"""Tests du LOT A/B — la fiche du titre (Task 2) et les routes (Task 4).

100 % hors ligne : ``brief.build`` reçoit TOUTES ses sources par ``deps``, et
les tests de route doublent ``brief.build`` lui-même (le patron des voisins :
TestClient + ``dependency_overrides[get_current_user]``, cf.
``test_paper_router.make_client``). Aucun test ne sort sur le réseau.

Spec : ``docs/superpowers/specs/2026-09-09-tv-coach-extension-design.md`` §5.1.
Plan : ``docs/superpowers/plans/2026-09-09-tv-coach-extension.md`` §1.1, §1.7.
"""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.auth.utils import get_current_user
from backend.bots import paper_tv_router as ptr
from backend.bots.paper import brief, price_alerts, quotes, store

# --------------------------------------------------------------------------- #
# Task 2 — la table de correspondance TradingView -> Yahoo (§1.1)
# --------------------------------------------------------------------------- #

MAPPING = [
    # Actions américaines : la place ne laisse aucune trace chez Yahoo.
    ("NASDAQ:AAPL", "AAPL"),
    ("BATS:AAPL", "AAPL"),
    ("NYSE:KO", "KO"),
    ("AMEX:SPY", "SPY"),
    # Suisse.
    ("SIX:NESN", "NESN.SW"),
    ("SIX:ROG", "ROG.SW"),
    ("BX:NESR", "NESN.SW"),
    # Allemagne, France, Royaume-Uni, Italie.
    ("XETR:SAP", "SAP.DE"),
    ("FWB:SAP", "SAP.DE"),
    ("EURONEXT:MC", "MC.PA"),
    ("EURONEXT:AIR", "AIR.PA"),
    ("LSE:SHEL", "SHEL.L"),
    ("MIL:ENI", "ENI.MI"),
    # Crypto — six écritures du même bitcoin.
    ("BITSTAMP:BTCUSD", "BTC-USD"),
    ("BINANCE:BTCUSDT", "BTC-USD"),
    ("BINANCE:BTCUSDT.P", "BTC-USD"),
    ("KRAKEN:XBTUSD", "BTC-USD"),
    ("COINBASE:BTCUSD", "BTC-USD"),
    ("CRYPTO:BTCUSD", "BTC-USD"),
    ("BINANCE:ETHUSDT", "ETH-USD"),
    ("COINBASE:SOLUSD", "SOL-USD"),
    ("BITSTAMP:XRPUSD", "XRP-USD"),
    # Devises.
    ("FX:EURUSD", "EURUSD=X"),
    ("OANDA:EURUSD", "EURUSD=X"),
    ("FX_IDC:EURUSD", "EURUSD=X"),
    # Matières premières et future CME.
    ("TVC:UKOIL", "BZ=F"),
    ("TVC:USOIL", "CL=F"),
    ("TVC:GOLD", "GC=F"),
    ("CME:BTC1!", "BTC=F"),
]


@pytest.mark.parametrize("tv_symbol,expected", MAPPING)
def test_correspondance_tradingview_vers_yahoo(tv_symbol, expected):
    assert brief.tv_to_yahoo(tv_symbol) == expected


@pytest.mark.parametrize("tv_symbol,expected", MAPPING)
def test_la_correspondance_est_insensible_a_la_casse(tv_symbol, expected):
    assert brief.tv_to_yahoo(tv_symbol.lower()) == expected


@pytest.mark.parametrize("tv_symbol", [
    "MOEX:GAZP",        # place non couverte
    "NASDAQ:",          # ticker vide
    ":AAPL",            # place vide
    "AAPL",             # sans place : TradingView n'écrit jamais ça
    "",
    None,
    42,
    "BINANCE:DOGEUSDT",  # crypto hors de la liste blanche
])
def test_un_symbole_inconnu_ne_donne_rien(tv_symbol):
    """« inconnu -> null » (§1.1) : mieux vaut une fiche vide qu'une fiche sur
    le mauvais titre."""
    assert brief.tv_to_yahoo(tv_symbol) is None


def test_le_suffixe_perp_est_retire():
    assert brief.tv_to_yahoo("BINANCE:ETHUSDT.P") == "ETH-USD"


