"""Scanner d'actions — lecture seule des mémoires du coach.

Deux familles de tests : la logique (chargeurs factices) et un test
d'INTÉGRATION qui écrit de vrais fichiers au format du coach dans un
``store.DATA_DIR`` temporaire et passe par les VRAIS chargeurs — c'est lui qui
attrape un champ lu au mauvais niveau (piège #61 du dépôt).
"""
import json
from datetime import datetime, timedelta, timezone

import pytest

from backend.bots.stockscan import coach

NOW = datetime(2026, 10, 17, 7, 0, tzinfo=timezone.utc)


def _iso(hours_ago):
    return (NOW - timedelta(hours=hours_ago)).isoformat()


UNIVERSE = [
    {"symbol": "ENI.MI", "ticker": "ENI", "name": "Eni S.p.A.", "tv_symbol": "MIL:ENI"},
    {"symbol": "STLAM.MI", "ticker": "STLAM", "name": "Stellantis N.V.", "tv_symbol": "MIL:STLAM"},
    {"symbol": "AAPL", "ticker": "AAPL", "name": "Apple Inc.", "tv_symbol": "NASDAQ:AAPL"},
    {"symbol": "RO.SW", "ticker": "ROG", "name": "Roche Holding AG", "tv_symbol": "SIX:ROG"},
]


class FakeLoaders(coach.Loaders):
    def __init__(self, **kw):
        self.data = kw

    def users(self):
        if "users_error" in self.data:
            raise OSError("disk")
        return self.data.get("users", [])

    def events(self, username):
        return self.data.get("events", {}).get(username, [])

    def trends(self, now):
        return self.data.get("trends", {})

    def tv_state(self):
        return self.data.get("tv_state", {})

    def hypotheses(self):
        return self.data.get("hypotheses", [])

    def portfolio(self, username):
        return self.data.get("portfolio", {}).get(username)

    def watchlist(self, username):
        return self.data.get("watchlist", {}).get(username, [])


def test_events_are_merged_across_users_and_deduped_by_link():
    ev = {"ts": _iso(2), "symbol": "ENI.MI", "title": "Eni beats estimates",
          "link": "https://n/1", "sentiment": "pos", "src": "pressefi"}
    loaders = FakeLoaders(users=["massii", "papy"],
                          events={"massii": [ev], "papy": [dict(ev)]})
    view = coach.load("massii", NOW, 48, UNIVERSE, loaders)
    assert len(view["by_symbol"]["ENI.MI"]["news"]) == 1
    assert view["stats"]["events"] == 1
    assert view["stats"]["users"] == 2


def test_window_pseudo_symbols_and_out_of_universe():
    events = [
        {"ts": _iso(100), "symbol": "ENI.MI", "title": "Eni old", "link": "https://n/old", "src": "eco"},
        {"ts": _iso(1), "symbol": "GOV", "title": "Tariffs announced", "link": "https://n/gov"},
        {"ts": _iso(1), "symbol": None, "title": "No symbol", "link": "https://n/none"},
        {"ts": _iso(1), "symbol": "TSLA", "title": "Tesla jumps", "link": "https://n/tsla", "src": "x"},
    ]
    view = coach.load("massii", NOW, 48, UNIVERSE, FakeLoaders(users=["massii"],
                                                               events={"massii": events}))
    assert view["by_symbol"] == {}
    assert view["stats"]["out_of_universe"] == 1     # TSLA n'est pas dans l'univers
    assert view["stats"]["events_in_window"] == 3


def test_yahoo_symbol_feed_requires_the_company_to_be_named():
    events = [
        # flux Yahoo par symbole (pas de src) : sectoriel -> doit NOMMER la société
        {"ts": _iso(1), "symbol": "ENI.MI", "title": "Oil majors rally as crude climbs",
         "link": "https://n/sector", "sentiment": "neutral"},
        {"ts": _iso(1), "symbol": "ENI.MI", "title": "Eni signs gas deal with Algeria",
         "link": "https://n/eni", "sentiment": "neutral"},
        # même sans src, un dépôt TradingView est filtré par symbole : admis
        {"ts": _iso(1), "symbol": "ENI.MI", "title": "Refining margins widen",
         "link": "https://n/tv", "source": "tradingview", "src": "tradingview"},
    ]
    view = coach.load("massii", NOW, 48, UNIVERSE, FakeLoaders(users=["massii"],
                                                               events={"massii": events}))
    titles = [n["title"] for n in view["by_symbol"]["ENI.MI"]["news"]]
    assert "Oil majors rally as crude climbs" not in titles
    assert "Eni signs gas deal with Algeria" in titles
    assert "Refining margins widen" in titles
    assert view["stats"]["dropped_irrelevant"] == 1


