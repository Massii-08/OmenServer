"""LOT 5 « Coach Trader MAX » — le garde-fou étendu et la cadence (100 % hors ligne).

Ce que ce lot ouvre, et pourquoi ces tests existent :

  - **le SHORT**. Vécu en prod : le coach a refusé quatre fois d'entrer, ses
    meilleures thèses étant BAISSIÈRES et donc « inexécutables en achat seul ».
    Le moteur d'ordres du simulateur savait déjà vendre à découvert (un humain
    peut le faire depuis le premier lot) ; c'était le MANDAT du coach qui
    l'interdisait. Il l'autorise désormais, avec un stop OBLIGATOIRE et
    AU-DESSUS de l'entrée — le miroir exact de ce qui est exigé d'un achat.
  - **``adjust_stop``**. Laisser courir un gagnant sans jamais pouvoir remonter
    son stop, c'est rendre la consigne « laisse courir » intenable. Le stop ne
    peut QUE se resserrer : un stop qui s'éloigne n'est pas une gestion, c'est
    l'annulation d'une décision déjà prise.
  - **la CADENCE**. Trois créneaux par jour ouvré, un seul le week-end et
    CRYPTO uniquement — un ordre sur une action un dimanche ne s'exécuterait
    pas, le refuser est plus honnête que de le laisser dormir.

Isolation : même fixture ``store.DATA_DIR`` que ``test_paper_coach_trader.py``.
"""
from datetime import datetime, timezone

import pytest

from backend.bots.paper import coach_trader, store

THESIS = "cassure du range mensuel sur volume"     # > MIN_THESIS_LEN

# Mercredi 26/08/2026, heures LOCALES Rome (CEST = UTC+2).
WED_0900 = datetime(2026, 8, 26, 7, 0, 0, tzinfo=timezone.utc)    # 09:00 Rome
WED_1545 = datetime(2026, 8, 26, 13, 45, 0, tzinfo=timezone.utc)  # 15:45 Rome
WED_1805 = datetime(2026, 8, 26, 16, 5, 0, tzinfo=timezone.utc)   # 18:05 Rome
WED_2145 = datetime(2026, 8, 26, 19, 45, 0, tzinfo=timezone.utc)  # 21:45 Rome
SAT_1805 = datetime(2026, 8, 29, 16, 5, 0, tzinfo=timezone.utc)   # samedi 18:05
SUN_1805 = datetime(2026, 8, 30, 16, 5, 0, tzinfo=timezone.utc)   # dimanche 18:05
SUN_0900 = datetime(2026, 8, 30, 7, 0, 0, tzinfo=timezone.utc)    # dimanche 09:00


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


def _pos(symbol, qty=1, avg_price=1.0, fx_rate=1.0, side="long", stop=None):
    return {"symbol": symbol, "qty": qty, "avg_price": avg_price,
            "currency": "CHF", "fx_rate": fx_rate, "side": side,
            "stop_loss": stop}


def _quote(price=100.0, currency="CHF", fx_rate=1.0):
    return {"price": price, "currency": currency, "fx_rate": fx_rate}


def _short(**over):
    """Une vente à découvert VALIDE : 20 x 100 = 2000 CHF (20 % de l'équité),
    stop à 105 -> risque 100 CHF (1 % de l'équité)."""
    base = {"action": "short", "symbol": "NESN.SW", "qty": 20, "stop": 105.0,
            "target": 80.0, "thesis": THESIS, "setup": "contrarian"}
    base.update(over)
    return base


# --------------------------------------------------------------------------- #
# Le contrat des actions
# --------------------------------------------------------------------------- #

def test_the_action_contract_now_carries_both_directions():
    """Les trois familles sont explicites : le prompt les cite par NOM, il ne
    les découpe plus par index (``ACTION_KINDS[1:]`` disait « sortie » et
    serait devenu faux en ajoutant une entrée)."""
    assert coach_trader.ENTRY_ACTIONS == ("buy", "short")
    assert coach_trader.EXIT_ACTIONS == ("sell", "reduce", "cover")
    assert coach_trader.ACTION_KINDS == ("buy", "short", "sell", "reduce",
                                         "cover", "adjust_stop")


