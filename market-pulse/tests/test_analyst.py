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


# --------------------------------------------------------------------------
# Où est le CLI — le chemin n'est pas le même sur les deux machines
# --------------------------------------------------------------------------

def test_claude_bin_honours_the_environment_variable(monkeypatch):
    monkeypatch.setenv("CLAUDE_BIN", "/opt/mon/claude")
    from pulse.analyst import claude_bin
    assert claude_bin() == "/opt/mon/claude"


def test_claude_bin_falls_back_to_the_PATH_when_the_omen_path_is_absent(monkeypatch):
    """Codé en dur sur `~/.local/bin/claude`, la synthèse tombait en mode
    dégradé SILENCIEUX sur le Mac de dev (le CLI y vit dans le nvm)."""
    monkeypatch.delenv("CLAUDE_BIN", raising=False)
    import pulse.analyst as mod
    monkeypatch.setattr(mod.os.path, "exists", lambda p: False)
    monkeypatch.setattr("shutil.which", lambda name: "/ailleurs/bin/claude")
    assert mod.claude_bin() == "/ailleurs/bin/claude"


def test_claude_bin_still_names_a_path_when_nothing_is_found(monkeypatch):
    # L'erreur doit dire QUEL chemin a été tenté, pas rendre None.
    monkeypatch.delenv("CLAUDE_BIN", raising=False)
    import pulse.analyst as mod
    monkeypatch.setattr(mod.os.path, "exists", lambda p: False)
    monkeypatch.setattr("shutil.which", lambda name: None)
    assert mod.claude_bin().endswith("claude")


def test_an_index_is_sent_without_a_currency():
    """Un indice est un NIVEAU, pas un montant.

    Yahoo étiquette ^N100 en EUR ; au premier passage réel le LLM a écrit
    « l'indice Euronext 100 a 1907,2 euro ». On ne lui donne plus l'occasion.
    """
    from pulse.analyst import compact
    got = compact({"label": "Euronext", "index": {"label": "Euronext 100",
                                                  "price": 1907.2, "change_pct": 0.39,
                                                  "currency": "EUR"}})
    assert "currency" not in got["indice"]
    assert got["indice"]["price"] == 1907.2


# --------------------------------------------------------------------------
# La traduction voyage dans le MÊME appel que la synthèse
# --------------------------------------------------------------------------
#
# Décision de Massii : la traduction ne doit coûter aucune requête de plus.
# Le même appel rend la synthèse ET les titres traduits.

def _brief_with_foreign_news():
    return {
        "label": "JPX",
        "session": {"opens_at": "09:00"},
        "index": {"label": "Nikkei 225", "price": 61867.43, "change_pct": 0.71},
        "comparison": [], "agenda": [],
        "news": {"items": [
            {"title": "Piazza Affari apre in rialzo", "lang": "it",
             "source": "Il Sole", "url": "https://x.test/1"},
            {"title": "日経平均は上昇", "lang": "ja",
             "source": "NHK", "url": "https://x.test/2"},
        ]},
    }


def test_the_prompt_carries_the_foreign_titles_when_a_language_is_asked():
    from pulse.analyst import build_prompt
    prompt = build_prompt(_brief_with_foreign_news(), lang="it")
    assert "日経平均は上昇" in prompt
    assert "traduzioni" in prompt.lower()


def test_the_prompt_stays_UNCHANGED_when_nothing_needs_translating():
    from pulse.analyst import build_prompt
    brief = _brief_with_foreign_news()
    brief["news"]["items"] = [{"title": "Piazza Affari apre", "lang": "it"}]
    assert "traduzioni" not in build_prompt(brief, lang="it").lower()


def test_analyse_returns_the_translated_titles():
    from pulse.analyst import analyse

    def fake_claude(prompt, model=None, **kw):
        return {"synthesis": "Il Nikkei ha chiuso in rialzo dello 0,71%.",
                "traduzioni": {"1": "Il Nikkei 225 sale"}}

    got = analyse(_brief_with_foreign_news(), claude=fake_claude, lang="it")
    assert got["degraded"] is False
    assert got["titles"] == {1: "Il Nikkei 225 sale"}


def test_a_rejected_synthesis_does_not_throw_away_the_translations():
    """Les deux sorties dégradent INDÉPENDAMMENT.

    Une synthèse qui dérape ne doit pas coûter des titres parfaitement traduits
    — et l'inverse non plus.
    """
    from pulse.analyst import analyse

    def prescriptive(prompt, model=None, **kw):
        return {"synthesis": "Conviene comprare adesso.",
                "traduzioni": {"1": "Il Nikkei 225 sale"}}

    got = analyse(_brief_with_foreign_news(), claude=prescriptive, lang="it")
    assert got["text"] is None and got["degraded"] is True
    assert got["titles"] == {1: "Il Nikkei 225 sale"}


def test_no_llm_at_all_yields_no_translation_and_no_crash():
    from pulse.analyst import analyse

    def broken(prompt, model=None, **kw):
        raise RuntimeError("claude introuvable")

    got = analyse(_brief_with_foreign_news(), claude=broken, lang="it")
    assert got["text"] is None
    assert got["titles"] == {}
    assert got["degraded"] is True


def test_the_synthesis_still_works_exactly_as_before_without_a_language():
    # Rétro-compatibilité : les appels existants ne passent pas `lang`.
    from pulse.analyst import analyse

    def fake(prompt, model=None, **kw):
        return {"synthesis": "Il Nikkei ha chiuso in rialzo dello 0,71%."}

    got = analyse(_brief_with_foreign_news(), claude=fake)
    assert got["degraded"] is False
    assert got["titles"] == {}


# --------------------------------------------------------------------------
# L'économie de jetons se COMPTE, elle ne se raconte pas
# --------------------------------------------------------------------------

def test_the_llm_is_called_once_per_analysed_exchange_and_not_once_more():
    """Le plan de run décide qui coûte des jetons.

    Ce test compte les appels : c'est la seule preuve que « on collecte partout,
    on n'analyse que le coché » économise vraiment quelque chose. Un test qui
    vérifierait seulement le contenu du briefing passerait même si le LLM était
    appelé dix fois.
    """
    from pulse.analyst import analyse
    from pulse.exchanges import run_plan

    calls = []

    def counting(prompt, model=None, **kw):
        calls.append(prompt)
        return {"synthesis": "Le piazze asiatiche hanno chiuso contrastate."}

    brief = {"label": "x", "session": {"opens_at": "09:00"}, "index": None,
             "comparison": [], "agenda": [], "news": {"items": []}}
    for _venue, do_analyse in run_plan(["nyse", "jpx"]):
        if do_analyse:
            analyse(brief, claude=counting)
    assert len(calls) == 2, "un appel par place cochée, pas un de plus"


def test_no_selection_means_ZERO_llm_call():
    from pulse.analyst import analyse
    from pulse.exchanges import run_plan

    calls = []

    def counting(prompt, model=None, **kw):
        calls.append(prompt)
        return {"synthesis": "..."}

    brief = {"label": "x", "session": {}, "index": None, "comparison": [],
             "agenda": [], "news": {"items": []}}
    plan = run_plan([])
    assert len(plan) == 10, "les dix places sont quand même collectées"
    for _venue, do_analyse in plan:
        if do_analyse:
            analyse(brief, claude=counting)
    assert calls == [], "aucune bourse cochée : aucun jeton dépensé"
