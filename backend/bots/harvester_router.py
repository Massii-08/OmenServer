"""Router AI Harvester (P1) — lance le moteur déterministe en subprocess détaché
(mirroir du Bond Scanner) + API privée gated par X-Feed-Key.

Admin-only (gate backend strict is_admin) sauf /data qui est gated par la clé
de feed par-harvest (header X-Feed-Key) — c'est l'API privée consommable par un
client externe."""
import csv
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

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from backend.auth.models import User
from backend.auth.utils import get_current_user
from backend.bots.harvester.config import HarvestConfig
from backend.bots.harvester.policy import PII_FIELDS
from backend.bots.harvester.recipe import Recipe
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


def _run_dir(job_id: str) -> Path:
    return Path(HARVESTER_RUNS_DIR) / job_id


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

    def _capture(p, j):
        try:
            for line in p.stdout:
                stripped = line.rstrip()
                if not stripped:
                    continue
                j["logs"].append(stripped)
                if len(j["logs"]) > 500:
                    j["logs"] = j["logs"][-500:]
                try:
                    msg = json.loads(stripped)
                    if msg.get("type") in ("progress", "done") and "counts" in msg:
                        j["counts"] = msg["counts"]
                except ValueError:
                    pass
        except Exception:
            pass
        p.wait()
        if j["status"] == "running":
            j["status"] = "completed" if p.returncode == 0 else "error"
        j["process"] = None
        logger.info("[Harvester] Job terminé: %s", j["status"])

    t = threading.Thread(target=_capture, args=(proc, job), daemon=True)
    t.start()


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
        raise HTTPException(status_code=404, detail="Job introuvable")
    counts = _disk_counts(job_id) or job["counts"]
    return {
        "job_id": job_id,
        "status": job["status"],
        "counts": counts,
        "logs": job["logs"][-50:],
        "feed_key": job["feed_key"],
        "url": job["url"],
    }


@router.get("/active")
def harvester_active(current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    for job in reversed(list(_harvester_jobs.values())):
        if job["status"] in ("starting", "running"):
            return {"job_id": job["job_id"], "status": job["status"],
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
