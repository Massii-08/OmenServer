"""Tests du journal niveau pro (LOT 2) — 100 % pur, aucun réseau, aucun I/O.

Quatre familles : excursions MAE/MFE + fenêtre de bougies (B1), « laissé sur
la table » (B5), stats dérivées par setup/émotion (B2/B3), score de
discipline (B4).
"""
from backend.bots.paper import tradestats


# --------------------------------------------------------------------------- #
# B1 — excursions (MAE/MFE)
# --------------------------------------------------------------------------- #
def _candle(high, low):
    return {"open": (high + low) / 2.0, "high": high, "low": low, "close": low}


def test_excursions_long_reads_worst_dip_and_best_peak_as_pct_of_entry():
    candles = [_candle(105, 98), _candle(103, 94), _candle(108, 100)]
    out = tradestats.excursions(candles, entry_price=100.0, side="long")
    # pire creux = 94 -> -6% ; meilleur sommet = 108 -> +8%
    assert out == {"mae_pct": -6.0, "mfe_pct": 8.0}


def test_excursions_short_inverts_the_favorable_direction():
    candles = [_candle(106, 97), _candle(112, 99)]
    out = tradestats.excursions(candles, entry_price=100.0, side="short")
    # pour un short, une hausse est DÉFAVORABLE (MAE) et une baisse FAVORABLE (MFE)
    assert out == {"mae_pct": -12.0, "mfe_pct": 3.0}


def test_excursions_are_clamped_to_their_sign_even_if_candles_never_cross_entry():
    # Toutes les bougies restent AU-DESSUS de l'entrée : le creux mesuré est
    # positif -- mathématiquement ce n'est plus une excursion ADVERSE, donc
    # MAE reste borné à 0 (jamais un nombre positif qui contredirait son nom).
    candles = [_candle(110, 105)]
    out = tradestats.excursions(candles, entry_price=100.0, side="long")
    assert out["mae_pct"] == 0.0
    assert out["mfe_pct"] == 10.0


def test_excursions_returns_empty_dict_on_empty_candles():
    assert tradestats.excursions([], entry_price=100.0, side="long") == {}
    assert tradestats.excursions(None, entry_price=100.0, side="long") == {}


def test_excursions_returns_empty_dict_without_a_usable_entry_price():
    candles = [_candle(105, 98)]
    assert tradestats.excursions(candles, entry_price=None, side="long") == {}
    assert tradestats.excursions(candles, entry_price=0, side="long") == {}
    assert tradestats.excursions(candles, entry_price=-10, side="long") == {}


def test_excursions_ignores_candles_missing_both_high_and_low():
    candles = [{"open": 100, "close": 101}, _candle(106, 95)]
    out = tradestats.excursions(candles, entry_price=100.0, side="long")
    assert out == {"mae_pct": -5.0, "mfe_pct": 6.0}


def test_excursions_defaults_to_long_on_an_unknown_side():
    candles = [_candle(105, 98)]
    assert (tradestats.excursions(candles, 100.0, "long")
            == tradestats.excursions(candles, 100.0, "n/a"))


# --------------------------------------------------------------------------- #
# B1 — range_for : fenêtre de bougies FERMÉE selon la durée de détention
# --------------------------------------------------------------------------- #
def test_range_for_picks_the_narrowest_window_that_covers_the_holding_period():
    assert tradestats.range_for(0.2) == ("1d", "15m")
    assert tradestats.range_for(1.0) == ("1d", "15m")
    assert tradestats.range_for(3.0) == ("5d", "15m")
    assert tradestats.range_for(5.0) == ("5d", "15m")
    assert tradestats.range_for(20.0) == ("1mo", "1h")
    assert tradestats.range_for(30.0) == ("1mo", "1h")
    assert tradestats.range_for(90.0) == ("6mo", "1d")
    assert tradestats.range_for(180.0) == ("6mo", "1d")
    assert tradestats.range_for(300.0) == ("1y", "1d")
    assert tradestats.range_for(365.0) == ("1y", "1d")
    assert tradestats.range_for(900.0) == ("5y", "1wk")


def test_range_for_tolerates_missing_or_negative_durations():
    assert tradestats.range_for(None) == ("1d", "15m")
    assert tradestats.range_for(-5) == ("1d", "15m")
    assert tradestats.range_for("n/a") == ("1d", "15m")


def test_range_for_only_uses_ranges_and_intervals_the_router_already_serves():
    # Fermeture de l'univers : jamais une combinaison inventée -- même
    # doctrine que ``paper_router.CANDLE_RANGES``/``CANDLE_INTERVALS``.
    router_ranges = {"1d", "5d", "1mo", "6mo", "1y", "5y"}
    router_intervals = {"15m", "1h", "1d", "1wk"}
    for days in (0.5, 3, 20, 90, 300, 900):
        r, i = tradestats.range_for(days)
        assert r in router_ranges
        assert i in router_intervals


# --------------------------------------------------------------------------- #
# B5 — best_exit_gap : ce que le trade a laissé sur la table
# --------------------------------------------------------------------------- #
def test_best_exit_gap_is_mfe_minus_realized():
    assert tradestats.best_exit_gap(mfe_pct=5.8, realized_pct=2.1) == 3.7


