"""Tests du LOT C — news TradingView, calendrier économique, focus, agenda.

100 % hors ligne : le client HTTP est INJECTÉ partout (une doublure qui rend
des charges utiles), l'horloge aussi, et ``store.DATA_DIR`` pointe sur
``tmp_path`` dans chaque test. Les charges utiles viennent des fixtures RÉELLES
capturées le 09/09 (``backend/bots/tests/fixtures/tvcoach/``) — pas de JSON
inventé pour les parseurs : c'est la forme du vrai flux qu'on épingle.

⚠️ Le test le plus important du fichier est
``test_l_etat_du_guetteur_garde_exactement_ces_cles`` : il fige la forme
COMPLÈTE de l'état de ``newswatch`` après un cycle et vérifie que TOUT ce qui
est écrit est relu. C'est le piège documenté en tête de ``_load_seen_state`` —
une clé d'état absente de l'allowlist est silencieusement perdue à la
relecture, et rien ne le signale.
"""
import functools
import json
import os
import stat
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.auth.utils import get_current_user
from backend.bots import paper_tv_router, paper_ws
from backend.bots.paper import calendar as cal
from backend.bots.paper import focus, newswatch, store, tvcalendar, tvnews

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "tvcoach"

# Le 09/09 à 20:30 UTC — l'instant des captures (les dépêches du flux BTC sont
# horodatées quelques minutes avant).
NOW = datetime(2026, 9, 9, 20, 30, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _isolate_data_dir(tmp_path, monkeypatch):
    """Aucun test n'écrit dans le vrai ``data/paper_trading/``."""
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    return tmp_path


@pytest.fixture(autouse=True)
def _no_ws_loop():
    """``emit`` doit rester un no-op : aucun test d'ici ne monte de serveur."""
    paper_ws.reset_loop()
    paper_ws.manager.clients.clear()
    yield
    paper_ws.reset_loop()
    paper_ws.manager.clients.clear()


def _fixture(name):
    with open(str(FIXTURES / name), "r", encoding="utf-8") as handle:
        return json.load(handle)


# --------------------------------------------------------------------------- #
# Doublure HTTP
# --------------------------------------------------------------------------- #

class _Response(object):
    def __init__(self, payload=None, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


class _Client(object):
    """Client hors ligne : une réponse par MOTIF d'URL, dans l'ordre déclaré.

    ``routes`` accepte une réponse, une exception (levée) ou une liste
    consommée appel après appel (pour scripter deux cycles successifs).
    """

    def __init__(self, default=None):
        self.calls = []
        self.routes = []
        self.default = default if default is not None else _Response({"items": []})

    def route(self, needle, response):
        self.routes.append([needle, response])
        return self

    def get(self, url, headers=None):
        self.calls.append((url, dict(headers or {})))
        for entry in self.routes:
            if entry[0] in url:
                answer = entry[1]
                if isinstance(answer, list):
                    answer = answer.pop(0) if answer else self.default
                if isinstance(answer, Exception):
                    raise answer
                return answer
        answer = self.default
        if isinstance(answer, Exception):
            raise answer
        return answer

    def urls(self):
        return [url for url, _ in self.calls]


# =========================================================================== #
#  tvnews — le pont TradingView <-> Yahoo
# =========================================================================== #

@pytest.mark.parametrize("tv_symbol,expected", [
    ("BITSTAMP:BTCUSD", "BTC-USD"),
    ("BINANCE:BTCUSDT", "BTC-USD"),
    ("BINANCE:BTCUSDT.P", "BTC-USD"),
    ("KRAKEN:XBTUSD", "BTC-USD"),
    ("COINBASE:BTCUSD", "BTC-USD"),
    ("BITSTAMP:ETHUSD", "ETH-USD"),
    ("NASDAQ:AAPL", "AAPL"),
    ("NYSE:KO", "KO"),
    ("AMEX:SPY", "SPY"),
    ("SIX:NESN", "NESN.SW"),
    ("BX:NESN", "NESN.SW"),
    ("XETR:SAP", "SAP.DE"),
    ("EURONEXT:MC", "MC.PA"),
    ("LSE:SHEL", "SHEL.L"),
    ("MIL:ENI", "ENI.MI"),
    ("FX:EURUSD", "EURUSD=X"),
    ("TVC:UKOIL", "BZ=F"),
    ("TVC:GOLD", "GC=F"),
    ("CME:BTC1!", "BTC=F"),
])
def test_le_repli_local_du_mapping_couvre_les_places_rencontrees(tv_symbol, expected):
    """Le repli LOCAL (sans ``brief``) doit suffire à ce module : il est testé
    seul, sans dépendre d'un lot voisin."""
    assert tvnews._fallback_tv_to_yahoo(tv_symbol) == expected


@pytest.mark.parametrize("tv_symbol", [
    "", "AAPL", "PLACEINCONNUE:XYZ", "BITSTAMP:", ":AAPL", None,
])
def test_un_symbole_non_mappable_rend_none(tv_symbol):
    assert tvnews._fallback_tv_to_yahoo(tv_symbol) is None


def test_le_mapping_delegue_a_brief_quand_il_existe(monkeypatch):
    """``brief.tv_to_yahoo`` est la table de RÉFÉRENCE : quand elle est là,
    c'est elle qui parle."""
    import sys
    import types
    fake = types.ModuleType("backend.bots.paper.brief")
    fake.tv_to_yahoo = lambda tv: "REPONSE-DE-BRIEF"
    monkeypatch.setitem(sys.modules, "backend.bots.paper.brief", fake)
    assert tvnews.tv_to_yahoo("NASDAQ:AAPL") == "REPONSE-DE-BRIEF"


def test_un_brief_en_panne_ne_casse_pas_le_mapping(monkeypatch):
    import sys
    import types

    def _boom(_tv):
        raise RuntimeError("table cassée")

    fake = types.ModuleType("backend.bots.paper.brief")
    fake.tv_to_yahoo = _boom
    monkeypatch.setitem(sys.modules, "backend.bots.paper.brief", fake)
    assert tvnews.tv_to_yahoo("NASDAQ:AAPL") == "AAPL"


@pytest.mark.parametrize("symbol,expected", [
    ("BTC-USD", "BITSTAMP:BTCUSD"),
    ("ETH-USD", "BITSTAMP:ETHUSD"),
    ("NESN.SW", "SIX:NESN"),
    ("SAP.DE", "XETR:SAP"),
    ("AAPL", "NASDAQ:AAPL"),
    ("GOV", None),                 # pseudo-symbole -> aucune place
    ("", None),
    ("INCONNU.XX", None),
])
def test_yahoo_to_tv(symbol, expected):
    got = tvnews.yahoo_to_tv(symbol)
    if expected is None:
        assert got is None or symbol == "GOV"
    else:
        assert got == expected


# =========================================================================== #
#  tvnews — parseurs sur les fixtures RÉELLES
# =========================================================================== #

def test_parse_items_sur_la_fixture_btc():
    payload = _fixture("tv_news_btc.json")
    items = tvnews.parse_items(payload, "BITSTAMP:BTCUSD")
    assert len(items) == 200
    first = items[0]
    assert set(first) == {"id", "title", "published", "provider", "urgency",
                          "story_path", "related", "tv_symbol", "symbol", "url"}
    assert first["symbol"] == "BTC-USD"
    assert first["provider"] == "cryptobriefing"
    assert first["published"].startswith("2026-09-09T")
    assert first["url"].startswith("https://www.tradingview.com/news/")
    assert "BITSTAMP:BTCUSD" in first["related"]
    assert all(i["symbol"] for i in items[:20])


def test_parse_items_sur_la_fixture_aapl():
    payload = _fixture("tv_news_aapl.json")
    items = tvnews.parse_items(payload, "NASDAQ:AAPL")
    assert len(items) == 200
    assert items[0]["symbol"] == "AAPL"
    assert items[0]["provider"] == "dow-jones"
    assert items[0]["urgency"] == 2
    assert items[0]["id"] == "DJN_DN20260909007319:0"


def test_parse_items_jette_ce_qui_n_a_ni_titre_ni_date():
    payload = {"items": [
        {"id": "1", "title": "", "published": 1788976046},
        {"id": "2", "title": "sans date"},
        {"id": "3", "title": "complet", "published": 1788976046},
    ]}
    items = tvnews.parse_items(payload, "NASDAQ:AAPL")
    assert [i["id"] for i in items] == ["3"]


def test_parse_items_dedoublonne_par_id():
    payload = {"items": [
        {"id": "1", "title": "a", "published": 1788976046},
        {"id": "1", "title": "a (repris)", "published": 1788976100},
    ]}
    assert len(tvnews.parse_items(payload, "NASDAQ:AAPL")) == 1


def test_parse_items_prend_le_symbole_du_premier_related_mappable():
    payload = {"items": [{
        "id": "1", "title": "a", "published": 1788976046,
        "relatedSymbols": [{"symbol": "PLACEINCONNUE:XYZ"},
                           {"symbol": "NASDAQ:NVDA"}],
    }]}
    assert tvnews.parse_items(payload, "NASDAQ:AAPL")[0]["symbol"] == "NVDA"


def test_parse_items_retombe_sur_le_symbole_demande():
    payload = {"items": [{
        "id": "1", "title": "a", "published": 1788976046,
        "relatedSymbols": [{"symbol": "PLACEINCONNUE:XYZ"}],
    }]}
    assert tvnews.parse_items(payload, "SIX:NESN")[0]["symbol"] == "NESN.SW"


def test_parse_items_accepte_un_epoch_en_millisecondes():
    payload = {"items": [{"id": "1", "title": "a", "published": 1788976046000}]}
    assert tvnews.parse_items(payload, "NASDAQ:AAPL")[0]["published"].startswith("2026-09-09T")


def test_parse_items_sur_une_charge_utile_cassee_rend_une_liste_vide():
    for payload in (None, {}, {"items": "pas une liste"}, 42, [None, 3]):
        assert tvnews.parse_items(payload, "NASDAQ:AAPL") == []


def test_parse_story_prend_la_description_courte():
    body = tvnews.parse_story(_fixture("tv_story.json"))
    assert body.startswith("Apple announces a new computer chip")
    assert len(body) <= tvnews.STORY_MAX_LEN


def test_parse_story_retombe_sur_l_arbre_ast():
    payload = dict(_fixture("tv_story.json"))
    payload.pop("shortDescription")
    body = tvnews.parse_story(payload)
    assert body and "A20 Pro" in body


def test_parse_story_tronque_a_1200_caracteres():
    payload = {"shortDescription": "x" * 5000}
    assert len(tvnews.parse_story(payload)) == tvnews.STORY_MAX_LEN


def test_parse_story_sans_rien_d_exploitable_rend_none():
    for payload in (None, {}, {"shortDescription": "   "}, {"astDescription": {}}):
        assert tvnews.parse_story(payload) is None


# =========================================================================== #
#  tvnews — événements
# =========================================================================== #

def _item(**kwargs):
    base = {"id": "i1", "title": "Apple beats estimates",
            "published": "2026-09-09T20:00:00+00:00", "provider": "reuters",
            "urgency": 2, "story_path": "/news/i1/", "related": ["NASDAQ:AAPL"],
            "tv_symbol": "NASDAQ:AAPL", "symbol": "AAPL",
            "url": "https://www.tradingview.com/news/i1/"}
    base.update(kwargs)
    return base


def test_un_evenement_porte_la_forme_de_newswatch():
    event = tvnews.to_events([_item()])[0]
    assert set(event) == {"ts", "symbol", "title", "link", "sentiment",
                          "source", "src", "provider", "curated", "muted",
                          "story"}
    assert event["source"] == "tradingview"
    assert event["symbol"] == "AAPL"
    assert event["muted"] is True          # ce volet n'envoie JAMAIS
    assert event["ts"] == "2026-09-09T20:00:00+00:00"


def test_le_sentiment_vient_du_classifieur_du_depot():
    positif = tvnews.to_events([_item(title="Nestlé beats estimates")])[0]
    neutre = tvnews.to_events([_item(title="Apple ouvre un magasin")])[0]
    assert positif["sentiment"] == newswatch.classify("Nestlé beats estimates")
    assert neutre["sentiment"] == newswatch.NEUTRAL_SENTIMENT


def test_un_titre_crypto_sans_symbole_recupere_sa_paire():
    event = tvnews.to_events([_item(symbol=None,
                                    title="Bitcoin rallies past resistance")])[0]
    assert event["symbol"] == "BTC-USD"


def test_un_titre_sans_symbole_ni_crypto_reste_sans_symbole():
    event = tvnews.to_events([_item(symbol=None, title="Le marché hésite")])[0]
    assert event["symbol"] is None


def test_une_depeche_curee_sur_un_titre_detenu_peut_reveiller_seule():
    """``curated`` -> ``src`` dans ``convergence.CURATED_NEWS_SOURCES``, donc
    le facteur ``held_risk`` (qui tire SEUL) peut s'allumer."""
    from backend.bots.paper import convergence
    event = tvnews.to_events([_item(provider="reuters")], held=["AAPL"])[0]
    assert event["curated"] is True
    assert event["src"] in convergence.CURATED_NEWS_SOURCES
    assert convergence._curated(event) is True


@pytest.mark.parametrize("kwargs,held", [
    ({"provider": "benzinga"}, ["AAPL"]),      # fournisseur non curé
    ({"urgency": 5}, ["AAPL"]),                # trop peu urgent
    ({}, []),                                  # titre non détenu
])
def test_hors_des_trois_conditions_la_depeche_ne_reveille_pas_seule(kwargs, held):
    from backend.bots.paper import convergence
    event = tvnews.to_events([_item(**kwargs)], held=held)[0]
    assert event["curated"] is False
    assert convergence._curated(event) is False


def test_le_corps_charge_est_rangé_avec_l_evenement():
    event = tvnews.to_events([_item()], held=["AAPL"],
                             bodies={"i1": "le corps"})[0]
    assert event["body"] == "le corps"


@pytest.mark.parametrize("kwargs,held,expected", [
    ({}, ["AAPL"], True),
    ({"provider": "dow-jones"}, ["AAPL"], True),
    ({"provider": "benzinga"}, ["AAPL"], False),
    ({"urgency": 3}, ["AAPL"], False),
    ({"urgency": None}, ["AAPL"], False),
    ({}, ["NESN.SW"], False),
    ({"symbol": None}, ["AAPL"], False),
])
def test_needs_story(kwargs, held, expected):
    assert tvnews.needs_story(_item(**kwargs), held) is expected


# =========================================================================== #
#  tvnews — collecte (client injecté)
# =========================================================================== #

def test_fetch_items_appelle_l_url_exacte_avec_les_bons_en_tetes():
    client = _Client(_Response(_fixture("tv_news_aapl.json")))
    items = tvnews.fetch_items(client, "NASDAQ:AAPL", "fr")
    assert len(items) == 200
    url, headers = client.calls[0]
    assert url == ("https://news-mediator.tradingview.com/news-flow/v2/news"
                   "?filter=lang:fr&filter=symbol:NASDAQ:AAPL"
                   "&client=web&streaming=false")
    assert headers["User-Agent"] == "Mozilla/5.0 (OmenServer coach)"
    assert headers["Origin"] == "https://www.tradingview.com"


@pytest.mark.parametrize("status", [429, 500, 403])
def test_un_statut_en_erreur_rend_une_liste_vide_sans_exception(status):
    client = _Client(_Response({"items": []}, status_code=status))
    assert tvnews.fetch_items(client, "NASDAQ:AAPL") == []


def test_une_panne_reseau_rend_une_liste_vide_sans_exception():
    client = _Client(RuntimeError("réseau coupé"))
    assert tvnews.fetch_items(client, "NASDAQ:AAPL") == []


def test_fetch_story_appelle_l_url_exacte():
    client = _Client(_Response(_fixture("tv_story.json")))
    body = tvnews.fetch_story(client, "DJN_DN20260909007319:0", "en")
    assert body.startswith("Apple announces")
    assert client.urls()[0] == ("https://news-headlines.tradingview.com/v2/story"
                                "?id=DJN_DN20260909007319:0&lang=en")


def test_fetch_story_sans_identifiant_ne_sort_pas():
    client = _Client(_Response({}))
    assert tvnews.fetch_story(client, "") is None
    assert client.calls == []


# =========================================================================== #
#  tvnews — le cycle : cadence, budget, déduplication, focus
# =========================================================================== #

def _news_payload(*ids):
    return {"items": [
        {"id": ident, "title": "Titre %s" % ident, "published": 1788976046,
         "urgency": 2, "storyPath": "/news/%s/" % ident,
         "provider": {"id": "benzinga"},
         "relatedSymbols": [{"symbol": "NASDAQ:AAPL"}]}
        for ident in ids
    ]}


def test_un_premier_passage_collecte_et_rend_des_evenements():
    client = _Client(_Response(_news_payload("a", "b")))
    state = {}
    events = tvnews.run({"bob": ["AAPL"]}, None, client, state, NOW,
                        langs=("en",))
    assert [e["title"] for e in events] == ["Titre a", "Titre b"]
    assert state["last_fetch"]["NASDAQ:AAPL"] == NOW.isoformat()
    assert set(state["seen_ids"]) == {"a", "b"}
    assert state["requests"] == 1


def test_un_symbole_n_est_pas_reinterroge_avant_soixante_secondes():
    client = _Client(_Response(_news_payload("a")))
    state = {}
    tvnews.run({"bob": ["AAPL"]}, None, client, state, NOW, langs=("en",))
    assert len(client.calls) == 1

    tvnews.run({"bob": ["AAPL"]}, None, client, state,
               NOW + timedelta(seconds=59), langs=("en",))
    assert len(client.calls) == 1          # la cadence a tenu

    tvnews.run({"bob": ["AAPL"]}, None, client, state,
               NOW + timedelta(seconds=61), langs=("en",))
    assert len(client.calls) == 2          # ... et elle rouvre à 60 s


def test_une_depeche_deja_vue_ne_ressort_pas():
    client = _Client(_Response(_news_payload("a")))
    state = {}
    assert len(tvnews.run({"bob": ["AAPL"]}, None, client, state, NOW,
                          langs=("en",))) == 1
    again = tvnews.run({"bob": ["AAPL"]}, None, client, state,
                       NOW + timedelta(seconds=61), langs=("en",))
    assert again == []


def test_la_fenetre_de_deduplication_est_bornee():
    state = {"seen_ids": ["vieux-%d" % i for i in range(tvnews.SEEN_MAX)]}
    client = _Client(_Response(_news_payload("neuf")))
    tvnews.run({"bob": ["AAPL"]}, None, client, state, NOW, langs=("en",))
    assert len(state["seen_ids"]) == tvnews.SEEN_MAX
    assert state["seen_ids"][-1] == "neuf"
    assert "vieux-0" not in state["seen_ids"]


def test_le_budget_de_requetes_borne_le_cycle():
    client = _Client(_Response(_news_payload("a")))
    symbols = ["SYM%d" % i for i in range(20)]
    state = {}
    tvnews.run({"bob": symbols}, None, client, state, NOW, budget=5,
               langs=("en",))
    assert len(client.calls) == 5
    assert state["requests"] == 5


def test_les_deux_langues_sont_demandees_par_defaut():
    client = _Client(_Response(_news_payload("a")))
    tvnews.run({"bob": ["AAPL"]}, None, client, {}, NOW)
    assert [u for u in client.urls() if "lang:en" in u]
    assert [u for u in client.urls() if "lang:fr" in u]


def test_un_symbole_non_mappable_ne_coute_aucune_requete():
    client = _Client(_Response(_news_payload("a")))
    tvnews.run({"bob": ["NESN.XX", "PAS-UN-SYMBOLE.ZZ"]}, None, client, {}, NOW)
    assert client.calls == []


def test_un_429_laisse_une_trace_dans_l_etat_sans_lever():
    client = _Client(_Response({"items": []}, status_code=429))
    state = {}
    assert tvnews.run({"bob": ["AAPL"]}, None, client, state, NOW,
                      langs=("en",)) == []
    assert state["errors"] == 1
    assert state["last_error"] == NOW.isoformat()


def test_un_flux_simplement_vide_n_est_pas_une_anomalie():
    client = _Client(_Response({"items": []}))
    state = {}
    tvnews.run({"bob": ["AAPL"]}, None, client, state, NOW, langs=("en",))
    assert int(state.get("errors") or 0) == 0


def test_le_corps_n_est_charge_que_pour_une_depeche_curee_et_detenue():
    payload = {"items": [
        {"id": "curee", "title": "Apple warns", "published": 1788976046,
         "urgency": 2, "storyPath": "/news/curee/",
         "provider": {"id": "reuters"},
         "relatedSymbols": [{"symbol": "NASDAQ:AAPL"}]},
        {"id": "bruit", "title": "Apple rumor", "published": 1788976046,
         "urgency": 2, "storyPath": "/news/bruit/",
         "provider": {"id": "benzinga"},
         "relatedSymbols": [{"symbol": "NASDAQ:AAPL"}]},
    ]}
    client = _Client()
    client.route("news-flow", _Response(payload))
    client.route("story", _Response({"shortDescription": "le corps curé"}))
    events = tvnews.run({"bob": ["AAPL"]}, None, client, {}, NOW,
                        held=["AAPL"], langs=("en",))
    story_calls = [u for u in client.urls() if "story?id=" in u]
    assert len(story_calls) == 1 and "curee" in story_calls[0]
    bodies = {e["title"]: e.get("body") for e in events}
    assert bodies["Apple warns"] == "le corps curé"
    assert bodies["Apple rumor"] is None


def test_le_titre_en_focus_est_scanne_meme_sans_position():
    client = _Client(_Response(_news_payload("a")))
    tvnews.run({}, {"bob": "BTC-USD"}, client, {}, NOW, langs=("en",))
    assert "BITSTAMP:BTCUSD" in client.urls()[0]


def test_les_news_du_titre_en_focus_partent_sur_le_websocket():
    client = _Client(_Response(_news_payload("a")))
    pushed = []
    tvnews.run({"bob": ["AAPL"]}, {"bob": "AAPL"}, client, {}, NOW,
               emit=lambda *args: pushed.append(args), langs=("en",))
    assert len(pushed) == 1
    username, kind, symbol, payload = pushed[0]
    assert (username, kind, symbol) == ("bob", "news", "AAPL")
    assert payload["title"] == "Titre a"


def test_sans_focus_rien_ne_part_sur_le_websocket():
    """Le pendant du test précédent : le push est CIBLÉ, pas systématique."""
    client = _Client(_Response(_news_payload("a")))
    pushed = []
    tvnews.run({"bob": ["AAPL"]}, None, client, {}, NOW,
               emit=lambda *args: pushed.append(args), langs=("en",))
    assert pushed == []


def test_un_push_en_panne_ne_fait_perdre_aucun_evenement():
    def _boom(*_args):
        raise RuntimeError("socket mort")

    client = _Client(_Response(_news_payload("a")))
    events = tvnews.run({"bob": ["AAPL"]}, {"bob": "AAPL"}, client, {}, NOW,
                        emit=_boom, langs=("en",))
    assert len(events) == 1


# =========================================================================== #
#  tvnews — le CACHE par symbole (« ce que TradingView montre »)
#
#  Vécu le 11/09 : TradingView affichait une dépêche française de 15 min sur
#  BTC-USD, le coach « Aucune dépêche récente ». L'item était bien dans
#  ``seen_ids`` — vu une fois pendant que Massii regardait UKOIL, donc jamais
#  distribué à son compte, et jamais réémis ensuite. La dédup globale est faite
#  pour les ALERTES ; la fiche, elle, doit montrer l'état du flux.
# =========================================================================== #

def _row(ident, published, **kw):
    row = {"id": ident, "title": "Titre %s" % ident, "published": published,
           "provider": "reuters", "url": "https://tv.test/%s" % ident,
           "lang": "en", "symbol": "BTC-USD", "tv_symbol": "BITSTAMP:BTCUSD",
           "urgency": 2}
    row.update(kw)
    return row


def test_merge_symbol_items_trie_du_plus_recent_au_plus_ancien():
    merged = tvnews.merge_symbol_items(
        [_row("vieux", "2026-09-11T08:00:00+00:00")],
        [_row("neuf", "2026-09-11T10:00:00+00:00"),
         _row("moyen", "2026-09-11T09:00:00+00:00")])
    assert [r["id"] for r in merged] == ["neuf", "moyen", "vieux"]


def test_merge_symbol_items_dedoublonne_par_id_et_garde_le_frais():
    merged = tvnews.merge_symbol_items(
        [_row("a", "2026-09-11T08:00:00+00:00", title="ancien titre")],
        [_row("a", "2026-09-11T08:00:00+00:00", title="titre corrigé")])
    assert len(merged) == 1
    assert merged[0]["title"] == "titre corrigé"


def test_merge_symbol_items_dedoublonne_les_deux_langues():
    """Le même flux en ``en`` et en ``fr`` rend le même ``id`` : une seule
    ligne, celle de la dernière langue lue."""
    fresh = [_row("x", "2026-09-11T10:00:00+00:00", lang="en"),
             _row("x", "2026-09-11T10:00:00+00:00", lang="fr",
                  title="Titre français")]
    merged = tvnews.merge_symbol_items([], fresh)
    assert len(merged) == 1 and merged[0]["lang"] == "fr"


def test_merge_symbol_items_borne_la_liste():
    fresh = [_row("i%02d" % i, "2026-09-11T%02d:00:00+00:00" % i)
             for i in range(20)]
    merged = tvnews.merge_symbol_items([], fresh)
    assert len(merged) == tvnews.SYMBOL_ITEMS_MAX
    assert merged[0]["id"] == "i19"                  # les plus RÉCENTS
    assert tvnews.merge_symbol_items([], fresh, limit=3) == merged[:3]


@pytest.mark.parametrize("garbage", [None, "pas une liste", 42, {"a": 1}])
def test_merge_symbol_items_avale_n_importe_quoi(garbage):
    assert tvnews.merge_symbol_items(garbage, garbage) == []


def test_merge_symbol_items_jette_les_lignes_sans_date_ni_titre():
    fresh = [{"id": "sans-date", "title": "Titre"},
             {"id": "sans-titre", "published": "2026-09-11T10:00:00+00:00"},
             "pas un dict",
             _row("bon", "2026-09-11T10:00:00+00:00")]
    assert [r["id"] for r in tvnews.merge_symbol_items([], fresh)] == ["bon"]


def test_le_cycle_remplit_le_cache_meme_quand_tout_est_deja_vu():
    """LE cas vécu : les ids sont tous dans ``seen_ids``, aucun événement ne
    sort — et la fiche doit quand même savoir ce que TradingView affiche."""
    client = _Client(_Response(_news_payload("a", "b")))
    state = {"seen_ids": ["a", "b"]}
    events = tvnews.run({"bob": ["AAPL"]}, None, client, state, NOW,
                        langs=("en",))
    assert events == []                              # rien de neuf : normal
    cache = state["items_by_symbol"]["NASDAQ:AAPL"]
    assert cache["fetched_at"] == NOW.isoformat()
    assert [r["id"] for r in cache["items"]] == ["a", "b"]
    assert cache["items"][0]["symbol"] == "AAPL"
    assert cache["items"][0]["lang"] == "en"
    assert set(cache["items"][0]) == {"id", "title", "published", "provider",
                                      "url", "lang", "symbol", "tv_symbol",
                                      "urgency"}


def test_le_cache_fusionne_les_deux_langues_et_survit_au_cycle_suivant():
    client = _Client(_Response(_news_payload("a")))
    state = {}
    tvnews.run({"bob": ["AAPL"]}, None, client, state, NOW)
    assert len(state["items_by_symbol"]["NASDAQ:AAPL"]["items"]) == 1

    client2 = _Client(_Response(_news_payload("b")))
    tvnews.run({"bob": ["AAPL"]}, None, client2, state,
               NOW + timedelta(seconds=61), langs=("en",))
    ids = [r["id"] for r in state["items_by_symbol"]["NASDAQ:AAPL"]["items"]]
    assert sorted(ids) == ["a", "b"]                 # l'ancien n'est pas perdu


def test_un_flux_en_panne_ne_vide_pas_le_cache():
    state = {"items_by_symbol": {
        "NASDAQ:AAPL": {"fetched_at": "2026-09-11T09:00:00+00:00",
                        "items": [_row("a", "2026-09-11T09:00:00+00:00")]}}}
    client = _Client(_Response({"items": []}, status_code=500))
    tvnews.run({"bob": ["AAPL"]}, None, client, state, NOW, langs=("en",))
    cache = state["items_by_symbol"]["NASDAQ:AAPL"]
    assert [r["id"] for r in cache["items"]] == ["a"]
    assert cache["fetched_at"] == "2026-09-11T09:00:00+00:00"


def test_cached_items_lit_un_etat_injecte():
    state = {"items_by_symbol": {"BITSTAMP:BTCUSD": {
        "fetched_at": NOW.isoformat(),
        "items": [_row("a", "2026-09-11T10:00:00+00:00"),
                  _row("b", "2026-09-11T09:00:00+00:00")]}}}
    got = tvnews.cached_items("BITSTAMP:BTCUSD", state=state)
    assert [r["id"] for r in got] == ["a", "b"]
    assert tvnews.cached_items("BITSTAMP:BTCUSD", state=state, limit=1) == got[:1]


def test_cached_items_rend_une_liste_vide_quand_le_symbole_est_absent():
    for state in ({}, {"items_by_symbol": {}}, {"items_by_symbol": "cassé"},
                  None):
        assert tvnews.cached_items("SIX:NESN", state=state or {}) == []


def test_cached_items_retrouve_le_symbole_par_le_detour_yahoo():
    """L'extension affiche ``BINANCE:BTCUSDT.P``, le cycle a rangé sous
    ``BITSTAMP:BTCUSD`` (la place de la table inverse) : le pont Yahoo fait le
    raccord, sinon la fiche du bitcoin resterait vide à jamais."""
    state = {"items_by_symbol": {"BITSTAMP:BTCUSD": {
        "fetched_at": NOW.isoformat(),
        "items": [_row("a", "2026-09-11T10:00:00+00:00")]}}}
    assert len(tvnews.cached_items("BINANCE:BTCUSDT.P", state=state)) == 1
    assert len(tvnews.cached_items("bitstamp:btcusd", state=state)) == 1


def test_cached_items_ne_filtre_jamais_par_les_ids_deja_vus():
    """Le cache n'est pas « ce qui est neuf », c'est « ce qui est affiché »."""
    state = {"seen_ids": ["a"], "items_by_symbol": {"BITSTAMP:BTCUSD": {
        "fetched_at": NOW.isoformat(),
        "items": [_row("a", "2026-09-11T10:00:00+00:00")]}}}
    assert len(tvnews.cached_items("BITSTAMP:BTCUSD", state=state)) == 1


def test_cached_items_ne_leve_jamais(monkeypatch):
    monkeypatch.setattr(tvnews, "_default_state",
                        lambda: (_ for _ in ()).throw(RuntimeError("disque")))
    assert tvnews.cached_items("BITSTAMP:BTCUSD") == []


def test_le_sous_etat_tv_news_est_lisible_depuis_newswatch(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path / "paper_trading")
    assert newswatch.tv_news_state() == {}            # fichier absent
    global_state = newswatch._load_global_seen()
    global_state["tv_news"] = {"items_by_symbol": {"SIX:NESN": {
        "fetched_at": NOW.isoformat(), "items": [_row("a", NOW.isoformat())]}}}
    newswatch._save_global_seen(global_state)

    assert "SIX:NESN" in newswatch.tv_news_state()["items_by_symbol"]
    assert len(tvnews.cached_items("SIX:NESN")) == 1  # sans état injecté

    # LECTURE SEULE : ce qu'on abîme dans la copie ne touche pas le fichier.
    newswatch.tv_news_state()["items_by_symbol"].clear()
    assert "SIX:NESN" in newswatch.tv_news_state()["items_by_symbol"]


def test_la_chaine_complete_du_11_09_de_la_veille_a_la_fiche(tmp_path,
                                                             monkeypatch):
    """Le chemin ENTIER, celui qui était cassé : le volet de veille écrit le
    cache dans l'état global, le fichier le garde, la fiche du titre le relit —
    alors même que l'item a déjà été vu et n'ouvre AUCUN événement.
    """
    from backend.bots.paper import brief, focus as focus_mod

    monkeypatch.setattr(store, "DATA_DIR", tmp_path / "paper_trading")
    (tmp_path / "paper_trading").mkdir(parents=True, exist_ok=True)
    focus_mod.state_path().write_text("{}", encoding="utf-8")   # le GATE du volet

    payload = {"items": [
        {"id": "cointelegraph:4e78182d1b858:0",
         "title": "Les acheteurs de Bitcoin doutent d’un plancher",
         "published": 1788976046, "urgency": 2,
         "storyPath": "/news/cointelegraph:4e78182d1b858:0/",
         "provider": {"id": "cointelegraph"},
         "relatedSymbols": [{"symbol": "BITSTAMP:BTCUSD"}]}]}
    client = _Client(_Response(payload))

    gov_state = newswatch._load_global_seen()
    # L'item est DÉJÀ vu (il l'a été pendant que Massii regardait UKOIL) :
    # aucun événement ne sortira, et c'est justement le cas à couvrir.
    gov_state["tv_news"] = {"seen_ids": ["cointelegraph:4e78182d1b858:0"]}
    portfolios = [("Massii08", {"positions": [{"symbol": "BTC-USD"}]})]
    counters = {"fetched": 0, "errors": 0}

    by_user = newswatch._run_tvnews_volet(gov_state, portfolios, NOW, counters,
                                          focus_map={}, client=client)
    assert by_user == {}                       # rien de neuf : normal
    newswatch._save_global_seen(gov_state)

    # ... et pourtant la fiche du titre sait quoi montrer.
    out = brief.build("Massii08", "BTC-USD", "BITSTAMP:BTCUSD",
                      deps={"quote": lambda s: None, "portfolio": lambda u: {},
                            "coach_positions": lambda: [],
                            "ideas_for_symbol": lambda u, s: [],
                            "hypotheses": lambda s: [], "news": lambda u: [],
                            "calendar": lambda: [], "whales": lambda s: [],
                            "mood": lambda: None, "btc": lambda: None,
                            "alerts": lambda u: [],
                            "candles_1m": lambda s: [],
                            "candles_1d": lambda s: [],
                            "fees_profile": lambda u: "kraken_spot",
                            "fx": lambda c: 1.0},
                      now=NOW.isoformat())
    assert [n["title"] for n in out["news"]] == [
        "Les acheteurs de Bitcoin doutent d’un plancher"]
    assert out["news"][0]["via"] == "tradingview"
    assert "tv_items" not in out["degraded"]


# =========================================================================== #
#  tvnews — 422 : « TradingView ne connaît pas ce symbole », pas une panne
#
#  Vécu : ``yahoo_to_tv`` préfixe tout ticker américain nu en ``NASDAQ:``, or
#  Suncor et Everest sont au NYSE -> 422 à chaque cycle, 4 par passage, 228
#  « anomalies » au compteur et autant de requêtes du budget brûlées.
# =========================================================================== #

def test_un_422_n_est_pas_compte_comme_une_anomalie():
    client = _Client(_Response({"items": []}, status_code=422))
    state = {}
    assert tvnews.run({"bob": ["SU"]}, None, client, state, NOW,
                      langs=("en",)) == []
    assert int(state.get("errors") or 0) == 0
    assert state.get("last_error") is None


def test_un_422_sur_le_repli_nasdaq_essaie_les_autres_places_americaines():
    client = _Client(_Response({"items": []}, status_code=422))
    client.route("symbol:NYSE:SU", _Response(_news_payload("su-1")))
    state = {}
    events = tvnews.run({"bob": ["SU"]}, None, client, state, NOW,
                        langs=("en",))
    assert [e["title"] for e in events] == ["Titre su-1"]
    assert state["exchange_of"]["SU"] == "NYSE:SU"
    assert int(state.get("errors") or 0) == 0


def test_la_place_trouvee_est_reutilisee_au_cycle_suivant():
    client = _Client(_Response({"items": []}, status_code=422))
    client.route("symbol:NYSE:SU", _Response(_news_payload("su-1")))
    state = {}
    tvnews.run({"bob": ["SU"]}, None, client, state, NOW, langs=("en",))

    client2 = _Client(_Response(_news_payload("su-2")))
    tvnews.run({"bob": ["SU"]}, None, client2, state,
               NOW + timedelta(seconds=61), langs=("en",))
    assert len(client2.calls) == 1                   # plus de cascade
    assert "symbol:NYSE:SU" in client2.urls()[0]


def test_un_symbole_qu_aucune_place_ne_connait_est_ignore_vingt_quatre_heures():
    client = _Client(_Response({"items": []}, status_code=422))
    state = {}
    tvnews.run({"bob": ["ZZZZ"]}, None, client, state, NOW, langs=("en",))
    assert state["unknown"]["ZZZZ"] == NOW.isoformat()
    assert len(client.calls) == len(tvnews.US_FALLBACK_EXCHANGES)

    client2 = _Client(_Response({"items": []}, status_code=422))
    tvnews.run({"bob": ["ZZZZ"]}, None, client2, state,
               NOW + timedelta(hours=23), langs=("en",))
    assert client2.calls == []                       # pas une requête de plus

    client3 = _Client(_Response(_news_payload("enfin")))
    tvnews.run({"bob": ["ZZZZ"]}, None, client3, state,
               NOW + timedelta(hours=25), langs=("en",))
    assert client3.calls                             # ... et on réessaie après


def test_un_422_sur_un_symbole_de_la_table_n_essaie_aucune_autre_place():
    """``BTC-USD`` vient de la table inverse, pas du repli ``NASDAQ:`` : lui
    chercher une place américaine n'aurait aucun sens."""
    client = _Client(_Response({"items": []}, status_code=422))
    state = {}
    tvnews.run({"bob": ["BTC-USD"]}, None, client, state, NOW, langs=("en",))
    assert len(client.calls) == 1
    assert state["unknown"]["BTC-USD"] == NOW.isoformat()


def test_un_budget_epuise_ne_condamne_pas_un_symbole_pour_la_journee():
    """La cascade coûte des requêtes : si le budget la coupe avant d'avoir
    essayé les autres places, on ne met PAS le symbole au placard — sinon un
    cycle chargé blackboulerait un titre valide pendant 24 h."""
    client = _Client(_Response({"items": []}, status_code=422))
    state = {}
    tvnews.run({"bob": ["SU"]}, None, client, state, NOW, budget=1,
               langs=("en",))
    assert len(client.calls) == 1
    assert "SU" not in state.get("unknown", {})
    assert int(state.get("errors") or 0) == 0


def test_un_500_reste_une_anomalie():
    """Le pendant : seul le 422 est requalifié, une vraie panne compte."""
    client = _Client(_Response({"items": []}, status_code=500))
    state = {}
    tvnews.run({"bob": ["AAPL"]}, None, client, state, NOW, langs=("en",))
    assert state["errors"] == 1
    assert "AAPL" not in state.get("unknown", {})


# =========================================================================== #
#  tvcalendar — parseur sur la fixture RÉELLE
# =========================================================================== #

def test_parse_events_ne_garde_que_la_haute_importance_des_pays_suivis():
    rows = tvcalendar.parse_events(_fixture("tv_calendar.json"))
    assert len(rows) == 27
    assert {r["importance"] for r in rows} == {1}
    assert {r["country"] for r in rows} <= set(tvcalendar.DEFAULT_COUNTRIES)


def test_parse_events_porte_la_forme_complete_et_la_decision_bce_du_10():
    rows = tvcalendar.parse_events(_fixture("tv_calendar.json"))
    bce = [r for r in rows
           if r["date"] == "2026-09-10" and "ECB Interest Rate" in r["label"]]
    assert len(bce) == 1
    entry = bce[0]
    assert set(entry) == {"id", "date", "time_utc", "kind", "label", "country",
                          "importance", "source"}
    assert entry["time_utc"] == "12:15"
    assert entry["kind"] == "macro"
    assert entry["label"] == "EU · ECB Interest Rate Decision"
    assert entry["source"] == "tradingview"


def test_parse_events_est_trie_par_instant():
    rows = tvcalendar.parse_events(_fixture("tv_calendar.json"))
    keys = [(r["date"], r["time_utc"]) for r in rows]
    assert keys == sorted(keys)


def test_parse_events_filtre_par_pays():
    rows = tvcalendar.parse_events(_fixture("tv_calendar.json"),
                                   countries=("CH",))
    assert {r["country"] for r in rows} <= {"CH"}


def test_parse_events_peut_descendre_le_seuil_d_importance():
    rows = tvcalendar.parse_events(_fixture("tv_calendar.json"),
                                   min_importance=0)
    assert len(rows) > 27
    assert {r["importance"] for r in rows} == {0, 1}


def test_la_date_vient_du_champ_date_jamais_d_un_calcul():
    """Une entrée sans ``date`` lisible est JETÉE — pas rattrapée par une date
    de repli (règle §4.2 de la spec)."""
    payload = {"result": [
        {"id": "1", "title": "Sans date", "country": "US", "importance": 1},
        {"id": "2", "title": "Date cassée", "country": "US", "importance": 1,
         "date": "demain matin"},
        {"id": "3", "title": "Bonne", "country": "US", "importance": 1,
         "date": "2026-09-11T12:30:00.000Z"},
    ]}
    rows = tvcalendar.parse_events(payload)
    assert [r["id"] for r in rows] == ["3"]
    assert rows[0]["date"] == "2026-09-11"


def test_parse_events_sur_une_charge_utile_cassee_rend_une_liste_vide():
    for payload in (None, {}, {"result": "pas une liste"}, 3):
        assert tvcalendar.parse_events(payload) == []


# =========================================================================== #
#  tvcalendar — fenêtre, imminence, collecte, cache
# =========================================================================== #

def test_window_borne_l_agenda():
    rows = tvcalendar.parse_events(_fixture("tv_calendar.json"))
    trois_jours = tvcalendar.window(rows, now=NOW, days=3)
    assert {r["date"] for r in trois_jours} <= {"2026-09-09", "2026-09-10",
                                                "2026-09-11", "2026-09-12"}


def test_soon_ne_retient_que_les_rendez_vous_a_venir_dans_la_fenetre():
    items = [
        {"id": "passe", "date": "2026-09-09", "time_utc": "20:00"},
        {"id": "dans-10", "date": "2026-09-09", "time_utc": "20:40"},
        {"id": "dans-90", "date": "2026-09-09", "time_utc": "22:00"},
        {"id": "sans-heure", "date": "2026-09-09", "time_utc": ""},
    ]
    assert [r["id"] for r in tvcalendar.soon(items, NOW, 30)] == ["dans-10"]


def test_fetch_appelle_l_url_exacte_et_rend_les_entrees():
    client = _Client(_Response(_fixture("tv_calendar.json")))
    rows = tvcalendar.fetch(client, days=14, now=NOW)
    assert len(rows) == 27
    url, headers = client.calls[0]
    assert url.startswith("https://economic-calendar.tradingview.com/events?")
    assert "from=2026-09-09T20:30:00.000Z" in url
    assert "to=2026-09-23T20:30:00.000Z" in url
    assert "countries=US,EU,CH,GB,JP,CN" in url
    assert headers["Origin"] == "https://www.tradingview.com"


@pytest.mark.parametrize("client", [
    _Client(_Response({}, status_code=429)),
    _Client(RuntimeError("réseau coupé")),
])
def test_une_collecte_en_panne_rend_une_liste_vide(client):
    assert tvcalendar.fetch(client, now=NOW) == []


def test_le_cache_evite_un_second_appel_dans_l_heure():
    client = _Client(_Response(_fixture("tv_calendar.json")))
    assert len(tvcalendar.refresh(client, now=NOW)) == 27
    assert len(client.calls) == 1

    tvcalendar.refresh(client, now=NOW + timedelta(minutes=59))
    assert len(client.calls) == 1

    tvcalendar.refresh(client, now=NOW + timedelta(minutes=61))
    assert len(client.calls) == 2


def test_une_source_muette_ne_vide_pas_le_cache():
    tvcalendar.refresh(_Client(_Response(_fixture("tv_calendar.json"))), now=NOW)
    muet = _Client(_Response({}, status_code=429))
    rows = tvcalendar.refresh(muet, now=NOW + timedelta(hours=2))
    assert len(rows) == 27


def test_le_cache_se_lit_sans_reseau():
    tvcalendar.refresh(_Client(_Response(_fixture("tv_calendar.json"))), now=NOW)
    assert len(tvcalendar.cached_items()) == 27
    assert len(tvcalendar.cached_items(now=NOW, days=2)) < 27


def test_le_fichier_de_cache_est_ecrit_en_0600_avec_un_point_dans_le_radical():
    tvcalendar.refresh(_Client(_Response(_fixture("tv_calendar.json"))), now=NOW)
    path = tvcalendar.state_path()
    assert path.name == "tvcalendar.state.json"
    assert "." in path.stem                     # anti-compte-fantôme
    assert stat.S_IMODE(os.stat(str(path)).st_mode) == 0o600


def test_un_cache_corrompu_repart_de_zero_sans_planter():
    path = tvcalendar.state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{ pas du json", encoding="utf-8")
    assert tvcalendar.load_state()["items"] == []


def test_notify_soon_pousse_une_fois_et_une_seule():
    state = {"items": [{"id": "ecb", "date": "2026-09-09", "time_utc": "20:40",
                        "label": "EU · BCE"}],
             "soon_sent": {}}
    pushed = []
    got = tvcalendar.notify_soon(state, now=NOW,
                                 emit=lambda *args: pushed.append(args))
    assert [r["id"] for r in got] == ["ecb"]
    assert pushed[0][1] == "calendar_soon"
    assert pushed[0][0] is None                 # à tout le monde

    encore = tvcalendar.notify_soon(state, now=NOW + timedelta(minutes=1),
                                    emit=lambda *args: pushed.append(args))
    assert encore == []
    assert len(pushed) == 1


def test_notify_soon_purge_les_rendez_vous_passes():
    state = {"items": [], "soon_sent": {"vieux": "2026-09-01"}}
    tvcalendar.notify_soon(state, now=NOW, emit=lambda *a: None)
    assert state["soon_sent"] == {}


def test_un_push_en_panne_n_empeche_pas_le_marquage():
    def _boom(*_args):
        raise RuntimeError("socket mort")

    state = {"items": [{"id": "ecb", "date": "2026-09-09", "time_utc": "20:40",
                        "label": "EU · BCE"}], "soon_sent": {}}
    assert tvcalendar.notify_soon(state, now=NOW, emit=_boom)
    assert "ecb" in state["soon_sent"]


# =========================================================================== #
#  L'agenda de l'Omen — fusion macro + crypto
# =========================================================================== #

_MACRO = [{"id": "ecb", "date": "2026-09-10", "time_utc": "12:15",
           "kind": "macro", "label": "EU · ECB Interest Rate Decision",
           "country": "EU", "importance": 1, "source": "tradingview"}]

_CRYPTO = [{"date": "2026-09-11", "time_utc": "08:00", "kind": "crypto",
            "label": "Expiration Deribit hebdomadaire"}]


def test_la_vue_agenda_porte_les_entrees_macro_et_crypto():
    rows = cal.calendar_view(NOW, bc_events=[], hypotheses=[], events=[],
                             verdicts={}, macro_events=_MACRO,
                             crypto_events=_CRYPTO)
    by_kind = {r["kind"]: r for r in rows}
    assert set(by_kind) == {"macro", "crypto"}
    assert by_kind["macro"]["date"] == "2026-09-10"
    assert by_kind["macro"]["label"] == "12:15 · EU · ECB Interest Rate Decision"
    assert by_kind["crypto"]["label"] == "08:00 · Expiration Deribit hebdomadaire"
    # forme COMPLÈTE : les mêmes clés que les trois genres historiques
    for row in rows:
        assert set(row) == {"key", "kind", "date", "label", "source_id",
                            "symbol", "tickers", "direction", "verdict",
                            "move_pct", "headline", "checked_at"}
        assert row["verdict"] is None and row["symbol"] is None


def test_la_vue_agenda_trie_les_nouvelles_entrees_avec_les_anciennes():
    bc = [{"date": "2026-09-16", "bank": "Fed", "label": "riunione"}]
    rows = cal.calendar_view(NOW, bc_events=bc, hypotheses=[], events=[],
                             verdicts={}, macro_events=_MACRO,
                             crypto_events=_CRYPTO)
    assert [r["date"] for r in rows] == ["2026-09-10", "2026-09-11", "2026-09-16"]


def test_un_rendez_vous_macro_vu_deux_fois_ne_compte_qu_une_fois():
    """Le calendrier économique change d'identifiant d'un rafraîchissement à
    l'autre : la dédup se fait sur ``(kind, date, label)``."""
    doublon = [dict(_MACRO[0]), dict(_MACRO[0], id="autre-identifiant")]
    rows = cal.calendar_view(NOW, bc_events=[], hypotheses=[], events=[],
                             verdicts={}, macro_events=doublon,
                             crypto_events=[])
    assert len(rows) == 1


def test_deux_rendez_vous_macro_du_meme_jour_a_des_heures_differentes_restent_deux():
    deux = [dict(_MACRO[0]),
            dict(_MACRO[0], id="conf", time_utc="12:45",
                 label="EU · ECB Press Conference")]
    rows = cal.calendar_view(NOW, bc_events=[], hypotheses=[], events=[],
                             verdicts={}, macro_events=deux, crypto_events=[])
    assert len(rows) == 2


def test_une_source_datee_en_panne_ne_casse_pas_la_vue(monkeypatch):
    def _boom(_rows):
        raise RuntimeError("normaliseur cassé")

    monkeypatch.setattr(cal, "normalize_crypto", _boom)
    rows = cal.calendar_view(NOW, bc_events=[], hypotheses=[], events=[],
                             verdicts={}, macro_events=_MACRO,
                             crypto_events=_CRYPTO)
    assert [r["kind"] for r in rows] == ["macro"]


def test_upcoming_ignore_macro_et_crypto():
    """``upcoming`` sert aussi le JUGE : un chiffre macro n'a ni symbole à
    coter ni thèse à noter, il n'a rien à y faire."""
    rows = cal.upcoming(NOW, bc_events=[], hypotheses=[], events=[])
    assert rows == []


def test_la_vue_agenda_lit_le_cache_tradingview_sans_reseau():
    tvcalendar.refresh(_Client(_Response(_fixture("tv_calendar.json"))), now=NOW)
    rows = cal.calendar_view(NOW, bc_events=[], hypotheses=[], events=[],
                             verdicts={}, crypto_events=[])
    macro = [r for r in rows if r["kind"] == "macro"]
    assert macro
    assert any("ECB Interest Rate Decision" in r["label"] for r in macro)


def test_la_vue_agenda_prend_l_agenda_crypto_calcule_par_btc():
    """Intégration avec le VRAI ``btc.crypto_agenda`` (lot E) : les entrées
    calculées arrivent dans la vue, et sur SEPT jours — pas sur l'horizon
    général de 90, sinon les rendez-vous qui se répètent noieraient les
    autres (cf. ``cal.CRYPTO_HORIZON_D``)."""
    btc = pytest.importorskip("backend.bots.paper.btc")
    attendu = btc.crypto_agenda(NOW, days=cal.CRYPTO_HORIZON_D)
    assert attendu                               # le lot E a bien de la matière

    rows = cal.calendar_view(NOW, bc_events=[], hypotheses=[], events=[],
                             verdicts={}, macro_events=[])
    crypto = [r for r in rows if r["kind"] == "crypto"]
    assert crypto
    assert max(r["date"] for r in crypto) <= (
        NOW + timedelta(days=cal.CRYPTO_HORIZON_D)).strftime("%Y-%m-%d")


def test_un_module_btc_absent_ne_fait_pas_tomber_la_vue(monkeypatch):
    import sys
    import backend.bots.paper as paper_pkg
    monkeypatch.setitem(sys.modules, "backend.bots.paper.btc", None)
    monkeypatch.setattr(paper_pkg, "btc", None, raising=False)
    rows = cal.calendar_view(NOW, bc_events=[], hypotheses=[], events=[],
                             verdicts={}, macro_events=_MACRO)
    assert [r["kind"] for r in rows] == ["macro"]


# =========================================================================== #
#  focus
# =========================================================================== #

def test_poser_un_focus_rend_le_symbole_et_son_echeance():
    out = focus.set_focus("bob", "btc-usd", NOW)
    assert out == {"ok": True, "symbol": "BTC-USD",
                   "until": (NOW + timedelta(seconds=600)).isoformat()}
    assert focus.get_focus("bob", NOW) == {
        "symbol": "BTC-USD",
        "until": (NOW + timedelta(seconds=600)).isoformat()}


def test_un_focus_expire_s_eteint_tout_seul():
    focus.set_focus("bob", "AAPL", NOW)
    assert focus.get_focus("bob", NOW + timedelta(minutes=9))["symbol"] == "AAPL"
    assert focus.get_focus("bob", NOW + timedelta(minutes=11)) == {
        "symbol": None, "until": None}


def test_un_seul_titre_par_utilisateur():
    focus.set_focus("bob", "AAPL", NOW)
    focus.set_focus("bob", "NESN.SW", NOW)
    assert focus.get_focus("bob", NOW)["symbol"] == "NESN.SW"
    assert focus.all_active(NOW) == {"bob": "NESN.SW"}


def test_all_active_ignore_les_focus_expires():
    focus.set_focus("bob", "AAPL", NOW)
    focus.set_focus("alice", "BTC-USD", NOW + timedelta(minutes=9))
    actifs = focus.all_active(NOW + timedelta(minutes=11))
    assert actifs == {"alice": "BTC-USD"}
    assert focus.active_symbols(NOW + timedelta(minutes=11)) == ["BTC-USD"]


def test_poser_un_focus_purge_les_expires_des_autres_comptes():
    focus.set_focus("bob", "AAPL", NOW)
    focus.set_focus("alice", "BTC-USD", NOW + timedelta(minutes=20))
    assert list(focus.load_state()["users"]) == ["alice"]


def test_eteindre_un_focus():
    focus.set_focus("bob", "AAPL", NOW)
    assert focus.clear_focus("bob") == {"symbol": None, "until": None}
    assert focus.all_active(NOW) == {}


@pytest.mark.parametrize("symbol", ["", "   ", "A" * 40, "AAPL;rm -rf", None,
                                    "../../etc/passwd"])
def test_un_symbole_invalide_est_rejete(symbol):
    with pytest.raises(ValueError):
        focus.set_focus("bob", symbol, NOW)


def test_un_nom_d_utilisateur_invalide_est_rejete():
    with pytest.raises(ValueError):
        focus.set_focus("../evil", "AAPL", NOW)


def test_le_fichier_de_focus_est_en_0600_avec_un_point_dans_le_radical():
    focus.set_focus("bob", "AAPL", NOW)
    path = focus.state_path()
    assert path.name == "focus.state.json"
    assert "." in path.stem                     # anti-compte-fantôme
    assert stat.S_IMODE(os.stat(str(path)).st_mode) == 0o600


def test_un_etat_de_focus_corrompu_repart_de_zero():
    path = focus.state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("pas du json", encoding="utf-8")
    assert focus.all_active(NOW) == {}


def test_un_focus_sans_echeance_lisible_est_traite_comme_expire():
    path = focus.state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"users": {"bob": {"symbol": "AAPL",
                                                  "until": "jamais"}}}),
                    encoding="utf-8")
    assert focus.all_active(NOW) == {}


