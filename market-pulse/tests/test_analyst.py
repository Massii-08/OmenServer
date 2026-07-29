"""L'étape LLM — la seule du bot. Hors ligne : `claude` est injecté.

Trois garde-fous, tous testés ici :
1. sans LLM, le briefing sort quand même (dégradation gracieuse) ;
2. une synthèse contenant un mot prescriptif est JETÉE, pas publiée ;
3. une synthèse contenant un CHIFFRE absent du briefing est JETÉE — c'est le
   garde-fou contre l'invention, le plus dangereux des défauts pour ce lecteur.
"""
import pytest

from pulse.analyst import DEFAULT_MODEL, analyse, check_synthesis

BRIEFING = {
    "exchange": "euronext", "label": "Euronext",
    "index": {"label": "Euronext 100", "price": 1904.55, "change_pct": 0.35},
    "comparison": [{"label": "Nikkei 225", "change_pct": -3.95, "state": "chiuso"}],
    "agenda": [{"when": "2026-07-30T12:15:00Z", "what": "BCE — decisione sui tassi"}],
    "news": {"items": [{"title": "Chipotle hikes same-store sales forecast",
                        "source": "CNBC",
                        "event": {"is_event": True, "actor": "azienda",
                                  "actions": ["previsioni"]}}],
             "themes": [{"theme": "utili societari", "count": 2}]},
    "followed": [], "discovered": [], "errors": [], "generated_at": 1785310800,
}

BONNE = ("Stamattina Euronext apre dopo una seduta asiatica in ribasso: "
         "il Nikkei ha chiuso a -3,95%. L'indice Euronext 100 segna +0,35%. "
         "Domani la BCE decide sui tassi.")


# --------------------------------------------------------------------------
# Le contrôle de sortie
# --------------------------------------------------------------------------

def test_a_clean_synthesis_passes():
    ok, reason = check_synthesis(BONNE, BRIEFING)
    assert ok is True and reason is None


@pytest.mark.parametrize("phrase", [
    "Conviene comprare Chipotle prima dei risultati.",
    "Consigliamo di vendere il titolo.",
    "Il target price è di 60 euro.",
    "La previsione è di un rialzo dell'indice.",
    "È un'occasione di acquisto.",
])
def test_a_prescriptive_synthesis_is_rejected(phrase):
    ok, reason = check_synthesis(BONNE + " " + phrase, BRIEFING)
    assert ok is False
    assert "vocabolario" in reason or "prescr" in reason


def test_an_invented_number_is_rejected():
    """Le pire défaut possible : un chiffre plausible mais absent des données.
    Un lecteur âgé n'a aucun moyen de le vérifier."""
    ok, reason = check_synthesis(BONNE + " Il petrolio è salito del 7,42%.", BRIEFING)
    assert ok is False
    assert "cifra" in reason


def test_numbers_present_in_the_briefing_are_accepted():
    ok, _ = check_synthesis("Euronext 100 a 1904,55, variazione +0,35%.", BRIEFING)
    assert ok is True


def test_number_formats_are_matched_across_notations():
    """Le LLM écrit à l'italienne (1.904,55) ce que les données portent en
    anglo-saxon (1904.55) : les deux doivent se reconnaître."""
    ok, _ = check_synthesis("L'indice vale 1.904,55 punti.", BRIEFING)
    assert ok is True


def test_small_integers_and_dates_are_not_treated_as_data():
    """« i tre membri », « il 30 luglio », « 2026 » ne sont pas des chiffres de
    marché : les exiger dans les données rejetterait toute phrase normale."""
    ok, _ = check_synthesis("Il 30 luglio 2026 la BCE si riunisce, tra 2 giorni.",
                            BRIEFING)
    assert ok is True


def test_an_empty_synthesis_is_rejected():
    assert check_synthesis("", BRIEFING)[0] is False
    assert check_synthesis(None, BRIEFING)[0] is False
    assert check_synthesis("   ", BRIEFING)[0] is False


# --------------------------------------------------------------------------
# analyse() — dégradation gracieuse
# --------------------------------------------------------------------------

