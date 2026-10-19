"""Orchestration d'un scan : univers -> coach -> présélection -> news -> score -> sortie.

Toutes les dépendances d'I/O passent par ``Deps`` (screener, chargeurs du coach,
flux de news, cotations du repli, horloge, sommeil) : le moteur entier se teste
hors ligne. ``run_scan`` écrit ``progress.json`` à chaque étape et
``results.json`` EN DERNIER — c'est sa présence qui fait dire « terminé » au
router (le disque fait foi).

Arrêt : ``stop.flag`` est relu à chaque point de contrôle ; on lève ``Stopped``
et ``__main__`` sort en code 3 sans écrire de résultat.
"""
import json
import os
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Set, Tuple

from backend.bots.stockscan import coach as coachmod
from backend.bots.stockscan import excel_out
from backend.bots.stockscan import markets as mk
from backend.bots.stockscan import news as nw
from backend.bots.stockscan import scoring as sg
from backend.bots.stockscan import screener as sc
from backend.bots.stockscan import sessions as ss

RESULTS_VERSION = 1
STOP_FILE = "stop.flag"
PROGRESS_FILE = "progress.json"
RESULTS_FILE = "results.json"

# Nombre maximal de titres essayés par l'univers de repli (une requête Yahoo
# chacun, pacing 1,1 s).
FALLBACK_MAX = 60

# Disjoncteur du repli. Vécu au premier lancement réel (réseau coupé) : chaque
# titre coûte ~13 s quand Yahoo ne répond pas (trois essais du client avec
# pauses croissantes), soit ~13 minutes de vide pour 60 titres. Trois échecs
# d'affilée suffisent à dire que la source est tombée.
FALLBACK_MAX_FAILURES = 3


class Stopped(Exception):
    """L'utilisateur a demandé l'arrêt (``stop.flag``)."""


class Deps:
    """Les dépendances d'un scan. Les valeurs par défaut sont les vraies."""

    def __init__(self, screener: Any = None, coach_loaders: Any = None,
                 news_fetch: Optional[Callable[[str, str], Tuple[Optional[list], int]]] = None,
                 chart: Optional[Callable[[str], Optional[Dict[str, Any]]]] = None,
                 fallback_symbols: Optional[Callable[[str], List[str]]] = None,
                 now: Optional[Callable[[], datetime]] = None,
                 sleep: Callable[[float], None] = time.sleep,
                 monotonic: Callable[[], float] = time.monotonic):
        self.screener = screener
        self.coach_loaders = coach_loaders
        self.news_fetch = news_fetch
        self.chart = chart
        self.fallback_symbols = fallback_symbols
        self.now = now or (lambda: datetime.now(timezone.utc))
        self.sleep = sleep
        self.monotonic = monotonic


# --------------------------------------------------------------------------- #
# Disque
# --------------------------------------------------------------------------- #

def write_json_atomic(path: Path, data: Any) -> None:
    path = Path(path)
    tmp = path.with_name(".%s.tmp-%d" % (path.name, os.getpid()))
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)
    except (AttributeError, OSError):
        pass
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.replace(str(tmp), str(path))
    except Exception:
        try:
            os.remove(str(tmp))
        except OSError:
            pass
        raise


class Progress:
    """``progress.json`` : phase, avancement, compteurs — relu par le router."""

    def __init__(self, out_dir: Path, now: Callable[[], datetime]):
        self.path = Path(out_dir) / PROGRESS_FILE
        self.now = now
        self.counts: Dict[str, Any] = {}

    def update(self, phase: str, done: int = 0, total: int = 0, **counts: Any) -> None:
        self.counts.update(counts)
        try:
            write_json_atomic(self.path, {"phase": phase, "done": int(done), "total": int(total),
                                          "counts": dict(self.counts),
                                          "at": self.now().isoformat(timespec="seconds")})
        except OSError:
            pass                  # la progression n'est jamais fatale


# --------------------------------------------------------------------------- #
# Univers de repli (bougies Yahoo) — PUR une fois le graphique reçu
# --------------------------------------------------------------------------- #

