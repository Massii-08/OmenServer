"""LOT 14 — « que le coach dise vrai, et qu'on voie ce qu'il fait ».

A1/A2 : deux phrases de refus qui racontaient autre chose que ce qui s'est
passé (le code de refus, lui, était juste). Les scénarios sont ceux du
registre réel du 22/09.
"""

from backend.bots import paper_router
from backend.bots.paper import coach_trader, models

THESIS = ("Taux hypothécaires au plus haut : le REIT hypothécaire souffre du "
          "portage, cassure du support des 20 derniers jours.")
INVALIDATION = "retour sous le range sur une clôture quotidienne"


def _pos(symbol, qty=10, avg_price=10.0, side="long"):
    return {"symbol": symbol, "qty": qty, "avg_price": avg_price,
            "currency": "USD", "fx_rate": 0.8, "side": side}


def _ambush(symbol, side="buy"):
    return {"id": "a-" + symbol, "symbol": symbol, "side": side,
            "kind": "stop", "status": "open", "qty": 5, "trigger": 50.0,
            "risk_chf": 20.0}


def _pf(positions=(), open_orders=()):
    return {"cash_chf": 8000.0, "positions": list(positions),
            "open_orders": list(open_orders), "trades": [],
            "initial_capital": 10000.0, "fee_profile": "ibkr"}


def _short_nly():
    return {"action": "short", "symbol": "NLY", "qty": 80, "stop": 20.5,
            "target": 18.0, "thesis": THESIS,
            # LOT 15 — le contrat de thèse d'une entrée (``no_horizon`` sinon).
            "horizon_days": 3, "invalidation": INVALIDATION}


# --- A1 — too_many_positions compte les FRONTS, la phrase aussi ------------ #

def _book_du_22_09():
    """3 positions ouvertes + 3 embuscades armées (BARN.SW, TXT, KRE)."""
    return _pf(positions=[_pos("AAPL"), _pos("DAL"), _pos("NESN.SW")],
               open_orders=[_ambush("BARN.SW"), _ambush("TXT"),
                            _ambush("KRE", side="short")])


def test_a1_le_refus_est_bien_too_many_positions():
    """Le garde-fou n'est PAS en cause : on épingle qu'il refuse toujours."""
    out = coach_trader.gate_decision(_short_nly(), _book_du_22_09(),
                                     {"price": 20.0, "fx_rate": 0.8})
    assert out["reason"] == "too_many_positions"


def test_a1_la_phrase_compte_positions_ET_embuscades():
    detail = coach_trader.reject_detail("too_many_positions", _short_nly(),
                                        _book_du_22_09(),
                                        {"price": 20.0, "fx_rate": 0.8})
    assert detail is not None
    assert "3 lignes ouvertes" in detail
    assert "3 embuscades armées" in detail
    # 7 fronts pour 6 : la phrase dit DE COMBIEN on dépasse
    assert "7" in detail and "plafond 6" in detail
    # l'ancien mensonge : « 3 lignes déjà ouvertes (plafond 6) »
    assert "3 lignes déjà ouvertes (plafond 6)" not in detail


def test_a1_un_symbole_deja_arme_n_est_pas_un_front_de_plus():
    """Même règle que la porte : un ensemble de SYMBOLES, pas une somme."""
    pf = _pf(positions=[_pos("AAPL"), _pos("DAL"), _pos("NESN.SW"),
                        _pos("MSFT"), _pos("KO")],
             open_orders=[_ambush("TXT"), _ambush("KRE")])
    detail = coach_trader.reject_detail("too_many_positions",
                                        dict(_short_nly(), symbol="TXT"),
                                        pf, {"price": 20.0, "fx_rate": 0.8})
    # 5 lignes + 2 embuscades (TXT déjà compté) = 7 fronts
    assert "5 lignes ouvertes" in detail
    assert "2 embuscades armées" in detail
    assert "7 fronts" in detail


def test_a1_le_routeur_sert_la_phrase_vraie():
    portfolio = models.Portfolio.from_dict(dict(_book_du_22_09(),
                                                owner="coach"))
    detail = paper_router._coach_reject_detail(
        "too_many_positions", _short_nly(), portfolio,
        {"price": 20.0, "fx_rate": 0.8})
    assert detail is not None
    assert "embuscades armées" in detail


# --- A2 — market_closed : week-end OU hors séance -------------------------- #

TUESDAY_0426 = "2026-09-22T04:26:00"      # mardi, heure de Rome (naïf = local)
SATURDAY_1100 = "2026-09-26T11:00:00"     # samedi, heure de Rome


def test_a2_le_refus_est_bien_market_closed_un_mardi_a_4h():
    out = coach_trader.gate_decision(_short_nly(), _pf(),
                                     {"price": 20.0, "fx_rate": 0.8},
                                     now=TUESDAY_0426)
    assert out["reason"] == "market_closed"


def test_a2_un_mardi_a_4h_on_ne_parle_pas_du_week_end():
    detail = coach_trader.reject_detail("market_closed", _short_nly(), _pf(),
                                        None, now=TUESDAY_0426)
    assert detail is not None
    assert "week-end" not in detail
    assert "NLY" in detail
    assert "04:26" in detail
    # l'horaire vient de _MARKET_WINDOWS, jamais inventé
    assert "15:35" in detail and "21:55" in detail


