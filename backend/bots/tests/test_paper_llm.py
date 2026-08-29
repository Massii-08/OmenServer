"""Tests du coach rédacteur — aucun binaire, aucun réseau (``run`` injecté).

Deux choses sont vérifiées et comptent autant l'une que l'autre :
  * la plomberie (enveloppe JSON, codes de retour, délai, dossier neutre) ;
  * le CONTENU des prompts — les interdits du coach (pas de recommandation en
    argent réel, pas de chiffre inventé) sont le produit, pas de la décoration.
"""
import json
import os
import subprocess

import pytest

from backend.bots.paper import llm


class FakeProc(object):
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def envelope(result, is_error=False):
    return json.dumps({"is_error": is_error, "result": result})


def runner(proc, captured=None):
    """Faux ``subprocess.run`` qui note ses arguments."""
    def fake_run(cmd, input=None, capture_output=None, text=None, timeout=None,
                 cwd=None):
        if captured is not None:
            captured.update({"cmd": cmd, "input": input, "timeout": timeout,
                             "cwd": cwd})
        return proc
    return fake_run


# ================================================================
#  plomberie
# ================================================================

def test_claude_text_returns_raw_text():
    captured = {}
    out = llm._claude_text("dis bonjour",
                           run=runner(FakeProc(0, envelope("Salut Massii.")), captured))
    assert out == "Salut Massii."
    assert captured["input"] == "dis bonjour"
    assert captured["cmd"][1:4] == ["-p", "--output-format", "json"]
    assert "--model" in captured["cmd"]


def test_claude_text_runs_from_a_neutral_directory():
    """Lancé depuis le dépôt, le CLI hérite du CLAUDE.md du projet et répond à
    côté (piège vécu sur Market Pulse)."""
    captured = {}
    llm._claude_text("p", run=runner(FakeProc(0, envelope("ok")), captured))
    assert captured["cwd"] != os.getcwd()
    assert "paper-coach-llm-" in captured["cwd"]


def test_claude_text_passes_the_timeout():
    captured = {}
    llm._claude_text("p", timeout=42, run=runner(FakeProc(0, envelope("ok")), captured))
    assert captured["timeout"] == 42


def test_claude_text_raises_on_error_envelope():
    with pytest.raises(RuntimeError):
        llm._claude_text("p", run=runner(FakeProc(0, envelope("refus", is_error=True))))


def test_claude_text_raises_on_nonzero_return_code():
    with pytest.raises(RuntimeError):
        llm._claude_text("p", run=runner(FakeProc(2, "", "boom")))


def test_claude_text_raises_on_unreadable_output():
    with pytest.raises(RuntimeError):
        llm._claude_text("p", run=runner(FakeProc(0, "pas du json")))


def test_claude_text_raises_on_empty_answer():
    """Une réponse vide n'est pas une réponse : mieux vaut un 502 qu'un encadré
    blanc dans l'interface."""
    with pytest.raises(RuntimeError):
        llm._claude_text("p", run=runner(FakeProc(0, envelope("   "))))


def test_timeout_becomes_a_runtime_error():
    def fake_run(*a, **kw):
        raise subprocess.TimeoutExpired(cmd="claude", timeout=120)

    with pytest.raises(RuntimeError):
        llm._claude_text("p", run=fake_run)


def test_missing_binary_becomes_a_runtime_error():
    def fake_run(*a, **kw):
        raise FileNotFoundError("claude")

    with pytest.raises(RuntimeError):
        llm._claude_text("p", run=fake_run)


def test_claude_bin_prefers_the_environment(monkeypatch):
    monkeypatch.setenv("CLAUDE_BIN", "/tmp/faux-claude")
    assert llm.claude_bin() == "/tmp/faux-claude"


# ================================================================
#  prompts — les interdits sont dans les TROIS
# ================================================================

FORBIDDEN = ["argent réel", "n'inventes AUCUN chiffre", "français"]


@pytest.mark.parametrize("prompt", [
    llm.build_coach_prompt({"stats": {}}, "ça va ?"),
    llm.build_postmortem_prompt({"symbol": "X"}, {}),
    llm.build_analysis_prompt({"symbol": "X"}),
])
def test_every_prompt_carries_the_hard_rules(prompt):
    for needle in FORBIDDEN:
        assert needle in prompt


def test_coach_prompt_carries_the_context_and_the_question():
    context = {"stats": {"expectancy_r": 0.42}, "biases": [{"code": "no_stop"}],
               "last_trades": [{"symbol": "NESN.SW"}]}
    prompt = llm.build_coach_prompt(context, "pourquoi je perds ?")
    assert "0.42" in prompt
    assert "no_stop" in prompt
    assert "NESN.SW" in prompt
    assert "pourquoi je perds ?" in prompt


def test_coach_prompt_has_a_default_question():
    prompt = llm.build_coach_prompt({}, "")
    assert "Fais le point" in prompt


def test_postmortem_prompt_imposes_the_four_parts_and_the_thesis_rule():
    trade = {"symbol": "ABBN.SW", "r_multiple": -1.0, "thesis": "",
             "exit_reason": "stop"}
    prompt = llm.build_postmortem_prompt(trade, {"stats": {"n_trades": 3}})
    assert "ABBN.SW" in prompt
    assert "ce qui était bien" in prompt
    assert "ce qui a cloché" in prompt
    assert "biais probable" in prompt
    assert "leçon actionnable" in prompt
    # une thèse absente est LE sujet du post-mortem
    assert "thèse est vide" in prompt


def test_analysis_prompt_forbids_any_buy_or_sell_opinion():
    facts = {"symbol": "ROG.SW", "sma50": 250.5, "trend": "haussier"}
    prompt = llm.build_analysis_prompt(facts)
    assert "ROG.SW" in prompt
    assert "250.5" in prompt
    assert "haussier" in prompt
    assert "aucun avis d'achat ou de vente" in prompt
    assert "aucune prévision" in prompt


# ================================================================
#  API publique
# ================================================================

def test_ask_coach_sends_the_prompt_and_returns_the_text():
    captured = {}
    out = llm.ask_coach({"stats": {"n_trades": 7}}, "et alors ?",
                        run=runner(FakeProc(0, envelope("Ta taille est le sujet.")),
                                   captured))
    assert out == "Ta taille est le sujet."
    assert "et alors ?" in captured["input"]
    assert llm.SYSTEM_PROMPT in captured["input"]


def test_write_postmortem_returns_the_text():
    out = llm.write_postmortem({"symbol": "X"}, {},
                               run=runner(FakeProc(0, envelope("  Analyse.  "))))
    assert out == "Analyse."


def test_write_weekly_report_returns_the_text():
    out = llm.write_weekly_report({"stats": {"n_trades": 3}},
                                  run=runner(FakeProc(0, envelope("  Bilan.  "))))
    assert out == "Bilan."


