"""Tests du volet Bitcoin de l'extension TradingView — 100 % HORS LIGNE.

Deux règles tenues d'un bout à l'autre de ce fichier :

* **aucun octet ne sort** — le client HTTP est une doublure servant les
  fixtures RÉELLES capturées le 09/09 (``fixtures/tvcoach/*.json``), et
  ``quotes.get_candles`` est injecté ;
* **aucune horloge système** — ``now`` est passé partout, donc l'agenda, les
  caches et les fenêtres de 24 h mesurent tous le même instant. Un test qui
  lirait ``datetime.now()`` prouverait quelque chose de différent chaque jour.

Le repère de temps commun est ``NOW = 2026-09-09 18:00 UTC`` (un MERCREDI) :
c'est l'instant de capture des fixtures, et c'est la date sur laquelle la spec
épingle l'agenda calculé (expiration hebdomadaire le vendredi 11/09 à 08:00,
mensuelle le dernier vendredi 25/09).
"""
import json
import os
import stat
import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.auth.utils import get_current_user
from backend.bots import paper_tv_router as tvr
from backend.bots.paper import btc, convergence, store

FIXTURES = Path(__file__).parent / "fixtures" / "tvcoach"

# Mercredi 9 septembre 2026, 18:00 UTC — naïf, comme tous les horodatages du
# dépôt (``_naive`` de calendar.py / convergence.py : on convertit en UTC puis
# on retire le fuseau, sinon Python 3.9 bute sur le suffixe « Z »).
NOW = datetime(2026, 9, 9, 18, 0, 0)


def _fixture(name):
    with open(str(FIXTURES / name), "r", encoding="utf-8") as handle:
        return json.load(handle)


PREMIUM = _fixture("binance_premium.json")
OI = _fixture("binance_oi.json")
DVOL = _fixture("deribit_dvol.json")
DERIBIT_INDEX = _fixture("deribit_index.json")
FNG = _fixture("fng.json")
COINBASE = _fixture("coinbase_spot.json")


# =========================================================================== #
#  Doublures
# =========================================================================== #

class FakeResponse(object):
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def json(self):
        return self._payload


class FakeClient(object):
    """Client HTTP factice : route par MORCEAU d'URL (l'URL DVOL porte des
    horodatages, donc l'égalité stricte ne marcherait pas)."""

    def __init__(self, **over):
        self.routes = {
            "premiumIndex": FakeResponse(PREMIUM),
            "openInterest": FakeResponse(OI),
            "get_volatility_index_data": FakeResponse(DVOL),
            "get_index_price": FakeResponse(DERIBIT_INDEX),
            "alternative.me": FakeResponse(FNG),
            "api.coinbase.com": FakeResponse(COINBASE),
        }
        self.routes.update(over)
        self.calls = []

    def get(self, url, headers=None, timeout=None):
        self.calls.append(url)
        for needle, response in self.routes.items():
            if needle in url:
                if isinstance(response, Exception):
                    raise response
                return response
        raise AssertionError("URL non prévue par le test : %s" % url)

    def hits(self, needle):
        return len([u for u in self.calls if needle in u])


def _candles(rows):
    """Bougies Yahoo ``BTC=F`` à la forme de ``quotes.parse_candles``."""
    out = []
    for day, low, high, close in rows:
        ts = int((datetime(day.year, day.month, day.day, 0, 0)
                  - datetime(1970, 1, 1)).total_seconds())
        out.append({"ts": ts, "open": close, "high": high, "low": low,
                    "close": close, "volume": 1})
    return out


def _no_candles(*args, **kwargs):
    return []


@pytest.fixture(autouse=True)
def _fresh_budgets():
    """Les budgets de requêtes sont un état de MODULE : sans remise à zéro ils
    fuiraient d'un test à l'autre (même leçon que ``_JOBS`` du router)."""
    btc.reset_budgets()
    yield
    btc.reset_budgets()


# =========================================================================== #
#  PUR — les parseurs, sur les fixtures RÉELLES puis sur des payloads cassés
# =========================================================================== #

def test_parse_premium_lit_la_fixture_reelle():
    out = btc.parse_premium(PREMIUM)
    assert out["mark"] == 78766.5
    assert out["index"] == 78792.40717391
    # lastFundingRate est une FRACTION (0.00006335) : le pourcentage est ×100.
    assert round(out["funding_pct"], 6) == 0.006335
    assert out["next_funding_utc"] == "2026-09-10T00:00:00"
    # Le règlement DÉJÀ passé que porte ``lastFundingRate`` : le prochain moins
    # les 8 h de l'intervalle. C'est l'identité d'un règlement dans l'historique.
    assert out["settled_at"] == "2026-09-09T16:00:00"


@pytest.mark.parametrize("payload", [None, {}, [], "boom", 42,
                                     {"lastFundingRate": "n/a"},
                                     {"markPrice": None, "nextFundingTime": "x"}])
def test_parse_premium_ne_leve_jamais_et_n_invente_rien(payload):
    out = btc.parse_premium(payload)
    assert set(out) == {"mark", "index", "funding_pct", "next_funding_utc",
                        "settled_at"}
    assert all(value is None for value in out.values())


