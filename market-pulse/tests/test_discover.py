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


# --------------------------------------------------------------------------
# Homonymie — toponymes et mots courants (mesuré en réel : 5 faux positifs
# sur 11 propositions, 45%, sur un run réel du 2026-08-04). Même classe que
# le WRONG-ISSUER du Bond Scanner (piège #31) : le rapprochement se fait sur
# un seul mot qui apparaît bien dans le nom réel de la société, mais qui ne
# suffit pas à prouver que l'article parle DE cette société plutôt que du
# LIEU ou du mot dans son sens commun.
# --------------------------------------------------------------------------

FAUX_POSITIFS_TITRES = [
    "Before the art islands, a reason to stop in Okayama",
    "Beyond the language of decline: Hope for democratic renewal",
    "Streetcar that survived atomic bomb now used for tours in Hiroshima",
    "California's diesel prices have jumped since the Iran war started, "
    "with ripple effects across the country",
]

# Résolveur RÉEL mesuré : chacun de ces mots existe bel et bien comme préfixe
# ou token du nom officiel d'une société cotée — le rapprochement n'est pas
# une erreur de recherche, c'est le mot qui ne suffit pas.
_RESOLVED_HOMONYMES = {
    "Okayama": {"symbol": "9063.T", "name": "OKAYAMAKEN FREIGHT TRANSPORTATI",
                "exchange": "JPX"},
    "Beyond": {"symbol": "BYND", "name": "Beyond Meat, Inc.", "exchange": "NMS"},
    "Hope": {"symbol": "HOPE", "name": "Hope Bancorp, Inc.", "exchange": "NMS"},
    "Hiroshima": {"symbol": "9535.T", "name": "HIROSHIMA GAS CO", "exchange": "JPX"},
    "California": {"symbol": "BANC", "name": "Banc of California, Inc.",
                   "exchange": "NYQ"},
}

VRAIS_POSITIFS_TITRES = [
    "Palantir soars 12% on blowout quarter, with U.S. commercial revenue "
    "soaring nearly 150%",
    "Palantir's stock climbs after earnings, as AI drives turbocharged growth",
    "Microsoft's stock is on a run not seen in 26 years — erasing its "
    "year-to-date losses",
    "Amazon tops $3 trillion market cap as stock continues post-earnings surge",
    "Prysmian acquisisce l'americana Atkore, operazione da 3,3 miliardi",
    "Prysmian rilancia sul mercato Usa rilevando Aktore per 3,3 miliardi",
]

_RESOLVED_LEGITIMES = {
    "Palantir": {"symbol": "PLTR", "name": "Palantir Technologies Inc.",
                 "exchange": "NMS"},
    "Microsoft": {"symbol": "MSFT", "name": "Microsoft Corporation",
                  "exchange": "NMS"},
    "Amazon": {"symbol": "AMZN", "name": "Amazon.com, Inc.", "exchange": "NMS"},
    "Prysmian": {"symbol": "PRY.MI", "name": "Prysmian S.p.A.", "exchange": "MIL"},
}


def test_toponyms_are_not_candidates_on_their_own():
    """Une préfecture japonaise ou un état américain, mentionné seul, ne doit
    jamais devenir un candidat — de vraies sociétés régionales portent
    littéralement le nom de leur préfecture (OKAYAMAKEN FREIGHT
    TRANSPORTATI, HIROSHIMA GAS CO), et « Banc of California » n'a pas plus
    de rapport avec l'article sur le prix du diesel que ICBC n'en avait avec
    Iccrea Banca (piège #31)."""
    assert "Okayama" not in candidate_names(FAUX_POSITIFS_TITRES[0])
    assert "Hiroshima" not in candidate_names(FAUX_POSITIFS_TITRES[2])
    assert "California" not in candidate_names(FAUX_POSITIFS_TITRES[3])


