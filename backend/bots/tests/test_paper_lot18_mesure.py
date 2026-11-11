"""LOT 18 — deux mesures fausses du simulateur.

A. MAE/MFE calculées sur TOUTES les bougies de la fenêtre Yahoo, avant-entrée
   comprise (OKTA : MAE -20,10 % pour un pire creux réel d'environ -3,6 %).
B. ``r_multiple``/``planned_stop`` pris sur le stop FINAL (après resserrement)
   au lieu du stop INITIAL : R ``None`` sur les gagnants à stop suiveur.

Tout est HORS LIGNE : ``quotes.get_candles`` est toujours doublé.
"""
from datetime import datetime, timezone

import pytest

from backend.bots import paper_router as pr
from backend.bots.paper import models as m
from backend.bots.paper import quotes, tradestats

HOUR = 3600
DAY = 86400


def _utc(*args):
    return datetime(*args, tzinfo=timezone.utc).timestamp()


def _hourly(start_epoch, hours, low_at=None, base=210.0):
    """Bougies horaires plates (low = base - 1, high = base + 1) ; ``low_at``
    = {index: (low, high)} pour poser des extrêmes."""
    rows = []
    for i in range(hours):
        low, high = base - 1.0, base + 1.0
        if low_at and i in low_at:
            low, high = low_at[i]
        rows.append({"ts": start_epoch + i * HOUR, "open": base, "high": high,
                     "low": low, "close": base})
    return rows


# =========================================================================== #
# A — tradestats (pur)
# =========================================================================== #
def test_interval_seconds_table():
    assert tradestats.INTERVAL_SECONDS["15m"] == 900
    assert tradestats.INTERVAL_SECONDS["1h"] == 3600
    assert tradestats.INTERVAL_SECONDS["1d"] == 86400
    assert tradestats.INTERVAL_SECONDS["1wk"] == 7 * 86400


def test_without_window_behaviour_is_unchanged():
    """Sans fenêtre : toutes les bougies comptent, même sans ``ts``."""
    candles = [{"high": 112.0, "low": 97.0}]
    assert tradestats.excursions(candles, 100.0, "long") == {
        "mae_pct": -3.0, "mfe_pct": 12.0}
    assert tradestats.excursions([], 100.0, "long") == {}


def test_okta_pre_entry_crash_is_not_counted():
    """Le cas OKTA : 30 jours de bougies horaires, un creux à 166 AVANT
    l'entrée ; pendant la détention le pire point est 200,5 (-3,6 %)."""
    start = _utc(2026, 9, 8, 13)
    entry_ts = start + 21 * DAY                       # 29/09
    exit_ts = entry_ts + 9 * DAY                      # 08/10
    candles = _hourly(start, 30 * 24, low_at={
        24: (166.2, 175.0),                           # le krach d'avant-entrée
        21 * 24 + 50: (200.5, 209.0),                 # le vrai creux de détention
    })
    exc = tradestats.excursions(candles, 208.0, "long",
                                window=(entry_ts, exit_ts, 3600),
                                exit_price=209.0)
    assert exc["mae_pct"] == -3.61
    assert exc["mae_pct"] > -5.0                      # pas -20,10


def test_only_candles_entirely_inside_the_window_count():
    entry_ts, exit_ts = 10_000.0, 10_000.0 + 4 * HOUR
    candles = [
        {"ts": entry_ts - 1800, "high": 150.0, "low": 50.0},   # chevauche le début
        {"ts": entry_ts, "high": 102.0, "low": 99.0},          # dedans
        {"ts": entry_ts + 3 * HOUR, "high": 104.0, "low": 98.0},  # finit pile à la sortie
        {"ts": exit_ts - 1800, "high": 160.0, "low": 40.0},    # déborde après la sortie
        {"high": 500.0, "low": 1.0},                           # sans ts : non situable
    ]
    exc = tradestats.excursions(candles, 100.0, "long",
                                window=(entry_ts, exit_ts, 3600))
    assert exc == {"mae_pct": -2.0, "mfe_pct": 4.0}


