"""Sortie des moteurs de bots dans un FICHIER, jamais dans un pipe.

Régression : avec ``stdout=PIPE`` le moteur dépendait du lecteur du pipe
(un thread de uvicorn). Au redémarrage de uvicorn (auto-deploy à chaque push),
la prochaine écriture de l'enfant levait BrokenPipeError -> Market Pulse et le
Harvester mouraient, Bond Scanner / Yield Bot perdaient leurs logs.
"""

import asyncio
import json
import os
import stat
import subprocess
import sys
import time

import pytest

from backend.bots import run_log
from backend.bots import harvester_router as hr
from backend.bots import market_router as mr
from backend.bots import scanner_router as sr
from backend.bots import yield_router as yr


@pytest.fixture(autouse=True)
def _fast_follow(monkeypatch):
    monkeypatch.setattr(run_log, "FOLLOW_POLL_S", 0.01)


class FakeProc(object):
    """Process déjà terminé, qui a écrit ``lines`` dans son stdout (le fichier)."""

    def __init__(self, rc=0):
        self.pid = 4242
        self.returncode = rc
        self.waited = False

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        self.waited = True
        return self.returncode

    def terminate(self):
        pass


def _fake_popen(monkeypatch, lines, rc=0):
    """Remplace Popen : vérifie que stdout est un FICHIER et y écrit ``lines``
    comme le ferait l'enfant."""
    seen = {}

    def fake(cmd, **kwargs):
        out = kwargs.get("stdout")
        assert out is not subprocess.PIPE
        assert hasattr(out, "fileno")
        assert kwargs.get("stderr") is subprocess.STDOUT
        os.write(out.fileno(), "".join(l + "\n" for l in lines).encode("utf-8"))
        seen["kwargs"] = kwargs
        seen["proc"] = FakeProc(rc)
        return seen["proc"]

    monkeypatch.setattr(run_log.subprocess, "Popen", fake)
    return seen


def _wait_until(pred, timeout=3.0):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.01)
    return pred()


# ---------------------------------------------------------------- helper ----

def test_open_log_is_born_600(tmp_path):
    f = run_log.open_log(tmp_path / "run.log")
    f.close()
    assert stat.S_IMODE(os.stat(str(tmp_path / "run.log")).st_mode) == 0o600


def test_follow_reads_complete_lines_from_start_offset_and_reaps(tmp_path):
    p = tmp_path / "run.log"
    p.write_bytes(b"ancienne ligne\n")
    start = run_log.log_size(p)
    with open(str(p), "ab") as f:
        f.write(b"un\n\ndeux\ntrois sans retour")
    proc = FakeProc(rc=3)
    got, codes = [], []
    run_log.follow(p, proc, got.append, start=start, on_exit=codes.append, poll=0.01)
    assert got == ["un", "deux", "trois sans retour"]
    assert codes == [3]
    assert proc.waited is True


def test_follow_survives_a_failing_parser(tmp_path):
    p = tmp_path / "run.log"
    p.write_bytes(b"a\nb\n")
    got = []

    def parser(line):
        got.append(line)
        raise RuntimeError("boom")

    run_log.follow(p, FakeProc(), parser, poll=0.01)
    assert got == ["a", "b"]


def test_child_survives_the_death_of_its_launcher(tmp_path):
    """Le vrai scénario : le lanceur (uvicorn) meurt, l'enfant continue
    d'écrire. Avec un pipe il lèverait BrokenPipeError ; avec le fichier, il
    finit et ses logs sont complets."""
    log = tmp_path / "run.log"
    child = ("import time,sys\n"
             "print('debut', flush=True)\n"
             "time.sleep(1.0)\n"
             "print('fin', flush=True)\n")
    launcher = (
        "import sys\n"
        "sys.path.insert(0, %r)\n"
        "from backend.bots import run_log\n"
        "p = run_log.spawn_logged([sys.executable, '-c', %r], %r,"
        " start_new_session=True)\n"
        "print(p.pid)\n" % (os.getcwd(), child, str(log))
    )
    out = subprocess.run([sys.executable, "-c", launcher], capture_output=True,
                         text=True, timeout=20, check=True)
    child_pid = int(out.stdout.strip())
    # le lanceur est mort ; l'enfant (orphelin) doit finir proprement
    assert _wait_until(lambda: "fin" in log.read_text(), timeout=10)
    assert log.read_text().splitlines() == ["debut", "fin"]
    assert _wait_until(lambda: not _alive(child_pid), timeout=5)


def _alive(pid):
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    # zombie non réapé par init dans un conteneur sans PID 1 réapeur
    try:
        with open("/proc/%d/stat" % pid) as f:
            return f.read().split()[2] != "Z"
    except OSError:
        return False


# ---------------------------------------------------------- Market Pulse ----

