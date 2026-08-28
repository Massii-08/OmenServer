"""Mesure du risque : R multiple, dimensionnement, statistiques, AFC n°36."""
import pytest

from backend.bots.paper.risk import (
    AFC_MIN_HOLDING_DAYS,
    AFC_VOLUME_LIMIT,
    afc_counters,
    exposure,
    portfolio_stats,
    preorder_warnings,
    r_multiple,
    suggested_qty,
)


# --------------------------------------------------------------------------- #
# R multiple
# --------------------------------------------------------------------------- #
def test_r_multiple_long_win_and_loss():
    assert r_multiple(100.0, 110.0, 95.0, "long") == 2.0      # +10 pour 5 risqués
    assert r_multiple(100.0, 97.0, 95.0, "long") == -0.6
    assert r_multiple(100.0, 95.0, 95.0, "long") == -1.0      # stop touché = -1 R


def test_r_multiple_short_is_mirrored():
    assert r_multiple(100.0, 90.0, 105.0, "short") == 2.0
    assert r_multiple(100.0, 105.0, 105.0, "short") == -1.0


def test_r_multiple_is_none_without_a_planned_stop():
    assert r_multiple(100.0, 110.0, None, "long") is None


def test_r_multiple_is_none_when_the_stop_is_on_the_wrong_side():
    """Un stop au-dessus de l'entrée sur un achat : la métrique n'a pas de sens."""
    assert r_multiple(100.0, 110.0, 105.0, "long") is None
    assert r_multiple(100.0, 90.0, 95.0, "short") is None


def test_r_multiple_is_none_when_the_stop_equals_the_entry():
    assert r_multiple(100.0, 110.0, 100.0, "long") is None


def test_r_multiple_is_none_on_missing_prices():
    assert r_multiple(None, 110.0, 95.0, "long") is None
    assert r_multiple(100.0, None, 95.0, "long") is None


def test_r_multiple_defaults_to_long_and_rejects_an_unknown_side():
    assert r_multiple(100.0, 110.0, 95.0) == 2.0
    with pytest.raises(ValueError):
        r_multiple(100.0, 110.0, 95.0, "flat")


# --------------------------------------------------------------------------- #
# Dimensionnement
# --------------------------------------------------------------------------- #
def test_suggested_qty_sizes_on_the_planned_risk():
    # 1 % de 10 000 = 100 CHF de risque, 5 CHF par action -> 20 actions
    assert suggested_qty(10000.0, 1.0, 100.0, 95.0) == 20
    assert suggested_qty(10000.0, 2.0, 50.0, 48.0) == 100


def test_a_tighter_stop_allows_a_bigger_position_for_the_same_risk():
    assert suggested_qty(10000.0, 1.0, 100.0, 99.5) == 200
    assert suggested_qty(10000.0, 1.0, 100.0, 90.0) == 10


def test_suggested_qty_always_rounds_down():
    # 100 / 7 = 14,28 -> 14 actions : on ne dépasse jamais le risque décidé
    assert suggested_qty(10000.0, 1.0, 100.0, 93.0) == 14


def test_suggested_qty_is_not_fooled_by_binary_noise():
    # 12,35 - 12,10 = 0,2500000000000009 en binaire ; 100 / 0,25 = 400 pile
    assert suggested_qty(1000.0, 10.0, 12.35, 12.10) == 400


def test_suggested_qty_works_for_a_short_stop_above_the_entry():
    assert suggested_qty(10000.0, 1.0, 100.0, 105.0) == 20


def test_suggested_qty_is_zero_on_an_invalid_stop():
    assert suggested_qty(10000.0, 1.0, 100.0, 100.0) == 0     # stop collé a l'entrée
    assert suggested_qty(10000.0, 1.0, 100.0, 0.0) == 0
    assert suggested_qty(10000.0, 1.0, 100.0, -5.0) == 0
    assert suggested_qty(10000.0, 1.0, 100.0, None) == 0


