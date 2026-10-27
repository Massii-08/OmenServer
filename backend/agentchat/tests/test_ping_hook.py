import importlib.util
import io
import json
from pathlib import Path

import pytest

_HOOK = Path(__file__).resolve().parents[3] / "tools" / "agentchat_ping_hook.py"


@pytest.fixture(scope="module")
def hook():
    spec = importlib.util.spec_from_file_location("agentchat_ping_hook", str(_HOOK))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def write_cfg(tmp_path, data):
    p = tmp_path / "claude.json"
    p.write_text(json.dumps(data), encoding="utf-8")
    return str(p)


GLOBAL_CFG = {"mcpServers": {"agentchat": {
    "type": "http", "url": "https://omen.example/mcp/agentchat",
    "headers": {"Authorization": "Bearer oac_global"}}}}

PINGS = {"member": "Claude-Pets", "pings": [
    {"id": 12, "author": "massii (humain)", "text": "fais le pet chat", "ts": "t"}]}


class Recorder(object):
    def __init__(self, result=None, exc=None):
        self.calls = []
        self.result = result
        self.exc = exc

    def __call__(self, url, auth, timeout):
        self.calls.append((url, auth, timeout))
        if self.exc is not None:
            raise self.exc
        return self.result


def run_main(hook, stdin_obj, cfg_path, fetch, env=None):
    out = io.StringIO()
    code = hook.main(stdin=io.StringIO(json.dumps(stdin_obj) if stdin_obj is not None else ""),
                     stdout=out, env=env or {}, config_path=cfg_path, fetch=fetch)
    return code, out.getvalue()


def test_blocks_with_open_pings(hook, tmp_path):
    cfg = write_cfg(tmp_path, GLOBAL_CFG)
    rec = Recorder(PINGS)
    code, out = run_main(hook, {"cwd": "/x", "stop_hook_active": False}, cfg, rec)
    assert code == 0
    assert rec.calls == [("https://omen.example/mcp/agentchat/pings", "Bearer oac_global", 5.0)]
    decision = json.loads(out)
    assert decision["decision"] == "block"
    assert "#12" in decision["reason"] and "fais le pet chat" in decision["reason"]
    assert "massii (humain)" in decision["reason"] and "reponse_a" in decision["reason"]


def test_no_pings_no_output(hook, tmp_path):
    cfg = write_cfg(tmp_path, GLOBAL_CFG)
    code, out = run_main(hook, {}, cfg, Recorder({"member": "x", "pings": []}))
    assert code == 0 and out == ""


def test_stop_hook_active_short_circuits(hook, tmp_path):
    cfg = write_cfg(tmp_path, GLOBAL_CFG)
    rec = Recorder(PINGS)
    code, out = run_main(hook, {"stop_hook_active": True}, cfg, rec)
    assert code == 0 and out == "" and rec.calls == []


def test_network_error_silent(hook, tmp_path):
    cfg = write_cfg(tmp_path, GLOBAL_CFG)
    code, out = run_main(hook, {}, cfg, Recorder(exc=OSError("injoignable")))
    assert code == 0 and out == ""
    code, out = run_main(hook, {}, cfg, Recorder(result="pas un objet"))
    assert code == 0 and out == ""


def test_missing_config_silent(hook, tmp_path):
    rec = Recorder(PINGS)
    code, out = run_main(hook, {}, str(tmp_path / "absent.json"), rec)
    assert code == 0 and out == "" and rec.calls == []
    bad = tmp_path / "bad.json"
    bad.write_text("{pas du json", encoding="utf-8")
    code, out = run_main(hook, {}, str(bad), rec)
    assert code == 0 and out == "" and rec.calls == []


def test_invalid_stdin_still_works(hook, tmp_path):
    cfg = write_cfg(tmp_path, GLOBAL_CFG)
    out = io.StringIO()
    code = hook.main(stdin=io.StringIO("{oops"), stdout=out, env={}, config_path=cfg,
                     fetch=Recorder(PINGS))
    assert code == 0 and json.loads(out.getvalue())["decision"] == "block"


def test_project_config_preferred(hook, tmp_path):
    data = dict(GLOBAL_CFG)
    data["projects"] = {"/proj": {"mcpServers": {"agentchat": {
        "url": "https://proj.example/mcp/agentchat/",
        "headers": {"authorization": "Bearer oac_proj"}}}}}
    cfg = write_cfg(tmp_path, data)
    rec = Recorder({"member": "x", "pings": []})
    run_main(hook, {"cwd": "/proj"}, cfg, rec)
    assert rec.calls[0][:2] == ("https://proj.example/mcp/agentchat/pings", "Bearer oac_proj")
    rec = Recorder({"member": "x", "pings": []})
    run_main(hook, {"cwd": "/autre"}, cfg, rec)
    assert rec.calls[0][:2] == ("https://omen.example/mcp/agentchat/pings", "Bearer oac_global")


def test_env_overrides(hook, tmp_path):
    cfg = write_cfg(tmp_path, GLOBAL_CFG)
    rec = Recorder({"member": "x", "pings": []})
    run_main(hook, {}, cfg, rec, env={"AGENTCHAT_URL": "http://localhost:8000/mcp/agentchat",
                                      "AGENTCHAT_KEY": "oac_env"})
    assert rec.calls[0][:2] == ("http://localhost:8000/mcp/agentchat/pings", "Bearer oac_env")
    rec = Recorder({"member": "x", "pings": []})
    run_main(hook, {}, str(tmp_path / "absent.json"), rec,
             env={"AGENTCHAT_URL": "http://h/mcp/agentchat", "AGENTCHAT_KEY": "Bearer oac_k"})
    assert rec.calls[0][1] == "Bearer oac_k"


def test_pings_url(hook):
    assert hook.pings_url("https://a/mcp/agentchat") == "https://a/mcp/agentchat/pings"
    assert hook.pings_url("https://a/mcp/agentchat/") == "https://a/mcp/agentchat/pings"
    assert hook.pings_url("https://a/mcp/agentchat/pings") == "https://a/mcp/agentchat/pings"


def test_long_text_truncated(hook):
    reason = hook.build_reason("M", [{"id": 1, "author": "a", "text": "x" * 1000}])
    assert "x" * 300 + "…" in reason and "x" * 301 not in reason


def test_end_to_end_with_server(hook, tmp_path, monkeypatch):
    """Le hook parle au vrai endpoint /mcp/agentchat/pings (TestClient en guise de réseau)."""
    from backend.agentchat import store
    from backend.agentchat.tests.test_agentchat import add_member, make_client, setup_room
    monkeypatch.setattr(store, "AGENTCHAT_DIR", tmp_path / "ac")
    c = make_client()
    setup_room(c)
    key = add_member(c, name="Claude-Pets")["key"]
    c.post("/api/agentchat/rooms/roblox/messages", json={"text": "@Claude-Pets exporte le .fbx"})
    cfg = write_cfg(tmp_path, {"mcpServers": {"agentchat": {
        "url": "http://testserver/mcp/agentchat", "headers": {"Authorization": "Bearer " + key}}}})

    def fetch(url, auth, timeout):
        r = c.get(url.replace("http://testserver", ""), headers={"Authorization": auth})
        r.raise_for_status()
        return r.json()

    code, out = run_main(hook, {"cwd": "/x"}, cfg, fetch)
    assert code == 0
    decision = json.loads(out)
    assert decision["decision"] == "block" and "exporte le .fbx" in decision["reason"]
    assert "Claude-Pets" in decision["reason"]
