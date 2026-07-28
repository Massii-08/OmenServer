"""Snapshot complet — fetch stub sur fixtures réelles, `now` figé."""
import json
import os

from pulse.config import Instrument
from pulse.snapshot import build_history_stats, build_snapshot

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def _load(name):
    with open(os.path.join(FIXTURES, name)) as f:
        return json.load(f)


CHARTS = {
    "^GDAXI": _load("chart_gdaxi.json"),
    "^GSPC": _load("chart_gspc.json"),
    "^N225": _load("chart_n225.json"),
}

INSTRUMENTS = [
    Instrument("^GDAXI", "DAX (Francoforte)", "europe", "index"),
    Instrument("^GSPC", "S&P 500", "usa", "index"),
    Instrument("^N225", "Nikkei 225 (Tokyo)", "asia", "index"),
]

NOW = 1785240000  # 2026-07-28 12:00 UTC


def test_snapshot_structure():
    snap = build_snapshot(lambda s: CHARTS[s], INSTRUMENTS, NOW)
    assert snap["generated_at"] == NOW
    assert snap["errors"] == []
    assert len(snap["markets"]) == 3
    dax = snap["markets"][0]
    assert dax["symbol"] == "^GDAXI"
    assert dax["label"] == "DAX (Francoforte)"
    assert dax["region"] == "europe"
    assert dax["price"] > 0
    assert dax["clock"]["status"] in ("open", "closed", "unknown")
    assert dax["clock"]["tz_name"] == "Europe/Berlin"
    assert dax["gap"] is None or "gap_pct" in dax["gap"]
    assert isinstance(dax["gap_is_today"], bool)
    assert dax["change_pct"] is not None
    # Sérialisable tel quel (contrat JSON pour le router/l'UI)
    json.dumps(snap)


def test_change_pct_uses_previous_candle_not_chart_previous_close():
    """Régression : meta.chartPreviousClose = clôture d'AVANT le range (10 j),
    pas la veille — la variation doit se calculer sur l'avant-dernière bougie."""
    snap = build_snapshot(lambda s: CHARTS[s], INSTRUMENTS, NOW)
    dax = snap["markets"][0]
    candles = CHARTS["^GDAXI"]["chart"]["result"][0]["indicators"]["quote"][0]
    closes = [c for c in candles["close"] if c is not None]
    assert dax["prev_close"] == closes[-2]
    expected = round((dax["price"] - closes[-2]) / closes[-2] * 100.0, 2)
    assert dax["change_pct"] == expected
    chart_prev = CHARTS["^GDAXI"]["chart"]["result"][0]["meta"]["chartPreviousClose"]
    assert dax["prev_close"] != chart_prev  # le piège : les deux diffèrent sur 10 j


def test_snapshot_isolates_failures():
    def fetch(symbol):
        if symbol == "^GSPC":
            raise OSError("down")
        return CHARTS[symbol]

    snap = build_snapshot(fetch, INSTRUMENTS, NOW)
    assert len(snap["markets"]) == 2
    assert len(snap["errors"]) == 1
    assert snap["errors"][0]["symbol"] == "^GSPC"
    assert "OSError" in snap["errors"][0]["error"]


def test_history_stats_from_fixture():
    hist = build_history_stats(lambda s, r="1y": CHARTS[s], INSTRUMENTS[:1])
    assert hist["errors"] == []
    entry = hist["stats"]["^GDAXI"]
    assert entry["n_sessions"] >= 2
    assert entry["weekday_stats"]  # au moins un jour de semaine présent
    assert isinstance(entry["biggest_gaps"], list)
    json.dumps(hist)
