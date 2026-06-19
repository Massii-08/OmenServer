"""Router AI Harvester (P1) — lance le moteur déterministe en subprocess détaché
(mirroir du Bond Scanner) + API privée gated par X-Feed-Key.

Admin-only (gate backend strict is_admin) sauf /data qui est gated par la clé
de feed par-harvest (header X-Feed-Key) — c'est l'API privée consommable par un
client externe."""
import csv
import errno
import io
import json
import logging
import os
import secrets
import subprocess
import sys
import threading
import uuid
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from backend.auth.models import User
from backend.auth.utils import get_current_user
from backend.bots.harvester.config import HarvestConfig
from backend.bots.harvester.llm import _claude
from backend.bots.harvester.policy import PII_FIELDS
from backend.bots.harvester.recipe import Recipe
from backend.bots.harvester.setup import build_setup
from backend.bots.harvester.store import Store

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/bots/harvester", tags=["AI Harvester"])

_project_root = Path(__file__).resolve().parent.parent.parent
HARVESTER_RUNS_DIR = _project_root / "data" / "harvester_runs"

# job en mémoire (comme le scanner) — perdu au reload, mais le store.json sur
# disque reste la source de vérité (le subprocess détaché continue).
_harvester_jobs = {}  # type: Dict[str, Dict[str, Any]]


def _require_admin(user) -> None:
    if not getattr(user, "is_admin", False):
        raise HTTPException(status_code=403, detail="Admin uniquement")


class RunRequest(BaseModel):
    url: str
    recipe: Dict[str, Any]
    plan: Dict[str, Any] = {}
    pacing: Dict[str, Any] = {}


class SetupRequest(BaseModel):
    url: str
    instructions: str = ""


def _run_dir(job_id: str) -> Path:
    return Path(HARVESTER_RUNS_DIR) / job_id


# --- A : résilience — le suivi de job survit au restart uvicorn ------------

def _pid_path(run_dir) -> Path:
    return Path(run_dir) / "pid"


def _read_pid(run_dir):
    try:
        return int(_pid_path(run_dir).read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None


def _pid_alive(pid) -> bool:
    """True si le PID tourne. ``os.kill(pid, 0)`` : ESRCH=mort, EPERM=vivant
    (autre user). Le subprocess détaché survit au restart uvicorn -> on le
    redétecte ainsi plutôt que de le croire mort."""
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
    except OSError as e:
        return e.errno == errno.EPERM
    except (TypeError, ValueError):
        return False
    return True


def _status_from_disk(run_dir, is_alive=_pid_alive) -> str:
    """Statut reconstruit depuis le disque. stop.flag prime (arrêt collant) ;
    sinon pid vivant -> running ; sinon -> completed (fini de lui-même)."""
    if (Path(run_dir) / "stop.flag").is_file():
        return "stopped"
    pid = _read_pid(run_dir)
    if pid and is_alive(pid):
        return "running"
    return "completed"


def _read_log_tail(run_dir, limit: int = 200):
    p = Path(run_dir) / "run.log"
    if not p.is_file():
        return []
    try:
        return p.read_text(encoding="utf-8", errors="replace").splitlines()[-limit:]
    except OSError:
        return []


def _job_from_disk(run_dir, job_id, is_alive=_pid_alive):
    """Reconstruit un job depuis config.json + store.json (None si pas de
    config -> dossier incomplet)."""
    if not (Path(run_dir) / "config.json").is_file():
        return None
    cfg = HarvestConfig.load(str(run_dir))
    store_path = Path(run_dir) / "store.json"
    counts = (Store.load(str(store_path)).counts() if store_path.is_file()
              else {"todo": 0, "done": 0, "records": 0, "errors": 0})
    return {
        "job_id": job_id,
        "status": _status_from_disk(run_dir, is_alive),
        "logs": _read_log_tail(run_dir),
        "process": None,
        "counts": counts,
        "feed_key": cfg.feed_key,
        "url": cfg.url,
        "user": "?",
    }


def rehydrate_jobs(is_alive=_pid_alive) -> None:
    """Repeuple ``_harvester_jobs`` depuis le disque (après restart uvicorn /
    auto-deploy) SANS écraser un job déjà suivi en mémoire (handle vivant)."""
    base = Path(HARVESTER_RUNS_DIR)
    if not base.is_dir():
        return
    for d in sorted(base.iterdir()):
        if not d.is_dir() or d.name in _harvester_jobs:
            continue
        try:
            job = _job_from_disk(str(d), d.name, is_alive)
        except Exception:  # noqa: BLE001 — un dossier corrompu ne tue pas le boot
            job = None
        if job:
            _harvester_jobs[d.name] = job


def _launch_subprocess(run_dir: str, job: Dict[str, Any]) -> None:
    """Lance `python -m backend.bots.harvester <run_dir>` détaché + thread logs."""
    subprocess_env = {**os.environ, "PYTHONUNBUFFERED": "1"}
    cmd = [sys.executable, "-m", "backend.bots.harvester", run_dir]
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        cwd=str(_project_root),
        env=subprocess_env,
        # détache dans sa propre session pour survivre à un reload uvicorn
        # (auto-deploy git pull) — comme le Bond Scanner.
        start_new_session=True,
    )
    job["process"] = proc
    job["status"] = "running"
    # pidfile : permet de redétecter le run vivant après un restart uvicorn (A)
    try:
        _pid_path(run_dir).write_text(str(proc.pid), encoding="utf-8")
    except OSError:
        pass

    def _capture(p, j):
        # logs persistés sur disque -> survivent au restart uvicorn (A)
        try:
            logf = open(os.path.join(run_dir, "run.log"), "a", encoding="utf-8")
        except OSError:
            logf = None
        try:
            for line in p.stdout:
                stripped = line.rstrip()
                if not stripped:
                    continue
                j["logs"].append(stripped)
                if len(j["logs"]) > 500:
                    j["logs"] = j["logs"][-500:]
                if logf:
                    try:
                        logf.write(stripped + "\n")
                        logf.flush()
                    except OSError:
                        pass
                try:
                    msg = json.loads(stripped)
                    if msg.get("type") in ("progress", "done") and "counts" in msg:
                        j["counts"] = msg["counts"]
                except ValueError:
                    pass
        except Exception:
            pass
        finally:
            if logf:
                try:
                    logf.close()
                except OSError:
                    pass
        p.wait()
        if j["status"] == "running":
            j["status"] = "completed" if p.returncode == 0 else "error"
        j["process"] = None
        logger.info("[Harvester] Job terminé: %s", j["status"])

    t = threading.Thread(target=_capture, args=(proc, job), daemon=True)
    t.start()


