"""Câblage de la passerelle LLM sur le coach du paper trading — 100 % hors ligne.

La passerelle (``backend/llm_gateway.py``) a ses propres tests
(``backend/tests/test_llm_gateway.py``) : ils prouvent sa LOGIQUE. Ici on prouve
le CÂBLAGE — ce qu'un test qui INJECTE la dépendance ne prouve jamais : qu'on la
BRANCHE. Concrètement :

* ``llm._claude_text`` SANS ``run`` appelle bien ``gw.complete`` (étiquette,
  palier, délai API, repli CLI, alertes) ; AVEC un ``run`` injecté, la passerelle
  n'est jamais touchée et le chemin CLI historique est intact ;
* le CLI de repli ne reçoit JAMAIS la clé API dans son environnement ;
* l'API n'a pas été en jeu (pas de clé, mode cli, SDK absent) et le CLI échoue :
  l'erreur qui sort est CELLE DU CLI, mot pour mot comme avant la passerelle ;
  l'API a été en jeu : la ``GatewayError`` cite les deux causes ;
* chacun des huit rédacteurs publics, des trois ``_default_llm`` et des deux
  ``speak`` du router passe la BONNE étiquette ;
* un scénario complet avec un faux client SDK : l'API répond, puis le crédit
  s'épuise et le texte vient du CLI, l'alerte partant sur le canal Oracle.

Aucun test n'atteint le réseau, le vrai CLI ni le vrai ``~/.local/state`` :
l'isolation est la fixture autouse ``_isolated_llm_gateway`` du ``conftest``
(``LLM_BACKEND=cli``, état dans ``tmp_path``, aucune clé). Les tests qui veulent
traverser le vrai ``llm._claude_text`` portent ``@pytest.mark.real_llm``.
"""
import json
import logging
import os
import subprocess
import sys
import traceback
import types
from pathlib import Path
from types import SimpleNamespace

import pytest

import backend.bots.paper as paper_pkg
from backend import llm_gateway as gw
from backend.bots import paper_router as pr
from backend.bots.paper import alerts, convergence, llm, radar, translate

FAKE_KEY = "sk-ant-api03-FAKE-0123456789abcdefghij-NE-DOIT-JAMAIS-FUIR"
CREDIT_MSG = ("Your credit balance is too low to access the Anthropic API. "
              "Please go to Plans & Billing to upgrade or purchase credits.")
KEY_VARS = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "LLM_GATEWAY_API_KEY")
NOW = "2026-08-24T10:00:00"


# --------------------------------------------------------------------------- #
# Doubles
# --------------------------------------------------------------------------- #

class FakeProc(object):
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def envelope(result, is_error=False):
    return json.dumps({"is_error": is_error, "result": result})


class CliRun(object):
    """Faux ``subprocess.run`` du CLI : note ses appels, rend une enveloppe."""

    def __init__(self, text="Réponse CLI"):
        self.text = text
        self.calls = []

    def __call__(self, cmd, input=None, capture_output=None, text=None,
                 timeout=None, cwd=None, env=None):
        self.calls.append({"cmd": cmd, "input": input, "timeout": timeout,
                           "cwd": cwd, "env": env})
        return FakeProc(0, envelope(self.text))


class CompleteSpy(object):
    """Remplace ``gw.complete`` : note l'appel, rend un ``Result`` (ou lève)."""

    def __init__(self, text="réponse API", exc=None):
        self.text = text
        self.exc = exc
        self.calls = []

    def __call__(self, prompt, **kw):
        self.calls.append(dict(kw, prompt=prompt))
        if self.exc is not None:
            raise self.exc
        return gw.Result(text=self.text, backend="api", model="claude-opus-5-5",
                         usage={}, cost_usd=0.0, fallback_reason=None)


class ClaudeTextSpy(object):
    """Remplace ``llm._claude_text`` : note ce que reçoit le « vrai » appelant."""

    def __init__(self, text="texte"):
        self.text = text
        self.calls = []

    def __call__(self, prompt, model=llm.DEFAULT_MODEL, timeout=llm.DEFAULT_TIMEOUT,
                 run=None, label="", tier=None):
        self.calls.append({"prompt": prompt, "model": model, "timeout": timeout,
                           "run": run, "label": label, "tier": tier})
        return self.text


class BadRequestError(Exception):
    """Même NOM que l'erreur du SDK : la passerelle classe par nom et ``status_code``."""
    status_code = 400


def make_resp(text="Réponse API", inp=1000, out=200):
    return SimpleNamespace(
        content=[SimpleNamespace(type="text", text=text)],
        usage=SimpleNamespace(input_tokens=inp, output_tokens=out,
                              cache_read_input_tokens=0, cache_creation_input_tokens=0),
        stop_reason="end_turn", stop_details=None, _request_id="req_test")


class FakeClient(object):
    """``.messages.create(**kw)`` : consomme ``script`` (réponse ou exception à
    lever), puis rend une réponse par défaut."""

    def __init__(self, *script):
        self.script = list(script)
        self.calls = []
        self.closed = 0
        self.messages = SimpleNamespace(create=self._create)

    def _create(self, **kw):
        self.calls.append(kw)
        action = self.script.pop(0) if self.script else make_resp()
        if isinstance(action, BaseException):
            raise action
        return action

    def close(self):
        self.closed += 1