# =========================================================================== #
#  Routes (section C du routeur TradingView)
# =========================================================================== #

class _FakeUser(object):
    def __init__(self, role="admin", username="bob"):
        self.role = role
        self.is_admin = role == "admin"
        self.username = username


def _client(role="admin"):
    app = FastAPI()
    app.include_router(paper_tv_router.router)
    app.dependency_overrides[get_current_user] = lambda: _FakeUser(role)
    return TestClient(app)


def test_route_focus_pose_et_relit():
    client = _client()
    posted = client.post("/api/paper/focus", json={"symbol": "btc-usd"})
    assert posted.status_code == 200
    assert posted.json()["ok"] is True
    assert posted.json()["symbol"] == "BTC-USD"

    read = client.get("/api/paper/focus")
    assert read.status_code == 200
    assert read.json()["symbol"] == "BTC-USD"
    assert read.json()["until"]


def test_route_focus_sans_focus_rend_la_forme_complete():
    assert _client().get("/api/paper/focus").json() == {"symbol": None,
                                                        "until": None}


def test_route_focus_refuse_un_symbole_invalide():
    assert _client().post("/api/paper/focus",
                          json={"symbol": "rm -rf /"}).status_code == 400


def test_route_tvcalendar_sert_le_cache(monkeypatch):
    tvcalendar.refresh(_Client(_Response(_fixture("tv_calendar.json"))), now=NOW)
    monkeypatch.setattr(paper_tv_router, "_tvcalendar_client", lambda: None)
    # La route lit l'horloge SYSTÈME : on fenêtre le cache à ``NOW`` (l'époque
    # de la fixture), sinon le compte pourrit au fil des jours (vécu le 11/09 :
    # 27 -> 21 deux jours plus tard).
    monkeypatch.setattr(tvcalendar, "cached_items",
                        functools.partial(tvcalendar.cached_items, now=NOW))
    body = _client().get("/api/paper/tvcalendar?days=60").json()
    assert len(body["items"]) == 27
    assert body["items"][0]["kind"] == "macro"


