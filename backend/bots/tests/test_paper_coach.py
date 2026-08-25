"""Tests du coach paper trading — détection de biais (déterministe, zéro LLM),
profil qui grandit, et générateurs de blocs markdown pour le carnet (§11).

Tout est PUR : aucun I/O ici (store.py a ses propres tests). On travaille sur
des dicts plains, les clés du contrat de données §4 de la spec.
"""
from datetime import datetime, timedelta

import pytest

from backend.bots.paper import coach

THESIS_OK = "Thèse suffisamment longue pour passer la barre des 15 caractères"
THESIS_SHORT = "ok"


def mk_trade(symbol="AAPL", qty=10, entry_price=100.0, exit_price=105.0,
             entry_at="2026-06-01T10:00:00", exit_at="2026-06-01T12:00:00",
             fees_chf=1.0, stamp_duty_chf=0.0, pnl_chf=50.0, pnl_pct=5.0,
             r_multiple=1.0, thesis=THESIS_OK, exit_reason="target",
             planned_stop=95.0, fx_rate=1.0, side="long"):
    return {
        "symbol": symbol, "side": side, "qty": qty,
        "entry_price": entry_price, "exit_price": exit_price,
        "entry_at": entry_at, "exit_at": exit_at,
        "fees_chf": fees_chf, "stamp_duty_chf": stamp_duty_chf,
        "pnl_chf": pnl_chf, "pnl_pct": pnl_pct, "r_multiple": r_multiple,
        "thesis": thesis, "exit_reason": exit_reason,
        "planned_stop": planned_stop, "fx_rate": fx_rate,
    }


def mk_order(id="o1", symbol="AAPL", side="buy", kind="limit", qty=10,
             limit_price=100.0, stop_price=None, created_at="2026-06-01T09:00:00",
             status="open", thesis=THESIS_OK, stop_loss=95.0, target=110.0,
             risk_chf=50.0):
    return {
        "id": id, "symbol": symbol, "side": side, "kind": kind, "qty": qty,
        "limit_price": limit_price, "stop_price": stop_price,
        "created_at": created_at, "status": status, "thesis": thesis,
        "stop_loss": stop_loss, "target": target, "risk_chf": risk_chf,
    }


def codes_of(biases):
    return [b["code"] for b in biases]


# --------------------------------------------------------------------------- #
# detect_biases — génériques
# --------------------------------------------------------------------------- #

def test_detect_biases_empty_inputs_returns_empty_list():
    assert coach.detect_biases([], [], 10000.0) == []


def test_detect_biases_tolerates_none_inputs():
    assert coach.detect_biases(None, None, 10000.0) == []


def test_bias_dict_shape():
    trades = [mk_trade(symbol="X", planned_stop=None) for _ in range(5)]
    biases = coach.detect_biases(trades, [], 10000.0)
    assert biases  # no_stop doit se déclencher (5/5 sans stop)
    b = biases[0]
    assert set(b.keys()) == {"code", "severity", "evidence", "metric"}
    assert isinstance(b["evidence"], list)
    assert all(isinstance(e, str) for e in b["evidence"])
    assert b["severity"] in ("info", "warn", "critical")


def test_detect_biases_never_emits_concentration():
    # concentration exige des cours live -> jamais émis par ce module PUR,
    # quel que soit le scénario (même si toutes les autres règles déclenchent).
    trades = [mk_trade(symbol="X", planned_stop=None, thesis="", r_multiple=None)
              for _ in range(6)]
    orders = [mk_order(risk_chf=99999)]
    biases = coach.detect_biases(trades, orders, 1000.0)
    assert "concentration" not in codes_of(biases)


def test_detect_biases_ordering_critical_before_warn():
    # no_stop (critical) + no_thesis (warn) dans le même run
    trades = [mk_trade(symbol="X", planned_stop=None, thesis="") for _ in range(5)]
    biases = coach.detect_biases(trades, [], 10000.0)
    severities = [b["severity"] for b in biases]
    assert severities == sorted(severities, key=lambda s: {"critical": 0, "warn": 1, "info": 2}[s])
    assert "no_stop" in codes_of(biases)
    assert "no_thesis" in codes_of(biases)
    assert biases[0]["code"] == "no_stop"  # critical passe avant le warn


# --------------------------------------------------------------------------- #
# 1. cut_winners_early
# --------------------------------------------------------------------------- #

def test_cut_winners_early_triggers():
    winners = [mk_trade(symbol=f"W{i}", r_multiple=r) for i, r in enumerate([0.3, 0.4, 0.5])]
    losers = [mk_trade(symbol=f"L{i}", r_multiple=r) for i, r in enumerate([-1.0, -1.2, -1.1])]
    biases = coach.detect_biases(winners + losers, [], 10000.0)
    hit = [b for b in biases if b["code"] == "cut_winners_early"]
    assert len(hit) == 1
    assert hit[0]["severity"] == "warn"
    assert hit[0]["metric"] < 1.0
    assert any("W0" in e for e in hit[0]["evidence"])