class Factory(object):
    def __init__(self, client):
        self.client = client
        self.kwargs = []

    def __call__(self, **kw):
        self.kwargs.append(kw)
        return self.client


@pytest.fixture
def state_dir():
    """Le dossier d'état de la passerelle, posé dans ``tmp_path`` par le conftest."""
    return Path(os.environ["LLM_GATEWAY_STATE_DIR"])


def ledger(state):
    rows = []
    for path in sorted(state.glob("usage-*.jsonl")):
        rows += [json.loads(line) for line in path.read_text("utf-8").splitlines() if line]
    return rows


def ledger_raw(state):
    return "".join(p.read_text("utf-8") for p in sorted(state.glob("usage-*.jsonl")))


@pytest.fixture
def rig(monkeypatch):
    """Tout ce qu'il faut pour un VRAI passage par l'API, sans réseau : mode
    ``auto``, clé factice, SDK « installé » (module vide), faux client, canal
    Oracle espionné, CLI doublé au niveau de ``subprocess.run``."""
    monkeypatch.setenv("LLM_BACKEND", "auto")
    monkeypatch.setenv("LLM_GATEWAY_API_KEY", FAKE_KEY)
    monkeypatch.setenv("CLAUDE_BIN", "/faux/claude")
    monkeypatch.setitem(sys.modules, "anthropic", types.ModuleType("anthropic"))
    client = FakeClient()
    factory = Factory(client)
    monkeypatch.setattr(gw, "_default_client_factory", factory)
    sent = []
    monkeypatch.setattr(alerts, "send", lambda text, *a, **k: sent.append(text) or True)
    cli = CliRun("Réponse CLI")
    monkeypatch.setattr(llm.subprocess, "run", cli)
    return SimpleNamespace(client=client, factory=factory, sent=sent, cli=cli)


# --------------------------------------------------------------------------- #
# 0. L'isolation de la suite
# --------------------------------------------------------------------------- #

def test_la_suite_est_isolee_de_la_vraie_passerelle(tmp_path):
    """Canari de la fixture autouse du conftest : mode cli, aucune clé, état et
    fichier d'env dans ``tmp_path`` — le vrai ``~/.local/state`` n'est jamais vu."""
    st = gw.status()
    assert st["mode"] == "cli"
    assert st["api_key_present"] is False
    assert Path(st["state_dir"]) == tmp_path / "llm-gateway"
    assert Path(st["env_file"]) == tmp_path / "absent.env"
    assert st["env_file_exists"] is False
    for name in KEY_VARS:
        assert name not in os.environ


# --------------------------------------------------------------------------- #
# 1. `_claude_text` : la passerelle est BRANCHÉE (sans run), court-circuitée (avec run)
# --------------------------------------------------------------------------- #

@pytest.mark.real_llm      # n'APPELLE rien : retire seulement le garde, pour lire la VRAIE signature
def test_le_run_par_defaut_est_le_vrai_subprocess_run_capture_a_l_import():
    """C'est l'IDENTITÉ avec cet objet qui distingue « personne n'a injecté de
    double » (-> passerelle) de « un double est injecté » (-> CLI historique)."""
    import inspect
    import subprocess
    assert llm._REAL_RUN is subprocess.run
    assert inspect.signature(llm._claude_text).parameters["run"].default is llm._REAL_RUN
    # historique : prompt, model, timeout, run restent les quatre premiers paramètres
    assert list(inspect.signature(llm._claude_text).parameters)[:4] == [
        "prompt", "model", "timeout", "run"]


@pytest.mark.real_llm
def test_sans_run_la_passerelle_recoit_le_label_le_palier_et_le_delai_api(monkeypatch):
    spy = CompleteSpy("réponse API")
    monkeypatch.setattr(llm.gw, "complete", spy)

    assert llm._claude_text("le prompt", label="ideas") == "réponse API"

    (call,) = spy.calls
    assert call["prompt"] == "le prompt"
    assert call["label"] == "ideas"
    assert call["tier"] == "opus"
    assert call["timeout"] == llm.API_TIMEOUT == 180     # Opus + longue sortie JSON : pas de repli à 120 s
    assert call["notify"] is llm._notify                 # les alertes partent sur Telegram
    assert callable(call["cli"])


@pytest.mark.real_llm
@pytest.mark.parametrize("kwargs,label,tier", [
    ({}, "paper", "sonnet"),                              # sans étiquette : le défaut
    ({"label": "translate"}, "translate", "haiku"),
    ({"label": "coach_ask"}, "coach_ask", "opus"),
    ({"label": "inconnu"}, "inconnu", "sonnet"),          # étiquette hors table : sonnet
    ({"label": "ideas", "tier": "haiku"}, "ideas", "haiku"),   # le palier explicite l'emporte
])
def test_label_et_palier_par_defaut_ou_explicites(monkeypatch, kwargs, label, tier):
    spy = CompleteSpy()
    monkeypatch.setattr(llm.gw, "complete", spy)
    llm._claude_text("p", **kwargs)
    assert (spy.calls[0]["label"], spy.calls[0]["tier"]) == (label, tier)