def test_parse_oi_lit_la_fixture_reelle():
    out = btc.parse_oi(OI)
    assert out["oi"] == 105007.948
    assert out["ts"] == "2026-09-09T17:56:26"


@pytest.mark.parametrize("payload", [None, {}, "boom", {"openInterest": "n/a"}])
def test_parse_oi_ne_leve_jamais(payload):
    assert btc.parse_oi(payload) == {"oi": None, "ts": None}


def test_parse_dvol_prend_le_dernier_close_de_la_serie():
    out = btc.parse_dvol(DVOL)
    # ``result.data`` = [[ts_ms, open, high, low, close], …] : le DVOL du
    # moment est le CLOSE de la dernière bougie horaire, pas son ouverture.
    assert out["dvol"] == 40.16
    assert out["ts"] == "2026-09-09T17:00:00"


@pytest.mark.parametrize("payload", [None, {}, {"result": {}},
                                     {"result": {"data": []}},
                                     {"result": {"data": [[1, 2]]}},
                                     {"error": {"message": "nope"}}])
def test_parse_dvol_ne_leve_jamais(payload):
    assert btc.parse_dvol(payload) == {"dvol": None, "ts": None}


def test_parse_deribit_index_lit_la_fixture_reelle():
    assert btc.parse_deribit_index(DERIBIT_INDEX) == 78775.49


@pytest.mark.parametrize("payload", [None, {}, {"result": {}}, "boom",
                                     {"result": {"index_price": "n/a"}}])
def test_parse_deribit_index_ne_leve_jamais(payload):
    assert btc.parse_deribit_index(payload) is None


def test_parse_fng_lit_la_fixture_reelle():
    out = btc.parse_fng(FNG)
    assert out["value"] == 66
    assert out["label"] == "Greed"
    assert out["ts"] == "2026-09-09T00:00:00"


@pytest.mark.parametrize("payload", [None, {}, {"data": []}, "boom",
                                     {"data": [{"value": "n/a"}]}])
def test_parse_fng_ne_leve_jamais(payload):
    out = btc.parse_fng(payload)
    assert out["value"] is None and out["label"] is None


def test_parse_coinbase_lit_la_fixture_reelle():
    assert btc.parse_coinbase(COINBASE) == 78776.045


@pytest.mark.parametrize("payload", [None, {}, {"data": {}}, "boom",
                                     {"data": {"amount": "n/a"}}])
def test_parse_coinbase_ne_leve_jamais(payload):
    assert btc.parse_coinbase(payload) is None


# =========================================================================== #
#  snapshot — la photo complète, chaque source en panne ISOLÉE
# =========================================================================== #

def test_snapshot_assemble_les_six_sources():
    state = {}
    client = FakeClient()
    out = btc.snapshot(client=client, state=state, now=NOW,
                       candles_fn=_no_candles)

    assert out["mark"] == 78766.5
    assert out["index"] == 78792.40717391
    assert round(out["funding_pct"], 6) == 0.006335
    assert out["next_funding_utc"] == "2026-09-10T00:00:00"
    assert out["oi"] == 105007.948
    assert out["dvol"] == 40.16
    assert out["fng"] == 66
    assert out["fng_label"] == "Greed"
    assert out["coinbase_spot"] == 78776.045
    # (78776.045 - 78766.5) / 78766.5 × 100
    assert out["coinbase_premium_pct"] == 0.0121
    assert out["degraded"] == []
    assert out["ts"] == "2026-09-09T18:00:00"
    # Premier passage : aucun point de 24 h en mémoire, donc AUCUNE dérivée.
    assert out["oi_24h_pct"] is None


def test_snapshot_rend_toutes_les_cles_du_contrat():
    out = btc.snapshot(client=FakeClient(), state={}, now=NOW,
                       candles_fn=_no_candles)
    assert set(out) == {"funding_pct", "next_funding_utc", "mark", "index",
                        "oi", "oi_24h_pct", "dvol", "fng", "fng_label",
                        "coinbase_spot", "coinbase_premium_pct", "cme_gap",
                        "degraded", "ts"}


@pytest.mark.parametrize("needle,champ,nom", [
    ("premiumIndex", "mark", "binance_premium"),
    ("openInterest", "oi", "binance_oi"),
    ("get_volatility_index_data", "dvol", "deribit_dvol"),
    ("alternative.me", "fng", "fng"),
    ("api.coinbase.com", "coinbase_spot", "coinbase"),
])
def test_snapshot_une_source_en_429_ne_tue_que_son_champ(needle, champ, nom):
    client = FakeClient(**{needle: FakeResponse({}, status_code=429)})
    out = btc.snapshot(client=client, state={}, now=NOW,
                       candles_fn=_no_candles)
    assert out[champ] is None
    assert nom in out["degraded"]
    # Les autres sources ont RÉPONDU : une panne est isolée, pas contagieuse.
    assert out["ts"] == "2026-09-09T18:00:00"


def test_snapshot_survit_a_une_panne_de_transport():
    client = FakeClient(premiumIndex=RuntimeError("réseau coupé"))
    out = btc.snapshot(client=client, state={}, now=NOW,
                       candles_fn=_no_candles)
    assert out["mark"] is None and out["funding_pct"] is None
    assert "binance_premium" in out["degraded"]
    # Sans prix de marque, la prime Coinbase n'a pas de dénominateur : elle est
    # NULLE, jamais calculée contre autre chose.
    assert out["coinbase_premium_pct"] is None


