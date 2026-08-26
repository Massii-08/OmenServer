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


def test_write_analysis_returns_the_text():
    out = llm.write_analysis({"symbol": "X"},
                             run=runner(FakeProc(0, envelope("Fiche."))))
    assert out == "Fiche."


# --------------------------------------------------------------------------- #
# Langue de sortie — UNE table, quatre prompts
#
# Le prompt reste français (c'est l'instruction au modèle) ; seule la consigne
# de langue de RÉPONSE change. Ces tests interdisent qu'un des quatre endpoints
# reparte en français pendant que les trois autres suivent l'interface.
# --------------------------------------------------------------------------- #

def _all_prompts(lang):
    return {
        "coach": llm.build_coach_prompt({"stats": {}}, "ça va ?", lang),
        "postmortem": llm.build_postmortem_prompt({"symbol": "X"}, {}, lang),
        "analysis": llm.build_analysis_prompt({"symbol": "X"}, lang),
        "ideas": llm.build_ideas_prompt({}, lang),
        "scenarios": llm.build_scenarios_prompt({}, lang),
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
