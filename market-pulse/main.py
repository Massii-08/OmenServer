"""Market Pulse — CLI du moteur.

Usage (depuis market-pulse/, avec le venv du projet) :
    python main.py                    # snapshot marché → out/snapshot.json + résumé
    python main.py --stats            # + stats historiques 1 an → out/history.json
    python main.py --news             # + presse & Reddit      → out/news.json
    python main.py --report           # + rapport italien      → out/report.txt
    python main.py --excel            # + classeur Excel       → out/market_pulse_<date>.xlsx
    python main.py --out /chemin/dir  # répertoire de sortie

Le router backend lance ce module en subprocess DÉTACHÉ (comme le Bond Scanner)
et lit les fichiers produits ; il ne dépend d'aucune sortie console.

Codes de sortie :
    0 → snapshot produit. Des instruments peuvent être en erreur : c'est dans
        snapshot["errors"], ce n'est PAS un échec de run — un marché en panne
        ne doit pas priver le lecteur des dix-neuf autres.
    2 → échec total : aucun marché récupéré (réseau coupé, Yahoo qui bloque).
"""
import argparse
import datetime
import json
import os
import sys
import time

from pulse.config import DEFAULT_WATCHLIST
from pulse.fetcher import YahooChartClient
from pulse.snapshot import build_history_stats, build_snapshot

STATUS_IT = {"open": "APERTO", "closed": "chiuso", "unknown": "?"}


def _fmt_market(m: dict) -> str:
    clock = m["clock"]
    chg = m["change_pct"]
    chg_s = ("%+.2f%%" % chg) if chg is not None else "  n/d "
    gap_s = ""
    if m["gap"] and m["gap_is_today"]:
        gap_s = "  gap oggi %+.2f%%" % m["gap"]["gap_pct"]
    elif m["gap"]:
        gap_s = "  ultimo gap %+.2f%% (%s)" % (m["gap"]["gap_pct"], m["gap"]["date"])
    return "  %-22s %-8s %10s  %s  ore %s%s" % (
        m["label"], STATUS_IT.get(clock["status"], "?"),
        ("%.2f" % m["price"]) if m["price"] is not None else "n/d",
        chg_s, clock["local_time"], gap_s,
    )


def _write_json(path: str, payload) -> None:
    with open(path, "w") as f:
        json.dump(payload, f, indent=1, ensure_ascii=False)


def _step(label, fn):
    """Exécute une étape optionnelle sans faire tomber le run.

    Le snapshot est la valeur principale : si le rapport ou l'Excel échoue, on
    le DIT sur la sortie standard (le router la journalise) et on continue —
    perdre le classeur ne doit pas coûter la photographie du marché. Le
    silence, lui, serait un piège : une étape muette qui ne produit rien
    ressemble à une étape qui a réussi.
    """
    try:
        return fn()
    except Exception as e:
        print("!! %s non produit: %s: %s" % (label, type(e).__name__, e))
        return None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Market Pulse - snapshot dei mercati")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "out"))
    ap.add_argument("--stats", action="store_true",
                    help="calcola anche le statistiche storiche (1 anno)")
    ap.add_argument("--news", action="store_true",
                    help="raccoglie i titoli di stampa e Reddit")
    ap.add_argument("--report", action="store_true",
                    help="scrive il rapporto in italiano (report.txt)")
    ap.add_argument("--excel", action="store_true", help="scrive il file Excel")
    ap.add_argument("--range", dest="range_", default="10d")
    args = ap.parse_args(argv)

    os.makedirs(args.out, exist_ok=True)
    client = YahooChartClient()
    now = int(time.time())

    snap = build_snapshot(lambda s: client.get_chart(s, args.range_), DEFAULT_WATCHLIST, now)
    snap_path = os.path.join(args.out, "snapshot.json")
    _write_json(snap_path, snap)

    print("=== MARKET PULSE — %s mercati, %s errori ===" % (len(snap["markets"]), len(snap["errors"])))
    for region in ("europe", "usa", "asia", "global"):
        rows = [m for m in snap["markets"] if m["region"] == region]
        if not rows:
            continue
        print("[%s]" % region.upper())
        for m in rows:
            print(_fmt_market(m))
    for err in snap["errors"]:
        print("  ERRORE %s: %s" % (err["symbol"], err["error"]))
    print("-> %s" % snap_path)

    if not snap["markets"]:
        print("!! nessun mercato recuperato — run fallito")
        return 2

    hist = None
    if args.stats or args.report or args.excel:
        # Les stats alimentent aussi le rapport et l'Excel : on les calcule dès
        # qu'un consommateur les veut. C'est un SECOND passage réseau complet
        # (le plus fragile des trois) → jamais bloquant.
        def _hist():
            path = os.path.join(args.out, "history.json")
            h = build_history_stats(lambda s, r="1y": client.get_chart(s, r), DEFAULT_WATCHLIST)
            _write_json(path, h)
            print("-> %s (statistiche storiche)" % path)
            return h
        hist = _step("statistiche storiche", _hist)

    news = None
    if args.news:
        def _news():
            from pulse.news import collect_news
            path = os.path.join(args.out, "news.json")
            n = collect_news()
            _write_json(path, n)
            print("-> %s (%s titoli, %s fonti ok)" % (
                path, len(n.get("items") or []), len(n.get("sources_ok") or [])))
            return n
        news = _step("notizie", _news)

    if args.report:
        def _report():
            from pulse.report import build_report
            path = os.path.join(args.out, "report.txt")
            with open(path, "w") as f:
                f.write(build_report(snap, history=hist, news=news, now_ts=now))
            print("-> %s (rapporto)" % path)
            return path
        _step("rapporto", _report)

    if args.excel:
        def _excel():
            from pulse.excel_out import write_workbook
            day = datetime.datetime.fromtimestamp(now).strftime("%Y-%m-%d")
            path = os.path.join(args.out, "market_pulse_%s.xlsx" % day)
            write_workbook(path, snap, history=hist, news=news)
            print("-> %s (Excel)" % path)
            return path
        _step("Excel", _excel)

    return 0


if __name__ == "__main__":
    sys.exit(main())
