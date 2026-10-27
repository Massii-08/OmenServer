import json
import os
import stat

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.agentchat import router as acr
from backend.agentchat import store
from backend.auth.utils import get_current_user


class FakeUser(object):
    def __init__(self, is_admin, role=None):
        self.is_admin = is_admin
        self.role = role or ("admin" if is_admin else "player")
        self.username = "massii"


@pytest.fixture
def ac_dir(tmp_path, monkeypatch):
    d = tmp_path / "agentchat"
    monkeypatch.setattr(store, "AGENTCHAT_DIR", d)
    return d


def make_client(is_admin=True, role=None):
    app = FastAPI()
    app.include_router(acr.router)
    app.include_router(acr.mcp_router)
    app.dependency_overrides[get_current_user] = lambda: FakeUser(is_admin, role)
    return TestClient(app)


def make_admin_and(role):
    """Client admin (pour préparer le salon) + client du rôle testé, même dossier."""
    return make_client(), make_client(is_admin=False, role=role)


def _mode(p):
    return stat.S_IMODE(os.stat(str(p)).st_mode)


def setup_room(c, room_id="roblox", name="Jeu Roblox"):
    r = c.post("/api/agentchat/rooms", json={"room_id": room_id, "name": name})
    assert r.status_code == 200, r.text
    return r.json()


def add_member(c, room_id="roblox", name="Claude-Pets"):
    r = c.post("/api/agentchat/rooms/%s/members" % room_id, json={"name": name})
    assert r.status_code == 200, r.text
    return r.json()


def mcp(c, key, payload, raw=None):
    headers = {"Content-Type": "application/json"}
    if key is not None:
        headers["Authorization"] = "Bearer " + key
    if raw is not None:
        return c.post("/mcp/agentchat", content=raw, headers=headers)
    return c.post("/mcp/agentchat", content=json.dumps(payload), headers=headers)


def call_tool(c, key, name, args=None, rid=1):
    r = mcp(c, key, {"jsonrpc": "2.0", "id": rid, "method": "tools/call",
                     "params": {"name": name, "arguments": args or {}}})
    assert r.status_code == 200, r.text
    return r.json()["result"]


# ------------------------------------------------------------- REST humaine

def test_non_admin_forbidden(ac_dir):
    c = make_client(is_admin=False)
    assert c.get("/api/agentchat/rooms").status_code == 403
    r = c.post("/api/agentchat/rooms", json={"room_id": "x", "name": "x"})
    assert r.status_code == 403


def test_create_room_and_member_key_once(ac_dir):
    c = make_client()
    setup_room(c)
    assert c.post("/api/agentchat/rooms", json={"room_id": "roblox", "name": "x"}).status_code == 409
    data = add_member(c)
    key = data["key"]
    assert key.startswith("oac_") and len(key) > 40
    assert data["member"]["name"] == "Claude-Pets"
    assert "key_hash" not in data["member"]
    # jamais la clé en clair sur disque
    for f in ac_dir.iterdir():
        assert key not in f.read_text(encoding="utf-8")
        assert _mode(f) == 0o600
    # la liste ne renvoie ni clé ni hash
    rooms = c.get("/api/agentchat/rooms").json()
    dumped = json.dumps(rooms)
    assert key not in dumped and "key_hash" not in dumped
    assert rooms["rooms"][0]["members"][0]["name"] == "Claude-Pets"


def test_messages_file_is_600(ac_dir):
    c = make_client()
    setup_room(c)
    r = c.post("/api/agentchat/rooms/roblox/messages", json={"text": "salut"})
    assert r.status_code == 200
    assert r.json()["message"]["author"] == "massii (humain)"
    assert r.json()["message"]["kind"] == "humain"
    assert _mode(ac_dir / "roblox.jsonl") == 0o600


@pytest.mark.parametrize("bad", ["../x", "ROBLOX", "a b", "", "x" * 41])
def test_invalid_room_id_rejected(ac_dir, bad):
    c = make_client()
    r = c.post("/api/agentchat/rooms", json={"room_id": bad, "name": "x"})
    assert r.status_code in (400, 422)
    assert not (ac_dir / "rooms.json").exists()


def test_path_traversal_in_url(ac_dir):
    c = make_client()
    r = c.get("/api/agentchat/rooms/..%2Fx/messages")
    assert r.status_code in (400, 404)


