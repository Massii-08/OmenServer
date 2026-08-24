"""Tests du router du simulateur de paper trading — 100 % hors ligne.

Patron des voisins (``test_market_router.py``) : TestClient FastAPI + override de
``get_current_user`` (sur lequel ``require_role`` se branche), cours et LLM
monkeypatchés, persistance redirigée vers ``tmp_path``.

Aucun test ne touche le réseau ni le disque réel : le faux marché ``Market``
remplace ``quotes``, les trois fonctions du ``llm`` sont neutralisées, et
``store.DATA_DIR`` pointe sur le répertoire temporaire du test.
"""
from datetime import datetime

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.auth.utils import get_current_user
from backend.bots import paper_router as pr
from backend.bots.paper import coach, fees, quotes, store

FIXED_NOW = "2026-08-24T10:00:00"


def _ts(hour):
    """Epoch local d'une heure du 24 août 2026 (les bougies du faux marché)."""
    return datetime(2026, 8, 24, hour, 0, 0).timestamp()


class FakeUser(object):
    def __init__(self, role="admin", username="tester"):
        self.role = role
        self.is_admin = role == "admin"
        self.username = username


class Market(object):
    """Faux marché : cours, taux, bougies. Aucun réseau."""

    def __init__(self):
        self.prices = {"NESN.SW": (100.0, "CHF", "Nestle SA")}
        self.fx = {"CHF": 1.0, "USD": 0.88}
        self.candles = {}
        self.broken = set()
        self.results = []
        self.facts = {"symbol": "NESN.SW", "price": 100.0, "trend": "haussier"}

    # --- API consommée par le router -----------------------------------
    def get_quote(self, symbol):
        if symbol in self.broken:
            raise quotes.QuoteError("cours indisponible pour %s" % symbol)
        if symbol not in self.prices:
            raise quotes.UnknownSymbol("symbole inconnu de Yahoo: %s" % symbol)
        price, currency, name = self.prices[symbol]
        return {"symbol": symbol, "price": price, "currency": currency,
                "change_pct": 1.5, "name": name}

    def fx_to_chf(self, currency):
        code = str(currency or "").upper()
        if code not in self.fx:
            raise quotes.QuoteError("taux %s->CHF indisponible" % code)
        return self.fx[code]

    def get_candles(self, symbol, range_="5d", interval="1d"):
        if symbol in self.broken:
            raise quotes.QuoteError("cours indisponible pour %s" % symbol)
        return list(self.candles.get(symbol, []))

    def search(self, q):
        return list(self.results)

    def fiche_facts(self, symbol):
        if symbol not in self.prices:
            raise quotes.UnknownSymbol("symbole inconnu de Yahoo: %s" % symbol)
        return dict(self.facts)


def make_client(tmp_path, monkeypatch, role="admin"):
    """Client isolé : disque en tmp, horloge figée, marché et LLM factices."""
    monkeypatch.setattr(store, "DATA_DIR", tmp_path / "paper_trading")
    monkeypatch.setattr(pr, "_now_iso", lambda: FIXED_NOW)

    market = Market()
    for name in ("get_quote", "fx_to_chf", "get_candles", "search", "fiche_facts"):
        monkeypatch.setattr(quotes, name, getattr(market, name))

    monkeypatch.setattr(pr.llm, "ask_coach",
                        lambda context, question: "Ta taille est le sujet.")
    monkeypatch.setattr(pr.llm, "write_postmortem",
                        lambda trade, context: "Post-mortem du trade.")
    monkeypatch.setattr(pr.llm, "write_analysis", lambda facts: "Fiche du titre.")

    app = FastAPI()
    app.include_router(pr.router)
    app.dependency_overrides[get_current_user] = lambda: FakeUser(role)
    return TestClient(app), market


# --- raccourcis ---------------------------------------------------------
def order(client, **kwargs):
    payload = {"symbol": "NESN.SW", "side": "buy", "kind": "market", "qty": 10}
    payload.update(kwargs)
    return client.post("/api/paper/orders", json=payload)


def buy(client, **kwargs):
    response = order(client, **kwargs)
    assert response.status_code == 200, response.text
    return response.json()


def portfolio_of(client):
    response = client.get("/api/paper/portfolio")
    assert response.status_code == 200, response.text
    return response.json()


def fee_total(notional, symbol="NESN.SW", profile="yuh"):
    """Frais attendus, calculés par le MODULE (qui a ses propres tests) — un
    test du router ne doit pas ré-implémenter la grille tarifaire."""
    return fees.compute_fees(profile, notional, symbol)["total_chf"]


# ================================================================
#  ACCÈS (RBAC)
# ================================================================

