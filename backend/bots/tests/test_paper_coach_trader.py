"""Tests du compte de paper trading DU COACH (LOT 4, tâche 1) — 100 % hors ligne.

Trois familles :
  - PUR : ``gate_decision`` (le garde-fou, un test par code de refus),
    ``parse_actions`` (le bloc structuré de fin de digest), ``pass_due``
    (l'horloge locale), le registre et la courbe de patrimoine ;
  - I/O : les deux nouvelles paires de ``store`` (registre + patrimoine) ;
  - ANTI-FANTÔMES : les nouveaux fichiers ne doivent JAMAIS être recensés
    comme des comptes par les trois modules qui balayent ``data/paper_trading``
    (le bug qui avait fabriqué « whales_watch » et consorts dans la communauté).

Isolation : ``store.DATA_DIR`` est monkeypatché vers ``tmp_path`` pour CHAQUE
test (même fixture autouse que ``test_paper_weekly.py``).
"""
import json
import os
import stat
from datetime import datetime, timezone

import pytest

from backend.bots.paper import coach_trader, models, quotes, risk, store

# Vendredi 28/08/2026 17:00 Rome (CEST) — jour de semaine, après l'heure.
FRIDAY_ON_TIME = datetime(2026, 8, 28, 15, 0, 0, tzinfo=timezone.utc)
FRIDAY_TOO_EARLY = datetime(2026, 8, 28, 14, 59, 0, tzinfo=timezone.utc)   # 16:59 Rome
# LOT 5 — avant le PREMIER creneau (15:40 Rome) : 07:00 UTC = 09:00 Rome.
FRIDAY_BEFORE_ANY_SLOT = datetime(2026, 8, 28, 7, 0, 0, tzinfo=timezone.utc)
SATURDAY = datetime(2026, 8, 29, 7, 0, 0, tzinfo=timezone.utc)  # 09:00 Rome — avant le 1er créneau du week-end (11:00, LOT 8)
SUNDAY = datetime(2026, 8, 30, 15, 0, 0, tzinfo=timezone.utc)
MONDAY = datetime(2026, 8, 31, 15, 0, 0, tzinfo=timezone.utc)
# 22:30 UTC un vendredi = SAMEDI 00:30 à Rome — le piège de l'heure locale.
FRIDAY_LATE_IS_SATURDAY_LOCAL = datetime(2026, 8, 28, 22, 30, 0, tzinfo=timezone.utc)
# Vendredi 09/01/2026 17:00 Rome (CET, hiver) : 16:00 UTC — prouve que le seuil
# horaire est LOCAL (en UTC il serait sous les 17 h).
WINTER_FRIDAY = datetime(2026, 1, 9, 16, 0, 0, tzinfo=timezone.utc)

THESIS = "cassure du range mensuel sur volume"     # > MIN_THESIS_LEN


@pytest.fixture(autouse=True)
def _isolate_data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path / "paper_trading")
    yield


# --------------------------------------------------------------------------- #
# Fabriques
# --------------------------------------------------------------------------- #

def _pf(cash=10000.0, positions=None, capital=10000.0):
    return {
        "cash_chf": cash,
        "positions": list(positions or []),
        "open_orders": [],
        "trades": [],
        "initial_capital": capital,
    }


def _pos(symbol, qty=1, avg_price=1.0, fx_rate=1.0, side="long"):
    return {"symbol": symbol, "qty": qty, "avg_price": avg_price,
            "currency": "CHF", "fx_rate": fx_rate, "side": side}


def _quote(price=100.0, currency="CHF", fx_rate=1.0):
    return {"price": price, "currency": currency, "fx_rate": fx_rate}


def _buy(**over):
    base = {"action": "buy", "symbol": "NESN.SW", "qty": 20, "stop": 95.0,
            "target": 130.0, "thesis": THESIS, "setup": "breakout"}
    base.update(over)
    return base


# --------------------------------------------------------------------------- #
# Constantes — le contrat que les tâches 2 à 4 consomment
# --------------------------------------------------------------------------- #

def test_constants_are_the_announced_contract():
    assert coach_trader.COACH_USERNAME == "coach"
    assert coach_trader.COACH_CAPITAL == 10000.0
    assert coach_trader.ACTIONS_MARKER == "COACH_ACTIONS"
    assert coach_trader.ACTION_KINDS == ("buy", "short", "sell", "reduce",
                                         "cover", "adjust_stop")
    assert coach_trader.LOCAL_TZ == "Europe/Rome"
    assert coach_trader.STATE_NAME == "coach_trader.state.json"
    assert coach_trader.MAX_LEDGER == 200
    assert coach_trader.MAX_EQUITY_POINTS == 730


def test_min_thesis_len_mirrors_the_preorder_guard():
    """Un seul seuil de thèse dans le simulateur — pas une seconde divergence."""
    assert coach_trader.MIN_THESIS_LEN == risk.PREORDER_MIN_THESIS_LEN


def test_every_reject_code_is_declared():
    expected = {
        "unknown_action", "no_symbol", "bad_qty", "no_quote",
        "no_thesis", "no_stop", "risk_high", "too_small", "oversize",
        "too_many_positions", "too_many_crypto", "cash_floor",
        "no_position", "qty_over_position",
        # LOT 5 — le short, le stop qui ne recule pas, le marche ferme.
        "wrong_side", "stop_widen", "market_closed",
        # LOT 8 — hors du périmètre du gardien.
        "out_of_scope",
    }
    assert set(coach_trader.REJECT_CODES) == expected
    assert len(coach_trader.REJECT_CODES) == 18


def test_coach_username_survives_the_store_allowlist():
    """Le compte du coach doit être un compte comme un autre (nom validable)."""
    assert store.portfolio_path(coach_trader.COACH_USERNAME).name == "coach.json"


# --------------------------------------------------------------------------- #
# gate_decision — les 17 refus, un par un
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("action", [None, "", "hold", 42, "BUY!", "sortir"])
def test_gate_rejects_unknown_action(action):
    out = coach_trader.gate_decision({"action": action, "symbol": "NESN.SW", "qty": 1},
                                     _pf(), _quote())
    assert out["accepted"] is False
    assert out["reason"] == "unknown_action"
    assert out["order"] is None


def test_short_and_cover_are_no_longer_unknown_actions():
    """LOT 5 — elles etaient hors perimetre, elles sont desormais du mandat.
    Elles echouent ici sur leurs PROPRES regles (une entree sans these, une
    sortie sans ligne), jamais plus sur ``unknown_action``.

    Le detail du short vit dans ``test_paper_coach_max.py`` ; ce test-ci ne
    garde que la bascule, la ou l'ancien contrat etait epingle."""
    assert coach_trader.gate_decision(
        {"action": "short", "symbol": "NESN.SW", "qty": 1}, _pf(),
        _quote())["reason"] == "no_thesis"
    assert coach_trader.gate_decision(
        {"action": "cover", "symbol": "NESN.SW", "qty": 1}, _pf(),
        _quote())["reason"] == "no_position"


@pytest.mark.parametrize("symbol", [None, "", "   ", 0])
def test_gate_rejects_missing_symbol(symbol):
    out = coach_trader.gate_decision(_buy(symbol=symbol), _pf(), _quote())
    assert out["reason"] == "no_symbol"


@pytest.mark.parametrize("qty", [None, 0, -3, "abc", "", 0.4, True])
def test_gate_rejects_bad_qty_on_buy(qty):
    out = coach_trader.gate_decision(_buy(qty=qty), _pf(), _quote())
    assert out["reason"] == "bad_qty"


def test_gate_rejects_bad_qty_on_reduce_when_missing():
    """``reduce`` = allègement PARTIEL : sans quantité, il n'y a pas d'ordre."""
    pf = _pf(positions=[_pos("NESN.SW", qty=10, avg_price=100.0)])
    out = coach_trader.gate_decision({"action": "reduce", "symbol": "NESN.SW"},
                                     pf, _quote())
    assert out["reason"] == "bad_qty"


def test_gate_rejects_garbage_qty_on_sell_too():
    """« tout solder » c'est une qty ABSENTE, pas une qty illisible."""
    pf = _pf(positions=[_pos("NESN.SW", qty=10, avg_price=100.0)])
    out = coach_trader.gate_decision({"action": "sell", "symbol": "NESN.SW",
                                      "qty": "beaucoup"}, pf, _quote())
    assert out["reason"] == "bad_qty"


@pytest.mark.parametrize("quote", [
    None, {}, {"price": None, "fx_rate": 1.0}, {"price": 0, "fx_rate": 1.0},
    {"price": -10, "fx_rate": 1.0}, {"price": "abc", "fx_rate": 1.0},
    {"price": 100.0}, {"price": 100.0, "fx_rate": 0}, {"price": 100.0, "fx_rate": None},
    {"price": 100.0, "fx_rate": "n/d"},
])
def test_gate_rejects_missing_or_broken_quote(quote):
    out = coach_trader.gate_decision(_buy(), _pf(), quote)
    assert out["reason"] == "no_quote"


@pytest.mark.parametrize("thesis", [None, "", "trop court", "   court   "])
def test_gate_rejects_a_missing_or_too_short_thesis(thesis):
    out = coach_trader.gate_decision(_buy(thesis=thesis), _pf(), _quote())
    assert out["reason"] == "no_thesis"


@pytest.mark.parametrize("stop", [None, "", "abc"])
def test_gate_rejects_a_missing_stop(stop):
    out = coach_trader.gate_decision(_buy(stop=stop), _pf(), _quote())
    assert out["reason"] == "no_stop"