def test_exit_price_is_an_observed_point():
    """Sorti au stop à 94 : le pire point vaut au moins la sortie, même si les
    bougies entières de la fenêtre ne descendent pas si bas."""
    entry_ts, exit_ts = 0.0, 10 * HOUR
    candles = _hourly(entry_ts, 5, base=100.0)        # low 99, high 101
    exc = tradestats.excursions(candles, 100.0, "long",
                                window=(entry_ts, exit_ts, 3600),
                                exit_price=94.0)
    assert exc == {"mae_pct": -6.0, "mfe_pct": 1.0}


def test_no_whole_candle_falls_back_on_entry_and_exit():
    candles = [{"ts": -DAY, "high": 300.0, "low": 10.0}]
    exc = tradestats.excursions(candles, 100.0, "long",
                                window=(0.0, HOUR, 86400), exit_price=110.0)
    assert exc == {"mae_pct": 0.0, "mfe_pct": 10.0}
    # AUCUNE bougie reçue (panne, symbole inconnu) : rien n'a été relu, {}
    assert tradestats.excursions([], 100.0, "long", window=(0.0, HOUR, 900),
                                 exit_price=90.0) == {}


def test_no_whole_candle_and_no_exit_price_is_empty():
    candles = [{"ts": -DAY, "high": 300.0, "low": 10.0}]
    assert tradestats.excursions(candles, 100.0, "long",
                                 window=(0.0, HOUR, 86400)) == {}


def test_window_short_side():
    entry_ts, exit_ts = 0.0, 3 * HOUR
    candles = [{"ts": -HOUR, "high": 200.0, "low": 50.0},
               {"ts": 0.0, "high": 103.0, "low": 96.0}]
    exc = tradestats.excursions(candles, 100.0, "short",
                                window=(entry_ts, exit_ts, 3600),
                                exit_price=97.0)
    assert exc == {"mae_pct": -3.0, "mfe_pct": 4.0}


def test_tradestats_stays_pure():
    import ast
    import inspect
    tree = ast.parse(inspect.getsource(tradestats))
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            names.add(node.module or "")
            names.update(a.name for a in node.names)
    assert not any("quotes" in n or "paper_router" in n for n in names)


# =========================================================================== #
# A — routeur
# =========================================================================== #
def test_local_epoch_handles_summer_and_winter_time():
    # Rome : UTC+2 l'été, UTC+1 l'hiver
    assert pr._local_epoch("2026-07-01T12:00:00") == _utc(2026, 7, 1, 10)
    assert pr._local_epoch("2026-01-15T12:00:00") == _utc(2026, 1, 15, 11)
    assert pr._local_epoch("n/a") is None
    assert pr._local_epoch(None) is None


def _okta_trade(**kw):
    base = dict(symbol="OKTA", side="long", qty=10, entry_price=208.0,
                exit_price=209.0, entry_at="2026-09-29T15:00:00",
                exit_at="2026-10-08T15:00:00", pnl_pct=0.3,
                mae_pct=-20.10, mfe_pct=4.0, best_exit_gap_pct=3.7)
    base.update(kw)
    return m.Trade(**base)


def _okta_candles():
    entry_ts = pr._local_epoch("2026-09-29T15:00:00")
    start = entry_ts - 21 * DAY
    return _hourly(start, 30 * 24, low_at={
        24: (166.2, 175.0),
        21 * 24 + 50: (200.5, 213.0),
    })


def test_trade_excursions_asks_a_window_from_now_back_to_the_entry(monkeypatch):
    calls = []

    def fake(symbol, range_, interval):
        calls.append((symbol, range_, interval))
        return _okta_candles()
    monkeypatch.setattr(quotes, "get_candles", fake)

    trade = _okta_trade().to_dict()
    # à la clôture (9 jours d'âge) : bougies horaires sur un mois
    exc = pr._trade_excursions(trade, now=datetime(2026, 10, 8, 15, 0, 0))
    assert calls[-1] == ("OKTA", "1mo", "1h")
    assert exc["mae_pct"] == -3.61
    assert exc["mfe_pct"] == 2.4                       # 213 / 208
    assert exc["best_exit_gap_pct"] == round(2.4 - 0.3, 2)
    # recalcul 40 jours plus tard : la fenêtre doit couvrir l'âge de l'entrée
    pr._trade_excursions(trade, now=datetime(2026, 11, 8, 15, 0, 0))
    assert calls[-1] == ("OKTA", "6mo", "1d")