def test_the_new_reject_codes_are_declared():
    for code in ("stop_widen", "market_closed"):
        assert code in coach_trader.REJECT_CODES


# --------------------------------------------------------------------------- #
# SHORT — l'entrée baissière
# --------------------------------------------------------------------------- #

def test_a_short_with_a_stop_above_the_entry_is_accepted():
    out = coach_trader.gate_decision(_short(), _pf(), _quote())
    assert out["accepted"] is True
    assert out["order"]["side"] == "short"
    assert out["order"]["qty"] == 20
    assert out["order"]["stop_loss"] == 105.0


def test_a_short_without_a_stop_is_refused():
    out = coach_trader.gate_decision(_short(stop=None), _pf(), _quote())
    assert out["reason"] == "no_stop"


def test_a_short_with_a_stop_below_the_entry_is_refused():
    """Le miroir exact du long : un stop SOUS le prix ne protège pas un
    vendeur à découvert — c'est son objectif, pas son invalidation."""
    out = coach_trader.gate_decision(_short(stop=95.0), _pf(), _quote())
    assert out["reason"] == "no_stop"


def test_a_short_without_a_thesis_is_refused():
    out = coach_trader.gate_decision(_short(thesis="court"), _pf(), _quote())
    assert out["reason"] == "no_thesis"


def test_a_short_risking_more_than_the_ceiling_is_refused():
    """Stop à 125 : 25 CHF de risque par titre x 20 = 500 CHF, soit 5 % de
    l'équité pour un plafond à 2 %."""
    out = coach_trader.gate_decision(_short(stop=125.0), _pf(), _quote())
    assert out["reason"] == "risk_high"


def test_a_short_too_small_is_refused():
    out = coach_trader.gate_decision(_short(qty=2), _pf(), _quote())
    assert out["reason"] == "too_small"


def test_a_short_too_large_is_refused():
    out = coach_trader.gate_decision(_short(qty=40, stop=101.0), _pf(), _quote())
    assert out["reason"] == "oversize"


def test_a_short_counts_against_the_number_of_open_fronts():
    positions = [_pos("A%d" % i, qty=1, avg_price=1.0)
                 for i in range(coach_trader.MAX_POSITIONS)]
    out = coach_trader.gate_decision(_short(), _pf(positions=positions), _quote())
    assert out["reason"] == "too_many_positions"


def test_shorting_a_symbol_already_held_long_is_refused():
    """Le moteur d'ordres l'interdit (``_open_long``/``_open_short``) ; le
    mandat doit le dire AVANT, avec un motif lisible plutôt qu'un refus
    technique du moteur trois étages plus bas."""
    held = [_pos("NESN.SW", qty=10, avg_price=100.0, side="long")]
    out = coach_trader.gate_decision(_short(), _pf(positions=held), _quote())
    assert out["reason"] == "wrong_side"


def test_a_short_does_not_consume_the_cash_floor():
    """Une vente à découvert n'achète rien : elle ne peut pas mettre le compte
    à sec. Le plancher de trésorerie ne la concerne pas — le lui appliquer
    interdirait de shorter dès que la trésorerie est investie, alors que sa
    vraie contrainte est la MARGE, que le moteur d'ordres fait respecter.

    Ici : 500 CHF en caisse et 9500 CHF investis en long — un achat de 2000 CHF
    serait refusé en ``cash_floor``, le short passe."""
    invested = [_pos("ROG.SW", qty=95, avg_price=100.0, side="long")]
    out = coach_trader.gate_decision(
        _short(), _pf(cash=500.0, positions=invested), _quote())
    assert out["accepted"] is True

    achat = dict(_short(), action="buy", stop=95.0)
    assert coach_trader.gate_decision(
        achat, _pf(cash=500.0, positions=invested), _quote())["reason"] \
        == "cash_floor"