def test_une_classe_d_action_americaine_prend_un_tiret():
    """Yahoo écrit ``BRK-B`` là où TradingView écrit ``BRK.B`` — même
    conversion que ``lib/symbols.js``, sinon le panneau demanderait une fiche
    que le serveur refuserait."""
    assert brief.tv_to_yahoo("NYSE:BRK.B") == "BRK-B"


def test_la_forme_canonique_reste_l_affaire_de_quotes():
    """``tv_to_yahoo`` rend le symbole de la TABLE (mirroir exact de
    ``lib/symbols.js``, qui n'a pas accès aux alias du serveur) ; c'est
    ``quotes.canonical`` qui applique ensuite ``SYMBOL_ALIASES``."""
    assert quotes.canonical(brief.tv_to_yahoo("SIX:ROG")) == "RO.SW"


@pytest.mark.parametrize("symbol,kind", [
    ("BTC-USD", "crypto"),
    ("ETH-USD", "crypto"),
    # Les trois autres devises de cotation crypto de Yahoo : la table ne les
    # PRODUIT pas (tout est ramené à ``-USD``) mais un symbole tapé à la main
    # doit être reconnu — même liste que ``kindOf`` de ``lib/symbols.js``.
    ("BTC-EUR", "crypto"),
    ("BTC-USDT", "crypto"),
    ("BTC-CHF", "crypto"),
    ("EURUSD=X", "forex"),
    ("CL=F", "commodity"),
    ("BTC=F", "commodity"),
    ("^VIX", "index"),
    ("AAPL", "stock"),
    ("NESN.SW", "stock"),
    ("", "stock"),
])
def test_famille_deduite_du_symbole(symbol, kind):
    assert brief.kind_of(symbol) == kind


# --------------------------------------------------------------------------- #
# Task 2 — ``build``
# --------------------------------------------------------------------------- #

NOW = "2026-09-09T14:00:00"


def _candles_1d(n=40):
    """40 bougies quotidiennes régulières (assez pour un ATR14)."""
    return [{"ts": 1000 + i, "open": 100.0 + i, "high": 102.0 + i,
             "low": 99.0 + i, "close": 101.0 + i, "volume": 1000}
            for i in range(n)]


def _candles_1m(volume=10):
    return [{"ts": 2000 + i, "open": 100.0, "high": 100.5 + i * 0.1,
             "low": 99.5 - i * 0.1, "close": 100.0 + i * 0.05,
             "volume": volume}
            for i in range(30)]


def _deps(**overrides):
    """Toutes les sources injectées, chacune en une valeur simple."""
    base = {
        "quote": lambda symbol: {"symbol": symbol, "price": 78760.1,
                                 "currency": "USD", "change_pct": 1.2,
                                 "name": "Bitcoin"},
        "portfolio": lambda username: {
            "cash_chf": 5000.0, "initial_capital": 10000.0,
            "fee_profile": "kraken_spot",
            "positions": [{"symbol": "BTC-USD", "qty": 0.02, "avg_price": 77900.0,
                           "currency": "USD", "fx_rate": 1.0, "side": "long",
                           "stop_loss": 76800.0, "target": 81000.0}],
            "orders": [{"id": "o1", "symbol": "BTC-USD", "side": "buy",
                        "qty": 1, "status": "open"},
                       {"id": "o2", "symbol": "AAPL", "side": "buy",
                        "qty": 1, "status": "open"},
                       {"id": "o3", "symbol": "BTC-USD", "side": "buy",
                        "qty": 1, "status": "filled"}],
        },
        "coach_positions": lambda: [
            {"symbol": "BTC-USD", "side": "short", "qty": 0.01,
             "stop_loss": 80000.0, "target": 70000.0, "thesis": "these du coach"},
            {"symbol": "AAPL", "side": "long", "qty": 5},
        ],
        "ideas_for_symbol": lambda username, symbol: [{"from": "journal",
                                                       "thesis": "une idee"}],
        "hypotheses": lambda symbol: [{"thesis": "une hypothese",
                                       "tickers": ["BTC-USD"]}],
        "news": lambda username: [
            {"ts": "2026-09-09T13:00:00", "symbol": "BTC-USD",
             "title": "Bitcoin monte", "src": "tradingview",
             "provider": "reuters", "sentiment": "pos",
             "url": "https://example.test/1"},
            {"ts": "2026-09-09T12:00:00", "symbol": "AAPL",
             "title": "Apple ailleurs", "src": "rss"},
        ],
        "calendar": lambda: [
            {"kind": "macro", "date": "2026-09-10", "time_utc": "12:30",
             "label": "US CPI", "country": "US", "importance": 1},
            {"kind": "hypothesis", "date": "2026-09-12", "label": "Echeance",
             "symbol": "BTC-USD", "tickers": ["BTC-USD"]},
            {"kind": "hypothesis", "date": "2026-09-12", "label": "Ailleurs",
             "symbol": "AAPL", "tickers": ["AAPL"]},
        ],
        "whales": lambda symbol: [{"manager": "Bridgewater", "move": "sortie"}],
        "mood": lambda: {"vix": 18.2, "change_pct": -1.0, "mood": "normal"},
        "btc": lambda: {"funding_pct": 0.0062, "oi": 104504, "fng": 66,
                        "dvol": 40.3},
        "alerts": lambda username: [
            {"id": "a1", "symbol": "BTC-USD", "op": "above", "price": 80000.0,
             "status": "armed"},
            {"id": "a2", "symbol": "BTC-USD", "op": "below", "price": 70000.0,
             "status": "triggered"},
            {"id": "a3", "symbol": "AAPL", "op": "above", "price": 300.0,
             "status": "armed"},
        ],
        "candles_1m": lambda symbol: _candles_1m(),
        "candles_1d": lambda symbol: _candles_1d(),
        "fees_profile": lambda username: "kraken_spot",
        # Le taux réellement relevé dans le livre de scalps : 1 USD = 0,8129 CHF.
        "fx": lambda currency: 0.8129,
    }
    base.update(overrides)
    return base


