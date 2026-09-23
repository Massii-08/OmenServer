"""LOT 15 — « le coach tient ses thèses » — 100 % hors ligne.

Le radar pense en semaines (thèses de 12 à 25 jours, justes 7 fois sur 11),
le coach agissait en jours (jamais plus de 6 jours de détention, médiane
~2 j) : il coupait ses idées à 15 % de leur horizon. Ce lot aligne le coach
sur la thèse :

  T1 — toute ENTRÉE porte un contrat (horizon, invalidation, échéance),
       hérité de l'hypothèse radar quand elle en vient ;
  T2 — le plancher de bruit du stop grandit comme √(jours restants) ;
  T3 — l'échéance ferme la position (moteur, sans LLM) ;
  T4 — une SORTIE dit pourquoi (liste fermée, contrôle de FORME) ;
  T6 — la mesure : par raison de sortie, et thèse juste/fausse x trade
       gagnant/perdant.

Ce fichier teste la partie PURE (``coach_trader``) ; le routeur est testé
dans ``test_paper_router.py`` (section LOT 15).
"""
import math

import pytest

from backend.bots.paper import coach_trader, radar, store

THESIS = "cassure du range mensuel sur volume"
INVALIDATION = "clôture sous 92 sur volume (le range tient)"
NOW = "2026-09-23T10:00:00"          # mercredi, 10:00 Rome : SIX ouverte


@pytest.fixture(autouse=True)
def _isolate_data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path / "paper_trading")
    yield


def _pf(cash=10000.0, positions=None, trades=None):
    return {"cash_chf": cash, "positions": list(positions or []),
            "open_orders": [], "trades": list(trades or []),
            "initial_capital": 10000.0}


def _quote(price=100.0):
    return {"price": price, "currency": "CHF", "fx_rate": 1.0}


def _buy(**over):
    base = {"action": "buy", "symbol": "NESN.SW", "qty": 20, "stop": 90.0,
            "target": 130.0, "thesis": THESIS, "setup": "breakout",
            "horizon_days": 10, "invalidation": INVALIDATION}
    base.update(over)
    return base


def _inherited(deadline="2026-10-08T17:00:00", horizon=15,
               invalidation="Une désescalade rapide dans le Golfe"):
    return {"horizon_days": horizon, "invalidation": invalidation,
            "thesis_deadline": deadline}


# =========================================================================== #
# T1 — le contrat de thèse
# =========================================================================== #

def test_new_reject_codes_are_declared():
    for code in ("no_horizon", "thesis_expiring"):
        assert code in coach_trader.REJECT_CODES


def test_the_bounds_are_the_radar_ones():
    """Pas un second jeu de bornes qui divergerait : celles du radar."""
    assert coach_trader.MIN_THESIS_HORIZON_D == radar.MIN_HORIZON_D
    assert coach_trader.MAX_THESIS_HORIZON_D == radar.MAX_HORIZON_COACH_D


def test_a_declared_contract_travels_on_the_accepted_order():
    out = coach_trader.gate_decision(_buy(), _pf(), _quote(), now=NOW)
    assert out["accepted"] is True, out
    order = out["order"]
    assert order["horizon_days"] == 10
    assert order["invalidation"] == INVALIDATION
    # déclaré -> l'échéance court à partir de MAINTENANT (heure locale naïve)
    assert order["thesis_deadline"] == "2026-10-03T10:00:00"


@pytest.mark.parametrize("missing", ["horizon_days", "invalidation"])
def test_an_entry_without_contract_is_refused(missing):
    decision = _buy()
    decision.pop(missing)
    out = coach_trader.gate_decision(decision, _pf(), _quote(), now=NOW)
    assert out["accepted"] is False
    assert out["reason"] == "no_horizon"


@pytest.mark.parametrize("horizon", [0, 2, 121, 999, "dix", None, True, 7.5])
def test_a_declared_horizon_out_of_bounds_is_refused_not_clamped(horizon):
    """On REJETTE, on ne rogne JAMAIS en silence (doctrine de la porte) :
    un horizon hors [3, 120] n'est pas ramené dans les bornes."""
    out = coach_trader.gate_decision(_buy(horizon_days=horizon), _pf(),
                                     _quote(), now=NOW)
    assert out["reason"] == "no_horizon"


def test_a_numeric_string_horizon_is_read():
    out = coach_trader.gate_decision(_buy(horizon_days="12"), _pf(), _quote(),
                                     now=NOW)
    assert out["accepted"] is True
    assert out["order"]["horizon_days"] == 12


