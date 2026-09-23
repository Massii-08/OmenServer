"""Tests du LOT A/B — profils de frais (Task 1) et pré-check (Task 3).

100 % hors ligne : ``precheck.evaluate`` est PUR (aucun I/O, tout est injecté)
et ``fees`` l'était déjà. Aucun test ne touche le disque ni le réseau.

Spec : ``docs/superpowers/specs/2026-09-09-tv-coach-extension-design.md``
(§5.2 le contrat, §6.3 les neuf garde-fous scalp, §6.4 les profils).
"""
import pytest

from backend.bots.paper import coach_trader, fees, precheck

# --------------------------------------------------------------------------- #
# Task 1 — profils de frais
#
# Le premier bloc est un VERROU de non-régression : les trois profils qui
# existaient avant ce lot doivent rendre exactement les mêmes centimes. Les
# valeurs ci-dessous ont été relevées sur le code AVANT le patch (Python 3.9.6,
# 09/09) — si l'une bouge, c'est que l'ajout des quatre nouveaux profils a
# débordé sur les anciens.
# --------------------------------------------------------------------------- #

FROZEN = [
    ("yuh", 10000, "NESN.SW", 50.0, 7.5, 57.5, 1.15),
    ("yuh", 10000, "AAPL", 50.0, 15.0, 65.0, 1.3),
    ("yuh", 100, "AAPL", 1.0, 0.15, 1.15, 2.3),
    ("swissquote", 10000, "NESN.SW", 30.0, 7.5, 37.5, 0.75),
    ("swissquote", 3000, "AAPL", 20.0, 4.5, 24.5, 1.6333),
    ("swissquote", 30000, "AAPL", 135.0, 45.0, 180.0, 1.2),
    ("ibkr", 10000, "NESN.SW", 5.0, 0.0, 5.0, 0.1),
    ("ibkr", 10000, "AAPL", 5.0, 0.0, 5.0, 0.1),
    ("ibkr", 100, "AAPL", 1.5, 0.0, 1.5, 3.0),
]


@pytest.mark.parametrize("profile,amount,symbol,brokerage,duty,total,rt", FROZEN)
def test_les_trois_profils_existants_sont_bit_a_bit_inchanges(
        profile, amount, symbol, brokerage, duty, total, rt):
    got = fees.compute_fees(profile, amount, symbol)
    assert got == {"brokerage_chf": brokerage, "stamp_duty_chf": duty,
                   "total_chf": total}
    assert fees.round_trip_pct(profile, amount, symbol) == rt


def test_les_quatre_nouveaux_profils_existent():
    for key in ("tv_paper", "kraken_spot", "kraken_futures", "custom"):
        assert key in fees.FEE_PROFILES


def test_aucun_nouveau_profil_ne_paie_le_timbre_suisse():
    """§6.4 : « Pas de timbre suisse sur ces profils. » Un scalp sur Kraken
    n'est pas une transaction chez un courtier suisse."""
    for key in ("tv_paper", "kraken_spot", "kraken_futures", "custom"):
        assert fees.compute_fees(key, 10000, "NESN.SW")["stamp_duty_chf"] == 0.0


def test_tv_paper_est_gratuit_par_defaut():
    assert fees.compute_fees("tv_paper", 10000, "AAPL")["total_chf"] == 0.0
    assert fees.round_trip_pct("tv_paper", 10000, "AAPL") == 0.0


def test_tv_paper_ajoute_la_commission_reglable():
    """« 0 % + commission réglable » : la commission est un forfait par jambe."""
    got = fees.compute_fees("tv_paper", 10000, "AAPL", commission_chf=2.5)
    assert got["brokerage_chf"] == 2.5
    assert got["total_chf"] == 2.5


def test_kraken_spot_compte_le_taker():
    """0,26 % taker sur 10 000 CHF = 26 CHF la jambe, 0,52 % l'aller-retour."""
    assert fees.compute_fees("kraken_spot", 10000, "BTC-USD")["total_chf"] == 26.0
    assert fees.round_trip_pct("kraken_spot", 10000, "BTC-USD") == 0.52


def test_kraken_futures_compte_le_taker():
    assert fees.compute_fees("kraken_futures", 10000, "BTC-USD")["total_chf"] == 5.0
    assert fees.round_trip_pct("kraken_futures", 10000, "BTC-USD") == 0.1


