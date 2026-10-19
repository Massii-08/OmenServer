"""Scanner d'actions — le scan de bout en bout, tout injecté (zéro réseau).

Univers : la fixture SYNTHÉTIQUE du screener (Italie). Signaux du coach :
chargeurs factices. News fraîches : fonction factice. Horloge épinglée au
2026-10-17 07:00 UTC (ENI publie ses résultats le 24/10, dans la fenêtre de 7 j ;
UniCredit le 29/10 et Ferrari le 04/11, hors fenêtre).
"""
import json
import os
from datetime import datetime, timedelta, timezone

import pytest
from openpyxl import load_workbook

from backend.bots.stockscan import __main__ as cli
from backend.bots.stockscan import coach as coachmod
from backend.bots.stockscan import config as cfgmod
from backend.bots.stockscan import engine
from backend.bots.stockscan import markets as mk
from backend.bots.stockscan import screener as sc

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")
NOW = datetime(2026, 10, 17, 7, 0, tzinfo=timezone.utc)


def _iso(hours_ago):
    return (NOW - timedelta(hours=hours_ago)).isoformat()


def _screener_payload():
    with open(os.path.join(FIXTURES, "stockscan", "screener_italy_synthetic.json"), encoding="utf-8") as f:
        return json.load(f)


class FakeScreener:
    def __init__(self, fail=()):
        self.fail = set(fail)
        self.calls = []

    def scan(self, market, cfg):
        self.calls.append(market.id)
        if market.id in self.fail or market.id != "italy":
            raise sc.ScreenerError("HTTP 403", 403)
        return _screener_payload(), {"status": 200, "attempts": 1, "ignored_unknown": False}


class FakeLoaders(coachmod.Loaders):
    def __init__(self, events=None, hypotheses=None, watchlist=None, tv_state=None):
        self._events = events or []
        self._hyps = hypotheses or []
        self._watch = watchlist or []
        self._tv = tv_state or {}

    def users(self):
        return ["massii"]

    def events(self, username):
        return list(self._events)

    def trends(self, now):
        return {}

    def tv_state(self):
        return self._tv

    def hypotheses(self):
        return list(self._hyps)

    def portfolio(self, username):
        return {"positions": []}

    def watchlist(self, username):
        return list(self._watch)


def _tv_item(title, minutes_ago=60, provider="reuters"):
    return {"id": title, "title": title, "provider": provider,
            "published": (NOW - timedelta(minutes=minutes_ago)).isoformat(),
            "url": "https://www.tradingview.com/news/" + title.replace(" ", "-")}


def _news_fetch(script, calls=None):
    def fetch(tv_symbol, lang):
        if calls is not None:
            calls.append((tv_symbol, lang))
        return script.get((tv_symbol, lang), ([], 200))
    return fetch


DEFAULT_LOADERS = dict(
    events=[{"ts": _iso(2), "symbol": "ENI.MI", "title": "Eni beats estimates on trading",
             "link": "https://n/eni", "sentiment": "pos", "src": "pressefi"}],
    hypotheses=[{"status": "open", "tickers": ["LDO.MI"], "direction": "up",
                 "thesis": "Commandes défense", "confidence": "moyenne"}],
    watchlist=[{"symbol": "UCG.MI", "name": "UniCredit"}],
    tv_state={"items_by_symbol": {"MIL:STLAM": {"fetched_at": _iso(0.1), "items": [
        {"id": "s1", "title": "Stellantis issues profit warning", "published": _iso(3),
         "provider": "reuters", "url": "https://www.tradingview.com/news/s1",
         "symbol": "STLAM.MI", "tv_symbol": "MIL:STLAM"}]}}},
)

NEWS_SCRIPT = {
    ("MIL:ENI", "en"): ([_tv_item("Eni signs gas supply deal with Algeria")], 200),
    ("MIL:UCG", "en"): ([_tv_item("UniCredit opens new branch in Milan", 120)], 200),
}


def _deps(screener=None, loaders=None, news=None, **kw):
    return engine.Deps(screener=screener or FakeScreener(),
                       coach_loaders=loaders or FakeLoaders(**DEFAULT_LOADERS),
                       news_fetch=news if news is not None else _news_fetch(NEWS_SCRIPT),
                       now=lambda: NOW, sleep=lambda s: None, monotonic=lambda: 0.0, **kw)


def _cfg(**over):
    base = {"markets": ["italy", "uk"], "min_value_meur": 5, "shortlist": 40, "top_n": 25}
    base.update(over)
    return cfgmod.validate(base)[0]


