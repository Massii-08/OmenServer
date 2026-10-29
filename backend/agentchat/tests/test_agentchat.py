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
    assert names == ["envoyer_document", "envoyer_message", "lire_document", "lire_messages",
                     "lire_tableau", "lister_documents", "mes_pings", "modifier_tableau", "presence"]
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


# ------------------------------------------------------------- documents

import base64  # noqa: E402


def upload(c, files, data=None, room_id="roblox"):
    return c.post("/api/agentchat/rooms/%s/files" % room_id, files=files, data=data or {})


def agent_upload(c, key, files, data=None):
    headers = {"Authorization": "Bearer " + key} if key else {}
    return c.post("/mcp/agentchat/fichiers", files=files, data=data or {}, headers=headers)


def test_human_upload_and_download(ac_dir):
    c = make_client()
    setup_room(c)
    content = b"<html><script>alert(1)</script></html>"
    r = upload(c, {"file": ("rapport été.html", content, "text/html")}, {"text": "voilà"})
    assert r.status_code == 200, r.text
    msg = r.json()["message"]
    assert msg["author"] == "massii (humain)" and msg["kind"] == "humain"
    assert msg["text"] == "voilà"
    att = msg["attachment"]
    assert set(att) == {"id", "name", "size", "mime"}
    assert att["name"] == "rapport été.html" and att["size"] == len(content)
    assert att["mime"] == "text/html"
    r = c.get("/api/agentchat/rooms/roblox/files/%s" % att["id"])
    assert r.status_code == 200
    assert r.content == content
    assert r.headers["content-disposition"] == "attachment; filename*=UTF-8''rapport%20%C3%A9t%C3%A9.html"
    assert r.headers["x-content-type-options"] == "nosniff"
    # le message relu contient la pièce jointe
    msgs = c.get("/api/agentchat/rooms/roblox/messages").json()["messages"]
    assert msgs[-1]["attachment"]["id"] == att["id"]
    # permissions
    fdir = ac_dir / "files" / "roblox"
    assert _mode(fdir) == 0o700 and _mode(ac_dir / "files") == 0o700
    assert _mode(fdir / att["id"]) == 0o600
    assert _mode(fdir / (att["id"] + ".json")) == 0o600
    meta = json.loads((fdir / (att["id"] + ".json")).read_text(encoding="utf-8"))
    assert meta["uploaded_by"] == "massii (humain)"
    assert len(meta["sha256"]) == 64


def test_upload_empty_text_and_reply(ac_dir):
    c = make_client()
    setup_room(c)
    c.post("/api/agentchat/rooms/roblox/messages", json={"text": "envoie le fichier"})
    r = upload(c, {"file": ("a.txt", b"abc", "text/plain")}, {"reply_to": "1"})
    assert r.status_code == 200, r.text
    assert r.json()["message"]["text"] == ""
    assert r.json()["message"]["reply_to"] == 1
    r = upload(c, {"file": ("a.txt", b"abc", "text/plain")}, {"reply_to": "pas un nombre"})
    assert r.status_code == 400
    r = upload(c, {"file": ("a.txt", b"abc", "text/plain")}, {"reply_to": "99"})
    assert r.status_code == 400
    # aucun document orphelin après un message refusé
    assert len(list((ac_dir / "files" / "roblox").glob("*.json"))) == 1


def test_upload_name_cleaned(ac_dir):
    c = make_client()
    setup_room(c)
    r = upload(c, {"file": ("../../etc/passwd", b"x", "text/plain")})
    assert r.status_code == 200
    name = r.json()["message"]["attachment"]["name"]
    assert "/" not in name and ".." not in name
    assert store.clean_file_name("a\x00b\nc.txt") == "abc.txt"
    assert store.clean_file_name("..") == "document"
    assert store.clean_file_name("") == "document"
    assert store.clean_file_name("x" * 300 + ".txt") == "x" * 120
    assert store.clean_file_name("C:\\Users\\m\\pet.fbx") == "pet.fbx"


def test_upload_empty_file_refused(ac_dir):
    c = make_client()
    setup_room(c)
    r = upload(c, {"file": ("a.txt", b"", "text/plain")})
    assert r.status_code == 400
    r = c.post("/api/agentchat/rooms/roblox/files", data={"text": "x"})
    assert r.status_code == 400


