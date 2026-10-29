import pytest

from backend.agentchat import presence, store
from backend.agentchat.tests.test_agentchat import (  # noqa: F401
    ac_dir, add_member, call_tool, make_client, mcp, setup_room)


@pytest.fixture(autouse=True)
def _clean_presence():
    presence.reset()
    yield
    presence.reset()


def auth(key):
    return {"Authorization": "Bearer " + key}


def post_status(c, key, body):
    return c.post("/mcp/agentchat/statut", json=body, headers=auth(key) if key else {})


def pres(c, room="roblox"):
    r = c.get("/api/agentchat/rooms/%s/presence" % room)
    assert r.status_code == 200, r.text
    return {m["name"]: m for m in r.json()["members"]}


def setup(ac_dir):
    c = make_client()
    setup_room(c)
    m = add_member(c)
    return c, m["key"], m["member"]["id"]


# --------------------------------------------------------------- HTTP

def test_statut_requires_key(ac_dir):
    c, key, _ = setup(ac_dir)
    assert post_status(c, None, {"state": "working"}).status_code == 401
    assert post_status(c, "oac_bad", {"state": "working"}).status_code == 401


def test_statut_then_read(ac_dir):
    c, key, _ = setup(ac_dir)
    r = post_status(c, key, {"state": "working", "session": "s1", "five_hour_pct": 42.5,
                             "five_hour_resets_at": 1900000000, "seven_day_pct": 13})
    assert r.status_code == 200 and r.json() == {"ok": True}
    m = pres(c)["Claude-Pets"]
    assert m["online"] and m["working"] and m["state"] == "working"
    assert m["sessions_working"] == 1
    assert m["five_hour"] == {"pct": 42.5, "resets_at": 1900000000}
    assert m["seven_day"]["pct"] == 13.0 and m["seven_day"]["resets_at"] is None


def test_invalid_values_ignored_and_clamped(ac_dir):
    c, key, _ = setup(ac_dir)
    assert post_status(c, key, {"state": "bogus", "five_hour_pct": "x",
                                "seven_day_pct": 250, "five_hour_resets_at": "z"}).status_code == 200
    m = pres(c)["Claude-Pets"]
    assert m["five_hour"] is None
    assert m["seven_day"]["pct"] == 100.0
    assert m["state"] == "idle"


def test_member_from_key_only(ac_dir):
    c = make_client()
    setup_room(c)
    a = add_member(c, name="Alice")
    add_member(c, name="Bob")
    post_status(c, a["key"], {"state": "working", "member_id": "x", "name": "Bob"})
    p = pres(c)
    assert p["Alice"]["working"] and not p["Bob"]["working"]


def test_mcp_and_pings_update_last_seen(ac_dir):
    c, key, _ = setup(ac_dir)
    assert pres(c)["Claude-Pets"]["last_seen_s"] is None
    call_tool(c, key, "lire_tableau")
    assert pres(c)["Claude-Pets"]["online"] is True
    presence.reset()
    assert c.get("/mcp/agentchat/pings", headers=auth(key)).status_code == 200
    assert pres(c)["Claude-Pets"]["online"] is True


def test_revoked_member_absent(ac_dir):
    c, key, mid = setup(ac_dir)
    c.post("/api/agentchat/rooms/roblox/members/%s/revoke" % mid)
    assert pres(c) == {}


def test_presence_forbidden_for_non_chat_user(ac_dir):
    c = make_client()
    setup_room(c)
    other = make_client(is_admin=False, role="player")
    assert other.get("/api/agentchat/rooms/roblox/presence").status_code == 403


# --------------------------------------------------------------- horloge simulée

class Clock(object):
    def __init__(self):
        self.t = 1000000.0

    def __call__(self):
        return self.t


def test_online_working_expiry():
    clk = Clock()
    presence.set_status("r", "m", session="a", state="working", now=clk)
    v = presence.view("r", "m", "n", clk)
    assert v["online"] and v["working"]
    clk.t += 10 * 60          # > 5 min sans signe de vie, working encore < 15 min
    v = presence.view("r", "m", "n", clk)
    assert v["working"] and v["online"]
    clk.t += 6 * 60           # > 15 min : working périmé, plus vu depuis 16 min
    v = presence.view("r", "m", "n", clk)
    assert not v["working"] and not v["online"] and v["state"] == "offline"