def test_route_tvcalendar_ne_sort_jamais_du_cache_chaud(monkeypatch):
    """Un cache chaud interdit l'appel sortant : la route ne doit pas payer le
    réseau pour un affichage.

    La route lit l'horloge SYSTÈME (c'est une requête, pas un cycle injecté) :
    le cache est donc rempli à l'instant réel, pas à ``NOW``.
    """
    tvcalendar.refresh(_Client(_Response(_fixture("tv_calendar.json"))),
                       now=datetime.now(timezone.utc))
    spy = _Client(_Response(_fixture("tv_calendar.json")))
    monkeypatch.setattr(paper_tv_router, "_tvcalendar_client", lambda: spy)
    _client().get("/api/paper/tvcalendar")
    assert spy.calls == []


def test_route_tvcalendar_survit_a_une_source_morte(monkeypatch):
    def _boom():
        raise RuntimeError("httpx absent")

    monkeypatch.setattr(paper_tv_router, "_tvcalendar_client", _boom)
    assert _client().get("/api/paper/tvcalendar").json() == {"items": []}


@pytest.mark.parametrize("path", ["/api/paper/focus", "/api/paper/tvcalendar"])
def test_les_routes_du_lot_sont_reservees_aux_roles_du_simulateur(path):
    app = FastAPI()
    app.include_router(paper_tv_router.router)
    assert TestClient(app).get(path).status_code == 401


