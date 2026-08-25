"""Tests du router du simulateur de paper trading — 100 % hors ligne.

Patron des voisins (``test_market_router.py``) : TestClient FastAPI + override de
``get_current_user`` (sur lequel ``require_role`` se branche), cours et LLM
monkeypatchés, persistance redirigée vers ``tmp_path``.

Aucun test ne touche le réseau ni le disque réel : le faux marché ``Market``
remplace ``quotes``, les trois fonctions du ``llm`` sont neutralisées, et
``store.DATA_DIR`` pointe sur le répertoire temporaire du test.
"""
import json
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
        self.unknown = set()          # symboles que Yahoo ne connaît pas
        self.meta_broken = set()      # métadonnées en panne, bougies OK
        self.candle_calls = []
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
        if symbol in self.unknown:
            raise quotes.UnknownSymbol("symbole inconnu de Yahoo: %s" % symbol)
        self.candle_calls.append((symbol, range_, interval))
        return list(self.candles.get(symbol, []))

    def get_meta(self, symbol, range_="5d", interval="1d"):
        if symbol in self.meta_broken:
            raise quotes.QuoteError("métadonnées indisponibles pour %s" % symbol)
        currency = self.prices[symbol][1] if symbol in self.prices else None
        return {"symbol": symbol, "currency": currency}

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
    for name in ("get_quote", "fx_to_chf", "get_candles", "get_meta", "search",
                 "fiche_facts"):
        monkeypatch.setattr(quotes, name, getattr(market, name))

    # ``lang="fr"`` sur chaque doublure : le router passe désormais la langue de
    # lecture aux QUATRE fonctions du LLM (même patron que ``suggest_ideas``).
    monkeypatch.setattr(pr.llm, "ask_coach",
                        lambda context, question, lang="fr": "Ta taille est le sujet.")
    monkeypatch.setattr(pr.llm, "write_postmortem",
                        lambda trade, context, lang="fr": "Post-mortem du trade.")
    monkeypatch.setattr(pr.llm, "write_analysis",
                        lambda facts, lang="fr": "Fiche du titre.")
    monkeypatch.setattr(pr.llm, "suggest_ideas",
                        lambda context, lang="fr", risk_level="mesure":
                        'Pas de matière suffisante.\n'
                        '```json\n{"ideas": []}\n```')

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
    assert c.get("/api/paper/digest").status_code == 403
    assert c.post("/api/paper/digest/run").status_code == 403
    assert c.get("/api/paper/candles?symbol=NESN.SW").status_code == 403
    assert c.get("/api/paper/community").status_code == 403
    assert c.post("/api/paper/ideas", json={}).status_code == 403
    assert c.get("/api/paper/watchlist").status_code == 403


def test_money_role_is_allowed(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch, role="money")
    assert c.get("/api/paper/portfolio").status_code == 200


def test_trader_role_is_allowed(tmp_path, monkeypatch):
    """Nouveau rôle : accès au SEUL module Trading — mêmes endpoints que
    money/admin (précédent exact : rectester, piège #37 CLAUDE.md)."""
    c, _ = make_client(tmp_path, monkeypatch, role="trader")
    assert c.get("/api/paper/portfolio").status_code == 200
    assert c.get("/api/paper/community").status_code == 200
    assert c.post("/api/paper/ideas", json={}).status_code == 200
    assert c.get("/api/paper/watchlist").status_code == 200


def test_trader_role_is_registered_but_not_invitable():
    """Même politique que rectester : admin-assigné uniquement, jamais
    distribuable via un code d'invitation."""
    from backend.auth import permissions as perms
    assert "trader" in perms.VALID_ROLES
    assert "trader" not in perms.INVITABLE_ROLES


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

    def boom(context, question, lang="fr"):
        raise RuntimeError("le coach n'a pas répondu dans les 120 s")

    monkeypatch.setattr(pr.llm, "ask_coach", boom)
    response = c.post("/api/paper/coach/ask", json={})
    assert response.status_code == 502
    assert "120" in response.json()["detail"]


def test_coach_ask_persists_the_discussion_in_the_shared_vault(tmp_path, monkeypatch):
    """Discussions.md est un carnet PARTAGÉ (extension communauté) — distinct
    du Journal.md privé déjà couvert par test_coach_ask_answers_and_journals."""
    c, _ = make_client(tmp_path, monkeypatch)
    body = c.post("/api/paper/coach/ask", json={"question": "je fais quoi ?"}).json()
    assert body["answer"] == "Ta taille est le sujet."

    names = [n["name"] for n in c.get("/api/paper/coach/notes").json()]
    assert "Discussions.md" in names
    note = c.get("/api/paper/coach/notes/Discussions.md").json()
    assert "je fais quoi ?" in note["markdown"]
    assert "Ta taille est le sujet." in note["markdown"]
    assert "Question de tester" in note["markdown"]        # FakeUser.username


def test_coach_ask_survives_a_broken_vault_write(tmp_path, monkeypatch):
    """Un carnet en panne (Journal.md ET Discussions.md) ne doit JAMAIS casser
    la réponse HTTP déjà obtenue du LLM — même invariant best-effort que
    _append_journal, étendu à _append_discussion."""
    c, _ = make_client(tmp_path, monkeypatch)

    def boom(username, rel_name, markdown_text):
        raise OSError("disque plein")

    monkeypatch.setattr(pr.store, "append_note", boom)
    response = c.post("/api/paper/coach/ask", json={"question": "je fais quoi ?"})
    assert response.status_code == 200
    assert response.json()["answer"] == "Ta taille est le sujet."


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

    def boom(trade, context, lang="fr"):
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

    def boom(facts, lang="fr"):
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
#  COMMUNAUTÉ (carnets partagés entre traders)
# ================================================================