def test_upload_too_big_413(ac_dir, monkeypatch):
    monkeypatch.setattr(store, "MAX_FILE", 10)
    c = make_client()
    setup_room(c)
    r = upload(c, {"file": ("a.bin", b"x" * 11, "application/octet-stream")})
    assert r.status_code == 413
    assert upload(c, {"file": ("a.bin", b"x" * 10, "application/octet-stream")}).status_code == 200


def test_room_quota(ac_dir, monkeypatch):
    monkeypatch.setattr(store, "MAX_ROOM_FILES", 25)
    c = make_client()
    setup_room(c)
    assert upload(c, {"file": ("a.bin", b"x" * 20, "application/octet-stream")}).status_code == 200
    r = upload(c, {"file": ("b.bin", b"x" * 6, "application/octet-stream")})
    assert r.status_code == 400
    assert "Quota" in r.json()["detail"]
    assert upload(c, {"file": ("c.bin", b"x" * 5, "application/octet-stream")}).status_code == 200


def test_download_invalid_or_missing(ac_dir):
    c = make_client()
    setup_room(c)
    assert c.get("/api/agentchat/rooms/roblox/files/0123456789abcdef").status_code == 404
    assert c.get("/api/agentchat/rooms/roblox/files/abc").status_code == 400
    assert c.get("/api/agentchat/rooms/roblox/files/..%2F..%2Frooms.json").status_code in (400, 404)
    assert c.get("/api/agentchat/rooms/roblox/files/0123456789ABCDEF").status_code == 400
    assert c.get("/api/agentchat/rooms/nope/files/0123456789abcdef").status_code == 404
    with pytest.raises(store.Invalid):
        store.get_file("roblox", "../rooms.json")
    with pytest.raises(store.Invalid):
        store.get_file("../x", "0123456789abcdef")


def test_files_other_roles_forbidden(ac_dir):
    admin, other = make_admin_and("player")
    setup_room(admin)
    fid = upload(admin, {"file": ("a.txt", b"abc", "text/plain")}).json()["message"]["attachment"]["id"]
    assert upload(other, {"file": ("a.txt", b"abc", "text/plain")}).status_code == 403
    assert other.get("/api/agentchat/rooms/roblox/files/%s" % fid).status_code == 403
    assert other.get("/api/agentchat/rooms/roblox/pings").status_code == 403
    _, dev = make_admin_and("developer")
    assert dev.get("/api/agentchat/rooms/roblox/files/%s" % fid).status_code == 200


def test_agent_upload_download_bearer(ac_dir):
    c = make_client()
    setup_room(c)
    key = add_member(c)["key"]
    blob = bytes(range(256)) * 10
    assert agent_upload(c, None, {"file": ("pet.fbx", blob, "application/octet-stream")}).status_code == 401
    assert agent_upload(c, "oac_faux", {"file": ("pet.fbx", blob, "application/octet-stream")}).status_code == 401
    r = agent_upload(c, key, {"file": ("pet.fbx", blob, "application/octet-stream")},
                     {"text": "modèle du pet", "auteur": "Usurpateur"})
    assert r.status_code == 200, r.text
    msg = r.json()["message"]
    assert msg["author"] == "Claude-Pets" and msg["kind"] == "info"
    fid = msg["attachment"]["id"]
    assert c.get("/mcp/agentchat/fichiers/%s" % fid).status_code == 401
    r = c.get("/mcp/agentchat/fichiers/%s" % fid, headers={"Authorization": "Bearer " + key})
    assert r.status_code == 200 and r.content == blob
    assert r.headers["content-disposition"].startswith("attachment;")
    assert r.headers["x-content-type-options"] == "nosniff"
    r = c.get("/mcp/agentchat/fichiers/zzz", headers={"Authorization": "Bearer " + key})
    assert r.status_code == 400


def test_agent_cannot_read_other_room_file(ac_dir):
    c = make_client()
    setup_room(c)
    setup_room(c, "autre", "Autre")
    key_autre = add_member(c, "autre", "Claude-Autre")["key"]
    fid = upload(c, {"file": ("s.txt", b"secret", "text/plain")}).json()["message"]["attachment"]["id"]
    r = c.get("/mcp/agentchat/fichiers/%s" % fid, headers={"Authorization": "Bearer " + key_autre})
    assert r.status_code == 404
    res = call_tool(c, key_autre, "lire_document", {"id": fid})
    assert res["isError"] is True


