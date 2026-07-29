"""Thèmes et filtre de conseil — fonctions pures, aucun réseau."""
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


def test_neutral_titles_are_not_flagged():
    for title in NEUTRAL_TITLES:
        assert is_advice(title) is False, "faux positif: %r" % title


def test_is_advice_tolerates_garbage():
    assert is_advice(None) is False
    assert is_advice("") is False
    assert is_advice(123) is False


def test_advice_detection_is_case_and_accent_insensitive():
    assert is_advice("LE AZIONI DA COMPRARE") is True
    assert is_advice("Perche conviene vendere") is True   # sans accent


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