def test_build_weekly_prompt_carries_the_week_context_and_the_doctrine():
    prompt = llm.build_weekly_prompt(
        {"closed_this_week": [{"symbol": "NESN.SW"}], "discipline": {"score": 62}})
    assert llm.SYSTEM_PROMPT in prompt
    assert "NESN.SW" in prompt
    assert "62" in prompt
    assert "hebdomadaire" in prompt.lower()


def test_build_weekly_prompt_handles_a_week_without_any_closed_trade():
    prompt = llm.build_weekly_prompt({"closed_this_week": []})
    assert "aucun trade" in prompt.lower()


def test_write_analysis_returns_the_text():
    out = llm.write_analysis({"symbol": "X"},
                             run=runner(FakeProc(0, envelope("Fiche."))))
    assert out == "Fiche."


# --------------------------------------------------------------------------- #
# Langue de sortie — UNE table, tous les prompts du coach
#
# Le prompt reste français (c'est l'instruction au modèle) ; seule la consigne
# de langue de RÉPONSE change. Ces tests interdisent qu'un des endpoints
# reparte en français pendant que les autres suivent l'interface.
# --------------------------------------------------------------------------- #

def _all_prompts(lang):
    return {
        "coach": llm.build_coach_prompt({"stats": {}}, "ça va ?", lang),
        "postmortem": llm.build_postmortem_prompt({"symbol": "X"}, {}, lang),
        "analysis": llm.build_analysis_prompt({"symbol": "X"}, lang),
        "ideas": llm.build_ideas_prompt({}, lang),
        "scenarios": llm.build_scenarios_prompt({}, lang),
        "weekly": llm.build_weekly_prompt({}, lang),
    }


@pytest.mark.parametrize("lang,needle", [("it", "italiano"), ("en", "English"),
                                         ("fr", "français")])
def test_every_prompt_carries_the_output_language(lang, needle):
    for name, prompt in _all_prompts(lang).items():
        assert "réponds exclusivement en %s" % needle in prompt, name


@pytest.mark.parametrize("lang", ["", None, "de", "zz"])
def test_an_unknown_language_falls_back_to_french(lang):
    for name, prompt in _all_prompts(lang).items():
        assert "réponds exclusivement en français" in prompt, name


def test_the_italian_prompt_keeps_its_instructions_in_french():
    """Traduire les CONSIGNES serait une régression : le modèle lit le français,
    c'est la réponse qui doit être italienne."""
    prompt = llm.build_postmortem_prompt({"symbol": "X"}, {}, "it")
    assert "Structure ta réponse en quatre parties" in prompt
    assert "n'inventes AUCUN chiffre" in prompt


def test_the_analysis_prompt_no_longer_hardcodes_a_reading_language():
    """« en français simple » contredisait la consigne italienne : le seul
    endroit qui décide de la langue de sortie est la ligne de consigne."""
    assert "en français simple" not in llm.build_analysis_prompt({}, "it")
    assert "en mots simples" in llm.build_analysis_prompt({}, "it")


# --------------------------------------------------------------------------- #
# Niveaux de risque — l'univers et la fourchette changent, la doctrine JAMAIS
#
# Ces blocs SONT le produit (« une option où le coach prend des risques élevés —
# genre short crypto, ou du semi-long sur du forex ») : ce qui est vérifié ici
# n'est pas de la décoration, c'est ce que Massii recevra.
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("given,expected", [
    ("mesure", "mesure"), ("mesuré", "mesure"), ("MESURE", "mesure"),
    (" agressif ", "agressif"), ("aggressive", "agressif"),
    ("speculatif", "speculatif"), ("spéculatif", "speculatif"),
    ("speculative", "speculatif"),
])
def test_risk_level_normalisation(given, expected):
    assert llm.normalize_risk_level(given) == expected


@pytest.mark.parametrize("given", ["", None, "extrême", "yolo", "haut", 42])
def test_an_unknown_risk_level_falls_back_to_the_lowest(given):
    """Le repli va vers le BAS : une valeur illisible ne doit jamais promouvoir
    une série d'idées à un étage qu'on ne lui a pas demandé."""
    assert llm.normalize_risk_level(given) == llm.DEFAULT_RISK_LEVEL == "mesure"


def test_the_measured_level_stays_on_stocks_and_etfs():
    prompt = llm.build_ideas_prompt({}, risk_level="mesure")
    assert "MESURÉ" in prompt
    assert "0,5 à 1 %" in prompt
    # l'univers interdit n'est même pas NOMMÉ : le schéma JSON de ce niveau
    # n'énumère que equity/etf, donc le mot ne peut pas donner d'idées.
    assert "crypto" not in prompt
    assert "forex" not in prompt
    assert "EURUSD=X" not in prompt
    assert '"asset_kind"' in prompt
    assert '"risk_level": "mesure"' in prompt


def test_the_aggressive_level_opens_shorts_and_concentration():
    prompt = llm.build_ideas_prompt({}, risk_level="agressif")
    assert "AGRESSIF" in prompt
    assert "VENTES À DÉCOUVERT" in prompt
    assert "short squeeze" in prompt
    assert "CONCENTRATION" in prompt
    assert "1 à 2 %" in prompt
    assert "invalidation SERRÉ" in prompt
    # un étage plus haut ne veut pas dire un univers plus large ici
    assert "crypto" not in prompt
    assert '"risk_level": "agressif"' in prompt


def test_the_speculative_level_opens_crypto_shorts_and_semi_long_forex():
    prompt = llm.build_ideas_prompt({}, risk_level="speculatif")
    assert "SPÉCULATIF" in prompt
    assert "crypto" in prompt.lower()
    assert "short" in prompt.lower()          # short crypto explicitement permis
    assert "forex" in prompt.lower()
    assert "BTC-USD" in prompt and "EURUSD=X" in prompt
    # le semi-long demandé : semaines à 2-3 mois, pas trois séances
    assert "SEMAINES" in prompt
    assert "MOIS" in prompt
    assert "2 à 3 %" in prompt
    assert '"asset_kind"' in prompt and '"crypto"' in prompt


def test_the_speculative_level_teaches_wide_stop_small_size():
    """La leçon centrale de l'étage : la volatilité n'augmente pas le risque
    autorisé, elle RÉTRÉCIT la position."""
    prompt = llm.build_ideas_prompt({}, risk_level="speculatif")
    assert "stop large, donc position petite" in prompt
    assert "TAILLE de la position qui rétrécit" in prompt


def test_the_speculative_level_caps_the_crypto_share():
    prompt = llm.build_ideas_prompt({}, risk_level="speculatif")
    assert "JAMAIS plus de 2 idées crypto sur 4" in prompt


@pytest.mark.parametrize("level,label", [("mesure", "mesuré"),
                                         ("agressif", "agressif"),
                                         ("speculatif", "spéculatif")])
