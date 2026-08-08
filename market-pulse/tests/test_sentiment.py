"""Thèmes et filtre de conseil — fonctions pures, aucun réseau."""
import pytest

from pulse.sentiment import (THEMES, extract_themes, is_advice, tone_counts)


def _it(title, source="Fonte", lang="it", published=None):
    return {"title": title, "source": source, "lang": lang, "published": published,
            "url": "https://example.test/x"}


# --------------------------------------------------------------------------
# Filtre de conseil — la ligne rouge appliquée aux TITRES DE PRESSE
# --------------------------------------------------------------------------

ADVICE_TITLES = [
    "We're upgrading our rating on Boeing as the turnaround bears fruit",
    "3 stocks to buy right now",
    "Should you buy Nvidia before earnings?",
    "Analyst downgrades Tesla, cuts price target to $180",
    "Le 5 azioni da comprare secondo gli analisti",
    "Perché conviene vendere questo titolo",
    "I migliori titoli su cui investire a luglio",
    "Top picks for the second half",
]

# Analyse graphique : ce n'est pas un conseil d'achat explicite, mais c'est une
# PRÉVISION de direction — et recopiée sous le nom de la bourse, elle se lit
# comme celle du bot. Mesuré sur la vraie recherche Bluesky « borsa milano ».
CHART_PREDICTION_TITLES = [
    "Il supporto del 38,2% di Fibonacci e il canale ribassista potrebbero "
    "preparare un rimbalzo",
    "Analisi tecnica: il Ftse Mib verso quota 42.000",
    "Technical analysis: gold eyes a breakout",
    "Il titolo potrebbe salire fino a 12 euro",
    "Le azioni potrebbero scendere sotto il supporto",
]

NEUTRAL_TITLES = [
    "Essilux, nei primi sei mesi l'utile sale a 1,92 miliardi",
    "Il gas prosegue in deciso calo (-3,8%) ad Amsterdam",
    "Tokyo chiude in ribasso dopo i dati sui salari",
    "Fed officials signal patience on policy",
    "Inflazione dell'area euro in rallentamento a luglio",
    "Wall Street apre in rialzo",
    "La Bce lascia i tassi invariati",
]


def test_advice_titles_are_detected():
    for title in ADVICE_TITLES:
        assert is_advice(title) is True, "non détecté comme conseil: %r" % title


def test_chart_prediction_titles_are_treated_as_advice():
    for title in CHART_PREDICTION_TITLES:
        assert is_advice(title) is True, "prévision de direction laissée passer: %r" % title


def test_neutral_titles_are_not_flagged():
    for title in NEUTRAL_TITLES:
        assert is_advice(title) is False, "faux positif: %r" % title


def test_the_new_patterns_do_not_swallow_ordinary_news():
    # « supporto » et « canale » existent hors du jargon graphique ; le filtre ne
    # doit pas manger une dépêche politique ou industrielle.
    for title in ["Il supporto del governo alla manovra resta incerto",
                  "Aperto il nuovo canale di Suez",
                  "L'azienda prepara il rimbalzo degli investimenti",
                  "Analisi dei conti pubblici: il deficit cala"]:
        assert is_advice(title) is False, "faux positif: %r" % title


def test_is_advice_tolerates_garbage():
    assert is_advice(None) is False
    assert is_advice("") is False
    assert is_advice(123) is False


def test_advice_detection_is_case_and_accent_insensitive():
    assert is_advice("LE AZIONI DA COMPRARE") is True
    assert is_advice("Perche conviene vendere") is True   # sans accent


# --------------------------------------------------------------------------
# Vocabulaire prescriptif PARTAGÉ avec analyst.check_synthesis — défaut de la
# mission : le garde-fou de sortie ne connaissait ni l'anglais de rating
# ("outperform"/"upgrade") ni "target price" à l'envers ni "dovrebbe salire".
# Ces mots-là vivent désormais dans `PRESCRIPTIVE_PATTERNS`, donc is_advice()
# doit aussi les détecter — c'est la même liste utilisée par les deux bouts.
# --------------------------------------------------------------------------