def test_reinforcing_a_short_uses_the_projected_size():
    """Déjà 20 titres vendus à découvert, 20 de plus : la ligne projetée pèse
    4000 CHF, au-dessus du plafond de 30 %."""
    held = [_pos("NESN.SW", qty=20, avg_price=100.0, side="short")]
    out = coach_trader.gate_decision(_short(stop=101.0),
                                     _pf(positions=held), _quote())
    assert out["reason"] == "oversize"


# --------------------------------------------------------------------------- #
# COVER — le rachat
# --------------------------------------------------------------------------- #

def test_cover_closes_a_short():
    held = [_pos("NESN.SW", qty=20, avg_price=100.0, side="short")]
    out = coach_trader.gate_decision(
        {"action": "cover", "symbol": "NESN.SW", "qty": 20},
        _pf(positions=held), _quote())
    assert out["accepted"] is True
    assert out["order"]["side"] == "cover"


def test_cover_without_a_quantity_buys_the_whole_line_back():
    held = [_pos("NESN.SW", qty=20, avg_price=100.0, side="short")]
    out = coach_trader.gate_decision(
        {"action": "cover", "symbol": "NESN.SW"}, _pf(positions=held), _quote())
    assert out["accepted"] is True and out["order"]["qty"] == 20


def test_cover_beyond_the_line_is_refused():
    held = [_pos("NESN.SW", qty=20, avg_price=100.0, side="short")]
    out = coach_trader.gate_decision(
        {"action": "cover", "symbol": "NESN.SW", "qty": 50},
        _pf(positions=held), _quote())
    assert out["reason"] == "qty_over_position"


def test_cover_without_a_short_is_refused():
    held = [_pos("NESN.SW", qty=20, avg_price=100.0, side="long")]
    out = coach_trader.gate_decision(
        {"action": "cover", "symbol": "NESN.SW", "qty": 5},
        _pf(positions=held), _quote())
    assert out["reason"] == "no_position"


def test_selling_a_line_held_short_is_refused():
    """``sell`` solde un ACHAT. Sur une ligne vendue à découvert, le geste
    s'appelle ``cover`` — et confondre les deux doublerait l'exposition au lieu
    de la fermer."""
    held = [_pos("NESN.SW", qty=20, avg_price=100.0, side="short")]
    out = coach_trader.gate_decision(
        {"action": "sell", "symbol": "NESN.SW", "qty": 5},
        _pf(positions=held), _quote())
    assert out["reason"] == "no_position"


def test_reduce_reads_the_side_of_the_line_it_finds():
    """``reduce`` dit « allège », pas « vends » : sur une ligne courte il
    rachète. Aucune ambiguïté possible — le moteur interdit de détenir les deux
    sens sur un même titre."""
    held = [_pos("NESN.SW", qty=20, avg_price=100.0, side="short")]
    out = coach_trader.gate_decision(
        {"action": "reduce", "symbol": "NESN.SW", "qty": 5},
        _pf(positions=held), _quote())
    assert out["accepted"] is True and out["order"]["side"] == "cover"


def test_reduce_on_a_long_still_sells():
    held = [_pos("NESN.SW", qty=20, avg_price=100.0, side="long")]
    out = coach_trader.gate_decision(
        {"action": "reduce", "symbol": "NESN.SW", "qty": 5},
        _pf(positions=held), _quote())
    assert out["accepted"] is True and out["order"]["side"] == "sell"


# --------------------------------------------------------------------------- #
# ADJUST_STOP — le stop ne va que dans un sens
# --------------------------------------------------------------------------- #

def test_tightening_the_stop_of_a_long_is_accepted():
    held = [_pos("NESN.SW", qty=20, avg_price=100.0, side="long", stop=90.0)]
    out = coach_trader.gate_decision(
        {"action": "adjust_stop", "symbol": "NESN.SW", "stop": 95.0},
        _pf(positions=held), _quote())
    assert out["accepted"] is True
    assert out["order"]["side"] == "adjust_stop"
    assert out["order"]["stop_loss"] == 95.0
    assert out["order"]["qty"] == 0        # rien ne s'échange