def test_cut_winners_early_not_triggered_when_winners_bigger():
    winners = [mk_trade(symbol=f"W{i}", r_multiple=2.0) for i in range(3)]
    losers = [mk_trade(symbol=f"L{i}", r_multiple=-1.0) for i in range(3)]
    biases = coach.detect_biases(winners + losers, [], 10000.0)
    assert "cut_winners_early" not in codes_of(biases)


def test_cut_winners_early_needs_min_3_and_3():
    winners = [mk_trade(symbol=f"W{i}", r_multiple=0.1) for i in range(2)]  # only 2
    losers = [mk_trade(symbol=f"L{i}", r_multiple=-1.0) for i in range(3)]
    biases = coach.detect_biases(winners + losers, [], 10000.0)
    assert "cut_winners_early" not in codes_of(biases)


def test_cut_winners_early_ignores_trades_without_r_multiple():
    winners = [mk_trade(symbol=f"W{i}", r_multiple=0.1) for i in range(3)]
    losers = [mk_trade(symbol=f"L{i}", r_multiple=-1.0) for i in range(3)]
    noise = [mk_trade(symbol="N", r_multiple=None) for _ in range(10)]
    biases = coach.detect_biases(winners + losers + noise, [], 10000.0)
    assert "cut_winners_early" in codes_of(biases)


# --------------------------------------------------------------------------- #
# 2. let_losers_run
# --------------------------------------------------------------------------- #

def test_let_losers_run_triggers():
    winners = [
        mk_trade(symbol=f"W{i}", pnl_chf=10.0, r_multiple=0.2,
                  entry_at="2026-06-01T10:00:00", exit_at="2026-06-01T11:00:00")
        for i in range(3)
    ]
    losers = [
        mk_trade(symbol=f"L{i}", pnl_chf=-10.0, r_multiple=-0.5,
                  entry_at="2026-06-01T10:00:00", exit_at="2026-06-01T15:00:00")
        for i in range(3)
    ]
    biases = coach.detect_biases(winners + losers, [], 10000.0)
    hit = [b for b in biases if b["code"] == "let_losers_run"]
    assert len(hit) == 1
    assert hit[0]["metric"] > 1.5
    assert any("L0" in e for e in hit[0]["evidence"])


def test_let_losers_run_not_triggered_when_close_durations():
    winners = [
        mk_trade(symbol=f"W{i}", pnl_chf=10.0, entry_at="2026-06-01T10:00:00",
                  exit_at="2026-06-01T11:00:00")
        for i in range(3)
    ]
    losers = [
        mk_trade(symbol=f"L{i}", pnl_chf=-10.0, entry_at="2026-06-01T10:00:00",
                  exit_at="2026-06-01T11:10:00")  # à peine plus long
        for i in range(3)
    ]
    biases = coach.detect_biases(winners + losers, [], 10000.0)
    assert "let_losers_run" not in codes_of(biases)


def test_let_losers_run_needs_min_3_and_3():
    winners = [
        mk_trade(symbol=f"W{i}", pnl_chf=10.0, entry_at="2026-06-01T10:00:00",
                  exit_at="2026-06-01T11:00:00")
        for i in range(3)
    ]
    losers = [
        mk_trade(symbol="L0", pnl_chf=-10.0, entry_at="2026-06-01T10:00:00",
                  exit_at="2026-06-01T20:00:00")
    ]  # only 1 loser
    biases = coach.detect_biases(winners + losers, [], 10000.0)
    assert "let_losers_run" not in codes_of(biases)


# --------------------------------------------------------------------------- #
# 3. no_stop
# --------------------------------------------------------------------------- #

def test_no_stop_triggers_above_30pct():
    trades = [mk_trade(symbol=f"T{i}", planned_stop=(None if i < 2 else 90.0))
              for i in range(5)]  # 2/5 = 40%
    biases = coach.detect_biases(trades, [], 10000.0)
    hit = [b for b in biases if b["code"] == "no_stop"]
    assert len(hit) == 1
    assert hit[0]["severity"] == "critical"
    assert hit[0]["metric"] == pytest.approx(0.4)


def test_no_stop_not_triggered_at_or_below_30pct():
    trades = [mk_trade(symbol=f"T{i}", planned_stop=(None if i < 1 else 90.0))
              for i in range(5)]  # 1/5 = 20%
    biases = coach.detect_biases(trades, [], 10000.0)
    assert "no_stop" not in codes_of(biases)


def test_no_stop_needs_min_5_trades():
    trades = [mk_trade(symbol=f"T{i}", planned_stop=None) for i in range(4)]  # 100% but only 4
    biases = coach.detect_biases(trades, [], 10000.0)
    assert "no_stop" not in codes_of(biases)


# --------------------------------------------------------------------------- #
# 4. oversized
# --------------------------------------------------------------------------- #