def test_un_role_insuffisant_est_refuse():
    assert _client(role="player").get("/api/paper/focus").status_code == 403


# =========================================================================== #
#  Branchement dans le cycle du guetteur
# =========================================================================== #

CFG = {"token": "t", "chat_id": "c"}

_EMPTY_RSS = ('<?xml version="1.0" encoding="UTF-8"?><rss version="2.0">'
              '<channel><title>Feed</title></channel></rss>')


@pytest.fixture
def quiet_cycle(monkeypatch):
    """Les mêmes neutralisations que ``test_paper_newswatch`` : ce fichier ne
    vise QUE le volet TradingView, tous les autres canaux restent muets."""
    monkeypatch.setattr(newswatch, "load_x_accounts", lambda: [])
    monkeypatch.setattr(newswatch, "_reddit_url", lambda subs=None: "")
    monkeypatch.setattr(newswatch, "_bsky_urls", lambda queries: [])
    monkeypatch.setattr(newswatch, "pressefi_feeds", lambda: [])
    from backend.bots.paper import convergence
    monkeypatch.setattr(convergence, "maybe_fire",
                        lambda **kwargs: {"fired": False, "sent": False})
    monkeypatch.setattr(cal, "run_verdicts", lambda **kwargs: [])
    from backend.bots.paper import backup as backup_mod
    monkeypatch.setattr(backup_mod, "maybe_run", lambda **kwargs: {"ran": False})
    from backend.bots.paper import weekly as weekly_mod
    monkeypatch.setattr(weekly_mod, "maybe_run",
                        lambda **kwargs: {"ran": False, "n_accounts": 0,
                                          "sent": 0})
    from backend.bots.paper import translate as translate_mod
    monkeypatch.setattr(translate_mod, "run_sweep", lambda **kwargs: {})
    return monkeypatch