def test_les_deux_profils_kraken_annoncent_aussi_leur_maker():
    """Le taux maker n'est pas FACTURÉ (on compte taker, §6.4) mais il est
    PUBLIÉ : l'écran doit pouvoir montrer ce qu'un ordre limite aurait coûté."""
    assert fees.FEE_PROFILES["kraken_spot"]["maker_rate"] == 0.0016
    assert fees.FEE_PROFILES["kraken_futures"]["maker_rate"] == 0.0002


def test_custom_sans_taux_saisi_retombe_sur_le_defaut_documente():
    """Défaut 0,10 % par côté (plan §2, Task 1)."""
    assert fees.compute_fees("custom", 10000, "AAPL")["total_chf"] == 10.0


def test_custom_avec_taux_saisi_utilise_ce_taux():
    got = fees.compute_fees("custom", 10000, "AAPL", custom_pct=0.35)
    assert got["total_chf"] == 35.0
    assert fees.round_trip_pct("custom", 10000, "AAPL", custom_pct=0.35) == 0.7


def test_custom_pct_est_ignore_par_les_autres_profils():
    """``custom_pct`` ne doit pas pouvoir réécrire le barème d'un vrai
    courtier — sinon l'utilisateur croirait payer Kraken en payant autre chose."""
    assert fees.compute_fees("kraken_spot", 10000, "BTC-USD",
                             custom_pct=99.0)["total_chf"] == 26.0


def test_profil_inconnu_leve_toujours_valueerror():
    """Choix assumé (plan §2 : « ValueError OU repli documenté ») — on GARDE
    le ``ValueError`` existant : ``coach_trader._round_trip_pct`` s'appuie
    dessus pour retomber sur « yuh », et deux tests de ``test_paper_fees.py``
    l'épinglent. Un repli silencieux ici casserait les deux."""
    with pytest.raises(ValueError):
        fees.compute_fees("kraken", 10000, "BTC-USD")
    with pytest.raises(ValueError):
        fees.round_trip_pct("kraken", 10000, "BTC-USD")


def test_le_catalogue_public_liste_les_sept_profils():
    ids = [row["id"] for row in fees.list_profiles()]
    assert ids == sorted(fees.FEE_PROFILES)
    assert "kraken_spot" in ids


# --------------------------------------------------------------------------- #
# Task 3 — pré-check
# --------------------------------------------------------------------------- #

NOW = "2026-09-09T14:00:00+00:00"


def _portfolio(cash=10000.0, positions=None, initial=10000.0,
               fee_profile="ibkr"):
    return {"cash_chf": cash, "positions": positions or [],
            "initial_capital": initial, "fee_profile": fee_profile,
            "orders": []}


def _order(**kw):
    base = {"symbol": "AAPL", "side": "buy", "price": 100.0, "stop": 98.0,
            "target": 110.0, "risk_pct": 1.0, "mode": "swing"}
    base.update(kw)
    return base


def _codes(rows):
    return [row["code"] for row in rows]


def test_la_sortie_porte_toutes_les_cles_du_contrat():
    out = precheck.evaluate(_order(), portfolio=_portfolio(), now=NOW)
    assert set(out) == {"qty", "risk_pct", "risk_chf", "fees_chf",
                        "fees_pct_round_trip", "r_multiple",
                        "expected_move_pct", "warnings", "refusals"}


def test_chaque_avertissement_a_un_code_un_niveau_et_un_texte():
    out = precheck.evaluate(_order(stop=None), portfolio=_portfolio(), now=NOW)
    for row in out["warnings"]:
        assert set(row) == {"code", "level", "text"}
        assert row["level"] in ("amber", "red")
        assert row["text"]
    for row in out["refusals"]:
        assert set(row) == {"code", "text"}


def test_quantite_actions_est_un_entier_tronque():
    """1 % de 10 000 = 100 CHF de risque, 2 CHF par action -> 50 actions."""
    out = precheck.evaluate(_order(), portfolio=_portfolio(), now=NOW)
    assert out["qty"] == 50
    assert isinstance(out["qty"], int)
    assert out["risk_chf"] == 100.0


def test_quantite_crypto_est_fractionnaire_a_quatre_decimales():
    order = _order(symbol="BTC-USD", price=78000.0, stop=77500.0, target=80000.0)
    out = precheck.evaluate(order, portfolio=_portfolio(), now=NOW)
    # 1 % de 10 000 = 100 CHF ; 500 CHF par unité -> 0,2 BTC.
    assert out["qty"] == 0.2
    assert isinstance(out["qty"], float)