def test_player_role_is_refused_everywhere(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch, role="player")
    assert c.get("/api/paper/portfolio").status_code == 403
    assert c.post("/api/paper/orders", json={"symbol": "X"}).status_code == 403
    assert c.post("/api/paper/tick").status_code == 403
    assert c.get("/api/paper/coach").status_code == 403
    assert c.get("/api/paper/lessons").status_code == 403
    assert c.get("/api/paper/arena").status_code == 403
    assert c.get("/api/paper/news").status_code == 403
    assert c.get("/api/paper/radar").status_code == 403


def test_money_role_is_allowed(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch, role="money")
    assert c.get("/api/paper/portfolio").status_code == 200


# ================================================================
#  PORTEFEUILLE
# ================================================================

def test_fresh_portfolio_is_created_on_first_read(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    data = portfolio_of(c)
    assert data["portfolio"]["cash_chf"] == 10000.0
    assert data["portfolio"]["initial_capital"] == 10000.0
    assert data["portfolio"]["positions"] == []
    assert data["stats"]["n_trades"] == 0
    assert data["afc"]["status"] == "prive"
    assert data["biases"] == []


def test_portfolio_survives_a_quote_outage(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    buy(c)
    market.broken.add("NESN.SW")
    data = portfolio_of(c)
    assert data["quotes"]["NESN.SW"]["price"] is None
    # la ligne reste comptée dans l'exposition, à son prix de revient
    assert data["exposure"]["invested_chf"] == 1000.0


# ================================================================
#  ORDRES AU MARCHÉ
# ================================================================

def test_market_buy_debits_cash_and_creates_the_position(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    body = buy(c, thesis="Défensive, marges qui tiennent, support testé 3 fois",
               stop_loss=90.0, target=130.0)

    assert body["order"]["status"] == "filled"
    assert body["fill"]["notional_chf"] == 1000.0
    assert body["fill"]["fees"]["brokerage_chf"] == 5.0      # 0,5 % de 1000
    assert body["fill"]["fees"]["stamp_duty_chf"] == 0.75    # 0,075 % titre suisse
    assert body["warnings"] == []

    data = portfolio_of(c)
    assert data["portfolio"]["cash_chf"] == 8994.25          # 10000 - 1000 - 5.75
    position = data["portfolio"]["positions"][0]
    assert position["symbol"] == "NESN.SW"
    assert position["qty"] == 10
    assert position["avg_price"] == 100.0
    assert position["side"] == "long"
    assert position["stop_loss"] == 90.0
    assert position["target"] == 130.0
    assert position["risk_chf"] == 100.0                     # |100-90| x 10 x 1
    assert position["thesis"].startswith("Défensive")


def test_foreign_currency_uses_the_fx_rate_and_the_foreign_stamp_duty(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    market.prices["AAPL"] = (200.0, "USD", "Apple Inc")
    body = buy(c, symbol="AAPL", qty=10)

    assert body["fill"]["fx_rate"] == 0.88
    assert body["fill"]["notional_chf"] == 1760.0            # 10 x 200 x 0.88
    assert body["fill"]["fees"]["stamp_duty_chf"] == 2.64    # 0,15 % titre étranger
    data = portfolio_of(c)
    assert data["portfolio"]["cash_chf"] == pytest.approx(10000.0 - 1760.0 - 11.44, abs=0.01)


def test_buy_beyond_cash_is_refused(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    response = order(c, qty=200)
    assert response.status_code == 400
    assert "Trésorerie insuffisante" in response.json()["detail"]
    # rien n'a bougé
    assert portfolio_of(c)["portfolio"]["cash_chf"] == 10000.0


def test_averaging_a_position_recomputes_the_average_price(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, qty=10)
    market.prices["NESN.SW"] = (120.0, "CHF", "Nestle SA")
    buy(c, qty=10)
    position = portfolio_of(c)["portfolio"]["positions"][0]
    assert position["qty"] == 20
    assert position["avg_price"] == 110.0


# ================================================================
#  VALIDATIONS (400)
# ================================================================

@pytest.mark.parametrize("payload,needle", [
    ({"side": "acheter"}, "Sens d'ordre invalide"),
    ({"kind": "iceberg"}, "Type d'ordre invalide"),
    ({"qty": 0}, "quantité doit être positive"),
    ({"qty": -3}, "quantité doit être positive"),
    ({"kind": "limit"}, "prix limite"),
    ({"kind": "stop"}, "prix de déclenchement"),
    ({"symbol": "  "}, "Symbole manquant"),
    ({"fee_profile": "nonexistant"}, "Profil de frais inconnu"),
])
def test_invalid_orders_are_rejected_with_400(tmp_path, monkeypatch, payload, needle):
    c, _ = make_client(tmp_path, monkeypatch)
    response = order(c, **payload)
    assert response.status_code == 400, response.text
    assert needle in response.json()["detail"]


def test_unknown_symbol_is_404(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert order(c, symbol="ZZZZ").status_code == 404


def test_broken_quote_is_502(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    market.broken.add("NESN.SW")
    assert order(c).status_code == 502


def test_missing_fx_rate_is_502(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    market.prices["TOK.T"] = (3000.0, "JPY", "Tokyo Co")
    assert order(c, symbol="TOK.T", qty=1).status_code == 502


# ================================================================
#  AVERTISSEMENTS (on avertit, on ne bloque jamais)
# ================================================================

def test_missing_thesis_and_stop_warn_but_execute(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    body = buy(c, qty=10, thesis="")
    assert "no_thesis" in body["warnings"]
    assert "no_stop" in body["warnings"]
    assert body["order"]["status"] == "filled"        # exécuté quand même


def test_short_thesis_still_warns(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert "no_thesis" in buy(c, thesis="ça monte")["warnings"]


def test_oversized_risk_warns(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    # risque planifié = |100-50| x 30 = 1500 CHF, soit 15 % du capital
    body = buy(c, qty=30, stop_loss=50.0, thesis="Pari sur le rebond du secteur")
    assert "oversized" in body["warnings"]
    assert body["order"]["risk_chf"] == 1500.0


def test_concentration_warns_above_a_quarter_of_the_portfolio(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    body = buy(c, qty=40, thesis="Conviction forte sur cette valeur défensive",
               stop_loss=95.0)
    assert "concentration" in body["warnings"]


def test_concentration_also_appears_as_a_bias_in_the_portfolio(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    buy(c, qty=40, thesis="Conviction forte sur cette valeur défensive")
    codes = [b["code"] for b in portfolio_of(c)["biases"]]
    assert "concentration" in codes


def test_sell_orders_carry_no_entry_warnings(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    buy(c, qty=10, thesis="Thèse suffisamment longue pour passer le seuil")
    body = buy(c, side="sell", qty=4)
    assert body["warnings"] == []


# ================================================================
#  ORDRES EN ATTENTE + TICK
# ================================================================

def test_limit_order_is_stored_not_executed(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    body = buy(c, kind="limit", limit_price=90.0, qty=10,
               thesis="J'achète seulement si ça revient sur son support")
    assert body["order"]["status"] == "open"
    assert body["fill"] is None
    data = portfolio_of(c)
    assert len(data["portfolio"]["open_orders"]) == 1
    assert data["portfolio"]["cash_chf"] == 10000.0        # rien n'a été débité


def test_tick_fills_a_limit_order_on_a_touching_candle(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, kind="limit", limit_price=90.0, qty=10, thesis="Achat sur repli au support")
    market.candles["NESN.SW"] = [
        {"ts": _ts(11), "open": 92.0, "high": 93.0, "low": 88.0, "close": 91.0}]

    result = c.post("/api/paper/tick").json()
    assert len(result["fills"]) == 1
    assert result["fills"][0]["price"] == 90.0

    data = portfolio_of(c)
    assert data["portfolio"]["open_orders"] == []
    position = data["portfolio"]["positions"][0]
    assert position["qty"] == 10 and position["avg_price"] == 90.0
    assert data["portfolio"]["cash_chf"] == pytest.approx(
        10000.0 - 900.0 - fee_total(900.0), abs=0.01)


def test_tick_leaves_an_untouched_limit_order_alone(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, kind="limit", limit_price=90.0, qty=10, thesis="Achat sur repli au support")
    market.candles["NESN.SW"] = [
        {"ts": _ts(11), "open": 96.0, "high": 97.0, "low": 95.0, "close": 96.0}]

    result = c.post("/api/paper/tick").json()
    assert result["fills"] == []
    assert len(portfolio_of(c)["portfolio"]["open_orders"]) == 1


def test_tick_ignores_candles_older_than_the_order(tmp_path, monkeypatch):
    """Sans ce filtre, un ordre posé cet après-midi serait exécuté sur la bougie
    de ce matin — l'utilisateur gagnerait sur des prix qu'il n'a jamais vus."""
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, kind="limit", limit_price=90.0, qty=10, thesis="Achat sur repli au support")
    market.candles["NESN.SW"] = [
        {"ts": _ts(9), "open": 92.0, "high": 93.0, "low": 80.0, "close": 91.0}]
    assert c.post("/api/paper/tick").json()["fills"] == []


def test_tick_triggers_a_protective_stop(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, qty=10, stop_loss=90.0, thesis="Cassure haussière, invalidation sous 90")
    market.candles["NESN.SW"] = [
        {"ts": _ts(11), "open": 95.0, "high": 96.0, "low": 88.0, "close": 89.0}]

    result = c.post("/api/paper/tick").json()
    assert len(result["stopped"]) == 1
    trade = result["stopped"][0]["trade"]
    assert trade["exit_reason"] == "stop"
    assert trade["exit_price"] == 90.0
    assert trade["entry_price"] == 100.0
    assert trade["r_multiple"] == -1.0            # perdu exactement le risque prévu

    data = portfolio_of(c)
    assert data["portfolio"]["positions"] == []
    assert len(data["portfolio"]["trades"]) == 1


def test_tick_survives_a_broken_symbol(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, kind="limit", limit_price=90.0, qty=10, thesis="Achat sur repli au support")
    market.broken.add("NESN.SW")
    response = c.post("/api/paper/tick")
    assert response.status_code == 200
    result = response.json()
    assert result["fills"] == []
    assert result["errors"] and result["errors"][0]["symbol"] == "NESN.SW"


def test_tick_cancels_an_order_that_became_unaffordable(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    # ordre limite énorme, puis on vide la caisse avec un achat au marché
    buy(c, kind="limit", limit_price=99.0, qty=95, thesis="Grosse position sur repli")
    buy(c, qty=95)
    market.candles["NESN.SW"] = [
        {"ts": _ts(11), "open": 98.0, "high": 99.0, "low": 90.0, "close": 95.0}]

    result = c.post("/api/paper/tick").json()
    assert result["fills"] == []
    assert len(result["cancelled"]) == 1
    assert "Trésorerie" in result["cancelled"][0]["reason"]
    assert portfolio_of(c)["portfolio"]["open_orders"] == []


# ================================================================
#  CLÔTURES
# ================================================================

def test_partial_sell_produces_a_partial_trade(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, qty=10, stop_loss=90.0, thesis="Cassure haussière, invalidation sous 90")
    market.prices["NESN.SW"] = (120.0, "CHF", "Nestle SA")
    body = buy(c, side="sell", qty=4)

    trade = body["fill"]["trade"]
    assert trade["qty"] == 4
    assert trade["entry_price"] == 100.0
    assert trade["exit_price"] == 120.0
    assert trade["exit_reason"] == "manual"
    assert trade["thesis"].startswith("Cassure")       # la thèse suit la POSITION
    assert trade["planned_stop"] == 90.0
    assert trade["r_multiple"] == 2.0                  # +20 pour 10 de risque
    # 80 de plus-value moins l'aller-retour (4.40 de courtage + 0.66 de timbre)
    assert trade["pnl_chf"] == pytest.approx(74.94, abs=0.01)

    positions = portfolio_of(c)["portfolio"]["positions"]
    assert positions[0]["qty"] == 6


def test_close_position_endpoint_closes_everything_by_default(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, qty=10, thesis="Thèse suffisamment longue pour passer le seuil")
    market.prices["NESN.SW"] = (110.0, "CHF", "Nestle SA")

    response = c.post("/api/paper/positions/NESN.SW/close", json={})
    assert response.status_code == 200, response.text
    assert response.json()["fill"]["trade"]["qty"] == 10
    data = portfolio_of(c)
    assert data["portfolio"]["positions"] == []
    assert len(data["portfolio"]["trades"]) == 1


def test_close_position_partial_and_guards(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    buy(c, qty=10, thesis="Thèse suffisamment longue pour passer le seuil")

    assert c.post("/api/paper/positions/ZZZ/close", json={}).status_code == 404
    assert c.post("/api/paper/positions/NESN.SW/close",
                  json={"qty": 99}).status_code == 400
    assert c.post("/api/paper/positions/NESN.SW/close",
                  json={"qty": 0}).status_code == 400

    response = c.post("/api/paper/positions/NESN.SW/close", json={"qty": 3})
    assert response.status_code == 200
    assert portfolio_of(c)["portfolio"]["positions"][0]["qty"] == 7


def test_selling_more_than_held_is_refused(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    buy(c, qty=5, thesis="Thèse suffisamment longue pour passer le seuil")
    response = order(c, side="sell", qty=9)
    assert response.status_code == 400
    assert "supérieure à la position" in response.json()["detail"]


def test_selling_without_position_is_refused(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    response = order(c, side="sell", qty=1)
    assert response.status_code == 400
    assert "Aucune position long" in response.json()["detail"]


# ================================================================
#  VENTE À DÉCOUVERT
# ================================================================

def test_short_within_margin_is_accepted(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    body = buy(c, side="short", qty=50, stop_loss=110.0,
               thesis="Surévaluée, résultats en baisse, stop au-dessus du plus haut")
    assert body["fill"]["notional_chf"] == 5000.0

    data = portfolio_of(c)
    position = data["portfolio"]["positions"][0]
    assert position["side"] == "short" and position["qty"] == 50
    # la vente encaisse le produit, moins les frais
    assert data["portfolio"]["cash_chf"] == pytest.approx(
        10000.0 + 5000.0 - fee_total(5000.0), abs=0.01)


def test_short_beyond_margin_is_refused(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    response = order(c, side="short", qty=200)
    assert response.status_code == 400
    assert "Marge insuffisante" in response.json()["detail"]


def test_cover_closes_the_short_with_its_pnl(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, side="short", qty=50, stop_loss=110.0,
        thesis="Surévaluée, résultats en baisse, stop au-dessus du plus haut")
    market.prices["NESN.SW"] = (90.0, "CHF", "Nestle SA")
    body = buy(c, side="cover", qty=50)

    trade = body["fill"]["trade"]
    assert trade["side"] == "short"
    assert trade["entry_price"] == 100.0 and trade["exit_price"] == 90.0
    assert trade["pnl_chf"] > 0                       # le short a gagné
    assert trade["r_multiple"] == 1.0                 # +10 pour 10 de risque
    assert portfolio_of(c)["portfolio"]["positions"] == []


def test_buying_a_symbol_held_short_is_refused(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    buy(c, side="short", qty=10, thesis="Surévaluée, résultats en baisse")
    response = order(c, side="buy", qty=5)
    assert response.status_code == 400
    assert "cover" in response.json()["detail"]


# ================================================================
#  ANNULATION ET REMISE À ZÉRO
# ================================================================

def test_cancel_an_open_order(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    body = buy(c, kind="limit", limit_price=90.0, qty=10, thesis="Achat sur repli")
    order_id = body["order"]["id"]

    response = c.post("/api/paper/orders/%s/cancel" % order_id)
    assert response.status_code == 200
    assert response.json()["order"]["status"] == "cancelled"
    assert portfolio_of(c)["portfolio"]["open_orders"] == []
    assert c.post("/api/paper/orders/%s/cancel" % order_id).status_code == 404


def test_reset_keeps_the_coach_memory(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    buy(c, qty=10, thesis="Thèse suffisamment longue pour passer le seuil")
    store.save_coach("tester", dict(coach.empty_profile(), lessons_passed=["basics"],
                                    n_sessions=3))

    response = c.post("/api/paper/portfolio/reset", json={"initial_capital": 5000.0,
                                                          "fee_profile": "ibkr"})
    assert response.status_code == 200
    data = portfolio_of(c)
    assert data["portfolio"]["cash_chf"] == 5000.0
    assert data["portfolio"]["initial_capital"] == 5000.0
    assert data["portfolio"]["fee_profile"] == "ibkr"
    assert data["portfolio"]["positions"] == []
    # la mémoire, elle, survit — c'est tout l'intérêt du coach
    assert c.get("/api/paper/lessons").json()["passed"] == ["basics"]
    assert c.get("/api/paper/coach").json()["profile"]["n_sessions"] == 3


def test_reset_guards(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert c.post("/api/paper/portfolio/reset",
                  json={"initial_capital": -5.0}).status_code == 400
    assert c.post("/api/paper/portfolio/reset",
                  json={"fee_profile": "banque-du-coin"}).status_code == 400


# ================================================================
#  COURS ET RECHERCHE
# ================================================================

def test_search_needs_two_characters(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    market.results = [{"symbol": "NESN.SW", "name": "Nestle SA",
                       "exchange": "Swiss", "currency": "CHF"}]
    assert c.get("/api/paper/search?q=n").json() == []
    assert c.get("/api/paper/search?q=nes").json() == market.results


def test_quotes_endpoint_returns_a_map_with_fx(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    market.prices["AAPL"] = (200.0, "USD", "Apple Inc")
    body = c.get("/api/paper/quotes?symbols=NESN.SW,AAPL,ZZZZ").json()
    assert body["NESN.SW"]["fx_rate_chf"] == 1.0
    assert body["AAPL"]["fx_rate_chf"] == 0.88
    assert body["ZZZZ"]["price"] is None and "error" in body["ZZZZ"]


# ================================================================
#  COACH
# ================================================================

def test_coach_endpoint_reads_without_network(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    body = c.get("/api/paper/coach").json()
    assert body["biases"] == []
    assert body["summary"]["n_sessions"] == 0
    assert body["stats"]["n_trades"] == 0


def test_coach_ask_answers_and_journals(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    body = c.post("/api/paper/coach/ask", json={"question": "je fais quoi ?"}).json()
    assert body["answer"] == "Ta taille est le sujet."

    names = [n["name"] for n in c.get("/api/paper/coach/notes").json()]
    assert "Journal.md" in names
    note = c.get("/api/paper/coach/notes/Journal.md").json()
    assert "Ta taille est le sujet." in note["markdown"]
    assert "session coach" in note["markdown"]


def test_coach_ask_returns_502_when_the_llm_fails(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)

    def boom(context, question):
        raise RuntimeError("le coach n'a pas répondu dans les 120 s")

    monkeypatch.setattr(pr.llm, "ask_coach", boom)
    response = c.post("/api/paper/coach/ask", json={})
    assert response.status_code == 502
    assert "120" in response.json()["detail"]


def test_postmortem_needs_a_closed_trade(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert c.post("/api/paper/postmortem", json={}).status_code == 404


def test_postmortem_writes_the_journal_entry(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, qty=10, stop_loss=90.0, thesis="Cassure haussière, invalidation sous 90")
    market.prices["NESN.SW"] = (120.0, "CHF", "Nestle SA")
    buy(c, side="sell", qty=10)

    body = c.post("/api/paper/postmortem", json={}).json()
    assert body["postmortem"] == "Post-mortem du trade."
    assert body["trade_index"] == 0

    markdown = c.get("/api/paper/coach/notes/Journal.md").json()["markdown"]
    assert "NESN.SW +2.00R" in markdown          # le R multiple titre l'entrée


def test_postmortem_rejects_an_out_of_range_index(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, qty=10, thesis="Thèse suffisamment longue pour passer le seuil")
    market.prices["NESN.SW"] = (120.0, "CHF", "Nestle SA")
    buy(c, side="sell", qty=10)
    assert c.post("/api/paper/postmortem", json={"trade_index": 7}).status_code == 404


def test_postmortem_502_when_the_llm_fails(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, qty=10, thesis="Thèse suffisamment longue pour passer le seuil")
    market.prices["NESN.SW"] = (120.0, "CHF", "Nestle SA")
    buy(c, side="sell", qty=10)

    def boom(trade, context):
        raise RuntimeError("claude cli rc=2")

    monkeypatch.setattr(pr.llm, "write_postmortem", boom)
    assert c.post("/api/paper/postmortem", json={}).status_code == 502


def test_analysis_returns_facts_and_text(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    body = c.post("/api/paper/analysis", json={"symbol": "nesn.sw"}).json()
    assert body["facts"]["trend"] == "haussier"
    assert body["analysis"] == "Fiche du titre."


def test_analysis_guards(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert c.post("/api/paper/analysis", json={"symbol": ""}).status_code == 400
    assert c.post("/api/paper/analysis", json={"symbol": "ZZZZ"}).status_code == 404

    def boom(facts):
        raise RuntimeError("claude introuvable")

    monkeypatch.setattr(pr.llm, "write_analysis", boom)
    assert c.post("/api/paper/analysis", json={"symbol": "NESN.SW"}).status_code == 502


def test_notes_guards(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert c.get("/api/paper/coach/notes").json() == []
    assert c.get("/api/paper/coach/notes/Journal.md").status_code == 404
    # nom hors de la whitelist du carnet (extension refusée) -> 400, pas 500
    assert c.get("/api/paper/coach/notes/Journal.txt").status_code == 400


def test_a_new_trade_grows_the_coach_profile(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, qty=10, thesis="", stop_loss=None)
    market.prices["NESN.SW"] = (80.0, "CHF", "Nestle SA")
    buy(c, side="sell", qty=10)

    profile = store.load_coach("tester")
    assert profile is not None
    assert profile["n_sessions"] == 1
    assert profile["last_synced_trades"] == 1


def test_reading_the_portfolio_does_not_grow_the_profile(tmp_path, monkeypatch):
    """Le profil grandit quand l'utilisateur TRADE, pas quand il regarde son
    écran : sinon ``n_sessions`` et le carnet deviendraient du bruit."""
    c, _ = make_client(tmp_path, monkeypatch)
    for _ in range(3):
        portfolio_of(c)
        c.post("/api/paper/tick")
    assert store.load_coach("tester") is None


# ================================================================
#  PÉDAGOGIE
# ================================================================

def test_lessons_never_leak_the_answers(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    body = c.get("/api/paper/lessons").json()
    assert len(body["lessons"]) >= 1
    for lesson in body["lessons"]:
        assert set(lesson) == {"id", "title", "body", "quiz"}
        for question in lesson["quiz"]:
            assert set(question) == {"q", "options"}
    assert body["passed"] == []


def _right_answers(lesson_id):
    for lesson in pr.lessons_catalog():
        if lesson["id"] == lesson_id:
            return [q["correct"] for q in lesson["quiz"]]
    raise AssertionError("leçon %s absente du catalogue" % lesson_id)


def test_a_perfect_quiz_is_recorded_in_the_profile(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    lesson_id = pr.lessons_catalog()[0]["id"]
    answers = _right_answers(lesson_id)

    body = c.post("/api/paper/lessons/%s/quiz" % lesson_id,
                  json={"answers": answers}).json()
    assert body["passed"] is True
    assert body["score"] == body["total"] == len(answers)
    assert c.get("/api/paper/lessons").json()["passed"] == [lesson_id]

    # idempotent : repasser le quiz ne duplique pas l'entrée
    c.post("/api/paper/lessons/%s/quiz" % lesson_id, json={"answers": answers})
    assert c.get("/api/paper/lessons").json()["passed"] == [lesson_id]


def test_a_wrong_quiz_explains_without_recording(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    lesson_id = pr.lessons_catalog()[0]["id"]
    answers = [(a + 1) % 3 for a in _right_answers(lesson_id)]

    body = c.post("/api/paper/lessons/%s/quiz" % lesson_id,
                  json={"answers": answers}).json()
    assert body["passed"] is False
    assert body["corrections"][0]["explain"]
    assert body["corrections"][0]["ok"] is False
    assert c.get("/api/paper/lessons").json()["passed"] == []


def test_missing_answers_count_as_wrong(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    lesson_id = pr.lessons_catalog()[0]["id"]
    body = c.post("/api/paper/lessons/%s/quiz" % lesson_id, json={"answers": []}).json()
    assert body["score"] == 0 and body["passed"] is False


def test_unknown_lesson_is_404(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert c.post("/api/paper/lessons/inexistante/quiz",
                  json={"answers": []}).status_code == 404


# ================================================================
#  ARÈNE
# ================================================================

def test_arena_serves_a_deterministic_weekly_challenge(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    first = c.get("/api/paper/arena").json()
    second = c.get("/api/paper/arena").json()
    assert first["challenge"]["id"] == second["challenge"]["id"]
    assert first["accepted"] is False
    assert first["history"] == []
    assert first["week"] == pr._week_id(datetime.now())


def test_arena_accept_is_idempotent(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert c.post("/api/paper/arena/accept").json()["accepted"] is True
    c.post("/api/paper/arena/accept")

    body = c.get("/api/paper/arena").json()
    assert body["accepted"] is True
    assert len(body["history"]) == 1
    assert body["history"][0]["status"] == "en_cours"     # la semaine se joue encore


# ================================================================
#  MODULES OPTIONNELS (veille news, radar)
# ================================================================

class FakeModule(object):
    def __init__(self, **functions):
        for name, function in functions.items():
            setattr(self, name, function)


def test_news_endpoint_serves_the_watch(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    events = [{"ts": 1, "symbol": "NESN.SW", "title": "Résultats", "link": "http://x",
               "sentiment": "neutre"}]
    monkeypatch.setattr(pr, "_newswatch",
                        lambda: FakeModule(recent_events=lambda user: events))
    assert c.get("/api/paper/news").json() == {"events": events}


def test_news_endpoint_without_the_module(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)

    def absent():
        raise ImportError("no module named newswatch")

    monkeypatch.setattr(pr, "_newswatch", absent)
    response = c.get("/api/paper/news")
    assert response.status_code == 200
    assert response.json() == {"events": []}


def test_news_endpoint_survives_a_broken_watch(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)

    def boom(user):
        raise IOError("flux RSS injoignable")

    monkeypatch.setattr(pr, "_newswatch", lambda: FakeModule(recent_events=boom))
    body = c.get("/api/paper/news").json()
    assert body["events"] == [] and "error" in body


def test_radar_read_and_run(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    payload = {"stats": {"scored": 3}, "hypotheses": [{"id": "h1"}]}
    counters = {"generated": 2, "notified": 1, "scored": 0, "errors": []}
    monkeypatch.setattr(pr, "_radar", lambda: FakeModule(
        recent=lambda: payload, run_once=lambda: counters))

    assert c.get("/api/paper/radar").json() == payload
    assert c.post("/api/paper/radar/run").json() == counters


def test_radar_without_the_module(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)

    def absent():
        raise ImportError("no module named radar")

    monkeypatch.setattr(pr, "_radar", absent)
    # la LECTURE dégrade en silence...
    assert c.get("/api/paper/radar").json() == {"stats": {}, "hypotheses": []}
    # ...mais une ACTION demandée qui ne peut pas avoir lieu se dit
    assert c.post("/api/paper/radar/run").status_code == 503


def test_radar_run_failure_is_502(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)

    def boom():
        raise RuntimeError("le générateur a échoué")

    monkeypatch.setattr(pr, "_radar", lambda: FakeModule(recent=lambda: {},
                                                         run_once=boom))
    response = c.post("/api/paper/radar/run")
    assert response.status_code == 502
    assert "générateur" in response.json()["detail"]


# ================================================================
#  LOGIQUE PURE (sans HTTP)
# ================================================================

def test_estimate_entry_price_prefers_the_threshold():
    assert pr.estimate_entry_price("limit", 90.0, None, 100.0) == 90.0
    assert pr.estimate_entry_price("stop", None, 110.0, 100.0) == 110.0
    assert pr.estimate_entry_price("market", None, None, 100.0) == 100.0
    assert pr.estimate_entry_price("market", None, None, None) is None


def test_planned_risk_is_none_without_a_stop():
    assert pr.planned_risk_chf(100.0, 90.0, 10, 1.0) == 100.0
    assert pr.planned_risk_chf(100.0, 90.0, 10, 0.5) == 50.0
    assert pr.planned_risk_chf(100.0, None, 10, 1.0) is None
    assert pr.planned_risk_chf(None, 90.0, 10, 1.0) is None


def test_compute_warnings_only_applies_to_entries():
    assert pr.compute_warnings("sell", "", None, None, 10000.0, 9999.0, 10000.0) == []
    assert pr.compute_warnings("cover", "", None, None, 10000.0, 9999.0, 10000.0) == []


def test_compute_warnings_flags_each_case():
    assert pr.compute_warnings("buy", "", 90.0, 10.0, 10000.0, 100.0, 10000.0) \
        == ["no_thesis"]
    assert pr.compute_warnings("buy", "Une thèse assez longue pour passer",
                               None, None, 10000.0, 100.0, 10000.0) == ["no_stop"]
    assert "oversized" in pr.compute_warnings(
        "buy", "Une thèse assez longue pour passer", 90.0, 250.0, 10000.0, 100.0, 10000.0)
    assert "concentration" in pr.compute_warnings(
        "buy", "Une thèse assez longue pour passer", 90.0, 10.0, 10000.0, 3000.0, 10000.0)


def test_week_id_and_week_of():
    assert pr._week_id(datetime(2026, 8, 24)) == "2026-W35"
    assert pr._week_of("2026-08-24T10:00:00") == "2026-W35"
    assert pr._week_of("pas une date") is None


def test_select_challenge_is_stable_and_spread():
    catalog = pr.arena_catalog()
    assert pr.select_challenge(catalog, "2026-W34") is pr.select_challenge(catalog, "2026-W34")
    weeks = ["2026-W%02d" % w for w in range(1, 30)]
    picked = {pr.select_challenge(catalog, w)["id"] for w in weeks}
    assert len(picked) > 1                       # le catalogue tourne vraiment
    assert pr.select_challenge([], "2026-W34") is None


def test_evaluate_check_reads_the_catalog_conditions():
    trades = [{"side": "long", "qty": 10, "entry_price": 100.0, "fx_rate": 1.0},
              {"side": "long", "qty": 5, "entry_price": 100.0, "fx_rate": 1.0}]
    assert pr.evaluate_check("n_trades_week>=1", trades, 10000.0) == "done"
    assert pr.evaluate_check("n_trades_week>=5", trades, 10000.0) == "failed"
    assert pr.evaluate_check("n_trades_week<=3", trades, 10000.0) == "done"
    assert pr.evaluate_check("has_short_trade_week", trades, 10000.0) == "failed"
    assert pr.evaluate_check("has_short_trade_week",
                             trades + [{"side": "short"}], 10000.0) == "done"
    # 10 x 100 = 1000 CHF = 10 % d'un capital de 10 000
    assert pr.evaluate_check("max_single_trade_notional_pct>=50",
                             trades, 10000.0) == "failed"
    assert pr.evaluate_check("max_single_trade_notional_pct>=5",
                             trades, 10000.0) == "done"
    # une condition qu'on ne sait pas mesurer n'est PAS un échec
    assert pr.evaluate_check("phase_de_lune==pleine", trades, 10000.0) == "na"
    assert pr.evaluate_check("", trades, 10000.0) == "na"


def test_arena_view_scores_only_past_weeks():
    catalog = [{"id": "earnings", "title": "Résultats", "check": "n_trades_week>=1"}]
    history = [{"week": "2026-W20", "id": "earnings", "accepted_at": "2026-05-11T09:00:00"},
               {"week": "2026-W35", "id": "earnings", "accepted_at": "2026-08-24T09:00:00"}]
    trades = [{"side": "long", "qty": 1, "entry_price": 10.0, "fx_rate": 1.0,
               "entry_at": "2026-05-12T10:00:00"}]
    view = pr.arena_view(catalog, history, trades, 10000.0, "2026-W35")
    statuses = {row["week"]: row["status"] for row in view["history"]}
    assert statuses["2026-W20"] == "done"        # un trade cette semaine-là
    assert statuses["2026-W35"] == "en_cours"    # la semaine courante ne se juge pas
    assert view["accepted"] is True


def test_window_filters_and_sorts_candles():
    candles = [{"ts": 30}, {"ts": 10}, {"ts": 20}]
    assert [c["ts"] for c in pr._window(candles, 15)] == [20, 30]
    assert [c["ts"] for c in pr._window(candles, None)] == [10, 20, 30]


def test_grade_quiz_is_server_side():
    lesson = {"quiz": [{"q": "a", "correct": 1, "explain": "parce que"},
                       {"q": "b", "correct": 0, "explain": "voilà"}]}
    assert pr.grade_quiz(lesson, [1, 0])["passed"] is True
    result = pr.grade_quiz(lesson, [1, 1])
    assert result["passed"] is False and result["score"] == 1
    assert result["corrections"][1]["correct"] == 0


def test_public_lesson_strips_the_answers():
    lesson = {"id": "x", "title": "T", "body": "B",
              "quiz": [{"q": "a", "options": ["1", "2"], "correct": 1,
                        "explain": "parce que"}]}
    public = pr.public_lesson(lesson)
    assert public["quiz"] == [{"q": "a", "options": ["1", "2"]}]


# ================================================================
#  MONTAGE DANS L'APPLICATION
# ================================================================

def test_router_is_mounted_in_main():
    from backend.main import app
    paths = {getattr(route, "path", "") for route in app.routes}
    assert "/api/paper/portfolio" in paths
    assert "/api/paper/orders" in paths
    assert "/api/paper/tick" in paths