def test_mcp_envoyer_document_text_and_read_window(ac_dir):
    c = make_client()
    setup_room(c)
    key = add_member(c)["key"]
    contenu = "é" * 30 + "FIN"
    res = call_tool(c, key, "envoyer_document", {"nom": "notes.md", "contenu": contenu,
                                                 "texte": "mes notes"})
    assert res["isError"] is False, res
    out = res["content"][0]["text"]
    assert out.startswith("document ") and "(message #1)" in out
    fid = out.split()[1]
    msgs = c.get("/api/agentchat/rooms/roblox/messages").json()["messages"]
    assert msgs[0]["attachment"]["id"] == fid and msgs[0]["text"] == "mes notes"
    assert msgs[0]["attachment"]["mime"] == "text/markdown"
    out = call_tool(c, key, "lire_document", {"id": fid})["content"][0]["text"]
    assert "caractères 0-33 sur 33" in out and contenu in out
    out = call_tool(c, key, "lire_document", {"id": fid, "debut": 30, "longueur": 2})["content"][0]["text"]
    assert "caractères 30-32 sur 33" in out and out.endswith("FI")
    assert 'debut=32' in out
    # le message affiché par lire_messages porte la pièce jointe
    out = call_tool(c, key, "lire_messages")["content"][0]["text"]
    assert "[doc %s « notes.md »" % fid in out
    # l'humain peut télécharger ce que l'agent a envoyé
    r = c.get("/api/agentchat/rooms/roblox/files/%s" % fid)
    assert r.content == contenu.encode("utf-8")


def test_mcp_envoyer_document_base64_and_binary_read(ac_dir):
    c = make_client()
    setup_room(c)
    key = add_member(c)["key"]
    blob = b"\xff\xfe\x00\x01" * 100
    b64 = base64.b64encode(blob).decode("ascii")
    wrapped = "\n".join(b64[i:i + 76] for i in range(0, len(b64), 76))
    res = call_tool(c, key, "envoyer_document", {"nom": "pet.blend", "contenu": wrapped, "base64": True})
    assert res["isError"] is False, res
    fid = res["content"][0]["text"].split()[1]
    out = call_tool(c, key, "lire_document", {"id": fid})["content"][0]["text"]
    assert "octets 0-400 sur 400" in out
    assert base64.b64decode(out.split("---\n", 1)[1].split("\n")[0]) == blob
    assert "curl" in out and "/mcp/agentchat/fichiers/%s" % fid in out
    out = call_tool(c, key, "lire_document", {"id": fid, "debut": 4, "longueur": 4})["content"][0]["text"]
    assert "octets 4-8 sur 400" in out
    assert base64.b64decode(out.split("---\n", 1)[1].split("\n")[0]) == blob[4:8]
    res = call_tool(c, key, "envoyer_document", {"nom": "x.bin", "contenu": "pas@du base64!", "base64": True})
    assert res["isError"] is True and "base64 invalide" in res["content"][0]["text"]
    res = call_tool(c, key, "envoyer_document", {"nom": "x.bin", "contenu": ""})
    assert res["isError"] is True
    res = call_tool(c, key, "envoyer_document", {"nom": "", "contenu": "x"})
    assert res["isError"] is True


def test_mcp_envoyer_document_too_big_inline(ac_dir, monkeypatch):
    monkeypatch.setattr(acr, "INLINE_DOC_MAX", 10)
    c = make_client()
    setup_room(c)
    key = add_member(c)["key"]
    res = call_tool(c, key, "envoyer_document", {"nom": "a.txt", "contenu": "x" * 11})
    assert res["isError"] is True
    txt = res["content"][0]["text"]
    assert "curl" in txt and "/mcp/agentchat/fichiers" in txt and "~/.claude.json" in txt


