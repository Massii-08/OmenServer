"""Détachement des sessions MC Agent (2026-07-19, demande Massii) :
un deploy (restart uvicorn) ne doit plus tuer la flotte — stdout → fichier de log,
registre persisté, ré-adoption au boot, pompe-tail. On ne recycle que les bots
que le fix concerne.
"""
import io
import json
import os
import re
import signal
import time

import pytest

from backend.bots import mc_agent_manager as mgr


class FakeProcNoPipe:
    """Faux subprocess SANS stdout (mode production : stdout → fichier) → pompe tail."""
    def __init__(self):
        self.stdout = None
        self.stdin = io.StringIO()
        self.pid = 54321
        self._alive = True

    def poll(self):
        return None if self._alive else 0

    def terminate(self):
        self._alive = False


def _wait(cond, timeout=5.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if cond():
            return True
        time.sleep(0.05)
    return False


@pytest.fixture(autouse=True)
def _clean_sessions():
    mgr._sessions.clear()
    yield
    mgr._sessions.clear()


# ─── Spawn : stdout fichier + registre ────────────────────────────────────────────────────────────

def test_spawn_opens_logfile_and_writes_registry(monkeypatch):
    captured = {}

    def fake_popen(cmd, **kw):
        captured["stdout"] = kw.get("stdout")
        return FakeProcNoPipe()

    monkeypatch.setattr(mgr.subprocess, "Popen", fake_popen)
    sid = mgr.start_session("h", 25565, "DetachBot")
    # stdout du Popen = un VRAI fichier (pas subprocess.PIPE)
    assert captured["stdout"] is not mgr.subprocess.PIPE
    assert hasattr(captured["stdout"], "fileno")
    s = mgr._sessions[sid]
    # nom unique par lancement : session-<sid>-<epoch>.jsonl (anti-collision post-restart uvicorn)
    assert s["log_path"] and re.search(rf"session-{sid}-\d+\.jsonl$", s["log_path"])
    assert os.path.isfile(s["log_path"])
    # registre écrit avec pid + log_path
    reg = json.loads(mgr._registry_path().read_text(encoding="utf-8"))
    entry = next(e for e in reg["sessions"] if e["id"] == sid)
    assert entry["pid"] == 54321
    assert entry["log_path"] == s["log_path"]
    mgr.stop_session(sid)


def test_pump_tail_applies_events_then_stops_on_death(monkeypatch):
    monkeypatch.setattr(mgr.subprocess, "Popen", lambda cmd, **kw: FakeProcNoPipe())
    sid = mgr.start_session("h", 25565, "TailBot")
    s = mgr._sessions[sid]
    with open(s["log_path"], "a", encoding="utf-8") as f:
        f.write(json.dumps({"type": "status", "state": "running"}) + "\n")
        f.write(json.dumps({"type": "chat", "from": "Massii", "message": "salut"}) + "\n")
    assert _wait(lambda: s["status"] == "running" and len(s["transcript"]) == 1)
    assert s["log_pos"] > 0
    # mort du process → la pompe draine puis clôture
    s["proc"]._alive = False
    assert _wait(lambda: s["status"] == "stopped")


def test_pump_tail_waits_for_partial_line(monkeypatch):
    monkeypatch.setattr(mgr.subprocess, "Popen", lambda cmd, **kw: FakeProcNoPipe())
    sid = mgr.start_session("h", 25565, "PartialBot")
    s = mgr._sessions[sid]
    with open(s["log_path"], "a", encoding="utf-8") as f:
        f.write('{"type": "status", "sta')          # ligne partielle (write en cours)
        f.flush()
        time.sleep(0.6)
        assert s["status"] == "starting"            # rien d'appliqué (pas de \n)
        f.write('te": "running"}\n')
    assert _wait(lambda: s["status"] == "running")
    mgr.stop_session(sid)


# ─── Adoption au boot ─────────────────────────────────────────────────────────────────────────────

def _registry_with(entries):
    mgr.RUNS_DIR.mkdir(parents=True, exist_ok=True)
    mgr._registry_path().write_text(json.dumps({"sessions": entries}), encoding="utf-8")


def test_adopt_orphan_alive_resumes_tail_and_counter(monkeypatch):
    mgr.LOGS_DIR.mkdir(parents=True, exist_ok=True)
    log = mgr.LOGS_DIR / "session-7.jsonl"
    log.write_text(json.dumps({"type": "status", "state": "running"}) + "\n", encoding="utf-8")
    _registry_with([{"id": 7, "pid": os.getpid(), "host": "h", "user": "OrphanBot",
                     "server_id": "g1", "objective": "mapper", "status": "running",
                     "log_path": str(log), "log_pos": 0,
                     "respawn": {"group_id": "g1", "bot_id": "b1", "objective": "mapper"}}])
    monkeypatch.setattr(mgr, "_pid_is_mc_agent", lambda pid: pid == os.getpid())
    adopted = mgr.adopt_orphan_sessions()
    assert adopted == [7]
    s = mgr._sessions[7]
    assert s["adopted"] is True and s["proc"] is None and s["pid"] == os.getpid()
    assert s["respawn"]["bot_id"] == "b1"          # le self-healing a survécu au restart
    assert _wait(lambda: s["status"] == "running")  # la pompe tail relit le log
    # le compteur repart APRÈS le sid adopté
    monkeypatch.setattr(mgr.subprocess, "Popen", lambda cmd, **kw: FakeProcNoPipe())
    sid2 = mgr.start_session("h", 25565, "NewBot")
    assert sid2 > 7
    # en ligne pour le groupe (anti double-login) + list_active
    assert "orphanbot" in mgr._online_usernames("g1")
    assert any(p["id"] == 7 for p in mgr.list_active())
    mgr._sessions[7]["pid"] = 999999999             # libère la pompe (pid mort)
    mgr.stop_session(sid2)


def test_adopt_skips_dead_stopped_and_cleans(monkeypatch, tmp_path):
    leftover = tmp_path / "login-9.txt"
    leftover.write_text("secret", encoding="utf-8")
    _registry_with([
        {"id": 9, "pid": 999999999, "host": "h", "user": "DeadBot", "status": "running",
         "login_path": str(leftover)},
        {"id": 10, "pid": os.getpid(), "host": "h", "user": "StoppedBot",
         "status": "stopped", "user_stopped": True},
    ])
    monkeypatch.setattr(mgr, "_pid_is_mc_agent", lambda pid: pid == os.getpid())
    assert mgr.adopt_orphan_sessions() == []
    assert mgr._sessions == {}
    assert not leftover.exists()                    # temp files du mort nettoyés


def test_adopt_without_registry_is_noop():
    assert mgr.adopt_orphan_sessions() == []


# ─── Contrôle des sessions adoptées ───────────────────────────────────────────────────────────────

def test_stop_adopted_session_kills_by_pid(monkeypatch):
    mgr._sessions[3] = {"id": 3, "proc": None, "pid": 424242, "status": "running",
                        "host": "h", "user": "A", "last_error": None,
                        "transcript": [], "events": []}
    monkeypatch.setattr(mgr, "_alive", lambda s: s.get("pid") == 424242)
    calls = {}
    monkeypatch.setattr(mgr.os, "getpgid", lambda pid: 111)
    monkeypatch.setattr(mgr.os, "killpg", lambda pgid, sig: calls.setdefault("killpg", (pgid, sig)))
    assert mgr.stop_session(3) is True
    assert calls["killpg"] == (111, signal.SIGTERM)
    assert mgr._sessions[3]["user_stopped"] is True


def test_send_command_on_adopted_returns_false():
    mgr._sessions[4] = {"id": 4, "proc": None, "pid": 424243, "status": "running",
                        "host": "h", "user": "B", "last_error": None,
                        "transcript": [], "events": []}
    assert mgr.send_command(4, {"type": "say", "message": "x"}) is False