def test_oversized_triggers_on_order_risk():
    orders = [mk_order(symbol="ORD", risk_chf=300.0)]  # 3% of 10000 > 2%
    biases = coach.detect_biases([], orders, 10000.0)
    hit = [b for b in biases if b["code"] == "oversized"]
    assert len(hit) == 1
    assert hit[0]["severity"] == "critical"
    assert hit[0]["metric"] == pytest.approx(0.03)
    assert any("ORD" in e for e in hit[0]["evidence"])


def test_oversized_triggers_on_trade_planned_risk():
    trades = [mk_trade(symbol="RISKY", entry_price=100.0, planned_stop=50.0, qty=10, fx_rate=1.0)]
    # risk = |100-50|*10*1 = 500 -> 5% of 10000
    biases = coach.detect_biases(trades, [], 10000.0)
    hit = [b for b in biases if b["code"] == "oversized"]
    assert len(hit) == 1
    assert any("RISKY" in e for e in hit[0]["evidence"])


def test_oversized_single_occurrence_is_enough():
    # Pas de minimum d'occurrences pour ce garde-fou critique : UNE seule
    # position surdimensionnée suffit à alerter.
    orders = [mk_order(risk_chf=201.0)]  # tout juste > 2% de 10000 (200)
    biases = coach.detect_biases([], orders, 10000.0)
    assert "oversized" in codes_of(biases)


def test_oversized_not_triggered_below_threshold():
    orders = [mk_order(risk_chf=100.0)]  # 1% < 2%
    trades = [mk_trade(entry_price=100.0, planned_stop=95.0, qty=5, fx_rate=1.0)]  # risk=25
    biases = coach.detect_biases(trades, orders, 10000.0)
    assert "oversized" not in codes_of(biases)


def test_oversized_skipped_when_initial_capital_invalid():
    orders = [mk_order(risk_chf=99999.0)]
    assert coach.detect_biases([], orders, 0.0) == []
    assert coach.detect_biases([], orders, -100.0) == []


# --------------------------------------------------------------------------- #
# 5. revenge_trade
# --------------------------------------------------------------------------- #

def test_revenge_trade_triggers():
    loser = mk_trade(symbol="LOSS", pnl_chf=-100.0, qty=10, entry_price=50.0,
                      exit_at="2026-06-01T10:00:00")
    revenge = mk_trade(symbol="REV", qty=20, entry_price=50.0,
                        entry_at="2026-06-01T10:15:00")  # 15 min après, 2x la taille
    biases = coach.detect_biases([loser, revenge], [], 10000.0)
    hit = [b for b in biases if b["code"] == "revenge_trade"]
    assert len(hit) == 1
    assert hit[0]["severity"] == "warn"
    assert hit[0]["metric"] == 1.0
    assert any("REV" in e for e in hit[0]["evidence"])


def test_revenge_trade_not_triggered_outside_30min_window():
    loser = mk_trade(symbol="LOSS", pnl_chf=-100.0, qty=10, entry_price=50.0,
                      exit_at="2026-06-01T10:00:00")
    late = mk_trade(symbol="LATE", qty=20, entry_price=50.0,
                     entry_at="2026-06-01T10:45:00")  # 45 min après
    biases = coach.detect_biases([loser, late], [], 10000.0)
    assert "revenge_trade" not in codes_of(biases)


def test_revenge_trade_not_triggered_when_size_not_bigger():
    loser = mk_trade(symbol="LOSS", pnl_chf=-100.0, qty=10, entry_price=50.0,
                      exit_at="2026-06-01T10:00:00")
    same_size = mk_trade(symbol="SAME", qty=10, entry_price=50.0,
                          entry_at="2026-06-01T10:10:00")
    biases = coach.detect_biases([loser, same_size], [], 10000.0)
    assert "revenge_trade" not in codes_of(biases)


def test_revenge_trade_not_triggered_after_a_winner():
    winner = mk_trade(symbol="WIN", pnl_chf=100.0, qty=10, entry_price=50.0,
                       exit_at="2026-06-01T10:00:00")
    bigger = mk_trade(symbol="BIG", qty=20, entry_price=50.0,
                       entry_at="2026-06-01T10:10:00")
    biases = coach.detect_biases([winner, bigger], [], 10000.0)
    assert "revenge_trade" not in codes_of(biases)


# --------------------------------------------------------------------------- #
# 6. overtrading
# --------------------------------------------------------------------------- #

def _this_year():
    return datetime.now().year


def test_overtrading_triggers_warn_at_4x():
    year = _this_year()
    trades = [
        mk_trade(symbol=f"T{i}", qty=150, entry_price=50.0, fx_rate=1.0,
                  exit_at=f"{year}-02-01T10:00:00")
        for i in range(3)
    ]  # notional 7500 chacun, sum 22500, volume 45000, /10000 = 4.5x
    biases = coach.detect_biases(trades, [], 10000.0)
    hit = [b for b in biases if b["code"] == "overtrading"]
    assert len(hit) == 1
    assert hit[0]["severity"] == "warn"
    assert hit[0]["metric"] == pytest.approx(4.5)