def test_idle_online_then_offline():
    clk = Clock()
    presence.set_status("r", "m", session="a", state="idle", now=clk)
    clk.t += 4 * 60
    assert presence.view("r", "m", "n", clk)["online"]
    clk.t += 2 * 60
    assert not presence.view("r", "m", "n", clk)["online"]


def test_session_end_offline_only_own_session():
    clk = Clock()
    presence.set_status("r", "m", session="a", state="working", now=clk)
    presence.set_status("r", "m", session="b", state="working", now=clk)
    presence.set_status("r", "m", session="a", state="offline", now=clk)
    v = presence.view("r", "m", "n", clk)
    assert v["online"] and v["sessions_working"] == 1
    presence.set_status("r", "m", session="b", state="offline", now=clk)
    v = presence.view("r", "m", "n", clk)
    assert not v["online"] and not v["working"]


def test_touch_makes_online_without_session():
    clk = Clock()
    presence.touch("r", "m", clk)
    assert presence.view("r", "m", "n", clk)["online"]
    clk.t += 400
    assert not presence.view("r", "m", "n", clk)["online"]


def test_limits_expire_after_6h_and_latest_kept():
    clk = Clock()
    presence.set_status("r", "m", session="a", five_hour_pct=10, now=clk)
    clk.t += 60
    presence.set_status("r", "m", session="b", five_hour_pct=55, now=clk)
    v = presence.view("r", "m", "n", clk)
    assert v["five_hour"]["pct"] == 55.0 and v["limits_age_s"] == 0
    clk.t += 6 * 3600 + 1
    v = presence.view("r", "m", "n", clk)
    assert v["five_hour"] is None and v["limits_age_s"] is None


def test_sessions_purged_and_capped():
    clk = Clock()
    for i in range(25):
        clk.t += 1
        presence.set_status("r", "m", session="s%d" % i, state="working", now=clk)
    assert len(presence._STATE[("r", "m")]["sessions"]) == presence.MAX_SESSIONS
    clk.t += 2 * 3600
    presence.set_status("r", "m", session="z", now=clk)
    assert list(presence._STATE[("r", "m")]["sessions"]) == ["z"]


def test_offline_note():
    clk = Clock()
    assert "redémarrage" in presence.offline_note(presence.view("r", "m", "n", clk))
    presence.touch("r", "m", clk)
    clk.t += 42 * 60
    assert "42 min" in presence.offline_note(presence.view("r", "m", "n", clk))
    presence.touch("r", "m", clk)
    assert presence.offline_note(presence.view("r", "m", "n", clk)) is None


# --------------------------------------------------------------- MCP

def test_presence_tool_and_offline_warning(ac_dir):
    c = make_client()
    setup_room(c)
    a = add_member(c, name="Alice")
    b = add_member(c, name="Bob")
    post_status(c, b["key"], {"state": "working", "session": "s", "five_hour_pct": 42})
    out = call_tool(c, a["key"], "presence")["content"][0]["text"]
    assert "Bob : travaille · 5 h : 42 %" in out
    assert "Alice : en ligne, inactif" in out
    # Alice mentionne Carl (hors ligne, jamais vu) -> avertissement
    add_member(c, name="Carl")
    out = call_tool(c, a["key"], "envoyer_message",
                    {"texte": "@Carl tu peux valider ?", "type": "demande"})["content"][0]["text"]
    assert "envoyé" in out and "Attention : Carl est hors ligne" in out
    assert "redémarrage" in out
    # mention d'un membre en ligne : pas d'avertissement
    out = call_tool(c, a["key"], "envoyer_message", {"texte": "@Bob salut"})["content"][0]["text"]
    assert "Attention" not in out


def test_instructions_mention_offline_rule(ac_dir):
    c, key, _ = setup(ac_dir)
    r = mcp(c, key, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
    ins = r.json()["result"]["instructions"]
    assert "hors ligne" in ins and "presence" in ins
