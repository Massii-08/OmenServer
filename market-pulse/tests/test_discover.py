"""Découverte de titres — « une liste de nouveaux titres déjà analysés ».

Demande de Massii. « Entrer » = entrer dans sa LISTE DE SUIVI, pas entrer en
position : on lui présente des sociétés apparues dans l'actualité, fiche déjà
remplie, et c'est lui qui choisit lesquelles il suit.

⚠️ Aucun jugement de valeur n'accompagne la liste : « apparu dans l'actualité »
est un fait, « intéressant à acheter » serait un conseil.

Tous les titres de test sont RÉELS (flux du 2026-07-29).
"""
from pulse.discover import (candidate_names, discover, extract_tickers)


REELS = [
    "Starbucks stock jumps as coffee giant raises full-year outlook",
    "Qualcomm's stock falls as memory woes weigh on earnings",
    "Corning tumbles 12% after earnings, leading rout in optical stocks",
    "Meta's Reality Labs lost over $4.6 billion in second quarter",
    "Webuild lancia opa su Trevi da 295 milioni",
    "Chipotle hikes same-store sales forecast as diners return",
    "Nike (NKE) Stock Looks Cheap On Earnings But Pricey On Cash Flow",
    "SK Hynix announces Q2 results, stock falls AH",
]

BRUIT = [
    "Global oil prices settle at a 2-week low",
    "The Federal Reserve on Wednesday voted to hold its key interest rate",
    "Here are the five big takeaways from this week's Fed meeting",
    "‘Love Island USA’ winners are spending their $100,000 prize money",
]


# --------------------------------------------------------------------------
# Tickers explicites
# --------------------------------------------------------------------------

def test_explicit_tickers_are_extracted():
    assert extract_tickers("Nike (NKE) Stock Looks Cheap On Earnings") == ["NKE"]
    assert extract_tickers("$AAPL and $MSFT lead the rally") == ["AAPL", "MSFT"]
    assert extract_tickers("Ferrari (RACE.MI) pubblica i risultati") == ["RACE.MI"]


def test_common_parentheses_are_not_mistaken_for_tickers():
    """« (Reuters) » ou « (AP) » ne sont pas des tickers, et un sigle de deux
    lettres est trop ambigu pour en être un."""
    assert extract_tickers("Markets rise (Reuters) after data") == []
    assert extract_tickers("Growth slows (AP)") == []
    assert extract_tickers("Profit up 12% (see chart)") == []


def test_extract_tickers_tolerates_garbage():
    assert extract_tickers(None) == []
    assert extract_tickers("") == []
    assert extract_tickers(1234) == []


# --------------------------------------------------------------------------
# Noms de sociétés
# --------------------------------------------------------------------------

def test_company_names_are_spotted_in_real_headlines():
    found = set()
    for title in REELS:
        found.update(candidate_names(title))
    for expected in ("Starbucks", "Qualcomm", "Corning", "Meta", "Webuild", "Chipotle"):
        assert expected in found, "société non repérée : %s" % expected


def test_institutions_and_noise_are_not_candidates():
    """La Fed n'est pas un titre cotable, et « Love Island » n'est pas une
    société — sans ce filtre la liste serait ridicule."""
    for title in BRUIT:
        names = candidate_names(title)
        for bad in ("Federal", "Reserve", "Fed", "Love", "Island", "Global", "Here"):
            assert bad not in names, "%r retenu depuis %r" % (bad, title)


def test_a_name_must_start_the_sentence_or_be_capitalised_mid_sentence():
    assert "Chipotle" in candidate_names("Chipotle hikes same-store sales forecast")
    # un mot commun en tête de phrase ne fait pas une société
    assert candidate_names("Markets are calm today") == []


def test_candidate_names_tolerates_garbage():
    assert candidate_names(None) == []
    assert candidate_names("") == []


# --------------------------------------------------------------------------
# Découverte complète — résolution injectée, aucun réseau
# --------------------------------------------------------------------------

RESOLVED = {
    "Starbucks": {"symbol": "SBUX", "name": "Starbucks Corporation", "exchange": "NMS"},
    "Qualcomm": {"symbol": "QCOM", "name": "QUALCOMM Incorporated", "exchange": "NMS"},
    "Corning": {"symbol": "GLW", "name": "Corning Incorporated", "exchange": "NYQ"},
    "Webuild": {"symbol": "WBD.MI", "name": "Webuild S.p.A.", "exchange": "MIL"},
    "Chipotle": {"symbol": "CMG", "name": "Chipotle Mexican Grill", "exchange": "NYQ"},
    "Meta": {"symbol": "META", "name": "Meta Platforms, Inc.", "exchange": "NMS"},
}


def _resolve(name, lang=""):
    return RESOLVED.get(name)


def _items(titles):
    return [{"title": t, "published": 1785300000} for t in titles]


def test_discover_returns_new_symbols_with_their_source_headline():
    out = discover(_items(REELS), followed=(), resolve=_resolve)
    symbols = {c["symbol"] for c in out}
    assert "SBUX" in symbols and "GLW" in symbols and "WBD.MI" in symbols
    for c in out:
        assert c["headline"], "aucun titre d'origine cité"
        assert c["exchange_id"], "société non rattachée à une place"


def test_already_followed_symbols_are_excluded():
    """C'est tout l'intérêt : ne proposer que du NOUVEAU."""
    out = discover(_items(REELS), followed=("SBUX", "GLW"), resolve=_resolve)
    symbols = {c["symbol"] for c in out}
    assert "SBUX" not in symbols and "GLW" not in symbols
    assert "QCOM" in symbols


