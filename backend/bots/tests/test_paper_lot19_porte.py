"""LOT 19 — la PORTE corrige un stop trop serré au lieu de refuser, le rapport
exigé suit le bilan du radar, et chaque décision d'entrée laisse sa trace
chiffrée au registre. 100 % hors ligne, aucun disque réel.

Trois blocs :
  A. :func:`coach_trader.repair_tight_stop` / :func:`coach_trader.gate_entry`
     (purs) et le re-jugement des ordres en file (:func:`gate_queued`) ;
  B. :func:`coach_trader.radar_record` / :func:`required_net_rr` et le seuil
     de ``edge_thin`` ;
  C. la trace : ``ledger_entry(extra=)``, ``Order/Position/Trade.repair``,
     ``economics_view["by_repair"]``, puis le routeur de bout en bout.
"""
import pytest

from backend.bots import paper_router as pr
from backend.bots.paper import coach_trader, llm, models, store
from backend.bots.tests.test_paper_router import (
    COACH, _serie, coach_ledger, coach_portfolio, make_client)

THESIS = "rupture du support sur la faiblesse du secteur"
INVALIDATION = "retour au-dessus de la résistance en clôture"
NOW = "2026-08-25T17:00:00"            # mardi, séance européenne ET US ouverte


def _book(**over):
    book = {"cash_chf": 10200.0, "positions": [], "open_orders": [],
            "trades": [], "fee_profile": "ibkr", "initial_capital": 10200.0}
    book.update(over)
    return book


def _quote(price=85.21, fx=0.83):
    return {"price": price, "currency": "USD", "fx_rate": fx}


# ATR 4,172 % (affiché « 4,17 ») : c'est lui qui donne le stop 94,21 et la
# quantité 40 du cas réel. À 4,170 % pile, le stop vaut 94,20 et 41 titres
# passent encore sous le plafond de risque.
TECH = {"atr14_pct": 4.172}


def _short(**over):
    base = {"action": "short", "symbol": "DAL", "qty": 43, "stop": 89.5,
            "target": 69.74, "thesis": THESIS, "horizon_days": 10,
            "invalidation": INVALIDATION, "setup": "breakout"}
    base.update(over)
    return base


def _buy(**over):
    base = {"action": "buy", "symbol": "DAL", "qty": 20, "stop": 90.0,
            "target": 118.0, "thesis": THESIS, "horizon_days": 5,
            "invalidation": INVALIDATION, "setup": "breakout"}
    base.update(over)
    return base


def _risk_pct(order, price, fx, equity=10200.0):
    return abs(price - order["stop_loss"]) * fx * order["qty"] / equity * 100.0


def _hyp(direction, outcome, day, ident=None):
    return {"id": ident or "h-%s-%s" % (direction, day), "direction": direction,
            "outcome": outcome, "created_at": "2026-07-%02dT09:00:00" % day,
            "tickers": ["DAL"], "status": "closed"}


def _record(hits, misses, n=None):
    return {"hits": hits, "misses": misses, "n": n or hits + misses}


# =========================================================================== #
# B — le bilan du radar
# =========================================================================== #

def test_radar_record_compte_les_trente_dernieres_notees_du_bon_sens():
    hyps = ([_hyp("up", "hit", d) for d in range(1, 10)]
            + [_hyp("up", "miss", d) for d in range(10, 20)]
            + [_hyp("down", "hit", d) for d in range(1, 6)])
    rec = coach_trader.radar_record(hyps, "up")
    assert rec == {"hits": 9, "misses": 10, "n": 19}
    assert coach_trader.radar_record(hyps, "down") == {"hits": 5, "misses": 0,
                                                       "n": 5}


def test_radar_record_prend_les_plus_recentes_et_ignore_les_non_notees():
    old = [_hyp("up", "miss", 1, "old%d" % i) for i in range(10)]
    for i, h in enumerate(old):
        h["created_at"] = "2026-05-%02dT09:00:00" % (i + 1)
    recent = [_hyp("up", "hit", 10 + i % 15, "new%d" % i) for i in range(30)]
    for i, h in enumerate(recent):
        h["created_at"] = "2026-07-%02dT%02d:00:00" % (1 + i % 28, i % 24)
    pending = [dict(_hyp("up", "hit", 5), outcome=None, status="open"),
               dict(_hyp("up", "hit", 6), outcome="")]
    rec = coach_trader.radar_record(old + recent + pending, "up", window=30)
    assert rec == {"hits": 30, "misses": 0, "n": 30}


def test_radar_record_unclear_occupe_une_place_sans_compter():
    hyps = ([_hyp("up", "unclear", d) for d in range(20, 25)]
            + [_hyp("up", "hit", d) for d in range(1, 6)])
    rec = coach_trader.radar_record(hyps, "up", window=7)
    # les 7 plus récentes : 5 unclear + 2 hit
    assert rec == {"hits": 2, "misses": 0, "n": 7}


def test_radar_record_tolere_le_n_importe_quoi():
    assert coach_trader.radar_record(None, "up") == {"hits": 0, "misses": 0,
                                                     "n": 0}
    assert coach_trader.radar_record(["x", 3, {}], "down")["n"] == 0


@pytest.mark.parametrize("hits,misses,expected", [
    (24, 5, 1.0),       # >= 2x : le radar a fait ses preuves
    (18, 3, 1.0),
    (9, 14, 2.0),       # plus de fausses que de justes
    (12, 11, 1.5),      # entre les deux
    (14, 8, 1.5),       # 14 < 2x8
    (16, 8, 1.0),       # pile 2x
    (10, 4, 1.0),       # < 15 tranchees -> 1,5 (cf. test suivant)
])
def test_required_net_rr_selon_le_bilan(hits, misses, expected):
    got = coach_trader.required_net_rr(_record(hits, misses))
    if hits + misses < coach_trader.RADAR_RECORD_MIN_DECIDED:
        expected = coach_trader.MIN_NET_RR
    assert got == expected