def test_quantite_crypto_tronque_a_la_quatrieme_decimale():
    order = _order(symbol="ETH-USD", price=3000.0, stop=2700.0, target=3600.0)
    out = precheck.evaluate(order, portfolio=_portfolio(), now=NOW)
    # 100 / 300 = 0,3333... -> tronqué (jamais arrondi vers le haut : on ne
    # dépasse pas le risque décidé, doctrine de risk.suggested_qty).
    assert out["qty"] == 0.3333


def test_une_quantite_imposee_est_reprise_telle_quelle_et_le_risque_recalcule():
    out = precheck.evaluate(_order(qty=10, risk_pct=None),
                            portfolio=_portfolio(), now=NOW)
    assert out["qty"] == 10
    assert out["risk_chf"] == 20.0
    assert out["risk_pct"] == 0.2


def test_stop_manquant_donne_no_stop_et_une_quantite_nulle():
    out = precheck.evaluate(_order(stop=None), portfolio=_portfolio(), now=NOW)
    assert out["qty"] is None
    assert out["risk_chf"] is None
    assert "no_stop" in _codes(out["warnings"])


def test_r_multiple_et_mouvement_attendu_en_swing():
    out = precheck.evaluate(_order(), portfolio=_portfolio(),
                            atr14_d=3.0, now=NOW)
    assert out["r_multiple"] == 5.0          # 10 de gain pour 2 de risque
    assert out["expected_move_pct"] == 3.0   # ATR jour 3 / prix 100


def test_mouvement_attendu_en_scalp_vaut_trois_atr_une_minute():
    out = precheck.evaluate(_order(mode="scalp"), portfolio=_portfolio(),
                            atr1_m=0.2, atr14_d=3.0, now=NOW)
    assert out["expected_move_pct"] == 0.6   # 3 x 0,2 / 100


def test_r_multiple_est_none_quand_le_stop_est_du_mauvais_cote():
    """Réutilise ``risk.r_multiple`` : un stop AU-DESSUS du prix sur un achat
    n'est pas un risque, c'est une erreur de saisie — on n'invente pas un R."""
    out = precheck.evaluate(_order(stop=102.0), portfolio=_portfolio(), now=NOW)
    assert out["r_multiple"] is None


def test_les_frais_sont_un_aller_retour():
    out = precheck.evaluate(_order(), portfolio=_portfolio(fee_profile="ibkr"),
                            now=NOW)
    # 50 actions x 100 = 5000 CHF ; ibkr = 0,05 % (min 1,50) -> 2,50 la jambe.
    assert out["fees_chf"] == 5.0
    assert out["fees_pct_round_trip"] == 0.1


def test_le_profil_de_frais_explicite_prime_sur_celui_du_portefeuille():
    out = precheck.evaluate(_order(), portfolio=_portfolio(fee_profile="ibkr"),
                            fees_profile="kraken_spot", now=NOW)
    assert out["fees_pct_round_trip"] == 0.52


# --- les six codes déjà écrits ------------------------------------------- #

def test_code_risk_high_quand_le_risque_depasse_deux_pourcents():
    out = precheck.evaluate(_order(risk_pct=3.0), portfolio=_portfolio(),
                            now=NOW)
    assert "risk_high" in _codes(out["warnings"])


def test_code_reward_risk_below_1_quand_la_cible_rapporte_moins_que_le_stop():
    out = precheck.evaluate(_order(target=101.0), portfolio=_portfolio(),
                            now=NOW)
    assert "reward_risk_below_1" in _codes(out["warnings"])


def test_code_oversize_quand_la_ligne_projetee_pese_trop():
    out = precheck.evaluate(_order(price=100.0, stop=99.9, risk_pct=2.0),
                            portfolio=_portfolio(), now=NOW)
    assert "oversize" in _codes(out["warnings"])


def test_aucun_no_thesis_quand_le_ticket_n_en_porte_pas():
    """Le pré-check est une CALCULETTE de taille, pas la porte de l'ordre : la
    thèse est demandée au moment de passer l'ordre, pas ici."""
    out = precheck.evaluate(_order(), portfolio=_portfolio(), now=NOW)
    assert "no_thesis" not in _codes(out["warnings"])


