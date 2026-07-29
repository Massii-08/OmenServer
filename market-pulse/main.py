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


def _briefings(args, snap, now):
    """Un briefing par borsa choisie — le cœur de la phase D.

    Piloté par prefs.json : quelles bourses, quels titres suivis, quelles
    sources sociales, synthèse ou pas, quaderno ou pas.
    """
    from pulse import prefs as _prefs
    from pulse.analyst import analyse
    from pulse.briefing import build_briefing
    from pulse.discover import discover
    from pulse.exchanges import by_id, opening_groups
    from pulse.news import collect_news
    from pulse.vault import write_note

    conf, warnings = _prefs.load(args.prefs)
    for w in warnings:
        print("   ! prefs : %s" % w)
    opz = conf["opzioni"]
    venues = [by_id(b) for b in conf["borse"]]
    venues = [v for v in venues if v]
    groups = opening_groups(venues)
    print("   %d borse -> %d aperture distinte" % (len(venues), len(groups)))

    out = {}
    for venue in venues:
        # La presse LOCALE de la place, plus les sources sociales si activées.
        feeds = list(venue.feeds)
        news = collect_news(feeds=feeds, max_items=opz["max_notizie"])

        followed = _followed_quotes(conf["titoli"].get(venue.id) or [], now)
        found = discover(news.get("items"), followed=tuple(
            f["symbol"] for f in followed)) if opz["scoperte"] else []

        brief = build_briefing(exchange=venue, snapshot=snap, news=news,
                               followed=followed, discovered=found, now_ts=now)
        analysis = analyse(brief) if opz["sintesi"] else {
            "text": None, "model": None, "degraded": True,
            "reason": "sintesi disattivata nelle preferenze"}
        brief["analysis"] = analysis

        if opz["quaderno"]:
            note = write_note(args.vault, brief, analysis, now)
            if note:
                print("   -> quaderno : %s" % os.path.basename(note))

        out[venue.id] = brief
        idx = brief.get("index") or {}
        print("   %-16s %-22s %s | sintesi %s"
              % (venue.id, idx.get("label") or "n/d",
                 ("%+.2f%%" % idx["change_pct"]) if idx.get("change_pct") is not None else "n/d",
                 "no" if analysis["degraded"] else "si"))

    _write_json(os.path.join(args.out, "briefings.json"), out)
    print("-> %s (%d briefing)" % (os.path.join(args.out, "briefings.json"), len(out)))
    return out


def _followed_quotes(symbols, now):
    """Les titres suivis, avec leur cours du moment."""
    from pulse.quotes import parse_chart
    client = YahooChartClient()
    out = []
    for sym in symbols:
        try:
            md = parse_chart(client.get_chart(sym, "10d"))
            prev = next((k.close for k in reversed(md.candles[:-1]) if k.close), None)
            chg = round((md.price - prev) / prev * 100.0, 2) if (md.price and prev) else None
            out.append({"symbol": sym, "label": md.name or sym, "price": md.price,
                        "change_pct": chg, "currency": md.currency})
        except Exception as e:
            out.append({"symbol": sym, "label": sym, "price": None,
                        "change_pct": None, "error": "%s" % type(e).__name__})
    return out


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
    ap.add_argument("--briefings", action="store_true",
                    help="un briefing per ogni borsa scelta in prefs.json")
    ap.add_argument("--prefs", default=None, help="percorso di prefs.json")
    ap.add_argument("--vault", default=None,
                    help="radice del quaderno Obsidian (default ~/market-vault)")
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

    if args.briefings:
        _step("briefing per borsa", lambda: _briefings(args, snap, now))

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