def test_overtrading_triggers_critical_at_4_8x():
    year = _this_year()
    trades = [
        mk_trade(symbol=f"T{i}", qty=100, entry_price=50.0, fx_rate=1.0,
                  exit_at=f"{year}-02-01T10:00:00")
        for i in range(5)
    ]  # notional 5000 chacun, sum 25000, volume 50000, /10000 = 5.0x
    biases = coach.detect_biases(trades, [], 10000.0)
    hit = [b for b in biases if b["code"] == "overtrading"]
    assert len(hit) == 1
    assert hit[0]["severity"] == "critical"
    assert hit[0]["metric"] == pytest.approx(5.0)


def test_overtrading_not_triggered_below_4x():
    year = _this_year()
    trades = [
        mk_trade(symbol=f"T{i}", qty=100, entry_price=50.0, fx_rate=1.0,
                  exit_at=f"{year}-02-01T10:00:00")
        for i in range(2)
    ]  # notional 5000 chacun, sum 10000, volume 20000, /10000 = 2.0x
    biases = coach.detect_biases(trades, [], 10000.0)
    assert "overtrading" not in codes_of(biases)


def test_overtrading_ignores_trades_from_other_years():
    trades = [
        mk_trade(symbol="OLD", qty=100000, entry_price=500.0, fx_rate=1.0,
                  exit_at="2019-02-01T10:00:00"),  # énorme volume mais année passée
    ]
    biases = coach.detect_biases(trades, [], 10000.0)
    assert "overtrading" not in codes_of(biases)


# --------------------------------------------------------------------------- #
# 8. fee_bleed
# --------------------------------------------------------------------------- #

def test_fee_bleed_triggers():
    trades = [mk_trade(symbol=f"T{i}", pnl_chf=100.0, fees_chf=20.0, stamp_duty_chf=5.0)
              for i in range(5)]
    # fees_sum = 25*5=125 ; pnl_abs_sum = 500 ; ratio = 0.25 > 0.20
    biases = coach.detect_biases(trades, [], 10000.0)
    hit = [b for b in biases if b["code"] == "fee_bleed"]
    assert len(hit) == 1
    assert hit[0]["severity"] == "warn"
    assert hit[0]["metric"] == pytest.approx(0.25)


def test_fee_bleed_not_triggered_below_20pct():
    trades = [mk_trade(symbol=f"T{i}", pnl_chf=100.0, fees_chf=5.0, stamp_duty_chf=0.0)
              for i in range(5)]
    # fees_sum=25, pnl_abs_sum=500, ratio=0.05
    biases = coach.detect_biases(trades, [], 10000.0)
    assert "fee_bleed" not in codes_of(biases)


def test_fee_bleed_needs_min_5_trades():
    trades = [mk_trade(symbol=f"T{i}", pnl_chf=1.0, fees_chf=100.0) for i in range(4)]
    biases = coach.detect_biases(trades, [], 10000.0)
    assert "fee_bleed" not in codes_of(biases)


def test_fee_bleed_skipped_when_denominator_zero():
    trades = [mk_trade(symbol=f"T{i}", pnl_chf=0.0, fees_chf=10.0) for i in range(5)]
    biases = coach.detect_biases(trades, [], 10000.0)
    assert "fee_bleed" not in codes_of(biases)


# --------------------------------------------------------------------------- #
# 9. no_thesis
# --------------------------------------------------------------------------- #

def test_no_thesis_triggers_above_30pct():
    trades = [mk_trade(symbol="A", thesis=THESIS_SHORT), mk_trade(symbol="B", thesis=None)]
    orders = [mk_order(symbol="C", thesis=THESIS_OK), mk_order(symbol="D", thesis=THESIS_OK)]
    # 2/4 = 50% sans thèse valable
    biases = coach.detect_biases(trades, orders, 10000.0)
    hit = [b for b in biases if b["code"] == "no_thesis"]
    assert len(hit) == 1
    assert hit[0]["severity"] == "warn"
    assert hit[0]["metric"] == pytest.approx(0.5)
    assert any("A" in e for e in hit[0]["evidence"])


def test_no_thesis_not_triggered_at_or_below_30pct():
    trades = [mk_trade(symbol="A", thesis=THESIS_SHORT)]
    orders = [mk_order(symbol="B", thesis=THESIS_OK), mk_order(symbol="C", thesis=THESIS_OK),
              mk_order(symbol="D", thesis=THESIS_OK)]
    # 1/4 = 25%
    biases = coach.detect_biases(trades, orders, 10000.0)
    assert "no_thesis" not in codes_of(biases)


def test_no_thesis_needs_min_3_elements():
    trades = [mk_trade(symbol="A", thesis=None)]
    orders = [mk_order(symbol="B", thesis=None)]
    biases = coach.detect_biases(trades, orders, 10000.0)
    assert "no_thesis" not in codes_of(biases)