@pytest.mark.parametrize("stop", [100.0, 105.0])
def test_gate_rejects_a_stop_at_or_above_the_entry(stop):
    """Un « stop » au-dessus du prix d'entrée d'un long ne protège rien."""
    out = coach_trader.gate_decision(_buy(stop=stop), _pf(), _quote(price=100.0))
    assert out["reason"] == "no_stop"


def test_gate_rejects_risk_above_two_percent():
    # 20 actions, entrée 100, stop 80 -> 400 CHF risqués pour 10 000 d'équité.
    out = coach_trader.gate_decision(_buy(qty=20, stop=80.0), _pf(), _quote(100.0))
    assert out["reason"] == "risk_high"


def test_gate_rejects_a_position_in_pennies():
    """LA doctrine : « pas des actions en centimes » — 1 action à 50 CHF sur
    10 000 d'équité (0,5 %) n'est pas une position, c'est un ticket de loterie."""
    out = coach_trader.gate_decision(_buy(qty=1, stop=45.0), _pf(), _quote(price=50.0))
    assert out["reason"] == "too_small"


def test_gate_rejects_an_oversized_position():
    # 40 x 100 = 4000 CHF = 40 % de l'équité (plafond 30 %).
    out = coach_trader.gate_decision(_buy(qty=40, stop=99.0), _pf(), _quote(100.0))
    assert out["reason"] == "oversize"


def test_oversize_counts_the_line_already_held():
    """Projection, pas incrément : renforcer une ligne compte le TOTAL."""
    pf = _pf(cash=10000.0, positions=[_pos("NESN.SW", qty=25, avg_price=100.0)])
    # équité = 10 000 + 2500 = 12 500 -> plafond 3750 ; (25 + 20) x 100 = 4500.
    out = coach_trader.gate_decision(_buy(qty=20, stop=99.0), pf, _quote(100.0))
    assert out["reason"] == "oversize"


def test_gate_rejects_a_seventh_front():
    held = [_pos("SYM%d" % i) for i in range(6)]
    out = coach_trader.gate_decision(_buy(symbol="NESN.SW", qty=20, stop=99.0),
                                     _pf(positions=held), _quote(100.0))
    assert out["reason"] == "too_many_positions"


def test_reinforcing_an_existing_line_is_not_a_new_front():
    held = [_pos("SYM%d" % i) for i in range(5)] + [_pos("NESN.SW", qty=1, avg_price=1.0)]
    out = coach_trader.gate_decision(_buy(symbol="NESN.SW", qty=20, stop=99.0),
                                     _pf(positions=held), _quote(100.0))
    assert out["accepted"] is True


def test_gate_rejects_a_third_crypto():
    held = [_pos("BTC-USD"), _pos("ETH-USD")]
    out = coach_trader.gate_decision(_buy(symbol="SOL-USD", qty=20, stop=99.0),
                                     _pf(positions=held), _quote(100.0))
    assert out["reason"] == "too_many_crypto"


def test_two_cryptos_still_pass():
    held = [_pos("BTC-USD")]
    out = coach_trader.gate_decision(_buy(symbol="ETH-USD", qty=20, stop=99.0),
                                     _pf(positions=held), _quote(100.0))
    assert out["accepted"] is True


def test_gate_rejects_when_the_cash_floor_would_break():
    # équité 10 000 (1000 de cash + 9000 investis) ; 11 x 100 = 1100 > le cash.
    pf = _pf(cash=1000.0, positions=[_pos("ABBN.SW", qty=90, avg_price=100.0)])
    out = coach_trader.gate_decision(_buy(symbol="NESN.SW", qty=11, stop=99.0),
                                     pf, _quote(100.0))
    assert out["reason"] == "cash_floor"


def test_gate_rejects_a_sell_without_position():
    out = coach_trader.gate_decision({"action": "sell", "symbol": "NESN.SW", "qty": 5},
                                     _pf(), _quote())
    assert out["reason"] == "no_position"


def test_gate_rejects_a_sell_larger_than_the_position():
    pf = _pf(positions=[_pos("NESN.SW", qty=5, avg_price=100.0)])
    out = coach_trader.gate_decision({"action": "sell", "symbol": "NESN.SW", "qty": 10},
                                     pf, _quote(100.0))
    assert out["reason"] == "qty_over_position"


def test_a_short_line_is_not_a_sellable_position():
    """Aucun short dans ce lot : une ligne ``short`` ne se solde pas par ici."""
    pf = _pf(positions=[_pos("NESN.SW", qty=5, avg_price=100.0, side="short")])
    out = coach_trader.gate_decision({"action": "sell", "symbol": "NESN.SW", "qty": 1},
                                     pf, _quote(100.0))
    assert out["reason"] == "no_position"


# --------------------------------------------------------------------------- #
# gate_decision — les acceptations
# --------------------------------------------------------------------------- #

def test_gate_accepts_a_nominal_buy():
    out = coach_trader.gate_decision(_buy(), _pf(), _quote(100.0))
    assert out["accepted"] is True
    assert out["reason"] is None
    assert out["order"] == {
        "symbol": "NESN.SW", "side": "buy", "kind": "market", "qty": 20,
        "thesis": THESIS, "stop_loss": 95.0, "target": 130.0,
        "setup": "breakout", "emotion": "calme",
    }


def test_the_accepted_symbol_is_canonical_uppercase():
    out = coach_trader.gate_decision(_buy(symbol="  nesn.sw  "), _pf(), _quote(100.0))
    assert out["order"]["symbol"] == "NESN.SW"


def test_an_unknown_setup_falls_back_to_coach_idea():
    out = coach_trader.gate_decision(_buy(setup="mon-super-plan"), _pf(), _quote(100.0))
    assert out["order"]["setup"] == "coach_idea"
    assert out["order"]["setup"] in models.SETUPS


def test_a_missing_setup_falls_back_to_coach_idea():
    decision = _buy()
    decision.pop("setup")
    out = coach_trader.gate_decision(decision, _pf(), _quote(100.0))
    assert out["order"]["setup"] == "coach_idea"


def test_gate_accepts_a_sell_that_liquidates_everything():
    pf = _pf(positions=[_pos("NESN.SW", qty=7, avg_price=100.0)])
    out = coach_trader.gate_decision({"action": "sell", "symbol": "NESN.SW"},
                                     pf, _quote(100.0))
    assert out["accepted"] is True
    assert out["order"]["side"] == "sell"
    assert out["order"]["qty"] == 7


@pytest.mark.parametrize("qty", [None, 0, ""])
def test_a_blank_qty_on_sell_means_liquidate(qty):
    pf = _pf(positions=[_pos("NESN.SW", qty=7, avg_price=100.0)])
    out = coach_trader.gate_decision({"action": "sell", "symbol": "NESN.SW", "qty": qty},
                                     pf, _quote(100.0))
    assert out["accepted"] is True
    assert out["order"]["qty"] == 7


def test_gate_accepts_a_partial_reduce():
    pf = _pf(positions=[_pos("NESN.SW", qty=7, avg_price=100.0)])
    out = coach_trader.gate_decision({"action": "reduce", "symbol": "NESN.SW", "qty": 3},
                                     pf, _quote(100.0))
    assert out["accepted"] is True
    assert out["order"]["side"] == "sell"     # ``reduce`` s'exécute comme une vente
    assert out["order"]["qty"] == 3


def test_an_exit_needs_neither_thesis_nor_stop():
    """Une sortie réduit TOUJOURS l'exposition — même restriction que
    ``risk.preorder_warnings`` (qui ne s'applique qu'aux ouvertures)."""
    pf = _pf(positions=[_pos("NESN.SW", qty=7, avg_price=100.0)])
    out = coach_trader.gate_decision({"action": "sell", "symbol": "NESN.SW", "qty": 2},
                                     pf, _quote(100.0))
    assert out["accepted"] is True
    assert out["order"]["thesis"] == ""
    assert out["order"]["stop_loss"] is None


def test_an_exit_ignores_the_position_count_and_the_cash_floor():
    """Sortir d'une 7e ligne quand la trésorerie est à sec doit passer."""
    held = [_pos("SYM%d" % i, qty=1, avg_price=100.0) for i in range(6)]
    held.append(_pos("NESN.SW", qty=5, avg_price=100.0))
    out = coach_trader.gate_decision({"action": "sell", "symbol": "NESN.SW"},
                                     _pf(cash=0.0, positions=held), _quote(100.0))
    assert out["accepted"] is True


def test_the_gate_converts_with_the_rate_given_by_the_caller():
    """La conversion CHF est la responsabilité de l'APPELANT (même doctrine que
    ``risk.preorder_warnings``) : 20 x 100 USD x 0,90 = 1800 CHF, pas 2000."""
    out = coach_trader.gate_decision(_buy(qty=20, stop=99.0), _pf(),
                                     _quote(100.0, currency="USD", fx_rate=0.90))
    assert out["accepted"] is True
    # Le MÊME ordre à un taux qui le fait passer sous les 10 % est refusé.
    small = coach_trader.gate_decision(_buy(qty=20, stop=99.0), _pf(),
                                       _quote(100.0, currency="USD", fx_rate=0.04))
    assert small["reason"] == "too_small"