def test_required_net_rr_sans_assez_de_tranchees_ou_sans_bilan_vaut_1_5():
    assert coach_trader.required_net_rr(None) == 1.5
    assert coach_trader.required_net_rr(_record(7, 7)) == 1.5
    assert coach_trader.required_net_rr(_record(1, 13)) == 1.5      # 14 < 15
    assert coach_trader.required_net_rr({}) == 1.5
    assert coach_trader.required_net_rr("n'importe quoi") == 1.5


def test_required_net_rr_interrupteur_eteint(monkeypatch):
    monkeypatch.setattr(coach_trader, "RR_BY_RADAR_RECORD", False)
    assert coach_trader.required_net_rr(_record(24, 5)) == 1.5
    assert coach_trader.required_net_rr(_record(9, 14)) == 1.5


def test_les_constantes_du_lot_19():
    assert coach_trader.MIN_NET_RR == 1.5
    assert coach_trader.NET_RR_PROVEN == 1.0
    assert coach_trader.NET_RR_UNPROVEN == 2.0
    assert coach_trader.RADAR_RECORD_WINDOW == 30
    assert coach_trader.RADAR_RECORD_MIN_DECIDED == 15
    assert coach_trader.RR_BY_RADAR_RECORD is True
    assert coach_trader.REPAIR_TIGHT_STOP is True


def test_gate_decision_sans_bilan_garde_le_seuil_d_avant():
    out = coach_trader.gate_decision(_buy(), _book(), _quote(100.0, 1.0),
                                     now=NOW, technical={"atr14_pct": 3.0})
    assert out["accepted"] is True


def test_achat_a_1_7_accepte_sans_bilan_refuse_avec_un_bilan_defavorable():
    quote = _quote(100.0, 1.0)
    tech = {"atr14_pct": 3.0}
    ok = coach_trader.gate_decision(_buy(), _book(), quote, now=NOW,
                                    technical=tech)
    assert ok["accepted"] is True
    # le rapport net est bien dans la fourchette annoncée par la spec
    rr = coach_trader._net_rr(100.0, 118.0, 90.0, 0.1)
    assert 1.5 < rr < 2.0

    bad = coach_trader.gate_decision(_buy(), _book(), quote, now=NOW,
                                     technical=tech,
                                     radar_record=_record(9, 14, 30))
    assert bad["accepted"] is False and bad["reason"] == "edge_thin"

    detail = coach_trader.reject_detail("edge_thin", _buy(), _book(), quote,
                                        now=NOW, technical=tech,
                                        radar_record=_record(9, 14, 30))
    assert "2,0" in detail
    assert "9 justes" in detail and "14 fausses" in detail
    assert "hausse" in detail and "30" in detail


def test_bilan_favorable_abaisse_le_seuil_a_1():
    # R net ~1,45 : refusé à 1,5, accepté à 1,0
    quote = _quote(100.0, 1.0)
    tech = {"atr14_pct": 3.0}
    thin = _buy(target=114.0)              # gain 14 % / risque 10 %
    assert coach_trader.gate_decision(thin, _book(), quote, now=NOW,
                                      technical=tech)["reason"] == "edge_thin"
    assert coach_trader.gate_decision(
        thin, _book(), quote, now=NOW, technical=tech,
        radar_record=_record(24, 5, 29))["accepted"] is True


def test_detail_edge_thin_sans_bilan_garde_le_texte_d_avant():
    detail = coach_trader.reject_detail("edge_thin", _buy(target=105.0),
                                        _book(), _quote(100.0, 1.0), now=NOW)
    assert "1,5 minimum" in detail
    assert "radar" not in detail


def test_detail_edge_thin_bilan_neutre_n_invoque_pas_le_radar():
    detail = coach_trader.reject_detail("edge_thin", _buy(target=105.0),
                                        _book(), _quote(100.0, 1.0), now=NOW,
                                        radar_record=_record(12, 11))
    assert "1,5 minimum" in detail
    assert "radar" not in detail


def test_interrupteur_bilan_eteint_comportement_d_avant(monkeypatch):
    monkeypatch.setattr(coach_trader, "RR_BY_RADAR_RECORD", False)
    out = coach_trader.gate_decision(_buy(), _book(), _quote(100.0, 1.0),
                                     now=NOW, technical={"atr14_pct": 3.0},
                                     radar_record=_record(9, 14))
    assert out["accepted"] is True


def test_edge_view_donne_le_seuil_et_le_bilan_par_sens():
    hyps = ([_hyp("up", "hit", d) for d in range(1, 10)]
            + [_hyp("up", "miss", d) for d in range(10, 24)]
            + [_hyp("down", "hit", d) for d in range(1, 25)]
            + [_hyp("down", "miss", d) for d in range(25, 30)])
    view = coach_trader.edge_view(hyps)
    assert view["up"] == {"required": 2.0, "hits": 9, "misses": 14}
    assert view["down"] == {"required": 1.0, "hits": 24, "misses": 5}


def test_radar_record_for_n_applique_que_dans_le_sens_de_l_hypothese():
    hyps = [_hyp("down", "hit", d) for d in range(1, 20)]
    hyp = dict(hyps[0], id="mine")
    assert coach_trader.radar_record_for(hyp, hyps, "short")["hits"] == 19
    assert coach_trader.radar_record_for(hyp, hyps, "buy") is None
    assert coach_trader.radar_record_for(None, hyps, "short") is None


# =========================================================================== #
# A — la correction du stop
# =========================================================================== #