def _run(tmp_path, cfg=None, deps=None, **kw):
    logs = []
    results = engine.run_scan(cfg or _cfg(), "massii", tmp_path, deps or _deps(),
                              log=logs.append, **kw)
    return results, logs


def test_full_scan_ranks_catalysts_and_writes_files(tmp_path):
    results, logs = _run(tmp_path)
    symbols = [r["symbol"] for r in results["rows"]]
    # ENI : deux news positives/neutres + résultats proches + volume ; LDO : hypothèse
    # du coach + gros volume mais « déjà parti » ; UCG : une news neutre ; STLAM :
    # alerte rouge. RACE et ENEL n'ont aucun catalyseur ; TINY est trop peu liquide.
    assert symbols == ["ENI.MI", "LDO.MI", "UCG.MI", "STLAM.MI"]
    assert [r["rank"] for r in results["rows"]] == [1, 2, 3, 4]

    eni = results["rows"][0]
    assert "earnings_soon" in eni["flags"]
    assert {"positive", "earnings", "volume", "aligned", "sources"} <= set(eni["components"])
    assert eni["links"]["chart"] == "https://www.tradingview.com/chart/?symbol=MIL%3AENI"
    assert len(eni["news"]) == 2

    ldo = results["rows"][1]
    assert "late" in ldo["flags"] and ldo["components"]["coach_up"] == 10
    assert ldo["coach"]["hypotheses"][0]["thesis"] == "Commandes défense"

    stl = results["rows"][3]
    assert "red" in stl["flags"] and stl["score"] == 0
    assert stl["news"][0]["sentiment"] == "neg"

    ucg = results["rows"][2]
    assert "followed" in ucg["flags"]

    c = results["counts"]
    assert c["universe"] == 6 and c["shortlist"] == 6 and c["kept"] == 4
    assert c["excluded_no_catalyst"] == 2 and c["excluded_red"] == 0
    assert c["news_from_cache"] == 1        # STLAM : cache du coach frais, pas de requête
    assert results["source"] == "screener"
    assert {"code": "market_failed", "market": "uk", "error": "HTTP 403"} in results["warnings"]

    on_disk = json.loads((tmp_path / "results.json").read_text(encoding="utf-8"))
    assert on_disk["rows"] == results["rows"]
    assert json.loads((tmp_path / "progress.json").read_text(encoding="utf-8"))["phase"] == "done"
    assert results["excel"] and (tmp_path / results["excel"]).is_file()
    wb = load_workbook(str(tmp_path / results["excel"]))
    assert wb.sheetnames == ["Candidats", "Infos"]
    assert any("Coach :" in line for line in logs)


def test_exclude_red_removes_and_counts(tmp_path):
    results, _ = _run(tmp_path, cfg=_cfg(exclude_red=True))
    assert "STLAM.MI" not in [r["symbol"] for r in results["rows"]]
    assert results["counts"]["excluded_red"] == 1


def test_top_n_cuts_the_list(tmp_path):
    results, _ = _run(tmp_path, cfg=_cfg(top_n=5, shortlist=10))
    assert len(results["rows"]) == 4             # moins de candidats que top_n
    results, _ = _run(tmp_path, cfg=_cfg(top_n=5, shortlist=10, exclude_red=True))
    assert results["counts"]["kept"] == 3


def test_shortlist_limits_news_requests(tmp_path):
    calls = []
    deps = _deps(news=_news_fetch(NEWS_SCRIPT, calls))
    cfg = _cfg()
    cfg["shortlist"] = 2                         # sous le plancher de validate : forcé ici
    results, _ = _run(tmp_path, cfg=cfg, deps=deps)
    assert results["counts"]["shortlist"] == 2
    assert len(calls) <= 2


def test_previous_run_marks_new_rows(tmp_path):
    results, _ = _run(tmp_path, previous_symbols={"ENI.MI"})
    flags = {r["symbol"]: r["flags"] for r in results["rows"]}
    assert "new" not in flags["ENI.MI"]
    assert "new" in flags["LDO.MI"]
    results, _ = _run(tmp_path, previous_symbols=None)
    assert all("new" not in r["flags"] for r in results["rows"])


def test_empty_coach_is_a_warning_not_a_silence(tmp_path):
    results, _ = _run(tmp_path, deps=_deps(loaders=FakeLoaders()))
    assert {"code": "coach_empty"} in results["warnings"]


