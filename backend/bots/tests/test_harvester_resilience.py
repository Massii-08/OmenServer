"""Tests A — le suivi de job survit au restart uvicorn.

On vérifie les helpers PURS de reconstruction depuis le disque (pidfile +
stop.flag -> statut), la reconstruction d'un job depuis config/store, et la
réhydratation du registre. `is_alive` est injecté -> déterministe, sans vrai PID.
"""
import json
import os

from backend.bots import harvester_router as R
from backend.bots.harvester.config import HarvestConfig
from backend.bots.harvester.recipe import Recipe
from backend.bots.harvester.store import Store


_RECIPE = {"item_selector": {"tag": "div"},
           "fields": {"x": {"selector": {"tag": "a"}, "extract": "text"}}}


def _seed_run(tmp_path, job_id, *, pid=None, stop=False, records=0, todo=True):
    run_dir = tmp_path / job_id
    run_dir.mkdir(parents=True, exist_ok=True)
    cfg = HarvestConfig(url="https://ex.test/p1", recipe=Recipe.from_dict(_RECIPE),
                        plan={"mode": "pagination"}, pacing={}, feed_key="K-" + job_id)
    cfg.save(str(run_dir))
    s = Store(str(run_dir / "store.json"))
    if todo:
        s.add_todo("https://ex.test/p1")
    for i in range(records):
        s.add_record({"x": str(i)})
    s.save()
    if pid is not None:
        (run_dir / "pid").write_text(str(pid))
    if stop:
        (run_dir / "stop.flag").write_text("1")
    return str(run_dir)


def test_status_running_when_pid_alive(tmp_path):
    rd = _seed_run(tmp_path, "j1", pid=4242)
    assert R._status_from_disk(rd, is_alive=lambda p: True) == "running"


def test_status_stopped_when_flag_and_pid_dead(tmp_path):
    rd = _seed_run(tmp_path, "j2", pid=4242, stop=True)
    assert R._status_from_disk(rd, is_alive=lambda p: False) == "stopped"


def test_status_stopped_takes_precedence_over_alive_pid(tmp_path):
    # stop.flag prime même si le subprocess n'a pas encore lu le flag (pid vivant)
    rd = _seed_run(tmp_path, "j2b", pid=4242, stop=True)
    assert R._status_from_disk(rd, is_alive=lambda p: True) == "stopped"


def test_status_interrupted_when_pid_dead_with_todo(tmp_path):
    # tué par un restart, todo restant -> interrompu (sera repris), pas completed
    rd = _seed_run(tmp_path, "j3", pid=4242, todo=True)
    assert R._status_from_disk(rd, is_alive=lambda p: False) == "interrupted"


def test_status_completed_when_pid_dead_no_todo(tmp_path):
    rd = _seed_run(tmp_path, "j3b", pid=4242, todo=False)
    assert R._status_from_disk(rd, is_alive=lambda p: False) == "completed"


def test_status_completed_when_no_pidfile_no_todo(tmp_path):
    rd = _seed_run(tmp_path, "j4", todo=False)
    assert R._status_from_disk(rd, is_alive=lambda p: True) == "completed"


def test_job_from_disk_includes_tier(tmp_path):
    rd = _seed_run(tmp_path, "j6", pid=4242)
    # le seeder met un plan sans fetch_tier -> défaut httpx
    job = R._job_from_disk(rd, "j6", is_alive=lambda p: True)
    assert job["tier"] == "httpx"


def test_job_from_disk_rebuilds_feedkey_url_counts(tmp_path):
    rd = _seed_run(tmp_path, "j5", pid=4242, records=3)
    job = R._job_from_disk(rd, "j5", is_alive=lambda p: True)
    assert job is not None
    assert job["feed_key"] == "K-j5"
    assert job["url"] == "https://ex.test/p1"
    assert job["status"] == "running"
    assert job["counts"]["records"] == 3


def test_job_from_disk_none_without_config(tmp_path):
    (tmp_path / "empty").mkdir()
    assert R._job_from_disk(str(tmp_path / "empty"), "empty") is None


def test_rehydrate_populates_registry_from_disk(tmp_path, monkeypatch):
    _seed_run(tmp_path, "a1", pid=4242, records=2)
    _seed_run(tmp_path, "b2", stop=True)
    monkeypatch.setattr(R, "HARVESTER_RUNS_DIR", str(tmp_path))
    monkeypatch.setattr(R, "_harvester_jobs", {})
    R.rehydrate_jobs(is_alive=lambda p: True)
    assert set(R._harvester_jobs.keys()) == {"a1", "b2"}
    assert R._harvester_jobs["a1"]["status"] == "running"   # pid alive
    assert R._harvester_jobs["b2"]["status"] == "stopped"   # stop.flag


def test_rehydrate_does_not_clobber_inmemory_job(tmp_path, monkeypatch):
    _seed_run(tmp_path, "a1", pid=4242)
    monkeypatch.setattr(R, "HARVESTER_RUNS_DIR", str(tmp_path))
    sentinel = {"job_id": "a1", "status": "running", "process": object()}
    monkeypatch.setattr(R, "_harvester_jobs", {"a1": sentinel})
    R.rehydrate_jobs(is_alive=lambda p: True)
    assert R._harvester_jobs["a1"] is sentinel       # live handle preserved


def test_pid_alive_true_for_self():
    assert R._pid_alive(os.getpid()) is True


def test_pid_alive_false_for_none():
    assert R._pid_alive(None) is False
