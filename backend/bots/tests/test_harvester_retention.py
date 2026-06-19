"""Tests — rétention : purge auto des runs inactifs anciens (anti-accumulation).

`now` et `is_alive` injectés -> déterministe. On force le mtime du store.json
pour simuler l'âge.
"""
import os

from backend.bots import harvester_router as R
from backend.bots.harvester.config import HarvestConfig
from backend.bots.harvester.recipe import Recipe
from backend.bots.harvester.store import Store

_RECIPE = {"item_selector": {"tag": "div"},
           "fields": {"x": {"selector": {"tag": "a"}, "extract": "text"}}}


def _seed(tmp_path, jid, *, mtime, pid=None):
    rd = tmp_path / jid
    rd.mkdir(parents=True, exist_ok=True)
    HarvestConfig(url="https://ex.test/p1", recipe=Recipe.from_dict(_RECIPE),
                  plan={}, pacing={}, feed_key="K").save(str(rd))
    s = Store(str(rd / "store.json"))
    s.add_todo("https://ex.test/p1")
    s.save()
    os.utime(str(rd / "store.json"), (mtime, mtime))
    if pid is not None:
        (rd / "pid").write_text(str(pid))
    return str(rd)


def test_purge_removes_old_inactive_run(tmp_path, monkeypatch):
    now = 1_000_000.0
    _seed(tmp_path, "old", mtime=now - 20 * 86400)   # 20 j -> purgé (> 14)
    _seed(tmp_path, "fresh", mtime=now - 1 * 86400)  # 1 j -> gardé
    monkeypatch.setattr(R, "HARVESTER_RUNS_DIR", str(tmp_path))
    monkeypatch.setattr(R, "_harvester_jobs", {})
    purged = R.purge_old_runs(now=now, max_age_days=14, is_alive=lambda p: False)
    assert purged == ["old"]
    assert (tmp_path / "old").exists() is False
    assert (tmp_path / "fresh").exists() is True


def test_purge_never_touches_running_even_if_old(tmp_path, monkeypatch):
    now = 1_000_000.0
    _seed(tmp_path, "old_running", mtime=now - 30 * 86400, pid=4242)
    monkeypatch.setattr(R, "HARVESTER_RUNS_DIR", str(tmp_path))
    monkeypatch.setattr(R, "_harvester_jobs", {})
    purged = R.purge_old_runs(now=now, max_age_days=14, is_alive=lambda p: True)
    assert purged == []
    assert (tmp_path / "old_running").exists() is True


def test_purge_drops_inmemory_job_entry(tmp_path, monkeypatch):
    now = 1_000_000.0
    _seed(tmp_path, "gone", mtime=now - 40 * 86400)
    monkeypatch.setattr(R, "HARVESTER_RUNS_DIR", str(tmp_path))
    monkeypatch.setattr(R, "_harvester_jobs", {"gone": {"job_id": "gone"}})
    R.purge_old_runs(now=now, max_age_days=14, is_alive=lambda p: False)
    assert "gone" not in R._harvester_jobs


def test_purge_removes_old_completed_run_when_not_consumed(tmp_path, monkeypatch):
    # Un run TERMINÉ (todo vide) avec records mais non-consommé > 14j est purgé
    # (anti-accumulation). La protection d'un feed actif vient de /data qui touche
    # le mtime — pas de la simple présence de records.
    now = 1_000_000.0
    rd = tmp_path / "done_old"
    rd.mkdir()
    HarvestConfig(url="https://ex.test/p1", recipe=Recipe.from_dict(_RECIPE),
                  plan={}, pacing={}, feed_key="K").save(str(rd))
    s = Store(str(rd / "store.json"))
    s.add_record({"x": "1"})            # records mais AUCUN todo -> completed
    s.save()
    os.utime(str(rd / "store.json"), (now - 20 * 86400, now - 20 * 86400))
    monkeypatch.setattr(R, "HARVESTER_RUNS_DIR", str(tmp_path))
    monkeypatch.setattr(R, "_harvester_jobs", {})
    purged = R.purge_old_runs(now=now, max_age_days=14, is_alive=lambda p: False)
    assert "done_old" in purged


def test_purge_fallback_to_dir_mtime_when_no_store(tmp_path, monkeypatch):
    # store.json absent -> ancre = mtime du dossier (fallback ref=d)
    now = 1_000_000.0
    rd = tmp_path / "nostore"
    rd.mkdir()
    os.utime(str(rd), (now - 20 * 86400, now - 20 * 86400))
    monkeypatch.setattr(R, "HARVESTER_RUNS_DIR", str(tmp_path))
    monkeypatch.setattr(R, "_harvester_jobs", {})
    assert "nostore" in R.purge_old_runs(now=now, max_age_days=14, is_alive=lambda p: False)


def test_purge_empty_when_no_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(R, "HARVESTER_RUNS_DIR", str(tmp_path / "nope"))
    assert R.purge_old_runs(now=1.0) == []