# --------------------------------------------------------------------------- #
# empty_profile
# --------------------------------------------------------------------------- #

def test_empty_profile_shape():
    p = coach.empty_profile()
    assert p == {
        "created_at": None,
        "n_sessions": 0,
        "bias_history": {},
        "resolved_biases": [],
        "milestones": [],
        "arena_history": [],
        "notes": [],
    }


# --------------------------------------------------------------------------- #
# update_profile
# --------------------------------------------------------------------------- #

def test_update_profile_sets_created_at_once_and_increments_sessions():
    p0 = coach.empty_profile()
    p1 = coach.update_profile(p0, [], {}, "2026-01-01T00:00:00")
    assert p1["created_at"] == "2026-01-01T00:00:00"
    assert p1["n_sessions"] == 1
    # original jamais muté
    assert p0["created_at"] is None
    assert p0["n_sessions"] == 0

    p2 = coach.update_profile(p1, [], {}, "2026-01-02T00:00:00")
    assert p2["created_at"] == "2026-01-01T00:00:00"  # inchangé
    assert p2["n_sessions"] == 2


def test_update_profile_does_not_mutate_input_nested_structures():
    p0 = coach.empty_profile()
    biases = [{"code": "no_stop", "severity": "critical", "evidence": ["x"], "metric": 0.4}]
    p1 = coach.update_profile(p0, biases, {}, "2026-01-01T00:00:00")
    p2 = coach.update_profile(p1, [], {}, "2026-01-02T00:00:00")
    # muter p2 ne doit pas affecter p1
    p2["bias_history"]["no_stop"]["count"] = 999
    assert p1["bias_history"]["no_stop"]["count"] == 1
    # muter p1 ne doit pas affecter p0 (toujours vide)
    assert p0["bias_history"] == {}


def test_update_profile_accumulates_bias_history():
    p = coach.empty_profile()
    biases = [{"code": "no_stop", "severity": "critical", "evidence": [], "metric": 0.4}]
    p = coach.update_profile(p, biases, {}, "2026-01-01T00:00:00")
    entry = p["bias_history"]["no_stop"]
    assert entry["count"] == 1
    assert entry["first_seen"] == "2026-01-01T00:00:00"
    assert entry["last_seen"] == "2026-01-01T00:00:00"
    assert entry["last_severity"] == "critical"

    p = coach.update_profile(p, biases, {}, "2026-01-08T00:00:00")
    entry = p["bias_history"]["no_stop"]
    assert entry["count"] == 2
    assert entry["first_seen"] == "2026-01-01T00:00:00"  # inchangé
    assert entry["last_seen"] == "2026-01-08T00:00:00"


def test_update_profile_resolves_stale_bias_after_14_days_and_count_2():
    p = coach.empty_profile()
    biases = [{"code": "revenge_trade", "severity": "warn", "evidence": [], "metric": 1.0}]
    p = coach.update_profile(p, biases, {}, "2026-01-01T00:00:00")  # count=1
    p = coach.update_profile(p, biases, {}, "2026-01-02T00:00:00")  # count=2, last_seen=01-02
    p = coach.update_profile(p, [], {}, "2026-01-20T00:00:00")  # 18j plus tard, plus détecté
    assert "revenge_trade" not in p["bias_history"]
    resolved = [r for r in p["resolved_biases"] if r["code"] == "revenge_trade"]
    assert len(resolved) == 1
    assert resolved[0]["resolved_at"] == "2026-01-20T00:00:00"


def test_update_profile_does_not_resolve_if_count_below_2():
    p = coach.empty_profile()
    biases = [{"code": "fee_bleed", "severity": "warn", "evidence": [], "metric": 0.3}]
    p = coach.update_profile(p, biases, {}, "2026-01-01T00:00:00")  # count=1 seulement
    p = coach.update_profile(p, [], {}, "2026-02-01T00:00:00")  # 31j plus tard
    assert "fee_bleed" in p["bias_history"]
    assert p["resolved_biases"] == []


def test_update_profile_does_not_resolve_if_not_yet_stale():
    p = coach.empty_profile()
    biases = [{"code": "cut_winners_early", "severity": "warn", "evidence": [], "metric": 0.5}]
    p = coach.update_profile(p, biases, {}, "2026-01-01T00:00:00")
    p = coach.update_profile(p, biases, {}, "2026-01-02T00:00:00")  # count=2
    p = coach.update_profile(p, [], {}, "2026-01-10T00:00:00")  # 8j seulement depuis last_seen
    assert "cut_winners_early" in p["bias_history"]
    assert p["resolved_biases"] == []