def test_common_capitalised_words_are_not_candidates_on_their_own():
    """« Beyond » et « Hope », mots anglais courants capitalisés en tête de
    phrase, résolvent en de vraies sociétés (Beyond Meat, Hope Bancorp) —
    mais l'article parle de renouveau démocratique, pas de ces sociétés."""
    names = candidate_names(FAUX_POSITIFS_TITRES[1])
    assert "Beyond" not in names
    assert "Hope" not in names


def test_homonymous_toponyms_and_common_words_are_never_proposed():
    """Bout en bout : les 5 faux positifs mesurés sur le run réel du
    2026-08-04 ne doivent plus jamais être proposés, quel que soit ce que
    rendrait le résolveur."""
    def resolve(name, lang=""):
        return _RESOLVED_HOMONYMES.get(name)

    out = discover(_items(FAUX_POSITIFS_TITRES), followed=(), resolve=resolve)
    symbols = {c["symbol"] for c in out}
    for bad in ("9063.T", "BYND", "HOPE", "9535.T", "BANC"):
        assert bad not in symbols, "%r proposé à tort" % bad


def test_legitimate_single_word_brands_still_resolve():
    """Le garde-fou anti-homonymie ne doit PAS sacrifier les vraies marques
    d'un seul mot : Palantir, Microsoft, Amazon et Prysmian doivent continuer
    à être proposées — recall < correctness, mais pas recall = zéro."""
    def resolve(name, lang=""):
        return _RESOLVED_LEGITIMES.get(name)

    out = discover(_items(VRAIS_POSITIFS_TITRES), followed=(), resolve=resolve)
    symbols = {c["symbol"] for c in out}
    for good in ("PLTR", "MSFT", "AMZN", "PRY.MI"):
        assert good in symbols, "%r manquant" % good


def test_imax_is_a_real_citation_and_survives():
    """Cas limite tranché : IMAX est réellement cité (l'article parle du
    format de projection Imax lui-même), à la différence d'Okayama/Hiroshima
    où le lieu n'a aucun rapport avec la société trouvée. On ne sacrifie pas
    une vraie citation pour simplifier la règle."""
    title = ("As 'Spider-Man' joins 'The Odyssey' in Imax, are premium "
             "movie screens worth the extra price?")
    assert "Imax" in candidate_names(title)

    def resolve(name, lang=""):
        if name == "Imax":
            return {"symbol": "IMAX", "name": "IMAX Corporation", "exchange": "NYQ"}
        return None

    out = discover(_items([title]), followed=(), resolve=resolve)
    assert {c["symbol"] for c in out} == {"IMAX"}


# --------------------------------------------------------------------------
# Sur-blocage trouvé à la vérification (2026-08-04) : le 1er correctif
# rejetait un candidat dès que son PREMIER mot était dans
# _GENERIC_NAME_TOKENS, sans regarder s'il y avait un second mot — rendant
# invisibles Tokyo Electron (poids lourd du Nikkei) et Texas Instruments
# (grande valeur du S&P 500). La règle ne doit écarter QUE les candidats
# d'un seul mot ; accompagné d'un second mot capitalisé, le toponyme devient
# discriminant.
# --------------------------------------------------------------------------

def test_a_toponym_followed_by_a_second_word_is_discriminating():
    """« Tokyo Electron », « Osaka Gas », « Texas Instruments » : le toponyme
    est en tête mais accompagné — aucun article sur la ville de Tokyo ou
    l'état du Texas n'écrit ces deux mots collés. Doivent rester des
    candidats, contrairement à « Tokyo »/« Osaka »/« Texas » tout seuls."""
    assert "Tokyo Electron" in candidate_names(
        "Tokyo Electron shares jump after strong guidance")
    assert "Osaka Gas" in candidate_names(
        "Osaka Gas raises its full-year outlook")
    assert "Texas Instruments" in candidate_names(
        "Texas Instruments beats on earnings")


