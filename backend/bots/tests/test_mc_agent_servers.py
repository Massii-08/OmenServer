"""Tests du store des profils serveur MC Agent."""
import json
import pytest

from backend.bots import mc_agent_servers as ss


@pytest.fixture
def tmp_store(tmp_path, monkeypatch):
    monkeypatch.setattr(ss, "SERVERS_PATH", tmp_path / "servers.json")
    catalog = [
        {"id": "msg", "cmd": "/msg", "syntax": "/msg <j> <m>", "desc": "mp", "category": "communication"},
        {"id": "home", "cmd": "/home", "syntax": "/home [n]", "desc": "h", "category": "teleport"},
    ]
    cat_path = tmp_path / "catalog.json"
    cat_path.write_text(json.dumps(catalog), encoding="utf-8")
    monkeypatch.setattr(ss, "CATALOG_PATH", cat_path)
    return tmp_path


def test_load_catalog(tmp_store):
    assert any(c["id"] == "msg" for c in ss.load_catalog())


def test_create_and_list(tmp_store):
    s = ss.create_server({"name": "Paper", "host": "h", "port": 25565, "commands": ["msg", "home"]})
    assert s["id"]
    servers = ss.load_servers()
    assert len(servers) == 1 and servers[0]["name"] == "Paper"


def test_create_filters_unknown_commands(tmp_store):
    s = ss.create_server({"name": "X", "commands": ["msg", "ghost", "home"]})
    assert s["commands"] == ["msg", "home"]


def test_create_defaults_invalid_intelligence_and_auth(tmp_store):
    s = ss.create_server({"name": "X", "intelligence": "genius", "auth": "hack"})
    assert s["intelligence"] == "intermediaire"
    assert s["auth"] == "offline"


def test_update_existing(tmp_store):
    s = ss.create_server({"name": "A"})
    out = ss.update_server(s["id"], {"name": "B", "commands": ["msg"]})
    assert out["name"] == "B" and out["commands"] == ["msg"]


def test_update_unknown_returns_none(tmp_store):
    assert ss.update_server("deadbeef", {"name": "X"}) is None


def test_update_rejects_bad_id(tmp_store):
    assert ss.update_server("../etc", {"name": "X"}) is None


def test_delete(tmp_store):
    s = ss.create_server({"name": "A"})
    assert ss.delete_server(s["id"]) is True
    assert ss.load_servers() == []


def test_delete_unknown(tmp_store):
    assert ss.delete_server("nope") is False


def test_custom_commands_sanitised(tmp_store):
    s = ss.create_server({"name": "X", "custom": [
        {"cmd": "/kit", "syntax": "/kit <n>", "desc": "kit"},
        {"cmd": "no-slash", "syntax": "x"},
        {"nope": 1},
    ]})
    assert len(s["custom"]) == 1 and s["custom"][0]["cmd"] == "/kit"


def test_resolve_commands(tmp_store):
    s = ss.create_server({"name": "X", "commands": ["home"],
                          "custom": [{"cmd": "/kit", "syntax": "/kit <n>", "desc": "k"}]})
    resolved = ss.resolve_commands(s)
    cmds = [c["cmd"] for c in resolved]
    assert "/home" in cmds and "/kit" in cmds
    assert all("syntax" in c for c in resolved)


def test_create_sanitises_trusted(tmp_store):
    s = ss.create_server({"name": "X", "trusted": ["Massii_08", " massii_08 ", "Pote2", 42, ""]})
    # dédup insensible à la casse + trim + drop non-string/vide
    assert s["trusted"] == ["Massii_08", "Pote2"]


def test_create_trade_valid_and_invalid(tmp_store):
    ok = ss.create_server({"name": "X", "trade": {"acceptCmd": "/trade accept", "requestPattern": "x"}})
    assert ok["trade"]["acceptCmd"] == "/trade accept"
    no = ss.create_server({"name": "Y", "trade": {"requestPattern": "x"}})  # pas d'acceptCmd
    assert no["trade"] is None
    no2 = ss.create_server({"name": "Z"})  # trade absent
    assert no2["trade"] is None


def test_resolve_policy(tmp_store):
    s = ss.create_server({"name": "X", "trusted": ["Bob"], "trade": {"acceptCmd": "/t accept"}})
    pol = ss.resolve_policy(s)
    assert pol["trusted"] == ["Bob"]
    assert pol["trade"]["acceptCmd"] == "/t accept"


def test_resolve_policy_empty(tmp_store):
    s = ss.create_server({"name": "X"})
    pol = ss.resolve_policy(s)
    assert pol == {"trusted": [], "trade": None}


def test_clean_server_language_default_and_valid(tmp_path, monkeypatch):
    import backend.bots.mc_agent_servers as s
    monkeypatch.setattr(s, "SERVERS_PATH", tmp_path / "srv.json")
    srv = s.create_server({"name": "X", "host": "h"})
    assert srv["language"] == "fr"  # défaut
    srv2 = s.create_server({"name": "Y", "host": "h", "language": "it"})
    assert srv2["language"] == "it"
    srv3 = s.create_server({"name": "Z", "host": "h", "language": "xx"})
    assert srv3["language"] == "fr"  # invalide → défaut


def test_migration_legacy_profile_gets_first_bot(tmp_path, monkeypatch):
    from backend.bots import mc_agent_servers as S
    monkeypatch.setattr(S, "SERVERS_PATH", tmp_path / "srv.json")
    S._save_servers([{"id": "abc123", "name": "Old", "host": "h", "user": "OldBot", "auth": "offline"}])
    one = S.load_servers()[0]
    assert len(one["bots"]) == 1
    assert one["bots"][0]["username"] == "OldBot" and one["bots"][0]["role"] == "worker"
    bid = one["bots"][0]["id"]
    two = S.load_servers()[0]                    # idempotent
    assert len(two["bots"]) == 1 and two["bots"][0]["id"] == bid


def test_clean_server_has_roster_and_login_fields():
    from backend.bots import mc_agent_servers as S
    s = S._clean_server({"name": "X", "host": "h", "has_login": True,
                         "login_command": "/login {pwd}", "bots": "pasuneliste"}, "abc123")
    assert s["bots"] == []                      # défaut sûr (string → [])
    assert s["has_login"] is True
    assert s["login_command"] == "/login {pwd}"


def test_add_remove_bot(tmp_path, monkeypatch):
    from backend.bots import mc_agent_servers as S
    monkeypatch.setattr(S, "SERVERS_PATH", tmp_path / "srv.json")
    g = S.create_server({"name": "G", "host": "h"})
    b = S.add_bot(g["id"], role="mapper", username="Mapper1", auth="offline")
    assert b["role"] == "mapper" and b["username"] == "Mapper1"
    assert S.add_bot(g["id"], role="mapper", username="mapper1", auth="offline") is None  # dup casse
    assert S.remove_bot(g["id"], b["id"]) is True
    assert S.get_server(g["id"])["bots"] == []


def test_update_server_preserves_roster_when_payload_has_no_bots(tmp_path, monkeypatch):
    from backend.bots import mc_agent_servers as S
    monkeypatch.setattr(S, "SERVERS_PATH", tmp_path / "srv.json")
    g = S.create_server({"name": "G", "host": "h"})
    S.add_bot(g["id"], role="worker", username="W1", auth="offline")
    out = S.update_server(g["id"], {"name": "G2", "host": "h"})
    assert [b["username"] for b in out["bots"]] == ["W1"]