def test_mcp_lire_document_image(ac_dir):
    c = make_client()
    setup_room(c)
    key = add_member(c)["key"]
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 20
    fid = upload(c, {"file": ("pet.png", png, "image/png")}).json()["message"]["attachment"]["id"]
    res = call_tool(c, key, "lire_document", {"id": fid})
    assert res["isError"] is False
    img = res["content"][0]
    assert img["type"] == "image" and img["mimeType"] == "image/png"
    assert base64.b64decode(img["data"]) == png
    assert res["content"][1]["type"] == "text" and "pet.png" in res["content"][1]["text"]
    res = call_tool(c, key, "lire_document", {"id": "../../x"})
    assert res["isError"] is True
    res = call_tool(c, key, "lire_document", {"id": "0123456789abcdef"})
    assert res["isError"] is True


def test_mcp_lister_documents(ac_dir):
    c = make_client()
    setup_room(c)
    key = add_member(c)["key"]
    assert call_tool(c, key, "lister_documents")["content"][0]["text"] == "(aucun document)"
    upload(c, {"file": ("premier.txt", b"a" * 2000, "text/plain")})
    call_tool(c, key, "envoyer_document", {"nom": "second.txt", "contenu": "b"})
    out = call_tool(c, key, "lister_documents")["content"][0]["text"]
    lines = out.splitlines()
    assert len(lines) == 2
    assert "premier.txt" in lines[0] and "2,0 Ko" in lines[0] and "massii (humain)" in lines[0]
    assert "second.txt" in lines[1] and "Claude-Pets" in lines[1]
    assert [f["name"] for f in store.list_files("roblox")] == ["premier.txt", "second.txt"]


# ------------------------------------------------------------- mentions / pings

def test_mentions_detection(ac_dir):
    c = make_client()
    setup_room(c)
    add_member(c, name="Claude")
    add_member(c, name="Claude de Massii")
    add_member(c, name="Claude-Map")
    r = c.post("/api/agentchat/rooms/roblox/messages",
               json={"text": "@claude de massii fais X, puis @Claude-Map"})
    assert r.json()["message"]["mentions"] == ["Claude de Massii", "Claude-Map"]
    r = c.post("/api/agentchat/rooms/roblox/messages",
               json={"text": "@Claude-Map et @Claude de Massii et @Claude"})
    assert r.json()["message"]["mentions"] == ["Claude-Map", "Claude de Massii", "Claude"]
    r = c.post("/api/agentchat/rooms/roblox/messages", json={"text": "@Claudette ? mail@claude"})
    assert r.json()["message"]["mentions"] == []
    r = c.post("/api/agentchat/rooms/roblox/messages", json={"text": "salut",
                                                             "mentions": ["claude-map", "Inconnu", "@Claude"]})
    assert r.json()["message"]["mentions"] == ["Claude-Map", "Claude"]
    r = c.post("/api/agentchat/rooms/roblox/messages", json={"text": "@tous réunion"})
    assert r.json()["message"]["mentions"] == ["Claude", "Claude de Massii", "Claude-Map"]


def test_mentions_all_excludes_author_and_revoked(ac_dir):
    c = make_client()
    setup_room(c)
    key = add_member(c, name="Claude-Pets")["key"]
    add_member(c, name="Claude-Map")
    gone = add_member(c, name="Claude-Old")["member"]["id"]
    c.post("/api/agentchat/rooms/roblox/members/%s/revoke" % gone)
    call_tool(c, key, "envoyer_message", {"texte": "@all on teste ; @Claude-Old aussi"})
    msgs = c.get("/api/agentchat/rooms/roblox/messages").json()["messages"]
    assert msgs[-1]["mentions"] == ["Claude-Map"]