def test_widening_the_stop_of_a_long_is_refused():
    held = [_pos("NESN.SW", qty=20, avg_price=100.0, side="long", stop=95.0)]
    out = coach_trader.gate_decision(
        {"action": "adjust_stop", "symbol": "NESN.SW", "stop": 90.0},
        _pf(positions=held), _quote())
    assert out["reason"] == "stop_widen"


def test_tightening_the_stop_of_a_short_means_lowering_it():
    held = [_pos("NESN.SW", qty=20, avg_price=110.0, side="short", stop=120.0)]
    out = coach_trader.gate_decision(
        {"action": "adjust_stop", "symbol": "NESN.SW", "stop": 108.0},
        _pf(positions=held), _quote())
    assert out["accepted"] is True and out["order"]["stop_loss"] == 108.0


def test_raising_the_stop_of_a_short_is_refused():
    held = [_pos("NESN.SW", qty=20, avg_price=110.0, side="short", stop=115.0)]
    out = coach_trader.gate_decision(
        {"action": "adjust_stop", "symbol": "NESN.SW", "stop": 120.0},
        _pf(positions=held), _quote())
    assert out["reason"] == "stop_widen"


def test_a_first_stop_on_an_unprotected_line_is_always_a_tightening():
    """Sans stop, l'invalidation est à l'infini : n'importe quel niveau valide
    la resserre."""
    held = [_pos("NESN.SW", qty=20, avg_price=100.0, side="long", stop=None)]
    out = coach_trader.gate_decision(
        {"action": "adjust_stop", "symbol": "NESN.SW", "stop": 80.0},
        _pf(positions=held), _quote())
    assert out["accepted"] is True


def test_adjust_stop_on_the_wrong_side_of_the_price_is_refused():
    """Un stop de long POSÉ AU-DESSUS du cours partirait à la seconde même :
    ce n'est pas une protection, c'est une sortie déguisée."""
    held = [_pos("NESN.SW", qty=20, avg_price=100.0, side="long", stop=90.0)]
    out = coach_trader.gate_decision(
        {"action": "adjust_stop", "symbol": "NESN.SW", "stop": 105.0},
        _pf(positions=held), _quote())
    assert out["reason"] == "no_stop"


def test_adjust_stop_without_a_position_is_refused():
    out = coach_trader.gate_decision(
        {"action": "adjust_stop", "symbol": "NESN.SW", "stop": 95.0},
        _pf(), _quote())
    assert out["reason"] == "no_position"


def test_adjust_stop_without_a_value_is_refused():
    held = [_pos("NESN.SW", qty=20, avg_price=100.0, side="long", stop=90.0)]
    out = coach_trader.gate_decision(
        {"action": "adjust_stop", "symbol": "NESN.SW"},
        _pf(positions=held), _quote())
    assert out["reason"] == "no_stop"


def test_adjust_stop_does_not_need_a_quantity():
    """Il ne s'échange rien : exiger une quantité ferait refuser en
    ``bad_qty`` un geste parfaitement formé."""
    held = [_pos("NESN.SW", qty=20, avg_price=100.0, side="long", stop=90.0)]
    out = coach_trader.gate_decision(
        {"action": "adjust_stop", "symbol": "NESN.SW", "stop": 95.0, "qty": 0},
        _pf(positions=held), _quote())
    assert out["accepted"] is True


# --------------------------------------------------------------------------- #
# Le week-end : crypto seulement
# --------------------------------------------------------------------------- #

def test_a_stock_order_is_refused_when_only_crypto_trades():
    out = coach_trader.gate_decision(_short(), _pf(), _quote(), crypto_only=True)
    assert out["reason"] == "market_closed"


def test_a_crypto_order_passes_when_only_crypto_trades():
    out = coach_trader.gate_decision(
        {"action": "buy", "symbol": "BTC-USD", "qty": 20, "stop": 95.0,
         "thesis": THESIS},
        _pf(), _quote(), crypto_only=True)
    assert out["accepted"] is True