def test_cas_reel_short_le_stop_serre_est_corrige_et_la_taille_reduite():
    out = coach_trader.gate_entry(_short(), _book(), _quote(), now=NOW,
                                  technical=TECH)
    assert out["accepted"] is True, out
    order = out["order"]
    assert order["repair"] == "stop_in_noise"
    assert order["stop_loss"] >= 94.2
    assert abs(order["stop_loss"] - 94.21) < 0.1
    assert order["qty"] == 40
    assert _risk_pct(order, 85.21, 0.83) <= coach_trader.MAX_RISK_PCT
    info = out["repair"]
    assert info["code"] == "stop_in_noise"
    assert info["stop_asked"] == 89.5 and info["qty_asked"] == 43
    assert info["stop"] == order["stop_loss"] and info["qty"] == 40
    assert 10.0 < info["floor_pct"] < 11.2
    assert out["decision"]["stop"] == order["stop_loss"]
    assert out["decision"]["qty"] == 40


def test_la_correction_arrondit_du_cote_sur_a_deux_decimales():
    out = coach_trader.gate_entry(_short(), _book(), _quote(), now=NOW,
                                  technical=TECH)
    stop = out["order"]["stop_loss"]
    assert round(stop, 2) == stop
    exact = 85.21 * (1 + out["repair"]["floor_pct"] / 100.0)
    assert stop >= exact - 1e-9                      # short : vers le haut
    buy = coach_trader.gate_entry(_buy(stop=97.0, qty=10), _book(),
                                  _quote(100.0, 1.0), now=NOW,
                                  technical={"atr14_pct": 3.0})
    assert buy["accepted"] is True
    stop = buy["order"]["stop_loss"]
    exact = 100.0 * (1 - buy["repair"]["floor_pct"] / 100.0)
    assert round(stop, 2) == stop and stop <= exact + 1e-9   # long : vers le bas


def test_un_stop_deja_au_dela_du_plancher_n_est_pas_touche():
    out = coach_trader.gate_entry(_short(stop=95.0, qty=37), _book(), _quote(),
                                  now=NOW, technical=TECH)
    assert out["accepted"] is True, out
    assert "repair" not in out
    assert "repair" not in out["order"]
    assert out["order"]["stop_loss"] == 95.0
    assert coach_trader.repair_tight_stop(
        _short(stop=95.0, qty=37), _book(), _quote(), now=NOW,
        technical=TECH) is None


def test_repair_tight_stop_retourne_la_decision_corrigee_et_l_info():
    fixed, info = coach_trader.repair_tight_stop(_short(), _book(), _quote(),
                                                 now=NOW, technical=TECH)
    assert fixed["stop"] == info["stop"] and fixed["qty"] == info["qty"] == 40
    assert fixed["symbol"] == "DAL" and fixed["target"] == 69.74
    assert info["code"] == "stop_in_noise"


def test_pas_de_correction_hors_cas_prevus():
    book, quote = _book(), _quote()
    rep = coach_trader.repair_tight_stop
    # pas une entrée
    assert rep({"action": "sell", "symbol": "DAL", "qty": 3}, book, quote,
               now=NOW, technical=TECH) is None
    # stop absent / du mauvais côté
    assert rep(_short(stop=None), book, quote, now=NOW, technical=TECH) is None
    assert rep(_short(stop=80.0), book, quote, now=NOW, technical=TECH) is None
    assert rep(_buy(stop=120.0), book, _quote(100.0, 1.0), now=NOW,
               technical=TECH) is None
    # pas de cotation
    assert rep(_short(), book, {}, now=NOW, technical=TECH) is None
    # pas de contrat de thèse
    assert rep(_short(horizon_days=None), book, quote, now=NOW,
               technical=TECH) is None
    assert rep(_short(invalidation=""), book, quote, now=NOW,
               technical=TECH) is None


def test_interrupteur_correction_eteint_on_refuse_comme_avant(monkeypatch):
    monkeypatch.setattr(coach_trader, "REPAIR_TIGHT_STOP", False)
    out = coach_trader.gate_entry(_short(), _book(), _quote(), now=NOW,
                                  technical=TECH)
    assert out["accepted"] is False and out["reason"] == "stop_in_noise"
    assert "repair" not in out
    assert coach_trader.repair_tight_stop(_short(), _book(), _quote(), now=NOW,
                                          technical=TECH) is None


def test_stop_du_mauvais_cote_reste_no_stop_et_rien_n_est_repare():
    out = coach_trader.gate_entry(_short(stop=80.0), _book(), _quote(),
                                  now=NOW, technical=TECH)
    assert out["accepted"] is False and out["reason"] == "no_stop"
    assert "repair" not in out


def test_adjust_stop_dans_le_bruit_reste_refuse():
    line = {"symbol": "DAL", "side": "long", "qty": 20, "avg_price": 100.0,
            "stop_loss": 90.0, "fx_rate": 1.0, "currency": "USD"}
    book = _book(positions=[line], cash_chf=8200.0)
    out = coach_trader.gate_entry(
        {"action": "adjust_stop", "symbol": "DAL", "stop": 98.5}, book,
        _quote(100.0, 1.0), now=NOW, technical={"atr14_pct": 3.0})
    assert out["accepted"] is False and out["reason"] == "stop_in_noise"
    assert "repair" not in out
    assert coach_trader.repair_tight_stop(
        {"action": "adjust_stop", "symbol": "DAL", "stop": 98.5}, book,
        _quote(100.0, 1.0), now=NOW, technical={"atr14_pct": 3.0}) is None


def test_correction_rejuge_tout_et_donne_le_code_du_second_passage():
    # même titre à 82,82, stop 88 : le rapport net tombe sous 1,5 une fois le
    # stop remis au plancher -> edge_thin, et le texte parle de l'ordre corrigé
    quote = _quote(82.82)
    decision = _short(stop=88.0)
    one = coach_trader.gate_decision(decision, _book(), quote, now=NOW,
                                     technical=TECH)
    assert one["reason"] == "stop_in_noise"           # l'ancien verdict
    out = coach_trader.gate_entry(decision, _book(), quote, now=NOW,
                                  technical=TECH)
    assert out["accepted"] is False and out["reason"] == "edge_thin"
    assert out["repair"]["stop_asked"] == 88.0
    assert out["decision"]["stop"] == out["repair"]["stop"]
    rr = coach_trader._net_rr(82.82, 69.74, out["repair"]["stop"], 0.1)
    assert 1.3 < rr < 1.5