def test_every_level_keeps_the_hard_rules_and_announces_itself(level, label):
    """Un étage plus haut n'achète AUCUN passe-droit : mêmes interdits, même
    stop, même invalidation — seul le curseur de risque bouge."""
    prompt = llm.build_ideas_prompt({}, risk_level=level)
    assert "argent réel" in prompt
    assert "n'inventes AUCUN chiffre" in prompt
    assert "« sûr »" in prompt
    assert "sizing" in prompt
    # l'en-tête de la réponse annonce le niveau (en toutes lettres) et sa
    # fourchette ; le CODE, lui, part dans le JSON
    assert "Niveau %s" % label in prompt
    assert '"risk_level": "%s"' % level in prompt


def test_an_unknown_level_produces_the_measured_prompt():
    assert llm.build_ideas_prompt({}, risk_level="yolo") == \
        llm.build_ideas_prompt({}, risk_level="mesure")


def test_the_ideas_json_schema_asks_for_the_structured_advice_fields():
    """Le conseil complet (stop, risque conseillé, invalidation, catalyseur)
    doit atterrir dans le JSON STRUCTURÉ, pas seulement dans le texte libre —
    sinon la pop-up « le coach sur <symbole> » ne peut jamais l'afficher
    proprement (elle devrait ré-extraire un paragraphe à chaque fois)."""
    prompt = llm.build_ideas_prompt({}, risk_level="mesure")
    for field in ('"stop"', '"risk_pct"', '"invalidated_if"', '"why_now"'):
        assert field in prompt


def test_the_default_ideas_prompt_is_the_measured_one():
    """Rétro-compatibilité : l'appel d'avant la fonctionnalité rend exactement
    le prompt de l'étage mesuré."""
    assert llm.build_ideas_prompt({}) == llm.build_ideas_prompt({}, "fr", "mesure")


def test_the_level_and_the_language_are_independent():
    prompt = llm.build_ideas_prompt({}, lang="it", risk_level="speculatif")
    assert "réponds exclusivement en italiano" in prompt
    assert "SPÉCULATIF" in prompt              # la consigne, elle, reste française


def test_suggest_ideas_forwards_the_risk_level(monkeypatch):
    seen = {}

    def fake_claude(prompt, model=llm.DEFAULT_MODEL, timeout=llm.DEFAULT_TIMEOUT,
                    run=None):
        seen["prompt"] = prompt
        return "idées"

    monkeypatch.setattr(llm, "_claude_text", fake_claude)
    assert llm.suggest_ideas({}, "fr", "speculatif") == "idées"
    assert "SPÉCULATIF" in seen["prompt"]

    llm.suggest_ideas({}, "fr", "n'importe quoi")
    assert "MESURÉ" in seen["prompt"]


def test_public_helpers_forward_the_language(monkeypatch):
    seen = {}

    def fake_claude(prompt, model=llm.DEFAULT_MODEL, timeout=llm.DEFAULT_TIMEOUT,
                    run=None):
        seen.setdefault("prompts", []).append(prompt)
        return "risposta"

    monkeypatch.setattr(llm, "_claude_text", fake_claude)
    assert llm.ask_coach({}, "?", lang="it") == "risposta"
    llm.write_postmortem({}, {}, lang="it")
    llm.write_analysis({}, lang="it")
    llm.suggest_ideas({}, lang="it")
    llm.suggest_scenarios({}, lang="it")
    assert len(seen["prompts"]) == 5
    for prompt in seen["prompts"]:
        assert "réponds exclusivement en italiano" in prompt


# --------------------------------------------------------------------------- #
# Arbres de scénarios — le coach cartographie les chemins du marché
# --------------------------------------------------------------------------- #

def test_the_scenarios_prompt_demands_divergent_paths():
    """Trois formulations du même scénario ne préparent à rien : c'est la
    DIVERGENCE qui fait la valeur de l'arbre."""
    prompt = llm.build_scenarios_prompt({"stats": {}})
    assert "DIVERGENT" in prompt
    assert "s'excluent" in prompt
    assert "2 à 4 BRANCHES" in prompt


def test_the_scenarios_prompt_demands_coherent_probabilities():
    """Trois « haute » sur trois chemins qui s'excluent, c'est une
    contradiction, pas une prévision."""
    prompt = llm.build_scenarios_prompt({})
    assert "COHÉRENTES entre elles" in prompt
    assert "ne peuvent pas être tous « haute »" in prompt


def test_the_scenarios_prompt_keeps_the_hard_rules():
    prompt = llm.build_scenarios_prompt({})
    assert "sûr" in prompt                        # interdit de vendre du « sûr »
    assert "argent réel" in prompt
    assert "n'invente RIEN" in prompt
    assert "deux niveaux au MAXIMUM" in prompt


def test_the_scenarios_prompt_leaves_ids_and_status_to_the_server():
    """Laisser le modèle déclarer qu'une branche s'est réalisée, ce serait lui
    laisser écrire le verdict de son propre pari."""
    assert "posés par le serveur" in llm.build_scenarios_prompt({})


def _tree_answer(payload, intro="Voici comment je vois les choses.\n"):
    return "%s\n```json\n%s\n```" % (intro, json.dumps(payload))


def _valid_payload():
    return {
        "title": "La Fed baisse-t-elle en septembre ?",
        "context": "Deux phrases.",
        "branches": [
            {"label": "la Fed coupe", "prob": "haute", "consequence": "small caps",
             "plays": [{"ticker": "iwm", "direction": "up"}]},
            {"label": "statu quo", "prob": "moyenne", "consequence": "rien ne bouge",
             "plays": [{"ticker": "spy", "direction": "down"}]},
        ],
    }


def test_parse_scenarios_reads_a_dirty_answer():
    tree = llm.parse_scenarios(_tree_answer(_valid_payload()))
    assert tree["title"].startswith("La Fed")
    assert [b["label"] for b in tree["branches"]] == ["la Fed coupe", "statu quo"]
    assert tree["branches"][0]["plays"] == [{"ticker": "IWM", "direction": "up"}]
    # ni id ni status : c'est le serveur qui les pose
    assert "id" not in tree["branches"][0]
    assert "status" not in tree["branches"][0]


def test_parse_scenarios_normalises_probabilities_and_directions():
    payload = _valid_payload()
    payload["branches"][0]["prob"] = "TRÈS haute"
    payload["branches"][1]["plays"][0]["direction"] = "vers le haut"
    tree = llm.parse_scenarios(_tree_answer(payload))
    assert tree["branches"][0]["prob"] == "moyenne"       # repli au MILIEU
    assert tree["branches"][1]["plays"][0]["direction"] == "up"


def test_parse_scenarios_clamps_depth_and_counts():
    payload = _valid_payload()
    payload["branches"][0]["children"] = [
        {"label": "niveau 2", "children": [{"label": "niveau 3"}]}]
    payload["branches"].extend([{"label": "b%d" % i} for i in range(5)])
    tree = llm.parse_scenarios(_tree_answer(payload))
    assert len(tree["branches"]) == llm.SCENARIO_MAX_BRANCHES
    assert tree["branches"][0]["children"][0]["children"] == []


