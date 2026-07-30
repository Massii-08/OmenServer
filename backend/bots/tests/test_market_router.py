"""Tests du router Market Pulse.

Miroir de test_harvester_router.py : TestClient FastAPI + override de
``get_current_user`` (sur lequel ``require_role`` se branche), subprocess
monkeypatché (aucun process réel, aucun réseau), tout écrit dans tmp_path.
"""
import io
import json
import os
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.auth.utils import get_current_user
from backend.bots import market_router as mr
from backend.bots import market_schedule as ms


class FakeUser(object):
    def __init__(self, role="admin"):
        self.role = role
        self.is_admin = role == "admin"
        self.username = "tester"


def make_client(tmp_path, monkeypatch, role="admin"):
    """Client isolé : runs dir en tmp, lancement de subprocess neutralisé."""
    monkeypatch.setattr(mr, "MARKET_RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(ms, "DEFAULT_PATH", str(tmp_path / "schedule.json"))
    mr._market_jobs.clear()

    launched = {}

    def fake_launch(run_dir, job, opts=None):
        launched["run_dir"] = run_dir
        launched["opts"] = opts
        job["status"] = "running"
        job["process"] = None
        # contrat du vrai lancement : un pidfile vivant -> le statut reconstruit
        # depuis le disque voit "running".
        mr._pid_path(run_dir).write_text(str(os.getpid()), encoding="utf-8")
        return None

    monkeypatch.setattr(mr, "_launch_subprocess", fake_launch)

    app = FastAPI()
    app.include_router(mr.router)
    app.dependency_overrides[get_current_user] = lambda: FakeUser(role)
    return TestClient(app), launched


def _start(c):
    r = c.post("/api/bots/market/run", json={})
    assert r.status_code == 200, r.text
    return r.json()["job_id"]


def _kill_pid(tmp_path, job_id):
    """Simule un run terminé : pidfile pointant sur un PID mort."""
    (tmp_path / "runs" / job_id / "pid").write_text("999999999", encoding="utf-8")


SNAP = {"generated_at": 1785257927, "markets": [
    {"symbol": "^GSPC", "label": "S&P 500", "region": "usa", "kind": "index",
     "price": 7450.02, "change_pct": 0.5}], "errors": []}


# ================================================================
#  ACCÈS
# ================================================================

def test_run_refuses_player_role(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch, role="player")
    assert c.post("/api/bots/market/run", json={}).status_code == 403


def test_run_allowed_for_money_role(tmp_path, monkeypatch):
    # l'utilisateur final (investisseur) a un compte de rôle "money"
    c, _ = make_client(tmp_path, monkeypatch, role="money")
    assert c.post("/api/bots/market/run", json={}).status_code == 200


def test_status_and_snapshot_refuse_player(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch, role="player")
    assert c.get("/api/bots/market/snapshot").status_code == 403
    assert c.get("/api/bots/market/active").status_code == 403


# ================================================================
#  RUN / STATUS / ACTIVE / STOP
# ================================================================

def test_run_creates_run_dir_and_meta(tmp_path, monkeypatch):
    c, launched = make_client(tmp_path, monkeypatch)
    job_id = _start(c)
    run_dir = tmp_path / "runs" / job_id
    assert run_dir.is_dir()
    assert launched["run_dir"] == str(run_dir)
    meta = json.loads((run_dir / "meta.json").read_text(encoding="utf-8"))
    assert meta["job_id"] == job_id
    assert meta["user"] == "tester"
    assert meta["date"]          # date locale du run (pour le rattrapage)


def test_run_does_not_stack_a_second_run(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    first = _start(c)
    r = c.post("/api/bots/market/run", json={})
    assert r.status_code == 200
    body = r.json()
    assert body["job_id"] == first          # on rend le run en cours
    assert body["already_running"] is True
    # un seul dossier créé
    assert len(list((tmp_path / "runs").iterdir())) == 1


def test_run_restarts_once_previous_finished(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    first = _start(c)
    _kill_pid(tmp_path, first)
    (tmp_path / "runs" / first / "snapshot.json").write_text("{}", encoding="utf-8")
    second = c.post("/api/bots/market/run", json={}).json()
    assert second["job_id"] != first
    assert second["already_running"] is False


def test_status_reports_files(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    job_id = _start(c)
    rd = tmp_path / "runs" / job_id
    (rd / "snapshot.json").write_text(json.dumps(SNAP), encoding="utf-8")
    (rd / "report.txt").write_text("ciao", encoding="utf-8")
    (rd / "market_pulse_2026-07-28.xlsx").write_bytes(b"PK")
    s = c.get("/api/bots/market/status/{0}".format(job_id))
    assert s.status_code == 200
    body = s.json()
    assert body["status"] == "running"
    assert body["files"]["snapshot"] is True
    assert body["files"]["report"] is True
    assert body["files"]["history"] is False
    assert body["files"]["excel"] == "market_pulse_2026-07-28.xlsx"


def test_status_completed_when_pid_dead_and_snapshot_present(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    job_id = _start(c)
    _kill_pid(tmp_path, job_id)
    (tmp_path / "runs" / job_id / "snapshot.json").write_text("{}", encoding="utf-8")
    assert c.get("/api/bots/market/status/{0}".format(job_id)).json()["status"] == "completed"


def test_status_error_when_pid_dead_without_snapshot(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    job_id = _start(c)
    _kill_pid(tmp_path, job_id)
    assert c.get("/api/bots/market/status/{0}".format(job_id)).json()["status"] == "error"


def test_status_unknown_job_404(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert c.get("/api/bots/market/status/" + "0" * 32).status_code == 404


def test_active_returns_live_then_last_finished(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert c.get("/api/bots/market/active").json()["found"] is False
    job_id = _start(c)
    a = c.get("/api/bots/market/active").json()
    assert a["found"] is True and a["job_id"] == job_id and a["status"] == "running"
    _kill_pid(tmp_path, job_id)
    (tmp_path / "runs" / job_id / "snapshot.json").write_text("{}", encoding="utf-8")
    a2 = c.get("/api/bots/market/active").json()
    assert a2["found"] is True and a2["status"] == "completed"


def test_active_survives_a_restart_of_the_backend(tmp_path, monkeypatch):
    # registre mémoire perdu (restart uvicorn) -> le disque reste la vérité
    c, _ = make_client(tmp_path, monkeypatch)
    job_id = _start(c)
    mr._market_jobs.clear()
    a = c.get("/api/bots/market/active").json()
    assert a["found"] is True and a["job_id"] == job_id and a["status"] == "running"


def test_stop_marks_job_stopped(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    job_id = _start(c)
    r = c.post("/api/bots/market/stop/{0}".format(job_id))
    assert r.status_code == 200 and r.json()["status"] == "stopped"
    assert c.get("/api/bots/market/status/{0}".format(job_id)).json()["status"] == "stopped"


def test_stop_unknown_job_404(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert c.post("/api/bots/market/stop/" + "0" * 32).status_code == 404


# ================================================================
#  TRAVERSÉE DE CHEMIN
# ================================================================

@pytest.mark.parametrize("bad", ["..", "..%2f..%2fetc", "not-a-uuid", "0" * 31, "../../etc"])
def test_malformed_job_id_never_composes_a_path(tmp_path, monkeypatch, bad):
    c, _ = make_client(tmp_path, monkeypatch)
    assert c.get("/api/bots/market/status/{0}".format(bad)).status_code == 404
    assert c.post("/api/bots/market/stop/{0}".format(bad)).status_code == 404
    assert c.get("/api/bots/market/download/{0}".format(bad)).status_code == 404
    assert c.get("/api/bots/market/report/{0}".format(bad)).status_code == 404


def test_check_job_id_accepts_real_uuid(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    job_id = _start(c)
    assert len(job_id) == 32
    assert c.get("/api/bots/market/status/{0}".format(job_id)).status_code == 200


# ================================================================
#  SNAPSHOT (endpoint consommé par l'UI)
# ================================================================

def test_snapshot_without_any_run_is_clean(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    r = c.get("/api/bots/market/snapshot")
    assert r.status_code == 200
    body = r.json()
    assert body["job_id"] is None
    assert body["snapshot"] is None
    assert body["report"] is None
    assert body["history"] is None
    assert body["news"] is None


def test_snapshot_returns_latest_payload(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    job_id = _start(c)
    rd = tmp_path / "runs" / job_id
    (rd / "snapshot.json").write_text(json.dumps(SNAP), encoding="utf-8")
    (rd / "history.json").write_text(json.dumps({"stats": {}, "errors": []}), encoding="utf-8")
    (rd / "report.txt").write_text("MERCATI\nS&P 500 +0,50%", encoding="utf-8")
    (rd / "news.json").write_text(json.dumps({"items": [{"title": "T"}]}), encoding="utf-8")
    body = c.get("/api/bots/market/snapshot").json()
    assert body["job_id"] == job_id
    assert body["snapshot"]["markets"][0]["symbol"] == "^GSPC"
    assert body["snapshot"]["generated_at"] == 1785257927
    assert "S&P 500" in body["report"]
    assert body["history"] == {"stats": {}, "errors": []}
    assert body["news"]["items"][0]["title"] == "T"
    assert body["ran_at"]


def test_snapshot_skips_runs_without_snapshot_file(tmp_path, monkeypatch):
    # un run en cours (ou raté) ne doit pas masquer le dernier snapshot valable
    c, _ = make_client(tmp_path, monkeypatch)
    old = _start(c)
    (tmp_path / "runs" / old / "snapshot.json").write_text(json.dumps(SNAP), encoding="utf-8")
    _kill_pid(tmp_path, old)
    time.sleep(0.01)
    new = c.post("/api/bots/market/run", json={}).json()["job_id"]
    assert new != old
    body = c.get("/api/bots/market/snapshot").json()
    assert body["job_id"] == old
    assert body["snapshot"]["markets"][0]["symbol"] == "^GSPC"


def test_snapshot_tolerates_corrupt_json(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    job_id = _start(c)
    (tmp_path / "runs" / job_id / "snapshot.json").write_text("{oops", encoding="utf-8")
    r = c.get("/api/bots/market/snapshot")
    assert r.status_code == 200          # jamais 500
    assert r.json()["snapshot"] is None


# ================================================================
#  DOWNLOAD / REPORT
# ================================================================

def test_download_returns_xlsx(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    job_id = _start(c)
    (tmp_path / "runs" / job_id / "market_pulse_2026-07-28.xlsx").write_bytes(b"PK\x03\x04")
    r = c.get("/api/bots/market/download/{0}".format(job_id))
    assert r.status_code == 200
    assert "spreadsheetml" in r.headers["content-type"]
    assert "market_pulse_2026-07-28.xlsx" in r.headers.get("content-disposition", "")


def test_download_404_when_missing(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    job_id = _start(c)
    assert c.get("/api/bots/market/download/{0}".format(job_id)).status_code == 404


def test_report_returns_plain_text(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    job_id = _start(c)
    (tmp_path / "runs" / job_id / "report.txt").write_text(
        "APERTURA MERCATI\n+0,41%", encoding="utf-8")
    r = c.get("/api/bots/market/report/{0}".format(job_id))
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/plain")
    assert "+0,41%" in r.text


def test_report_404_when_missing(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    job_id = _start(c)
    assert c.get("/api/bots/market/report/{0}".format(job_id)).status_code == 404


# ================================================================
#  PLANIFICATION (endpoints)
# ================================================================

def test_get_schedule_defaults(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    r = c.get("/api/bots/market/schedule")
    assert r.status_code == 200
    body = r.json()
    assert body["enabled"] is False
    assert body["time"] == "07:30"
    assert body["tz"] == "Europe/Rome"
    assert body["days"] == "weekdays"


def test_post_schedule_requires_admin_strict(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch, role="money")
    # lecture autorisée pour "money"...
    assert c.get("/api/bots/market/schedule").status_code == 200
    # ...mais l'écriture est admin strict
    r = c.post("/api/bots/market/schedule",
               json={"enabled": True, "time": "07:00", "tz": "Europe/Rome", "days": "daily"})
    assert r.status_code == 403


def test_post_schedule_persists(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    r = c.post("/api/bots/market/schedule",
               json={"enabled": True, "time": "7:5", "tz": "Europe/Rome", "days": "daily"})
    assert r.status_code == 200
    assert r.json()["time"] == "07:05"
    saved = ms.load(str(tmp_path / "schedule.json"))
    assert saved["enabled"] is True and saved["days"] == "daily"


def test_post_schedule_rejects_bad_timezone_with_400(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    r = c.post("/api/bots/market/schedule",
               json={"enabled": True, "time": "07:30", "tz": "Mars/Olympus", "days": "daily"})
    assert r.status_code == 400        # jamais un 500


def test_post_schedule_rejects_bad_time_with_400(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    r = c.post("/api/bots/market/schedule",
               json={"enabled": True, "time": "25:00", "tz": "Europe/Rome", "days": "daily"})
    assert r.status_code == 400


def test_post_schedule_reregisters_the_job(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    calls = []
    monkeypatch.setattr(mr, "_reregister_schedule", lambda cfg: calls.append(cfg))
    c.post("/api/bots/market/schedule",
           json={"enabled": True, "time": "07:30", "tz": "Europe/Rome", "days": "weekdays"})
    assert len(calls) == 1 and calls[0]["enabled"] is True


def test_schedule_exposes_last_run_date(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    _start(c)
    body = c.get("/api/bots/market/schedule").json()
    assert body["last_run_date"]


# ================================================================
#  LANCEMENT RÉEL (subprocess) — contrat du moteur
# ================================================================

class FakeProc(object):
    def __init__(self, pid=4242, rc=0):
        self.pid = pid
        self.returncode = rc
        self.stdout = io.StringIO("ligne de log\n")
        self.terminated = False

    def wait(self):
        return self.returncode

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated = True


def test_launch_detaches_the_subprocess(tmp_path, monkeypatch):
    """start_new_session=True est OBLIGATOIRE : l'auto-deploy redémarre uvicorn
    toutes les minutes et tuerait un enfant resté dans la même session."""
    monkeypatch.setattr(mr, "MARKET_RUNS_DIR", tmp_path / "runs")
    captured = {}

    def fake_popen(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["kwargs"] = kwargs
        return FakeProc()

    monkeypatch.setattr(mr.subprocess, "Popen", fake_popen)
    rd = tmp_path / "runs" / ("a" * 32)
    rd.mkdir(parents=True)
    job = {"job_id": "a" * 32, "status": "starting", "logs": [], "process": None}
    mr._launch_subprocess(str(rd), job)
    assert captured["kwargs"]["start_new_session"] is True
    assert captured["kwargs"]["cwd"] == str(mr.MARKET_PULSE_DIR)
    assert (rd / "pid").read_text(encoding="utf-8") == "4242"


def test_build_cmd_matches_engine_contract(tmp_path):
    cmd = mr._build_cmd("/tmp/rd", {"stats": True, "report": True, "excel": True, "news": False})
    assert cmd[1] == "main.py"
    assert "--out" in cmd and cmd[cmd.index("--out") + 1] == "/tmp/rd"
    assert "--stats" in cmd and "--report" in cmd and "--excel" in cmd
    assert "--news" not in cmd


def test_build_cmd_omits_disabled_flags(tmp_path):
    cmd = mr._build_cmd("/tmp/rd", {"stats": False, "report": False, "excel": False, "news": True})
    assert "--stats" not in cmd and "--excel" not in cmd and "--report" not in cmd
    assert "--news" in cmd


# ================================================================
#  RATTRAPAGE MATINAL (machine en veille 01:00 → 06:00)
# ================================================================

def test_run_scheduled_launches_when_nothing_alive(tmp_path, monkeypatch):
    c, launched = make_client(tmp_path, monkeypatch)
    job_id = mr.run_scheduled()
    assert job_id
    assert launched["run_dir"].endswith(job_id)


def test_run_scheduled_does_not_stack(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    first = _start(c)
    assert mr.run_scheduled() == first


def test_catch_up_launches_when_morning_slot_was_missed(tmp_path, monkeypatch):
    from datetime import datetime
    from zoneinfo import ZoneInfo
    c, launched = make_client(tmp_path, monkeypatch)
    ms.save({"enabled": True, "time": "07:30", "tz": "Europe/Rome", "days": "weekdays"},
            str(tmp_path / "schedule.json"))
    now = datetime(2026, 7, 28, 9, 0, tzinfo=ZoneInfo("Europe/Rome"))   # mardi
    assert mr.catch_up_if_needed(now=now) is not None
    assert "run_dir" in launched


def test_catch_up_skipped_when_already_ran_today(tmp_path, monkeypatch):
    from datetime import datetime
    from zoneinfo import ZoneInfo
    c, _ = make_client(tmp_path, monkeypatch)
    ms.save({"enabled": True, "time": "07:30", "tz": "Europe/Rome", "days": "weekdays"},
            str(tmp_path / "schedule.json"))
    job_id = _start(c)
    # force la date du run à "aujourd'hui" du point de vue du test
    meta_p = tmp_path / "runs" / job_id / "meta.json"
    meta = json.loads(meta_p.read_text(encoding="utf-8"))
    meta["date"] = "2026-07-28"
    meta_p.write_text(json.dumps(meta), encoding="utf-8")
    now = datetime(2026, 7, 28, 9, 0, tzinfo=ZoneInfo("Europe/Rome"))
    assert mr.catch_up_if_needed(now=now) is None


def test_catch_up_skipped_when_disabled(tmp_path, monkeypatch):
    from datetime import datetime
    from zoneinfo import ZoneInfo
    c, _ = make_client(tmp_path, monkeypatch)
    ms.save({"enabled": False, "time": "07:30", "tz": "Europe/Rome", "days": "weekdays"},
            str(tmp_path / "schedule.json"))
    now = datetime(2026, 7, 28, 9, 0, tzinfo=ZoneInfo("Europe/Rome"))
    assert mr.catch_up_if_needed(now=now) is None


def test_last_run_date_reads_the_most_recent_meta(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    job_id = _start(c)
    meta_p = tmp_path / "runs" / job_id / "meta.json"
    meta = json.loads(meta_p.read_text(encoding="utf-8"))
    meta["date"] = "2026-07-27"
    meta_p.write_text(json.dumps(meta), encoding="utf-8")
    assert mr.last_run_date() == "2026-07-27"


def test_last_run_date_none_without_runs(tmp_path, monkeypatch):
    make_client(tmp_path, monkeypatch)
    assert mr.last_run_date() is None


# ================================================================
#  PURGE
# ================================================================

def _seed_run(tmp_path, name, age_days):
    d = tmp_path / "runs" / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "meta.json").write_text(json.dumps({"job_id": name, "date": "2026-01-01"}),
                                 encoding="utf-8")
    (d / "snapshot.json").write_text("{}", encoding="utf-8")
    old = time.time() - age_days * 86400
    for f in ("meta.json", "snapshot.json"):
        os.utime(str(d / f), (old, old))
    os.utime(str(d), (old, old))
    return d


def test_purge_removes_old_runs(tmp_path, monkeypatch):
    make_client(tmp_path, monkeypatch)
    old = _seed_run(tmp_path, "a" * 32, age_days=60)
    recent = _seed_run(tmp_path, "b" * 32, age_days=1)
    purged = mr.purge_old_runs(max_age_days=30)
    assert (old.name in purged) and (recent.name not in purged)
    assert not old.is_dir() and recent.is_dir()


def test_purge_keeps_the_most_recent_run_even_if_old(tmp_path, monkeypatch):
    # sinon /snapshot devient vide après une longue période sans lancement
    make_client(tmp_path, monkeypatch)
    older = _seed_run(tmp_path, "a" * 32, age_days=90)
    newer = _seed_run(tmp_path, "b" * 32, age_days=60)
    mr.purge_old_runs(max_age_days=30)
    assert not older.is_dir()
    assert newer.is_dir()


def test_purge_never_touches_a_live_run(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    job_id = _start(c)                      # pidfile = PID vivant (le nôtre)
    d = tmp_path / "runs" / job_id
    old = time.time() - 90 * 86400
    os.utime(str(d), (old, old))
    for f in d.iterdir():
        os.utime(str(f), (old, old))
    mr.purge_old_runs(max_age_days=30)
    assert d.is_dir()


def test_purge_without_runs_dir_is_noop(tmp_path, monkeypatch):
    monkeypatch.setattr(mr, "MARKET_RUNS_DIR", tmp_path / "absent")
    assert mr.purge_old_runs() == []


# ================================================================
#  PHASE D — préférences, briefings, un job par ouverture
# ================================================================

BRIEFINGS = {
    "euronext": {"exchange": "euronext", "label": "Euronext",
                 "index": {"label": "Euronext 100", "change_pct": 0.41},
                 "agenda": [{"when": "2026-07-31", "what": "BoJ — riunione"}],
                 "news": {"items": [], "alarms": []},
                 "analysis": {"text": "Le borse asiatiche…", "degraded": False},
                 "generated_at": 1785412800},
}


def _prefs_client(tmp_path, monkeypatch, role="admin"):
    c, launched = make_client(tmp_path, monkeypatch, role=role)
    monkeypatch.setattr(mr, "PREFS_PATH", str(tmp_path / "prefs.json"))
    return c, launched


# --- accès -----------------------------------------------------------------

def test_prefs_are_readable_by_the_investor_account(tmp_path, monkeypatch):
    c, _ = _prefs_client(tmp_path, monkeypatch, role="money")
    assert c.get("/api/bots/market/prefs").status_code == 200


def test_prefs_are_not_readable_by_a_player(tmp_path, monkeypatch):
    c, _ = _prefs_client(tmp_path, monkeypatch, role="player")
    assert c.get("/api/bots/market/prefs").status_code == 403


def test_writing_the_prefs_is_admin_STRICT(tmp_path, monkeypatch):
    """Choisir les bourses suivies règle les réveils de la machine.

    Miroir de la planification : lecture pour l'investisseur, écriture pour
    l'administrateur.
    """
    c, _ = _prefs_client(tmp_path, monkeypatch, role="money")
    r = c.post("/api/bots/market/prefs", json={"borse": ["nyse"]})
    assert r.status_code == 403


def test_briefings_refuse_a_player(tmp_path, monkeypatch):
    c, _ = _prefs_client(tmp_path, monkeypatch, role="player")
    assert c.get("/api/bots/market/briefings").status_code == 403


# --- lecture / écriture ----------------------------------------------------

def test_prefs_without_a_file_serve_the_defaults(tmp_path, monkeypatch):
    c, _ = _prefs_client(tmp_path, monkeypatch)
    body = c.get("/api/bots/market/prefs").json()
    assert body["prefs"]["borse"]
    assert body["prefs"]["opzioni"]["max_notizie"] >= 1


def test_the_catalogue_travels_with_the_prefs(tmp_path, monkeypatch):
    """Le sélecteur a besoin des noms, des heures et des sous-places.

    Le servir dans le même appel évite un aller-retour et, surtout, évite que
    l'UI code en dur une liste qui vivrait alors à deux endroits.
    """
    c, _ = _prefs_client(tmp_path, monkeypatch)
    body = c.get("/api/bots/market/prefs").json()
    assert len(body["exchanges"]) == 10
    ids = [e["id"] for e in body["exchanges"]]
    assert "euronext" in ids


def test_posting_the_prefs_writes_them_and_serves_them_back(tmp_path, monkeypatch):
    c, _ = _prefs_client(tmp_path, monkeypatch)
    r = c.post("/api/bots/market/prefs",
               json={"borse": ["nyse", "jpx"],
                     "titoli": {"nyse": ["NKE"]},
                     "opzioni": {"sintesi": False, "max_notizie": 5}})
    assert r.status_code == 200, r.text
    saved = r.json()["prefs"]
    assert saved["borse"] == ["nyse", "jpx"]
    assert saved["titoli"] == {"nyse": ["NKE"]}
    assert saved["opzioni"]["sintesi"] is False
    assert saved["opzioni"]["max_notizie"] == 5
    # relu depuis le disque, pas depuis la mémoire
    again = c.get("/api/bots/market/prefs").json()["prefs"]
    assert again["borse"] == ["nyse", "jpx"]


def test_an_unknown_exchange_is_dropped_and_the_warning_is_served(tmp_path, monkeypatch):
    c, _ = _prefs_client(tmp_path, monkeypatch)
    body = c.post("/api/bots/market/prefs",
                  json={"borse": ["nyse", "borsa-di-marte"]}).json()
    assert body["prefs"]["borse"] == ["nyse"]
    assert any("marte" in w for w in body["warnings"]), body["warnings"]


def test_the_groups_are_served_so_the_ui_can_say_when_it_will_fire(tmp_path, monkeypatch):
    c, _ = _prefs_client(tmp_path, monkeypatch)
    body = c.post("/api/bots/market/prefs", json={"borse": ["nyse", "nasdaq", "jpx"]}).json()
    # deux ouvertures pour trois opérateurs
    assert len(body["groups"]) == 2, body["groups"]
    for group in body["groups"]:
        assert set(group) >= {"ids", "tz", "opens_at", "fires_at", "key"}


def test_posting_prefs_reinstalls_the_opening_jobs(tmp_path, monkeypatch):
    seen = {}

    def fake_register(scheduler, run_fn, groups, cfg=None, **kw):
        seen["groups"] = groups
        return []

    c, _ = _prefs_client(tmp_path, monkeypatch)
    monkeypatch.setattr(mr.ms, "register_exchange_jobs", fake_register)
    monkeypatch.setattr(mr, "_scheduler", lambda: object())
    c.post("/api/bots/market/prefs", json={"borse": ["jpx"]})
    assert seen.get("groups") is not None, "les réveils n'ont pas été réinstallés"
    assert seen["groups"] and seen["groups"][0][0] == ["jpx"]


# --- /briefings ------------------------------------------------------------

def test_briefings_without_any_run_are_clean(tmp_path, monkeypatch):
    c, _ = _prefs_client(tmp_path, monkeypatch)
    body = c.get("/api/bots/market/briefings").json()
    assert body["briefings"] is None
    assert body["job_id"] is None


def test_briefings_of_the_latest_run_are_served(tmp_path, monkeypatch):
    c, _ = _prefs_client(tmp_path, monkeypatch)
    job_id = _start(c)
    run_dir = tmp_path / "runs" / job_id
    (run_dir / "briefings.json").write_text(json.dumps(BRIEFINGS), encoding="utf-8")
    body = c.get("/api/bots/market/briefings").json()
    assert body["job_id"] == job_id
    assert body["briefings"]["euronext"]["label"] == "Euronext"
    assert body["ran_at"]


def test_a_fresh_run_without_briefings_does_not_hide_yesterdays(tmp_path, monkeypatch):
    """Un run en cours ne doit pas vider la page.

    Même règle que /snapshot : on saute les runs qui n'ont rien produit plutôt
    que d'afficher une page blanche pendant les deux minutes du relevé.
    """
    c, _ = _prefs_client(tmp_path, monkeypatch)
    old = _start(c)
    (tmp_path / "runs" / old / "briefings.json").write_text(json.dumps(BRIEFINGS),
                                                           encoding="utf-8")
    _kill_pid(tmp_path, old)
    time.sleep(0.01)
    new = _start(c)
    assert new != old
    body = c.get("/api/bots/market/briefings").json()
    assert body["job_id"] == old
    assert body["briefings"]["euronext"]


def test_briefings_tolerate_a_half_written_file(tmp_path, monkeypatch):
    c, _ = _prefs_client(tmp_path, monkeypatch)
    job_id = _start(c)
    (tmp_path / "runs" / job_id / "briefings.json").write_text("{trunc", encoding="utf-8")
    body = c.get("/api/bots/market/briefings").json()
    assert body["briefings"] is None       # jamais un 500


# --- ligne de commande ------------------------------------------------------

def test_build_cmd_asks_for_the_briefings_and_names_the_prefs_file(tmp_path):
    cmd = mr._build_cmd("/tmp/rd", {"briefings": True})
    assert "--briefings" in cmd
    # Le chemin est passé explicitement : c'est le router qui décide où vit la
    # config, pas le répertoire courant du subprocess.
    assert "--prefs" in cmd and cmd[cmd.index("--prefs") + 1] == mr.PREFS_PATH


def test_build_cmd_limits_the_briefings_to_the_venue_that_opens(tmp_path):
    """Sans --borse, l'ouverture de Tokyo régénérerait aussi Milan et New York —
    et autant d'appels au LLM pour rien."""
    cmd = mr._build_cmd("/tmp/rd", {"briefings": True, "borse": ["nyse", "nasdaq"]})
    assert cmd[cmd.index("--borse") + 1] == "nyse,nasdaq"


def test_build_cmd_without_briefings_does_not_pass_prefs_or_borse(tmp_path):
    cmd = mr._build_cmd("/tmp/rd", {"briefings": False, "borse": ["nyse"]})
    assert "--briefings" not in cmd and "--prefs" not in cmd and "--borse" not in cmd


def test_a_manual_run_asks_for_the_briefings_by_default(tmp_path, monkeypatch):
    c, launched = _prefs_client(tmp_path, monkeypatch)
    c.post("/api/bots/market/run", json={})
    assert launched["opts"]["briefings"] is True


# --- rattrapage PAR GROUPE --------------------------------------------------

def _enable(tmp_path, time_="07:30"):
    ms.save({"enabled": True, "time": time_, "tz": "Europe/Rome", "days": "weekdays"},
            str(tmp_path / "schedule.json"))


def test_a_group_run_records_which_group_it_was_for(tmp_path, monkeypatch):
    """La date du dernier run doit être connue PAR GROUPE.

    Sinon le rattrapage de Tokyo serait annulé par un run de New York, et
    l'inverse.
    """
    c, launched = _prefs_client(tmp_path, monkeypatch)
    job_id = mr.run_exchange_group(["nyse", "nasdaq"])
    meta = json.loads((tmp_path / "runs" / job_id / "meta.json").read_text(encoding="utf-8"))
    assert meta["exchanges"] == ["nyse", "nasdaq"]
    assert meta["groups"] == [ms.group_key("America/New_York", "09:30")]
    assert launched["opts"]["borse"] == ["nyse", "nasdaq"]


def test_last_run_dates_are_read_per_group(tmp_path, monkeypatch):
    c, _ = _prefs_client(tmp_path, monkeypatch)
    job_id = mr.run_exchange_group(["jpx"])
    dates = mr.last_run_dates()
    key = ms.group_key("Asia/Tokyo", "09:00")
    assert key in dates, dates
    assert dates[key] == json.loads(
        (tmp_path / "runs" / job_id / "meta.json").read_text(encoding="utf-8"))["date"]


def test_last_run_dates_is_empty_without_runs(tmp_path, monkeypatch):
    c, _ = _prefs_client(tmp_path, monkeypatch)
    assert mr.last_run_dates() == {}


def test_the_asian_opening_missed_during_the_nightly_sleep_is_caught_up(tmp_path, monkeypatch):
    from datetime import datetime
    from zoneinfo import ZoneInfo
    c, launched = _prefs_client(tmp_path, monkeypatch)
    _enable(tmp_path)
    # Sélection : Tokyo seulement, pour que la cible soit sans ambiguïté.
    from backend.bots import market_engine as me
    me.save_prefs({"borse": ["jpx"]}, str(tmp_path / "prefs.json"))
    now = datetime(2026, 7, 30, 6, 0, tzinfo=ZoneInfo("Europe/Rome"))   # jeudi 06:00
    done = mr.catch_up_exchange_groups(now=now)
    assert done, "l'ouverture de Tokyo n'a pas été rattrapée"
    assert launched["opts"]["borse"] == ["jpx"]


def test_nothing_is_caught_up_when_the_group_already_ran_today(tmp_path, monkeypatch):
    from datetime import datetime
    from zoneinfo import ZoneInfo
    from backend.bots import market_engine as me
    c, _ = _prefs_client(tmp_path, monkeypatch)
    _enable(tmp_path)
    me.save_prefs({"borse": ["jpx"]}, str(tmp_path / "prefs.json"))
    now = datetime(2026, 7, 30, 6, 0, tzinfo=ZoneInfo("Europe/Rome"))
    mr.run_exchange_group(["jpx"], today=now)
    _kill_pid(tmp_path, mr._run_dirs()[0].name)
    assert mr.catch_up_exchange_groups(now=now) == []


def test_no_catch_up_when_the_schedule_is_off(tmp_path, monkeypatch):
    from datetime import datetime
    from zoneinfo import ZoneInfo
    from backend.bots import market_engine as me
    c, _ = _prefs_client(tmp_path, monkeypatch)
    ms.save({"enabled": False, "time": "07:30", "tz": "Europe/Rome",
             "days": "weekdays"}, str(tmp_path / "schedule.json"))
    me.save_prefs({"borse": ["jpx"]}, str(tmp_path / "prefs.json"))
    now = datetime(2026, 7, 30, 6, 0, tzinfo=ZoneInfo("Europe/Rome"))
    assert mr.catch_up_exchange_groups(now=now) == []


def test_catch_up_never_raises_when_the_engine_is_missing(tmp_path, monkeypatch):
    from datetime import datetime
    from backend.bots import market_engine as me
    c, _ = _prefs_client(tmp_path, monkeypatch)
    _enable(tmp_path)

    def boom(_ids):
        raise me.EngineUnavailable("pas de moteur")

    monkeypatch.setattr(me, "opening_groups", boom)
    assert mr.catch_up_exchange_groups(now=datetime(2026, 7, 30, 6, 0)) == []


def test_startup_installs_the_opening_jobs_too(tmp_path, monkeypatch):
    seen = {}
    c, _ = _prefs_client(tmp_path, monkeypatch)
    _enable(tmp_path)
    monkeypatch.setattr(mr, "_scheduler", lambda: object())
    monkeypatch.setattr(mr.ms, "register_job", lambda *a, **k: None)
    monkeypatch.setattr(mr.ms, "register_exchange_jobs",
                        lambda s, f, g, cfg=None, **k: seen.setdefault("groups", g))
    monkeypatch.setattr(mr, "catch_up_if_needed", lambda *a, **k: None)
    monkeypatch.setattr(mr, "catch_up_exchange_groups", lambda *a, **k: [])
    mr.register_startup_job()
    assert "groups" in seen, "les réveils d'ouverture n'ont pas été installés au boot"