def test_a2_le_samedi_garde_le_message_du_week_end():
    detail = coach_trader.reject_detail("market_closed", _short_nly(), _pf(),
                                        None, now=SATURDAY_1100)
    assert detail == ("NLY ne s'échange pas ce jour-là — seules les cryptos "
                      "cotent le week-end")


def test_a2_une_place_inconnue_le_dit_au_lieu_d_accuser_l_horloge():
    """``tradable_now`` refuse toute place qu'il ne sait pas situer, même un
    mardi à midi : ce n'est ni l'heure ni le week-end."""
    decision = dict(_short_nly(), symbol="TITAN.NS")
    detail = coach_trader.reject_detail("market_closed", decision, _pf(),
                                        None, now="2026-09-22T12:00:00")
    assert detail is not None
    assert "week-end" not in detail
    assert "TITAN.NS" in detail
    assert "place" in detail


def test_a2_le_routeur_sert_la_phrase_vraie():
    portfolio = models.Portfolio.from_dict(dict(_pf(), owner="coach"))
    detail = paper_router._coach_reject_detail(
        "market_closed", _short_nly(), portfolio, None, now=TUESDAY_0426)
    assert "week-end" not in detail


# --- C — l'économie du compte, lisible à l'écran --------------------------- #

from backend.bots.paper import fees  # noqa: E402


def _closed(pnl, fee, stamp=0.0, exit_at="2026-09-01T18:00:00"):
    return {"symbol": "X", "pnl_chf": pnl, "fees_chf": fee,
            "stamp_duty_chf": stamp, "exit_at": exit_at}


def test_c_economics_view_brut_egale_net_plus_frais_sur_TOUS_les_trades():
    """Toute la vie du compte, pas 7 jours : le diagnostic du 21/09 portait
    sur 24 jours et c'est ce chiffre-là qui manquait à l'écran."""
    pf = dict(_pf(), trades=[_closed(-50.0, 10.0, 2.0,
                                     exit_at="2026-08-20T18:00:00"),
                             _closed(30.0, 8.0),
                             _closed(-20.0, 5.0)])
    view = coach_trader.economics_view(pf)
    assert view["n_trades"] == 3
    assert view["n_wins"] == 1
    assert view["fees_paid_chf"] == 25.0
    assert view["net_pnl_chf"] == -40.0
    assert view["gross_pnl_chf"] == -15.0
    assert view["net_per_trade_chf"] == round(-40.0 / 3, 2)
    assert view["gross_per_trade_chf"] == -5.0


def test_c_economics_view_aller_retour_au_profil_REEL_du_compte():
    """Jamais un taux recopié : le chiffre suit ``fee_profile``."""
    ibkr = coach_trader.economics_view(dict(_pf(), fee_profile="ibkr"))
    yuh = coach_trader.economics_view(dict(_pf(), fee_profile="yuh"))
    assert ibkr["fee_profile"] == "ibkr"
    assert ibkr["round_trip_pct"] == fees.round_trip_pct(
        "ibkr", ibkr["notional_chf"], "")
    assert yuh["round_trip_pct"] == fees.round_trip_pct(
        "yuh", yuh["notional_chf"], "")
    assert ibkr["round_trip_pct"] != yuh["round_trip_pct"]
    # mesuré sur la plus petite ligne permise par le mandat (même règle que
    # ``fees_view``, qui alimente le prompt : l'écran et le coach lisent le
    # même chiffre)
    assert ibkr["round_trip_pct"] == coach_trader.fees_view(
        dict(_pf(), fee_profile="ibkr"))["round_trip_pct"]


def test_c_economics_view_sans_trade_est_neutre_et_ne_divise_pas_par_zero():
    view = coach_trader.economics_view(_pf())
    assert view["n_trades"] == 0
    assert view["net_per_trade_chf"] is None
    assert view["gross_per_trade_chf"] is None
    assert view["fees_paid_chf"] == 0.0


def test_c_economics_view_ne_leve_jamais():
    view = coach_trader.economics_view(None)
    assert view["n_trades"] == 0


def test_c_la_route_coach_trader_sert_l_economie(tmp_path, monkeypatch):
    from backend.bots.tests.test_paper_router import make_client
    from backend.bots import paper_router as pr
    c, _ = make_client(tmp_path, monkeypatch)
    portfolio = pr._ensure_coach_account()
    portfolio.trades.append(pr.models.Trade.from_dict(dict(
        _closed(30.0, 8.0), entry_price=10.0, exit_price=11.0, qty=10,
        side="long", entry_at="2026-08-30T15:40:00")))
    pr._save(pr.coach_trader.COACH_USERNAME, portfolio)
    body = c.get("/api/paper/coach-trader").json()
    eco = body["economics"]
    assert eco["fee_profile"] == pr.COACH_FEE_PROFILE
    assert eco["fees_paid_chf"] == 8.0
    assert eco["gross_pnl_chf"] == 38.0
    assert eco["net_pnl_chf"] == 30.0
