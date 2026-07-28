"""Régression : un `open` qui vaut la clôture de la veille ne fait pas un gap."""
from pulse.gaps import Gap, open_is_degenerate


def _g(pct):
    return Gap("2026-07-28", pct, 100.0, 100.0)


def test_ftse_like_series_is_degenerate():
    # ^FTSE mesuré sur 2 ans : 94,8 % de gaps exactement nuls
    gaps = [_g(0.0)] * 8 + [_g(0.12)]
    assert open_is_degenerate(gaps) is True


def test_healthy_series_is_not_degenerate():
    # ^GDAXI mesuré : 0,6 % de gaps nuls
    gaps = [_g(0.53), _g(-0.21), _g(0.0), _g(0.49), _g(-0.33), _g(0.24), _g(0.11)]
    assert open_is_degenerate(gaps) is False


def test_too_few_points_is_not_a_verdict():
    """Sur 2 séances on ne conclut rien — accuser à tort priverait d'un vrai gap."""
    assert open_is_degenerate([_g(0.0), _g(0.0)]) is False
    assert open_is_degenerate([]) is False
    assert open_is_degenerate(None) is False


def test_report_says_why_instead_of_showing_a_fake_zero():
    from pulse.report import build_report
    snap = {"generated_at": 1785270000, "markets": [{
        "symbol": "^FTSE", "label": "FTSE 100 (Londra)", "region": "europe",
        "kind": "index", "price": 10871.02, "prev_close": 10781.0,
        "change_pct": 0.83, "gap": None, "gap_note": "open_non_significativo",
        "gap_is_today": False,
        "clock": {"status": "closed", "opens_at": None, "closes_at": None,
                  "local_time": "17:58", "tz_name": "Europe/London",
                  "session_open": "08:00", "session_close": "16:30"}}],
        "errors": []}
    rep = build_report(snap, now_ts=1785270000)
    assert "gap non calcolabile" in rep
    assert "0,00%" not in rep


def test_history_drops_stats_built_on_a_degenerate_series():
    from pulse.config import Instrument
    from pulse.snapshot import build_history_stats
    # série type ^FTSE : ouverture = clôture de la veille
    ts, closes = 1784530800, [100.0, 101.0, 102.0, 103.0, 104.0, 105.0, 106.0]
    raw = {"chart": {"result": [{
        "meta": {"symbol": "^FTSE", "exchangeTimezoneName": "Europe/London",
                 "currentTradingPeriod": {"regular": {"start": 1, "end": 2}}},
        "timestamp": [ts + i * 86400 for i in range(len(closes))],
        "indicators": {"quote": [{
            "open": [closes[0]] + closes[:-1],   # open == close veille
            "close": closes, "high": closes, "low": closes}]}}], "error": None}}
    hist = build_history_stats(lambda s, r="1y": raw,
                               [Instrument("^FTSE", "FTSE 100", "europe", "index")])
    entry = hist["stats"]["^FTSE"]
    assert entry["open_usable"] is False
    assert entry["weekday_stats"] == {}
    assert entry["biggest_gaps"] == []