@pytest.mark.real_llm
def test_le_texte_rendu_est_celui_du_resultat_quel_que_soit_le_backend(monkeypatch):
    """Que l'API ou le CLI ait répondu, l'appelant ne voit que le texte."""
    def complete(prompt, **kw):
        return gw.Result(text="venu du CLI", backend="cli", model="cli", usage={},
                         cost_usd=0.0, fallback_reason="credit_exhausted")
    monkeypatch.setattr(llm.gw, "complete", complete)
    assert llm._claude_text("p", label="ideas") == "venu du CLI"


@pytest.mark.parametrize("kwargs", [{}, {"label": "ideas"}, {"label": "ideas", "tier": "opus"}])
def test_un_run_injecte_ne_touche_jamais_la_passerelle(monkeypatch, state_dir, kwargs):
    """Cas de TOUS les tests existants : le chemin CLI historique, à l'identique —
    le double reçoit l'appel historique, SANS mot-clé ``env``."""
    def boom(*a, **k):
        raise AssertionError("la passerelle ne doit pas être touchée")
    monkeypatch.setattr(llm.gw, "complete", boom)
    seen = {}

    def run(cmd, input=None, capture_output=None, text=None, timeout=None, cwd=None):
        # signature HISTORIQUE : un `env=` passé ici lèverait TypeError
        seen.update(cmd=cmd, input=input, timeout=timeout, cwd=cwd)
        return FakeProc(0, envelope("  Salut Massii.  "))

    assert llm._claude_text("dis bonjour", timeout=42, run=run, **kwargs) == "Salut Massii."
    assert seen["cmd"][1:4] == ["-p", "--output-format", "json"]
    assert seen["input"] == "dis bonjour"
    assert seen["timeout"] == 42
    assert "paper-coach-llm-" in seen["cwd"]
    assert not state_dir.exists()          # rien n'a été journalisé non plus


def test_un_run_injecte_garde_toutes_les_erreurs_en_runtime_error(monkeypatch):
    monkeypatch.setattr(llm.gw, "complete", lambda *a, **k: pytest.fail("passerelle touchée"))

    def missing(*a, **k):
        raise FileNotFoundError("claude")

    with pytest.raises(RuntimeError, match="CLI Claude introuvable"):
        llm._claude_text("p", run=missing, label="ideas")


# --------------------------------------------------------------------------- #
# 2. Le CLI de repli : environnement SANS clé, mêmes arguments qu'avant
# --------------------------------------------------------------------------- #

@pytest.mark.real_llm
def test_le_cli_de_repli_ne_recoit_jamais_la_cle_api(monkeypatch):
    """Avec ANTHROPIC_API_KEY dans son environnement le CLI s'en servirait À LA
    PLACE de l'abonnement et brûlerait le crédit en plein repli."""
    for name in KEY_VARS:
        monkeypatch.setenv(name, FAKE_KEY)
    monkeypatch.setenv("UNE_AUTRE_VARIABLE", "gardee")
    # Le jeton OAuth de l'abonnement Max : c'est LUI qui authentifie le CLI sur
    # l'Omen (omenserver.service le reçoit de start-omen.sh). Le retirer
    # couperait le repli au moment précis où on en a besoin.
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-FAKE-ABONNEMENT")
    cli = CliRun("Réponse CLI")
    monkeypatch.setattr(llm.subprocess, "run", cli)

    # LLM_BACKEND=cli (conftest) : la passerelle va droit au closure CLI
    assert llm._claude_text("p", model="claude-opus-5", timeout=77, label="ideas") == "Réponse CLI"

    (call,) = cli.calls
    assert isinstance(call["env"], dict)
    for name in KEY_VARS:
        assert name not in call["env"]
    assert call["env"]["CLAUDE_CODE_OAUTH_TOKEN"] == "sk-ant-oat01-FAKE-ABONNEMENT"
    assert call["env"]["UNE_AUTRE_VARIABLE"] == "gardee"     # le reste de l'env est conservé
    assert os.environ["ANTHROPIC_API_KEY"] == FAKE_KEY       # l'env du process, lui, est intact
    assert call["timeout"] == 77                             # le CLI garde SON délai, pas les 180 s de l'API
    assert call["cmd"][1:4] == ["-p", "--output-format", "json"]
    assert call["cmd"][-2:] == ["--model", "claude-opus-5"]
    assert "paper-coach-llm-" in call["cwd"]                 # dossier neutre aussi sur ce chemin