def test_no_thesis_ressort_quand_une_these_trop_courte_est_fournie():
    out = precheck.evaluate(_order(thesis="court"), portfolio=_portfolio(),
                            now=NOW)
    assert "no_thesis" in _codes(out["warnings"])


def test_refus_fee_ratio_quand_la_cible_ne_paie_pas_trois_allers_retours():
    out = precheck.evaluate(_order(target=100.5),
                            portfolio=_portfolio(fee_profile="yuh"), now=NOW)
    assert "fee_ratio" in _codes(out["refusals"])


def test_refus_stop_in_noise_quand_le_stop_tombe_sous_le_plancher_de_bruit():
    out = precheck.evaluate(_order(stop=99.95, target=130.0),
                            portfolio=_portfolio(fee_profile="yuh"), now=NOW)
    assert "stop_in_noise" in _codes(out["refusals"])


def test_refus_concentration_quand_la_ligne_depasse_le_plafond_du_coach():
    positions = [{"symbol": "AAPL", "qty": 80, "avg_price": 100.0,
                  "currency": "CHF", "fx_rate": 1.0, "side": "long"}]
    out = precheck.evaluate(_order(qty=10, risk_pct=None),
                            portfolio=_portfolio(cash=2000.0,
                                                 positions=positions),
                            now=NOW)
    assert "concentration" in _codes(out["refusals"])


def test_refus_cash_floor_quand_l_achat_vide_la_tresorerie():
    out = precheck.evaluate(_order(qty=99, risk_pct=None),
                            portfolio=_portfolio(cash=10000.0), now=NOW)
    assert "cash_floor" in _codes(out["refusals"])


def test_equivalence_fee_ratio_avec_la_porte_du_coach():
    """Le pré-check doit refuser EXACTEMENT ce que ``coach_trader.gate_decision``
    refuse : même profil, même barème, même seuil (3 x aller-retour)."""
    portfolio = _portfolio(fee_profile="yuh")
    decision = {"action": "buy", "symbol": "AAPL", "qty": 10, "stop": 98.0,
                "target": 100.5, "thesis": "these assez longue pour passer",
                # LOT 15 — une entrée du coach porte un contrat de thèse.
                "horizon_days": 3,
                "invalidation": "retour sous le range en clôture"}
    gate = coach_trader.gate_decision(
        decision, portfolio, {"price": 100.0, "currency": "CHF", "fx_rate": 1.0})
    assert gate["reason"] == "fee_ratio"
    out = precheck.evaluate(_order(target=100.5, qty=10, risk_pct=None),
                            portfolio=portfolio, now=NOW)
    assert "fee_ratio" in _codes(out["refusals"])


def test_equivalence_stop_in_noise_avec_la_porte_du_coach():
    portfolio = _portfolio(fee_profile="yuh")
    decision = {"action": "buy", "symbol": "AAPL", "qty": 10, "stop": 99.95,
                "target": 130.0, "thesis": "these assez longue pour passer",
                # LOT 15 — une entrée du coach porte un contrat de thèse.
                "horizon_days": 3,
                "invalidation": "retour sous le range en clôture"}
    gate = coach_trader.gate_decision(
        decision, portfolio, {"price": 100.0, "currency": "CHF", "fx_rate": 1.0})
    assert gate["reason"] == "stop_in_noise"
    out = precheck.evaluate(_order(stop=99.95, target=130.0, qty=10,
                                   risk_pct=None),
                            portfolio=portfolio, now=NOW)
    assert "stop_in_noise" in _codes(out["refusals"])


def test_les_biais_de_l_historique_remontent_en_avertissement():
    """``coach.detect_biases`` est déjà écrit : le pré-check le rejoue sur
    l'historique au lieu de réinventer « revenge_trade »/« overtrading »."""
    trades = [
        {"symbol": "AAPL", "side": "long", "qty": 10, "entry_price": 100.0,
         "exit_price": 90.0, "entry_at": "2026-09-08T09:00:00",
         "exit_at": "2026-09-08T10:00:00", "pnl_chf": -100.0, "pnl_pct": -10.0,
         "fees_chf": 5.0, "planned_stop": 98.0},
        # Entrée 20 min après la sortie perdante (fenêtre de 30 min) et pour
        # un notionnel PLUS GROS : les deux conditions de la règle.
        {"symbol": "AAPL", "side": "long", "qty": 20, "entry_price": 90.0,
         "exit_price": 88.0, "entry_at": "2026-09-08T10:20:00",
         "exit_at": "2026-09-08T11:00:00", "pnl_chf": -40.0, "pnl_pct": -2.2,
         "fees_chf": 5.0, "planned_stop": 89.0},
    ]
    out = precheck.evaluate(_order(), portfolio=_portfolio(), trades=trades,
                            now=NOW)
    assert "revenge_trade" in _codes(out["warnings"])


