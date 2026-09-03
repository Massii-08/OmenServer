"""Tests du module DÉCOUVERTE (LOT 11) — 100 % HORS LIGNE.

Aucun appel réseau, aucune horloge réelle : le client HTTP et ``now`` sont
injectés partout. La forme du flux ``trending`` est celle SONDÉE le 03/09 sur
``https://query1.finance.yahoo.com/v1/finance/trending/US?count=15``.
"""
import json
import os
import stat
from datetime import datetime, timedelta

import pytest

from backend.bots.paper import discovery as disc


NOW = datetime(2026, 9, 3, 10, 0, 0)


@pytest.fixture(autouse=True)
def _isolated_data_dir(tmp_path, monkeypatch):
    """Cache en tmp — jamais le vrai ``data/``."""
    monkeypatch.setattr(disc, "DATA_DIR", tmp_path / "paper_trading")
    return tmp_path


# =========================================================================== #
#  Faux client HTTP
# =========================================================================== #

class FakeResp(object):
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload
        self.text = text

    def json(self):
        if self._payload is None:
            raise ValueError("pas de JSON")
        return self._payload


class FakeClient(object):
    """Table URL -> réponse. Une valeur ``Exception`` est LEVÉE (panne réseau)."""

    def __init__(self, routes=None):
        self.routes = dict(routes or {})
        self.calls = []

    def get(self, url, timeout=None):
        self.calls.append(url)
        if url not in self.routes:
            return FakeResp(404, text="not found")
        value = self.routes[url]
        if isinstance(value, Exception):
            raise value
        if isinstance(value, FakeResp):
            return value
        return FakeResp(200, payload=value)


# La forme RÉELLE, sondée le 03/09 (voir CLAUDE.md, LOT 11) ------------------
TRENDING_URL = "https://query1.finance.yahoo.com/v1/finance/trending/US?count=15"

REAL_PAYLOAD = {
    "finance": {
        "result": [{
            "count": 15,
            "quotes": [
                {"symbol": "BTC-USD"}, {"symbol": "TSLA"}, {"symbol": "AVGO"},
                {"symbol": "SNOW"}, {"symbol": "HOOD"}, {"symbol": "CPB"},
                {"symbol": "XRP-USD"}, {"symbol": "CRCL"}, {"symbol": "CIEN"},
                {"symbol": "MSTR"}, {"symbol": "CHPT"}, {"symbol": "ETH-USD"},
                {"symbol": "SPCX"}, {"symbol": "RARE"}, {"symbol": "COIN"},
            ],
            "jobTimestamp": 1788451984810,
            "startInterval": 202609031500,
        }],
        "error": None,
    }
}


# =========================================================================== #
#  fetch_trending
# =========================================================================== #

def test_fetch_trending_parses_the_real_response_shape():
    client = FakeClient({TRENDING_URL: REAL_PAYLOAD})
    symbols = disc.fetch_trending(client=client)
    assert symbols == ["BTC-USD", "TSLA", "AVGO", "SNOW", "HOOD", "CPB",
                       "XRP-USD", "CRCL", "CIEN", "MSTR", "CHPT", "ETH-USD",
                       "SPCX", "RARE", "COIN"]


def test_fetch_trending_uses_the_count_parameter_in_the_url():
    client = FakeClient({
        "https://query1.finance.yahoo.com/v1/finance/trending/US?count=5":
            {"finance": {"result": [{"quotes": [{"symbol": "TSLA"}]}]}},
    })
    assert disc.fetch_trending(client=client, count=5) == ["TSLA"]


def test_fetch_trending_is_empty_on_a_transport_failure():
    client = FakeClient({TRENDING_URL: RuntimeError("TLS handshake KO")})
    assert disc.fetch_trending(client=client) == []


def test_fetch_trending_is_empty_on_a_non_200_status():
    client = FakeClient({TRENDING_URL: FakeResp(503, text="service indisponible")})
    assert disc.fetch_trending(client=client) == []


def test_fetch_trending_is_empty_on_unreadable_json():
    client = FakeClient({TRENDING_URL: FakeResp(200, text="<<<pas du json>>>")})
    assert disc.fetch_trending(client=client) == []


def test_fetch_trending_is_empty_on_a_malformed_shape():
    """Le contrat externe (Yahoo) peut changer de forme sans prévenir — une
    forme inattendue rend une liste vide, jamais une exception."""
    client = FakeClient({TRENDING_URL: {"finance": {"result": []}}})
    assert disc.fetch_trending(client=client) == []
    client2 = FakeClient({TRENDING_URL: {"surprise": True}})
    assert disc.fetch_trending(client=client2) == []