def test_symbols_outside_the_followed_venues_are_dropped():
    """Un titre coté à Varsovie n'a rien à faire dans une liste construite pour
    les dix places suivies."""
    def resolve(name, lang=""):
        return {"symbol": "NIKE.WA", "name": "NIKE", "exchange": "WSE"}
    assert discover(_items(["Nike raises guidance"]), followed=(), resolve=resolve) == []


def test_a_name_that_resolves_to_nothing_is_dropped_silently():
    assert discover(_items(REELS), followed=(), resolve=lambda n, lang="": None) == []


def test_the_same_company_cited_twice_appears_once():
    out = discover(_items(["Starbucks raises outlook",
                           "Starbucks stock jumps after earnings"]),
                   followed=(), resolve=_resolve)
    assert len(out) == 1
    assert out[0]["mentions"] == 2


def test_candidates_are_ranked_by_number_of_mentions():
    titles = ["Starbucks raises outlook", "Starbucks stock jumps",
              "Qualcomm's stock falls"]
    out = discover(_items(titles), followed=(), resolve=_resolve)
    assert out[0]["symbol"] == "SBUX"


def test_discover_on_empty_input():
    assert discover([], followed=(), resolve=_resolve) == []
    assert discover(None, followed=(), resolve=_resolve) == []


def test_resolution_is_called_once_per_distinct_name():
    """Chaque résolution est une requête réseau : on ne la refait pas pour un
    nom déjà vu."""
    calls = []

    def counting(name, lang=""):
        calls.append(name)
        return RESOLVED.get(name)

    discover(_items(["Starbucks raises outlook", "Starbucks stock jumps",
                     "Qualcomm's stock falls"]), followed=(), resolve=counting)
    assert sorted(calls) == ["Qualcomm", "Starbucks"]


# --------------------------------------------------------------------------
# Ligne rouge
# --------------------------------------------------------------------------

def test_a_candidate_carries_no_judgement():
    """« apparu dans l'actualité » est un fait. Pas de note, pas de score, pas
    de conseil : le champ ne doit pas exister."""
    out = discover(_items(REELS), followed=(), resolve=_resolve)
    for c in out:
        assert set(c) == {"symbol", "name", "exchange_id", "mentions",
                          "headline", "headlines"}


# --------------------------------------------------------------------------
# Trois défauts trouvés EN LANÇANT la découverte sur les vraies news
# --------------------------------------------------------------------------

def test_a_possessive_common_word_is_not_a_company():
    """« Here's what changed in the Fed statement » donnait « Here », résolu en
    « Here Group Limited » et présenté comme un titre à suivre. Le possessif
    doit tomber AVANT le test de mot commun."""
    assert "Here" not in candidate_names("Here's what changed in the second Fed statement")
    assert "There" not in candidate_names("There's more to come, says the CEO")


def test_the_language_of_the_headline_is_passed_to_the_resolver():
    """Sans cet indice, « Trevi » dans une dépêche ITALIENNE se résout en Trevi
    Therapeutics au Nasdaq au lieu de la société milanaise visée par l'OPA —
    c'est le mauvais-émetteur du piège #31 du dépôt, reproduit ici."""
    vus = []

    def resolve(name, lang=""):
        vus.append((name, lang))
        return None

    discover([{"title": "Webuild lancia opa su Trevi da 295 milioni",
               "lang": "it", "published": 1}], followed=(), resolve=resolve)
    assert vus, "le résolveur n'a pas été appelé"
    assert all(lang == "it" for _n, lang in vus)


def test_non_english_function_words_are_not_companies():
    """Trois faux positifs vus EN RÉEL sur des dépêches italiennes : « Per
    quota 49,9%... » se résolvait en Performance Shipping, « Tap offerte da
    Lufthansa » en Tapestry. Un titre italien ou allemand commence lui aussi
    par une majuscule — la liste de mots communs ne peut pas être anglaise."""
    assert "Per" not in candidate_names("Per quota 49,9% in portoghese Tap offerte da Lufthansa")
    assert "Dopo" not in candidate_names("Dopo i conti la borsa reagisce")
    assert "Nach" not in candidate_names("Nach den Zahlen steigt die Aktie")
    assert "Apres" not in candidate_names("Apres les resultats le titre monte")


def test_a_three_letter_name_is_too_short_to_be_discriminating():
    """« Tap » (la compagnie portugaise) se résolvait en Tapestry. Sous quatre
    lettres, un nom nu n'est pas assez discriminant — sauf s'il est écrit comme
    un ticker explicite, ce que gère extract_tickers."""
    assert "Tap" not in candidate_names("Tap offerte da Lufthansa e Air France")
    assert extract_tickers("Ferrari (RACE) sale") == ["RACE"]


def test_a_capitalised_function_word_mid_sentence_is_not_a_company():
    """Mesuré en réel : « Should we set up a trust » produisait le candidat
    « Should », résolu en « Shoulder Innovations Inc. » et proposé comme titre
    à suivre. Un mot commun capitalisé au milieu d'une phrase est aussi
    dangereux qu'en tête."""
    names = candidate_names("'We already have wills': We're in our 60s. Should we set up a trust?")
    for bad in ("Should", "We", "Were"):
        assert bad not in names, "%r retenu" % bad