@pytest.mark.real_llm
def test_sans_cle_le_cli_recoit_exactement_l_appel_d_aujourd_hui(monkeypatch, state_dir):
    """« SANS clé configurée, le comportement reste celui d'aujourd'hui » : même
    commande, même prompt, même délai que le chemin à `run` injecté — et la
    passerelle n'invente aucun client (pas de clé, pas de SDK touché)."""
    monkeypatch.setenv("LLM_BACKEND", "auto")                # le défaut de production
    monkeypatch.setattr(gw, "_default_client_factory",
                        lambda **kw: pytest.fail("aucun client sans clé"))
    legacy = CliRun("Bonjour")
    assert llm._claude_text("dis bonjour", run=legacy) == "Bonjour"
    via_gateway = CliRun("Bonjour")
    monkeypatch.setattr(llm.subprocess, "run", via_gateway)

    assert llm._claude_text("dis bonjour", label="ideas") == "Bonjour"

    a, b = legacy.calls[0], via_gateway.calls[0]
    assert (a["cmd"], a["input"], a["timeout"]) == (b["cmd"], b["input"], b["timeout"])
    assert a["env"] is None and isinstance(b["env"], dict)   # seule différence : l'env sans clé
    (row,) = ledger(state_dir)
    assert (row["backend"], row["fallback_reason"], row["label"]) == ("cli", "no_key", "ideas")


# --------------------------------------------------------------------------- #
# 3. Les pannes ressortent en RuntimeError — et, SANS l'API en jeu, MOT POUR MOT
#    comme avant la passerelle
# --------------------------------------------------------------------------- #

def _rc2(*a, **k):
    return FakeProc(2, "", "boom")


def _error_envelope(*a, **k):
    return FakeProc(0, envelope("refus", is_error=True))


def _garbage(*a, **k):
    return FakeProc(0, "pas du json")


def _empty_answer(*a, **k):
    return FakeProc(0, envelope("   "))


def _times_out(*a, **k):
    raise subprocess.TimeoutExpired(cmd="claude", timeout=llm.DEFAULT_TIMEOUT)


def _missing_binary(*a, **k):
    raise FileNotFoundError("claude")


# Chaque panne possible du CLI (les six branches d'erreur de `_cli_text`). Ces
# doubles acceptent `*a, **k` : ils servent sur le chemin historique (`run=`) comme
# sur le chemin passerelle (qui ajoute `env=`).
CLI_FAILURES = {
    "rc2": _rc2,
    "enveloppe_erreur": _error_envelope,
    "sortie_illisible": _garbage,
    "reponse_vide": _empty_answer,
    "delai": _times_out,
    "binaire_absent": _missing_binary,
}


def _backend_cli(monkeypatch):
    """Le défaut du conftest : LLM_BACKEND=cli — l'interrupteur d'urgence."""


def _no_key(monkeypatch):
    monkeypatch.setenv("LLM_BACKEND", "auto")       # le défaut de production, aucune clé


def _sdk_missing(monkeypatch):
    monkeypatch.setenv("LLM_BACKEND", "auto")
    monkeypatch.setenv("LLM_GATEWAY_API_KEY", FAKE_KEY)
    monkeypatch.setitem(sys.modules, "anthropic", None)   # « import anthropic » -> ImportError


# Les trois situations où l'API n'est JAMAIS en jeu (`llm._API_NOT_TRIED`).
API_NOT_TRIED = {"backend_cli": _backend_cli, "no_key": _no_key, "sdk_missing": _sdk_missing}


@pytest.mark.real_llm
def test_une_gateway_error_ressort_en_runtime_error(monkeypatch):
    err = gw.GatewayError("API: credit_exhausted; CLI: boom", api_reason="credit_exhausted")
    monkeypatch.setattr(llm.gw, "complete", CompleteSpy(exc=err))
    with pytest.raises(RuntimeError) as info:
        llm._claude_text("p", label="ideas")
    assert info.value is err
    assert "credit_exhausted" in str(info.value)


def test_la_liste_des_situations_sans_api_est_celle_du_cahier_des_charges():
    assert tuple(sorted(llm._API_NOT_TRIED)) == tuple(sorted(API_NOT_TRIED))


@pytest.mark.real_llm
def test_sans_cle_un_cli_en_rc2_garde_exactement_le_message_d_avant(monkeypatch):
    monkeypatch.setenv("LLM_BACKEND", "auto")            # le défaut de production, aucune clé
    monkeypatch.setattr(llm.subprocess, "run", _rc2)

    with pytest.raises(RuntimeError) as info:
        llm._claude_text("p", label="ideas")

    assert type(info.value) is RuntimeError              # pas une GatewayError
    assert str(info.value) == "claude cli rc=2: boom"    # ni « API: no_key; CLI: … »


@pytest.mark.real_llm
@pytest.mark.parametrize("situation", sorted(API_NOT_TRIED))
@pytest.mark.parametrize("failure", sorted(CLI_FAILURES))
def test_api_non_tentee_une_panne_du_cli_ressort_mot_pour_mot_comme_avant(
        monkeypatch, situation, failure):
    """« SANS clé, comportement EXACTEMENT identique » : même type, même message que
    le chemin historique (`run` injecté) — jamais la GatewayError « API: …; CLI: … »."""
    monkeypatch.setenv("CLAUDE_BIN", "/faux/claude")      # le chemin du binaire est dans un message
    API_NOT_TRIED[situation](monkeypatch)
    behaviour = CLI_FAILURES[failure]
    with pytest.raises(RuntimeError) as before:
        llm._claude_text("p", run=behaviour)              # le chemin historique
    monkeypatch.setattr(llm.subprocess, "run", behaviour)

    with pytest.raises(RuntimeError) as after:
        llm._claude_text("p", label="ideas")              # la passerelle

    assert type(after.value) is RuntimeError
    assert str(after.value) == str(before.value)
    assert "API:" not in str(after.value)


