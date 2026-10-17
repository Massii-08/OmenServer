"""Scanner d'actions — admission/classement des news et flux TradingView frais.

Fixture RÉELLE réutilisée : ``fixtures/tvcoach/tv_news_aapl.json`` (flux
TradingView de NASDAQ:AAPL capturé le 2026-09-09, 200 items, le plus récent
publié à 1788975540 = 2026-09-09 16:59 UTC). ``NOW`` est épinglé juste après.
"""
import json
import os
from datetime import datetime, timedelta, timezone

import pytest

from backend.bots.stockscan import news as nw

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")
NOW = datetime(2026, 9, 9, 18, 0, tzinfo=timezone.utc)


def _aapl_payload():
    with open(os.path.join(FIXTURES, "tvcoach", "tv_news_aapl.json"), "r", encoding="utf-8") as f:
        return json.load(f)


# --------------------------------------------------------------------------- #
# Admission / classement
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("title", [
    "3 stocks to buy before earnings season",
    "Should you buy Nvidia after the dip?",
    "Is it a buy? Apple after WWDC",
    "Our top picks for October",
    "Le 5 azioni da comprare adesso",
    "Faut-il acheter Airbus ?",
    "Top stocks for the week",          # règle du coach
])
def test_reader_directed_advice_is_refused(title):
    assert nw.is_advice(title) is True


@pytest.mark.parametrize("title", [
    "Goldman upgrades Eni to buy on refining margins",   # changement de note : admis
    "Stellantis to sell its stake in a Chinese venture",  # une cession : un fait
    "Klarna, the buy now, pay later lender, files for IPO",
    "Apple announces buyback of $90bn",
    "",
])
def test_facts_are_not_advice(title):
    assert nw.is_advice(title) is False


def test_classify_uses_coach_rules():
    assert nw.classify("Stellantis issues profit warning") == "neg"
    assert nw.classify("Eni beats estimates on strong trading") == "pos"
    assert nw.classify("Ferrari to report earnings next week") == "watch"
    assert nw.classify("Enel opens a new office") == "neutral"
    assert nw.classify(None) == "neutral"


def test_parse_ts_variants():
    assert nw.parse_ts("2026-09-09T10:00:00+00:00") == datetime(2026, 9, 9, 10, tzinfo=timezone.utc)
    # un ISO naïf est lu en UTC
    assert nw.parse_ts("2026-09-09T10:00:00") == datetime(2026, 9, 9, 10, tzinfo=timezone.utc)
    assert nw.parse_ts(1788975540).tzinfo is not None
    assert nw.parse_ts(1788975540000) == nw.parse_ts(1788975540)
    assert nw.parse_ts("hier") is None
    assert nw.parse_ts(True) is None


def test_window_and_recency():
    assert nw.in_window(NOW - timedelta(hours=47), NOW, 48)
    assert not nw.in_window(NOW - timedelta(hours=49), NOW, 48)
    assert nw.in_window(NOW + timedelta(minutes=30), NOW, 48)     # horloge décalée
    assert not nw.in_window(NOW + timedelta(hours=3), NOW, 48)    # date inventée
    assert nw.recency_weight(2) == 1.0
    assert nw.recency_weight(30) == 0.6
    assert nw.recency_weight(60) == 0.3
    assert nw.recency_weight(None) == 0.0


def test_merge_dedups_and_sorts_first_list_wins():
    a = [{"title": "Eni beats estimates", "url": "https://x/1",
          "published": "2026-09-09T10:00:00+00:00", "source": "tradingview"}]
    b = [{"title": "Eni  beats estimates!", "url": "https://y/other",
          "published": "2026-09-09T11:00:00+00:00", "source": "coach"},
         {"title": "Eni opens plant", "url": "https://x/2",
          "published": "2026-09-09T12:00:00+00:00", "source": "coach"},
         {"title": "dup by url", "url": "https://x/1", "published": "2026-09-09T13:00:00+00:00"}]
    merged = nw.merge(a, b)
    assert [m["title"] for m in merged] == ["Eni opens plant", "Eni beats estimates"]
    assert merged[1]["source"] == "tradingview"