def test_the_gate_never_touches_the_network(monkeypatch):
    """``quotes.kind_from_symbol`` est PUR : la reconnaissance du genre crypto
    ne doit ouvrir aucune connexion."""
    def _boom(*args, **kwargs):      # pragma: no cover - ne doit jamais tourner
        raise AssertionError("appel réseau interdit dans un module pur")

    monkeypatch.setattr(quotes, "_fetch_json", _boom, raising=False)
    assert quotes.kind_from_symbol("BTC-USD") == "crypto"
    out = coach_trader.gate_decision(_buy(symbol="BTC-USD", qty=20, stop=99.0),
                                     _pf(), _quote(100.0))
    assert out["accepted"] is True


def test_the_gate_survives_a_battered_portfolio():
    """Un portefeuille abîmé ne doit jamais faire tomber le garde-fou : les
    lignes illisibles sont ignorées, pas devinées."""
    pf = {"cash_chf": "10000", "positions": [
        {"symbol": "NESN.SW", "qty": None, "avg_price": "abc"},
        {"symbol": None, "qty": 3},
        "junk", None, 42,
    ]}
    out = coach_trader.gate_decision(_buy(qty=20, stop=99.0), pf, _quote(100.0))
    assert out["accepted"] is True


@pytest.mark.parametrize("junk", [None, "pas un dict", 42, []])
def test_the_gate_survives_junk_arguments(junk):
    out = coach_trader.gate_decision(junk, junk, junk)
    assert out["accepted"] is False
    assert out["reason"] == "unknown_action"


def test_the_gate_does_not_mutate_its_inputs():
    decision, portfolio, quote = _buy(), _pf(), _quote(100.0)
    before = (json.dumps(decision, sort_keys=True), json.dumps(portfolio, sort_keys=True),
              json.dumps(quote, sort_keys=True))
    coach_trader.gate_decision(decision, portfolio, quote)
    assert (json.dumps(decision, sort_keys=True), json.dumps(portfolio, sort_keys=True),
            json.dumps(quote, sort_keys=True)) == before


# --------------------------------------------------------------------------- #
# gate_decision — l'ORDRE des contrôles (le premier échec gagne)
# --------------------------------------------------------------------------- #

def test_unknown_action_wins_over_everything_else():
    out = coach_trader.gate_decision({"action": "danser", "symbol": "", "qty": 0},
                                     _pf(), None)
    assert out["reason"] == "unknown_action"


def test_no_symbol_wins_over_bad_qty():
    out = coach_trader.gate_decision({"action": "buy", "symbol": "", "qty": "abc"},
                                     _pf(), _quote(100.0))
    assert out["reason"] == "no_symbol"


def test_bad_qty_wins_over_no_quote():
    out = coach_trader.gate_decision({"action": "buy", "symbol": "NESN.SW", "qty": 0},
                                     _pf(), None)
    assert out["reason"] == "bad_qty"


def test_no_quote_wins_over_no_thesis():
    out = coach_trader.gate_decision(_buy(thesis=""), _pf(), {"price": 0})
    assert out["reason"] == "no_quote"


def test_no_thesis_wins_over_no_stop():
    out = coach_trader.gate_decision(_buy(thesis="court", stop=None), _pf(), _quote(100.0))
    assert out["reason"] == "no_thesis"


def test_no_stop_wins_over_oversize():
    out = coach_trader.gate_decision(_buy(qty=400, stop=None), _pf(), _quote(100.0))
    assert out["reason"] == "no_stop"


def test_risk_high_wins_over_too_small():
    """1 action à 100 avec un stop à 1 : minuscule ET trop risquée -> risque."""
    out = coach_trader.gate_decision(_buy(qty=1, stop=1.0), _pf(cash=1000.0),
                                     _quote(100.0))
    assert out["reason"] == "risk_high"


def test_too_small_wins_over_too_many_positions():
    held = [_pos("SYM%d" % i) for i in range(6)]
    out = coach_trader.gate_decision(_buy(qty=1, stop=45.0), _pf(positions=held),
                                     _quote(price=50.0))
    assert out["reason"] == "too_small"


def test_an_exit_never_falls_into_the_entry_checks():
    """Une sortie sans thèse ni stop sur une position absente doit dire
    ``no_position`` (le vrai problème), pas ``no_thesis``."""
    out = coach_trader.gate_decision({"action": "reduce", "symbol": "NESN.SW", "qty": 2},
                                     _pf(), _quote(100.0))
    assert out["reason"] == "no_position"


def test_every_reason_returned_is_a_declared_code():
    """``reason`` est TOUJOURS un code (la traduction vit dans lang.js)."""
    cases = [
        ({"action": "x"}, _pf(), _quote()),
        (_buy(symbol=""), _pf(), _quote()),
        (_buy(qty=0), _pf(), _quote()),
        (_buy(), _pf(), None),
        (_buy(thesis=""), _pf(), _quote()),
        (_buy(stop=None), _pf(), _quote()),
        (_buy(stop=10.0, qty=20), _pf(), _quote()),
        (_buy(qty=1, stop=45.0), _pf(), _quote(50.0)),
        (_buy(qty=40, stop=99.0), _pf(), _quote(100.0)),
        ({"action": "sell", "symbol": "NESN.SW", "qty": 1}, _pf(), _quote(100.0)),
    ]
    for decision, portfolio, quote in cases:
        out = coach_trader.gate_decision(decision, portfolio, quote)
        assert out["accepted"] is False
        assert out["reason"] in coach_trader.REJECT_CODES
        assert out["order"] is None


# --------------------------------------------------------------------------- #
# parse_actions
# --------------------------------------------------------------------------- #

def _digest(block):
    return "Bonjour Massii.\n\nVoici le point du jour.\n\n" + block


BLOCK_OK = ('```COACH_ACTIONS\n'
            '{"actions": [{"action": "buy", "symbol": "NESN.SW", "qty": 10}]}\n'
            '```')


def test_parse_actions_extracts_the_block():
    out = coach_trader.parse_actions(_digest(BLOCK_OK))
    assert out["error"] is None
    assert out["actions"] == [{"action": "buy", "symbol": "NESN.SW", "qty": 10}]


def test_parse_actions_removes_the_block_from_the_readable_text():
    out = coach_trader.parse_actions(_digest(BLOCK_OK))
    assert coach_trader.ACTIONS_MARKER not in out["text"]
    assert "```" not in out["text"]
    assert out["text"].startswith("Bonjour Massii.")
    assert out["text"].endswith("point du jour.")


def test_parse_actions_without_block_invents_nothing():
    text = "Bonjour Massii.\n\nRien à faire aujourd'hui."
    out = coach_trader.parse_actions(text)
    assert out["error"] == "no_block"
    assert out["actions"] == []
    assert out["text"] == text


def test_parse_actions_on_broken_json_still_cleans_the_text():
    broken = _digest('```COACH_ACTIONS\n{"actions": [ceci n\'est pas du JSON}\n```')
    out = coach_trader.parse_actions(broken)
    assert out["error"] == "parse_failed"
    assert out["actions"] == []
    assert coach_trader.ACTIONS_MARKER not in out["text"]
    assert "n'est pas du JSON" not in out["text"]


def test_parse_actions_on_an_unexpected_shape_is_parse_failed():
    out = coach_trader.parse_actions(_digest('```COACH_ACTIONS\n{"actions": "buy"}\n```'))
    assert out["error"] == "parse_failed"
    assert out["actions"] == []


def test_parse_actions_accepts_a_bare_list():
    out = coach_trader.parse_actions(
        _digest('```COACH_ACTIONS\n[{"action": "sell", "symbol": "NESN.SW"}]\n```'))
    assert out["error"] is None
    assert out["actions"] == [{"action": "sell", "symbol": "NESN.SW"}]


def test_parse_actions_accepts_an_empty_action_list():
    out = coach_trader.parse_actions(_digest('```COACH_ACTIONS\n{"actions": []}\n```'))
    assert out["error"] is None
    assert out["actions"] == []


def test_parse_actions_keeps_incomplete_entries_for_the_gate_to_refuse():
    """Une entrée bancale est CONSERVÉE : c'est le garde-fou qui la refusera
    avec son code, et ce refus doit se voir."""
    out = coach_trader.parse_actions(
        _digest('```COACH_ACTIONS\n{"actions": [{"action": "buy"}, {"symbol": "X"}]}\n```'))
    assert out["error"] is None
    assert out["actions"] == [{"action": "buy"}, {"symbol": "X"}]


def test_parse_actions_drops_non_dict_entries():
    out = coach_trader.parse_actions(
        _digest('```COACH_ACTIONS\n{"actions": [{"action": "buy"}, "achete", 3, null]}\n```'))
    assert out["actions"] == [{"action": "buy"}]


def test_parse_actions_tolerates_spaces_around_the_marker():
    out = coach_trader.parse_actions(
        _digest('```  COACH_ACTIONS  \n\n{"actions": [{"action": "buy"}]}\n\n```'))
    assert out["error"] is None
    assert out["actions"] == [{"action": "buy"}]


def test_parse_actions_finds_a_block_that_is_not_at_the_very_end():
    text = "Avant.\n\n" + BLOCK_OK + "\n\nAprès le bloc."
    out = coach_trader.parse_actions(text)
    assert out["error"] is None
    assert len(out["actions"]) == 1
    assert "Avant." in out["text"] and "Après le bloc." in out["text"]
    assert coach_trader.ACTIONS_MARKER not in out["text"]


def test_parse_actions_takes_the_first_block_and_removes_them_all():
    second = ('```COACH_ACTIONS\n'
              '{"actions": [{"action": "sell", "symbol": "ZZZ"}]}\n```')
    out = coach_trader.parse_actions(_digest(BLOCK_OK) + "\n\nEt puis :\n\n" + second)
    assert [a["symbol"] for a in out["actions"]] == ["NESN.SW"]
    assert coach_trader.ACTIONS_MARKER not in out["text"]
    assert "ZZZ" not in out["text"]


