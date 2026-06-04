import json
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.bots import mc_agent_router as r
from backend.bots import mc_agent_manager as mgr
from backend.bots import mc_agent_secrets
from backend.bots import mc_agent_servers as servers_store
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
    def fake_start(host, port, user, model=None, auth="offline", profile=None, commands=None, policy=None, server_id=None, language="fr", autonomous=False, objective="stone_pickaxe", world_label=None):
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
    def fake_start(host, port, user, model=None, auth="offline", profile=None, commands=None, policy=None, server_id=None, language="fr", autonomous=False, objective="stone_pickaxe", world_label=None):
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

    def fake_start(host, port, user, model=None, auth="offline", profile=None, commands=None, policy=None, server_id=None, language="fr", autonomous=False, objective="stone_pickaxe", world_label=None):
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


def test_create_server_accepts_trusted_and_trade(monkeypatch):
    captured = {}
    monkeypatch.setattr(r.servers_store, "create_server", lambda payload: (captured.update(payload) or {"id": "ab12cd", **payload}))
    c = make_client()
    resp = c.post("/api/mc-agent/servers", json={"name": "X", "trusted": ["Bob"], "trade": {"acceptCmd": "/t accept"}})
    assert resp.status_code == 200
    assert captured["trusted"] == ["Bob"]
    assert captured["trade"]["acceptCmd"] == "/t accept"


def test_run_with_server_id_passes_policy(monkeypatch):
    monkeypatch.setattr(mgr, "has_api_key", lambda: True)
    monkeypatch.setattr(r.servers_store, "get_server", lambda sid: {
        "id": sid, "host": "play.x", "port": 25565, "user": "Bot",
        "auth": "offline", "intelligence": "expert", "commands": [], "custom": [],
        "trusted": ["Bob"], "trade": None})
    monkeypatch.setattr(r.servers_store, "resolve_commands", lambda srv: [])
    monkeypatch.setattr(r.servers_store, "resolve_policy", lambda srv: {"trusted": ["Bob"], "trade": None})
    captured = {}

    def fake_start(host, port, user, model=None, auth="offline", profile=None, commands=None, policy=None, server_id=None, language="fr", autonomous=False, objective="stone_pickaxe", world_label=None):
        captured["policy"] = policy
        return 11

    monkeypatch.setattr(mgr, "start_session", fake_start)
    c = make_client()
    resp = c.post("/api/mc-agent/run", json={"server_id": "abc"})
    assert resp.status_code == 200
    assert captured["policy"]["trusted"] == ["Bob"]


def test_run_with_server_id_passes_server_id(monkeypatch):
    """L'id du profil serveur est transmis à start_session (pour tracer la session côté carte)."""
    monkeypatch.setattr(mgr, "has_api_key", lambda: True)
    monkeypatch.setattr(r.servers_store, "get_server", lambda sid: {
        "id": sid, "host": "play.x", "port": 25565, "user": "Bot",
        "auth": "offline", "intelligence": "expert", "commands": [], "custom": [],
        "trusted": [], "trade": None})
    monkeypatch.setattr(r.servers_store, "resolve_commands", lambda srv: [])
    monkeypatch.setattr(r.servers_store, "resolve_policy", lambda srv: {"trusted": [], "trade": None})
    captured = {}

    def fake_start(host, port, user, model=None, auth="offline", profile=None, commands=None, policy=None, server_id=None, language="fr", autonomous=False, objective="stone_pickaxe", world_label=None):
        captured["server_id"] = server_id
        return 12

    monkeypatch.setattr(mgr, "start_session", fake_start)
    c = make_client()
    resp = c.post("/api/mc-agent/run", json={"server_id": "abc"})
    assert resp.status_code == 200
    assert captured["server_id"] == "abc"