def test_a_too_short_invalidation_is_refused():
    out = coach_trader.gate_decision(_buy(invalidation="baisse"), _pf(),
                                     _quote(), now=NOW)
    assert out["reason"] == "no_horizon"


def test_an_ambush_needs_a_contract_too():
    ambush = _buy(kind="stop", trigger=110.0, stop=100.0, target=140.0)
    ambush.pop("horizon_days")
    out = coach_trader.gate_decision(ambush, _pf(), _quote(), now=NOW)
    assert out["reason"] == "no_horizon"


def test_an_inherited_contract_wins_over_the_declared_one():
    """Né d'une idée du radar : horizon, invalidation et ÉCHÉANCE sont ceux
    de l'hypothèse — le coach ne peut pas allonger."""
    decision = _buy(horizon_days=120, invalidation="jamais, je tiens pour toujours")
    out = coach_trader.gate_decision(decision, _pf(), _quote(), now=NOW,
                                     thesis=_inherited())
    assert out["accepted"] is True, out
    order = out["order"]
    assert order["horizon_days"] == 15
    assert order["invalidation"] == "Une désescalade rapide dans le Golfe"
    assert order["thesis_deadline"] == "2026-10-08T17:00:00"


def test_an_inherited_contract_needs_nothing_declared():
    decision = _buy()
    decision.pop("horizon_days")
    decision.pop("invalidation")
    out = coach_trader.gate_decision(decision, _pf(), _quote(), now=NOW,
                                     thesis=_inherited())
    assert out["accepted"] is True, out


def test_an_inherited_contract_without_invalidation_takes_the_declared_one():
    """Une hypothèse ancienne dont l'invalidation est « (non précisée) » :
    l'échéance reste héritée, l'invalidation est celle que le coach dit."""
    out = coach_trader.gate_decision(
        _buy(), _pf(), _quote(), now=NOW,
        thesis=_inherited(invalidation="(non précisée)"))
    assert out["accepted"] is True, out
    assert out["order"]["invalidation"] == INVALIDATION
    assert out["order"]["thesis_deadline"] == "2026-10-08T17:00:00"


def test_an_inherited_contract_without_any_invalidation_is_refused():
    decision = _buy()
    decision.pop("invalidation")
    out = coach_trader.gate_decision(decision, _pf(), _quote(), now=NOW,
                                     thesis=_inherited(invalidation=""))
    assert out["reason"] == "no_horizon"


def test_an_inherited_contract_without_readable_deadline_is_refused():
    out = coach_trader.gate_decision(_buy(), _pf(), _quote(), now=NOW,
                                     thesis=_inherited(deadline="n'importe quoi"))
    assert out["reason"] == "no_horizon"


def test_a_thesis_expiring_in_less_than_three_days_is_not_playable():
    out = coach_trader.gate_decision(
        _buy(), _pf(), _quote(), now=NOW,
        thesis=_inherited(deadline="2026-09-26T09:00:00"))   # 2 j 23 h
    assert out["accepted"] is False
    assert out["reason"] == "thesis_expiring"


def test_a_thesis_three_days_away_is_still_playable():
    out = coach_trader.gate_decision(
        _buy(), _pf(), _quote(), now=NOW,
        thesis=_inherited(deadline="2026-09-26T10:00:00"))
    assert out["accepted"] is True, out


def test_an_already_expired_thesis_is_not_playable():
    out = coach_trader.gate_decision(
        _buy(), _pf(), _quote(), now=NOW,
        thesis=_inherited(deadline="2026-09-01T10:00:00"))
    assert out["reason"] == "thesis_expiring"


def test_exits_need_no_contract():
    """Une SORTIE n'a pas de thèse à porter : le contrat ne la concerne pas."""
    pf = _pf(positions=[{"symbol": "NESN.SW", "qty": 10, "avg_price": 100.0,
                         "currency": "CHF", "fx_rate": 1.0, "side": "long"}])
    out = coach_trader.gate_decision(
        {"action": "sell", "symbol": "NESN.SW", "exit_reason": "threat"},
        pf, _quote(), now=NOW)
    assert out["accepted"] is True, out


# --- T1 — le contrat voyage : ordre -> position -> trade clos (modèles) ---- #

from backend.bots.paper import models  # noqa: E402


@pytest.mark.parametrize("cls,extra", [
    (models.Order, {"id": "o1"}), (models.Position, {}), (models.Trade, {})])
