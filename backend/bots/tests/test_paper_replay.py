"""Tests du « bar replay » (LOT 3, A3) — module PUR, zéro I/O."""
import pytest

from backend.bots.paper.replay import (
    MAX_REPLAY_SESSIONS,
    MIN_CANDLES,
    grade,
    make_window,
    stats,
)


class _FixedRng:
    """Source d'aléa injectée qui rend toujours la même valeur -- déterminisme
    total pour les tests, aucune dépendance au module ``random`` global."""
    def __init__(self, value=0):
        self.value = value
        self.calls = []

    def randint(self, a, b):
        self.calls.append((a, b))
        return self.value


def _candles(n, start_close=100.0, step=1.0):
    """``n`` bougies journalières croissantes, ``ts`` chronologique."""
    return [{"ts": 1_700_000_000 + i * 86400, "open": start_close + i * step,
            "high": start_close + i * step + 0.5, "low": start_close + i * step - 0.5,
            "close": start_close + i * step, "volume": 1000}
            for i in range(n)]


# --------------------------------------------------------------------------- #
# make_window
# --------------------------------------------------------------------------- #

def test_make_window_refuses_below_the_minimum():
    with pytest.raises(ValueError):
        make_window(_candles(MIN_CANDLES - 1), _FixedRng())


def test_make_window_accepts_exactly_the_minimum():
    win = make_window(_candles(MIN_CANDLES), _FixedRng(0))
    assert len(win["candles"]) == 60
    assert len(win["reveal"]) == 20


def test_make_window_splits_60_visible_then_20_to_reveal():
    win = make_window(_candles(90), _FixedRng(0))
    assert [c["close"] for c in win["candles"]] == [100.0 + i for i in range(60)]
    assert [c["close"] for c in win["reveal"]] == [100.0 + i for i in range(60, 80)]


def test_make_window_uses_the_injected_rng_for_the_start_offset():
    # 100 bougies dispo, 80 nécessaires -> 20 décalages de départ possibles (0..20).
    rng = _FixedRng(7)
    win = make_window(_candles(100), rng)
    assert rng.calls == [(0, 20)]
    assert win["candles"][0]["close"] == 100.0 + 7
    assert win["reveal"][-1]["close"] == 100.0 + 7 + 79


def test_make_window_at_the_minimum_still_offers_several_start_offsets():
    # 90 dispo, 80 nécessaires -> 11 départs possibles (0..10) : le seuil de
    # MIN_CANDLES existe justement pour garantir un minimum de variation.
    rng = _FixedRng(0)
    make_window(_candles(90), rng)
    assert rng.calls == [(0, 10)]


def test_make_window_never_calls_randint_when_exactly_one_start_fits():
    # shown+steps == candles dispo (90 == 70+20) -> UN SEUL départ possible
    # (0), pas la peine de tirer.
    rng = _FixedRng(0)
    win = make_window(_candles(90), rng, shown=70, steps=20)
    assert rng.calls == []
    assert len(win["candles"]) == 70 and len(win["reveal"]) == 20


def test_make_window_custom_shown_and_steps():
    win = make_window(_candles(MIN_CANDLES), _FixedRng(0), shown=10, steps=5)
    assert len(win["candles"]) == 10
    assert len(win["reveal"]) == 5


def test_make_window_refuses_when_shown_plus_steps_exceeds_available():
    with pytest.raises(ValueError):
        make_window(_candles(90), _FixedRng(0), shown=60, steps=40)


def test_make_window_ignores_non_dict_entries():
    rows = _candles(MIN_CANDLES) + ["junk", None, 4]
    win = make_window(rows, _FixedRng(0))
    assert len(win["candles"]) == 60 and len(win["reveal"]) == 20


def test_make_window_preserves_chronological_order():
    win = make_window(_candles(90), _FixedRng(0))
    ts = [c["ts"] for c in win["candles"]] + [c["ts"] for c in win["reveal"]]
    assert ts == sorted(ts)


# --------------------------------------------------------------------------- #
# grade
# --------------------------------------------------------------------------- #

def test_grade_empty_decisions_is_all_zeros():
    assert grade({"decisions": []}) == {"pnl_pct": 0.0, "n_decisions": 0, "hold_pnl_pct": 0.0}
    assert grade({}) == {"pnl_pct": 0.0, "n_decisions": 0, "hold_pnl_pct": 0.0}
    assert grade(None) == {"pnl_pct": 0.0, "n_decisions": 0, "hold_pnl_pct": 0.0}


def test_grade_a_single_winning_buy():
    out = grade({"decisions": [{"prev_close": 100.0, "close": 110.0, "action": "buy"}]})
    assert out == {"pnl_pct": 10.0, "n_decisions": 1, "hold_pnl_pct": 10.0}


def test_grade_a_single_winning_sell_is_mirrored():
    # short : le titre BAISSE de 10 % -> +10 % pour le vendeur ; le hold, lui,
    # reste la performance BRUTE du titre (-10 %), peu importe la décision.
    out = grade({"decisions": [{"prev_close": 100.0, "close": 90.0, "action": "sell"}]})
    assert out["pnl_pct"] == 10.0
    assert out["hold_pnl_pct"] == -10.0