def test_messages_after_and_board(ac_dir):
    c = make_client()
    setup_room(c)
    for i in range(3):
        c.post("/api/agentchat/rooms/roblox/messages", json={"text": "m%d" % i})
    r = c.get("/api/agentchat/rooms/roblox/messages?after=1")
    assert [m["id"] for m in r.json()["messages"]] == [2, 3]
    assert c.put("/api/agentchat/rooms/roblox/board", json={"board": "Pets: A"}).status_code == 200
    assert c.get("/api/agentchat/rooms/roblox/board").json()["board"] == "Pets: A"
    r = c.post("/api/agentchat/rooms/roblox/messages", json={"text": "x" * 4001})
    assert r.status_code == 400


def test_unknown_room_404(ac_dir):
    c = make_client()
    assert c.get("/api/agentchat/rooms/nope/messages").status_code == 404


# ------------------------------------------------------------- MCP

def test_mcp_401_without_or_bad_key(ac_dir):
    c = make_client()
    setup_room(c)
    add_member(c)
    init = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}
    assert mcp(c, None, init).status_code == 401
    assert mcp(c, "oac_nimportequoi", init).status_code == 401
    r = c.post("/mcp/agentchat", json=init, headers={"Authorization": "Basic abc"})
    assert r.status_code == 401


def test_mcp_revoked_key_401(ac_dir):
    c = make_client()
    setup_room(c)
    data = add_member(c)
    mid = data["member"]["id"]
    assert c.post("/api/agentchat/rooms/roblox/members/%s/revoke" % mid).status_code == 200
    r = mcp(c, data["key"], {"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert r.status_code == 401


def test_mcp_initialize(ac_dir):
    c = make_client()
    setup_room(c)
    key = add_member(c)["key"]
    r = mcp(c, key, {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                     "params": {"protocolVersion": "2025-03-26"}})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/json")
    res = r.json()["result"]
    assert res["protocolVersion"] == "2025-03-26"
    assert res["serverInfo"]["name"] == "omenserver-agentchat"
    assert "tools" in res["capabilities"]
    assert "Claude-Pets" in res["instructions"]
    assert "Jeu Roblox" in res["instructions"]
    r = mcp(c, key, {"jsonrpc": "2.0", "id": 2, "method": "initialize",
                     "params": {"protocolVersion": "1999-01-01"}})
    assert r.json()["result"]["protocolVersion"] == "2025-06-18"


def test_mcp_notification_202(ac_dir):
    c = make_client()
    setup_room(c)
    key = add_member(c)["key"]
    r = mcp(c, key, {"jsonrpc": "2.0", "method": "notifications/initialized"})
    assert r.status_code == 202
    assert r.content == b""


def test_mcp_ping_and_tools_list(ac_dir):
    c = make_client()
    setup_room(c)
    key = add_member(c)["key"]
    assert mcp(c, key, {"jsonrpc": "2.0", "id": 1, "method": "ping"}).json()["result"] == {}
    tools = mcp(c, key, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}).json()["result"]["tools"]
    names = sorted(t["name"] for t in tools)
    assert names == ["envoyer_message", "lire_messages", "lire_tableau", "modifier_tableau"]
    for t in tools:
        assert t["inputSchema"]["type"] == "object"


def test_mcp_send_then_read_author_forced(ac_dir):
    c = make_client()
    setup_room(c)
    key = add_member(c)["key"]
    res = call_tool(c, key, "envoyer_message",
                    {"texte": "je fais les pets", "type": "en_cours", "auteur": "Usurpateur",
                     "author": "Usurpateur"})
    assert res["isError"] is False
    assert "#1" in res["content"][0]["text"]
    call_tool(c, key, "envoyer_message", {"texte": "ok", "type": "reponse", "reponse_a": 1})
    msgs = c.get("/api/agentchat/rooms/roblox/messages").json()["messages"]
    assert [m["author"] for m in msgs] == ["Claude-Pets", "Claude-Pets"]
    assert msgs[0]["kind"] == "en_cours"
    assert msgs[1]["reply_to"] == 1
    out = call_tool(c, key, "lire_messages", {})["content"][0]["text"]
    assert "#1" in out and "je fais les pets" in out and "dernier id : 2" in out
    assert "Usurpateur" not in out
    out = call_tool(c, key, "lire_messages", {"depuis_id": 1})["content"][0]["text"]
    assert "#2" in out and "je fais les pets" not in out
    assert "#1" in out  # la réponse cite #1
    out = call_tool(c, key, "lire_messages", {"limite": 1})["content"][0]["text"]
    assert "#2" in out and "je fais les pets" not in out


def test_mcp_board_tools(ac_dir):
    c = make_client()
    setup_room(c)
    key = add_member(c)["key"]
    add_member(c, name="Claude-Map")
    res = call_tool(c, key, "modifier_tableau", {"texte": "Pets: Claude-Pets / Map: Claude-Map"})
    assert res["isError"] is False
    msgs = c.get("/api/agentchat/rooms/roblox/messages").json()["messages"]
    assert msgs[-1]["kind"] == "info"
    assert "tableau modifié par Claude-Pets" in msgs[-1]["text"]
    out = call_tool(c, key, "lire_tableau")["content"][0]["text"]
    assert "Pets: Claude-Pets" in out and "Claude-Map" in out


def test_mcp_errors(ac_dir):
    c = make_client()
    setup_room(c)
    key = add_member(c)["key"]
    r = mcp(c, key, {"jsonrpc": "2.0", "id": 9, "method": "resources/list"})
    assert r.json()["error"]["code"] == -32601
    assert r.json()["id"] == 9
    r = mcp(c, key, None, raw="{pas du json")
    assert r.json()["error"]["code"] == -32700
    res = call_tool(c, key, "outil_inconnu")
    assert res["isError"] is True
    res = call_tool(c, key, "envoyer_message", {"texte": "x" * 4001})
    assert res["isError"] is True
    res = call_tool(c, key, "envoyer_message", {"texte": "x", "type": "humain"})
    assert res["isError"] is True
    res = call_tool(c, key, "envoyer_message", {})
    assert res["isError"] is True


def test_mcp_batch(ac_dir):
    c = make_client()
    setup_room(c)
    key = add_member(c)["key"]
    r = mcp(c, key, [
        {"jsonrpc": "2.0", "id": 1, "method": "ping"},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    ])
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body, list) and [x["id"] for x in body] == [1, 2]


