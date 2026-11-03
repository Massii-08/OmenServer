"""Claude personnels : une clé par compte, valable dans tous ses salons."""
import json

import pytest

from backend.agentchat import presence, store
from backend.agentchat.tests.test_agentchat import (  # noqa: F401
    _mode, ac_dir, add_member, call_tool, make_admin_and, make_client, mcp, setup_room)


@pytest.fixture(autouse=True)
def _clean_presence():
    presence.reset()
    yield
    presence.reset()


def auth(key):
    return {"Authorization": "Bearer " + key}


def make_personal(admin, username, name):
    r = admin.post("/api/agentchat/claudes/%s" % username, json={"name": name})
    assert r.status_code == 200, r.text
    return r.json()


def members(admin, room_id):
    room = next(r for r in admin.get("/api/agentchat/rooms").json()["rooms"] if r["room_id"] == room_id)
    return room["members"]


def active(admin, room_id):
    return [m for m in members(admin, room_id) if not m["revoked"]]


def text_of(res):
    return "\n".join(c.get("text", "") for c in res["content"])


# ------------------------------------------------------------- REST admin

def test_claudes_routes_admin_only(ac_dir):
    admin, abdull = make_admin_and("developer", username="abdull")
    assert abdull.get("/api/agentchat/claudes").status_code == 403
    assert abdull.post("/api/agentchat/claudes/abdull", json={"name": "X"}).status_code == 403
    assert abdull.post("/api/agentchat/claudes/abdull/revoke").status_code == 403
    assert abdull.post("/api/agentchat/claudes/abdull/rename", json={"name": "Y"}).status_code == 403
    r = admin.get("/api/agentchat/claudes")
    assert r.status_code == 200
    assert [a["username"] for a in r.json()["accounts"]] == ["abdull", "chou", "massii"]
    assert all(a["claude"] is None for a in r.json()["accounts"])


def test_create_personal_key_once_and_command(ac_dir):
    admin = make_client()
    data = make_personal(admin, "abdull", "Claude d abdull1920")
    key = data["key"]
    assert key.startswith("oac_")
    assert data["claude"]["name"] == "Claude d abdull1920"
    assert data["mcp_command"] == (
        'claude mcp add --transport http -s user agentchat http://testserver/mcp/agentchat '
        '--header "Authorization: Bearer %s"' % key)
    assert key not in (ac_dir / "claudes.json").read_text(encoding="utf-8")
    assert _mode(ac_dir / "claudes.json") == 0o600
    listed = json.dumps(admin.get("/api/agentchat/claudes").json())
    assert key not in listed and "key_hash" not in listed
    acc = {a["username"]: a for a in admin.get("/api/agentchat/claudes").json()["accounts"]}
    assert acc["abdull"]["claude"]["name"] == "Claude d abdull1920"


def test_create_personal_unknown_or_wrong_role_400(ac_dir):
    admin = make_client()
    assert admin.post("/api/agentchat/claudes/fantome", json={"name": "X"}).status_code == 400
    assert admin.post("/api/agentchat/claudes/bob", json={"name": "X"}).status_code == 400
    assert admin.post("/api/agentchat/claudes/abdull/revoke").status_code == 404


def test_personal_name_unique_case_insensitive(ac_dir):
    admin = make_client()
    make_personal(admin, "abdull", "Claude A")
    r = admin.post("/api/agentchat/claudes/chou", json={"name": "claude a"})
    assert r.status_code == 409
    # le même compte peut garder son nom en régénérant
    make_personal(admin, "abdull", "Claude A")


def test_mcp_command_https_behind_proxy(ac_dir):
    from starlette.requests import Request
    from backend.agentchat import router as acr
    scope = {"type": "http", "method": "POST", "path": "/x", "headers": [(b"host", b"omenserver.org")],
             "scheme": "http", "server": ("omenserver.org", 80), "query_string": b"", "root_path": ""}
    assert acr._mcp_base(Request(scope)) == "https://omenserver.org/mcp/agentchat"
    scope["headers"] = [(b"host", b"localhost:8000")]
    scope["server"] = ("localhost", 8000)
    assert acr._mcp_base(Request(scope)) == "http://localhost:8000/mcp/agentchat"


