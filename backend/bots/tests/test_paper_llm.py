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
    assert len(seen["prompts"]) == 4
    for prompt in seen["prompts"]:
        assert "réponds exclusivement en italiano" in prompt