def _fetch_full(url):
    """Un GET httpx unique pour l'échantillon de setup → (status, headers, text)."""
    with httpx.Client(timeout=20.0, follow_redirects=True,
                      headers={"User-Agent": "OmenHarvester/0.1 (+https://omenserver.org)"}) as client:
        resp = client.get(url)
        return resp.status_code, dict(resp.headers), resp.text


def _run_setup(url, instructions):
    """Orchestre le setup avec les vraies dépendances (Claude CLI + httpx)."""
    return build_setup(url, instructions, fetch_full=_fetch_full, claude=_claude)


@router.post("/run")
def run_harvester(data: RunRequest, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)

    # n'accepte que http(s) (rejette file://, gopher://, etc.)
    if urlparse(data.url).scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="URL doit être http(s)")

    # no-PII gate sur les NOMS de champ de la recette (fail fast au lancement)
    try:
        recipe = Recipe.from_dict(data.recipe)
    except (KeyError, TypeError):
        raise HTTPException(status_code=400, detail="Recette invalide")
    for name in recipe.field_names():
        if name.lower() in PII_FIELDS:
            raise HTTPException(
                status_code=400,
                detail="Champ PII interdit dans la recette: '{0}'".format(name),
            )

    job_id = uuid.uuid4().hex
    feed_key = secrets.token_urlsafe(24)
    run_dir = _run_dir(job_id)
    run_dir.mkdir(parents=True, exist_ok=True)

    cfg = HarvestConfig(
        url=data.url, recipe=recipe, plan=data.plan,
        pacing=data.pacing or {"min_interval_s": 1.5, "jitter": [0.5, 2.0]},
        feed_key=feed_key,
    )
    cfg.save(str(run_dir))
    # seed la frontière avec l'URL de départ
    store = Store(str(run_dir / "store.json"))
    store.add_todo(data.url)
    store.save()

    job = {
        "job_id": job_id,
        "status": "starting",
        "logs": [],
        "process": None,
        "counts": {"todo": 1, "done": 0, "records": 0, "errors": 0},
        "feed_key": feed_key,
        "url": data.url,
        "user": getattr(current_user, "username", "?"),
    }
    _harvester_jobs[job_id] = job
    _launch_subprocess(str(run_dir), job)

    return {"job_id": job_id, "feed_key": feed_key}