@pytest.mark.parametrize("raw", [None, "", "   ", 42, {"actions": []}])
def test_parse_actions_tolerates_a_non_string(raw):
    out = coach_trader.parse_actions(raw)
    assert out["actions"] == []
    assert out["error"] == "no_block"
    assert isinstance(out["text"], str)


def test_parse_actions_output_shape_is_stable():
    out = coach_trader.parse_actions(_digest(BLOCK_OK))
    assert set(out) == {"text", "actions", "note", "error"}


def test_parse_actions_survives_a_truncated_block():
    """Réponse coupée en plein bloc : on lit ce qui est lisible et, surtout,
    on ne laisse JAMAIS le JSON tronqué partir sur Telegram."""
    out = coach_trader.parse_actions(
        _digest('```COACH_ACTIONS\n{"actions": [{"action": "buy", "sym'))
    assert out["error"] == "parse_failed"
    assert out["actions"] == []
    assert coach_trader.ACTIONS_MARKER not in out["text"]
    assert out["text"].endswith("point du jour.")


def test_parse_actions_reads_a_closed_truncation_correctly_too():
    """La clôture, quand elle est là, gagne sur la fin de texte."""
    out = coach_trader.parse_actions(
        _digest(BLOCK_OK) + "\n\nBonne soirée.")
    assert out["error"] is None
    assert out["text"].endswith("Bonne soirée.")


def test_parse_actions_is_case_insensitive_on_the_marker():
    out = coach_trader.parse_actions(
        _digest('```coach_actions\n{"actions": [{"action": "buy"}]}\n```'))
    assert out["error"] is None
    assert out["actions"] == [{"action": "buy"}]


def test_parse_actions_can_render_an_empty_text():
    """Un digest RÉDUIT à son bloc laisse une chaîne vide, pas un blanc
    trompeur — c'est à l'appelant de décider s'il envoie quelque chose."""
    out = coach_trader.parse_actions(BLOCK_OK)
    assert out["text"] == ""
    assert len(out["actions"]) == 1


# --------------------------------------------------------------------------- #
# parse_actions — le ``note`` de tête (LOT 4bis)
#
# L'inaction doit être un CHOIX ARGUMENTÉ, jamais un silence générique : le
# coach écrit désormais POURQUOI il ne fait rien (ou ce qu'il lit du marché
# quand il agit) dans un champ ``note`` de tête, à côté de ``actions``.
# --------------------------------------------------------------------------- #

def _block_with(note=None, actions=None):
    payload = {"actions": actions if actions is not None else []}
    if note is not None:
        payload["note"] = note
    return _digest("```COACH_ACTIONS\n%s\n```" % json.dumps(payload))


def test_parse_actions_extracts_the_note_next_to_empty_actions():
    out = coach_trader.parse_actions(
        _block_with(note="J'attends la confirmation du support à 92."))
    assert out["error"] is None
    assert out["actions"] == []
    assert out["note"] == "J'attends la confirmation du support à 92."


def test_parse_actions_extracts_the_note_alongside_real_actions():
    out = coach_trader.parse_actions(
        _block_with(note="Le marché est nerveux ce soir.",
                   actions=[{"action": "buy", "symbol": "NESN.SW"}]))
    assert out["note"] == "Le marché est nerveux ce soir."
    assert out["actions"] == [{"action": "buy", "symbol": "NESN.SW"}]


def test_parse_actions_note_is_none_when_absent():
    out = coach_trader.parse_actions(_block_with())
    assert out["error"] is None
    assert out["note"] is None


@pytest.mark.parametrize("bad", [42, 3.5, True, ["x"], {"a": 1}, None])
def test_parse_actions_note_non_string_is_none(bad):
    """Un ``note`` mal typé ne doit jamais lever — juste compter comme absent,
    même tolérance que le reste du parseur (cf. ``_actions_of``)."""
    out = coach_trader.parse_actions(_block_with(note=bad))
    assert out["note"] is None


@pytest.mark.parametrize("blank", ["", "   ", "\n\t"])
def test_parse_actions_note_blank_string_is_none(blank):
    """Une chaîne vide ou blanche ne dit rien de plus qu'un silence : elle
    compte comme absente, pas comme une raison."""
    out = coach_trader.parse_actions(_block_with(note=blank))
    assert out["note"] is None


def test_parse_actions_note_is_stripped():
    out = coach_trader.parse_actions(_block_with(note="  espaces autour  "))
    assert out["note"] == "espaces autour"


def test_parse_actions_note_is_none_on_a_bare_list_payload():
    """Une liste nue n'a pas de clé ``note`` possible — jamais une exception,
    juste ``None``."""
    out = coach_trader.parse_actions(
        _digest('```COACH_ACTIONS\n[{"action": "sell", "symbol": "X"}]\n```'))
    assert out["note"] is None


def test_parse_actions_note_is_none_on_parse_failed():
    broken = _digest('```COACH_ACTIONS\n{"note": "X", "actions": [ceci}\n```')
    out = coach_trader.parse_actions(broken)
    assert out["error"] == "parse_failed"
    assert out["note"] is None


def test_parse_actions_note_is_none_without_a_block():
    out = coach_trader.parse_actions("Bonjour Massii. Rien à faire.")
    assert out["error"] == "no_block"
    assert out["note"] is None


# --------------------------------------------------------------------------- #
# pass_due
# --------------------------------------------------------------------------- #

def test_pass_due_true_on_a_weekday_evening():
    assert coach_trader.pass_due(FRIDAY_ON_TIME, None) is True
    assert coach_trader.pass_due(MONDAY, None) is True


def test_pass_due_false_before_the_hour():
    assert coach_trader.pass_due(FRIDAY_TOO_EARLY, None) is False


def test_pass_due_false_on_the_weekend():
    assert coach_trader.pass_due(SATURDAY, None) is False
    assert coach_trader.pass_due(SUNDAY, None) is False


def test_pass_due_reads_the_weekend_in_local_time():
    """22h30 UTC un vendredi, c'est déjà SAMEDI à Rome."""
    assert coach_trader.pass_due(FRIDAY_LATE_IS_SATURDAY_LOCAL, None) is False


def test_pass_due_uses_the_local_hour_in_winter_too():
    assert coach_trader.pass_due(WINTER_FRIDAY, None) is True


def test_pass_due_false_twice_on_the_same_local_day():
    assert coach_trader.pass_due(FRIDAY_ON_TIME, FRIDAY_ON_TIME.isoformat()) is False


def test_pass_due_compares_the_LOCAL_date_not_the_utc_one():
    """23h30 UTC le 27 = 01h30 LOCAL le 28 : la passe du 28 est déjà faite."""
    last = datetime(2026, 8, 27, 23, 30, tzinfo=timezone.utc).isoformat()
    assert coach_trader.pass_due(FRIDAY_ON_TIME, last) is False


def test_pass_due_true_the_next_day():
    last = datetime(2026, 8, 27, 15, 0, tzinfo=timezone.utc).isoformat()
    assert coach_trader.pass_due(FRIDAY_ON_TIME, last) is True


@pytest.mark.parametrize("last", [None, "", "   ", "n'importe quoi", 42])
def test_pass_due_when_the_last_run_is_unreadable(last):
    assert coach_trader.pass_due(FRIDAY_ON_TIME, last) is True


def test_pass_due_accepts_a_naive_now_as_utc():
    assert coach_trader.pass_due(datetime(2026, 8, 28, 15, 0), None) is True
    assert coach_trader.pass_due(datetime(2026, 8, 28, 14, 59), None) is False


def test_pass_due_honours_a_custom_hour():
    assert coach_trader.pass_due(FRIDAY_TOO_EARLY, None, hour=16) is True
    assert coach_trader.pass_due(FRIDAY_ON_TIME, None, hour=23) is False


# --------------------------------------------------------------------------- #
# market_of / tradable_now — LOT 8 : l'univers PAR SYMBOLE et PAR INSTANT.
#
# Remplace ``crypto_only_at`` (LOT 6), qui ne posait qu'une question binaire
# pour toute la passe (« est-on le week-end ? ») et ratait toute la semaine —
# un short US à 10h du matin Rome n'avait JAMAIS de raison de passer (Wall
# Street n'ouvre qu'à 15h35 locales), et rien ne le refusait.
# --------------------------------------------------------------------------- #

# Mardi 25/08/2026, heures LOCALES Rome (CEST = UTC+2).
TUESDAY_1000 = datetime(2026, 8, 25, 8, 0, 0, tzinfo=timezone.utc)    # 10:00 Rome
TUESDAY_1600 = datetime(2026, 8, 25, 14, 0, 0, tzinfo=timezone.utc)   # 16:00 Rome


@pytest.mark.parametrize("symbol,expected", [
    ("NESN.SW", "europe"), ("MC.PA", "europe"), ("SAP.DE", "europe"),
    ("AI.F", "europe"), ("ENI.MI", "europe"), ("ASML.AS", "europe"),
    ("SAN.MC", "europe"), ("SHEL.L", "europe"),
    ("DAL", "us"), ("AAPL", "us"), ("RY.TO", "us"),
    ("BTC-USD", "crypto"), ("ETH-EUR", "crypto"),
    ("EURUSD=X", "unknown"), ("XYZ.ZZ", "unknown"), ("", "unknown"),
])
def test_market_of_reads_the_ticker_suffix(symbol, expected):
    assert coach_trader.market_of(symbol) == expected