def test_meme_titre_accepte_avec_un_bilan_baissier_favorable():
    quote = _quote(82.82)
    out = coach_trader.gate_entry(_short(stop=88.0), _book(), quote, now=NOW,
                                  technical=TECH,
                                  radar_record=_record(18, 3))
    assert out["accepted"] is True, out
    assert out["order"]["repair"] == "stop_in_noise"
    # le bilan joue aussi sur le second passage ; sans lui : edge_thin
    assert coach_trader.gate_entry(_short(stop=88.0), _book(), quote, now=NOW,
                                   technical=TECH)["reason"] == "edge_thin"


def test_correction_qui_rend_la_ligne_trop_petite_refus_too_small():
    # ATR énorme -> le stop corrigé est très loin -> la taille fond sous le
    # plancher de 5 % de l'équité : l'ordre CORRIGÉ est refusé, et le code est
    # celui du second passage.
    out = coach_trader.gate_entry(_short(qty=43, target=30.0), _book(),
                                  _quote(), now=NOW,
                                  technical={"atr14_pct": 25.0})
    assert out["accepted"] is False
    assert out["reason"] == "too_small"
    assert out["repair"]["qty"] < out["repair"]["qty_asked"]
    assert out["decision"]["qty"] == out["repair"]["qty"]
    assert "order" in out and out["order"] is None
    detail = coach_trader.repair_note(out["repair"], accepted=False)
    assert detail.startswith("ordre corrigé (stop 89,50 → ")
    assert detail.endswith(") puis refusé : ")
    assert "43 → %d titres" % out["repair"]["qty"] in detail


def test_repair_note_formate_les_deux_cas_en_francais():
    info = {"code": "stop_in_noise", "stop_asked": 89.5, "stop": 94.21,
            "qty_asked": 43, "qty": 40, "floor_pct": 10.56}
    assert coach_trader.repair_note(info, accepted=True) == (
        " — ordre corrigé : stop 89,50 → 94,21 (plancher de bruit 10,6 %), "
        "43 → 40 titres")
    assert coach_trader.repair_note(info, accepted=False) == (
        "ordre corrigé (stop 89,50 → 94,21, 43 → 40 titres) puis refusé : ")
    assert coach_trader.repair_note(None, accepted=True) == ""


def test_embuscade_le_niveau_de_reference_est_le_trigger():
    # short armé SOUS le cours : référence = trigger 80, pas le cours 85,21
    decision = _short(kind="stop", trigger=80.0, stop=84.0, qty=40,
                      target=60.0)
    out = coach_trader.gate_entry(decision, _book(), _quote(), now=NOW,
                                  technical=TECH)
    assert out["accepted"] is True, out
    assert out["order"]["kind"] == "stop"
    assert out["order"]["trigger"] == 80.0
    assert out["order"]["stop_loss"] >= 80.0 * (1 + 0.1)
    assert out["order"]["repair"] == "stop_in_noise"


def test_marche_ferme_l_entree_corrigee_part_en_file():
    sunday = "2026-08-23T18:05:00"
    out = coach_trader.gate_entry(_short(symbol="NESN.SW"), _book(), _quote(),
                                  now=sunday, technical=TECH)
    assert out["accepted"] is True, out
    assert out["order"]["kind"] == coach_trader.AT_OPEN_KIND
    assert out["order"]["repair"] == "stop_in_noise"


# --- propriété ------------------------------------------------------------ #

def _grid():
    for action in ("buy", "short"):
        for price in (4.37, 19.9, 85.21, 142.0, 960.0):
            for atr in (0.8, 2.5, 4.17, 7.0):
                for horizon in (3, 10, 25):
                    for qty in (5, 40, 200, 1500):
                        for dist_pct in (0.5, 2.0, 5.0):
                            yield action, price, atr, horizon, qty, dist_pct


def test_propriete_la_decision_corrigee_n_est_jamais_dans_le_bruit_ni_hors_risque():
    n_fixed = 0
    for action, price, atr, horizon, qty, dist in _grid():
        sign = -1.0 if action == "buy" else 1.0
        stop = round(price * (1 + sign * dist / 100.0), 2)
        if stop <= 0 or stop == price:
            continue
        decision = {"action": action, "symbol": "DAL", "qty": qty,
                    "stop": stop, "target": price * (1 - sign * 0.3),
                    "thesis": THESIS, "horizon_days": horizon,
                    "invalidation": INVALIDATION}
        quote = {"price": price, "currency": "USD", "fx_rate": 0.9}
        tech = {"atr14_pct": atr}
        got = coach_trader.repair_tight_stop(decision, _book(), quote,
                                             now=NOW, technical=tech)
        if got is None:
            continue
        n_fixed += 1
        fixed, info = got
        assert 1 <= info["qty"] <= qty
        verdict = coach_trader.gate_decision(fixed, _book(), quote, now=NOW,
                                             technical=tech)
        assert verdict.get("reason") != "stop_in_noise", (decision, fixed)
        risk = abs(price - fixed["stop"]) * 0.9 * fixed["qty"]
        assert risk <= 10200.0 * coach_trader.MAX_RISK_PCT / 100.0 + 1e-6, (
            decision, fixed)
        # le bon côté du cours
        if action == "buy":
            assert fixed["stop"] < price
        else:
            assert fixed["stop"] > price
    assert n_fixed > 100          # la grille exerce vraiment la correction


# --- re-jugement des ordres en file ---------------------------------------- #