def test_trade_excursions_never_raises(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("hs")
    monkeypatch.setattr(quotes, "get_candles", boom)
    assert pr._trade_excursions(_okta_trade().to_dict()) == {}
    assert pr._trade_excursions({}) == {}
    assert pr._trade_excursions(None) == {}
    assert pr._trade_excursions({"symbol": "X", "entry_at": "n/a"}) == {}


def test_attach_trade_extras_okta_case(monkeypatch):
    monkeypatch.setattr(quotes, "get_candles",
                        lambda symbol, range_, interval: _okta_candles())
    monkeypatch.setattr(pr, "_now_iso", lambda: "2026-10-08T15:00:00")
    trade = _okta_trade(mae_pct=None, mfe_pct=None, best_exit_gap_pct=None)
    portfolio = m.Portfolio(trades=[trade])
    fill = {"trade": trade.to_dict()}
    pr._attach_trade_extras(portfolio, fill)
    assert portfolio.trades[0].mae_pct == -3.61
    assert fill["trade"]["mae_pct"] == -3.61
    assert fill["trade"]["best_exit_gap_pct"] == portfolio.trades[0].best_exit_gap_pct


def test_recompute_trade_excursions(monkeypatch):
    def fake(symbol, range_, interval):
        if symbol == "BROKEN":
            raise RuntimeError("hs")
        return _okta_candles()
    monkeypatch.setattr(quotes, "get_candles", fake)

    good = _okta_trade()
    broken = _okta_trade(symbol="BROKEN")
    portfolio = m.Portfolio(trades=[good, broken])
    n = pr.recompute_trade_excursions(portfolio,
                                      now=datetime(2026, 10, 8, 15, 0, 0))
    assert n == 1
    assert good.mae_pct == -3.61 and good.mfe_pct == 2.4
    assert good.best_exit_gap_pct == 2.1
    # l'échec garde ses anciennes valeurs
    assert broken.mae_pct == -20.10 and broken.mfe_pct == 4.0
    assert broken.best_exit_gap_pct == 3.7


def test_three_month_step_is_not_added_without_router_support():
    """``3mo`` n'est pas dans ``CANDLE_RANGES`` : la table reste telle quelle."""
    assert "3mo" not in pr.CANDLE_RANGES
    assert all(r != "3mo" for _, r, _ in tradestats._RANGE_STEPS)


# =========================================================================== #
# B — stop initial / stop final
# =========================================================================== #
def test_position_initial_stop_roundtrip_and_legacy():
    assert m.Position.from_dict({"symbol": "X"}).initial_stop is None
    p = m.Position(symbol="X", initial_stop=95.0)
    assert m.Position.from_dict(p.to_dict()).initial_stop == 95.0


def test_trade_new_fields_roundtrip_and_legacy():
    legacy = m.Trade.from_dict({"symbol": "X"})
    assert legacy.final_stop is None and legacy.risk_chf is None
    assert legacy.target is None
    t = m.Trade(symbol="X", final_stop=105.0, risk_chf=50.0, target=120.0)
    back = m.Trade.from_dict(t.to_dict())
    assert (back.final_stop, back.risk_chf, back.target) == (105.0, 50.0, 120.0)


def _order(side, qty, stop=None, target=None, risk_chf=None):
    return m.Order(id="o-%s-%d" % (side, qty), symbol="NESN.SW", side=side,
                   kind="market", qty=qty, created_at="2026-08-24T10:00:00",
                   status="filled", currency="CHF", stop_loss=stop,
                   target=target, risk_chf=risk_chf)


def _open(portfolio, qty=10, stop=95.0, target=120.0, risk_chf=50.0, price=100.0):
    pr.execute_order(portfolio, _order("buy", qty, stop, target, risk_chf),
                     price, 1.0, "2026-08-24T10:00:00")


@pytest.fixture
def no_candles(monkeypatch):
    monkeypatch.setattr(quotes, "get_candles", lambda *a, **k: [])


def test_opening_sets_initial_stop(no_candles):
    portfolio = m.Portfolio(cash_chf=100000.0)
    _open(portfolio)
    assert portfolio.positions[0].initial_stop == 95.0


def test_trailed_stop_above_entry_keeps_r_on_initial_stop(no_candles):
    portfolio = m.Portfolio(cash_chf=100000.0)
    _open(portfolio)
    pr._coach_move_stop(portfolio, "NESN.SW", {"stop_loss": 105.0}, "coach",
                        "2026-08-25T10:00:00")
    assert portfolio.positions[0].stop_loss == 105.0
    assert portfolio.positions[0].initial_stop == 95.0

    fill = pr.execute_order(portfolio, _order("sell", 10), 110.0, 1.0,
                            "2026-08-26T10:00:00")
    trade = portfolio.trades[-1]
    assert trade.r_multiple == 2.0                    # (110-100)/(100-95)
    assert trade.planned_stop == 95.0
    assert trade.final_stop == 105.0
    assert trade.target == 120.0
    assert trade.risk_chf == 50.0
    assert fill["trade"]["final_stop"] == 105.0


def test_legacy_position_without_initial_stop_behaves_as_before(no_candles):
    portfolio = m.Portfolio(cash_chf=100000.0, positions=[m.Position(
        symbol="NESN.SW", qty=10, avg_price=100.0, opened_at="2026-08-20T10:00:00",
        stop_loss=97.0, risk_chf=30.0)])
    pr.execute_order(portfolio, _order("sell", 10), 106.0, 1.0,
                     "2026-08-26T10:00:00")
    trade = portfolio.trades[-1]
    assert trade.planned_stop == 97.0
    assert trade.final_stop == 97.0
    assert trade.r_multiple == 2.0                    # (106-100)/(100-97)


def test_partial_close_prorates_risk(no_candles):
    portfolio = m.Portfolio(cash_chf=100000.0)
    _open(portfolio, qty=10, risk_chf=50.0)
    pr.execute_order(portfolio, _order("sell", 4), 105.0, 1.0,
                     "2026-08-26T10:00:00")
    assert portfolio.trades[-1].risk_chf == 20.0
    pr.execute_order(portfolio, _order("sell", 6), 106.0, 1.0,
                     "2026-08-27T10:00:00")
    assert portfolio.trades[-1].risk_chf == 30.0      # le total reste 50


def test_partial_close_without_risk_is_none(no_candles):
    portfolio = m.Portfolio(cash_chf=100000.0)
    _open(portfolio, qty=10, risk_chf=None)
    pr.execute_order(portfolio, _order("sell", 4), 105.0, 1.0,
                     "2026-08-26T10:00:00")
    assert portfolio.trades[-1].risk_chf is None


def test_reinforcement_keeps_initial_stop(no_candles):
    portfolio = m.Portfolio(cash_chf=100000.0)
    _open(portfolio, stop=95.0)
    _open(portfolio, qty=5, stop=98.0, price=102.0)
    pos = portfolio.positions[0]
    assert pos.stop_loss == 98.0
    assert pos.initial_stop == 95.0


def test_reinforcement_sets_initial_stop_when_missing(no_candles):
    portfolio = m.Portfolio(cash_chf=100000.0)
    _open(portfolio, stop=None)
    assert portfolio.positions[0].initial_stop is None
    _open(portfolio, qty=5, stop=96.0, price=102.0)
    assert portfolio.positions[0].initial_stop == 96.0


def test_postmortem_prompt_describes_final_stop():
    from backend.bots.paper import llm
    prompt = llm.build_postmortem_prompt({"symbol": "X"}, {})
    assert "final_stop" in prompt
    assert "stop suiveur" in prompt