def test_suggested_qty_is_zero_without_capital_or_risk():
    assert suggested_qty(0.0, 1.0, 100.0, 95.0) == 0
    assert suggested_qty(10000.0, 0.0, 100.0, 95.0) == 0
    assert suggested_qty(-10.0, 1.0, 100.0, 95.0) == 0


# --------------------------------------------------------------------------- #
# Statistiques de méthode
# --------------------------------------------------------------------------- #
def _sample_trades():
    return [
        {"pnl_chf": 300.0, "r_multiple": 2.0, "fees_chf": 10.0, "stamp_duty_chf": 5.0},
        {"pnl_chf": -150.0, "r_multiple": -1.0, "fees_chf": 10.0, "stamp_duty_chf": 5.0},
        {"pnl_chf": 100.0, "fees_chf": 10.0, "stamp_duty_chf": 5.0},   # sans stop -> sans R
        {"pnl_chf": -50.0, "r_multiple": -0.5, "fees_chf": 10.0, "stamp_duty_chf": 5.0},
    ]


def test_portfolio_stats_on_a_mixed_track_record():
    stats = portfolio_stats(_sample_trades(), initial_capital=10000.0)
    assert stats["n_trades"] == 4
    assert stats["win_rate"] == 50.0            # pourcentage, pas fraction
    assert stats["avg_r_win"] == 2.0
    assert stats["avg_r_loss"] == -0.75
    assert stats["expectancy_r"] == 0.17        # moyenne des 3 R disponibles
    assert stats["total_pnl_chf"] == 200.0
    assert stats["total_fees_chf"] == 60.0      # courtage + droit de timbre
    assert stats["profit_factor"] == 2.0        # 400 gagnés / 200 perdus


def test_drawdown_needs_the_initial_capital_to_mean_anything():
    trades = _sample_trades()
    sur_capital = portfolio_stats(trades, initial_capital=10000.0)["max_drawdown_pct"]
    sur_gains = portfolio_stats(trades)["max_drawdown_pct"]
    assert sur_capital == 1.46      # 10 300 -> 10 150
    assert sur_gains == 50.0        # 300 -> 150 : vrai, mais trompeur
    assert sur_capital < sur_gains


def test_drawdown_keeps_the_worst_trough_not_the_last():
    trades = [{"pnl_chf": 1000.0}, {"pnl_chf": -500.0}, {"pnl_chf": 400.0},
              {"pnl_chf": -100.0}]
    # sommet 11 000 -> creux 10 500 = -4,55 % ; la baisse suivante est moindre
    assert portfolio_stats(trades, initial_capital=10000.0)["max_drawdown_pct"] == 4.55


def test_portfolio_stats_tolerates_an_empty_history():
    stats = portfolio_stats([], initial_capital=10000.0)
    assert stats == {
        "n_trades": 0, "win_rate": 0.0, "avg_r_win": None, "avg_r_loss": None,
        "expectancy_r": None, "total_pnl_chf": 0.0, "total_fees_chf": 0.0,
        "max_drawdown_pct": 0.0, "profit_factor": None,
    }
    assert portfolio_stats(None)["n_trades"] == 0


def test_profit_factor_is_none_without_a_single_loss():
    assert portfolio_stats([{"pnl_chf": 100.0}])["profit_factor"] is None


def test_profit_factor_is_zero_when_everything_lost():
    assert portfolio_stats([{"pnl_chf": -100.0}, {"pnl_chf": -50.0}])["profit_factor"] == 0.0


def test_a_scratch_trade_counts_in_the_denominator_only():
    stats = portfolio_stats([{"pnl_chf": 100.0}, {"pnl_chf": 0.0}])
    assert stats["n_trades"] == 2 and stats["win_rate"] == 50.0


