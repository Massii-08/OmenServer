"""LOT 17 — les LEVIERS du coach (100 % hors ligne).

Mesuré sur le compte réel du coach depuis le 23/09 : +3,1 %, 5 trades sur 5
gagnants, mais 17 décisions refusées ``market_closed`` (il décide le soir, la
nuit ou le week-end : achat STNG refusé 3 fois puis jamais fait, fermeture FCX
refusée 4 fois, short CON.DE retardé de plusieurs jours) et 2 refus
``too_small`` à 9-10 % de l'équité. Quatre leviers validés par Massii :

  1. la FILE « à l'ouverture » au lieu du refus ``market_closed`` ;
  2. la cadence x20 (8 créneaux en semaine) ;
  3. le plancher de taille à 5 % ;
  4. le risque par trade à 3 % (et le cumul des ordres en attente à 6 %).
"""
from datetime import datetime, timedelta

import pytest

from backend.bots.paper import coach_trader, store

THESIS = "cassure du range mensuel sur volume"
INVALIDATION = "retour sous le range sur une clôture quotidienne"

SUNDAY = "2026-08-23T18:05:00"        # dimanche, heure de Rome (naïf = local)
TUE_1000 = "2026-08-25T10:00:00"      # mardi 10h : Europe ouverte, US fermée
TUE_1600 = "2026-08-25T16:00:00"      # mardi 16h : les deux ouverts
FRI_2300 = "2026-08-28T23:00:00"      # vendredi soir, tout est fermé


@pytest.fixture(autouse=True)
def _isolate_data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path / "paper_trading")
    yield


def _pf(cash=10000.0, positions=None, orders=None, capital=10000.0,
        fee_profile=None):
    book = {"cash_chf": cash, "positions": list(positions or []),
            "open_orders": list(orders or []), "trades": [],
            "initial_capital": capital}
    if fee_profile:
        book["fee_profile"] = fee_profile
    return book


def _pos(symbol, qty=10, avg_price=100.0, side="long", stop=None):
    return {"symbol": symbol, "qty": qty, "avg_price": avg_price,
            "currency": "CHF", "fx_rate": 1.0, "side": side,
            "stop_loss": stop}


def _quote(price=100.0):
    return {"price": price, "currency": "CHF", "fx_rate": 1.0}


def _buy(**over):
    """15 x 100 = 1500 CHF (15 %), stop 90 -> risque 150 CHF (1,5 %)."""
    base = {"action": "buy", "symbol": "NESN.SW", "qty": 15, "stop": 90.0,
            "target": 130.0, "thesis": THESIS, "setup": "breakout",
            "horizon_days": 10, "invalidation": INVALIDATION}
    base.update(over)
    return base


def _queued(symbol="NESN.SW", side="buy", qty=15, ref=100.0, stop=90.0,
            target=130.0, risk=150.0, oid="q1", **over):
    row = {"id": oid, "symbol": symbol, "side": side, "kind": "at_open",
           "qty": qty, "status": "open", "ref_price": ref, "stop_loss": stop,
           "target": target, "risk_chf": risk, "thesis": THESIS,
           "setup": "breakout", "created_at": SUNDAY, "currency": "CHF",
           "horizon_days": 10, "invalidation": INVALIDATION,
           "thesis_deadline": "2026-09-02T18:05:00", "exit_reason": "",
           "sell_all": False, "source": "daily"}
    row.update(over)
    return row


# --------------------------------------------------------------------------- #
# Leviers 2, 3, 4 — les constantes
# --------------------------------------------------------------------------- #

def test_levier_2_la_cadence_x20_est_restauree():
    assert coach_trader.WEEKDAY_SLOTS == (
        "09:10", "11:30", "14:00", "15:40", "17:00", "18:30", "20:00", "21:40")
    assert coach_trader.PASSES_PER_DAY == 8


def test_levier_3_le_plancher_de_taille_passe_a_5_pourcent():
    assert coach_trader.MIN_POSITION_PCT == 5.0
    # 6 x 100 = 600 CHF = 6 % : refusé hier (``too_small``), accepté
    # aujourd'hui (objectif et stop élargis pour rester sous les règles fines).
    out = coach_trader.gate_decision(_buy(qty=6), _pf(), _quote())
    assert out["accepted"] is True, out