def _queued_row(**over):
    row = {"id": "q1", "kind": "at_open", "side": "short", "symbol": "DAL",
           "qty": 40, "stop_loss": 94.21, "target": 69.74, "thesis": THESIS,
           "setup": "breakout", "horizon_days": 10,
           "invalidation": INVALIDATION, "ref_price": 85.21, "status": "open",
           "repair": "stop_in_noise"}
    row.update(over)
    return row


def test_file_ecart_dans_le_bon_sens_stop_reancre_sans_risk_high():
    # le cours baisse de 2 % : l'ancien stop serait à 12,8 % -> on le re-ancre
    price = 85.21 * 0.98
    out = coach_trader.gate_queued(_queued_row(), _book(), _quote(price), NOW,
                                   technical=TECH, open_price=price)
    assert out["accepted"] is True, out
    order = out["order"]
    assert order["repair"] == "stop_in_noise"
    assert order["stop_loss"] < 94.21                  # re-ancré, plus près
    assert order["stop_loss"] >= price * 1.1
    assert order["qty"] == 40                          # jamais plus que demandé
    assert _risk_pct(order, price, 0.83) <= coach_trader.MAX_RISK_PCT


def test_file_ecart_dans_le_mauvais_sens_stop_reancre_et_quantite_reduite():
    price = 85.21 * 1.04            # sous la garde : max(3 %, 1 ATR = 4,17 %)
    out = coach_trader.gate_queued(_queued_row(), _book(), _quote(price), NOW,
                                   technical=TECH, open_price=price)
    assert out["accepted"] is True, out
    order = out["order"]
    assert order["stop_loss"] >= price * 1.1
    assert order["qty"] < 40
    assert _risk_pct(order, price, 0.83) <= coach_trader.MAX_RISK_PCT


def test_file_ecart_au_dela_de_la_garde_reste_open_gap():
    price = 85.21 * 1.10
    out = coach_trader.gate_queued(_queued_row(), _book(), _quote(price), NOW,
                                   technical=TECH, open_price=price)
    assert out["accepted"] is False and out["reason"] == "open_gap"


def test_file_sans_etiquette_repair_meme_logique_que_gate_entry():
    # ordre en file SANS repair dont le stop tombe dans le bruit au re-jugement
    row = _queued_row(repair="", stop_loss=89.5, qty=43)
    out = coach_trader.gate_queued(row, _book(), _quote(), NOW, technical=TECH,
                                   open_price=85.21)
    assert out["accepted"] is True, out
    assert out["order"]["repair"] == "stop_in_noise"
    assert out["repair"]["stop_asked"] == 89.5


def test_file_ordre_non_touche_garde_son_etiquette_si_rien_a_corriger():
    row = _queued_row(stop_loss=95.5, repair="stop_in_noise")
    out = coach_trader.gate_queued(row, _book(), _quote(), NOW, technical=TECH,
                                   open_price=85.21)
    assert out["accepted"] is True
    assert out["order"]["repair"] == "stop_in_noise"


def test_file_sortie_jamais_corrigee_ni_soumise_a_la_garde():
    row = {"id": "q2", "kind": "at_open", "side": "sell", "symbol": "DAL",
           "qty": 5, "ref_price": 100.0, "status": "open"}
    book = _book(positions=[{"symbol": "DAL", "side": "long", "qty": 5,
                             "avg_price": 100.0, "stop_loss": 90.0,
                             "fx_rate": 1.0, "currency": "USD"}])
    out = coach_trader.gate_queued(row, book, _quote(60.0, 1.0), NOW)
    assert out["accepted"] is True and out["order"]["side"] == "sell"
    assert "repair" not in out["order"]


# =========================================================================== #
# C — la trace
# =========================================================================== #

def test_ledger_entry_extra_ajoute_plan_et_repair_seulement_s_ils_existent():
    plain = coach_trader.ledger_entry("t", "daily", "buy", "dal", True)
    assert "plan" not in plain and "repair" not in plain
    row = coach_trader.ledger_entry("t", "daily", "buy", "dal", True,
                                    extra={"plan": {"qty": 3},
                                           "repair": {"code": "x"},
                                           "zzz": 1})
    assert row["plan"] == {"qty": 3} and row["repair"] == {"code": "x"}
    assert "zzz" not in row
    only = coach_trader.ledger_entry("t", "daily", "buy", "dal", True,
                                     extra={"plan": {"qty": 3}})
    assert "repair" not in only


def test_entry_plan_donne_les_valeurs_jugees_et_none_si_inconnu():
    fixed, info = coach_trader.repair_tight_stop(_short(), _book(), _quote(),
                                                 now=NOW, technical=TECH)
    plan = coach_trader.entry_plan(fixed, _book(), _quote(), now=NOW,
                                   technical=TECH,
                                   radar_record=_record(18, 3), kind="market")
    assert set(plan) == {"qty", "level", "stop", "target", "kind",
                         "horizon_days", "atr_pct", "floor_pct", "net_rr",
                         "required_rr", "fx_rate"}
    assert plan["qty"] == 40 and plan["level"] == 85.21
    assert plan["stop"] == fixed["stop"] and plan["target"] == 69.74
    assert plan["kind"] == "market" and plan["horizon_days"] == 10
    assert plan["atr_pct"] == 4.172 and plan["fx_rate"] == 0.83
    assert plan["required_rr"] == 1.0
    assert plan["net_rr"] is not None and plan["net_rr"] > 1.5
    assert plan["floor_pct"] == info["floor_pct"]
    empty = coach_trader.entry_plan({"action": "buy", "symbol": "DAL"},
                                    _book(), {}, now=NOW)
    assert empty["level"] is None and empty["net_rr"] is None
    assert empty["floor_pct"] is None and empty["fx_rate"] is None
    assert empty["qty"] is None and empty["required_rr"] == 1.5