def test_trades_without_r_are_excluded_from_the_r_averages():
    stats = portfolio_stats([{"pnl_chf": 100.0}, {"pnl_chf": -100.0}])
    assert stats["avg_r_win"] is None and stats["avg_r_loss"] is None
    assert stats["expectancy_r"] is None


def test_portfolio_stats_ignores_corrupt_rows():
    stats = portfolio_stats([{"pnl_chf": 100.0}, "corrompu", None,
                             {"pnl_chf": "abc"}])
    assert stats["n_trades"] == 2 and stats["total_pnl_chf"] == 100.0


# --------------------------------------------------------------------------- #
# Exposition
# --------------------------------------------------------------------------- #
def _sample_positions():
    return [
        {"symbol": "NESN.SW", "qty": 10, "avg_price": 95.0, "currency": "CHF",
         "fx_rate": 1.0, "side": "long"},
        {"symbol": "AAPL", "qty": 5, "avg_price": 200.0, "currency": "USD",
         "fx_rate": 0.9, "side": "short"},
    ]


def test_exposure_values_positions_at_the_live_quote_in_chf():
    out = exposure(_sample_positions(), {"NESN.SW": 100.0, "AAPL": 210.0}, 1000.0)
    assert out["invested_chf"] == 1945.0        # 1000 + 5 x 210 x 0,9
    assert out["cash_chf"] == 1000.0
    assert out["total_chf"] == 2945.0
    assert out["per_position_pct"] == {"NESN.SW": 33.96, "AAPL": 32.09}
    assert out["max_concentration_pct"] == 33.96


def test_a_short_counts_as_exposure_because_it_carries_risk():
    shorts = [{"symbol": "AAPL", "qty": 5, "avg_price": 200.0, "fx_rate": 1.0,
               "side": "short"}]
    assert exposure(shorts, {"AAPL": 210.0}, 0.0)["invested_chf"] == 1050.0


def test_exposure_falls_back_to_the_average_price_without_a_quote():
    out = exposure(_sample_positions(), {}, 1000.0)
    assert out["invested_chf"] == 950.0 + 900.0


def test_exposure_can_revalue_with_todays_fx_rates():
    out = exposure(_sample_positions(), {"NESN.SW": 100.0, "AAPL": 200.0}, 0.0,
                   fx_rates={"USD": 0.8})
    assert out["invested_chf"] == 1000.0 + 800.0


def test_exposure_aggregates_two_lines_on_the_same_symbol():
    positions = [
        {"symbol": "AAPL", "qty": 5, "avg_price": 100.0, "fx_rate": 1.0},
        {"symbol": "AAPL", "qty": 5, "avg_price": 100.0, "fx_rate": 1.0},
    ]
    out = exposure(positions, {"AAPL": 100.0}, 0.0)
    assert out["per_position_pct"] == {"AAPL": 100.0}
    assert out["max_concentration_pct"] == 100.0


def test_exposure_on_an_empty_portfolio():
    out = exposure([], {}, 10000.0)
    assert out == {"invested_chf": 0.0, "cash_chf": 10000.0, "total_chf": 10000.0,
                   "per_position_pct": {}, "max_concentration_pct": 0.0}


def test_exposure_never_divides_by_zero():
    out = exposure([{"symbol": "AAPL", "qty": 1, "avg_price": 0.0}], {}, 0.0)
    assert out["total_chf"] == 0.0
    assert out["max_concentration_pct"] == 0.0


def test_exposure_skips_empty_lines():
    out = exposure([{"symbol": "", "qty": 5, "avg_price": 10.0},
                    {"symbol": "AAPL", "qty": 0, "avg_price": 10.0}], {}, 100.0)
    assert out["invested_chf"] == 0.0 and out["per_position_pct"] == {}


# --------------------------------------------------------------------------- #
# LOT 3, C3 — garde-fou PRÉ-ordre (porte de confirmation)
# --------------------------------------------------------------------------- #
_LONG_THESIS = "Thèse suffisamment longue pour passer le seuil"