def test_accompanied_toponyms_still_resolve_end_to_end():
    """Bout en bout : le garde-fou anti-homonymie ne doit pas rendre Tokyo
    Electron ou Texas Instruments invisibles de discover()."""
    titles = [
        "Tokyo Electron shares jump after strong guidance",
        "Osaka Gas raises its full-year outlook",
        "Texas Instruments beats on earnings",
    ]

    def resolve(name, lang=""):
        return {
            "Tokyo Electron": {"symbol": "8035.T", "name": "TOKYO ELECTRON LIMITED",
                                "exchange": "JPX"},
            "Osaka Gas": {"symbol": "9532.T", "name": "OSAKA GAS CO", "exchange": "JPX"},
            "Texas Instruments": {"symbol": "TXN", "name": "Texas Instruments Incorporated",
                                   "exchange": "NMS"},
        }.get(name)

    out = discover(_items(titles), followed=(), resolve=resolve)
    symbols = {c["symbol"] for c in out}
    for good in ("8035.T", "9532.T", "TXN"):
        assert good in symbols, "%r manquant (sur-blocage)" % good


def test_the_5_measured_false_positives_stay_rejected_after_the_fix():
    """Non-régression : le correctif du sur-blocage ne doit pas ressusciter
    les 5 faux positifs d'origine."""
    def resolve(name, lang=""):
        return _RESOLVED_HOMONYMES.get(name)

    out = discover(_items(FAUX_POSITIFS_TITRES), followed=(), resolve=resolve)
    symbols = {c["symbol"] for c in out}
    for bad in ("9063.T", "BYND", "HOPE", "9535.T", "BANC"):
        assert bad not in symbols, "%r proposé à tort" % bad


def test_the_4_true_positives_still_resolve_after_the_fix():
    """Non-régression : les 4 vrais positifs mono-mot restent proposés."""
    def resolve(name, lang=""):
        return _RESOLVED_LEGITIMES.get(name)

    out = discover(_items(VRAIS_POSITIFS_TITRES), followed=(), resolve=resolve)
    symbols = {c["symbol"] for c in out}
    for good in ("PLTR", "MSFT", "AMZN", "PRY.MI"):
        assert good in symbols, "%r manquant" % good


# --------------------------------------------------------------------------
# 6e faux positif mesuré (2026-08-04, run réel du jour) : « Tourism » n'est
# ni un toponyme ni un mot déjà listé — la LISTE ne pouvait pas le couvrir.
# Règle qui généralise, en plus de la liste (ne pas rallonger la liste pour
# ce cas précis) : pour un candidat d'UN SEUL MOT, n'accepter que si ce mot
# est le mot de TÊTE (premier mot significatif) du nom résolu — même principe
# que le token identitaire du Bond Scanner (piège #31), appliqué cette fois
# au nom RÉSOLU plutôt qu'au terme cherché : le mot qui identifie l'entreprise
# est le premier de son nom, pas un mot du milieu.
# --------------------------------------------------------------------------

TOURISM_TITLE = ("Tourism price wars threaten to dim a rare bright spot in "
                  "China's consumer spending")


def _resolve_tourism(name, lang=""):
    if name == "Tourism":
        return {"symbol": "601888.SS", "name": "CHINA TOURISM GROUP DUTY FREE",
                 "exchange": "SHH"}
    return None


def test_tourism_is_a_mid_name_word_not_the_lead_token_and_is_rejected():
    """« Tourism » (tête de « Tourism price wars threaten... ») se résolvait
    en CHINA TOURISM GROUP DUTY FREE — un mot du MILIEU du nom (tête réelle :
    « China »). L'article parle du secteur du tourisme, pas de cette société
    précise.

    ⚠️ Historique de ce test (à comprendre AVANT de le modifier de nouveau) :
    au moment où seule la règle du mot de tête existait, `candidate_names()`
    rendait `['Tourism']` (le mot n'était dans aucune liste) et c'était
    `discover()` qui le rejetait via le nom résolu. Depuis le 6e faux positif
    mesuré (« Tourism » EST le mot de tête de TOURISM FINANCE CORPORATION —
    la règle du mot de tête l'aurait accepté À RAISON), « tourism » a rejoint
    _GENERIC_NAME_TOKENS : il est désormais filtré dès `candidate_names()`,
    AVANT même d'atteindre la règle du mot de tête. Les deux garde-fous
    coexistent (défense en profondeur), ce test verrouille juste le résultat
    final : jamais proposé, quel que soit le nom que le résolveur renvoie."""
    assert "Tourism" not in candidate_names(TOURISM_TITLE)
    out = discover(_items([TOURISM_TITLE]), followed=(), resolve=_resolve_tourism)
    assert out == []