@pytest.mark.parametrize("phrase", [
    "Rating: outperform, upgrade da hold a buy.",
    "Gli analisti hanno alzato il target price a 250 dollari.",
    "Consigliamo di comprare Prysmian: è una buona occasione.",
    "L'indice dovrebbe salire nella seduta di oggi.",
    "We recommend buying the dip.",
    "Il titolo è un buy.",
])
def test_the_shared_vocabulary_catches_every_rejected_synthesis_phrase(phrase):
    """Les 6 formulations que le défaut laissait passer en synthèse LLM (mais
    pas comme titre de presse) doivent maintenant être détectées ICI aussi,
    puisque check_synthesis lit la MÊME liste."""
    assert is_advice(phrase) is True, phrase


@pytest.mark.parametrize("phrase", [
    "L'agenzia di rating Fitch ha confermato la valutazione A di Enel.",
    "Ieri Wall Street ha chiuso in rialzo: S&P 500 +1,48%.",
    "Oggi apre Euronext; l'indice Euronext 100 è a 1939,23 punti.",
])
def test_bare_rating_mentions_stay_factual_not_prescriptive(phrase):
    """« rating » seul est un mot parfaitement factuel en italien financier
    (une agence NOTE, ça ne conseille pas) — le raisonner en motif
    (« upgrade », « outperform », « target price »...) et pas en mot nu évite
    de le confondre avec un conseil."""
    assert is_advice(phrase) is False, phrase


def test_recommend_stem_catches_english_recommendation_verbs():
    assert is_advice("We recommend buying the dip.") is True
    assert is_advice("Analysts recommend caution ahead of earnings.") is True


def test_target_price_is_caught_in_either_word_order():
    """La presse anglophone écrit « price target », la presse italienne
    emprunte souvent l'ordre inverse « target price » — les deux doivent
    tomber."""
    assert is_advice("Cuts price target to $180.") is True
    assert is_advice("Gli analisti hanno alzato il target price a 250 dollari.") is True


def test_should_rise_or_fall_is_a_direction_prediction():
    assert is_advice("L'indice dovrebbe salire nella seduta di oggi.") is True
    assert is_advice("Il titolo dovrebbe scendere ancora.") is True


def test_forecast_words_are_caught_but_scheduled_language_is_not():
    """« previsione »/« prevediamo »/« prevedo » sont une prévision de marché.
    « previsto »/« prevista » (le PARTICIPE) est une donnée d'AGENDA
    factuelle — « la riunione della BCE prevista per oggi » ne doit jamais
    être jetée, sinon le briefing dégrade sur sa propre section agenda."""
    assert is_advice("La previsione è di un rialzo dell'indice.") is True
    assert is_advice("Prevediamo un calo del 3%.") is True
    assert is_advice("Prevedo un rimbalzo domani.") is True
    assert is_advice("La riunione della BCE prevista per oggi si terrà alle 14.") is False
    assert is_advice("L'appuntamento previsto oggi riguarda i tassi.") is False


def test_suggeriamo_is_prescriptive():
    assert is_advice("Vi suggeriamo di attendere prima di agire.") is True


def test_opportunita_di_acquisto_is_caught_like_occasione():
    assert is_advice("È un'opportunità di acquisto imperdibile.") is True


def test_occasione_di_acquisto_is_caught_with_or_without_the_space():
    """Motif historique bogué : « occasione d[i']acquisto » n'acceptait aucun
    espace entre « di » et « acquisto » et ne matchait donc jamais la forme
    la plus courante « occasione di acquisto »."""
    assert is_advice("È un'occasione di acquisto.") is True
    assert is_advice("È un'occasione d'acquisto.") is True


# --------------------------------------------------------------------------
# Thèmes
# --------------------------------------------------------------------------

def test_themes_are_declared_bilingual():
    """Chaque thème doit avoir des mots-clés italiens ET anglais, sinon un
    thème ne serait détecté que sur la moitié du corpus."""
    for theme, words in THEMES.items():
        assert words, theme
        assert all(isinstance(w, str) and w for w in words), theme


