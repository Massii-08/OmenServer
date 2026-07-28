"""Router Market Pulse — 3ᵉ bot de la suite finance.

Il lance le moteur `market-pulse/main.py` en subprocess DÉTACHÉ et sert les
fichiers qu'il produit. Le patron est celui du AI Harvester, pas celui du Bond
Scanner : **le disque est la source de vérité**, pas le registre mémoire.
L'auto-deploy redémarre uvicorn toutes les minutes ; un run en cours doit
survivre à ce redémarrage, et l'UI doit pouvoir se reconnecter après.

Accès : lecture et lancement pour `admin` et `money` (l'utilisateur final,
l'investisseur, a un compte `money` — c'est la convention des deux autres bots
finance). La PLANIFICATION, elle, est admin strict : c'est une configuration
de la machine, pas une consultation.
"""
import json
import logging
import os
import re
import subprocess
import sys
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel

from backend.auth.models import User
from backend.auth.permissions import require_role
from backend.bots import market_schedule as ms

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/bots/market", tags=["Market Pulse"])

_project_root = Path(__file__).resolve().parent.parent.parent
MARKET_PULSE_DIR = _project_root / "market-pulse"
MARKET_RUNS_DIR = _project_root / "data" / "market_pulse" / "runs"

RUN_RETENTION_DAYS = 30

# Registre mémoire : pratique, mais JAMAIS la vérité (un restart uvicorn le
# vide alors que le subprocess détaché, lui, tourne toujours).
_market_jobs = {}  # type: Dict[str, Dict[str, Any]]

_JOB_ID_RE = re.compile(r"\A[0-9a-f]{32}\Z")


def _check_job_id(job_id: str) -> None:
    """Un job_id qui n'est pas 32 hexa ne compose JAMAIS un chemin.

    404 et non 400 : on ne confirme même pas qu'un identifiant mal formé
    aurait pu exister.
    """
    if not _JOB_ID_RE.match(job_id or ""):
        raise HTTPException(status_code=404, detail="Job introuvable")


def _run_dir(job_id: str) -> Path:
    return Path(MARKET_RUNS_DIR) / job_id


def _pid_path(run_dir) -> Path:
    return Path(run_dir) / "pid"