def test_short_tickers_are_not_relevance_anchors():
    anchors = coach.build_anchors([{"symbol": "ENI.MI", "ticker": "ENI", "name": "Eni S.p.A."},
                                   {"symbol": "STLAM.MI", "ticker": "STLAM", "name": "Stellantis N.V."}])
    assert anchors.get("eni") == "ENI.MI"             # vient du NOM sans forme juridique
    assert anchors.get("stlam") == "STLAM.MI"         # ticker de 5 lettres : ancre
    anchors = coach.build_anchors([{"symbol": "ON", "ticker": "ON", "name": "ON"}])
    assert "on" not in anchors


def test_advice_titles_are_filtered_and_counted():
    events = [{"ts": _iso(1), "symbol": "AAPL", "title": "3 stocks to buy like Apple",
               "link": "https://n/adv", "src": "pressefi"}]
    view = coach.load("massii", NOW, 48, UNIVERSE, FakeLoaders(users=["massii"],
                                                               events={"massii": events}))
    assert view["stats"]["filtered_advice"] == 1
    assert "AAPL" not in view["by_symbol"]


def test_sec_filings_are_kept_as_filings_too():
    events = [{"ts": _iso(3), "symbol": "AAPL", "title": "AAPL — 8-K déposé (événement matériel)",
               "link": "https://www.sec.gov/x", "sentiment": "watch", "src": "sec_own", "form": "8-K"}]
    view = coach.load("massii", NOW, 48, UNIVERSE, FakeLoaders(users=["massii"],
                                                               events={"massii": events}))
    slot = view["by_symbol"]["AAPL"]
    assert slot["filings"][0]["form"] == "8-K"
    assert slot["news"][0]["family"] == "sec"


def test_tv_cache_trends_hypotheses_and_aliases():
    loaders = FakeLoaders(
        users=["massii"],
        tv_state={"items_by_symbol": {"NASDAQ:AAPL": {"fetched_at": _iso(0.1), "items": [
            {"id": "1", "title": "Apple unveils new chip", "published": _iso(2),
             "provider": "reuters", "url": "https://www.tradingview.com/news/1",
             "symbol": "AAPL", "tv_symbol": "NASDAQ:AAPL"}]}}},
        trends={"AAPL": {"count": 8, "prev": 2}, "TSLA": {"count": 50, "prev": 10}},
        hypotheses=[
            {"status": "open", "tickers": ["ROG.SW"], "direction": "up", "thesis": "Approbation FDA",
             "confidence": "moyenne", "horizon_days": 10},
            {"status": "scored", "tickers": ["AAPL"], "direction": "down"},
            {"status": "open", "tickers": ["AAPL"], "direction": "down", "evicted_at": "x"},
        ],
    )
    view = coach.load("massii", NOW, 48, UNIVERSE, loaders)
    assert view["by_symbol"]["AAPL"]["news"][0]["source"] == "tradingview"
    assert view["by_symbol"]["AAPL"]["reddit"] == {"count": 8, "prev": 2}
    assert "TSLA" not in view["by_symbol"]
    # ROG.SW (ticker SIX) est relu sous l'alias Yahoo canonique RO.SW
    assert view["by_symbol"]["RO.SW"]["hypotheses"][0]["direction"] == "up"
    assert view["stats"]["hypotheses_open"] == 1
    assert "NASDAQ:AAPL" in view["tv_cache"]