def test_levier_3_les_frais_protegent_toujours_une_petite_ligne():
    """Au profil IBKR, le minimum de 1,50 CHF par côté pèse PLUS sur une
    petite ligne : la porte économique doit continuer de refuser un trade
    dont l'objectif ne paie pas l'aller-retour."""
    small = coach_trader._round_trip_pct("ibkr", 500.0, "NESN.SW")
    large = coach_trader._round_trip_pct("ibkr", 5000.0, "NESN.SW")
    assert small > large
    out = coach_trader.gate_decision(
        _buy(qty=5, stop=99.0, target=100.5), _pf(fee_profile="ibkr"),
        _quote())
    assert out["reason"] in ("fee_ratio", "edge_thin")


def test_levier_4_le_risque_par_trade_passe_a_3_pourcent():
    assert coach_trader.MAX_RISK_PCT == 3.0
    assert coach_trader.MAX_PENDING_RISK_PCT == 6.0
    # 25 x 100, stop 89 -> 275 CHF de risque = 2,75 % : refusé à 2 %, accepté.
    out = coach_trader.gate_decision(_buy(qty=25, stop=89.0), _pf(), _quote())
    assert out["accepted"] is True, out
    out = coach_trader.gate_decision(_buy(qty=25, stop=87.0), _pf(), _quote())
    assert out["reason"] == "risk_high"


# --------------------------------------------------------------------------- #
# Levier 1 — la file « à l'ouverture » : la porte
# --------------------------------------------------------------------------- #

def test_open_gap_est_un_code_de_refus():
    assert "open_gap" in coach_trader.REJECT_CODES
    assert coach_trader.AT_OPEN_KIND == "at_open"


def test_une_entree_marche_ferme_est_mise_en_file_pas_refusee():
    out = coach_trader.gate_decision(_buy(symbol="DAL"), _pf(), _quote(),
                                     now=TUE_1000)
    assert out["accepted"] is True
    assert out["order"]["kind"] == "at_open"
    assert out["order"]["side"] == "buy"


def test_une_entree_marche_ouvert_reste_au_marche():
    out = coach_trader.gate_decision(_buy(), _pf(), _quote(), now=TUE_1000)
    assert out["order"]["kind"] == "market"


def test_une_sortie_marche_ferme_est_mise_en_file():
    held = [_pos("NESN.SW", qty=20)]
    out = coach_trader.gate_decision(
        {"action": "sell", "symbol": "NESN.SW", "exit_reason": "threat"},
        _pf(positions=held), _quote(), now=SUNDAY)
    assert out["accepted"] is True
    assert out["order"]["kind"] == "at_open"
    assert out["order"]["qty"] == 20
    assert out["order"]["exit_reason"] == "threat"


def test_la_mise_en_file_rejoue_toutes_les_regles_sur_le_prix_de_decision():
    """Une décision mal formée n'attend pas l'ouverture pour être refusée."""
    out = coach_trader.gate_decision(_buy(stop=None), _pf(), _quote(),
                                     now=SUNDAY)
    assert out["reason"] == "no_stop"


def test_une_place_inconnue_reste_refusee_market_closed():
    """Elle ne rouvrira jamais (on ne sait pas la situer) : une file y
    dormirait pour rien."""
    out = coach_trader.gate_decision(_buy(symbol="TITAN.NS"), _pf(), _quote(),
                                     now=TUE_1000)
    assert out["reason"] == "market_closed"


def test_un_ordre_en_file_compte_comme_un_front():
    positions = [_pos("P%d" % i, qty=1, avg_price=1.0) for i in range(5)]
    pf = _pf(positions=positions, orders=[_queued(symbol="ROG.SW")])
    out = coach_trader.gate_decision(_buy(), pf, _quote(), now=TUE_1000)
    assert out["reason"] == "too_many_positions"


def test_le_risque_d_un_ordre_en_file_compte_dans_le_cumul_des_embuscades():
    pf = _pf(orders=[_queued(symbol="ROG.SW", risk=500.0)])
    piege = _buy(kind="stop", trigger=105.0, stop=95.0, qty=15)   # 150 CHF
    assert coach_trader.gate_decision(piege, _pf(), _quote())["accepted"]
    out = coach_trader.gate_decision(piege, pf, _quote())
    assert out["reason"] == "pending_risk_high"