def row_from_chart(symbol: str, raw: Any) -> Optional[Dict[str, Any]]:
    """Réponse chart Yahoo (3 mois, journalier) -> ligne d'univers, ou ``None``.

    Variation calculée sur la DERNIÈRE clôture connue précédente (jamais
    ``chartPreviousClose``, qui dépend de la fenêtre demandée — piège #68e) ;
    bougie à moitié écrite gardée (piège #67a, via ``quotes.parse_candles``).
    """
    try:
        from backend.bots.paper import quotes
    except Exception:             # noqa: BLE001
        return None
    results = ((raw or {}).get("chart") or {}).get("result") if isinstance(raw, dict) else None
    result = results[0] if isinstance(results, list) and results else None
    if not isinstance(result, dict):
        return None
    candles = quotes.parse_candles(result)
    meta = result.get("meta") or {}
    closes = [c["close"] for c in candles if c.get("close") is not None]
    price = sc._num(meta.get("regularMarketPrice")) or (closes[-1] if closes else None)
    if price is None or price <= 0:
        return None
    market_id = mk.market_of_yahoo(symbol)
    market = mk.by_id(market_id)
    if market is None:
        return None
    prev = closes[-2] if len(closes) >= 2 else None
    change = round((price - prev) / prev * 100.0, 2) if prev else None
    volumes = [c.get("volume") for c in candles if c.get("volume") is not None]
    rel_volume = None
    avg_volume = None
    if len(volumes) >= 2:
        history = volumes[-11:-1]
        avg_volume = sum(history) / len(history) if history else None
        if avg_volume:
            rel_volume = round(volumes[-1] / avg_volume, 2)
    perf_w = None
    if len(closes) >= 6 and closes[-6]:
        perf_w = round((closes[-1] / closes[-6] - 1.0) * 100.0, 2)
    # Devise BRUTE de Yahoo (« GBp » pour les pence) : ``parse_meta`` la met en
    # majuscules, ce qui la confondrait avec la livre.
    currency = str(meta.get("currency") or market.currency)
    rate = mk.eur_rate(currency, market)
    avg_value = round(avg_volume * price * rate / 1e6, 2) if (avg_volume and rate) else None
    tv_symbol = mk.yahoo_to_tv(symbol)
    return {
        "tv_symbol": tv_symbol, "symbol": symbol,
        "ticker": symbol.split(".")[0] if market_id != "america" else symbol,
        "name": meta.get("longName") or meta.get("shortName") or symbol,
        "market": market_id, "exchange": meta.get("exchangeName") or "",
        "currency": "GBX" if currency == "GBp" else currency.upper(),
        "price": price, "change_pct": change, "gap_pct": None, "volume": volumes[-1] if volumes else None,
        "rel_volume": rel_volume, "rel_volume_time": None,
        "avg_value_meur": avg_value, "value_traded_meur": None,
        "market_cap_meur": None, "sector": None, "industry": None, "country": None,
        "perf_w": perf_w, "perf_1m": None, "high_52w": None, "low_52w": None,
        "earnings_next": None, "dividend_yield": None, "pe": None,
    }


def _fallback_universe(cfg: Dict[str, Any], username: str, deps: Deps,
                       check: Callable[[], None], progress: Progress,
                       log: Callable[[str], None]) -> Tuple[List[Dict[str, Any]], bool]:
    """``(lignes, disjoncteur_déclenché)``."""
    if deps.chart is None or deps.fallback_symbols is None:
        return [], False
    wanted = set(cfg["markets"])
    symbols = [s for s in deps.fallback_symbols(username) if mk.market_of_yahoo(s) in wanted]
    symbols = list(dict.fromkeys(symbols))[:FALLBACK_MAX]
    rows: List[Dict[str, Any]] = []
    failures = 0
    for index, symbol in enumerate(symbols):
        check()
        progress.update("universe", index, len(symbols))
        try:
            raw = deps.chart(symbol)
        except Exception as exc:  # noqa: BLE001 — un titre ne casse pas le repli
            failures += 1
            log("  repli: %s indisponible (%s)" % (symbol, type(exc).__name__))
            if failures >= FALLBACK_MAX_FAILURES:
                log("  repli abandonné : %d échecs d'affilée" % failures)
                return rows, True
            continue
        failures = 0
        row = row_from_chart(symbol, raw)
        if row:
            rows.append(row)
    return rows, False