def test_lead_token_true_positives_still_resolve():
    """Le mot de tête EST le token identitaire quand il colle au premier mot
    (normalisé) du nom résolu : Palantir, Microsoft, Amazon, Prysmian, HSBC,
    McDonald's et Imax doivent tous rester proposés. Comparaison par TOKEN
    ENTIER après normalisation ponctuation/casse — « Amazon » matche
    « Amazon.com » (le point sépare les tokens), « McDonald » (candidat
    post-possessif) matche « McDonald's » (l'apostrophe sépare aussi)."""
    def resolve(name, lang=""):
        return {
            "Palantir": {"symbol": "PLTR", "name": "Palantir Technologies Inc.",
                         "exchange": "NMS"},
            "Microsoft": {"symbol": "MSFT", "name": "Microsoft Corporation",
                          "exchange": "NMS"},
            "Amazon": {"symbol": "AMZN", "name": "Amazon.com, Inc.", "exchange": "NMS"},
            "Prysmian": {"symbol": "PRY.MI", "name": "PRYSMIAN", "exchange": "MIL"},
            "HSBC": {"symbol": "HSBA.L", "name": "HSBC Holdings, plc.", "exchange": "LON"},
            "McDonald": {"symbol": "MCD", "name": "McDonald's Corporation",
                         "exchange": "NYQ"},
            "Imax": {"symbol": "IMAX", "name": "IMAX Corporation", "exchange": "NYQ"},
        }.get(name)

    titles = [
        "Palantir soars 12% on blowout quarter, with U.S. commercial revenue "
        "soaring nearly 150%",
        "Microsoft's stock is on a run not seen in 26 years",
        "Amazon tops $3 trillion market cap as stock continues post-earnings surge",
        "Prysmian acquisisce l'americana Atkore, operazione da 3,3 miliardi",
        "HSBC posts record profit as rate cuts loom",
        "McDonald's same-store sales beat estimates",
        "As 'Spider-Man' joins 'The Odyssey' in Imax, are premium movie "
        "screens worth the extra price?",
    ]
    out = discover(_items(titles), followed=(), resolve=resolve)
    symbols = {c["symbol"] for c in out}
    for good in ("PLTR", "MSFT", "AMZN", "PRY.MI", "HSBA.L", "MCD", "IMAX"):
        assert good in symbols, "%r manquant (sur-blocage du mot de tête)" % good


def test_multi_word_candidates_bypass_the_lead_token_rule():
    """Les candidats multi-mots (déjà discriminants par construction) ne sont
    PAS soumis à la règle du mot de tête : Schneider Electric, Tokyo
    Electron, Osaka Gas, Texas Instruments doivent tous rester proposés."""
    def resolve(name, lang=""):
        return {
            "Schneider Electric": {"symbol": "SU.PA", "name": "SCHNEIDER ELECTRIC SE",
                                    "exchange": "PAR"},
            "Tokyo Electron": {"symbol": "8035.T", "name": "TOKYO ELECTRON LIMITED",
                                "exchange": "JPX"},
            "Osaka Gas": {"symbol": "9532.T", "name": "OSAKA GAS CO", "exchange": "JPX"},
            "Texas Instruments": {"symbol": "TXN", "name": "Texas Instruments Incorporated",
                                   "exchange": "NMS"},
        }.get(name)

    titles = [
        "Schneider Electric raises full-year guidance",
        "Tokyo Electron shares jump after strong guidance",
        "Osaka Gas raises its full-year outlook",
        "Texas Instruments beats on earnings",
    ]
    out = discover(_items(titles), followed=(), resolve=resolve)
    symbols = {c["symbol"] for c in out}
    for good in ("SU.PA", "8035.T", "9532.T", "TXN"):
        assert good in symbols, "%r manquant" % good