def test_extract_themes_counts_and_sorts():
    items = [
        _it("L'inflazione rallenta a luglio"),
        _it("Inflation cools in the euro area", lang="en"),
        _it("La Bce lascia i tassi invariati"),
        _it("Il petrolio scende ancora"),
    ]
    themes = extract_themes(items)
    names = [t["theme"] for t in themes]
    assert "inflazione" in names
    counts = {t["theme"]: t["count"] for t in themes}
    assert counts["inflazione"] == 2
    # tri décroissant
    assert [t["count"] for t in themes] == sorted([t["count"] for t in themes], reverse=True)


def test_extract_themes_gives_examples_without_duplicating_them():
    items = [_it("Inflazione in calo"), _it("Inflazione sotto controllo"),
             _it("Inflazione e tassi")]
    themes = extract_themes(items, max_examples=2)
    infl = [t for t in themes if t["theme"] == "inflazione"][0]
    assert infl["count"] == 3
    assert len(infl["examples"]) == 2
    assert len(set(infl["examples"])) == 2


def test_extract_themes_ignores_untitled_or_broken_items():
    themes = extract_themes([{}, None, {"title": None}, _it("Inflazione su")])
    assert [t["theme"] for t in themes] == ["inflazione"]


def test_extract_themes_on_empty_input():
    assert extract_themes([]) == []
    assert extract_themes(None) == []


def test_a_word_inside_another_word_does_not_count():
    """« oro » ne doit pas matcher « lavoro » : sans limite de mot, le thème
    des matières premières se déclencherait sur n'importe quoi."""
    themes = extract_themes([_it("Il mercato del lavoro resta solido")])
    assert "materie prime" not in [t["theme"] for t in themes]


# --------------------------------------------------------------------------
# Comptage de tonalité — un COMPTAGE DE MOTS, présenté comme tel
# --------------------------------------------------------------------------

def test_tone_counts_titles_carrying_a_tone_word():
    """On compte des TITRES, pas des occurrences : un titre bourré de
    superlatifs ne doit pas peser plus lourd que les autres."""
    items = [_it("Borsa in forte rialzo, utili in crescita"),   # 3 mots positifs
             _it("Tokyo chiude in ribasso, timori sui dazi"),   # 2 mots négatifs
             _it("La Bce pubblica il bollettino mensile")]      # neutre
    tone = tone_counts(items)
    assert tone["positive"] == 1
    assert tone["negative"] == 1
    assert tone["total"] == 3


def test_a_title_can_be_both_positive_and_negative():
    tone = tone_counts([_it("Milano in rialzo, Tokyo in ribasso")])
    assert tone["positive"] == 1 and tone["negative"] == 1 and tone["total"] == 1


def test_tone_counts_empty_input():
    assert tone_counts([])["total"] == 0
    assert tone_counts(None)["total"] == 0


# --------------------------------------------------------------------------
# Hors-sujet : courrier des lecteurs / finances personnelles
# --------------------------------------------------------------------------

def test_personal_columns_are_detected_as_offtopic():
    from pulse.sentiment import is_offtopic
    for title in [
        "My stepdad is dying from cancer. How can I help my mom find out?",
        "My husband wants to put the house in his name only",
        "I'm 63 and my wife wants to retire abroad",
        "Dear Quentin: my sister borrowed money and never paid it back",
        "Mio marito ha ereditato una casa: cosa devo fare?",
    ]:
        assert is_offtopic(title) is True, title


def test_market_headlines_are_not_offtopic():
    from pulse.sentiment import is_offtopic
    for title in [
        "Wall Street apre in rialzo",
        "Ford raises guidance after Q2 earnings beat",
        "Il gas prosegue in deciso calo ad Amsterdam",
        "My Money Market fund returns hit a record",   # « my » pas en tête de phrase
        "Global oil prices settle at a 2-week low",
    ]:
        assert is_offtopic(title) is False, title


def test_reader_letters_opening_on_a_quote_are_offtopic():
    """Mesuré en réel : ces deux titres passaient le filtre parce que mes
    ancrages étaient en début de chaîne et que la citation les décalait."""
    from pulse.sentiment import is_offtopic
    for title in [
        "'I'm in my peak earning years': I'm working beyond 70. Will that help my Social Security?",
        "'We already have wills': We're in our 60s with $1.5 million. Should we set up a trust?",
    ]:
        assert is_offtopic(title) is True, title