def test_selling_a_stock_is_refused_too_when_the_market_is_shut():
    """Le refus ne vise pas le SENS de l'ordre mais l'HEURE : on ne solde pas
    une action un dimanche non plus."""
    held = [_pos("NESN.SW", qty=20, avg_price=100.0)]
    out = coach_trader.gate_decision(
        {"action": "sell", "symbol": "NESN.SW", "qty": 5},
        _pf(positions=held), _quote(), crypto_only=True)
    assert out["reason"] == "market_closed"


def test_moving_a_stop_stays_allowed_when_the_market_is_shut():
    """Déplacer un stop n'exécute rien : c'est une consigne au carnet, qui
    n'agira qu'à la réouverture. L'interdire priverait le coach du seul geste
    utile de son créneau du week-end."""
    held = [_pos("NESN.SW", qty=20, avg_price=100.0, side="long", stop=90.0)]
    out = coach_trader.gate_decision(
        {"action": "adjust_stop", "symbol": "NESN.SW", "stop": 95.0},
        _pf(positions=held), _quote(), crypto_only=True)
    assert out["accepted"] is True


def test_by_default_nothing_is_shut():
    """``crypto_only`` est OPTIONNEL : tous les appelants existants passent
    trois arguments et doivent continuer à voir un marché ouvert."""
    out = coach_trader.gate_decision(_short(), _pf(), _quote())
    assert out["accepted"] is True


# --------------------------------------------------------------------------- #
# La cadence — les créneaux
# --------------------------------------------------------------------------- #

def test_the_budget_block_is_the_documented_contract():
    assert coach_trader.WEEKDAY_SLOTS == ("15:40", "18:00", "21:40")
    assert coach_trader.WEEKEND_SLOTS == ("18:00",)
    assert coach_trader.PASSES_PER_DAY == 3
    assert coach_trader.MAX_FOCUS == 3
    assert coach_trader.LLM_CALLS_PER_PASS == 2


def test_slots_of_the_day_depend_on_the_weekday():
    assert coach_trader.slots_for(WED_1805) == ("15:40", "18:00", "21:40")
    assert coach_trader.slots_for(SAT_1805) == ("18:00",)


def test_due_slot_is_the_latest_one_reached():
    assert coach_trader.due_slot(WED_1545, {}) == "15:40"
    assert coach_trader.due_slot(WED_1805, {}) == "18:00"
    assert coach_trader.due_slot(WED_2145, {}) == "21:40"


def test_no_slot_before_the_first_one():
    assert coach_trader.due_slot(WED_0900, {}) is None


def test_a_slot_already_run_today_does_not_run_twice():
    state = {"slots": {"15:40": "2026-08-26T15:41:00"}}
    assert coach_trader.due_slot(WED_1545, state) is None


def test_the_same_slot_runs_again_the_next_day():
    state = {"slots": {"15:40": "2026-08-25T15:41:00"}}
    assert coach_trader.due_slot(WED_1545, state) == "15:40"


def test_a_missed_slot_is_not_caught_up_afterwards():
    """La valeur d'un créneau est dans son HEURE : 15h40 vaut « avant
    l'ouverture de New York », pas « la première passe du jour ». Une machine
    éteinte tout l'après-midi reprend à 18 h et ne repaie pas un appel pour une
    lecture dont le moment est passé — deux passes en dix minutes sur un
    contexte identique ne diraient rien de plus."""
    state = {"slots": {"18:00": "2026-08-26T18:01:00"}}
    assert coach_trader.due_slot(WED_1805, state) is None


def test_the_next_slot_still_runs_after_one_was_missed():
    """Sauter 15h40 ne condamne pas la journée : 21h40 tourne normalement."""
    state = {"slots": {"18:00": "2026-08-26T18:01:00"}}
    assert coach_trader.due_slot(WED_2145, state) == "21:40"


def test_the_weekend_slot_is_crypto_only():
    assert coach_trader.crypto_only_at(SAT_1805) is True
    assert coach_trader.crypto_only_at(SUN_1805) is True
    assert coach_trader.crypto_only_at(WED_1805) is False