def test_the_contract_round_trips_on_every_structure(cls, extra):
    data = dict(extra, symbol="NESN.SW", horizon_days=15,
                invalidation=INVALIDATION,
                thesis_deadline="2026-10-08T17:00:00")
    obj = cls.from_dict(data)
    assert obj.horizon_days == 15
    assert obj.invalidation == INVALIDATION
    assert obj.thesis_deadline == "2026-10-08T17:00:00"
    again = cls.from_dict(obj.to_dict())
    assert again.to_dict() == obj.to_dict()


@pytest.mark.parametrize("cls,extra", [
    (models.Order, {"id": "o1"}), (models.Position, {}), (models.Trade, {})])
def test_a_legacy_file_has_no_contract_never_an_invented_one(cls, extra):
    obj = cls.from_dict(dict(extra, symbol="NESN.SW"))
    assert obj.horizon_days is None
    assert obj.invalidation == ""
    assert obj.thesis_deadline is None


def test_an_unreadable_horizon_is_none():
    assert models.Position.from_dict({"symbol": "X", "horizon_days": "dix"}
                                     ).horizon_days is None


# =========================================================================== #
# T2 — un stop dimensionné pour l'horizon de la thèse
# =========================================================================== #

@pytest.mark.parametrize("horizon,expected", [
    (None, 2.0),                      # sans horizon : le plancher d'avant
    (1, 2.0),                         # 0,8 x √1 = 0,8 -> borné à 1 ATR
    (1.5625, 2.0),                    # 0,8 x 1,25 = 1,0 ATR exactement
    (4, 2.0 * 1.6),                   # 0,8 x 2 = 1,6 ATR
    (16, 2.0 * 3.2),                  # 0,8 x 4 = 3,2 ATR
    (25, 2.0 * 4.0),                  # 0,8 x 5 = 4,0 ATR
    (100, 2.0 * 4.0),                 # borné à 4 ATR : jamais une largeur absurde
])
def test_the_noise_floor_grows_like_the_square_root_of_the_horizon(horizon, expected):
    assert coach_trader._noise_floor_pct(0.1, 2.0, horizon) == pytest.approx(expected)


def test_without_atr_the_horizon_changes_nothing():
    """Sans ATR, on ne DEVINE pas une respiration : plancher d'avant."""
    assert coach_trader._noise_floor_pct(0.1, None, 20) == pytest.approx(1.0)


def test_the_horizon_never_makes_the_floor_tighter():
    """Plus exigeant que le plancher des frais, jamais moins."""
    assert coach_trader._noise_floor_pct(3.0, 1.0, 25) == pytest.approx(6.0)


def test_an_entry_stop_is_judged_on_the_REMAINING_horizon():
    """ATR 2 %, thèse héritée à 16 jours de l'échéance : plancher 3,2 ATR =
    6,4 %. Un stop à 5 % (hier encore largement hors du bruit) est refusé."""
    tech = {"atr14_pct": 2.0}
    thesis = _inherited(deadline="2026-10-09T10:00:00", horizon=20)   # J-16
    out = coach_trader.gate_decision(
        _buy(qty=10, stop=95.0, target=140.0), _pf(), _quote(), now=NOW,
        technical=tech, thesis=thesis)
    assert out["reason"] == "stop_in_noise"
    ok = coach_trader.gate_decision(
        _buy(qty=10, stop=93.5, target=140.0), _pf(), _quote(), now=NOW,
        technical=tech, thesis=thesis)
    assert ok["accepted"] is True, ok


def test_a_declared_horizon_sizes_the_stop_too():
    tech = {"atr14_pct": 2.0}
    out = coach_trader.gate_decision(
        _buy(qty=10, stop=96.0, target=140.0, horizon_days=9), _pf(), _quote(),
        now=NOW, technical=tech)            # 0,8 x 3 = 2,4 ATR = 4,8 %
    assert out["reason"] == "stop_in_noise"


def test_the_risk_rule_still_caps_the_loss_at_the_stop():
    """Le stop s'élargit, le RISQUE ne change pas : 2 % de l'équité. Un stop
    à 6,5 % n'autorise que 30 titres à 100 (195 CHF) ; 40 sont refusés."""
    tech = {"atr14_pct": 2.0}
    thesis = _inherited(deadline="2026-10-09T10:00:00", horizon=20)
    out = coach_trader.gate_decision(
        _buy(qty=40, stop=93.5, target=140.0), _pf(), _quote(), now=NOW,
        technical=tech, thesis=thesis)
    assert out["reason"] == "risk_high"


