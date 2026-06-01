import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.bots import mc_agent_router as r
from backend.bots import mc_agent_manager as mgr
from backend.auth.utils import get_current_user


class FakeUser:
    def __init__(self, is_admin):
        self.is_admin = is_admin
        self.role = "admin" if is_admin else "player"


def make_client(is_admin=True):
    app = FastAPI()
    app.include_router(r.router)
    app.dependency_overrides[get_current_user] = lambda: FakeUser(is_admin)
    return TestClient(app)


def test_run_refuse_les_non_admins():
    c = make_client(is_admin=False)
    resp = c.post("/api/mc-agent/run", json={"host": "h"})
    assert resp.status_code == 403


def test_run_400_si_pas_de_cle(monkeypatch):
    monkeypatch.setattr(mgr, "has_api_key", lambda: False)
    c = make_client()
    resp = c.post("/api/mc-agent/run", json={"host": "h"})
    assert resp.status_code == 400


def test_run_demarre_une_session(monkeypatch):
    captured = {}
    monkeypatch.setattr(mgr, "has_api_key", lambda: True)
    def fake_start(host, port, user, model=None, auth="offline", profile=None, commands=None):
        captured["auth"] = auth
        return 7
    monkeypatch.setattr(mgr, "start_session", fake_start)
    c = make_client()
    resp = c.post("/api/mc-agent/run", json={"host": "play.x.net", "user": "TrainBot", "auth": "microsoft"})
    assert resp.status_code == 200
    assert resp.json()["session_id"] == 7
    assert captured["auth"] == "microsoft"  # auth transmis au manager


def test_status_404_si_inconnu(monkeypatch):
    monkeypatch.setattr(mgr, "get_status", lambda sid: None)
    c = make_client()
    assert c.get("/api/mc-agent/status/999").status_code == 404


def test_stop_ok(monkeypatch):
    monkeypatch.setattr(mgr, "stop_session", lambda sid: True)
    c = make_client()
    resp = c.post("/api/mc-agent/stop/3")
    assert resp.status_code == 200 and resp.json()["ok"] is True


def test_get_api_key_status(monkeypatch):
    monkeypatch.setattr(mgr, "get_api_key_status", lambda: {"has_key": True, "preview": "sk-ant-1…wxyz", "source": "file"})
    c = make_client()
    resp = c.get("/api/mc-agent/settings/api-key")
    assert resp.status_code == 200 and resp.json()["has_key"] is True


def test_set_api_key_rejette_mauvais_prefixe(monkeypatch):
    monkeypatch.setattr(mgr, "set_api_key", lambda k: "x")
    c = make_client()
    resp = c.post("/api/mc-agent/settings/api-key", json={"key": "pas-une-cle"})
    assert resp.status_code == 400


def test_set_api_key_ok(monkeypatch):
    captured = {}
    monkeypatch.setattr(mgr, "set_api_key", lambda k: captured.setdefault("k", k) or "sk-ant-1…wxyz")
    c = make_client()
    resp = c.post("/api/mc-agent/settings/api-key", json={"key": "sk-ant-abcdefghijklmnop"})
    assert resp.status_code == 200
    assert captured["k"].startswith("sk-ant-")


def test_set_api_key_refuse_non_admin():
    c = make_client(is_admin=False)
    resp = c.post("/api/mc-agent/settings/api-key", json={"key": "sk-ant-abcdefghijklmnop"})
    assert resp.status_code == 403


def test_delete_api_key(monkeypatch):
    called = {}
    monkeypatch.setattr(mgr, "clear_api_key", lambda: called.setdefault("done", True))
    c = make_client()
    resp = c.delete("/api/mc-agent/settings/api-key")
    assert resp.status_code == 200 and called.get("done") is True


def test_profiles_admin_only():
    c = make_client(is_admin=False)
    assert c.get("/api/mc-agent/profiles").status_code == 403


