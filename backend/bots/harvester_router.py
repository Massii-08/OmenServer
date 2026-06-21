"""Router AI Harvester (P1) — lance le moteur déterministe en subprocess détaché
(mirroir du Bond Scanner) + API privée gated par X-Feed-Key.

Admin-only (gate backend strict is_admin) sauf /data qui est gated par la clé
de feed par-harvest (header X-Feed-Key) — c'est l'API privée consommable par un
client externe."""
import asyncio
import csv
import errno
import io
import json
import logging
import os
import re
import secrets
import subprocess
import sys
import threading
import uuid
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query, WebSocket
from fastapi.responses import PlainTextResponse, Response
from pydantic import BaseModel

from backend.auth.models import User
from backend.auth.utils import get_current_user, decode_token
from backend.database import SessionLocal
from backend.bots.harvester.config import HarvestConfig
from backend.bots.harvester.llm import _claude
from backend.bots.harvester.policy import PII_FIELDS
from backend.bots.harvester.recipe import Recipe
from backend.bots.harvester.setup import build_setup
from backend.bots.harvester.store import Store
from backend.bots.harvester import unblocker_config
from backend.bots.harvester import telegram_config
from backend.bots.harvester import notify as _notify
from backend.bots.harvester import exporter

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


# job_id = uuid4().hex (32 hex). Validé en tête des routes qui composent un chemin
# disque (_run_dir) -> empêche tout path-traversal (`../`, séparateurs, etc.).
_JOB_ID_RE = re.compile(r"\A[0-9a-f]{32}\Z")


def _check_job_id(job_id: str) -> None:
    if not _JOB_ID_RE.match(job_id or ""):
        raise HTTPException(status_code=404, detail="Job introuvable")


# --- D : bridge VNC (vue live du CAPTCHA) ---------------------------------

# Socket Unix d'x11vnc (-display :100). Aucun port TCP : accès gouverné par les
# perms du socket (user omenserver) + le JWT admin du bridge. Surchargeable env.
HARVESTER_VNC_SOCK = os.environ.get(
    "HARVESTER_VNC_SOCK", "/run/omen-harvester-vnc/vnc.sock")


def _ws_admin_from_token(token):
    """Décode le JWT (?token=) -> User admin, ou None. Réutilise le pattern WS du
    projet (game_server/websocket.py). Toute erreur -> None (refus sûr)."""
    try:
        payload = decode_token(token)
        if not payload:
            return None
        username = payload.get("sub")
        if not username:
            return None
        db = SessionLocal()
        try:
            user = db.query(User).filter(User.username == username).first()
        finally:
            db.close()
        if user and getattr(user, "is_admin", False):
            return user
        return None
    except Exception:  # noqa: BLE001 — refus sûr
        return None


def _vnc_authorize(token, job_id, admin_fn=None):
    """Décision d'autorisation du bridge VNC (PURE -> testable sans WS).
    Retourne (ok: bool, reason). Exige : admin + job_id valide + job en attente
    de résolution manuelle (n'ouvre JAMAIS le bureau arbitrairement)."""
    if admin_fn is None:
        admin_fn = _ws_admin_from_token
    if not token or not admin_fn(token):
        return False, "auth"
    if not _JOB_ID_RE.match(job_id or ""):
        return False, "job_id"
    job = _harvester_jobs.get(job_id) or _job_from_disk(str(_run_dir(job_id)), job_id)
    if not job or not _job_awaiting(job):
        return False, "not_awaiting"
    return True, "ok"