def test_community_lists_vaults_and_reads_another_traders_note(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    store.append_note("alice", "Journal.md", "## note d'alice\n")
    store.append_note("bob", "Journal.md", "## note de bob\n")

    body = c.get("/api/paper/community").json()
    users = {row["user"] for row in body["users"]}
    assert users == {"alice", "bob"}
    alice_row = next(row for row in body["users"] if row["user"] == "alice")
    assert [n["name"] for n in alice_row["notes"]] == ["Journal.md"]

    # "tester" (l'utilisateur courant du client) lit le carnet de bob -
    # LECTURE d'un AUTRE utilisateur, aucune écriture cross-user en jeu.
    note = c.get("/api/paper/community/bob/Journal.md")
    assert note.status_code == 200
    assert note.json() == {"user": "bob", "name": "Journal.md",
                           "markdown": "## note de bob\n"}


def test_community_is_empty_without_any_vault(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert c.get("/api/paper/community").json() == {"users": []}


def test_community_404s_a_user_absent_from_the_vault_list(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    store.append_note("alice", "Journal.md", "## note d'alice\n")
    assert c.get("/api/paper/community/does-not-exist/Journal.md").status_code == 404


def test_community_rejects_a_forged_user(tmp_path, monkeypatch):
    """``..`` ne peut structurellement jamais figurer dans
    ``list_vault_users`` (allowlist stricte de ``_sanitize_username``, aucun
    ``.`` autorisé) : 404 avant même de toucher le disque, comme n'importe
    quel autre utilisateur inconnu."""
    c, _ = make_client(tmp_path, monkeypatch)
    resp = c.get("/api/paper/community/%2e%2e/Journal.md")
    assert resp.status_code in (400, 404)


def test_community_404s_an_absent_note_of_a_real_vault(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    store.append_note("alice", "Journal.md", "## note d'alice\n")
    assert c.get("/api/paper/community/alice/Nope.md").status_code == 404


def test_community_400s_an_invalid_note_name(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    store.append_note("alice", "Journal.md", "## note d'alice\n")
    assert c.get("/api/paper/community/alice/Journal.txt").status_code == 400


def test_watchlist_file_does_not_create_a_ghost_radar_user(tmp_path, monkeypatch):
    """<user>.watchlist.json porte un point dans le radical (même mécanisme
    que .coach.json et .news_seen.json, cf. radar._USER_FILE_RE) : il ne doit
    JAMAIS être compté comme un compte fantôme par le radar."""
    from backend.bots.paper import radar
    make_client(tmp_path, monkeypatch)          # applique le monkeypatch DATA_DIR
    store.save_portfolio("tester", pr.new_portfolio().to_dict())
    store.save_watchlist("tester", [{"symbol": "NESN.SW", "name": "Nestle SA",
                                     "currency": "CHF", "added_at": FIXED_NOW}])
    assert radar._users_with_portfolio() == ["tester"]


# ================================================================
#  IDÉES DE TRADE (extension coach, orientées rentabilité)
# ================================================================

def test_ideas_prompt_carries_the_profitability_doctrine():
    """Doctrine explicite : sizing/stop plutôt que « sûr », catalyseur cité."""
    from backend.bots.paper import llm as llm_mod
    prompt = llm_mod.build_ideas_prompt({}, lang="fr")
    assert "sizing" in prompt
    assert "catalyseur" in prompt
    assert "sûr" in prompt


def test_ideas_prompt_switches_language():
    from backend.bots.paper import llm as llm_mod
    assert "English" in llm_mod.build_ideas_prompt({}, lang="en")
    assert "italiano" in llm_mod.build_ideas_prompt({}, lang="it")
    assert "français" in llm_mod.build_ideas_prompt({}, lang="fr")


def _ideas_json(*rows):
    payload = json.dumps({"ideas": list(rows)})
    return "Voici mes idées.\n```json\n%s\n```" % payload


def test_ideas_happy_path_registers_radar_hypotheses(tmp_path, monkeypatch):
    from backend.bots.paper import radar
    c, _ = make_client(tmp_path, monkeypatch)
    monkeypatch.setattr(
        pr.llm, "suggest_ideas",
        lambda context, lang="fr", risk_level="mesure": _ideas_json(
            {"ticker": "aapl", "direction": "up", "horizon_days": 10,
             "thesis": "Momentum"},
            {"ticker": "tsla", "direction": "down", "horizon_days": 5,
             "thesis": "Retournement"},
        ))
    body = c.post("/api/paper/ideas", json={}).json()
    assert len(body["ideas"]) == 2
    assert all(idea["tracked"] for idea in body["ideas"])
    assert {idea["ticker"] for idea in body["ideas"]} == {"AAPL", "TSLA"}

    state = radar.load_state()
    assert len(state["hypotheses"]) == 2
    assert {h.get("source") for h in state["hypotheses"]} == {"coach"}
    assert {h.get("tickers", [None])[0] for h in state["hypotheses"]} == {"AAPL", "TSLA"}


def test_ideas_respects_the_radar_max_open_queue(tmp_path, monkeypatch):
    from backend.bots.paper import radar
    c, _ = make_client(tmp_path, monkeypatch)

    state = radar.blank_state()
    for i in range(radar.MAX_OPEN):
        state["hypotheses"].append({
            "id": "h%d" % i, "created_at": FIXED_NOW, "status": "open",
            "outcome": None, "scored_at": None, "move_pct": None,
            "thesis": "déjà ouverte", "chain": [], "markets": [],
            "tickers": ["X%d" % i], "direction": "up", "horizon_days": 7,
            "confidence": "moyenne", "invalidation": "?",
        })
    radar.save_state(state)

    monkeypatch.setattr(
        pr.llm, "suggest_ideas",
        lambda context, lang="fr", risk_level="mesure": _ideas_json(
            {"ticker": "AAPL", "direction": "up", "horizon_days": 10,
             "thesis": "Momentum"}))
    body = c.post("/api/paper/ideas", json={}).json()
    assert body["ideas"] == [{"ticker": "AAPL", "direction": "up",
                             "horizon_days": 10, "thesis": "Momentum",
                             "risk_level": "mesure", "asset_kind": "equity",
                             "tracked": False}]
    assert len(radar.load_state()["hypotheses"]) == radar.MAX_OPEN


def test_ideas_without_a_json_block_still_returns_the_text(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    monkeypatch.setattr(pr.llm, "suggest_ideas",
                        lambda context, lang="fr", risk_level="mesure":
                        "Contexte trop maigre, je ne peux rien proposer.")
    body = c.post("/api/paper/ideas", json={}).json()
    assert body["text"] == "Contexte trop maigre, je ne peux rien proposer."
    assert body["ideas"] == []


def test_ideas_returns_502_when_the_llm_fails(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)

    def boom(context, lang="fr", risk_level="mesure"):
        raise RuntimeError("le coach n'a pas répondu dans les 120 s")

    monkeypatch.setattr(pr.llm, "suggest_ideas", boom)
    response = c.post("/api/paper/ideas", json={})
    assert response.status_code == 502


def test_ideas_context_includes_the_watchlist(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    store.save_watchlist("tester", [{"symbol": "TSLA", "name": "Tesla Inc",
                                     "currency": "USD", "added_at": FIXED_NOW}])
    seen = {}

    def fake_suggest(context, lang="fr", risk_level="mesure"):
        seen["context"] = context
        return _ideas_json()

    monkeypatch.setattr(pr.llm, "suggest_ideas", fake_suggest)
    c.post("/api/paper/ideas", json={})
    assert seen["context"]["watchlist"] == [{"symbol": "TSLA", "name": "Tesla Inc",
                                             "currency": "USD", "added_at": FIXED_NOW}]


# ================================================================
#  NIVEAUX DE RISQUE (mesuré / agressif / spéculatif)
#
#  Le niveau traverse quatre couches : payload -> normalisation -> prompt ->
#  hypothèse persistée. C'est exactement la classe de champ qui se fait
#  stripper en silence (piège #61) : chaque étage est vérifié.
# ================================================================

def _ideas_double(monkeypatch, *rows):
    """Double de ``suggest_ideas`` qui NOTE le niveau reçu et rend ``rows``."""
    seen = {}

    def fake(context, lang="fr", risk_level="mesure"):
        seen["lang"] = lang
        seen["risk_level"] = risk_level
        return _ideas_json(*rows)

    monkeypatch.setattr(pr.llm, "suggest_ideas", fake)
    return seen


def test_ideas_defaults_to_the_measured_level(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    seen = _ideas_double(monkeypatch)
    assert c.post("/api/paper/ideas", json={}).json()["risk_level"] == "mesure"
    assert seen["risk_level"] == "mesure"


def test_ideas_forwards_the_requested_level_to_the_coach(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    seen = _ideas_double(monkeypatch)
    body = c.post("/api/paper/ideas", json={"risk_level": "spéculatif"}).json()
    assert seen["risk_level"] == "speculatif"
    # la réponse dit l'étage RÉELLEMENT appliqué, pas celui qu'on croit avoir
    # demandé (l'accent a été normalisé en chemin)
    assert body["risk_level"] == "speculatif"


def test_an_unknown_level_falls_back_to_measured(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    seen = _ideas_double(monkeypatch)
    body = c.post("/api/paper/ideas", json={"risk_level": "yolo"}).json()
    assert seen["risk_level"] == "mesure"
    assert body["risk_level"] == "mesure"


def test_the_level_and_the_asset_kind_reach_the_radar(tmp_path, monkeypatch):
    from backend.bots.paper import radar
    c, _ = make_client(tmp_path, monkeypatch)
    _ideas_double(monkeypatch,
                  {"ticker": "btc-usd", "direction": "down", "horizon_days": 12,
                   "thesis": "Short crypto", "asset_kind": "crypto"},
                  {"ticker": "EURUSD=X", "direction": "up", "horizon_days": 60,
                   "thesis": "Semi-long euro", "asset_kind": "forex"})
    body = c.post("/api/paper/ideas", json={"risk_level": "speculatif"}).json()
    assert [(i["ticker"], i["asset_kind"], i["risk_level"]) for i in body["ideas"]] == [
        ("BTC-USD", "crypto", "speculatif"),
        ("EURUSD=X", "forex", "speculatif")]

    stored = {h["tickers"][0]: h for h in radar.load_state()["hypotheses"]}
    assert stored["BTC-USD"]["risk_level"] == "speculatif"
    assert stored["BTC-USD"]["asset_kind"] == "crypto"
    assert stored["EURUSD=X"]["asset_kind"] == "forex"
    assert stored["BTC-USD"]["source"] == "coach"


def test_a_semi_long_forex_idea_keeps_its_real_horizon(tmp_path, monkeypatch):
    """Bout en bout : une idée forex à 75 jours est PERSISTÉE à 75 jours (pas
    rabotée à 30) et n'est donc pas notée au 40ᵉ jour — c'est ce qui rend le
    semi-long du niveau spéculatif jugeable pour ce qu'il est."""
    from datetime import timedelta
    from backend.bots.paper import radar
    c, _ = make_client(tmp_path, monkeypatch)
    _ideas_double(monkeypatch,
                  {"ticker": "EURUSD=X", "direction": "up", "horizon_days": 75,
                   "thesis": "Écart de taux Fed/BCE", "asset_kind": "forex"})
    c.post("/api/paper/ideas", json={"risk_level": "speculatif"})

    stored = radar.load_state()["hypotheses"][0]
    assert stored["horizon_days"] == 75
    born = datetime.fromisoformat(FIXED_NOW)
    assert radar.is_mature(stored, born + timedelta(days=40)) is False
    assert radar.is_mature(stored, born + timedelta(days=76)) is True


def test_the_coach_cannot_promote_its_own_ideas(tmp_path, monkeypatch):
    """Le niveau est celui DEMANDÉ, jamais celui que le modèle s'attribue :
    sinon le bilan par étage mesurerait ce que le LLM a envie de raconter."""
    c, _ = make_client(tmp_path, monkeypatch)
    _ideas_double(monkeypatch,
                  {"ticker": "AAPL", "direction": "up", "horizon_days": 10,
                   "thesis": "Momentum", "risk_level": "speculatif"})
    body = c.post("/api/paper/ideas", json={"risk_level": "mesure"}).json()
    assert body["ideas"][0]["risk_level"] == "mesure"


def test_the_asset_kind_is_guessed_when_the_coach_omits_it(tmp_path, monkeypatch):
    """Un genre absent ou fantaisiste ne salit pas le bilan : il est déduit de
    la forme du ticker (BTC-USD -> crypto, =X -> forex)."""
    c, _ = make_client(tmp_path, monkeypatch)
    _ideas_double(monkeypatch,
                  {"ticker": "ETH-USD", "direction": "up", "horizon_days": 9,
                   "thesis": "Sans genre"},
                  {"ticker": "USDJPY=X", "direction": "down", "horizon_days": 45,
                   "thesis": "Genre fantaisiste", "asset_kind": "banane"},
                  {"ticker": "AAPL", "direction": "up", "horizon_days": 8,
                   "thesis": "Action ordinaire"})
    ideas = c.post("/api/paper/ideas", json={"risk_level": "speculatif"}).json()["ideas"]
    assert [i["asset_kind"] for i in ideas] == ["crypto", "forex", "equity"]


def test_the_radar_endpoint_exposes_the_scoreboard_by_level(tmp_path, monkeypatch):
    from backend.bots.paper import radar
    c, _ = make_client(tmp_path, monkeypatch)
    state = radar.blank_state()
    state["hypotheses"] = [
        {"id": "a", "created_at": FIXED_NOW, "status": "scored", "outcome": "hit",
         "scored_at": FIXED_NOW, "move_pct": 6.0, "source": "coach",
         "risk_level": "speculatif", "asset_kind": "crypto",
         "thesis": "Short crypto", "chain": [], "markets": [],
         "tickers": ["BTC-USD"], "direction": "down", "horizon_days": 12,
         "confidence": "moyenne", "invalidation": "?"},
        # hypothèse du radar automatique : sa propre case, pas un étage
        {"id": "b", "created_at": FIXED_NOW, "status": "scored", "outcome": "miss",
         "scored_at": FIXED_NOW, "move_pct": -4.0, "thesis": "Ricochet",
         "chain": ["a", "b"], "markets": [], "tickers": ["NESN.SW"],
         "direction": "up", "horizon_days": 7, "confidence": "moyenne",
         "invalidation": "?"},
    ]
    state["stats"] = {"hits": 1, "misses": 1, "unclear": 0}
    radar.save_state(state)

    body = c.get("/api/paper/radar").json()
    assert body["stats_by_level"] == {
        "speculatif": {"hits": 1, "misses": 0, "unclear": 0},
        "radar": {"hits": 0, "misses": 1, "unclear": 0}}


def test_an_old_radar_state_is_reread_and_extended(tmp_path, monkeypatch):
    """Un état écrit AVANT les niveaux (aucun ``risk_level``, aucun
    ``asset_kind``) se relit, s'affiche et accueille une idée neuve sans
    migration ni exception."""
    from backend.bots.paper import radar
    c, _ = make_client(tmp_path, monkeypatch)
    state = radar.blank_state()
    state["hypotheses"] = [{
        "id": "vieille", "created_at": FIXED_NOW, "status": "open",
        "outcome": None, "scored_at": None, "move_pct": None, "source": "coach",
        "thesis": "Idée d'avant les niveaux", "chain": [], "markets": [],
        "tickers": ["MSFT"], "direction": "up", "horizon_days": 7,
        "confidence": "moyenne", "invalidation": "(non précisée)",
    }]
    radar.save_state(state)

    assert c.get("/api/paper/radar").status_code == 200
    _ideas_double(monkeypatch, {"ticker": "SOL-USD", "direction": "up",
                                "horizon_days": 14, "thesis": "Nouvelle"})
    body = c.post("/api/paper/ideas", json={"risk_level": "agressif"}).json()
    assert body["ideas"][0]["tracked"] is True

    stored = radar.load_state()["hypotheses"]
    assert [h["id"] for h in stored][0] == "vieille"
    assert "risk_level" not in stored[0]            # l'ancienne n'est pas réécrite
    assert stored[1]["risk_level"] == "agressif"


def test_search_exposes_the_kind_of_each_result(tmp_path, monkeypatch):
    """Champ traversant : le router rend ce que ``quotes.search`` produit, le
    frontend a besoin du genre pour dire « crypto » plutôt que « action »."""
    c, market = make_client(tmp_path, monkeypatch)
    market.results = [{"symbol": "BTC-USD", "name": "Bitcoin USD",
                       "exchange": "CCC", "currency": "", "kind": "crypto"}]
    assert c.get("/api/paper/search?q=btc").json() == market.results


def test_coach_ask_context_includes_the_watchlist(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    store.save_watchlist("tester", [{"symbol": "TSLA", "name": "Tesla Inc",
                                     "currency": "USD", "added_at": FIXED_NOW}])
    seen = {}

    def fake_ask(context, question, lang="fr"):
        seen["context"] = context
        return "Ta taille est le sujet."

    monkeypatch.setattr(pr.llm, "ask_coach", fake_ask)
    c.post("/api/paper/coach/ask", json={"question": "?"})
    assert seen["context"]["watchlist"][0]["symbol"] == "TSLA"


# ================================================================
#  WATCHLIST (titres favoris)
# ================================================================

def test_watchlist_add_list_remove_roundtrip(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert c.get("/api/paper/watchlist").json() == {"symbols": []}

    body = c.post("/api/paper/watchlist", json={"symbol": "nesn.sw"}).json()
    assert body["symbols"] == [{"symbol": "NESN.SW", "name": "Nestle SA",
                                "currency": "CHF", "added_at": FIXED_NOW}]
    assert c.get("/api/paper/watchlist").json() == body

    removed = c.delete("/api/paper/watchlist/NESN.SW")
    assert removed.status_code == 200
    assert removed.json()["symbols"] == []
    assert c.get("/api/paper/watchlist").json() == {"symbols": []}


def test_watchlist_add_is_idempotent_case_insensitive(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    c.post("/api/paper/watchlist", json={"symbol": "NESN.SW"})
    body = c.post("/api/paper/watchlist", json={"symbol": "nesn.sw"}).json()
    assert len(body["symbols"]) == 1


def test_watchlist_rejects_an_empty_symbol(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert c.post("/api/paper/watchlist", json={"symbol": "   "}).status_code == 400


def test_watchlist_rejects_an_unknown_symbol(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert c.post("/api/paper/watchlist", json={"symbol": "ZZZZ"}).status_code == 404


def test_watchlist_caps_at_the_maximum(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    for i in range(pr.MAX_WATCHLIST):
        symbol = "SYM%d" % i
        market.prices[symbol] = (10.0, "CHF", "Titre %d" % i)
        assert c.post("/api/paper/watchlist", json={"symbol": symbol}).status_code == 200
    market.prices["OVERFLOW"] = (10.0, "CHF", "Trop")
    assert c.post("/api/paper/watchlist", json={"symbol": "OVERFLOW"}).status_code == 400


def test_watchlist_remove_unknown_is_404(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert c.delete("/api/paper/watchlist/ZZZZ").status_code == 404


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
    # la LECTURE dégrade en silence — bilan par niveau vide compris, pour que le
    # client n'ait jamais à distinguer « pas de radar » de « pas de verdict »...
    assert c.get("/api/paper/radar").json() == {"stats": {}, "stats_by_level": {},
                                                "hypotheses": []}
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
#  CONVERGENCE (digest Telegram, spec §13)
# ================================================================

def _fake_convergence(monkeypatch, **functions):
    calls = []

    def _maybe_fire(force=False):
        calls.append(force)
        return functions.get("result", {"fired": True, "reason": "ok",
                                        "factors": {}, "sent": True, "llm": True})

    module = FakeModule(recent=functions.get("recent", lambda: {"history": []}),
                        maybe_fire=functions.get("maybe_fire", _maybe_fire))
    monkeypatch.setattr(pr, "_convergence", lambda: module)
    return calls


def test_digest_read_and_run(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    history = {"history": [{"ts": "2026-08-24T12:00:00", "factors": ["gov"],
                            "n_items": 3, "digest": "…", "llm": True}]}
    calls = _fake_convergence(monkeypatch, recent=lambda: history)

    assert c.get("/api/paper/digest").json() == history
    body = c.post("/api/paper/digest/run").json()
    assert body["fired"] is True and body["reason"] == "ok"
    assert calls == [False]                     # sans ``force`` par défaut


def test_digest_run_force_is_passed_through(tmp_path, monkeypatch):
    """``force=true`` = la porte du test manuel : elle saute le cooldown de 6 h
    et l'empreinte, mais c'est la convergence qui garde le seuil de facteurs."""
    c, _ = make_client(tmp_path, monkeypatch)
    calls = _fake_convergence(monkeypatch)
    assert c.post("/api/paper/digest/run?force=true").status_code == 200
    assert calls == [True]


def test_digest_run_without_convergence_still_answers(tmp_path, monkeypatch):
    """Moins de deux facteurs : la réponse est explicite, pas une erreur."""
    c, _ = make_client(tmp_path, monkeypatch)
    _fake_convergence(monkeypatch, result={"fired": False, "reason": "too_few",
                                           "factors": {}, "sent": False,
                                           "llm": False})
    body = c.post("/api/paper/digest/run?force=true").json()
    assert body == {"fired": False, "reason": "too_few", "factors": {},
                    "sent": False, "llm": False}


def test_digest_without_the_module(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)

    def absent():
        raise ImportError("no module named convergence")

    monkeypatch.setattr(pr, "_convergence", absent)
    # la LECTURE dégrade en silence...
    assert c.get("/api/paper/digest").json() == {"history": []}
    # ...mais une ACTION demandée qui ne peut pas avoir lieu se dit
    assert c.post("/api/paper/digest/run").status_code == 503


def test_digest_read_survives_a_broken_state(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)

    def boom():
        raise IOError("état illisible")

    monkeypatch.setattr(pr, "_convergence", lambda: FakeModule(recent=boom))
    body = c.get("/api/paper/digest").json()
    assert body["history"] == [] and "error" in body


def test_digest_run_failure_is_502(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)

    def boom(force=False):
        raise RuntimeError("le digest a échoué")

    monkeypatch.setattr(pr, "_convergence",
                        lambda: FakeModule(recent=lambda: {}, maybe_fire=boom))
    response = c.post("/api/paper/digest/run")
    assert response.status_code == 502
    assert "digest" in response.json()["detail"]


# ================================================================
#  BOUGIES (graphique du frontend)
# ================================================================

def test_candles_happy_path(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    market.candles["NESN.SW"] = [
        {"ts": _ts(9), "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.5},
        # bougie du jour ENCORE OUVERTE : elle doit être servie telle quelle
        {"ts": _ts(10), "open": 100.5, "high": None, "low": None, "close": None},
    ]
    body = c.get("/api/paper/candles?symbol=nesn.sw&range_=6mo&interval=1d").json()

    assert body["symbol"] == "NESN.SW"           # normalisé en majuscules
    assert body["currency"] == "CHF"
    assert len(body["candles"]) == 2
    assert body["candles"][1]["close"] is None
    assert market.candle_calls == [("NESN.SW", "6mo", "1d")]


def test_candles_default_window(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    c.get("/api/paper/candles?symbol=NESN.SW")
    assert market.candle_calls == [("NESN.SW", "6mo", "1d")]


def test_candles_requires_a_symbol(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert c.get("/api/paper/candles").status_code == 400
    assert c.get("/api/paper/candles?symbol=%20").status_code == 400


@pytest.mark.parametrize("query", [
    "symbol=NESN.SW&range_=10y",        # fenêtre hors catalogue
    "symbol=NESN.SW&interval=1m",       # intervalle hors catalogue
    "symbol=NESN.SW&range_=",           # vide
])
def test_candles_refuses_an_unlisted_window(tmp_path, monkeypatch, query):
    """Liste FERMÉE : on ne proxifie pas Yahoo en aveugle."""
    c, market = make_client(tmp_path, monkeypatch)
    assert c.get("/api/paper/candles?" + query).status_code == 400
    assert market.candle_calls == []             # rien n'est même tenté


def test_candles_unknown_symbol_is_404(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    market.unknown.add("XXXX")
    assert c.get("/api/paper/candles?symbol=XXXX").status_code == 404


def test_candles_quote_failure_is_502(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    market.broken.add("NESN.SW")
    assert c.get("/api/paper/candles?symbol=NESN.SW").status_code == 502


def test_candles_currency_is_best_effort(tmp_path, monkeypatch):
    """Un graphique sans étiquette de devise reste lisible ; un 502 pour ça, non."""
    c, market = make_client(tmp_path, monkeypatch)
    market.candles["NESN.SW"] = [{"ts": _ts(9), "close": 100.0}]
    market.meta_broken.add("NESN.SW")
    body = c.get("/api/paper/candles?symbol=NESN.SW").json()
    assert body["currency"] is None and len(body["candles"]) == 1


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


# ================================================================
#  CONTENU MULTILINGUE (le simulateur parle la langue de l'interface)
#
#  Le chrome de l'interface était déjà traduit ×3 ; ce qui restait en
#  français, c'est le CONTENU servi par le backend. La priorité est
#  l'italien (Massii est italophone) ; l'anglais retombe sur le français.
# ================================================================

# Mots FRANÇAIS-SEULEMENT, cherchés en MOT ENTIER. Deux pièges évités :
#   - la sous-chaîne (« les » vit dans « valse ») -> on tokenise ;
#   - le mot commun aux deux langues -> « le », « tu », « da », « credito » sont
#     de l'italien parfaitement valide ; les inclure ferait échouer une
#     traduction IRRÉPROCHABLE (c'est ce qui est arrivé au premier jet).
# HEURISTIQUE assumée : elle ne juge pas la QUALITÉ de l'italien, elle attrape
# le cas réel — un bloc laissé dans la langue d'origine. Sa discriminance est
# elle-même testée plus bas : un détecteur qui ne détecte rien ne prouve rien.
FRENCH_MARKERS = ("les", "vous", "des", "une", "est", "sont", "avec", "pour",
                  "dans", "cette", "leur", "aussi", "après", "toujours", "jamais",
                  "moins", "plus", "quand", "parce", "perte", "pertes", "prix",
                  "titre", "titres", "marché", "frais", "risque", "seuil",
                  "gagnants", "perdants", "achat", "vente", "année", "jours",
                  "semaine", "semaines", "chaque", "ordre", "ordres", "thèse",
                  "suisse", "impôt", "actions", "entreprise", "bénéfice")


def _words(text):
    """Tokens alphabétiques, apostrophes COUPÉES (« l'azione » -> {l, azione}) :
    sans cela « d'une » serait un seul token et « une » passerait au travers."""
    import re
    return set(w.lower() for w in re.findall(r"[a-zA-ZÀ-ÿ]+", str(text or "")))


def _lesson_strings(lesson):
    out = [lesson.get("title", ""), lesson.get("body", "")]
    for question in lesson.get("quiz") or []:
        out.append(question.get("q", ""))
        out.append(question.get("explain", ""))
        out.extend(question.get("options") or [])
    return out


def test_the_italian_lessons_mirror_the_french_ones_exactly():
    """LE test de parité : mêmes leçons, mêmes questions, MÊMES index corrects.

    C'est lui qui empêche une traduction de fausser une correction de quiz —
    un `correct` décalé rendrait le quiz italien faux sans lever la moindre
    erreur, et personne ne s'en apercevrait avant que Massii échoue à un quiz
    auquel il a bien répondu.
    """
    fr = pr.lessons_catalog("fr")
    it = pr.lessons_catalog("it")
    assert fr and it
    assert [l["id"] for l in fr] == [l["id"] for l in it]

    for lesson_fr, lesson_it in zip(fr, it):
        quiz_fr = lesson_fr["quiz"]
        quiz_it = lesson_it["quiz"]
        assert len(quiz_fr) == len(quiz_it), lesson_fr["id"]
        for question_fr, question_it in zip(quiz_fr, quiz_it):
            assert question_fr["correct"] == question_it["correct"], lesson_fr["id"]
            assert len(question_fr["options"]) == len(question_it["options"])
            assert question_it["explain"].strip()


def test_the_italian_lessons_are_actually_translated():
    """Parité structurelle sans traduction = 8 leçons françaises rebaptisées."""
    for lesson_fr, lesson_it in zip(pr.lessons_catalog("fr"), pr.lessons_catalog("it")):
        assert lesson_it["title"] != lesson_fr["title"], lesson_fr["id"]
        assert lesson_it["body"] != lesson_fr["body"], lesson_fr["id"]


def test_no_french_leftovers_in_the_italian_lessons():
    for lesson in pr.lessons_catalog("it"):
        for text in _lesson_strings(lesson):
            leftovers = _words(text) & set(FRENCH_MARKERS)
            assert not leftovers, "%s: %s dans %r" % (lesson["id"], leftovers, text[:80])


def test_the_french_detector_actually_detects_french():
    """Garde-fou du garde-fou : la liste ci-dessus doit repérer CHAQUE leçon
    française. Sinon le test précédent passerait même sur un fichier italien
    entièrement rédigé en français."""
    for lesson in pr.lessons_catalog("fr"):
        blob = " ".join(_lesson_strings(lesson))
        assert _words(blob) & set(FRENCH_MARKERS), lesson["id"]
    for challenge in pr.arena_catalog("fr"):
        blob = challenge["title"] + " " + challenge["desc"]
        assert _words(blob) & set(FRENCH_MARKERS), challenge["id"]


def test_the_italian_arena_mirrors_the_french_one():
    fr = pr.arena_catalog("fr")
    it = pr.arena_catalog("it")
    assert fr and it
    assert [c["id"] for c in fr] == [c["id"] for c in it]
    for challenge_fr, challenge_it in zip(fr, it):
        assert challenge_fr["check"] == challenge_it["check"], challenge_fr["id"]
        assert challenge_fr["difficulty"] == challenge_it["difficulty"]
        assert challenge_it["title"] != challenge_fr["title"]
        assert challenge_it["desc"] != challenge_fr["desc"]
        leftovers = (_words(challenge_it["title"]) | _words(challenge_it["desc"])) \
            & set(FRENCH_MARKERS)
        assert not leftovers, "%s: %s" % (challenge_fr["id"], leftovers)


def test_english_and_unknown_languages_fall_back_to_french_content():
    """Repli SILENCIEUX et voulu : pas de fichier anglais (décision utilisateur),
    et servir une demi-traduction serait pire que d'assumer le français."""
    french = pr.lessons_catalog("fr")
    for lang in ("en", "de", "", None, "zz"):
        assert pr.lessons_catalog(lang) is french
        assert pr.arena_catalog(lang) is pr.arena_catalog("fr")


def test_lessons_endpoint_serves_the_requested_language(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    italian = c.get("/api/paper/lessons?lang=it").json()["lessons"]
    french = c.get("/api/paper/lessons?lang=fr").json()["lessons"]
    english = c.get("/api/paper/lessons?lang=en").json()["lessons"]
    default = c.get("/api/paper/lessons").json()["lessons"]

    assert [l["id"] for l in italian] == [l["id"] for l in french]
    assert italian[0]["title"] != french[0]["title"]
    assert "azione" in italian[0]["title"].lower()
    assert english == french == default
    # les réponses ne fuitent dans AUCUNE langue
    for lesson in italian:
        for question in lesson["quiz"]:
            assert set(question) == {"q", "options"}


def test_quiz_corrections_are_explained_in_the_requested_language(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    lesson = pr.lessons_catalog("fr")[0]
    wrong = [(q["correct"] + 1) % len(q["options"]) for q in lesson["quiz"]]

    body = c.post("/api/paper/lessons/%s/quiz" % lesson["id"],
                  json={"answers": wrong, "lang": "it"}).json()
    assert body["passed"] is False
    explains = " ".join(row["explain"] for row in body["corrections"])
    assert explains.strip()
    assert not (_words(explains) & set(FRENCH_MARKERS)), explains


def test_quiz_progress_is_the_same_whatever_the_language(tmp_path, monkeypatch):
    """On valide une LEÇON, pas une traduction : réussie en italien, réussie
    tout court."""
    c, _ = make_client(tmp_path, monkeypatch)
    lesson = pr.lessons_catalog("fr")[0]
    answers = [q["correct"] for q in lesson["quiz"]]

    body = c.post("/api/paper/lessons/%s/quiz" % lesson["id"],
                  json={"answers": answers, "lang": "it"}).json()
    assert body["passed"] is True
    assert c.get("/api/paper/lessons?lang=fr").json()["passed"] == [lesson["id"]]
    assert c.get("/api/paper/lessons?lang=it").json()["passed"] == [lesson["id"]]


def test_arena_endpoint_translates_the_challenge_without_changing_it(tmp_path,
                                                                    monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    italian = c.get("/api/paper/arena?lang=it").json()
    french = c.get("/api/paper/arena?lang=fr").json()
    assert italian["challenge"]["id"] == french["challenge"]["id"]
    assert italian["challenge"]["check"] == french["challenge"]["check"]
    assert italian["challenge"]["title"] != french["challenge"]["title"]
    assert not (_words(italian["challenge"]["desc"]) & set(FRENCH_MARKERS))


def test_coach_endpoint_serves_italian_evidence(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    for i in range(5):                      # 5 allers-retours SANS stop planifié
        buy(c, qty=1)
        market.prices["NESN.SW"] = (95.0 + i, "CHF", "Nestle SA")
        buy(c, side="sell", qty=1)

    biases = c.get("/api/paper/coach?lang=it").json()["biases"]
    no_stop = [b for b in biases if b["code"] == "no_stop"]
    assert no_stop, [b["code"] for b in biases]
    assert "senza stop pianificato" in no_stop[0]["evidence"][0]

    french = c.get("/api/paper/coach").json()["biases"]
    assert [b["code"] for b in french] == [b["code"] for b in biases]
    assert "sans stop planifié" in [b for b in french if b["code"] == "no_stop"][0]["evidence"][0]


def test_portfolio_biases_follow_the_language(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    for i in range(5):
        buy(c, qty=1)
        market.prices["NESN.SW"] = (95.0 + i, "CHF", "Nestle SA")
        buy(c, side="sell", qty=1)

    italian = c.get("/api/paper/portfolio?lang=it").json()["biases"]
    assert any("senza stop pianificato" in " ".join(b["evidence"]) for b in italian)
    assert not any("planifié" in " ".join(b["evidence"]) for b in italian)


def test_the_concentration_evidence_is_translated_too():
    """9ᵉ règle : elle vit dans le router (elle a besoin des cours), donc elle
    a sa propre table — c'est exactement celle qu'une traduction oublie."""
    exposure = {"max_concentration_pct": 60.0, "per_position_pct": {"NESN.SW": 60.0}}
    italian = pr._with_concentration([], exposure, "it")
    french = pr._with_concentration([], exposure)
    assert italian[0]["code"] == french[0]["code"] == "concentration"
    assert italian[0]["metric"] == french[0]["metric"]
    assert "pesa il 60.0% del portafoglio" in italian[0]["evidence"][0]
    assert "pèse 60.0% du portefeuille" in french[0]["evidence"][0]
    assert pr._with_concentration([], exposure, "en") == french


def test_the_llm_endpoints_forward_the_reading_language(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, qty=10, thesis="Thèse suffisamment longue pour passer le seuil")
    market.prices["NESN.SW"] = (120.0, "CHF", "Nestle SA")
    buy(c, side="sell", qty=10)

    seen = {}
    monkeypatch.setattr(pr.llm, "ask_coach",
                        lambda context, question, lang="fr":
                        seen.__setitem__("ask", lang) or "risposta")
    monkeypatch.setattr(pr.llm, "write_postmortem",
                        lambda trade, context, lang="fr":
                        seen.__setitem__("postmortem", lang) or "risposta")
    monkeypatch.setattr(pr.llm, "write_analysis",
                        lambda facts, lang="fr":
                        seen.__setitem__("analysis", lang) or "risposta")
    monkeypatch.setattr(pr.llm, "suggest_ideas",
                        lambda context, lang="fr", risk_level="mesure":
                        seen.__setitem__("ideas", lang) or '```json\n{"ideas": []}\n```')

    c.post("/api/paper/coach/ask", json={"question": "?", "lang": "it"})
    c.post("/api/paper/postmortem", json={"lang": "it"})
    c.post("/api/paper/analysis", json={"symbol": "NESN.SW", "lang": "it"})
    c.post("/api/paper/ideas", json={"lang": "it"})
    assert seen == {"ask": "it", "postmortem": "it", "analysis": "it", "ideas": "it"}

    c.post("/api/paper/coach/ask", json={"question": "?"})
    c.post("/api/paper/analysis", json={"symbol": "NESN.SW", "lang": "klingon"})
    assert seen["ask"] == "fr" and seen["analysis"] == "fr"