def test_market_launch_writes_to_run_log_and_rebuilds_status(tmp_path, monkeypatch):
    monkeypatch.setattr(mr, "MARKET_RUNS_DIR", tmp_path / "runs")
    rd = tmp_path / "runs" / ("b" * 32)
    rd.mkdir(parents=True)
    seen = _fake_popen(monkeypatch, ["indice FTSE MIB", "snapshot ok"])
    job = {"job_id": "b" * 32, "status": "starting", "logs": [], "process": None}
    mr._launch_subprocess(str(rd), job)
    assert seen["kwargs"]["start_new_session"] is True
    assert _wait_until(lambda: job["status"] == "completed")
    assert job["logs"] == ["indice FTSE MIB", "snapshot ok"]
    assert (rd / "run.log").read_text().splitlines() == ["indice FTSE MIB", "snapshot ok"]
    assert seen["proc"].waited is True
    assert stat.S_IMODE(os.stat(str(rd / "run.log")).st_mode) == 0o600


# ------------------------------------------------------------- Harvester ----

def test_harvester_launch_parses_events_from_the_file(tmp_path, monkeypatch):
    rd = tmp_path / "run1"
    rd.mkdir()
    (rd / "run.log").write_text(
        json.dumps({"type": "awaiting_manual_solve", "url": "old"}) + "\n")
    lines = [
        json.dumps({"type": "progress", "counts": {"todo": 1, "done": 2,
                                                   "records": 3, "errors": 0}}),
        json.dumps({"type": "recommend_tier", "tier": "unblocker"}),
        "texte libre",
    ]
    seen = _fake_popen(monkeypatch, lines)
    job = {"job_id": "run1", "status": "starting", "logs": [], "process": None,
           "counts": {}}
    hr._launch_subprocess(str(rd), job)
    assert seen["kwargs"]["start_new_session"] is True
    assert _wait_until(lambda: job["status"] == "completed")
    assert job["counts"]["records"] == 3
    assert job["recommend"]["tier"] == "unblocker"
    # la reprise ne relit pas l'ancien log : pas d'état « awaiting » ressuscité
    assert "awaiting_solve" not in job
    assert job["logs"][-1] == "texte libre"
    assert job["process"] is None
    assert seen["proc"].waited is True


# ---------------------------------------------------------- Bond Scanner ----

class _User(object):
    username = "massii"


def test_scanner_run_writes_to_run_log_and_parses_progress(tmp_path, monkeypatch):
    monkeypatch.setattr(sr, "OUTPUTS_DIR", tmp_path / "out")
    monkeypatch.setattr(sr, "_brave_remaining", lambda: None)
    lines = ["📊 EUR: 150 bond trovati sul mercato", "[3/10] XS123",
             "✅ ACCETTATO", "📊 EUR completato: 1 accettati"]
    seen = _fake_popen(monkeypatch, lines)
    res = asyncio.run(sr.run_scanner(sr.ScanRequest(), current_user=_User()))
    job = sr._scanner_jobs[res["job_id"]]
    assert seen["kwargs"]["start_new_session"] is True
    assert _wait_until(lambda: job["status"] == "completed")
    assert job["stats"]["total_scanned"] == 150
    assert job["stats"]["total_filtered"] == 1
    assert job["_completed_currencies"] == ["EUR"]
    log = tmp_path / "out" / res["job_id"] / "run.log"
    assert log.read_text().splitlines() == lines
    assert seen["proc"].waited is True


def test_scanner_stop_is_not_overwritten_by_the_reaper(tmp_path, monkeypatch):
    monkeypatch.setattr(sr, "OUTPUTS_DIR", tmp_path / "out")
    monkeypatch.setattr(sr, "_brave_remaining", lambda: None)
    _fake_popen(monkeypatch, ["x"], rc=-15)
    monkeypatch.setattr(run_log, "start_follower", lambda *a, **k: None)
    res = asyncio.run(sr.run_scanner(sr.ScanRequest(), current_user=_User()))
    job = sr._scanner_jobs[res["job_id"]]
    asyncio.run(sr.stop_scanner(res["job_id"], current_user=_User()))
    assert job["status"] == "stopped"


# ------------------------------------------------------------- Yield Bot ----

def test_yield_run_writes_to_run_log_and_parses_progress(tmp_path, monkeypatch):
    job_dir = tmp_path / "j1"
    job_dir.mkdir()
    inp = job_dir / "bonds.xlsx"
    inp.write_bytes(b"x")
    (job_dir / "bonds_AGGIORNATO.xlsx").write_bytes(b"y")
    yr._yield_jobs["j1"] = {
        "status": "pending", "filename": "bonds.xlsx", "input_path": str(inp),
        "output_path": None, "logs": [], "process": None, "bonds_count": 2,
        "sheets": [], "mode": None, "stats": {}, "created_at": "2026-10-19",
    }
    lines = ["📌 [Foglio1:2] Bond A", "   📈 Yield calcolato: 4.2%",
             "📌 [Foglio1:3] Bond B", "   ⚠️ Nessun prezzo"]
    seen = _fake_popen(monkeypatch, lines)
    asyncio.run(yr.run_yield_bot("j1", yr.YieldRunRequest(), current_user=_User()))
    job = yr._yield_jobs["j1"]
    assert seen["kwargs"]["start_new_session"] is True
    assert _wait_until(lambda: job["status"] == "completed")
    assert job["_processed"] == 2
    assert job["stats"]["updated"] == 1
    assert job["stats"]["skipped"] == 1
    assert job["output_path"].endswith("bonds_AGGIORNATO.xlsx")
    assert (job_dir / "run.log").read_text().splitlines() == lines
    assert seen["proc"].waited is True
    yr._yield_jobs.pop("j1", None)