def test_une_mise_en_file_est_soumise_au_cumul_des_ordres_en_attente():
    pf = _pf(orders=[_queued(symbol="ROG.SW", risk=500.0)])
    out = coach_trader.gate_decision(_buy(), pf, _quote(), now=SUNDAY)
    assert out["reason"] == "pending_risk_high"


def test_remplacer_l_ordre_en_file_du_meme_titre_ne_cumule_pas_son_risque():
    pf = _pf(orders=[_queued(risk=500.0)])
    out = coach_trader.gate_decision(_buy(), pf, _quote(), now=SUNDAY)
    assert out["accepted"] is True


def test_cancel_pending_retire_un_ordre_en_file():
    pf = _pf(orders=[_queued()])
    out = coach_trader.gate_decision(
        {"action": "cancel_pending", "symbol": "NESN.SW"}, pf, _quote(),
        now=SUNDAY)
    assert out["accepted"] is True


# --- doublons et décisions opposées --------------------------------------- #

def test_meme_titre_meme_sens_remplace():
    pf = _pf(orders=[_queued(oid="a")])
    got = coach_trader.queue_conflicts(_buy(), pf)
    assert got == {"replace": ["a"], "cancel": []}


def test_une_sortie_annule_l_entree_en_file_du_meme_sens():
    pf = _pf(orders=[_queued(side="short", oid="s", stop=110.0, target=80.0)])
    got = coach_trader.queue_conflicts(
        {"action": "cover", "symbol": "NESN.SW"}, pf)
    assert got == {"replace": [], "cancel": ["s"]}


def test_une_entree_inverse_annule_l_entree_en_file():
    pf = _pf(orders=[_queued(oid="b")])
    got = coach_trader.queue_conflicts(_buy(action="short"), pf)
    assert got == {"replace": [], "cancel": ["b"]}


def test_une_entree_n_annule_jamais_une_sortie_en_file():
    """Une sortie défensive n'est jamais retardée."""
    pf = _pf(positions=[_pos("NESN.SW")],
             orders=[_queued(side="sell", oid="x", risk=None)])
    got = coach_trader.queue_conflicts(_buy(), pf)
    assert got == {"replace": [], "cancel": []}


def test_un_autre_titre_n_est_pas_concerne():
    pf = _pf(orders=[_queued(symbol="ROG.SW")])
    assert coach_trader.queue_conflicts(_buy(), pf) == {"replace": [],
                                                        "cancel": []}


# --- la réévaluation à l'ouverture --------------------------------------- #

def test_a_l_ouverture_sans_ecart_l_entree_part_au_marche():
    order = _queued()
    pf = _pf(orders=[order])
    out = coach_trader.gate_queued(order, pf, _quote(101.0), TUE_1000,
                                   open_price=100.8)
    assert out["accepted"] is True, out
    assert out["order"]["kind"] == "market"
    assert out["order"]["qty"] == 15


def test_un_ecart_d_ouverture_de_plus_de_3_pourcent_annule_l_entree():
    order = _queued()
    out = coach_trader.gate_queued(order, _pf(orders=[order]), _quote(104.0),
                                   TUE_1000, open_price=104.0)
    assert out["reason"] == "open_gap"


def test_l_ecart_se_mesure_aussi_sur_le_prix_d_ouverture():
    order = _queued()
    out = coach_trader.gate_queued(order, _pf(orders=[order]), _quote(101.0),
                                   TUE_1000, open_price=96.0)
    assert out["reason"] == "open_gap"


def test_un_atr_large_elargit_la_tolerance_d_ecart():
    order = _queued(stop=80.0, target=140.0, risk=300.0, qty=15)
    tech = {"atr14_pct": 5.0}
    out = coach_trader.gate_queued(order, _pf(orders=[order]), _quote(104.0),
                                   TUE_1000, technical=tech, open_price=104.0)
    assert out["reason"] != "open_gap"


def test_un_prix_qui_a_deja_franchi_le_stop_annule():
    order = _queued(stop=99.0, target=130.0)
    out = coach_trader.gate_queued(order, _pf(orders=[order]), _quote(98.5),
                                   TUE_1000, open_price=98.5)
    assert out["reason"] == "open_gap"


def test_un_objectif_deja_atteint_annule():
    order = _queued(stop=90.0, target=101.0)
    out = coach_trader.gate_queued(order, _pf(orders=[order]), _quote(101.5),
                                   TUE_1000, open_price=101.5)
    assert out["reason"] == "open_gap"