def _pf(cash=10000.0, positions=None, capital=10000.0):
    return {"cash_chf": cash, "positions": positions or [], "initial_capital": capital}


def test_preorder_warnings_empty_on_a_clean_entry():
    payload = {"side": "buy", "thesis": _LONG_THESIS, "stop_loss": 95.0, "qty": 5}
    assert preorder_warnings(payload, _pf(), 100.0) == []


def test_preorder_warnings_flags_no_thesis():
    payload = {"side": "buy", "thesis": "", "stop_loss": 95.0, "qty": 5}
    assert preorder_warnings(payload, _pf(), 100.0) == ["no_thesis"]


def test_preorder_warnings_short_thesis_still_flags():
    payload = {"side": "buy", "thesis": "trop court", "stop_loss": 95.0, "qty": 5}
    assert "no_thesis" in preorder_warnings(payload, _pf(), 100.0)


def test_preorder_warnings_flags_no_stop():
    payload = {"side": "buy", "thesis": _LONG_THESIS, "stop_loss": None, "qty": 5}
    assert preorder_warnings(payload, _pf(), 100.0) == ["no_stop"]


def test_preorder_warnings_flags_risk_high_alone():
    # risque = |100-20| x 5 = 400 CHF = 4 % du capital (> 2 %) ; position projetée
    # = 5 x 100 = 500 CHF = 5 % de l'équité (< 25 %) -- isole risk_high.
    payload = {"side": "buy", "thesis": _LONG_THESIS, "stop_loss": 20.0, "qty": 5}
    assert preorder_warnings(payload, _pf(), 100.0) == ["risk_high"]


def test_preorder_warnings_flags_oversize_alone():
    # risque = |100-95| x 30 = 150 CHF = 1,5 % du capital (< 2 %) ; position
    # projetée = 30 x 100 = 3000 CHF = 30 % de l'équité (> 25 %) -- isole oversize.
    payload = {"side": "buy", "thesis": _LONG_THESIS, "stop_loss": 95.0, "qty": 30}
    assert preorder_warnings(payload, _pf(), 100.0) == ["oversize"]


def test_preorder_warnings_only_applies_to_opening_orders():
    payload = {"side": "sell", "thesis": "", "stop_loss": None, "qty": 500}
    assert preorder_warnings(payload, _pf(cash=0.0), 100.0) == []
    payload["side"] = "cover"
    assert preorder_warnings(payload, _pf(cash=0.0), 100.0) == []


def test_preorder_warnings_without_a_level_skips_the_two_numeric_checks():
    # Un cours indisponible : risk_high/oversize ne peuvent pas se calculer,
    # jamais un chiffre inventé -- seuls les deux avertissements structurels
    # (thèse/stop) restent évaluables.
    payload = {"side": "buy", "thesis": "", "stop_loss": None, "qty": 999}
    assert preorder_warnings(payload, _pf(), None) == ["no_thesis", "no_stop"]


def test_preorder_warnings_counts_an_existing_position_of_the_same_side():
    positions = [{"symbol": "NESN.SW", "side": "long", "qty": 20,
                 "avg_price": 100.0, "fx_rate": 1.0}]
    payload = {"symbol": "NESN.SW", "side": "buy", "thesis": _LONG_THESIS,
              "stop_loss": 95.0, "qty": 10}
    # équité = 8000 cash + 2000 valorisé = 10000 ; projeté = (20+10) x 100 = 3000
    # = 30 % -- oversize à cause de la ligne déjà détenue.
    assert preorder_warnings(payload, _pf(cash=8000.0, positions=positions), 100.0) \
        == ["oversize"]


def test_preorder_warnings_ignores_a_position_on_the_opposite_side():
    # Même symbole, mais SHORT : ne compte pas comme "détenu" pour un BUY (les
    # deux sens ne se compensent ni ne s'additionnent dans cette projection).
    positions = [{"symbol": "NESN.SW", "side": "short", "qty": 20,
                 "avg_price": 100.0, "fx_rate": 1.0}]
    payload = {"symbol": "NESN.SW", "side": "buy", "thesis": _LONG_THESIS,
              "stop_loss": 95.0, "qty": 10}
    assert preorder_warnings(payload, _pf(cash=8000.0, positions=positions), 100.0) \
        == []