def _build(**overrides):
    return brief.build("tester", "BTC-USD", "BITSTAMP:BTCUSD",
                       deps=_deps(**overrides), now=NOW)


def test_la_fiche_porte_exactement_les_cles_du_contrat():
    out = _build()
    assert set(out) == {"symbol", "tv_symbol", "kind", "quote", "position",
                        "coach_position", "pending_orders", "alerts", "ideas",
                        "hypotheses", "news", "calendar", "whales", "mood",
                        "btc", "fees", "ta", "defaults", "degraded"}


def test_identite_du_titre():
    out = _build()
    assert out["symbol"] == "BTC-USD"
    assert out["tv_symbol"] == "BITSTAMP:BTCUSD"
    assert out["kind"] == "crypto"
    assert out["degraded"] == []


def test_la_cotation_dit_son_retard():
    out = _build()
    assert out["quote"]["price"] == 78760.1
    assert out["quote"]["delay_min"] == 0       # crypto : pas de différé Yahoo
    assert out["quote"]["ts"] == NOW


def test_la_cotation_porte_le_taux_de_change_vers_le_franc():
    """Sans ce taux, l'extension ne peut pas borner un scalp par le capital :
    le 11/09 elle a ouvert 1 BTC (62 770 CHF) sur un compte de 10 000 CHF."""
    out = _build()
    assert out["quote"]["currency"] == "USD"
    assert out["quote"]["fx_to_chf"] == 0.8129
    assert out["degraded"] == []


def test_une_cotation_en_francs_ne_demande_aucun_taux():
    def jamais(currency):                   # pragma: no cover - ne doit pas courir
        raise AssertionError("le franc n'a pas de taux à demander")
    out = _build(quote=lambda symbol: {"price": 31.4, "currency": "CHF"},
                 fx=jamais)
    assert out["quote"]["fx_to_chf"] == 1.0
    assert out["degraded"] == []


def test_une_cotation_sans_devise_vaut_le_franc():
    out = _build(quote=lambda symbol: {"price": 31.4, "currency": None})
    assert out["quote"]["fx_to_chf"] == 1.0


def test_un_taux_de_change_en_panne_laisse_la_fiche_debout():
    """Champs absents = ``null`` (§5.1) : mieux vaut pas de taux qu'un taux
    inventé — l'extension sous-dimensionne alors au lieu de sur-exposer."""
    def boom(currency):
        raise RuntimeError("Yahoo muet")
    out = _build(fx=boom)
    assert out["quote"]["fx_to_chf"] is None
    assert out["quote"]["price"] == 78760.1          # le reste vit
    assert "fx" in out["degraded"]