# --------------------------------------------------------------------------
# Hors-sujet — défaut mesuré : 0/13 titres écartés sur un échantillon réel,
# le briefing de la Bourse de Tokyo publiait une dépêche politique et un
# article de tourisme. Trois nouvelles catégories : actualité générale sans
# angle de marché (politique/diplomatie), tourisme/voyage, et questions
# personnelles de particuliers italiens (forums de finance perso).
# --------------------------------------------------------------------------

def test_general_wire_news_without_a_market_angle_is_offtopic():
    from pulse.sentiment import is_offtopic
    for title in [
        "Myanmar's Aung San Suu Kyi meets Red Cross official, government says",
        "Before the art islands, a reason to stop in Okayama",
        "Streetcar that survived atomic bomb now used for tours in Hiroshima",
    ]:
        assert is_offtopic(title) is True, title


def test_italian_personal_finance_forum_questions_are_offtopic():
    """Les questions personnelles de particuliers (forums type
    r/ItaliaPersonalFinance) charriées par un flux de presse générique : ce
    n'est pas de l'actualité de marché, et sous le nom d'une bourse ça se lit
    comme du conseil."""
    from pulse.sentiment import is_offtopic
    for title in [
        "Ho 23 anni, ho appena iniziato un PAC da 500 €/mese su VWCE. Cosa ne pensate?",
        "Gestione del patrimonio",
        "Fondo emergenza sovradimensionato? Dubbio su gestione liquidità e acquisto auto",
    ]:
        assert is_offtopic(title) is True, title


def test_geopolitics_and_macro_headlines_with_a_real_market_angle_are_kept():
    """Règle d'arbitrage en cas de doute : GARDER. Ces titres partagent du
    vocabulaire avec les catégories offtopic (guerre, tourisme) mais portent
    une vraie information de marché — un titre écarté à tort est perdu pour
    de bon, un titre de trop n'est que du bruit visible."""
    from pulse.sentiment import is_offtopic
    for title in [
        "California's diesel prices have jumped since the Iran war started, "
        "with ripple effects across the country",
        "Tourism price wars threaten to dim a rare bright spot in China's "
        "consumer spending",
        "Palantir soars 12% on blowout quarter",
        "Prysmian acquisisce l'americana Atkore, operazione da 3,3 miliardi",
        "Mef, a luglio avanzo provvisorio di 13,4 miliardi",
        "Il petrolio chiude a New York in calo del 5%",
    ]:
        assert is_offtopic(title) is False, title


def test_the_offtopic_patterns_generalize_beyond_the_measured_examples():
    """Les motifs ne doivent pas être des correspondances exactes des titres
    mesurés — une autre ville, un autre âge, un autre pays doivent aussi
    être détectés, sinon le filtre est juste une liste déguisée."""
    from pulse.sentiment import is_offtopic
    assert is_offtopic("Detained Ugandan opposition figure is unconscious") is True
    assert is_offtopic("A reason to stop in Kyoto before the temples close") is True
    assert is_offtopic("Best tours in Lisbon this summer") is True
    assert is_offtopic("Ho 45 anni, quanto dovrei investire ogni mese?") is True
    assert is_offtopic("Dubbi su gestione del mutuo, consigli?") is True


# --------------------------------------------------------------------------
# Durcissement anti-bavardage de forum (2026-08-04) — mesuré sur un run réel :
# les 3 items Reddit publiés ce matin-là étaient tous du bavardage, et
# is_offtopic() a rendu False sur les trois. Le point commun n'est pas le
# sujet (ils parlent bien de finance) mais le REGISTRE : première personne,
# demande d'avis, récit personnel, question d'assistance, langage
# familier/vulgaire — jamais un acteur qui fait une action.
# --------------------------------------------------------------------------