def test_the_5_measured_false_positives_and_tourism_all_stay_rejected():
    """Non-régression bout en bout : les 5 faux positifs d'origine ET
    Tourism restent tous écartés une fois la règle du mot de tête ajoutée."""
    def resolve(name, lang=""):
        if name == "Tourism":
            return _resolve_tourism(name, lang)
        return _RESOLVED_HOMONYMES.get(name)

    titles = list(FAUX_POSITIFS_TITRES) + [TOURISM_TITLE]
    out = discover(_items(titles), followed=(), resolve=resolve)
    symbols = {c["symbol"] for c in out}
    for bad in ("9063.T", "BYND", "HOPE", "9535.T", "BANC", "601888.SS"):
        assert bad not in symbols, "%r proposé à tort" % bad


# --------------------------------------------------------------------------
# 2e passage sur Tourism (2026-08-04, résolveur RÉSEAU réel cette fois) : la
# règle du mot de tête ne peut STRUCTURELLEMENT rien faire ici — « Tourism »
# EST vraiment le mot de tête de TOURISM FINANCE CORPORATION OF INDIA, la
# règle l'accepte À JUSTE TITRE selon sa propre logique. BSE -> "nse" est une
# place suivie, et main.py appelle discover() SANS l'argument `venues`
# (venues=None en prod, cf. main.py:201) : le filtre de place ne sauve pas
# non plus. Seule une extension de _GENERIC_NAME_TOKENS aux NOMS COMMUNS
# ABSTRAITS arrête ce cas — « Tourism », « Finance », « Energy »... employés
# seuls dans un titre de presse, désignent presque toujours le CONCEPT, pas
# une société précise. Recall < correctness assumé : « United » seul ne doit
# plus proposer United Airlines, « American » seul ne doit plus proposer
# American Express — un article qui parle vraiment d'elles écrit les DEUX
# mots (« United Airlines »), candidat multi-mots, donc non concerné par
# cette règle mono-mot.
# --------------------------------------------------------------------------

_RESOLVED_TOURISM_FINANCE_REAL = {
    "symbol": "TFCILTD.BO",
    "name": "TOURISM FINANCE CORPORATION OF",
    "exchange": "BSE",
}


def _resolve_tourism_finance_real(name, lang=""):
    if name == "Tourism":
        return dict(_RESOLVED_TOURISM_FINANCE_REAL)
    return None


def test_tourism_finance_corp_the_real_case_the_lead_token_rule_cannot_stop():
    """Critère 1 : même avec venues=None (comme la production), Tourism Finance
    Corp ne doit plus être proposée — « Tourism » EST son mot de tête (la
    règle précédente l'accepterait à raison), et BSE->nse est une place
    suivie (le filtre venues ne coupe rien ici)."""
    out = discover(_items([TOURISM_TITLE]), followed=(),
                    resolve=_resolve_tourism_finance_real, venues=None)
    assert out == []