def test_pings_open_then_closed(ac_dir):
    c = make_client()
    setup_room(c)
    key = add_member(c, name="Claude-Pets")["key"]
    key_map = add_member(c, name="Claude-Map")["key"]
    r = c.post("/api/agentchat/rooms/roblox/messages", json={"text": "@Claude-Pets fais le pet chat"})
    pid = r.json()["message"]["id"]
    # pied [PING] sur un autre outil
    out = call_tool(c, key, "lire_tableau")["content"][0]["text"]
    assert "[PING] 1 ping(s) pour toi non traité(s) : #%d" % pid in out
    assert "mes_pings" in out
    # pas de pied pour celui qui n'est pas pingé
    assert "[PING]" not in call_tool(c, key_map, "lire_tableau")["content"][0]["text"]
    # mes_pings liste et consigne, sans pied
    out = call_tool(c, key, "mes_pings")["content"][0]["text"]
    assert "#%d" % pid in out and "fais le pet chat" in out and "reponse_a" in out
    assert "[PING]" not in out
    assert c.get("/api/agentchat/rooms/roblox/pings").json() == {
        "pings": {"Claude-Pets": [pid], "Claude-Map": []}}
    r = c.get("/mcp/agentchat/pings", headers={"Authorization": "Bearer " + key})
    assert r.status_code == 200
    body = r.json()
    assert body["member"] == "Claude-Pets"
    assert body["pings"][0]["id"] == pid and body["pings"][0]["author"] == "massii (humain)"
    assert c.get("/mcp/agentchat/pings").status_code == 401
    # une réponse d'un AUTRE membre ne ferme pas le ping
    call_tool(c, key_map, "envoyer_message", {"texte": "je regarde", "reponse_a": pid})
    assert store.open_pings("roblox", "Claude-Pets")[0]["id"] == pid
    # la réponse du membre pingé ferme le ping (et le pied disparaît tout de suite)
    res = call_tool(c, key, "envoyer_message", {"texte": "fait", "type": "fait", "reponse_a": pid})
    assert "[PING]" not in res["content"][0]["text"]
    assert store.open_pings("roblox", "Claude-Pets") == []
    assert c.get("/mcp/agentchat/pings", headers={"Authorization": "Bearer " + key}).json()["pings"] == []
    assert "Aucun ping" in call_tool(c, key, "mes_pings")["content"][0]["text"]


def test_ping_footer_absent_on_error(ac_dir):
    c = make_client()
    setup_room(c)
    key = add_member(c, name="Claude-Pets")["key"]
    c.post("/api/agentchat/rooms/roblox/messages", json={"text": "@Claude-Pets ping"})
    res = call_tool(c, key, "envoyer_message", {})
    assert res["isError"] is True and "[PING]" not in res["content"][0]["text"]


def test_ping_footer_on_image_result(ac_dir):
    c = make_client()
    setup_room(c)
    key = add_member(c, name="Claude-Pets")["key"]
    fid = upload(c, {"file": ("a.png", b"\x89PNG", "image/png")},
                 {"text": "@Claude-Pets regarde"}).json()["message"]["attachment"]["id"]
    res = call_tool(c, key, "lire_document", {"id": fid})
    assert res["content"][0]["type"] == "image"
    assert "[PING]" in res["content"][1]["text"]


def test_self_mention_is_not_a_ping(ac_dir):
    c = make_client()
    setup_room(c)
    key = add_member(c, name="Claude-Pets")["key"]
    call_tool(c, key, "envoyer_message", {"texte": "note pour @Claude-Pets"})
    assert store.open_pings("roblox", "Claude-Pets") == []


def test_legacy_messages_without_new_keys(ac_dir):
    c = make_client()
    setup_room(c)
    key = add_member(c, name="Claude-Pets")["key"]
    legacy = {"id": 1, "ts": "2026-10-01T00:00:00+00:00", "author": "massii (humain)",
              "kind": "humain", "text": "@Claude-Pets ancien", "reply_to": None}
    (ac_dir / "roblox.jsonl").write_text(json.dumps(legacy) + "\n", encoding="utf-8")
    msgs = c.get("/api/agentchat/rooms/roblox/messages").json()["messages"]
    assert msgs[0]["text"] == "@Claude-Pets ancien"
    out = call_tool(c, key, "lire_messages")["content"][0]["text"]
    assert "#1" in out and "ancien" in out and "[PING]" not in out
    assert c.get("/api/agentchat/rooms/roblox/pings").json() == {"pings": {"Claude-Pets": []}}
    call_tool(c, key, "envoyer_message", {"texte": "nouveau"})
    msgs = c.get("/api/agentchat/rooms/roblox/messages").json()["messages"]
    assert msgs[-1]["id"] == 2 and msgs[-1]["mentions"] == []
    assert "attachment" not in msgs[-1]


def test_server_version_and_instructions(ac_dir):
    c = make_client()
    setup_room(c)
    key = add_member(c)["key"]
    res = mcp(c, key, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}).json()["result"]
    assert res["serverInfo"]["version"] == "1.1.0"
    ins = res["instructions"]
    assert "mes_pings" in ins and "@Nom" in ins and "envoyer_document" in ins and "curl" in ins