def test_parse_scenarios_drops_a_branch_without_a_label_alone():
    payload = _valid_payload()
    payload["branches"].append({"prob": "haute"})
    tree = llm.parse_scenarios(_tree_answer(payload))
    assert len(tree["branches"]) == 2


@pytest.mark.parametrize("raw", [
    None, 42, "",
    "aucun bloc json ici",
    "```json\n{pas du json}\n```",
    "```json\n[1, 2]\n```",
    '```json\n{"title": "", "branches": [{"label": "a"}, {"label": "b"}]}\n```',
    '```json\n{"title": "T", "branches": "pas une liste"}\n```',
])
def test_parse_scenarios_returns_none_on_anything_unusable(raw):
    assert llm.parse_scenarios(raw) is None


def test_parse_scenarios_refuses_a_single_branch():
    """Un arbre à une branche n'est pas un arbre : c'est une prédiction
    déguisée, exactement ce que cette vue refuse de produire."""
    payload = _valid_payload()
    payload["branches"] = payload["branches"][:1]
    assert llm.parse_scenarios(_tree_answer(payload)) is None


def test_intro_of_keeps_only_the_prose():
    answer = _tree_answer(_valid_payload(), intro="La question du moment.")
    assert llm.intro_of(answer) == "La question du moment."


def test_intro_of_falls_back_to_the_whole_text():
    assert llm.intro_of("rien que du texte") == "rien que du texte"
    assert llm.intro_of(None) == ""


def test_intro_of_cuts_on_a_bare_json_block():
    assert llm.intro_of('Mon avis.\n{"title": "T"}') == "Mon avis."


# =========================================================================== #
#  Niveau « crypto » — le 4e étage (26/08)
# =========================================================================== #

def test_le_niveau_crypto_existe_et_est_normalise():
    assert "crypto" in llm.RISK_LEVELS
    assert llm.normalize_risk_level("crypto") == "crypto"
    assert llm.normalize_risk_level("CRYPTOS") == "crypto"


def test_le_prompt_crypto_n_ouvre_que_l_univers_crypto():
    prompt = llm.build_ideas_prompt({}, "fr", "crypto")
    assert "BTC-USD" in prompt and "ETH-USD" in prompt
    assert "Aucune action, aucun ETF" in prompt
    assert '"asset_kind"' in prompt
    assert '"crypto"' in prompt


def test_le_prompt_crypto_demande_de_comparer_les_pieces_entre_elles():
    """C'est LA raison d'être de cet étage : « analyse les différentes cryptos
    les unes par rapport aux autres », pas quatre fois le même pari."""
    prompt = llm.build_ideas_prompt({}, "fr", "crypto")
    assert "COMPARE LES CRYPTOS ENTRE ELLES" in prompt
    assert "dominance" in prompt.lower() and "rotation" in prompt.lower()


def test_le_prompt_crypto_ne_porte_PAS_la_regle_des_deux_sur_quatre():
    """La règle « jamais plus de 2 idées crypto sur 4 » appartient au niveau
    spéculatif ; l'appliquer ici viderait l'étage de son sens."""
    crypto = llm.build_ideas_prompt({}, "fr", "crypto")
    speculatif = llm.build_ideas_prompt({}, "fr", "speculatif")
    assert "2 idées crypto sur 4" in speculatif
    assert "2 idées crypto sur 4" not in crypto


def test_le_prompt_crypto_rappelle_stop_large_donc_position_petite():
    prompt = llm.build_ideas_prompt({}, "fr", "crypto")
    assert "stop large, donc position petite" in prompt


def test_le_prompt_crypto_autorise_a_rendre_moins_d_idees():
    """L'honnêteté du modèle (« le contexte ne contient aucune donnée crypto »)
    est le comportement VOULU."""
    assert "rends moins" in llm.build_ideas_prompt({}, "fr", "crypto")


# =========================================================================== #
#  Mémoire du coach — le journal dans le prompt d'idées (26/08)
# =========================================================================== #

JOURNAL = [
    {"date": "2026-08-20", "kind": "ideas", "risk_level": "agressif",
     "ideas": [{"ticker": "TSLA", "direction": "up", "outcome": "miss"}]},
]


def test_le_prompt_porte_l_historique_des_idees_passees():
    prompt = llm.build_ideas_prompt({}, "fr", "mesure", JOURNAL)
    assert "HISTORIQUE DE TES PROPRES IDÉES" in prompt
    assert "TSLA" in prompt and "2026-08-20" in prompt and "miss" in prompt


def test_le_prompt_interdit_de_reproposer_sauf_si_un_facteur_a_change():
    prompt = llm.build_ideas_prompt({}, "fr", "mesure", JOURNAL)
    assert "INTERDIT de reproposer" in prompt
    assert "CHANGÉ LA DONNE" in prompt
    assert "je l'avais proposée le" in prompt


def test_sans_historique_le_prompt_ne_parle_pas_de_memoire():
    """Une première série ne doit pas recevoir un bloc vide qui l'embrouille."""
    prompt = llm.build_ideas_prompt({}, "fr", "mesure", [])
    assert "HISTORIQUE DE TES PROPRES IDÉES" not in prompt


def test_suggest_ideas_transmet_l_historique():
    captured = {}
    proc = FakeProc(stdout=envelope("des idées"))
    llm.suggest_ideas({}, "fr", "mesure", JOURNAL,
                      run=runner(proc, captured))
    assert "HISTORIQUE DE TES PROPRES IDÉES" in captured["input"]


# =========================================================================== #
#  Revue des positions détenues (26/08)
# =========================================================================== #

FACTS = {"positions": [{"symbol": "NESN.SW", "avg_price": 100.0,
                        "last_price": 92.0, "pnl_pct": -8.0,
                        "stop_loss": 90.0, "distance_stop_pct": -2.2,
                        "news_recentes": [], "gov_recent": False,
                        "whale_moves_on_this": []}]}


def test_le_prompt_de_revue_porte_les_faits_et_le_schema():
    prompt = llm.build_review_prompt(FACTS, "fr")
    assert "NESN.SW" in prompt
    assert "distance_stop_pct" in prompt and "whale_moves_on_this" in prompt
    assert '"verdicts"' in prompt
    for stance in llm.REVIEW_STANCES:
        assert '"%s"' % stance in prompt


def test_le_prompt_de_revue_s_adresse_a_un_debutant_et_laisse_la_decision():
    prompt = llm.build_review_prompt(FACTS, "fr")
    assert "DÉBUTANT" in prompt
    assert "les décisions restent à LUI" in prompt
    assert "argent réel" in prompt