# --- les neuf garde-fous scalp (§6.3) ------------------------------------- #

def _scalp(**kw):
    return _order(mode="scalp", **kw)


def test_scalp_event_risk_quand_un_evenement_macro_est_dans_le_quart_d_heure():
    cal = [{"kind": "macro", "date": "2026-09-09", "time_utc": "14:10",
            "label": "US CPI", "importance": 1}]
    out = precheck.evaluate(_scalp(), portfolio=_portfolio(), calendar=cal,
                            now=NOW)
    row = [w for w in out["warnings"] if w["code"] == "event_risk"]
    assert row and row[0]["level"] == "red"


def test_scalp_event_risk_tire_aussi_juste_apres_l_evenement():
    cal = [{"kind": "macro", "date": "2026-09-09", "time_utc": "13:57",
            "label": "US CPI", "importance": 1}]
    out = precheck.evaluate(_scalp(), portfolio=_portfolio(), calendar=cal,
                            now=NOW)
    assert "event_risk" in _codes(out["warnings"])


def test_scalp_event_risk_ignore_un_evenement_de_faible_importance():
    cal = [{"kind": "macro", "date": "2026-09-09", "time_utc": "14:10",
            "label": "Stock de gaz", "importance": 0}]
    out = precheck.evaluate(_scalp(), portfolio=_portfolio(), calendar=cal,
                            now=NOW)
    assert "event_risk" not in _codes(out["warnings"])


def test_scalp_funding_soon_quand_le_reglement_est_dans_moins_de_cinq_minutes():
    out = precheck.evaluate(_scalp(symbol="BTC-USD"), portfolio=_portfolio(),
                            btc={"next_funding_utc": "2026-09-09T14:03:00Z"},
                            now=NOW)
    row = [w for w in out["warnings"] if w["code"] == "funding_soon"]
    assert row and row[0]["level"] == "amber"


def test_scalp_flash_news_quand_une_depeche_a_moins_de_deux_minutes():
    news = [{"ts": "2026-09-09T13:59:00+00:00", "title": "Apple rappelle un lot"}]
    out = precheck.evaluate(_scalp(), portfolio=_portfolio(), news=news, now=NOW)
    assert "flash_news" in _codes(out["warnings"])


def test_scalp_flash_news_ignore_une_depeche_d_il_y_a_dix_minutes():
    news = [{"ts": "2026-09-09T13:50:00+00:00", "title": "Vieille depeche"}]
    out = precheck.evaluate(_scalp(), portfolio=_portfolio(), news=news, now=NOW)
    assert "flash_news" not in _codes(out["warnings"])


def test_scalp_vol_spike_quand_l_atr_une_minute_double_sa_mediane():
    out = precheck.evaluate(_scalp(), portfolio=_portfolio(), atr1_m=0.5,
                            atr1_m_median=0.2, now=NOW)
    assert "vol_spike" in _codes(out["warnings"])


def test_scalp_spread_wide_quand_l_ecart_double_sa_mediane_de_seance():
    out = precheck.evaluate(_scalp(), portfolio=_portfolio(), spread_pct=0.12,
                            spread_median_pct=0.04, now=NOW)
    assert "spread_wide" in _codes(out["warnings"])


def test_scalp_fee_coverage_quand_le_mouvement_attendu_ne_paie_pas_le_courtier():
    out = precheck.evaluate(_scalp(), portfolio=_portfolio(fee_profile="yuh"),
                            atr1_m=0.01, now=NOW)
    row = [w for w in out["warnings"] if w["code"] == "fee_coverage"]
    assert row and row[0]["level"] == "red"
    assert "%" in row[0]["text"]


def test_scalp_fee_coverage_se_tait_quand_le_mouvement_couvre_largement():
    out = precheck.evaluate(_scalp(),
                            portfolio=_portfolio(fee_profile="tv_paper"),
                            atr1_m=0.5, now=NOW)
    assert "fee_coverage" not in _codes(out["warnings"])


