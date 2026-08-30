"""Tests du router du simulateur de paper trading — 100 % hors ligne.

Patron des voisins (``test_market_router.py``) : TestClient FastAPI + override de
``get_current_user`` (sur lequel ``require_role`` se branche), cours et LLM
monkeypatchés, persistance redirigée vers ``tmp_path``.

Aucun test ne touche le réseau ni le disque réel : le faux marché ``Market``
remplace ``quotes``, les trois fonctions du ``llm`` sont neutralisées, et
``store.DATA_DIR`` pointe sur le répertoire temporaire du test.
"""
import json
import threading
import time
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.auth.utils import get_current_user
from backend.bots import paper_router as pr
from backend.bots.paper import coach, fees, mood, quotes, store

# Les VRAIES fonctions du balayage frais, capturées AVANT que ``make_client`` ne
# les neutralise (même patron que ``_REAL_COLLECT_SOCIAL`` côté radar) : les
# tests dédiés les réinstallent avec un ``fetch``/``sleep`` injectés.
_REAL_FRESH_SWEEP = pr._fresh_sweep
_REAL_BACKFILL_NEW = pr._backfill_new_tickers
_REAL_AGENDA_MACRO = pr._agenda_macro

FIXED_NOW = "2026-08-24T10:00:00"


def _ts(hour):
    """Epoch local d'une heure du 24 août 2026 (les bougies du faux marché)."""
    return datetime(2026, 8, 24, hour, 0, 0).timestamp()


@pytest.fixture(autouse=True)
def _empty_job_registry():
    """Le registre des travaux détachés est un état de MODULE : sans remise à
    zéro, il fuit d'un test à l'autre.

    Ce n'est pas de l'hygiène gratuite, c'est un échec MESURÉ : les travaux
    laissés ``pending`` par les tests précédents comptaient dans le plafond par
    compte, et les deux tests du plafond passaient SEULS puis échouaient dans la
    suite complète (429 dès la première requête). Un test qui dépend de l'ordre
    d'exécution ne prouve rien.
    """
    pr._JOBS.clear()
    yield
    pr._JOBS.clear()


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
        self.search_calls = []
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
        self.search_calls.append(q)
        return list(self.results)

    def fiche_facts(self, symbol):
        if symbol not in self.prices:
            raise quotes.UnknownSymbol("symbole inconnu de Yahoo: %s" % symbol)
        return dict(self.facts)


def scenarios_answer(title="La Fed baisse-t-elle en septembre ?", labels=None,
                     intro="Voici les chemins que je vois."):
    """Réponse type du coach stratège : du texte, puis le bloc JSON final."""
    labels = labels or ["la Fed coupe", "statu quo"]
    payload = {
        "title": title,
        "context": "Le marché hésite avant la réunion.",
        "branches": [
            {"label": label, "prob": "moyenne", "consequence": "les small caps",
             "plays": [{"ticker": "IWM", "direction": "up"}]}
            for label in labels
        ],
    }
    return "%s\n```json\n%s\n```" % (intro, json.dumps(payload))


def make_client(tmp_path, monkeypatch, role="admin"):
    """Client isolé : disque en tmp, horloge figée, marché et LLM factices."""
    monkeypatch.setattr(store, "DATA_DIR", tmp_path / "paper_trading")
    monkeypatch.setattr(pr, "_now_iso", lambda: FIXED_NOW)
    # La jauge VIX (D3) est cachée EN MÉMOIRE PROCESSUS (mood._CACHE) -- ce
    # cache survivrait sinon d'un test à l'autre, contrairement à tout le
    # reste de cette fixture qui vit dans tmp_path.
    mood.clear_cache()

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
                        lambda context, lang="fr", risk_level="mesure", journal=None:
                        'Pas de matière suffisante.\n'
                        '```json\n{"ideas": []}\n```')
    # Le 5e prompt (arbres de scénarios) est doublé comme les quatre autres :
    # sans ce stub, un test de la vue « Plan » lancerait le VRAI CLI Claude.
    monkeypatch.setattr(pr.llm, "suggest_scenarios",
                        lambda context, lang="fr": scenarios_answer())
    # Deux portes RÉSEAU ouvertes par ``/ideas`` et ``/board/scenarios/generate``
    # depuis le 26/08 : le balayage de presse fait au clic, et la collecte du
    # dossier des tickers que le coach vient de choisir. Sans ces doublures,
    # chaque test de ces endpoints partirait vraiment sur Google News (mesuré :
    # 34 s pour la section « idées »). Les tests dédiés réinstallent les vraies
    # fonctions avec un ``fetch``/``sleep`` injectés.
    monkeypatch.setattr(pr, "_fresh_sweep", lambda targets, **kw: {})
    monkeypatch.setattr(pr, "_backfill_new_tickers", lambda ideas, **kw: [])
    # TROISIÈME porte réseau (W2b) : l'agenda macro relève CINQ sites de banque
    # centrale quand son cache de 24 h est froid — mesuré à ~1,7 s par appel
    # depuis un test qui se croit hors ligne. Les tests dédiés réinstallent la
    # vraie fonction avec le PONT doublé (cf. ``_agenda_double``).
    monkeypatch.setattr(pr, "_agenda_macro", lambda: {})

    app = FastAPI()
    app.include_router(pr.router)
    app.dependency_overrides[get_current_user] = lambda: FakeUser(role)
    return TestClient(app), market


# --- raccourcis ---------------------------------------------------------
def order(client, **kwargs):
    # ``confirmed: True`` par défaut (LOT 3, C3) : la quasi-totalité des
    # ~130 appels de ce fichier posent un ordre nu (sans thèse ni stop) pour
    # tester tout AUTRE CHOSE que la porte de confirmation elle-même — sans
    # ce défaut, ils tomberaient tous sur ``needs_confirm`` au lieu
    # d'exécuter. Les tests qui visent SPÉCIFIQUEMENT la porte passent
    # ``confirmed=False`` explicitement.
    payload = {"symbol": "NESN.SW", "side": "buy", "kind": "market", "qty": 10,
              "confirmed": True}
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
    assert c.post("/api/paper/ideas?sync=1", json={}).status_code == 403
    assert c.get("/api/paper/watchlist").status_code == 403
    assert c.get("/api/paper/board").status_code == 403
    assert c.post("/api/paper/board/pipeline", json={"symbol": "NESN.SW"}).status_code == 403
    assert c.post("/api/paper/board/pipeline/x", json={"stage_manual": "pret"}).status_code == 403
    assert c.delete("/api/paper/board/pipeline/x").status_code == 403
    assert c.post("/api/paper/board/scenarios/generate?sync=1", json={}).status_code == 403
    assert c.post("/api/paper/board/scenarios/t/branches/b",
                  json={"status": "happened"}).status_code == 403
    assert c.delete("/api/paper/board/scenarios/t").status_code == 403
    assert c.get("/api/paper/graph").status_code == 403
    assert c.get("/api/paper/graph/count?symbol=NESN.SW").status_code == 403
    assert c.get("/api/paper/graph/grove?kind=monde").status_code == 403
    assert c.get("/api/paper/journal/setups").status_code == 403
    assert c.get("/api/paper/journal/emotions").status_code == 403
    assert c.get("/api/paper/discipline").status_code == 403


def test_money_role_is_allowed(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch, role="money")
    assert c.get("/api/paper/portfolio").status_code == 200


def test_trader_role_is_allowed(tmp_path, monkeypatch):
    """Nouveau rôle : accès au SEUL module Trading — mêmes endpoints que
    money/admin (précédent exact : rectester, piège #37 CLAUDE.md)."""
    c, _ = make_client(tmp_path, monkeypatch, role="trader")
    assert c.get("/api/paper/portfolio").status_code == 200
    assert c.get("/api/paper/community").status_code == 200
    assert c.post("/api/paper/ideas?sync=1", json={}).status_code == 200
    assert c.get("/api/paper/watchlist").status_code == 200
    assert c.get("/api/paper/board").status_code == 200
    assert c.get("/api/paper/graph").status_code == 200
    assert c.get("/api/paper/graph/grove?kind=monde").status_code == 200
    assert c.post("/api/paper/board/pipeline",
                  json={"symbol": "NESN.SW"}).status_code == 200
    assert c.post("/api/paper/board/scenarios/generate?sync=1", json={}).status_code == 200
    assert c.get("/api/paper/journal/setups").status_code == 200
    assert c.get("/api/paper/journal/emotions").status_code == 200
    assert c.get("/api/paper/discipline").status_code == 200


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
#  LOT 3, C3 — porte de confirmation PRÉ-ordre
# ================================================================

