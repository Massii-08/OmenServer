"""Tests hors-ligne du coach Muscu (clé, quotas, contrat HTTP). Aucun vrai LLM."""
import os
import stat
from datetime import datetime

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import llm_gateway as gw
from backend.muscu import router as mr
from backend.muscu import store


class Clock:
    def __init__(self):
        self.t = datetime(2026, 10, 21, 12, 0, 0, tzinfo=store.TZ).timestamp()

    def __call__(self):
        return self.t


@pytest.fixture
def env(tmp_path, monkeypatch):
    clock = Clock()
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    monkeypatch.setattr(store, "_clock", clock)
    store.reset_state()
    calls = []

    def fake_complete(prompt, **kw):
        calls.append((prompt, kw))
        return gw.Result(text="Bien joué.", backend="api", model="m", usage={},
                         cost_usd=0.0, fallback_reason=None)

    monkeypatch.setattr(gw, "complete", fake_complete)
    app = FastAPI()
    app.include_router(mr.router)
    client = TestClient(app)
    key = store.load_key()
    return client, key, clock, calls, tmp_path


def body(n=1, last="user"):
    msgs = [{"role": "user" if i % 2 == 0 else "assistant", "content": "m%d" % i}
            for i in range(n)]
    msgs[-1]["role"] = last
    return {"system": "Tu es un coach.", "messages": msgs}


def H(key):
    return {"X-Muscu-Key": key}


def test_key_created_0600(env):
    _, key, _, _, tmp = env
    st = os.stat(str(tmp / store.KEY_FILE))
    assert stat.S_IMODE(st.st_mode) == 0o600
    assert len(key) >= 32


def test_auth_401(env):
    c, key, _, _, _ = env
    assert c.get("/api/muscu/ping").status_code == 401
    assert c.get("/api/muscu/ping", headers=H("faux")).status_code == 401
    assert c.post("/api/muscu/coach", json=body()).status_code == 401
    assert c.post("/api/muscu/coach", json=body(), headers=H("faux")).status_code == 401


def test_503_when_key_unavailable(env, monkeypatch):
    c, _, _, _, tmp = env
    monkeypatch.setattr(store, "DATA_DIR", tmp / "fichier" / "x")
    (tmp / "fichier").write_text("je suis un fichier")
    assert c.get("/api/muscu/ping", headers=H("x")).status_code == 503


def test_ping(env):
    c, key, _, _, _ = env
    r = c.get("/api/muscu/ping", headers=H(key))
    assert r.status_code == 200
    assert r.json() == {"ok": True, "remaining_today": 40}


@pytest.mark.parametrize("payload", [
    body(2, last="assistant"),
    body(31),
    {"system": "", "messages": []},
    {"system": "", "messages": [{"role": "user", "content": ""}]},
    {"system": "", "messages": [{"role": "user", "content": "x" * 4001}]},
    {"system": "x" * 20001, "messages": [{"role": "user", "content": "a"}]},
    {"system": "", "messages": [{"role": "system", "content": "a"}]},
])
def test_422(env, payload):
    c, key, _, calls, _ = env
    assert c.post("/api/muscu/coach", json=payload, headers=H(key)).status_code == 422
    assert not calls


def test_ok_and_prompt(env):
    c, key, _, calls, _ = env
    payload = {"system": "SYS", "messages": [
        {"role": "user", "content": "un"},
        {"role": "assistant", "content": "deux"},
        {"role": "user", "content": "trois"}]}
    r = c.post("/api/muscu/coach", json=payload, headers=H(key))
    assert r.status_code == 200
    j = r.json()
    assert j == {"text": "Bien joué.", "via": "api", "remaining_today": 39}
    prompt, kw = calls[0]
    assert prompt.index("un") < prompt.index("deux") < prompt.index("trois")
    assert prompt.rstrip().endswith("Utilisateur : trois")
    assert kw["system"] == "SYS" and kw["label"] == "muscu_coach"
    assert callable(kw["cli"])
    assert key not in r.text


def test_rate_limit_3s(env):
    c, key, clock, _, _ = env
    assert c.post("/api/muscu/coach", json=body(), headers=H(key)).status_code == 200
    clock.t += 1
    r = c.post("/api/muscu/coach", json=body(), headers=H(key))
    assert r.status_code == 429
    clock.t += 3
    assert c.post("/api/muscu/coach", json=body(), headers=H(key)).status_code == 200
    # le refus de débit n'a pas consommé de quota
    assert c.get("/api/muscu/ping", headers=H(key)).json()["remaining_today"] == 38


def test_daily_quota_and_reset(env):
    c, key, clock, _, _ = env
    for _ in range(40):
        clock.t += 4
        assert c.post("/api/muscu/coach", json=body(), headers=H(key)).status_code == 200
    clock.t += 4
    r = c.post("/api/muscu/coach", json=body(), headers=H(key))
    assert r.status_code == 429 and "quota" in r.json()["detail"].lower()
    clock.t += 86400
    r = c.post("/api/muscu/coach", json=body(), headers=H(key))
    assert r.status_code == 200 and r.json()["remaining_today"] == 39


def test_usage_file_0600(env):
    c, key, _, _, tmp = env
    c.post("/api/muscu/coach", json=body(), headers=H(key))
    st = os.stat(str(tmp / store.USAGE_FILE))
    assert stat.S_IMODE(st.st_mode) == 0o600


def test_502_on_gateway_error(env, monkeypatch):
    c, key, _, _, _ = env

    def boom(*a, **k):
        raise gw.GatewayError("API: x; CLI: y")

    monkeypatch.setattr(gw, "complete", boom)
    r = c.post("/api/muscu/coach", json=body(), headers=H(key))
    assert r.status_code == 502
    assert key not in r.text


def test_cli_closure_uses_system_and_env(env, monkeypatch):
    from backend.bots.paper import llm as pl
    seen = {}

    def fake_cli_text(prompt, model, timeout, run, env=None):
        seen.update(prompt=prompt, env=env)
        return "ok"

    monkeypatch.setattr(pl, "_cli_text", fake_cli_text)
    monkeypatch.setattr(gw, "cli_env", lambda: {"SENTINEL": "1"})
    assert mr._cli_closure("SYS", "Utilisateur : hi")() == "ok"
    assert seen["prompt"].startswith("SYS") and seen["env"] == {"SENTINEL": "1"}