def test_snapshot_un_5xx_degrade_aussi():
    client = FakeClient(get_index_price=FakeResponse({}, status_code=503))
    out = btc.snapshot(client=client, state={}, now=NOW,
                       candles_fn=_no_candles)
    assert out["index"] == 78792.40717391   # celui de Binance reste
    assert "deribit_index" in out["degraded"]


def test_snapshot_cache_60_s_sur_les_sources_rapides():
    state = {}
    client = FakeClient()
    btc.snapshot(client=client, state=state, now=NOW, candles_fn=_no_candles)
    assert client.hits("premiumIndex") == 1

    btc.snapshot(client=client, state=state, now=NOW + timedelta(seconds=59),
                 candles_fn=_no_candles)
    assert client.hits("premiumIndex") == 1     # servi par le cache

    btc.snapshot(client=client, state=state, now=NOW + timedelta(seconds=61),
                 candles_fn=_no_candles)
    assert client.hits("premiumIndex") == 2


def test_snapshot_cache_1_h_pour_le_fear_and_greed_et_le_dvol():
    state = {}
    client = FakeClient()
    btc.snapshot(client=client, state=state, now=NOW, candles_fn=_no_candles)
    btc.snapshot(client=client, state=state, now=NOW + timedelta(minutes=10),
                 candles_fn=_no_candles)

    assert client.hits("premiumIndex") == 2                  # 60 s
    assert client.hits("alternative.me") == 1                # 1 h
    assert client.hits("get_volatility_index_data") == 1     # 1 h

    btc.snapshot(client=client, state=state, now=NOW + timedelta(minutes=61),
                 candles_fn=_no_candles)
    assert client.hits("alternative.me") == 2
    assert client.hits("get_volatility_index_data") == 2


def test_snapshot_sert_la_valeur_CACHEE_et_pas_un_trou():
    """Le cache n'est pas qu'une économie de requête : il porte la DERNIÈRE
    valeur connue, donc un second appel dans la minute rend la même photo."""
    state = {}
    client = FakeClient()
    first = btc.snapshot(client=client, state=state, now=NOW,
                         candles_fn=_no_candles)
    second = btc.snapshot(client=client, state=state,
                          now=NOW + timedelta(seconds=30),
                          candles_fn=_no_candles)
    assert second["mark"] == first["mark"] == 78766.5
    assert second["degraded"] == []


# =========================================================================== #
#  Historiques : intérêt ouvert 48 h, règlements de funding
# =========================================================================== #

def test_oi_24h_pct_se_calcule_sur_l_historique():
    state = {"oi_history": [[(NOW - timedelta(hours=24)).isoformat(), 95000.0]]}
    out = btc.snapshot(client=FakeClient(), state=state, now=NOW,
                       candles_fn=_no_candles)
    # 105007.948 / 95000 - 1 = +10,53 %
    assert out["oi_24h_pct"] == 10.53


def test_oi_24h_pct_est_nul_quand_l_interet_ouvert_NE_BOUGE_PAS():
    """Piège du dépôt : mesurer que le champ VARIE avant d'en dériver une
    métrique. Un ``openInterest`` bit-à-bit identique sur 24 h n'est pas un
    marché immobile, c'est un champ GELÉ (réponse cachée, endpoint mort) — 0 %
    serait une mesure qu'on n'a pas faite."""
    frozen = 105007.948
    state = {"oi_history": [[(NOW - timedelta(hours=h)).isoformat(), frozen]
                            for h in (24, 12, 1)]}
    out = btc.snapshot(client=FakeClient(), state=state, now=NOW,
                       candles_fn=_no_candles)
    assert out["oi_24h_pct"] is None


def test_oi_24h_pct_refuse_une_reference_trop_JEUNE():
    """Un point de 2 h ne peut pas servir de référence « 24 h » : nommer 24 h
    ce qu'on a mesuré sur 2 h, c'est inventer la mesure."""
    state = {"oi_history": [[(NOW - timedelta(hours=2)).isoformat(), 95000.0]]}
    out = btc.snapshot(client=FakeClient(), state=state, now=NOW,
                       candles_fn=_no_candles)
    assert out["oi_24h_pct"] is None


def test_l_historique_d_oi_glisse_sur_48_h():
    state = {"oi_history": [[(NOW - timedelta(hours=72)).isoformat(), 1.0],
                            [(NOW - timedelta(hours=24)).isoformat(), 95000.0]]}
    btc.snapshot(client=FakeClient(), state=state, now=NOW,
                 candles_fn=_no_candles)
    ages = [row[0] for row in state["oi_history"]]
    assert (NOW - timedelta(hours=72)).isoformat() not in ages
    assert (NOW - timedelta(hours=24)).isoformat() in ages
    assert ages[-1] == NOW.isoformat()          # le point du jour est ajouté