def test_fetch_trending_skips_quotes_without_a_readable_symbol():
    client = FakeClient({TRENDING_URL: {"finance": {"result": [
        {"quotes": [{"symbol": "TSLA"}, {"no_symbol": True}, {"symbol": ""},
                    {"symbol": 42}, {"symbol": "AVGO"}]}]}}})
    assert disc.fetch_trending(client=client) == ["TSLA", "AVGO"]


def test_fetch_trending_never_raises_on_junk_payloads():
    for payload in (None, [], "pas un dict", 0, {"finance": None}):
        client = FakeClient({TRENDING_URL: payload})
        assert disc.fetch_trending(client=client) == []


# =========================================================================== #
#  trending_symbols — cache disque, TTL 15 min
# =========================================================================== #

class CountingClient(object):
    """Compte les GET réellement effectués (patron ``CountingCollector`` de
    ``test_paper_agenda_bridge.py``)."""

    def __init__(self, symbols):
        self.symbols = list(symbols)
        self.calls = 0

    def get(self, url, timeout=None):
        self.calls += 1
        quotes = [{"symbol": s} for s in self.symbols]
        return FakeResp(200, payload={"finance": {"result": [{"quotes": quotes}]}})


def test_a_fresh_cache_costs_zero_request():
    client = CountingClient(["TSLA"])
    first = disc.trending_symbols(now=NOW, client=client)
    assert first == ["TSLA"]
    assert client.calls == 1

    second = disc.trending_symbols(now=NOW + timedelta(minutes=10), client=client)
    assert second == ["TSLA"]
    assert client.calls == 1              # servi par le cache — pas de 2e GET


def test_an_expired_cache_is_refreshed_after_fifteen_minutes():
    client = CountingClient(["TSLA"])
    disc.trending_symbols(now=NOW, client=client)
    disc.trending_symbols(now=NOW + timedelta(minutes=16), client=client)
    assert client.calls == 2


def test_the_cache_file_is_0600_and_readable():
    disc.trending_symbols(now=NOW, client=CountingClient(["TSLA"]))
    path = disc.cache_path()
    assert oct(path.stat().st_mode & 0o777) == "0o600"
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["symbols"] == ["TSLA"]
    assert "fetched_ts" in data and "fetched_at" in data


def test_force_bypasses_a_fresh_cache():
    client = CountingClient(["TSLA"])
    disc.trending_symbols(now=NOW, client=client)
    disc.trending_symbols(now=NOW, client=client, force=True)
    assert client.calls == 2


def test_a_stale_cache_survives_a_dead_source():
    disc.trending_symbols(now=NOW, client=CountingClient(["TSLA"]))
    later = NOW + timedelta(minutes=30)
    dead = FakeClient({})   # tout 404 -> fetch_trending rend []
    assert disc.trending_symbols(now=later, client=dead) == ["TSLA"]


def test_no_cache_and_a_dead_source_is_just_empty():
    dead = FakeClient({})
    assert disc.trending_symbols(now=NOW, client=dead) == []


def test_an_empty_fetch_does_not_wipe_a_usable_cache():
    disc.trending_symbols(now=NOW, client=CountingClient(["TSLA"]))
    later = NOW + timedelta(minutes=20)
    empty_client = FakeClient({disc._trending_url(disc.DEFAULT_COUNT):
                               {"finance": {"result": [{"quotes": []}]}}})
    assert disc.trending_symbols(now=later, client=empty_client) == ["TSLA"]


def test_a_corrupt_cache_is_just_an_empty_cache():
    disc.cache_path().parent.mkdir(parents=True, exist_ok=True)
    disc.cache_path().write_text("<<<pas du json>>>", encoding="utf-8")
    client = CountingClient(["TSLA"])
    assert disc.trending_symbols(now=NOW, client=client) == ["TSLA"]
    assert client.calls == 1


def test_trending_symbols_defaults_now_to_the_real_clock(monkeypatch):
    """``now`` absent -> l'horloge du module (injectable), jamais une
    exception."""
    monkeypatch.setattr(disc, "_now", lambda: NOW.timestamp())
    client = CountingClient(["TSLA"])
    assert disc.trending_symbols(client=client) == ["TSLA"]


# =========================================================================== #
#  discovery_candidates
# =========================================================================== #

def _quote_ok(symbol):
    return {"price": 42.0, "currency": "USD"}


def _quote_none(symbol):
    return None


TRADABLE_NOW = datetime(2026, 9, 3, 16, 0, 0)   # mardi, séance US ouverte (heure de Rome)