# ------------------------------------------------------------- synchronisation

def test_creator_and_checked_people_added(ac_dir):
    admin = make_client()
    make_personal(admin, "massii", "Claude de Massii")
    make_personal(admin, "abdull", "Claude d abdull1920")
    r = admin.post("/api/agentchat/rooms", json={"room_id": "salon-a", "name": "A", "users": ["abdull"]})
    assert r.status_code == 200, r.text
    room = r.json()["room"]
    assert room["created_by"] == "massii"
    assert sorted((m["name"], m["owner"]) for m in room["members"]) == [
        ("Claude d abdull1920", "abdull"), ("Claude de Massii", "massii")]
    assert r.json()["keys"] == []
    assert all("key_hash" not in m for m in json.loads((ac_dir / "rooms.json").read_text())["salon-a"]["members"])


def test_guest_claude_same_name_as_personal_refused(ac_dir):
    admin = make_client()
    make_personal(admin, "abdull", "Claude d abdull1920")
    r = admin.post("/api/agentchat/rooms", json={"room_id": "x", "name": "x", "users": ["abdull"],
                                                  "claudes": ["claude d ABDULL1920"]})
    assert r.status_code == 400
    assert admin.get("/api/agentchat/rooms").json()["rooms"] == []


def test_check_and_uncheck_person(ac_dir):
    admin = make_client()
    key = make_personal(admin, "abdull", "Claude d abdull1920")["key"]
    setup_room(admin, "salon-a", "A")
    assert active(admin, "salon-a") == []
    r = admin.put("/api/agentchat/rooms/salon-a/users", json={"users": ["abdull"]})
    assert [m["name"] for m in r.json()["room"]["members"]] == ["Claude d abdull1920"]
    mid = active(admin, "salon-a")[0]["id"]
    assert not call_tool(admin, key, "envoyer_message", {"texte": "salut"}).get("isError")
    # décoché : retiré (révoqué), plus d'accès
    admin.put("/api/agentchat/rooms/salon-a/users", json={"users": []})
    assert active(admin, "salon-a") == []
    res = call_tool(admin, key, "lire_messages", {"salon": "salon-a"})
    assert res["isError"] and "introuvable" in text_of(res)
    # recoché : le MÊME membre revient (id et historique conservés), sans nouvelle clé
    admin.put("/api/agentchat/rooms/salon-a/users", json={"users": ["abdull"]})
    assert [m["id"] for m in active(admin, "salon-a")] == [mid]
    assert not call_tool(admin, key, "lire_messages", {"salon": "salon-a"}).get("isError")


def test_personal_created_after_room_joins_it(ac_dir):
    admin = make_client()
    setup_room(admin, "salon-a", "A", users=["abdull"])
    setup_room(admin, "salon-b", "B", users=["chou"])
    make_personal(admin, "abdull", "Claude d abdull1920")
    assert [m["owner"] for m in active(admin, "salon-a")] == ["abdull"]
    assert active(admin, "salon-b") == []
    acc = {a["username"]: a for a in admin.get("/api/agentchat/claudes").json()["accounts"]}
    assert acc["abdull"]["claude"]["rooms"] == ["salon-a"]


def test_rotate_invalidates_old_key(ac_dir):
    admin = make_client()
    setup_room(admin, "salon-a", "A", users=["abdull"])
    old = make_personal(admin, "abdull", "Claude d abdull1920")["key"]
    new = make_personal(admin, "abdull", "Claude d abdull1920")["key"]
    assert old != new
    assert mcp(admin, old, {"jsonrpc": "2.0", "id": 1, "method": "ping"}).status_code == 401
    assert mcp(admin, new, {"jsonrpc": "2.0", "id": 1, "method": "ping"}).status_code == 200
    assert len(active(admin, "salon-a")) == 1