def test_run_passes_language_from_server_profile(monkeypatch):
    monkeypatch.setattr(mgr, "has_api_key", lambda: True)
    captured = {}

    def fake_start(host, port, user, model=None, auth="offline", profile=None,
                   commands=None, policy=None, server_id=None, language="fr", autonomous=False, objective="stone_pickaxe", world_label=None):
        captured["language"] = language
        return 7

    monkeypatch.setattr(mgr, "start_session", fake_start)
    monkeypatch.setattr(r.servers_store, "get_server", lambda sid: {
        "id": sid, "host": "h", "port": 25565, "user": "Bot", "auth": "offline",
        "intelligence": "intermediaire", "language": "it", "commands": [], "custom": [],
        "trusted": [], "trade": None})
    monkeypatch.setattr(r.servers_store, "resolve_commands", lambda srv: [])
    monkeypatch.setattr(r.servers_store, "resolve_policy", lambda srv: {"trusted": [], "trade": None})
    c = make_client()
    resp = c.post("/api/mc-agent/run", json={"server_id": "abc"})
    assert resp.status_code == 200
    assert captured["language"] == "it"


def test_run_passes_autonomous_flag(monkeypatch):
    """POST /run avec autonomous:true → transmis à start_session (lance la boucle planner au spawn)."""
    monkeypatch.setattr(mgr, "has_api_key", lambda: True)
    captured = {}

    def fake_start(host, port, user, model=None, auth="offline", profile=None, commands=None, policy=None, server_id=None, language="fr", autonomous=False, objective="stone_pickaxe", world_label=None):
        captured["autonomous"] = autonomous
        return 7

    monkeypatch.setattr(mgr, "start_session", fake_start)
    c = make_client()
    resp = c.post("/api/mc-agent/run", json={"host": "play.x.net", "user": "TrainBot", "autonomous": True})
    assert resp.status_code == 200
    assert captured["autonomous"] is True


def test_run_passes_objective(monkeypatch):
    """POST /run avec objective:iron_pickaxe → transmis à start_session (sélectionne la chaîne fer)."""
    monkeypatch.setattr(mgr, "has_api_key", lambda: True)
    captured = {}

    def fake_start(host, port, user, model=None, auth="offline", profile=None, commands=None, policy=None, server_id=None, language="fr", autonomous=False, objective="stone_pickaxe", world_label=None):
        captured["objective"] = objective
        return 7

    monkeypatch.setattr(mgr, "start_session", fake_start)
    c = make_client()
    resp = c.post("/api/mc-agent/run", json={"host": "play.x.net", "user": "TrainBot", "autonomous": True, "objective": "iron_pickaxe"})
    assert resp.status_code == 200
    assert captured["objective"] == "iron_pickaxe"


def test_run_passes_diamond_objective(monkeypatch):
    """POST /run avec objective:diamond → transmis à start_session (sélectionne DIAMOND_CHAIN)."""
    monkeypatch.setattr(mgr, "has_api_key", lambda: True)
    captured = {}

    def fake_start(host, port, user, model=None, auth="offline", profile=None, commands=None, policy=None, server_id=None, language="fr", autonomous=False, objective="stone_pickaxe", world_label=None):
        captured["objective"] = objective
        return 9

    monkeypatch.setattr(mgr, "start_session", fake_start)
    c = make_client()
    resp = c.post("/api/mc-agent/run", json={"host": "play.x.net", "user": "TrainBot", "autonomous": True, "objective": "diamond"})
    assert resp.status_code == 200
    assert captured["objective"] == "diamond"


def test_delete_server_cascade(monkeypatch):
    """DELETE /servers/{sid} → supprime le profil + cascade (stop bots + oubli mémoire)."""
    monkeypatch.setattr(r.servers_store, "delete_server", lambda sid: True)
    calls = {}

    def fake_stop(gid):
        calls["stop"] = gid
        return 2

    def fake_forget(gid):
        calls["forget"] = gid
        return True

    monkeypatch.setattr(mgr, "stop_group", fake_stop)
    monkeypatch.setattr(mgr, "forget_group", fake_forget)
    c = make_client()
    resp = c.delete("/api/mc-agent/servers/ab12cd")
    assert resp.status_code == 200
    assert resp.json()["bots_stopped"] == 2
    assert calls["stop"] == "ab12cd" and calls["forget"] == "ab12cd"