def test_les_regles_sont_rejouees_sur_le_vrai_prix():
    """Une thèse vieille de plusieurs jours peut ne plus passer à l'ouverture :
    ici la ligne est devenue trop grosse (cash fondu entre-temps)."""
    order = _queued(qty=15)
    pf = _pf(cash=1000.0, orders=[order])
    out = coach_trader.gate_queued(order, pf, _quote(100.0), TUE_1000,
                                   open_price=100.0)
    assert out["accepted"] is False
    assert out["reason"] != "open_gap"


def test_une_sortie_n_est_jamais_bloquee_par_l_ecart():
    held = [_pos("NESN.SW", qty=20)]
    order = _queued(side="sell", qty=20, risk=None, exit_reason="threat",
                    sell_all=True)
    pf = _pf(positions=held, orders=[order])
    out = coach_trader.gate_queued(order, pf, _quote(80.0), TUE_1000,
                                   open_price=78.0)
    assert out["accepted"] is True
    assert out["order"]["side"] == "sell"
    assert out["order"]["kind"] == "market"
    assert out["order"]["exit_reason"] == "threat"


def test_solder_la_ligne_suit_la_quantite_vraiment_tenue():
    held = [_pos("NESN.SW", qty=12)]
    order = _queued(side="sell", qty=20, risk=None, sell_all=True)
    out = coach_trader.gate_queued(order, _pf(positions=held, orders=[order]),
                                   _quote(100.0), TUE_1000)
    assert out["order"]["qty"] == 12


def test_un_contrat_herite_garde_son_echeance():
    order = _queued()
    inherited = {"horizon_days": 15, "invalidation": INVALIDATION,
                 "thesis_deadline": "2026-09-02T18:05:00"}
    out = coach_trader.gate_queued(order, _pf(orders=[order]), _quote(100.0),
                                   TUE_1000, open_price=100.0,
                                   thesis=inherited)
    assert out["order"]["thesis_deadline"] == "2026-09-02T18:05:00"


def test_un_contrat_herite_qui_echoit_pendant_l_attente_est_refuse():
    order = _queued()
    inherited = {"horizon_days": 5, "invalidation": INVALIDATION,
                 "thesis_deadline": "2026-08-26T18:05:00"}
    out = coach_trader.gate_queued(order, _pf(orders=[order]), _quote(100.0),
                                   TUE_1000, open_price=100.0,
                                   thesis=inherited)
    assert out["reason"] == "thesis_expiring"


def test_un_horizon_declare_court_a_partir_de_l_execution():
    """Trois jours décidés un vendredi soir ne sont pas mangés par le
    week-end : sans contrat hérité, l'horizon part de l'exécution."""
    order = _queued(horizon_days=3, thesis_deadline="2026-08-26T18:05:00")
    out = coach_trader.gate_queued(order, _pf(orders=[order]), _quote(100.0),
                                   TUE_1000, open_price=100.0)
    assert out["accepted"] is True
    assert out["order"]["thesis_deadline"] == "2026-08-28T10:00:00"


# --- l'échéance de la file ------------------------------------------------ #

def _parse(text):
    return datetime.fromisoformat(text)


def test_expire_a_la_fin_de_la_premiere_seance_europe_le_lundi():
    assert coach_trader.at_open_expiry("NESN.SW", SUNDAY) == "2026-08-24T17:25:00"


def test_expire_le_jour_meme_pour_wall_street_avant_l_ouverture():
    assert coach_trader.at_open_expiry("DAL", TUE_1000) == "2026-08-25T21:55:00"


def test_vendredi_soir_attend_lundi():
    assert coach_trader.at_open_expiry("DAL", FRI_2300) == "2026-08-31T21:55:00"


def test_jamais_plus_de_4_jours():
    for now in (SUNDAY, TUE_1000, FRI_2300):
        for symbol in ("DAL", "NESN.SW"):
            left = _parse(coach_trader.at_open_expiry(symbol, now)) - _parse(now)
            assert left <= timedelta(days=coach_trader.AT_OPEN_MAX_DAYS)


def test_queued_orders_ne_lit_que_la_file():
    pf = _pf(orders=[_queued(oid="a"),
                     dict(_queued(oid="b"), kind="stop"),
                     dict(_queued(oid="c"), status="cancelled")])
    assert [o["id"] for o in coach_trader.queued_orders(pf)] == ["a"]