def test_mcp_get_405(ac_dir):
    c = make_client()
    assert c.get("/mcp/agentchat").status_code == 405


# ------------------------------------------------------------- rôles

def test_developer_can_chat_and_edit_board(ac_dir):
    admin, dev = make_admin_and("developer")
    setup_room(admin)
    add_member(admin)
    r = dev.get("/api/agentchat/rooms")
    assert r.status_code == 200
    assert "key_hash" not in json.dumps(r.json())
    r = dev.post("/api/agentchat/rooms/roblox/messages", json={"text": "salut"})
    assert r.status_code == 200
    assert r.json()["message"]["author"] == "massii (humain)"
    assert dev.get("/api/agentchat/rooms/roblox/messages").status_code == 200
    assert dev.put("/api/agentchat/rooms/roblox/board", json={"board": "B"}).status_code == 200
    assert dev.get("/api/agentchat/rooms/roblox/board").json()["board"] == "B"


def test_developer_cannot_manage_rooms_or_keys(ac_dir):
    admin, dev = make_admin_and("developer")
    setup_room(admin)
    mid = add_member(admin)["member"]["id"]
    assert dev.post("/api/agentchat/rooms", json={"room_id": "x", "name": "x"}).status_code == 403
    assert dev.post("/api/agentchat/rooms/roblox/members", json={"name": "Z"}).status_code == 403
    assert dev.post("/api/agentchat/rooms/roblox/members/%s/revoke" % mid).status_code == 403
    rooms = admin.get("/api/agentchat/rooms").json()["rooms"]
    assert len(rooms) == 1 and len(rooms[0]["members"]) == 1
    assert rooms[0]["members"][0]["revoked"] is False


@pytest.mark.parametrize("role", ["player", "moderator", "money", "spectator"])
def test_other_roles_forbidden_everywhere(ac_dir, role):
    admin, other = make_admin_and(role)
    setup_room(admin)
    mid = add_member(admin)["member"]["id"]
    assert other.get("/api/agentchat/rooms").status_code == 403
    assert other.get("/api/agentchat/rooms/roblox/messages").status_code == 403
    assert other.post("/api/agentchat/rooms/roblox/messages", json={"text": "x"}).status_code == 403
    assert other.get("/api/agentchat/rooms/roblox/board").status_code == 403
    assert other.put("/api/agentchat/rooms/roblox/board", json={"board": "x"}).status_code == 403
    assert other.post("/api/agentchat/rooms", json={"room_id": "y", "name": "y"}).status_code == 403
    assert other.post("/api/agentchat/rooms/roblox/members", json={"name": "Z"}).status_code == 403
    assert other.post("/api/agentchat/rooms/roblox/members/%s/revoke" % mid).status_code == 403