@pytest.mark.real_llm
def test_l_erreur_d_origine_est_relevee_sans_trainer_la_gateway_error(monkeypatch):
    """`raise … from None` : la trace affichée ne montre que l'erreur du CLI."""
    monkeypatch.setattr(llm.subprocess, "run", _rc2)

    with pytest.raises(RuntimeError) as info:
        llm._claude_text("p", label="ideas")

    exc = info.value
    shown = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    assert "GatewayError" not in shown
    assert "During handling of the above exception" not in shown
    assert exc.__cause__ is None and exc.__suppress_context__ is True


@pytest.mark.real_llm
def test_une_exception_inattendue_du_cli_sort_quand_meme_en_runtime_error(monkeypatch):
    """`_cli_text` ne lève que RuntimeError ; un double qui lève autre chose (bug de
    programmation) n'est PAS relevé tel quel : la passerelle l'emballe, et l'appelant
    garde son contrat « RuntimeError et rien d'autre »."""
    def bizarre(*a, **k):
        raise ValueError("pas prévu")
    monkeypatch.setattr(llm.subprocess, "run", bizarre)

    with pytest.raises(RuntimeError) as info:
        llm._claude_text("p", label="ideas")

    assert isinstance(info.value, gw.GatewayError)
    assert "ValueError" in str(info.value)


@pytest.mark.real_llm
def test_api_tentee_puis_cli_en_echec_la_gateway_error_cite_les_deux_causes(rig, monkeypatch):
    class OverloadedError(Exception):                     # même NOM que celle du SDK
        status_code = 529
    rig.client.script.append(OverloadedError("Overloaded"))
    monkeypatch.setattr(llm.subprocess, "run", _rc2)

    with pytest.raises(RuntimeError) as info:             # ce que le router attrape pour le 502
        llm._claude_text("p", label="ideas")

    assert isinstance(info.value, gw.GatewayError)
    assert info.value.api_reason == "overloaded"
    assert "overloaded" in str(info.value)                # la cause côté API…
    assert "claude cli rc=2: boom" in str(info.value)     # …et la cause côté CLI
    assert len(rig.client.calls) == 1                     # l'API a bien été tentée
    assert FAKE_KEY not in str(info.value)


@pytest.mark.real_llm
def test_budget_atteint_puis_cli_en_echec_garde_la_gateway_error(rig, monkeypatch):
    """Clé configurée, budget à 0 : l'API n'est pas tentée mais ce n'est pas « sans
    API » — c'est une décision de la passerelle, et son message dit laquelle."""
    monkeypatch.setenv("LLM_MONTHLY_BUDGET_USD", "0")
    monkeypatch.setattr(llm.subprocess, "run", _rc2)

    with pytest.raises(gw.GatewayError) as info:
        llm._claude_text("p", label="radar")

    assert info.value.api_reason == "budget_reached"
    assert "budget_reached" in str(info.value)
    assert "claude cli rc=2: boom" in str(info.value)
    assert rig.client.calls == []


@pytest.mark.real_llm
def test_api_bloquee_puis_cli_en_echec_garde_la_gateway_error(rig, monkeypatch):
    """Après un crédit épuisé l'API est bloquée une heure : l'appel suivant ne la
    tente pas, mais ce n'est pas « sans API » non plus — la GatewayError cite le
    blocage en plus de l'échec du CLI."""
    rig.client.script.append(BadRequestError(CREDIT_MSG))
    assert llm._claude_text("p", label="radar") == "Réponse CLI"        # pose le blocage
    monkeypatch.setattr(llm.subprocess, "run", _rc2)

    with pytest.raises(gw.GatewayError) as info:
        llm._claude_text("p", label="radar")

    assert info.value.api_reason == "blocked:credit_exhausted"
    assert "blocked:credit_exhausted" in str(info.value)
    assert "claude cli rc=2: boom" in str(info.value)
    assert len(rig.client.calls) == 1                                   # l'API n'a pas été retentée


@pytest.mark.real_llm
def test_mode_api_sans_repli_garde_la_gateway_error_et_ne_lance_pas_le_cli(monkeypatch):
    """Raison `no_key` mais AUCUNE erreur de CLI à relever (le CLI est désactivé) :
    la règle ne s'applique pas, la GatewayError sort telle quelle."""
    monkeypatch.setenv("LLM_BACKEND", "api")
    cli = CliRun()
    monkeypatch.setattr(llm.subprocess, "run", cli)

    with pytest.raises(gw.GatewayError) as info:
        llm._claude_text("p", label="radar")

    assert cli.calls == []
    assert info.value.api_reason == "no_key"
    assert "LLM_BACKEND=api" in str(info.value)


# --------------------------------------------------------------------------- #
# 4. Les paliers
# --------------------------------------------------------------------------- #

EXPECTED_TIERS = {
    "coach_ask": "opus", "ideas": "opus", "review": "opus", "scenarios": "opus",
    "postmortem": "sonnet", "weekly": "sonnet", "analysis": "sonnet",
    "scalp_review": "sonnet", "convergence": "sonnet", "radar": "sonnet",
    "coach_trader": "sonnet", "coach_guardian": "sonnet", "paper": "sonnet",
    "translate": "haiku",
}