def test_preorder_warnings_ignores_a_position_on_another_symbol():
    positions = [{"symbol": "AAPL", "side": "long", "qty": 20,
                 "avg_price": 100.0, "fx_rate": 1.0}]
    payload = {"symbol": "NESN.SW", "side": "buy", "thesis": _LONG_THESIS,
              "stop_loss": 95.0, "qty": 10}
    assert preorder_warnings(payload, _pf(cash=8000.0, positions=positions), 100.0) \
        == []


def test_preorder_warnings_tolerates_a_missing_or_empty_payload():
    assert preorder_warnings({}, _pf(), 100.0) == []
    assert preorder_warnings(None, _pf(), 100.0) == []


def test_preorder_warnings_tolerates_a_missing_or_empty_portfolio():
    payload = {"side": "buy", "thesis": _LONG_THESIS, "stop_loss": 95.0, "qty": 5}
    assert preorder_warnings(payload, {}, 100.0) == []
    assert preorder_warnings(payload, None, 100.0) == []


# --------------------------------------------------------------------------- #
# Garde-fou fiscal — circulaire AFC n°36
# --------------------------------------------------------------------------- #
NOW = "2026-08-24T12:00:00"


def _afc_trades():
    return [
        # entrée ET sortie dans l'année, détenu 64 jours -> détention courte
        {"qty": 10, "entry_price": 100.0, "exit_price": 110.0, "fx_rate": 1.0,
         "entry_at": "2026-01-10T09:00:00", "exit_at": "2026-03-15T16:00:00"},
        # entrée l'an dernier, sortie cette année, détenu 245 jours -> conforme
        {"qty": 5, "entry_price": 200.0, "exit_price": 190.0, "fx_rate": 1.0,
         "entry_at": "2025-06-01T09:00:00", "exit_at": "2026-02-01T16:00:00"},
    ]


def test_afc_counts_volume_holdings_and_trades_of_the_current_year():
    out = afc_counters(_afc_trades(),
                       [{"symbol": "X", "qty": 4, "avg_price": 50.0, "fx_rate": 1.0,
                         "opened_at": "2026-08-01T09:00:00"}],
                       10000.0, NOW)
    # 1000 + 1100 (trade 1) + 950 (sortie du trade 2 seule) + 200 (position) = 3250
    assert out["volume_ratio"] == 0.33
    assert out["volume_limit"] == AFC_VOLUME_LIMIT == 5.0
    assert out["short_holdings"] == 1
    assert out["n_trades_year"] == 2
    assert out["uses_leverage"] is False
    assert out["uses_derivatives"] is False


def test_afc_status_is_at_risk_as_soon_as_one_holding_is_too_short():
    assert afc_counters(_afc_trades(), [], 10000.0, NOW)["status"] == "a_risque"


def test_afc_status_stays_private_when_every_criterion_holds():
    long_holds = [{"qty": 5, "entry_price": 100.0, "exit_price": 120.0, "fx_rate": 1.0,
                   "entry_at": "2025-01-05T09:00:00", "exit_at": "2026-03-05T16:00:00"}]
    out = afc_counters(long_holds, [], 10000.0, NOW)
    assert out["short_holdings"] == 0
    assert out["status"] == "prive"


