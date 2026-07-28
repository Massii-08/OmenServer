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


def test_parse_skips_null_points():
    raw = _load("chart_gspc.json")
    res = raw["chart"]["result"][0]
    n_before = len(parse_chart(raw).candles)
    # On troue artificiellement le premier point (séance sans donnée)
    res["indicators"]["quote"][0]["open"][0] = None
    assert len(parse_chart(raw).candles) == n_before - 1