def test_la_table_label_palier_est_exactement_celle_du_cahier_des_charges():
    assert llm.TIER_BY_LABEL == EXPECTED_TIERS
    for label, tier in EXPECTED_TIERS.items():
        assert llm.tier_for(label) == tier


def test_tous_les_paliers_de_la_table_existent_dans_la_passerelle():
    assert set(llm.TIER_BY_LABEL.values()) <= set(gw.TIERS)


@pytest.mark.parametrize("label", ["", None, "inconnu", "COACH_ASK"])
def test_une_etiquette_vide_ou_inconnue_tombe_sur_sonnet(label):
    assert llm.tier_for(label) == "sonnet"


# --------------------------------------------------------------------------- #
# 5. Chaque appelant passe SA bonne étiquette
# --------------------------------------------------------------------------- #

WRAPPERS = [
    ("coach_ask", lambda **kw: llm.ask_coach({}, "et alors ?", **kw)),
    ("postmortem", lambda **kw: llm.write_postmortem({}, {}, **kw)),
    ("weekly", lambda **kw: llm.write_weekly_report({}, **kw)),
    ("analysis", lambda **kw: llm.write_analysis({}, **kw)),
    ("scenarios", lambda **kw: llm.suggest_scenarios({}, **kw)),
    ("review", lambda **kw: llm.review_positions({}, **kw)),
    ("ideas", lambda **kw: llm.suggest_ideas({}, **kw)),
    ("scalp_review", lambda **kw: llm.write_scalp_review({}, **kw)),
]


@pytest.mark.parametrize("label,call", WRAPPERS, ids=[w[0] for w in WRAPPERS])
def test_chaque_redacteur_public_passe_son_label_a_claude_text(monkeypatch, label, call):
    spy = ClaudeTextSpy()
    monkeypatch.setattr(llm, "_claude_text", spy)
    sentinel = object()

    assert call(model="un-modele", timeout=7, run=sentinel) == "texte"

    (got,) = spy.calls
    assert got["label"] == label
    assert got["tier"] is None                    # le palier vient de la table, pas du rédacteur
    assert got["model"] == "un-modele"
    assert got["timeout"] == 7
    assert got["run"] is sentinel                 # le `run` injecté traverse
    assert llm.SYSTEM_PROMPT in got["prompt"]


@pytest.mark.parametrize("label,call", WRAPPERS, ids=[w[0] for w in WRAPPERS])
def test_sans_run_les_redacteurs_laissent_le_vrai_run_par_defaut(monkeypatch, label, call):
    """C'est CE `run` par défaut qui fait prendre la passerelle à `_claude_text`."""
    spy = ClaudeTextSpy()
    monkeypatch.setattr(llm, "_claude_text", spy)
    call()
    assert spy.calls[0]["run"] is llm._REAL_RUN
    assert spy.calls[0]["model"] == llm.DEFAULT_MODEL
    assert spy.calls[0]["timeout"] == llm.DEFAULT_TIMEOUT


@pytest.mark.parametrize("module,label", [(convergence, "convergence"),
                                          (radar, "radar"),
                                          (translate, "translate")],
                         ids=["convergence", "radar", "translate"])
def test_les_default_llm_directs_passent_leur_label(monkeypatch, module, label):
    spy = ClaudeTextSpy("réponse")
    monkeypatch.setattr(llm, "_claude_text", spy)

    assert module._default_llm("le prompt") == "réponse"

    assert spy.calls == [{"prompt": "le prompt", "model": llm.DEFAULT_MODEL,
                          "timeout": llm.DEFAULT_TIMEOUT, "run": None,
                          "label": label, "tier": None}]


def test_le_bilan_hebdomadaire_passe_par_le_label_weekly(monkeypatch):
    """`weekly._default_llm` n'appelle pas `_claude_text` : il passe par le
    rédacteur public — la chaîne doit donc rendre `weekly` de bout en bout."""
    from backend.bots.paper import weekly
    spy = ClaudeTextSpy("bilan")
    monkeypatch.setattr(llm, "_claude_text", spy)
    assert weekly._default_llm({"closed_this_week": []}) == "bilan"
    assert spy.calls[0]["label"] == "weekly"


def test_le_coach_trader_parle_avec_le_label_coach_trader(monkeypatch):
    """Le `speak` par défaut de la passe quotidienne (router ~l.3513)."""
    spy = ClaudeTextSpy("réponse")
    monkeypatch.setattr(pr.llm, "_claude_text", spy)
    captured = {}

    def stop(speak, builder, context, now):
        captured["speak"] = speak
        return None, "arrêt du test"

    monkeypatch.setattr(pr, "_ensure_coach_account", lambda: SimpleNamespace(positions=[]))
    monkeypatch.setattr(pr, "_coach_pass_context", lambda portfolio, now: {})
    monkeypatch.setattr(pr, "_coach_speak", stop)
    monkeypatch.setattr(pr, "_coach_llm_failure", lambda now, detail: [])

    pr.run_coach_daily_pass(now_iso=NOW)

    assert captured["speak"]("le prompt") == "réponse"
    assert spy.calls[0]["prompt"] == "le prompt"
    assert spy.calls[0]["label"] == "coach_trader"