@pytest.mark.parametrize("value", [None, 0, -1.5, "beaucoup"])
def test_un_taux_qui_n_en_est_pas_un_est_traite_comme_une_panne(value):
    out = _build(fx=lambda currency: value)
    assert out["quote"]["fx_to_chf"] is None
    assert "fx" in out["degraded"]


def test_le_taux_est_demande_pour_la_devise_de_la_cotation():
    vus = []
    out = _build(quote=lambda symbol: {"price": 230.0, "currency": "usd "},
                 fx=lambda currency: vus.append(currency) or 0.8129)
    assert vus == ["USD"]                   # normalisé avant l'appel
    assert out["quote"]["fx_to_chf"] == 0.8129


def test_une_action_annonce_le_differe_de_quinze_minutes():
    out = brief.build("tester", "AAPL", "NASDAQ:AAPL", deps=_deps(), now=NOW)
    assert out["quote"]["delay_min"] == 15
    assert out["kind"] == "stock"


def test_la_position_du_titre_est_isolee_et_valorisee():
    out = _build()
    assert out["position"]["side"] == "long"
    assert out["position"]["qty"] == 0.02
    assert out["position"]["avg"] == 77900.0
    assert out["position"]["stop"] == 76800.0
    assert out["position"]["target"] == 81000.0
    # (78760,1 - 77900) x 0,02 = 17,20
    assert out["position"]["pnl_chf"] == 17.2


def test_sans_ligne_sur_le_titre_la_position_est_nulle_jamais_un_dict_vide():
    out = brief.build("tester", "AAPL", "NASDAQ:AAPL", deps=_deps(), now=NOW)
    assert out["position"] is None


def test_la_position_du_coach_est_a_part():
    out = _build()
    assert out["coach_position"]["side"] == "short"
    assert out["coach_position"]["thesis"] == "these du coach"


def test_les_ordres_en_attente_sont_ceux_du_titre_et_encore_ouverts():
    out = _build()
    assert [row["id"] for row in out["pending_orders"]] == ["o1"]


def test_seules_les_alertes_armees_du_titre_remontent():
    """L'extension ÉVALUE ces alertes sur le prix vif (§7, levier 5) : une
    alerte déjà déclenchée n'a plus rien à surveiller, l'envoyer la ferait
    tirer une deuxième fois."""
    out = _build()
    assert [row["id"] for row in out["alerts"]] == ["a1"]


def test_les_nouvelles_sont_filtrees_sur_le_titre_et_mises_en_forme():
    out = _build()
    assert len(out["news"]) == 1
    item = out["news"][0]
    assert set(item) == {"ts", "title", "source", "via", "sentiment", "url"}
    assert item["source"] == "reuters"
    assert item["via"] == "tradingview"


def test_une_depeche_tradingview_du_symbole_tv_est_gardee():
    news = [{"ts": "2026-09-09T13:00:00", "symbol": "BITSTAMP:BTCUSD",
             "title": "Vu par TradingView", "src": "tradingview"}]
    out = _build(news=lambda username: news)
    assert len(out["news"]) == 1
    assert out["news"][0]["title"] == "Vu par TradingView"


def test_les_nouvelles_sont_bornees_aux_dix_dernieres():
    news = [{"ts": "2026-09-09T13:%02d:00" % i, "symbol": "BTC-USD",
             "title": "depeche %d" % i, "src": "rss"} for i in range(20)]
    out = _build(news=lambda username: news)
    assert len(out["news"]) == 10


def test_le_calendrier_garde_le_macro_et_ce_qui_touche_le_titre():
    out = _build()
    labels = [row["label"] for row in out["calendar"]]
    assert "US CPI" in labels          # macro : pour tout le monde
    assert "Echeance" in labels        # daté sur ce titre
    assert "Ailleurs" not in labels    # daté sur un autre titre


def test_le_technique_melange_le_jour_et_la_minute():
    out = _build()
    assert out["ta"]["atr14_d"] is not None
    assert out["ta"]["atr1_m"] is not None
    assert out["ta"]["day_high"] == pytest.approx(103.4)
    assert out["ta"]["day_low"] == pytest.approx(96.6)
    assert out["ta"]["vwap"] is not None