def test_item_from_event_families():
    base = {"ts": "2026-09-09T10:00:00+00:00", "title": "Apple beats estimates",
            "link": "https://example.com/a", "symbol": "AAPL"}
    assert nw.item_from_event(dict(base))["family"] == "presse"
    assert nw.item_from_event(dict(base, source="tradingview", src="news"))["family"] == "tradingview"
    assert nw.item_from_event(dict(base, src="reddit"))["family"] == "social"
    assert nw.item_from_event(dict(base, src="sec_own"))["family"] == "sec"
    item = nw.item_from_event(dict(base, sentiment="crowd"))
    assert item["sentiment"] == "pos"             # recalculé : « crowd » n'est pas un sens
    assert nw.item_from_event(dict(base, link="javascript:alert(1)"))["url"] == ""
    assert nw.item_from_event({"title": "sans date"}) is None


def test_admit_counts_advice_and_window():
    items = [
        {"title": "Apple beats estimates", "published": (NOW - timedelta(hours=2)).isoformat()},
        {"title": "3 stocks to buy now", "published": (NOW - timedelta(hours=2)).isoformat()},
        {"title": "Old news", "published": (NOW - timedelta(hours=100)).isoformat()},
    ]
    kept, advice = nw.admit(items, NOW, 48)
    assert [k["title"] for k in kept] == ["Apple beats estimates"]
    assert advice == 1


def test_real_tradingview_payload_parses_into_items():
    from backend.bots.paper import tvnews
    raw = tvnews.parse_items(_aapl_payload(), "NASDAQ:AAPL")
    items = [nw.item_from_tv(r, "en") for r in raw]
    items = [i for i in items if i]
    assert len(items) > 100
    first = items[0]
    assert first["source"] == "tradingview"
    assert first["provider"] == "dow-jones"
    assert first["url"].startswith("https://www.tradingview.com/news/")
    kept, _ = nw.admit(items, NOW, 24)
    assert kept and all(nw.in_window(k["published"], NOW, 24) for k in kept)


# --------------------------------------------------------------------------- #
# fetch_fresh
# --------------------------------------------------------------------------- #

class FakeFetch:
    def __init__(self, script):
        self.script = dict(script)   # {(tv, lang): (items|None, status)}
        self.calls = []

    def __call__(self, tv_symbol, lang):
        self.calls.append((tv_symbol, lang))
        return self.script.get((tv_symbol, lang), ([], 200))


def _clock():
    state = {"t": 0.0, "sleeps": []}

    def sleep(s):
        state["sleeps"].append(s)
        state["t"] += s

    return state, sleep, (lambda: state["t"])


def _raw(title, minutes_ago=30):
    return {"id": title, "title": title, "provider": "reuters",
            "published": (NOW - timedelta(minutes=minutes_ago)).isoformat(),
            "url": "https://www.tradingview.com/news/" + title.replace(" ", "-")}


def test_fetch_fresh_collects_and_paces():
    fetch = FakeFetch({("MIL:ENI", "en"): ([_raw("Eni beats estimates")], 200),
                       ("SIX:NESN", "en"): ([_raw("Nestle opens plant")], 200),
                       ("SIX:NESN", "fr"): ([_raw("Nestlé ouvre une usine")], 200)})
    state, sleep, mono = _clock()
    out, stats = nw.fetch_fresh([("MIL:ENI", ("en",)), ("SIX:NESN", ("en", "fr"))],
                                fetch, now=NOW, sleep=sleep, monotonic=mono)
    assert [i["title"] for i in out["MIL:ENI"]] == ["Eni beats estimates"]
    assert len(out["SIX:NESN"]) == 2
    assert stats["requests"] == 3 and stats["ok"] == 2
    assert state["sleeps"] == [1.2, 1.2]