def test_revoke_personal_removes_everywhere(ac_dir):
    admin = make_client()
    setup_room(admin, "salon-a", "A", users=["abdull"])
    setup_room(admin, "salon-b", "B", users=["abdull"])
    key = make_personal(admin, "abdull", "Claude d abdull1920")["key"]
    r = admin.post("/api/agentchat/claudes/abdull/revoke")
    assert r.status_code == 200 and r.json()["claude"]["revoked"]
    assert active(admin, "salon-a") == [] and active(admin, "salon-b") == []
    assert mcp(admin, key, {"jsonrpc": "2.0", "id": 1, "method": "ping"}).status_code == 401
    # recréée : revient dans les deux salons
    make_personal(admin, "abdull", "Claude d abdull1920")
    assert len(active(admin, "salon-a")) == 1 and len(active(admin, "salon-b")) == 1


def test_rename_updates_members(ac_dir):
    admin = make_client()
    setup_room(admin, "salon-a", "A", users=["abdull"])
    make_personal(admin, "abdull", "Claude d abdull1920")
    r = admin.post("/api/agentchat/claudes/abdull/rename", json={"name": "Claude Abdull"})
    assert r.status_code == 200
    assert [m["name"] for m in active(admin, "salon-a")] == ["Claude Abdull"]


def test_legacy_member_same_name_is_attached(ac_dir):
    """Cas réel des salons existants : « Claude d abdull1920 » a déjà une clé de salon."""
    admin = make_client()
    setup_room(admin, "salon-a", "A", users=["abdull"])
    legacy = add_member(admin, "salon-a", "Claude d abdull1920")
    legacy_key, legacy_id = legacy["key"], legacy["member"]["id"]
    call_tool(admin, legacy_key, "envoyer_message", {"texte": "avant"})
    admin.post("/api/agentchat/rooms/salon-a/messages", json={"text": "@Claude d abdull1920 fais X"})
    key = make_personal(admin, "abdull", "claude d ABDULL1920")["key"]
    ms = members(admin, "salon-a")
    assert len(ms) == 1, ms  # pas de doublon
    assert ms[0]["id"] == legacy_id and ms[0]["owner"] == "abdull"
    assert ms[0]["name"] == "claude d ABDULL1920"
    # l'ancienne clé de salon marche toujours, la personnelle aussi, même membre
    assert not call_tool(admin, legacy_key, "lire_messages").get("isError")
    res = call_tool(admin, key, "lire_messages")
    assert "avant" in text_of(res)
    # même membre = mêmes pings (les noms se comparent sans la casse)
    assert "fais X" in text_of(call_tool(admin, key, "mes_pings"))
    # révoquer directement un membre owner est refusé (il suit sa personne)
    assert admin.post("/api/agentchat/rooms/salon-a/members/%s/revoke" % legacy_id).status_code == 400


def test_existing_room_key_unchanged(ac_dir):
    admin = make_client()
    setup_room(admin)
    key = add_member(admin)["key"]
    make_personal(admin, "massii", "Claude de Massii")
    res = call_tool(admin, key, "envoyer_message", {"texte": "hello", "salon": "roblox"})
    assert not res.get("isError")
    res = call_tool(admin, key, "lire_messages", {"salon": "autre"})
    assert res["isError"] and "introuvable" in text_of(res)
    # le créateur (massii) a reçu son Claude, le membre à clé de salon est intact
    assert [m["name"] for m in active(admin, "roblox")] == ["Claude-Pets", "Claude de Massii"]


# ------------------------------------------------------------- MCP clé personnelle

def two_rooms_for_abdull(admin):
    setup_room(admin, "salon-a", "A", users=["abdull"])
    setup_room(admin, "salon-b", "B", users=["abdull", "chou"])
    setup_room(admin, "salon-c", "C", users=["chou"])
    return make_personal(admin, "abdull", "Claude d abdull1920")["key"]


def test_personal_key_two_rooms_with_salon(ac_dir):
    admin = make_client()
    key = two_rooms_for_abdull(admin)
    for rid in ("salon-a", "salon-b"):
        res = call_tool(admin, key, "envoyer_message", {"texte": "dans " + rid, "salon": rid})
        assert not res.get("isError"), res
    msgs = admin.get("/api/agentchat/rooms/salon-a/messages").json()["messages"]
    assert [(m["author"], m["text"]) for m in msgs] == [("Claude d abdull1920", "dans salon-a")]
    res = call_tool(admin, key, "lire_tableau", {"salon": "salon-b"})
    assert "Claude d abdull1920" in text_of(res)