def test_delete_server_404_no_cascade(monkeypatch):
    """Profil inexistant → 404, aucune cascade déclenchée."""
    monkeypatch.setattr(r.servers_store, "delete_server", lambda sid: False)
    calls = {}
    monkeypatch.setattr(mgr, "stop_group", lambda gid: calls.setdefault("stop", gid))
    monkeypatch.setattr(mgr, "forget_group", lambda gid: calls.setdefault("forget", gid))
    c = make_client()
    assert c.delete("/api/mc-agent/servers/zzzz").status_code == 404
    assert calls == {}


def test_delete_server_admin_only():
    c = make_client(is_admin=False)
    assert c.delete("/api/mc-agent/servers/ab12cd").status_code == 403


def test_server_memory_endpoint(monkeypatch):
    """GET /servers/{sid}/memory → renvoie la mémoire de monde (admin)."""
    fake_mem = {"group_id": "ab12cd", "worlds": {"w": {"biomes": [{"name": "forest", "x": 0, "z": 0}], "caves": [], "finds": []}}}
    monkeypatch.setattr(r.world_memory, "load", lambda sid: fake_mem)
    c = make_client()
    resp = c.get("/api/mc-agent/servers/ab12cd/memory")
    assert resp.status_code == 200
    assert resp.json()["worlds"]["w"]["biomes"][0]["name"] == "forest"


def test_server_memory_admin_only():
    c = make_client(is_admin=False)
    assert c.get("/api/mc-agent/servers/ab12cd/memory").status_code == 403


def test_run_passes_world_label_et_mapper(monkeypatch):
    """objective=mapper + world_label passent du payload au manager."""
    monkeypatch.setattr(mgr, "has_api_key", lambda: True)
    captured = {}

    def fake_start(host, port, user, model=None, auth="offline", profile=None, commands=None, policy=None, server_id=None, language="fr", autonomous=False, objective="stone_pickaxe", world_label=None):
        captured["objective"] = objective
        captured["world_label"] = world_label
        captured["autonomous"] = autonomous
        return 11

    monkeypatch.setattr(mgr, "start_session", fake_start)
    c = make_client()
    r = c.post("/api/mc-agent/run", json={
        "host": "h", "user": "Mapper", "autonomous": True,
        "objective": "mapper", "world_label": "mining",
    })
    assert r.status_code == 200
    assert captured["objective"] == "mapper"
    assert captured["world_label"] == "mining"
    assert captured["autonomous"] is True


# ---------------------------------------------------------------------------
# Task 5 : endpoints bot CRUD (admin-only) + secret jamais renvoyé
# ---------------------------------------------------------------------------

@pytest.fixture()
def bot_env(tmp_path, monkeypatch):
    """Isole SERVERS_PATH, SECRETS_DIR, CATALOG_PATH sur tmp_path.
    Crée un groupe 'ab12cd' avec aucun bot pour les tests de création.
    """
    servers_file = tmp_path / "mc_agent_servers.json"
    secrets_dir = tmp_path / "mc_agent_secrets"
    catalog_file = tmp_path / "commands-catalog.json"

    # Groupe vide de départ
    servers_file.write_text(json.dumps([{
        "id": "ab12cd",
        "name": "Test",
        "host": "play.x",
        "port": 25565,
        "user": "Bot",
        "auth": "offline",
        "intelligence": "intermediaire",
        "language": "fr",
        "commands": [],
        "custom": [],
        "trusted": [],
        "trade": None,
        "has_login": False,
        "login_command": "/login {pwd}",
        "bots": [],
    }]), encoding="utf-8")
    catalog_file.write_text("[]", encoding="utf-8")

    monkeypatch.setattr(servers_store, "SERVERS_PATH", servers_file)
    monkeypatch.setattr(mc_agent_secrets, "SECRETS_DIR", secrets_dir)
    monkeypatch.setattr(servers_store, "CATALOG_PATH", catalog_file)

    return {"servers_file": servers_file, "secrets_dir": secrets_dir, "sid": "ab12cd"}