def test_fetch_fresh_reuses_fresh_coach_cache():
    cache = {"MIL:ENI": {"fetched_at": (NOW - timedelta(minutes=5)).isoformat(),
                         "items": [_raw("Eni from coach cache")]},
             "MIL:UCG": {"fetched_at": (NOW - timedelta(hours=3)).isoformat(),
                         "items": [_raw("stale cache")]}}
    fetch = FakeFetch({("MIL:UCG", "en"): ([_raw("UniCredit fresh")], 200)})
    out, stats = nw.fetch_fresh([("MIL:ENI", ("en",)), ("MIL:UCG", ("en",))],
                                fetch, cache=cache, now=NOW, sleep=lambda s: None)
    assert out["MIL:ENI"][0]["title"] == "Eni from coach cache"
    assert out["MIL:UCG"][0]["title"] == "UniCredit fresh"
    assert stats["from_cache"] == 1
    assert fetch.calls == [("MIL:UCG", "en")]


def test_fetch_fresh_breaker_on_429_marks_rest_unverified():
    fetch = FakeFetch({("A:1", "en"): ([_raw("ok")], 200),
                       ("A:2", "en"): (None, 429)})
    out, stats = nw.fetch_fresh([("A:1", ("en",)), ("A:2", ("en",)), ("A:3", ("en",))],
                                fetch, now=NOW, sleep=lambda s: None)
    assert "A:1" in out
    assert "A:2" not in out and "A:3" not in out
    assert stats["breaker"] is True and stats["breaker_status"] == 429
    assert stats["skipped"] == 1
    assert ("A:3", "en") not in fetch.calls


def test_fetch_fresh_breaker_after_three_consecutive_failures():
    fetch = FakeFetch({("A:%d" % i, "en"): (None, 503) for i in range(5)})
    out, stats = nw.fetch_fresh([("A:%d" % i, ("en",)) for i in range(5)],
                                fetch, now=NOW, sleep=lambda s: None)
    assert out == {}
    assert stats["failed"] == 3 and stats["skipped"] == 2 and stats["breaker"] is True


def test_fetch_fresh_unknown_symbol_is_not_a_failure():
    fetch = FakeFetch({("A:1", "en"): (None, 422), ("A:2", "en"): (None, 422),
                       ("A:3", "en"): (None, 422), ("A:4", "en"): ([_raw("x")], 200)})
    out, stats = nw.fetch_fresh([("A:%d" % i, ("en",)) for i in range(1, 5)],
                                fetch, now=NOW, sleep=lambda s: None)
    assert stats["breaker"] is False
    assert out["A:1"] == [] and len(out["A:4"]) == 1
    assert stats["unknown"] == 3


def test_fetch_fresh_stops_on_request():
    fetch = FakeFetch({})
    calls = {"n": 0}

    def should_stop():
        calls["n"] += 1
        return calls["n"] > 1

    out, stats = nw.fetch_fresh([("A:1", ("en",)), ("A:2", ("en",))], fetch,
                                now=NOW, sleep=lambda s: None, should_stop=should_stop)
    assert list(out) == ["A:1"]
    assert stats["skipped"] == 1


def test_tv_fetcher_uses_coach_url_and_parser():
    class Resp:
        status_code = 200

        def json(self):
            return _aapl_payload()

    class Client:
        def __init__(self):
            self.urls = []

        def get(self, url, headers=None):
            self.urls.append((url, headers))
            return Resp()

    client = Client()
    items, status = nw.tv_fetcher(client)("NASDAQ:AAPL", "en")
    assert status == 200 and len(items) > 100
    url, headers = client.urls[0]
    assert "filter=symbol:NASDAQ:AAPL" in url and "filter=lang:en" in url
    assert "OmenServer" in headers["User-Agent"]


def test_tv_fetcher_reports_status_and_network_errors():
    class Resp:
        status_code = 429

    class Client:
        def get(self, url, headers=None):
            return Resp()

    class Broken:
        def get(self, url, headers=None):
            raise OSError("reset")

    assert nw.tv_fetcher(Client())("A:B", "en") == (None, 429)
    assert nw.tv_fetcher(Broken())("A:B", "en") == (None, 0)