def test_criteria_2_to_4_hold_with_venues_none_like_production():
    """Critères 2-4, avec venues=None explicite comme le fait réellement
    main.py:201 (qui n'appelle jamais discover() avec l'argument venues)."""
    def resolve(name, lang=""):
        table = dict(_RESOLVED_HOMONYMES)
        table.update(_RESOLVED_LEGITIMES)
        table["HSBC"] = {"symbol": "HSBA.L", "name": "HSBC Holdings, plc.",
                          "exchange": "LON"}
        table["McDonald"] = {"symbol": "MCD", "name": "McDonald's Corporation",
                              "exchange": "NYQ"}
        table["Imax"] = {"symbol": "IMAX", "name": "IMAX Corporation", "exchange": "NYQ"}
        table["Schneider Electric"] = {"symbol": "SU.PA", "name": "SCHNEIDER ELECTRIC SE",
                                        "exchange": "PAR"}
        table["Tokyo Electron"] = {"symbol": "8035.T", "name": "TOKYO ELECTRON LIMITED",
                                    "exchange": "JPX"}
        table["Osaka Gas"] = {"symbol": "9532.T", "name": "OSAKA GAS CO", "exchange": "JPX"}
        table["Texas Instruments"] = {"symbol": "TXN", "name": "Texas Instruments Incorporated",
                                       "exchange": "NMS"}
        return table.get(name)

    # Critère 2 : les 5 faux positifs mesurés restent écartés.
    out2 = discover(_items(FAUX_POSITIFS_TITRES), followed=(), resolve=resolve,
                     venues=None)
    symbols2 = {c["symbol"] for c in out2}
    for bad in ("9063.T", "BYND", "HOPE", "9535.T", "BANC"):
        assert bad not in symbols2, "%r proposé à tort" % bad

    # Critère 3 : Palantir/Microsoft/Amazon/Prysmian/HSBC/McDonald's/Imax
    # restent proposés.
    titres3 = list(VRAIS_POSITIFS_TITRES) + [
        "HSBC posts record profit as rate cuts loom",
        "McDonald's same-store sales beat estimates",
        "As 'Spider-Man' joins 'The Odyssey' in Imax, are premium movie "
        "screens worth the extra price?",
    ]
    out3 = discover(_items(titres3), followed=(), resolve=resolve, venues=None)
    symbols3 = {c["symbol"] for c in out3}
    for good in ("PLTR", "MSFT", "AMZN", "PRY.MI", "HSBA.L", "MCD", "IMAX"):
        assert good in symbols3, "%r manquant" % good

    # Critère 4 : Schneider Electric/Tokyo Electron/Osaka Gas/Texas
    # Instruments (multi-mots) restent proposés.
    titres4 = [
        "Schneider Electric raises full-year guidance",
        "Tokyo Electron shares jump after strong guidance",
        "Osaka Gas raises its full-year outlook",
        "Texas Instruments beats on earnings",
    ]
    out4 = discover(_items(titres4), followed=(), resolve=resolve, venues=None)
    symbols4 = {c["symbol"] for c in out4}
    for good in ("SU.PA", "8035.T", "9532.T", "TXN"):
        assert good in symbols4, "%r manquant" % good


def test_criterion_5_united_airlines_is_a_multi_word_candidate_and_survives():
    """Critère 5 : « United Airlines cuts capacity » propose toujours United
    Airlines — candidat multi-mots (« United » + « Airlines »), donc jamais
    soumis à la règle mono-mot, quand bien même « united » rejoint
    _GENERIC_NAME_TOKENS."""
    assert "United Airlines" in candidate_names("United Airlines cuts capacity")

    def resolve(name, lang=""):
        if name == "United Airlines":
            return {"symbol": "UAL", "name": "United Airlines Holdings, Inc.",
                     "exchange": "NMS"}
        return None

    out = discover(_items(["United Airlines cuts capacity"]), followed=(),
                    resolve=resolve, venues=None)
    assert {c["symbol"] for c in out} == {"UAL"}


def test_a_lone_abstract_noun_is_never_a_candidate_trigger_on_its_own():
    """Les noms communs abstraits fréquemment tête de raison sociale
    (finance, energy, capital, national, international...) ne doivent jamais,
    seuls, déclencher une résolution — même mécanisme que les toponymes."""
    for word, title in (
        ("Finance", "Finance ministers meet to discuss the budget"),
        ("Energy", "Energy prices climb as winter approaches"),
        ("Capital", "Capital flows shift amid rate uncertainty"),
        ("National", "National output grew last quarter"),
        ("American", "American workers see wage growth slow"),
    ):
        names = candidate_names(title)
        assert word not in names, "%r retenu depuis %r" % (word, title)
