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
