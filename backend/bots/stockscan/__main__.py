"""Entrée du subprocess détaché.

    python -m backend.bots.stockscan --out <run_dir> --config <json> --user <compte>
    python -m backend.bots.stockscan --probe <dossier> [--market italy] [--symbol MIL:ENI]

Le router lance la première forme depuis la racine du projet, stdout redirigé
DIRECTEMENT dans ``run.log`` (pas de pipe : un redémarrage d'uvicorn par
l'auto-deploy ne doit pas tuer le scan sur un ``BrokenPipeError``).

La seconde forme est la SONDE : elle interroge une fois le screener et le flux
de news, enregistre les réponses BRUTES dans le dossier donné (pour en faire
des fixtures) et imprime un rapport colonne par colonne. À lancer sur l'Omen
après le déploiement — le conteneur de développement n'avait pas accès à ces
hôtes.

Codes de sortie : 0 terminé, 1 plantage, 2 univers vide (résultat écrit quand
même, avec ses avertissements), 3 arrêté à la demande.
"""
import argparse
import json
import sys
import traceback
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from backend.bots.stockscan import config as cfgmod
from backend.bots.stockscan import engine
from backend.bots.stockscan import markets as mk
from backend.bots.stockscan import news as nw
from backend.bots.stockscan import screener as sc


def _log(line: str) -> None:
    print(line, flush=True)


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m backend.bots.stockscan")
    p.add_argument("--out", help="dossier du run (écrit progress.json, results.json, .xlsx)")
    p.add_argument("--config", help="config.json du run")
    p.add_argument("--user", default="", help="compte qui a lancé le scan")
    p.add_argument("--probe", help="sonde : dossier où enregistrer les réponses brutes")
    p.add_argument("--market", default="italy", help="marché sondé (défaut : italy)")
    p.add_argument("--symbol", default=None, help="symbole TradingView sondé pour les news")
    return p


# --------------------------------------------------------------------------- #
# Vraies dépendances
# --------------------------------------------------------------------------- #

def _fallback_symbols(username: str) -> List[str]:
    """Univers de repli : la table d'entités du coach + ce que le demandeur suit
    + les titres des hypothèses ouvertes du radar."""
    out: List[str] = []
    try:
        from backend.bots.paper import entities
        out.extend(entities.known_symbols())
    except Exception:             # noqa: BLE001
        pass
    loaders = engine.coachmod.Loaders()
    for getter in (lambda: [r.get("symbol") for r in loaders.watchlist(username) or []],
                   lambda: [p.get("symbol") for p in (loaders.portfolio(username) or {}).get("positions") or []],
                   lambda: [t for h in loaders.hypotheses() if h.get("status") == "open"
                            for t in h.get("tickers") or []]):
        try:
            out.extend(s for s in getter() if isinstance(s, str))
        except Exception:         # noqa: BLE001
            continue
    return [engine.coachmod._canonical(s) for s in out if s]


def real_deps() -> engine.Deps:
    import httpx
    news_client = httpx.Client(timeout=15.0, follow_redirects=True)

    def chart(symbol: str) -> Optional[Dict[str, Any]]:
        from backend.bots.paper import quotes
        return quotes.get_client().get_chart(symbol, range_="3mo", interval="1d")

    return engine.Deps(screener=sc.ScreenerClient(), news_fetch=nw.tv_fetcher(news_client),
                       chart=chart, fallback_symbols=_fallback_symbols)