def test_le_prompt_de_revue_refuse_surveiller_comme_refuge():
    """« Le coach ne doit pas attendre le 100 % de sûreté. »"""
    prompt = llm.build_review_prompt(FACTS, "fr")
    assert "n'est PAS un refuge" in prompt
    assert "déclencheur PRÉCIS" in prompt
    assert "délai" in prompt


def test_le_prompt_de_revue_dit_quoi_faire_d_un_cours_manquant():
    assert "ne l'invente pas" in llm.build_review_prompt(FACTS, "fr")


def test_parse_review_lit_les_verdicts():
    raw = ('Voici ma revue.\n```json\n'
           '{"verdicts": [{"symbol": "nesn.sw", "stance": "alleger", '
           '"reason": "le stop est proche"}]}\n```')
    assert llm.parse_review(raw) == [
        {"symbol": "NESN.SW", "stance": "alleger", "reason": "le stop est proche"}]


def test_parse_review_ramene_une_posture_forgee_sur_surveiller():
    """Une posture inconnue ne doit ni rassurer (« garder ») ni pousser dehors."""
    raw = '{"verdicts": [{"symbol": "AAPL", "stance": "VENDS TOUT MAINTENANT"}]}'
    assert llm.parse_review(raw)[0]["stance"] == "surveiller"


@pytest.mark.parametrize("raw", [
    "pas de bloc json du tout", "{ json cassé", '{"autre": 1}',
    '{"verdicts": "pas une liste"}', None, 42,
])
def test_parse_review_est_tolerant(raw):
    assert llm.parse_review(raw) == []


def test_parse_review_jette_un_verdict_sans_symbole_pas_tout_le_lot():
    raw = ('{"verdicts": [{"stance": "garder"}, '
           '{"symbol": "KO", "stance": "garder", "reason": "solide"}]}')
    assert [v["symbol"] for v in llm.parse_review(raw)] == ["KO"]


@pytest.mark.parametrize("value,expected", [
    ("garder", "garder"), ("HOLD", "garder"), ("alléger", "alleger"),
    ("sell", "sortir"), ("n'importe quoi", "surveiller"), (None, "surveiller"),
])
def test_normalize_stance(value, expected):
    assert llm.normalize_stance(value) == expected


def test_review_positions_appelle_le_cli_avec_le_prompt_de_revue():
    captured = {}
    proc = FakeProc(stdout=envelope("ma revue"))
    assert llm.review_positions(FACTS, "fr", run=runner(proc, captured)) == "ma revue"
    assert "POSITIONS ET FAITS" in captured["input"]


def test_review_positions_respecte_la_langue_de_lecture():
    captured = {}
    proc = FakeProc(stdout=envelope("la mia revisione"))
    llm.review_positions(FACTS, "it", run=runner(proc, captured))
    assert "italiano" in captured["input"]


# --------------------------------------------------------------------------- #
# Recherche FRAÎCHE — la consigne du balayage fait au clic (26/08)
# --------------------------------------------------------------------------- #

_SWEEP_CTX = {"recherche_fraiche": {
    "fenetre_jours": 7,
    "titres": {"NESN.SW": [{"ts": "2026-08-23T09:00:00",
                            "title": "Nestlé beats estimates",
                            "sentiment": "pos"}]},
    "momentum": {"NESN.SW": {"prix": 110.0, "pct_7j": 10.0}},
}}


@pytest.mark.parametrize("builder", [
    lambda ctx: llm.build_ideas_prompt(ctx),
    lambda ctx: llm.build_scenarios_prompt(ctx),
])
def test_la_consigne_de_recherche_fraiche_accompagne_la_cle(builder):
    prompt = builder(_SWEEP_CTX)
    assert "RECHERCHE À L'INSTANT" in prompt
    # L'ORDRE demandé : la mémoire porte la durée, le balayage la surprise.
    assert "Appuie-toi D'ABORD sur la MÉMOIRE" in prompt
    # Et la donnée elle-même voyage bien dans le bloc de contexte.
    assert "Nestlé beats estimates" in prompt


@pytest.mark.parametrize("builder", [
    lambda ctx: llm.build_ideas_prompt(ctx),
    lambda ctx: llm.build_scenarios_prompt(ctx),
])
@pytest.mark.parametrize("ctx", [None, {}, {"recherche_fraiche": {}}])
def test_sans_balayage_le_prompt_n_annonce_aucune_section(builder, ctx):
    """Annoncer une section absente inviterait le modèle à la combler seul —
    même précaution que pour l'historique."""
    assert "RECHERCHE À L'INSTANT" not in builder(ctx)


def test_la_consigne_distingue_une_liste_vide_d_un_titre_jamais_collecte():
    """Les deux silences ne disent pas la même chose : « rien de neuf sur sept
    jours » est un FAIT, « absent de l'historique » est une lacune."""
    prompt = llm.build_ideas_prompt(_SWEEP_CTX)
    assert "Une liste VIDE" in prompt and "rien de neuf sur sept jours" in prompt
    assert "n'a lui jamais été collecté" in prompt


# =========================================================================== #
#  W2a — doctrine « le pouvoir nomme, l'administration investit »
# =========================================================================== #

def test_la_doctrine_du_pouvoir_qui_nomme_est_dans_le_prompt_des_idees():
    prompt = llm.build_ideas_prompt({"positions": []})
    assert llm.POWER_NAMED_LINE in prompt


def test_la_doctrine_du_pouvoir_qui_nomme_est_dans_le_prompt_des_scenarios():
    prompt = llm.build_scenarios_prompt({"positions": []})
    assert llm.POWER_NAMED_LINE in prompt


def test_la_doctrine_dit_indicateur_avance_ET_jamais_promesse():
    """Les deux moitiés comptent autant l'une que l'autre : un dirigeant qui
    nomme une entreprise ne signe rien — le modèle doit PESER, pas croire."""
    line = llm.POWER_NAMED_LINE
    assert "INDICATEUR AVANCÉ" in line and "CATALYSEURS" in line
    assert "PROMESSES" in line


def test_la_doctrine_est_ecrite_a_UN_seul_endroit():
    """Trois formulations parallèles d'une même doctrine finiraient par
    diverger, et c'est le genre de dérive qu'on ne verrait jamais."""
    from backend.bots.paper import convergence
    assert convergence._power_named_line() == llm.POWER_NAMED_LINE


# =========================================================================== #
#  LOT 4 — le bloc d'ACTIONS du coach trader
#
#  Le coach a son propre compte : ce qu'il DIT et ce qu'il FAIT doivent sortir
#  du MÊME appel au modèle. Le bloc est donc écrit UNE fois ici, et réclamé par
#  DEUX prompts (le digest de convergence et la passe quotidienne).
# =========================================================================== #