def test_update_profile_does_not_resolve_if_still_detected():
    p = coach.empty_profile()
    biases = [{"code": "no_thesis", "severity": "warn", "evidence": [], "metric": 0.5}]
    p = coach.update_profile(p, biases, {}, "2026-01-01T00:00:00")
    p = coach.update_profile(p, biases, {}, "2026-01-02T00:00:00")  # count=2
    p = coach.update_profile(p, biases, {}, "2026-02-01T00:00:00")  # encore détecté aujourd'hui
    assert "no_thesis" in p["bias_history"]
    assert p["bias_history"]["no_thesis"]["count"] == 3
    assert p["resolved_biases"] == []


def test_update_profile_milestone_first_10_trades():
    p = coach.empty_profile()
    p = coach.update_profile(p, [], {"n_trades": 10}, "2026-01-01T00:00:00")
    keys = {m["key"] for m in p["milestones"]}
    assert "first_10_trades" in keys
    assert "fifty_trades" not in keys


def test_update_profile_milestone_positive_expectancy_requires_10_trades():
    p = coach.empty_profile()
    p = coach.update_profile(p, [], {"n_trades": 5, "expectancy_r": 0.5}, "2026-01-01T00:00:00")
    keys = {m["key"] for m in p["milestones"]}
    assert "first_positive_expectancy" not in keys

    p = coach.update_profile(p, [], {"n_trades": 10, "expectancy_r": 0.5}, "2026-01-02T00:00:00")
    keys = {m["key"] for m in p["milestones"]}
    assert "first_positive_expectancy" in keys


def test_update_profile_milestone_drawdown_and_fifty_trades():
    p = coach.empty_profile()
    p = coach.update_profile(p, [], {"max_drawdown_pct": 25}, "2026-01-01T00:00:00")
    keys = {m["key"] for m in p["milestones"]}
    assert "survived_20pct_drawdown" in keys

    p2 = coach.empty_profile()
    p2 = coach.update_profile(p2, [], {"n_trades": 60}, "2026-01-01T00:00:00")
    keys2 = {m["key"] for m in p2["milestones"]}
    assert "first_10_trades" in keys2
    assert "fifty_trades" in keys2


def test_update_profile_milestone_fires_only_once():
    p = coach.empty_profile()
    p = coach.update_profile(p, [], {"n_trades": 10}, "2026-01-01T00:00:00")
    p = coach.update_profile(p, [], {"n_trades": 15}, "2026-01-02T00:00:00")
    count = sum(1 for m in p["milestones"] if m["key"] == "first_10_trades")
    assert count == 1


# --------------------------------------------------------------------------- #
# coach_summary
# --------------------------------------------------------------------------- #

def test_coach_summary_top_biases_by_count_desc():
    p = coach.empty_profile()
    p["bias_history"] = {
        "no_stop": {"count": 5, "first_seen": "x", "last_seen": "y", "last_severity": "critical"},
        "fee_bleed": {"count": 2, "first_seen": "x", "last_seen": "y", "last_severity": "warn"},
        "revenge_trade": {"count": 8, "first_seen": "x", "last_seen": "y", "last_severity": "warn"},
        "no_thesis": {"count": 1, "first_seen": "x", "last_seen": "y", "last_severity": "warn"},
    }
    p["n_sessions"] = 12
    summary = coach.coach_summary(p, [])
    assert summary["top_biases"] == ["revenge_trade", "no_stop", "fee_bleed"]
    assert summary["n_sessions"] == 12


def test_coach_summary_recent_progress_within_30_days():
    now = datetime.now()
    recent_iso = (now - timedelta(days=5)).isoformat()
    old_iso = (now - timedelta(days=40)).isoformat()
    p = coach.empty_profile()
    p["resolved_biases"] = [
        {"code": "no_stop", "resolved_at": recent_iso},
        {"code": "fee_bleed", "resolved_at": old_iso},
    ]
    summary = coach.coach_summary(p, [])
    codes = {r["code"] for r in summary["recent_progress"]}
    assert codes == {"no_stop"}


def test_coach_summary_milestones_passthrough():
    p = coach.empty_profile()
    p["milestones"] = [{"key": "first_10_trades", "reached_at": "2026-01-01T00:00:00"}]
    summary = coach.coach_summary(p, [])
    assert summary["milestones"] == p["milestones"]


def test_coach_summary_empty_profile_has_sane_defaults():
    p = coach.empty_profile()
    summary = coach.coach_summary(p, [])
    assert summary == {
        "top_biases": [],
        "recent_progress": [],
        "n_sessions": 0,
        "milestones": [],
    }


# --------------------------------------------------------------------------- #
# §11 — carnet Markdown : générateurs de blocs (PUR, aucun I/O)
# --------------------------------------------------------------------------- #

def test_bias_note_entry_contains_header_evidence_and_journal_link():
    bias = {"code": "no_stop", "severity": "critical",
            "evidence": ["2/5 trades sans stop", "AAPL (2026-06-01): aucun stop"],
            "metric": 0.4}
    text = coach.bias_note_entry(bias, "2026-08-24T09:00:00")
    assert text.startswith("## 2026-08-24 — détection (critical)")
    assert "- 2/5 trades sans stop" in text
    assert "- AAPL (2026-06-01): aucun stop" in text
    assert "[[Journal]]" in text
    assert text.endswith("\n\n") or text.endswith("\n")


