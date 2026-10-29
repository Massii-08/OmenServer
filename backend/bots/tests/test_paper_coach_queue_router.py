"""LOT 17 — la FILE « à l'ouverture », de bout en bout par le VRAI chemin
(100 % hors ligne) : réponse du modèle parsée -> porte -> mise en file ->
tick à l'ouverture -> exécution ou annulation au registre.

Un test qui injecte la dépendance ne prouve pas qu'on la branche : ici, la
passe du coach part de la réponse texte du modèle (``_Speaker``), et la file
se vide par ``tick_coach_account``, exactement comme en production.
"""
from datetime import datetime

from backend.bots import paper_router as pr
from backend.bots.paper import coach_trader
from backend.bots.tests.test_paper_router import (
    COACH, _actions_answer, _focus_answer, _serie, _Speaker, coach_action,
    coach_ledger, coach_portfolio, make_client, seed_coach_position)

SUNDAY = "2026-08-23T18:05:00"          # dimanche soir, tout est fermé
MONDAY_0800 = "2026-08-24T08:00:00"     # lundi avant l'ouverture européenne
MONDAY_0930 = "2026-08-24T09:30:00"     # lundi, l'Europe a ouvert à 09:05
TUESDAY_0400 = "2026-08-25T04:00:00"    # mardi nuit
TUESDAY_0930 = "2026-08-25T09:30:00"
TUESDAY_1800 = "2026-08-25T18:00:00"    # mardi, après la clôture européenne


def _candle(stamp, open_, close):
    ts = datetime.fromisoformat(stamp).timestamp()
    return {"ts": ts, "open": open_, "high": max(open_, close) * 1.002,
            "low": min(open_, close) * 0.998, "close": close, "volume": 1000}


def _queue(portfolio=None):
    book = portfolio or coach_portfolio()
    return [o for o in book["open_orders"] if o["kind"] == "at_open"]


def _sunday_buy(tmp_path, monkeypatch, *actions):
    c, market = make_client(tmp_path, monkeypatch)
    market.candles["NESN.SW"] = _serie()
    speaker = _Speaker(_focus_answer(["NESN.SW"]),
                       _actions_answer(list(actions) or [coach_action()]))
    pr.run_coach_daily_pass(SUNDAY, claude=speaker)
    return market


def test_une_decision_du_dimanche_est_mise_en_file_pas_refusee(
        tmp_path, monkeypatch):
    _sunday_buy(tmp_path, monkeypatch)
    rows = [r for r in coach_ledger() if r["symbol"] == "NESN.SW"]
    assert rows[0]["action"] == "queue_open"
    assert rows[0]["accepted"] is True
    assert not any(r.get("reason") == "market_closed" for r in rows)
    queue = _queue()
    assert len(queue) == 1
    order = queue[0]
    assert order["side"] == "buy" and order["qty"] == 15
    assert order["ref_price"] == 100.0
    assert order["stop_loss"] == 90.0 and order["target"] == 130.0
    assert order["source"] == "daily"
    assert order["expires_at"] == "2026-08-24T17:25:00"
    assert order["risk_chf"] == 150.0
    assert order["thesis_deadline"]
    assert coach_portfolio()["positions"] == []


def test_a_l_ouverture_l_ordre_en_file_s_execute(tmp_path, monkeypatch):
    market = _sunday_buy(tmp_path, monkeypatch)
    market.prices["NESN.SW"] = (101.0, "CHF", "Nestle SA")
    market.candles["NESN.SW"] = _serie() + [
        _candle("2026-08-24T09:20:00", 100.6, 101.0)]

    pr.tick_coach_account(MONDAY_0930)

    book = coach_portfolio()
    assert _queue(book) == []
    assert len(book["positions"]) == 1
    line = book["positions"][0]
    assert line["symbol"] == "NESN.SW" and line["qty"] == 15
    assert line["avg_price"] == 101.0
    assert line["stop_loss"] == 90.0
    # l'objectif est rendu exécutable, comme pour une entrée directe
    assert any(o["kind"] == "limit" and o["limit_price"] == 130.0
               for o in book["open_orders"])
    top = coach_ledger()[0]
    assert top["action"] == "queue_filled" and top["accepted"] is True
    assert top["source"] == "daily"


def test_avant_l_ouverture_l_ordre_attend(tmp_path, monkeypatch):
    market = _sunday_buy(tmp_path, monkeypatch)
    pr.tick_coach_account(MONDAY_0800)
    assert len(_queue()) == 1
    assert coach_portfolio()["positions"] == []


def test_sans_bougie_de_la_nouvelle_seance_l_ordre_attend(
        tmp_path, monkeypatch):
    """À 09:30 Yahoo peut encore servir la clôture d'avant : sans bougie
    postérieure à la mise en file, on n'exécute pas sous un vieux prix."""
    _sunday_buy(tmp_path, monkeypatch)
    pr.tick_coach_account(MONDAY_0930)
    assert len(_queue()) == 1
    assert coach_portfolio()["positions"] == []