def test_tightening_a_thesis_stop_back_into_its_noise_is_refused():
    """Sinon T2 serait contourné en deux passes : entrer à 3 ATR, puis
    resserrer à 1 ATR à la passe suivante."""
    line = {"symbol": "NESN.SW", "qty": 20, "avg_price": 100.0,
            "currency": "CHF", "fx_rate": 1.0, "side": "long",
            "stop_loss": 90.0, "horizon_days": 20, "invalidation": INVALIDATION,
            "thesis_deadline": "2026-10-09T10:00:00"}
    tech = {"atr14_pct": 2.0}
    out = coach_trader.gate_decision(
        {"action": "adjust_stop", "symbol": "NESN.SW", "stop": 97.0},
        _pf(positions=[line]), _quote(), now=NOW, technical=tech)
    assert out["reason"] == "stop_in_noise"
    legacy = dict(line, thesis_deadline=None, horizon_days=None)
    out = coach_trader.gate_decision(
        {"action": "adjust_stop", "symbol": "NESN.SW", "stop": 97.0},
        _pf(positions=[legacy]), _quote(), now=NOW, technical=tech)
    assert out["accepted"] is True, out        # ligne d'avant : inchangé


def test_the_stop_in_noise_detail_TEACHES_the_stop_for_this_horizon():
    tech = {"atr14_pct": 2.0}
    thesis = _inherited(deadline="2026-10-09T10:00:00", horizon=20)
    decision = _buy(qty=10, stop=95.0, target=140.0)
    text = coach_trader.reject_detail("stop_in_noise", decision, _pf(),
                                      _quote(), now=NOW, technical=tech,
                                      thesis=thesis)
    assert "6,4" in text                    # le plancher exigé, en %
    assert "93,60" in text                  # le stop qui passerait
    assert "16" in text                     # les jours restants
    assert "√" in text or "racine" in text  # le pourquoi
    assert "31" in text                     # la taille qui garde 2 % de risque


# =========================================================================== #
# T4 — chaque sortie dit POURQUOI
# =========================================================================== #

def _line(**over):
    base = {"symbol": "NESN.SW", "qty": 10, "avg_price": 100.0,
            "currency": "CHF", "fx_rate": 1.0, "side": "long"}
    base.update(over)
    return base


def test_the_exit_reasons_are_a_closed_list():
    assert coach_trader.EXIT_REASONS == ("invalidated", "threat", "target",
                                         "deadline", "risk", "rebalance")
    assert "no_exit_reason" in coach_trader.REJECT_CODES


@pytest.mark.parametrize("action", ["sell", "reduce"])
@pytest.mark.parametrize("reason", [None, "", "bruit", "je le sens mal", 42])
def test_an_exit_without_a_listed_reason_is_refused(action, reason):
    decision = {"action": action, "symbol": "NESN.SW", "qty": 5}
    if reason is not None:
        decision["exit_reason"] = reason
    out = coach_trader.gate_decision(decision, _pf(positions=[_line()]), _quote())
    assert out["accepted"] is False
    assert out["reason"] == "no_exit_reason"


def test_a_cover_without_reason_is_refused_too():
    out = coach_trader.gate_decision(
        {"action": "cover", "symbol": "NESN.SW"},
        _pf(positions=[_line(side="short")]), _quote())
    assert out["reason"] == "no_exit_reason"


@pytest.mark.parametrize("reason", ["invalidated", "threat", "target",
                                    "deadline", "risk", "rebalance"])
def test_every_listed_reason_passes_and_travels(reason):
    out = coach_trader.gate_decision(
        {"action": "sell", "symbol": "NESN.SW", "exit_reason": reason},
        _pf(positions=[_line()]), _quote())
    assert out["accepted"] is True
    assert out["order"]["exit_reason"] == reason


@pytest.mark.parametrize("raw", ["THREAT", " threat ", "Menace", "minaccia"])
def test_a_threat_passes_whatever_its_spelling(raw):
    """« Menace = tire seul » : une sortie défensive ne doit JAMAIS buter sur
    une faute de casse ou de langue."""
    out = coach_trader.gate_decision(
        {"action": "sell", "symbol": "NESN.SW", "exit_reason": raw},
        _pf(positions=[_line()]), _quote())
    assert out["accepted"] is True
    assert out["order"]["exit_reason"] == "threat"


def test_a_threat_exit_is_never_blocked_by_the_thesis_or_the_noise():
    """C'est un contrôle de FORME : aucune règle de thèse, d'horizon ni de
    bruit ne touche une sortie. Une ligne de thèse loin de son échéance, un
    cours dans le bruit : ``threat`` passe."""
    line = _line(horizon_days=20, invalidation=INVALIDATION,
                 thesis_deadline="2026-10-20T10:00:00", stop_loss=90.0)
    out = coach_trader.gate_decision(
        {"action": "sell", "symbol": "NESN.SW", "exit_reason": "threat"},
        _pf(positions=[line]), _quote(99.9), now=NOW,
        technical={"atr14_pct": 3.0})
    assert out["accepted"] is True