# --------------------------------------------------------------------------- #
# Le scan
# --------------------------------------------------------------------------- #

def _check_stop(out_dir: Path) -> None:
    if (Path(out_dir) / STOP_FILE).is_file():
        raise Stopped()


def _coach_summary(slot: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "hypotheses": [{"direction": h.get("direction"), "thesis": h.get("thesis"),
                        "confidence": h.get("confidence"), "source": h.get("source")}
                       for h in slot.get("hypotheses") or []][:3],
        "reddit": slot.get("reddit"),
        "filings": [{"form": f.get("form"), "title": f.get("title"), "url": f.get("url")}
                    for f in slot.get("filings") or []][:3],
    }


def _fr_number(value: Optional[float]) -> str:
    """« 1,06 » pour le journal (deux décimales, virgule) ; « — » si inconnu."""
    return "—" if value is None else ("%.2f" % value).replace(".", ",")


_ROW_KEYS = ("tv_symbol", "symbol", "ticker", "name", "market", "exchange", "currency",
             "price", "change_pct", "gap_pct", "rel_volume", "rel_volume_raw", "rel_volume_time",
             "avg_value_meur", "market_cap_meur", "sector", "perf_w", "earnings_next")


def run_scan(cfg: Dict[str, Any], username: str, out_dir: Any, deps: Deps,
             previous_symbols: Optional[Set[str]] = None,
             log: Callable[[str], None] = print) -> Dict[str, Any]:
    """Un scan complet. Rend le contenu de ``results.json`` (aussi écrit sur disque)."""
    out_dir = Path(out_dir)
    now = deps.now()
    today = now.date()
    window = float(cfg["window_h"])
    progress = Progress(out_dir, deps.now)
    check = lambda: _check_stop(out_dir)          # noqa: E731
    warnings: List[Dict[str, Any]] = []
    counts: Dict[str, Any] = {"universe": 0, "shortlist": 0, "news_requests": 0,
                              "news_failed": 0, "news_from_cache": 0, "candidates": 0,
                              "kept": 0, "excluded_no_catalyst": 0, "excluded_red": 0,
                              "filtered_advice": 0, "dropped_irrelevant": 0, "coach_events": 0}

    # --- 1. univers ---------------------------------------------------------
    log("Scanner d'actions — marchés : %s" % ", ".join(cfg["markets"]))
    markets_status: List[Dict[str, Any]] = []
    all_rows: List[Dict[str, Any]] = []
    dead_columns: Set[str] = set()
    for index, market_id in enumerate(cfg["markets"]):
        check()
        progress.update("universe", index, len(cfg["markets"]))
        market = mk.by_id(market_id)
        if market is None or deps.screener is None:
            continue
        try:
            payload, meta = deps.screener.scan(market, cfg)
        except sc.ScreenerError as exc:
            reason = (exc.reason or "erreur")[:160]
            markets_status.append({"id": market_id, "ok": False, "rows": 0, "error": reason})
            warnings.append({"code": "market_failed", "market": market_id, "error": reason})
            log("  %s : échec (%s)" % (market_id, reason))
            continue
        rows, info = sc.parse_response(payload, market)
        dead_columns.update(info.get("null_columns") or [])
        markets_status.append({"id": market_id, "ok": True, "rows": len(rows), "error": None,
                               "total": info.get("total"),
                               "ignored_unknown": bool(meta.get("ignored_unknown"))})
        all_rows.extend(rows)
        log("  %s : %d titres (sur %s)" % (market_id, len(rows), info.get("total")))
    if dead_columns:
        warnings.append({"code": "degraded_columns", "columns": sorted(dead_columns)})

    # Liquidité : une ligne sans échanges moyens connus n'est PAS jetée (si la
    # colonne est morte, on viderait tout l'univers sans le dire) — elle est
    # gardée, et la colonne morte est déjà signalée.
    min_value = float(cfg["min_value_meur"])
    universe = [r for r in all_rows
                if r.get("avg_value_meur") is None or r["avg_value_meur"] >= min_value]
    source = "screener"
    if not universe:
        log("Univers vide : repli sur les grandes valeurs (Yahoo)")
        universe, fallback_broken = _fallback_universe(cfg, username, deps, check, progress, log)
        source = "fallback"
        warnings.append({"code": "fallback_universe"})
        if fallback_broken:
            warnings.append({"code": "fallback_failed"})
    counts["universe"] = len(universe)

    # Volume comparable d'une place à l'autre : le volume « à l'heure » de
    # TradingView (le 10 j à défaut), rapporté à la médiane de son marché.
    medians = ss.normalize_volume(universe)
    for status in markets_status:
        status["volume_median"] = medians.get(status["id"])
    if medians:
        # « (10 j) » : aucun titre du marché n'a de volume « à l'heure »
        # (colonne morte, repli Yahoo) — le journal ne le fait pas passer pour un.
        timed = {r.get("market") for r in universe if r.get("rel_volume_time") is not None}
        log("Volume relatif médian à l'heure : %s" % " · ".join(
            "%s %s%s" % (m, _fr_number(medians[m]), "" if m in timed else " (10 j)")
            for m in cfg["markets"] if m in medians))

    # --- 2. signaux du coach (zéro réseau) ---------------------------------------
    check()
    progress.update("coach", 0, 1, universe=len(universe))
    view = coachmod.load(username, now, window, universe, deps.coach_loaders)
    cstats = view["stats"]
    counts["coach_events"] = cstats["events"]
    counts["dropped_irrelevant"] = cstats["dropped_irrelevant"]
    counts["filtered_advice"] = cstats["filtered_advice"]
    if cstats["events"] == 0:
        warnings.append({"code": "coach_empty"})
    log("Coach : %d événements lus, %d rattachés à l'univers, %d hypothèses ouvertes"
        % (cstats["events"], cstats["assigned"], cstats["hypotheses_open"]))
    by_symbol = view["by_symbol"]

    # --- 3. présélection -------------------------------------------------------------
    check()
    ranked = sorted(universe, key=lambda r: (-sg.pre_score(r, by_symbol.get(r.get("symbol")), today),
                                             -(r.get("avg_value_meur") or 0.0)))
    # Une part de la présélection RÉSERVÉE à chaque marché : sans elle, le
    # marché dont la séance est la plus avancée (ou finie) prend toutes les places.
    shortlist = ss.shortlist_with_quota(ranked, int(cfg["shortlist"]), cfg["markets"])
    counts["shortlist"] = len(shortlist)
    per_market = Counter(r.get("market") for r in shortlist)
    for status in markets_status:
        status["shortlisted"] = per_market.get(status["id"], 0)
    detail = ", ".join("%s %d" % (m, n) for m, n in
                       sorted(per_market.items(), key=lambda kv: (-kv[1], str(kv[0]))))
    log("Présélection : %d %s%s" % (len(shortlist), "titre" if len(shortlist) <= 1 else "titres",
                                     (" — " + detail) if detail else ""))
    progress.update("shortlist", 1, 1, shortlist=len(shortlist))

    # --- 4. news fraîches de la présélection --------------------------------------------
    targets = []
    for row in shortlist:
        tv_symbol = row.get("tv_symbol")
        market = mk.by_id(row.get("market"))
        if tv_symbol and market is not None:
            targets.append((tv_symbol, market.news_langs))
    fresh: Dict[str, List[Dict[str, Any]]] = {}
    if deps.news_fetch is not None and targets:
        def _on_progress(done: int, total: int) -> None:
            progress.update("news", done, total)
        fresh, nstats = nw.fetch_fresh(
            targets, deps.news_fetch, cache=view.get("tv_cache"), now=now,
            sleep=deps.sleep, monotonic=deps.monotonic,
            should_stop=lambda: (out_dir / STOP_FILE).is_file(), on_progress=_on_progress)
        counts["news_requests"] = nstats["requests"]
        counts["news_failed"] = nstats["failed"] + nstats["skipped"]
        counts["news_from_cache"] = nstats["from_cache"]
        if nstats["breaker"]:
            warnings.append({"code": "news_breaker", "status": nstats["breaker_status"]})
        log("News : %d requêtes, %d en cache, %d échecs%s"
            % (nstats["requests"], nstats["from_cache"], counts["news_failed"],
               " (disjoncteur)" if nstats["breaker"] else ""))
    check()

    # --- 5. score ---------------------------------------------------------------------
    progress.update("scoring", 0, len(shortlist))
    candidates: List[Dict[str, Any]] = []
    for row in shortlist:
        symbol = row.get("symbol")
        slot = by_symbol.get(symbol) or {}
        fresh_items = fresh.get(row.get("tv_symbol")) if row.get("tv_symbol") else None
        items, advice = nw.admit(nw.merge(fresh_items or [], slot.get("news") or []), now, window)
        counts["filtered_advice"] += advice
        verified = fresh_items is not None or deps.news_fetch is None
        # La séance que décrivent les chiffres (TradingView, la table en repli) :
        # des cours figés avant toutes les news ne les confirment pas.
        session = ss.row_session(row, now)
        scored = sg.score_row(row, items, slot, view["followed"], now, window,
                              exclude_red=bool(cfg["exclude_red"]), news_verified=verified,
                              price_asof=ss.price_asof(session))
        if scored["excluded"] == "no_catalyst":
            counts["excluded_no_catalyst"] += 1
            continue
        if scored["excluded"] == "red":
            counts["excluded_red"] += 1
            continue
        flags = list(scored["flags"])
        if previous_symbols is not None and symbol and symbol not in previous_symbols:
            flags.append("new")
        out = {k: row.get(k) for k in _ROW_KEYS}
        out.update({"score": scored["score"], "components": scored["components"],
                    "reasons": scored["reasons"], "flags": flags, "news": scored["news"],
                    "coach": _coach_summary(slot),
                    "session": session,
                    "links": {"chart": mk.chart_url(row.get("tv_symbol"))}})
        candidates.append(out)
    candidates.sort(key=lambda r: (-r["score"], -(r.get("rel_volume") or 0.0),
                                   -(r.get("avg_value_meur") or 0.0)))
    counts["candidates"] = len(candidates)
    top = candidates[:int(cfg["top_n"])]
    for rank, row in enumerate(top, start=1):
        row["rank"] = rank
    counts["kept"] = len(top)
    log("Score : %d candidats, %d gardés, %d sans catalyseur, %d en rouge exclus"
        % (len(candidates), len(top), counts["excluded_no_catalyst"], counts["excluded_red"]))

    # --- 6. sortie : l'Excel d'abord, results.json EN DERNIER -------------------------------
    check()
    progress.update("output", 0, 1, kept=len(top))
    results = {
        "version": RESULTS_VERSION,
        "generated_at": now.isoformat(timespec="seconds"),
        "config": dict(cfg),
        "source": source,
        "markets": markets_status,
        "sessions": ss.market_sessions(universe, now),
        "counts": counts,
        "warnings": warnings,
        "rows": top,
    }
    try:
        path = excel_out.write_workbook(results, out_dir, cfg.get("lang"))
        results["excel"] = path.name
    except Exception as exc:      # noqa: BLE001 — l'Excel n'empêche pas l'écran
        warnings.append({"code": "excel_failed", "error": type(exc).__name__})
        results["excel"] = None
        log("Excel non produit (%s)" % type(exc).__name__)
    write_json_atomic(out_dir / RESULTS_FILE, results)
    progress.update("done", 1, 1)
    log("Terminé : %d lignes" % len(top))
    return results
