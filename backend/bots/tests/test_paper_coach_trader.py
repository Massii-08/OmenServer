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

from backend.bots.paper import coach_trader, fees, models, quotes, risk, store

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
INVALIDATION = "retour sous le range sur une clôture quotidienne"
# LOT 15 — le contrat de thèse que toute ENTRÉE porte désormais.
CONTRACT = {"horizon_days": 3, "invalidation": INVALIDATION}


@pytest.fixture(autouse=True)
def _isolate_data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path / "paper_trading")
    yield


# --------------------------------------------------------------------------- #
# Fabriques
# --------------------------------------------------------------------------- #

def _pf(cash=10000.0, positions=None, capital=10000.0, trades=None,
       fee_profile=None):
    pf = {
        "cash_chf": cash,
        "positions": list(positions or []),
        "open_orders": [],
        "trades": list(trades or []),
        "initial_capital": capital,
    }
    if fee_profile is not None:
        pf["fee_profile"] = fee_profile
    return pf


def _pos(symbol, qty=1, avg_price=1.0, fx_rate=1.0, side="long"):
    return {"symbol": symbol, "qty": qty, "avg_price": avg_price,
            "currency": "CHF", "fx_rate": fx_rate, "side": side}


def _quote(price=100.0, currency="CHF", fx_rate=1.0):
    return {"price": price, "currency": currency, "fx_rate": fx_rate}


def _buy(**over):
    # LOT 15 — une entrée porte un CONTRAT de thèse (``no_horizon`` sinon) :
    # la fabrique le déclare, les tests d'autres règles n'ont pas à s'en soucier.
    base = {"action": "buy", "symbol": "NESN.SW", "qty": 20, "stop": 95.0,
            "target": 130.0, "thesis": THESIS, "setup": "breakout",
            "horizon_days": 3, "invalidation": INVALIDATION}
    base.update(over)
    return base


# --------------------------------------------------------------------------- #
# Constantes — le contrat que les tâches 2 à 4 consomment
# --------------------------------------------------------------------------- #

def test_tradable_now_treats_a_naive_timestamp_as_local_rome(tmp_path=None):
    """VECU (31/08 14:00) : le coach a shorte UAL a 14:00 heure de Rome, NYSE
    fermee — le naif etait relu comme UTC puis reconverti (+2 h fantomes).
    Convention maison (LOT 4) : un horodatage NAIF est DEJA en heure locale."""
    assert coach_trader.tradable_now("UAL", "2026-08-31T14:00:30") is False
    assert coach_trader.tradable_now("UAL", "2026-08-31T16:00:00") is True
    assert coach_trader.tradable_now("UAL", "2026-08-31T21:56:00") is False
    assert coach_trader.tradable_now("NESN.SW", "2026-08-31T10:00:00") is True
    assert coach_trader.tradable_now("NESN.SW", "2026-08-31T14:05:00") is True
    assert coach_trader.tradable_now("NESN.SW", "2026-08-31T17:30:00") is False


def test_tradable_now_converts_an_aware_timestamp_properly():
    """Un horodatage AWARE, lui, se convertit : 12:00 UTC = 14:00 Rome (ferme
    pour les US), 14:00 UTC = 16:00 Rome (ouvert)."""
    assert coach_trader.tradable_now("UAL", "2026-08-31T12:00:00+00:00") is False
    assert coach_trader.tradable_now("UAL", "2026-08-31T14:00:00+00:00") is True


def test_constants_are_the_announced_contract():
    assert coach_trader.COACH_USERNAME == "coach"
    assert coach_trader.COACH_CAPITAL == 10000.0
    assert coach_trader.ACTIONS_MARKER == "COACH_ACTIONS"
    assert coach_trader.ACTION_KINDS == ("buy", "short", "sell", "reduce",
                                         "cover", "adjust_stop",
                                         "cancel_pending")
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
        # LOT 9 — les EMBUSCADES : forme de l'ordre, niveau d'armement, cap,
        # risque cumulé des pièges, annulation d'un piège inexistant.
        "bad_kind", "bad_trigger", "too_many_pending", "pending_risk_high",
        "no_pending",
        # LOT 12 — la conscience des frais.
        "fee_ratio", "stop_in_noise",
        # LOT 13 — le regime IBKR : l'objectif obligatoire, l'esperance NETTE,
        # et le rachat plus cher de ce qu'on vient de perdre.
        "no_target", "edge_thin", "whipsaw",
        # LOT 15 — le contrat de thèse : absent, ou échéance trop proche.
        "no_horizon", "thesis_expiring",
        # LOT 15 avait ajouté ``no_exit_reason`` (une sortie qui ne dit pas
        # pourquoi) ; LOT 16 l'a RETIRÉ — inversion DÉLIBÉRÉE, doctrine
        # Massii « Menace = tire seul » : une sortie ne se refuse plus pour
        # un défaut de forme, elle se MESURE (cf. coach_trader.py).
    }
    assert set(coach_trader.REJECT_CODES) == expected
    assert len(coach_trader.REJECT_CODES) == 30


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
        {"action": "cover", "exit_reason": "risk", "symbol": "NESN.SW", "qty": 1}, _pf(),
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
    out = coach_trader.gate_decision({"action": "reduce", "exit_reason": "risk", "symbol": "NESN.SW"},
                                     pf, _quote())
    assert out["reason"] == "bad_qty"