def test_trade_position_order_portent_repair_et_se_relisent_sans_lui():
    for cls in (models.Order, models.Position, models.Trade):
        data = cls.from_dict({}).to_dict()
        assert cls.from_dict({}).repair == ""
        assert data["repair"] == ""
        data.pop("repair")
        assert cls.from_dict(data).repair == ""
        data["repair"] = "stop_in_noise"
        assert cls.from_dict(data).repair == "stop_in_noise"


def test_economics_view_ventile_par_correction():
    trades = [
        {"repair": "stop_in_noise", "pnl_chf": 50.0},
        {"repair": "stop_in_noise", "pnl_chf": -20.0},
        {"repair": "", "pnl_chf": 10.0},
        {"pnl_chf": -5.0},
    ]
    view = coach_trader.economics_view({"cash_chf": 10000, "trades": trades,
                                        "positions": []})
    assert view["by_repair"]["repaired"] == {"n_trades": 2, "n_wins": 1,
                                             "net_pnl_chf": 30.0}
    assert view["by_repair"]["as_asked"] == {"n_trades": 2, "n_wins": 1,
                                             "net_pnl_chf": 5.0}
    only = coach_trader.economics_view({"cash_chf": 10000, "positions": [],
                                        "trades": [{"pnl_chf": 1.0}]})
    assert list(only["by_repair"]) == ["as_asked"]
    assert coach_trader.economics_view({"cash_chf": 1})["by_repair"] == {}


def test_le_bloc_d_actions_explique_les_trois_seuils_et_la_correction():
    book = {"cash_chf": 10000.0, "equity_chf": 10000.0, "positions": [],
            "open_orders": [], "candidates": [],
            "edge": {"up": {"required": 2.0, "hits": 9, "misses": 14},
                     "down": {"required": 1.0, "hits": 24, "misses": 5}}}
    block = llm.coach_actions_block(book)
    low = block.lower()
    assert "edge" in block and "``edge``" in block
    assert '"required": 2.0' in block and '"hits": 24' in block
    for needle in ("1,0", "1,5", "2,0"):
        assert needle in block
    assert "edge_thin" in block
    assert "plancher" in low and "écarte" in low
    assert "le registre le dit" in low
    # la consigne finale reste vraie : le bloc d'exemple ferme la section
    tail = block.rsplit("Termine IMPÉRATIVEMENT", 1)[1]
    assert tail.rstrip().endswith("```")
    assert "COACH_ACTIONS" in tail
    assert block.count("Termine IMPÉRATIVEMENT") == 1


def test_coach_book_of_laisse_passer_le_bloc_edge():
    ctx = {"cash_chf": 1, "edge": {"up": {"required": 1.5, "hits": 0,
                                          "misses": 0}}}
    assert llm._coach_book_of(ctx)["edge"]["up"]["required"] == 1.5
    assert llm._coach_book_of({})["edge"] == {}


# =========================================================================== #
# C — le routeur, de bout en bout (hors ligne)
# =========================================================================== #

TUE = NOW


def _router(tmp_path, monkeypatch, tech=None):
    c, market = make_client(tmp_path, monkeypatch)
    market.prices["DAL"] = (85.21, "USD", "Delta")
    market.fx["USD"] = 0.83
    market.candles["DAL"] = _serie()
    monkeypatch.setattr(pr, "_coach_technical",
                        lambda symbol, price=None: dict(tech or TECH))
    pf = pr._ensure_coach_account()
    pf.fee_profile = "ibkr"
    pr._save(COACH, pf)
    return market


def _seed_radar(monkeypatch, hyps):
    monkeypatch.setattr(pr, "_radar_hypotheses", lambda: list(hyps))
    monkeypatch.setattr(pr, "_open_radar_hypotheses",
                        lambda: [h for h in hyps if h.get("status") == "open"])


def _rshort(**over):
    """Le cas réel, à l'échelle du compte du coach (10 000 CHF : 43 titres
    dépasseraient le plafond de 30 % par ligne — 42 passent)."""
    return _short(**dict({"qty": 42}, **over))


def _run(action, now=TUE, source="daily"):
    return pr.execute_coach_actions([action], source, now)


def test_routeur_entree_corrigee_posee_au_carnet_avec_trace(tmp_path, monkeypatch):
    _router(tmp_path, monkeypatch)
    rows = _run(_rshort())
    row = rows[0]
    assert row["accepted"] is True and row["action"] == "short"
    assert "— ordre corrigé : stop 89,50 → " in row["detail"]
    assert row["detail"].endswith("42 → 40 titres")
    assert row["repair"]["code"] == "stop_in_noise"
    assert row["repair"]["qty"] == 40
    plan = row["plan"]
    assert plan["qty"] == 40 and plan["target"] == 69.74
    assert plan["net_rr"] is not None and plan["fx_rate"] == 0.83
    assert plan["kind"] == "market" and plan["required_rr"] == 1.5
    # la position porte l'étiquette et le stop corrigé
    book = coach_portfolio()
    line = book["positions"][0]
    assert line["qty"] == 40 and line["repair"] == "stop_in_noise"
    assert line["stop_loss"] == row["repair"]["stop"]
    assert line["risk_chf"] <= 10000.0 * 0.03 + 1e-6
    # le registre ET l'archive mensuelle reçoivent les champs
    assert coach_ledger()[0]["plan"] == plan
    archived = store.load_ledger_archive(COACH)
    assert any(r.get("repair") and r.get("plan") for r in archived)


def test_routeur_entree_corrigee_puis_refusee_le_detail_est_prefixe(
        tmp_path, monkeypatch):
    market = _router(tmp_path, monkeypatch)
    market.prices["DAL"] = (82.82, "USD", "Delta")
    rows = _run(_rshort(stop=88.0))
    row = rows[0]
    assert row["accepted"] is False and row["reason"] == "edge_thin"
    assert row["detail"].startswith("ordre corrigé (stop 88,00 → ")
    assert "puis refusé : " in row["detail"]
    assert row["repair"]["stop_asked"] == 88.0
    assert row["plan"]["stop"] == row["repair"]["stop"]
    assert coach_portfolio()["positions"] == []