def test_le_vwap_est_nul_sans_volume():
    """« Champs absents = null, jamais inventés » : un VWAP calculé sans les
    volumes serait une moyenne des cours déguisée en prix moyen pondéré."""
    candles = [dict(row, volume=None) for row in _candles_1m()]
    out = _build(candles_1m=lambda symbol: candles)
    assert out["ta"]["vwap"] is None
    assert out["ta"]["day_high"] is not None    # les extrêmes, eux, existent


def test_les_frais_annoncent_le_profil_et_l_aller_retour():
    """0,26 % par jambe -> 0,52 % l'aller-retour, au CENTIME près : la ligne
    vaut 0,02 x 78 760,1 = 1 575,20, la jambe 4,10 (arrondie), donc 0,5206 %.
    ``fees`` arrondit chaque composante avant de sommer (doctrine du module) —
    on épingle le chiffre RÉELLEMENT affiché, pas sa version idéalisée."""
    out = _build()
    assert out["fees"]["profile"] == "kraken_spot"
    assert out["fees"]["notional_chf"] == pytest.approx(1575.2)
    assert out["fees"]["round_trip_pct"] == 0.5206


def _fee_deps(**overrides):
    """Un portefeuille SANS ligne sur le titre, chez ``yuh``.

    Sans position, ``_fees_view`` chiffre sur le ticket de référence (10 % de
    l'équité) : 1 000 CHF ronds, donc des barèmes lisibles (0,52 % / 1,30 % /
    0,20 %) au lieu des arrondis au centime du test voisin. Et le profil du
    PORTEFEUILLE (``yuh``) diffère de celui que l'extension impose : sans cet
    écart, un test « le profil imposé gagne » ne prouverait rien.
    """
    base = {
        "portfolio": lambda username: {"cash_chf": 10000.0,
                                       "fee_profile": "yuh",
                                       "positions": [], "orders": []},
        "fees_profile": lambda username: "yuh",
    }
    base.update(overrides)
    return _deps(**base)


def _fee_build(deps=None, **kwargs):
    return brief.build("tester", "BTC-USD", "BITSTAMP:BTCUSD",
                       deps=_fee_deps() if deps is None else deps,
                       now=NOW, **kwargs)


def test_sans_profil_impose_la_fiche_garde_celui_du_portefeuille():
    out = _fee_build()
    assert out["fees"] == {"profile": "yuh", "round_trip_pct": 1.3,
                           "notional_chf": 1000.0}


def test_le_profil_de_l_extension_remplace_celui_du_portefeuille():
    """Le cas vécu sur UKOIL : la fiche annonçait 1,30 % (Yuh, le profil du
    SITE) alors que l'extension enregistre ses scalps en ``kraken_spot``
    (0,52 %) — les frais affichés étaient ceux d'un autre courtier."""
    out = _fee_build(fee_profile="kraken_spot")
    assert out["fees"]["profile"] == "kraken_spot"
    assert out["fees"]["round_trip_pct"] == 0.52


@pytest.mark.parametrize("value", ["  KRAKEN_SPOT  ", "Kraken_Spot", "kraken_spot"])
def test_le_profil_impose_est_normalise(value):
    assert _fee_build(fee_profile=value)["fees"]["profile"] == "kraken_spot"


@pytest.mark.parametrize("value", ["", None, "   ", "binance_frites", "yuh "])
def test_un_profil_impose_inconnu_retombe_en_silence_sur_le_portefeuille(value):
    """Repli SILENCIEUX : une faute de frappe dans l'extension ne doit pas
    faire tomber la fiche ni inventer un barème."""
    out = _fee_build(fee_profile=value)
    assert out["fees"]["profile"] == "yuh"
    assert out["fees"]["round_trip_pct"] == 1.3
    assert out["degraded"] == []


def test_le_taux_personnalise_est_transmis_au_bareme():
    assert _fee_build(fee_profile="custom",
                      custom_pct=0.1)["fees"]["round_trip_pct"] == 0.2
    assert _fee_build(fee_profile="custom",
                      custom_pct=0.5)["fees"]["round_trip_pct"] == 1.0


def test_un_taux_personnalise_hors_profil_custom_est_ignore():
    """``fees`` ne laisse réécrire le taux que sur le profil ``custom`` : un
    ``custom_pct`` envoyé avec Kraken ne doit rien changer."""
    out = _fee_build(fee_profile="kraken_spot", custom_pct=5.0)
    assert out["fees"]["round_trip_pct"] == 0.52