def test_news_breaker_marks_unverified(tmp_path):
    script = {("MIL:%s" % t, "en"): (None, 429) for t in ("ENI", "UCG", "LDO", "ENEL", "RACE")}
    results, _ = _run(tmp_path, deps=_deps(news=_news_fetch(script)))
    assert any(w["code"] == "news_breaker" for w in results["warnings"])
    eni = [r for r in results["rows"] if r["symbol"] == "ENI.MI"][0]
    assert "news_unverified" in eni["flags"]


def test_stop_flag_stops_before_writing_results(tmp_path):
    (tmp_path / "stop.flag").write_text("1", encoding="utf-8")
    with pytest.raises(engine.Stopped):
        _run(tmp_path)
    assert not (tmp_path / "results.json").exists()


def test_fallback_universe_when_screener_fails_everywhere(tmp_path):
    def chart(symbol):
        closes = [100.0, 101.0, 102.0, 101.5, 103.0, 104.0, 106.0]
        vols = [1e6, 1.1e6, 0.9e6, 1e6, 1e6, 1e6, 3e6]
        return {"chart": {"result": [{
            "meta": {"regularMarketPrice": 106.0, "currency": "EUR", "longName": "Eni S.p.A.",
                     "exchangeName": "MIL"},
            "timestamp": list(range(len(closes))),
            "indicators": {"quote": [{"open": closes, "high": closes, "low": closes,
                                      "close": closes, "volume": vols}]}}]}}

    deps = _deps(screener=FakeScreener(fail={"italy"}), chart=chart,
                 fallback_symbols=lambda u: ["ENI.MI", "AAPL", "NESN.SW"])
    results, _ = _run(tmp_path, cfg=_cfg(markets=["italy"]), deps=deps)
    assert results["source"] == "fallback"
    assert {"code": "fallback_universe"} in results["warnings"]
    assert results["counts"]["universe"] == 1          # seul ENI.MI est sur le marché choisi
    eni = results["rows"][0]
    assert eni["tv_symbol"] == "MIL:ENI"
    assert eni["rel_volume"] == 3.0
    # pas de volume « à l'heure » chez Yahoo : le 10 j, comparé à son marché
    # (une seule ligne : pas de médiane, diviseur 1)
    assert eni["rel_volume_time"] is None
    assert eni["rel_volume_adj"] == 3.0
    # Yahoo ne dit pas l'état de séance : rien n'est affirmé, rien n'est « périmé »
    assert (eni["session_state"], eni["session_date"], eni["session_stale"]) == (None, None, False)
    assert eni["change_pct"] == round((106 - 104) / 104 * 100, 2)


def test_fallback_breaker_stops_after_three_failures(tmp_path):
    calls = []

    def chart(symbol):
        calls.append(symbol)
        raise OSError("network down")

    deps = _deps(screener=FakeScreener(fail={"america"}), chart=chart,
                 fallback_symbols=lambda u: ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "META"])
    results, logs = _run(tmp_path, cfg=_cfg(markets=["america"]), deps=deps)
    assert calls == ["AAPL", "MSFT", "NVDA"]          # pas 6 × 13 s de vide
    assert {"code": "fallback_failed"} in results["warnings"]
    assert any("repli abandonné" in line for line in logs)


def test_universe_empty_everywhere_still_writes_results(tmp_path):
    deps = _deps(screener=FakeScreener(fail={"italy"}))
    results, _ = _run(tmp_path, cfg=_cfg(markets=["italy"]), deps=deps)
    assert results["rows"] == [] and results["counts"]["universe"] == 0
    assert (tmp_path / "results.json").is_file()


def test_row_from_chart_handles_pence_and_garbage():
    raw = {"chart": {"result": [{
        "meta": {"regularMarketPrice": 2450.0, "currency": "GBp", "shortName": "Shell"},
        "timestamp": [1, 2, 3],
        "indicators": {"quote": [{"open": [2400, 2420, 2450], "high": [2400, 2420, 2450],
                                  "low": [2400, 2420, 2450], "close": [2400, 2420, 2450],
                                  "volume": [1e7, 1e7, 1e7]}]}}]}}
    row = engine.row_from_chart("SHEL.L", raw)
    assert "rel_volume_time" in row and row["rel_volume_time"] is None
    for key in ("session_state", "session_date", "session_tz"):
        assert key in row and row[key] is None
    assert row["currency"] == "GBX"
    assert row["avg_value_meur"] == round(1e7 * 2450 * 0.0117 / 1e6, 2)
    assert row["tv_symbol"] == "LSE:SHEL"
    assert engine.row_from_chart("SHEL.L", {"chart": {"result": []}}) is None
    assert engine.row_from_chart("XX.ZZ", raw) is None          # place inconnue
    assert engine.row_from_chart("SHEL.L", None) is None