def test_l_historique_des_reglements_de_funding_se_remplit_sans_doublon():
    state = {}
    client = FakeClient()
    btc.snapshot(client=client, state=state, now=NOW, candles_fn=_no_candles)
    assert state["funding_history"] == [
        {"ts": "2026-09-09T16:00:00", "funding_pct": pytest.approx(0.006335)}]

    # Même règlement relu 10 minutes plus tard : AUCUNE seconde entrée.
    btc.snapshot(client=client, state=state, now=NOW + timedelta(minutes=10),
                 candles_fn=_no_candles)
    assert len(state["funding_history"]) == 1


def test_un_NOUVEAU_reglement_s_ajoute_a_l_historique():
    state = {"funding_history": [{"ts": "2026-09-09T08:00:00",
                                  "funding_pct": 0.06}]}
    btc.snapshot(client=FakeClient(), state=state, now=NOW,
                 candles_fn=_no_candles)
    assert [row["ts"] for row in state["funding_history"]] == [
        "2026-09-09T08:00:00", "2026-09-09T16:00:00"]


# =========================================================================== #
#  cme_gap — le trou du week-end, ouvert tant qu'il n'est pas retraversé
# =========================================================================== #

VENDREDI = datetime(2026, 9, 4)          # vendredi précédant NOW
SAMEDI = datetime(2026, 9, 5)
LUNDI = datetime(2026, 9, 7)
MARDI = datetime(2026, 9, 8)


def test_cme_gap_ouvert_quand_le_spot_n_est_jamais_redescendu():
    candles = _candles([(datetime(2026, 9, 3), 76000, 78000, 77500),
                        (VENDREDI, 77000, 78500, 77900),
                        (LUNDI, 79000, 80500, 80000),
                        (MARDI, 80100, 81000, 80800)])
    gap = btc.cme_gap(candles, 80900.0, now=NOW)
    assert gap == {"level": 77900.0, "open": True}


def test_cme_gap_comble_quand_une_bougie_reprend_le_niveau():
    candles = _candles([(VENDREDI, 77000, 78500, 77900),
                        (LUNDI, 79000, 80500, 80000),
                        (MARDI, 77500, 80200, 79000)])   # la mèche repasse à 77 900
    gap = btc.cme_gap(candles, 79000.0, now=NOW)
    assert gap == {"level": 77900.0, "open": False}


def test_cme_gap_comble_quand_le_SPOT_est_passe_de_l_autre_cote():
    """Aucune bougie postérieure ne couvre le niveau, mais le spot est passé
    SOUS lui alors que la réouverture s'était faite au-dessus : le prix a donc
    forcément traversé."""
    candles = _candles([(VENDREDI, 77000, 78500, 77900),
                        (LUNDI, 79000, 80500, 80000)])
    gap = btc.cme_gap(candles, 76000.0, now=NOW)
    assert gap == {"level": 77900.0, "open": False}


def test_cme_gap_sans_vendredi_ne_rend_rien():
    candles = _candles([(SAMEDI, 77000, 78500, 77900),
                        (LUNDI, 79000, 80500, 80000)])
    assert btc.cme_gap(candles, 80000.0, now=NOW) is None


def test_cme_gap_sans_spot_ne_rend_rien():
    candles = _candles([(VENDREDI, 77000, 78500, 77900)])
    assert btc.cme_gap(candles, None, now=NOW) is None


def test_cme_gap_ignore_les_bougies_du_FUTUR():
    """Une bougie postérieure à ``now`` (séance en cours mal datée, fixture
    recopiée) ne doit pas décider qu'un gap est comblé avant l'heure."""
    candles = _candles([(VENDREDI, 77000, 78500, 77900),
                        (datetime(2026, 9, 12), 70000, 90000, 80000)])
    assert btc.cme_gap(candles, 80900.0, now=NOW) == {"level": 77900.0,
                                                      "open": True}


@pytest.mark.parametrize("candles", [None, [], "boom", [None, 3]])
def test_cme_gap_ne_leve_jamais(candles):
    assert btc.cme_gap(candles, 80000.0, now=NOW) is None


def test_snapshot_branche_le_gap_cme_sur_les_bougies_injectees():
    calls = []

    def candles_fn(symbol, range_, interval):
        calls.append((symbol, range_, interval))
        return _candles([(VENDREDI, 77000, 78500, 77900),
                         (LUNDI, 79000, 80500, 80000)])

    out = btc.snapshot(client=FakeClient(), state={}, now=NOW,
                       candles_fn=candles_fn)
    assert calls == [("BTC=F", "1mo", "1d")]
    assert out["cme_gap"] == {"level": 77900.0, "open": True}


def test_snapshot_degrade_le_gap_cme_si_yahoo_tombe():
    def boom(*args, **kwargs):
        raise RuntimeError("Yahoo indisponible")

    out = btc.snapshot(client=FakeClient(), state={}, now=NOW,
                       candles_fn=boom)
    assert out["cme_gap"] is None
    assert "cme_gap" in out["degraded"]


# =========================================================================== #
#  crypto_agenda — TOUT est calculé, RIEN n'est inventé
# =========================================================================== #

def _agenda(days=7, now=NOW):
    return btc.crypto_agenda(now=now, days=days)


def _labels_at(entries, date, time_utc):
    return [e["label"] for e in entries
            if e["date"] == date and e["time_utc"] == time_utc]


