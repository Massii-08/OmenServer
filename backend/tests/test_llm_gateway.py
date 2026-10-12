"""Tests de la passerelle LLM (backend/llm_gateway.py).

100 % hors-ligne et déterministes :
- le client Anthropic est INJECTÉ (``client_factory``) : jamais de réseau, et le
  SDK ``anthropic`` n'est PAS requis ;
- les exceptions du SDK sont simulées par des classes de MÊMES NOMS (le gateway
  classe les erreurs par nom, ``status_code`` et message, jamais par isinstance
  sur les classes du SDK) ;
- l'horloge est injectée (``now``) ;
- dossier d'état et fichier d'env vivent dans ``tmp_path`` : le vrai
  ``~/.config/omen-llm.env`` n'est jamais lu, le vrai état jamais écrit.
"""
import calendar
import itertools
import json
import logging
import os
import stat
import sys
import textwrap
import threading
import types
from types import SimpleNamespace

import pytest

from backend import llm_gateway as gw

KEY = "sk-ant-api03-TESTKEY-0123456789abcdefghij-NE-DOIT-JAMAIS-FUIR"
OTHER_KEY = "sk-ant-api03-AUTRECLE-9876543210zyxwvutsrq-ROTATION"
T0 = calendar.timegm((2026, 10, 15, 12, 0, 0))
MONTH = "2026-10"
T_NEXT_MONTH = calendar.timegm((2026, 11, 1, 0, 0, 5))
CREDIT_MSG = ("Your credit balance is too low to access the Anthropic API. "
              "Please go to Plans & Billing to upgrade or purchase credits.")
OPUS, SONNET, HAIKU = "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"

CONFIG_VARS = (
    "LLM_GATEWAY_API_KEY", "LLM_BACKEND", "LLM_MONTHLY_BUDGET_USD", "LLM_DOWNGRADE_AT",
    "LLM_MODEL_OPUS", "LLM_MODEL_SONNET", "LLM_MODEL_HAIKU", "LLM_TIER_OVERRIDES",
    "LLM_GATEWAY_STATE_DIR", "LLM_GATEWAY_ENV_FILE", "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
)


# --- exceptions factices : MÊMES NOMS que celles du SDK anthropic ------------
class _FakeSDKError(Exception):
    status_code = None

    def __init__(self, message="erreur", status_code=None):
        super().__init__(message)
        self.message = message
        if status_code is not None:
            self.status_code = status_code


class BadRequestError(_FakeSDKError):
    status_code = 400


class AuthenticationError(_FakeSDKError):
    status_code = 401


class PermissionDeniedError(_FakeSDKError):
    status_code = 403


class NotFoundError(_FakeSDKError):
    status_code = 404


class RateLimitError(_FakeSDKError):
    status_code = 429


class InternalServerError(_FakeSDKError):
    status_code = 500


class OverloadedError(_FakeSDKError):
    status_code = 529


class APIStatusError(_FakeSDKError):
    pass


class APIError(Exception):
    pass


class APIConnectionError(Exception):
    pass


class APITimeoutError(APIConnectionError):   # comme dans le SDK
    pass


# --- faux client Anthropic -----------------------------------------------------
def make_resp(text="Réponse", *, inp=1000, out=200, cache_read=0, cache_write=0,
              stop="end_turn", rid="req_test", thinking=False):
    content = []
    if thinking:
        content.append(SimpleNamespace(type="thinking", thinking="", signature="sig"))
    if text is not None:
        content.append(SimpleNamespace(type="text", text=text))
    usage = SimpleNamespace(input_tokens=inp, output_tokens=out,
                            cache_read_input_tokens=cache_read,
                            cache_creation_input_tokens=cache_write)
    return SimpleNamespace(content=content, usage=usage, stop_reason=stop,
                           stop_details=None, _request_id=rid)


class _FakeMessages:
    def __init__(self, owner):
        self._owner = owner

    def create(self, **kw):
        return self._owner._handle(kw)


class FakeClient:
    """``.messages.create(**kw)`` programmable : ``script`` consommé dans l'ordre,
    puis ``default``. Une action est une réponse, une exception (levée) ou un
    callable ``f(kwargs)`` qui rend l'une ou l'autre."""

    def __init__(self, *script, default=None):
        self.script = list(script)
        self.default = default if default is not None else make_resp()
        self.calls = []
        self.closed = 0
        self.messages = _FakeMessages(self)
        self._lock = threading.Lock()

    def _handle(self, kw):
        with self._lock:
            self.calls.append(kw)
            action = self.script.pop(0) if self.script else self.default
        if callable(action):
            action = action(kw)
        if isinstance(action, BaseException):
            raise action
        return action

    def close(self):
        self.closed += 1


class Factory:
    def __init__(self, client):
        self.client = client
        self.kwargs = []

    def __call__(self, **kw):
        self.kwargs.append(kw)
        return self.client

    @property
    def created(self):
        return len(self.kwargs)


class Cli:
    def __init__(self, text="via CLI", exc=None):
        self.text, self.exc, self.calls = text, exc, 0

    def __call__(self):
        self.calls += 1
        if self.exc is not None:
            raise self.exc
        return self.text


class Clock:
    def __init__(self, t=T0):
        self.t = float(t)

    def __call__(self):
        return self.t


class Env:
    def __init__(self, tmp_path, monkeypatch):
        self.mp = monkeypatch
        self.state_dir = tmp_path / "state"
        self.env_file = tmp_path / "omen-llm.env"

    def set(self, name, value):
        self.mp.setenv(name, value)

    def write_env(self, text, bump=0):
        """Écrit le fichier d'env et fixe son mtime (déterministe, quelle que
        soit la résolution d'horodatage du système de fichiers)."""
        self.env_file.write_text(text, encoding="utf-8")
        t = 1_700_000_000 + bump
        os.utime(str(self.env_file), (t, t))

    def ledger_raw(self, month=MONTH):
        path = self.state_dir / ("usage-%s.jsonl" % month)
        return path.read_text(encoding="utf-8") if path.exists() else ""

    def ledger(self, month=MONTH):
        return [json.loads(line) for line in self.ledger_raw(month).splitlines() if line]

    def state(self):
        return json.loads((self.state_dir / "state.json").read_text(encoding="utf-8"))

    def seed_spend(self, amount, month=MONTH):
        """Ajoute une ligne API déjà facturée (format documenté du journal)."""
        os.makedirs(str(self.state_dir), mode=0o700, exist_ok=True)
        rec = {"ts": T0, "label": "seed", "backend": "api", "model": SONNET,
               "tier": "sonnet", "in": 0, "out": 0, "cache_read": 0, "cache_write": 0,
               "cost_usd": amount, "fallback_reason": None, "request_id": None}
        with open(str(self.state_dir / ("usage-%s.jsonl" % month)), "a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")


