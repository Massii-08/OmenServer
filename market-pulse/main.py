"""Market Pulse — CLI du moteur.

Usage (depuis market-pulse/, avec le venv du projet) :
    python main.py                    # snapshot marché → out/snapshot.json + résumé
    python main.py --stats            # + stats historiques 1 an → out/history.json
    python main.py --out /chemin/dir  # répertoire de sortie

Le router backend (phase B) lancera ce module en subprocess détaché, comme le
Bond Scanner, et lira les JSON produits.
"""
import argparse
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


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Market Pulse - snapshot dei mercati")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "out"))
    ap.add_argument("--stats", action="store_true", help="calcola anche le statistiche storiche (1 anno)")
    ap.add_argument("--range", dest="range_", default="10d")
    args = ap.parse_args(argv)

    os.makedirs(args.out, exist_ok=True)
    client = YahooChartClient()
    now = int(time.time())

    snap = build_snapshot(lambda s: client.get_chart(s, args.range_), DEFAULT_WATCHLIST, now)
    snap_path = os.path.join(args.out, "snapshot.json")
    with open(snap_path, "w") as f:
        json.dump(snap, f, indent=1, ensure_ascii=False)

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

    if args.stats:
        hist = build_history_stats(lambda s, r="1y": client.get_chart(s, r), DEFAULT_WATCHLIST)
        hist_path = os.path.join(args.out, "history.json")
        with open(hist_path, "w") as f:
            json.dump(hist, f, indent=1, ensure_ascii=False)
        print("-> %s (statistiche storiche)" % hist_path)

    return 0 if not snap["errors"] else 1


if __name__ == "__main__":
    sys.exit(main())