def test_measured_forum_chatter_titles_are_now_offtopic():
    """Les 3 titres Reddit mesurés en vrai qui passaient le filtre ce
    matin-là."""
    from pulse.sentiment import is_offtopic
    for title in [
        "Fanculo Vanguard, io mi butto su ALLW!",
        "What's a piece of investing content you'd hand a beginner today?",
        "Problemi con acquisto etf su fineco",
    ]:
        assert is_offtopic(title) is True, title


def test_the_three_already_covered_forum_questions_stay_offtopic():
    """Rappel de non-régression : ces 3 titres (mission) sont déjà couverts
    par `test_italian_personal_finance_forum_questions_are_offtopic` —
    vérifiés ici aussi pour documenter qu'ils font partie du même lot
    mesuré et qu'ils ne doivent pas être cassés par le durcissement."""
    from pulse.sentiment import is_offtopic
    for title in [
        "Ho 23 anni, ho appena iniziato un PAC da 500 €/mese su VWCE. "
        "Cosa ne pensate?",
        "Gestione del patrimonio",
        "Fondo emergenza sovradimensionato? Dubbio su gestione liquidità "
        "e acquisto auto",
    ]:
        assert is_offtopic(title) is True, title


def test_vulgar_or_personal_bet_register_generalizes_beyond_the_measured_title():
    """Le motif n'est pas le mot « Vanguard »/« ALLW » du titre mesuré — un
    autre juron, un autre titre coté, une autre tournure doivent aussi être
    détectés (italien ET anglais, les subreddits sources sont bilingues)."""
    from pulse.sentiment import is_offtopic
    for title in [
        "Cazzo, ho perso 5000 euro su GME",
        "Vaffanculo Tesla, mi butto su Nvidia domani",
        "Fuck it, going all in on GME calls",
        "Sono entrato su Amazon con tutto lo stipendio",
    ]:
        assert is_offtopic(title) is True, title


def test_broker_support_question_register_generalizes_beyond_fineco():
    """Le motif n'est pas « fineco »/« etf » du titre mesuré — une autre
    opération, un autre courtier doivent aussi être détectés."""
    from pulse.sentiment import is_offtopic
    for title in [
        "Problema nel prelievo dal conto Revolut",
        "Problemi con la vendita di azioni su Directa",
        "Problemi con il bonifico verso Trade Republic, aiuto",
    ]:
        assert is_offtopic(title) is True, title


def test_a_real_service_outage_reported_as_news_is_not_caught_by_the_support_pattern():
    """Contre-exemple volontaire : une panne de service RELATÉE par la
    presse (acteur + action, l'acteur ouvre le titre) n'est pas une question
    d'assistance personnelle — elle doit rester une info de marché."""
    from pulse.sentiment import is_offtopic
    assert is_offtopic(
        "Una banca, problemi con l'app mandano in tilt migliaia di utenti"
    ) is False
    assert is_offtopic(
        "Deutsche Bank, problemi con l'acquisto di una quota di controllo, "
        "il titolo cala in Borsa"
    ) is False


def test_crowdsourced_advice_question_register_generalizes():
    """Le motif n'est pas « beginner »/« today » du titre mesuré — une autre
    formulation de la même sollicitation communautaire doit aussi être
    détectée."""
    from pulse.sentiment import is_offtopic
    for title in [
        "What's a lesson you'd share with a new investor?",
        "What would you recommend to someone starting out today?",
        "Anyone else holding VWCE for the long run?",
        "Does anyone have experience with Trade Republic fees?",
        "Qualcuno ha esperienza con Fineco per comprare ETF?",
    ]:
        assert is_offtopic(title) is True, title


def test_more_real_press_headlines_with_forum_adjacent_words_are_kept():
    """4 dépêches réelles supplémentaires (mission) qui n'étaient pas encore
    couvertes par les tests existants — aucune ne doit être écartée par le
    durcissement anti-bavardage."""
    from pulse.sentiment import is_offtopic
    for title in [
        "Gme, il prezzo dell'elettricità sale a 177,16 euro al Mwh",
        "Istat, a giugno vendite al dettaglio -0,1% su mese; in crescita "
        "su anno",
        "Borsa: Punta al rialzo Milano, in aumento dell'1,14% alle 10:30",
        "HSBC pretax profit beats estimates",
    ]:
        assert is_offtopic(title) is False, title