# --------------------------------------------------------------------------- #
# Biais horaire : volume comparable + quota par marché dans la présélection
# --------------------------------------------------------------------------- #

SNAPSHOT_NOW = datetime(2026, 10, 19, 13, 30, 37, tzinfo=timezone.utc)
SNAPSHOT_MARKETS = ["switzerland", "italy", "germany", "france", "america"]


class PayloadScreener:
    """Sert des réponses brutes du screener, marché par marché (403 sinon)."""

    def __init__(self, payloads):
        self.payloads = payloads

    def scan(self, market, cfg):
        if market.id not in self.payloads:
            raise sc.ScreenerError("HTTP 403", 403)
        return self.payloads[market.id], {"status": 200, "attempts": 1, "ignored_unknown": False}


def _snapshot_payloads():
    """Capture RÉELLE du lundi 19/10/2026 13:30 UTC : Europe en séance, États-Unis
    en pré-ouverture (leurs chiffres sont ceux du vendredi 16/10)."""
    path = os.path.join(FIXTURES, "stockscan", "screener_snapshot_2026-10-19T1330Z.json")
    with open(path, encoding="utf-8") as f:
        return json.load(f)["markets"]


def _payload(*rows):
    """Réponse du screener construite colonne par colonne : ``(tv_symbol, {colonne: valeur})``."""
    data = []
    for tv_symbol, cols in rows:
        assert set(cols) <= set(sc.COLUMNS)          # une faute de frappe ferait un test à vide
        base = {c: None for c in sc.COLUMNS}
        base.update({"type": "stock", "currency": "EUR", "fundamental_currency_code": "EUR"})
        base.update(cols)
        data.append({"s": tv_symbol, "d": [base[c] for c in sc.COLUMNS]})
    return {"totalCount": len(data), "data": data}


def test_hour_bias_regression_on_real_snapshot(tmp_path):
    """Sans coach ni news fraîches, la présélection de 20 titres donnait 16
    places aux États-Unis, 0 à la France et 1 à la Suisse : le volume relatif
    10 j d'une séance européenne EN COURS (0,3) perdait face à la séance
    précédente COMPLÈTE d'une place pas encore ouverte (1,2 : vendredi)."""
    deps = engine.Deps(screener=PayloadScreener(_snapshot_payloads()), coach_loaders=FakeLoaders(),
                       news_fetch=None, now=lambda: SNAPSHOT_NOW,
                       sleep=lambda s: None, monotonic=lambda: 0.0)
    cfg = cfgmod.validate({"markets": SNAPSHOT_MARKETS, "shortlist": 20, "top_n": 10})[0]
    results, logs = _run(tmp_path, cfg=cfg, deps=deps)

    by_market = {m["id"]: m for m in results["markets"]}
    assert sorted(by_market) == sorted(SNAPSHOT_MARKETS)
    for market_id, status in by_market.items():
        assert status["shortlisted"] >= 2, market_id        # 20 × 0,5 / 5 marchés
        assert status["volume_median"] is not None, market_id
    assert sum(m["shortlisted"] for m in by_market.values()) == results["counts"]["shortlist"] == 20
    assert by_market["america"]["shortlisted"] < 20          # plus 100 % américaine
    assert by_market["france"]["volume_median"] == 0.987

    # le champ traverse jusqu'au résultat (piège #61 : une couche qui l'oublie le tue)
    assert results["rows"]
    for row in results["rows"]:
        assert isinstance(row["rel_volume_time"], float)
        assert isinstance(row["rel_volume_adj"], float)
    on_disk = json.loads((tmp_path / "results.json").read_text(encoding="utf-8"))
    assert on_disk["rows"][0]["rel_volume_adj"] == results["rows"][0]["rel_volume_adj"]

    # l'onglet Infos de l'Excel écrit chaque compteur dans une cellule : jamais de dict
    assert results["excel"]
    assert all(not isinstance(v, (dict, list)) for v in results["counts"].values())
    assert ("Volume relatif médian à l'heure : switzerland 1,06 · italy 0,91 · germany 0,86"
            " · france 0,99 · america 1,19") in logs
    assert any(line.startswith("Présélection : 20 titres — ") for line in logs)