def previous_symbols(run_dir: Path) -> Optional[Set[str]]:
    """Symboles du dernier run TERMINÉ (pour le drapeau « nouveau »)."""
    parent = Path(run_dir).parent
    try:
        siblings = sorted((d for d in parent.iterdir()
                           if d.is_dir() and d != Path(run_dir) and (d / engine.RESULTS_FILE).is_file()),
                          key=lambda d: d.stat().st_mtime, reverse=True)
    except OSError:
        return None
    for d in siblings:
        try:
            data = json.loads((d / engine.RESULTS_FILE).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        return {r.get("symbol") for r in data.get("rows") or [] if isinstance(r, dict) and r.get("symbol")}
    return None


# --------------------------------------------------------------------------- #
# Sonde
# --------------------------------------------------------------------------- #

def probe(out_dir: str, market_id: str, tv_symbol: Optional[str],
          screener: Optional[sc.ScreenerClient] = None, news_get: Any = None) -> int:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    market = mk.by_id(market_id)
    if market is None:
        _log("marché inconnu : %s" % market_id)
        return 1
    client = screener or sc.ScreenerClient(max_retries=1)
    try:
        payload, meta = client.scan(market, {"min_cap_meur": 1000})
    except sc.ScreenerError as exc:
        _log("SCREENER : ÉCHEC statut=%s raison=%s" % (exc.status, exc.reason))
        return 1
    raw_path = out / ("screener_%s.json" % market.id)
    raw_path.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    rows, info = sc.parse_response(payload, market)
    _log("SCREENER : statut=%s essais=%s colonnes_inconnues_ignorées=%s total=%s lignes=%d"
         % (meta.get("status"), meta.get("attempts"), meta.get("ignored_unknown"),
            info.get("total"), len(rows)))
    data = payload.get("data") if isinstance(payload, dict) else None
    sample = data if isinstance(data, list) else []
    for index, column in enumerate(sc.COLUMNS):
        values = [r.get("d")[index] for r in sample
                  if isinstance(r, dict) and isinstance(r.get("d"), list) and len(r["d"]) > index]
        filled = [v for v in values if v not in (None, "", [])]
        example = repr(filled[0])[:60] if filled else "-"
        _log("  %-40s %3d/%-3d ex: %s" % (column, len(filled), len(values), example))
    if info.get("null_columns"):
        _log("  COLONNES MORTES : %s" % ", ".join(info["null_columns"]))
    _log("  -> %s" % raw_path)

    symbol = tv_symbol or (rows[0]["tv_symbol"] if rows else None)
    if not symbol:
        return 0
    if news_get is None:
        import httpx
        news_get = httpx.Client(timeout=15.0, follow_redirects=True)
    from backend.bots.paper import tvnews
    url = tvnews.NEWS_URL.format(lang="en", tv_symbol=symbol)
    try:
        resp = news_get.get(url, headers=dict(tvnews.HEADERS))
        status = getattr(resp, "status_code", 0)
        body = resp.json() if status == 200 else None
    except Exception as exc:      # noqa: BLE001
        _log("NEWS %s : ÉCHEC (%s)" % (symbol, type(exc).__name__))
        return 0
    if body is None:
        _log("NEWS %s : statut %s" % (symbol, status))
        return 0
    news_path = out / ("tvnews_%s.json" % symbol.replace(":", "_"))
    news_path.write_text(json.dumps(body, ensure_ascii=False, indent=1), encoding="utf-8")
    items = tvnews.parse_items(body, symbol)
    _log("NEWS %s : statut 200, %d items, plus récent %s"
         % (symbol, len(items), items[0]["published"] if items else "-"))
    _log("  -> %s" % news_path)
    return 0


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #

def main(argv: Optional[List[str]] = None, deps: Optional[engine.Deps] = None) -> int:
    args = _parser().parse_args(argv)
    if args.probe:
        return probe(args.probe, args.market, args.symbol)
    if not args.out:
        _parser().error("--out est obligatoire (ou --probe)")
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    raw: Dict[str, Any] = {}
    if args.config:
        try:
            raw = json.loads(Path(args.config).read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            _log("config illisible (%s) : défauts utilisés" % type(exc).__name__)
    cfg, warnings = cfgmod.validate(raw)
    for w in warnings:
        _log("config : %s" % json.dumps(w, ensure_ascii=False))
    try:
        results = engine.run_scan(cfg, args.user, out_dir, deps or real_deps(),
                                  previous_symbols=previous_symbols(out_dir), log=_log)
    except engine.Stopped:
        _log("Arrêté à la demande.")
        return 3
    except Exception:             # noqa: BLE001 — la trace va dans run.log
        _log("PLANTAGE :\n" + traceback.format_exc())
        return 1
    return 0 if results.get("counts", {}).get("universe") else 2


if __name__ == "__main__":
    sys.exit(main())