def test_routeur_entree_normale_a_un_plan_sans_repair(tmp_path, monkeypatch):
    _router(tmp_path, monkeypatch)
    rows = _run(_rshort(stop=94.5, qty=38))
    row = rows[0]
    assert row["accepted"] is True
    assert "repair" not in row
    assert row["plan"]["stop"] == 94.5 and row["plan"]["qty"] == 38
    assert coach_portfolio()["positions"][0]["repair"] == ""


def test_routeur_un_refus_d_entree_garde_son_plan(tmp_path, monkeypatch):
    _router(tmp_path, monkeypatch)
    rows = _run(_rshort(target=None))
    row = rows[0]
    assert row["accepted"] is False and row["reason"] == "no_target"
    assert row["plan"]["target"] is None and row["plan"]["qty"] == 42
    assert "repair" not in row


def test_routeur_une_sortie_n_a_pas_de_plan(tmp_path, monkeypatch):
    _router(tmp_path, monkeypatch)
    _run(_rshort(stop=94.5, qty=38))
    rows = _run({"action": "cover", "symbol": "DAL", "exit_reason": "target"})
    assert "plan" not in rows[0]


def test_routeur_le_trade_clos_garde_l_etiquette(tmp_path, monkeypatch):
    market = _router(tmp_path, monkeypatch)
    _run(_rshort())
    market.prices["DAL"] = (80.0, "USD", "Delta")
    _run({"action": "cover", "symbol": "DAL", "exit_reason": "target"},
         now="2026-08-25T17:30:00")
    book = coach_portfolio()
    assert book["positions"] == []
    assert book["trades"][0]["repair"] == "stop_in_noise"
    view = coach_trader.economics_view(book)
    assert view["by_repair"]["repaired"]["n_trades"] == 1


def test_routeur_le_bilan_du_radar_ne_joue_que_pour_une_idee_du_radar(
        tmp_path, monkeypatch):
    _router(tmp_path, monkeypatch, tech={"atr14_pct": 3.0})
    hyps = ([_hyp("up", "hit", d) for d in range(1, 10)]
            + [_hyp("up", "miss", d) for d in range(10, 24)])
    hyps.append({"id": "live", "direction": "up", "status": "open",
                 "outcome": None, "created_at": "2026-08-24T09:00:00",
                 "tickers": ["DAL"], "horizon_days": 20,
                 "invalidation": INVALIDATION, "thesis": THESIS})
    _seed_radar(monkeypatch, hyps)
    monkeypatch.setattr(pr, "_radar_hypothesis_of", lambda s: "live")
    # achat du radar, bilan haussier mauvais (9/14) -> seuil 2,0 -> refusé
    monkeypatch.setattr(pr, "_coach_quote",
                        lambda s: {"price": 100.0, "currency": "CHF",
                                   "fx_rate": 1.0})
    buy = _buy(horizon_days=None, invalidation=None)
    rows = _run(buy, source="daily")
    assert rows[0]["accepted"] is False and rows[0]["reason"] == "edge_thin"
    assert "2,0" in rows[0]["detail"] and "9 justes" in rows[0]["detail"]
    assert rows[0]["plan"]["required_rr"] == 2.0
    # une idée qui ne vient PAS du radar garde 1,5
    monkeypatch.setattr(pr, "_radar_hypothesis_of", lambda s: None)
    rows = _run(_buy(), source="daily")
    assert rows[0]["accepted"] is True
    assert rows[0]["plan"]["required_rr"] == 1.5


def test_routeur_un_ordre_a_contre_sens_de_l_hypothese_garde_1_5(
        tmp_path, monkeypatch):
    _router(tmp_path, monkeypatch, tech={"atr14_pct": 3.0})
    hyps = ([_hyp("up", "hit", d) for d in range(1, 10)]
            + [_hyp("up", "miss", d) for d in range(10, 24)])
    hyps.append({"id": "live", "direction": "up", "status": "open",
                 "outcome": None, "created_at": "2026-08-24T09:00:00",
                 "tickers": ["DAL"], "horizon_days": 20,
                 "invalidation": INVALIDATION, "thesis": THESIS})
    _seed_radar(monkeypatch, hyps)
    monkeypatch.setattr(pr, "_radar_hypothesis_of", lambda s: "live")
    monkeypatch.setattr(pr, "_coach_quote",
                        lambda s: {"price": 100.0, "currency": "CHF",
                                   "fx_rate": 1.0})
    short = {"action": "short", "symbol": "DAL", "qty": 20, "stop": 110.0,
             "target": 82.0, "thesis": THESIS, "horizon_days": None,
             "invalidation": None}
    rows = _run(short)
    assert rows[0]["plan"]["required_rr"] == 1.5


def test_routeur_embuscade_corrigee_porte_l_etiquette_jusqu_a_l_ordre(
        tmp_path, monkeypatch):
    _router(tmp_path, monkeypatch)
    rows = _run(_rshort(kind="stop", trigger=80.0, stop=84.0, qty=40,
                        target=60.0))
    row = rows[0]
    assert row["action"] == "arm_ambush" and row["accepted"] is True, row
    assert row["repair"]["code"] == "stop_in_noise"
    assert row["plan"]["kind"] == "stop" and row["plan"]["level"] == 80.0
    assert row["detail"].endswith("titres") or "ordre corrigé" in row["detail"]
    armed = [o for o in coach_portfolio()["open_orders"] if o["kind"] == "stop"]
    assert armed[0]["repair"] == "stop_in_noise"
    assert armed[0]["stop_loss"] >= 80.0 * 1.1
    assert armed[0]["risk_chf"] <= 10000.0 * 0.03 + 1e-6