@router.post("/setup")
def setup_harvester(data: SetupRequest, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    if urlparse(data.url).scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="URL doit être http(s)")
    try:
        preview = _run_setup(data.url, data.instructions)
    except Exception as e:  # LLM/fetch failure → surfaced to the operator
        logger.warning("[Harvester] setup failed: %r", e)
        raise HTTPException(status_code=502, detail="Setup IA échoué: {0}".format(str(e)[:200]))
    # no-PII gate sur la recette générée par Claude
    try:
        recipe = Recipe.from_dict(preview["recipe"])
    except (KeyError, TypeError):
        raise HTTPException(status_code=502, detail="Recette générée invalide")
    for name in recipe.field_names():
        if name.lower() in PII_FIELDS:
            raise HTTPException(
                status_code=400,
                detail="La recette générée contient un champ PII: '{0}'".format(name),
            )
    return preview


def _disk_counts(job_id: str) -> Optional[Dict[str, int]]:
    store_path = _run_dir(job_id) / "store.json"
    if not store_path.is_file():
        return None
    return Store.load(str(store_path)).counts()


@router.get("/status/{job_id}")
def harvester_status(job_id: str, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    job = _harvester_jobs.get(job_id)
    if not job:
        # restart uvicorn -> reconstruit depuis le disque (A)
        job = _job_from_disk(str(_run_dir(job_id)), job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job introuvable")
        _harvester_jobs[job_id] = job
    # pas de handle de process vivant -> recalcule le statut depuis le disque
    if job.get("process") is None:
        job["status"] = _status_from_disk(str(_run_dir(job_id)))
    counts = _disk_counts(job_id) or job["counts"]
    return {
        "job_id": job_id,
        "status": job["status"],
        "counts": counts,
        "logs": job["logs"][-50:] or _read_log_tail(str(_run_dir(job_id)), 50),
        "feed_key": job["feed_key"],
        "url": job["url"],
    }


@router.get("/active")
def harvester_active(current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    rehydrate_jobs()  # restart uvicorn -> redécouvre les runs détachés vivants (A)
    for job in reversed(list(_harvester_jobs.values())):
        if job.get("process") is not None:
            status = job["status"]
        else:
            status = _status_from_disk(str(_run_dir(job["job_id"])))
        if status in ("starting", "running"):
            return {"job_id": job["job_id"], "status": status,
                    "counts": _disk_counts(job["job_id"]) or job["counts"],
                    "url": job["url"]}
    return None


@router.post("/stop/{job_id}")
def harvester_stop(job_id: str, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    job = _harvester_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job introuvable")
    # arrêt propre : pose le flag (le subprocess le lit entre deux URL)
    try:
        (_run_dir(job_id) / "stop.flag").write_text("1", encoding="utf-8")
    except OSError:
        pass
    proc = job.get("process")
    if proc and proc.poll() is None:
        proc.terminate()
    job["status"] = "stopped"
    job["process"] = None
    return {"status": "stopped", "job_id": job_id}


def _csv_safe(value: Any) -> str:
    """Neutralise l'injection de formule CSV (Excel/Sheets) : préfixe d'une
    apostrophe toute valeur commençant par = + - @ tab ou CR."""
    s = "" if value is None else str(value)
    if s and s[0] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + s
    return s


@router.get("/data/{job_id}")
def harvester_data(job_id: str, format: str = "json",
                   x_feed_key: Optional[str] = Header(default=None)):
    """API privée : renvoie les records accumulés. Gated par X-Feed-Key
    (pas par login → consommable par un client externe)."""
    run_dir = _run_dir(job_id)
    cfg_path = run_dir / "config.json"
    if not cfg_path.is_file():
        raise HTTPException(status_code=404, detail="Harvest introuvable")
    cfg = HarvestConfig.load(str(run_dir))
    if not x_feed_key or not secrets.compare_digest(x_feed_key, cfg.feed_key):
        raise HTTPException(status_code=401, detail="Clé de feed invalide")

    store_path = run_dir / "store.json"
    records = Store.load(str(store_path)).records() if store_path.is_file() else []

    if format == "csv":
        cols = cfg.recipe.field_names()
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
        writer.writeheader()
        for rec in records:
            writer.writerow({k: _csv_safe(v) for k, v in rec.items()})
        return PlainTextResponse(buf.getvalue(), media_type="text/csv")

    return {"job_id": job_id, "count": len(records), "records": records}


# Au chargement du module (= démarrage uvicorn, donc après chaque auto-deploy),
# repeuple le registre depuis le disque pour ne pas perdre le suivi des runs
# détachés encore vivants (A).
try:
    rehydrate_jobs()
except Exception:  # noqa: BLE001 — jamais bloquer le boot sur un dossier corrompu
    pass