def test_followed_is_only_the_requesting_user():
    loaders = FakeLoaders(
        users=["massii", "papy"],
        portfolio={"massii": {"positions": [{"symbol": "ENI.MI"}]},
                   "papy": {"positions": [{"symbol": "AAPL"}]}},
        watchlist={"massii": [{"symbol": "rog.sw", "name": "Roche"}]},
    )
    view = coach.load("massii", NOW, 48, UNIVERSE, loaders)
    assert view["followed"] == {"ENI.MI", "RO.SW"}


def test_broken_memory_is_isolated_and_reported():
    loaders = FakeLoaders(users_error=True,
                          events={"massii": [{"ts": _iso(1), "symbol": "AAPL",
                                              "title": "Apple beats estimates",
                                              "link": "https://n/a", "src": "pressefi"}]})
    view = coach.load("massii", NOW, 48, UNIVERSE, loaders)
    assert any(e.startswith("users:") for e in view["errors"])
    # le demandeur est lu quand même
    assert "AAPL" in view["by_symbol"]


# --------------------------------------------------------------------------- #
# Intégration : les VRAIS chargeurs sur de vrais fichiers du coach
# --------------------------------------------------------------------------- #

@pytest.fixture
def coach_dir(tmp_path, monkeypatch):
    from backend.bots.paper import store
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    return tmp_path


def _write(path, data):
    path.write_text(json.dumps(data), encoding="utf-8")


def test_real_loaders_read_real_coach_files(coach_dir):
    _write(coach_dir / "massii.json", {"cash": 10000, "positions": [{"symbol": "ENI.MI", "qty": 10}]})
    _write(coach_dir / "massii.watchlist.json", {"symbols": [{"symbol": "AAPL", "name": "Apple Inc."}]})
    _write(coach_dir / "massii.news_seen.json", {"events": [
        {"ts": _iso(2), "symbol": "ENI.MI", "title": "Eni beats estimates on trading",
         "link": "https://n/eni", "sentiment": "pos"},
    ]})
    _write(coach_dir / "newswatch_global.json", {
        "events": [{"ts": _iso(1), "symbol": "AAPL", "title": "AAPL — 8-K déposé",
                    "link": "https://sec/a", "sentiment": "watch", "src": "sec_own", "form": "8-K"}],
        "reddit_trends": {"AAPL": [_iso(1), _iso(2), _iso(3), _iso(4), _iso(5), _iso(30)]},
        "tv_news": {"items_by_symbol": {"MIL:STLAM": {"fetched_at": _iso(0.2), "items": [
            {"id": "s1", "title": "Stellantis issues profit warning", "published": _iso(3),
             "provider": "reuters", "url": "https://www.tradingview.com/news/s1",
             "symbol": "STLAM.MI", "tv_symbol": "MIL:STLAM"}]}}},
    })
    _write(coach_dir / "radar.json", {"hypotheses": [
        {"id": "h1", "status": "open", "tickers": ["STLAM.MI"], "direction": "down",
         "thesis": "Ventes en baisse", "confidence": "basse", "horizon_days": 7}],
        "stats": {"hits": 0, "misses": 0, "unclear": 0}})

    view = coach.load("massii", NOW, 48, UNIVERSE)

    assert view["errors"] == []
    assert view["followed"] == {"ENI.MI", "AAPL"}
    eni = view["by_symbol"]["ENI.MI"]["news"]
    assert eni and eni[0]["sentiment"] == "pos"
    assert view["by_symbol"]["AAPL"]["filings"][0]["form"] == "8-K"
    assert view["by_symbol"]["AAPL"]["reddit"] == {"count": 5, "prev": 1}
    stl = view["by_symbol"]["STLAM.MI"]
    assert stl["news"][0]["sentiment"] == "neg"
    assert stl["hypotheses"][0]["direction"] == "down"
    assert view["stats"]["tv_cache_symbols"] == 1
    # et rien n'a été écrit chez le coach
    assert sorted(p.name for p in coach_dir.iterdir()) == [
        "massii.json", "massii.news_seen.json", "massii.watchlist.json",
        "newswatch_global.json", "radar.json"]


def test_real_loaders_on_empty_coach_dir(coach_dir):
    view = coach.load("massii", NOW, 48, UNIVERSE)
    assert view["by_symbol"] == {}
    assert view["stats"]["events"] == 0
    assert view["errors"] == []