def test_best_exit_gap_can_be_negative_when_the_exit_beat_the_mfe_window():
    # Un exit_reason "target" au-delà de la fenêtre relue peut dépasser le
    # MFE mesuré -- ce n'est pas une erreur, juste un signal négatif honnête.
    assert tradestats.best_exit_gap(mfe_pct=2.0, realized_pct=5.0) == -3.0


def test_best_exit_gap_is_none_without_both_values():
    assert tradestats.best_exit_gap(None, 2.1) is None
    assert tradestats.best_exit_gap(5.8, None) is None
    assert tradestats.best_exit_gap(None, None) is None


# --------------------------------------------------------------------------- #
# B2 — setup_breakdown : stats dérivées PAR SETUP
# --------------------------------------------------------------------------- #
def _trade(pnl, r=None, setup="", emotion=""):
    return {"pnl_chf": pnl, "r_multiple": r, "setup": setup, "emotion": emotion}


def test_setup_breakdown_groups_wins_losses_and_r_by_setup():
    trades = [
        _trade(100, r=2.0, setup="breakout"),
        _trade(-50, r=-1.0, setup="breakout"),
        _trade(80, r=1.5, setup="breakout"),
        _trade(30, r=1.0, setup="pullback"),
    ]
    rows = tradestats.setup_breakdown(trades)
    by_setup = {r["setup"]: r for r in rows}

    breakout = by_setup["breakout"]
    assert breakout["n"] == 3
    assert breakout["winrate"] == round(2 / 3 * 100.0, 1)
    assert breakout["avg_r"] == round((2.0 - 1.0 + 1.5) / 3, 2)
    assert breakout["total_pnl_chf"] == 130.0

    pullback = by_setup["pullback"]
    assert pullback["n"] == 1
    assert pullback["winrate"] == 100.0
    assert pullback["total_pnl_chf"] == 30.0


def test_setup_breakdown_buckets_missing_or_unknown_setups_as_untagged():
    trades = [_trade(10, setup=""), _trade(-5, setup=None),
             _trade(20, setup="ne-existe-pas")]
    rows = tradestats.setup_breakdown(trades)
    assert len(rows) == 1
    assert rows[0]["setup"] == "untagged"
    assert rows[0]["n"] == 3
    assert rows[0]["total_pnl_chf"] == 25.0


def test_setup_breakdown_is_sorted_by_count_then_by_name():
    trades = [_trade(1, setup="other"), _trade(1, setup="trend"),
             _trade(1, setup="trend"), _trade(1, setup="breakout"),
             _trade(1, setup="breakout")]
    rows = tradestats.setup_breakdown(trades)
    assert [r["setup"] for r in rows] == ["breakout", "trend", "other"]


def test_setup_breakdown_trades_without_an_r_multiple_are_excluded_from_avg_r():
    trades = [_trade(10, r=None, setup="news"), _trade(20, r=3.0, setup="news")]
    rows = tradestats.setup_breakdown(trades)
    assert rows[0]["avg_r"] == 3.0


def test_setup_breakdown_of_no_trades_is_empty():
    assert tradestats.setup_breakdown([]) == []
    assert tradestats.setup_breakdown(None) == []


# --------------------------------------------------------------------------- #
# B3 — emotion_breakdown : stats dérivées PAR ÉMOTION (d'entrée)
# --------------------------------------------------------------------------- #
def test_emotion_breakdown_groups_by_emotion_without_a_pnl_total():
    trades = [_trade(100, r=2.0, emotion="fomo"), _trade(-50, r=-1.0, emotion="fomo"),
             _trade(30, r=1.0, emotion="calme")]
    rows = tradestats.emotion_breakdown(trades)
    by_emotion = {r["emotion"]: r for r in rows}

    assert by_emotion["fomo"]["n"] == 2
    assert by_emotion["fomo"]["winrate"] == 50.0
    assert by_emotion["fomo"]["avg_r"] == 0.5
    assert "total_pnl_chf" not in by_emotion["fomo"]        # B3 n'a PAS ce champ

    assert by_emotion["calme"]["n"] == 1


def test_emotion_breakdown_buckets_missing_emotions_as_untagged():
    trades = [_trade(10, emotion=""), _trade(20, emotion="n/a")]
    rows = tradestats.emotion_breakdown(trades)
    assert len(rows) == 1 and rows[0]["emotion"] == "untagged" and rows[0]["n"] == 2


def test_a_mechanical_exit_has_no_emotion_close_and_still_counts_by_entry_emotion():
    """Le fill automatique (stop/tick) n'a pas d'``emotion_close`` -- mais le
    trade garde son ``emotion`` D'ENTRÉE, qui reste la clé d'agrégation."""
    trades = [{"pnl_chf": -20, "r_multiple": -1.0, "emotion": "revanche",
              "emotion_close": ""}]
    rows = tradestats.emotion_breakdown(trades)
    assert rows[0]["emotion"] == "revanche" and rows[0]["n"] == 1