def test_agenda_forme_des_entrees():
    for entry in _agenda():
        assert set(entry) == {"date", "time_utc", "kind", "label"}
        assert entry["kind"] == "crypto"
        assert len(entry["date"]) == 10 and len(entry["time_utc"]) == 5
        assert entry["label"]


def test_agenda_est_trie_et_tient_dans_la_fenetre():
    entries = _agenda(days=7)
    keys = [(e["date"], e["time_utc"]) for e in entries]
    assert keys == sorted(keys)
    assert keys[0] >= ("2026-09-09", "18:00")       # rien de PASSÉ
    assert keys[-1] <= ("2026-09-16", "18:00")      # rien au-delà de 7 jours


def test_agenda_pose_les_trois_reglements_de_funding():
    entries = _agenda(days=7)
    for heure in ("00:00", "08:00", "16:00"):
        labels = _labels_at(entries, "2026-09-10", heure)
        assert any("funding" in label.lower() for label in labels), heure
    # Le 09/09 à 18:00, les trois règlements du jour sont DÉJÀ passés.
    assert _labels_at(entries, "2026-09-09", "16:00") == []


def test_agenda_expiration_deribit_hebdomadaire_le_vendredi_11_09_a_08h():
    labels = _labels_at(_agenda(days=7), "2026-09-11", "08:00")
    assert any("hebdomadaire" in label.lower() for label in labels), labels
    assert not any("mensuelle" in label.lower() for label in labels), labels


def test_agenda_expiration_MENSUELLE_le_dernier_vendredi_25_09():
    entries = _agenda(days=30)
    labels = _labels_at(entries, "2026-09-25", "08:00")
    assert any("mensuelle" in label.lower() for label in labels), labels
    # Le dernier vendredi du mois n'est PAS compté deux fois : une expiration
    # mensuelle remplace l'hebdomadaire de ce vendredi-là.
    assert not any("hebdomadaire" in label.lower() for label in labels), labels
    # Les autres vendredis de la fenêtre restent hebdomadaires.
    assert any("hebdomadaire" in label.lower()
               for label in _labels_at(entries, "2026-09-18", "08:00"))


def test_agenda_cme_ferme_le_vendredi_21h_et_rouvre_le_dimanche_22h():
    entries = _agenda(days=7)
    assert _labels_at(entries, "2026-09-11", "21:00")       # vendredi
    assert _labels_at(entries, "2026-09-13", "22:00")       # dimanche
    assert "CME" in _labels_at(entries, "2026-09-11", "21:00")[0]
    assert "CME" in _labels_at(entries, "2026-09-13", "22:00")[0]


def test_agenda_ouverture_us_seulement_les_jours_ouvres():
    entries = _agenda(days=7)
    assert _labels_at(entries, "2026-09-11", "13:30")       # vendredi
    assert _labels_at(entries, "2026-09-14", "13:30")       # lundi
    assert _labels_at(entries, "2026-09-12", "13:30") == []  # samedi
    assert _labels_at(entries, "2026-09-13", "13:30") == []  # dimanche


def test_agenda_ne_contient_aucun_doublon():
    entries = _agenda(days=30)
    keys = [(e["date"], e["time_utc"], e["label"]) for e in entries]
    assert len(keys) == len(set(keys))


def test_agenda_horizon_nul_ou_negatif_rend_une_liste_vide():
    assert btc.crypto_agenda(now=NOW, days=0) == []
    assert btc.crypto_agenda(now=NOW, days=-3) == []


def test_agenda_accepte_une_horloge_absente_sans_lever():
    assert isinstance(btc.crypto_agenda(), list)


# =========================================================================== #
#  factors — deux facteurs déterministes, ids DISJOINTS
# =========================================================================== #

def _funding_state(*rates):
    """Un état dont les règlements sont espacés de 8 h et finissent à
    ``NOW - 2 h`` (donc frais)."""
    rows = []
    total = len(rates)
    for index, rate in enumerate(rates):
        moment = NOW - timedelta(hours=2 + 8 * (total - 1 - index))
        rows.append({"ts": moment.isoformat(), "funding_pct": rate})
    return {"funding_history": rows}


def test_funding_extreme_sur_deux_reglements_consecutifs():
    out = btc.factors(_funding_state(0.061, 0.072), now=NOW)
    items = out["funding_extreme"]
    assert len(items) == 1
    assert items[0]["id"] == "btc:funding:2026-09-09T16:00:00"
    assert items[0]["kind"] == "funding_extreme"
    assert items[0]["text"]


def test_funding_extreme_ne_s_allume_pas_sur_UN_SEUL_reglement_extreme():
    assert btc.factors(_funding_state(0.01, 0.072), now=NOW)["funding_extreme"] == []
    assert btc.factors(_funding_state(0.072), now=NOW)["funding_extreme"] == []


def test_funding_extreme_accepte_le_funding_NEGATIF():
    out = btc.factors(_funding_state(-0.061, -0.058), now=NOW)
    assert len(out["funding_extreme"]) == 1