def test_an_order_with_warnings_needs_confirmation_when_not_confirmed(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    r = order(c, thesis="", confirmed=False)
    assert r.status_code == 200          # une pause, jamais un refus dur
    body = r.json()
    assert body["needs_confirm"] is True
    assert "no_thesis" in body["warnings"]
    assert "no_stop" in body["warnings"]
    assert sorted(body.keys()) == ["needs_confirm", "warnings"]


def test_needs_confirm_never_touches_the_portfolio(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    before = portfolio_of(c)["portfolio"]
    order(c, thesis="", confirmed=False)
    after = portfolio_of(c)["portfolio"]
    assert after["cash_chf"] == before["cash_chf"]
    assert after["positions"] == before["positions"] == []


def test_confirming_executes_despite_the_warnings(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    body = buy(c, thesis="", confirmed=True)
    assert body["order"]["status"] == "filled"
    assert "no_thesis" in body["warnings"]     # l'avertissement informatif reste


def test_a_clean_order_never_needs_confirmation(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    r = order(c, qty=5, stop_loss=95.0,
             thesis="Thèse suffisamment longue pour passer le seuil du coach",
             confirmed=False)
    body = r.json()
    assert "needs_confirm" not in body
    assert body["order"]["status"] == "filled"


def test_sell_orders_never_need_confirmation_even_unconfirmed(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    buy(c, qty=10, thesis="Thèse suffisamment longue pour passer le seuil")
    r = order(c, side="sell", qty=4, thesis="", confirmed=False)
    body = r.json()
    assert "needs_confirm" not in body
    assert body["fill"]["trade"] is not None


def test_a_pending_limit_order_can_also_need_confirmation(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    r = order(c, kind="limit", limit_price=90.0, thesis="", confirmed=False)
    body = r.json()
    assert body["needs_confirm"] is True

    r2 = order(c, kind="limit", limit_price=90.0, thesis="", confirmed=True)
    body2 = r2.json()
    assert body2["fill"] is None
    assert body2["order"]["status"] == "open"


def test_forced_warnings_land_on_the_trade_at_close(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    entry = buy(c, qty=5, stop_loss=95.0, thesis="", confirmed=True)  # force no_thesis
    assert entry["order"]["forced_warnings"] == ["no_thesis"]

    market.prices["NESN.SW"] = (120.0, "CHF", "Nestle SA")
    close = buy(c, side="sell", qty=5)
    assert close["fill"]["trade"]["forced_warnings"] == ["no_thesis"]


def test_forced_warnings_stay_empty_when_nothing_was_forced(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    body = buy(c, qty=5, stop_loss=95.0,
              thesis="Thèse suffisamment longue pour passer le seuil du coach",
              confirmed=True)
    assert body["order"]["forced_warnings"] == []


def test_averaging_into_a_position_updates_forced_warnings(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    buy(c, qty=2, stop_loss=95.0,
       thesis="Thèse suffisamment longue pour passer le seuil du coach",
       confirmed=True)
    buy(c, qty=2, stop_loss=95.0, thesis="", confirmed=True)   # renfort forcé
    positions = portfolio_of(c)["portfolio"]["positions"]
    assert positions[0]["forced_warnings"] == ["no_thesis"]


# ================================================================
#  LOT 2 — JOURNAL NIVEAU PRO (B1-B5)
# ================================================================

# --- B2/B3 : setup/émotion, whitelists fermées, portées jusqu'au trade -----

def test_setup_and_emotion_are_optional_and_validated_against_a_closed_whitelist(
        tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    body = buy(c, setup="breakout", emotion="fomo",
              thesis="Cassure nette du plus haut du mois sur fort volume")
    assert body["order"]["setup"] == "breakout"
    assert body["order"]["emotion"] == "fomo"
    position = portfolio_of(c)["portfolio"]["positions"][0]
    assert position["setup"] == "breakout" and position["emotion"] == "fomo"

    assert order(c, setup="n-existe-pas").status_code == 400
    assert order(c, emotion="n-existe-pas").status_code == 400


def test_setup_and_emotion_default_to_empty_when_not_given(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    body = buy(c)
    assert body["order"]["setup"] == "" and body["order"]["emotion"] == ""


def test_setup_and_emotion_survive_from_entry_to_the_closed_trade(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, setup="trend", emotion="doute",
       thesis="Tendance de fond haussière confirmée sur plusieurs unités de temps")
    market.prices["NESN.SW"] = (120.0, "CHF", "Nestle SA")
    body = buy(c, side="sell", qty=10)
    trade = body["fill"]["trade"]
    assert trade["setup"] == "trend"
    assert trade["emotion"] == "doute"
    # Sortie via un ordre marché (pas le dialogue de clôture) : pas d'émotion
    # de SORTIE, même si l'entrée en portait une.
    assert trade["emotion_close"] == ""


def test_emotion_close_is_accepted_only_by_the_close_endpoint(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    buy(c, thesis="Une thèse suffisamment longue pour passer le seuil du coach")
    r = c.post("/api/paper/positions/NESN.SW/close", json={"emotion_close": "euphorie"})
    assert r.status_code == 200
    assert r.json()["fill"]["trade"]["emotion_close"] == "euphorie"


def test_emotion_close_is_validated_and_refuses_to_close_on_a_bad_value(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    buy(c, thesis="Une thèse suffisamment longue pour passer le seuil du coach")
    r = c.post("/api/paper/positions/NESN.SW/close", json={"emotion_close": "n-existe-pas"})
    assert r.status_code == 400
    assert len(portfolio_of(c)["portfolio"]["positions"]) == 1     # rien n'a bougé


def test_a_mechanical_stop_close_never_carries_an_emotion_close(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, qty=10, stop_loss=90.0, thesis="Cassure haussière, invalidation sous 90")
    market.candles["NESN.SW"] = [
        {"ts": _ts(11), "open": 95.0, "high": 96.0, "low": 88.0, "close": 89.0}]
    result = c.post("/api/paper/tick").json()
    assert result["stopped"][0]["trade"]["emotion_close"] == ""


# --- B1/B5 : MAE/MFE + « laissé sur la table », câblés aux clôtures --------

def test_close_position_attaches_mae_mfe_and_the_gap_left_on_the_table(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, qty=10, thesis="Une thèse suffisamment longue pour passer le seuil du coach")
    market.prices["NESN.SW"] = (108.0, "CHF", "Nestle SA")
    market.candles["NESN.SW"] = [{"high": 112.0, "low": 97.0}]

    r = c.post("/api/paper/positions/NESN.SW/close", json={})
    trade = r.json()["fill"]["trade"]
    assert trade["mae_pct"] == -3.0
    assert trade["mfe_pct"] == 12.0
    assert trade["best_exit_gap_pct"] == round(12.0 - trade["pnl_pct"], 2)
    # Persistance : le trade RELU depuis le portefeuille porte les mêmes champs
    # (et pas seulement la réponse HTTP de l'instant).
    stored = portfolio_of(c)["portfolio"]["trades"][0]
    assert stored["mae_pct"] == -3.0 and stored["mfe_pct"] == 12.0


def test_a_market_sell_order_also_attaches_mae_mfe(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, qty=10, thesis="Une thèse suffisamment longue pour passer le seuil du coach")
    market.prices["NESN.SW"] = (108.0, "CHF", "Nestle SA")
    market.candles["NESN.SW"] = [{"high": 112.0, "low": 97.0}]

    body = buy(c, side="sell", qty=10)
    trade = body["fill"]["trade"]
    assert trade["mae_pct"] == -3.0 and trade["mfe_pct"] == 12.0


def test_tick_limit_sell_close_also_attaches_mae_mfe(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, qty=10, thesis="Une thèse suffisamment longue pour passer le seuil du coach")
    buy(c, side="sell", kind="limit", limit_price=110.0, qty=10)
    market.candles["NESN.SW"] = [
        {"ts": _ts(11), "open": 108.0, "high": 115.0, "low": 99.0, "close": 111.0}]

    result = c.post("/api/paper/tick").json()
    trade = result["fills"][0]["trade"]
    assert trade["mae_pct"] == -1.0
    assert trade["mfe_pct"] == 15.0


def test_tick_protective_stop_also_attaches_mae_mfe(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, qty=10, stop_loss=90.0, thesis="Cassure haussière, invalidation sous 90")
    market.candles["NESN.SW"] = [
        {"ts": _ts(11), "open": 95.0, "high": 96.0, "low": 88.0, "close": 89.0}]
    result = c.post("/api/paper/tick").json()
    trade = result["stopped"][0]["trade"]
    assert trade["mae_pct"] is not None and trade["mfe_pct"] is not None


def test_mae_mfe_asks_for_a_wider_candle_window_on_a_long_holding_period(tmp_path, monkeypatch):
    """B1 : ``range_for`` doit varier avec la durée de détention -- pas rester
    scotché à la fenêtre 1 jour/15 min que le TICK utilise pour lui-même."""
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, qty=10, thesis="Une thèse suffisamment longue pour passer le seuil du coach")
    raw = store.load_portfolio("tester")
    raw["positions"][0]["opened_at"] = "2026-01-01T09:00:00"     # ~236 jours avant FIXED_NOW
    store.save_portfolio("tester", raw)
    market.candles["NESN.SW"] = [{"high": 112.0, "low": 97.0}]

    c.post("/api/paper/positions/NESN.SW/close", json={})
    assert ("NESN.SW", "1y", "1d") in market.candle_calls


def test_close_position_never_fails_when_excursion_candles_are_unavailable(
        tmp_path, monkeypatch):
    """Best-effort (invariant 2 du module) : une panne SPÉCIFIQUE aux bougies
    d'excursion (le cours de clôture, lui, a bien été obtenu) ne doit jamais
    faire échouer la clôture — les champs restent simplement absents."""
    c, _ = make_client(tmp_path, monkeypatch)
    buy(c, thesis="Une thèse suffisamment longue pour passer le seuil du coach")

    def _boom(symbol, range_, interval):
        raise quotes.QuoteError("bougies indisponibles")
    monkeypatch.setattr(quotes, "get_candles", _boom)

    r = c.post("/api/paper/positions/NESN.SW/close", json={})
    assert r.status_code == 200
    trade = r.json()["fill"]["trade"]
    assert trade["mae_pct"] is None and trade["mfe_pct"] is None


def test_close_position_leaves_excursions_absent_on_empty_candles(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, thesis="Une thèse suffisamment longue pour passer le seuil du coach")
    # ``market.candles`` ne connaît pas NESN.SW -> get_candles rend [].
    r = c.post("/api/paper/positions/NESN.SW/close", json={})
    trade = r.json()["fill"]["trade"]
    assert trade["mae_pct"] is None and trade["mfe_pct"] is None
    assert trade["best_exit_gap_pct"] is None


# --- ``_attach_trade_extras``/``_holding_days`` en direct, sans HTTP -------

def _bare_trade(**kwargs):
    base = dict(symbol="NESN.SW", side="long", entry_price=100.0, exit_price=110.0,
               entry_at="2026-08-24T09:00:00", exit_at="2026-08-24T10:00:00",
               pnl_pct=5.0)
    base.update(kwargs)
    from backend.bots.paper import models as m
    return m.Trade(**base)


def test_holding_days_computes_the_delta_in_days():
    assert pr._holding_days("2026-01-01T00:00:00", "2026-01-03T12:00:00") == 2.5


def test_holding_days_is_none_on_unreadable_dates():
    assert pr._holding_days(None, "2026-01-01T00:00:00") is None
    assert pr._holding_days("2026-01-01T00:00:00", "n/a") is None


def test_attach_trade_extras_mutates_both_the_trade_object_and_the_fill_dict(monkeypatch):
    from backend.bots.paper import models as m
    trade = _bare_trade()
    portfolio = m.Portfolio(trades=[trade])
    fill = {"trade": trade.to_dict()}
    monkeypatch.setattr(quotes, "get_candles",
                        lambda symbol, range_, interval: [{"high": 112.0, "low": 97.0}])

    pr._attach_trade_extras(portfolio, fill)

    assert portfolio.trades[0].mae_pct == -3.0
    assert portfolio.trades[0].mfe_pct == 12.0
    assert portfolio.trades[0].best_exit_gap_pct == 7.0     # 12.0 - 5.0
    assert fill["trade"]["mae_pct"] == -3.0
    assert fill["trade"]["mfe_pct"] == 12.0
    assert fill["trade"]["best_exit_gap_pct"] == 7.0


def test_attach_trade_extras_is_a_noop_without_a_fill_or_a_trade():
    from backend.bots.paper import models as m
    portfolio = m.Portfolio(trades=[_bare_trade()])
    pr._attach_trade_extras(portfolio, None)                       # ne lève pas
    pr._attach_trade_extras(portfolio, {"trade": None})            # ne lève pas
    pr._attach_trade_extras(m.Portfolio(), {"trade": {"symbol": "X"}})  # pas de trades[]


def test_attach_trade_extras_swallows_any_exception_from_get_candles(monkeypatch):
    from backend.bots.paper import models as m
    trade = _bare_trade()
    portfolio = m.Portfolio(trades=[trade])
    fill = {"trade": trade.to_dict()}

    def _boom(symbol, range_, interval):
        raise RuntimeError("panne quelconque")
    monkeypatch.setattr(quotes, "get_candles", _boom)

    pr._attach_trade_extras(portfolio, fill)          # ne lève PAS
    assert portfolio.trades[0].mae_pct is None
    assert fill["trade"]["mae_pct"] is None


# --- Endpoints dérivés : /journal/setups, /journal/emotions, /discipline --

def test_journal_setups_endpoint_reflects_closed_trades(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, setup="breakout", thesis="Cassure nette du plus haut du mois sur fort volume")
    market.prices["NESN.SW"] = (110.0, "CHF", "Nestle SA")
    buy(c, side="sell", qty=10)

    rows = c.get("/api/paper/journal/setups").json()["rows"]
    assert len(rows) == 1
    assert rows[0]["setup"] == "breakout"
    assert rows[0]["n"] == 1
    assert rows[0]["winrate"] == 100.0
    assert rows[0]["total_pnl_chf"] > 0


def test_journal_emotions_endpoint_reflects_closed_trades(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, emotion="calme", thesis="Position posée sans urgence, plan clair et écrit")
    market.prices["NESN.SW"] = (110.0, "CHF", "Nestle SA")
    buy(c, side="sell", qty=10)

    rows = c.get("/api/paper/journal/emotions").json()["rows"]
    assert len(rows) == 1
    assert rows[0]["emotion"] == "calme"
    assert rows[0]["n"] == 1
    assert "total_pnl_chf" not in rows[0]           # B3 n'a pas ce champ (≠ B2)


def test_journal_endpoints_are_empty_on_a_fresh_account(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert c.get("/api/paper/journal/setups").json() == {"rows": []}
    assert c.get("/api/paper/journal/emotions").json() == {"rows": []}


def test_discipline_endpoint_is_honestly_none_under_five_trades(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert c.get("/api/paper/discipline").json() == {"score": None}


def test_discipline_endpoint_scores_five_disciplined_trades_perfectly(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    for _ in range(5):
        buy(c, qty=1, stop_loss=95.0,
           thesis="Une thèse écrite avant l'entrée, assez longue pour compter")
        market.prices["NESN.SW"] = (105.0, "CHF", "Nestle SA")
        buy(c, side="sell", qty=1)
        market.prices["NESN.SW"] = (100.0, "CHF", "Nestle SA")

    out = c.get("/api/paper/discipline").json()
    assert out["score"] == 100


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
#  JAUGE VIX (D3)
# ================================================================

def test_market_mood_returns_the_vix_reading(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    market.prices["^VIX"] = (17.2, "USD", "CBOE Volatility Index")
    body = c.get("/api/paper/market-mood").json()
    assert body == {"vix": 17.2, "change_pct": 1.5, "mood": "normal"}


def test_market_mood_empty_when_vix_unavailable(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    # ^VIX absent de market.prices -> Market.get_quote lève UnknownSymbol.
    assert c.get("/api/paper/market-mood").status_code == 200
    assert c.get("/api/paper/market-mood").json() == {}


def test_market_mood_is_cached_across_calls(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    market.prices["^VIX"] = (17.2, "USD", "VIX")
    first = c.get("/api/paper/market-mood").json()
    market.prices["^VIX"] = (40.0, "USD", "VIX")   # changerait le mood si relu
    second = c.get("/api/paper/market-mood").json()
    assert first == second == {"vix": 17.2, "change_pct": 1.5, "mood": "normal"}


def test_market_mood_role_gating_matches_the_rest_of_the_router(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch, role="player")
    assert c.get("/api/paper/market-mood").status_code == 403


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
    body = c.post("/api/paper/coach/ask?sync=1", json={"question": "je fais quoi ?"}).json()
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
    response = c.post("/api/paper/coach/ask?sync=1", json={})
    assert response.status_code == 502
    assert "120" in response.json()["detail"]


def test_coach_ask_persists_the_discussion_in_the_shared_vault(tmp_path, monkeypatch):
    """Discussions.md est un carnet PARTAGÉ (extension communauté) — distinct
    du Journal.md privé déjà couvert par test_coach_ask_answers_and_journals."""
    c, _ = make_client(tmp_path, monkeypatch)
    body = c.post("/api/paper/coach/ask?sync=1", json={"question": "je fais quoi ?"}).json()
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
    response = c.post("/api/paper/coach/ask?sync=1", json={"question": "je fais quoi ?"})
    assert response.status_code == 200
    assert response.json()["answer"] == "Ta taille est le sujet."


def test_postmortem_needs_a_closed_trade(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert c.post("/api/paper/postmortem?sync=1", json={}).status_code == 404


def test_postmortem_writes_the_journal_entry(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, qty=10, stop_loss=90.0, thesis="Cassure haussière, invalidation sous 90")
    market.prices["NESN.SW"] = (120.0, "CHF", "Nestle SA")
    buy(c, side="sell", qty=10)

    body = c.post("/api/paper/postmortem?sync=1", json={}).json()
    assert body["postmortem"] == "Post-mortem du trade."
    assert body["trade_index"] == 0

    markdown = c.get("/api/paper/coach/notes/Journal.md").json()["markdown"]
    assert "NESN.SW +2.00R" in markdown          # le R multiple titre l'entrée


def test_postmortem_rejects_an_out_of_range_index(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, qty=10, thesis="Thèse suffisamment longue pour passer le seuil")
    market.prices["NESN.SW"] = (120.0, "CHF", "Nestle SA")
    buy(c, side="sell", qty=10)
    assert c.post("/api/paper/postmortem?sync=1", json={"trade_index": 7}).status_code == 404


def test_postmortem_502_when_the_llm_fails(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, qty=10, thesis="Thèse suffisamment longue pour passer le seuil")
    market.prices["NESN.SW"] = (120.0, "CHF", "Nestle SA")
    buy(c, side="sell", qty=10)

    def boom(trade, context, lang="fr"):
        raise RuntimeError("claude cli rc=2")

    monkeypatch.setattr(pr.llm, "write_postmortem", boom)
    assert c.post("/api/paper/postmortem?sync=1", json={}).status_code == 502


# ================================================================
#  LOT 3, C1 — post-mortem AUTOMATIQUE à chaque clôture
# ================================================================

def test_closing_via_a_market_sell_auto_triggers_a_postmortem_job(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, qty=10, stop_loss=90.0, thesis="Cassure haussière, invalidation sous 90")
    market.prices["NESN.SW"] = (120.0, "CHF", "Nestle SA")
    body = buy(c, side="sell", qty=10)

    job = body["fill"]["postmortem_job"]
    assert isinstance(job, str) and len(job) == 32

    done = _await_job(c, job)
    assert done["status"] == "done"
    assert done["result"]["postmortem"] == "Post-mortem du trade."

    markdown = c.get("/api/paper/coach/notes/Journal.md").json()["markdown"]
    assert "Post-mortem du trade." in markdown


def test_closing_via_the_close_endpoint_auto_triggers_a_postmortem_job(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, qty=10, thesis="Thèse suffisamment longue pour passer le seuil")
    market.prices["NESN.SW"] = (120.0, "CHF", "Nestle SA")
    r = c.post("/api/paper/positions/NESN.SW/close", json={})
    assert r.status_code == 200
    job = r.json()["fill"]["postmortem_job"]
    assert isinstance(job, str) and len(job) == 32
    assert _await_job(c, job)["status"] == "done"


def test_a_stop_fill_in_the_tick_also_auto_triggers_a_postmortem(tmp_path, monkeypatch):
    """Le fill MÉCANIQUE (stop de protection qui saute dans /tick) déclenche
    lui aussi le job -- c'est justement le cas où personne n'est là pour
    cliquer le bouton manuel."""
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, qty=10, stop_loss=95.0, thesis="Thèse suffisamment longue pour passer")
    market.candles["NESN.SW"] = [
        {"ts": _ts(11), "open": 100.0, "high": 100.0, "low": 90.0, "close": 92.0},
    ]
    result = c.post("/api/paper/tick").json()
    assert len(result["stopped"]) == 1
    job = result["stopped"][0]["postmortem_job"]
    assert isinstance(job, str) and len(job) == 32
    assert _await_job(c, job)["status"] == "done"
    markdown = c.get("/api/paper/coach/notes/Journal.md").json()["markdown"]
    assert "Post-mortem du trade." in markdown


def test_a_market_buy_that_does_not_close_anything_gets_no_postmortem_job(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    body = buy(c, qty=10, thesis="Thèse suffisamment longue pour passer le seuil")
    assert "postmortem_job" not in body["fill"]


def test_queuing_a_limit_order_gets_no_postmortem_job(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    body = buy(c, kind="limit", limit_price=90.0,
              thesis="Thèse suffisamment longue pour passer le seuil")
    assert body["fill"] is None


def test_the_auto_postmortem_rafale_gate_caps_at_six_per_account_per_day(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    jobs = []
    for _ in range(7):
        buy(c, qty=1, thesis="Thèse suffisamment longue pour passer le seuil")
        body = buy(c, side="sell", qty=1)
        job = body["fill"]["postmortem_job"]
        jobs.append(job)
        if job:
            _await_job(c, job)     # vide la file avant le tour suivant

    assert jobs[:6] == [j for j in jobs[:6] if isinstance(j, str)]
    assert len(jobs[:6]) == 6 and all(jobs[:6])
    assert jobs[6] is None     # la 7e clôture du jour est au-delà du plafond


def test_the_auto_postmortem_rafale_gate_resets_the_next_day(tmp_path, monkeypatch):
    """Le plafond est PAR JOUR (``_now_iso()[:10]``) : la veille au plafond ne
    doit pas priver le compte du jour suivant."""
    c, market = make_client(tmp_path, monkeypatch)
    store.save_postmortem_auto("tester", {"date": "2026-08-23", "count": 6})
    buy(c, qty=1, thesis="Thèse suffisamment longue pour passer le seuil")
    body = buy(c, side="sell", qty=1)
    job = body["fill"]["postmortem_job"]
    assert isinstance(job, str) and len(job) == 32


def test_auto_postmortem_never_blocks_the_close_when_the_job_queue_is_full(tmp_path, monkeypatch):
    """Best-effort TOTAL (invariant C1) : même quand _start_job refuserait
    (429, file de travaux pleine), la clôture elle-même doit réussir."""
    c, market = make_client(tmp_path, monkeypatch)
    release = threading.Event()

    def slow(facts, lang="fr"):
        release.wait(5)
        return "Fiche du titre."
    monkeypatch.setattr(pr.llm, "write_analysis", slow)

    for _ in range(pr.MAX_PENDING_JOBS_PER_USER):
        r = c.post("/api/paper/analysis", json={"symbol": "NESN.SW"})
        assert r.status_code == 200, r.text

    buy(c, qty=10, thesis="Thèse suffisamment longue pour passer le seuil")
    market.prices["NESN.SW"] = (120.0, "CHF", "Nestle SA")
    body = buy(c, side="sell", qty=10)
    assert body["fill"]["trade"] is not None       # la clôture a bien eu lieu
    assert body["fill"]["postmortem_job"] is None  # mais pas de job (file pleine)

    release.set()


def test_analysis_returns_facts_and_text(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    body = c.post("/api/paper/analysis?sync=1", json={"symbol": "nesn.sw"}).json()
    assert body["facts"]["trend"] == "haussier"
    assert body["analysis"] == "Fiche du titre."


def test_analysis_guards(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert c.post("/api/paper/analysis?sync=1", json={"symbol": ""}).status_code == 400
    assert c.post("/api/paper/analysis?sync=1", json={"symbol": "ZZZZ"}).status_code == 404

    def boom(facts, lang="fr"):
        raise RuntimeError("claude introuvable")

    monkeypatch.setattr(pr.llm, "write_analysis", boom)
    assert c.post("/api/paper/analysis?sync=1", json={"symbol": "NESN.SW"}).status_code == 502


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

def _real_trader(username, note="## une note\n"):
    """Un VRAI compte : un carnet ET une preuve d'existence (un portefeuille).

    Depuis le correctif du 26/08, un carnet seul ne suffit plus à figurer dans
    la communauté — c'est par des carnets écrits à tort que les utilisateurs
    fantômes « newswatch_global » et « whales_watch » y étaient apparus.
    """
    store.save_portfolio(username, pr.new_portfolio().to_dict())
    store.append_note(username, "Journal.md", note)


def test_community_lists_vaults_and_reads_another_traders_note(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    _real_trader("alice", "## note d'alice\n")
    _real_trader("bob", "## note de bob\n")

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
    _real_trader("alice", "## note d'alice\n")
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
        lambda context, lang="fr", risk_level="mesure", journal=None: _ideas_json(
            {"ticker": "aapl", "direction": "up", "horizon_days": 10,
             "thesis": "Momentum"},
            {"ticker": "tsla", "direction": "down", "horizon_days": 5,
             "thesis": "Retournement"},
        ))
    body = c.post("/api/paper/ideas?sync=1", json={}).json()
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
        lambda context, lang="fr", risk_level="mesure", journal=None: _ideas_json(
            {"ticker": "AAPL", "direction": "up", "horizon_days": 10,
             "thesis": "Momentum"}))
    body = c.post("/api/paper/ideas?sync=1", json={}).json()
    assert body["ideas"] == [{"ticker": "AAPL", "direction": "up",
                             "horizon_days": 10, "thesis": "Momentum",
                             "risk_level": "mesure", "asset_kind": "equity",
                             "stop": None, "risk_pct": None,
                             "invalidated_if": None, "why_now": None,
                             "tracked": False}]
    assert len(radar.load_state()["hypotheses"]) == radar.MAX_OPEN


# ----------------------------------------------------------------
#  Conseil structuré (stop / risk_pct / invalidated_if / why_now)
# ----------------------------------------------------------------

def test_parse_ideas_json_carries_the_structured_advice_fields():
    text = _ideas_json({"ticker": "AAPL", "direction": "up", "horizon_days": 10,
                        "thesis": "Momentum", "stop": "195 ou -5 %",
                        "risk_pct": 1.2, "invalidated_if": "clôture sous 195",
                        "why_now": "résultats trimestriels demain"})
    idea = pr._parse_ideas_json(text)[0]
    assert idea["stop"] == "195 ou -5 %"
    assert idea["risk_pct"] == 1.2
    assert idea["invalidated_if"] == "clôture sous 195"
    assert idea["why_now"] == "résultats trimestriels demain"


def test_parse_ideas_json_defaults_the_advice_fields_to_none_when_absent():
    """Rétro-compat : une réponse d'AVANT l'enrichissement du schéma (ou un
    modèle qui oublie les champs) ne doit pas faire tomber le parseur."""
    text = _ideas_json({"ticker": "AAPL", "direction": "up", "horizon_days": 10,
                        "thesis": "Momentum"})
    idea = pr._parse_ideas_json(text)[0]
    assert idea["stop"] is None
    assert idea["risk_pct"] is None
    assert idea["invalidated_if"] is None
    assert idea["why_now"] is None


def test_parse_ideas_json_tolerates_a_non_numeric_risk_pct():
    text = _ideas_json({"ticker": "AAPL", "direction": "up", "horizon_days": 10,
                        "thesis": "Momentum", "risk_pct": "environ 1 %"})
    assert pr._parse_ideas_json(text)[0]["risk_pct"] is None


def test_parse_ideas_json_treats_blank_advice_strings_as_absent():
    text = _ideas_json({"ticker": "AAPL", "direction": "up", "horizon_days": 10,
                        "thesis": "Momentum", "stop": "   ",
                        "invalidated_if": "", "why_now": None})
    idea = pr._parse_ideas_json(text)[0]
    assert idea["stop"] is None
    assert idea["invalidated_if"] is None
    assert idea["why_now"] is None


def test_ideas_without_a_json_block_still_returns_the_text(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    monkeypatch.setattr(pr.llm, "suggest_ideas",
                        lambda context, lang="fr", risk_level="mesure", journal=None:
                        "Contexte trop maigre, je ne peux rien proposer.")
    body = c.post("/api/paper/ideas?sync=1", json={}).json()
    assert body["text"] == "Contexte trop maigre, je ne peux rien proposer."
    assert body["ideas"] == []


def test_ideas_returns_502_when_the_llm_fails(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)

    def boom(context, lang="fr", risk_level="mesure", journal=None):
        raise RuntimeError("le coach n'a pas répondu dans les 120 s")

    monkeypatch.setattr(pr.llm, "suggest_ideas", boom)
    response = c.post("/api/paper/ideas?sync=1", json={})
    assert response.status_code == 502


def test_ideas_context_includes_the_watchlist(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    store.save_watchlist("tester", [{"symbol": "TSLA", "name": "Tesla Inc",
                                     "currency": "USD", "added_at": FIXED_NOW}])
    seen = {}

    def fake_suggest(context, lang="fr", risk_level="mesure", journal=None):
        seen["context"] = context
        return _ideas_json()

    monkeypatch.setattr(pr.llm, "suggest_ideas", fake_suggest)
    c.post("/api/paper/ideas?sync=1", json={})
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

    def fake(context, lang="fr", risk_level="mesure", journal=None):
        seen["lang"] = lang
        seen["risk_level"] = risk_level
        seen["journal"] = journal
        seen["context"] = context
        return _ideas_json(*rows)

    monkeypatch.setattr(pr.llm, "suggest_ideas", fake)
    return seen


def test_ideas_defaults_to_the_measured_level(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    seen = _ideas_double(monkeypatch)
    assert c.post("/api/paper/ideas?sync=1", json={}).json()["risk_level"] == "mesure"
    assert seen["risk_level"] == "mesure"


def test_ideas_forwards_the_requested_level_to_the_coach(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    seen = _ideas_double(monkeypatch)
    body = c.post("/api/paper/ideas?sync=1", json={"risk_level": "spéculatif"}).json()
    assert seen["risk_level"] == "speculatif"
    # la réponse dit l'étage RÉELLEMENT appliqué, pas celui qu'on croit avoir
    # demandé (l'accent a été normalisé en chemin)
    assert body["risk_level"] == "speculatif"


def test_an_unknown_level_falls_back_to_measured(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    seen = _ideas_double(monkeypatch)
    body = c.post("/api/paper/ideas?sync=1", json={"risk_level": "yolo"}).json()
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
    body = c.post("/api/paper/ideas?sync=1", json={"risk_level": "speculatif"}).json()
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
    c.post("/api/paper/ideas?sync=1", json={"risk_level": "speculatif"})

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
    body = c.post("/api/paper/ideas?sync=1", json={"risk_level": "mesure"}).json()
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
    ideas = c.post("/api/paper/ideas?sync=1", json={"risk_level": "speculatif"}).json()["ideas"]
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
    body = c.post("/api/paper/ideas?sync=1", json={"risk_level": "agressif"}).json()
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
    c.post("/api/paper/coach/ask?sync=1", json={"question": "?"})
    assert seen["context"]["watchlist"][0]["symbol"] == "TSLA"


# ================================================================
#  ALIAS DE SYMBOLE (ROG.SW n'existe pas chez Yahoo, RO.SW oui)
#
# ``quotes.canonical`` est appliqué à l'ENTRÉE de chaque endpoint qui reçoit un
# symbole brut de l'utilisateur : la position/ligne de suivi est stockée sous
# le symbole CANONIQUE, jamais sous l'alias tapé.
# ================================================================

def test_order_with_a_known_alias_stores_the_canonical_symbol(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    market.prices["RO.SW"] = (280.0, "CHF", "Roche Holding AG")
    body = buy(c, symbol="ROG.SW",
              thesis="Thèse suffisamment longue pour passer le seuil")
    assert body["order"]["symbol"] == "RO.SW"
    positions = portfolio_of(c)["portfolio"]["positions"]
    assert positions[0]["symbol"] == "RO.SW"


def test_candles_redirects_a_known_alias_to_its_canonical_symbol(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    market.candles["RO.SW"] = [{"ts": _ts(9), "close": 280.0}]
    body = c.get("/api/paper/candles?symbol=rog.sw").json()
    assert body["symbol"] == "RO.SW"
    assert market.candle_calls == [("RO.SW", "6mo", "1d")]


def test_analysis_redirects_a_known_alias_to_its_canonical_symbol(tmp_path, monkeypatch):
    """``market.fiche_facts`` 404 sur tout ce qui n'est pas dans ``prices`` :
    un 200 ici prouve que ``quotes.fiche_facts`` a bien été appelé avec
    ``RO.SW``, pas avec l'alias tapé."""
    c, market = make_client(tmp_path, monkeypatch)
    market.prices["RO.SW"] = (280.0, "CHF", "Roche Holding AG")
    body = c.post("/api/paper/analysis?sync=1", json={"symbol": "ROG.SW"}).json()
    assert body["facts"]["trend"] == "haussier"


def test_watchlist_add_with_a_known_alias_stores_the_canonical_symbol(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    market.prices["RO.SW"] = (280.0, "CHF", "Roche Holding AG")
    body = c.post("/api/paper/watchlist", json={"symbol": "ROG.SW"}).json()
    assert body["symbols"] == [{"symbol": "RO.SW", "name": "Roche Holding AG",
                                "currency": "CHF", "added_at": FIXED_NOW}]


def test_watchlist_remove_accepts_the_alias_of_a_canonical_entry(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    market.prices["RO.SW"] = (280.0, "CHF", "Roche Holding AG")
    c.post("/api/paper/watchlist", json={"symbol": "ROG.SW"})
    removed = c.delete("/api/paper/watchlist/rog.sw")
    assert removed.status_code == 200
    assert removed.json()["symbols"] == []


def test_close_position_accepts_the_alias_of_a_canonical_position(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    market.prices["RO.SW"] = (280.0, "CHF", "Roche Holding AG")
    buy(c, symbol="ROG.SW", thesis="Thèse suffisamment longue pour passer le seuil")
    response = c.post("/api/paper/positions/rog.sw/close", json={})
    assert response.status_code == 200, response.text
    assert portfolio_of(c)["portfolio"]["positions"] == []


def test_quotes_endpoint_redirects_a_known_alias(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    market.prices["RO.SW"] = (280.0, "CHF", "Roche Holding AG")
    body = c.get("/api/paper/quotes?symbols=ROG.SW").json()
    assert "RO.SW" in body and body["RO.SW"]["price"] == 280.0
    assert "ROG.SW" not in body


def test_search_redirects_a_known_alias_to_its_canonical_symbol(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    market.results = [{"symbol": "RO.SW", "name": "Roche Holding AG",
                       "exchange": "Swiss", "currency": "CHF"}]
    body = c.get("/api/paper/search?q=ROG.SW").json()
    assert market.search_calls == ["RO.SW"]
    assert body == market.results


def test_search_without_an_alias_match_is_unchanged(tmp_path, monkeypatch):
    """Yahoo rend 0 résultat et aucun alias ne matche -> requête inchangée
    (recherche par NOM, ex. « nestle », qui n'est pas un symbole)."""
    c, market = make_client(tmp_path, monkeypatch)
    market.results = []
    c.get("/api/paper/search?q=nestle")
    assert market.search_calls == ["nestle"]


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
#  ALERTES DE PRIX (A1)
# ================================================================

def test_alerts_create_list_delete_roundtrip(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert c.get("/api/paper/alerts").json() == {"alerts": []}

    created = c.post("/api/paper/alerts",
                     json={"symbol": "nesn.sw", "op": "above", "price": 150})
    assert created.status_code == 200, created.text
    alert = created.json()["alert"]
    assert alert["symbol"] == "NESN.SW"
    assert alert["op"] == "above"
    assert alert["price"] == 150
    assert alert["status"] == "armed"
    assert alert["triggered_at"] is None
    assert isinstance(alert["id"], str) and alert["id"]

    listed = c.get("/api/paper/alerts").json()["alerts"]
    assert listed == [alert]

    deleted = c.delete("/api/paper/alerts/%s" % alert["id"])
    assert deleted.status_code == 200
    assert deleted.json()["alerts"] == []
    assert c.get("/api/paper/alerts").json() == {"alerts": []}


def test_alerts_create_uses_canonical_symbol(tmp_path, monkeypatch):
    """Un alias connu (ROG.SW -> RO.SW) est stocké sous le symbole
    CANONIQUE — symétrique de la watchlist."""
    c, market = make_client(tmp_path, monkeypatch)
    market.prices["RO.SW"] = (50.0, "CHF", "Roche")
    body = c.post("/api/paper/alerts",
                  json={"symbol": "ROG.SW", "op": "below", "price": 40}).json()
    assert body["alert"]["symbol"] == "RO.SW"


def test_alerts_reject_empty_symbol(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    r = c.post("/api/paper/alerts", json={"symbol": "  ", "op": "above", "price": 10})
    assert r.status_code == 400


def test_alerts_reject_invalid_op(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    r = c.post("/api/paper/alerts",
               json={"symbol": "NESN.SW", "op": "sideways", "price": 10})
    assert r.status_code == 400


def test_alerts_reject_non_positive_price(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    for bad_price in (0, -5):
        r = c.post("/api/paper/alerts",
                   json={"symbol": "NESN.SW", "op": "above", "price": bad_price})
        assert r.status_code == 400


def test_alerts_reject_condition_already_true_above(tmp_path, monkeypatch):
    """NESN.SW cote 100.0 dans le faux marché -- une alerte "au-dessus de 90"
    tirerait à la seconde où on la pose."""
    c, _ = make_client(tmp_path, monkeypatch)
    r = c.post("/api/paper/alerts",
               json={"symbol": "NESN.SW", "op": "above", "price": 90})
    assert r.status_code == 400
    assert c.get("/api/paper/alerts").json() == {"alerts": []}   # rien n'a été posé


def test_alerts_reject_condition_already_true_below(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    r = c.post("/api/paper/alerts",
               json={"symbol": "NESN.SW", "op": "below", "price": 110})
    assert r.status_code == 400


def test_alerts_accept_condition_not_yet_true(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    above = c.post("/api/paper/alerts",
                   json={"symbol": "NESN.SW", "op": "above", "price": 150})
    assert above.status_code == 200
    below = c.post("/api/paper/alerts",
                   json={"symbol": "NESN.SW", "op": "below", "price": 50})
    assert below.status_code == 200


def test_alerts_armed_even_when_quote_unavailable(tmp_path, monkeypatch):
    """Cours introuvable -> on arme quand même (best-effort) : mieux vaut une
    alerte posée que pas d'alerte du tout parce que Yahoo hoquette."""
    c, market = make_client(tmp_path, monkeypatch)
    market.broken.add("UNKNOWNQ")   # get_quote lève QuoteError pour ce symbole
    r = c.post("/api/paper/alerts",
              json={"symbol": "UNKNOWNQ", "op": "above", "price": 5})
    assert r.status_code == 200, r.text
    assert r.json()["alert"]["status"] == "armed"


def test_alerts_cap_at_the_maximum(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    for i in range(pr.MAX_ALERTS):
        symbol = "SYM%d" % i
        market.prices[symbol] = (10.0, "CHF", "Titre %d" % i)
        r = c.post("/api/paper/alerts",
                  json={"symbol": symbol, "op": "above", "price": 999})
        assert r.status_code == 200, r.text
    r = c.post("/api/paper/alerts",
              json={"symbol": "NESN.SW", "op": "above", "price": 999})
    assert r.status_code == 400


def test_alerts_delete_unknown_is_404(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert c.delete("/api/paper/alerts/doesnotexist").status_code == 404


def test_alerts_are_isolated_per_user(tmp_path, monkeypatch):
    c1, _ = make_client(tmp_path, monkeypatch)
    c1.post("/api/paper/alerts", json={"symbol": "NESN.SW", "op": "above", "price": 999})

    app2 = FastAPI()
    app2.include_router(pr.router)
    from backend.auth.utils import get_current_user as _gcu
    app2.dependency_overrides[_gcu] = lambda: FakeUser("admin", username="bob")
    c2 = TestClient(app2)
    assert c2.get("/api/paper/alerts").json() == {"alerts": []}


def test_alerts_role_gating_matches_watchlist(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch, role="player")
    assert c.get("/api/paper/alerts").status_code == 403
    assert c.post("/api/paper/alerts", json={"symbol": "X"}).status_code == 403
    assert c.delete("/api/paper/alerts/x").status_code == 403


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
#  LOT 3, A3 — le « bar replay » (entraînement)
# ================================================================

class _FixedReplayRng(object):
    """Source d'aléa injectée : ``choice`` pioche dans une file (le premier
    symbole tenté, puis le suivant si le test veut simuler un échec), et
    ``randint`` rend toujours le même décalage de départ."""
    def __init__(self, choices, start=0):
        self._choices = list(choices)
        self.start = start
        self.choice_calls = []
        self.randint_calls = []

    def choice(self, seq):
        self.choice_calls.append(list(seq))
        return self._choices.pop(0)

    def randint(self, a, b):
        self.randint_calls.append((a, b))
        return self.start


def _90_candles(base=100.0):
    return [{"ts": i, "open": base + i, "high": base + i + 1, "low": base + i - 1,
            "close": base + i, "volume": 10} for i in range(90)]


def test_replay_window_is_closed_to_the_player_role(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch, role="player")
    assert c.get("/api/paper/replay/window").status_code == 403


def test_replay_window_returns_60_visible_and_20_reveal_from_a_real_symbol(
        tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    market.candles["NVDA"] = _90_candles()
    monkeypatch.setattr(pr, "_new_rng", lambda: _FixedReplayRng(["NVDA"]))

    body = c.get("/api/paper/replay/window").json()
    assert len(body["id"]) == 32
    assert len(body["candles"]) == 60
    assert len(body["reveal"]["candles"]) == 20
    assert body["reveal"]["symbol"] == "NVDA"
    assert body["reveal"]["period"] == pr.REPLAY_INTERVAL
    assert ("NVDA", pr.REPLAY_RANGE, pr.REPLAY_INTERVAL) in market.candle_calls


def test_replay_window_retries_on_a_symbol_with_too_few_candles(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    market.candles["NVDA"] = []            # pas assez de bougies -> ValueError
    market.candles["AAPL"] = _90_candles()
    monkeypatch.setattr(pr, "_new_rng", lambda: _FixedReplayRng(["NVDA", "AAPL"]))

    body = c.get("/api/paper/replay/window").json()
    assert body["reveal"]["symbol"] == "AAPL"


def test_replay_window_retries_on_an_unknown_symbol(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    market.unknown.add("NVDA")
    market.candles["AAPL"] = _90_candles()
    monkeypatch.setattr(pr, "_new_rng", lambda: _FixedReplayRng(["NVDA", "AAPL"]))

    body = c.get("/api/paper/replay/window").json()
    assert body["reveal"]["symbol"] == "AAPL"


def test_replay_window_503_after_three_failed_attempts(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    monkeypatch.setattr(pr, "_new_rng",
                        lambda: _FixedReplayRng(["NVDA", "AAPL", "MSFT"]))
    r = c.get("/api/paper/replay/window")
    assert r.status_code == 503


def test_replay_log_grades_the_session_server_side(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    body = c.post("/api/paper/replay/log", json={
        "id": "a" * 32,
        "decisions": [
            {"prev_close": 100.0, "close": 110.0, "action": "buy"},
            {"prev_close": 110.0, "close": 121.0, "action": "buy"},
        ],
    }).json()
    assert body["session"]["pnl_pct"] == 20.0
    assert body["session"]["hold_pnl_pct"] == 21.0
    assert body["session"]["n_decisions"] == 2
    assert body["session"]["id"] == "a" * 32


def test_replay_log_ignores_a_client_submitted_pnl_and_recomputes(tmp_path, monkeypatch):
    """Un seul calcul fait foi (cf. ``ReplayLogPayload``) : le serveur ignore
    ce que le client prétend et rejoue lui-même les décisions."""
    c, _ = make_client(tmp_path, monkeypatch)
    body = c.post("/api/paper/replay/log", json={
        "id": "b" * 32, "pnl_pct": 999.0, "hold_pnl_pct": -999.0,
        "decisions": [{"prev_close": 100.0, "close": 105.0, "action": "buy"}],
    }).json()
    assert body["session"]["pnl_pct"] == 5.0
    assert body["session"]["hold_pnl_pct"] == 5.0


def test_replay_log_is_readable_afterwards_via_stats(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    c.post("/api/paper/replay/log", json={
        "id": "a" * 32,
        "decisions": [{"prev_close": 100.0, "close": 110.0, "action": "buy"}]})
    c.post("/api/paper/replay/log", json={
        "id": "b" * 32,
        "decisions": [{"prev_close": 100.0, "close": 95.0, "action": "buy"}]})

    stats = c.get("/api/paper/replay/stats").json()
    assert stats["n"] == 2
    assert stats["avg_pnl_pct"] == round((10.0 - 5.0) / 2, 2)
    assert stats["beat_hold_pct"] == 0.0   # pnl == hold sur les 2 (pas de short)


def test_replay_stats_empty_journal(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert c.get("/api/paper/replay/stats").json() == {
        "n": 0, "avg_pnl_pct": None, "avg_hold_pnl_pct": None, "beat_hold_pct": None}


def test_replay_log_caps_at_the_max_and_keeps_the_most_recent(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    old = [{"id": "old-%d" % i, "ts": "2020-01-01T00:00:00", "pnl_pct": 0.0,
           "hold_pnl_pct": 0.0, "n_decisions": 1}
          for i in range(pr.replay.MAX_REPLAY_SESSIONS)]
    store.save_replay_sessions("tester", old)

    c.post("/api/paper/replay/log", json={
        "id": "f" * 32,
        "decisions": [{"prev_close": 100.0, "close": 110.0, "action": "buy"}]})

    sessions = store.load_replay_sessions("tester")
    assert len(sessions) == pr.replay.MAX_REPLAY_SESSIONS
    assert sessions[0]["pnl_pct"] == 10.0          # la plus récente en tête
    assert "old-%d" % (pr.replay.MAX_REPLAY_SESSIONS - 1) not in [s["id"] for s in sessions]


def test_replay_sessions_are_isolated_per_account(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    c.post("/api/paper/replay/log", json={
        "id": "a" * 32,
        "decisions": [{"prev_close": 100.0, "close": 110.0, "action": "buy"}]})
    assert store.load_replay_sessions("bob") == []


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


def test_news_endpoint_carries_cached_translations(tmp_path, monkeypatch):
    """Le panneau Actualites affiche les memes titres que la toile — il recoit
    donc le meme enrichissement (title_fr/src_lang), l'original intact."""
    from backend.bots.paper import translate
    c, _ = make_client(tmp_path, monkeypatch)
    german_title = "Naechster Nackenschlag fuer Nestle: Zuercher Bank straft ab"
    events = [{"ts": 1, "symbol": "NESN.SW", "title": german_title,
               "link": "http://nzz.test/2", "sentiment": "neg"},
              {"ts": 2, "symbol": "AAPL", "title": "Results beat", "link": "http://y",
               "sentiment": "pos"}]
    monkeypatch.setattr(pr, "_newswatch",
                        lambda: FakeModule(recent_events=lambda user: events))
    translate.save_cache({"last_sweep_ts": None, "entries": {
        translate._title_key(german_title): {
            "fr": "Nouveau coup dur pour Nestle : une banque zurichoise sanctionne",
            "src": "de", "ts": 1}}})

    body = c.get("/api/paper/news").json()
    de, en = body["events"][0], body["events"][1]
    assert de["title_fr"] == ("Nouveau coup dur pour Nestle : une banque "
                              "zurichoise sanctionne")
    assert de["src_lang"] == "DE"
    assert de["title"] == german_title            # l'original ne bouge JAMAIS
    assert "title_fr" not in en


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
                        lambda context, lang="fr", risk_level="mesure", journal=None:
                        seen.__setitem__("ideas", lang) or '```json\n{"ideas": []}\n```')

    c.post("/api/paper/coach/ask?sync=1", json={"question": "?", "lang": "it"})
    c.post("/api/paper/postmortem?sync=1", json={"lang": "it"})
    c.post("/api/paper/analysis?sync=1", json={"symbol": "NESN.SW", "lang": "it"})
    c.post("/api/paper/ideas?sync=1", json={"lang": "it"})
    assert seen == {"ask": "it", "postmortem": "it", "analysis": "it", "ideas": "it"}

    c.post("/api/paper/coach/ask?sync=1", json={"question": "?"})
    c.post("/api/paper/analysis?sync=1", json={"symbol": "NESN.SW", "lang": "klingon"})
    assert seen["ask"] == "fr" and seen["analysis"] == "fr"


# ================================================================
#  VUE « PLAN » — pipeline, progression, arbres de scénarios
# ================================================================

def add_item(client, symbol="NESN.SW", thesis="À creuser"):
    return client.post("/api/paper/board/pipeline",
                       json={"symbol": symbol, "thesis": thesis})


def test_board_of_a_fresh_account_is_readable(tmp_path, monkeypatch):
    """Un compte neuf rend un tableau vide et LISIBLE, jamais un 500."""
    c, _ = make_client(tmp_path, monkeypatch)
    body = c.get("/api/paper/board").json()
    assert body["pipeline"] == []
    assert body["scenarios"] == []
    assert body["learning"]["lessons"] == {"passed": 0, "total": 8}
    assert body["learning"]["arena"] == {"accepted": 0, "done": 0}
    assert body["learning"]["n_trades"] == 0


def test_board_learning_counts_the_real_catalogue(tmp_path, monkeypatch):
    """``total`` vient du catalogue servi, pas d'un 8 codé en dur qui mentirait
    le jour où une 9e leçon arrive."""
    c, _ = make_client(tmp_path, monkeypatch)
    body = c.get("/api/paper/board").json()
    assert body["learning"]["lessons"]["total"] == len(pr.lessons_catalog())


def test_pipeline_add_validates_the_symbol(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert add_item(c, "N-EXISTE-PAS").status_code == 404
    assert add_item(c, "   ").status_code == 400


def test_pipeline_add_reads_the_name_from_the_quote(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    body = add_item(c).json()
    assert body["item"]["symbol"] == "NESN.SW"
    assert body["item"]["name"] == "Nestle SA"
    assert body["item"]["source"] == "moi"
    assert body["item"]["computed_stage"] == "etude"
    assert body["item"]["duplicate"] is False
    assert len(body["pipeline"]) == 1


def test_pipeline_add_with_a_known_alias_stores_the_canonical_symbol(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    market.prices["RO.SW"] = (280.0, "CHF", "Roche Holding AG")
    body = add_item(c, symbol="ROG.SW").json()
    assert body["item"]["symbol"] == "RO.SW"


def test_pipeline_add_is_idempotent_on_an_active_symbol(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    add_item(c)
    again = add_item(c, thesis="autre thèse").json()
    assert again["item"]["duplicate"] is True
    assert len(again["pipeline"]) == 1


def test_the_stage_follows_the_portfolio_not_the_declaration(tmp_path, monkeypatch):
    """LE point du tableau : acheter le titre change son étape TOUT SEUL, sans
    que personne n'ait rien déclaré."""
    c, _ = make_client(tmp_path, monkeypatch)
    item_id = add_item(c).json()["item"]["id"]
    buy(c, qty=5, thesis="Thèse suffisamment longue pour passer le seuil")

    row = c.get("/api/paper/board").json()["pipeline"][0]
    assert row["id"] == item_id
    assert row["computed_stage"] == "position"

    # …et refermer la position la fait passer à « clos », avec son R.
    c.post("/api/paper/positions/NESN.SW/close", json={})
    row = c.get("/api/paper/board").json()["pipeline"][0]
    assert row["computed_stage"] == "clos"
    assert "last_r" in row


def test_a_pending_order_shows_as_ordre(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    add_item(c)
    assert order(c, kind="limit", limit_price=90.0, qty=3).status_code == 200
    row = c.get("/api/paper/board").json()["pipeline"][0]
    assert row["computed_stage"] == "ordre"


def test_pipeline_stage_endpoint(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    item_id = add_item(c).json()["item"]["id"]

    body = c.post("/api/paper/board/pipeline/%s" % item_id,
                  json={"stage_manual": "pret"})
    assert body.status_code == 200
    assert body.json()["item"]["computed_stage"] == "pret"

    # une étape DÉRIVÉE ne se déclare pas
    assert c.post("/api/paper/board/pipeline/%s" % item_id,
                  json={"stage_manual": "position"}).status_code == 400
    assert c.post("/api/paper/board/pipeline/inconnu",
                  json={"stage_manual": "pret"}).status_code == 404


def test_pipeline_delete(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    item_id = add_item(c).json()["item"]["id"]
    body = c.delete("/api/paper/board/pipeline/%s" % item_id)
    assert body.status_code == 200
    assert body.json()["pipeline"] == []
    assert c.delete("/api/paper/board/pipeline/%s" % item_id).status_code == 404


def test_ideas_land_in_the_pipeline(tmp_path, monkeypatch):
    """« Le coach pourra utiliser aussi cet outil » : ses idées SUIVIES
    atterrissent dans la file de travail, pas seulement dans une réponse
    qu'on ferme."""
    c, _ = make_client(tmp_path, monkeypatch)
    monkeypatch.setattr(
        pr.llm, "suggest_ideas",
        lambda context, lang="fr", risk_level="mesure", journal=None: _ideas_json(
            {"ticker": "aapl", "direction": "up", "horizon_days": 10,
             "thesis": "Momentum"},
        ))
    assert c.post("/api/paper/ideas?sync=1", json={}).status_code == 200

    pipeline = c.get("/api/paper/board").json()["pipeline"]
    assert [row["symbol"] for row in pipeline] == ["AAPL"]
    assert pipeline[0]["source"] == "coach"
    assert pipeline[0]["thesis"] == "Momentum"

    # relancer le coach ne duplique pas la ligne
    c.post("/api/paper/ideas?sync=1", json={})
    assert len(c.get("/api/paper/board").json()["pipeline"]) == 1


def test_an_untracked_idea_never_lands_in_the_pipeline(tmp_path, monkeypatch):
    """Une idée refusée par la file du radar n'est suivie NULLE PART : l'écrire
    au tableau ferait croire le contraire."""
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
        lambda context, lang="fr", risk_level="mesure", journal=None: _ideas_json(
            {"ticker": "AAPL", "direction": "up", "thesis": "Momentum"}))
    body = c.post("/api/paper/ideas?sync=1", json={}).json()
    assert body["ideas"][0]["tracked"] is False
    assert c.get("/api/paper/board").json()["pipeline"] == []


def test_a_broken_board_never_breaks_the_ideas_answer(tmp_path, monkeypatch):
    """Le tableau est best-effort : une réponse LLM déjà obtenue ne doit pas
    être perdue parce que le disque a hoqueté."""
    c, _ = make_client(tmp_path, monkeypatch)

    def boom(*args, **kwargs):
        raise OSError("disque plein")

    monkeypatch.setattr(pr.board, "add_pipeline_item", boom)
    monkeypatch.setattr(
        pr.llm, "suggest_ideas",
        lambda context, lang="fr", risk_level="mesure", journal=None: _ideas_json(
            {"ticker": "AAPL", "direction": "up", "thesis": "Momentum"}))
    body = c.post("/api/paper/ideas?sync=1", json={})
    assert body.status_code == 200
    assert body.json()["ideas"][0]["tracked"] is True


def test_scenarios_generate_happy_path(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    body = c.post("/api/paper/board/scenarios/generate?sync=1", json={})
    assert body.status_code == 200
    data = body.json()
    assert data["text"] == "Voici les chemins que je vois."      # sans le bloc JSON
    assert data["tree"]["title"].startswith("La Fed")
    assert data["tree"]["status"] == "active"
    assert [b["label"] for b in data["tree"]["branches"]] == ["la Fed coupe", "statu quo"]
    assert all(b["status"] == "open" for b in data["tree"]["branches"])
    assert len(data["scenarios"]) == 1
    assert c.get("/api/paper/board").json()["scenarios"][0]["id"] == data["tree"]["id"]


def test_scenarios_generate_sees_the_pipeline(tmp_path, monkeypatch):
    """Les futurs achats notés font partie de ce qui est en jeu."""
    c, _ = make_client(tmp_path, monkeypatch)
    add_item(c)
    seen = {}
    monkeypatch.setattr(pr.llm, "suggest_scenarios",
                        lambda context, lang="fr":
                        seen.update(context) or scenarios_answer())
    c.post("/api/paper/board/scenarios/generate?sync=1", json={})
    assert [row["symbol"] for row in seen["pipeline"]] == ["NESN.SW"]
    assert "watchlist" in seen and "stats" in seen


def test_scenarios_generate_forwards_the_language(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    seen = {}
    monkeypatch.setattr(pr.llm, "suggest_scenarios",
                        lambda context, lang="fr":
                        seen.__setitem__("lang", lang) or scenarios_answer())
    c.post("/api/paper/board/scenarios/generate?sync=1", json={"lang": "it"})
    assert seen["lang"] == "it"
    c.post("/api/paper/board/scenarios/generate?sync=1", json={"lang": "klingon"})
    assert seen["lang"] == "fr"


def test_scenarios_generate_502s_on_a_llm_outage(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)

    def boom(context, lang="fr"):
        raise RuntimeError("le coach n'a pas répondu dans les 120 s")

    monkeypatch.setattr(pr.llm, "suggest_scenarios", boom)
    assert c.post("/api/paper/board/scenarios/generate?sync=1", json={}).status_code == 502


def test_scenarios_generate_502s_on_an_unusable_answer(tmp_path, monkeypatch):
    """Mieux vaut le dire que d'afficher un demi-arbre."""
    c, _ = make_client(tmp_path, monkeypatch)
    monkeypatch.setattr(pr.llm, "suggest_scenarios",
                        lambda context, lang="fr": "je n'ai rien à dire")
    resp = c.post("/api/paper/board/scenarios/generate?sync=1", json={})
    assert resp.status_code == 502
    assert c.get("/api/paper/board").json()["scenarios"] == []


def test_only_three_scenarios_stay_active_through_the_api(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    for i in range(4):
        c.post("/api/paper/board/scenarios/generate?sync=1", json={})
    statuses = [t["status"] for t in c.get("/api/paper/board").json()["scenarios"]]
    assert statuses.count("active") == 3
    assert statuses.count("archived") == 1


def test_resolving_a_branch(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    tree = c.post("/api/paper/board/scenarios/generate?sync=1", json={}).json()["tree"]
    branch_id = tree["branches"][0]["id"]

    body = c.post("/api/paper/board/scenarios/%s/branches/%s" % (tree["id"], branch_id),
                  json={"status": "happened"})
    assert body.status_code == 200
    assert body.json()["tree"]["branches"][0]["status"] == "happened"

    stored = c.get("/api/paper/board").json()["scenarios"][0]
    assert stored["branches"][0]["status"] == "happened"
    assert stored["branches"][1]["status"] == "open"


def test_resolving_a_branch_refuses_a_reopening(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    tree = c.post("/api/paper/board/scenarios/generate?sync=1", json={}).json()["tree"]
    url = "/api/paper/board/scenarios/%s/branches/%s" % (tree["id"],
                                                         tree["branches"][0]["id"])
    assert c.post(url, json={"status": "open"}).status_code == 400
    assert c.post(url, json={}).status_code == 400


def test_resolving_an_unknown_branch_or_tree_is_a_404(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    tree = c.post("/api/paper/board/scenarios/generate?sync=1", json={}).json()["tree"]
    assert c.post("/api/paper/board/scenarios/nope/branches/x",
                  json={"status": "happened"}).status_code == 404
    assert c.post("/api/paper/board/scenarios/%s/branches/nope" % tree["id"],
                  json={"status": "happened"}).status_code == 404


def test_deleting_a_scenario_archives_it(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    tree = c.post("/api/paper/board/scenarios/generate?sync=1", json={}).json()["tree"]
    body = c.delete("/api/paper/board/scenarios/%s" % tree["id"])
    assert body.status_code == 200
    assert body.json()["tree"]["status"] == "archived"
    scenarios = c.get("/api/paper/board").json()["scenarios"]
    assert [t["status"] for t in scenarios] == ["archived"]     # jamais supprimé
    assert c.delete("/api/paper/board/scenarios/nope").status_code == 404


def test_board_file_does_not_create_a_ghost_radar_user(tmp_path, monkeypatch):
    """<user>.board.json porte un point dans le radical (même mécanisme que
    .coach.json / .watchlist.json, cf. radar._USER_FILE_RE) : jamais un compte
    fantôme pour le radar."""
    from backend.bots.paper import radar
    c, _ = make_client(tmp_path, monkeypatch)
    store.save_portfolio("tester", pr.new_portfolio().to_dict())
    add_item(c)
    assert pr.board.board_path("tester").is_file()      # le fichier existe bien
    assert radar._users_with_portfolio() == ["tester"]


def test_board_file_does_not_create_a_ghost_newswatch_user(tmp_path, monkeypatch):
    """Le veilleur news globe le MÊME dossier : son radical à point est écarté
    par la liste explicite ET rejeté par store.portfolio_path (ceinture et
    bretelles). Sans quoi « tester.board » recevrait ses propres dépêches."""
    from backend.bots.paper import newswatch
    c, _ = make_client(tmp_path, monkeypatch)
    store.save_portfolio("tester", pr.new_portfolio().to_dict())
    store.save_watchlist("tester", [{"symbol": "NESN.SW", "name": "Nestle SA",
                                     "currency": "CHF", "added_at": FIXED_NOW}])
    add_item(c)
    assert pr.board.board_path("tester").is_file()
    assert [name for name, _ in newswatch._discover_portfolios()] == ["tester"]


def test_board_learning_counts_a_challenge_actually_WON(tmp_path, monkeypatch):
    """Le verdict d'un défi n'est PAS stocké dans le profil : il se recalcule
    depuis le catalogue et les trades de la semaine. Ce test épingle le
    câblage — sans lui, ``done`` resterait à zéro pour toujours en ayant l'air
    de marcher (la classe de bug des pièges #52a/#61)."""
    c, _ = make_client(tmp_path, monkeypatch)
    profile = coach.empty_profile()
    # "drawdown" a pour condition n_trades_week>=0 : une semaine PASSÉE sans
    # trade la remplit, donc le verdict est "done" et rien d'autre.
    profile["arena_history"] = [{"week": "2020-W01", "id": "drawdown",
                                 "accepted_at": FIXED_NOW}]
    profile["lessons_passed"] = ["risque_1", "stop"]
    store.save_coach("tester", profile)

    learning = c.get("/api/paper/board").json()["learning"]
    assert learning["arena"] == {"accepted": 1, "done": 1}
    assert learning["lessons"]["passed"] == 2


def test_the_strategy_context_is_the_same_for_ideas_and_scenarios(tmp_path, monkeypatch):
    """UNE seule assemblée de contexte pour les deux registres : deux
    assemblages parallèles finiraient par diverger (l'un recevrait les
    annonces politiques, l'autre pas — sans que rien ne le signale)."""
    c, _ = make_client(tmp_path, monkeypatch)
    seen = {}
    monkeypatch.setattr(pr.llm, "suggest_ideas",
                        lambda context, lang="fr", risk_level="mesure", journal=None:
                        seen.__setitem__("ideas", dict(context))
                        or '```json\n{"ideas": []}\n```')
    monkeypatch.setattr(pr.llm, "suggest_scenarios",
                        lambda context, lang="fr":
                        seen.__setitem__("scenarios", dict(context))
                        or scenarios_answer())
    c.post("/api/paper/ideas?sync=1", json={})
    c.post("/api/paper/board/scenarios/generate?sync=1", json={})

    expected = {"stats", "biases", "coach_summary", "last_trades",
                "capital_initial_chf", "cash_chf", "watchlist",
                "radar_open_hypotheses", "recent_news", "recent_filings"}
    assert expected <= set(seen["ideas"])
    # les scénarios voient la MÊME chose, plus le pipeline
    assert set(seen["scenarios"]) == set(seen["ideas"]) | {"pipeline"}


def test_strategy_context_carries_a_compact_emotion_summary_lot2_b3(tmp_path, monkeypatch):
    """B3 : le coach VOIT la corrélation émotion -> résultat déjà calculée, il
    ne la recalcule pas. Une seule ligne PAR ÉMOTION significative (n>=3) ;
    ``untagged`` n'apprend rien et n'apparaît jamais."""
    c, market = make_client(tmp_path, monkeypatch)
    for _ in range(3):
        buy(c, emotion="fomo", thesis="Une thèse suffisamment longue pour le coach")
        market.prices["NESN.SW"] = (90.0, "CHF", "Nestle SA")
        buy(c, side="sell", qty=10)
        market.prices["NESN.SW"] = (100.0, "CHF", "Nestle SA")
    buy(c, emotion="calme", thesis="Une thèse suffisamment longue pour le coach")
    buy(c, side="sell", qty=10)                          # une seule -> sous le seuil

    seen = {}
    monkeypatch.setattr(pr.llm, "suggest_ideas",
                        lambda context, lang="fr", risk_level="mesure", journal=None:
                        seen.__setitem__("ideas", dict(context))
                        or '```json\n{"ideas": []}\n```')
    c.post("/api/paper/ideas?sync=1", json={})

    lines = seen["ideas"]["emotion_patterns"]
    assert len(lines) == 1
    assert "fomo" in lines[0]
    assert all("calme" not in line for line in lines)


def test_strategy_context_has_no_emotion_key_below_the_significance_threshold(
        tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    buy(c, emotion="doute", thesis="Une thèse suffisamment longue pour le coach")
    buy(c, side="sell", qty=10)

    seen = {}
    monkeypatch.setattr(pr.llm, "suggest_ideas",
                        lambda context, lang="fr", risk_level="mesure", journal=None:
                        seen.__setitem__("ideas", dict(context))
                        or '```json\n{"ideas": []}\n```')
    c.post("/api/paper/ideas?sync=1", json={})
    assert "emotion_patterns" not in seen["ideas"]


# ================================================================
#  MODE D'ALERTE (26/08) — la partie automatique
# ================================================================

def test_alerts_mode_defaults_to_quiet(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    body = c.get("/api/paper/alerts-mode").json()
    assert body["mode"] == "calme"
    assert set(body["modes"]) == {"calme", "tout"}


def test_alerts_mode_can_be_switched_and_persists(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert c.post("/api/paper/alerts-mode", json={"mode": "tout"}).json()["mode"] == "tout"
    assert c.get("/api/paper/alerts-mode").json()["mode"] == "tout"


def test_alerts_mode_returns_the_mode_really_applied(tmp_path, monkeypatch):
    """Le client lit ce qui S'APPLIQUE, pas ce qu'il croyait demander."""
    c, _ = make_client(tmp_path, monkeypatch)
    assert c.post("/api/paper/alerts-mode",
                  json={"mode": "yolo"}).json()["mode"] == "calme"


def test_alerts_mode_is_refused_to_the_trader_role(tmp_path, monkeypatch):
    """C'est un réglage de la veille (ce que le téléphone reçoit), pas une
    action de trading."""
    c, _ = make_client(tmp_path, monkeypatch, role="trader")
    assert c.get("/api/paper/alerts-mode").status_code == 403
    assert c.post("/api/paper/alerts-mode", json={"mode": "tout"}).status_code == 403


def test_alerts_mode_is_allowed_to_money(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch, role="money")
    assert c.get("/api/paper/alerts-mode").status_code == 200
    assert c.post("/api/paper/alerts-mode", json={"mode": "tout"}).status_code == 200


# ================================================================
#  COMPTES X SUIVIS (26/08)
# ================================================================

def test_x_accounts_serves_the_defaults(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    body = c.get("/api/paper/x-accounts").json()
    assert body["handles"] and body["max"] >= 1


def test_x_accounts_replaces_the_whole_list(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    body = c.post("/api/paper/x-accounts",
                  json={"handles": ["@WhiteHouse", "elonmusk"]}).json()
    assert body["handles"] == ["WhiteHouse", "elonmusk"]
    assert c.get("/api/paper/x-accounts").json()["handles"] == ["WhiteHouse",
                                                                "elonmusk"]


def test_x_accounts_drops_an_invalid_handle(tmp_path, monkeypatch):
    """Un nom sanitisé pointerait sur un AUTRE compte : on rejette."""
    c, _ = make_client(tmp_path, monkeypatch)
    body = c.post("/api/paper/x-accounts",
                  json={"handles": ["ok_handle", "pas un handle !", "x" * 20]}).json()
    assert body["handles"] == ["ok_handle"]


def test_x_accounts_caps_the_list(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    body = c.post("/api/paper/x-accounts",
                  json={"handles": ["c%d" % i for i in range(30)]}).json()
    assert len(body["handles"]) == body["max"]


def test_x_accounts_is_refused_to_the_trader_role(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch, role="trader")
    assert c.get("/api/paper/x-accounts").status_code == 403
    assert c.post("/api/paper/x-accounts", json={"handles": []}).status_code == 403


# ================================================================
#  JOURNAL DES IDÉES (26/08)
# ================================================================

def test_ideas_are_appended_to_the_journal(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    _ideas_double(monkeypatch, {"ticker": "TSLA", "direction": "up",
                                "horizon_days": 10, "thesis": "un pari"})
    c.post("/api/paper/ideas?sync=1", json={"risk_level": "agressif"})

    entries = c.get("/api/paper/ideas/journal").json()["entries"]
    assert len(entries) == 1
    assert entries[0]["kind"] == "ideas"
    assert entries[0]["risk_level"] == "agressif"
    assert entries[0]["ideas"][0]["ticker"] == "TSLA"


def test_the_journal_reaches_the_next_prompt(tmp_path, monkeypatch):
    """C'est tout l'objet du journal : ne pas reproposer la même idée."""
    c, _ = make_client(tmp_path, monkeypatch)
    seen = _ideas_double(monkeypatch, {"ticker": "TSLA", "direction": "up",
                                       "horizon_days": 10, "thesis": "un pari"})
    c.post("/api/paper/ideas?sync=1", json={})
    assert seen["journal"] == []                # première série : rien derrière
    c.post("/api/paper/ideas?sync=1", json={})
    assert seen["journal"][0]["ideas"][0]["ticker"] == "TSLA"


def test_the_journal_is_capped_by_the_limit_parameter(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    _ideas_double(monkeypatch)
    for _ in range(3):
        c.post("/api/paper/ideas?sync=1", json={})
    assert len(c.get("/api/paper/ideas/journal?limit=2").json()["entries"]) == 2


def test_an_unwritable_journal_never_breaks_the_answer(tmp_path, monkeypatch):
    """Une écriture ratée ne doit pas faire perdre une réponse déjà payée."""
    c, _ = make_client(tmp_path, monkeypatch)
    _ideas_double(monkeypatch)

    def boom(*a, **kw):
        raise OSError("disque plein")

    monkeypatch.setattr(pr.idea_journal, "append_entry", boom)
    assert c.post("/api/paper/ideas?sync=1", json={}).status_code == 200


def test_the_journal_is_refused_to_the_player_role(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch, role="player")
    assert c.get("/api/paper/ideas/journal").status_code == 403


# ================================================================
#  CE QUE LE COACH A DÉJÀ DIT SUR UN TITRE (lecture pure)
# ================================================================

def test_ideas_for_symbol_aggregates_radar_and_journal(tmp_path, monkeypatch):
    from backend.bots.paper import radar
    c, _ = make_client(tmp_path, monkeypatch)
    _ideas_double(monkeypatch, {"ticker": "TSLA", "direction": "up",
                                "horizon_days": 10, "thesis": "un pari"})
    c.post("/api/paper/ideas?sync=1", json={})

    state = radar.load_state()
    state["hypotheses"][0]["status"] = "scored"
    state["hypotheses"][0]["outcome"] = "hit"
    radar.save_state(state)

    items = c.get("/api/paper/ideas/for-symbol?symbol=tsla").json()["items"]
    origins = {row["from"] for row in items}
    assert origins == {"radar", "journal"}
    radar_row = next(r for r in items if r["from"] == "radar")
    assert radar_row["outcome"] == "hit" and radar_row["source"] == "coach"


def test_ideas_for_symbol_includes_review_verdicts(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    pr.idea_journal.append_entry(
        "tester", "review", "ma revue",
        verdicts=[{"symbol": "KO", "stance": "alleger", "reason": "stop proche"}],
        now_iso=FIXED_NOW)
    items = c.get("/api/paper/ideas/for-symbol?symbol=KO").json()["items"]
    assert items == [{"from": "review", "ts": FIXED_NOW, "stance": "alleger",
                      "reason": "stop proche"}]


def test_ideas_for_symbol_journal_row_carries_the_structured_advice(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    pr.idea_journal.append_entry(
        "tester", "ideas", "texte quelconque",
        ideas=[{"ticker": "AAPL", "direction": "up", "tracked": True,
                "stop": "195 ou -5 %", "risk_pct": 1.2,
                "invalidated_if": "clôture sous 195",
                "why_now": "résultats demain"}],
        now_iso=FIXED_NOW)
    row = c.get("/api/paper/ideas/for-symbol?symbol=AAPL").json()["items"][0]
    assert row["stop"] == "195 ou -5 %"
    assert row["risk_pct"] == 1.2
    assert row["invalidated_if"] == "clôture sous 195"
    assert row["why_now"] == "résultats demain"
    assert "advice" not in row          # les champs structurés suffisent


def test_ideas_for_symbol_journal_row_falls_back_to_extracted_advice(tmp_path, monkeypatch):
    """Idée journalisée AVANT l'enrichissement du schéma (pas de champs
    structurés) : le conseil complet vit dans le texte, on va le chercher."""
    c, _ = make_client(tmp_path, monkeypatch)
    text = ("MSFT — cloud toujours solide.\n\n"
            "AAPL — hausse probable, stop sous 190, invalidée si -5 %.")
    pr.idea_journal.append_entry(
        "tester", "ideas", text,
        ideas=[{"ticker": "AAPL", "direction": "up", "tracked": True}],
        now_iso=FIXED_NOW)
    row = c.get("/api/paper/ideas/for-symbol?symbol=AAPL").json()["items"][0]
    assert row["advice"] == "AAPL — hausse probable, stop sous 190, invalidée si -5 %."
    assert "stop" not in row


def test_ideas_for_symbol_journal_row_has_no_advice_when_nothing_to_show(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    pr.idea_journal.append_entry(
        "tester", "ideas", "texte muet sur ce titre",
        ideas=[{"ticker": "AAPL", "direction": "up", "tracked": True}],
        now_iso=FIXED_NOW)
    row = c.get("/api/paper/ideas/for-symbol?symbol=AAPL").json()["items"][0]
    assert "advice" not in row
    assert "stop" not in row


def test_ideas_for_symbol_is_case_insensitive(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    pr.idea_journal.append_entry(
        "tester", "ideas", "texte",
        ideas=[{"ticker": "AAPL", "direction": "up", "tracked": True}],
        now_iso=FIXED_NOW)
    assert c.get("/api/paper/ideas/for-symbol?symbol=aapl").json()["items"]
    assert c.get("/api/paper/ideas/for-symbol?symbol=AAPL").json()["items"]


def test_ideas_for_symbol_sorts_and_caps(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    for day in range(1, 15):
        pr.idea_journal.append_entry(
            "tester", "ideas", "texte",
            ideas=[{"ticker": "AAPL", "direction": "up"}],
            now_iso="2026-08-%02dT10:00:00" % day)
    items = c.get("/api/paper/ideas/for-symbol?symbol=AAPL").json()["items"]
    assert len(items) == pr.IDEAS_FOR_SYMBOL_LIMIT
    assert items[0]["ts"] > items[-1]["ts"]     # le plus récent en tête


def test_ideas_for_symbol_is_empty_when_nothing_was_said(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    response = c.get("/api/paper/ideas/for-symbol?symbol=ZZZZ")
    assert response.status_code == 200
    assert response.json() == {"items": []}


def test_ideas_for_symbol_requires_a_symbol(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert c.get("/api/paper/ideas/for-symbol?symbol=").status_code == 400


def test_ideas_for_symbol_never_calls_the_coach(tmp_path, monkeypatch):
    """LECTURE PURE : zéro LLM, zéro réseau."""
    c, _ = make_client(tmp_path, monkeypatch)

    def boom(*a, **kw):
        raise AssertionError("aucun appel au modèle ne doit partir d'ici")

    for name in ("suggest_ideas", "review_positions", "ask_coach"):
        monkeypatch.setattr(pr.llm, name, boom)
    assert c.get("/api/paper/ideas/for-symbol?symbol=AAPL").status_code == 200


# ================================================================
#  REVUE DES POSITIONS (« prévision de vente »)
# ================================================================

def _review_double(monkeypatch, text=None):
    """Double de ``review_positions`` qui NOTE le fait-pack reçu."""
    seen = {}
    answer = text if text is not None else (
        'Ma revue.\n```json\n{"verdicts": [{"symbol": "NESN.SW", '
        '"stance": "alleger", "reason": "le stop est proche"}]}\n```')

    def fake(context, lang="fr"):
        seen["context"] = context
        seen["lang"] = lang
        return answer

    monkeypatch.setattr(pr.llm, "review_positions", fake)
    return seen


def test_review_refuses_an_empty_portfolio(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    _review_double(monkeypatch)
    response = c.post("/api/paper/positions/review?sync=1", json={})
    assert response.status_code == 400
    assert "revue" in response.json()["detail"]


def test_review_builds_a_deterministic_factpack(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, qty=10, stop_loss=90.0)
    market.prices["NESN.SW"] = (92.0, "CHF", "Nestle SA")
    seen = _review_double(monkeypatch)

    c.post("/api/paper/positions/review?sync=1", json={})
    position = seen["context"]["positions"][0]
    assert position["symbol"] == "NESN.SW"
    assert position["last_price"] == 92.0
    assert position["pnl_pct"] == -8.0          # payé 100, vaut 92
    assert position["stop_loss"] == 90.0
    assert position["distance_stop_pct"] == -2.17
    assert position["news_recentes"] == [] and position["gov_recent"] is False


def test_review_says_null_when_the_price_is_unavailable(tmp_path, monkeypatch):
    """Un cours indisponible n'est pas inventé — le prompt dit au coach de le
    signaler."""
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, qty=10)
    market.broken.add("NESN.SW")
    seen = _review_double(monkeypatch)

    c.post("/api/paper/positions/review?sync=1", json={})
    position = seen["context"]["positions"][0]
    assert position["last_price"] is None and position["pnl_pct"] is None


def test_review_carries_recent_news_and_whale_moves(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    buy(c, qty=10)
    events = [{"ts": FIXED_NOW, "symbol": "NESN.SW", "sentiment": "neg",
               "title": "Avertissement sur résultats", "link": "http://x"},
              {"ts": FIXED_NOW, "symbol": "GOV", "sentiment": "gov",
               "title": "Droits de douane", "link": "http://g"}]
    moves = [{"manager_label": "Berkshire", "action": "sortie",
              "name": "NESTLE SA", "quarter": "T2 2026"}]
    monkeypatch.setattr(pr, "_newswatch",
                        lambda: FakeModule(recent_events=lambda user: events))
    monkeypatch.setattr(pr, "_whales", lambda: FakeModule(
        moves_summary=lambda: moves,
        match_issuer=lambda name, candidates: "NESN.SW"))
    seen = _review_double(monkeypatch)

    c.post("/api/paper/positions/review?sync=1", json={})
    position = seen["context"]["positions"][0]
    assert position["news_recentes"][0]["sentiment"] == "neg"
    assert position["gov_recent"] is True
    assert position["whale_moves_on_this"][0]["action"] == "sortie"


def test_review_parses_the_verdicts(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    buy(c, qty=10)
    _review_double(monkeypatch)
    body = c.post("/api/paper/positions/review?sync=1", json={}).json()
    assert body["verdicts"] == [{"symbol": "NESN.SW", "stance": "alleger",
                                 "reason": "le stop est proche"}]
    assert body["text"].startswith("Ma revue.")


def test_review_survives_an_unreadable_json_block(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    buy(c, qty=10)
    _review_double(monkeypatch, text="Ma revue sans bloc final.")
    body = c.post("/api/paper/positions/review?sync=1", json={}).json()
    assert body["verdicts"] == [] and body["text"]


def test_review_is_appended_to_the_journal(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    buy(c, qty=10)
    _review_double(monkeypatch)
    c.post("/api/paper/positions/review?sync=1", json={})

    entries = c.get("/api/paper/ideas/journal").json()["entries"]
    assert entries[0]["kind"] == "review"
    assert entries[0]["verdicts"][0]["symbol"] == "NESN.SW"


def test_review_returns_a_clean_502_when_the_coach_is_down(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    buy(c, qty=10)

    def boom(context, lang="fr"):
        raise RuntimeError("le coach n'a pas répondu")

    monkeypatch.setattr(pr.llm, "review_positions", boom)
    assert c.post("/api/paper/positions/review?sync=1", json={}).status_code == 502


def test_review_forwards_the_reading_language(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    buy(c, qty=10)
    seen = _review_double(monkeypatch)
    c.post("/api/paper/positions/review?sync=1", json={"lang": "it"})
    assert seen["lang"] == "it"


def test_review_is_refused_to_the_player_role(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch, role="player")
    assert c.post("/api/paper/positions/review?sync=1", json={}).status_code == 403


def test_review_is_allowed_to_the_trader_role(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch, role="trader")
    _review_double(monkeypatch)
    assert c.post("/api/paper/positions/review?sync=1", json={}).status_code == 400


# ================================================================
#  CONTEXTE DU COACH — crypto et grands gérants (26/08)
# ================================================================

def test_the_crypto_factpack_is_built_only_for_the_crypto_level(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    for symbol in pr.CRYPTO_MAJORS:
        market.prices[symbol] = (100.0, "USD", symbol)
        market.candles[symbol] = [{"ts": i, "close": 90.0 + i} for i in range(12)]
    seen = _ideas_double(monkeypatch)

    c.post("/api/paper/ideas?sync=1", json={"risk_level": "mesure"})
    assert "crypto_market" not in seen["context"]

    c.post("/api/paper/ideas?sync=1", json={"risk_level": "crypto"})
    facts = seen["context"]["crypto_market"]
    assert [row["symbol"] for row in facts] == list(pr.CRYPTO_MAJORS)
    assert facts[0]["price"] == 100.0
    assert facts[0]["change_7d_pct"] is not None


def test_the_crypto_factpack_survives_a_broken_quote(tmp_path, monkeypatch):
    """Le coach a TOUJOURS un bloc, même si une pièce ne répond pas."""
    c, market = make_client(tmp_path, monkeypatch)
    seen = _ideas_double(monkeypatch)
    c.post("/api/paper/ideas?sync=1", json={"risk_level": "crypto"})
    facts = seen["context"]["crypto_market"]
    assert len(facts) == len(pr.CRYPTO_MAJORS)
    assert facts[0]["price"] is None and facts[0]["change_7d_pct"] is None


def test_the_context_carries_crypto_news_and_whale_moves(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    events = [{"ts": FIXED_NOW, "symbol": "BTC-USD", "sentiment": "neg",
               "title": "Exchange hack", "link": "http://c", "src": "crypto"},
              {"ts": FIXED_NOW, "symbol": "NESN.SW", "sentiment": "neg",
               "title": "Avertissement", "link": "http://y"}]
    monkeypatch.setattr(pr, "_newswatch",
                        lambda: FakeModule(recent_events=lambda user: events))
    monkeypatch.setattr(pr, "_whales", lambda: FakeModule(
        moves_summary=lambda: [{"manager_label": "Berkshire", "action": "sortie",
                                "name": "KROGER CO"}],
        recent_filing_events=lambda: []))
    seen = _ideas_double(monkeypatch)

    c.post("/api/paper/ideas?sync=1", json={})
    assert [e["title"] for e in seen["context"]["recent_crypto"]] == ["Exchange hack"]
    assert seen["context"]["whale_moves"][0]["action"] == "sortie"


def test_a_broken_whales_module_never_breaks_the_context(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)

    def boom():
        raise RuntimeError("cache illisible")

    monkeypatch.setattr(pr, "_whales", lambda: FakeModule(
        moves_summary=boom, recent_filing_events=lambda: []))
    seen = _ideas_double(monkeypatch)
    assert c.post("/api/paper/ideas?sync=1", json={}).status_code == 200
    assert seen["context"]["whale_moves"] == []


# ================================================================
#  COMMUNAUTÉ — plus d'utilisateurs fantômes (26/08)
# ================================================================

def test_a_module_vault_is_not_a_community_user(tmp_path, monkeypatch):
    """Constaté à l'écran : « newswatch_global » et « whales_watch » listés
    comme des traders. Ces carnets existent ENCORE sur le disque de production
    (bug d'avant 83a8d4b) — un carnet seul ne prouve plus rien."""
    c, _ = make_client(tmp_path, monkeypatch)
    store.append_note("newswatch_global", "Journal.md", "## fantôme\n")
    store.append_note("whales_watch", "Journal.md", "## fantôme\n")
    _real_trader("alice")

    users = {row["user"] for row in c.get("/api/paper/community").json()["users"]}
    assert users == {"alice"}


def test_a_ghost_user_is_also_404_on_note_reading(tmp_path, monkeypatch):
    """Le filtre ferme les DEUX portes : la liste ET la lecture (le paramètre
    ``user`` est validé contre cette même liste)."""
    c, _ = make_client(tmp_path, monkeypatch)
    store.append_note("newswatch_global", "Journal.md", "## fantôme\n")
    response = c.get("/api/paper/community/newswatch_global/Journal.md")
    assert response.status_code == 404


def test_a_vault_without_any_account_file_is_ignored(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    store.append_note("inconnu", "Journal.md", "## sans compte\n")
    assert c.get("/api/paper/community").json() == {"users": []}


def test_a_coach_profile_is_enough_to_be_a_community_user(tmp_path, monkeypatch):
    """Un compte qui a discuté avec le coach sans jamais passer d'ordre a un
    profil mais pas de portefeuille : il compte."""
    c, _ = make_client(tmp_path, monkeypatch)
    store.save_coach("bob", {"profile": {}, "biases": []})
    store.append_note("bob", "Journal.md", "## note de bob\n")
    users = {row["user"] for row in c.get("/api/paper/community").json()["users"]}
    assert users == {"bob"}


def test_review_matches_a_whale_move_through_the_yahoo_name(tmp_path, monkeypatch):
    """⚠️ Une position ne porte pas de nom : c'est la COTATION qui en fournit
    un. Sans lui, ``match_issuer`` comparerait « NESTLE SA » à « NESN.SW » et
    aucun mouvement de gérant ne serait jamais rattaché à une position."""
    c, _ = make_client(tmp_path, monkeypatch)
    buy(c, qty=10)
    seen_names = {}

    def match_issuer(name, candidates):
        seen_names.update(candidates)
        return "NESN.SW" if "NESTLE" in str(name).upper() else None

    monkeypatch.setattr(pr, "_whales", lambda: FakeModule(
        moves_summary=lambda: [{"manager_label": "Berkshire", "action": "sortie",
                                "name": "NESTLE SA", "quarter": "T2 2026"}],
        match_issuer=match_issuer, recent_filing_events=lambda: []))
    seen = _review_double(monkeypatch)

    c.post("/api/paper/positions/review?sync=1", json={})
    assert seen_names == {"NESN.SW": "Nestle SA"}       # le nom, pas le ticker
    assert seen["context"]["positions"][0]["whale_moves_on_this"]


def test_review_asks_the_price_once_per_symbol(tmp_path, monkeypatch):
    """Deux lignes sur le même titre ne paient pas deux cotations."""
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, qty=10)
    buy(c, qty=5)
    _review_double(monkeypatch)
    calls = []
    real_get_quote = quotes.get_quote
    monkeypatch.setattr(quotes, "get_quote",
                        lambda s: calls.append(s) or real_get_quote(s))
    c.post("/api/paper/positions/review?sync=1", json={})
    assert calls.count("NESN.SW") == 1


# ================================================================
#  GRAPHE DES CONNEXIONS (lecture pure — zéro LLM, zéro réseau)
# ================================================================

def graph_stubs(monkeypatch, events=None, hypotheses=None, moves=None,
                trends=None):
    """Câble les trois modules OPTIONNELS que le graphe consomme. Chacun est
    lazy dans le router, donc on remplace l'accesseur, pas le module."""
    monkeypatch.setattr(pr, "_newswatch",
                        lambda: FakeModule(
                            recent_events=lambda user: list(events or []),
                            recent_trends=lambda now=None: dict(trends or {})))
    monkeypatch.setattr(pr, "_radar",
                        lambda: FakeModule(load_state=lambda: {
                            "hypotheses": list(hypotheses or []),
                            "stats": {"hits": 0, "misses": 0, "unclear": 0}}))
    monkeypatch.setattr(pr, "_whales",
                        lambda: FakeModule(moves_summary=lambda: list(moves or []),
                                           recent_filing_events=lambda: []))


def graph_of(client, symbol=None, name=None):
    params = {}
    if symbol:
        params["symbol"] = symbol
    if name:
        params["name"] = name
    response = client.get("/api/paper/graph", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def test_graph_puts_the_held_title_at_the_centre(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    graph_stubs(monkeypatch, events=[
        {"ts": FIXED_NOW, "symbol": "NESN.SW", "title": "Résultats",
         "link": "http://n/1", "sentiment": "pos"}])
    buy(c)

    body = graph_of(c)
    assert body["generated_at"] == FIXED_NOW
    assert body["truncated"] is False
    types = {node["id"]: node["type"] for node in body["nodes"]}
    assert types["NESN.SW"] == "position"
    news = [node for node in body["nodes"] if node["type"] == "news"]
    assert len(news) == 1
    assert body["edges"] == [{"source": news[0]["id"], "target": "NESN.SW",
                              "type": "symbol", "sentiment": "pos"}]


def test_graph_reads_the_watchlist_the_pipeline_the_radar_and_the_whales(
        tmp_path, monkeypatch):
    """Les quatre sources arrivent bien jusqu'au graphe — c'est le test qui
    attrape un champ perdu en route (piège #61 du dépôt)."""
    c, _ = make_client(tmp_path, monkeypatch)
    store.save_watchlist("tester", [{"symbol": "AAPL", "name": "Apple Inc"}])
    graph_stubs(
        monkeypatch,
        hypotheses=[{"id": "h1", "status": "open", "created_at": FIXED_NOW,
                     "thesis": "Le cycle repart", "tickers": ["AAPL"]}],
        moves=[{"manager_label": "Berkshire", "action": "sortie",
                "name": "APPLE INC", "quarter": "T2 2026",
                "fetched_at": FIXED_NOW}])
    assert c.post("/api/paper/board/pipeline",
                  json={"symbol": "NESN.SW"}).status_code == 200

    body = graph_of(c)
    types = {node["id"]: node["type"] for node in body["nodes"]}
    assert types["AAPL"] == "watchlist"
    assert types["NESN.SW"] == "pipeline"
    kinds = sorted(node["type"] for node in body["nodes"])
    assert kinds == ["hypothesis", "pipeline", "watchlist", "whale_move"]
    assert sorted(edge["type"] for edge in body["edges"]) == ["issuer", "ticker"]
    assert all(edge["target"] == "AAPL" for edge in body["edges"])


def test_graph_hangs_a_political_headline_on_the_world_pivot(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    graph_stubs(monkeypatch, events=[
        {"ts": FIXED_NOW, "symbol": "GOV", "title": "Nouveaux tarifs",
         "link": "http://g/1", "sentiment": "gov"}])
    buy(c)

    body = graph_of(c)
    assert "monde" in [node["id"] for node in body["nodes"]]
    assert [edge["target"] for edge in body["edges"]] == ["monde"]
    # …et la branche du titre ne la voit pas : le pivot n'est relié à aucune ancre.
    branch = graph_of(c, "NESN.SW")
    assert [node["id"] for node in branch["nodes"]] == ["NESN.SW"]


def test_graph_branch_keeps_only_that_title(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    store.save_watchlist("tester", [{"symbol": "AAPL", "name": "Apple Inc"}])
    graph_stubs(monkeypatch, events=[
        {"ts": FIXED_NOW, "symbol": "NESN.SW", "title": "Sur Nestlé",
         "link": "http://n/1", "sentiment": "pos"},
        {"ts": FIXED_NOW, "symbol": "AAPL", "title": "Sur Apple",
         "link": "http://n/2", "sentiment": "neg"}])
    buy(c)

    branch = graph_of(c, "NESN.SW")
    assert "AAPL" not in [node["id"] for node in branch["nodes"]]
    assert [node["label"] for node in branch["nodes"] if node["type"] == "news"] \
        == ["Sur Nestlé"]
    assert all(edge["target"] == "NESN.SW" for edge in branch["edges"])


def test_graph_hangs_reddit_trends_on_the_crowd_pivot(tmp_path, monkeypatch):
    """Les tendances traversent bien le router jusqu'au bosquet — c'est le test
    qui échoue si on oublie d'assembler cette entrée (piège #61)."""
    c, _ = make_client(tmp_path, monkeypatch)
    graph_stubs(monkeypatch, trends={"GME": {"count": 42, "prev": 3},
                                     "NESN.SW": {"count": 9, "prev": 1}})
    buy(c)

    body = graph_of(c)
    by_id = {node["id"]: node for node in body["nodes"]}
    assert by_id["rt:GME"]["label"] == "GME ×42"
    assert "foule" in by_id
    # Le ticker DÉTENU rejoint aussi sa branche ; celui qu'on ne suit pas, non.
    branch = graph_of(c, "NESN.SW")
    assert [node["id"] for node in branch["nodes"]] == ["NESN.SW", "rt:NESN.SW"]
    assert "foule" not in [node["id"] for node in branch["nodes"]]


def test_graph_survives_a_watcher_without_trends(tmp_path, monkeypatch):
    """Un guetteur d'une version antérieure n'expose pas ``recent_trends`` : un
    graphe partiel se lit, une erreur non."""
    c, _ = make_client(tmp_path, monkeypatch)
    monkeypatch.setattr(pr, "_newswatch",
                        lambda: FakeModule(recent_events=lambda user: []))
    monkeypatch.setattr(pr, "_radar", lambda: FakeModule(
        load_state=lambda: {"hypotheses": [], "stats": {}}))
    monkeypatch.setattr(pr, "_whales", lambda: FakeModule(
        moves_summary=lambda: [], recent_filing_events=lambda: []))
    buy(c)
    assert [node["id"] for node in graph_of(c)["nodes"]] == ["NESN.SW"]


def test_graph_branch_of_an_unknown_symbol_is_empty_and_still_200(tmp_path,
                                                                  monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    graph_stubs(monkeypatch)
    assert graph_of(c, "ZZZZ") == {"nodes": [], "edges": [], "truncated": False,
                                   "generated_at": FIXED_NOW}


# ----------------------------------------------------------------
#  Résolution par SOCIÉTÉ (``name``) — NSRGY (ADR US) vs NESN.SW (SIX)
#
#  PAS un alias de prix (cf. quotes.SYMBOL_ALIASES) : deux instruments réels,
#  deux devises. La résolution ne concerne QUE la toile, et seulement quand la
#  branche EXACTE est vide.
# ----------------------------------------------------------------

def test_graph_resolves_via_company_name_when_the_exact_symbol_has_no_branch(
        tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    graph_stubs(monkeypatch)
    store.save_watchlist("tester", [{"symbol": "NESN.SW", "name": "Nestlé S.A."}])

    body = graph_of(c, "NSRGY", name="Nestlé S.A.")
    assert body["via_symbol"] == "NESN.SW"
    assert [node["id"] for node in body["nodes"]] == ["NESN.SW"]


def test_graph_exact_symbol_stays_priority_even_with_a_name_hint(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    graph_stubs(monkeypatch)
    store.save_watchlist("tester", [{"symbol": "NSRGY", "name": "Nestle ADR"},
                                    {"symbol": "NESN.SW", "name": "Nestlé S.A."}])

    body = graph_of(c, "NSRGY", name="Nestlé S.A.")
    assert "via_symbol" not in body
    assert [node["id"] for node in body["nodes"]] == ["NSRGY"]


def test_graph_name_without_a_mapped_company_stays_empty(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    graph_stubs(monkeypatch)
    assert graph_of(c, "ZZZZ", name="Une société totalement inconnue") == \
        {"nodes": [], "edges": [], "truncated": False, "generated_at": FIXED_NOW}


def test_graph_company_resolution_prefers_the_users_own_anchor_name(tmp_path, monkeypatch):
    """``entities.anchor_index`` prime sur la table livrée : si Massii suit
    « Roche » sous un symbole qui lui est propre, c'est CELUI-LÀ qui doit
    sortir, pas celui de la table statique (RO.SW)."""
    c, _ = make_client(tmp_path, monkeypatch)
    graph_stubs(monkeypatch)
    store.save_watchlist("tester", [{"symbol": "RHHBY", "name": "Roche"}])
    body = graph_of(c, "ZZZZ", name="Roche")
    assert body["via_symbol"] == "RHHBY"


def test_graph_count_gives_the_number_of_direct_neighbours(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    graph_stubs(
        monkeypatch,
        events=[{"ts": FIXED_NOW, "symbol": "NESN.SW", "title": "Résultats",
                 "link": "http://n/1", "sentiment": "pos"},
                {"ts": FIXED_NOW, "symbol": "NESN.SW", "title": "Rachat",
                 "link": "http://n/2", "sentiment": "pos"}],
        hypotheses=[{"id": "h1", "status": "open", "created_at": FIXED_NOW,
                     "thesis": "Le lait remonte", "tickers": ["NESN.SW"]}])
    buy(c)

    assert c.get("/api/paper/graph/count?symbol=NESN.SW").json() == {"count": 3}
    assert c.get("/api/paper/graph/count?symbol=nesn.sw").json() == {"count": 3}
    assert c.get("/api/paper/graph/count?symbol=ZZZZ").json() == {"count": 0}


def test_graph_count_resolves_via_company_name_too(tmp_path, monkeypatch):
    """Même logique que ``/graph`` : le compteur/chip ne doit pas rester à
    zéro pendant que le dessin, lui, trouve une branche via le nom."""
    c, _ = make_client(tmp_path, monkeypatch)
    graph_stubs(monkeypatch, events=[
        {"ts": FIXED_NOW, "symbol": "NESN.SW", "title": "Résultats",
         "link": "http://n/1", "sentiment": "pos"}])
    store.save_watchlist("tester", [{"symbol": "NESN.SW", "name": "Nestlé S.A."}])

    body = c.get("/api/paper/graph/count",
                 params={"symbol": "NSRGY", "name": "Nestlé S.A."}).json()
    assert body == {"count": 1, "via_symbol": "NESN.SW"}


def test_graph_count_without_a_symbol_is_a_400(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    graph_stubs(monkeypatch)
    assert c.get("/api/paper/graph/count").status_code == 400


def test_graph_count_ignores_the_theme_nodes(tmp_path, monkeypatch):
    """Un thème est un intercalaire de mise en forme, pas une connexion : le
    compter ferait grimper « N connexions en mémoire » sans qu'une seule
    information de plus soit arrivée."""
    c, _ = make_client(tmp_path, monkeypatch)
    titles = ["Nestle cuts its dairy outlook after weak sales",
              "Nestle dairy sales weigh on the outlook",
              "Nestle confirms weak dairy sales in Europe",
              "Nestle dairy division cuts jobs",
              "Analysts trim Nestle dairy forecasts",
              "Nestle dairy margins under pressure",
              "Nestle dairy recall widens in Germany",
              "Nestle reshuffles its dairy leadership"]
    graph_stubs(monkeypatch, events=[
        {"ts": FIXED_NOW, "symbol": "NESN.SW", "title": title,
         "link": "http://n/%d" % i, "sentiment": "pos"}
        for i, title in enumerate(titles)])
    buy(c)

    branch = graph_of(c, "NESN.SW")
    assert [n for n in branch["nodes"] if n["type"] == "theme"]
    assert c.get("/api/paper/graph/count?symbol=NESN.SW").json() == {"count": 8}


def test_graph_survives_every_source_being_down(tmp_path, monkeypatch):
    """Une source en panne est ABSENTE du graphe, jamais un 500 : un graphe
    partiel se lit, une erreur non."""
    c, _ = make_client(tmp_path, monkeypatch)

    def boom(*args, **kwargs):
        raise IOError("source injoignable")

    monkeypatch.setattr(pr, "_newswatch", lambda: FakeModule(recent_events=boom))
    monkeypatch.setattr(pr, "_radar", lambda: FakeModule(load_state=boom))
    monkeypatch.setattr(pr, "_whales", lambda: FakeModule(moves_summary=boom))
    monkeypatch.setattr(pr, "_pipeline_view", boom)
    buy(c)

    body = graph_of(c)
    assert [node["id"] for node in body["nodes"]] == ["NESN.SW"]
    assert body["edges"] == []


def test_graph_survives_the_optional_modules_being_absent(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)

    def absent():
        raise ImportError("déploiement partiel")

    monkeypatch.setattr(pr, "_newswatch", absent)
    monkeypatch.setattr(pr, "_radar", absent)
    monkeypatch.setattr(pr, "_whales", absent)
    buy(c)

    assert [node["id"] for node in graph_of(c)["nodes"]] == ["NESN.SW"]


def test_graph_survives_a_broken_portfolio(tmp_path, monkeypatch):
    """Le portefeuille tombe -> on perd les positions, pas la watchlist."""
    c, _ = make_client(tmp_path, monkeypatch)
    store.save_watchlist("tester", [{"symbol": "AAPL", "name": "Apple Inc"}])
    graph_stubs(monkeypatch)

    def boom(username):
        raise ValueError("portefeuille illisible")

    monkeypatch.setattr(pr, "_load", boom)
    assert [node["id"] for node in graph_of(c)["nodes"]] == ["AAPL"]


# ================================================================
#  TRADUCTION DES TITRES ÉTRANGERS (27/08) — enrichissement au SERVICE,
#  lecture disque PURE, ZÉRO LLM dans le chemin de rendu.
#
#  « L'utilisateur (français) ne peut pas lire les titres ALLEMANDS qui
#  s'affichent dans les listes de la toile/connexions. »
# ================================================================

def test_graph_nodes_carry_a_cached_french_translation(tmp_path, monkeypatch):
    from backend.bots.paper import translate
    c, _ = make_client(tmp_path, monkeypatch)
    german_title = "Nestlé unter Druck: Analysten senken das Kursziel"
    graph_stubs(monkeypatch, events=[
        {"ts": FIXED_NOW, "symbol": "NESN.SW", "title": german_title,
         "link": "http://nzz.test/1", "sentiment": "neg"}])
    buy(c)
    translate.save_cache({"last_sweep_ts": None, "entries": {
        translate._title_key(german_title): {
            "fr": "Nestlé sous pression : les analystes abaissent l'objectif "
                 "de cours",
            "src": "de", "ts": FIXED_NOW}}})

    body = graph_of(c)
    news = [n for n in body["nodes"] if n["type"] == "news"][0]
    assert news["title_fr"] == ("Nestlé sous pression : les analystes "
                                "abaissent l'objectif de cours")
    assert news["src_lang"] == "DE"
    assert news["label"] == german_title          # l'original ne bouge JAMAIS


def test_graph_nodes_without_a_cache_hit_stay_intact(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    graph_stubs(monkeypatch, events=[
        {"ts": FIXED_NOW, "symbol": "NESN.SW", "title": "Résultats",
         "link": "http://n/1", "sentiment": "pos"}])
    buy(c)

    body = graph_of(c)
    news = [n for n in body["nodes"] if n["type"] == "news"][0]
    assert "title_fr" not in news
    assert "src_lang" not in news


def test_graph_survives_the_translation_cache_being_unreadable(tmp_path, monkeypatch):
    """Un module de confort qui plante ne doit jamais faire tomber la toile :
    les nœuds ressortent, simplement pas enrichis."""
    c, _ = make_client(tmp_path, monkeypatch)
    graph_stubs(monkeypatch, events=[
        {"ts": FIXED_NOW, "symbol": "NESN.SW", "title": "Résultats",
         "link": "http://n/1", "sentiment": "pos"}])
    buy(c)

    def boom():
        raise ImportError("translate absent")

    monkeypatch.setattr(pr, "_translate", boom)
    body = graph_of(c)
    assert [n["type"] for n in body["nodes"] if n["type"] == "news"] == ["news"]


# ================================================================
#  LISTE COMPLÈTE D'UN BOSQUET (« +N autres » devient cliquable)
#
#  Doctrine : « quand on ouvre, on voit tout ». La toile garde ses douze
#  satellites par bosquet (lisibilité) ; la MASSE se lit en liste.
# ================================================================

def grove_of(client, kind):
    response = client.get("/api/paper/graph/grove?kind=%s" % kind)
    assert response.status_code == 200, response.text
    return response.json()


def _gov_events(count):
    """``count`` annonces politiques, espacées d'une minute (donc toutes dans
    la fenêtre de fraîcheur), la n° 0 étant la plus RÉCENTE."""
    base = datetime(2026, 8, 24, 9, 0, 0)
    return [{"ts": (base - timedelta(minutes=i)).isoformat(), "symbol": "GOV",
             "title": "Annonce %03d" % i, "link": "http://g/%03d" % i,
             "sentiment": "gov"} for i in range(count)]


def test_grove_lists_everything_the_canvas_left_out(tmp_path, monkeypatch):
    """40 annonces : la toile en dessine 12 et compte « +28 » ; la liste rend
    les 40. C'est LE point de la fonctionnalité (retour utilisateur du 26/08 :
    « +71 autres — non dessinés », et rien pour aller voir)."""
    c, _ = make_client(tmp_path, monkeypatch)
    graph_stubs(monkeypatch, events=_gov_events(40))
    buy(c)

    drawn = [n for n in graph_of(c)["nodes"] if n["type"] == "gov"]
    assert len(drawn) == 12

    body = grove_of(c, "monde")
    assert body["kind"] == "monde"
    assert body["total"] == 40
    assert len(body["items"]) == 40
    # Décroissant : la plus fraîche en tête, comme sur la toile.
    assert [item["label"] for item in body["items"]] == \
        ["Annonce %03d" % i for i in range(40)]
    # Un item porte tout ce que la liste affiche — rien à reconstituer.
    assert body["items"][0]["link"] == "http://g/000"
    assert body["items"][0]["sentiment"] == "gov"


def test_grove_serves_the_three_kinds(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    graph_stubs(
        monkeypatch,
        events=_gov_events(3),
        trends={"GME": {"count": 42, "prev": 3}, "TSLA": {"count": 9, "prev": 1}},
        hypotheses=[{"id": "h1", "status": "open", "created_at": FIXED_NOW,
                     "thesis": "Le cycle repart", "tickers": ["ZZZZ"]}])
    buy(c)

    world = grove_of(c, "monde")
    assert [item["type"] for item in world["items"]] == ["gov"] * 3

    crowd = grove_of(c, "foule")
    assert [item["id"] for item in crowd["items"]] == ["rt:GME", "rt:TSLA"]
    assert crowd["items"][0]["meta"] == {"count": 42, "prev": 3}

    radar = grove_of(c, "radar")
    assert radar["total"] == 1
    assert radar["items"][0]["status"] == "open"
    assert radar["items"][0]["meta"] == {"tickers": ["ZZZZ"]}


def test_grove_is_capped_at_150_but_says_the_real_total(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    graph_stubs(monkeypatch, events=_gov_events(175))
    buy(c)

    body = grove_of(c, "monde")
    assert len(body["items"]) == 150
    assert body["total"] == 175
    assert body["items"][0]["label"] == "Annonce 000"      # les plus récentes


@pytest.mark.parametrize("query", ["", "?kind=", "?kind=titres", "?kind=agg:monde",
                                   "?kind=NESN.SW"])
def test_grove_refuses_an_unknown_kind(tmp_path, monkeypatch, query):
    """Une liste vide se lirait « il n'y a rien » alors qu'on a mal demandé."""
    c, _ = make_client(tmp_path, monkeypatch)
    graph_stubs(monkeypatch)
    assert c.get("/api/paper/graph/grove" + query).status_code == 400


def test_grove_accepts_the_kind_whatever_its_case(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    graph_stubs(monkeypatch, events=_gov_events(2))
    assert grove_of(c, "MONDE")["kind"] == "monde"


def test_grove_survives_every_source_being_down(tmp_path, monkeypatch):
    """Best-effort par source, comme ``/graph`` : une liste partielle se lit,
    une erreur non."""
    c, _ = make_client(tmp_path, monkeypatch)

    def boom(*args, **kwargs):
        raise IOError("source injoignable")

    monkeypatch.setattr(pr, "_newswatch", lambda: FakeModule(recent_events=boom))
    monkeypatch.setattr(pr, "_radar", lambda: FakeModule(load_state=boom))
    monkeypatch.setattr(pr, "_whales", lambda: FakeModule(moves_summary=boom))
    monkeypatch.setattr(pr, "_pipeline_view", boom)
    buy(c)

    assert grove_of(c, "monde") == {"kind": "monde", "items": [], "total": 0}


def test_grove_survives_one_source_down_and_keeps_the_others(tmp_path, monkeypatch):
    """La presse tombe, le radar répond : le bosquet du radar reste servi."""
    c, _ = make_client(tmp_path, monkeypatch)

    def boom(*args, **kwargs):
        raise IOError("guetteur injoignable")

    monkeypatch.setattr(pr, "_newswatch", lambda: FakeModule(recent_events=boom))
    monkeypatch.setattr(pr, "_radar", lambda: FakeModule(load_state=lambda: {
        "hypotheses": [{"id": "h1", "status": "open", "created_at": FIXED_NOW,
                        "thesis": "Le pari tient", "tickers": ["ZZZZ"]}],
        "stats": {}}))
    monkeypatch.setattr(pr, "_whales", lambda: FakeModule(moves_summary=lambda: [],
                                                          recent_filing_events=lambda: []))
    buy(c)

    assert grove_of(c, "monde")["total"] == 0
    assert grove_of(c, "radar")["total"] == 1


def test_grove_omits_what_the_canvas_hangs_on_a_title(tmp_path, monkeypatch):
    """Ce qui touche une ancre est une BRANCHE, pas un bosquet : la liste se
    compose EXACTEMENT comme le dessin, sinon un item apparaîtrait dans l'une
    et pas dans l'autre — et ça passerait pour une perte de mémoire."""
    c, _ = make_client(tmp_path, monkeypatch)
    graph_stubs(monkeypatch, events=[
        {"ts": FIXED_NOW, "symbol": "NESN.SW", "title": "Tarifs sur Nestlé",
         "link": "http://g/9", "sentiment": "gov"},
        {"ts": FIXED_NOW, "symbol": "GOV", "title": "Tarifs acier",
         "link": "http://g/1", "sentiment": "gov"}])
    buy(c)

    assert [item["label"] for item in grove_of(c, "monde")["items"]] \
        == ["Tarifs acier"]


def test_grove_items_carry_a_cached_french_translation(tmp_path, monkeypatch):
    from backend.bots.paper import translate
    c, _ = make_client(tmp_path, monkeypatch)
    german_title = "Die Nestlé Bank warnt vor einem Rückgang"
    graph_stubs(monkeypatch, events=[
        {"ts": FIXED_NOW, "symbol": "GOV", "title": german_title,
         "link": "http://nzz.test/1", "sentiment": "gov"}])
    buy(c)
    translate.save_cache({"last_sweep_ts": None, "entries": {
        translate._title_key(german_title):
            {"fr": "La banque met en garde contre un recul",
             "src": "de", "ts": FIXED_NOW}}})

    body = grove_of(c, "monde")
    assert body["items"][0]["title_fr"] == "La banque met en garde contre un recul"
    assert body["items"][0]["src_lang"] == "DE"
    assert body["items"][0]["label"] == german_title


def test_grove_items_without_a_cache_hit_stay_intact(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    graph_stubs(monkeypatch, events=_gov_events(1))
    buy(c)

    item = grove_of(c, "monde")["items"][0]
    assert "title_fr" not in item
    assert "src_lang" not in item


# ================================================================
#  BALAYAGE FRAIS AU CLIC + AUTO-BACKFILL (extension 26/08)
#
#  « Quand le coach génère des idées, il se base sur ce qu'il a ET il peut
#  chercher plus profondément au-delà. » Deux portes réseau, toutes deux
#  best-effort, toutes deux injectables — donc testées hors ligne.
# ================================================================

def _gnews(*titles):
    """Un flux Google News RSS minimal, au format que ``backfill`` sait lire
    (titre + pubDate RFC822 — sans date, l'item est écarté à la source)."""
    from email.utils import format_datetime
    when = format_datetime(datetime(2026, 8, 23, 9, 0, 0))
    items = "".join(
        "<item><title><![CDATA[%s]]></title><link>https://n/%d</link>"
        "<pubDate>%s</pubDate></item>" % (title, i, when)
        for i, title in enumerate(titles))
    return ('<?xml version="1.0"?><rss version="2.0"><channel>'
            '<title>News</title>%s</channel></rss>') % items


class _SweepFetch:
    """Fetch RSS injectable : enregistre les URL, rend le flux demandé."""

    def __init__(self, xml=None, boom=False):
        self.urls = []
        self.xml = xml if xml is not None else _gnews("Nestlé beats estimates")
        self.boom = boom

    def __call__(self, url):
        self.urls.append(url)
        if self.boom:
            raise RuntimeError("Google News injoignable")
        return self.xml


def _wire_sweep(monkeypatch, fetch):
    """Réinstalle le VRAI balayage avec un fetch injecté et une horloge muette.
    Rend la liste des attentes demandées — c'est elle qui borne la latence."""
    slept = []
    monkeypatch.setattr(
        pr, "_fresh_sweep",
        lambda targets: _REAL_FRESH_SWEEP(targets, fetch=fetch,
                                          sleep=slept.append))
    return slept


# --- la CIBLE du balayage ---------------------------------------------------

def test_sweep_targets_put_the_anchors_first_then_the_crowd(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    buy(c)                                            # position NESN.SW
    store.save_watchlist("tester", [{"symbol": "AAPL", "name": "Apple Inc"}])
    monkeypatch.setattr(pr, "_reddit_trends",
                        lambda: {"GME": {"count": 42}, "AMC": {"count": 7}})

    targets = pr._sweep_targets("tester")
    assert [t["symbol"] for t in targets] == ["NESN.SW", "AAPL", "GME", "AMC"]
    # Seule la watchlist porte un NOM — et c'est le nom qui fait la requête.
    assert {t["symbol"]: t["name"] for t in targets}["AAPL"] == "Apple Inc"
    assert {t["symbol"]: t["name"] for t in targets}["NESN.SW"] == ""


def test_sweep_targets_are_capped_at_six(tmp_path, monkeypatch):
    """Un endpoint interactif attend : six symboles, une requête chacun."""
    c, _ = make_client(tmp_path, monkeypatch)
    store.save_watchlist("tester", [{"symbol": "SYM%d" % i} for i in range(10)])
    monkeypatch.setattr(pr, "_reddit_trends", lambda: {"GME": {"count": 99}})

    targets = pr._sweep_targets("tester")
    assert len(targets) == pr.SWEEP_MAX_SYMBOLS
    # Les ancres d'abord : un gros portefeuille consomme tout le budget, et le
    # balayage reste alors sur ce que Massii détient vraiment.
    assert [t["symbol"] for t in targets] == ["SYM%d" % i for i in range(6)]


def test_a_ticker_with_no_mention_is_not_a_trend(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    monkeypatch.setattr(pr, "_reddit_trends", lambda: {"GME": {"count": 0}})
    assert pr._sweep_targets("tester") == []


def test_sweep_targets_survive_a_broken_portfolio(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    store.save_watchlist("tester", [{"symbol": "AAPL", "name": "Apple Inc"}])

    def boom(username):
        raise ValueError("portefeuille illisible")

    monkeypatch.setattr(pr, "_load", boom)
    assert [t["symbol"] for t in pr._sweep_targets("tester")] == ["AAPL"]


# --- le BALAYAGE lui-même ---------------------------------------------------

def test_the_sweep_collects_headlines_and_momentum(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    market.candles["NESN.SW"] = [{"ts": _ts(10) - 8 * 86400, "close": 100.0},
                                 {"ts": _ts(10), "close": 110.0}]
    fetch = _SweepFetch(_gnews("Nestlé beats estimates", "Nestlé opens a plant"))

    out = _REAL_FRESH_SWEEP([{"symbol": "NESN.SW", "name": "Nestlé S.A."}],
                            fetch=fetch, sleep=lambda s: None)

    assert out["fenetre_jours"] == 7 and out["fait_a"] == FIXED_NOW
    titles = out["titres"]["NESN.SW"]
    assert [row["title"] for row in titles] == ["Nestlé beats estimates",
                                                "Nestlé opens a plant"]
    # Sentiment posé par le MÊME classifieur que les archives (``newswatch``),
    # et le titre neutre garde sa place — c'est la base sur laquelle le reste
    # se détache.
    assert [row["sentiment"] for row in titles] == ["pos", "neutre"]
    assert out["momentum"]["NESN.SW"] == {"prix": 110.0, "pct_7j": 10.0}
    # La requête part sur le NOM sans sa forme juridique, bornée en date.
    assert "Nestl" in fetch.urls[0] and "after%3A" in fetch.urls[0]


def test_the_sweep_keeps_an_empty_list_apart_from_a_missing_symbol(tmp_path,
                                                                   monkeypatch):
    """« Rien de neuf sur sept jours » est une information — et le prompt
    l'explique au modèle. Elle ne doit donc pas se confondre avec un silence."""
    c, _ = make_client(tmp_path, monkeypatch)
    out = _REAL_FRESH_SWEEP([{"symbol": "NESN.SW", "name": "Nestlé"}],
                            fetch=_SweepFetch(_gnews()), sleep=lambda s: None)
    assert out["titres"] == {"NESN.SW": []}


def test_the_sweep_paces_its_requests_and_bounds_its_latency(tmp_path, monkeypatch):
    """Piège #67 : un burst vaut un 429. Une attente ENTRE deux symboles, donc
    n-1 attentes — et la latence ajoutée reste bornée par le cap de symboles."""
    c, _ = make_client(tmp_path, monkeypatch)
    slept = []
    targets = [{"symbol": "SYM%d" % i, "name": "Nom %d" % i} for i in range(6)]
    fetch = _SweepFetch()

    _REAL_FRESH_SWEEP(targets, fetch=fetch, sleep=slept.append)

    assert len(fetch.urls) == 6                       # UNE requête par symbole
    assert slept == [pr.SWEEP_PACE_S] * 5
    assert sum(slept) <= (pr.SWEEP_MAX_SYMBOLS - 1) * pr.SWEEP_PACE_S


def test_a_mute_source_costs_its_line_not_the_sweep(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    market.candles["NESN.SW"] = [{"ts": _ts(9), "close": 100.0},
                                 {"ts": _ts(10), "close": 100.0}]
    calls = {"n": 0}

    def flaky(url):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("timeout")
        return _gnews("Apple beats estimates")

    out = _REAL_FRESH_SWEEP([{"symbol": "NESN.SW", "name": "Nestlé"},
                             {"symbol": "AAPL", "name": "Apple"}],
                            fetch=flaky, sleep=lambda s: None)
    assert "NESN.SW" not in out["titres"] and "AAPL" in out["titres"]
    assert "NESN.SW" in out["momentum"]                # le cours, lui, a répondu


def test_a_total_outage_yields_no_key_at_all(tmp_path, monkeypatch):
    """Best-effort intégral : rien récolté -> ``{}`` -> clé ABSENTE du contexte,
    et le prompt n'annonce pas une section vide."""
    c, _ = make_client(tmp_path, monkeypatch)
    monkeypatch.setattr(quotes, "get_candles",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("hs")))
    out = _REAL_FRESH_SWEEP([{"symbol": "NESN.SW", "name": "Nestlé"}],
                            fetch=_SweepFetch(boom=True), sleep=lambda s: None)
    assert out == {}


def test_the_sweep_on_nothing_asks_nothing(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    fetch = _SweepFetch()
    assert _REAL_FRESH_SWEEP([], fetch=fetch, sleep=lambda s: None) == {}
    assert fetch.urls == []


@pytest.mark.parametrize("candles,expected", [
    ([], None),                                        # rien
    ([{"ts": 0, "close": 100.0}], None),               # un seul point
    ([{"ts": 0, "close": 0.0}, {"ts": 1, "close": 5.0}], None),   # base nulle
])
def test_the_seven_day_change_refuses_to_invent_a_number(candles, expected):
    assert pr._pct_over_days(candles, 7, _ts(10)) is expected


def test_the_seven_day_change_uses_the_last_close_before_the_boundary():
    """Sept jours calendaires ne tombent pas sur une séance : on prend la
    clôture la plus récente ANTÉRIEURE à la borne, pas une date exacte."""
    now = _ts(10)
    candles = [{"ts": now - 30 * 86400, "close": 50.0},
               {"ts": now - 8 * 86400, "close": 100.0},   # la référence
               {"ts": now - 2 * 86400, "close": 105.0},
               {"ts": now, "close": 120.0}]
    assert pr._pct_over_days(candles, 7, now) == 20.0


# --- le PROMPT --------------------------------------------------------------

def test_the_fresh_sweep_reaches_the_ideas_prompt(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    buy(c)
    market.candles["NESN.SW"] = [{"ts": _ts(9), "close": 100.0},
                                 {"ts": _ts(10), "close": 101.0}]
    _wire_sweep(monkeypatch, _SweepFetch(_gnews("Nestlé beats estimates")))

    seen = {}

    def spy(context, lang="fr", risk_level="mesure", journal=None):
        seen["context"] = context
        from backend.bots.paper import llm as llm_mod
        seen["prompt"] = llm_mod.build_ideas_prompt(context, lang, risk_level,
                                                    journal)
        return _ideas_json()

    monkeypatch.setattr(pr.llm, "suggest_ideas", spy)
    assert c.post("/api/paper/ideas?sync=1", json={}).status_code == 200

    sweep = seen["context"]["recherche_fraiche"]
    assert sweep["titres"]["NESN.SW"][0]["title"] == "Nestlé beats estimates"
    assert "RECHERCHE À L'INSTANT" in seen["prompt"]
    assert "Appuie-toi D'ABORD sur la MÉMOIRE" in seen["prompt"]


def test_the_fresh_sweep_reaches_the_scenarios_prompt(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    buy(c)
    _wire_sweep(monkeypatch, _SweepFetch(_gnews("Nestlé beats estimates")))

    seen = {}

    def spy(context, lang="fr"):
        from backend.bots.paper import llm as llm_mod
        seen["prompt"] = llm_mod.build_scenarios_prompt(context, lang)
        return scenarios_answer()

    monkeypatch.setattr(pr.llm, "suggest_scenarios", spy)
    assert c.post("/api/paper/board/scenarios/generate?sync=1",
                  json={}).status_code == 200
    assert "RECHERCHE À L'INSTANT" in seen["prompt"]


def test_a_sweep_outage_still_calls_the_model_without_the_key(tmp_path, monkeypatch):
    """La règle qui compte : une panne de recherche ne coûte JAMAIS la réponse."""
    c, _ = make_client(tmp_path, monkeypatch)
    buy(c)
    monkeypatch.setattr(quotes, "get_candles",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("hs")))
    _wire_sweep(monkeypatch, _SweepFetch(boom=True))

    seen = {}

    def spy(context, lang="fr", risk_level="mesure", journal=None):
        seen["context"] = context
        from backend.bots.paper import llm as llm_mod
        seen["prompt"] = llm_mod.build_ideas_prompt(context, lang, risk_level,
                                                    journal)
        return _ideas_json()

    monkeypatch.setattr(pr.llm, "suggest_ideas", spy)
    assert c.post("/api/paper/ideas?sync=1", json={}).status_code == 200
    assert "recherche_fraiche" not in seen["context"]
    assert "RECHERCHE À L'INSTANT" not in seen["prompt"]


# --- AUTO-BACKFILL des tickers choisis --------------------------------------

def _collect_spy(monkeypatch, boom=None):
    """Espionne ``backfill.backfill_symbol`` — aucune requête réelle."""
    from backend.bots.paper import backfill
    calls = []

    def fake(symbol, name=None, now=None, fetch=None, sleep=None, force=False):
        calls.append({"symbol": symbol, "name": name})
        if boom and symbol in boom:
            raise RuntimeError("Google News injoignable")
        return {"symbol": symbol, "reason": "collected", "windows": 4}

    monkeypatch.setattr(backfill, "backfill_symbol", fake)
    return calls


def test_the_coach_curiosity_feeds_its_own_base(tmp_path, monkeypatch):
    """Doctrine : un titre que le coach vient de choisir et sur lequel on n'a
    aucun recul est collecté TOUT DE SUITE — la prochaine fois qu'on en parlera,
    on aura douze mois derrière."""
    c, market = make_client(tmp_path, monkeypatch)
    market.prices["AAPL"] = (200.0, "USD", "Apple Inc")
    calls = _collect_spy(monkeypatch)
    monkeypatch.setattr(pr, "_backfill_new_tickers", _REAL_BACKFILL_NEW)

    monkeypatch.setattr(
        pr.llm, "suggest_ideas",
        lambda context, lang="fr", risk_level="mesure", journal=None: _ideas_json(
            {"ticker": "AAPL", "direction": "up", "horizon_days": 10,
             "thesis": "Momentum"}))
    assert c.post("/api/paper/ideas?sync=1", json={}).status_code == 200

    # Le NOM fait la requête (piège #29a) : il vient de la cotation, pas du ticker.
    assert calls == [{"symbol": "AAPL", "name": "Apple Inc"}]


def test_the_auto_backfill_is_capped_at_two_per_answer(tmp_path, monkeypatch):
    """Une collecte coûte 4 requêtes espacées de 1,1 s, AJOUTÉES à une réponse
    déjà payée. Les autres reviendront au prochain clic."""
    c, _ = make_client(tmp_path, monkeypatch)
    calls = _collect_spy(monkeypatch)
    ideas = [{"ticker": "SYM%d" % i} for i in range(5)]

    done = _REAL_BACKFILL_NEW(ideas)

    assert done == ["SYM0", "SYM1"]
    assert [call["symbol"] for call in calls] == ["SYM0", "SYM1"]
    assert pr.IDEAS_BACKFILL_MAX == 2


def test_a_ticker_that_already_has_a_folder_is_not_recollected(tmp_path, monkeypatch):
    from backend.bots.paper import backfill
    c, _ = make_client(tmp_path, monkeypatch)
    state = backfill.blank_state()
    state["symbols"]["AAPL"] = {"name": "Apple Inc", "fetched_at": FIXED_NOW,
                                "windows": []}
    backfill.save_state(state)
    calls = _collect_spy(monkeypatch)

    assert _REAL_BACKFILL_NEW([{"ticker": "AAPL"}, {"ticker": "TSLA"}]) == ["TSLA"]
    assert [call["symbol"] for call in calls] == ["TSLA"]


def test_a_failed_collection_never_costs_the_answer(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    calls = _collect_spy(monkeypatch, boom={"SYM0"})
    assert _REAL_BACKFILL_NEW([{"ticker": "SYM0"}, {"ticker": "SYM1"}]) == ["SYM1"]
    assert len(calls) == 2                             # la panne n'arrête pas la suite


def test_the_auto_backfill_ignores_a_deformed_ideas_block(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    calls = _collect_spy(monkeypatch)
    assert _REAL_BACKFILL_NEW([None, "texte", {}, {"ticker": ""}]) == []
    assert calls == []


def test_a_deformed_trend_state_costs_discovery_not_the_answer(tmp_path,
                                                               monkeypatch):
    """Un compteur non numérique dans l'état de la foule ne doit pas faire
    tomber ``/ideas`` : il coûte la découverte, jamais la réponse."""
    c, _ = make_client(tmp_path, monkeypatch)
    store.save_watchlist("tester", [{"symbol": "AAPL", "name": "Apple Inc"}])
    monkeypatch.setattr(pr, "_reddit_trends",
                        lambda: {"GME": {"count": "beaucoup"},
                                 "AMC": {"count": 12}})
    assert [t["symbol"] for t in pr._sweep_targets("tester")] == ["AAPL", "AMC"]


# ================================================================
#  AGENDA MACRO (W2b) — les rendez-vous DATÉS dans le contexte du coach
#
#  « Un catalyseur DATÉ vaut plus qu'une rumeur » : la moitié du contexte est
#  faite de dépêches dont le coach ne peut pas dire QUAND elles produiront un
#  effet. Ces dates-là, si.
# ================================================================

AGENDA_ROWS = [
    {"date": "2026-08-28", "bank": "Fed",
     "label": "Fed — riunione del FOMC (27-28 agosto)",
     "source_url": "https://fed.test/cal"},
    {"date": "2026-09-10", "bank": "BCE",
     "label": "BCE — riunione di politica monetaria (decisione)",
     "source_url": "https://ecb.test/cal"},
]


def _agenda_double(monkeypatch, rows):
    """Réinstalle le VRAI ``_agenda_macro`` (que ``make_client`` neutralise) en
    doublant le PONT dessous — ainsi la mise en forme du contexte est bien
    celle du router, et non celle du test."""
    from backend.bots.paper import agenda_bridge
    monkeypatch.setattr(agenda_bridge, "upcoming_events", lambda **kw: list(rows))
    monkeypatch.setattr(pr, "_agenda_macro", _REAL_AGENDA_MACRO)


def test_the_agenda_reaches_the_ideas_and_scenarios_context(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    _agenda_double(monkeypatch, AGENDA_ROWS)
    seen = {}
    monkeypatch.setattr(pr.llm, "suggest_ideas",
                        lambda context, lang="fr", risk_level="mesure", journal=None:
                        seen.__setitem__("ideas", dict(context))
                        or '```json\n{"ideas": []}\n```')
    monkeypatch.setattr(pr.llm, "suggest_scenarios",
                        lambda context, lang="fr":
                        seen.__setitem__("scenarios", dict(context))
                        or scenarios_answer())
    c.post("/api/paper/ideas?sync=1", json={})
    c.post("/api/paper/board/scenarios/generate?sync=1", json={})

    for key in ("ideas", "scenarios"):
        agenda = seen[key]["agenda_macro"]
        assert [r["date"] for r in agenda["rendez_vous"]] == ["2026-08-28",
                                                              "2026-09-10"]
        assert agenda["consigne"] == pr.AGENDA_CONSIGNE


def test_the_agenda_reaches_the_review_factpack(tmp_path, monkeypatch):
    """Garder une position jusqu'à la veille d'une réunion de banque centrale,
    ce n'est pas la même décision qu'un mois ordinaire : la revue doit voir ce
    que la position va TRAVERSER."""
    c, _ = make_client(tmp_path, monkeypatch)
    buy(c, qty=10)
    _agenda_double(monkeypatch, AGENDA_ROWS)
    seen = _review_double(monkeypatch)

    c.post("/api/paper/positions/review?sync=1", json={})
    agenda = seen["context"]["agenda_macro"]
    assert agenda["rendez_vous"][0]["bank"] == "Fed"
    assert agenda["consigne"] == pr.AGENDA_CONSIGNE


def test_the_consigne_says_a_dated_catalyst_beats_a_rumour():
    """La consigne voyage AVEC les dates (le bloc ``CONTEXTE`` est sérialisé en
    entier vers le modèle) : elle ne peut donc pas se désynchroniser de la
    donnée qu'elle commente."""
    assert "catalyseur DATÉ" in pr.AGENDA_CONSIGNE
    assert "construis autour" in pr.AGENDA_CONSIGNE
    # ...et elle interdit la prévision de sens : une date est un fait, pas une
    # direction.
    assert "jamais dans quel sens" in pr.AGENDA_CONSIGNE


def test_an_empty_agenda_adds_no_key_at_all(tmp_path, monkeypatch):
    """Décrire au modèle une section VIDE, c'est l'inviter à la remplir tout
    seul (même règle que ``llm._sweep_line`` pour la recherche fraîche)."""
    c, _ = make_client(tmp_path, monkeypatch)
    _agenda_double(monkeypatch, [])
    seen = {}
    monkeypatch.setattr(pr.llm, "suggest_ideas",
                        lambda context, lang="fr", risk_level="mesure", journal=None:
                        seen.__setitem__("ideas", dict(context))
                        or '```json\n{"ideas": []}\n```')
    c.post("/api/paper/ideas?sync=1", json={})
    assert "agenda_macro" not in seen["ideas"]


def test_a_broken_agenda_never_breaks_an_answer(tmp_path, monkeypatch):
    from backend.bots.paper import agenda_bridge
    c, _ = make_client(tmp_path, monkeypatch)

    def boom(**kwargs):
        raise RuntimeError("banques centrales injoignables")

    monkeypatch.setattr(agenda_bridge, "upcoming_events", boom)
    monkeypatch.setattr(pr, "_agenda_macro", _REAL_AGENDA_MACRO)
    assert pr._agenda_macro() == {}
    assert c.post("/api/paper/ideas?sync=1", json={}).status_code == 200


def test_the_agenda_costs_no_network_when_the_module_is_missing(monkeypatch):
    """Déploiement partiel : le pont absent coûte l'agenda, jamais le contexte.

    Le faux ``__import__`` COMPTE ses interceptions — sans ce compteur, le test
    passerait aussi bien si le filtre ne matchait rien (l'appel réel rendrait
    ``{}`` un jour de calendrier vide) et on croirait avoir vérifié le repli.
    """
    import builtins
    real_import = builtins.__import__
    blocked = []

    def no_bridge(name, glob=None, loc=None, fromlist=(), level=0):
        if name.endswith("agenda_bridge") or "agenda_bridge" in (fromlist or ()):
            blocked.append(name)
            raise ImportError("pas déployé")
        return real_import(name, glob, loc, fromlist, level)

    monkeypatch.setattr(builtins, "__import__", no_bridge)
    assert _REAL_AGENDA_MACRO() == {}
    assert blocked == ["backend.bots.paper"]


# ================================================================
#  TRAVAUX DÉTACHÉS (27/08) — les six appels au modèle ne tiennent
#  plus la requête HTTP
#
#  Incident : 60-90 s en ligne à travers le tunnel Cloudflare (qui coupe vers
#  100 s) -> le moindre hoquet réseau rendait un 502 alors que le travail avait
#  bien eu lieu. Le POST rend maintenant un accusé, le client relève.
# ================================================================

def _await_job(client, job_id, tries=200):
    """Relève le travail jusqu'à ce qu'il ne soit plus ``pending``.

    Les fils sont réels (pas de doublure) : c'est justement ce qu'on veut
    vérifier. Ils ne font qu'appeler un LLM doublé, donc la boucle rend la main
    en quelques itérations — mais on la BORNE, un test qui tourne à l'infini
    sur une régression ne dit rien à personne.
    """
    for _ in range(tries):
        response = client.get("/api/paper/job/%s" % job_id)
        assert response.status_code == 200, response.text
        body = response.json()
        if body["status"] != "pending":
            return body
        time.sleep(0.01)
    raise AssertionError("le travail %s n'a jamais fini" % job_id)


def test_the_six_llm_endpoints_answer_with_a_job_ticket(tmp_path, monkeypatch):
    """DÉTACHÉ PAR DÉFAUT : c'est le point du lot. Un POST rend un accusé
    immédiat, pas le résultat."""
    c, _ = make_client(tmp_path, monkeypatch)
    buy(c)
    calls = [
        ("/api/paper/coach/ask", {"question": "et ma taille ?"}),
        ("/api/paper/analysis", {"symbol": "NESN.SW"}),
        ("/api/paper/postmortem", {}),
        ("/api/paper/ideas", {}),
        ("/api/paper/positions/review", {}),
        ("/api/paper/board/scenarios/generate", {}),
    ]
    for url, payload in calls:
        body = c.post(url, json=payload).json()
        assert list(body) == ["job"], url
        assert isinstance(body["job"], str) and len(body["job"]) == 32, url


def test_a_detached_job_carries_the_exact_former_payload(tmp_path, monkeypatch):
    """``result`` est EXACTEMENT ce que l'endpoint rendait avant ce lot : le
    client ne doit pas avoir deux façons de lire la même réponse."""
    c, _ = make_client(tmp_path, monkeypatch)
    job = c.post("/api/paper/coach/ask", json={"question": "et ma taille ?"}).json()["job"]
    detached = _await_job(c, job)
    assert detached["status"] == "done"
    assert detached["result"] == {"answer": "Ta taille est le sujet."}

    inline = c.post("/api/paper/coach/ask?sync=1", json={"question": "idem"}).json()
    assert detached["result"] == inline


def test_a_detached_job_really_does_the_side_effects(tmp_path, monkeypatch):
    """Le travail écrit le journal, le pipeline et le radar DANS le fil — c'est
    tout l'intérêt de le détacher, pas seulement de rendre la main plus vite."""
    c, _ = make_client(tmp_path, monkeypatch)
    monkeypatch.setattr(pr.llm, "suggest_ideas",
                        lambda context, lang="fr", risk_level="mesure", journal=None:
                        '```json\n{"ideas": [{"ticker": "NESN.SW",'
                        ' "thesis": "le café renchérit", "direction": "up"}]}\n```')

    job = c.post("/api/paper/ideas", json={}).json()["job"]
    body = _await_job(c, job)

    assert body["status"] == "done"
    assert body["result"]["ideas"][0]["tracked"] is True
    # ...et les trois mémoires ont bien été écrites depuis le fil.
    assert c.get("/api/paper/ideas/journal").json()["entries"][0]["kind"] == "ideas"
    assert [r["symbol"] for r in c.get("/api/paper/board").json()["pipeline"]] \
        == ["NESN.SW"]
    assert c.get("/api/paper/radar").json()["hypotheses"][0]["source"] == "coach"


def test_a_llm_outage_inside_a_job_keeps_its_502(tmp_path, monkeypatch):
    """Une ``HTTPException`` levée dans le travail n'est pas perdue : un 502
    « le coach n'a pas répondu » doit rester un 502, pas devenir un 500
    anonyme. La RELÈVE, elle, est un 200 — c'est elle qui a réussi."""
    c, _ = make_client(tmp_path, monkeypatch)

    def boom(context, question, lang="fr"):
        raise RuntimeError("le coach est muet")

    monkeypatch.setattr(pr.llm, "ask_coach", boom)
    job = c.post("/api/paper/coach/ask", json={"question": "?"}).json()["job"]
    body = _await_job(c, job)
    assert body == {"status": "error", "error": "le coach est muet", "code": 502}


def test_a_business_refusal_inside_a_job_keeps_its_400(tmp_path, monkeypatch):
    """Même règle pour les refus MÉTIER : « aucune position à passer en revue »
    est un 400, il le reste à travers le fil."""
    c, _ = make_client(tmp_path, monkeypatch)
    job = c.post("/api/paper/positions/review", json={}).json()["job"]
    body = _await_job(c, job)
    assert body["status"] == "error" and body["code"] == 400
    assert "Aucune position" in body["error"]


def test_an_unexpected_crash_inside_a_job_is_a_500_not_a_stuck_pending(tmp_path,
                                                                      monkeypatch):
    """Une exception qui remonterait d'un fil ne serait vue de personne et le
    travail resterait ``pending`` À VIE. ``_run_job`` n'explose jamais."""
    c, _ = make_client(tmp_path, monkeypatch)

    def boom(facts, lang="fr"):
        raise ValueError("bug inattendu")

    monkeypatch.setattr(pr.llm, "write_analysis", boom)
    job = c.post("/api/paper/analysis", json={"symbol": "NESN.SW"}).json()["job"]
    body = _await_job(c, job)
    assert body == {"status": "error", "error": "bug inattendu", "code": 500}


def test_an_unknown_job_is_a_404(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert c.get("/api/paper/job/pas-un-travail").status_code == 404


def test_a_job_of_another_account_is_a_404_never_a_403(tmp_path, monkeypatch):
    """404 et pas 403 : répondre « interdit » confirmerait qu'il existe. Le
    résultat porte un portefeuille — deux verrous valent mieux qu'un."""
    c, _ = make_client(tmp_path, monkeypatch)
    job = c.post("/api/paper/analysis", json={"symbol": "NESN.SW"}).json()["job"]
    _await_job(c, job)
    c.app.dependency_overrides[get_current_user] = \
        lambda: FakeUser("money", username="bob")
    assert c.get("/api/paper/job/%s" % job).status_code == 404


def test_the_job_relay_is_closed_to_the_player_role(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch, role="player")
    assert c.get("/api/paper/job/x").status_code == 403


def test_a_pending_job_says_pending_and_nothing_else(tmp_path, monkeypatch):
    """Le contrat de la relève : trois formes, et ``pending`` n'en porte
    aucune autre clé (un ``result: null`` se lirait « fini, sans réponse »)."""
    c, _ = make_client(tmp_path, monkeypatch)
    started, release = threading.Event(), threading.Event()

    def slow(facts, lang="fr"):
        started.set()
        release.wait(5)
        return "Fiche du titre."

    monkeypatch.setattr(pr.llm, "write_analysis", slow)
    job = c.post("/api/paper/analysis", json={"symbol": "NESN.SW"}).json()["job"]
    assert started.wait(5)
    assert c.get("/api/paper/job/%s" % job).json() == {"status": "pending"}
    release.set()
    assert _await_job(c, job)["status"] == "done"


def test_expired_jobs_are_purged_at_the_next_creation(tmp_path, monkeypatch):
    """Purge à la CRÉATION : pas de tâche de fond à surveiller pour ça."""
    c, _ = make_client(tmp_path, monkeypatch)
    old = c.post("/api/paper/analysis", json={"symbol": "NESN.SW"}).json()["job"]
    _await_job(c, old)

    with pr._JOBS_LOCK:
        pr._JOBS[old]["created"] -= pr.JOB_TTL_S + 1
    fresh = c.post("/api/paper/analysis", json={"symbol": "NESN.SW"}).json()["job"]
    _await_job(c, fresh)

    assert c.get("/api/paper/job/%s" % old).status_code == 404
    assert c.get("/api/paper/job/%s" % fresh).status_code == 200


def test_a_job_purged_mid_flight_does_not_resurrect(tmp_path, monkeypatch):
    """Le fil qui finit APRÈS la purge ne ressuscite pas son entrée : sinon un
    travail périmé reviendrait dans le registre sans date de création tenable."""
    c, _ = make_client(tmp_path, monkeypatch)
    started, release = threading.Event(), threading.Event()

    def slow(facts, lang="fr"):
        started.set()
        release.wait(5)
        return "Fiche du titre."

    monkeypatch.setattr(pr.llm, "write_analysis", slow)
    job = c.post("/api/paper/analysis", json={"symbol": "NESN.SW"}).json()["job"]
    assert started.wait(5)
    with pr._JOBS_LOCK:
        pr._JOBS.pop(job)
    release.set()
    time.sleep(0.2)
    with pr._JOBS_LOCK:
        assert job not in pr._JOBS


def test_sync_keeps_the_former_inline_behaviour(tmp_path, monkeypatch):
    """``?sync=1`` = la porte de sortie : le résultat, pas un accusé. C'est ce
    mode que la suite existante utilise (86 appels bascules d'un coup)."""
    c, _ = make_client(tmp_path, monkeypatch)
    body = c.post("/api/paper/analysis?sync=1", json={"symbol": "NESN.SW"}).json()
    assert body["analysis"] == "Fiche du titre."
    assert "job" not in body


def test_sync_still_raises_its_http_errors_in_line(tmp_path, monkeypatch):
    """En mode en ligne, un 502 reste un 502 HTTP — on n'a pas déplacé les
    erreurs dans le corps de la réponse pour tout le monde."""
    c, _ = make_client(tmp_path, monkeypatch)

    def boom(facts, lang="fr"):
        raise RuntimeError("le coach est muet")

    monkeypatch.setattr(pr.llm, "write_analysis", boom)
    response = c.post("/api/paper/analysis?sync=1", json={"symbol": "NESN.SW"})
    assert response.status_code == 502


def test_two_concurrent_jobs_never_lose_a_journal_entry(tmp_path, monkeypatch):
    """LE test du verrou. ``idea_journal.append_entry`` relit tout le journal,
    ajoute en tête et réécrit — et nomme son temporaire d'après le seul PID.
    Deux travaux détachés qui finissent ensemble ne perdaient pas seulement une
    entrée : ils écrivaient dans le MÊME fichier temporaire.

    La barrière force le chevauchement : sans verrou dans le router, les deux
    fils lisent le journal vide en même temps et le second écrase le premier.
    """
    c, _ = make_client(tmp_path, monkeypatch)
    barrier = threading.Barrier(2, timeout=5)

    def rendezvous(context, lang="fr", risk_level="mesure", journal=None):
        barrier.wait()          # les deux fils sortent du modèle ENSEMBLE
        return '```json\n{"ideas": []}\n```'

    monkeypatch.setattr(pr.llm, "suggest_ideas", rendezvous)
    jobs = [c.post("/api/paper/ideas", json={}).json()["job"] for _ in range(2)]
    for job in jobs:
        assert _await_job(c, job)["status"] == "done"

    entries = c.get("/api/paper/ideas/journal").json()["entries"]
    assert len(entries) == 2


def test_two_concurrent_jobs_never_lose_a_radar_hypothesis(tmp_path, monkeypatch):
    """Même barrière sur l'état du RADAR : un lire-modifier-réécrire qui
    s'entrelace perdrait un lot d'idées ET fausserait le décompte de
    ``MAX_OPEN``."""
    c, _ = make_client(tmp_path, monkeypatch)
    barrier = threading.Barrier(2, timeout=5)
    tickers = iter(["NESN.SW", "AAPL"])

    def rendezvous(context, lang="fr", risk_level="mesure", journal=None):
        ticker = next(tickers)
        barrier.wait()
        return ('```json\n{"ideas": [{"ticker": "%s", "thesis": "une thèse",'
                ' "direction": "up"}]}\n```' % ticker)

    monkeypatch.setattr(pr.llm, "suggest_ideas", rendezvous)
    for job in [c.post("/api/paper/ideas", json={}).json()["job"] for _ in range(2)]:
        assert _await_job(c, job)["status"] == "done"

    hypotheses = c.get("/api/paper/radar").json()["hypotheses"]
    assert sorted(h["tickers"][0] for h in hypotheses) == ["AAPL", "NESN.SW"]


def test_the_write_lock_is_reentrant(tmp_path, monkeypatch):
    """``_sync_coach`` appelle ``_append_journal``, qui prend le même verrou.
    Avec un ``Lock`` simple, ce chemin s'auto-bloquerait — au premier jalon
    atteint, donc jamais en test et toujours en production."""
    assert isinstance(pr._WRITE_LOCK, type(threading.RLock()))
    with pr._WRITE_LOCK:
        with pr._WRITE_LOCK:
            pass


def test_the_backfill_lock_is_separate_from_the_write_lock(tmp_path):
    """Deux verrous DISTINCTS et jamais imbriqués : la collecte des dossiers
    fait du réseau (secondes) avant d'écrire, la mettre sous le verrou des
    écritures rapides sérialiserait deux travaux pour rien."""
    assert pr._BACKFILL_LOCK is not pr._WRITE_LOCK


# ================================================================
#  LE JOURNAL DES CONVERGENCES, CLIQUABLE (27/08)
#
#  « La liste des convergences dites sur Telegram ; je clique -> toutes les
#  infos dites et les liens entre. »
# ================================================================

def _digest_history(monkeypatch, entries):
    """Une convergence dont l'état porte ``entries`` — le VRAI module pour le
    dessin (``entry_graph`` est pur), l'état seul étant doublé."""
    from backend.bots.paper import convergence
    module = FakeModule(recent=lambda: {"history": list(entries)},
                        load_state=lambda: {"history": list(entries)},
                        entry_graph=convergence.entry_graph)
    monkeypatch.setattr(pr, "_convergence", lambda: module)


ENTRY_WITH_ITEMS = {
    "ts": "2026-08-24T12:00:00", "factors": ["gov", "held_catalyst"],
    "n_items": 2, "digest": "…", "llm": True,
    "items": [
        {"src": "gov", "id": "http://x.test/g", "title": "Droits de douane",
         "symbol": "GOV", "sentiment": "gov", "link": "http://x.test/g"},
        {"src": "news", "id": "http://x.test/n", "title": "Le fret bondit",
         "symbol": "NESN.SW", "sentiment": "neg", "link": "http://x.test/n"},
    ],
}


def test_the_digest_list_carries_its_items(tmp_path, monkeypatch):
    """``/digest`` sert l'entrée TELLE QUELLE : les items voyagent sans que
    l'endpoint ait à les recopier (c'est ce qui rend la liste cliquable)."""
    c, _ = make_client(tmp_path, monkeypatch)
    _digest_history(monkeypatch, [ENTRY_WITH_ITEMS])
    entry = c.get("/api/paper/digest").json()["history"][0]
    assert [i["title"] for i in entry["items"]] == ["Droits de douane",
                                                    "Le fret bondit"]


def test_digest_list_items_carry_a_cached_french_translation(tmp_path, monkeypatch):
    """C'est CETTE liste (``_convItem`` côté frontend) qui affiche « les
    éléments un par un » du journal des convergences -- celle qu'un titre
    allemand rendrait illisible."""
    from backend.bots.paper import translate
    c, _ = make_client(tmp_path, monkeypatch)
    german_title = "Die Nestlé Bank warnt vor einem Rückgang"
    entry = {
        "ts": "2026-08-24T12:00:00", "factors": ["gov"], "n_items": 1,
        "digest": "…", "llm": True,
        "items": [{"src": "pressefi", "id": "http://nzz.test/1",
                  "title": german_title, "symbol": "NESN.SW",
                  "sentiment": "neg", "link": "http://nzz.test/1"}],
    }
    _digest_history(monkeypatch, [entry])
    translate.save_cache({"last_sweep_ts": None, "entries": {
        translate._title_key(german_title):
            {"fr": "La banque met en garde contre un recul",
             "src": "de", "ts": FIXED_NOW}}})

    item = c.get("/api/paper/digest").json()["history"][0]["items"][0]
    assert item["title_fr"] == "La banque met en garde contre un recul"
    assert item["src_lang"] == "DE"
    assert item["title"] == german_title           # l'original ne bouge JAMAIS


def test_digest_list_items_without_a_cache_hit_stay_intact(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    _digest_history(monkeypatch, [ENTRY_WITH_ITEMS])
    item = c.get("/api/paper/digest").json()["history"][0]["items"][0]
    assert "title_fr" not in item
    assert "src_lang" not in item


def test_a_digest_entry_opens_on_its_own_mini_graph(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    _digest_history(monkeypatch, [ENTRY_WITH_ITEMS])

    body = c.get("/api/paper/digest/0/graph").json()
    assert body["ts"] == "2026-08-24T12:00:00"
    assert body["factors"] == ["gov", "held_catalyst"]
    assert body["n_items"] == 2 and body["legacy"] is False
    # L'ancre du seul VRAI titre, plus les deux pièces. « GOV » n'est pas un
    # titre : il n'ouvre pas d'ancre (il resterait un faux centre au milieu).
    assert [n["id"] for n in body["nodes"] if n["type"] == "watchlist"] == ["NESN.SW"]
    assert sorted(n["type"] for n in body["nodes"]) == ["gov", "news", "watchlist"]
    assert body["edges"] == [{"source": body["nodes"][2]["id"],
                              "target": "NESN.SW", "type": "symbol",
                              "sentiment": "neg"}]


def test_digest_graph_nodes_carry_a_cached_french_translation(tmp_path, monkeypatch):
    """Même forme de nœud que la grande toile (``entry_graph`` la reproduit à
    l'identique) -- l'enrichissement doit donc s'y appliquer pareil."""
    from backend.bots.paper import translate
    c, _ = make_client(tmp_path, monkeypatch)
    german_title = "Die Nestlé Bank warnt vor einem Rückgang"
    entry = dict(ENTRY_WITH_ITEMS, items=[
        {"src": "pressefi", "id": "http://nzz.test/1", "title": german_title,
         "symbol": "NESN.SW", "sentiment": "neg", "link": "http://nzz.test/1"},
    ])
    _digest_history(monkeypatch, [entry])
    translate.save_cache({"last_sweep_ts": None, "entries": {
        translate._title_key(german_title):
            {"fr": "La banque met en garde contre un recul",
             "src": "de", "ts": FIXED_NOW}}})

    body = c.get("/api/paper/digest/0/graph").json()
    node = [n for n in body["nodes"] if n["type"] == "news"][0]
    assert node["title_fr"] == "La banque met en garde contre un recul"
    assert node["src_lang"] == "DE"
    assert node["label"] == german_title


def test_a_digest_entry_can_be_addressed_by_its_timestamp(tmp_path, monkeypatch):
    """L'horodatage est la seule clé qui reste JUSTE quand un nouveau digest
    part entre l'affichage de la liste et le clic — l'index, lui, a glissé."""
    c, _ = make_client(tmp_path, monkeypatch)
    fresher = dict(ENTRY_WITH_ITEMS, ts="2026-08-25T12:00:00", items=[])
    _digest_history(monkeypatch, [fresher, ENTRY_WITH_ITEMS])

    by_ts = c.get("/api/paper/digest/2026-08-24T12:00:00/graph").json()
    assert by_ts["ts"] == "2026-08-24T12:00:00" and len(by_ts["edges"]) == 1
    # ...et l'index 0 désigne bien l'autre, le plus récent.
    assert c.get("/api/paper/digest/0/graph").json()["ts"] == "2026-08-25T12:00:00"


def test_an_old_digest_entry_is_marked_legacy_not_empty(tmp_path, monkeypatch):
    """Une entrée d'AVANT le lot rend un graphe vide MARQUÉ : le client peut
    le DIRE, au lieu d'afficher un vide qui se lirait « cette convergence ne
    reposait sur rien »."""
    c, _ = make_client(tmp_path, monkeypatch)
    old = {k: v for k, v in ENTRY_WITH_ITEMS.items() if k != "items"}
    _digest_history(monkeypatch, [old])

    body = c.get("/api/paper/digest/0/graph").json()
    assert body["legacy"] is True
    assert body["nodes"] == [] and body["edges"] == []
    # ...mais les MÉTADONNÉES de l'entrée restent servies : on sait de quelle
    # convergence on parle, même sans ses pièces.
    assert body["n_items"] == 2 and body["factors"] == ["gov", "held_catalyst"]


def test_an_unknown_digest_entry_is_a_404(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    _digest_history(monkeypatch, [ENTRY_WITH_ITEMS])
    assert c.get("/api/paper/digest/9/graph").status_code == 404
    assert c.get("/api/paper/digest/2020-01-01T00:00:00/graph").status_code == 404


def test_the_digest_graph_without_the_module_is_a_503(tmp_path, monkeypatch):
    """On a demandé quelque chose de PRÉCIS : rendre un graphe vide ferait
    passer une panne pour un fait (≠ la LECTURE de la liste, qui dégrade)."""
    c, _ = make_client(tmp_path, monkeypatch)

    def absent():
        raise ImportError("no module named convergence")

    monkeypatch.setattr(pr, "_convergence", absent)
    assert c.get("/api/paper/digest/0/graph").status_code == 503


def test_the_digest_graph_survives_a_broken_state(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)

    def boom():
        raise IOError("état illisible")

    monkeypatch.setattr(pr, "_convergence",
                        lambda: FakeModule(load_state=boom))
    assert c.get("/api/paper/digest/0/graph").status_code == 503


def test_the_digest_graph_is_closed_to_the_player_role(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch, role="player")
    assert c.get("/api/paper/digest/0/graph").status_code == 403


# ================================================================
#  LE CALENDRIER (27/08) — les rendez-vous notés à l'avance, et ce
#  qu'ils ont donné
# ================================================================

def test_the_calendar_serves_the_dated_appointments(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    entries = [
        {"date": "2026-08-26", "kind": "hypothesis", "label": "échéance NESN.SW",
         "tickers": ["NESN.SW"], "direction": "up", "source_id": "h1",
         "verdict": "flop", "move_pct": -4.2, "headline": "Nestlé déçoit",
         "checked_at": "2026-08-26T18:00:00"},
        {"date": "2026-09-17", "kind": "bc", "label": "réunion de la Fed",
         "source_id": "fed-2026-09-17", "verdict": None, "move_pct": None,
         "headline": "", "checked_at": None},
    ]
    monkeypatch.setattr(pr, "_calendar",
                        lambda: FakeModule(calendar_view=lambda: entries))
    assert c.get("/api/paper/calendar").json() == {"entries": entries}


def test_the_calendar_without_the_module_is_an_empty_list(tmp_path, monkeypatch):
    """Déploiement partiel : un tableau de bord ne tombe pas parce qu'un lot
    n'est pas encore déployé (même posture que ``/news`` et ``/digest``)."""
    c, _ = make_client(tmp_path, monkeypatch)

    def absent():
        raise ImportError("no module named calendar")

    monkeypatch.setattr(pr, "_calendar", absent)
    assert c.get("/api/paper/calendar").json() == {"entries": []}


def test_the_calendar_survives_a_broken_source(tmp_path, monkeypatch):
    """Best-effort : un site de banque centrale qui hoquette ne rend pas 500."""
    c, _ = make_client(tmp_path, monkeypatch)

    def boom():
        raise IOError("agenda illisible")

    monkeypatch.setattr(pr, "_calendar",
                        lambda: FakeModule(calendar_view=boom))
    body = c.get("/api/paper/calendar").json()
    assert body["entries"] == [] and "error" in body


def test_the_calendar_is_closed_to_the_player_role(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch, role="player")
    assert c.get("/api/paper/calendar").status_code == 403


def test_the_calendar_is_open_to_the_trader_role(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch, role="trader")
    monkeypatch.setattr(pr, "_calendar",
                        lambda: FakeModule(calendar_view=lambda: []))
    assert c.get("/api/paper/calendar").status_code == 200


def test_too_many_pending_jobs_is_a_429(tmp_path, monkeypatch):
    """Chaque travail détaché lance un SUBPROCESS du CLI Claude sur l'Omen. En
    ligne, la requête HTTP servait de frein naturel ; détaché, ce frein
    disparaît et une boucle de relance côté client en démarrerait autant qu'elle
    veut."""
    c, _ = make_client(tmp_path, monkeypatch)
    release = threading.Event()

    def slow(facts, lang="fr"):
        release.wait(5)
        return "Fiche du titre."

    monkeypatch.setattr(pr.llm, "write_analysis", slow)
    body = {"symbol": "NESN.SW"}
    jobs = []
    for _ in range(pr.MAX_PENDING_JOBS_PER_USER):
        response = c.post("/api/paper/analysis", json=body)
        assert response.status_code == 200, response.text
        jobs.append(response.json()["job"])

    refused = c.post("/api/paper/analysis", json=body)
    assert refused.status_code == 429
    assert "en cours" in refused.json()["detail"]

    release.set()
    for job in jobs:
        assert _await_job(c, job)["status"] == "done"
    # ...et une fois la file vidée, on repart normalement.
    assert c.post("/api/paper/analysis", json=body).status_code == 200


def test_the_cap_counts_PER_USER_not_globally(tmp_path, monkeypatch):
    """Deux traders qui travaillent en même temps ne se bloquent pas l'un
    l'autre : le plafond protège la machine d'UN emballement, il ne rationne
    pas le service."""
    c, _ = make_client(tmp_path, monkeypatch)
    release = threading.Event()

    def slow(facts, lang="fr"):
        release.wait(5)
        return "Fiche du titre."

    monkeypatch.setattr(pr.llm, "write_analysis", slow)
    body = {"symbol": "NESN.SW"}
    for _ in range(pr.MAX_PENDING_JOBS_PER_USER):
        assert c.post("/api/paper/analysis", json=body).status_code == 200
    assert c.post("/api/paper/analysis", json=body).status_code == 429

    c.app.dependency_overrides[get_current_user] = \
        lambda: FakeUser("money", username="bob")
    assert c.post("/api/paper/analysis", json=body).status_code == 200
    release.set()


def test_the_inline_mode_is_not_capped(tmp_path, monkeypatch):
    """``?sync=1`` n'ouvre aucun fil : c'est la requête HTTP elle-même qui
    tient le travail, donc le frein naturel est toujours là."""
    c, _ = make_client(tmp_path, monkeypatch)
    for _ in range(pr.MAX_PENDING_JOBS_PER_USER + 2):
        assert c.post("/api/paper/analysis?sync=1",
                      json={"symbol": "NESN.SW"}).status_code == 200


# ================================================================
#  COMPTE DE TRADING DU COACH (LOT 4, tâche 3)
#
#  Le coach reçoit SES 10 000 CHF fictifs et trade lui-même. Trois choses se
#  vérifient ici : que son compte EXISTE, qu'il TOURNE (le tick, sans lequel
#  ses stops ne partiraient jamais faute de navigateur) et qu'il S'EXÉCUTE
#  (le chemin complet d'un ordre, refus compris).
# ================================================================

COACH = "coach"
COACH_THESIS = "cassure du range mensuel sur volume soutenu"


def coach_action(**over):
    """Une entrée qui passe TOUT le garde-fou avec le marché par défaut
    (NESN.SW à 100 CHF, équité 10 000) : 1500 CHF = 15 % (plancher 10, plafond
    30), risque 150 CHF = 1,5 % (plafond 2), trésorerie restante 8500."""
    base = {"action": "buy", "symbol": "NESN.SW", "qty": 15, "stop": 90.0,
            "target": 130.0, "thesis": COACH_THESIS, "setup": "breakout"}
    base.update(over)
    return base


def coach_portfolio():
    return pr._load(COACH).to_dict()


def coach_ledger():
    return store.load_ledger(COACH)


def seed_coach_position(qty=10, stop_loss=90.0, avg_price=100.0):
    """Une ligne déjà ouverte sur le compte du coach, écrite en direct (les
    tests du TICK n'ont pas à repasser par le chemin d'exécution)."""
    portfolio = pr._ensure_coach_account()
    portfolio.positions.append(pr.models.Position(
        symbol="NESN.SW", qty=qty, avg_price=avg_price, currency="CHF",
        fx_rate=1.0, opened_at=FIXED_NOW, side="long",
        thesis=COACH_THESIS, stop_loss=stop_loss))
    portfolio.cash_chf = round(portfolio.cash_chf - qty * avg_price, 2)
    pr._save(COACH, portfolio)
    return portfolio


# --- 1) Le compte existe ------------------------------------------------

def test_the_coach_account_is_created_with_ten_thousand_chf(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    portfolio = pr._ensure_coach_account()
    assert portfolio.cash_chf == 10000.0
    assert portfolio.initial_capital == 10000.0
    assert store.portfolio_path(COACH).is_file()      # persisté tout de suite


def test_the_coach_account_is_loaded_not_recreated(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    first = pr._ensure_coach_account()
    first.cash_chf = 4242.0
    pr._save(COACH, first)
    assert pr._ensure_coach_account().cash_chf == 4242.0


def test_the_coach_is_listed_once_in_the_community(tmp_path, monkeypatch):
    """Ses positions sont PUBLIQUES par design : dès qu'il a un carnet, il est
    un trader comme les autres — présent, et une seule fois."""
    c, _ = make_client(tmp_path, monkeypatch)
    pr.execute_coach_actions([coach_action()], source="daily")
    users = [row["user"] for row in c.get("/api/paper/community").json()["users"]]
    assert users.count(COACH) == 1


# --- 2) Le chemin d'exécution ------------------------------------------

def test_execute_coach_actions_places_the_order(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    rows = pr.execute_coach_actions([coach_action()], source="daily")

    assert len(rows) == 1 and rows[0]["accepted"] is True
    assert rows[0]["action"] == "buy" and rows[0]["symbol"] == "NESN.SW"
    portfolio = coach_portfolio()
    assert len(portfolio["positions"]) == 1
    assert portfolio["positions"][0]["qty"] == 15
    assert portfolio["cash_chf"] < 10000.0            # payé, frais compris
    assert coach_ledger()[0]["accepted"] is True


def test_an_accepted_entry_carries_the_whole_plan_to_the_position(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    pr.execute_coach_actions([coach_action()], source="daily")
    position = coach_portfolio()["positions"][0]
    assert position["thesis"] == COACH_THESIS
    assert position["stop_loss"] == 90.0
    assert position["target"] == 130.0
    assert position["setup"] == "breakout"
    assert position["emotion"] == "calme"             # il n'a pas d'émotion
    assert position["risk_chf"] == 150.0              # (100 - 90) x 15 x 1.0


def test_an_accepted_entry_with_a_target_leaves_a_pending_limit_order(tmp_path, monkeypatch):
    """``fills.check_protective_stops`` ne connaît QUE ``stop_loss`` : sans cet
    ordre limite, l'objectif ne serait jamais exécuté mécaniquement."""
    c, _ = make_client(tmp_path, monkeypatch)
    pr.execute_coach_actions([coach_action()], source="daily")
    orders = coach_portfolio()["open_orders"]
    assert len(orders) == 1
    assert orders[0]["side"] == "sell" and orders[0]["kind"] == "limit"
    assert orders[0]["limit_price"] == 130.0
    assert orders[0]["qty"] == 15
    assert orders[0]["status"] == "open"


def test_an_entry_without_target_leaves_no_pending_order(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    pr.execute_coach_actions([coach_action(target=None)], source="daily")
    assert coach_portfolio()["open_orders"] == []


def test_the_target_order_is_executable_by_the_tick(tmp_path, monkeypatch):
    """La preuve que l'objectif est RÉEL : la première boucle de ``run_tick``
    le déclenche et la ligne se solde."""
    c, market = make_client(tmp_path, monkeypatch)
    pr.execute_coach_actions([coach_action()], source="daily")
    market.candles["NESN.SW"] = [
        {"ts": _ts(11), "open": 128.0, "high": 135.0, "low": 127.0, "close": 133.0}]

    result = pr.tick_coach_account()
    assert len(result["fills"]) == 1
    assert coach_portfolio()["positions"] == []
    assert len(coach_portfolio()["trades"]) == 1


def test_the_confirmation_gate_never_fires_for_the_coach(tmp_path, monkeypatch):
    """``needs_confirm`` est une pause d'INTERFACE pour un humain devant un
    formulaire — le coach vient de franchir un garde-fou PLUS STRICT."""
    c, _ = make_client(tmp_path, monkeypatch)
    rows = pr.execute_coach_actions([coach_action(qty=28, stop=95.0)],
                                   source="daily")
    assert all("needs_confirm" not in row for row in rows)
    assert rows[0]["accepted"] is True
    assert coach_portfolio()["positions"][0]["qty"] == 28   # exécuté, pas suspendu


def test_preorder_warnings_are_recorded_on_the_order(tmp_path, monkeypatch):
    """28 % de l'équité : accepté par le mandat du coach (plafond 30 %), mais
    au-delà du seuil d'avertissement humain (25 %) — CONSIGNÉ, comme pour un
    humain qui confirme."""
    c, _ = make_client(tmp_path, monkeypatch)
    pr.execute_coach_actions([coach_action(qty=28, stop=95.0)], source="daily")
    assert coach_portfolio()["positions"][0]["forced_warnings"] == ["oversize"]


def test_a_clean_entry_records_no_forced_warning(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    pr.execute_coach_actions([coach_action()], source="daily")
    assert coach_portfolio()["positions"][0]["forced_warnings"] == []


def test_the_coach_can_sell_what_he_holds(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    seed_coach_position(qty=10)
    rows = pr.execute_coach_actions([{"action": "sell", "symbol": "NESN.SW"}],
                                   source="daily")
    assert rows[0]["accepted"] is True
    assert coach_portfolio()["positions"] == []


# --- 3) Les refus : pédagogiques, chiffrés, sans effet -----------------

def test_a_rejected_action_leaves_the_portfolio_untouched(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    before = coach_portfolio()
    # 42 x 100 = 4200 CHF, soit 42 % de l'équité (plafond 30) ; le stop à 97
    # garde le RISQUE sous les 2 % pour que ce soit bien la TAILLE qui tombe.
    rows = pr.execute_coach_actions([coach_action(qty=42, stop=97.0)],
                                   source="daily")

    assert rows[0]["accepted"] is False
    assert rows[0]["reason"] == "oversize"
    assert coach_portfolio()["positions"] == []
    assert coach_portfolio()["cash_chf"] == before["cash_chf"]


def test_a_rejected_action_carries_a_readable_figure(tmp_path, monkeypatch):
    """C'est ce ``detail`` que l'écran affichera : « voulait 4200.00 CHF,
    42% de l'équité » — un refus qui n'enseigne rien ne sert à rien."""
    c, _ = make_client(tmp_path, monkeypatch)
    rows = pr.execute_coach_actions([coach_action(qty=42, stop=97.0)],
                                   source="daily")
    detail = rows[0]["detail"] or ""
    assert "4200" in detail and "42" in detail
    assert coach_ledger()[0]["detail"] == detail


def test_the_too_small_refusal_names_the_floor(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    rows = pr.execute_coach_actions([coach_action(qty=1)], source="daily")
    assert rows[0]["reason"] == "too_small"
    assert "10" in (rows[0]["detail"] or "")           # le plancher, en %


def test_the_no_stop_refusal_says_so(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    rows = pr.execute_coach_actions([coach_action(stop=None)], source="daily")
    assert rows[0]["reason"] == "no_stop"
    assert rows[0]["detail"]


def test_a_broken_quote_is_logged_as_no_quote_without_raising(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    market.broken.add("NESN.SW")
    rows = pr.execute_coach_actions([coach_action()], source="daily")
    assert rows[0]["accepted"] is False and rows[0]["reason"] == "no_quote"
    assert coach_portfolio()["positions"] == []


def test_an_unknown_symbol_is_logged_as_no_quote(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    rows = pr.execute_coach_actions([coach_action(symbol="ZZZZ.XX")], source="daily")
    assert rows[0]["reason"] == "no_quote"


def test_a_broken_quote_does_not_stop_the_next_action(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    market.prices["NOVN.SW"] = (100.0, "CHF", "Novartis")
    market.broken.add("NESN.SW")
    rows = pr.execute_coach_actions(
        [coach_action(), coach_action(symbol="NOVN.SW")], source="daily")
    assert rows[0]["reason"] == "no_quote"
    assert rows[1]["accepted"] is True


def test_a_parse_error_writes_one_line_and_places_nothing(tmp_path, monkeypatch):
    """On n'invente JAMAIS un ordre : bloc illisible ⇒ zéro action."""
    c, _ = make_client(tmp_path, monkeypatch)
    rows = pr.execute_coach_actions([coach_action()], source="daily",
                                   parse_error="parse_failed")
    assert len(rows) == 1
    assert rows[0] == {"ts": FIXED_NOW, "source": "daily", "action": "parse",
                       "symbol": "", "accepted": False, "reason": "parse_failed",
                       "detail": None}
    assert coach_portfolio()["positions"] == []
    assert len(coach_ledger()) == 1


def test_an_empty_decision_is_logged_as_a_deliberate_hold(tmp_path, monkeypatch):
    """L'inaction doit être un CHOIX visible, jamais un silence : le modèle a
    répondu, il a choisi de ne rien changer."""
    c, _ = make_client(tmp_path, monkeypatch)
    rows = pr.execute_coach_actions([], source="daily")
    assert len(rows) == 1
    assert rows[0]["action"] == "hold" and rows[0]["accepted"] is True
    assert rows[0]["detail"]
    assert coach_portfolio()["positions"] == []
    assert len(coach_ledger()) == 1


def test_a_parse_error_never_produces_a_hold(tmp_path, monkeypatch):
    """Une panne n'est pas un choix : les deux ne doivent pas se confondre."""
    c, _ = make_client(tmp_path, monkeypatch)
    rows = pr.execute_coach_actions([], source="daily", parse_error="no_block")
    assert [row["action"] for row in rows] == ["parse"]


# --- LOT 4bis : le ``note`` du coach, jusqu'au registre --------------------- #

def test_an_empty_decision_WITH_a_note_records_the_ACTUAL_reason(tmp_path, monkeypatch):
    """Vécu en prod : le coach a rendu deux passes ``hold`` de suite, et le
    registre n'archivait que la phrase générique — sa vraie raison écrite dans
    ``note`` était perdue. Elle devient le ``detail`` de la ligne ``hold``."""
    c, _ = make_client(tmp_path, monkeypatch)
    reason = "il me faut le cours actuel du titre pour fixer un stop technique"
    rows = pr.execute_coach_actions([], source="daily", note=reason)
    assert len(rows) == 1
    assert rows[0]["action"] == "hold" and rows[0]["accepted"] is True
    assert rows[0]["detail"] == reason
    assert coach_ledger()[0]["detail"] == reason


def test_an_empty_decision_without_a_note_keeps_the_generic_detail(tmp_path, monkeypatch):
    """Repli sur la phrase historique : comportement inchangé quand le coach
    (ou un appelant plus ancien) ne fournit rien."""
    c, _ = make_client(tmp_path, monkeypatch)
    rows = pr.execute_coach_actions([], source="daily")
    assert rows[0]["detail"] == pr.COACH_HOLD_DETAIL


@pytest.mark.parametrize("blank_note", [None, "", "   ", 42, ["x"], {"a": 1}])
def test_an_empty_decision_with_a_blank_or_untyped_note_falls_back(
        tmp_path, monkeypatch, blank_note):
    """Tolérant comme le reste du module : un ``note`` mal typé ne doit jamais
    lever, et ne doit pas se lire comme une raison inventée."""
    c, _ = make_client(tmp_path, monkeypatch)
    rows = pr.execute_coach_actions([], source="daily", note=blank_note)
    assert rows[0]["detail"] == pr.COACH_HOLD_DETAIL


def test_a_parse_error_ignores_any_note(tmp_path, monkeypatch):
    """Une panne n'a rien à voir avec une lecture de marché : elle reste une
    ligne ``parse`` isolée, ``note`` ou pas."""
    c, _ = make_client(tmp_path, monkeypatch)
    rows = pr.execute_coach_actions([], source="daily", parse_error="parse_failed",
                                   note="jamais utilisée")
    assert len(rows) == 1
    assert rows[0]["action"] == "parse"


def test_actions_WITH_a_note_add_one_accompanying_note_row(tmp_path, monkeypatch):
    """Quand il agit ET commente, les deux coexistent : la ligne d'ordre garde
    SON détail chiffré, une ligne ``note`` séparée porte la lecture de marché
    — choix documenté au lieu d'écraser le détail de la 1ʳᵉ ligne (cf.
    ``_execute_coach_actions_locked``)."""
    c, _ = make_client(tmp_path, monkeypatch)
    rows = pr.execute_coach_actions([coach_action()], source="daily",
                                   note="Le marché est nerveux ce soir.")
    assert len(rows) == 2
    kinds = [row["action"] for row in rows]
    assert kinds.count("note") == 1
    note_row = next(row for row in rows if row["action"] == "note")
    assert note_row["accepted"] is True
    assert note_row["detail"] == "Le marché est nerveux ce soir."
    assert note_row["symbol"] == ""
    order_row = next(row for row in rows if row["action"] == "buy")
    assert order_row["detail"] == "15 x 100.00 CHF"     # PAS écrasé par la note


def test_actions_without_a_note_add_no_accompanying_row(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    rows = pr.execute_coach_actions([coach_action()], source="daily")
    assert len(rows) == 1
    assert rows[0]["action"] != "note"


def test_the_note_row_reads_most_recent_in_the_persisted_ledger(tmp_path, monkeypatch):
    """Le registre se lit du plus récent au plus ancien : la RAISON d'ensemble
    doit apparaître AVANT l'action concrète qu'elle accompagne."""
    c, _ = make_client(tmp_path, monkeypatch)
    pr.execute_coach_actions([coach_action()], source="daily",
                             note="Le marché est nerveux ce soir.")
    persisted = coach_ledger()
    assert persisted[0]["action"] == "note"
    assert persisted[1]["action"] == "buy"


def test_execute_coach_actions_never_raises(tmp_path, monkeypatch):
    """Appelée depuis un cycle de veille ET depuis la convergence : elle ne
    doit JAMAIS faire tomber son appelant."""
    c, _ = make_client(tmp_path, monkeypatch)

    def _boom(*a, **kw):
        raise RuntimeError("le disque a disparu")
    monkeypatch.setattr(pr, "_ensure_coach_account", _boom)
    assert pr.execute_coach_actions([coach_action()], source="daily") == []


def test_execute_coach_actions_swallows_unknown_keywords(tmp_path, monkeypatch):
    """L'appelant convergence peut lui passer des mots-clés qu'elle ne connaît
    pas encore."""
    c, _ = make_client(tmp_path, monkeypatch)
    rows = pr.execute_coach_actions([coach_action()], source="digest",
                                   lang="it", trigger="convergence")
    assert rows[0]["accepted"] is True


def test_an_accepted_action_is_written_to_the_coach_journal(tmp_path, monkeypatch):
    """La trace lisible de « comment il fait » — et ce qui lui donne un carnet."""
    c, _ = make_client(tmp_path, monkeypatch)
    pr.execute_coach_actions([coach_action()], source="daily")
    journal = store.read_note(COACH, "Journal.md") or ""
    assert "NESN.SW" in journal


def test_a_rejected_action_is_not_written_to_the_journal(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    pr.execute_coach_actions([coach_action(qty=42, stop=97.0)], source="daily")
    assert (store.read_note(COACH, "Journal.md") or "") == ""


# --- 4) L'inclusion dans le tick (LE point critique du lot) -------------

def test_tick_coach_account_executes_the_protective_stop(tmp_path, monkeypatch):
    """``run_tick`` n'énumère aucun compte et le coach n'a pas de navigateur :
    sans ce chemin, son stop ne partirait jamais."""
    c, market = make_client(tmp_path, monkeypatch)
    seed_coach_position(qty=10, stop_loss=90.0)
    market.candles["NESN.SW"] = [
        {"ts": _ts(11), "open": 95.0, "high": 96.0, "low": 88.0, "close": 89.0}]

    result = pr.tick_coach_account()
    assert len(result["stopped"]) == 1
    portfolio = coach_portfolio()
    assert portfolio["positions"] == []
    assert len(portfolio["trades"]) == 1                # la ligne est SOLDÉE


def test_a_coach_close_goes_through_attach_trade_extras(tmp_path, monkeypatch):
    """Le post-mortem automatique est déclenché comme pour un humain."""
    c, market = make_client(tmp_path, monkeypatch)
    seed_coach_position(qty=10, stop_loss=90.0)
    market.candles["NESN.SW"] = [
        {"ts": _ts(11), "open": 95.0, "high": 96.0, "low": 88.0, "close": 89.0}]

    result = pr.tick_coach_account()
    assert result["stopped"][0]["postmortem_job"]


@pytest.mark.real_coach_trader
def test_the_watch_cycle_hook_reaches_the_coach_tick(tmp_path, monkeypatch):
    """Le chemin COMPLET, du crochet du guetteur jusqu'au stop exécuté :
    ``newswatch._run_coach_trader`` -> ``coach_trader.maybe_run`` ->
    ``paper_router.tick_coach_account`` -> ``run_tick``.

    On entre par le CROCHET et non par ``run_once`` entier : que ``run_once``
    appelle bien ce crochet est épinglé côté ``test_paper_newswatch.py`` (deux
    tests, injecté ET par défaut), et faire tourner un cycle complet ici
    ouvrirait les neuf autres volets — dont la sauvegarde nocturne, qui écrit
    un vrai ``tar.gz`` HORS de ``tmp_path``.

    Un SAMEDI : la passe quotidienne ne se déclenche pas (aucun appel au
    modèle dans ce test), et le tick tourne quand même — c'est exactement ce
    qu'on veut prouver, un stop peut sauter le week-end sur une crypto.
    """
    from backend.bots.paper import newswatch
    c, market = make_client(tmp_path, monkeypatch)
    seed_coach_position(qty=10, stop_loss=90.0)
    market.candles["NESN.SW"] = [
        {"ts": _ts(11), "open": 95.0, "high": 96.0, "low": 88.0, "close": 89.0}]

    newswatch._run_coach_trader(datetime(2026, 8, 29, 15, 0, 0,
                                         tzinfo=timezone.utc))
    assert coach_portfolio()["positions"] == []         # le stop est parti
    assert store.load_equity(COACH)                     # et la photo est prise


# --- 5) La photo de patrimoine -----------------------------------------

def test_snapshot_equity_all_writes_one_point_per_account(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    buy(c, qty=10)                                       # le compte « tester »
    pr._ensure_coach_account()

    pr.snapshot_equity_all(FIXED_NOW)
    coach_points = store.load_equity(COACH)
    user_points = store.load_equity("tester")
    assert len(coach_points) == 1 and coach_points[0]["date"] == FIXED_NOW[:10]
    assert coach_points[0]["equity"] == 10000.0
    assert len(user_points) == 1
    assert user_points[0]["equity"] > 0


def test_snapshot_equity_all_is_idempotent_within_the_day(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    pr._ensure_coach_account()
    pr.snapshot_equity_all(FIXED_NOW)
    pr.snapshot_equity_all(FIXED_NOW)
    assert len(store.load_equity(COACH)) == 1


def test_snapshot_equity_values_the_positions_at_the_current_price(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    seed_coach_position(qty=10, avg_price=100.0)         # 9000 de cash + 10 titres
    market.prices["NESN.SW"] = (120.0, "CHF", "Nestle SA")

    pr.snapshot_equity_all(FIXED_NOW)
    assert store.load_equity(COACH)[0]["equity"] == 10200.0     # 9000 + 10 x 120


def test_snapshot_equity_falls_back_to_cost_basis_when_the_quote_is_broken(tmp_path,
                                                                          monkeypatch):
    """Un cours en panne ne doit pas faire PERDRE le point (même doctrine que
    ``risk.exposure``) : on retombe sur le prix de revient."""
    c, market = make_client(tmp_path, monkeypatch)
    seed_coach_position(qty=10, avg_price=100.0)
    market.broken.add("NESN.SW")

    pr.snapshot_equity_all(FIXED_NOW)
    points = store.load_equity(COACH)
    assert len(points) == 1 and points[0]["equity"] == 10000.0


def test_snapshot_equity_asks_one_quote_per_distinct_symbol(tmp_path, monkeypatch):
    """Un batch UNIQUE sur les symboles DISTINCTS de tous les comptes — jamais
    un appel par compte (patron ``_run_price_alerts_volet``)."""
    c, market = make_client(tmp_path, monkeypatch)
    buy(c, qty=5)                                        # « tester » sur NESN.SW
    seed_coach_position(qty=10)                          # le coach aussi

    calls = []
    real_quote = market.get_quote
    monkeypatch.setattr(quotes, "get_quote",
                        lambda symbol: calls.append(symbol) or real_quote(symbol))
    pr.snapshot_equity_all(FIXED_NOW)
    assert calls == ["NESN.SW"]


def test_snapshot_equity_never_raises(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)

    def _boom():
        raise RuntimeError("radar en panne")
    monkeypatch.setattr(pr, "_snapshot_usernames", _boom)
    assert pr.snapshot_equity_all(FIXED_NOW)["accounts"] == 0


# --- 6) La passe quotidienne -------------------------------------------

def _actions_block(actions, note=None):
    payload = {"actions": actions}
    if note is not None:
        payload["note"] = note
    return ("Voici ce que je fais ce soir.\n```COACH_ACTIONS\n%s\n```"
            % json.dumps(payload))


def test_run_coach_daily_pass_executes_what_the_model_returns(tmp_path, monkeypatch):
    """LOT 5 — la passe est en DEUX temps : le tri designe les dossiers, la
    decision passe les ordres. Le premier appel repond donc un bloc de TRI, le
    second le bloc d'actions."""
    c, market = make_client(tmp_path, monkeypatch)
    market.candles["NESN.SW"] = _serie()
    seen = []

    def _claude(prompt):
        seen.append(prompt)
        if len(seen) == 1:
            return _focus_answer(["NESN.SW"])
        return _actions_block([coach_action()])

    monkeypatch.setattr(pr.llm, "build_coach_screen_prompt",
                        lambda context, lang="fr": "TRI " + str(context["now"]),
                        raising=False)
    monkeypatch.setattr(pr.llm, "build_coach_trader_prompt",
                        lambda context, lang="fr": "PROMPT " + str(context["now"]),
                        raising=False)
    out = pr.run_coach_daily_pass(FIXED_NOW, claude=_claude)

    assert out["ledger"][0]["accepted"] is True
    assert coach_portfolio()["positions"][0]["qty"] == 15
    assert seen[0].startswith("TRI") and seen[1].startswith("PROMPT")


def test_the_daily_pass_context_is_deterministic(tmp_path, monkeypatch):
    """Le contexte est construit SANS LLM : positions valorisées, statistiques,
    discipline — et les sources best-effort (radar/humeur/agenda) n'y sont
    jamais une exception."""
    c, _ = make_client(tmp_path, monkeypatch)
    seed_coach_position(qty=10)
    captured = {}

    # Le contexte complet est celui du PREMIER temps (le tri) : c'est lui qui
    # voit large. Le second n'y ajoute que les dossiers des elus.
    monkeypatch.setattr(pr.llm, "build_coach_screen_prompt",
                        lambda context, lang="fr": captured.update(context) or "P",
                        raising=False)
    pr.run_coach_daily_pass(FIXED_NOW, claude=lambda prompt: "rien à faire")

    assert captured["cash_chf"] == 9000.0
    assert captured["initial_capital"] == 10000.0
    assert captured["equity_chf"] == 10000.0
    assert captured["positions"][0]["symbol"] == "NESN.SW"
    assert captured["positions"][0]["value_chf"] == 1000.0
    assert captured["positions"][0]["thesis"] == COACH_THESIS
    assert "stats" in captured and "discipline" in captured
    assert isinstance(captured["radar"], list)
    assert isinstance(captured["candidates"], list)


def test_the_daily_pass_logs_llm_failed_and_acts_on_nothing(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)

    def _boom(prompt):
        raise RuntimeError("le coach n'a pas répondu dans les 180 s")
    monkeypatch.setattr(pr.llm, "build_coach_screen_prompt",
                        lambda context, lang="fr": "P", raising=False)
    out = pr.run_coach_daily_pass(FIXED_NOW, claude=_boom)

    assert out["ledger"][0]["reason"] == "llm_failed"
    assert out["ledger"][0]["action"] == "pass"
    assert coach_ledger()[0]["reason"] == "llm_failed"
    assert coach_portfolio()["positions"] == []


def test_the_daily_pass_without_a_prompt_builder_logs_a_failure(tmp_path, monkeypatch):
    """Import PARESSEUX tolérant : le constructeur de prompt arrive par une
    autre tâche — absent, la passe consigne une panne et n'agit pas."""
    c, _ = make_client(tmp_path, monkeypatch)
    monkeypatch.delattr(pr.llm, "build_coach_trader_prompt", raising=False)
    out = pr.run_coach_daily_pass(FIXED_NOW, claude=lambda prompt: "")
    assert out["ledger"][0]["reason"] == "llm_failed"


def test_a_quiet_daily_pass_logs_a_hold(tmp_path, monkeypatch):
    """Le modèle a répondu sans bloc d'actions : rien à faire, mais on le DIT."""
    c, _ = make_client(tmp_path, monkeypatch)
    monkeypatch.setattr(pr.llm, "build_coach_screen_prompt",
                        lambda context, lang="fr": "P", raising=False)
    pr.run_coach_daily_pass(FIXED_NOW, claude=lambda prompt: "Je ne touche à rien.")
    assert coach_ledger()[0]["action"] == "hold"
    # Pas de bloc du tout -> pas de ``note`` à lire -> repli générique.
    assert coach_ledger()[0]["detail"] == pr.COACH_HOLD_DETAIL


def test_a_quiet_daily_pass_WITH_a_note_records_the_ARGUED_reason(tmp_path, monkeypatch):
    """LOT 4bis — vécu en prod : le coach a rendu deux passes ``hold`` de suite
    et seule la phrase générique était archivée, sa vraie raison perdue."""
    c, _ = make_client(tmp_path, monkeypatch)
    monkeypatch.setattr(pr.llm, "build_coach_screen_prompt",
                        lambda context, lang="fr": "P", raising=False)
    reason = ("il me faut le cours actuel du titre pour fixer un stop "
             "technique et une taille cohérente avec le risque à 2 %")
    # LOT 5 : quand le TRI ne retient aucun dossier, c'est SA note qui devient
    # la raison archivee -- et le second appel ne part pas.
    pr.run_coach_daily_pass(FIXED_NOW,
                            claude=lambda prompt: _focus_answer([], note=reason))
    assert coach_ledger()[0]["action"] == "hold"
    assert coach_ledger()[0]["detail"] == reason


def test_the_daily_pass_never_raises(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)

    def _boom(*a, **kw):
        raise RuntimeError("tout brûle")
    monkeypatch.setattr(pr, "_ensure_coach_account", _boom)
    assert isinstance(pr.run_coach_daily_pass(FIXED_NOW,
                                              claude=lambda p: ""), dict)


# --- 6bis) Le LIVRE du coach : ce que la convergence vient chercher ------
#
#  ``convergence._coach_book`` appelle CETTE fonction. C'est elle qui fait
#  passer le coach de « il parle » à « il agit » quand une convergence part —
#  sans elle, le prompt ne demande aucune action et l'exécuteur n'est jamais
#  engagé, sans une erreur ni un test rouge.

def test_coach_book_rend_les_cinq_cles_sur_un_compte_neuf(tmp_path, monkeypatch):
    """La forme EXACTE que ``llm.coach_actions_block`` consomme, sur un compte
    tout neuf — et rien ne lève. ``candidates`` (LOT 4bis) rejoint les quatre
    clés historiques."""
    c, _ = make_client(tmp_path, monkeypatch)
    book = pr.coach_book()
    assert set(book) == {"cash_chf", "equity_chf", "positions", "open_orders",
                         "candidates"}
    assert book["cash_chf"] == 10000.0
    assert book["equity_chf"] == 10000.0
    assert book["positions"] == []
    assert book["open_orders"] == []
    assert book["candidates"] == []


def test_coach_book_a_la_MEME_forme_que_celui_de_la_passe_quotidienne(
        tmp_path, monkeypatch):
    """Une seule vérité : les clés sont celles de ``llm._coach_book_of``, qui
    est l'extracteur de la passe quotidienne. Deux formes divergentes rendraient
    la section d'actions muette en silence (piège #61)."""
    c, _ = make_client(tmp_path, monkeypatch)
    assert set(pr.coach_book()) == set(pr.llm._coach_book_of({}))


def test_coach_book_porte_these_stop_et_objectif_sur_chaque_ligne(tmp_path,
                                                                  monkeypatch):
    """Sans thèse, sans stop et sans objectif, le modèle ne peut décider ni de
    déplacer un stop ni de sortir : ce sont ces trois champs qui font du livre
    autre chose qu'une liste de tickers."""
    c, _ = make_client(tmp_path, monkeypatch)
    portfolio = seed_coach_position(qty=10, stop_loss=90.0)
    portfolio.positions[0].target = 130.0
    pr._save(COACH, portfolio)

    rows = pr.coach_book()["positions"]
    assert len(rows) == 1
    assert rows[0]["symbol"] == "NESN.SW"
    assert rows[0]["qty"] == 10
    assert rows[0]["thesis"] == COACH_THESIS
    assert rows[0]["stop_loss"] == 90.0
    assert rows[0]["target"] == 130.0


def test_coach_book_n_invente_NI_cours_NI_plus_value(tmp_path, monkeypatch):
    """Le livre se lit sans réseau : sans cours, ``price`` vaudrait le prix de
    revient et ``pnl_pct`` « 0 % » — c'est-à-dire toutes les lignes à plat, un
    fait FAUX. Absent vaut mieux qu'inventé."""
    c, _ = make_client(tmp_path, monkeypatch)
    seed_coach_position(qty=10, avg_price=100.0)
    row = pr.coach_book()["positions"][0]
    assert "price" not in row
    assert "pnl_pct" not in row


def test_coach_book_donne_la_MEME_equite_que_le_garde_fou(tmp_path, monkeypatch):
    """⚠️ Point dur : le prompt dit au modèle de viser « X % de TON équité », et
    c'est ``coach_trader._equity_chf`` (prix de revient) qui REFUSE ensuite. Une
    autre équité le ferait dimensionner contre un chiffre dont le garde-fou ne
    se sert pas — les refus paraîtraient arbitraires."""
    from backend.bots.paper import coach_trader

    c, _ = make_client(tmp_path, monkeypatch)
    seed_coach_position(qty=10, avg_price=100.0)
    raw = coach_portfolio()

    assert pr.coach_book()["equity_chf"] == round(
        coach_trader._equity_chf(raw["cash_chf"], raw["positions"]), 2)


def test_coach_book_ne_leve_JAMAIS_et_rend_un_livre_VIDE(tmp_path, monkeypatch):
    """Best-effort : un compte illisible ne doit ni faire tomber le digest, ni
    faire décider le modèle sur un livre inventé. Le dict VIDE est le seul
    retour qui dégrade correctement des DEUX côtés — aucune section d'actions
    dans le prompt, et ``maybe_fire`` n'engage pas l'exécuteur (livre falsy)."""
    c, _ = make_client(tmp_path, monkeypatch)

    def _boom(*a, **kw):
        raise RuntimeError("compte illisible")

    monkeypatch.setattr(pr, "_ensure_coach_account", _boom)
    book = pr.coach_book()
    assert book == {}
    assert not book                                   # falsy -> pas d'exécuteur
    assert pr.llm.coach_actions_block(book) == ""     # ... et pas de section


# --- 6ter) Les CANDIDATS : le cours de ce que le coach ne détient pas encore
#
#  Vécu en prod (2026-08-28) : un livre neuf ou vide n'a AUCUN prix hors de ce
#  qu'il détient déjà — trois passes de suite se sont terminées sur la même
#  raison honnête (« il me faut le cours actuel du titre pour fixer un stop
#  technique ») avant que ce cours n'existe nulle part dans le contexte. Le
#  coach était affamé de données, pas timide.

def _open_hyp(tickers, hyp_id="h1", status="open"):
    return {"id": hyp_id, "created_at": FIXED_NOW, "status": status,
            "outcome": None, "scored_at": None, "move_pct": None,
            "thesis": "une thèse", "chain": ["a"], "markets": [],
            "tickers": tickers, "direction": "up", "horizon_days": 7,
            "confidence": "moyenne", "invalidation": "?"}


def _seed_radar(hyps):
    from backend.bots.paper import radar
    state = radar.blank_state()
    state["hypotheses"] = hyps
    radar.save_state(state)


def test_coach_candidates_quotes_each_distinct_ticker_from_open_hypotheses(
        tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    market.prices["AAPL"] = (200.0, "USD", "Apple Inc")
    _seed_radar([_open_hyp(["AAPL"], "h1"), _open_hyp(["NESN.SW"], "h2")])

    candidates = pr._coach_candidates(pr._open_radar_hypotheses())
    by_symbol = {row["symbol"]: row for row in candidates}
    assert set(by_symbol) == {"AAPL", "NESN.SW"}
    assert by_symbol["AAPL"]["currency"] == "USD"
    assert by_symbol["AAPL"]["price_chf"] == round(200.0 * 0.88, 2)
    assert by_symbol["NESN.SW"]["price_chf"] == 100.0   # déjà en CHF, fx=1.0


def test_coach_candidates_dedupes_tickers_across_hypotheses(tmp_path, monkeypatch):
    """Le même ticker cité par deux hypothèses ne doit pas être coté deux fois
    — l'ordre est celui de la PREMIÈRE apparition."""
    c, market = make_client(tmp_path, monkeypatch)
    market.prices["AAPL"] = (200.0, "USD", "Apple Inc")
    _seed_radar([_open_hyp(["NESN.SW"], "h1"),
                 _open_hyp(["NESN.SW", "AAPL"], "h2")])

    candidates = pr._coach_candidates(pr._open_radar_hypotheses())
    assert [row["symbol"] for row in candidates] == ["NESN.SW", "AAPL"]


def test_coach_candidates_ignores_hypotheses_that_are_not_open(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    market.prices["AAPL"] = (200.0, "USD", "Apple Inc")
    _seed_radar([_open_hyp(["AAPL"], "h1", status="scored")])

    assert pr._coach_candidates(pr._open_radar_hypotheses()) == []


def test_coach_candidates_omits_a_broken_quote_without_raising(tmp_path, monkeypatch):
    """Panne -> candidat OMIS, jamais une exception : le reste du contexte ne
    doit pas tomber pour un seul ticker muet."""
    c, market = make_client(tmp_path, monkeypatch)
    market.broken.add("AAPL")
    _seed_radar([_open_hyp(["AAPL"], "h1"), _open_hyp(["NESN.SW"], "h2")])

    candidates = pr._coach_candidates(pr._open_radar_hypotheses())
    assert [row["symbol"] for row in candidates] == ["NESN.SW"]


def test_coach_candidates_omits_an_unknown_symbol_without_raising(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    _seed_radar([_open_hyp(["ZZZZ.UNKNOWN"], "h1"), _open_hyp(["NESN.SW"], "h2")])

    candidates = pr._coach_candidates(pr._open_radar_hypotheses())
    assert [row["symbol"] for row in candidates] == ["NESN.SW"]


def test_coach_candidates_caps_at_ten_distinct_tickers(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    hyps = []
    for i in range(15):
        symbol = "T%d.SW" % i
        market.prices[symbol] = (10.0 + i, "CHF", "Titre %d" % i)
        hyps.append(_open_hyp([symbol], "h%d" % i))
    _seed_radar(hyps)

    candidates = pr._coach_candidates(pr._open_radar_hypotheses())
    assert len(candidates) == 10
    assert [row["symbol"] for row in candidates] == ["T%d.SW" % i for i in range(10)]


def test_coach_candidates_is_empty_without_any_open_hypothesis(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert pr._coach_candidates([]) == []
    assert pr._coach_candidates(None) == []


def test_coach_pass_context_carries_candidates(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    market.prices["AAPL"] = (200.0, "USD", "Apple Inc")
    _seed_radar([_open_hyp(["AAPL"], "h1")])
    portfolio = pr._ensure_coach_account()

    context = pr._coach_pass_context(portfolio, FIXED_NOW)
    # LOT 5 : chaque candidat porte AUSSI son analyse technique -- ``None`` ici,
    # le faux marche ne servant aucune bougie a ce symbole.
    assert context["candidates"] == [
        {"symbol": "AAPL", "price_chf": round(200.0 * 0.88, 2),
         "currency": "USD", "technical": None}]


def test_coach_book_carries_candidates_too(tmp_path, monkeypatch):
    """Le digest n'a NULLE PART de cours pour ses items — même faim de
    données que la passe quotidienne, donc le même enrichissement."""
    c, market = make_client(tmp_path, monkeypatch)
    market.prices["AAPL"] = (200.0, "USD", "Apple Inc")
    _seed_radar([_open_hyp(["AAPL"], "h1")])

    book = pr.coach_book()
    assert book["candidates"] == [
        {"symbol": "AAPL", "price_chf": round(200.0 * 0.88, 2),
         "currency": "USD", "technical": None}]


# --- 7) Les endpoints ---------------------------------------------------

def test_coach_trader_endpoint_is_refused_without_a_role(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch, role="player")
    assert c.get("/api/paper/coach-trader").status_code == 403
    assert c.post("/api/paper/coach-trader/run?sync=1").status_code == 403


def test_coach_trader_run_is_admin_only(tmp_path, monkeypatch):
    """Forcer une passe consomme le modèle : réservé à l'admin, contrairement
    à la LECTURE qui reste ouverte aux trois rôles."""
    for role in ("money", "trader"):
        c, _ = make_client(tmp_path, monkeypatch, role=role)
        assert c.get("/api/paper/coach-trader").status_code == 200
        assert c.post("/api/paper/coach-trader/run?sync=1").status_code == 403


def test_coach_trader_run_forces_the_pass_for_an_admin(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    calls = []
    monkeypatch.setattr(pr, "run_coach_daily_pass",
                        lambda now_iso=None, crypto_only=False:
                        calls.append(now_iso) or {"ok": True})
    body = c.post("/api/paper/coach-trader/run?sync=1")
    assert body.status_code == 200 and body.json() == {"ok": True}
    assert len(calls) == 1


# --- LOT 6 — la passe FORCÉE applique la MÊME règle d'univers ------------ #

SUNDAY_NOW = "2026-08-23T01:47:00"  # l'incident réel : un short d'action US


def test_coach_trader_run_computes_crypto_only_from_the_real_moment(
        tmp_path, monkeypatch):
    """Vécu en prod : la passe FORCÉE a shorté une action US un dimanche
    01:47 — elle saute le gate d'HORAIRE (``pass_due``, c'est le sens du mot
    « forcer ») mais ne doit JAMAIS sauter le gate d'UNIVERS. Avant ce fix,
    ``crypto_only`` restait au défaut ``False`` quel que soit le jour, faute
    d'être calculé du tout."""
    c, _ = make_client(tmp_path, monkeypatch)
    calls = []
    monkeypatch.setattr(pr, "run_coach_daily_pass",
                        lambda now_iso=None, crypto_only=False:
                        calls.append(crypto_only) or {"ok": True})

    monkeypatch.setattr(pr, "_now_iso", lambda: SUNDAY_NOW)
    assert c.post("/api/paper/coach-trader/run?sync=1").status_code == 200
    monkeypatch.setattr(pr, "_now_iso", lambda: FIXED_NOW)     # lundi
    assert c.post("/api/paper/coach-trader/run?sync=1").status_code == 200

    assert calls == [True, False]


def test_coach_trader_run_forced_on_sunday_refuses_stocks_and_keeps_crypto(
        tmp_path, monkeypatch):
    """Bout en bout via l'endpoint HTTP forcé : une action US se voit
    opposer ``market_closed``, une crypto passe — même verdict que la passe
    naturelle du week-end (``test_the_weekend_pass_refuses_stocks_and_keeps_
    crypto``), désormais garanti aussi quand un admin CLIQUE le bouton."""
    c, market = make_client(tmp_path, monkeypatch)
    market.prices["BTC-USD"] = (100.0, "USD", "Bitcoin")
    market.candles["BTC-USD"] = _serie()
    market.candles["NESN.SW"] = _serie()
    monkeypatch.setattr(pr, "_now_iso", lambda: SUNDAY_NOW)
    speaker = _Speaker(
        _focus_answer(["NESN.SW", "BTC-USD"]),
        _actions_answer([coach_action(),
                         coach_action(symbol="BTC-USD", qty=15, stop=90.0)]))
    monkeypatch.setattr(pr.llm, "_claude_text", speaker)

    body = c.post("/api/paper/coach-trader/run?sync=1")
    assert body.status_code == 200

    rows = {row["symbol"]: row for row in coach_ledger() if row["symbol"]}
    assert rows["NESN.SW"]["reason"] == "market_closed"
    assert rows["BTC-USD"]["accepted"] is True


def test_coach_trader_view_returns_both_equity_series(tmp_path, monkeypatch):
    """La comparaison exige les DEUX courbes : celle du coach et celle de
    l'utilisateur qui appelle."""
    c, _ = make_client(tmp_path, monkeypatch)
    store.save_equity(COACH, [{"date": "2026-08-23", "equity": 10100.0}])
    store.save_equity("tester", [{"date": "2026-08-23", "equity": 9800.0}])

    body = c.get("/api/paper/coach-trader").json()
    assert body["username"] == COACH
    assert body["capital"] == 10000.0
    assert body["equity"]["coach"][0]["equity"] == 10100.0
    assert body["equity"]["user"][0]["equity"] == 9800.0
    assert body["next_pass"]["after_hour"] == 17
    assert "portfolio" in body and "stats" in body and "discipline" in body
    assert body["ledger"] == []


def test_coach_trader_view_shows_the_ledger_including_refusals(tmp_path, monkeypatch):
    """Le livre du coach est PUBLIC : aucun filtrage, les refus compris."""
    c, _ = make_client(tmp_path, monkeypatch)
    pr.execute_coach_actions([coach_action(qty=42, stop=97.0)], source="daily")
    body = c.get("/api/paper/coach-trader").json()
    assert body["ledger"][0]["reason"] == "oversize"
    assert body["quotes"] == {}          # rien n'a été acheté


def test_portfolio_carries_the_equity_curve(tmp_path, monkeypatch):
    """La carte « Courbe d'équité » du dashboard lit ``equity_curve`` — aucun
    backend ne l'avait jamais produite."""
    c, _ = make_client(tmp_path, monkeypatch)
    assert portfolio_of(c)["equity_curve"] == []
    store.save_equity("tester", [{"date": "2026-08-23", "equity": 9800.0},
                                 {"date": "2026-08-24", "equity": 9900.0}])
    curve = portfolio_of(c)["equity_curve"]
    assert [point["equity"] for point in curve] == [9800.0, 9900.0]


# ==========================================================================
#  LOT 5 « Coach Trader MAX » — le short, les créneaux, les deux temps
#
#  Vécu qui motive tout : le coach a refusé QUATRE fois d'entrer, ses
#  meilleures thèses étant BAISSIÈRES donc « inexécutables en achat seul ».
#  Le moteur d'ordres savait vendre à découvert depuis le premier lot ; seul
#  son MANDAT l'interdisait.
# ==========================================================================

def coach_short(**over):
    """Une vente à découvert qui passe tout le garde-fou avec le marché par
    défaut (NESN.SW à 100 CHF, équité 10 000) : 1500 CHF = 15 % de l'équité,
    stop à 108 -> risque 120 CHF = 1,2 %."""
    base = {"action": "short", "symbol": "NESN.SW", "qty": 15, "stop": 108.0,
            "target": 80.0, "thesis": COACH_THESIS, "setup": "contrarian"}
    base.update(over)
    return base


def seed_coach_short(qty=15, stop_loss=108.0, avg_price=100.0):
    """Une ligne VENDUE À DÉCOUVERT déjà ouverte, écrite en direct — miroir de
    ``seed_coach_position`` (la trésorerie encaisse le produit de la vente)."""
    portfolio = pr._ensure_coach_account()
    portfolio.positions.append(pr.models.Position(
        symbol="NESN.SW", qty=qty, avg_price=avg_price, currency="CHF",
        fx_rate=1.0, opened_at=FIXED_NOW, side="short",
        thesis=COACH_THESIS, stop_loss=stop_loss))
    portfolio.cash_chf = round(portfolio.cash_chf + qty * avg_price, 2)
    pr._save(COACH, portfolio)
    return portfolio


# --- A) Le short, de bout en bout ---------------------------------------

def test_the_coach_can_finally_open_a_short(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    rows = pr.execute_coach_actions([coach_short()], source="daily")

    assert rows[0]["accepted"] is True and rows[0]["action"] == "short"
    position = coach_portfolio()["positions"][0]
    assert position["side"] == "short" and position["qty"] == 15
    assert position["stop_loss"] == 108.0
    assert position["thesis"] == COACH_THESIS


def test_a_bearish_thesis_that_plays_out_earns_money(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    pr.execute_coach_actions([coach_short()], source="daily")
    market.prices["NESN.SW"] = (85.0, "CHF", "Nestle SA")

    pr.execute_coach_actions([{"action": "cover", "symbol": "NESN.SW"}],
                             source="daily")
    trade = coach_portfolio()["trades"][0]
    assert trade["side"] == "short"
    assert trade["entry_price"] == 100.0 and trade["exit_price"] == 85.0
    assert trade["pnl_chf"] > 0            # le cours a BAISSÉ : le short gagne
    assert coach_portfolio()["positions"] == []


def test_a_bearish_thesis_that_fails_loses_money(tmp_path, monkeypatch):
    """Le miroir, et il compte autant : un short qui se trompe PERD quand le
    titre monte. Sans ce test, une erreur de signe passerait pour un gain."""
    c, market = make_client(tmp_path, monkeypatch)
    pr.execute_coach_actions([coach_short()], source="daily")
    market.prices["NESN.SW"] = (106.0, "CHF", "Nestle SA")

    pr.execute_coach_actions([{"action": "cover", "symbol": "NESN.SW"}],
                             source="daily")
    assert coach_portfolio()["trades"][0]["pnl_chf"] < 0


def test_the_stop_of_a_short_fires_upwards_and_honours_the_gap(tmp_path, monkeypatch):
    """Le miroir EXACT de la règle du gap : un stop de rachat à 108 sur une
    bougie qui OUVRE à 115 n'exécute pas à 108 — il exécute à 115. C'est la
    leçon centrale du simulateur, et elle vaut dans les deux sens."""
    c, market = make_client(tmp_path, monkeypatch)
    seed_coach_short(qty=15, stop_loss=108.0)
    market.candles["NESN.SW"] = [
        {"ts": _ts(11), "open": 115.0, "high": 118.0, "low": 114.0, "close": 117.0}]

    result = pr.tick_coach_account()
    assert len(result["stopped"]) == 1
    trade = coach_portfolio()["trades"][0]
    assert trade["exit_price"] == 115.0        # l'ouverture, PAS le seuil
    assert trade["pnl_chf"] < 0
    assert coach_portfolio()["positions"] == []


def test_a_short_pays_fees_on_both_legs(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    pr.execute_coach_actions([coach_short()], source="daily")
    market.prices["NESN.SW"] = (90.0, "CHF", "Nestle SA")
    pr.execute_coach_actions([{"action": "cover", "symbol": "NESN.SW"}],
                             source="daily")

    trade = coach_portfolio()["trades"][0]
    # 15 x 100 à l'entrée, 15 x 90 à la sortie — l'aller ET le retour.
    courtage = (fees.compute_fees("yuh", 1500.0, "NESN.SW")["brokerage_chf"]
                + fees.compute_fees("yuh", 1350.0, "NESN.SW")["brokerage_chf"])
    assert trade["fees_chf"] == pytest.approx(courtage, abs=0.01)
    assert trade["stamp_duty_chf"] > 0
    # Le gain BRUT vaut 150 ; le net est amputé des deux jambes de frais.
    assert trade["pnl_chf"] == pytest.approx(
        150.0 - trade["fees_chf"] - trade["stamp_duty_chf"], abs=0.01)


def test_the_excursions_of_a_short_are_measured_upside_down(tmp_path, monkeypatch):
    """MAE/MFE : pour un vendeur à découvert, le PIRE creux est le plus HAUT
    traversé et le meilleur sommet le plus BAS. ``tradestats`` le sait déjà —
    ce test prouve que le chemin du coach le lui demande correctement."""
    c, market = make_client(tmp_path, monkeypatch)
    pr.execute_coach_actions([coach_short()], source="daily")
    market.candles["NESN.SW"] = [
        {"ts": _ts(1), "open": 100.0, "high": 112.0, "low": 84.0, "close": 90.0}]
    market.prices["NESN.SW"] = (90.0, "CHF", "Nestle SA")
    pr.execute_coach_actions([{"action": "cover", "symbol": "NESN.SW"}],
                             source="daily")

    trade = coach_portfolio()["trades"][0]
    assert trade["mae_pct"] is not None and trade["mfe_pct"] is not None
    assert trade["mae_pct"] < 0            # le titre est monté contre lui
    assert trade["mfe_pct"] > 0            # il est descendu en sa faveur


def test_the_target_of_a_short_becomes_a_limit_buyback(tmp_path, monkeypatch):
    """L'objectif d'un short se prend EN RACHETANT sous le prix : l'ordre en
    attente doit être un ``cover`` limite, pas une vente de plus (qui
    doublerait l'exposition au lieu de la fermer)."""
    c, _ = make_client(tmp_path, monkeypatch)
    pr.execute_coach_actions([coach_short(target=80.0)], source="daily")

    orders = coach_portfolio()["open_orders"]
    assert len(orders) == 1
    assert orders[0]["side"] == "cover" and orders[0]["kind"] == "limit"
    assert orders[0]["limit_price"] == 80.0


def test_the_limit_buyback_of_a_short_actually_closes_it(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    pr.execute_coach_actions([coach_short(target=80.0)], source="daily")
    market.candles["NESN.SW"] = [
        {"ts": _ts(11), "open": 85.0, "high": 86.0, "low": 78.0, "close": 79.0}]

    pr.tick_coach_account()
    portfolio = coach_portfolio()
    assert portfolio["positions"] == []
    assert portfolio["trades"][0]["pnl_chf"] > 0


def test_shorting_a_line_already_held_long_is_refused_with_its_own_reason(
        tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    pr.execute_coach_actions([coach_action()], source="daily")
    rows = pr.execute_coach_actions([coach_short()], source="daily")
    assert rows[0]["accepted"] is False and rows[0]["reason"] == "wrong_side"
    assert "NESN.SW" in (rows[0]["detail"] or "")


# --- B) L'équité : le piège du short ------------------------------------

def test_the_wealth_curve_does_not_inflate_when_the_coach_shorts(
        tmp_path, monkeypatch):
    """⚠️ LE piège de la vente à découvert. La trésorerie ENCAISSE le produit
    de la vente ; si la courbe de patrimoine ajoute EN PLUS la valeur de marché
    de la ligne, le compte a l'air de grossir de 15 % à la seconde où il shorte
    — et de grossir encore quand le titre MONTE contre lui. Une ligne courte
    doit se SOUSTRAIRE : c'est une dette de rachat, pas un avoir."""
    c, market = make_client(tmp_path, monkeypatch)
    pr.execute_coach_actions([coach_short()], source="daily")

    raw = coach_portfolio()
    prices = {"NESN.SW": 100.0}
    rates = {"CHF": 1.0}
    # Au cours d'entrée : l'équité vaut le capital moins les frais payés.
    equity = pr._equity_now_chf(raw, prices, rates)
    assert equity == pytest.approx(10000.0 - fee_total(1500.0), abs=0.01)

    # Le titre BAISSE de 10 % : le short gagne 150 CHF.
    gagnant = pr._equity_now_chf(raw, {"NESN.SW": 90.0}, rates)
    assert gagnant == pytest.approx(equity + 150.0, abs=0.01)

    # Le titre MONTE de 10 % : le short perd 150 CHF.
    perdant = pr._equity_now_chf(raw, {"NESN.SW": 110.0}, rates)
    assert perdant == pytest.approx(equity - 150.0, abs=0.01)


def test_the_coach_reads_the_gain_of_his_own_short_the_right_way_up(
        tmp_path, monkeypatch):
    """Le contexte de sa passe lui montre ses lignes. Un short gagnant affiché
    « -10 % » le pousserait à COUPER un gagnant — l'erreur exacte que son
    mandat lui interdit."""
    c, market = make_client(tmp_path, monkeypatch)
    seed_coach_short(qty=15, avg_price=100.0)
    market.prices["NESN.SW"] = (90.0, "CHF", "Nestle SA")

    context = pr._coach_pass_context(pr._ensure_coach_account(), FIXED_NOW)
    row = context["positions"][0]
    assert row["side"] == "short"
    assert row["pnl_pct"] == pytest.approx(10.0, abs=0.01)


def test_the_book_shown_to_the_model_names_the_side_of_each_line(
        tmp_path, monkeypatch):
    """Sans le sens, le modèle ne peut pas savoir qu'une ligne se solde par un
    RACHAT — il proposerait un ``sell``, refusé."""
    c, _ = make_client(tmp_path, monkeypatch)
    seed_coach_short()
    assert pr.coach_book()["positions"][0]["side"] == "short"


# --- C) adjust_stop : laisser courir sans jamais reculer ----------------

def test_the_coach_can_tighten_the_stop_of_a_winner(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    seed_coach_position(qty=10, stop_loss=90.0)
    market.prices["NESN.SW"] = (120.0, "CHF", "Nestle SA")

    rows = pr.execute_coach_actions(
        [{"action": "adjust_stop", "symbol": "NESN.SW", "stop": 110.0}],
        source="daily")
    assert rows[0]["accepted"] is True and rows[0]["action"] == "adjust_stop"
    assert coach_portfolio()["positions"][0]["stop_loss"] == 110.0
    # Rien ne s'est échangé : ni trade, ni mouvement de trésorerie.
    assert coach_portfolio()["trades"] == []


def test_a_stop_that_retreats_is_refused_and_the_position_keeps_its_own(
        tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    seed_coach_position(qty=10, stop_loss=90.0)

    rows = pr.execute_coach_actions(
        [{"action": "adjust_stop", "symbol": "NESN.SW", "stop": 80.0}],
        source="daily")
    assert rows[0]["reason"] == "stop_widen"
    assert coach_portfolio()["positions"][0]["stop_loss"] == 90.0


def test_tightening_the_stop_of_a_short_means_lowering_it_end_to_end(
        tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    seed_coach_short(qty=15, stop_loss=108.0)
    market.prices["NESN.SW"] = (85.0, "CHF", "Nestle SA")

    rows = pr.execute_coach_actions(
        [{"action": "adjust_stop", "symbol": "NESN.SW", "stop": 92.0}],
        source="daily")
    assert rows[0]["accepted"] is True
    assert coach_portfolio()["positions"][0]["stop_loss"] == 92.0


def test_a_tightened_stop_is_actually_enforced_by_the_tick(tmp_path, monkeypatch):
    """Le stop resserré doit VIVRE dans la position, pas seulement au registre :
    c'est le tick qui l'exécutera."""
    c, market = make_client(tmp_path, monkeypatch)
    seed_coach_position(qty=10, stop_loss=90.0)
    market.prices["NESN.SW"] = (120.0, "CHF", "Nestle SA")
    pr.execute_coach_actions(
        [{"action": "adjust_stop", "symbol": "NESN.SW", "stop": 110.0}],
        source="daily")

    market.candles["NESN.SW"] = [
        {"ts": _ts(11), "open": 115.0, "high": 116.0, "low": 108.0, "close": 109.0}]
    result = pr.tick_coach_account()
    assert len(result["stopped"]) == 1
    assert coach_portfolio()["trades"][0]["exit_price"] == 110.0


# --- D) L'analyse technique dans le contexte ----------------------------

def _serie(n=260, base=100.0):
    """Une série de bougies quotidiennes exploitable par ``ta`` (>= 200 pour
    que la moyenne 200 existe)."""
    out, price = [], base
    depart = _ts(10) - n * 86400.0
    for i in range(n):
        price = price * (1.004 if i % 3 else 0.997)
        out.append({"ts": depart + i * 86400.0, "open": price * 0.998,
                    "high": price * 1.01, "low": price * 0.99,
                    "close": price, "volume": 1000})
    return out


def test_each_candidate_carries_its_technical_summary(tmp_path, monkeypatch):
    """Le refus vécu en prod était « je manque d'un niveau technique fiable
    pour poser un stop ». Le niveau arrive désormais AVEC le cours."""
    c, market = make_client(tmp_path, monkeypatch)
    market.candles["NESN.SW"] = _serie()
    _seed_radar([_open_hyp(["NESN.SW"], "h1")])

    candidat = pr._coach_candidates(pr._open_radar_hypotheses())[0]
    assert candidat["symbol"] == "NESN.SW"
    tech = candidat["technical"]
    assert tech["sma50"] is not None and tech["sma200"] is not None
    assert tech["rsi14"] is not None and tech["atr14"] is not None
    assert tech["week52_high"] is not None


def test_a_broken_candle_feed_does_not_lose_the_candidate(tmp_path, monkeypatch):
    """Best-effort PAR SYMBOLE : sans bougies, le cours reste (il vient d'un
    autre appel) et l'analyse est ABSENTE — jamais inventée, jamais fatale."""
    c, market = make_client(tmp_path, monkeypatch)
    market.broken_candles = getattr(market, "broken_candles", set())
    _seed_radar([_open_hyp(["NESN.SW"], "h1")])

    def _boom(symbol, *a, **kw):
        raise RuntimeError("bougies indisponibles")

    monkeypatch.setattr(pr.quotes, "get_candles", _boom)
    candidat = pr._coach_candidates(pr._open_radar_hypotheses())[0]
    assert candidat["price_chf"] == 100.0
    assert candidat["technical"] is None


def test_the_positions_of_the_pass_carry_their_technical_summary(
        tmp_path, monkeypatch):
    """Gérer une ligne (resserrer un stop, laisser courir) demande les mêmes
    niveaux qu'en ouvrir une."""
    c, market = make_client(tmp_path, monkeypatch)
    market.candles["NESN.SW"] = _serie()
    seed_coach_position(qty=10)

    context = pr._coach_pass_context(pr._ensure_coach_account(), FIXED_NOW)
    assert context["positions"][0]["technical"]["sma50"] is not None


# --- E) Les deux temps : trier, puis instruire --------------------------

class _Speaker(object):
    """Un modèle factice qui COMPTE ses appels et rend une réponse par tour."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.prompts = []

    def __call__(self, prompt, *a, **kw):
        self.prompts.append(prompt)
        if not self.answers:
            return ""
        return self.answers.pop(0)


def _focus_answer(symbols, note="deux dossiers a instruire"):
    import json as _json
    return ("Ma lecture du jour.\n\n```COACH_FOCUS\n"
            + _json.dumps({"focus": list(symbols), "note": note})
            + "\n```")


def _actions_answer(actions, note=None):
    import json as _json
    payload = {"actions": list(actions)}
    if note is not None:
        payload["note"] = note
    return ("Voici ce que je fais.\n\n```COACH_ACTIONS\n"
            + _json.dumps(payload) + "\n```")


def test_an_empty_screening_costs_a_single_call(tmp_path, monkeypatch):
    """Le tri est le point d'économie : quand rien ne mérite un dossier, le
    second appel NE PART PAS. C'est aussi la réponse honnête d'une journée
    sans opportunité — et elle est archivée avec sa raison."""
    c, _ = make_client(tmp_path, monkeypatch)
    speaker = _Speaker(_focus_answer([], note="rien au-dessus de mes criteres"))

    out = pr.run_coach_daily_pass(FIXED_NOW, claude=speaker)
    assert len(speaker.prompts) == 1
    ledger = coach_ledger()
    assert ledger[0]["action"] == "hold"
    assert ledger[0]["detail"] == "rien au-dessus de mes criteres"


def test_a_screening_with_names_costs_two_calls_and_trades(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    market.candles["NESN.SW"] = _serie()
    speaker = _Speaker(_focus_answer(["NESN.SW"]),
                       _actions_answer([coach_action()]))

    pr.run_coach_daily_pass(FIXED_NOW, claude=speaker)
    assert len(speaker.prompts) == 2
    assert coach_portfolio()["positions"][0]["symbol"] == "NESN.SW"


def test_the_screening_is_capped_at_three_names(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    for symbol in ("NESN.SW", "ROG.SW", "ABBN.SW", "UBSG.SW", "ZURN.SW"):
        market.prices[symbol] = (100.0, "CHF", symbol)
        market.candles[symbol] = _serie()
    speaker = _Speaker(
        _focus_answer(["NESN.SW", "ROG.SW", "ABBN.SW", "UBSG.SW", "ZURN.SW"]),
        _actions_answer([]))

    pr.run_coach_daily_pass(FIXED_NOW, claude=speaker)
    dossiers = speaker.prompts[1]
    assert "UBSG.SW" not in dossiers and "ZURN.SW" not in dossiers
    assert "NESN.SW" in dossiers


def test_the_second_prompt_carries_the_full_file_of_the_chosen_names(
        tmp_path, monkeypatch):
    """Le tri voit BEAUCOUP de titres et peu de choses ; le dossier voit TROIS
    titres et tout ce qu'on sait d'eux. C'est là qu'est le gain."""
    c, market = make_client(tmp_path, monkeypatch)
    market.candles["NESN.SW"] = _serie()
    speaker = _Speaker(_focus_answer(["NESN.SW"]), _actions_answer([]))

    pr.run_coach_daily_pass(FIXED_NOW, claude=speaker)
    dossier = speaker.prompts[1]
    assert "DOSSIERS" in dossier
    assert "sma200" in dossier and "rsi14" in dossier and "atr14" in dossier


def test_an_unreadable_screening_stops_the_pass_without_inventing_orders(
        tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    speaker = _Speaker("```COACH_FOCUS\n{casse\n```")

    pr.run_coach_daily_pass(FIXED_NOW, claude=speaker)
    assert len(speaker.prompts) == 1               # aucun second appel
    assert coach_ledger()[0]["action"] == "parse"
    assert coach_portfolio()["positions"] == []


def test_a_screening_without_a_block_is_a_hold_not_a_failure(tmp_path, monkeypatch):
    """Pas de bloc = le coach n'a rien à instruire aujourd'hui. C'est une
    journée normale, pas une panne — et les deux doivent se distinguer."""
    c, _ = make_client(tmp_path, monkeypatch)
    speaker = _Speaker("Je ne vois rien de convaincant aujourd'hui.")

    pr.run_coach_daily_pass(FIXED_NOW, claude=speaker)
    assert len(speaker.prompts) == 1
    assert coach_ledger()[0]["action"] == "hold"


def test_a_model_failure_on_the_first_call_is_logged_as_such(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)

    def _boom(prompt, *a, **kw):
        raise RuntimeError("CLI absent")

    pr.run_coach_daily_pass(FIXED_NOW, claude=_boom)
    assert coach_ledger()[0]["reason"] == "llm_failed"


def test_the_weekend_pass_refuses_stocks_and_keeps_crypto(tmp_path, monkeypatch):
    """Créneau du week-end : les bourses sont fermées. Un ordre sur une action
    y dormirait jusqu'au lundi pour s'exécuter à un prix que personne n'a vu."""
    c, market = make_client(tmp_path, monkeypatch)
    market.prices["BTC-USD"] = (100.0, "USD", "Bitcoin")
    market.candles["BTC-USD"] = _serie()
    market.candles["NESN.SW"] = _serie()
    speaker = _Speaker(
        _focus_answer(["NESN.SW", "BTC-USD"]),
        _actions_answer([coach_action(),
                         coach_action(symbol="BTC-USD", qty=15, stop=90.0)]))

    pr.run_coach_daily_pass(FIXED_NOW, claude=speaker, crypto_only=True)
    rows = {row["symbol"]: row for row in coach_ledger() if row["symbol"]}
    assert rows["NESN.SW"]["reason"] == "market_closed"
    assert rows["BTC-USD"]["accepted"] is True


# --- F) Hygiène des tickers : les fantômes ne polluent plus l'univers ----

def test_the_coach_skips_a_ticker_the_market_does_not_know(tmp_path, monkeypatch):
    """Vécu : « SAP.TO » n'existe pas chez Yahoo. Marqué à la naissance de
    l'hypothèse, il ne doit plus jamais arriver jusqu'aux candidats — sinon sa
    cotation échoue à chaque passe, en silence, et il occupe une place."""
    c, market = make_client(tmp_path, monkeypatch)
    # ⚠️ Le faux marche COTE ce symbole : sans cela, le test passerait pour la
    # mauvaise raison (candidat omis faute de cours) et ne prouverait RIEN sur
    # la marque. C'est bien la MARQUE qu'on veut voir agir.
    market.prices["SAP.TO"] = (120.0, "CHF", "SAP fantome")
    hyp = _open_hyp(["SAP.TO", "NESN.SW"], "h1")
    hyp["unquoted"] = ["SAP.TO"]
    _seed_radar([hyp])

    assert pr._coach_quote("SAP.TO") is not None      # cotable, donc discriminant
    symbols = [row["symbol"]
               for row in pr._coach_candidates(pr._open_radar_hypotheses())]
    assert symbols == ["NESN.SW"]


def test_an_unmarked_hypothesis_keeps_all_its_tickers(tmp_path, monkeypatch):
    c, market = make_client(tmp_path, monkeypatch)
    market.prices["AAPL"] = (200.0, "USD", "Apple Inc")
    _seed_radar([_open_hyp(["AAPL", "NESN.SW"], "h1")])

    symbols = [row["symbol"]
               for row in pr._coach_candidates(pr._open_radar_hypotheses())]
    assert symbols == ["AAPL", "NESN.SW"]


def test_a_ticker_muted_in_one_hypothesis_survives_in_another(tmp_path, monkeypatch):
    """La marque est PAR HYPOTHÈSE : si une autre hypothèse cite le même
    ticker sans le marquer, c'est qu'il cotait au moment de SA naissance — on
    ne le condamne pas sur la foi d'un contrôle plus ancien."""
    c, market = make_client(tmp_path, monkeypatch)
    muette = _open_hyp(["NESN.SW"], "h1")
    muette["unquoted"] = ["NESN.SW"]
    _seed_radar([muette, _open_hyp(["NESN.SW"], "h2")])

    symbols = [row["symbol"]
               for row in pr._coach_candidates(pr._open_radar_hypotheses())]
    assert symbols == ["NESN.SW"]


def test_the_pass_context_carries_the_recent_calendar_verdicts(tmp_path, monkeypatch):
    """« Le rendez-vous a-t-il tenu ce qu'il annonçait ? » — c'est ce qui
    distingue un catalyseur qui a produit son effet d'un autre passé sans rien
    donner, donc une thèse vivante d'une thèse à couper."""
    c, _ = make_client(tmp_path, monkeypatch)
    rendus = [{"key": "k1", "label": "FOMC", "verdict": "tenu",
               "move_pct": 1.4, "date": "2026-08-25"}]
    monkeypatch.setattr(pr._calendar(), "recent_verdicts",
                        lambda *a, **kw: rendus)

    context = pr._coach_pass_context(pr._ensure_coach_account(), FIXED_NOW)
    assert context["verdicts"] == rendus


def test_a_broken_calendar_never_stops_the_pass(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)

    def _boom(*a, **kw):
        raise RuntimeError("verdicts illisibles")

    monkeypatch.setattr(pr._calendar(), "recent_verdicts", _boom)
    assert pr._coach_pass_context(pr._ensure_coach_account(),
                                  FIXED_NOW)["verdicts"] == []