def test_le_gardien_parle_avec_le_label_coach_guardian(monkeypatch):
    """Le `speak` par défaut de la passe gardien (router ~l.3617)."""
    spy = ClaudeTextSpy("réponse")
    monkeypatch.setattr(pr.llm, "_claude_text", spy)
    captured = {}

    def stop(speak, builder, context, now):
        captured["speak"] = speak
        return None, "arrêt du test"

    position = SimpleNamespace(symbol="NESN.SW", to_dict=lambda: {"symbol": "NESN.SW"})
    monkeypatch.setattr(pr, "_ensure_coach_account",
                        lambda: SimpleNamespace(positions=[position]))
    monkeypatch.setattr(pr.coach_trader, "load_guardian_state", lambda: {})
    monkeypatch.setattr(pr.coach_trader, "save_guardian_state", lambda state: None)
    monkeypatch.setattr(pr.coach_trader, "guardian_decision",
                        lambda *a, **k: {"fire": True, "trigger": "move"})
    monkeypatch.setattr(pr, "_coach_quote", lambda symbol: {"price": 10.0, "fx_rate": 1.0})
    monkeypatch.setattr(pr, "_coach_guardian_dossier", lambda *a, **k: {})
    monkeypatch.setattr(pr, "_coach_speak", stop)
    monkeypatch.setattr(pr, "execute_coach_actions", lambda *a, **k: [])

    out = pr.run_coach_guardian_pass(now_iso=NOW)

    assert out["fired"] == ["NESN.SW"]            # on a bien atteint l'appel au modèle
    assert captured["speak"]("le prompt") == "réponse"
    assert spy.calls[0]["label"] == "coach_guardian"


def test_un_claude_injecte_dans_les_passes_du_coach_reste_tel_quel(monkeypatch):
    """La logique `claude if claude is not None else …` n'a pas bougé : un
    `claude=` injecté est le `speak`, sans enveloppe ni étiquette."""
    monkeypatch.setattr(pr, "_ensure_coach_account", lambda: SimpleNamespace(positions=[]))
    monkeypatch.setattr(pr, "_coach_pass_context", lambda portfolio, now: {})
    captured = {}

    def stop(speak, builder, context, now):
        captured["speak"] = speak
        return None, "arrêt du test"

    monkeypatch.setattr(pr, "_coach_speak", stop)
    monkeypatch.setattr(pr, "_coach_llm_failure", lambda now, detail: [])

    def mon_claude(prompt):
        return "x"

    pr.run_coach_daily_pass(now_iso=NOW, claude=mon_claude)
    assert captured["speak"] is mon_claude


# --------------------------------------------------------------------------- #
# 6. Les alertes de la passerelle partent sur le canal du bot Oracle
# --------------------------------------------------------------------------- #

def test_notify_prefixe_le_texte_et_l_envoie_sur_le_canal_oracle(monkeypatch):
    sent = []
    monkeypatch.setattr(alerts, "send", lambda text, *a, **k: sent.append(text) or True)
    llm._notify("crédit API épuisé")
    assert sent == ["[Coach IA] crédit API épuisé"]


def test_notify_ne_leve_jamais_quand_le_canal_leve(monkeypatch, caplog):
    def boom(*a, **k):
        raise RuntimeError("token=SECRET-123 chat=42")
    monkeypatch.setattr(alerts, "send", boom)
    with caplog.at_level(logging.DEBUG):
        assert llm._notify("x") is None
    assert "SECRET-123" not in caplog.text          # l'exception n'est pas loguée


def test_notify_sans_canal_configure_ne_leve_pas_et_ne_touche_pas_le_reseau(monkeypatch):
    from backend.bots.harvester import notify
    network = []        # on ENREGISTRE (un assert levé ici serait avalé par _notify)

    monkeypatch.setattr(alerts, "load_cfg", lambda path=None: None)
    monkeypatch.setattr(notify, "send", lambda *a, **k: network.append(a) or True)

    assert llm._notify("x") is None
    assert network == []


def test_notify_avale_aussi_un_module_alerts_introuvable(monkeypatch):
    monkeypatch.delattr(paper_pkg, "alerts")
    monkeypatch.setitem(sys.modules, "backend.bots.paper.alerts", None)
    with pytest.raises(ImportError):               # le décor est bien planté…
        from backend.bots.paper import alerts as _  # noqa: F401
    assert llm._notify("x") is None                # …et _notify ne lève quand même pas


# --------------------------------------------------------------------------- #
# 7. Scénarios complets : faux client SDK, vrai `llm._claude_text`, vraie passerelle
# --------------------------------------------------------------------------- #

