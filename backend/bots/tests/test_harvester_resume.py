"""Tests — reprise auto des moissons interrompues (survie réelle au restart).

Un run TUÉ par un restart (pid mort, pas de stop.flag, todo restant) est relancé
au démarrage de l'app et reprend depuis la frontière persistée. `launch`,
`is_alive` et `now` sont injectés -> déterministe, aucun vrai subprocess.
"""
import os

from backend.bots import harvester_router as R
from backend.bots.harvester.config import HarvestConfig
from backend.bots.harvester.recipe import Recipe
from backend.bots.harvester.store import Store

_RECIPE = {"item_selector": {"tag": "div"},
           "fields": {"x": {"selector": {"tag": "a"}, "extract": "text"}}}


def _seed(tmp_path, jid, *, pid=None, stop=False, todo=True):
    rd = tmp_path / jid
    rd.mkdir(parents=True, exist_ok=True)
    HarvestConfig(url="https://ex.test/p1", recipe=Recipe.from_dict(_RECIPE),
                  plan={}, pacing={}, feed_key="K-" + jid).save(str(rd))
    s = Store(str(rd / "store.json"))
    if todo:
        s.add_todo("https://ex.test/next")
    s.save()
    if pid is not None:
        (rd / "pid").write_text(str(pid))
    if stop:
        (rd / "stop.flag").write_text("1")
    return str(rd)


# ---- _should_resume -------------------------------------------------------

def test_resume_true_when_interrupted_with_todo(tmp_path):
    rd = _seed(tmp_path, "r1", pid=4242, todo=True)
    assert R._should_resume(rd, is_alive=lambda p: False) is True


def test_no_resume_when_stop_flag(tmp_path):
    rd = _seed(tmp_path, "r2", pid=4242, stop=True, todo=True)
    assert R._should_resume(rd, is_alive=lambda p: False) is False


def test_no_resume_when_still_running(tmp_path):
    rd = _seed(tmp_path, "r3", pid=4242, todo=True)
    assert R._should_resume(rd, is_alive=lambda p: True) is False


def test_no_resume_when_no_todo_left(tmp_path):
    rd = _seed(tmp_path, "r4", pid=4242, todo=False)
    assert R._should_resume(rd, is_alive=lambda p: False) is False


def test_no_resume_when_stale_beyond_max_age(tmp_path):
    rd = _seed(tmp_path, "r5", pid=4242, todo=True)
    old = 1000.0
    os.utime(os.path.join(rd, "store.json"), (old, old))
    # now bien après -> trop vieux -> pas de résurrection
    assert R._should_resume(rd, is_alive=lambda p: False,
                            now=old + 100000, max_age_s=3600) is False
    # within window -> reprise
    assert R._should_resume(rd, is_alive=lambda p: False,
                            now=old + 60, max_age_s=3600) is True


# ---- resume_interrupted_runs ---------------------------------------------

def test_resume_launches_only_interrupted(tmp_path, monkeypatch):
    _seed(tmp_path, "go", pid=4242, todo=True)        # interrompu -> relance
    _seed(tmp_path, "stopped", pid=4242, stop=True)   # arrêté -> non
    _seed(tmp_path, "done", pid=4242, todo=False)     # fini -> non
    monkeypatch.setattr(R, "HARVESTER_RUNS_DIR", str(tmp_path))
    monkeypatch.setattr(R, "_harvester_jobs", {})

    launched = []

    def fake_launch(run_dir, job):
        launched.append(os.path.basename(run_dir))
        job["process"] = object()

    resumed = R.resume_interrupted_runs(launch=fake_launch, is_alive=lambda p: False)
    assert resumed == ["go"]
    assert launched == ["go"]
    assert R._harvester_jobs["go"]["status"] == "running"


def test_resume_skips_when_alive(tmp_path, monkeypatch):
    _seed(tmp_path, "alive", pid=4242, todo=True)
    monkeypatch.setattr(R, "HARVESTER_RUNS_DIR", str(tmp_path))
    monkeypatch.setattr(R, "_harvester_jobs", {})
    launched = []
    R.resume_interrupted_runs(launch=lambda rd, j: launched.append(rd),
                              is_alive=lambda p: True)
    assert launched == []


def test_resume_empty_when_no_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(R, "HARVESTER_RUNS_DIR", str(tmp_path / "nope"))
    monkeypatch.setattr(R, "_harvester_jobs", {})
    assert R.resume_interrupted_runs(launch=lambda rd, j: None) == []