@pytest.fixture
def env(tmp_path, monkeypatch):
    for name in CONFIG_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("LLM_GATEWAY_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("LLM_GATEWAY_ENV_FILE", str(tmp_path / "omen-llm.env"))
    monkeypatch.setattr(gw, "_WARNED", set())
    monkeypatch.setattr(gw, "_MEM_ALERTS", {})
    return Env(tmp_path, monkeypatch)


def _call(fac, cli=None, clock=None, notify=None, **kw):
    kw.setdefault("label", "test")
    return gw.complete("prompt", cli=cli or Cli(), client_factory=fac,
                       now=clock or Clock(), notify=notify, **kw)


# --- 1. pas de clé -------------------------------------------------------------
def test_sans_cle_passe_par_le_cli_sans_creer_de_client(env):
    fac, cli = Factory(FakeClient()), Cli("texte cli")
    r = _call(fac, cli, label="coach")
    assert (r.backend, r.text, r.model, r.fallback_reason) == ("cli", "texte cli", "cli", "no_key")
    assert r.usage == {} and r.cost_usd == 0.0
    assert fac.created == 0                       # client jamais créé
    rows = env.ledger()
    assert len(rows) == 1
    assert rows[0]["backend"] == "cli" and rows[0]["fallback_reason"] == "no_key"
    assert rows[0]["label"] == "coach" and rows[0]["cost_usd"] == 0


def test_anthropic_api_key_nest_jamais_lue(env):
    env.set("ANTHROPIC_API_KEY", KEY)             # seule LLM_GATEWAY_API_KEY compte
    fac = Factory(FakeClient())
    assert _call(fac).fallback_reason == "no_key"
    assert fac.created == 0


# --- 2. clé dans l'environnement -> API ------------------------------------------
def test_cle_par_env_appel_api_cout_exact(env):
    env.set(gw.KEY_VAR, KEY)
    client = FakeClient(make_resp("  Bonjour  ", inp=10000, out=1000, rid="req_abc"))
    fac, cli = Factory(client), Cli()
    r = _call(fac, cli, label="coach", tier="opus")
    assert (r.backend, r.text, r.model, r.fallback_reason) == ("api", "Bonjour", OPUS, None)
    assert r.cost_usd == pytest.approx(0.06)      # 10 000 x 4 $ + 1 000 x 20 $ par MTok
    assert r.usage == {"input_tokens": 10000, "output_tokens": 1000,
                       "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
    assert cli.calls == 0
    assert fac.kwargs == [{"api_key": KEY, "timeout": 300.0, "max_retries": 1}]
    assert client.closed == 1
    (row,) = env.ledger()
    assert row["backend"] == "api" and row["model"] == OPUS and row["tier"] == "opus"
    assert (row["in"], row["out"], row["cache_read"], row["cache_write"]) == (10000, 1000, 0, 0)
    assert row["cost_usd"] == pytest.approx(0.06)
    assert row["request_id"] == "req_abc" and row["fallback_reason"] is None
    assert set(row) == {"ts", "label", "backend", "model", "tier", "in", "out", "cache_read",
                        "cache_write", "cost_usd", "fallback_reason", "request_id"}


def test_texte_concatene_les_blocs_text_et_ignore_thinking(env):
    env.set(gw.KEY_VAR, KEY)
    resp = make_resp(None)
    # Un bloc non-« text » qui porterait quand même un attribut .text ne doit
    # jamais fuiter dans la réponse : le filtre est sur le TYPE du bloc.
    resp.content = [SimpleNamespace(type="thinking", thinking="je réfléchis", signature="s",
                                    text="RÉFLEXION À NE PAS INCLURE"),
                    SimpleNamespace(type="text", text="Bon"),
                    SimpleNamespace(type="redacted_thinking", data="xx"),
                    {"type": "text", "text": "jour \n"}]          # forme dict tolérée aussi
    assert _call(Factory(FakeClient(resp))).text == "Bonjour"


# --- 3. fichier d'env relu à chaud ---------------------------------------------------
def test_cle_et_interrupteur_via_fichier_env_relu_a_chaud(env):
    client = FakeClient(default=make_resp("api"))
    fac, clock = Factory(client), Clock()

    def call():
        return _call(fac, Cli("cli"), clock)

    env.write_env("# pas encore de clé\nLLM_BACKEND=auto\n")
    assert call().fallback_reason == "no_key"
    env.write_env('# config\nexport LLM_GATEWAY_API_KEY="%s"\nLLM_BACKEND=auto  # normal\n'
                  % KEY, bump=10)
    assert call().backend == "api"
    # Interrupteur d'urgence : même taille, même inode, seul le mtime change.
    env.write_env('# config\nexport LLM_GATEWAY_API_KEY="%s"\nLLM_BACKEND=cli   # normal\n'
                  % KEY, bump=20)
    r = call()
    assert r.backend == "cli" and r.fallback_reason == "backend_cli"
    assert len(client.calls) == 1


def test_fichier_env_formats_et_precedence(env):
    env.write_env(textwrap.dedent("""\
        # commentaire
        LLM_MONTHLY_BUDGET_USD = '12,5'
        LLM_TIER_OVERRIDES="ideas=haiku"   # commentaire en ligne
        export LLM_DOWNGRADE_AT=0.75
        LIGNE INVALIDE
        LLM_MODEL_SONNET=claude-sonnet-4-6 # commentaire
        LLM_BACKEND=cli
        """))
    env.set("LLM_BACKEND", "auto")                # le process prime sur le fichier
    st = gw.status(now=Clock())
    assert st["mode"] == "auto"
    assert st["budget_usd"] == 12.5 and st["downgrade_at"] == 0.75
    assert st["models"]["sonnet"] == "claude-sonnet-4-6"
    assert st["tier_overrides"] == {"ideas": "haiku"}
    env.set("LLM_BACKEND", "")                    # vide = non défini : le fichier reprend la main
    assert gw.status(now=Clock())["mode"] == "cli"


def test_valeurs_invalides_retombent_sur_les_defauts(env, caplog):
    caplog.set_level(logging.WARNING, logger="omenserver")
    env.set("LLM_BACKEND", "turbo")
    env.set("LLM_MONTHLY_BUDGET_USD", "beaucoup")
    env.set("LLM_DOWNGRADE_AT", "-1")
    st = gw.status(now=Clock())
    assert (st["mode"], st["budget_usd"], st["downgrade_at"]) == ("auto", 90.0, 0.6)
    assert "turbo" in caplog.text and "beaucoup" in caplog.text


# --- 4. LLM_BACKEND -------------------------------------------------------------------
def test_llm_backend_cli_force_le_cli_meme_avec_cle(env):
    env.set(gw.KEY_VAR, KEY)
    env.set("LLM_BACKEND", "cli")
    fac = Factory(FakeClient())
    r = _call(fac)
    assert r.backend == "cli" and r.fallback_reason == "backend_cli"
    assert fac.created == 0


def test_llm_backend_api_sans_repli_leve_gateway_error(env):
    env.set(gw.KEY_VAR, KEY)
    env.set("LLM_BACKEND", "api")
    cli = Cli()
    fac = Factory(FakeClient(RateLimitError("rate limited")))
    with pytest.raises(gw.GatewayError) as ei:
        _call(fac, cli)
    assert "API: rate_limit" in str(ei.value) and ei.value.api_reason == "rate_limit"
    assert cli.calls == 0
    # Réponse facturée mais tronquée : journalisée, puis GatewayError (pas de repli).
    with pytest.raises(gw.GatewayError, match="truncated"):
        _call(Factory(FakeClient(make_resp('{"a":', stop="max_tokens"))), cli)
    assert cli.calls == 0
    assert [r["backend"] for r in env.ledger()] == ["api"]
    # Sans clé : même règle.
    env.mp.delenv(gw.KEY_VAR)
    with pytest.raises(gw.GatewayError, match="API: no_key"):
        _call(Factory(FakeClient()), cli)
    assert cli.calls == 0


# --- 5. crédit épuisé -----------------------------------------------------------------
def test_credit_epuise_bloque_1h_alerte_unique_puis_retente(env):
    env.set(gw.KEY_VAR, KEY)
    clock, alerts = Clock(), []
    client = FakeClient(default=BadRequestError(CREDIT_MSG))
    fac, cli = Factory(client), Cli("cli")

    def call():
        return _call(fac, cli, clock, notify=alerts.append, label="coach")

    r = call()
    assert (r.backend, r.text, r.fallback_reason) == ("cli", "cli", "credit_exhausted")
    assert len(alerts) == 1
    assert "crédit" in alerts[0] and "console.anthropic.com" in alerts[0] and "1 h" in alerts[0]
    state = env.state()
    assert state["api_blocked_until"] == T0 + 3600
    assert state["blocked_reason"] == "credit_exhausted"
    # Dans la fenêtre : l'API n'est pas touchée.
    clock.t = T0 + 1800
    r = call()
    assert r.fallback_reason == "blocked:credit_exhausted"
    assert len(client.calls) == 1 and len(alerts) == 1
    # Après expiration : l'API est retentée.
    clock.t = T0 + 3601
    client.default = make_resp("l'API est revenue")
    r = call()
    assert (r.backend, r.text) == ("api", "l'API est revenue")
    assert len(client.calls) == 2
    # La panne revient dans les 6 h : nouveau blocage, mais pas de 2e alerte.
    client.default = BadRequestError(CREDIT_MSG)
    clock.t = T0 + 4000
    assert call().fallback_reason == "credit_exhausted"
    assert len(alerts) == 1
    assert env.state()["api_blocked_until"] == T0 + 4000 + 3600


def _billing_type_error():
    e = APIError("billing")
    e.type = "billing_error"
    return e


def _credit_in_body_error():
    e = APIStatusError("Error code: 400", status_code=400)
    e.body = {"type": "error", "error": {"type": "invalid_request_error", "message": CREDIT_MSG}}
    return e


@pytest.mark.parametrize("make_exc", [
    lambda: APIStatusError("payment required", status_code=402),
    lambda: BadRequestError("This request would exceed your organization's spend limit."),
    lambda: BadRequestError("You have reached your specified API usage limits."),
    lambda: RateLimitError("Workspace API usage limits reached for this month."),
    _billing_type_error,
    _credit_in_body_error,
])
def test_variantes_de_credit_epuise(env, make_exc):
    env.set(gw.KEY_VAR, KEY)
    r = _call(Factory(FakeClient(make_exc())))
    assert r.fallback_reason == "credit_exhausted"
    assert env.state()["blocked_reason"] == "credit_exhausted"


# --- 6. clé refusée -------------------------------------------------------------------
@pytest.mark.parametrize("make_exc", [
    lambda: AuthenticationError("invalid x-api-key"),
    lambda: PermissionDeniedError("Your API key does not have permission"),
    lambda: APIStatusError("unauthorized", status_code=401),
])
def test_cle_refusee_bloque_6h_et_alerte(env, make_exc):
    env.set(gw.KEY_VAR, KEY)
    clock, alerts = Clock(), []
    client = FakeClient(make_exc(), default=make_resp("ok"))
    fac = Factory(client)
    r = _call(fac, clock=clock, notify=alerts.append)
    assert r.backend == "cli" and r.fallback_reason == "key_invalid"
    assert len(alerts) == 1 and "clé" in alerts[0] and "console.anthropic.com" in alerts[0]
    assert str(env.env_file) in alerts[0]
    assert env.state()["api_blocked_until"] == T0 + 6 * 3600
    clock.t = T0 + 6 * 3600 - 1
    assert _call(fac, clock=clock).fallback_reason == "blocked:key_invalid"
    assert len(client.calls) == 1
    clock.t = T0 + 6 * 3600 + 1
    assert _call(fac, clock=clock).backend == "api"
    assert len(client.calls) == 2 and len(alerts) == 1


def test_nouvelle_cle_leve_le_blocage(env):
    env.set(gw.KEY_VAR, KEY)
    clock = Clock()
    client = FakeClient(AuthenticationError("invalid x-api-key"),
                        default=make_resp("ok avec la nouvelle clé"))
    fac = Factory(client)
    assert _call(fac, clock=clock).fallback_reason == "key_invalid"
    clock.t += 60
    assert _call(fac, clock=clock).fallback_reason == "blocked:key_invalid"
    env.set(gw.KEY_VAR, OTHER_KEY)                # Massii remplace la clé dans le fichier
    r = _call(fac, clock=clock)
    assert r.backend == "api" and fac.kwargs[-1]["api_key"] == OTHER_KEY


def test_commande_unblock_leve_le_blocage(env, capsys):
    env.set(gw.KEY_VAR, KEY)
    client = FakeClient(BadRequestError(CREDIT_MSG), default=make_resp("ok"))
    fac = Factory(client)
    # horloge réelle : la commande unblock lit time.time()
    gw.complete("p", label="x", cli=Cli(), client_factory=fac)
    assert gw.status()["blocked"] is True
    assert gw.main(["unblock"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out == {"unblocked": True, "previous_reason": "credit_exhausted"}
    assert gw.status()["blocked"] is False
    assert gw.complete("p", label="x", cli=Cli(), client_factory=fac).backend == "api"


# --- 7. erreurs transitoires : repli SANS blocage --------------------------------------
@pytest.mark.parametrize("make_exc, reason", [
    (lambda: RateLimitError("Number of requests has exceeded your rate limit"), "rate_limit"),
    (lambda: OverloadedError("Overloaded"), "overloaded"),
    (lambda: APIStatusError("overloaded_error", status_code=529), "overloaded"),
    (lambda: InternalServerError("overloaded_error", status_code=529), "overloaded"),
    (lambda: InternalServerError("Internal server error"), "server_error"),
    (lambda: APIStatusError("bad gateway", status_code=502), "server_error"),
    (lambda: APITimeoutError("Request timed out."), "timeout"),
    (lambda: TimeoutError("timed out"), "timeout"),
    (lambda: APIConnectionError("Connection error."), "connection"),
    (lambda: ConnectionRefusedError("refused"), "connection"),
    (lambda: ValueError("forme inattendue"), "other"),
])
def test_erreurs_transitoires_repli_sans_blocage(env, make_exc, reason):
    env.set(gw.KEY_VAR, KEY)
    clock, alerts = Clock(), []
    client = FakeClient(make_exc(), default=make_resp("revenu"))
    fac = Factory(client)
    r = _call(fac, Cli("cli"), clock, notify=alerts.append)
    assert (r.backend, r.fallback_reason) == ("cli", reason)
    assert alerts == []
    assert gw.status(now=clock)["blocked"] is False
    r = _call(fac, clock=clock)                   # l'appel suivant retente l'API
    assert r.backend == "api" and len(client.calls) == 2


def test_bad_request_logge_en_error_sans_blocage(env, caplog):
    caplog.set_level(logging.WARNING, logger="omenserver")
    env.set(gw.KEY_VAR, KEY)
    clock = Clock()
    client = FakeClient(BadRequestError("messages.0.content: Input should be a valid string"),
                        NotFoundError("model: claude-opus-9-9"), default=make_resp("ok"))
    fac = Factory(client)
    assert _call(fac, clock=clock).fallback_reason == "bad_request"
    errors = [rec.getMessage() for rec in caplog.records if rec.levelno == logging.ERROR]
    assert any("Input should be a valid string" in m for m in errors)
    assert _call(fac, clock=clock).fallback_reason == "bad_request"   # 404 modèle inconnu
    assert gw.status(now=clock)["blocked"] is False
    assert _call(fac, clock=clock).backend == "api"


# --- 8. réponses API écartées ----------------------------------------------------------
@pytest.mark.parametrize("resp, reason", [
    (make_resp("Je ne peux pas aider avec ça.", stop="refusal"), "refusal"),
    (make_resp('{"plan": [1, 2', stop="max_tokens"), "truncated"),
    (make_resp("   \n "), "empty"),
    (make_resp(None, thinking=True), "empty"),
])
def test_reponse_api_ecartee_repli_et_cout_journalise(env, resp, reason):
    env.set(gw.KEY_VAR, KEY)
    clock = Clock()
    r = _call(Factory(FakeClient(resp)), Cli("cli"), clock, tier="sonnet")
    assert (r.backend, r.text, r.fallback_reason) == ("cli", "cli", reason)
    rows = env.ledger()
    assert [x["backend"] for x in rows] == ["api", "cli"]
    # La réponse écartée a été FACTURÉE : elle compte dans le budget.
    assert rows[0]["fallback_reason"] == reason and rows[0]["cost_usd"] > 0
    assert rows[1]["fallback_reason"] == reason
    st = gw.status(now=clock)
    assert st["spent_usd"] > 0 and st["blocked"] is False


# --- 9. tout échoue ----------------------------------------------------------------------
def test_api_et_cli_en_echec_gateway_error(env):
    env.set(gw.KEY_VAR, KEY)
    fac = Factory(FakeClient(RateLimitError("rate limited")))
    cli = Cli(exc=RuntimeError("claude cli rc=1: session expirée"))
    with pytest.raises(gw.GatewayError) as ei:
        _call(fac, cli)
    err = ei.value
    assert isinstance(err, RuntimeError)
    assert "API: rate_limit" in str(err) and "CLI:" in str(err) and "session expirée" in str(err)
    assert err.api_reason == "rate_limit"
    assert env.ledger() == []                     # rien n'a été servi
    env.mp.delenv(gw.KEY_VAR)
    with pytest.raises(gw.GatewayError, match="API: no_key; CLI: RuntimeError"):
        _call(fac, cli)


@pytest.mark.parametrize("out, needle", [("  \n ", "réponse vide"), (None, "retour non textuel")])
def test_cli_vide_ou_non_textuel_est_un_echec(env, out, needle):
    with pytest.raises(gw.GatewayError, match=needle):
        _call(Factory(FakeClient()), Cli(out))


def test_cli_qui_rend_des_octets_est_decode(env):
    assert _call(Factory(FakeClient()), Cli("réponse".encode("utf-8"))).text == "réponse"


# --- 10. budget -------------------------------------------------------------------------
def test_budget_alertes_80_100_puis_nouveau_mois(env):
    env.set(gw.KEY_VAR, KEY)
    env.set("LLM_MONTHLY_BUDGET_USD", "1.00")
    clock, alerts = Clock(), []
    client = FakeClient(default=make_resp("ok", inp=1000, out=100))   # sonnet : 0.003 $
    fac, cli = Factory(client), Cli("cli")

    def call():
        return _call(fac, cli, clock, notify=alerts.append, label="budget")

    env.seed_spend(0.70)
    assert call().backend == "api" and alerts == []
    env.seed_spend(0.10)                          # ~80 %
    assert call().backend == "api"                # à 80 % l'API sert toujours
    assert len(alerts) == 1 and "80 %" in alerts[0]
    call()
    assert len(alerts) == 1                       # une fois par mois et par seuil
    env.seed_spend(0.25)                          # > 100 %
    n_api = len(client.calls)
    r = call()
    assert (r.backend, r.fallback_reason) == ("cli", "budget_reached")
    assert len(client.calls) == n_api             # l'API n'est pas touchée
    assert len(alerts) == 2 and "budget API mensuel atteint" in alerts[1]
    call()
    assert len(alerts) == 2
    # Nouveau mois : compteur remis à zéro.
    clock.t = T_NEXT_MONTH
    r = call()
    assert r.backend == "api" and len(alerts) == 2
    assert env.ledger("2026-11")[0]["backend"] == "api"


def test_budget_saut_direct_a_100_une_seule_alerte(env):
    env.set(gw.KEY_VAR, KEY)
    env.set("LLM_MONTHLY_BUDGET_USD", "1")
    env.seed_spend(2.0)
    alerts = []
    r = _call(Factory(FakeClient()), notify=alerts.append)
    assert r.fallback_reason == "budget_reached"
    assert len(alerts) == 1 and "atteint" in alerts[0]
    assert set(env.state()["alerts"]) == {"budget80:" + MONTH, "budget100:" + MONTH}


def test_journal_corrompu_ou_lignes_cli_ne_faussent_pas_la_depense(env):
    env.seed_spend(0.5)
    with open(str(env.state_dir / ("usage-%s.jsonl" % MONTH)), "a", encoding="utf-8") as f:
        f.write("pas du json\n[1, 2]\n")
        f.write(json.dumps({"backend": "cli", "cost_usd": 99}) + "\n")
        f.write(json.dumps({"backend": "api", "cost_usd": "n/a"}) + "\n")
    assert gw.status(now=Clock())["spent_usd"] == pytest.approx(0.5)


# --- 11. rétrogradation opus -> sonnet -----------------------------------------------------
def test_retrogradation_opus_vers_sonnet(env):
    env.set(gw.KEY_VAR, KEY)
    env.set("LLM_MONTHLY_BUDGET_USD", "10")
    client = FakeClient(default=make_resp("ok", inp=10, out=10))
    fac, clock = Factory(client), Clock()
    env.seed_spend(5.99)                          # 59.9 %
    assert _call(fac, clock=clock, tier="opus").model == OPUS
    env.seed_spend(0.01)                          # >= 60 %
    r = _call(fac, clock=clock, tier="opus")
    assert r.model == SONNET and client.calls[-1]["model"] == SONNET
    # la profondeur demandée (effort du tier opus) est conservée
    assert client.calls[-1]["output_config"] == {"effort": "medium"}
    row = env.ledger()[-1]
    assert row["tier"] == "opus" and row["model"] == SONNET
    assert _call(fac, clock=clock, tier="haiku").model == HAIKU
    assert _call(fac, clock=clock, model=OPUS).model == OPUS   # id explicite : tel quel
    env.set("LLM_DOWNGRADE_AT", "0.9")
    assert _call(fac, clock=clock, tier="opus").model == OPUS
    assert gw.status(now=clock)["opus_served_by_sonnet"] is False


def test_resolve_model_seuil_de_retrogradation(env):
    assert gw.resolve_model("opus") == OPUS
    assert gw.resolve_model("opus", spend_ratio=0.59) == OPUS
    assert gw.resolve_model("opus", spend_ratio=0.6) == SONNET
    assert gw.resolve_model("sonnet", spend_ratio=0.99) == SONNET
    assert gw.resolve_model("HAIKU") == HAIKU
    assert gw.resolve_model("claude-custom-9") == "claude-custom-9"


# --- 12. surcharges ----------------------------------------------------------------------
def test_surcharges_tier_et_modeles(env):
    env.set(gw.KEY_VAR, KEY)
    env.set("LLM_MODEL_OPUS", "claude-opus-4-8")
    env.set("LLM_TIER_OVERRIDES", "ideas=haiku, Radar=opus ,cassé, =sonnet")
    client = FakeClient(default=make_resp("ok"))
    fac = Factory(client)
    r = _call(fac, label="ideas", tier="opus")
    assert r.model == HAIKU and client.calls[-1]["output_config"] == {"effort": "low"}
    assert env.ledger()[-1]["tier"] == "haiku"
    r = _call(fac, label="radar", tier="sonnet")
    assert r.model == "claude-opus-4-8"
    assert client.calls[-1]["output_config"] == {"effort": "medium"}
    assert gw.resolve_model("opus") == "claude-opus-4-8"
    assert gw.resolve_model("sonnet", label="RADAR") == "claude-opus-4-8"
    assert gw.resolve_model("sonnet", label="autre") == SONNET
    assert gw.status(now=Clock())["tier_overrides"] == {"ideas": "haiku", "radar": "opus"}


def test_effort_jamais_envoye_par_defaut_a_un_modele_qui_le_refuse(env):
    env.set(gw.KEY_VAR, KEY)
    env.set("LLM_MODEL_HAIKU", "claude-haiku-4-5")   # Haiku 4.5 : pas d'effort
    client = FakeClient(default=make_resp("ok"))
    fac = Factory(client)
    _call(fac, tier="haiku")
    assert client.calls[-1]["model"] == "claude-haiku-4-5"
    assert "output_config" not in client.calls[-1]
    _call(fac, tier="haiku", effort="high")          # demandé explicitement : transmis
    assert client.calls[-1]["output_config"] == {"effort": "high"}
    _call(fac, model="claude-fable-5-1")             # hors tiers : pas d'effort par défaut
    assert "output_config" not in client.calls[-1]
    _call(fac, model="claude-opus-4-5-20251101")     # id daté d'un modèle compatible
    assert client.calls[-1]["output_config"] == {"effort": "medium"}


# --- 13. cli_env ----------------------------------------------------------------------------
def test_cli_env_retire_les_cles_et_preserve_le_reste(env):
    base = {"PATH": "/usr/bin", "HOME": "/home/m", "CLAUDE_BIN": "/opt/claude",
            "ANTHROPIC_API_KEY": KEY, "ANTHROPIC_AUTH_TOKEN": "jeton",
            "LLM_GATEWAY_API_KEY": KEY}
    assert gw.cli_env(base) == {"PATH": "/usr/bin", "HOME": "/home/m", "CLAUDE_BIN": "/opt/claude"}
    assert "ANTHROPIC_API_KEY" in base               # copie : la base n'est pas modifiée
    env.set("ANTHROPIC_API_KEY", KEY)
    env.set(gw.KEY_VAR, KEY)
    out = gw.cli_env()
    assert "ANTHROPIC_API_KEY" not in out and gw.KEY_VAR not in out
    assert out.get("PATH") == os.environ.get("PATH")


# --- 14. concurrence -----------------------------------------------------------------------
def test_concurrence_journal_toujours_json_valide(env):
    env.set(gw.KEY_VAR, KEY)
    counter, lock = itertools.count(), threading.Lock()

    def behaviour(kw):
        with lock:
            n = next(counter)
        return RateLimitError("rate limit") if n % 3 == 0 else make_resp("ok", inp=100, out=10)

    fac, clock, errors = Factory(FakeClient(default=behaviour)), Clock(), []

    def worker(i):
        for _ in range(25):
            try:
                r = gw.complete("p", label="w%d" % i, cli=lambda: "cli ok",
                                client_factory=fac, now=clock)
                assert r.text in ("ok", "cli ok")
            except Exception as e:   # remonté au thread principal
                errors.append(e)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert errors == []
    raw = env.ledger_raw()
    lines = raw.splitlines()
    assert len(lines) == 200 and raw.endswith("\n")
    records = [json.loads(line) for line in lines]   # chaque ligne est du JSON valide
    cli_rows = [r for r in records if r["backend"] == "cli"]
    assert len(cli_rows) == 67 and all(r["fallback_reason"] == "rate_limit" for r in cli_rows)
    assert gw.month_summary(now=clock)["totals"]["calls"] == 200


def test_concurrence_alerte_credit_unique(env):
    env.set(gw.KEY_VAR, KEY)
    barrier = threading.Barrier(8)

    def behaviour(kw):
        barrier.wait(timeout=20)                  # les 8 appels sont en vol en même temps
        return BadRequestError(CREDIT_MSG)

    fac, clock = Factory(FakeClient(default=behaviour)), Clock()
    alerts, results, errors = [], [], []

    def worker():
        try:
            results.append(gw.complete("p", label="par", cli=lambda: "cli", client_factory=fac,
                                       notify=alerts.append, now=clock))
        except Exception as e:
            errors.append(e)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert errors == []
    assert len(results) == 8 and all(r.fallback_reason == "credit_exhausted" for r in results)
    assert len(alerts) == 1
    assert gw.status(now=clock)["blocked_reason"] == "credit_exhausted"


# --- 15. la clé ne fuit nulle part ----------------------------------------------------------
def test_la_cle_napparait_nulle_part(env, caplog, capsys):
    caplog.set_level(logging.DEBUG, logger="omenserver")
    env.set(gw.KEY_VAR, KEY)
    env.set("LLM_MONTHLY_BUDGET_USD", "0.05")
    clock, alerts = Clock(), []

    # a) une erreur réseau ET un CLI en panne qui citent la clé
    leaky = FakeClient(APIConnectionError("échec TLS (x-api-key: %s)" % KEY))
    with pytest.raises(gw.GatewayError) as ei:
        _call(Factory(leaky), Cli(exc=RuntimeError("le CLI a vu %s" % KEY)), clock,
              notify=alerts.append)
    err = ei.value
    assert KEY not in str(err) and "connection" in str(err)
    # aucune exception d'origine (qui citait la clé) n'est chaînée
    assert err.__cause__ is None and err.__context__ is None
    # b) bad_request loggué en ERROR avec son message (masqué)
    _call(Factory(FakeClient(BadRequestError("bad request for %s" % KEY))), clock=clock)
    # c) crédit épuisé -> état + alerte
    _call(Factory(FakeClient(BadRequestError(CREDIT_MSG))), clock=clock, notify=alerts.append)
    # d) clé refusée avec une AUTRE clé -> nouveau blocage + alerte
    env.set(gw.KEY_VAR, OTHER_KEY)
    _call(Factory(FakeClient(AuthenticationError("invalid x-api-key"))), clock=clock,
          notify=alerts.append)
    # e) retour à la clé d'origine : succès API (journal), puis budget dépassé (alerte)
    env.set(gw.KEY_VAR, KEY)
    assert _call(Factory(FakeClient(make_resp("ok", inp=10000, out=1000))), clock=clock,
                 tier="opus").backend == "api"
    assert _call(Factory(FakeClient()), clock=clock,
                 notify=alerts.append).fallback_reason == "budget_reached"
    assert len(alerts) == 3                       # crédit, clé refusée, budget

    blob = " ".join([json.dumps(gw.status(now=clock)), json.dumps(gw.month_summary(now=clock)),
                     caplog.text, " ".join(alerts)])
    assert gw.main(["status"]) == 0
    blob += capsys.readouterr().out
    for secret in (KEY, OTHER_KEY):
        assert secret not in blob
    files = [p for p in env.state_dir.rglob("*") if p.is_file()]
    assert len(files) >= 3                        # journal, état, verrou
    for path in files:
        data = path.read_bytes()
        assert KEY.encode() not in data and OTHER_KEY.encode() not in data


def test_cle_sans_prefixe_reconnaissable_masquee_aussi(env, caplog):
    caplog.set_level(logging.DEBUG, logger="omenserver")
    odd = "cle-maison-SANS-prefixe-42"
    env.set(gw.KEY_VAR, odd)
    with pytest.raises(gw.GatewayError) as ei:
        _call(Factory(FakeClient(APIConnectionError("refus pour %s" % odd))),
              Cli(exc=RuntimeError("cli: %s" % odd)))
    assert odd not in str(ei.value) and odd not in caplog.text


# --- 16. notify qui lève --------------------------------------------------------------------
def test_notify_qui_leve_ne_casse_rien(env, caplog):
    caplog.set_level(logging.WARNING, logger="omenserver")
    env.set(gw.KEY_VAR, KEY)
    env.set("LLM_MONTHLY_BUDGET_USD", "1")
    clock = Clock()

    def boom(text):
        raise RuntimeError("telegram KO token=123456:SECRETBOT")

    r = _call(Factory(FakeClient(BadRequestError(CREDIT_MSG))), Cli("cli"), clock, notify=boom)
    assert r.backend == "cli" and r.fallback_reason == "credit_exhausted"
    env.seed_spend(5.0)
    r = _call(Factory(FakeClient()), Cli("cli"), clock, notify=boom)   # alerte budget : boom aussi
    assert r.backend == "cli"
    assert "notify a échoué" in caplog.text and "SECRETBOT" not in caplog.text


def test_alerte_sans_notify_ne_consomme_pas_le_creneau(env):
    env.set(gw.KEY_VAR, KEY)
    clock, alerts = Clock(), []
    fac = Factory(FakeClient(default=BadRequestError(CREDIT_MSG)))
    _call(fac, clock=clock)                       # pas de canal : rien à marquer
    clock.t += 3601                               # blocage expiré
    _call(fac, clock=clock, notify=alerts.append)
    assert len(alerts) == 1                       # l'appelant suivant (avec canal) alerte


# --- 17. SDK absent / factory par défaut ------------------------------------------------------
def test_sdk_absent_bascule_cli_et_avertit_une_seule_fois(env, monkeypatch, caplog):
    caplog.set_level(logging.WARNING, logger="omenserver")
    monkeypatch.setitem(sys.modules, "anthropic", None)    # « import anthropic » -> ImportError
    env.set(gw.KEY_VAR, KEY)
    clock = Clock()
    for _ in range(2):
        r = gw.complete("p", label="x", cli=Cli("cli"), now=clock)   # factory par défaut
        assert (r.backend, r.fallback_reason) == ("cli", "sdk_missing")
    warnings = [rec for rec in caplog.records
                if rec.levelno == logging.WARNING and "anthropic" in rec.getMessage()]
    assert len(warnings) == 1
    assert gw.status(now=clock)["sdk_installed"] is False


def test_factory_qui_leve_importerror_vaut_sdk_missing(env):
    env.set(gw.KEY_VAR, KEY)

    def factory(**kw):
        raise ImportError("No module named 'anthropic'")

    r = gw.complete("p", label="x", cli=Cli("cli"), client_factory=factory, now=Clock())
    assert (r.backend, r.fallback_reason) == ("cli", "sdk_missing")


def test_factory_par_defaut_passe_la_cle_explicitement(env, monkeypatch):
    env.set(gw.KEY_VAR, KEY)
    client, captured = FakeClient(make_resp("via le SDK factice")), []

    def Anthropic(**kw):            # même nom que le constructeur du SDK
        captured.append(kw)
        return client

    fake_sdk = types.ModuleType("anthropic")
    fake_sdk.Anthropic = Anthropic
    monkeypatch.setitem(sys.modules, "anthropic", fake_sdk)
    r = gw.complete("p", label="x", cli=Cli(), timeout=42.0, now=Clock())
    assert (r.backend, r.text) == ("api", "via le SDK factice")
    assert captured == [{"api_key": KEY, "timeout": 42.0, "max_retries": 1}]
    assert client.closed == 1


# --- 18. status / month_summary ----------------------------------------------------------------
def test_status_et_month_summary(env, monkeypatch):
    monkeypatch.setitem(sys.modules, "anthropic", types.ModuleType("anthropic"))
    env.set(gw.KEY_VAR, KEY)
    env.set("LLM_MONTHLY_BUDGET_USD", "10")
    clock = Clock()
    client = FakeClient(make_resp("a", inp=10000, out=1000),     # opus : 0.06 $
                        make_resp("b", inp=10000, out=1000),     # opus : 0.06 $
                        RateLimitError("429"),                     # -> CLI
                        make_resp("d", inp=1000, out=100))       # haiku : 0.00015 $
    fac = Factory(client)
    _call(fac, clock=clock, label="coach", tier="opus")
    _call(fac, clock=clock, label="coach", tier="opus")
    _call(fac, clock=clock, label="radar", tier="haiku")
    _call(fac, clock=clock, label="radar", tier="haiku")

    st = gw.status(now=clock)
    assert st["mode"] == "auto" and st["api_key_present"] is True and st["sdk_installed"] is True
    assert st["budget_usd"] == 10.0 and st["month"] == MONTH
    assert st["spent_usd"] == pytest.approx(0.12015, abs=1e-4)
    assert st["blocked"] is False and st["blocked_reason"] is None
    assert st["api_skip_reason"] is None and st["budget_reached"] is False
    assert st["state_dir"] == str(env.state_dir)
    assert st["ledger_file"] == str(env.state_dir / ("usage-%s.jsonl" % MONTH))
    assert st["models"] == {"opus": OPUS, "sonnet": SONNET, "haiku": HAIKU}

    ms = gw.month_summary(now=clock)
    assert ms["month"] == MONTH
    rows = {(r["label"], r["backend"], r["model"]): r for r in ms["rows"]}
    coach = rows[("coach", "api", OPUS)]
    assert (coach["calls"], coach["in"], coach["out"]) == (2, 20000, 2000)
    assert coach["cost_usd"] == pytest.approx(0.12)
    assert rows[("radar", "cli", "cli")]["calls"] == 1
    assert rows[("radar", "api", HAIKU)]["cost_usd"] == pytest.approx(0.00015)
    assert ms["rows"][0]["label"] == "coach"      # trié par coût décroissant
    totals = ms["totals"]
    assert (totals["calls"], totals["api_calls"], totals["cli_calls"]) == (4, 3, 1)
    assert totals["cost_usd"] == pytest.approx(0.12015)
    assert ms["fallback_reasons"] == {"rate_limit": 1}
    assert ms["api_rejected"] == {}


# --- 19. vieux SDK sans output_config ---------------------------------------------------------
class _OldSDKMessages:
    def __init__(self, error="create() got an unexpected keyword argument 'output_config'"):
        self.calls, self.error = [], error

    def create(self, **kw):
        self.calls.append(kw)
        if "output_config" in kw:
            raise TypeError(self.error)
        return make_resp("ok")


def test_vieux_sdk_typeerror_output_config_reessai_avec_extra_body(env):
    env.set(gw.KEY_VAR, KEY)
    messages = _OldSDKMessages()
    r = gw.complete("p", label="x", tier="opus", cli=Cli(),
                    client_factory=lambda **kw: SimpleNamespace(messages=messages), now=Clock())
    assert r.backend == "api"
    assert len(messages.calls) == 2
    assert "output_config" not in messages.calls[1]
    assert messages.calls[1]["extra_body"] == {"output_config": {"effort": "medium"}}


def test_typeerror_sans_rapport_pas_de_reessai(env):
    env.set(gw.KEY_VAR, KEY)
    messages = _OldSDKMessages(error="unsupported operand type(s)")
    r = gw.complete("p", label="x", cli=Cli("cli"),
                    client_factory=lambda **kw: SimpleNamespace(messages=messages), now=Clock())
    assert (r.backend, r.fallback_reason) == ("cli", "other")
    assert len(messages.calls) == 1


# --- 20. effort par défaut, paramètres interdits -----------------------------------------------
@pytest.mark.parametrize("tier, model, effort", [
    ("opus", OPUS, "medium"), ("sonnet", SONNET, "medium"), ("haiku", HAIKU, "low"),
])
def test_effort_par_defaut_selon_le_tier(env, tier, model, effort):
    env.set(gw.KEY_VAR, KEY)
    client = FakeClient()
    _call(Factory(client), tier=tier)
    kw = client.calls[0]
    assert set(kw) == {"model", "max_tokens", "messages", "output_config"}
    assert kw["model"] == model and kw["output_config"] == {"effort": effort}
    assert kw["max_tokens"] == 16000
    assert kw["messages"] == [{"role": "user", "content": "prompt"}]


def test_parametres_interdits_jamais_envoyes(env):
    env.set(gw.KEY_VAR, KEY)
    client = FakeClient()
    _call(Factory(client), tier="sonnet", system="Tu es le coach.", effort="high", max_tokens=500)
    kw = client.calls[0]
    assert set(kw) == {"model", "max_tokens", "messages", "output_config", "system"}
    assert kw["system"] == "Tu es le coach." and kw["output_config"] == {"effort": "high"}
    assert kw["max_tokens"] == 500
    for forbidden in ("temperature", "top_p", "top_k", "thinking", "tool_choice", "tools",
                      "betas", "fallbacks", "cache_control", "extra_body", "stop_sequences"):
        assert forbidden not in kw
    assert kw["messages"][-1]["role"] == "user"   # pas de prefill assistant


# --- fichiers d'état -----------------------------------------------------------------------------
@pytest.mark.skipif(os.name != "posix", reason="permissions POSIX")
def test_permissions_des_fichiers_d_etat(env):
    env.set(gw.KEY_VAR, KEY)
    os.makedirs(str(env.state_dir), mode=0o700)
    ledger = env.state_dir / ("usage-%s.jsonl" % MONTH)
    ledger.write_text("")
    os.chmod(str(ledger), 0o644)                  # journal préexistant trop ouvert
    fac = Factory(FakeClient(make_resp("ok"), BadRequestError(CREDIT_MSG)))
    _call(fac, notify=lambda text: None)
    _call(fac, notify=lambda text: None)          # crédit épuisé -> state.json écrit
    assert stat.S_IMODE(os.stat(str(env.state_dir)).st_mode) == 0o700
    for name in ("state.json", "state.lock", "usage-%s.jsonl" % MONTH):
        assert stat.S_IMODE(os.stat(str(env.state_dir / name)).st_mode) == 0o600, name
    assert not [p for p in env.state_dir.iterdir() if p.name.endswith(".tmp")]


def test_dossier_d_etat_cree_en_700(env):
    _call(Factory(FakeClient()))
    assert stat.S_IMODE(os.stat(str(env.state_dir)).st_mode) == 0o700


def test_journal_sans_prompt_ni_reponse(env):
    env.set(gw.KEY_VAR, KEY)
    client = FakeClient(make_resp("REPONSE-CONFIDENTIELLE"), RateLimitError("429"))
    fac = Factory(client)
    gw.complete("PROMPT-CONFIDENTIEL", label="x", cli=Cli("CLI-CONFIDENTIEL"),
                client_factory=fac, now=Clock(), system="SYSTEME-CONFIDENTIEL")
    gw.complete("PROMPT-CONFIDENTIEL", label="x", cli=Cli("CLI-CONFIDENTIEL"),
                client_factory=fac, now=Clock())
    raw = env.ledger_raw()
    assert len(raw.splitlines()) == 2
    for secret in ("PROMPT", "REPONSE", "SYSTEME", "CLI-CONFIDENTIEL"):
        assert secret not in raw


def test_dossier_d_etat_inutilisable_ne_casse_aucun_appel(env, tmp_path):
    blocker = tmp_path / "un-fichier"
    blocker.write_text("x")
    env.set("LLM_GATEWAY_STATE_DIR", str(blocker / "etat"))   # parent = fichier : mkdir impossible
    env.set(gw.KEY_VAR, KEY)
    clock, alerts = Clock(), []
    client = FakeClient(default=BadRequestError(CREDIT_MSG))
    fac = Factory(client)
    # Blocage non persistable : l'API est retentée ; alerte dédoublonnée en mémoire.
    for _ in range(2):
        r = _call(fac, Cli("cli"), clock, notify=alerts.append)
        assert (r.backend, r.fallback_reason) == ("cli", "credit_exhausted")
    assert len(client.calls) == 2 and len(alerts) == 1
    assert _call(Factory(FakeClient(make_resp("ok"))), clock=clock).backend == "api"


def test_etat_corrompu_repart_de_zero(env):
    os.makedirs(str(env.state_dir), mode=0o700)
    (env.state_dir / "state.json").write_text("{ pas du json")
    env.set(gw.KEY_VAR, KEY)
    assert _call(Factory(FakeClient())).backend == "api"
    assert gw.status(now=Clock())["blocked"] is False


# --- tarifs ----------------------------------------------------------------------------
def test_estimation_des_couts():
    est = gw.estimate_cost
    assert est(OPUS, {"input_tokens": 10000, "output_tokens": 1000}) == pytest.approx(0.06)
    assert est(SONNET, {"input_tokens": 10000, "output_tokens": 1000}) == pytest.approx(0.03)
    # cache : lecture au tarif listé, écriture à 1.25 x l'entrée
    assert est(OPUS, {"cache_read_input_tokens": 1000000}) == pytest.approx(0.20)
    assert est(OPUS, {"cache_creation_input_tokens": 1000000}) == pytest.approx(5.0)
    # lecture de cache non listée : 10 % de l'entrée
    assert est("claude-sonnet-4-6", {"cache_read_input_tokens": 1000000}) == pytest.approx(0.30)
    # Haiku 5.5 : palier long au-delà de 100K tokens de prompt
    assert est(HAIKU, {"input_tokens": 100000, "output_tokens": 1000}) == pytest.approx(0.0105)
    assert est(HAIKU, {"input_tokens": 90000, "cache_read_input_tokens": 20000}) == \
        pytest.approx((90000 * 0.50 + 20000 * 0.05) / 1e6)
    # ids datés -> famille la plus précise ; inconnu -> 5/25 prudent
    assert est("claude-opus-5-5-20261001", {"input_tokens": 1000000}) == pytest.approx(4.0)
    assert est("claude-opus-5-20260101", {"input_tokens": 1000000}) == pytest.approx(5.0)
    assert est("modele-mystere", {"input_tokens": 1000000, "output_tokens": 1000000}) == \
        pytest.approx(30.0)
    assert est(OPUS, {}) == 0.0


# --- ligne de commande -----------------------------------------------------------------
def test_main_status_selftest_summary(env, capsys):
    env.write_env("LLM_GATEWAY_API_KEY=%s\n" % KEY)
    os.chmod(str(env.env_file), 0o644)
    assert gw.main(["status"]) == 0
    out = capsys.readouterr().out
    assert json.loads(out)["api_key_present"] is True and KEY not in out
    assert gw.main(["selftest"]) == 1
    out = capsys.readouterr().out
    report = json.loads(out)
    assert any("chmod 600" in p for p in report["problems"]) and KEY not in out
    os.chmod(str(env.env_file), 0o600)
    gw.main(["selftest"])
    assert "chmod 600" not in capsys.readouterr().out
    assert gw.main(["summary"]) == 0
    assert "totals" in json.loads(capsys.readouterr().out)
    assert gw.main([]) == 2
    assert gw.main(["inconnue"]) == 2