BOOK = {
    "cash_chf": 6200.0,
    "equity_chf": 10450.0,
    "positions": [
        {"symbol": "NESN.SW", "qty": 12, "avg_price": 92.4, "currency": "CHF",
         "thesis": "reprise des volumes en Europe", "stop_loss": 85.0,
         "target": 110.0, "opened_at": "2026-08-10T09:00:00"},
    ],
    "open_orders": [{"symbol": "AAPL", "side": "buy", "qty": 3, "kind": "limit"}],
}


def test_coach_actions_block_est_vide_sans_compte():
    """Pas de compte -> pas de bloc : un prompt qui décrit une section absente
    invite le modèle à la combler tout seul (même précaution que _sweep_line)."""
    for empty in (None, {}, [], "pas un dict", 0):
        assert llm.coach_actions_block(empty) == ""


def test_coach_actions_block_montre_au_coach_SON_compte():
    block = llm.coach_actions_block(BOOK)
    assert "6200" in block and "10450" in block
    assert "NESN.SW" in block
    assert "reprise des volumes en Europe" in block     # la thèse de la ligne
    assert "85.0" in block and "110.0" in block         # stop et objectif
    assert "AAPL" in block                              # les ordres en attente


def test_coach_actions_block_enonce_les_regles_dures_du_garde_fou():
    """Les six bornes du mandat, en clair. Un modèle qui ne les connaît pas
    propose des ordres refusés — et le refus, lui, est visible publiquement."""
    from backend.bots.paper import coach_trader

    block = llm.coach_actions_block(BOOK)
    assert "sans stop" in block.lower()
    assert "10 %" in block and "centimes" in block      # MIN_POSITION_PCT
    assert "30 %" in block                              # MAX_POSITION_PCT
    assert "2 %" in block                               # MAX_RISK_PCT
    assert "6 " in block and "ligne" in block           # MAX_POSITIONS
    assert "crypto" in block                            # MAX_CRYPTO
    assert "5 %" in block and "trésorerie" in block     # MIN_CASH_PCT
    # Les chiffres sont LUS sur le garde-fou, jamais recopiés : un seuil ajusté
    # d'un côté ne peut pas mentir de l'autre.
    assert coach_trader.MAX_POSITIONS == 6
    assert "%g" % coach_trader.MAX_POSITION_PCT == "30"


def test_coach_actions_block_donne_le_format_exact_du_bloc():
    from backend.bots.paper import coach_trader

    block = llm.coach_actions_block(BOOK)
    assert "```%s" % coach_trader.ACTIONS_MARKER in block
    assert '{"actions": [' in block
    assert '"action": "buy"' in block
    for field in ("symbol", "qty", "stop", "target", "thesis", "setup"):
        assert '"%s"' % field in block, field
    for kind in coach_trader.ACTION_KINDS:
        assert kind in block, kind


def test_coach_actions_block_dit_que_zero_action_est_legitime():
    """« On n'invente jamais un ordre pour avoir l'air actif. »"""
    block = llm.coach_actions_block(BOOK)
    assert '{"actions": []}' in block
    # Insensible à la casse : le dépôt met les mots-clés en capitales pour
    # l'emphase, et ce test pin le FOND, pas la typographie.
    assert "légitime" in block.lower()


def test_coach_actions_block_precise_les_regles_de_forme():
    block = llm.coach_actions_block(BOOK)
    assert "TECHNIQUE" in block                 # le bloc ne répète pas le texte
    assert "devise du titre" in block.lower()   # stop/target dans la devise
    assert "sell" in block and "solder" in block  # sell sans qty = tout solder


def test_coach_actions_block_liste_les_setups_autorises():
    from backend.bots.paper import models

    block = llm.coach_actions_block(BOOK)
    for setup in models.SETUPS:
        assert '"%s"' % setup in block, setup


# --- LOT 4bis : le ``note`` de tête — l'inaction doit être ARGUMENTÉE ------- #

def test_coach_actions_block_exige_une_note_quand_les_actions_sont_vides():
    """Ne rien faire reste légitime, mais la raison doit être ÉCRITE — jamais
    un silence générique."""
    block = llm.coach_actions_block(BOOK)
    assert '"note"' in block
    assert "OBLIGATOIRE" in block
    low = block.lower()
    assert "spécifiques" in low
    assert "niveau de prix" in low
    assert "agenda" in low


def test_coach_actions_block_interdit_la_generalite_type_j_attends_une_opportunite():
    """L'exemple banni doit être ÉCRIT dans le prompt, pas seulement décrit en
    abstrait — un modèle apprend mieux d'un contre-exemple concret."""
    low = llm.coach_actions_block(BOOK).lower()
    assert "j'attends une meilleure opportunité" in low
    assert "ça ne dit rien" in low


def test_coach_actions_block_dit_que_le_registre_affiche_la_note_telle_quelle():
    low = llm.coach_actions_block(BOOK).lower()
    assert "registre l'afficherait" in low or "afficherait tel quel" in low


def test_coach_actions_block_note_reste_facultative_et_bienvenue_avec_des_actions():
    """Quand il agit, ``note`` n'est qu'une phrase de lecture de marché —
    bienvenue, jamais exigée."""
    block = llm.coach_actions_block(BOOK)
    low = block.lower()
    assert "facultatif" in low and "bienvenu" in low
    assert '"note"' in block


def test_coach_actions_block_donne_note_comme_champ_de_tete_hors_actions():
    low = llm.coach_actions_block(BOOK).lower()
    assert "champ de tête" in low or "champ de tete" in low
    assert "à côté de" in low or "a cote de" in low


def test_coach_actions_block_l_exemple_json_porte_desormais_une_note():
    block = llm.coach_actions_block(BOOK)
    assert '"note": "une phrase de lecture de marché"' in block
    # ... et le format d'origine n'a pas bougé : ``{"actions": [`` toujours là.
    assert '{"actions": [' in block


def test_coach_actions_block_mentionne_les_candidats_et_leurs_cours():
    """Vécu en prod : sans cours des candidats, un livre neuf/vide ne peut
    RIEN dimensionner — le coach était affamé de données, pas timide."""
    block = llm.coach_actions_block(BOOK)
    low = block.lower()
    assert "candidates" in low
    assert "manque de donn" in low       # « le manque de données n'est plus une excuse »
    assert "chf" in low


# --- la passe quotidienne de gestion ---------------------------------------- #

CTX = {
    "now": "2026-08-28T17:30:00",
    "cash_chf": 6200.0,
    "equity_chf": 10450.0,
    "initial_capital": 10000.0,
    "positions": [
        {"symbol": "NESN.SW", "qty": 12, "avg_price": 92.4, "currency": "CHF",
         "price": 96.1, "value_chf": 1153.2, "pnl_pct": 4.0,
         "thesis": "reprise des volumes en Europe", "stop_loss": 85.0,
         "target": 110.0, "opened_at": "2026-08-10T09:00:00"},
    ],
    "open_orders": [{"symbol": "AAPL", "side": "buy", "qty": 3}],
    "stats": {"trades": 9, "win_rate": 55.0},
    "discipline": {"score": 72},
    "radar": [{"title": "Le fret cher renchérit le café", "tickers": ["NESN.SW"],
               "status": "open"}],
    "market_mood": {"vix": 17.2, "change_pct": -1.5, "mood": "normal"},
    "agenda": [{"date": "2026-09-04", "label": "Résultats Nestlé",
                "symbol": "NESN.SW"}],
}


