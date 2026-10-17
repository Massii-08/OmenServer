"""Piège #70 : un moteur détaché écrit dans un FICHIER, jamais dans un pipe.

Couvre le helper ``_runlog`` et les deux routers qui l'utilisent pour garder
leur progression parsée ligne à ligne (Bond Scanner, Yield Bot).
"""

import subprocess
import sys
import textwrap
import time

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.auth.utils import get_current_user
from backend.bots import _runlog
from backend.bots import scanner_router as sr
from backend.bots import yield_router as yr


class FakeUser(object):
    def __init__(self, role="admin"):
        self.role = role
        self.is_admin = role == "admin"
        self.username = "tester"


def _wait(pred, timeout=10.0):
    deadline = time.time() + timeout
    while not pred() and time.time() < deadline:
        time.sleep(0.05)
    return pred()


# ---------------------------------------------------------------- helper

def test_launch_to_file_detaches_and_never_pipes(tmp_path, monkeypatch):
    captured = {}

    class P(object):
        pid = 1

    def fake_popen(cmd, **kwargs):
        captured.update(kwargs)
        return P()

    monkeypatch.setattr(_runlog.subprocess, "Popen", fake_popen)
    _runlog.launch_to_file(["x"], tmp_path / "run.log", cwd=str(tmp_path))
    out = captured["stdout"]
    assert out is not subprocess.PIPE
    assert out.name == str(tmp_path / "run.log") and out.closed
    assert captured["stderr"] is subprocess.STDOUT
    assert captured["start_new_session"] is True
    assert captured["cwd"] == str(tmp_path)


def test_engine_keeps_writing_when_nobody_follows(tmp_path):
    """La reproduction du bug : le « parent » cesse de lire (uvicorn redémarre)
    et le moteur écrit encore. Avec un pipe : BrokenPipeError. Ici : rien."""
    log = tmp_path / "run.log"
    proc = _runlog.launch_to_file(
        [sys.executable, "-c",
         "import time; print('a', flush=True); time.sleep(0.5); "
         "print('b', flush=True)"], log)
    assert proc.wait(timeout=10) == 0
    assert log.read_text(encoding="utf-8").split() == ["a", "b"]


def test_follow_streams_lines_including_partial_ones(tmp_path):
    log = tmp_path / "run.log"
    log.write_bytes(b"old line from a previous run\n")
    start = log.stat().st_size
    proc = _runlog.launch_to_file(
        [sys.executable, "-c", textwrap.dedent("""
            import sys, time
            sys.stdout.write('one\\ntw'); sys.stdout.flush()
            time.sleep(0.3)
            sys.stdout.write('o\\n'); sys.stdout.flush()
            sys.stderr.write('err\\n'); sys.stderr.flush()
            sys.stdout.write('tail-without-newline')
        """)], log)
    got = []
    _runlog.follow(proc, log, got.append, poll_s=0.05, start=start)
    assert got == ["one", "two", "err", "tail-without-newline"]


# ---------------------------------------------------------------- routers

def _client(router):
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_user] = lambda: FakeUser()
    return TestClient(app)


def test_scanner_engine_output_goes_to_run_log_and_progress_still_parses(tmp_path, monkeypatch):
    bot = tmp_path / "bot"
    bot.mkdir()
    (bot / "main.py").write_text(
        "print('scan line 1', flush=True)\nprint('scan line 2', flush=True)\n",
        encoding="utf-8")
    monkeypatch.setattr(sr, "SCANNER_BOT_DIR", bot)
    monkeypatch.setattr(sr, "OUTPUTS_DIR", tmp_path / "out")
    monkeypatch.setattr(sr, "BRAVE_REMAINING_PATH", tmp_path / "none.json")
    seen = []
    monkeypatch.setattr(sr, "_parse_scanner_progress",
                        lambda job, line: seen.append(line))
    c = _client(sr.router)
    r = c.post("/api/bots/scanner/run", json={})
    assert r.status_code == 200, r.text
    jid = r.json()["job_id"]
    job = sr._scanner_jobs[jid]
    assert _wait(lambda: job["status"] != "running")
    assert job["status"] == "completed"
    assert seen == ["scan line 1", "scan line 2"]
    assert job["logs"] == ["scan line 1", "scan line 2"]
    run_log = tmp_path / "out" / jid / "run.log"
    assert run_log.read_text(encoding="utf-8").split("\n")[:2] == ["scan line 1", "scan line 2"]


def test_yield_engine_is_detached_and_output_goes_to_run_log(tmp_path, monkeypatch):
    bot = tmp_path / "bot"
    bot.mkdir()
    (bot / "main.py").write_text("print('yield line', flush=True)\n", encoding="utf-8")
    monkeypatch.setattr(yr, "YIELD_BOT_DIR", bot)
    monkeypatch.setattr(yr, "UPLOADS_DIR", tmp_path / "up")
    job_dir = tmp_path / "up" / "abcd1234"
    job_dir.mkdir(parents=True)
    xlsx = job_dir / "in.xlsx"
    xlsx.write_bytes(b"x")
    yr._yield_jobs["abcd1234"] = {"status": "uploaded", "input_path": str(xlsx),
                                  "bonds_count": 1, "logs": [], "process": None}
    launched = {}
    real = _runlog.launch_to_file

    def spy(cmd, log_path, **kw):
        proc = real(cmd, log_path, **kw)
        launched["log_path"] = log_path
        return proc

    monkeypatch.setattr(yr._runlog, "launch_to_file", spy)
    c = _client(yr.router)
    r = c.post("/api/bots/yield/run/abcd1234", json={"mode": "all"})
    assert r.status_code == 200, r.text
    job = yr._yield_jobs["abcd1234"]
    assert _wait(lambda: job["status"] != "running")
    assert job["status"] == "completed"
    assert job["logs"] == ["yield line"]
    assert launched["log_path"] == job_dir / "run.log"
    assert (job_dir / "run.log").read_text(encoding="utf-8") == "yield line\n"