def test_un_ecart_d_ouverture_annule_l_entree_au_registre(tmp_path, monkeypatch):
    market = _sunday_buy(tmp_path, monkeypatch)
    market.prices["NESN.SW"] = (110.0, "CHF", "Nestle SA")
    market.candles["NESN.SW"] = _serie() + [
        _candle("2026-08-24T09:20:00", 109.0, 110.0)]

    pr.tick_coach_account(MONDAY_0930)

    book = coach_portfolio()
    assert _queue(book) == [] and book["positions"] == []
    top = coach_ledger()[0]
    assert top["action"] == "queue_cancelled"
    assert top["accepted"] is False
    assert top["reason"] == "open_gap"
    assert "100" in top["detail"] and "annulée" in top["detail"]


def test_l_ordre_en_file_perime_a_la_fin_de_la_premiere_seance(
        tmp_path, monkeypatch):
    _sunday_buy(tmp_path, monkeypatch)
    pr.tick_coach_account(TUESDAY_1800)
    assert _queue() == []
    top = coach_ledger()[0]
    assert top["action"] == "queue_expired" and top["reason"] == "queue_expired"


def test_deux_decisions_du_meme_sens_ne_s_empilent_pas(tmp_path, monkeypatch):
    _sunday_buy(tmp_path, monkeypatch)
    pr.execute_coach_actions([coach_action(qty=20)], "digest", SUNDAY)
    queue = _queue()
    assert len(queue) == 1 and queue[0]["qty"] == 20
    actions = [r["action"] for r in coach_ledger()[:2]]
    assert "queue_cancelled" in actions and "queue_open" in actions


def test_une_decision_opposee_annule_l_entree_en_file(tmp_path, monkeypatch):
    _sunday_buy(tmp_path, monkeypatch)
    rows = pr.execute_coach_actions(
        [{"action": "sell", "symbol": "NESN.SW", "exit_reason": "invalidated"}],
        "digest", SUNDAY)
    assert _queue() == []
    assert [r["action"] for r in rows] == ["queue_cancelled"]
    assert rows[0]["accepted"] is True


def test_cancel_pending_retire_l_ordre_en_file(tmp_path, monkeypatch):
    _sunday_buy(tmp_path, monkeypatch)
    rows = pr.execute_coach_actions(
        [{"action": "cancel_pending", "symbol": "NESN.SW"}], "digest", SUNDAY)
    assert rows[0]["accepted"] is True
    assert _queue() == []


def test_une_sortie_en_file_part_meme_sur_un_gros_ecart(tmp_path, monkeypatch):
    """Une sortie défensive n'est jamais retardée : -20 % à l'ouverture ne
    l'annule pas, au contraire."""
    c, market = make_client(tmp_path, monkeypatch)
    seed_coach_position(qty=10, stop_loss=None)
    rows = pr.execute_coach_actions(
        [{"action": "sell", "symbol": "NESN.SW", "exit_reason": "threat"}],
        "guardian", TUESDAY_0400)
    assert rows[0]["action"] == "queue_open"
    assert _queue()[0]["sell_all"] is True

    market.prices["NESN.SW"] = (80.0, "CHF", "Nestle SA")
    market.candles["NESN.SW"] = [_candle("2026-08-25T09:10:00", 79.0, 80.0)]
    pr.tick_coach_account(TUESDAY_0930)

    book = coach_portfolio()
    assert book["positions"] == [] and _queue(book) == []
    trade = book["trades"][-1]
    assert trade["exit_price"] == 80.0
    assert trade["exit_reason"] == "threat"
    assert coach_ledger()[0]["action"] == "queue_filled"


def test_le_coach_voit_sa_file_dans_son_contexte(tmp_path, monkeypatch):
    _sunday_buy(tmp_path, monkeypatch)
    context = pr._coach_pass_context(pr._ensure_coach_account(), MONDAY_0800)
    kinds = [o["kind"] for o in context["open_orders"]]
    assert coach_trader.AT_OPEN_KIND in kinds


def test_le_tick_humain_ne_touche_jamais_un_ordre_en_file(tmp_path, monkeypatch):
    """``run_tick`` est partagé avec les humains : il ne doit ni exécuter un
    ordre ``at_open`` comme un ordre au marché, ni le signaler en erreur."""
    market = _sunday_buy(tmp_path, monkeypatch)
    market.candles["NESN.SW"] = _serie() + [
        _candle("2026-08-24T09:20:00", 100.6, 101.0)]
    portfolio = pr._ensure_coach_account()
    result = pr.run_tick(portfolio, MONDAY_0930,
                         lambda s: market.candles.get(s, []),
                         lambda c: 1.0, COACH)
    assert result["fills"] == [] and result["errors"] == []
    assert len([o for o in portfolio.open_orders if o.kind == "at_open"]) == 1
