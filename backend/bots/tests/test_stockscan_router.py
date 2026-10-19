"""Tests du router du Scanner d'actions (``/api/bots/stocks``).

Miroir de test_market_router.py : TestClient FastAPI + override de
``get_current_user`` (sur lequel ``require_role`` se branche), lancement
remplacé par un double, ``os.killpg`` enregistré (AUCUN signal réel), tout
écrit dans tmp_path, aucun réseau. Seuls deux tests lancent un vrai process —
un moteur factice d'une ligne — pour prouver qu'un moteur terminé n'est
jamais affiché « running » (fil faucheur, cf. docstring du router).
"""
import io
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from backend.auth.utils import get_current_user
from backend.bots import stockscan_router as sr
from backend.bots.stockscan import config as cfgmod
from backend.bots.stockscan import markets as mk

API = "/api/bots/stocks"
VALID_ID = "0123456789abcdef" * 2
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
DEAD_PID = "999999999"      # au-delà de pid_max : jamais un process vivant

RESULTS = {
    "version": 1, "generated_at": "2026-10-17T07:45:12+00:00", "source": "screener",
    "counts": {"universe": 1180, "shortlist": 40, "kept": 1},
    "warnings": [{"code": "coach_empty"}],
    "rows": [{"rank": 1, "tv_symbol": "MIL:ENI", "symbol": "ENI.MI", "score": 72,
              "flags": ["earnings_soon"], "reasons": [{"code": "volume", "value": 2.4}]}],
}


class FakeUser(object):
    def __init__(self, role="admin"):
        self.role = role
        self.is_admin = role == "admin"
        self.username = "tester"


def make_client(tmp_path, monkeypatch, role="admin"):
    """Client isolé : runs + défauts en tmp, lancement neutralisé, signaux enregistrés."""
    monkeypatch.setattr(sr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(cfgmod, "DATA_DIR", tmp_path / "data")
    sr._stock_jobs.clear()

    harness = {"launches": [], "signals": []}

    def fake_launch(run_dir, job, username):
        harness["launches"].append({"run_dir": run_dir, "username": username})
        job["status"] = "running"
        job["process"] = None
        # contrat du vrai lancement : un pidfile VIVANT (le nôtre) -> le statut
        # reconstruit depuis le disque voit "running".
        sr._pid_path(run_dir).write_text(str(os.getpid()), encoding="utf-8")

    monkeypatch.setattr(sr, "_launch_subprocess", fake_launch)
    # JAMAIS de vrai signal depuis la suite : le pidfile factice est NOTRE pid.
    monkeypatch.setattr(sr.os, "killpg",
                        lambda pid, sig: harness["signals"].append((pid, sig)))

    app = FastAPI()
    app.include_router(sr.router)
    app.dependency_overrides[get_current_user] = lambda: FakeUser(role)
    return TestClient(app), harness


def _start(c, payload=None):
    r = c.post(API + "/run", json=payload if payload is not None else {})
    assert r.status_code == 200, r.text
    return r.json()["job_id"]


def _rd(tmp_path, job_id):
    return tmp_path / "runs" / job_id


def _kill_pid(tmp_path, job_id):
    """Simule un moteur sorti : pidfile pointant sur un PID mort."""
    (_rd(tmp_path, job_id) / "pid").write_text(DEAD_PID, encoding="utf-8")


def _finish(tmp_path, job_id, results=None):
    """Simule un scan terminé : PID mort + results.json écrit."""
    _kill_pid(tmp_path, job_id)
    (_rd(tmp_path, job_id) / "results.json").write_text(
        json.dumps(RESULTS if results is None else results), encoding="utf-8")


def _age(run_dir, seconds):
    """Vieillit un run (meta.json puis le dossier) de ``seconds``."""
    old = time.time() - seconds
    for path in (run_dir / "meta.json", run_dir):
        if path.exists():
            os.utime(str(path), (old, old))


def _seed_run(tmp_path, name, age_days, pid=None, results=True):
    """Un run déjà sur le disque, daté de ``age_days`` jours."""
    d = tmp_path / "runs" / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "meta.json").write_text(json.dumps(
        {"job_id": name, "user": "tester", "created_at": "2026-01-01T08:00:00",
         "date": "2026-01-01"}), encoding="utf-8")
    if results:
        (d / "results.json").write_text(json.dumps(RESULTS), encoding="utf-8")
    if pid is not None:
        (d / "pid").write_text(str(pid), encoding="utf-8")
    old = time.time() - age_days * 86400
    for f in d.iterdir():
        os.utime(str(f), (old, old))
    os.utime(str(d), (old, old))
    return d


# ================================================================
#  ACCÈS — admin + money, sur TOUS les endpoints
# ================================================================

FORBIDDEN_ROLES = ["spectator", "player", "trader", "moderator", "developer"]


