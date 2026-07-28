"""Parsing des réponses chart Yahoo (fixtures réelles capturées le 2026-07-28)."""
import json
import os

import pytest

from pulse.quotes import parse_chart

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def _load(name):
    with open(os.path.join(FIXTURES, name)) as f:
        return json.load(f)


def test_parse_gdaxi_real_fixture():
    md = parse_chart(_load("chart_gdaxi.json"))
    assert md.symbol == "^GDAXI"
    assert md.tz_name == "Europe/Berlin"
    assert md.price and md.price > 0
    assert md.prev_close and md.prev_close > 0
    assert md.currency == "EUR"
    assert len(md.candles) >= 2
    assert md.regular_start and md.regular_end and md.regular_start < md.regular_end
    for c in md.candles:
        assert c.open > 0 and c.close > 0
        assert c.low <= c.high


def test_parse_n225_real_fixture():
    md = parse_chart(_load("chart_n225.json"))
    assert md.tz_name == "Asia/Tokyo"
    assert len(md.candles) >= 2


def test_parse_rejects_error_payload():
    with pytest.raises(ValueError):
        parse_chart({"chart": {"error": {"code": "Not Found"}, "result": None}})


def test_parse_rejects_empty():
    with pytest.raises(ValueError):
        parse_chart({"chart": {"result": []}})


def test_parse_skips_fully_null_points():
    """Une date sans AUCUNE donnée = pas de séance → bougie écartée."""
    raw = _load("chart_gspc.json")
    quote = raw["chart"]["result"][0]["indicators"]["quote"][0]
    n_before = len(parse_chart(raw).candles)
    quote["open"][0] = None
    quote["close"][0] = None
    assert len(parse_chart(raw).candles) == n_before - 1


def test_parse_keeps_half_filled_points():
    """Une bougie à moitié remplie est CONSERVÉE, le côté manquant à None.

    Jeter la bougie du jour parce que sa clôture n'est pas encore consolidée
    décalait la référence de clôture d'une séance (cf. test_unclosed_session).
    """
    raw = _load("chart_gspc.json")
    quote = raw["chart"]["result"][0]["indicators"]["quote"][0]
    n_before = len(parse_chart(raw).candles)

    quote["close"][0] = None          # ouverture seule (séance du jour en cours)
    candles = parse_chart(raw).candles
    assert len(candles) == n_before
    assert candles[0].close is None and candles[0].open is not None

    quote["close"][0] = 7572.4
    quote["open"][0] = None           # clôture seule
    candles = parse_chart(raw).candles
    assert len(candles) == n_before
    assert candles[0].open is None and candles[0].close is not None


def test_parse_derives_high_low_from_the_only_known_side():
    """Sans high/low, on borne avec ce qu'on a — jamais de max(x, None)."""
    raw = _load("chart_gspc.json")
    quote = raw["chart"]["result"][0]["indicators"]["quote"][0]
    quote["close"][0] = None
    quote["high"][0] = None
    quote["low"][0] = None
    c = parse_chart(raw).candles[0]
    assert c.high == c.open and c.low == c.open