def _read_pid(run_dir) -> Optional[int]:
    try:
        return int(_pid_path(run_dir).read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None


def _pid_alive(pid: Optional[int]) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _status_from_disk(run_dir, is_alive=_pid_alive) -> str:
    """Statut reconstruit depuis le disque (survit à un restart uvicorn)."""
    run_dir = Path(run_dir)
    if (run_dir / "stop.flag").is_file():
        return "stopped"
    if is_alive(_read_pid(run_dir)):
        return "running"
    # Process mort : le snapshot fait foi. Pas de snapshot = le moteur n'a
    # rien pu produire, c'est un échec — le dire plutôt que d'afficher
    # « terminé » sur un run vide.
    return "completed" if (run_dir / "snapshot.json").is_file() else "error"


def _excel_name(run_dir) -> Optional[str]:
    try:
        for entry in sorted(Path(run_dir).glob("*.xlsx")):
            return entry.name
    except OSError:
        pass
    return None


def _files_of(run_dir) -> Dict[str, Any]:
    run_dir = Path(run_dir)
    return {
        "snapshot": (run_dir / "snapshot.json").is_file(),
        "history": (run_dir / "history.json").is_file(),
        "report": (run_dir / "report.txt").is_file(),
        "news": (run_dir / "news.json").is_file(),
        "excel": _excel_name(run_dir),
    }


def _read_json(path) -> Optional[Any]:
    """JSON du disque, ou None. Un fichier à moitié écrit (run tué en plein
    vol) ne doit jamais rendre un 500 à l'utilisateur."""
    try:
        with open(str(path), "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _read_text(path) -> Optional[str]:
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def _run_dirs() -> List[Path]:
    """Dossiers de run, du plus récent au plus ancien."""
    base = Path(MARKET_RUNS_DIR)
    try:
        entries = [d for d in base.iterdir() if d.is_dir() and _JOB_ID_RE.match(d.name)]
    except OSError:
        return []
    return sorted(entries, key=lambda d: d.stat().st_mtime, reverse=True)


def _meta(run_dir) -> Dict[str, Any]:
    return _read_json(Path(run_dir) / "meta.json") or {}


# ================================================================
#  LANCEMENT
# ================================================================

DEFAULT_OPTS = {"stats": True, "report": True, "excel": True, "news": True}


def _build_cmd(run_dir: str, opts: Dict[str, Any]) -> List[str]:
    """Ligne de commande du moteur — contrat de `market-pulse/main.py`."""
    cmd = [sys.executable, "main.py", "--out", str(run_dir)]
    for flag in ("stats", "news", "report", "excel"):
        if opts.get(flag):
            cmd.append("--" + flag)
    return cmd


def _launch_subprocess(run_dir: str, job: Dict[str, Any],
                       opts: Optional[Dict[str, Any]] = None) -> None:
    """Lance le moteur détaché + un thread qui persiste ses logs."""
    opts = dict(DEFAULT_OPTS, **(opts or {}))
    env = dict(os.environ, PYTHONUNBUFFERED="1")
    proc = subprocess.Popen(
        _build_cmd(run_dir, opts),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        cwd=str(MARKET_PULSE_DIR),
        env=env,
        # OBLIGATOIRE : sans session propre, le restart uvicorn de
        # l'auto-deploy (toutes les minutes) tuerait le run en cours.
        start_new_session=True,
    )
    job["process"] = proc
    job["status"] = "running"
    try:
        _pid_path(run_dir).write_text(str(proc.pid), encoding="utf-8")
    except OSError:
        pass

    def _capture(p, j):
        log_path = Path(run_dir) / "run.log"
        try:
            with open(str(log_path), "a", encoding="utf-8") as logf:
                for line in p.stdout:
                    line = line.rstrip()
                    if not line:
                        continue
                    j["logs"].append(line)
                    if len(j["logs"]) > 300:
                        j["logs"] = j["logs"][-300:]
                    logf.write(line + "\n")
                    logf.flush()
        except Exception:
            pass
        try:
            p.wait()
        except Exception:
            pass
        if j.get("status") == "running":
            j["status"] = "completed" if p.returncode == 0 else "error"

    threading.Thread(target=_capture, args=(proc, job), daemon=True).start()


def _live_job_id() -> Optional[str]:
    """Identifiant du run vivant, s'il y en a un (lu sur le DISQUE)."""
    for d in _run_dirs():
        if _status_from_disk(d) == "running":
            return d.name
    return None


def _start_run(username: str, opts: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Démarre un run, ou rend celui qui tourne déjà.

    On vérifie AVANT de créer le dossier : empiler deux relevés simultanés
    doublerait les appels réseau chez Yahoo pour rien.
    """
    live = _live_job_id()
    if live:
        return {"job_id": live, "already_running": True}

    job_id = uuid.uuid4().hex
    run_dir = _run_dir(job_id)
    run_dir.mkdir(parents=True, exist_ok=True)

    now = datetime.now()
    meta = {
        "job_id": job_id,
        "user": username,
        "created_at": now.isoformat(timespec="seconds"),
        # Date LOCALE : c'est elle que lit le rattrapage matinal.
        "date": now.strftime("%Y-%m-%d"),
    }
    try:
        (run_dir / "meta.json").write_text(
            json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass

    job = {"job_id": job_id, "status": "starting", "logs": [], "process": None}
    _market_jobs[job_id] = job
    _launch_subprocess(str(run_dir), job, opts)
    return {"job_id": job_id, "already_running": False}


# ================================================================
#  PLANIFICATION — rattrapage
# ================================================================

def last_run_date() -> Optional[str]:
    """Date locale du run le plus récent (pour décider d'un rattrapage)."""
    for d in _run_dirs():
        day = _meta(d).get("date")
        if day:
            return str(day)
    return None


def run_scheduled() -> Optional[str]:
    """Cible du job APScheduler. Rend l'id du run (ou de celui en cours)."""
    result = _start_run("scheduler")
    logger.info("[Market Pulse] run planifié %s (déjà en cours: %s)",
                result["job_id"], result["already_running"])
    return result["job_id"]


def catch_up_if_needed(now: Optional[datetime] = None) -> Optional[str]:
    """Rattrapage au démarrage du backend.

    Sans jobstore persistant, APScheduler ne sait RIEN d'un déclenchement
    manqué pendant que la machine dormait (01:00 → 06:00) : c'est ici, et
    seulement ici, que le rapport du matin est récupéré.
    """
    cfg = ms.load(ms.DEFAULT_PATH)
    if not ms.should_catch_up(cfg, last_run_date(), now or datetime.now()):
        return None
    logger.info("[Market Pulse] créneau du matin manqué → rattrapage")
    return run_scheduled()


def _reregister_schedule(cfg: Dict[str, Any]) -> None:
    """Réinstalle le job après un changement de configuration."""
    try:
        from backend.scheduler import engine
        scheduler = getattr(engine, "_scheduler", None)
        if scheduler is None:
            return
        ms.register_job(scheduler, run_scheduled, cfg)
    except Exception as e:
        logger.warning("[Market Pulse] réinstallation du job impossible: %r", e)


def register_startup_job() -> None:
    """Appelé au démarrage du backend : installe le job + rattrape si besoin."""
    cfg = ms.load(ms.DEFAULT_PATH)
    _reregister_schedule(cfg)
    try:
        catch_up_if_needed()
    except Exception as e:
        logger.warning("[Market Pulse] rattrapage matinal échoué: %r", e)


# ================================================================
#  PURGE
# ================================================================

def purge_old_runs(max_age_days: int = RUN_RETENTION_DAYS,
                   is_alive=_pid_alive) -> List[str]:
    """Supprime les vieux runs. Ne touche jamais un run VIVANT, ni le plus
    récent (sinon `/snapshot` se viderait après une longue absence)."""
    import shutil
    import time as _time

    dirs = _run_dirs()
    if not dirs:
        return []
    keep_newest = dirs[0].name
    cutoff = _time.time() - max_age_days * 86400
    purged = []
    for d in dirs:
        if d.name == keep_newest:
            continue
        if is_alive(_read_pid(d)):
            continue
        try:
            if d.stat().st_mtime >= cutoff:
                continue
            shutil.rmtree(str(d))
        except OSError:
            continue
        _market_jobs.pop(d.name, None)
        purged.append(d.name)
    return purged


# ================================================================
#  ENDPOINTS
# ================================================================

class RunRequest(BaseModel):
    stats: bool = True
    report: bool = True
    excel: bool = True
    news: bool = True


class SchedulePayload(BaseModel):
    enabled: bool = False
    time: str = "07:30"
    tz: str = "Europe/Rome"
    days: str = "weekdays"


@router.post("/run")
def market_run(data: RunRequest,
               current_user: User = Depends(require_role("admin", "money"))):
    return _start_run(current_user.username, data.dict())


@router.get("/status/{job_id}")
def market_status(job_id: str,
                  current_user: User = Depends(require_role("admin", "money"))):
    _check_job_id(job_id)
    run_dir = _run_dir(job_id)
    if not run_dir.is_dir():
        raise HTTPException(status_code=404, detail="Job introuvable")
    job = _market_jobs.get(job_id) or {}
    status = _status_from_disk(run_dir)
    return {
        "job_id": job_id,
        "status": status,
        "files": _files_of(run_dir),
        "logs": (job.get("logs") or [])[-50:]
                or (_read_text(run_dir / "run.log") or "").splitlines()[-50:],
        "meta": _meta(run_dir),
    }


@router.get("/active")
def market_active(current_user: User = Depends(require_role("admin", "money"))):
    """Run vivant, sinon le dernier terminé — pour la reconnexion de l'UI."""
    for d in _run_dirs():
        status = _status_from_disk(d)
        return {"found": True, "job_id": d.name, "status": status,
                "files": _files_of(d), "meta": _meta(d)}
    return {"found": False}


@router.post("/stop/{job_id}")
def market_stop(job_id: str,
                current_user: User = Depends(require_role("admin", "money"))):
    _check_job_id(job_id)
    run_dir = _run_dir(job_id)
    if not run_dir.is_dir():
        raise HTTPException(status_code=404, detail="Job introuvable")
    try:
        (run_dir / "stop.flag").write_text("1", encoding="utf-8")
    except OSError:
        pass
    job = _market_jobs.get(job_id) or {}
    proc = job.get("process")
    if proc is not None and proc.poll() is None:
        try:
            proc.terminate()
        except OSError:
            pass
    job["status"] = "stopped"
    job["process"] = None
    return {"status": "stopped", "job_id": job_id}


@router.get("/snapshot")
def market_snapshot(current_user: User = Depends(require_role("admin", "money"))):
    """Tout ce que l'UI affiche, en un appel : dernier relevé exploitable.

    On saute les runs qui n'ont pas encore de snapshot (un run en cours ne
    doit pas masquer la photographie de ce matin).
    """
    for d in _run_dirs():
        if not (d / "snapshot.json").is_file():
            continue
        meta = _meta(d)
        return {
            "job_id": d.name,
            "snapshot": _read_json(d / "snapshot.json"),
            "history": _read_json(d / "history.json"),
            "news": _read_json(d / "news.json"),
            "report": _read_text(d / "report.txt"),
            "files": _files_of(d),
            "status": _status_from_disk(d),
            "ran_at": meta.get("created_at") or datetime.fromtimestamp(
                d.stat().st_mtime).isoformat(timespec="seconds"),
        }
    return {"job_id": None, "snapshot": None, "history": None, "news": None,
            "report": None, "files": None, "status": None, "ran_at": None}


@router.get("/download/{job_id}")
def market_download(job_id: str,
                    current_user: User = Depends(require_role("admin", "money"))):
    _check_job_id(job_id)
    name = _excel_name(_run_dir(job_id))
    if not name:
        raise HTTPException(status_code=404, detail="File Excel non trovato")
    return FileResponse(
        path=str(_run_dir(job_id) / name),
        filename=name,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="%s"' % name},
    )


@router.get("/report/{job_id}")
def market_report(job_id: str,
                  current_user: User = Depends(require_role("admin", "money"))):
    _check_job_id(job_id)
    text = _read_text(_run_dir(job_id) / "report.txt")
    if text is None:
        raise HTTPException(status_code=404, detail="Rapporto non trovato")
    return PlainTextResponse(text)


@router.get("/schedule")
def market_get_schedule(current_user: User = Depends(require_role("admin", "money"))):
    view = ms.public_view(ms.load(ms.DEFAULT_PATH))
    view["last_run_date"] = last_run_date()
    return view


@router.post("/schedule")
def market_set_schedule(data: SchedulePayload,
                        current_user: User = Depends(require_role("admin"))):
    """Admin STRICT : régler l'heure du rapport, c'est configurer la machine."""
    try:
        saved = ms.save(data.dict(), ms.DEFAULT_PATH)
    except ms.ScheduleError as e:
        # Une config invalide est une erreur d'entrée, pas une panne serveur.
        raise HTTPException(status_code=400, detail=str(e))
    _reregister_schedule(saved)
    view = ms.public_view(saved)
    view["last_run_date"] = last_run_date()
    return view