@pytest.mark.parametrize("role", FORBIDDEN_ROLES)
def test_every_endpoint_is_refused_to_non_finance_roles(tmp_path, monkeypatch, role):
    c, h = make_client(tmp_path, monkeypatch, role=role)
    # un VRAI run avec résultats et classeur : le refus ne dépend pas de
    # l'absence du fichier (défaut du Bond Scanner : download sans contrôle).
    rd = _seed_run(tmp_path, VALID_ID, age_days=0)
    (rd / "stock_scanner.xlsx").write_bytes(b"PK")
    for method, path in (
            ("get", "/config"), ("post", "/run"), ("get", "/active"),
            ("get", "/latest"), ("get", "/status/" + VALID_ID),
            ("post", "/stop/" + VALID_ID), ("get", "/results/" + VALID_ID),
            ("get", "/download/" + VALID_ID)):
        if method == "get":
            r = c.get(API + path)
        else:
            r = c.post(API + path, json={})
        assert r.status_code == 403, (role, method, path, r.status_code)
    assert h["launches"] == [] and h["signals"] == []
    assert not (rd / "stop.flag").exists()


@pytest.mark.parametrize("role", ["money", "admin"])
def test_finance_roles_can_use_every_endpoint(tmp_path, monkeypatch, role):
    c, _ = make_client(tmp_path, monkeypatch, role=role)
    assert c.get(API + "/config").status_code == 200
    job_id = _start(c)
    assert c.get(API + "/active").status_code == 200
    assert c.get(API + "/status/" + job_id).status_code == 200
    _finish(tmp_path, job_id)
    (_rd(tmp_path, job_id) / "stock_scanner.xlsx").write_bytes(b"PK")
    assert c.get(API + "/latest").status_code == 200
    assert c.get(API + "/results/" + job_id).status_code == 200
    assert c.get(API + "/download/" + job_id).status_code == 200
    assert c.post(API + "/stop/" + job_id).status_code == 200


# ================================================================
#  /config
# ================================================================