def test_le_profil_impose_ne_touche_a_rien_d_autre():
    """Il change les FRAIS, pas le portefeuille ni la cotation."""
    impose = _fee_build(fee_profile="kraken_spot")
    defaut = _fee_build()
    for key in ("quote", "position", "defaults", "ta", "degraded"):
        assert impose[key] == defaut[key], key


def test_l_humeur_recolte_le_fear_and_greed_et_le_dvol_du_volet_bitcoin():
    out = _build()
    assert out["mood"]["vix"] == 18.2
    assert out["mood"]["fng"] == 66
    assert out["mood"]["dvol"] == 40.3


def test_les_defauts_portent_le_risque_et_l_equite():
    out = _build()
    assert out["defaults"]["risk_pct"] == 1.0
    # 5000 de trésorerie + 0,02 x 77900 (prix de revient) = 6558
    assert out["defaults"]["equity_chf"] == pytest.approx(6558.0)


def test_le_volet_bitcoin_n_est_servi_que_pour_une_crypto():
    out = brief.build("tester", "AAPL", "NASDAQ:AAPL", deps=_deps(), now=NOW)
    assert out["btc"] is None
    assert "btc" not in out["degraded"]     # pas demandé n'est pas en panne


def test_le_volet_bitcoin_absent_degrade_sans_faire_tomber_la_fiche():
    """``btc.py`` est écrit par un autre lot : tant qu'il n'existe pas,
    l'import échoue et la fiche le DIT au lieu de tomber."""
    def boom():
        raise ImportError("pas encore de module btc")
    out = _build(btc=boom)
    assert out["btc"] is None
    assert "btc" in out["degraded"]


def test_une_panne_par_source_est_isolee():
    def boom(*args):
        raise RuntimeError("panne")
    out = _build(news=boom, whales=boom, hypotheses=boom)
    assert out["news"] == []
    assert out["whales"] == []
    assert out["hypotheses"] == []
    assert sorted(out["degraded"]) == ["hypotheses", "news", "whales"]
    assert out["quote"]["price"] == 78760.1     # le reste vit


def test_le_vix_en_panne_laisse_le_reste_de_l_humeur():
    """``mood`` est le SEUL champ composite (§5.1 : ``{vix, fng, dvol}``, deux
    sources) : le VIX en panne ne doit pas effacer le Fear & Greed qu'on a. Le
    champ n'est nul que s'il est VIDE ; ``degraded`` dit quand même la panne."""
    def boom(*args):
        raise RuntimeError("panne")
    out = _build(mood=boom)
    assert out["mood"] == {"fng": 66, "dvol": 40.3}
    assert "mood" in out["degraded"]


def test_l_humeur_est_nulle_quand_aucune_de_ses_deux_sources_ne_repond():
    def boom(*args):
        raise RuntimeError("panne")
    out = _build(mood=boom, btc=boom)
    assert out["mood"] is None
    assert sorted(out["degraded"]) == ["btc", "mood"]


def test_toutes_les_sources_en_panne_rendent_une_fiche_complete_et_vide():
    def boom(*args):
        raise RuntimeError("panne")
    deps = dict((key, boom) for key in brief.DEP_NAMES)
    out = brief.build("tester", "BTC-USD", "BITSTAMP:BTCUSD", deps=deps, now=NOW)
    assert out["symbol"] == "BTC-USD"
    assert out["quote"] is None and out["position"] is None
    assert out["news"] == [] and out["alerts"] == [] and out["ideas"] == []
    assert out["ta"] == {"atr14_d": None, "atr1_m": None, "vwap": None,
                         "day_high": None, "day_low": None}
    # ``fx`` n'est PAS dedans : sans cotation il n'y a pas de devise, donc rien
    # à convertir — « pas demandé n'est pas en panne » (cf. le volet bitcoin).
    assert set(out["degraded"]) == set(brief.DEP_NAMES) - {"fx"}


def test_build_ne_leve_jamais_meme_sur_des_sources_absurdes():
    deps = dict((key, lambda *a: "pas un dict") for key in brief.DEP_NAMES)
    out = brief.build("tester", "BTC-USD", "BITSTAMP:BTCUSD", deps=deps, now=NOW)
    assert out["symbol"] == "BTC-USD"
    assert isinstance(out["degraded"], list)