def test_profiles_retourne_la_liste(monkeypatch):
    monkeypatch.setattr(mgr, "list_profiles",
                        lambda: [{"id": "expert", "level": 3, "label": "Expert", "summary": "s", "tells": ["t"]}])
    c = make_client()
    resp = c.get("/api/mc-agent/profiles")
    assert resp.status_code == 200
    assert resp.json()["profiles"][0]["id"] == "expert"


def test_run_transmet_le_profil(monkeypatch):
    monkeypatch.setattr(mgr, "has_api_key", lambda: True)
    captured = {}
    def fake_start(host, port, user, model=None, auth="offline", profile=None, commands=None):
        captured["profile"] = profile
        return 11
    monkeypatch.setattr(mgr, "start_session", fake_start)
    c = make_client()
    resp = c.post("/api/mc-agent/run", json={"host": "h", "profile": "expert"})
    assert resp.status_code == 200
    assert captured["profile"] == "expert"


def test_commands_catalog(monkeypatch):
    monkeypatch.setattr(r.servers_store, "load_catalog", lambda: [{"id": "msg", "cmd": "/msg"}])
    c = make_client()
    resp = c.get("/api/mc-agent/commands-catalog")
    assert resp.status_code == 200 and resp.json()["catalog"][0]["id"] == "msg"


def test_servers_endpoints_admin_only():
    c = make_client(is_admin=False)
    assert c.get("/api/mc-agent/servers").status_code == 403
    assert c.post("/api/mc-agent/servers", json={"name": "X"}).status_code == 403
    assert c.get("/api/mc-agent/commands-catalog").status_code == 403


def test_create_server(monkeypatch):
    monkeypatch.setattr(r.servers_store, "create_server", lambda payload: {"id": "ab12cd", **payload})
    c = make_client()
    resp = c.post("/api/mc-agent/servers", json={"name": "Paper", "commands": ["msg"]})
    assert resp.status_code == 200 and resp.json()["id"] == "ab12cd"


def test_list_servers(monkeypatch):
    monkeypatch.setattr(r.servers_store, "load_servers", lambda: [{"id": "x", "name": "A"}])
    c = make_client()
    resp = c.get("/api/mc-agent/servers")
    assert resp.status_code == 200 and resp.json()["servers"][0]["name"] == "A"


def test_update_server_404(monkeypatch):
    monkeypatch.setattr(r.servers_store, "update_server", lambda sid, payload: None)
    c = make_client()
    assert c.put("/api/mc-agent/servers/x", json={"name": "Y"}).status_code == 404


def test_delete_server_ok(monkeypatch):
    monkeypatch.setattr(r.servers_store, "delete_server", lambda sid: True)
    c = make_client()
    assert c.delete("/api/mc-agent/servers/abc").status_code == 200


def test_run_with_server_id_resolves_commands(monkeypatch):
    monkeypatch.setattr(mgr, "has_api_key", lambda: True)
    monkeypatch.setattr(r.servers_store, "get_server", lambda sid: {
        "id": sid, "host": "play.x", "port": 25570, "user": "Bot",
        "auth": "offline", "intelligence": "expert", "commands": ["home"], "custom": []})
    monkeypatch.setattr(r.servers_store, "resolve_commands",
                        lambda srv: [{"cmd": "/home", "syntax": "/home", "desc": "h"}])
    captured = {}

    def fake_start(host, port, user, model=None, auth="offline", profile=None, commands=None):
        captured.update(host=host, profile=profile, commands=commands)
        return 9

    monkeypatch.setattr(mgr, "start_session", fake_start)
    c = make_client()
    resp = c.post("/api/mc-agent/run", json={"server_id": "abc"})
    assert resp.status_code == 200 and resp.json()["session_id"] == 9
    assert captured["host"] == "play.x" and captured["profile"] == "expert"
    assert captured["commands"][0]["cmd"] == "/home"


def test_run_400_sans_host_ni_server_id(monkeypatch):
    monkeypatch.setattr(mgr, "has_api_key", lambda: True)
    c = make_client()
    assert c.post("/api/mc-agent/run", json={}).status_code == 400