def _portfolio(symbols):
    return {
        "cash_chf": 5000.0,
        "positions": [
            {"symbol": s, "qty": 1, "avg_price": 10.0, "currency": "CHF",
             "opened_at": NOW.isoformat(), "side": "long"}
            for s in symbols
        ],
        "open_orders": [], "trades": [], "fee_profile": "yuh",
        "initial_capital": 10000.0, "created_at": NOW.isoformat(),
    }


def _cycle(tv_client=None, **kwargs):
    return newswatch.run_once(now=NOW, fetch=lambda url: _EMPTY_RSS,
                              notifier=lambda text, cfg: True, tg_cfg=CFG,
                              sleep=lambda s: None, mode="calme",
                              tv_client=tv_client, **kwargs)


def test_sans_extension_installee_le_volet_tradingview_ne_sort_pas(quiet_cycle):
    """GATE : pas de ``focus.state.json``, donc personne n'a d'extension, donc
    aucune requête TradingView. C'est ce qui laisse les cycles historiques
    exactement comme ils étaient."""
    store.save_portfolio("bob", _portfolio(["AAPL"]))
    spy = _Client(_Response(_news_payload("a")))
    _cycle(tv_client=spy)
    assert spy.calls == []


def test_avec_l_extension_le_volet_collecte_et_verse_dans_le_carnet(quiet_cycle):
    store.save_portfolio("bob", _portfolio(["AAPL"]))
    focus.set_focus("bob", "AAPL", NOW)
    client = _Client(_Response(_news_payload("a", "b")))

    counters = _cycle(tv_client=client)

    assert [u for u in client.urls() if "news-mediator" in u]
    events = newswatch.recent_events("bob")
    titles = [e["title"] for e in events]
    assert "Titre a" in titles and "Titre b" in titles
    tv_event = [e for e in events if e["title"] == "Titre a"][0]
    assert tv_event["source"] == "tradingview"
    assert tv_event["muted"] is True
    assert counters["fetched"] >= 2