# --------------------------------------------------------------------------- #
# B4 — discipline_score
# --------------------------------------------------------------------------- #
def _disciplined_trade(pnl, stop=95.0, thesis="une thèse honnête", entry=100.0, qty=10, fx=1.0):
    return {"pnl_chf": pnl, "planned_stop": stop, "thesis": thesis,
           "entry_price": entry, "qty": qty, "fx_rate": fx}


def test_discipline_score_is_none_under_five_closed_trades():
    trades = [_disciplined_trade(10)] * 4
    assert tradestats.discipline_score(trades, 10000.0) == {"score": None}


def test_discipline_score_of_five_losing_trades_missing_everything_is_zero():
    trades = [{"pnl_chf": -10, "planned_stop": None, "thesis": "",
              "entry_price": 100.0, "qty": 10, "fx_rate": 1.0}] * 5
    out = tradestats.discipline_score(trades, 10000.0)
    assert out["score"] == 0
    assert out["components"]["stop_set"]["points"] == 0.0
    assert out["components"]["thesis_written"]["points"] == 0.0
    assert out["components"]["risk_respected"]["points"] == 0.0
    assert out["components"]["profit_factor"] == {"value": 0.0, "points": 0.0}


def test_discipline_score_gives_full_profit_factor_points_when_there_are_no_losses_at_all():
    # Aucune perte (ici : break-even) -> profit factor « infini » = None côté
    # ``risk.portfolio_stats`` -> 25 pts PLEINS sur CET AXE SEUL, même sans
    # stop ni thèse : le risque de pertes qui s'enchaînent ne s'est simplement
    # jamais matérialisé.
    trades = [{"pnl_chf": 0.0, "planned_stop": None, "thesis": "",
              "entry_price": 100.0, "qty": 10, "fx_rate": 1.0}] * 5
    out = tradestats.discipline_score(trades, 10000.0)
    assert out["components"]["profit_factor"] == {"value": None, "points": 25.0}
    assert out["components"]["stop_set"]["points"] == 0.0
    assert out["score"] == 25


def test_discipline_score_of_a_disciplined_run_is_perfect():
    # 5 trades : stop posé, thèse écrite, risque = |100-95|*10 = 50 CHF = 0.5%
    # du capital (<=2%), aucune perte -> profit factor plein.
    trades = [_disciplined_trade(50)] * 5
    out = tradestats.discipline_score(trades, 10000.0)
    assert out["score"] == 100
    assert out["components"]["stop_set"] == {"pct": 100.0, "points": 25.0}
    assert out["components"]["thesis_written"] == {"pct": 100.0, "points": 25.0}
    assert out["components"]["risk_respected"] == {"pct": 100.0, "points": 25.0}
    assert out["components"]["profit_factor"] == {"value": None, "points": 25.0}


def test_discipline_score_oversized_risk_fails_only_the_risk_component():
    # risque = |100-50|*10 = 500 CHF = 5% du capital (> 2%) : stop ET thèse
    # sont bien là, seul le dimensionnement pèche.
    trades = [_disciplined_trade(50, stop=50.0)] * 5
    out = tradestats.discipline_score(trades, 10000.0)
    assert out["components"]["stop_set"]["points"] == 25.0
    assert out["components"]["thesis_written"]["points"] == 25.0
    assert out["components"]["risk_respected"]["points"] == 0.0


def test_discipline_score_profit_factor_interpolates_linearly_between_0_and_2():
    capital = 10000.0
    base = dict(planned_stop=95.0, thesis="x", entry_price=100.0, qty=10, fx_rate=1.0)
    # profit factor = 1.0 (gains == pertes) -> 12.5 pts
    trades = [dict(base, pnl_chf=100)] * 3 + [dict(base, pnl_chf=-100)] * 3
    out = tradestats.discipline_score(trades, capital)
    assert out["components"]["profit_factor"] == {"value": 1.0, "points": 12.5}


def test_discipline_score_profit_factor_caps_at_25_points_beyond_2():
    capital = 10000.0
    base = dict(planned_stop=95.0, thesis="x", entry_price=100.0, qty=10, fx_rate=1.0)
    trades = [dict(base, pnl_chf=100)] * 4 + [dict(base, pnl_chf=-10)]
    out = tradestats.discipline_score(trades, capital)
    assert out["components"]["profit_factor"]["value"] == 40.0
    assert out["components"]["profit_factor"]["points"] == 25.0


def test_discipline_score_survives_missing_and_garbage_fields():
    trades = [{"pnl_chf": "n/a"}, {}, None, "corrompu", {"planned_stop": "??"}] * 2
    out = tradestats.discipline_score([t for t in trades if t is not None], 10000.0)
    assert out["score"] is not None            # 8 entrées exploitables >= 5
    assert 0 <= out["score"] <= 100


def test_discipline_score_of_no_capital_never_divides_by_zero():
    trades = [_disciplined_trade(10)] * 5
    out = tradestats.discipline_score(trades, 0)
    assert out["components"]["risk_respected"]["points"] == 0.0