def test_rows_say_which_session_their_figures_come_from(tmp_path):
    """Lundi 13:30 UTC, la variation de -11,91 % de CoreWeave affichée à côté de
    « CoreWeave jumps as Goldman upgrades » est celle de VENDREDI : la ligne doit
    le dire (pré-ouverture, chiffres du 16/10, périmée). Une ligne européenne en
    séance n'est pas périmée."""
    news_at = (SNAPSHOT_NOW - timedelta(hours=2)).isoformat()
    loaders = FakeLoaders(events=[
        {"ts": news_at, "symbol": "CRWV", "title": "CoreWeave jumps as Goldman upgrades",
         "link": "https://n/crwv", "sentiment": "pos", "src": "pressefi"},
        {"ts": news_at, "symbol": "RHM.DE", "title": "Rheinmetall wins German army ammunition order",
         "link": "https://n/rhm", "sentiment": "pos", "src": "pressefi"},
    ])
    deps = engine.Deps(screener=PayloadScreener(_snapshot_payloads()), coach_loaders=loaders,
                       news_fetch=None, now=lambda: SNAPSHOT_NOW,
                       sleep=lambda s: None, monotonic=lambda: 0.0)
    cfg = cfgmod.validate({"markets": SNAPSHOT_MARKETS, "shortlist": 20, "top_n": 10})[0]
    results, _ = _run(tmp_path, cfg=cfg, deps=deps)

    rows = {r["symbol"]: r for r in results["rows"]}
    crwv = rows["CRWV"]
    assert crwv["change_pct"] == pytest.approx(-11.91, abs=0.01)
    assert (crwv["session_state"], crwv["session_date"], crwv["session_stale"]) == \
        ("pre_open", "2026-10-16", True)
    rhm = rows["RHM.DE"]
    assert (rhm["session_state"], rhm["session_date"], rhm["session_stale"]) == \
        ("open", "2026-10-19", False)
    for row in results["rows"]:
        expected = (("pre_open", "2026-10-16", True) if row["market"] == "america"
                    else ("open", "2026-10-19", False))
        assert (row["session_state"], row["session_date"], row["session_stale"]) == expected, \
            row["symbol"]
    on_disk = json.loads((tmp_path / "results.json").read_text(encoding="utf-8"))
    assert {r["symbol"]: r["session_stale"] for r in on_disk["rows"]} == \
        {s: r["session_stale"] for s, r in rows.items()}


def test_stale_is_judged_on_the_local_day_of_the_place(tmp_path):
    """Lundi 23:30 UTC = mardi 01:30 à Rome : les chiffres de la séance de lundi y
    sont ceux d'HIER, alors qu'en UTC on serait encore lundi."""
    late = datetime(2026, 10, 19, 23, 30, tzinfo=timezone.utc)
    payload = _payload(("MIL:ENI", {
        "name": "ENI", "close": 15.0, "change": 1.0, "average_volume_10d_calc": 2e6,
        "earnings_release_next_trading_date_fq": 1792800000,      # 24/10 : catalyseur
        "current_session": "out_of_session", "time": 1792393200, "timezone": "Europe/Rome"}))
    deps = engine.Deps(screener=PayloadScreener({"italy": payload}), coach_loaders=FakeLoaders(),
                       news_fetch=None, now=lambda: late,
                       sleep=lambda s: None, monotonic=lambda: 0.0)
    results, _ = _run(tmp_path, cfg=_cfg(markets=["italy"]), deps=deps)
    (eni,) = results["rows"]
    assert (eni["session_state"], eni["session_date"], eni["session_stale"]) == \
        ("closed", "2026-10-19", True)


def test_markets_status_carries_volume_median_and_shortlisted(tmp_path):
    results, _ = _run(tmp_path)
    by_market = {m["id"]: m for m in results["markets"]}
    # Italie : 6 titres liquides, moins que VOLUME_MEDIAN_MIN_ROWS -> pas de médiane
    assert by_market["italy"]["volume_median"] is None
    assert by_market["italy"]["shortlisted"] == 6
    assert by_market["uk"]["volume_median"] is None          # marché en échec
    assert by_market["uk"]["shortlisted"] == 0