def test_les_sources_par_defaut_couvrent_tout_le_contrat():
    """Sans ``deps``, chaque source a bien une implémentation réelle — on
    vérifie le CÂBLAGE (des appelables, les bonnes clés), jamais l'appel :
    celui-là sortirait sur Yahoo."""
    defaults = brief.default_deps()
    assert set(defaults) == set(brief.DEP_NAMES)
    assert all(callable(fn) for fn in defaults.values())


# --------------------------------------------------------------------------- #
# Task 4 — les routes
# --------------------------------------------------------------------------- #

class FakeUser(object):
    def __init__(self, role="admin", username="tester"):
        self.role = role
        self.is_admin = role == "admin"
        self.username = username


def make_client(tmp_path, monkeypatch, role="admin"):
    """Client isolé : disque en tmp, ``brief.build`` doublé (il sortirait sur
    Yahoo), horloge figée."""
    monkeypatch.setattr(store, "DATA_DIR", tmp_path / "paper_trading")
    monkeypatch.setattr(ptr, "_now_iso", lambda: NOW)
    monkeypatch.setattr(ptr.brief, "build",
                        lambda username, symbol, tv_symbol, **kw: {
                            "symbol": symbol, "tv_symbol": tv_symbol,
                            "kind": brief.kind_of(symbol), "degraded": []})
    app = FastAPI()
    app.include_router(ptr.router)
    app.dependency_overrides[get_current_user] = lambda: FakeUser(role)
    return TestClient(app)


def test_brief_repond_pour_un_symbole_yahoo(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch)
    got = client.get("/api/paper/brief?symbol=BTC-USD&tv=BITSTAMP:BTCUSD")
    assert got.status_code == 200
    assert got.json()["symbol"] == "BTC-USD"
    assert got.json()["tv_symbol"] == "BITSTAMP:BTCUSD"


def _spy_build(monkeypatch):
    """Remplace ``brief.build`` par un mouchard qui garde ses mots-clés."""
    vus = {}

    def _build(username, symbol, tv_symbol, **kw):
        vus.update(kw)
        return {"symbol": symbol, "tv_symbol": tv_symbol,
                "kind": brief.kind_of(symbol), "degraded": []}

    monkeypatch.setattr(ptr.brief, "build", _build)
    return vus


def test_brief_transmet_le_profil_de_frais_de_l_extension(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch)
    vus = _spy_build(monkeypatch)
    got = client.get("/api/paper/brief?symbol=BTC-USD&tv=BITSTAMP:BTCUSD"
                     "&fee_profile=kraken_spot&custom_pct=0.1")
    assert got.status_code == 200
    assert vus["fee_profile"] == "kraken_spot"
    assert vus["custom_pct"] == 0.1


def test_brief_sans_profil_impose_n_impose_rien(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch)
    vus = _spy_build(monkeypatch)
    assert client.get("/api/paper/brief?symbol=BTC-USD").status_code == 200
    assert vus["fee_profile"] == ""
    assert vus["custom_pct"] is None


def test_brief_avale_un_profil_inconnu_sans_500(tmp_path, monkeypatch):
    """Le repli vit dans ``build`` : la route ne filtre pas, elle transmet."""
    client = make_client(tmp_path, monkeypatch)
    vus = _spy_build(monkeypatch)
    got = client.get("/api/paper/brief?symbol=BTC-USD&fee_profile=binance_frites")
    assert got.status_code == 200
    assert vus["fee_profile"] == "binance_frites"


def test_brief_deduit_le_symbole_du_seul_symbole_tradingview(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch)
    got = client.get("/api/paper/brief?tv=BINANCE:BTCUSDT")
    assert got.status_code == 200
    assert got.json()["symbol"] == "BTC-USD"


def test_brief_canonise_le_symbole_recu(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch)
    got = client.get("/api/paper/brief?symbol=rog.sw")
    assert got.json()["symbol"] == "RO.SW"


def test_brief_refuse_un_symbole_introuvable(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch)
    assert client.get("/api/paper/brief?tv=MOEX:GAZP").status_code == 400
    assert client.get("/api/paper/brief").status_code == 400