# --- file « à l'ouverture » de bout en bout ------------------------------- #

SUNDAY = "2026-08-23T18:05:00"
MONDAY_0930 = "2026-08-24T09:30:00"


def _candle(stamp, open_, close):
    from datetime import datetime
    ts = datetime.fromisoformat(stamp).timestamp()
    return {"ts": ts, "open": open_, "high": max(open_, close) * 1.002,
            "low": min(open_, close) * 0.998, "close": close, "volume": 1000}


def _queue_setup(tmp_path, monkeypatch):
    market = _router(tmp_path, monkeypatch)
    market.prices["NESN.SW"] = (85.21, "CHF", "Nestle SA")
    market.fx["CHF"] = 0.83
    market.candles["NESN.SW"] = _serie()
    rows = pr.execute_coach_actions([_rshort(symbol="NESN.SW")], "daily", SUNDAY)
    return market, rows


def _queue():
    return [o for o in coach_portfolio()["open_orders"]
            if o["kind"] == "at_open"]


def test_routeur_la_file_porte_l_etiquette_et_le_plan(tmp_path, monkeypatch):
    market, rows = _queue_setup(tmp_path, monkeypatch)
    assert rows[0]["action"] == "queue_open" and rows[0]["accepted"] is True
    assert rows[0]["repair"]["code"] == "stop_in_noise"
    assert rows[0]["plan"]["kind"] == "at_open"
    assert rows[0]["detail"].endswith("42 → 40 titres")
    queued = _queue()[0]
    assert queued["repair"] == "stop_in_noise" and queued["qty"] == 40
    assert queued["risk_chf"] > 0


def test_routeur_ordre_en_file_execute_avec_stop_et_risque_reancres(
        tmp_path, monkeypatch):
    market, _ = _queue_setup(tmp_path, monkeypatch)
    new_price = 85.21 * 0.98
    market.prices["NESN.SW"] = (new_price, "CHF", "Nestle SA")
    market.candles["NESN.SW"] = _serie() + [
        _candle("2026-08-24T09:20:00", new_price * 1.001, new_price)]
    pr.tick_coach_account(MONDAY_0930)
    book = coach_portfolio()
    assert _queue() == []
    line = book["positions"][0]
    assert line["repair"] == "stop_in_noise"
    assert line["qty"] == 40
    assert line["stop_loss"] >= new_price * 1.1
    assert line["stop_loss"] < 94.21
    expected = abs(new_price - line["stop_loss"]) * 0.83 * 40
    assert abs(line["risk_chf"] - expected) < 0.05
    assert line["risk_chf"] <= 10000.0 * 0.03 + 1e-6
    top = coach_ledger()[0]
    assert top["action"] == "queue_filled" and top["accepted"] is True
    assert top["repair"]["code"] == "stop_in_noise"
    assert top["plan"]["stop"] == line["stop_loss"]


def test_routeur_ordre_en_file_ecart_defavorable_quantite_reduite(
        tmp_path, monkeypatch):
    market, _ = _queue_setup(tmp_path, monkeypatch)
    new_price = 85.21 * 1.04
    market.prices["NESN.SW"] = (new_price, "CHF", "Nestle SA")
    market.candles["NESN.SW"] = _serie() + [
        _candle("2026-08-24T09:20:00", new_price * 0.999, new_price)]
    pr.tick_coach_account(MONDAY_0930)
    line = coach_portfolio()["positions"][0]
    assert line["qty"] < 40
    assert line["stop_loss"] >= new_price * 1.1
    assert line["risk_chf"] <= 10000.0 * 0.03 + 1e-6


def test_routeur_ordre_en_file_au_dela_de_la_garde_open_gap(tmp_path, monkeypatch):
    market, _ = _queue_setup(tmp_path, monkeypatch)
    new_price = 85.21 * 1.10
    market.prices["NESN.SW"] = (new_price, "CHF", "Nestle SA")
    market.candles["NESN.SW"] = _serie() + [
        _candle("2026-08-24T09:20:00", new_price, new_price)]
    pr.tick_coach_account(MONDAY_0930)
    top = coach_ledger()[0]
    assert top["action"] == "queue_cancelled" and top["reason"] == "open_gap"
    assert top["plan"]["qty"] == 40
    assert coach_portfolio()["positions"] == []


# --- le bloc ``edge`` du livre -------------------------------------------- #

def test_radar_direction_suit_le_radar():
    from backend.bots.paper import radar
    for raw in ("up", "down", "baisse", "BEAR", "short", "descente", "hausse",
                "", None, "n'importe quoi", " Down "):
        assert coach_trader._radar_direction(raw) == radar._clamp_direction(raw)


def test_les_deux_livres_du_coach_portent_le_bloc_edge(tmp_path, monkeypatch):
    """Le contexte de la passe ET le livre du digest : le mandat vit dans un
    bloc PARTAGÉ, il ne peut pas être renseigné d'un seul côté."""
    _router(tmp_path, monkeypatch)
    hyps = ([_hyp("up", "hit", d) for d in range(1, 10)]
            + [_hyp("up", "miss", d) for d in range(10, 24)]
            + [_hyp("down", "hit", d) for d in range(1, 25)]
            + [_hyp("down", "miss", d) for d in range(25, 30)])
    _seed_radar(monkeypatch, hyps)
    expected = {"up": {"required": 2.0, "hits": 9, "misses": 14},
                "down": {"required": 1.0, "hits": 24, "misses": 5}}
    portfolio = pr._ensure_coach_account()
    assert pr._coach_pass_context(portfolio, NOW)["edge"] == expected
    assert pr.coach_book()["edge"] == expected
    # ... et il arrive jusque dans le prompt
    block = llm.coach_actions_block(pr.coach_book())
    assert '"required": 2.0' in block