def test_le_volet_tradingview_ne_notifie_jamais(quiet_cycle):
    """Le volet nourrit la base ; la parole reste à la convergence."""
    store.save_portfolio("bob", _portfolio(["AAPL"]))
    focus.set_focus("bob", "AAPL", NOW)
    sent = []
    newswatch.run_once(now=NOW, fetch=lambda url: _EMPTY_RSS,
                       notifier=lambda text, cfg: sent.append(text) or True,
                       tg_cfg=CFG, sleep=lambda s: None, mode="tout",
                       tv_client=_Client(_Response(_news_payload("a"))))
    assert sent == []


def test_un_volet_tradingview_qui_leve_laisse_le_cycle_intact(quiet_cycle):
    store.save_portfolio("bob", _portfolio(["AAPL"]))
    focus.set_focus("bob", "AAPL", NOW)

    def _boom(*_args, **_kwargs):
        raise RuntimeError("TradingView cassé")

    counters = _cycle(tv_client=_Client(), tv_run=_boom)
    assert counters["users"] == 1
    assert counters["errors"] >= 1
    assert newswatch._load_global_seen()["seen"] is not None


def test_le_titre_en_focus_rejoint_le_scan_rss(quiet_cycle):
    """Levier n°3 : le titre REGARDÉ est scanné même sans position."""
    store.save_portfolio("bob", _portfolio(["NESN.SW"]))
    focus.set_focus("bob", "BTC-USD", NOW)
    fetched = []

    newswatch.run_once(now=NOW, fetch=lambda url: fetched.append(url) or _EMPTY_RSS,
                       notifier=lambda text, cfg: True, tg_cfg=CFG,
                       sleep=lambda s: None, mode="calme",
                       tv_client=_Client())
    assert any("BTC-USD" in url for url in fetched)


