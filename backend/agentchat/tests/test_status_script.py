import importlib.util
import io
import json
import os
import stat
from pathlib import Path

import pytest

_TOOLS = Path(__file__).resolve().parents[3] / "tools"


@pytest.fixture(scope="module")
def st():
    spec = importlib.util.spec_from_file_location("agentchat_status", str(_TOOLS / "agentchat_status.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


CFG = {"mcpServers": {
    "agentchat": {"type": "http", "url": "https://o.example/mcp/agentchat",
                  "headers": {"Authorization": "Bearer oac_a"}},
    "agentchat-metro": {"type": "http", "url": "https://o.example/mcp/agentchat",
                        "headers": {"Authorization": "Bearer oac_b"}},
    "other": {"url": "https://x/mcp", "headers": {"Authorization": "Bearer nope"}}}}


@pytest.fixture
def env(tmp_path):
    cfg = tmp_path / "c.json"
    cfg.write_text(json.dumps(CFG), encoding="utf-8")
    return {"cfg": str(cfg), "cache": str(tmp_path / "cache")}


class Rec(object):
    def __init__(self, fail=False):
        self.calls = []
        self.fail = fail

    def __call__(self, url, auth, body, timeout):
        self.calls.append((url, auth, body))
        if self.fail:
            raise OSError("down")


def hook(st, env, rec, event, sid="sess-1", t=1000.0):
    st.run_hook({"hook_event_name": event, "session_id": sid, "cwd": "/p"}, {}, env["cfg"],
                env["cache"], rec, lambda: t)


def test_status_url(st):
    assert st.status_url("https://o/mcp/agentchat") == "https://o/mcp/agentchat/statut"
    assert st.status_url("https://o/mcp/agentchat/pings/") == "https://o/mcp/agentchat/statut"


def test_session_hash_not_raw(st):
    h = st.session_hash("abc-secret")
    assert len(h) == 12 and "abc" not in h and st.session_hash("") is None


def test_load_all_configs_dedup_and_env(st, tmp_path):
    cfg = tmp_path / "c.json"
    cfg.write_text(json.dumps(CFG), encoding="utf-8")
    from_hook = st._ph.load_all_configs(None, {"AGENTCHAT_URL": "https://e/mcp/agentchat",
                                               "AGENTCHAT_KEY": "oac_a"}, str(cfg))
    assert from_hook[0] == ("https://e/mcp/agentchat", "Bearer oac_a")
    assert [a for _, a in from_hook] == ["Bearer oac_a", "Bearer oac_b"]  # oac_a dédupliquée
    assert st._ph.load_all_configs(None, {}, str(tmp_path / "missing")) == []


def test_hook_posts_to_all_servers_with_state(st, env):
    rec = Rec()
    hook(st, env, rec, "UserPromptSubmit")
    assert len(rec.calls) == 2
    assert {c[1] for c in rec.calls} == {"Bearer oac_a", "Bearer oac_b"}
    assert rec.calls[0][0].endswith("/mcp/agentchat/statut")
    assert rec.calls[0][2]["state"] == "working" and "sess-1" not in json.dumps(rec.calls)
    rec2 = Rec()
    hook(st, env, rec2, "Stop")
    assert rec2.calls[0][2]["state"] == "idle"
    hook(st, env, rec2, "SessionEnd")
    assert rec2.calls[-1][2]["state"] == "offline"
    rec3 = Rec()
    hook(st, env, rec3, "Notification")
    assert rec3.calls == []


def test_pretooluse_throttled(st, env):
    rec = Rec()
    hook(st, env, rec, "PreToolUse", t=1000.0)
    hook(st, env, rec, "PreToolUse", t=1010.0)
    assert len(rec.calls) == 2          # 2 serveurs, un seul tour
    hook(st, env, rec, "PreToolUse", t=1025.0)
    assert len(rec.calls) == 4
    cache_files = os.listdir(env["cache"])
    assert cache_files and all(stat.S_IMODE(os.stat(os.path.join(env["cache"], f)).st_mode) == 0o600
                               for f in cache_files)


def test_hook_failure_swallowed_and_silent(st, env):
    out = io.StringIO()
    rc = st.main(["hook"], io.StringIO(json.dumps({"hook_event_name": "Stop", "session_id": "s"})), out,
                 {}, env["cfg"], env["cache"], Rec(fail=True))
    assert rc == 0 and out.getvalue() == ""
    assert st.main(["hook"], io.StringIO("not json"), out, {}, env["cfg"], env["cache"], Rec()) == 0
    assert st.main(["bogus"], io.StringIO(""), out, {}, env["cfg"], env["cache"], Rec()) == 0


SL = {"session_id": "s", "cwd": "/p", "rate_limits": {
    "five_hour": {"used_percentage": 42.4, "resets_at": 1900000000},
    "seven_day": {"used_percentage": 13, "resets_at": 1900500000}}}


def test_statusline_line_and_post(st, env):
    rec = Rec()
    out = io.StringIO()
    rc = st.main(["statusline"], io.StringIO(json.dumps(SL)), out, {}, env["cfg"], env["cache"], rec)
    assert rc == 0 and out.getvalue() == "5h 42% · 7j 13%\n"
    body = rec.calls[0][2]
    assert body["five_hour_pct"] == 42.4 and body["five_hour_resets_at"] == 1900000000
    assert body["seven_day_pct"] == 13.0 and len(body["session"]) == 12


def test_statusline_throttle_and_pct_change(st, env):
    rec = Rec()
    st.run_statusline(SL, {}, env["cfg"], env["cache"], rec, lambda: 1000.0)
    st.run_statusline(SL, {}, env["cfg"], env["cache"], rec, lambda: 1030.0)
    assert len(rec.calls) == 2
    st.run_statusline(SL, {}, env["cfg"], env["cache"], rec, lambda: 1061.0)
    assert len(rec.calls) == 4
    changed = json.loads(json.dumps(SL))
    changed["rate_limits"]["five_hour"]["used_percentage"] = 50
    st.run_statusline(changed, {}, env["cfg"], env["cache"], rec, lambda: 1062.0)
    assert len(rec.calls) == 6


def test_statusline_no_data(st, env):
    rec = Rec()
    out = io.StringIO()
    st.main(["statusline"], io.StringIO(json.dumps({"session_id": "s"})), out, {}, env["cfg"], env["cache"], rec)
    assert out.getvalue() == "" and rec.calls == []
    assert st.format_line({"five_hour": {"used_percentage": 3}}) == "5h 3%"