def test_funding_extreme_ignore_un_historique_PERIME():
    """Un état recopié d'une autre machine, ou un guetteur à l'arrêt depuis
    trois jours, ne doit pas ressortir un funding de la semaine dernière."""
    state = {"funding_history": [
        {"ts": (NOW - timedelta(days=3)).isoformat(), "funding_pct": 0.09},
        {"ts": (NOW - timedelta(days=3, hours=-8)).isoformat(),
         "funding_pct": 0.09}]}
    assert btc.factors(state, now=NOW)["funding_extreme"] == []


@pytest.mark.parametrize("state", [None, {}, "boom", {"funding_history": "x"},
                                   {"funding_history": [1, 2]}])
def test_factors_ne_leve_jamais(state):
    out = btc.factors(state, now=NOW)
    assert out == {"funding_extreme": [], "oi_buildup": []}


def _oi_state(ref_oi, last_oi, ref_price, last_price):
    old = (NOW - timedelta(hours=24)).isoformat()
    new = (NOW - timedelta(minutes=1)).isoformat()
    return {"oi_history": [[old, ref_oi], [new, last_oi]],
            "price_history": [[old, ref_price], [new, last_price]]}


def test_oi_buildup_quand_l_interet_ouvert_gonfle_a_prix_immobile():
    out = btc.factors(_oi_state(100000.0, 112000.0, 78000.0, 78300.0), now=NOW)
    items = out["oi_buildup"]
    assert len(items) == 1
    assert items[0]["id"] == "btc:oi:2026-09-09"
    assert items[0]["kind"] == "oi_buildup"
    assert items[0]["text"]


def test_oi_buildup_ne_s_allume_pas_si_le_PRIX_a_bouge():
    out = btc.factors(_oi_state(100000.0, 112000.0, 78000.0, 80000.0), now=NOW)
    assert out["oi_buildup"] == []


def test_oi_buildup_ne_s_allume_pas_en_dessous_de_10_pourcent():
    out = btc.factors(_oi_state(100000.0, 105000.0, 78000.0, 78300.0), now=NOW)
    assert out["oi_buildup"] == []


def test_oi_buildup_ne_s_allume_pas_sans_historique_de_PRIX():
    state = _oi_state(100000.0, 112000.0, 78000.0, 78300.0)
    state.pop("price_history")
    assert btc.factors(state, now=NOW)["oi_buildup"] == []


def test_les_deux_facteurs_ont_des_ids_DISJOINTS():
    state = _oi_state(100000.0, 112000.0, 78000.0, 78300.0)
    state.update(_funding_state(0.061, 0.072))
    out = btc.factors(state, now=NOW)
    ids = [item["id"] for items in out.values() for item in items]
    assert len(ids) == len(set(ids)) == 2
    assert ids[0].startswith("btc:funding:") and ids[1].startswith("btc:oi:")


# =========================================================================== #
#  Branchement convergence — ils COMPTENT, ils ne TIRENT jamais seuls
# =========================================================================== #

def test_les_deux_codes_sont_dans_FACTOR_CODES_a_la_FIN():
    assert convergence.FACTOR_CODES[:10] == (
        "fresh_hyps", "gov", "held_catalyst", "held_risk", "whale_filing",
        "whale_sold_watched", "cross_source", "crowd_buzz", "event_flop",
        "event_confirmed")
    assert convergence.FACTOR_CODES[10:] == ("funding_extreme", "oi_buildup")


def test_les_deux_codes_ont_un_libelle_francais():
    for code in ("funding_extreme", "oi_buildup"):
        assert convergence.FACTOR_LABELS[code]
    # La table de libellés couvre TOUS les codes : un code sans libellé ferait
    # planter le résumé brut (``FACTOR_LABELS[code]``, sans ``.get``).
    assert set(convergence.FACTOR_LABELS) == set(convergence.FACTOR_CODES)


def test_les_facteurs_btc_ne_sont_PAS_des_facteurs_de_menace():
    for code in ("funding_extreme", "oi_buildup"):
        assert code not in convergence.THREAT_FACTORS


@pytest.mark.parametrize("code", ["funding_extreme", "oi_buildup"])
def test_un_facteur_btc_SEUL_ne_declenche_jamais_should_fire(code):
    payload = {"factors": {code: True}, "factor_ids": {code: ["btc:x"]}}
    fired, reason = convergence.should_fire(payload, {}, NOW.isoformat(), "fp")
    assert fired is False and reason == "too_few"


def test_un_facteur_btc_COMPTE_comme_second_facteur():
    payload = {"factors": {"gov": True, "funding_extreme": True},
               "factor_ids": {"gov": ["news:1"],
                              "funding_extreme": ["btc:funding:x"]}}
    fired, reason = convergence.should_fire(payload, {}, NOW.isoformat(), "fp")
    assert fired is True and reason == "ok"


def _collect(btc_factors=None):
    return convergence.collect_factors(NOW, [], [], [], [],
                                       btc_factors=btc_factors)


def test_collect_factors_sans_volet_btc_laisse_les_deux_codes_a_faux():
    out = _collect()
    assert out["factors"]["funding_extreme"] is False
    assert out["factors"]["oi_buildup"] is False
    assert out["items"] == []