def test_analyse_returns_the_text_when_the_llm_behaves():
    out = analyse(BRIEFING, claude=lambda prompt, **kw: {"synthesis": BONNE})
    assert out["degraded"] is False
    assert out["text"] == BONNE
    assert out["model"] == DEFAULT_MODEL
    assert out["reason"] is None


def test_analyse_degrades_when_the_llm_is_absent():
    def boom(prompt, **kw):
        raise RuntimeError("claude cli introuvable")
    out = analyse(BRIEFING, claude=boom)
    assert out["degraded"] is True
    assert out["text"] is None
    assert "claude cli introuvable" in out["reason"]


def test_analyse_degrades_on_a_prescriptive_answer():
    out = analyse(BRIEFING, claude=lambda p, **kw: {"synthesis": "Conviene comprare."})
    assert out["degraded"] is True and out["text"] is None


def test_analyse_degrades_on_an_invented_number():
    out = analyse(BRIEFING,
                  claude=lambda p, **kw: {"synthesis": "Il Dax è salito del 9,99%."})
    assert out["degraded"] is True and out["text"] is None


def test_analyse_degrades_on_a_malformed_answer():
    for bad in ({}, {"autre": "chose"}, None, "pas un dict"):
        out = analyse(BRIEFING, claude=lambda p, **kw: bad)
        assert out["degraded"] is True, bad


def test_analyse_never_raises():
    """Le briefing doit sortir quoi qu'il arrive : la synthèse embellit, elle ne
    conditionne rien."""
    for bad in (lambda p, **kw: 1 / 0, lambda p, **kw: {"synthesis": None}):
        out = analyse(BRIEFING, claude=bad)
        assert out["degraded"] is True and out["text"] is None


def test_analyse_without_a_briefing():
    out = analyse(None, claude=lambda p, **kw: {"synthesis": BONNE})
    assert out["degraded"] is True


# --------------------------------------------------------------------------
# Le prompt
# --------------------------------------------------------------------------

def test_the_prompt_carries_the_facts_and_the_interdiction():
    seen = {}

    def spy(prompt, **kw):
        seen["prompt"] = prompt
        return {"synthesis": BONNE}

    analyse(BRIEFING, claude=spy)
    prompt = seen["prompt"]
    assert "Euronext" in prompt
    assert "Nikkei" in prompt
    assert "BCE" in prompt
    # l'interdiction doit être DANS le prompt, pas seulement dans le contrôle
    low = prompt.lower()
    assert "nessun consiglio" in low or "mai consigli" in low
    assert "non aggiungere" in low or "solo i fatti" in low


def test_the_model_is_overridable():
    out = analyse(BRIEFING, claude=lambda p, **kw: {"synthesis": BONNE},
                  model="claude-opus-5")
    assert out["model"] == "claude-opus-5"


def test_the_prompt_is_compacted_not_the_whole_briefing():
    """Envoyer le briefing entier faisait TRONQUER la réponse du LLM : le JSON
    revenait sans accolade fermante et la synthèse était perdue. Vu au premier
    passage complet."""
    from pulse.analyst import compact
    gros = dict(BRIEFING)
    gros["news"] = {"items": [{"title": "Titolo %d" % i, "url": "https://x/%d" % i,
                               "source": "S", "published": 1,
                               "event": {"is_event": True, "actor": "azienda",
                                         "actions": ["risultati"]}}
                              for i in range(40)]}
    small = compact(gros)
    assert len(small["titoli_notizie"]) == 8
    import json as _j
    assert len(_j.dumps(small)) < len(_j.dumps(gros)) / 2
    # les URL et les compteurs internes ne partent pas au LLM
    assert "https://" not in _j.dumps(small)


def test_the_compacted_prompt_still_carries_every_fact_needed():
    from pulse.analyst import compact
    small = compact(BRIEFING)
    assert small["borsa"] == "Euronext"
    assert small["indice"]["change_pct"] == 0.35
    assert small["altre_piazze"][0]["nome"] == "Nikkei 225"
    assert small["agenda"][0]["cosa"].startswith("BCE")