def test_the_no_exit_reason_detail_names_the_list_and_the_threat_rule():
    text = coach_trader.reject_detail(
        "no_exit_reason", {"action": "sell", "symbol": "NESN.SW",
                           "exit_reason": "bruit"}, _pf(), _quote())
    for reason in coach_trader.EXIT_REASONS:
        assert reason in text
    assert "bruit" in text
    assert "threat" in text and "toujours" in text


def test_the_ledger_carries_the_exit_reason_only_when_there_is_one():
    row = coach_trader.ledger_entry("t", "daily", "sell", "NESN.SW", True,
                                    exit_reason="threat")
    assert row["exit_reason"] == "threat"
    assert "exit_reason" not in coach_trader.ledger_entry(
        "t", "daily", "buy", "NESN.SW", True)


# =========================================================================== #
# T5 — le mandat : tenir la thèse, pas réagir au bruit
# =========================================================================== #

from backend.bots.paper import llm  # noqa: E402

_LINE = {"symbol": "FRO", "qty": 46, "side": "long", "avg_price": 51.48,
         "horizon_days": 20, "invalidation": "Une désescalade rapide dans le Golfe",
         "thesis_deadline": "2026-10-09T10:00:00"}


def test_thesis_state_counts_the_days_of_the_thesis():
    state = coach_trader.thesis_state(_LINE, NOW)          # J-16 sur 20
    assert state == {"day": 5, "horizon": 20,
                     "deadline": "2026-10-09T10:00:00", "days_left": 16.0,
                     "invalidation": "Une désescalade rapide dans le Golfe"}


def test_thesis_state_is_none_for_a_legacy_line():
    assert coach_trader.thesis_state({"symbol": "X", "qty": 1}, NOW) is None


def test_thesis_state_day_is_bounded():
    late = coach_trader.thesis_state(_LINE, "2026-10-12T10:00:00")
    assert late["day"] == 20 and late["days_left"] < 0


def _book(**over):
    row = dict(_LINE, these=coach_trader.thesis_state(_LINE, NOW))
    book = {"cash_chf": 5000.0, "equity_chf": 9000.0, "positions": [row],
            "open_orders": [], "candidates": []}
    book.update(over)
    return book


def test_each_thesis_position_is_shown_with_its_state_and_invalidation():
    block = llm.coach_actions_block(_book())
    assert "FRO" in block and "jour 5/20" in block and "09/10" in block
    assert "Une désescalade rapide dans le Golfe" in block
    low = block.lower()
    assert "intacte" in low and "invalidée" in low


def test_no_thesis_section_without_thesis_positions():
    block = llm.coach_actions_block(_book(positions=[]))
    assert "TES THÈSES EN COURS" not in block


def test_the_mandate_says_to_hold_the_thesis_not_react_to_noise():
    low = llm.coach_actions_block(_book()).lower()
    assert "bruit n'est pas une raison" in low
    assert "à l'intérieur de ton stop" in low
    for word in ("invalidation", "menace", "échéance", "objectif", "stop"):
        assert word in low


def test_the_mandate_quotes_his_own_record():
    block = llm.coach_actions_block(_book())
    assert "7 sur 7" in block
    assert "VRT" in block and "PINS" in block
    assert "3 jours" in block


def test_the_mandate_explains_the_contract_and_the_exit_reasons():
    block = llm.coach_actions_block(_book())
    assert "horizon_days" in block and "invalidation" in block
    assert "exit_reason" in block
    for reason in coach_trader.EXIT_REASONS:
        assert reason in block
    assert "threat" in block


def test_the_json_example_carries_the_contract_and_an_exit_reason():
    block = llm.coach_actions_block(_book())
    example = block.rsplit("```%s" % coach_trader.ACTIONS_MARKER, 1)[1]
    assert '"horizon_days"' in example and '"invalidation"' in example
    assert '"exit_reason"' in example


def test_the_guardian_prompt_demands_an_exit_reason_threat_first():
    prompt = llm.build_coach_guardian_prompt(
        {"symbol": "FRO", "trigger": "stop", "stop_loss": 46.5,
         "these": coach_trader.thesis_state(_LINE, NOW)})
    assert "exit_reason" in prompt
    assert "threat" in prompt
    assert "Une désescalade rapide dans le Golfe" in prompt