def test_the_holding_threshold_is_183_days():
    entry = "2026-01-01T00:00:00"
    just_short = {"qty": 1, "entry_price": 100.0, "exit_price": 100.0, "fx_rate": 1.0,
                  "entry_at": entry, "exit_at": "2026-07-02T00:00:00"}   # 182 jours
    just_ok = {"qty": 1, "entry_price": 100.0, "exit_price": 100.0, "fx_rate": 1.0,
               "entry_at": entry, "exit_at": "2026-07-03T00:00:00"}      # 183 jours
    assert AFC_MIN_HOLDING_DAYS == 183
    assert afc_counters([just_short], [], 10000.0, NOW)["short_holdings"] == 1
    assert afc_counters([just_ok], [], 10000.0, NOW)["short_holdings"] == 0


def test_afc_status_is_at_risk_when_the_volume_exceeds_five_times_the_capital():
    churn = [{"qty": 100, "entry_price": 30.0, "exit_price": 30.0, "fx_rate": 1.0,
              "entry_at": "2026-02-01T09:00:00", "exit_at": "2025-12-01T09:00:00"}]
    # 100 x 30 = 3000 a l'entrée seulement (sortie l'an dernier) sur 500 de capital
    out = afc_counters(churn, [], 500.0, NOW)
    assert out["volume_ratio"] == 6.0
    assert out["status"] == "a_risque"


def test_afc_converts_foreign_volume_to_chf():
    usd = [{"qty": 10, "entry_price": 100.0, "exit_price": 100.0, "fx_rate": 0.9,
            "entry_at": "2026-01-10T09:00:00", "exit_at": "2026-01-20T09:00:00"}]
    out = afc_counters(usd, [], 10000.0, NOW)
    assert out["volume_ratio"] == 0.18      # (900 + 900) / 10 000


def test_afc_ignores_another_year():
    old = [{"qty": 10, "entry_price": 100.0, "exit_price": 110.0, "fx_rate": 1.0,
            "entry_at": "2024-01-10T09:00:00", "exit_at": "2024-03-15T16:00:00"}]
    out = afc_counters(old, [], 10000.0, NOW)
    assert out == {"volume_ratio": 0.0, "volume_limit": 5.0, "short_holdings": 0,
                   "n_trades_year": 0, "uses_leverage": False,
                   "uses_derivatives": False, "status": "prive"}


def test_afc_reads_iso_timestamps_with_z_and_with_an_offset():
    """3.9 ne sait pas lire le Z, et mélanger aware/naive lèverait un TypeError."""
    zulu = [{"qty": 1, "entry_price": 100.0, "exit_price": 110.0, "fx_rate": 1.0,
             "entry_at": "2026-01-10T09:00:00Z", "exit_at": "2026-03-15T16:00:00Z"}]
    offset = [{"qty": 1, "entry_price": 100.0, "exit_price": 110.0, "fx_rate": 1.0,
               "entry_at": "2026-01-10T09:00:00+01:00",
               "exit_at": "2026-03-15T16:00:00+02:00"}]
    for rows in (zulu, offset):
        out = afc_counters(rows, [], 10000.0, "2026-08-24T12:00:00+02:00")
        assert out["n_trades_year"] == 1
        assert out["short_holdings"] == 1
        assert out["volume_ratio"] == 0.02


def test_afc_accepts_a_date_only_timestamp():
    rows = [{"qty": 1, "entry_price": 100.0, "exit_price": 110.0, "fx_rate": 1.0,
             "entry_at": "2026-01-10", "exit_at": "2026-03-15"}]
    assert afc_counters(rows, [], 10000.0, "2026-08-24")["n_trades_year"] == 1


def test_afc_never_divides_by_zero_capital():
    out = afc_counters(_afc_trades(), [], 0.0, NOW)
    assert out["volume_ratio"] == 0.0


def test_afc_tolerates_unreadable_dates_and_empty_input():
    broken = [{"qty": 1, "entry_price": 100.0, "exit_price": 110.0,
               "entry_at": "hier", "exit_at": ""}]
    out = afc_counters(broken, None, 10000.0, NOW)
    assert out["n_trades_year"] == 0 and out["volume_ratio"] == 0.0
    assert afc_counters([], [], 10000.0, "pas une date")["status"] == "prive"