def test_build_coach_trader_prompt_ne_leve_pas_sur_un_contexte_partiel():
    from backend.bots.paper import coach_trader

    for bad in (None, {}, "pas un dict", [], {"positions": "cassé"}):
        prompt = llm.build_coach_trader_prompt(bad)
        assert llm.SYSTEM_PROMPT in prompt
        # Le marqueur reste là même sans compte : c'est LE contrat de sortie.
        assert coach_trader.ACTIONS_MARKER in prompt


def test_build_coach_trader_prompt_porte_tout_le_contexte():
    prompt = llm.build_coach_trader_prompt(CTX)
    assert "NESN.SW" in prompt and "reprise des volumes en Europe" in prompt
    assert "win_rate" in prompt and "55" in prompt          # stats
    assert "discipline" in prompt and "72" in prompt
    assert "Le fret cher renchérit le café" in prompt       # radar
    assert "17.2" in prompt                                 # VIX
    assert "Résultats Nestlé" in prompt and "2026-09-04" in prompt  # agenda


def test_build_coach_trader_prompt_dit_le_ton_professionnel_discipline():
    low = llm.build_coach_trader_prompt(CTX).lower()
    assert "invalid" in low          # on coupe ce qui est invalidé
    assert "courir" in low           # on laisse courir ce qui marche
    assert "conviction" in low       # on n'entre que par conviction
    assert "ne rien faire" in low    # et on assume de ne rien faire


def test_build_coach_trader_prompt_reprend_les_trois_interdits():
    prompt = llm.build_coach_trader_prompt(CTX)
    assert "sûr" in prompt and "garanti" in prompt       # certitude
    assert "ARGENT RÉEL" in prompt                       # jamais de conseil réel
    assert "invente" in prompt.lower()                   # rien hors contexte


def test_coach_book_of_porte_desormais_cinq_cles_dont_candidates():
    book = llm._coach_book_of(CTX)
    assert set(book) == {"cash_chf", "equity_chf", "positions", "open_orders",
                         "candidates"}
    assert book["candidates"] == []                 # absent du contexte CTX


def test_coach_book_of_porte_les_candidats_fournis_par_le_contexte():
    ctx = dict(CTX)
    ctx["candidates"] = [{"symbol": "AAPL", "price_chf": 176.0, "currency": "USD"}]
    assert llm._coach_book_of(ctx)["candidates"] == ctx["candidates"]


def test_coach_book_of_tolere_un_contexte_sans_candidats():
    for bad in (None, {}, "pas un dict", []):
        assert llm._coach_book_of(bad)["candidates"] == []


def test_build_coach_trader_prompt_termine_par_le_bloc_d_actions():
    """Le bloc CLÔT le prompt : c'est la dernière chose que le modèle lit."""
    prompt = llm.build_coach_trader_prompt(CTX)
    tail = llm.coach_actions_block(llm._coach_book_of(CTX))
    assert tail and prompt.endswith(tail)


def test_build_coach_trader_prompt_change_la_langue_de_sortie():
    assert "italiano" in llm.build_coach_trader_prompt(CTX, lang="it")
    assert "English" in llm.build_coach_trader_prompt(CTX, lang="en")
    assert "français" in llm.build_coach_trader_prompt(CTX, lang="fr")
    assert "français" in llm.build_coach_trader_prompt(CTX, lang="klingon")


# --- posture de PERFORMANCE (directive utilisateur : « le but, c'est qu'il
#     gagne le plus possible — cela ne veut pas dire d'oublier toute mesure de
#     sûreté »). Le garde-fou déterministe ne bouge PAS : c'est lui, la sûreté.
#     Seul le PROMPT vise la performance. ------------------------------------ #

def test_coach_actions_block_vise_la_performance_maximale_SOUS_les_regles():
    low = llm.coach_actions_block(BOOK).lower()
    assert "performance" in low
    # Un livre qui dort en cash sans raison échoue autant qu'un livre qui explose.
    assert "dort" in low or "dormir" in low
    assert "préservation du capital" in low


def test_coach_actions_block_dit_d_utiliser_PLEINEMENT_le_budget_de_risque():
    """Viser le bas de la fourchette « par prudence » est un mauvais réflexe
    ici : le plancher de 10 % existe déjà pour ça."""
    block = llm.coach_actions_block(BOOK)
    low = block.lower()
    assert "plafond" in low or "proche de" in low
    assert "prudence" in low and "mauvais réflexe" in low
    assert "10 %" in block and "30 %" in block and "2 %" in block


def test_coach_actions_block_dit_courir_couper_et_jamais_moyenner_en_baisse():
    low = llm.coach_actions_block(BOOK).lower()
    assert "courir" in low                 # laisser courir les gagnants
    assert "déplace" in low or "remonte" in low   # le stop, pas le mini-profit
    assert "moyenner à la baisse" in low
    assert "invalid" in low                # couper VITE ce qui est invalidé


def test_coach_actions_block_veut_une_inaction_ARGUMENTEE():
    """Ne rien faire reste légitime — mais comme un CHOIX, pas par timidité :
    le registre archive aussi les passes sans action."""
    low = llm.coach_actions_block(BOOK).lower()
    assert "timidité" in low
    assert "choix" in low and "argument" in low


def test_coach_actions_block_rappelle_que_TOUT_est_archive_note_et_compare():
    """C'est ce qui le tient honnête, exactement comme « ton bilan public te
    tient honnête » du digest."""
    low = llm.coach_actions_block(BOOK).lower()
    assert "registre" in low and "refus" in low      # acceptées ET refusées
    assert "discipline" in low
    assert "mae" in low and "mfe" in low
    assert "courbe" in low and "face" in low         # comparée à la sienne
    assert "crédibilité" in low


def test_les_DEUX_prompts_portent_la_posture_de_performance():
    """Le bloc est partagé : la posture ne peut pas diverger entre le digest et
    la passe quotidienne, elle est écrite une seule fois."""
    from backend.bots.paper import convergence

    daily = llm.build_coach_trader_prompt(CTX)
    digest = convergence.build_digest_prompt({}, [], None, None, "",
                                             coach_book=BOOK)
    for prompt in (daily, digest):
        low = prompt.lower()
        assert "performance" in low
        assert "registre" in low and "discipline" in low