def test_brief_exige_un_jeton(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path / "paper_trading")
    app = FastAPI()
    app.include_router(ptr.router)
    client = TestClient(app)
    assert client.get("/api/paper/brief?symbol=AAPL").status_code == 401


def test_brief_refuse_un_role_sans_droit(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch, role="player")
    assert client.get("/api/paper/brief?symbol=AAPL").status_code == 403


def test_precheck_rend_le_ticket_chiffre(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch)
    store.save_portfolio("tester", {"cash_chf": 10000.0,
                                    "initial_capital": 10000.0,
                                    "fee_profile": "ibkr",
                                    "positions": [], "orders": [], "trades": []})
    got = client.post("/api/paper/precheck",
                      json={"symbol": "AAPL", "side": "buy", "price": 100.0,
                            "stop": 98.0, "target": 110.0, "risk_pct": 1.0,
                            "mode": "swing"})
    assert got.status_code == 200
    data = got.json()
    assert data["qty"] == 50
    assert data["risk_chf"] == 100.0
    assert data["r_multiple"] == 5.0
    assert isinstance(data["warnings"], list)
    assert isinstance(data["refusals"], list)


def test_precheck_ne_bloque_jamais(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch)
    store.save_portfolio("tester", {"cash_chf": 10000.0,
                                    "initial_capital": 10000.0,
                                    "fee_profile": "yuh",
                                    "positions": [], "orders": [], "trades": []})
    got = client.post("/api/paper/precheck",
                      json={"symbol": "AAPL", "side": "buy", "price": 100.0,
                            "stop": 99.99, "target": 100.1, "mode": "scalp",
                            "atr1_m": 0.01})
    assert got.status_code == 200
    assert got.json()["refusals"]


def test_precheck_exige_un_jeton(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path / "paper_trading")
    app = FastAPI()
    app.include_router(ptr.router)
    client = TestClient(app)
    got = client.post("/api/paper/precheck",
                      json={"symbol": "AAPL", "side": "buy", "price": 100.0})
    assert got.status_code == 401


def _armed(client, symbol="BTC-USD"):
    alert = price_alerts.new_alert("a1", symbol, "above", 80000.0, NOW)
    store.save_alerts("tester", [alert])
    return alert


def test_declencher_une_alerte_la_marque_et_la_persiste(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch)
    _armed(client)
    got = client.post("/api/paper/alerts/a1/fire",
                      json={"price": 80100.0, "ts": "2026-09-09T14:00:05",
                            "by": "extension"})
    assert got.status_code == 200
    alert = got.json()["alert"]
    assert got.json()["ok"] is True
    assert alert["fired"] is True
    assert alert["fired_at"] == "2026-09-09T14:00:05"
    assert alert["fired_by"] == "extension"
    assert alert["fired_price"] == 80100.0
    # Le statut EXISTANT bascule aussi : c'est lui que le guetteur de 15 min
    # regarde pour ne pas tirer une seconde fois (dédoublonnage, §5.5).
    assert alert["status"] == price_alerts.STATUS_TRIGGERED
    assert store.load_alerts("tester")[0]["fired_by"] == "extension"


def test_declencher_une_alerte_inconnue_donne_404(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch)
    _armed(client)
    got = client.post("/api/paper/alerts/inconnue/fire", json={"price": 1.0})
    assert got.status_code == 404


def test_declencher_deux_fois_donne_409(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch)
    _armed(client)
    assert client.post("/api/paper/alerts/a1/fire",
                       json={"price": 80100.0}).status_code == 200
    got = client.post("/api/paper/alerts/a1/fire", json={"price": 80200.0})
    assert got.status_code == 409
    assert store.load_alerts("tester")[0]["fired_price"] == 80100.0


def test_declencher_sans_horodatage_prend_l_heure_du_serveur(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch)
    _armed(client)
    got = client.post("/api/paper/alerts/a1/fire", json={"price": 80100.0})
    assert got.json()["alert"]["fired_at"] == NOW


def test_declencher_exige_un_jeton(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path / "paper_trading")
    app = FastAPI()
    app.include_router(ptr.router)
    client = TestClient(app)
    got = client.post("/api/paper/alerts/a1/fire", json={"price": 1.0})
    assert got.status_code == 401