def test_bias_note_entry_handles_empty_evidence():
    bias = {"code": "oversized", "severity": "critical", "evidence": [], "metric": None}
    text = coach.bias_note_entry(bias, "2026-08-24T09:00:00")
    assert "détection (critical)" in text
    assert "[[Journal]]" in text


def test_resolution_note_entry_mentions_code_and_journal_link():
    text = coach.resolution_note_entry("revenge_trade", "2026-08-24T09:00:00")
    assert "2026-08-24" in text
    assert "revenge_trade" in text
    assert "résolu" in text
    assert "[[Journal]]" in text


def test_journal_entry_has_dated_header_and_body():
    text = coach.journal_entry("NESN.SW +1.8R", "Sortie propre, thèse respectée.",
                                "2026-08-24T09:00:00")
    assert text.startswith("## 2026-08-24 — NESN.SW +1.8R")
    assert "Sortie propre, thèse respectée." in text


def test_journal_entry_strips_body_whitespace():
    text = coach.journal_entry("Titre", "   du texte avec des espaces   \n",
                                "2026-08-24T09:00:00")
    assert "du texte avec des espaces" in text
    assert "   du texte" not in text


def test_note_entries_return_plain_strings():
    bias = {"code": "no_stop", "severity": "warn", "evidence": [], "metric": None}
    assert isinstance(coach.bias_note_entry(bias, "2026-08-24T09:00:00"), str)
    assert isinstance(coach.resolution_note_entry("no_stop", "2026-08-24T09:00:00"), str)
    assert isinstance(coach.journal_entry("t", "b", "2026-08-24T09:00:00"), str)


# --------------------------------------------------------------------------- #
# Langue des preuves (le simulateur parle la langue de l'interface)
#
# Ce que ces tests verrouillent : la langue change les PHRASES et RIEN d'autre.
# Le jour où quelqu'un traduit un gabarit et déplace un seuil par mégarde, ce
# sont ces tests qui le disent — pas l'utilisateur italophone.
# --------------------------------------------------------------------------- #

def _evidence_text(biases, code):
    hit = [b for b in biases if b["code"] == code]
    assert len(hit) == 1, "biais %s absent : %s" % (code, codes_of(biases))
    return "\n".join(hit[0]["evidence"])


def test_every_template_exists_in_every_language():
    """Un gabarit manquant lèverait un KeyError en pleine réponse HTTP."""
    reference = set(coach._TEXTS["fr"])
    for lang, table in coach._TEXTS.items():
        assert set(table) == reference, "gabarits divergents pour %r" % lang


def test_no_stop_evidence_is_italian_when_asked():
    trades = [mk_trade(symbol="T%d" % i, planned_stop=(None if i < 2 else 90.0))
              for i in range(5)]
    text = _evidence_text(coach.detect_biases(trades, [], 10000.0, lang="it"),
                          "no_stop")
    assert "trade chiusi senza stop pianificato" in text
    assert "nessuno stop pianificato" in text
    assert "planifié" not in text


def test_oversized_evidence_is_italian_when_asked():
    orders = [mk_order(symbol="ORD", risk_chf=300.0)]
    text = _evidence_text(coach.detect_biases([], orders, 10000.0, lang="it"),
                          "oversized")
    assert "Ordine ORD" in text
    assert "rischio pianificato" in text and "del capitale" in text


def test_fee_bleed_and_no_thesis_evidence_are_italian():
    trades = [mk_trade(symbol="T%d" % i, fees_chf=30.0, pnl_chf=10.0,
                       thesis=THESIS_SHORT) for i in range(5)]
    biases = coach.detect_biases(trades, [], 10000.0, lang="it")
    fees = _evidence_text(biases, "fee_bleed")
    assert "Costi cumulati" in fees and "del P&L lordo" in fees
    assert "di commissioni/bollo" in fees
    thesis = _evidence_text(biases, "no_thesis")
    assert "senza tesi" in thesis and "tesi assente o troppo corta" in thesis


def test_revenge_trade_evidence_is_italian():
    loser = mk_trade(symbol="LOSS", pnl_chf=-50.0, qty=5,
                     entry_at="2026-06-01T09:00:00", exit_at="2026-06-01T10:00:00")
    revenge = mk_trade(symbol="REV", qty=50,
                       entry_at="2026-06-01T10:10:00", exit_at="2026-06-01T11:00:00")
    text = _evidence_text(coach.detect_biases([loser, revenge], [], 10000.0, lang="it"),
                          "revenge_trade")
    assert "revenge trade rilevati" in text
    assert "dopo una perdita su LOSS" in text and "size nozionale maggiore" in text