def test_tradable_now_a_crypto_never_closes():
    assert coach_trader.tradable_now("BTC-USD", SUNDAY) is True
    assert coach_trader.tradable_now("BTC-USD", TUESDAY_1000) is True


def test_tradable_now_a_us_stock_is_shut_on_sunday():
    assert coach_trader.tradable_now("DAL", SUNDAY) is False


def test_tradable_now_a_european_stock_is_open_tuesday_morning():
    assert coach_trader.tradable_now("NESN.SW", TUESDAY_1000) is True


def test_tradable_now_a_us_stock_is_shut_tuesday_morning():
    """10h à Rome, c'est 4h du matin à New York : Wall Street n'a pas encore
    ouvert."""
    assert coach_trader.tradable_now("DAL", TUESDAY_1000) is False


def test_tradable_now_a_us_stock_opens_tuesday_afternoon():
    assert coach_trader.tradable_now("DAL", TUESDAY_1600) is True


def test_tradable_now_an_unknown_market_is_never_tradable():
    """On ne trade pas ce qu'on ne sait pas situer."""
    assert coach_trader.tradable_now("XYZ.ZZ", TUESDAY_1600) is False


def test_tradable_now_accepts_an_iso_string():
    """Même tolérance que ``pass_due``/``_aware_utc`` : une chaîne ISO (le
    format que les 3 chemins ont sous la main, ``_now_iso()``-style) est
    PARSÉE, jamais ignorée."""
    assert coach_trader.tradable_now("DAL", "2026-08-23T01:47:00") is False   # dimanche
    assert coach_trader.tradable_now("BTC-USD", "2026-08-23T01:47:00") is True


def test_pass_due_default_hour_is_the_constant():
    assert coach_trader.RUN_AFTER_HOUR == 17


# --------------------------------------------------------------------------- #
# Le GARDIEN — LOT 8 : la sentinelle déclenchée par le MARCHÉ, entre deux
# créneaux planifiés. PUR : ``guardian_trigger`` (quel déclencheur, s'il y en
# a un), ``guardian_decision`` (doit-on APPELER le modèle maintenant, tout
# compris : marché, cooldown, plafond quotidien), ``guardian_seen``/
# ``guardian_mark_fired`` (les deux mutations d'état), ``guardian_gate`` (le
# garde-fou de PÉRIMÈTRE : cette décision porte-t-elle sur LA bonne ligne ?).
# --------------------------------------------------------------------------- #

GUARDIAN_MOVED = {"stop_loss": None, "target": None}


def test_guardian_trigger_move_at_the_threshold():
    assert coach_trader.guardian_trigger(GUARDIAN_MOVED, 98.0, 100.0) == "move"


def test_guardian_trigger_no_move_under_the_threshold():
    assert coach_trader.guardian_trigger(GUARDIAN_MOVED, 98.5, 100.0) is None


def test_guardian_trigger_stop_at_the_threshold():
    position = {"stop_loss": 97.5, "target": None}
    assert coach_trader.guardian_trigger(position, 100.0, None) == "stop"


def test_guardian_trigger_no_stop_trigger_far_from_the_stop():
    position = {"stop_loss": 90.0, "target": None}
    assert coach_trader.guardian_trigger(position, 100.0, None) is None


def test_guardian_trigger_target_at_the_threshold():
    position = {"stop_loss": None, "target": 101.5}
    assert coach_trader.guardian_trigger(position, 100.0, None) == "target"


def test_guardian_trigger_no_target_trigger_far_from_the_target():
    position = {"stop_loss": None, "target": 110.0}
    assert coach_trader.guardian_trigger(position, 100.0, None) is None


def test_guardian_trigger_stop_wins_over_target_when_both_apply():
    """Ordre de sévérité DÉLIBÉRÉ : un stop qui chauffe (risque de perte)
    prime sur un objectif qui mûrit (opportunité)."""
    position = {"stop_loss": 97.5, "target": 101.5}
    assert coach_trader.guardian_trigger(position, 100.0, None) == "stop"


def test_guardian_trigger_none_of_the_three_fire():
    position = {"stop_loss": 50.0, "target": 200.0}
    assert coach_trader.guardian_trigger(position, 100.0, 100.5) is None


def test_guardian_trigger_no_price_is_never_a_trigger():
    assert coach_trader.guardian_trigger(GUARDIAN_MOVED, None, 100.0) is None
    assert coach_trader.guardian_trigger(GUARDIAN_MOVED, 0, 100.0) is None


def test_guardian_decision_fires_on_a_trigger():
    state = {"NESN.SW": {"last_price": 100.0}}
    out = coach_trader.guardian_decision(
        "NESN.SW", GUARDIAN_MOVED, 98.0, state, TUESDAY_1000)
    assert out == {"fire": True, "trigger": "move", "reason": None}


def test_guardian_decision_nothing_to_report():
    """Ni déclencheur ni état antérieur (premier regard) : rien à signaler."""
    out = coach_trader.guardian_decision(
        "NESN.SW", GUARDIAN_MOVED, 100.0, {}, TUESDAY_1000)
    assert out == {"fire": False, "trigger": None, "reason": None}


def test_guardian_decision_no_price_never_calls():
    out = coach_trader.guardian_decision(
        "NESN.SW", GUARDIAN_MOVED, None, {}, TUESDAY_1000)
    assert out == {"fire": False, "trigger": None, "reason": "no_price"}


def test_guardian_decision_a_shut_market_never_calls_even_on_a_trigger():
    """DAL (US) est fermé à 10h Rome : même une position qui a bougé de 2 %
    ne réveille pas le gardien — un appel qui ne peut mener à AUCUN ordre
    exécutable est un appel gaspillé."""
    out = coach_trader.guardian_decision(
        "DAL", GUARDIAN_MOVED, 98.0, {}, TUESDAY_1000)
    assert out == {"fire": False, "trigger": None, "reason": "market_closed"}


def test_guardian_decision_a_crypto_can_always_fire():
    state = {"BTC-USD": {"last_price": 100.0}}
    out = coach_trader.guardian_decision(
        "BTC-USD", GUARDIAN_MOVED, 98.0, state, SUNDAY)
    assert out["fire"] is True


def test_guardian_decision_respects_the_cooldown():
    state = {"NESN.SW": {"last_price": 100.0,
                         "last_call": "2026-08-25T07:30:00+00:00"}}   # 09:30 Rome
    out = coach_trader.guardian_decision(
        "NESN.SW", GUARDIAN_MOVED, 98.0, state, TUESDAY_1000)   # 10:00 Rome, 30 min après
    assert out == {"fire": False, "trigger": "move", "reason": "cooldown"}


def test_guardian_decision_the_cooldown_expires():
    state = {"NESN.SW": {"last_price": 100.0,
                         "last_call": "2026-08-25T07:00:00+00:00"}}   # 09:00 Rome
    out = coach_trader.guardian_decision(
        "NESN.SW", GUARDIAN_MOVED, 98.0, state, TUESDAY_1000)   # 10:00 Rome, 60 min après
    assert out["fire"] is True


def test_guardian_decision_respects_the_daily_cap():
    state = {"NESN.SW": {"last_price": 100.0,
                         "calls_today": coach_trader.MAX_GUARDIAN_CALLS_PER_DAY,
                         "calls_date": "2026-08-25"}}
    out = coach_trader.guardian_decision(
        "NESN.SW", GUARDIAN_MOVED, 98.0, state, TUESDAY_1000)
    assert out == {"fire": False, "trigger": "move", "reason": "daily_cap"}


def test_guardian_decision_the_daily_cap_resets_the_next_day():
    state = {"NESN.SW": {"last_price": 100.0,
                         "calls_today": coach_trader.MAX_GUARDIAN_CALLS_PER_DAY,
                         "calls_date": "2026-08-24"}}   # hier
    out = coach_trader.guardian_decision(
        "NESN.SW", GUARDIAN_MOVED, 98.0, state, TUESDAY_1000)
    assert out["fire"] is True


def test_guardian_decision_never_raises_on_junk():
    for junk in (None, {}, [], "pas un dict", 0, "n'importe quoi"):
        out = coach_trader.guardian_decision("NESN.SW", junk, 98.0, junk, junk)
        assert isinstance(out, dict) and "fire" in out


def test_guardian_seen_records_the_last_price():
    state = coach_trader.guardian_seen({}, "NESN.SW", 101.5)
    assert state == {"NESN.SW": {"last_price": 101.5}}


def test_guardian_seen_keeps_the_other_symbols():
    state = coach_trader.guardian_seen(
        {"BTC-USD": {"last_price": 50000.0}}, "NESN.SW", 101.5)
    assert state["BTC-USD"] == {"last_price": 50000.0}
    assert state["NESN.SW"]["last_price"] == 101.5


def test_guardian_seen_never_mutates_the_input():
    original = {"NESN.SW": {"last_price": 100.0}}
    coach_trader.guardian_seen(original, "NESN.SW", 200.0)
    assert original["NESN.SW"]["last_price"] == 100.0


def test_guardian_mark_fired_increments_the_daily_count():
    state = coach_trader.guardian_mark_fired({}, "NESN.SW", TUESDAY_1000)
    sym = state["NESN.SW"]
    assert sym["calls_today"] == 1
    assert sym["calls_date"] == "2026-08-25"
    assert sym["last_call"]