def test_gate_rejects_garbage_qty_on_sell_too():
    """« tout solder » c'est une qty ABSENTE, pas une qty illisible."""
    pf = _pf(positions=[_pos("NESN.SW", qty=10, avg_price=100.0)])
    out = coach_trader.gate_decision({"action": "sell", "exit_reason": "risk", "symbol": "NESN.SW",
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
    out = coach_trader.gate_decision(_buy(symbol="NESN.SW", qty=20, stop=95.0),
                                     _pf(positions=held), _quote(100.0))
    assert out["accepted"] is True


def test_gate_rejects_a_third_crypto():
    held = [_pos("BTC-USD"), _pos("ETH-USD")]
    out = coach_trader.gate_decision(_buy(symbol="SOL-USD", qty=20, stop=99.0),
                                     _pf(positions=held), _quote(100.0))
    assert out["reason"] == "too_many_crypto"


def test_two_cryptos_still_pass():
    held = [_pos("BTC-USD")]
    out = coach_trader.gate_decision(_buy(symbol="ETH-USD", qty=20, stop=95.0),
                                     _pf(positions=held), _quote(100.0))
    assert out["accepted"] is True


def test_gate_rejects_when_the_cash_floor_would_break():
    # équité 10 000 (1000 de cash + 9000 investis) ; 11 x 100 = 1100 > le cash.
    pf = _pf(cash=1000.0, positions=[_pos("ABBN.SW", qty=90, avg_price=100.0)])
    out = coach_trader.gate_decision(_buy(symbol="NESN.SW", qty=11, stop=99.0),
                                     pf, _quote(100.0))
    assert out["reason"] == "cash_floor"


def test_gate_rejects_a_sell_without_position():
    out = coach_trader.gate_decision({"action": "sell", "exit_reason": "risk", "symbol": "NESN.SW", "qty": 5},
                                     _pf(), _quote())
    assert out["reason"] == "no_position"


def test_gate_rejects_a_sell_larger_than_the_position():
    pf = _pf(positions=[_pos("NESN.SW", qty=5, avg_price=100.0)])
    out = coach_trader.gate_decision({"action": "sell", "exit_reason": "risk", "symbol": "NESN.SW", "qty": 10},
                                     pf, _quote(100.0))
    assert out["reason"] == "qty_over_position"


def test_a_short_line_is_not_a_sellable_position():
    """Aucun short dans ce lot : une ligne ``short`` ne se solde pas par ici."""
    pf = _pf(positions=[_pos("NESN.SW", qty=5, avg_price=100.0, side="short")])
    out = coach_trader.gate_decision({"action": "sell", "exit_reason": "risk", "symbol": "NESN.SW", "qty": 1},
                                     pf, _quote(100.0))
    assert out["reason"] == "no_position"


# --------------------------------------------------------------------------- #
# gate_decision — LOT 12 : la conscience des frais
#
# Profil par défaut du portefeuille de test = Yuh (``models.DEFAULT_FEE_
# PROFILE``). Avec qty=20, price=100 (notional 2000 CHF, bien au-dessus du
# plancher de courtage de 1 CHF), ``round_trip_pct`` vaut EXACTEMENT 1,15 %
# sur un titre suisse (NESN.SW) quel que soit le prix exact utilisé tant que
# le notional reste assez grand — le modèle Yuh est un pourcentage pur au-
# dessus du plancher. Plancher de bruit sans ATR = 2 x 1,15 = 2,3 % ;
# plancher fee_ratio = 3 x 1,15 = 3,45 %.
# --------------------------------------------------------------------------- #

def test_gate_rejects_an_entry_whose_target_does_not_clear_three_times_the_fees():
    """Objectif à 2 % de l'entrée — sous le plancher de 3,45 %."""
    out = coach_trader.gate_decision(_buy(qty=20, stop=95.0, target=102.0),
                                     _pf(), _quote(100.0))
    assert out["accepted"] is False
    assert out["reason"] == "fee_ratio"
    assert out["order"] is None


def test_gate_accepts_an_entry_whose_target_clears_three_times_the_fees():
    """Objectif à 12 % de l'entrée — au-dessus du plancher de 3,45 %.

    ⚠️ LOT 13 : ce test visait 4 % à l'origine. Un objectif à 4 % passe encore
    ``fee_ratio``, mais plus l'espérance NETTE — et c'est VOULU : au profil
    Yuh (1,15 % l'aller-retour), un objectif à 4 % avec un stop qui respire le
    bruit (2,3 % minimum) rend (4 - 1,15)/(2,3 + 1,15) = 0,83, sous le seuil de
    1,5. Autrement dit : au tarif Yuh, un 4 % n'était pas un trade. Pour tester
    ``fee_ratio`` SEUL il faut donc un objectif qui survive aussi au contrôle
    suivant."""
    out = coach_trader.gate_decision(_buy(qty=20, stop=95.0, target=112.0),
                                     _pf(), _quote(100.0))
    assert out["accepted"] is True


def test_gate_rejects_an_entry_without_a_target():
    """LOT 13 — CONTRAT INVERSÉ. Jusqu'ici, une entrée sans objectif passait :
    ``fee_ratio`` était conditionné par la présence du ``target``, donc omettre
    l'objectif DÉSARMAIT tout contrôle économique. C'était l'échappatoire la
    plus large de la porte — désormais une entrée SANS objectif est refusée."""
    decision = _buy(qty=20, stop=90.0)
    decision.pop("target")
    out = coach_trader.gate_decision(decision, _pf(), _quote(100.0))
    assert out["accepted"] is False
    assert out["reason"] == "no_target"


def test_gate_rejects_an_initial_stop_stuck_in_the_noise():
    """Stop à 1 % de l'entrée, sous le plancher de 2,3 % — refusé même si le
    reste de l'ordre est sain (objectif large)."""
    out = coach_trader.gate_decision(
        _buy(qty=20, stop=99.0, target=140.0), _pf(), _quote(100.0))
    assert out["accepted"] is False
    assert out["reason"] == "stop_in_noise"


def test_gate_accepts_an_initial_stop_wide_enough():
    """Stop à 5 % de l'entrée — au-dessus du plancher de 2,3 %."""
    out = coach_trader.gate_decision(
        _buy(qty=20, stop=95.0, target=140.0), _pf(), _quote(100.0))
    assert out["accepted"] is True


def test_gate_uses_two_times_fees_only_when_no_atr_is_available():
    """Sans contexte technique (pas d'ATR) : le plancher est 2x les frais,
    RIEN d'autre — un stop à 2 % (sous 2,3 %) est refusé."""
    out = coach_trader.gate_decision(
        _buy(qty=20, stop=98.0, target=140.0), _pf(), _quote(100.0))
    assert out["accepted"] is False
    assert out["reason"] == "stop_in_noise"


def test_gate_rejects_an_adjust_stop_tightened_into_the_noise():
    """``adjust_stop`` : resserrer à 0,5 % du cours, sous le plancher de
    2,3 %, sans qu'aucun gain ne soit déjà acquis (cours == prix de revient)."""
    pf = _pf(positions=[_pos("NESN.SW", qty=20, avg_price=100.0)])
    out = coach_trader.gate_decision(
        {"action": "adjust_stop", "symbol": "NESN.SW", "stop": 99.5},
        pf, _quote(100.0))
    assert out["accepted"] is False
    assert out["reason"] == "stop_in_noise"


def test_gate_accepts_an_adjust_stop_that_locks_in_a_gain_past_three_times_the_fees():
    """Le cours a grimpé de 10 % (>> 3 x 1,15 %) : resserrer le stop tout
    près du cours protège un gain DÉJÀ ACQUIS, pas du bruit — l'exception
    du LOT 12 s'applique malgré une distance de moins de 1 %."""
    pf = _pf(positions=[_pos("NESN.SW", qty=20, avg_price=100.0)])
    out = coach_trader.gate_decision(
        {"action": "adjust_stop", "symbol": "NESN.SW", "stop": 109.0},
        pf, _quote(110.0))
    assert out["accepted"] is True


def test_gate_accepts_an_adjust_stop_far_enough_without_a_gain():
    """Sans gain acquis (cours == prix de revient), un stop à 3 % passe
    quand même — il est simplement au-dessus du plancher de bruit."""
    pf = _pf(positions=[_pos("NESN.SW", qty=20, avg_price=100.0)])
    out = coach_trader.gate_decision(
        {"action": "adjust_stop", "symbol": "NESN.SW", "stop": 97.0},
        pf, _quote(100.0))
    assert out["accepted"] is True


def test_gate_widens_the_noise_floor_with_a_large_atr():
    """Un ATR large (5 % du cours -> plancher 0,5x = 2,5 %) est PLUS EXIGEANT
    que le plancher de frais seul (2,3 %) : un stop à 2,4 % passerait sur les
    frais seuls, il est refusé une fois l'ATR pris en compte."""
    technical = {"atr14_pct": 5.0}
    out = coach_trader.gate_decision(
        _buy(qty=20, stop=97.6, target=140.0), _pf(), _quote(100.0),
        technical=technical)
    assert out["accepted"] is False
    assert out["reason"] == "stop_in_noise"


def test_gate_accepts_a_stop_beyond_half_the_atr():
    # LOT 15 — une entrée porte un horizon (3 j dans la fabrique) : son
    # plancher est 0,8 x √3 = 1,39 ATR = 6,9 %, plus seulement 1 ATR. Le stop
    # passe donc à 7 % (il était à 6 %, au-delà du seul ATR).
    technical = {"atr14_pct": 5.0}
    out = coach_trader.gate_decision(
        _buy(qty=20, stop=93.0, target=140.0), _pf(), _quote(100.0),
        technical=technical)
    assert out["accepted"] is True


# --------------------------------------------------------------------------- #
# gate_decision — LOT 13 : le régime IBKR
#
# Le compte du coach quitte Yuh (1,30 % l'aller-retour) pour IBKR (0,05 %/côté,
# pas de droit de timbre). Trois conséquences mesurées sur les 19 trades réels
# du compte, et trois garde-fous :
#
#   1. le PLANCHER DE BRUIT ne doit pas s'effondrer avec les frais. Il valait
#      ``max(2 x aller-retour, 0,5 x ATR)`` : à 1,30 % le terme frais dominait
#      (2,6 %), à 0,10 % il ne vaut plus rien (0,2 %) et il ne resterait qu'un
#      DEMI-ATR — or les stops à ~1 ATR du coach se sont TOUS fait toucher.
#      -> coefficient ATR porté à 1,0 et plancher ABSOLU de 1 %.
#   2. une ENTRÉE SANS OBJECTIF ne peut plus passer (``no_target``) : c'était
#      l'échappatoire qui désarmait tout contrôle économique.
#   3. l'ESPÉRANCE NETTE DE FRAIS devient une règle (``edge_thin``), et on ne
#      rachète plus plus cher ce qu'on vient de perdre (``whipsaw``).
#
# Barème utile ici : IBKR rend EXACTEMENT 0,10 % l'aller-retour dès 3000 CHF de
# notional (en dessous, le minimum de 1,50 CHF par côté domine) — d'où les
# qty=30 à 100 CHF de ces tests. Yuh reste à 1,15 % sur un titre suisse.
# --------------------------------------------------------------------------- #

def _ibkr(**over):
    """Le portefeuille du coach au NOUVEAU profil de frais."""
    return _pf(fee_profile="ibkr", **over)


# --- 1a. le plancher de bruit, en unitaire -------------------------------- #

def test_le_plancher_de_bruit_vaut_un_ATR_ENTIER_et_non_la_moitie():
    """Un stop à un demi-ATR se fait toucher par la respiration ordinaire du
    titre : c'est l'ATR ENTIER qui borne le bruit."""
    assert coach_trader._noise_floor_pct(0.10, 5.0) == 5.0


def test_le_plancher_de_bruit_ne_descend_jamais_sous_un_pour_cent():
    """Sans ATR et au tarif IBKR, le terme frais seul vaudrait 0,2 % — un stop
    collé au cours. Le plancher ABSOLU de 1 % l'en empêche."""
    assert coach_trader._noise_floor_pct(0.10, None) == 1.0


def test_le_plancher_de_bruit_reste_deux_fois_les_frais_quand_ils_dominent():
    """Au tarif Yuh le terme frais (2,3 %) bat le plancher absolu : rien ne
    change pour l'ancien profil."""
    assert coach_trader._noise_floor_pct(1.15, None) == 2.3


# --- 1b. le plancher de bruit, dans la porte ------------------------------ #

def test_avec_ibkr_un_stop_sous_un_pour_cent_tombe_dans_le_bruit():
    """Stop à 0,8 % : accepté si le plancher n'était que 2 x 0,10 %, refusé
    par le plancher absolu."""
    out = coach_trader.gate_decision(
        _buy(qty=30, stop=99.2, target=140.0), _ibkr(), _quote(100.0))
    assert out["accepted"] is False
    assert out["reason"] == "stop_in_noise"


def test_avec_ibkr_un_stop_au_dela_d_un_pour_cent_passe():
    out = coach_trader.gate_decision(
        _buy(qty=30, stop=98.5, target=140.0), _ibkr(), _quote(100.0))
    assert out["accepted"] is True


def test_un_ATR_entier_refuse_ce_qu_un_demi_ATR_acceptait():
    """ATR 5 % : l'ancien plancher (0,5 x ATR = 2,5 %) acceptait un stop à 4 %,
    le nouveau (1 x ATR = 5 %) le refuse. C'est LE changement du lot."""
    out = coach_trader.gate_decision(
        _buy(qty=30, stop=96.0, target=140.0), _ibkr(), _quote(100.0),
        technical={"atr14_pct": 5.0})
    assert out["accepted"] is False
    assert out["reason"] == "stop_in_noise"


def test_un_stop_au_dela_d_un_ATR_entier_passe():
    # LOT 15 — avec l'horizon minimal (3 j) le plancher d'une ENTRÉE est
    # 0,8 x √3 = 1,39 ATR (6,9 %) : le stop passe de 6 à 7 %, et la taille de
    # 30 à 28 pour garder le risque sous 2 % (196 CHF).
    out = coach_trader.gate_decision(
        _buy(qty=28, stop=93.0, target=140.0), _ibkr(), _quote(100.0),
        technical={"atr14_pct": 5.0})
    assert out["accepted"] is True


# --- 2. l'exception « gain déjà acquis » suit le même plancher ------------ #

def test_l_exception_du_gain_acquis_suit_le_plancher_de_bruit():
    """Gain acquis de 0,5 % : au tarif IBKR, 3 x l'aller-retour ne vaut que
    0,3 % — une erreur d'arrondi suffirait à rouvrir les stops collés. Le seuil
    de dérogation ne descend donc jamais sous le plancher de bruit (1 %)."""
    pf = _ibkr(positions=[_pos("NESN.SW", qty=30, avg_price=100.0)])
    out = coach_trader.gate_decision(
        {"action": "adjust_stop", "symbol": "NESN.SW", "stop": 100.4},
        pf, _quote(100.5))
    assert out["accepted"] is False
    assert out["reason"] == "stop_in_noise"


def test_l_exception_du_gain_acquis_joue_des_que_le_plancher_est_encaisse():
    """Gain acquis de 1,5 %, au-dessus du plancher : le stop protège du
    RÉALISÉ, il n'a plus à respirer le bruit — « laisse courir les gagnants »
    reste tenable."""
    pf = _ibkr(positions=[_pos("NESN.SW", qty=30, avg_price=100.0)])
    out = coach_trader.gate_decision(
        {"action": "adjust_stop", "symbol": "NESN.SW", "stop": 101.4},
        pf, _quote(101.5))
    assert out["accepted"] is True


# --- 3. une ENTRÉE sans objectif est refusée ------------------------------ #

def test_une_embuscade_sans_objectif_est_refusee():
    """Une embuscade est une ENTRÉE : elle doit porter son objectif comme les
    autres, sinon elle partirait la nuit sans qu'aucune économie soit jugée."""
    piege = _buy(qty=20, stop=104.0, kind="stop", trigger=110.0)
    piege.pop("target")
    out = coach_trader.gate_decision(piege, _pf(), _quote(100.0))
    assert out["reason"] == "no_target"


def test_un_objectif_illisible_vaut_absence_d_objectif():
    out = coach_trader.gate_decision(_buy(qty=20, stop=95.0, target="bientôt"),
                                     _pf(), _quote(100.0))
    assert out["reason"] == "no_target"


def test_un_objectif_nul_vaut_absence_d_objectif():
    out = coach_trader.gate_decision(_buy(qty=20, stop=95.0, target=0.0),
                                     _pf(), _quote(100.0))
    assert out["reason"] == "no_target"


def test_une_SORTIE_n_a_pas_besoin_d_objectif():
    """Une sortie réduit l'exposition : rien à espérer, rien à mesurer."""
    pf = _pf(positions=[_pos("NESN.SW", qty=10, avg_price=100.0)])
    out = coach_trader.gate_decision(
        {"action": "sell", "exit_reason": "risk", "symbol": "NESN.SW", "qty": 10}, pf, _quote(100.0))
    assert out["accepted"] is True


def test_ajuster_un_stop_n_exige_pas_d_objectif():
    pf = _pf(positions=[_pos("NESN.SW", qty=20, avg_price=100.0)])
    out = coach_trader.gate_decision(
        {"action": "adjust_stop", "symbol": "NESN.SW", "stop": 95.0},
        pf, _quote(100.0))
    assert out["accepted"] is True


# --- 4. l'espérance NETTE de frais ---------------------------------------- #

def test_edge_thin_refuse_un_rapport_net_sous_un_et_demi():
    """Entrée 100, stop 97, objectif 103 au tarif IBKR (0,10 %) :
    (3 - 0,1) / (3 + 0,1) = 0,94 — sous 1,5, ce n'est pas un trade."""
    out = coach_trader.gate_decision(
        _buy(qty=30, stop=97.0, target=103.0), _ibkr(), _quote(100.0))
    assert out["accepted"] is False
    assert out["reason"] == "edge_thin"
    assert out["order"] is None


def test_edge_thin_laisse_passer_un_rapport_net_au_dessus_d_un_et_demi():
    """Même entrée, même stop, objectif 106 : (6 - 0,1)/(3,1) = 1,90."""
    out = coach_trader.gate_decision(
        _buy(qty=30, stop=97.0, target=106.0), _ibkr(), _quote(100.0))
    assert out["accepted"] is True


def test_edge_thin_compte_l_aller_retour_DEUX_fois():
    """Le cœur du calcul : au tarif Yuh, un R:R BRUT de 1,55 (gain 6,2 % pour
    un risque de 4 %) tombe à 0,98 une fois l'aller-retour compté — il ampute
    le gain ET s'ajoute à la perte. ``risk.preorder_warnings`` n'aurait ici
    rien signalé (son ``reward_risk_below_1`` regarde le BRUT), et 8 des 19
    trades perdants du compte portaient exactement ce profil."""
    out = coach_trader.gate_decision(
        _buy(qty=20, stop=96.0, target=106.2), _pf(), _quote(100.0))
    assert out["accepted"] is False
    assert out["reason"] == "edge_thin"


def test_edge_thin_arrive_APRES_fee_ratio():
    """Ordre déterministe : un objectif qui ne couvre même pas 3 x les frais
    est nommé ``fee_ratio``, le motif le plus grossier d'abord."""
    out = coach_trader.gate_decision(
        _buy(qty=30, stop=97.0, target=100.1), _ibkr(), _quote(100.0))
    assert out["reason"] == "fee_ratio"


def test_edge_thin_arrive_AVANT_stop_in_noise():
    """Un ordre à la fois sans espérance ET au stop collé est nommé
    ``edge_thin`` : l'économie du trade prime sur la mécanique du stop."""
    out = coach_trader.gate_decision(
        _buy(qty=30, stop=99.5, target=100.6), _ibkr(), _quote(100.0))
    assert out["reason"] == "edge_thin"


def test_edge_thin_ne_concerne_pas_les_sorties():
    pf = _ibkr(positions=[_pos("NESN.SW", qty=10, avg_price=100.0)])
    out = coach_trader.gate_decision(
        {"action": "sell", "exit_reason": "risk", "symbol": "NESN.SW", "qty": 10}, pf, _quote(100.0))
    assert out["accepted"] is True


def test_l_embuscade_mesure_son_esperance_depuis_le_TRIGGER():
    """Piège armé à 110 sur un cours de 100, stop 106,5, objectif 116 : mesuré
    depuis le TRIGGER le rapport net vaut (5,45 - 0,1)/(3,18 + 0,1) = 1,63 et
    passe ; mesuré depuis le cours il aurait été absurde (16 % de gain pour
    6,5 % de risque)."""
    out = coach_trader.gate_decision(
        _buy(qty=27, stop=106.5, target=116.0, kind="stop", trigger=110.0),
        _ibkr(), _quote(100.0))
    assert out["accepted"] is True


def test_l_embuscade_refuse_une_esperance_mince_mesuree_au_TRIGGER():
    """Le même piège avec un objectif à 113 : (2,73 - 0,1)/(3,18 + 0,1) = 0,80
    — refusé, alors qu'un calcul fait depuis le cours de 100 l'aurait cru
    généreux (13 % de gain)."""
    out = coach_trader.gate_decision(
        _buy(qty=27, stop=106.5, target=113.0, kind="stop", trigger=110.0),
        _ibkr(), _quote(100.0))
    assert out["reason"] == "edge_thin"


# --- 5. anti-whipsaw ------------------------------------------------------ #
#
# Vécu : 4 re-entrées sur un titre qu'on venait de perdre, dont 2 RACHETÉES
# PLUS CHER que la sortie (GM, PINS) et une le jour même (FRO, 3,3 % au-dessus
# de son propre stop). Les délais réels : J+0, J+3, J+3 et J+4 — d'où les 5
# jours INCLUSIFS de :data:`coach_trader.WHIPSAW_DAYS` (à 3 jours stricts, la
# règle n'aurait attrapé qu'un cas sur quatre).

WED_NOW = "2026-09-16T15:00:00"        # mercredi 15:00 Rome — SIX ouverte


def _trade(symbol="NESN.SW", side="long", exit_price=100.0, pnl_chf=-120.0,
          exit_at="2026-09-14T16:00:00"):
    return {"symbol": symbol, "side": side, "qty": 20,
            "entry_price": 105.0, "exit_price": exit_price,
            "entry_at": "2026-09-10T10:00:00", "exit_at": exit_at,
            "pnl_chf": pnl_chf, "pnl_pct": -4.8, "exit_reason": "stop"}


def test_whipsaw_refuse_de_racheter_PLUS_CHER_ce_qu_on_vient_de_perdre():
    """Sorti à 100 sur un stop il y a deux jours, on rachète à 102 : c'est le
    scénario GM/PINS, payé deux fois le courtier pour la même idée."""
    pf = _ibkr(trades=[_trade(exit_price=100.0)])
    out = coach_trader.gate_decision(
        _buy(qty=29, stop=98.0, target=110.0), pf, _quote(102.0), now=WED_NOW)
    assert out["accepted"] is False
    assert out["reason"] == "whipsaw"


def test_whipsaw_laisse_passer_un_rachat_MOINS_CHER():
    """Re-rentrer à un prix MEILLEUR après un stop est une décision légitime :
    la thèse est la même, le point d'entrée est meilleur."""
    pf = _ibkr(trades=[_trade(exit_price=100.0)])
    out = coach_trader.gate_decision(
        _buy(qty=30, stop=94.0, target=106.0), pf, _quote(97.0), now=WED_NOW)
    assert out["accepted"] is True


def test_whipsaw_ne_vise_pas_l_AUTRE_sens():
    """Perdre un long puis shorter le titre n'est pas un whipsaw : c'est un
    changement d'avis, et il a le droit de se jouer."""
    pf = _ibkr(trades=[_trade(side="long", exit_price=100.0)])
    out = coach_trader.gate_decision(
        {"action": "short", "symbol": "NESN.SW", "qty": 29, "stop": 105.0,
         "target": 94.0, "thesis": THESIS, **CONTRACT},
        pf, _quote(102.0), now=WED_NOW)
    assert out["accepted"] is True


def test_whipsaw_ne_vise_pas_un_trade_GAGNANT():
    """Re-rentrer plus cher sur un titre qu'on vient de gagner, c'est suivre
    une tendance — l'inverse exact du whipsaw."""
    pf = _ibkr(trades=[_trade(exit_price=100.0, pnl_chf=250.0)])
    out = coach_trader.gate_decision(
        _buy(qty=29, stop=98.0, target=110.0), pf, _quote(102.0), now=WED_NOW)
    assert out["accepted"] is True


def test_whipsaw_refuse_ENCORE_a_J_plus_5():
    """La borne est INCLUSIVE : les re-entrées réelles allaient jusqu'à J+4,
    une règle qui s'arrêterait avant serait cosmétique."""
    pf = _ibkr(trades=[_trade(exit_at="2026-09-11T16:00:00")])
    out = coach_trader.gate_decision(
        _buy(qty=29, stop=98.0, target=110.0), pf, _quote(102.0), now=WED_NOW)
    assert out["reason"] == "whipsaw"


def test_whipsaw_laisse_passer_a_J_plus_6():
    """Au-delà, l'idée a eu le temps de redevenir une idée neuve."""
    pf = _ibkr(trades=[_trade(exit_at="2026-09-10T16:00:00")])
    out = coach_trader.gate_decision(
        _buy(qty=29, stop=98.0, target=110.0), pf, _quote(102.0), now=WED_NOW)
    assert out["accepted"] is True


def test_whipsaw_refuse_le_rachat_LE_JOUR_MEME():
    """Le cas FRO : sorti le matin, racheté l'après-midi au-dessus de son
    propre stop."""
    pf = _ibkr(trades=[_trade(exit_at="2026-09-16T09:30:00")])
    out = coach_trader.gate_decision(
        _buy(qty=29, stop=98.0, target=110.0), pf, _quote(102.0), now=WED_NOW)
    assert out["reason"] == "whipsaw"


def test_whipsaw_ne_regarde_que_le_DERNIER_trade_clos():
    """Deux passages sur le titre : c'est le plus RÉCENT qui décide. Ici le
    dernier fut gagnant — l'ancienne perte ne bloque plus rien."""
    pf = _ibkr(trades=[
        _trade(exit_at="2026-09-14T16:00:00", exit_price=100.0),
        _trade(exit_at="2026-09-15T16:00:00", exit_price=101.0,
               pnl_chf=180.0),
    ])
    out = coach_trader.gate_decision(
        _buy(qty=29, stop=98.0, target=110.0), pf, _quote(102.0), now=WED_NOW)
    assert out["accepted"] is True


def test_whipsaw_ignore_les_trades_d_un_AUTRE_symbole():
    pf = _ibkr(trades=[_trade(symbol="AAPL", exit_price=100.0)])
    out = coach_trader.gate_decision(
        _buy(qty=29, stop=98.0, target=110.0), pf, _quote(102.0), now=WED_NOW)
    assert out["accepted"] is True


def test_whipsaw_ne_se_prononce_pas_SANS_horloge():
    """``now`` est optionnel dans cette porte (cf. ``market_closed``) : sans
    horloge on ne DEVINE pas une date, on saute le contrôle."""
    pf = _ibkr(trades=[_trade(exit_price=100.0)])
    out = coach_trader.gate_decision(
        _buy(qty=29, stop=98.0, target=110.0), pf, _quote(102.0))
    assert out["accepted"] is True


def test_whipsaw_ignore_un_horodatage_de_sortie_illisible():
    """Un ``exit_at`` vide ne doit pas se lire « maintenant » : sans date, pas
    de délai, donc pas de whipsaw (et surtout pas de refus inventé)."""
    pf = _ibkr(trades=[_trade(exit_at="")])
    out = coach_trader.gate_decision(
        _buy(qty=29, stop=98.0, target=110.0), pf, _quote(102.0), now=WED_NOW)
    assert out["accepted"] is True


def test_whipsaw_pour_un_SHORT_refuse_une_re_entree_PLUS_BAS():
    """Miroir : un short se dégrade quand on le rouvre PLUS BAS, puisque la
    chute restante est plus courte."""
    pf = _ibkr(trades=[_trade(side="short", exit_price=100.0)])
    out = coach_trader.gate_decision(
        {"action": "short", "symbol": "NESN.SW", "qty": 30, "stop": 102.0,
         "target": 90.0, "thesis": THESIS, **CONTRACT},
        pf, _quote(98.0), now=WED_NOW)
    assert out["reason"] == "whipsaw"


def test_whipsaw_laisse_passer_un_SHORT_rouvert_PLUS_HAUT():
    pf = _ibkr(trades=[_trade(side="short", exit_price=100.0)])
    out = coach_trader.gate_decision(
        {"action": "short", "symbol": "NESN.SW", "qty": 28, "stop": 107.0,
         "target": 94.0, "thesis": THESIS, **CONTRACT},
        pf, _quote(104.0), now=WED_NOW)
    assert out["accepted"] is True


def test_whipsaw_mesure_une_embuscade_a_son_TRIGGER():
    """Un piège armé AU-DESSUS du prix de sortie perdant est un whipsaw
    programmé : c'est le trigger qui sera payé, pas le cours d'aujourd'hui."""
    pf = _ibkr(trades=[_trade(exit_price=100.0)])
    out = coach_trader.gate_decision(
        _buy(qty=29, stop=98.5, target=112.0, kind="stop", trigger=102.0),
        pf, _quote(99.0), now=WED_NOW)
    assert out["reason"] == "whipsaw"


# --- 6. le détail chiffré des trois nouveaux refus ------------------------ #

def test_le_detail_de_no_target_dit_ce_qui_manque():
    detail = coach_trader.reject_detail("no_target", _buy(qty=30, stop=97.0),
                                        _pf(), _quote(100.0))
    assert detail is not None
    assert "objectif" in detail.lower()


def test_le_detail_de_edge_thin_chiffre_le_rapport_net():
    detail = coach_trader.reject_detail(
        "edge_thin", _buy(qty=30, stop=97.0, target=103.0),
        _ibkr(), _quote(100.0))
    assert detail is not None
    assert "0,94" in detail or "0.94" in detail
    assert "1,5" in detail or "1.5" in detail


def test_le_detail_de_whipsaw_nomme_la_sortie_precedente():
    pf = _ibkr(trades=[_trade(exit_price=100.0)])
    detail = coach_trader.reject_detail(
        "whipsaw", _buy(qty=29, stop=98.0, target=110.0), pf, _quote(102.0),
        now=WED_NOW)
    assert detail is not None
    assert "100" in detail and "102" in detail


def test_le_detail_se_tait_sur_un_code_qui_n_est_pas_a_lui():
    """``reject_detail`` ne couvre QUE les trois codes du lot : les autres
    restent la responsabilité du routeur, qui les chiffre déjà."""
    assert coach_trader.reject_detail("oversize", _buy(), _pf(),
                                      _quote(100.0)) is None


def test_le_detail_ne_leve_JAMAIS_sur_une_decision_illisible():
    """Un détail illisible ne doit jamais empêcher le refus d'être consigné."""
    assert coach_trader.reject_detail("edge_thin", {"target": "x"},
                                      None, None) is None


# --------------------------------------------------------------------------- #
# gate_decision — les acceptations
# --------------------------------------------------------------------------- #

def test_gate_accepts_a_nominal_buy():
    out = coach_trader.gate_decision(_buy(), _pf(), _quote(100.0))
    assert out["accepted"] is True
    assert out["reason"] is None
    assert out["order"] == {
        "symbol": "NESN.SW", "side": "buy", "kind": "market", "qty": 20,
        # LOT 9 — la forme de l'ordre voyage désormais dans le plan :
        # ``market`` (immédiat) ou ``stop`` (EMBUSCADE armée sur ``trigger``).
        "trigger": None,
        "thesis": THESIS, "stop_loss": 95.0, "target": 130.0,
        "setup": "breakout", "emotion": "calme",
        # LOT 15 — le contrat de thèse voyage avec l'ordre ; sans horloge
        # (``now`` absent) l'échéance ne se date pas.
        "horizon_days": 3, "invalidation": INVALIDATION,
        "thesis_deadline": None,
        # LOT 15 — la raison d'une SORTIE ; une entrée n'en porte pas.
        "exit_reason": None,
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
    out = coach_trader.gate_decision({"action": "sell", "exit_reason": "risk", "symbol": "NESN.SW"},
                                     pf, _quote(100.0))
    assert out["accepted"] is True
    assert out["order"]["side"] == "sell"
    assert out["order"]["qty"] == 7


@pytest.mark.parametrize("qty", [None, 0, ""])
def test_a_blank_qty_on_sell_means_liquidate(qty):
    pf = _pf(positions=[_pos("NESN.SW", qty=7, avg_price=100.0)])
    out = coach_trader.gate_decision({"action": "sell", "exit_reason": "risk", "symbol": "NESN.SW", "qty": qty},
                                     pf, _quote(100.0))
    assert out["accepted"] is True
    assert out["order"]["qty"] == 7


def test_gate_accepts_a_partial_reduce():
    pf = _pf(positions=[_pos("NESN.SW", qty=7, avg_price=100.0)])
    out = coach_trader.gate_decision({"action": "reduce", "exit_reason": "risk", "symbol": "NESN.SW", "qty": 3},
                                     pf, _quote(100.0))
    assert out["accepted"] is True
    assert out["order"]["side"] == "sell"     # ``reduce`` s'exécute comme une vente
    assert out["order"]["qty"] == 3


def test_an_exit_needs_neither_thesis_nor_stop():
    """Une sortie réduit TOUJOURS l'exposition — même restriction que
    ``risk.preorder_warnings`` (qui ne s'applique qu'aux ouvertures)."""
    pf = _pf(positions=[_pos("NESN.SW", qty=7, avg_price=100.0)])
    out = coach_trader.gate_decision({"action": "sell", "exit_reason": "risk", "symbol": "NESN.SW", "qty": 2},
                                     pf, _quote(100.0))
    assert out["accepted"] is True
    assert out["order"]["thesis"] == ""
    assert out["order"]["stop_loss"] is None


def test_an_exit_ignores_the_position_count_and_the_cash_floor():
    """Sortir d'une 7e ligne quand la trésorerie est à sec doit passer."""
    held = [_pos("SYM%d" % i, qty=1, avg_price=100.0) for i in range(6)]
    held.append(_pos("NESN.SW", qty=5, avg_price=100.0))
    out = coach_trader.gate_decision({"action": "sell", "exit_reason": "risk", "symbol": "NESN.SW"},
                                     _pf(cash=0.0, positions=held), _quote(100.0))
    assert out["accepted"] is True


def test_the_gate_converts_with_the_rate_given_by_the_caller():
    """La conversion CHF est la responsabilité de l'APPELANT (même doctrine que
    ``risk.preorder_warnings``) : 20 x 100 USD x 0,90 = 1800 CHF, pas 2000."""
    out = coach_trader.gate_decision(_buy(qty=20, stop=95.0), _pf(),
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
    out = coach_trader.gate_decision(_buy(symbol="BTC-USD", qty=20, stop=95.0),
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
    out = coach_trader.gate_decision(_buy(qty=20, stop=95.0), pf, _quote(100.0))
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
    out = coach_trader.gate_decision({"action": "reduce", "exit_reason": "risk", "symbol": "NESN.SW", "qty": 2},
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
        ({"action": "sell", "exit_reason": "risk", "symbol": "NESN.SW", "qty": 1}, _pf(), _quote(100.0)),
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
        _digest('```COACH_ACTIONS\n[{"action": "sell", "exit_reason": "risk", "symbol": "NESN.SW"}]\n```'))
    assert out["error"] is None
    assert out["actions"] == [{"action": "sell", "exit_reason": "risk", "symbol": "NESN.SW"}]


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
              '{"actions": [{"action": "sell", "exit_reason": "risk", "symbol": "ZZZ"}]}\n```')
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
        _digest('```COACH_ACTIONS\n[{"action": "sell", "exit_reason": "risk", "symbol": "X"}]\n```'))
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


def test_pass_due_accepts_a_naive_now_as_local_rome():
    """Convention maison depuis le 31/08 : un naif est DEJA de l'heure locale
    (l'ancienne tolerance naif=UTC a fait shorter UAL a 14:00, NYSE fermee).
    pass_due garde son seuil legacy >=17h locale (l'ecran s'en sert) :
    15:00 locale -> pas due ; 18:00 locale -> due."""
    assert coach_trader.pass_due(datetime(2026, 8, 28, 15, 0), None) is False
    assert coach_trader.pass_due(datetime(2026, 8, 28, 18, 0), None) is True
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
    decision = {"action": "sell", "exit_reason": "risk", "symbol": "AAPL"}
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
    # REGIME SEPTEMBRE : 17h00 Rome tombe dans la fenetre du creneau 15:40
    # (non consomme dans ce test) — c'est LUI qui est retenu.
    assert out["slot"] == "15:40"


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
    out = _run_hook(now=WED_1545, guardian=guardian)
    assert out["slot"] == "15:40"
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
    """Régime septembre : TROIS créneaux, chacun tourne UNE fois — les
    moments intermédiaires (11:35, 14:05…) ne re-déclenchent pas un créneau
    déjà consommé."""
    pass_ = _Spy()
    slots = []
    for moment in (WED_0915, WED_1135, WED_1405, WED_1545,
                  WED_1705, WED_1835, WED_2005, WED_2145):
        out = _run_hook(now=moment, pass_=pass_)
        slots.append(out.get("slot"))
    assert len(pass_.calls) == coach_trader.PASSES_PER_DAY
    assert [s for s in slots if s] == ["09:10", "15:40", "21:40"]


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
    """Le créneau de 21h40 ne doit pas effacer la trace de celui de 15h40 :
    sinon l'état repartirait à zéro et 15h40 pourrait re-tourner."""
    _run_hook(now=WED_1545, pass_=_Spy())
    _run_hook(now=WED_2145, pass_=_Spy())
    assert set(coach_trader.load_state()["slots"]) == {"15:40", "21:40"}


# --------------------------------------------------------------------------- #
# LOT 9 — le RÉGIME DÉPLOYÉ : le déploiement CHIFFRÉ du livre (PUR)
# --------------------------------------------------------------------------- #

def test_deployment_view_livre_vide_est_100pct_cash():
    view = coach_trader.deployment_view(
        {"cash_chf": 10000.0, "positions": [], "initial_capital": 10000.0})
    assert view["cash_pct"] == 100.0
    assert view["n_positions"] == 0
    assert view["themes_ouverts"] == []


def test_deployment_view_compte_les_lignes_et_rend_les_theses():
    view = coach_trader.deployment_view({
        "cash_chf": 6000.0,
        "positions": [
            {"symbol": "DAL", "side": "short", "qty": 100, "avg_price": 40.0,
             "thesis": "hausse du kérosène après le blocage d'Ormuz"},
            {"symbol": "NESN.SW", "side": "long", "qty": 10, "avg_price": 100.0,
             "thesis": "défensive sur repli du marché"},
        ],
    })
    assert view["n_positions"] == 2
    # LOT 14b — mis à jour DÉLIBÉRÉMENT. L'ancienne convention (les deux sens
    # en valeur absolue : 6000 + 4000 + 1000 = 11000, 54,5 %) comptait la
    # dette de rachat du short comme un avoir. Équité NETTE du garde-fou :
    # 6000 + 1000 (long) − 4000 (short) = 3000 ; trésorerie LIBRE = 6000 −
    # 4000 de produit du short = 2000, soit 66,7 %.
    # arrondi à la décimale : ce chiffre se LIT dans un prompt.
    assert view["cash_pct"] == 66.7
    assert view["themes_ouverts"] == [
        "DAL (short) — hausse du kérosène après le blocage d'Ormuz",
        "NESN.SW (long) — défensive sur repli du marché",
    ]


def test_deployment_view_tronque_une_these_fleuve():
    longue = "a" * 400
    view = coach_trader.deployment_view(
        {"cash_chf": 1000.0,
         "positions": [{"symbol": "X", "side": "long", "qty": 1,
                        "avg_price": 10.0, "thesis": longue}]})
    theme = view["themes_ouverts"][0]
    assert len(theme) <= 140
    assert theme.startswith("X (long) — aaa")


def test_deployment_view_ne_leve_jamais_sur_une_entree_abimee():
    view = coach_trader.deployment_view({"cash_chf": "?", "positions": "nope"})
    assert view == {"cash_pct": 0.0, "n_positions": 0, "themes_ouverts": []}


def test_deployment_view_ligne_sans_these_reste_nommee():
    view = coach_trader.deployment_view(
        {"cash_chf": 500.0,
         "positions": [{"symbol": "AAPL", "side": "long", "qty": 5,
                        "avg_price": 100.0}]})
    assert view["themes_ouverts"] == ["AAPL (long) — (sans thèse écrite)"]


# --------------------------------------------------------------------------- #
# LOT 12 — fees_view : la saignée des frais, chiffrée sur 7 jours (PUR)
# --------------------------------------------------------------------------- #

def test_fees_view_sums_only_trades_closed_within_the_last_seven_days():
    now = "2026-09-06T12:00:00Z"
    pf = _pf(trades=[
        {"exit_at": "2026-09-05T10:00:00Z", "fees_chf": 10.0,
         "stamp_duty_chf": 2.0, "pnl_chf": -5.0},
        # 17 jours plus tôt : hors fenêtre, ignoré.
        {"exit_at": "2026-08-20T10:00:00Z", "fees_chf": 999.0,
         "stamp_duty_chf": 999.0, "pnl_chf": 999.0},
    ])
    view = coach_trader.fees_view(pf, now=now)
    assert view["fees_paid_7d_chf"] == 12.0
    assert view["net_pnl_7d_chf"] == -5.0
    assert view["gross_pnl_7d_chf"] == 7.0


def test_fees_view_sums_across_several_trades_in_the_window():
    now = "2026-09-06T12:00:00Z"
    pf = _pf(trades=[
        {"exit_at": "2026-09-05T10:00:00Z", "fees_chf": 10.0,
         "stamp_duty_chf": 2.0, "pnl_chf": -5.0},
        {"exit_at": "2026-09-01T10:00:00Z", "fees_chf": 20.0,
         "stamp_duty_chf": 3.0, "pnl_chf": 8.0},
    ])
    view = coach_trader.fees_view(pf, now=now)
    assert view["fees_paid_7d_chf"] == 35.0
    assert view["net_pnl_7d_chf"] == 3.0
    assert view["gross_pnl_7d_chf"] == 38.0


def test_fees_view_is_zero_without_any_trade():
    view = coach_trader.fees_view(_pf(), now="2026-09-06T12:00:00Z")
    assert view["fees_paid_7d_chf"] == 0.0
    assert view["gross_pnl_7d_chf"] == 0.0
    assert view["net_pnl_7d_chf"] == 0.0


def test_fees_view_round_trip_pct_uses_the_portfolio_fee_profile():
    """À la plus petite position autorisée (10 % de l'équité) : c'est là que
    le poids relatif des frais est le plus lourd, donc le chiffre le plus
    honnête à montrer. Aucun symbole précis pour ce chiffre générique -> taux
    de timbre ÉTRANGER (le plus pénalisant)."""
    pf = _pf(cash=10000.0, fee_profile="yuh")
    view = coach_trader.fees_view(pf, now="2026-09-06T12:00:00Z")
    expected = fees.round_trip_pct(
        "yuh", 10000.0 * coach_trader.MIN_POSITION_PCT / 100.0)
    assert view["round_trip_pct"] == expected


def test_fees_view_defaults_to_yuh_without_a_declared_profile():
    pf = _pf(cash=10000.0)
    assert "fee_profile" not in pf
    view = coach_trader.fees_view(pf, now="2026-09-06T12:00:00Z")
    assert view["round_trip_pct"] == fees.round_trip_pct(
        "yuh", 10000.0 * coach_trader.MIN_POSITION_PCT / 100.0)


def test_fees_view_never_raises_on_a_battered_portfolio():
    view = coach_trader.fees_view({"cash_chf": "?", "trades": "nope"},
                                  now="2026-09-06T12:00:00Z")
    assert view == {"fees_paid_7d_chf": 0.0, "gross_pnl_7d_chf": 0.0,
                    "net_pnl_7d_chf": 0.0, "round_trip_pct": 0.0}


def test_fees_view_exposes_exactly_four_keys():
    view = coach_trader.fees_view(_pf(), now="2026-09-06T12:00:00Z")
    assert set(view) == {"fees_paid_7d_chf", "gross_pnl_7d_chf",
                         "net_pnl_7d_chf", "round_trip_pct"}


# =========================================================================== #
# LOT 9 — LES ORDRES D'EMBUSCADE : l'entrée déclenchée par NIVEAU.
#
# Le vrai « ne plus attendre » : au lieu de guetter passivement « une clôture
# sous la SMA50 » à chaque passe, le coach ARME un ordre. Le moteur exécute à
# la minute où le niveau casse, nuit comprise.
#
# Le gate valide le plan COMPLET À L'ARMEMENT — un piège mal armé est refusé
# comme un ordre direct.
# =========================================================================== #

def _piege(**over):
    """Une embuscade LONGUE : « achète si ça casse 110 par le haut »."""
    base = {"action": "buy", "symbol": "NESN.SW", "qty": 20, "kind": "stop",
            "trigger": 110.0, "stop": 104.0, "target": 130.0,
            "thesis": THESIS, "setup": "breakout", **CONTRACT}
    base.update(over)
    return base


def _armee(symbol="AAPL", side="buy", trigger=110.0, qty=10,
           risk_chf=50.0, stop_loss=104.0):
    """Une embuscade DÉJÀ armée, telle qu'elle vit dans ``open_orders``."""
    return {"id": symbol.lower(), "symbol": symbol, "side": side,
            "kind": "stop", "qty": qty, "stop_price": trigger,
            "status": "open", "stop_loss": stop_loss, "risk_chf": risk_chf,
            "expires_at": "2026-09-07T12:00:00+00:00", "source": "daily"}


def test_les_nouvelles_constantes_des_embuscades():
    assert coach_trader.MAX_PENDING == 4
    assert coach_trader.MAX_PENDING_RISK_PCT == 4.0
    assert coach_trader.AMBUSH_MARKET_DAYS == 5
    assert "cancel_pending" in coach_trader.ACTION_KINDS


def test_les_cinq_codes_de_refus_des_embuscades_sont_declares():
    for code in ("bad_kind", "bad_trigger", "too_many_pending",
                 "pending_risk_high", "no_pending"):
        assert code in coach_trader.REJECT_CODES


# --- armement : le cas nominal -------------------------------------------- #

def test_une_embuscade_longue_bien_armee_passe():
    verdict = coach_trader.gate_decision(_piege(), _pf(), _quote(100.0))
    assert verdict["accepted"] is True
    order = verdict["order"]
    assert order["kind"] == "stop"
    assert order["trigger"] == 110.0
    assert order["side"] == "buy"
    assert order["stop_loss"] == 104.0


def test_une_embuscade_courte_bien_armee_passe():
    """« Shorte si ça casse 90 par le bas » — stop AU-DESSUS du trigger."""
    piege = _piege(action="short", trigger=90.0, stop=96.0, target=70.0)
    verdict = coach_trader.gate_decision(piege, _pf(), _quote(100.0))
    assert verdict["accepted"] is True
    assert verdict["order"]["side"] == "short"
    assert verdict["order"]["trigger"] == 90.0


def test_un_ordre_direct_reste_au_marche_et_sans_trigger():
    order = coach_trader.gate_decision(_buy(), _pf(), _quote(100.0))["order"]
    assert order["kind"] == "market"
    assert order["trigger"] is None


# --- armement : chaque refus ---------------------------------------------- #

def test_un_kind_invente_est_refuse_jamais_degrade_en_marche():
    """Doctrine du module : on REJETTE, on ne rogne pas en silence. Servir un
    ordre au marché à qui a demandé une limite serait exactement ça."""
    verdict = coach_trader.gate_decision(_piege(kind="limit"), _pf(),
                                         _quote(100.0))
    assert verdict == {"accepted": False, "reason": "bad_kind", "order": None}


def test_une_sortie_ne_s_arme_pas():
    decision = {"action": "sell", "exit_reason": "risk", "symbol": "NESN.SW", "qty": 5, "kind": "stop",
                "trigger": 90.0}
    verdict = coach_trader.gate_decision(decision, _pf(
        positions=[_pos("NESN.SW", qty=10, avg_price=100.0)]), _quote(100.0))
    assert verdict["reason"] == "bad_kind"


def test_une_embuscade_sans_trigger_est_refusee():
    verdict = coach_trader.gate_decision(_piege(trigger=None), _pf(),
                                         _quote(100.0))
    assert verdict["reason"] == "bad_trigger"


def test_une_embuscade_longue_armee_SOUS_le_cours_est_refusee():
    """Un piège du mauvais côté partirait au premier tick : ce n'est pas une
    embuscade, c'est un ordre au marché déguisé."""
    verdict = coach_trader.gate_decision(_piege(trigger=95.0), _pf(),
                                         _quote(100.0))
    assert verdict["reason"] == "bad_trigger"


def test_une_embuscade_courte_armee_AU_DESSUS_du_cours_est_refusee():
    piege = _piege(action="short", trigger=105.0, stop=112.0)
    verdict = coach_trader.gate_decision(piege, _pf(), _quote(100.0))
    assert verdict["reason"] == "bad_trigger"


def test_une_embuscade_sans_these_est_refusee():
    verdict = coach_trader.gate_decision(_piege(thesis="court"), _pf(),
                                         _quote(100.0))
    assert verdict["reason"] == "no_thesis"


def test_le_stop_d_une_embuscade_s_evalue_contre_le_TRIGGER_pas_le_cours():
    """Stop à 106 : sous le cours (100 ? non, au-dessus) — mais surtout SOUS le
    trigger de 110, donc il protège bien l'entrée qui aura lieu à 110."""
    verdict = coach_trader.gate_decision(_piege(stop=106.0), _pf(),
                                         _quote(100.0))
    assert verdict["accepted"] is True


def test_un_stop_au_dessus_du_trigger_d_une_embuscade_longue_est_refuse():
    verdict = coach_trader.gate_decision(_piege(stop=112.0), _pf(),
                                         _quote(100.0))
    assert verdict["reason"] == "no_stop"


def test_le_risque_d_une_embuscade_se_calcule_sur_trigger_moins_stop():
    """20 x (110 - 104) = 120 CHF, soit 1,2 % — ça passe. Mesuré contre le
    COURS (100) il n'aurait valu que 0,8 % : la mesure serait FAUSSE, et le
    piège partirait à 110 avec un risque non contrôlé."""
    assert coach_trader.gate_decision(_piege(), _pf(), _quote(100.0))["accepted"]
    # 20 x (110 - 99) = 220 CHF = 2,2 % > 2 % -> refusé.
    verdict = coach_trader.gate_decision(_piege(stop=99.0), _pf(), _quote(100.0))
    assert verdict["reason"] == "risk_high"


def test_la_taille_d_une_embuscade_se_mesure_au_TRIGGER():
    """8 x 110 = 880 CHF = 8,8 % < plancher de 10 % -> trop petit."""
    verdict = coach_trader.gate_decision(_piege(qty=8, stop=107.0), _pf(),
                                         _quote(100.0))
    assert verdict["reason"] == "too_small"


def test_une_embuscade_qui_depasserait_la_concentration_est_refusee():
    verdict = coach_trader.gate_decision(_piege(qty=30, stop=109.0), _pf(),
                                         _quote(100.0))
    assert verdict["reason"] == "oversize"


# --- les garde-fous PROPRES aux embuscades -------------------------------- #

def test_le_cinquieme_piege_est_refuse():
    pf = _pf()
    pf["open_orders"] = [_armee("A"), _armee("B"), _armee("C"), _armee("D")]
    verdict = coach_trader.gate_decision(_piege(), pf, _quote(100.0))
    assert verdict["reason"] == "too_many_pending"


def test_quatre_pieges_armes_laissent_passer_le_quatrieme():
    pf = _pf()
    pf["open_orders"] = [_armee("A"), _armee("B"), _armee("C")]
    assert coach_trader.gate_decision(_piege(), pf, _quote(100.0))["accepted"]


def test_un_ordre_LIMITE_en_attente_n_est_pas_une_embuscade():
    """Les objectifs posés par le coach vivent aussi dans ``open_orders`` — les
    compter comme des pièges armés ferait sauter le cap au bout de 4 gains."""
    pf = _pf()
    pf["open_orders"] = [
        {"id": str(i), "symbol": "X%d" % i, "side": "sell", "kind": "limit",
         "qty": 1, "limit_price": 100.0, "status": "open"} for i in range(6)]
    assert coach_trader.gate_decision(_piege(), pf, _quote(100.0))["accepted"]


def test_le_risque_des_pieges_armes_est_CUMULE():
    """Si les pièges partaient tous, le livre doit rester dans les règles :
    3 x 150 CHF déjà armés + 120 CHF de plus = 570 CHF > 4 % de 10 000."""
    pf = _pf()
    pf["open_orders"] = [_armee("A", risk_chf=150.0), _armee("B", risk_chf=150.0),
                         _armee("C", risk_chf=150.0)]
    verdict = coach_trader.gate_decision(_piege(), pf, _quote(100.0))
    assert verdict["reason"] == "pending_risk_high"


def test_le_risque_cumule_ne_penalise_PAS_un_ordre_direct():
    """Un ordre au marché est jugé sur SON risque (``risk_high``) : le coach ne
    doit pas être empêché d'agir MAINTENANT parce qu'il a des pièges armés."""
    pf = _pf()
    pf["open_orders"] = [_armee("A", risk_chf=190.0), _armee("B", risk_chf=190.0)]
    assert coach_trader.gate_decision(_buy(), pf, _quote(100.0))["accepted"]


def test_les_pieges_armes_comptent_comme_des_FRONTS_ouverts():
    """4 lignes tenues + 2 pièges armés = 6 fronts : le 7ᵉ est refusé."""
    pf = _pf(positions=[_pos("P%d" % i, qty=1, avg_price=1.0) for i in range(4)])
    pf["open_orders"] = [_armee("A"), _armee("B")]
    verdict = coach_trader.gate_decision(_piege(), pf, _quote(100.0))
    assert verdict["reason"] == "too_many_positions"


def test_re_armer_le_MEME_symbole_ne_cree_pas_un_front_de_plus():
    pf = _pf(positions=[_pos("P%d" % i, qty=1, avg_price=1.0) for i in range(5)])
    pf["open_orders"] = [_armee("NESN.SW")]
    assert coach_trader.gate_decision(_piege(), pf, _quote(100.0))["accepted"]


def test_une_embuscade_s_arme_MARCHE_FERME():
    """C'est tout l'intérêt : le piège est une consigne au CARNET, il n'exécute
    rien maintenant. L'interdire reviendrait à ne pouvoir armer qu'aux heures
    où l'on pourrait déjà agir directement."""
    verdict = coach_trader.gate_decision(_piege(), _pf(), _quote(100.0),
                                         now=SUNDAY)
    assert verdict["accepted"] is True


def test_un_ordre_direct_reste_refuse_marche_ferme():
    verdict = coach_trader.gate_decision(_buy(), _pf(), _quote(100.0),
                                         now=SUNDAY)
    assert verdict["reason"] == "market_closed"


# --- retirer une embuscade ------------------------------------------------ #

def test_annuler_une_embuscade_existante_passe():
    pf = _pf()
    pf["open_orders"] = [_armee("NESN.SW")]
    verdict = coach_trader.gate_decision(
        {"action": "cancel_pending", "symbol": "NESN.SW"}, pf, _quote(100.0))
    assert verdict["accepted"] is True
    assert verdict["order"]["side"] == "cancel_pending"
    assert verdict["order"]["qty"] == 0


def test_annuler_une_embuscade_qui_n_existe_pas_est_refuse():
    verdict = coach_trader.gate_decision(
        {"action": "cancel_pending", "symbol": "NESN.SW"}, _pf(), _quote(100.0))
    assert verdict["reason"] == "no_pending"


def test_annuler_ne_vise_pas_un_ordre_LIMITE_d_objectif():
    pf = _pf()
    pf["open_orders"] = [{"id": "t", "symbol": "NESN.SW", "side": "sell",
                          "kind": "limit", "qty": 1, "limit_price": 130.0,
                          "status": "open"}]
    verdict = coach_trader.gate_decision(
        {"action": "cancel_pending", "symbol": "NESN.SW"}, pf, _quote(100.0))
    assert verdict["reason"] == "no_pending"


def test_annuler_une_embuscade_marche_FERME_reste_permis():
    pf = _pf()
    pf["open_orders"] = [_armee("NESN.SW")]
    verdict = coach_trader.gate_decision(
        {"action": "cancel_pending", "symbol": "NESN.SW"}, pf, _quote(100.0),
        now=SUNDAY)
    assert verdict["accepted"] is True


# --- la péremption -------------------------------------------------------- #

def test_cinq_jours_de_marche_sautent_le_week_end():
    """Lundi 31/08 + 5 jours de marché = lundi 07/09 (et non samedi 05/09)."""
    fin = coach_trader.market_days_after("2026-08-31T15:00:00+00:00", 5)
    assert fin.startswith("2026-09-07")


def test_la_peremption_part_d_un_vendredi_sans_compter_le_week_end():
    fin = coach_trader.market_days_after("2026-08-28T15:00:00+00:00", 5)
    assert fin.startswith("2026-09-04")


def test_une_date_illisible_ne_leve_pas():
    assert coach_trader.market_days_after("n'importe quoi", 5) == ""
    assert coach_trader.market_days_after(None, 5) == ""


def test_une_embuscade_est_perimee_apres_sa_date():
    armee = _armee("A")
    armee["expires_at"] = "2026-09-01T12:00:00+00:00"
    assert coach_trader.is_expired(armee, "2026-09-02T09:00:00+00:00") is True
    assert coach_trader.is_expired(armee, "2026-08-31T09:00:00+00:00") is False


def test_un_ordre_sans_date_de_peremption_ne_perime_jamais():
    assert coach_trader.is_expired({"symbol": "A"}, "2030-01-01T00:00:00+00:00") \
        is False


# --------------------------------------------------------------------------- #
# LOT 14b T1 — l'équité du garde-fou est NETTE : un short est une DETTE
# --------------------------------------------------------------------------- #

def test_equity_counts_a_short_as_a_debt_not_an_asset():
    """Le cash porte DÉJÀ le produit de la vente à découvert : additionner la
    ligne courte la compterait deux fois. Même règle que
    ``paper_router._coach_equity_chf`` (corrigée le 30/08)."""
    positions = [_pos("DAL", qty=25, avg_price=80.0, side="short"),
                 _pos("NESN.SW", qty=10, avg_price=100.0)]
    # 12 000 + 1 000 (long) − 2 000 (dette de rachat du short) = 11 000
    assert coach_trader._equity_chf(12000.0, positions) == pytest.approx(11000.0)


def test_equity_applies_the_fx_rate_on_both_sides():
    positions = [_pos("HSY", qty=10, avg_price=100.0, fx_rate=0.8, side="short"),
                 _pos("FRO", qty=10, avg_price=50.0, fx_rate=0.8)]
    assert coach_trader._equity_chf(5000.0, positions) == pytest.approx(
        5000.0 - 800.0 + 400.0)


def test_risk_high_is_measured_against_NET_equity_when_short():
    """VÉCU (22/09, compte réel) : un short HSY faisait passer l'équité du
    garde-fou de ~8 760 à ~14 020 CHF — le plafond de risque de 2 % en
    autorisait ~3,2 %. Ici : cash 12 000 dont 2 000 de produit de short,
    équité nette 10 000 -> risque max 200. 25 x (100-90) = 250 : refusé.
    (L'ancienne équité brute, 14 000, laissait passer jusqu'à 280.)"""
    pf = _pf(cash=12000.0,
             positions=[_pos("DAL", qty=25, avg_price=80.0, side="short")])
    out = coach_trader.gate_decision(_buy(qty=25, stop=90.0), pf, _quote(100.0))
    assert out["reason"] == "risk_high"


def test_deployment_view_short_proceeds_do_not_count_as_idle_cash():
    """Avec un short, ``cash / équité nette`` dépasserait 100 % : la part du
    cash qui est le produit d'une vente à découvert est GAGÉE par la dette de
    rachat, elle ne « dort » pas. Le chiffre montré est la trésorerie LIBRE."""
    view = coach_trader.deployment_view({
        "cash_chf": 12000.0,
        "positions": [_pos("DAL", qty=25, avg_price=80.0, side="short")],
    })
    # libre = 12 000 − 2 000 = 10 000 ; équité nette = 10 000
    assert view["cash_pct"] == 100.0


# --------------------------------------------------------------------------- #
# LOT 14b T2 — le plancher de trésorerie d'un ACHAT se mesure sur le LIBRE
# --------------------------------------------------------------------------- #

def test_cash_floor_is_measured_against_free_cash_when_short():
    """Même famille que T1 : le contrôle ``cash_floor`` lisait encore
    ``cash_chf`` BRUT, gonflé par le produit d'un short — un achat pouvait
    donc être financé par l'argent d'une vente à découvert que le short doit
    pourtant racheter. Ici : 8 000 de cash dont 8 000 sont la dette de
    rachat d'un short DAL -> trésorerie libre = 0 ; un achat de 1 500 CHF
    (équité nette 10 000, loin sous les plafonds oversize/risk_high/
    too_small) doit être refusé cash_floor plutôt qu'accepté sur la foi du
    cash brut."""
    pf = _pf(cash=8000.0,
             positions=[_pos("ABBN.SW", qty=100, avg_price=100.0),
                        _pos("DAL", qty=100, avg_price=80.0, side="short")])
    out = coach_trader.gate_decision(_buy(qty=15, stop=95.0), pf, _quote(100.0))
    assert out["reason"] == "cash_floor"


def test_cash_floor_without_a_short_is_unaffected():
    """Sans short, la trésorerie libre EST la trésorerie brute (dette de
    rachat nulle) — le même refus, pour la même raison : la règle dégénère
    correctement à ``cash_chf`` seul, comportement inchangé par ce lot."""
    pf = _pf(cash=0.0, positions=[_pos("ABBN.SW", qty=100, avg_price=100.0)])
    out = coach_trader.gate_decision(_buy(qty=15, stop=95.0), pf, _quote(100.0))
    assert out["reason"] == "cash_floor"


# --------------------------------------------------------------------------- #
# LOT 14b T5 — l'économie ventilée PAR SOURCE d'idée
# --------------------------------------------------------------------------- #

def _eco_trade(pnl, fees=2.0, source=None, stamp=0.0):
    row = {"symbol": "X", "pnl_chf": pnl, "fees_chf": fees,
           "stamp_duty_chf": stamp}
    if source is not None:
        row["candidate_source"] = source
    return row


def test_economics_view_breaks_down_by_candidate_source():
    view = coach_trader.economics_view(_pf(trades=[
        _eco_trade(10.0, source="radar"), _eco_trade(-4.0, source="radar"),
        _eco_trade(6.0, fees=1.0, stamp=0.5, source="europe_pool"),
        _eco_trade(-3.0),                                   # ancien trade
    ]))
    by = view["by_source"]
    assert by["radar"] == {"n_trades": 2, "n_wins": 1, "net_pnl_chf": 6.0,
                           "gross_pnl_chf": 10.0}
    assert by["europe_pool"] == {"n_trades": 1, "n_wins": 1,
                                 "net_pnl_chf": 6.0, "gross_pnl_chf": 7.5}
    # un trade sans provenance n'est attribué à AUCUNE source réelle
    assert by["unknown"] == {"n_trades": 1, "n_wins": 0, "net_pnl_chf": -3.0,
                             "gross_pnl_chf": -1.0}
    assert sum(r["n_trades"] for r in by.values()) == view["n_trades"]


def test_economics_view_by_source_is_empty_without_trades():
    assert coach_trader.economics_view(_pf())["by_source"] == {}
