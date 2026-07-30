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


def _memo_fetch():
    """Un flux n'est récupéré qu'UNE fois par run, même s'il sert deux places.

    CNBC figure dans `nyse` ET dans `nasdaq` : sans ce mémo, la même URL partait
    deux fois par run. Les échecs sont mémorisés aussi — réessayer une source
    déjà tombée, c'est marteler quelqu'un qui vient de dire non.
    """
    from pulse.news import _default_fetch
    cache = {}

    def fetch(url):
        if url not in cache:
            try:
                cache[url] = ("ok", _default_fetch(url))
            except Exception as e:      # noqa: BLE001 — rejouée telle quelle
                cache[url] = ("err", e)
        kind, payload = cache[url]
        if kind == "err":
            raise payload
        return payload
    return fetch


def _social_for(venue, opz, now, budget):
    """Les sources sociales de cette place, selon les options cochées.

    ⚠️ Rien de coché ⇒ **aucune requête**. C'est le point qui manquait : les
    quatre options `reddit`/`bluesky`/`x`/`x_account` de prefs.json existaient
    depuis le début mais personne ne les lisait — elles ne faisaient rien.
    """
    from pulse.social import collect_social
    subs = list(venue.reddit_subs) if opz.get("reddit") else []
    queries = list(venue.bluesky_queries) if opz.get("bluesky") else []
    handles = list(opz.get("x_account") or []) if opz.get("x") else []
    if not (subs or queries or handles):
        return None
    return collect_social(subs=subs, queries=queries, handles=handles,
                          now_ts=now, max_items=budget)


def _merge_social(news, social):
    """Presse + social dans un seul lot, sans doublon de titre.

    Le social est un APPOINT : il a son propre budget, plus petit, pour qu'un
    sub bavard ne pousse pas la presse locale hors de la page.
    """
    merged = dict(news)
    seen = {" ".join((i.get("title") or "").lower().split())
            for i in (news.get("items") or [])}
    extra = [i for i in (social.get("items") or [])
             if " ".join((i.get("title") or "").lower().split()) not in seen]
    merged["items"] = list(news.get("items") or []) + extra
    merged["sources_ok"] = list(news.get("sources_ok") or []) + list(social.get("sources_ok") or [])
    merged["sources_failed"] = (list(news.get("sources_failed") or [])
                                + list(social.get("sources_failed") or []))
    merged["filtered_advice"] = (news.get("filtered_advice") or 0) + (social.get("filtered_advice") or 0)
    merged["filtered_offtopic"] = (news.get("filtered_offtopic") or 0) + (social.get("filtered_offtopic") or 0)
    merged["alarms"] = list(news.get("alarms") or []) + list(social.get("alarms") or [])
    return merged


def _briefings(args, snap, now):
    """Un briefing par borsa choisie — le cœur de la phase D.

    Piloté par prefs.json : quelles bourses, quels titres suivis, quelles
    sources sociales, synthèse ou pas, quaderno ou pas.
    """
    from pulse import prefs as _prefs
    from pulse.agenda import collect_agenda, for_venue
    from pulse.analyst import analyse
    from pulse.briefing import build_briefing
    from pulse.discover import discover
    from pulse.resolve import make_resolver
    from pulse.exchanges import by_id, opening_groups
    from pulse.news import collect_news
    from pulse.vault import write_note

    conf, warnings = _prefs.load(args.prefs)
    # ⚠️ discover() rend une liste VIDE sans résolveur : l'oublier ici rendait
    # l'option « scoperte » silencieusement inopérante (bug vécu).
    resolver = make_resolver()
    for w in warnings:
        print("   ! prefs : %s" % w)
    opz = conf["opzioni"]
    venues = [by_id(b) for b in conf["borse"]]
    venues = [v for v in venues if v]
    if args.borse:
        # Le planificateur ne demande QUE la place qui ouvre : sans ce filtre,
        # chaque ouverture régénérerait les briefings des autres places — et
        # autant d'appels au LLM pour rien.
        wanted = set(x.strip() for x in str(args.borse).split(",") if x.strip())
        venues = [v for v in venues if v.id in wanted]
        if not venues:
            print("   ! --borse %r ne correspond à aucune borsa des préférences"
                  % args.borse)
    groups = opening_groups(venues)
    print("   %d borse -> %d aperture distinte" % (len(venues), len(groups)))

    # Un seul fetch mémorisé pour tout le run, et l'agenda des banques centrales
    # une seule fois : les sources sont les mêmes pour toutes les places.
    fetch = _memo_fetch()
    agenda = collect_agenda(now, fetch=fetch)
    for bad in agenda["sources_failed"]:
        print("   ! agenda %s : %s" % (bad["source"], bad["error"]))
    print("   agenda : %d appuntamenti entro %d giorni (%s)"
          % (len(agenda["events"]), int(agenda["horizon_h"] / 24),
             ", ".join(agenda["sources_ok"]) or "nessuna fonte"))

    social_budget = max(2, int(opz["max_notizie"]) // 3)
    out = {}
    for venue in venues:
        # La presse LOCALE de la place, plus les sources sociales si activées.
        feeds = list(venue.feeds)
        news = collect_news(fetch=fetch, feeds=feeds, max_items=opz["max_notizie"])
        social = _social_for(venue, opz, now, social_budget)
        if social:
            news = _merge_social(news, social)
            for alarm in social["alarms"]:
                # Surfacée fort : une source qui a changé de format rendrait un
                # briefing vide qui a l'air normal.
                print("!! ALLARME source : %s" % alarm)

        followed = _followed_quotes(conf["titoli"].get(venue.id) or [], now)
        # ⚠️ La découverte tourne sur la PRESSE seulement. Mesuré au premier run
        # réel : les posts sociaux ont fait « découvrir » NEXT (extrait de
        # « NIKKEI NEWS NEXT ») et 9TO.F. Une dépêche est de la prose éditée, un
        # post est une soupe de hashtags — et la règle anti-homonyme s'appuie
        # justement sur la langue de la dépêche.
        press = [i for i in (news.get("items") or [])
                 if not str(i.get("source") or "").startswith(("Reddit", "Bluesky", "X @"))]
        found = discover(press,
                         followed=tuple(f["symbol"] for f in followed),
                         resolve=resolver) if opz["scoperte"] else []

        brief = build_briefing(exchange=venue, snapshot=snap, news=news,
                               agenda=for_venue(agenda["events"], venue.id),
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
        print("   %-16s %-22s %s | notizie %d (social %d) | agenda %d | sintesi %s"
              % (venue.id, idx.get("label") or "n/d",
                 ("%+.2f%%" % idx["change_pct"]) if idx.get("change_pct") is not None else "n/d",
                 len(brief["news"]["items"]), len(social["items"]) if social else 0,
                 len(brief["agenda"]),
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
    ap.add_argument("--borse", default=None,
                    help="limita i briefing a queste borse (id separati da virgola) — "
                         "usato dal pianificatore: all'apertura di una piazza si "
                         "rigenera solo il suo briefing")
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