def test_no_weekend_pass_before_its_slot():
    assert coach_trader.due_slot(SUN_0900, {}) is None


def test_arming_a_slot_keeps_the_others():
    state = coach_trader.arm_slot({"slots": {"15:40": "hier"}}, "18:00", "aujourd hui")
    assert state["slots"] == {"15:40": "hier", "18:00": "aujourd hui"}


def test_arming_a_slot_never_mutates_the_state_it_receives():
    original = {"slots": {"15:40": "hier"}}
    coach_trader.arm_slot(original, "18:00", "aujourd hui")
    assert original == {"slots": {"15:40": "hier"}}


def test_arming_a_slot_tolerates_a_state_without_slots():
    assert coach_trader.arm_slot({}, "18:00", "maintenant")["slots"] == \
        {"18:00": "maintenant"}


def test_an_unreadable_slot_stamp_is_treated_as_never_run():
    """Un fichier d'état touché à la main ne doit jamais éteindre le coach en
    silence : mieux vaut une passe de trop qu'un compte qui ne trade plus."""
    assert coach_trader.due_slot(WED_1545, {"slots": {"15:40": "n importe quoi"}}) \
        == "15:40"


# --------------------------------------------------------------------------- #
# Le premier temps : le tri (bloc COACH_FOCUS)
# --------------------------------------------------------------------------- #

def test_focus_block_is_read():
    text = ('Voici ma lecture.\n\n```COACH_FOCUS\n'
            '{"focus": ["NESN.SW", "BTC-USD"], "note": "deux dossiers"}\n```')
    out = coach_trader.parse_focus(text)
    assert out["focus"] == ["NESN.SW", "BTC-USD"]
    assert out["note"] == "deux dossiers"
    assert out["error"] is None
    assert "COACH_FOCUS" not in out["text"]


def test_focus_symbols_are_canonical_and_deduplicated():
    text = ('```COACH_FOCUS\n{"focus": [" nesn.sw ", "NESN.SW", "AAPL"]}\n```')
    assert coach_trader.parse_focus(text)["focus"] == ["NESN.SW", "AAPL"]


def test_focus_is_capped():
    text = ('```COACH_FOCUS\n{"focus": ["A", "B", "C", "D", "E"]}\n```')
    assert len(coach_trader.parse_focus(text)["focus"]) == coach_trader.MAX_FOCUS


def test_an_empty_focus_is_a_legitimate_answer():
    text = ('```COACH_FOCUS\n{"focus": [], "note": "rien ne mérite un dossier"}\n```')
    out = coach_trader.parse_focus(text)
    assert out["focus"] == [] and out["note"] == "rien ne mérite un dossier"
    assert out["error"] is None


def test_a_missing_focus_block_is_not_an_invention():
    out = coach_trader.parse_focus("juste du texte")
    assert out["focus"] == [] and out["error"] == "no_block"


def test_a_malformed_focus_block_is_reported_and_stripped():
    out = coach_trader.parse_focus("```COACH_FOCUS\n{ceci n est pas du json\n```")
    assert out["focus"] == [] and out["error"] == "parse_failed"
    assert "COACH_FOCUS" not in out["text"]


def test_a_bare_list_is_accepted_as_a_focus():
    """Le modèle rend une liste nue un jour sur deux — même tolérance que
    ``parse_actions``."""
    assert coach_trader.parse_focus('```COACH_FOCUS\n["NESN.SW"]\n```')["focus"] \
        == ["NESN.SW"]


def test_non_string_focus_entries_are_dropped():
    text = ('```COACH_FOCUS\n{"focus": ["NESN.SW", 8001, null, true]}\n```')
    assert coach_trader.parse_focus(text)["focus"] == ["NESN.SW"]


def test_focus_tolerates_anything():
    for junk in (None, 42, [], {}, b"octets"):
        out = coach_trader.parse_focus(junk)
        assert out["focus"] == [] and out["error"] == "no_block"