def test_create_bot_200_has_secret_true(bot_env):
    """POST /servers/{sid}/bots avec secret → 200, has_secret:true, secret absent de la réponse."""
    c = make_client()
    resp = c.post("/api/mc-agent/servers/ab12cd/bots", json={
        "role": "mapper", "username": "M1", "auth": "offline", "secret": "pw"
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["has_secret"] is True
    assert data["username"] == "M1"
    assert data["role"] == "mapper"
    # La chaîne "pw" ne doit JAMAIS apparaître dans la réponse
    assert "pw" not in resp.text


def test_create_bot_secret_bien_stocke(bot_env):
    """Le secret passé au POST est stocké dans mc_agent_secrets."""
    c = make_client()
    resp = c.post("/api/mc-agent/servers/ab12cd/bots", json={
        "role": "worker", "username": "M1", "auth": "offline", "secret": "s3cr3t"
    })
    assert resp.status_code == 200
    bot_id = resp.json()["id"]
    assert mc_agent_secrets.get_secret("ab12cd", bot_id) == "s3cr3t"


def test_create_bot_sans_secret_has_secret_false(bot_env):
    """POST sans champ secret → 200, has_secret:false."""
    c = make_client()
    resp = c.post("/api/mc-agent/servers/ab12cd/bots", json={
        "role": "worker", "username": "NoPass", "auth": "offline"
    })
    assert resp.status_code == 200
    assert resp.json()["has_secret"] is False


def test_list_servers_no_secret_leak(bot_env):
    """GET /servers après création → le secret n'apparaît jamais dans la réponse."""
    c = make_client()
    # Crée un bot avec secret
    c.post("/api/mc-agent/servers/ab12cd/bots", json={
        "role": "worker", "username": "M1", "auth": "offline", "secret": "topsecret"
    })
    resp = c.get("/api/mc-agent/servers")
    assert resp.status_code == 200
    assert "topsecret" not in resp.text


def test_list_servers_bots_enrichis_has_secret(bot_env):
    """GET /servers → chaque bot du roster a has_secret (true si secret stocké, false sinon)."""
    c = make_client()
    # Bot avec secret
    r1 = c.post("/api/mc-agent/servers/ab12cd/bots", json={
        "role": "worker", "username": "WithSecret", "auth": "offline", "secret": "pw"
    })
    # Bot sans secret
    c.post("/api/mc-agent/servers/ab12cd/bots", json={
        "role": "worker", "username": "NoSecret", "auth": "offline"
    })
    resp = c.get("/api/mc-agent/servers")
    assert resp.status_code == 200
    servers = resp.json()["servers"]
    bots = servers[0]["bots"]
    by_username = {b["username"]: b for b in bots}
    assert by_username["WithSecret"]["has_secret"] is True
    assert by_username["NoSecret"]["has_secret"] is False


def test_create_bot_username_duplique_400(bot_env):
    """Username déjà présent (insensible casse) → 400."""
    c = make_client()
    c.post("/api/mc-agent/servers/ab12cd/bots", json={
        "role": "worker", "username": "Alice", "auth": "offline"
    })
    resp = c.post("/api/mc-agent/servers/ab12cd/bots", json={
        "role": "worker", "username": "alice", "auth": "offline"  # même nom, casse différente
    })
    assert resp.status_code == 400


def test_create_bot_username_vide_400(bot_env):
    """Username vide → 400."""
    c = make_client()
    resp = c.post("/api/mc-agent/servers/ab12cd/bots", json={
        "role": "worker", "username": "", "auth": "offline"
    })
    assert resp.status_code == 400


def test_create_bot_groupe_inexistant_400(bot_env):
    """Groupe inexistant → 400 (add_bot retourne None).
    Note : on retourne 400 car add_bot ne distingue pas 'absent' de 'invalide'.
    """
    c = make_client()
    resp = c.post("/api/mc-agent/servers/zzzzzz/bots", json={
        "role": "worker", "username": "X", "auth": "offline"
    })
    assert resp.status_code == 400


def test_create_bot_non_admin_403(bot_env):
    """Non-admin → 403 sur POST /bots."""
    c = make_client(is_admin=False)
    resp = c.post("/api/mc-agent/servers/ab12cd/bots", json={
        "role": "worker", "username": "X", "auth": "offline"
    })
    assert resp.status_code == 403


def test_delete_bot_ok(bot_env):
    """DELETE /servers/{sid}/bots/{bot_id} → 200 {ok:true}, bot absent du roster."""
    c = make_client()
    # Crée un bot
    r1 = c.post("/api/mc-agent/servers/ab12cd/bots", json={
        "role": "worker", "username": "ToDelete", "auth": "offline", "secret": "pw"
    })
    bot_id = r1.json()["id"]

    # Supprime
    resp = c.delete(f"/api/mc-agent/servers/ab12cd/bots/{bot_id}")
    assert resp.status_code == 200
    assert resp.json()["ok"] is True

    # Plus dans le roster
    servers = c.get("/api/mc-agent/servers").json()["servers"]
    bots = servers[0]["bots"]
    assert not any(b["id"] == bot_id for b in bots)


def test_delete_bot_supprime_le_secret(bot_env):
    """DELETE bot → secret aussi supprimé (get_secret retourne None après)."""
    c = make_client()
    r1 = c.post("/api/mc-agent/servers/ab12cd/bots", json={
        "role": "worker", "username": "WithSecret", "auth": "offline", "secret": "mypass"
    })
    bot_id = r1.json()["id"]

    # Vérifie que le secret existait bien
    assert mc_agent_secrets.get_secret("ab12cd", bot_id) == "mypass"

    c.delete(f"/api/mc-agent/servers/ab12cd/bots/{bot_id}")

    # Secret supprimé
    assert mc_agent_secrets.get_secret("ab12cd", bot_id) is None


def test_delete_bot_non_admin_403(bot_env):
    """Non-admin → 403 sur DELETE /bots/{bot_id}."""
    c = make_client(is_admin=False)
    assert c.delete("/api/mc-agent/servers/ab12cd/bots/abc123").status_code == 403


def test_delete_bot_inexistant_404(bot_env):
    """bot_id inexistant → 404."""
    c = make_client()
    assert c.delete("/api/mc-agent/servers/ab12cd/bots/ffffff").status_code == 404


def test_delete_server_cascade_secrets(bot_env):
    """DELETE /servers/{sid} → cascade supprime les secrets du groupe."""
    c = make_client()
    # Crée un bot avec secret
    r1 = c.post("/api/mc-agent/servers/ab12cd/bots", json={
        "role": "worker", "username": "BotX", "auth": "offline", "secret": "cascade_pw"
    })
    bot_id = r1.json()["id"]
    assert mc_agent_secrets.get_secret("ab12cd", bot_id) == "cascade_pw"

    # Monkeypatch les dépendances de la cascade manager
    import backend.bots.mc_agent_manager as _mgr
    # Patch stop_group et forget_group pour éviter les appels réels
    import unittest.mock as mock
    with mock.patch.object(_mgr, "stop_group", return_value=0), \
         mock.patch.object(_mgr, "forget_group", return_value=True):
        resp = c.delete("/api/mc-agent/servers/ab12cd")
    assert resp.status_code == 200

    # Le fichier secrets du groupe ne doit plus exister
    secrets_file = bot_env["secrets_dir"] / "ab12cd.json"
    assert not secrets_file.exists()