def test_guardian_mark_fired_resets_the_count_on_a_new_day():
    state = {"NESN.SW": {"calls_today": 3, "calls_date": "2026-08-24"}}
    state = coach_trader.guardian_mark_fired(state, "NESN.SW", TUESDAY_1000)
    assert state["NESN.SW"]["calls_today"] == 1
    assert state["NESN.SW"]["calls_date"] == "2026-08-25"


def test_guardian_mark_fired_keeps_the_last_price():
    """``guardian_seen`` et ``guardian_mark_fired`` mutent des clés
    DIFFÉRENTES du même sous-dict : l'une n'écrase pas l'autre."""
    state = coach_trader.guardian_seen({}, "NESN.SW", 101.5)
    state = coach_trader.guardian_mark_fired(state, "NESN.SW", TUESDAY_1000)
    assert state["NESN.SW"]["last_price"] == 101.5
    assert state["NESN.SW"]["calls_today"] == 1


def test_guardian_gate_accepts_an_exit_on_the_focus_symbol():
    for action in ("sell", "reduce", "cover", "adjust_stop"):
        decision = {"action": action, "symbol": "NESN.SW"}
        assert coach_trader.guardian_gate(decision, "NESN.SW") is None


def test_guardian_gate_rejects_a_different_symbol():
    decision = {"action": "sell", "symbol": "AAPL"}
    assert coach_trader.guardian_gate(decision, "NESN.SW") == "out_of_scope"


def test_guardian_gate_rejects_a_new_entry():
    for action in ("buy", "short"):
        decision = {"action": action, "symbol": "NESN.SW"}
        assert coach_trader.guardian_gate(decision, "NESN.SW") == "out_of_scope"


def test_guardian_gate_never_raises_on_junk():
    for junk in (None, {}, [], "pas un dict", 0):
        assert coach_trader.guardian_gate(junk, "NESN.SW") == "out_of_scope"


# --------------------------------------------------------------------------- #
# Registre
# --------------------------------------------------------------------------- #

def test_ledger_entry_shape():
    entry = coach_trader.ledger_entry("2026-08-28T17:00:00", "digest", "buy",
                                      "nesn.sw", True)
    assert entry["ts"] == "2026-08-28T17:00:00"
    assert entry["source"] == "digest"
    assert entry["action"] == "buy"
    assert entry["symbol"] == "NESN.SW"
    assert entry["accepted"] is True
    assert entry["reason"] is None
    assert entry["detail"] is None


def test_ledger_entry_archives_the_refusal_with_its_code():
    """« voir COMMENT il fait » = archiver les REFUS, pas seulement les ordres."""
    entry = coach_trader.ledger_entry("2026-08-28T17:00:00", "daily", "buy",
                                      "TSLA", False, reason="oversize",
                                      detail="40 % de l'équité")
    assert entry["accepted"] is False
    assert entry["reason"] == "oversize"
    assert entry["detail"] == "40 % de l'équité"


def test_ledger_entry_normalises_blank_fields_to_none():
    entry = coach_trader.ledger_entry(None, "digest", " BUY ", None, "oui",
                                      reason="  ", detail="")
    assert entry["ts"] == ""
    assert entry["action"] == "buy"
    assert entry["symbol"] == ""
    assert entry["accepted"] is True
    assert entry["reason"] is None
    assert entry["detail"] is None


def test_push_ledger_puts_the_newest_first():
    rows = coach_trader.push_ledger([], {"ts": "1"})
    rows = coach_trader.push_ledger(rows, {"ts": "2"})
    assert [r["ts"] for r in rows] == ["2", "1"]


def test_push_ledger_caps_at_two_hundred():
    rows = []
    for i in range(250):
        rows = coach_trader.push_ledger(rows, {"ts": str(i)})
    assert len(rows) == coach_trader.MAX_LEDGER == 200
    assert rows[0]["ts"] == "249"
    assert rows[-1]["ts"] == "50"


def test_push_ledger_tolerates_garbage_and_never_mutates():
    original = [{"ts": "1"}, "junk", None]
    rows = coach_trader.push_ledger(original, {"ts": "2"})
    assert rows == [{"ts": "2"}, {"ts": "1"}]
    assert original == [{"ts": "1"}, "junk", None]


def test_push_ledger_honours_a_custom_cap():
    rows = coach_trader.push_ledger([{"ts": "1"}, {"ts": "0"}], {"ts": "2"}, cap=2)
    assert [r["ts"] for r in rows] == ["2", "1"]


def test_ledger_sources_are_declared():
    assert coach_trader.ledger_entry("t", "digest", "buy", "X", True)["source"] == "digest"
    assert coach_trader.ledger_entry("t", "daily", "buy", "X", True)["source"] == "daily"


# --------------------------------------------------------------------------- #
# Patrimoine
# --------------------------------------------------------------------------- #

def test_should_snapshot_on_an_empty_series():
    assert coach_trader.should_snapshot([], "2026-08-28") is True
    assert coach_trader.should_snapshot(None, "2026-08-28") is True


def test_should_snapshot_is_false_when_today_is_already_the_last_point():
    series = [{"date": "2026-08-27", "equity": 1.0}, {"date": "2026-08-28", "equity": 2.0}]
    assert coach_trader.should_snapshot(series, "2026-08-28") is False


def test_should_snapshot_is_true_on_a_new_day():
    series = [{"date": "2026-08-27", "equity": 1.0}]
    assert coach_trader.should_snapshot(series, "2026-08-28") is True


def test_should_snapshot_refuses_a_blank_date():
    assert coach_trader.should_snapshot([], "") is False
    assert coach_trader.should_snapshot([], None) is False


def test_push_equity_appends_in_chronological_order():
    series = coach_trader.push_equity([], "2026-08-27", 10000.0)
    series = coach_trader.push_equity(series, "2026-08-28", 10120.5)
    assert series == [{"date": "2026-08-27", "equity": 10000.0},
                      {"date": "2026-08-28", "equity": 10120.5}]


def test_push_equity_is_idempotent_for_a_date_already_present():
    series = [{"date": "2026-08-27", "equity": 1.0}, {"date": "2026-08-28", "equity": 2.0}]
    assert coach_trader.push_equity(series, "2026-08-27", 999.0) == series


def test_push_equity_caps_and_keeps_the_most_recent():
    series = []
    for i in range(coach_trader.MAX_EQUITY_POINTS + 40):
        series = coach_trader.push_equity(series, "day-%04d" % i, float(i))
    assert len(series) == coach_trader.MAX_EQUITY_POINTS == 730
    assert series[-1]["date"] == "day-0769"
    assert series[0]["date"] == "day-0040"


def test_push_equity_ignores_a_blank_date_or_an_unreadable_equity():
    series = [{"date": "2026-08-27", "equity": 1.0}]
    assert coach_trader.push_equity(series, "", 10.0) == series
    assert coach_trader.push_equity(series, "2026-08-28", "beaucoup") == series
    assert coach_trader.push_equity(series, "2026-08-28", None) == series


def test_push_equity_never_mutates_its_input():
    original = [{"date": "2026-08-27", "equity": 1.0}]
    coach_trader.push_equity(original, "2026-08-28", 2.0)
    assert original == [{"date": "2026-08-27", "equity": 1.0}]


def test_push_equity_honours_a_custom_cap():
    series = coach_trader.push_equity([{"date": "a", "equity": 1.0},
                                       {"date": "b", "equity": 2.0}], "c", 3.0, cap=2)
    assert [p["date"] for p in series] == ["b", "c"]


# --------------------------------------------------------------------------- #
# État du module (I/O)
# --------------------------------------------------------------------------- #

def test_state_path_lives_next_to_the_accounts(tmp_path):
    assert coach_trader.state_path() == tmp_path / "paper_trading" / "coach_trader.state.json"


def test_load_state_missing_returns_empty():
    assert coach_trader.load_state() == {}


def test_state_roundtrip():
    coach_trader.save_state({"last_pass_iso": "2026-08-28T17:00:00"})
    assert coach_trader.load_state() == {"last_pass_iso": "2026-08-28T17:00:00"}