def test_config_serves_defaults_catalogue_limits_windows_langs(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    body = c.get(API + "/config").json()
    assert set(body) == {"defaults", "markets", "limits", "windows", "langs"}
    assert body["defaults"] == cfgmod.DEFAULTS         # aucun fichier : défauts d'usine
    assert [m["id"] for m in body["markets"]] == [m.id for m in mk.MARKETS]
    assert set(body["limits"]) == set(cfgmod.LIMITS)
    assert body["limits"]["top_n"] == [5, 80]      # = borne de la présélection
    assert body["limits"]["min_cap_meur"] == [50, 500000]
    assert body["windows"] == [24, 48, 72]
    assert body["langs"] == ["fr", "en", "it"]


def test_config_defaults_follow_the_last_launched_settings(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    _start(c, {"markets": ["uk"], "top_n": 10, "lang": "it"})
    defaults = c.get(API + "/config").json()["defaults"]
    assert defaults["markets"] == ["uk"]
    assert defaults["top_n"] == 10 and defaults["lang"] == "it"


# ================================================================
#  /run
# ================================================================

def test_run_creates_dir_meta_config_saves_defaults_and_launches(tmp_path, monkeypatch):
    c, h = make_client(tmp_path, monkeypatch)
    r = c.post(API + "/run", json={"markets": ["italy", "japan"], "top_n": 10})
    assert r.status_code == 200, r.text
    body = r.json()
    job_id = body["job_id"]
    assert re.match(r"\A[0-9a-f]{32}\Z", job_id)
    assert body["already_running"] is False
    # le marché inconnu est écarté ET signalé (une faute de frappe doit se voir)
    assert {"code": "unknown_market", "value": "japan"} in body["warnings"]
    assert body["config"]["markets"] == ["italy"] and body["config"]["top_n"] == 10

    run_dir = _rd(tmp_path, job_id)
    assert run_dir.is_dir()
    meta = json.loads((run_dir / "meta.json").read_text(encoding="utf-8"))
    assert meta["job_id"] == job_id and meta["user"] == "tester"
    assert re.match(r"\A\d{4}-\d{2}-\d{2}\Z", meta["date"])
    # heure LOCALE à la seconde, sans fuseau
    assert re.match(r"\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\Z", meta["created_at"])
    assert meta["created_at"].startswith(meta["date"])
    assert json.loads((run_dir / "config.json").read_text(encoding="utf-8")) == body["config"]
    saved = json.loads((tmp_path / "data" / "defaults.json").read_text(encoding="utf-8"))
    assert saved == body["config"]
    assert h["launches"] == [{"run_dir": str(run_dir), "username": "tester"}]


def test_run_passes_every_field_to_the_engine(tmp_path, monkeypatch):
    """Un champ du modèle perdu en route serait une fonctionnalité MORTE, sans
    erreur ni test rouge (piège #61) : la forme COMPLÈTE est figée ici."""
    c, _ = make_client(tmp_path, monkeypatch)
    payload = {"markets": ["uk", "spain"], "min_cap_meur": 2500, "min_value_meur": 12.5,
               "window_h": 72, "top_n": 30, "shortlist": 60, "exclude_red": True,
               "lang": "en"}
    body = c.post(API + "/run", json=payload).json()
    assert body["warnings"] == []
    on_disk = json.loads((_rd(tmp_path, body["job_id"]) / "config.json").read_text(encoding="utf-8"))
    assert on_disk == payload == body["config"]


def test_run_without_a_body_launches_the_defaults(tmp_path, monkeypatch):
    c, h = make_client(tmp_path, monkeypatch)
    r = c.post(API + "/run")
    assert r.status_code == 200, r.text
    assert r.json()["config"] == cfgmod.DEFAULTS
    assert r.json()["warnings"] == []
    assert len(h["launches"]) == 1


def test_run_does_not_stack_a_second_run(tmp_path, monkeypatch):
    c, h = make_client(tmp_path, monkeypatch)
    first = _start(c)
    r = c.post(API + "/run", json={"markets": ["italy", "atlantis"]})
    assert r.status_code == 200
    body = r.json()
    assert body["job_id"] == first and body["already_running"] is True
    # les avertissements de la demande restent visibles...
    assert {"code": "unknown_market", "value": "atlantis"} in body["warnings"]
    # ...mais la config rendue est celle du scan qui TOURNE, pas celle refusée
    live = json.loads((_rd(tmp_path, first) / "config.json").read_text(encoding="utf-8"))
    assert body["config"] == live
    assert len(list((tmp_path / "runs").iterdir())) == 1
    assert len(h["launches"]) == 1


def test_a_refused_run_does_not_overwrite_the_saved_defaults(tmp_path, monkeypatch):
    # Rapport de test réel du 19/10 : un clic refusé (scan déjà en cours)
    # écrasait defaults.json avec des réglages qui n'ont jamais tourné.
    c, h = make_client(tmp_path, monkeypatch)
    first = _start(c)
    before = (tmp_path / "data" / "defaults.json").read_text(encoding="utf-8")
    r = c.post(API + "/run", json={"markets": ["uk"], "top_n": 7})
    assert r.json()["already_running"] is True and r.json()["job_id"] == first
    assert (tmp_path / "data" / "defaults.json").read_text(encoding="utf-8") == before


def test_the_live_run_is_detected_from_disk_after_a_backend_restart(tmp_path, monkeypatch):
    c, h = make_client(tmp_path, monkeypatch)
    first = _start(c)
    sr._stock_jobs.clear()                 # registre perdu (restart uvicorn)
    body = c.post(API + "/run", json={}).json()
    assert body["job_id"] == first and body["already_running"] is True
    assert len(h["launches"]) == 1


def test_run_starts_again_once_the_previous_one_finished(tmp_path, monkeypatch):
    c, h = make_client(tmp_path, monkeypatch)
    first = _start(c)
    _finish(tmp_path, first)
    second = c.post(API + "/run", json={}).json()
    assert second["job_id"] != first and second["already_running"] is False
    assert len(h["launches"]) == 2


def test_a_stopped_run_never_blocks_the_next_one(tmp_path, monkeypatch):
    # pid encore vivant (le moteur met du temps à mourir) mais stop.flag posé
    c, h = make_client(tmp_path, monkeypatch)
    first = _start(c)
    assert c.post(API + "/stop/" + first).status_code == 200
    second = c.post(API + "/run", json={}).json()
    assert second["already_running"] is False and second["job_id"] != first


def test_two_simultaneous_launches_never_stack(tmp_path, monkeypatch):
    """Double clic : sans verrou, les deux requêtes passeraient la vérification
    pendant que la première n'a pas encore écrit son pidfile."""
    make_client(tmp_path, monkeypatch)
    launches = []

    def slow_launch(run_dir, job, username):
        launches.append(run_dir)
        time.sleep(0.2)             # pidfile pas encore écrit : la fenêtre du doublon
        sr._pid_path(run_dir).write_text(str(os.getpid()), encoding="utf-8")

    monkeypatch.setattr(sr, "_launch_subprocess", slow_launch)
    barrier = threading.Barrier(2)
    results = []

    def go():
        barrier.wait()
        results.append(sr._start_run("tester", dict(cfgmod.DEFAULTS)))

    threads = [threading.Thread(target=go) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert len(launches) == 1
    assert sorted(r["already_running"] for r in results) == [False, True]
    assert results[0]["job_id"] == results[1]["job_id"]


def test_a_defaults_write_failure_never_blocks_the_scan(tmp_path, monkeypatch):
    c, h = make_client(tmp_path, monkeypatch)

    def disk_full(cfg, path=None):
        raise OSError("disque plein")

    monkeypatch.setattr(cfgmod, "save_defaults", disk_full)
    r = c.post(API + "/run", json={"top_n": 12})
    assert r.status_code == 200, r.text
    assert len(h["launches"]) == 1


def test_a_launch_failure_is_a_500_and_leaves_a_readable_trace(tmp_path, monkeypatch):
    """Le silence est un bug : le run raté dit POURQUOI dans son journal."""
    c, _ = make_client(tmp_path, monkeypatch)

    def boom(run_dir, job, username):
        raise OSError("plus de pid disponible")

    monkeypatch.setattr(sr, "_launch_subprocess", boom)
    r = c.post(API + "/run", json={})
    assert r.status_code == 500
    dirs = list((tmp_path / "runs").iterdir())
    assert len(dirs) == 1
    assert "plus de pid disponible" in (dirs[0] / "run.log").read_text(encoding="utf-8")
    active = c.get(API + "/active").json()
    assert active["job_id"] == dirs[0].name and active["status"] == "error"
    assert sr._stock_jobs == {}


# ================================================================
#  IDENTIFIANTS — 404 AVANT de composer un chemin
# ================================================================

BAD_IDS = ["../etc", "..%2f..%2fetc", "..", "%2e%2e", "abc", "A" * 32,
           "ABCDEF0123456789" * 2, "0" * 31, "0" * 33, "g" * 32]


@pytest.mark.parametrize("bad", BAD_IDS)
def test_malformed_job_id_is_404_everywhere_and_never_composes_a_path(tmp_path, monkeypatch, bad):
    c, h = make_client(tmp_path, monkeypatch)
    composed = []
    real_run_dir = sr._run_dir
    monkeypatch.setattr(sr, "_run_dir",
                        lambda job_id: composed.append(job_id) or real_run_dir(job_id))
    assert c.get(API + "/status/" + bad).status_code == 404
    assert c.post(API + "/stop/" + bad).status_code == 404
    assert c.get(API + "/results/" + bad).status_code == 404
    assert c.get(API + "/download/" + bad).status_code == 404
    assert composed == []
    assert h["signals"] == []


@pytest.mark.parametrize("bad", ["../etc", "abc", "A" * 32, "", "0" * 31, "0" * 33,
                                 "0" * 32 + "\n", " " + "0" * 32])
def test_check_job_id_rejects_anything_but_32_lowercase_hex(bad):
    with pytest.raises(HTTPException) as e:
        sr._check_job_id(bad)
    assert e.value.status_code == 404


def test_check_job_id_accepts_a_uuid4_hex():
    sr._check_job_id(uuid.uuid4().hex)        # ne lève pas


def test_unknown_but_well_formed_job_is_404(tmp_path, monkeypatch):
    c, h = make_client(tmp_path, monkeypatch)
    assert c.get(API + "/status/" + VALID_ID).status_code == 404
    assert c.post(API + "/stop/" + VALID_ID).status_code == 404
    assert c.get(API + "/results/" + VALID_ID).status_code == 404
    assert c.get(API + "/download/" + VALID_ID).status_code == 404
    assert not _rd(tmp_path, VALID_ID).exists()      # /stop ne crée rien
    assert h["signals"] == []


# ================================================================
#  STATUT — reconstruit depuis le disque
# ================================================================

@pytest.mark.parametrize("files,alive,expected", [
    ((), True, "running"),
    (("results.json",), True, "completed"),     # écrit EN DERNIER : fini, même si le process traîne
    (("results.json",), False, "completed"),
    ((), False, "error"),
    (("stop.flag",), True, "stopped"),          # moteur encore en train de mourir
    (("stop.flag",), False, "stopped"),         # sorti en code 3 : JAMAIS « error »
    (("stop.flag", "results.json"), False, "stopped"),
])
def test_status_from_disk_mapping(tmp_path, files, alive, expected):
    rd = tmp_path / ("a" * 32)
    rd.mkdir()
    (rd / "pid").write_text("4242", encoding="utf-8")
    for name in files:
        (rd / name).write_text("{}", encoding="utf-8")
    seen = []
    status = sr._status_from_disk(rd, is_alive=lambda pid: seen.append(pid) or alive)
    assert status == expected
    assert seen in ([], [4242])           # le pid lu sur le disque, s'il a servi


def test_status_a_live_pid_too_old_is_not_the_engine(tmp_path):
    """Garde anti-PID recyclé : sans elle, un pid réattribué par le système
    ferait passer un run mort pour « running » à vie — et /run refuserait
    d'en lancer un autre."""
    rd = tmp_path / ("a" * 32)
    rd.mkdir()
    (rd / "pid").write_text("4242", encoding="utf-8")
    (rd / "meta.json").write_text("{}", encoding="utf-8")
    created = (rd / "meta.json").stat().st_mtime
    alive = lambda pid: True                                     # noqa: E731
    assert sr._status_from_disk(rd, is_alive=alive, now=created + 60) == "running"
    assert sr._status_from_disk(rd, is_alive=alive,
                                now=created + sr.STALE_AFTER_S + 1) == "error"


def test_username_starting_with_a_dash_stays_one_argument():
    cmd = sr._build_cmd("/srv/runs/abc", "-weird")
    assert cmd[-1] == "--user=-weird"


def test_status_follows_the_engine_lifecycle(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    job_id = _start(c)
    url = API + "/status/" + job_id
    assert c.get(url).json()["status"] == "running"
    _kill_pid(tmp_path, job_id)
    assert c.get(url).json()["status"] == "error"         # mort sans résultats
    (_rd(tmp_path, job_id) / "results.json").write_text(json.dumps(RESULTS), encoding="utf-8")
    assert c.get(url).json()["status"] == "completed"


def test_a_stop_is_never_displayed_as_an_error(tmp_path, monkeypatch):
    """Défaut du Bond Scanner : un arrêt finissait affiché « erreur »."""
    c, _ = make_client(tmp_path, monkeypatch)
    job_id = _start(c)
    c.post(API + "/stop/" + job_id)
    _kill_pid(tmp_path, job_id)        # le moteur sort (code 3) SANS results.json
    assert c.get(API + "/status/" + job_id).json()["status"] == "stopped"
    assert c.get(API + "/active").json()["status"] == "stopped"


def test_status_serves_progress_logs_meta_and_files(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    job_id = _start(c)
    rd = _rd(tmp_path, job_id)
    progress = {"phase": "news", "done": 12, "total": 40,
                "counts": {"universe": 1180, "shortlist": 40}, "at": "2026-10-17T07:44:00+00:00"}
    (rd / "progress.json").write_text(json.dumps(progress), encoding="utf-8")
    (rd / "run.log").write_text("\n".join("ligne %d" % i for i in range(100)) + "\n",
                                encoding="utf-8")
    body = c.get(API + "/status/" + job_id).json()
    assert body["job_id"] == job_id and body["status"] == "running"
    assert body["progress"] == progress
    assert body["logs"] == ["ligne %d" % i for i in range(40, 100)]     # les 60 dernières
    assert body["meta"]["job_id"] == job_id and body["meta"]["user"] == "tester"
    assert body["files"] == {"results": False, "excel": None}

    (rd / "results.json").write_text(json.dumps(RESULTS), encoding="utf-8")
    (rd / "b_scan.xlsx").write_bytes(b"PK")
    (rd / "a_scan.xlsx").write_bytes(b"PK")
    assert c.get(API + "/status/" + job_id).json()["files"] == {"results": True,
                                                                "excel": "a_scan.xlsx"}


def test_status_tolerates_half_written_files(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    job_id = _start(c)
    rd = _rd(tmp_path, job_id)
    (rd / "progress.json").write_text('{"phase": "uni', encoding="utf-8")
    (rd / "meta.json").write_text("[1, 2", encoding="utf-8")
    r = c.get(API + "/status/" + job_id)
    assert r.status_code == 200                  # jamais un 500
    body = r.json()
    assert body["progress"] is None and body["meta"] == {} and body["logs"] == []


def test_log_tail_reads_only_the_end_of_a_big_log(tmp_path):
    rd = tmp_path / ("a" * 32)
    rd.mkdir()
    lines = ["%06d %s" % (i, "x" * 80) for i in range(5000)]       # ≈ 440 Ko
    (rd / "run.log").write_text("\n".join(lines) + "\n", encoding="utf-8")
    assert sr._log_tail(rd) == lines[-60:]


def test_log_tail_skips_blank_lines_and_survives_bad_utf8(tmp_path):
    rd = tmp_path / ("a" * 32)
    rd.mkdir()
    (rd / "run.log").write_bytes(b"un\n\n   \ndeux\xff\n")
    assert sr._log_tail(rd) == ["un", "deux\ufffd"]
    assert sr._log_tail(tmp_path / "absent") == []


# ================================================================
#  /stop — drapeau + SIGTERM au groupe, pid lu sur le DISQUE
# ================================================================

def test_stop_writes_the_flag_then_kills_the_process_group(tmp_path, monkeypatch):
    c, h = make_client(tmp_path, monkeypatch)
    job_id = _start(c)
    rd = _rd(tmp_path, job_id)
    (rd / "pid").write_text("424242", encoding="utf-8")
    # après un restart d'uvicorn : plus aucun Popen en mémoire, seul le disque reste
    sr._stock_jobs.clear()
    flag_present = []
    monkeypatch.setattr(sr.os, "killpg", lambda pid, sig: (
        flag_present.append((rd / "stop.flag").is_file()), h["signals"].append((pid, sig))))
    r = c.post(API + "/stop/" + job_id)
    assert r.status_code == 200
    assert r.json() == {"status": "stopped", "job_id": job_id}
    assert (rd / "stop.flag").is_file()
    assert h["signals"] == [(424242, signal.SIGTERM)]
    assert flag_present == [True]          # le drapeau AVANT le signal
    assert c.get(API + "/status/" + job_id).json()["status"] == "stopped"


@pytest.mark.parametrize("exc", [ProcessLookupError, PermissionError, OSError])
def test_stop_tolerates_a_failed_signal(tmp_path, monkeypatch, exc):
    c, _ = make_client(tmp_path, monkeypatch)
    job_id = _start(c)
    (_rd(tmp_path, job_id) / "pid").write_text("424242", encoding="utf-8")

    def refuse(pid, sig):
        raise exc("le moteur a déjà fini")

    monkeypatch.setattr(sr.os, "killpg", refuse)
    r = c.post(API + "/stop/" + job_id)
    assert r.status_code == 200 and r.json()["status"] == "stopped"
    assert (_rd(tmp_path, job_id) / "stop.flag").is_file()


@pytest.mark.parametrize("pid_text", ["0", "1", "-1", "-4242", "", "pas-un-pid",
                                      "OWN_PID", "OWN_PGRP"])
def test_stop_never_signals_init_everyone_or_the_backend_itself(tmp_path, monkeypatch, pid_text):
    """``killpg(0)`` viserait le groupe d'uvicorn, ``killpg(1)`` TOUS les process."""
    c, h = make_client(tmp_path, monkeypatch)
    job_id = _start(c)
    pid_text = {"OWN_PID": str(os.getpid()),
                "OWN_PGRP": str(os.getpgrp())}.get(pid_text, pid_text)
    (_rd(tmp_path, job_id) / "pid").write_text(pid_text, encoding="utf-8")
    r = c.post(API + "/stop/" + job_id)
    assert r.status_code == 200
    assert h["signals"] == []
    assert (_rd(tmp_path, job_id) / "stop.flag").is_file()


def test_stop_without_a_pidfile_still_stops(tmp_path, monkeypatch):
    c, h = make_client(tmp_path, monkeypatch)
    job_id = _start(c)
    (_rd(tmp_path, job_id) / "pid").unlink()
    assert c.post(API + "/stop/" + job_id).json()["status"] == "stopped"
    assert h["signals"] == []
    assert c.get(API + "/status/" + job_id).json()["status"] == "stopped"


class FakeProc(object):
    def __init__(self, returncode=None):
        self.pid = 4242
        self.returncode = returncode
        self.terminated = False

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        return self.returncode

    def terminate(self):
        self.terminated = True


def test_stop_also_terminates_the_in_memory_process_if_alive(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    job_id = _start(c)
    proc = FakeProc(returncode=None)
    sr._stock_jobs[job_id]["process"] = proc
    c.post(API + "/stop/" + job_id)
    assert proc.terminated is True
    assert sr._stock_jobs[job_id]["status"] == "stopped"


def test_stop_leaves_an_exited_process_alone(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    job_id = _start(c)
    proc = FakeProc(returncode=0)
    sr._stock_jobs[job_id]["process"] = proc
    c.post(API + "/stop/" + job_id)
    assert proc.terminated is False


# ================================================================
#  /active
# ================================================================

def test_active_without_any_run(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert c.get(API + "/active").json() == {"found": False}


def test_active_returns_the_newest_run_whatever_its_status(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    old = _start(c)
    _finish(tmp_path, old)
    _age(_rd(tmp_path, old), 3600)
    a = c.get(API + "/active").json()
    # un run terminé reste servi (reconnexion) ; l'UI ne compte que "running"
    assert a["found"] is True and a["job_id"] == old and a["status"] == "completed"

    new = _start(c)
    progress = {"phase": "universe", "done": 1, "total": 5, "counts": {}, "at": "x"}
    (_rd(tmp_path, new) / "progress.json").write_text(json.dumps(progress), encoding="utf-8")
    a = c.get(API + "/active").json()
    assert a["found"] is True and a["job_id"] == new and a["status"] == "running"
    assert a["progress"] == progress
    assert a["meta"]["job_id"] == new
    assert set(a) == {"found", "job_id", "status", "progress", "meta"}


def test_active_survives_a_restart_of_the_backend(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    job_id = _start(c)
    sr._stock_jobs.clear()
    a = c.get(API + "/active").json()
    assert a["found"] is True and a["job_id"] == job_id and a["status"] == "running"


def test_a_stop_flag_on_an_old_run_does_not_make_it_the_newest(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    old = _start(c)
    _finish(tmp_path, old)
    _age(_rd(tmp_path, old), 3600)
    new = _start(c)
    (_rd(tmp_path, old) / "stop.flag").write_text("1", encoding="utf-8")   # touche le dossier
    assert c.get(API + "/active").json()["job_id"] == new


def test_active_ignores_stray_entries(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    (tmp_path / "runs" / "pas-un-run").mkdir(parents=True)
    (tmp_path / "runs" / ("a" * 32 + ".txt")).write_text("x", encoding="utf-8")
    assert c.get(API + "/active").json() == {"found": False}


# ================================================================
#  /latest
# ================================================================

def test_latest_without_results_is_clean(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert c.get(API + "/latest").json() == {"job_id": None, "status": None,
                                            "ran_at": None, "results": None}
    _start(c)                                    # un scan en cours, rien d'écrit
    assert c.get(API + "/latest").json()["job_id"] is None


def test_latest_skips_runs_without_readable_results(tmp_path, monkeypatch):
    """Un scan en cours (ou un results.json à moitié écrit) ne doit pas vider
    la page des résultats précédents."""
    c, _ = make_client(tmp_path, monkeypatch)
    old = _start(c)
    _finish(tmp_path, old)
    _age(_rd(tmp_path, old), 7200)
    mid = _start(c)
    _kill_pid(tmp_path, mid)
    (_rd(tmp_path, mid) / "results.json").write_text('{"version": 1, "rows": [', encoding="utf-8")
    _age(_rd(tmp_path, mid), 3600)
    new = _start(c)                              # en cours, sans results.json
    assert new not in (old, mid)
    body = c.get(API + "/latest").json()
    assert body["job_id"] == old
    assert body["status"] == "completed"
    assert body["results"] == RESULTS
    meta = json.loads((_rd(tmp_path, old) / "meta.json").read_text(encoding="utf-8"))
    assert body["ran_at"] == meta["created_at"]


def test_latest_ran_at_falls_back_to_the_folder_date(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    job_id = _start(c)
    _finish(tmp_path, job_id)
    (_rd(tmp_path, job_id) / "meta.json").unlink()
    ran_at = c.get(API + "/latest").json()["ran_at"]
    assert re.match(r"\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\Z", ran_at)


# ================================================================
#  /results et /download
# ================================================================

def test_results_404_until_written_then_served(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    job_id = _start(c)
    url = API + "/results/" + job_id
    assert c.get(url).status_code == 404
    (_rd(tmp_path, job_id) / "results.json").write_text(json.dumps(RESULTS), encoding="utf-8")
    r = c.get(url)
    assert r.status_code == 200 and r.json() == RESULTS
    (_rd(tmp_path, job_id) / "results.json").write_text('{"rows": [', encoding="utf-8")
    assert c.get(url).status_code == 404          # illisible -> 404, jamais un 500


def test_download_404_without_a_workbook(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    job_id = _start(c)
    assert c.get(API + "/download/" + job_id).status_code == 404


def test_download_serves_the_first_workbook_as_xlsx(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    job_id = _start(c)
    rd = _rd(tmp_path, job_id)
    (rd / "stock_scanner_2026-10-17.xlsx").write_bytes(b"PK\x03\x04scan")
    (rd / "z_autre.xlsx").write_bytes(b"PK")
    (rd / ".stock_scanner.xlsx.tmp.xlsx").write_bytes(b"moitie")   # temporaire : ignoré
    (rd / "~$stock_scanner.xlsx").write_bytes(b"verrou")           # verrou Excel : ignoré
    r = c.get(API + "/download/" + job_id)
    assert r.status_code == 200
    assert r.headers["content-type"] == XLSX
    assert r.headers["content-disposition"] == 'attachment; filename="stock_scanner_2026-10-17.xlsx"'
    assert r.content == b"PK\x03\x04scan"


def test_download_of_a_non_ascii_name_never_crashes(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    job_id = _start(c)
    (_rd(tmp_path, job_id) / "Candidats à étudier.xlsx").write_bytes(b"PK")
    r = c.get(API + "/download/" + job_id)
    assert r.status_code == 200
    assert r.headers["content-disposition"].startswith("attachment; filename*=utf-8''")


def test_download_never_follows_a_symlinked_workbook(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    job_id = _start(c)
    secret = tmp_path / "secret.txt"
    secret.write_text("ne doit jamais sortir", encoding="utf-8")
    os.symlink(str(secret), str(_rd(tmp_path, job_id) / "a.xlsx"))
    assert c.get(API + "/download/" + job_id).status_code == 404


# ================================================================
#  PURGE — 30 jours, jamais le plus récent ni un run vivant
# ================================================================

def test_purge_removes_old_dead_runs_and_keeps_recent_ones(tmp_path, monkeypatch):
    make_client(tmp_path, monkeypatch)
    old = _seed_run(tmp_path, "a" * 32, age_days=60, pid=DEAD_PID)
    recent = _seed_run(tmp_path, "b" * 32, age_days=1)
    purged = sr.purge_old_runs(max_age_days=30)
    assert purged == [old.name]
    assert not old.is_dir() and recent.is_dir()


def test_purge_keeps_the_newest_run_even_if_old(tmp_path, monkeypatch):
    # sinon /latest se viderait après une longue période sans scan
    make_client(tmp_path, monkeypatch)
    older = _seed_run(tmp_path, "a" * 32, age_days=90)
    newer = _seed_run(tmp_path, "b" * 32, age_days=60)
    sr.purge_old_runs(max_age_days=30)
    assert not older.is_dir()
    assert newer.is_dir()


def test_purge_never_touches_a_live_run(tmp_path, monkeypatch):
    make_client(tmp_path, monkeypatch)
    dead = _seed_run(tmp_path, "a" * 32, age_days=100, pid=DEAD_PID)
    live = _seed_run(tmp_path, "b" * 32, age_days=90, pid=os.getpid())   # pid vivant
    newest = _seed_run(tmp_path, "c" * 32, age_days=60)
    purged = sr.purge_old_runs(max_age_days=30)
    assert purged == [dead.name]
    assert live.is_dir() and newest.is_dir()


def test_purge_forgets_the_purged_jobs(tmp_path, monkeypatch):
    make_client(tmp_path, monkeypatch)
    old = _seed_run(tmp_path, "a" * 32, age_days=60)
    _seed_run(tmp_path, "b" * 32, age_days=1)
    sr._stock_jobs[old.name] = {"job_id": old.name, "process": None}
    sr.purge_old_runs(max_age_days=30)
    assert old.name not in sr._stock_jobs


def test_purge_without_runs_dir_is_noop(tmp_path, monkeypatch):
    monkeypatch.setattr(sr, "RUNS_DIR", tmp_path / "absent")
    assert sr.purge_old_runs() == []


def test_run_purges_old_runs_before_creating_the_new_one(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    oldest = _seed_run(tmp_path, "a" * 32, age_days=60, pid=DEAD_PID)
    previous = _seed_run(tmp_path, "b" * 32, age_days=45, pid=DEAD_PID)
    job_id = _start(c)
    assert not oldest.is_dir()
    # le plus récent AVANT ce scan reste : /latest ne se vide pas pendant qu'il tourne
    assert previous.is_dir()
    assert _rd(tmp_path, job_id).is_dir()
    assert c.get(API + "/latest").json()["job_id"] == previous.name


# ================================================================
#  LANCEMENT RÉEL — contrat du moteur, détachement, run.log, faucheur
# ================================================================

def test_build_cmd_matches_the_engine_contract():
    assert sr._build_cmd("/srv/runs/abc", "massii") == [
        sys.executable, "-m", "backend.bots.stockscan",
        "--out", "/srv/runs/abc", "--config", "/srv/runs/abc/config.json",
        "--user=massii"]


class BlockingProc(object):
    """Double de Popen dont ``wait()`` bloque jusqu'à ``release``."""

    def __init__(self, pid=int(DEAD_PID)):
        self.pid = pid
        self.returncode = None
        self.release = threading.Event()
        self.waited = threading.Event()

    def wait(self, timeout=None):
        self.release.wait(5)
        self.returncode = 0
        self.waited.set()
        return 0

    def poll(self):
        return self.returncode

    def terminate(self):
        pass


def test_launch_detaches_and_writes_the_output_straight_into_run_log(tmp_path, monkeypatch):
    """start_new_session=True est OBLIGATOIRE (l'auto-deploy redémarre uvicorn
    toutes les minutes), et la sortie va dans un FICHIER, pas dans un pipe dont
    le lecteur mourrait avec uvicorn (BrokenPipeError au print suivant)."""
    monkeypatch.setattr(sr, "RUNS_DIR", tmp_path / "runs")
    captured = {}
    proc = BlockingProc()

    def fake_popen(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["kwargs"] = kwargs
        # le « moteur » écrit dans le descripteur hérité, comme un vrai print
        kwargs["stdout"].write(b"[moteur] phase universe\n")
        kwargs["stdout"].flush()
        return proc

    monkeypatch.setattr(sr.subprocess, "Popen", fake_popen)
    rd = tmp_path / "runs" / ("a" * 32)
    rd.mkdir(parents=True)
    job = {"job_id": "a" * 32, "status": "starting", "process": None}
    try:
        sr._launch_subprocess(str(rd), job, "tester")
        kw = captured["kwargs"]
        assert kw["start_new_session"] is True
        assert kw["cwd"] == str(sr._project_root)
        assert (Path(kw["cwd"]) / "backend" / "main.py").is_file()   # racine du projet
        assert captured["cmd"][0] == sys.executable
        assert captured["cmd"][1:] == [
            "-m", "backend.bots.stockscan", "--out", str(rd),
            "--config", str(rd / "config.json"), "--user=tester"]
        out = kw["stdout"]
        assert out is not subprocess.PIPE and isinstance(out, io.IOBase)
        assert os.path.samefile(out.name, str(rd / "run.log"))
        assert out.closed                # la copie du parent est refermée après Popen
        assert kw["stderr"] == subprocess.STDOUT
        assert kw["stdin"] == subprocess.DEVNULL
        assert kw["env"]["PYTHONUNBUFFERED"] == "1"
        assert "[moteur] phase universe" in (rd / "run.log").read_text(encoding="utf-8")
        assert (rd / "pid").read_text(encoding="utf-8") == str(proc.pid)
        assert job["process"] is proc and job["status"] == "running"
    finally:
        proc.release.set()
    # le fil faucheur récolte le moteur (wait) puis lâche la référence
    assert proc.waited.wait(5)
    deadline = time.time() + 5
    while job.get("process") is not None and time.time() < deadline:
        time.sleep(0.01)
    assert job["process"] is None and job["returncode"] == 0
    assert job["status"] == "error"          # sorti sans results.json


def _real_launch(tmp_path, monkeypatch, code):
    """Lance un VRAI process (moteur factice d'une ligne) par le vrai Popen."""
    monkeypatch.setattr(sr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(sr, "_build_cmd",
                        lambda run_dir, username: [sys.executable, "-c", code, str(run_dir)])
    rd = tmp_path / "runs" / uuid.uuid4().hex
    rd.mkdir(parents=True)
    job = {"job_id": rd.name, "status": "starting", "process": None}
    sr._launch_subprocess(str(rd), job, "tester")
    return rd


def _wait_for_status(rd, expected, timeout=15.0):
    deadline = time.time() + timeout
    status = sr._status_from_disk(rd)
    while status != expected and time.time() < deadline:
        time.sleep(0.05)
        status = sr._status_from_disk(rd)
    return status


def test_a_real_engine_that_exits_is_reaped_and_never_stays_running(tmp_path, monkeypatch):
    """Sans fil faucheur, le moteur fini resterait ZOMBIE : ``os.kill(pid, 0)``
    réussit sur un zombie, et le run serait « running » à vie."""
    rd = _real_launch(tmp_path, monkeypatch, "print('moteur factice: fin sans resultats')")
    assert _wait_for_status(rd, "error") == "error"
    assert "moteur factice: fin sans resultats" in (rd / "run.log").read_text(encoding="utf-8")


def test_a_real_engine_that_writes_results_reads_completed(tmp_path, monkeypatch):
    code = ("import json, os, sys\n"
            "with open(os.path.join(sys.argv[1], 'results.json'), 'w') as f:\n"
            "    json.dump({'version': 1, 'rows': []}, f)\n")
    rd = _real_launch(tmp_path, monkeypatch, code)
    assert _wait_for_status(rd, "completed") == "completed"