def test_personal_key_without_salon_lists_rooms(ac_dir):
    admin = make_client()
    key = two_rooms_for_abdull(admin)
    res = call_tool(admin, key, "lire_messages")
    assert res["isError"]
    t = text_of(res)
    assert "salon-a" in t and "salon-b" in t and "salon-c" not in t


def test_personal_key_other_room_not_found(ac_dir):
    admin = make_client()
    key = two_rooms_for_abdull(admin)
    for rid in ("salon-c", "nexiste-pas"):
        res = call_tool(admin, key, "envoyer_message", {"texte": "x", "salon": rid})
        assert res["isError"] and "introuvable" in text_of(res)
    assert admin.get("/api/agentchat/rooms/salon-c/messages").json()["messages"] == []


def test_personal_key_single_room_implicit(ac_dir):
    admin = make_client()
    setup_room(admin, "salon-a", "A", users=["abdull"])
    key = make_personal(admin, "abdull", "Claude d abdull1920")["key"]
    assert not call_tool(admin, key, "envoyer_message", {"texte": "ok"}).get("isError")


def test_lister_salons_and_instructions(ac_dir):
    admin = make_client()
    key = two_rooms_for_abdull(admin)
    admin.post("/api/agentchat/rooms/salon-b/messages", json={"text": "@Claude d abdull1920 go"})
    t = text_of(call_tool(admin, key, "lister_salons"))
    assert "salon-a « A »" in t and "salon-b « B »" in t and "salon-c" not in t
    assert "pings ouverts pour toi : 1" in t
    res = mcp(admin, key, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}).json()["result"]
    ins = res["instructions"]
    assert "Claude d abdull1920" in ins and "salon-a" in ins and "salon-b" in ins
    assert "salon=" in ins and "mes_pings" in ins and "@Nom" in ins and "hors ligne" in ins


def test_personal_ping_footer_covers_all_rooms(ac_dir):
    admin = make_client()
    key = two_rooms_for_abdull(admin)
    admin.post("/api/agentchat/rooms/salon-a/messages", json={"text": "@Claude d abdull1920 a"})
    admin.post("/api/agentchat/rooms/salon-b/messages", json={"text": "@Claude d abdull1920 b"})
    t = text_of(call_tool(admin, key, "lire_tableau", {"salon": "salon-a"}))
    assert "[PING] 2 ping(s)" in t and "salon-a #1" in t and "salon-b #1" in t
    # répondre ferme le ping de ce salon seulement
    call_tool(admin, key, "envoyer_message", {"texte": "fait", "type": "fait", "reponse_a": 1,
                                             "salon": "salon-a"})
    t = text_of(call_tool(admin, key, "mes_pings", {"salon": "salon-b"}))
    assert "1 ping(s)" in t


def test_personal_presence_targets_room(ac_dir):
    admin = make_client()
    key = two_rooms_for_abdull(admin)
    call_tool(admin, key, "lire_messages", {"salon": "salon-a"})

    def online(rid):
        return [m["online"] for m in admin.get("/api/agentchat/rooms/%s/presence" % rid).json()["members"]]
    assert online("salon-a") == [True]
    assert online("salon-b") == [False]
    mcp(admin, key, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})  # sans salon : tous
    assert online("salon-b") == [True]


# ------------------------------------------------------------- REST agents

def test_agent_pings_personal(ac_dir):
    admin = make_client()
    key = two_rooms_for_abdull(admin)
    admin.post("/api/agentchat/rooms/salon-a/messages", json={"text": "@Claude d abdull1920 a"})
    admin.post("/api/agentchat/rooms/salon-b/messages", json={"text": "@Claude d abdull1920 b"})
    r = admin.get("/mcp/agentchat/pings", headers=auth(key))
    assert r.status_code == 200
    d = r.json()
    assert d["member"] == "Claude d abdull1920"
    assert sorted((p["salon"], p["text"]) for p in d["pings"]) == [
        ("salon-a", "@Claude d abdull1920 a"), ("salon-b", "@Claude d abdull1920 b")]
    r = admin.get("/mcp/agentchat/pings?salon=salon-b", headers=auth(key))
    assert [p["salon"] for p in r.json()["pings"]] == ["salon-b"]
    assert admin.get("/mcp/agentchat/pings?salon=salon-c", headers=auth(key)).status_code == 404


