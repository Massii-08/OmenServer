"""Gaps et statistiques — fonctions pures sur bougies synthétiques."""
from pulse.gaps import Gap, all_gaps, biggest_gaps, is_same_local_day, latest_gap, weekday_stats
from pulse.quotes import Candle

TZ = "Europe/Rome"
DAY = 86400
# Lundi 2026-07-20 09:00 Rome
MON = 1784530800


def _c(ts, open_, close):
    return Candle(ts=ts, open=open_, high=max(open_, close), low=min(open_, close), close=close)


def test_latest_gap_up():
    candles = [_c(MON, 100.0, 102.0), _c(MON + DAY, 104.04, 105.0)]
    g = latest_gap(candles, TZ)
    assert g is not None
    assert g.gap_pct == 2.0          # (104.04 - 102) / 102
    assert g.prev_close == 102.0
    assert g.date == "2026-07-21"


def test_latest_gap_needs_two_candles():
    assert latest_gap([_c(MON, 100, 101)], TZ) is None
    assert latest_gap([], TZ) is None


def test_all_gaps_chain():
    candles = [_c(MON, 100, 100), _c(MON + DAY, 101, 101), _c(MON + 2 * DAY, 99.99, 100)]
    gaps = all_gaps(candles, TZ)
    assert [g.gap_pct for g in gaps] == [1.0, -1.0]


def test_weekday_stats():
    gaps = [
        Gap("2026-07-20", 1.0, 0, 0),   # lundi
        Gap("2026-07-27", -0.5, 0, 0),  # lundi
        Gap("2026-07-21", 0.4, 0, 0),   # mardi
    ]
    stats = weekday_stats(gaps)
    assert stats["lunedì"]["n"] == 2
    assert stats["lunedì"]["avg_gap_pct"] == 0.25
    assert stats["lunedì"]["avg_abs_gap_pct"] == 0.75
    assert stats["lunedì"]["pct_up"] == 50.0
    assert stats["martedì"]["n"] == 1


def test_biggest_gaps_sorted_by_magnitude():
    gaps = [Gap("2026-07-20", 0.1, 0, 0), Gap("2026-07-21", -2.0, 0, 0), Gap("2026-07-22", 1.0, 0, 0)]
    top = biggest_gaps(gaps, n=2)
    assert [g.gap_pct for g in top] == [-2.0, 1.0]


def test_is_same_local_day():
    assert is_same_local_day(MON, MON + 3600, TZ)
    assert not is_same_local_day(MON, MON + DAY, TZ)