def test_grade_flat_contributes_nothing():
    out = grade({"decisions": [{"prev_close": 100.0, "close": 120.0, "action": "flat"}]})
    assert out["pnl_pct"] == 0.0
    assert out["hold_pnl_pct"] == 20.0


def test_grade_unknown_action_is_treated_as_flat():
    out = grade({"decisions": [{"prev_close": 100.0, "close": 120.0, "action": "???"}]})
    assert out["pnl_pct"] == 0.0


def test_grade_sums_steps_instead_of_compounding():
    # deux +10 % d'affilée en LONG : une somme donne 20 (lisible), un produit
    # composé aurait donné 21 (1.1*1.1=1.21) -- on veut la somme.
    out = grade({"decisions": [
        {"prev_close": 100.0, "close": 110.0, "action": "buy"},
        {"prev_close": 110.0, "close": 121.0, "action": "buy"},
    ]})
    assert out["pnl_pct"] == 20.0
    assert out["n_decisions"] == 2


def test_grade_hold_spans_the_first_prev_close_to_the_last_close():
    out = grade({"decisions": [
        {"prev_close": 100.0, "close": 105.0, "action": "flat"},
        {"prev_close": 105.0, "close": 90.0, "action": "flat"},
    ]})
    assert out["hold_pnl_pct"] == -10.0  # (90-100)/100 x 100


def test_grade_mixed_long_and_short_decisions():
    out = grade({"decisions": [
        {"prev_close": 100.0, "close": 110.0, "action": "buy"},   # +10
        {"prev_close": 110.0, "close": 99.0, "action": "sell"},   # +10 (baisse de 10%)
    ]})
    assert out["pnl_pct"] == 20.0


def test_grade_ignores_non_dict_decisions():
    out = grade({"decisions": [
        {"prev_close": 100.0, "close": 110.0, "action": "buy"}, "junk", None, 4]})
    assert out["n_decisions"] == 1


def test_grade_skips_a_step_with_unreadable_prices_without_crashing():
    out = grade({"decisions": [
        {"prev_close": None, "close": 110.0, "action": "buy"},
        {"prev_close": 100.0, "close": None, "action": "buy"},
        {"prev_close": 0.0, "close": 110.0, "action": "buy"},
    ]})
    assert out["pnl_pct"] == 0.0
    assert out["n_decisions"] == 3


def test_grade_hold_is_zero_when_the_baseline_is_unreadable():
    out = grade({"decisions": [{"prev_close": None, "close": 110.0, "action": "buy"}]})
    assert out["hold_pnl_pct"] == 0.0


def test_max_replay_sessions_is_fifty():
    assert MAX_REPLAY_SESSIONS == 50


# --------------------------------------------------------------------------- #
# stats
# --------------------------------------------------------------------------- #

def test_stats_on_an_empty_journal():
    assert stats([]) == {"n": 0, "avg_pnl_pct": None, "avg_hold_pnl_pct": None,
                         "beat_hold_pct": None}
    assert stats(None) == {"n": 0, "avg_pnl_pct": None, "avg_hold_pnl_pct": None,
                           "beat_hold_pct": None}


def test_stats_averages_and_beat_rate():
    sessions = [
        {"pnl_pct": 10.0, "hold_pnl_pct": 4.0},    # bat le hold
        {"pnl_pct": -2.0, "hold_pnl_pct": 3.0},    # ne bat pas
        {"pnl_pct": 6.0, "hold_pnl_pct": 6.0},     # égalité -- ne compte pas comme "bat"
    ]
    out = stats(sessions)
    assert out["n"] == 3
    assert out["avg_pnl_pct"] == round((10.0 - 2.0 + 6.0) / 3, 2)
    assert out["avg_hold_pnl_pct"] == round((4.0 + 3.0 + 6.0) / 3, 2)
    assert out["beat_hold_pct"] == round(1 / 3 * 100.0, 1)


def test_stats_tolerates_unreadable_entries():
    sessions = [{"pnl_pct": "n/a", "hold_pnl_pct": None}, "junk", None,
               {"pnl_pct": 5.0, "hold_pnl_pct": 1.0}]
    out = stats(sessions)
    assert out["n"] == 2   # "junk"/None écartés (pas des dicts) ; les valeurs
                            # illisibles de la 1ʳᵉ entrée ne l'écartent pas
                            # elle-même, elles écartent juste ses moyennes.
    assert out["avg_pnl_pct"] == 5.0
    assert out["avg_hold_pnl_pct"] == 1.0
    assert out["beat_hold_pct"] == 50.0


def test_stats_all_unreadable_gives_none_averages_but_a_real_count():
    out = stats([{"pnl_pct": "n/a", "hold_pnl_pct": "n/a"}])
    assert out["n"] == 1
    assert out["avg_pnl_pct"] is None
    assert out["avg_hold_pnl_pct"] is None
    assert out["beat_hold_pct"] == 0.0