def test_la_cadence_du_volet_survit_a_la_relecture_de_l_etat(quiet_cycle):
    """Le sous-état ``tv_news`` doit REVENIR du disque : c'est tout l'objet de
    l'allowlist. Sans elle, le second cycle réinterrogerait TradingView."""
    store.save_portfolio("bob", _portfolio(["AAPL"]))
    focus.set_focus("bob", "AAPL", NOW)
    client = _Client(_Response(_news_payload("a")))

    _cycle(tv_client=client)
    premier = len([u for u in client.urls() if "news-mediator" in u])
    assert premier > 0

    newswatch.run_once(now=NOW + timedelta(seconds=30),
                       fetch=lambda url: _EMPTY_RSS,
                       notifier=lambda text, cfg: True, tg_cfg=CFG,
                       sleep=lambda s: None, mode="calme", tv_client=client)
    assert len([u for u in client.urls() if "news-mediator" in u]) == premier


def test_le_calendrier_est_rafraichi_par_le_cycle(quiet_cycle):
    store.save_portfolio("bob", _portfolio(["AAPL"]))
    focus.set_focus("bob", "AAPL", NOW)
    client = _Client(_Response(_news_payload("a")))
    client.route("economic-calendar", _Response(_fixture("tv_calendar.json")))

    _cycle(tv_client=client)
    assert len(tvcalendar.cached_items()) == 27