def test_scalp_cooldown_apres_un_scalp_perdant_recent():
    scalps = [{"closed_ts": "2026-09-09T13:55:00+00:00", "pnl_chf": -12.0}]
    out = precheck.evaluate(_scalp(), portfolio=_portfolio(),
                            scalps_today=scalps, now=NOW)
    assert "cooldown" in _codes(out["warnings"])


def test_scalp_cooldown_se_tait_apres_un_scalp_gagnant():
    scalps = [{"closed_ts": "2026-09-09T13:55:00+00:00", "pnl_chf": 12.0}]
    out = precheck.evaluate(_scalp(), portfolio=_portfolio(),
                            scalps_today=scalps, now=NOW)
    assert "cooldown" not in _codes(out["warnings"])


def test_scalp_pace_au_dela_de_six_scalps_dans_l_heure():
    scalps = [{"closed_ts": "2026-09-09T13:%02d:00+00:00" % (10 + i),
               "pnl_chf": 1.0} for i in range(7)]
    out = precheck.evaluate(_scalp(), portfolio=_portfolio(),
                            scalps_today=scalps, now=NOW)
    assert "pace" in _codes(out["warnings"])


def test_scalp_daily_loss_quand_la_journee_perd_deux_pourcents_de_l_equite():
    scalps = [{"closed_ts": "2026-09-09T09:00:00+00:00", "pnl_chf": -250.0}]
    out = precheck.evaluate(_scalp(), portfolio=_portfolio(),
                            scalps_today=scalps, now=NOW)
    row = [w for w in out["warnings"] if w["code"] == "daily_loss"]
    assert row and row[0]["level"] == "red"


def test_le_mode_swing_n_emet_aucun_code_scalp():
    """Toutes les matières des neuf garde-fous sont fournies EN MÊME TEMPS ;
    en swing, aucun ne doit sortir."""
    cal = [{"kind": "macro", "date": "2026-09-09", "time_utc": "14:10",
            "label": "US CPI", "importance": 1}]
    news = [{"ts": "2026-09-09T13:59:30+00:00", "title": "Depeche"}]
    scalps = [{"closed_ts": "2026-09-09T13:55:00+00:00", "pnl_chf": -400.0}]
    out = precheck.evaluate(
        _order(mode="swing"), portfolio=_portfolio(fee_profile="yuh"),
        calendar=cal, news=news, scalps_today=scalps, atr1_m=0.01,
        atr1_m_median=0.001, spread_pct=0.5, spread_median_pct=0.01,
        btc={"next_funding_utc": "2026-09-09T14:03:00Z"}, now=NOW)
    for code in precheck.SCALP_CODES:
        assert code not in _codes(out["warnings"])


def test_les_seuils_scalp_sont_surchargeables():
    news = [{"ts": "2026-09-09T13:50:00+00:00", "title": "Depeche"}]
    out = precheck.evaluate(_scalp(), portfolio=_portfolio(), news=news,
                            thresholds={"flash_news_min": 30.0}, now=NOW)
    assert "flash_news" in _codes(out["warnings"])
    assert precheck.SCALP_THRESHOLDS["flash_news_min"] == 2.0   # non muté


def test_rien_ne_bloque_jamais():
    """Même avec tout au rouge, ``evaluate`` rend un ticket : c'est l'humain
    qui décide (§5.2 : « Rien ne bloque »)."""
    cal = [{"kind": "macro", "date": "2026-09-09", "time_utc": "14:05",
            "label": "US CPI", "importance": 1}]
    out = precheck.evaluate(_scalp(target=100.2),
                            portfolio=_portfolio(fee_profile="yuh"),
                            calendar=cal, atr1_m=0.01, now=NOW)
    assert out["qty"] == 50
    assert out["warnings"] and out["refusals"]


def test_une_entree_illisible_ne_leve_jamais():
    out = precheck.evaluate({}, portfolio=None, now=NOW)
    assert out["qty"] is None
    assert out["warnings"] == [] or isinstance(out["warnings"], list)
    assert isinstance(out["refusals"], list)


def test_une_source_illisible_ne_fait_pas_tomber_le_ticket():
    out = precheck.evaluate(_scalp(), portfolio=_portfolio(),
                            calendar="pas une liste", news={"ts": "?"},
                            scalps_today=42, btc="?", now=NOW)
    assert out["qty"] == 50