def test_agent_files_personal(ac_dir):
    admin = make_client()
    key = two_rooms_for_abdull(admin)
    files = {"file": ("m.txt", b"modele", "text/plain")}
    r = admin.post("/mcp/agentchat/fichiers", files=files, headers=auth(key))
    assert r.status_code == 400 and "salon-a" in r.json()["detail"]
    r = admin.post("/mcp/agentchat/fichiers?salon=salon-c", files=files, headers=auth(key))
    assert r.status_code == 404
    r = admin.post("/mcp/agentchat/fichiers?salon=salon-b", files=files, data={"text": "voilà"},
                   headers=auth(key))
    assert r.status_code == 200, r.text
    fid = r.json()["message"]["attachment"]["id"]
    assert r.json()["message"]["author"] == "Claude d abdull1920"
    r = admin.get("/mcp/agentchat/fichiers/%s?salon=salon-b" % fid, headers=auth(key))
    assert r.status_code == 200 and r.content == b"modele"
    assert admin.get("/mcp/agentchat/fichiers/%s?salon=salon-a" % fid, headers=auth(key)).status_code == 404


def test_curl_hint_includes_salon(ac_dir, monkeypatch):
    from backend.agentchat import router as acr
    monkeypatch.setattr(acr, "INLINE_DOC_MAX", 10)
    admin = make_client()
    key = two_rooms_for_abdull(admin)
    res = call_tool(admin, key, "envoyer_document", {"nom": "a.txt", "contenu": "x" * 50, "salon": "salon-b"})
    assert res["isError"] and "/mcp/agentchat/fichiers?salon=salon-b" in text_of(res)


def test_agent_status_personal(ac_dir):
    admin = make_client()
    key = two_rooms_for_abdull(admin)
    r = admin.post("/mcp/agentchat/statut", json={"state": "working", "session": "s1"}, headers=auth(key))
    assert r.status_code == 200
    for rid in ("salon-a", "salon-b"):
        m = admin.get("/api/agentchat/rooms/%s/presence" % rid).json()["members"][0]
        assert m["working"], rid
    r = admin.post("/mcp/agentchat/statut?salon=salon-a", json={"state": "idle", "session": "s1"},
                   headers=auth(key))
    assert r.status_code == 200
    assert not admin.get("/api/agentchat/rooms/salon-a/presence").json()["members"][0]["working"]
    assert admin.get("/api/agentchat/rooms/salon-b/presence").json()["members"][0]["working"]


# ------------------------------------------------------------- membres révoqués

def test_delete_revoked_member(ac_dir):
    admin, abdull = make_admin_and("developer", username="abdull")
    setup_room(admin, users=["abdull"])
    mid = add_member(admin)["member"]["id"]
    base = "/api/agentchat/rooms/roblox/members/%s" % mid
    assert admin.delete(base).status_code == 409  # actif
    admin.post(base + "/revoke")
    assert abdull.delete(base).status_code == 403
    assert admin.delete(base).status_code == 200
    assert members(admin, "roblox") == []
    assert admin.delete(base).status_code == 404


# ------------------------------------------------------------- store direct

def test_set_creator_migration(ac_dir):
    admin = make_client()
    setup_room(admin, "perfect-circle", "Perfect Circle", users=["abdull"])
    rooms = json.loads((ac_dir / "rooms.json").read_text(encoding="utf-8"))
    del rooms["perfect-circle"]["created_by"]  # salon d'avant le champ
    (ac_dir / "rooms.json").write_text(json.dumps(rooms), encoding="utf-8")
    add_member(admin, "perfect-circle", "Claude de Massii")
    store.create_or_rotate_personal("massii", "Claude de Massii")
    assert active(admin, "perfect-circle")[0]["owner"] is None  # rien sans created_by
    store.set_creator("perfect-circle", "massii")
    assert active(admin, "perfect-circle")[0]["owner"] == "massii"
    assert len(members(admin, "perfect-circle")) == 1