def test_l_etat_du_guetteur_garde_exactement_ces_cles(quiet_cycle):
    """⚠️ LE test de l'allowlist (piège documenté en tête de
    ``_load_seen_state``) : la forme COMPLÈTE de l'état après un vrai cycle, et
    la preuve que TOUT ce qui a été écrit est bien relu. Une clé oubliée dans
    l'allowlist serait perdue en silence — la cadence n'existerait plus, le
    volet tournerait à chaque cycle, et rien ne le signalerait."""
    attendu = {
        "seen", "events", "seeded", "stories", "sent_log", "crypto_sent_log",
        "x_sent_log", "eco_sent_log", "climat_sent_log", "bc_sent_log",
        "pressefi_sent_log", "bsky_sent_log", "x_cycle", "x_tiers", "x_fails",
        "x_candidates", "x_cand_cycle", "x_pending_seen", "bc_cycle",
        "pressefi_cycle", "bsky_cycle", "reddit_cycle", "reddit_group_cycle",
        "reddit_trends", "calendar_cycle", "tv_news",
    }
    # ⚠️ Asymétrie PRÉEXISTANTE épinglée ici pour qu'elle reste délibérée :
    # ``calendar_cycle`` vit dans l'allowlist mais PAS dans l'état vierge. Sans
    # conséquence (``_counter`` rend 0 pour une clé absente), mais un futur
    # ajout de clé doit choisir sciemment de faire pareil ou non.
    assert set(newswatch._default_seen_state()) | {"calendar_cycle"} == attendu
    assert "tv_news" in newswatch._default_seen_state()

    store.save_portfolio("bob", _portfolio(["AAPL"]))
    focus.set_focus("bob", "AAPL", NOW)
    _cycle(tv_client=_Client(_Response(_news_payload("a"))))

    path = newswatch._global_seen_path()
    with open(str(path), "r", encoding="utf-8") as handle:
        ecrit = json.load(handle)
    relu = newswatch._load_seen_state(path)

    assert set(relu) == attendu
    # RIEN d'écrit ne doit se perdre à la relecture : c'est la forme
    # DISCRIMINANTE du test (une clé écrite hors allowlist la ferait tomber).
    assert set(ecrit) - set(relu) == set()
    assert set(relu["tv_news"]) >= {"last_fetch", "seen_ids", "requests"}
    assert relu["tv_news"]["last_fetch"]["NASDAQ:AAPL"] == NOW.isoformat()