def test_let_losers_run_evidence_is_italian_including_the_day_unit():
    """Le suffixe de durée fait partie de la langue : 'j' en français, 'g' en
    italien (giorni) — un détail, mais c'est le genre de détail qui trahit une
    traduction faite à moitié."""
    winners = [mk_trade(symbol="W%d" % i, pnl_chf=10.0,
                        entry_at="2026-06-01T09:00:00",
                        exit_at="2026-06-01T10:00:00") for i in range(3)]
    losers = [mk_trade(symbol="L%d" % i, pnl_chf=-10.0,
                       entry_at="2026-06-01T09:00:00",
                       exit_at="2026-06-06T09:00:00") for i in range(3)]
    text = _evidence_text(coach.detect_biases(winners + losers, [], 10000.0, lang="it"),
                          "let_losers_run")
    assert "Durata media di detenzione dei perdenti" in text
    assert "in perdita" in text
    assert "5.0g" in text and "5.0j" not in text


def test_cut_winners_and_overtrading_evidence_are_italian():
    winners = [mk_trade(symbol="W%d" % i, r_multiple=0.5, pnl_chf=10.0)
               for i in range(3)]
    losers = [mk_trade(symbol="L%d" % i, r_multiple=-2.0, pnl_chf=-10.0)
              for i in range(3)]
    text = _evidence_text(coach.detect_biases(winners + losers, [], 10000.0, lang="it"),
                          "cut_winners_early")
    assert "R media dei trade vincenti" in text and "chiuso a +" in text

    year = datetime.now().year
    heavy = [mk_trade(symbol="H%d" % i, qty=100, entry_price=30.0,
                      exit_at="%d-06-01T12:00:00" % year) for i in range(9)]
    volume = _evidence_text(coach.detect_biases(heavy, [], 10000.0, lang="it"),
                            "overtrading")
    assert "Volume annuo stimato" in volume and "il capitale iniziale" in volume


def test_the_capped_evidence_tail_is_translated():
    trades = [mk_trade(symbol="T%d" % i, planned_stop=None) for i in range(40)]
    text = _evidence_text(coach.detect_biases(trades, [], 10000.0, lang="it"),
                          "no_stop")
    assert "e altri" in text and "et " not in text


def test_missing_date_label_is_translated():
    trades = [mk_trade(symbol="T%d" % i, planned_stop=None, exit_at=None,
                       pnl_chf=None) for i in range(5)]
    text = _evidence_text(coach.detect_biases(trades, [], 10000.0, lang="it"),
                          "no_stop")
    assert "data sconosciuta" in text


def test_language_changes_the_words_but_never_the_verdict():
    """Codes, sévérités, métriques et ordre : identiques dans les deux langues."""
    trades = [mk_trade(symbol="T%d" % i, planned_stop=None, fees_chf=30.0,
                       pnl_chf=10.0, thesis=THESIS_SHORT) for i in range(5)]
    orders = [mk_order(symbol="ORD", risk_chf=300.0)]
    fr = coach.detect_biases(trades, orders, 10000.0, lang="fr")
    it = coach.detect_biases(trades, orders, 10000.0, lang="it")
    assert [(b["code"], b["severity"], b["metric"]) for b in fr] \
        == [(b["code"], b["severity"], b["metric"]) for b in it]
    assert [b["evidence"] for b in fr] != [b["evidence"] for b in it]


def test_default_language_is_bit_for_bit_the_previous_behaviour():
    trades = [mk_trade(symbol="T%d" % i, planned_stop=None) for i in range(5)]
    orders = [mk_order(symbol="ORD", risk_chf=300.0)]
    assert coach.detect_biases(trades, orders, 10000.0) \
        == coach.detect_biases(trades, orders, 10000.0, lang="fr")


@pytest.mark.parametrize("lang", ["en", "de", "", None, "IT-CH", "  "])
def test_unsupported_languages_fall_back_to_french_without_raising(lang):
    trades = [mk_trade(symbol="T%d" % i, planned_stop=None) for i in range(5)]
    assert coach.detect_biases(trades, [], 10000.0, lang=lang) \
        == coach.detect_biases(trades, [], 10000.0)


def test_italian_is_accepted_case_insensitively():
    trades = [mk_trade(symbol="T%d" % i, planned_stop=None) for i in range(5)]
    assert coach.detect_biases(trades, [], 10000.0, lang="IT") \
        == coach.detect_biases(trades, [], 10000.0, lang="it")


def test_coach_summary_is_language_independent_by_design():
    """Le résumé ne contient QUE des codes — le client les traduit lui-même.
    Le paramètre existe pour que le router passe la même langue partout."""
    p = coach.empty_profile()
    p["bias_history"] = {"no_stop": {"count": 3, "first_seen": "x", "last_seen": "y",
                                     "last_severity": "critical"}}
    p["milestones"] = [{"key": "first_10_trades", "reached_at": "2026-01-01T00:00:00"}]
    assert coach.coach_summary(p, [], lang="it") == coach.coach_summary(p, [])
    assert coach.coach_summary(p, [], lang="zz") == coach.coach_summary(p, [])