@pytest.mark.real_llm
def test_scenario_complet_l_api_repond_puis_le_credit_s_epuise_et_le_cli_prend_le_relais(
        rig, state_dir):
    # 1. L'API répond : tier opus pour `ideas`, délai API de 180 s, journal écrit.
    assert llm._claude_text("le prompt", label="ideas") == "Réponse API"
    assert rig.cli.calls == []                       # le CLI n'a pas bougé
    (create,) = rig.client.calls
    assert create["model"] == "claude-opus-5-5"
    assert create["messages"] == [{"role": "user", "content": "le prompt"}]
    assert rig.factory.kwargs == [{"api_key": FAKE_KEY, "timeout": 180.0, "max_retries": 1}]
    assert rig.client.closed == 1
    (row,) = ledger(state_dir)
    assert (row["backend"], row["label"], row["tier"], row["model"],
            row["fallback_reason"]) == ("api", "ideas", "opus", "claude-opus-5-5", None)
    assert row["cost_usd"] == pytest.approx(0.008)   # 1000 x 4 $ + 200 x 20 $ par MTok
    assert FAKE_KEY not in ledger_raw(state_dir)

    # 2. Le crédit s'épuise : le texte vient du CLI, l'alerte part sur le canal Oracle.
    rig.client.script.append(BadRequestError(CREDIT_MSG))
    assert llm._claude_text("le prompt", label="ideas") == "Réponse CLI"
    (cli_call,) = rig.cli.calls
    for name in KEY_VARS:
        assert name not in cli_call["env"]           # le CLI n'a pas vu la clé
    assert cli_call["cmd"][-2:] == ["--model", llm.DEFAULT_MODEL]
    assert cli_call["timeout"] == llm.DEFAULT_TIMEOUT
    last = ledger(state_dir)[-1]
    assert (last["backend"], last["fallback_reason"]) == ("cli", "credit_exhausted")
    assert len(rig.sent) == 1
    assert rig.sent[0].startswith("[Coach IA] ")
    assert "crédit" in rig.sent[0]
    assert FAKE_KEY not in rig.sent[0]

    # 3. API bloquée une heure : l'appel suivant va droit au CLI, sans nouveau
    #    client, sans nouvelle alerte (dédoublonnée).
    assert llm._claude_text("le prompt", label="ideas") == "Réponse CLI"
    assert len(rig.factory.kwargs) == 2              # 2 clients créés au total (appels 1 et 2)
    assert len(rig.cli.calls) == 2
    assert len(rig.sent) == 1
    assert ledger(state_dir)[-1]["fallback_reason"].startswith("blocked:")
    assert FAKE_KEY not in ledger_raw(state_dir)


@pytest.mark.real_llm
def test_cle_refusee_bascule_sur_le_cli_et_alerte(rig, state_dir):
    class AuthenticationError(Exception):
        status_code = 401
    rig.client.script.append(AuthenticationError("invalid x-api-key"))

    assert llm._claude_text("p", label="radar") == "Réponse CLI"

    assert ledger(state_dir)[-1]["fallback_reason"] == "key_invalid"
    assert len(rig.sent) == 1 and rig.sent[0].startswith("[Coach IA] ")
    assert FAKE_KEY not in rig.sent[0]


@pytest.mark.real_llm
def test_api_en_panne_garde_le_cli_comme_filet_sans_bloquer(rig, state_dir):
    class InternalServerError(Exception):
        status_code = 500
    rig.client.script.append(InternalServerError("boom"))

    assert llm._claude_text("p", label="radar") == "Réponse CLI"
    assert llm._claude_text("p", label="radar") == "Réponse API"   # l'API revient aussitôt

    assert [r["backend"] for r in ledger(state_dir)] == ["cli", "api"]
    assert rig.sent == []                      # une panne transitoire n'alerte personne


@pytest.mark.real_llm
def test_le_palier_se_change_sans_redeployer_par_llm_tier_overrides(rig, monkeypatch):
    monkeypatch.setenv("LLM_TIER_OVERRIDES", "ideas=haiku")
    llm._claude_text("p", label="ideas")
    llm._claude_text("p", label="coach_ask")          # non surchargé : reste opus
    assert [c["model"] for c in rig.client.calls] == ["claude-haiku-5-5", "claude-opus-5-5"]


@pytest.mark.real_llm
def test_le_budget_atteint_envoie_tout_au_cli(rig, monkeypatch, state_dir):
    monkeypatch.setenv("LLM_MONTHLY_BUDGET_USD", "0.001")
    llm._claude_text("p", label="radar")                          # ~0.002 $ : dépasse le plafond
    assert llm._claude_text("p", label="radar") == "Réponse CLI"
    assert len(rig.client.calls) == 1                             # plus aucun appel API
    assert ledger(state_dir)[-1]["fallback_reason"] == "budget_reached"


@pytest.mark.real_llm
def test_un_wrapper_public_traverse_toute_la_chaine_jusqu_a_l_api(rig, state_dir):
    """De `suggest_ideas` jusqu'au faux client : étiquette, palier et prompt
    arrivent intacts — la preuve de bout en bout que le rédacteur est branché."""
    assert llm.suggest_ideas({"x": 1}) == "Réponse API"
    (create,) = rig.client.calls
    assert create["model"] == "claude-opus-5-5"                  # ideas -> opus
    assert llm.SYSTEM_PROMPT in create["messages"][0]["content"]
    assert ledger(state_dir)[-1]["label"] == "ideas"