def test_discovery_candidates_excludes_symbols_already_present(monkeypatch):
    monkeypatch.setattr(disc, "trending_symbols",
                        lambda **kw: ["TSLA", "CHPT"])
    out = disc.discovery_candidates(["TSLA"], TRADABLE_NOW, quote=_quote_ok)
    assert [row["symbol"] for row in out] == ["CHPT"]


def test_discovery_candidates_dedupes_case_and_alias_against_existing(monkeypatch):
    """``existing_symbols`` est comparé CANONIQUE, pas chaîne brute."""
    monkeypatch.setattr(disc, "trending_symbols", lambda **kw: ["tsla"])
    out = disc.discovery_candidates(["TSLA"], TRADABLE_NOW, quote=_quote_ok)
    assert out == []


def test_discovery_candidates_excludes_a_non_tradable_symbol(monkeypatch):
    """Un marché FERMÉ à cet instant n'a pas sa place dans le bonus tendance
    — le champ ``tradable`` de ``_coach_candidates`` le confirmerait de toute
    façon plus tard, mais la découverte filtre déjà en amont."""
    monkeypatch.setattr(disc, "trending_symbols", lambda **kw: ["TSLA"])
    sunday = datetime(2026, 9, 6, 16, 0, 0)      # dimanche
    out = disc.discovery_candidates([], sunday, quote=_quote_ok)
    assert out == []


def test_discovery_candidates_excludes_a_symbol_without_a_quote(monkeypatch):
    monkeypatch.setattr(disc, "trending_symbols", lambda **kw: ["TSLA"])
    out = disc.discovery_candidates([], TRADABLE_NOW, quote=_quote_none)
    assert out == []


def test_discovery_candidates_respects_the_default_cap_of_four(monkeypatch):
    monkeypatch.setattr(disc, "trending_symbols",
                        lambda **kw: ["A", "B", "C", "D", "E"])
    out = disc.discovery_candidates([], TRADABLE_NOW, quote=_quote_ok)
    assert [row["symbol"] for row in out] == ["A", "B", "C", "D"]


def test_discovery_candidates_respects_a_custom_cap(monkeypatch):
    monkeypatch.setattr(disc, "trending_symbols",
                        lambda **kw: ["A", "B", "C"])
    out = disc.discovery_candidates([], TRADABLE_NOW, quote=_quote_ok, cap=1)
    assert [row["symbol"] for row in out] == ["A"]


def test_discovery_candidates_cap_zero_is_empty(monkeypatch):
    monkeypatch.setattr(disc, "trending_symbols", lambda **kw: ["A"])
    assert disc.discovery_candidates([], TRADABLE_NOW, quote=_quote_ok, cap=0) == []


def test_discovery_candidates_tags_each_row_with_the_trend_provenance(monkeypatch):
    monkeypatch.setattr(disc, "trending_symbols", lambda **kw: ["TSLA"])
    out = disc.discovery_candidates([], TRADABLE_NOW, quote=_quote_ok)
    assert out == [{"symbol": "TSLA", "source": disc.CANDIDATE_SOURCE_DISCOVERY}]
    assert disc.CANDIDATE_SOURCE_DISCOVERY == "tendance"


def test_discovery_candidates_dedupes_the_trending_list_itself(monkeypatch):
    monkeypatch.setattr(disc, "trending_symbols", lambda **kw: ["TSLA", "TSLA"])
    out = disc.discovery_candidates([], TRADABLE_NOW, quote=_quote_ok)
    assert [row["symbol"] for row in out] == ["TSLA"]


def test_discovery_candidates_survives_a_trending_failure(monkeypatch):
    def boom(**kwargs):
        raise RuntimeError("cache disque illisible")
    monkeypatch.setattr(disc, "trending_symbols", boom)
    assert disc.discovery_candidates(["TSLA"], TRADABLE_NOW, quote=_quote_ok) == []


def test_discovery_candidates_survives_a_quote_exception(monkeypatch):
    monkeypatch.setattr(disc, "trending_symbols", lambda **kw: ["TSLA"])

    def boom(symbol):
        raise RuntimeError("Yahoo down")
    out = disc.discovery_candidates([], TRADABLE_NOW, quote=boom)
    assert out == []


def test_discovery_candidates_never_raises_on_junk_existing(monkeypatch):
    monkeypatch.setattr(disc, "trending_symbols", lambda **kw: ["TSLA"])
    for junk in (None, "pas une liste", 0, [None, 123, {}]):
        out = disc.discovery_candidates(junk, TRADABLE_NOW, quote=_quote_ok)
        assert [row["symbol"] for row in out] == ["TSLA"]