async def _pump_ws_socket(websocket, reader, writer):
    """Pompe bidirectionnelle d'octets RFB entre le WebSocket noVNC et le socket
    Unix d'x11vnc. Verbatim (zéro transformation) — c'est ce que fait websockify."""
    async def ws_to_sock():
        try:
            while True:
                data = await websocket.receive_bytes()
                writer.write(data)
                await writer.drain()
        except Exception:  # noqa: BLE001 — fin de flux / déconnexion
            pass

    async def sock_to_ws():
        try:
            while True:
                chunk = await reader.read(65536)
                if not chunk:
                    break
                await websocket.send_bytes(chunk)
        except Exception:  # noqa: BLE001
            pass

    t1 = asyncio.ensure_future(ws_to_sock())
    t2 = asyncio.ensure_future(sock_to_ws())
    try:
        await asyncio.wait({t1, t2}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for t in (t1, t2):
            t.cancel()
        try:
            writer.close()
        except Exception:  # noqa: BLE001
            pass


@router.websocket("/vnc/{job_id}")
async def harvester_vnc(websocket: WebSocket, job_id: str,
                        token: str = Query(default="")):
    """Bridge admin-gated : pompe le RFB d'x11vnc (socket Unix) vers noVNC. Refuse
    (close 1008) si non-admin / job_id invalide / job pas en `awaiting_solve`."""
    ok, _reason = _vnc_authorize(token, job_id)
    if not ok:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    try:
        reader, writer = await asyncio.open_unix_connection(HARVESTER_VNC_SOCK)
    except OSError:
        await websocket.close(code=1011)   # x11vnc indisponible
        return
    try:
        await _pump_ws_socket(websocket, reader, writer)
    finally:
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass


class RunRequest(BaseModel):
    url: str
    recipe: Dict[str, Any]
    plan: Dict[str, Any] = {}
    pacing: Dict[str, Any] = {}


class SetupRequest(BaseModel):
    url: str
    instructions: str = ""


class UnblockerConfigRequest(BaseModel):
    endpoint: str = ""
    key: str = ""              # vide -> on garde la clé déjà enregistrée
    render_js: bool = False
    method: str = "POST"
    key_in: str = "body"
    key_param: str = "apikey"
    result_field: str = ""


class TelegramConfigRequest(BaseModel):
    token: str = ""          # vide -> on garde le token déjà enregistré
    chat_id: str = ""


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
    pid vivant -> running ; pid mort -> interrupted s'il reste du todo (tué par
    un restart ; repris au prochain boot s'il est récent, cf. RESUME_MAX_AGE_S),
    sinon completed (a fini de lui-même)."""
    if (Path(run_dir) / "stop.flag").is_file():
        return "stopped"
    pid = _read_pid(run_dir)
    if pid and is_alive(pid):
        return "running"
    return "interrupted" if _has_pending(run_dir) else "completed"


def _read_log_tail(run_dir, limit: int = 200):
    p = Path(run_dir) / "run.log"
    if not p.is_file():
        return []
    try:
        return p.read_text(encoding="utf-8", errors="replace").splitlines()[-limit:]
    except OSError:
        return []


def _open_run_log(run_dir):
    """Ouvre run.log en append + 0o600 (cohérent avec config.json : un log de
    run peut contenir des traces sensibles -> même posture que les secrets). Le
    fichier NAÎT en 0o600 (création atomique via os.open, pas de fenêtre
    world-readable) ; os.fchmod couvre un fichier pré-existant aux autres
    permissions. Même posture que unblocker_config.save."""
    path = os.path.join(run_dir, "run.log")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.fchmod(fd, 0o600)
    except (AttributeError, OSError):
        pass
    return os.fdopen(fd, "a", encoding="utf-8")


# run.log n'est PAS borné (1 ligne/page) -> on ne lit que la fin pour la reco.
# La reco est émise UNE fois quand la cible bloque (le run stalle alors -> peu de
# lignes ensuite) donc elle reste dans le tail. Un run qui REPART produit >tail
# de logs après : la reco devenue obsolète disparaît de /status, ce qui est voulu.
_RECO_TAIL_BYTES = 65536


def _recommend_from_log(run_dir, max_bytes=_RECO_TAIL_BYTES):
    """Reconstruit la DERNIÈRE reco de tier (`recommend_tier`) depuis la FIN de
    run.log (lecture bornée -> O(tail), pas O(fichier) à chaque poll). Survit au
    restart uvicorn. None si aucune. Ne porte JAMAIS de secret (l'event =
    tier/raison/url/compteur)."""
    p = Path(run_dir) / "run.log"
    if not p.is_file():
        return None
    try:
        size = p.stat().st_size
        with open(str(p), "rb") as f:
            if size > max_bytes:
                f.seek(size - max_bytes)
                f.readline()             # jette la 1re ligne partielle
            data = f.read()
        text = data.decode("utf-8", errors="replace")
    except OSError:
        return None
    found = None
    for line in text.splitlines():
        line = line.strip()
        if not line or "recommend_tier" not in line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if msg.get("type") == "recommend_tier":
            found = msg                  # garde la plus récente du tail
    return found


def _solve_from_log(run_dir, max_bytes=_RECO_TAIL_BYTES):
    """État courant de résolution manuelle, reconstruit depuis la FIN de run.log
    (miroir de _recommend_from_log). Renvoie l'event `awaiting_manual_solve`
    SEULEMENT s'il n'a pas été suivi d'un `manual_solve_resolved`/`_timeout`
    (état transitoire). None sinon. Survit au restart uvicorn. Jamais de secret."""
    p = Path(run_dir) / "run.log"
    if not p.is_file():
        return None
    try:
        size = p.stat().st_size
        with open(str(p), "rb") as f:
            if size > max_bytes:
                f.seek(size - max_bytes)
                f.readline()
            data = f.read()
        text = data.decode("utf-8", errors="replace")
    except OSError:
        return None
    last = None
    for line in text.splitlines():
        line = line.strip()
        if not line or "manual_solve" not in line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        t = msg.get("type")
        if t == "awaiting_manual_solve":
            last = msg
        elif t in ("manual_solve_resolved", "manual_solve_timeout"):
            last = None
    return last


def _job_awaiting(job):
    """État `awaiting_solve` d'un job : mémoire (posée par _capture) si le process
    est suivi vivant, sinon relecture du tail (restart-résilient). NON caché
    (l'état est transitoire : awaiting -> resolved)."""
    if job.get("process") is not None:
        return job.get("awaiting_solve")
    return _solve_from_log(str(_run_dir(job["job_id"])))


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
        "tier": (cfg.plan or {}).get("fetch_tier", "httpx"),
        "recommend": _recommend_from_log(str(run_dir)),
        "awaiting_solve": _solve_from_log(str(run_dir)),
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


# Survie réelle au restart : une moisson tuée par le cgroup (restart/auto-deploy)
# est RELANCÉE au démarrage et reprend depuis la frontière persistée sur disque.
RESUME_MAX_AGE_S = 24 * 3600  # ne pas ressusciter un run abandonné depuis > 24h


def _has_pending(run_dir) -> bool:
    sp = Path(run_dir) / "store.json"
    if not sp.is_file():
        return False
    return Store.load(str(sp)).next_todo() is not None


def _should_resume(run_dir, is_alive=_pid_alive, now=None,
                   max_age_s=RESUME_MAX_AGE_S) -> bool:
    """True si le run a été INTERROMPU (pas d'arrêt volontaire, plus de process
    vivant) et qu'il reste du todo -> à reprendre. Garde de fraîcheur : un run
    abandonné depuis trop longtemps n'est pas ressuscité (now optionnel)."""
    if (Path(run_dir) / "stop.flag").is_file():
        return False                      # arrêt volontaire
    pid = _read_pid(run_dir)
    if pid and is_alive(pid):
        return False                      # déjà en cours
    sp = Path(run_dir) / "store.json"
    if not sp.is_file():
        return False
    if now is not None:
        try:
            if now - os.path.getmtime(str(sp)) > max_age_s:
                return False
        except OSError:
            return False
    return Store.load(str(sp)).next_todo() is not None


def resume_interrupted_runs(launch=None, is_alive=_pid_alive, now=None):
    """Relance les moissons interrompues depuis leur frontière. Appelé au
    DÉMARRAGE de l'app (pas à l'import -> aucun effet de bord en test)."""
    import time as _time
    if now is None:
        now = _time.time()
    launch = launch or _launch_subprocess
    base = Path(HARVESTER_RUNS_DIR)
    if not base.is_dir():
        return []
    resumed = []
    for d in sorted(base.iterdir()):
        if not d.is_dir() or not _should_resume(str(d), is_alive, now):
            continue
        job = _job_from_disk(str(d), d.name, is_alive) or {"job_id": d.name, "logs": []}
        job["status"] = "running"
        _harvester_jobs[d.name] = job
        try:
            launch(str(d), job)           # reprend depuis la frontière
            resumed.append(d.name)
        except Exception:  # noqa: BLE001 — un run qui refuse de relancer ne bloque pas les autres
            pass
    return resumed


RUN_RETENTION_DAYS = 14  # purge des runs inactifs depuis > N jours (anti-accumulation)


def purge_old_runs(now=None, max_age_days=RUN_RETENTION_DAYS, is_alive=_pid_alive):
    """Supprime les run dirs inactifs depuis plus de ``max_age_days`` (ancre =
    mtime du store.json). Ne touche JAMAIS un run vivant. Appelé au démarrage."""
    import shutil
    import time as _time
    if now is None:
        now = _time.time()
    base = Path(HARVESTER_RUNS_DIR)
    if not base.is_dir():
        return []
    cutoff = float(max_age_days) * 86400.0
    purged = []
    for d in sorted(base.iterdir()):
        if not d.is_dir():
            continue
        pid = _read_pid(str(d))
        if pid and is_alive(pid):
            continue                      # jamais purger un run en cours
        ref = d / "store.json"
        if not ref.is_file():
            ref = d
        try:
            if now - os.path.getmtime(str(ref)) <= cutoff:
                continue
        except OSError:
            continue
        try:
            shutil.rmtree(str(d))
            _harvester_jobs.pop(d.name, None)
            purged.append(d.name)
        except OSError:
            pass
    return purged


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
            logf = _open_run_log(run_dir)
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
                    elif msg.get("type") == "recommend_tier":
                        j["recommend"] = msg     # surfacé par /status et /active
                    elif msg.get("type") == "awaiting_manual_solve":
                        j["awaiting_solve"] = msg
                    elif msg.get("type") in ("manual_solve_resolved",
                                             "manual_solve_timeout"):
                        j["awaiting_solve"] = None
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
        "tier": (data.plan or {}).get("fetch_tier", "httpx"),
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


def _job_recommend(job):
    """Reco de tier pour un job : valeur en mémoire (posée par le thread _capture)
    sinon relecture du tail de run.log. Le résultat positif est CACHÉ sur le job
    -> une fois trouvée, plus aucun re-scan disque (revue #2/#6)."""
    rec = job.get("recommend")
    if rec:
        return rec
    found = _recommend_from_log(str(_run_dir(job["job_id"])))
    if found:
        job["recommend"] = found
    return found


@router.get("/unblocker-config")
def get_unblocker_config(current_user: User = Depends(get_current_user)):
    """Vue publique de la config débloqueur (clé MASQUÉE). Admin-only."""
    _require_admin(current_user)
    return unblocker_config.public_view(unblocker_config.load())


@router.post("/unblocker-config")
def set_unblocker_config(data: UnblockerConfigRequest,
                         current_user: User = Depends(get_current_user)):
    """Enregistre la config débloqueur (clé en chmod 600). Clé vide -> on garde
    l'existante (permet d'ajuster l'endpoint sans recoller la clé). Admin-only."""
    _require_admin(current_user)
    endpoint = data.endpoint.strip()
    if endpoint and urlparse(endpoint).scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="Endpoint doit être http(s)")
    existing = unblocker_config.load()
    cfg = {
        "endpoint": endpoint,
        "render_js": bool(data.render_js),
        "method": (data.method or "POST").upper(),
        "key_in": data.key_in if data.key_in in ("body", "header", "query") else "body",
        "key_param": (data.key_param or "apikey").strip() or "apikey",
        "result_field": data.result_field.strip(),
    }
    new_key = data.key.strip()
    if new_key:
        cfg["key"] = new_key
    elif existing.get("key"):
        cfg["key"] = existing["key"]          # conservée
    unblocker_config.save(cfg)
    return unblocker_config.public_view(cfg)


@router.post("/unblocker-config/clear")
def clear_unblocker_config(current_user: User = Depends(get_current_user)):
    """Oublie la config débloqueur (supprime le fichier). Admin-only."""
    _require_admin(current_user)
    unblocker_config.clear()
    return {"configured": False}


@router.get("/telegram-config")
def get_telegram_config(current_user: User = Depends(get_current_user)):
    """Vue publique de la config Telegram (token MASQUÉ). Admin-only."""
    _require_admin(current_user)
    return telegram_config.public_view(telegram_config.load())


@router.post("/telegram-config")
def set_telegram_config(data: TelegramConfigRequest,
                        current_user: User = Depends(get_current_user)):
    """Enregistre la config Telegram (token en chmod 600). Token vide -> on garde
    l'existant (permet d'ajuster le chat_id sans recoller le token). Admin-only."""
    _require_admin(current_user)
    existing = telegram_config.load()
    cfg = {"chat_id": data.chat_id.strip()}
    new_token = data.token.strip()
    if new_token:
        cfg["token"] = new_token
    elif existing.get("token"):
        cfg["token"] = existing["token"]
    telegram_config.save(cfg)
    return telegram_config.public_view(cfg)


@router.post("/telegram-config/clear")
def clear_telegram_config(current_user: User = Depends(get_current_user)):
    """Oublie la config Telegram (supprime le fichier). Admin-only."""
    _require_admin(current_user)
    telegram_config.clear()
    return {"configured": False}


@router.post("/export/{job_id}")
def export_harvester(job_id: str, current_user: User = Depends(get_current_user)):
    """Génère le package client STANDALONE (zip) à partir d'un harvest validé :
    moteur déterministe + config figée + serveur de feed privé. Le client reçoit
    sa PROPRE clé de feed (jamais celle du serveur). Admin-only, zéro IA."""
    _require_admin(current_user)
    run_dir = _run_dir(job_id)
    if not (run_dir / "config.json").is_file():
        raise HTTPException(status_code=404, detail="Harvest introuvable")
    cfg = HarvestConfig.load(str(run_dir))
    # garde no-PII (défensive) sur la recette livrée
    for name in cfg.recipe.field_names():
        if name.lower() in PII_FIELDS:
            raise HTTPException(
                status_code=400,
                detail="Recette PII, export refusé: '{0}'".format(name))
    # 🔒 ne JAMAIS livrer la clé débloqueur de l'admin au client (si posée dans le
    # plan par-run) — le client met la SIENNE via .env (cf. .env.example du zip).
    # secrets/serveur-only retirés du plan livré : la clé débloqueur de l'admin
    # ET les options de résolution manuelle (manual_solve* n'ont aucun sens côté
    # client — ni dashboard, ni noVNC, ni Telegram pour résoudre — et stalleraient
    # une cible challengée jusqu'au timeout).
    _client_strip = ("unblocker_key", "manual_solve", "manual_solve_timeout")
    safe_plan = {k: v for k, v in (cfg.plan or {}).items() if k not in _client_strip}
    client_config = {
        "url": cfg.url,
        "recipe": cfg.recipe.to_dict(),
        "plan": safe_plan,
        "pacing": cfg.pacing,
        "feed_key": secrets.token_urlsafe(24),   # clé dédiée au client
    }
    blob = exporter.build_export(client_config)
    return Response(
        content=blob, media_type="application/zip",
        headers={"Content-Disposition":
                 'attachment; filename="harvest-{0}.zip"'.format(job_id[:8])})


def _disk_counts(job_id: str) -> Optional[Dict[str, int]]:
    store_path = _run_dir(job_id) / "store.json"
    if not store_path.is_file():
        return None
    return Store.load(str(store_path)).counts()


@router.get("/status/{job_id}")
def harvester_status(job_id: str, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    _check_job_id(job_id)
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
        "tier": job.get("tier", "httpx"),
        "recommend": _job_recommend(job),
        "awaiting_solve": _job_awaiting(job),
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
                    "url": job["url"],
                    "feed_key": job.get("feed_key"),
                    "tier": job.get("tier", "httpx"),
                    "recommend": _job_recommend(job),
                    "awaiting_solve": _job_awaiting(job)}
    return None


@router.post("/stop/{job_id}")
def harvester_stop(job_id: str, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    _check_job_id(job_id)
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
    _check_job_id(job_id)
    run_dir = _run_dir(job_id)
    cfg_path = run_dir / "config.json"
    if not cfg_path.is_file():
        raise HTTPException(status_code=404, detail="Harvest introuvable")
    cfg = HarvestConfig.load(str(run_dir))
    if not x_feed_key or not secrets.compare_digest(x_feed_key, cfg.feed_key):
        raise HTTPException(status_code=401, detail="Clé de feed invalide")

    store_path = run_dir / "store.json"
    records = Store.load(str(store_path)).records() if store_path.is_file() else []

    # Consommation = activité : repousse la rétention. Un feed encore tiré par un
    # client externe ne doit JAMAIS être auto-purgé, même si la moisson a fini
    # d'écrire (sinon perte de données silencieuse à J+14 — cf. revue adversariale).
    try:
        if store_path.is_file():
            os.utime(str(store_path), None)  # mtime -> maintenant
    except OSError:
        pass

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