def test_collect_factors_fusionne_le_volet_btc():
    state = _oi_state(100000.0, 112000.0, 78000.0, 78300.0)
    state.update(_funding_state(0.061, 0.072))
    out = _collect(btc.factors(state, now=NOW))

    assert out["factors"]["funding_extreme"] is True
    assert out["factors"]["oi_buildup"] is True
    ids = sorted(out["factor_ids"]["funding_extreme"]
                 + out["factor_ids"]["oi_buildup"])
    assert ids == ["btc:funding:2026-09-09T16:00:00", "btc:oi:2026-09-09"]

    # Les items sont remis à la forme COMMUNE : sans ``src``/``title``,
    # l'empreinte et les lignes du digest sortiraient vides.
    for item in out["items"]:
        assert item["src"] == "btc"
        assert item["title"]
        assert item["symbol"] == "BTC-USD"


@pytest.mark.parametrize("bad", [None, "boom", 42, {"funding_extreme": "x"},
                                 {"funding_extreme": [None, 3]},
                                 {"funding_extreme": [{"text": "sans id"}]}])
def test_collect_factors_ignore_un_volet_btc_MALFORME(bad):
    out = _collect(bad)
    assert out["factors"]["funding_extreme"] is False


def test_collect_factors_garde_sa_signature_POSITIONNELLE():
    """Les appelants historiques (``maybe_fire``) passent leurs cinq premiers
    arguments en positionnel : le nouveau paramètre est le DERNIER et il est
    optionnel."""
    out = convergence.collect_factors(NOW, [], [], [], [])
    assert set(out) == {"factors", "items", "factor_ids"}


# =========================================================================== #
#  État persisté — un POINT dans le radical, atomique, 0o600
# =========================================================================== #

def test_le_fichier_d_etat_porte_un_point_dans_son_RADICAL(tmp_path, monkeypatch):
    """Piège du dépôt (``agenda.cache.json``) : ``data/paper_trading/`` est
    recensé comme la liste des COMPTES par ``radar._users_with_portfolio``
    (regex ``^[A-Za-z0-9_-]+\\.json$``). Un ``btc.json`` deviendrait un
    utilisateur fantôme nommé « btc »."""
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    path = btc.state_path()
    assert path.name == "btc.state.json"
    assert "." in path.stem