def test_coach_actions_block_FINIT_par_le_bloc_lui_meme():
    """« Termine par ce bloc, et RIEN après » doit être VRAI dans la mise en
    page : une consigne démentie par ce qui la suit apprend au modèle que les
    consignes sont approximatives — et le bloc finirait au milieu du message.
    """
    block = llm.coach_actions_block(BOOK).rstrip()
    assert block.endswith("```")
    # La consigne de format et son exemple ferment le prompt, APRÈS le rappel
    # « ne rien faire est légitime » (sinon celui-ci s'intercale entre l'ordre
    # et son exemple).
    assert block.index("Termine IMPÉRATIVEMENT") > block.index("timidité")
    assert block.index("Termine IMPÉRATIVEMENT") > block.index("TU ES NOTÉ")


def test_coach_actions_block_ne_repete_pas_l_intro_de_ses_appelants():
    """Les deux appelants posent déjà le cadre (« ce compte est à toi »/« tu
    gères ton livre ») : le bloc n'ouvre pas une troisième fois là-dessus."""
    from backend.bots.paper import convergence

    section = convergence.build_digest_prompt(
        {}, [], None, None, "", coach_book=BOOK
    ).split("150 à 400 mots.")[-1]
    assert section.count("TON PROPRE compte") + \
        section.count("TON PROPRE COMPTE") == 1


# ==========================================================================
#  LOT 5 « Coach Trader MAX » — ce que le prompt doit DIRE, désormais
# ==========================================================================

def test_le_bloc_annonce_que_le_short_est_disponible():
    """Le mur vécu en prod : quatre refus d'entrer d'affilée, ses meilleures
    thèses étant BAISSIÈRES donc « inexécutables en achat seul ». Si le prompt
    ne le dit pas, le mandat a beau l'autoriser, il ne s'en servira pas."""
    block = llm.coach_actions_block(BOOK).lower()
    assert "short" in block
    assert "baissi" in block                    # « une thèse BAISSIÈRE se JOUE »
    assert "au-dessus" in block                 # le stop d'un short
    assert "cover" in block                     # ... et la façon de refermer


def test_le_bloc_explique_le_stop_des_deux_cotes():
    from backend.bots.paper import coach_trader

    block = llm.coach_actions_block(BOOK)
    for action in coach_trader.ENTRY_ACTIONS + coach_trader.EXIT_ACTIONS:
        assert action in block, action
    assert "adjust_stop" in block


def test_le_bloc_dit_que_le_stop_ne_se_desserre_jamais():
    block = llm.coach_actions_block(BOOK).lower()
    assert "resserr" in block
    assert "refus" in block                     # un stop qui s'éloigne est REFUSÉ


def test_le_bloc_decrit_les_niveaux_techniques_disponibles():
    """L'autre moitié du blocage : « je n'ai pas de niveau technique fiable
    pour poser un stop ». Les niveaux existent maintenant — encore faut-il lui
    dire qu'il les a et à quoi ils servent."""
    block = llm.coach_actions_block(BOOK).lower()
    assert "technical" in block
    for mot in ("rsi", "atr", "52 semaines", "moyenne"):
        assert mot in block, mot
    assert "null" in block                      # une donnée absente ne s'invente pas


def test_le_bloc_dit_que_le_short_ne_consomme_pas_la_tresorerie():
    block = llm.coach_actions_block(BOOK).lower()
    assert "n'achète rien" in block or "n achète rien" in block


# --- Le prompt du PREMIER temps : le tri ---------------------------------- #

SCREEN_CTX = {
    "now": "2026-08-26T18:00:00",
    "cash_chf": 6200.0,
    "equity_chf": 10450.0,
    "positions": [{"symbol": "NESN.SW", "qty": 12, "side": "long"}],
    "candidates": [{"symbol": "AAPL", "price_chf": 176.0,
                    "technical": {"rsi14": 61.2}}],
    "radar": [],
}


def test_le_prompt_de_tri_ne_demande_AUCUN_ordre():
    """Le tri REPÈRE, il ne décide pas : y glisser un bloc d'actions ferait
    passer des ordres sur un contexte large, ce que la passe en deux temps
    cherche précisément à éviter."""
    from backend.bots.paper import coach_trader

    prompt = llm.build_coach_screen_prompt(SCREEN_CTX)
    assert coach_trader.ACTIONS_MARKER not in prompt
    assert coach_trader.FOCUS_MARKER in prompt


def test_le_prompt_de_tri_borne_le_nombre_de_dossiers():
    from backend.bots.paper import coach_trader

    prompt = llm.build_coach_screen_prompt(SCREEN_CTX)
    assert str(coach_trader.MAX_FOCUS) in prompt
    assert '"focus"' in prompt


def test_le_prompt_de_tri_porte_le_contexte_complet():
    prompt = llm.build_coach_screen_prompt(SCREEN_CTX)
    assert "NESN.SW" in prompt and "AAPL" in prompt


def test_le_prompt_de_tri_dit_que_la_liste_vide_est_legitime():
    prompt = llm.build_coach_screen_prompt(SCREEN_CTX).lower()
    assert "vide" in prompt and "légitime" in prompt
    assert "timidité" in prompt          # ... mais que ce doit être un CHOIX


def test_le_prompt_de_tri_annonce_le_week_end_ferme():
    ouvert = llm.build_coach_screen_prompt(SCREEN_CTX)
    ferme = llm.build_coach_screen_prompt(dict(SCREEN_CTX, crypto_only=True))
    assert "ferm" in ferme.lower() and "crypto" in ferme.lower()
    assert "ferm" not in ouvert.lower()


def test_le_prompt_de_tri_ne_leve_jamais():
    for junk in (None, {}, [], "pas un dict", 0):
        assert isinstance(llm.build_coach_screen_prompt(junk), str)


# --- Le prompt du SECOND temps : les dossiers ------------------------------ #

def test_les_dossiers_arrivent_dans_le_second_prompt():
    ctx = dict(SCREEN_CTX, dossiers=[{
        "symbol": "AAPL",
        "technical": {"sma200": 180.4, "atr14": 4.2},
        "news": [{"title": "une dépêche", "sentiment": "pos"}],
        "history": ["une ligne d'historique"],
        "whale_moves": [{"symbol": "AAPL", "action": "sortie"}],
        "memory": [{"thesis": "une thèse déjà jouée", "outcome": "rate"}],
    }])
    prompt = llm.build_coach_trader_prompt(ctx)
    assert "DOSSIERS" in prompt
    assert "une dépêche" in prompt
    assert "une ligne d'historique" in prompt
    assert "une thèse déjà jouée" in prompt
    assert "180.4" in prompt


def test_pas_de_section_dossiers_quand_le_tri_n_a_rien_retenu():
    """Une section vide inviterait le modèle à la combler tout seul."""
    assert "DOSSIERS" not in llm.build_coach_trader_prompt(SCREEN_CTX)
    assert "DOSSIERS" not in llm.build_coach_trader_prompt(
        dict(SCREEN_CTX, dossiers=[]))