def test_equal_scores_are_ordered_by_the_comparable_volume(tmp_path):
    """À score égal, le départage suit le volume comparé à SON marché, pas le 10 j
    brut — qui donnerait toujours l'avantage à la place pas encore ouverte."""
    common = {"close": 10.0, "change": 0.0, "Perf.W": 0.0, "average_volume_10d_calc": 2e6,
              "earnings_release_next_trading_date_fq": 1792800000}     # résultats le 24/10
    payload = _payload(
        ("MIL:AAA", dict(common, name="AAA", relative_volume_10d_calc=1.4,
                         **{"relative_volume_intraday|5": 0.5})),
        ("MIL:BBB", dict(common, name="BBB", average_volume_10d_calc=1e6,
                         relative_volume_10d_calc=0.2, **{"relative_volume_intraday|5": 1.3})))
    deps = _deps(screener=PayloadScreener({"italy": payload}), loaders=FakeLoaders(),
                 news=_news_fetch({}))
    results, _ = _run(tmp_path, cfg=_cfg(markets=["italy"]), deps=deps)
    assert [r["score"] for r in results["rows"]] == [10, 10]     # résultats proches, rien d'autre
    assert [r["ticker"] for r in results["rows"]] == ["BBB", "AAA"]


def test_yahoo_market_helpers():
    assert mk.market_of_yahoo("ENI.MI") == "italy"
    assert mk.market_of_yahoo("BRK-B") == "america"
    assert mk.market_of_yahoo("EURUSD=X") is None
    assert mk.yahoo_to_tv("RO.SW") == "SIX:ROG"
    assert mk.yahoo_to_tv("BRK-B") == "NASDAQ:BRK.B"
    assert mk.yahoo_to_tv("ASML.AS") == "EURONEXT:ASML"


# --------------------------------------------------------------------------- #
# __main__
# --------------------------------------------------------------------------- #

def test_main_reads_config_and_returns_codes(tmp_path):
    run_dir = tmp_path / "runs" / ("a" * 32)
    run_dir.mkdir(parents=True)
    (run_dir / "config.json").write_text(json.dumps({"markets": ["italy"], "lang": "it"}),
                                         encoding="utf-8")
    code = cli.main(["--out", str(run_dir), "--config", str(run_dir / "config.json"),
                     "--user", "massii"], deps=_deps())
    assert code == 0
    results = json.loads((run_dir / "results.json").read_text(encoding="utf-8"))
    assert results["config"]["lang"] == "it"
    assert results["excel"].startswith("scanner_azioni_")


def test_main_previous_run_feeds_new_flag(tmp_path):
    runs = tmp_path / "runs"
    old = runs / ("b" * 32)
    old.mkdir(parents=True)
    (old / "results.json").write_text(json.dumps({"rows": [{"symbol": "ENI.MI"}]}), encoding="utf-8")
    assert cli.previous_symbols(runs / ("c" * 32)) == {"ENI.MI"}


def test_main_stop_and_crash_codes(tmp_path):
    run_dir = tmp_path / "r"
    run_dir.mkdir()
    (run_dir / "stop.flag").write_text("1", encoding="utf-8")
    assert cli.main(["--out", str(run_dir)], deps=_deps()) == 3

    class Boom(FakeScreener):
        def scan(self, market, cfg):
            raise RuntimeError("bug")

    run2 = tmp_path / "r2"
    assert cli.main(["--out", str(run2), "--config", str(tmp_path / "absent.json")],
                    deps=_deps(screener=Boom())) == 1


def test_main_empty_universe_returns_2(tmp_path):
    run_dir = tmp_path / "r3"
    code = cli.main(["--out", str(run_dir)], deps=_deps(screener=FakeScreener(fail={"italy"})))
    assert code == 2
    assert (run_dir / "results.json").is_file()


def test_probe_writes_raw_responses(tmp_path):
    class Resp:
        status_code = 200

        def json(self):
            with open(os.path.join(FIXTURES, "tvcoach", "tv_news_aapl.json"), encoding="utf-8") as f:
                return json.load(f)

    class News:
        def get(self, url, headers=None):
            return Resp()

    code = cli.probe(str(tmp_path), "italy", None, screener=FakeScreener(), news_get=News())
    assert code == 0
    assert (tmp_path / "screener_italy.json").is_file()
    assert (tmp_path / "tvnews_MIL_UCG.json").is_file()


def test_probe_reports_screener_failure(tmp_path):
    assert cli.probe(str(tmp_path), "italy", None, screener=FakeScreener(fail={"italy"})) == 1
    assert cli.probe(str(tmp_path), "japan", None, screener=FakeScreener()) == 1