def test_l_etat_se_sauve_et_se_relit(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    assert btc.load_state() == {}          # absent -> dict vide, jamais None

    btc.save_state({"oi_history": [["2026-09-09T18:00:00", 1.0]]})
    assert btc.load_state() == {"oi_history": [["2026-09-09T18:00:00", 1.0]]}
    mode = stat.S_IMODE(os.stat(str(btc.state_path())).st_mode)
    assert mode == 0o600


def test_l_etat_corrompu_ne_fait_pas_planter(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    tmp_path.mkdir(parents=True, exist_ok=True)
    with open(str(btc.state_path()), "w", encoding="utf-8") as handle:
        handle.write("{ pas du json")
    assert btc.load_state() == {}


def test_snapshot_sans_etat_injecte_persiste_sur_le_DISQUE(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    btc.snapshot(client=FakeClient(), now=NOW, candles_fn=_no_candles)
    saved = btc.load_state()
    assert saved["funding_history"][0]["ts"] == "2026-09-09T16:00:00"
    assert saved["oi_history"][-1][0] == "2026-09-09T18:00:00"

    # Deuxième photo dans la minute : le cache RELU du disque évite la requête.
    client = FakeClient()
    btc.snapshot(client=client, now=NOW + timedelta(seconds=10),
                 candles_fn=_no_candles)
    assert client.hits("premiumIndex") == 0


# =========================================================================== #
#  Budgets de requêtes (Binance 30/min, Deribit 10/min)
# =========================================================================== #

def test_le_budget_binance_coupe_avant_de_marteler():
    """Vingt photos au MÊME instant (état neuf à chaque fois, donc aucun cache
    ne les sert) = quarante requêtes Binance demandées dans la même minute. Le
    budget en laisse passer trente, puis la source est traitée comme
    indisponible — dégradée, jamais martelée."""
    client = FakeClient()
    out = {}
    for _ in range(20):
        out = btc.snapshot(client=client, state={}, now=NOW,
                           candles_fn=_no_candles)
    assert client.hits("premiumIndex") + client.hits("openInterest") == 30
    assert "binance_premium" in out["degraded"]
    # Deribit a son propre budget (10/min) : il tombe aussi, mais séparément.
    assert client.hits("get_index_price") + \
        client.hits("get_volatility_index_data") <= 10


def test_le_budget_se_libere_une_fois_la_minute_passee():
    client = FakeClient()
    for _ in range(20):
        btc.snapshot(client=client, state={}, now=NOW, candles_fn=_no_candles)
    out = btc.snapshot(client=client, state={}, now=NOW + timedelta(hours=2),
                       candles_fn=_no_candles)
    assert out["mark"] == 78766.5
    assert "binance_premium" not in out["degraded"]


# =========================================================================== #
#  Route GET /api/paper/btc
# =========================================================================== #

def _client(tmp_path, monkeypatch, role="admin"):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path / "paper_trading")
    monkeypatch.setattr(btc, "_default_candles", _no_candles, raising=False)
    btc.set_client(FakeClient())

    class FakeUser(object):
        def __init__(self):
            self.role = role
            self.is_admin = role == "admin"
            self.username = "tester"

    app = FastAPI()
    app.include_router(tvr.router)
    app.dependency_overrides[get_current_user] = lambda: FakeUser()
    return TestClient(app)


@pytest.fixture(autouse=True)
def _no_module_client():
    yield
    btc.set_client(None)


def test_route_btc_rend_le_snapshot_et_l_agenda(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    response = client.get("/api/paper/btc")
    assert response.status_code == 200, response.text
    body = response.json()

    assert body["mark"] == 78766.5
    assert body["fng"] == 66
    assert body["degraded"] == []
    assert isinstance(body["agenda"], list) and body["agenda"]
    for entry in body["agenda"]:
        assert entry["kind"] == "crypto"
        assert set(entry) == {"date", "time_utc", "kind", "label"}


def test_route_btc_est_reservee_aux_roles_du_simulateur(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch, role="player")
    assert client.get("/api/paper/btc").status_code == 403


@pytest.mark.parametrize("role", ["money", "trader"])
def test_route_btc_ouverte_a_money_et_trader(tmp_path, monkeypatch, role):
    client = _client(tmp_path, monkeypatch, role=role)
    assert client.get("/api/paper/btc").status_code == 200


def test_route_btc_survit_a_une_source_morte(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path / "paper_trading")
    monkeypatch.setattr(btc, "_default_candles", _no_candles, raising=False)
    btc.set_client(FakeClient(premiumIndex=FakeResponse({}, status_code=500)))

    class FakeUser(object):
        role, is_admin, username = "admin", True, "tester"

    app = FastAPI()
    app.include_router(tvr.router)
    app.dependency_overrides[get_current_user] = lambda: FakeUser()
    response = TestClient(app).get("/api/paper/btc")

    assert response.status_code == 200
    body = response.json()
    assert body["mark"] is None
    assert "binance_premium" in body["degraded"]


# =========================================================================== #
#  Branchement maybe_fire — le volet Bitcoin comme SOURCE de collect_factors
# =========================================================================== #
#
# Patron repris de ``test_paper_convergence.py`` (``test_maybe_fire_trop_peu_
# de_facteurs``/``test_maybe_fire_sources_absentes_ne_casse_rien``) : newswatch
# et whales sont neutralisés en cassant leur import paresseux (``None`` dans
# ``sys.modules``), et ``store.DATA_DIR`` est isolé en ``tmp_path`` — sinon
# ``whales.recent_filing_events`` lirait le VRAI ``data/paper_trading/`` du
# dépôt (son ``DATA_DIR`` est une constante figée à l'import, indépendante de
# ``store.DATA_DIR``). Seul le volet Bitcoin peut alors porter de la matière.

def test_maybe_fire_branche_funding_extreme_sans_franchir_le_seuil_seul(
        tmp_path, monkeypatch):
    """``maybe_fire`` passe désormais par ``_collect_btc_factors`` : un état
    BTC qui allume ``funding_extreme`` (mêmes valeurs que
    ``test_funding_extreme_sur_deux_reglements_consecutifs``) doit se voir
    dans les facteurs RENDUS — mais un seul facteur, même Bitcoin, ne franchit
    pas ``MIN_FACTORS`` (cf. ``test_un_facteur_btc_SEUL_ne_declenche_jamais_
    should_fire`` plus haut : les deux codes BTC comptent, ils ne tirent
    jamais seuls)."""
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    monkeypatch.setitem(sys.modules, "backend.bots.paper.newswatch", None)
    monkeypatch.setitem(sys.modules, "backend.bots.paper.whales", None)
    monkeypatch.setattr(btc, "load_state",
                        lambda: _funding_state(0.061, 0.072))

    out = convergence.maybe_fire(
        now=NOW, llm=lambda prompt: "digest",
        notifier=lambda text, cfg: True,
        tg_cfg={"token": "t", "chat_id": "c"},
        fetch_state=lambda: {"hypotheses": [], "stats": {}})

    assert out["factors"]["funding_extreme"] is True
    assert out["factors"]["oi_buildup"] is False
    assert out["fired"] is False and out["reason"] == "too_few"


def test_maybe_fire_avale_une_panne_de_btc_load_state(tmp_path, monkeypatch):
    """Le volet Bitcoin est une source comme une autre : ``btc.load_state`` qui
    lève ne doit ni faire lever ``maybe_fire`` lui-même, ni allumer
    ``funding_extreme`` autrement qu'à FAUX."""
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    monkeypatch.setitem(sys.modules, "backend.bots.paper.newswatch", None)
    monkeypatch.setitem(sys.modules, "backend.bots.paper.whales", None)

    def _boom():
        raise RuntimeError("état BTC illisible")

    monkeypatch.setattr(btc, "load_state", _boom)

    out = convergence.maybe_fire(
        now=NOW, llm=lambda prompt: "digest",
        notifier=lambda text, cfg: True,
        tg_cfg={"token": "t", "chat_id": "c"},
        fetch_state=lambda: {"hypotheses": [], "stats": {}})

    assert out["factors"]["funding_extreme"] is False
    assert out["fired"] is False