def test_load_state_on_a_corrupt_file_returns_empty():
    path = coach_trader.state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{pas du json", encoding="utf-8")
    assert coach_trader.load_state() == {}


def test_state_file_is_600():
    coach_trader.save_state({"a": 1})
    mode = stat.S_IMODE(os.stat(str(coach_trader.state_path())).st_mode)
    assert mode == 0o600


# --------------------------------------------------------------------------- #
# État du GARDIEN (I/O, LOT 8) — même patron, FICHIER SÉPARÉ (par symbole,
# pas par compte : le gardien n'a qu'un seul compte à surveiller, le coach).
# --------------------------------------------------------------------------- #

def test_guardian_state_path_lives_next_to_the_accounts(tmp_path):
    assert (coach_trader.guardian_state_path()
           == tmp_path / "paper_trading" / "coach_guardian.state.json")


def test_load_guardian_state_missing_returns_empty():
    assert coach_trader.load_guardian_state() == {}


def test_guardian_state_roundtrip():
    coach_trader.save_guardian_state({"NESN.SW": {"last_price": 101.5}})
    assert coach_trader.load_guardian_state() == {"NESN.SW": {"last_price": 101.5}}


def test_load_guardian_state_on_a_corrupt_file_returns_empty():
    path = coach_trader.guardian_state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{pas du json", encoding="utf-8")
    assert coach_trader.load_guardian_state() == {}


def test_guardian_state_file_is_600():
    coach_trader.save_guardian_state({"a": 1})
    mode = stat.S_IMODE(os.stat(str(coach_trader.guardian_state_path())).st_mode)
    assert mode == 0o600


# --------------------------------------------------------------------------- #
# store — registre & patrimoine
# --------------------------------------------------------------------------- #

def test_ledger_and_equity_paths(tmp_path):
    base = tmp_path / "paper_trading"
    assert store.ledger_path("coach") == base / "coach.ledger.json"
    assert store.equity_path("coach") == base / "coach.equity.json"


def test_ledger_and_equity_paths_validate_the_username():
    for bad in ("", "a/b", "../etc", "al.ice"):
        with pytest.raises(ValueError):
            store.ledger_path(bad)
        with pytest.raises(ValueError):
            store.equity_path(bad)


def test_load_ledger_missing_returns_empty_list():
    assert store.load_ledger("coach") == []


def test_load_equity_missing_returns_empty_list():
    assert store.load_equity("coach") == []


def test_ledger_roundtrip():
    rows = [{"ts": "2026-08-28T17:00:00", "action": "buy", "accepted": True}]
    store.save_ledger("coach", rows)
    assert store.load_ledger("coach") == rows


def test_equity_roundtrip():
    points = [{"date": "2026-08-28", "equity": 10000.0}]
    store.save_equity("coach", points)
    assert store.load_equity("coach") == points


def test_ledger_and_equity_use_the_documented_top_level_keys():
    store.save_ledger("coach", [{"ts": "1"}])
    store.save_equity("coach", [{"date": "2026-08-28", "equity": 1.0}])
    assert json.loads(store.ledger_path("coach").read_text(encoding="utf-8")) \
        == {"rows": [{"ts": "1"}]}
    assert json.loads(store.equity_path("coach").read_text(encoding="utf-8")) \
        == {"points": [{"date": "2026-08-28", "equity": 1.0}]}


@pytest.mark.parametrize("junk", ["pas du json", "[]", '{"rows": "nope"}',
                                  '{"points": 3}', "null"])
def test_ledger_and_equity_reads_are_tolerant(junk):
    store.ledger_path("coach").parent.mkdir(parents=True, exist_ok=True)
    store.ledger_path("coach").write_text(junk, encoding="utf-8")
    store.equity_path("coach").write_text(junk, encoding="utf-8")
    assert store.load_ledger("coach") == []
    assert store.load_equity("coach") == []


def test_ledger_and_equity_drop_non_dict_rows():
    store.save_ledger("coach", [{"ts": "1"}, "junk", None])
    store.save_equity("coach", [{"date": "d", "equity": 1.0}, 42])
    assert store.load_ledger("coach") == [{"ts": "1"}]
    assert store.load_equity("coach") == [{"date": "d", "equity": 1.0}]


def test_ledger_and_equity_files_are_600():
    store.save_ledger("coach", [{"ts": "1"}])
    store.save_equity("coach", [{"date": "d", "equity": 1.0}])
    for path in (store.ledger_path("coach"), store.equity_path("coach")):
        assert stat.S_IMODE(os.stat(str(path)).st_mode) == 0o600


def test_saving_the_ledger_does_not_touch_the_portfolio():
    """Fichiers SÉPARÉS : le round-trip par la dataclass ``Portfolio``
    stripperait une clé inconnue (piège #61 du dépôt)."""
    store.save_portfolio("coach", {"cash_chf": 10000.0})
    store.save_ledger("coach", [{"ts": "1"}])
    store.save_equity("coach", [{"date": "d", "equity": 1.0}])
    assert store.load_portfolio("coach") == {"cash_chf": 10000.0}


# --------------------------------------------------------------------------- #
# ANTI-FANTÔMES — les nouveaux fichiers ne sont pas des comptes,
# mais « coach » en est un (ses positions sont publiques par design)
# --------------------------------------------------------------------------- #

def _seed_coach_and_aux():
    store.save_portfolio("coach", {"cash_chf": 10000.0, "initial_capital": 10000.0,
                                   "positions": [{"symbol": "NESN.SW", "qty": 3}],
                                   "open_orders": [], "trades": []})
    store.save_ledger("coach", [{"ts": "1"}])
    store.save_equity("coach", [{"date": "2026-08-28", "equity": 10000.0}])
    coach_trader.save_state({"last_pass_iso": "2026-08-28T17:00:00"})


def test_newswatch_does_not_mistake_the_new_files_for_accounts():
    from backend.bots.paper import newswatch
    _seed_coach_and_aux()
    found = [name for name, _ in newswatch._discover_portfolios()]
    assert found == ["coach"]


def test_weekly_does_not_mistake_the_new_files_for_accounts():
    from backend.bots.paper import weekly
    _seed_coach_and_aux()
    found = [name for name, _ in weekly._discover_accounts()]
    assert found == ["coach"]


def test_radar_does_not_mistake_the_new_files_for_accounts():
    from backend.bots.paper import radar
    _seed_coach_and_aux()
    assert radar._users_with_portfolio() == ["coach"]


def test_the_new_names_are_documented_in_the_explicit_lists():
    """Première ligne de défense : la liste EXPLICITE, qui documente ce qui
    n'est pas un compte (l'allowlist de ``store`` n'est que le filet)."""
    from backend.bots.paper import radar, weekly
    assert ".ledger.json" in weekly._AUX_SUFFIXES
    assert ".equity.json" in weekly._AUX_SUFFIXES
    assert coach_trader.STATE_NAME in weekly._AUX_NAMES
    assert coach_trader.STATE_NAME in radar._NON_USER_FILES
    # LOT 8 — le fichier d'état du GARDIEN, même doctrine.
    assert coach_trader.GUARDIAN_STATE_NAME in weekly._AUX_NAMES
    assert coach_trader.GUARDIAN_STATE_NAME in radar._NON_USER_FILES


def test_the_coach_is_a_real_account_for_the_community():
    _seed_coach_and_aux()
    assert store._is_real_account("coach") is True
    assert coach_trader.COACH_USERNAME not in store.RESERVED_VAULT_NAMES


def test_the_aux_radicals_are_rejected_by_the_store_allowlist():
    """Ceinture ET bretelles : ``coach.ledger`` porte un point -> impossible
    comme nom de compte, quoi qu'il arrive aux listes explicites."""
    for bad in ("coach.ledger", "coach.equity", "coach_trader.state"):
        with pytest.raises(ValueError):
            store.portfolio_path(bad)


# =========================================================================== #
#  I/O — ``maybe_run``, le crochet UNIQUE du cycle de veille (tâche 3)
#
#  ⚠️ ``@pytest.mark.real_coach_trader`` sur CHAQUE test : le conftest neutralise
#  ``maybe_run`` par défaut (elle ouvre un chemin réseau + LLM depuis le cycle).
#  Les trois exécutants sont injectés — aucun de ces tests ne touche le router.
# =========================================================================== #

class _Spy:
    """Un exécutant injectable : mémorise ses appels, peut exploser."""

    def __init__(self, boom=False, result=None):
        self.calls = []
        self.boom = boom
        self.result = result

    def __call__(self, *args):
        self.calls.append(args)
        if self.boom:
            raise RuntimeError("exécutant en panne")
        return self.result


def _run_hook(now=FRIDAY_ON_TIME, tick=None, snap=None, pass_=None, guardian=None):
    return coach_trader.maybe_run(now=now,
                                  tick_fn=tick if tick is not None else _Spy(),
                                  snapshot_fn=snap if snap is not None else _Spy(),
                                  pass_fn=pass_ if pass_ is not None else _Spy(),
                                  guardian_fn=guardian if guardian is not None else _Spy())


@pytest.mark.real_coach_trader
def test_maybe_run_ticks_at_every_pass():
    """LE point critique du lot : ``run_tick`` n'énumère aucun compte et le
    coach n'a pas de navigateur — sans ce tick, ses stops ne s'exécuteraient
    JAMAIS. Il tourne donc à CHAQUE passage, pas une fois par jour."""
    tick = _Spy()
    out = _run_hook(tick=tick)
    assert len(tick.calls) == 1
    assert out["ticked"] is True


@pytest.mark.real_coach_trader
def test_maybe_run_ticks_even_when_the_pass_is_not_due():
    """Samedi : la passe ne tourne pas, le tick SI (un stop peut sauter le
    week-end sur une crypto)."""
    tick, pass_ = _Spy(), _Spy()
    out = _run_hook(now=SATURDAY, tick=tick, pass_=pass_)
    assert len(tick.calls) == 1
    assert pass_.calls == []
    assert out == {"ticked": True, "snapshotted": True, "passed": False,
                   "reason": "not_due", "guarded": True}


@pytest.mark.real_coach_trader
def test_maybe_run_runs_the_daily_pass_once_per_day():
    pass_ = _Spy()
    first = _run_hook(pass_=pass_)
    second = _run_hook(pass_=pass_)
    assert len(pass_.calls) == 1
    assert first["passed"] is True
    assert second["passed"] is False
    assert second["reason"] == "not_due"


@pytest.mark.real_coach_trader
def test_maybe_run_arms_the_state_even_when_the_pass_fails():
    """Même doctrine que ``weekly`` : sinon une panne fait retenter toutes les
    5 minutes pendant toute la soirée."""
    pass_ = _Spy(boom=True)
    first = _run_hook(pass_=pass_)
    assert first["passed"] is False
    assert first["reason"] == "error"
    assert coach_trader.load_state().get("last_pass")

    second = _run_hook(pass_=pass_)
    assert len(pass_.calls) == 1          # pas de nouvelle tentative le soir même
    assert second["reason"] == "not_due"


@pytest.mark.real_coach_trader
def test_maybe_run_snapshots_the_equity_once_per_day():
    snap = _Spy()
    # La photo est gatée sur la série du COACH : sans elle, rien n'a été pris.
    first = _run_hook(snap=snap)
    assert len(snap.calls) == 1
    assert first["snapshotted"] is True

    # Le vrai exécutant écrit la série ; ici on la pose à la main pour prouver
    # que le gate la lit bien.
    store.save_equity(coach_trader.COACH_USERNAME,
                      [{"date": _local_day(FRIDAY_ON_TIME), "equity": 10000.0}])
    second = _run_hook(snap=snap)
    assert len(snap.calls) == 1
    assert second["snapshotted"] is False


def _local_day(moment):
    """La date LOCALE (Europe/Rome) du moment — celle que ``maybe_run`` utilise."""
    from zoneinfo import ZoneInfo
    return moment.astimezone(ZoneInfo(coach_trader.LOCAL_TZ)).date().isoformat()


@pytest.mark.real_coach_trader
def test_maybe_run_hands_the_same_local_timestamp_to_the_three_volets():
    """Un SEUL horodatage local pour les trois : la photo se range sous la date
    de Rome, et le gate ``should_snapshot`` interroge cette même date. Deux
    horloges divergentes rateraient la photo un jour sur deux vers minuit."""
    tick, snap, pass_ = _Spy(), _Spy(), _Spy()
    _run_hook(tick=tick, snap=snap, pass_=pass_)
    stamps = {tick.calls[0][0], snap.calls[0][0], pass_.calls[0][0]}
    assert len(stamps) == 1
    assert stamps.pop()[:10] == _local_day(FRIDAY_ON_TIME)


@pytest.mark.real_coach_trader
def test_a_broken_tick_never_stops_the_snapshot_nor_the_pass():
    snap, pass_ = _Spy(), _Spy()
    out = _run_hook(tick=_Spy(boom=True), snap=snap, pass_=pass_)
    assert out["ticked"] is False
    assert len(snap.calls) == 1
    assert len(pass_.calls) == 1


@pytest.mark.real_coach_trader
def test_a_broken_snapshot_never_stops_the_pass():
    pass_ = _Spy()
    out = _run_hook(snap=_Spy(boom=True), pass_=pass_)
    assert out["snapshotted"] is False
    assert len(pass_.calls) == 1


@pytest.mark.real_coach_trader
def test_maybe_run_never_raises_even_when_everything_burns():
    out = _run_hook(tick=_Spy(boom=True), snap=_Spy(boom=True),
                    pass_=_Spy(boom=True))
    assert out["ticked"] is False
    assert out["snapshotted"] is False
    assert out["passed"] is False
    assert out["reason"] == "error"
    # LOT 5 : le creneau retenu voyage avec le resultat -- savoir LEQUEL a
    # tourne est la premiere chose qu'on regarde quand la cadence surprend.
    # LOT 8 : FRIDAY_ON_TIME (17h00 Rome) tombe maintenant PILE sur le
    # creneau "17:00" du nouveau planning a 8 creneaux.
    assert out["slot"] == "17:00"


@pytest.mark.real_coach_trader
def test_maybe_run_respects_the_local_hour():
    """09h00 à Rome, avant le premier créneau (09h10) : pas de passe — le
    tick, lui, tourne toujours."""
    tick, pass_ = _Spy(), _Spy()
    out = _run_hook(now=FRIDAY_BEFORE_ANY_SLOT, tick=tick, pass_=pass_)
    assert pass_.calls == []
    assert len(tick.calls) == 1
    assert out["reason"] == "not_due"


# --------------------------------------------------------------------------- #
# LOT 8 — LE GARDIEN vu du CROCHET : verrou « jamais pendant qu'une passe à
# créneau tourne ».
# --------------------------------------------------------------------------- #

@pytest.mark.real_coach_trader
def test_the_guardian_runs_when_no_slot_is_due():
    guardian = _Spy()
    out = _run_hook(now=FRIDAY_BEFORE_ANY_SLOT, guardian=guardian)
    assert len(guardian.calls) == 1
    assert out["guarded"] is True


@pytest.mark.real_coach_trader
def test_the_guardian_receives_the_same_local_timestamp():
    guardian = _Spy()
    _run_hook(now=FRIDAY_BEFORE_ANY_SLOT, guardian=guardian)
    assert guardian.calls[0][0][:10] == _local_day(FRIDAY_BEFORE_ANY_SLOT)


@pytest.mark.real_coach_trader
def test_the_guardian_never_runs_the_same_cycle_as_a_slot_pass():
    """Le verrou : une passe créneau vient DÉJÀ de relire tout le livre, le
    gardien serait redondant dans le même cycle de 5 minutes."""
    guardian = _Spy()
    out = _run_hook(now=WED_1705, guardian=guardian)
    assert out["slot"] == "17:00"
    assert out["passed"] is True
    assert guardian.calls == []
    assert out["guarded"] is False


@pytest.mark.real_coach_trader
def test_a_broken_guardian_never_breaks_the_hook():
    out = _run_hook(now=FRIDAY_BEFORE_ANY_SLOT, guardian=_Spy(boom=True))
    assert out["guarded"] is False
    assert out["reason"] == "not_due"          # le VOLET 3 reste "not_due"


# --------------------------------------------------------------------------- #
# LOT 8 — la cadence vue du CROCHET (huit créneaux, deux le week-end)
# --------------------------------------------------------------------------- #

# Mercredi 26/08/2026 en heures LOCALES Rome (CEST = UTC+2), 5 min après
# chacun des 8 créneaux du planning x20.
WED_0915 = datetime(2026, 8, 26, 7, 15, 0, tzinfo=timezone.utc)   # 09:15 Rome
WED_1135 = datetime(2026, 8, 26, 9, 35, 0, tzinfo=timezone.utc)   # 11:35 Rome
WED_1405 = datetime(2026, 8, 26, 12, 5, 0, tzinfo=timezone.utc)   # 14:05 Rome
WED_1545 = datetime(2026, 8, 26, 13, 45, 0, tzinfo=timezone.utc)  # 15:45 Rome
WED_1705 = datetime(2026, 8, 26, 15, 5, 0, tzinfo=timezone.utc)   # 17:05 Rome
WED_1835 = datetime(2026, 8, 26, 16, 35, 0, tzinfo=timezone.utc)  # 18:35 Rome
WED_2005 = datetime(2026, 8, 26, 18, 5, 0, tzinfo=timezone.utc)   # 20:05 Rome
WED_2145 = datetime(2026, 8, 26, 19, 45, 0, tzinfo=timezone.utc)  # 21:45 Rome
SUNDAY_1105 = datetime(2026, 8, 30, 9, 5, 0, tzinfo=timezone.utc)  # 11:05 Rome
SUNDAY_1805 = datetime(2026, 8, 30, 16, 5, 0, tzinfo=timezone.utc)  # 18:05 Rome


@pytest.mark.real_coach_trader
def test_the_hook_runs_eight_passes_on_a_weekday():
    """La cadence du mois x20 : huit créneaux, et chacun tourne UNE fois."""
    pass_ = _Spy()
    slots = []
    for moment in (WED_0915, WED_1135, WED_1405, WED_1545,
                  WED_1705, WED_1835, WED_2005, WED_2145):
        out = _run_hook(now=moment, pass_=pass_)
        slots.append(out["slot"])
    assert len(pass_.calls) == coach_trader.PASSES_PER_DAY
    assert slots == ["09:10", "11:30", "14:00", "15:40",
                     "17:00", "18:30", "20:00", "21:40"]


@pytest.mark.real_coach_trader
def test_the_hook_never_runs_the_same_slot_twice():
    """La veille repasse toutes les 5 minutes : sans ce verrou, un créneau
    tournerait douze fois par heure — douze appels au modèle."""
    pass_ = _Spy()
    for _ in range(4):
        _run_hook(now=WED_1835, pass_=pass_)
    assert len(pass_.calls) == 1


@pytest.mark.real_coach_trader
def test_the_weekend_still_runs_its_two_slots():
    """LOT 8 : le crochet ne calcule plus de ``crypto_only`` global — c'est
    ``run_coach_daily_pass`` (via ``gate_decision``/``tradable_now``) qui
    juge, décision par décision, ce qui s'échange. Le crochet ne fait plus
    que passer l'horodatage local, SEUL argument désormais — c'est lui qui
    compte. Le week-end porte désormais DEUX créneaux (matin + soir)."""
    morning = _run_hook(now=SUNDAY_1105, pass_=_Spy())
    assert morning["slot"] == "11:00"

    pass_ = _Spy()
    out = _run_hook(now=SUNDAY_1805, pass_=pass_)
    assert out["slot"] == "18:00"
    assert len(pass_.calls[0]) == 1
    assert pass_.calls[0][0][:10] == _local_day(SUNDAY_1805)


@pytest.mark.real_coach_trader
def test_arming_one_slot_does_not_disarm_the_others():
    """Le créneau de 18h30 ne doit pas effacer la trace de celui de 15h40 :
    sinon l'état repartirait à zéro et 15h40 pourrait re-tourner."""
    _run_hook(now=WED_1545, pass_=_Spy())
    _run_hook(now=WED_1835, pass_=_Spy())
    assert set(coach_trader.load_state()["slots"]) == {"15:40", "18:30"}
