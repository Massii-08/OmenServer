"""Router du Scanner d'actions — 4ᵉ bot de la suite finance.

Il lance le moteur ``backend.bots.stockscan`` en subprocess DÉTACHÉ et sert
les fichiers qu'il produit. Même patron que Market Pulse : **le disque est la
source de vérité**, pas le registre mémoire. L'auto-deploy redémarre uvicorn
toutes les minutes ; un scan en cours doit survivre à ce redémarrage, et l'UI
doit pouvoir s'y reconnecter (``/active``) puis le suivre (``/status``).

Trois écarts VOULUS par rapport à ``market_router`` :

- **La sortie du moteur va DIRECTEMENT dans ``run.log``**, sans pipe ni fil
  de capture. Avec un pipe, le lecteur meurt au restart d'uvicorn et le
  ``print`` suivant du moteur lève ``BrokenPipeError`` : le scan s'arrête net.
- **Un fil « faucheur » attend la fin du moteur** (``wait()``, rien d'autre).
  Sans lui, un moteur terminé resterait ZOMBIE tant qu'uvicorn vit — or
  ``os.kill(pid, 0)`` réussit sur un zombie (vérifié) : le run serait affiché
  « running » pour toujours et ``/run`` refuserait d'en lancer un autre.
- **L'arrêt tue le GROUPE de process lu sur le disque** (``os.killpg`` du
  ``pid``) : après un restart d'uvicorn, le ``Popen`` en mémoire n'existe
  plus alors que le moteur détaché tourne toujours (défaut de Market Pulse).

Défauts du Bond Scanner NON recopiés : un arrêt affiché « erreur » (ici
``stop.flag`` prime sur tout), un téléchargement sans contrôle de rôle, des
identifiants de job non validés avant de composer un chemin.

Accès : TOUT en ``admin`` + ``money``, comme les trois autres bots finance.
Spec : ``docs/superpowers/specs/2026-10-17-action-scanner-design.md`` (§7.4, §8).
"""
import json
import logging
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from backend.auth.models import User
from backend.auth.permissions import require_role
from backend.bots.stockscan import config as scan_config
from backend.bots.stockscan import markets as scan_markets

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/bots/stocks", tags=["Scanner d'actions"])

_project_root = Path(__file__).resolve().parent.parent.parent
RUNS_DIR = _project_root / "data" / "stock_scanner" / "runs"

RUN_RETENTION_DAYS = 30

# Un scan dure quelques minutes (pires cas bornés par les délais d'attente et
# les disjoncteurs du moteur : < 15 min). Au-delà, un pid « vivant » sans
# résultat est un pid recyclé, pas le moteur.
STALE_AFTER_S = 45 * 60

# Journal servi par /status : les dernières lignes, lues dans les derniers
# octets du fichier seulement — un run.log de plusieurs Mo ne doit pas être
# relu en entier à chaque sondage de l'UI.
LOG_TAIL_LINES = 60
_LOG_TAIL_BYTES = 64 * 1024

_XLSX_MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

# Registre mémoire : pratique (fil faucheur, terminate), mais JAMAIS la vérité
# (un restart uvicorn le vide alors que le moteur détaché, lui, tourne toujours).
_stock_jobs = {}  # type: Dict[str, Dict[str, Any]]

# Sérialise « vérifier qu'aucun scan ne tourne PUIS lancer » : les endpoints
# synchrones tournent dans un pool de threads, deux clics rapprochés passeraient
# sinon tous les deux la vérification.
_start_lock = threading.Lock()

_JOB_ID_RE = re.compile(r"\A[0-9a-f]{32}\Z")


# ================================================================
#  DISQUE — le dossier d'un run fait foi
# ================================================================

def _check_job_id(job_id: str) -> None:
    """Un job_id qui n'est pas 32 hexa minuscules ne compose JAMAIS un chemin.

    404 et non 400 : on ne confirme même pas qu'un identifiant mal formé
    aurait pu exister.
    """
    if not _JOB_ID_RE.match(job_id or ""):
        raise HTTPException(status_code=404, detail="Job introuvable")


def _run_dir(job_id: str) -> Path:
    return Path(RUNS_DIR) / job_id


def _existing_run_dir(job_id: str) -> Path:
    """Dossier d'un run existant, ou 404 — l'identifiant est vérifié AVANT
    que le moindre chemin soit composé."""
    _check_job_id(job_id)
    run_dir = _run_dir(job_id)
    if not run_dir.is_dir():
        raise HTTPException(status_code=404, detail="Job introuvable")
    return run_dir


def _pid_path(run_dir) -> Path:
    return Path(run_dir) / "pid"


def _read_pid(run_dir) -> Optional[int]:
    try:
        return int(_pid_path(run_dir).read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None


def _pid_alive(pid) -> bool:
    """True si le PID tourne (patron du Harvester).

    ``os.kill(pid, 0)`` : ESRCH = mort, EPERM = VIVANT (autre utilisateur).
    Le moteur détaché survit au restart d'uvicorn : on le redétecte ainsi
    plutôt que de le croire mort. Un pid négatif viserait un GROUPE : refusé.
    """
    if not pid:
        return False
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except PermissionError:
        return True
    except (OSError, OverflowError):
        return False
    return True


def _status_from_disk(run_dir, is_alive=_pid_alive, now: Optional[float] = None) -> str:
    """Statut reconstruit depuis le disque (survit à un restart uvicorn).

    ``stop.flag`` prime sur tout : un arrêt demandé s'affiche « stopped »,
    jamais « error », même si le moteur est sorti sans résultat (défaut du
    Bond Scanner) — et même s'il met quelques secondes à mourir.
    """
    run_dir = Path(run_dir)
    if (run_dir / "stop.flag").is_file():
        return "stopped"
    # results.json est écrit EN DERNIER par le moteur : sa présence dit « fini »,
    # même si le process n'est pas encore sorti — et un PID recyclé par le
    # système ne peut plus faire passer un run terminé pour un run en cours.
    if (run_dir / "results.json").is_file():
        return "completed"
    if is_alive(_read_pid(run_dir)):
        # Garde anti-PID recyclé : un scan dure quelques minutes. Au-delà de
        # STALE_AFTER_S, un pid « vivant » sans résultat n'est plus le moteur —
        # et le croire bloquerait tout nouveau scan (``/run`` refuse d'empiler).
        age = (now if now is not None else time.time()) - _created_ts(run_dir)
        return "running" if age <= STALE_AFTER_S else "error"
    # Process mort sans résultats : le moteur n'est pas allé au bout, c'est un
    # échec — le dire plutôt que d'afficher « terminé » sur un run vide.
    return "error"


def _read_json(path) -> Optional[Any]:
    """JSON du disque, ou None. Un fichier à moitié écrit (run tué en plein
    vol) ne doit jamais rendre un 500 à l'utilisateur."""
    try:
        with open(str(path), "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _write_atomic(path: Path, text: str) -> None:
    """Écrit ``text`` d'un coup (temporaire puis ``os.replace``) : un lecteur
    ne voit jamais un fichier à moitié écrit."""
    tmp = path.parent / (".%s.tmp-%d-%d" % (path.name, os.getpid(), threading.get_ident()))
    try:
        with open(str(tmp), "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(str(tmp), str(path))
    except Exception:
        try:
            os.remove(str(tmp))
        except OSError:
            pass
        raise


def _append_log(run_dir, line: str) -> None:
    """Une ligne du ROUTER dans le journal du run (lancement raté…) : un run
    en « error » doit dire pourquoi, jamais rester muet."""
    try:
        with open(str(Path(run_dir) / "run.log"), "a", encoding="utf-8") as f:
            f.write(line.rstrip("\n") + "\n")
    except OSError:
        pass


def _log_tail(run_dir, limit: int = LOG_TAIL_LINES) -> List[str]:
    """Les ``limit`` dernières lignes non vides de ``run.log``.

    Seuls les derniers ``_LOG_TAIL_BYTES`` sont lus ; la première ligne de ce
    morceau, coupée en route, est écartée.
    """
    try:
        with open(str(Path(run_dir) / "run.log"), "rb") as f:
            f.seek(0, os.SEEK_END)
            start = max(0, f.tell() - _LOG_TAIL_BYTES)
            f.seek(start)
            chunk = f.read()
    except OSError:
        return []
    lines = chunk.decode("utf-8", errors="replace").splitlines()
    if start > 0 and lines:
        lines = lines[1:]
    return [line.rstrip() for line in lines if line.strip()][-limit:]


def _excel_name(run_dir) -> Optional[str]:
    """Nom du premier classeur du run (ordre alphabétique), ou None.

    Jamais un fichier caché ou temporaire (``.`` en tête, verrou ``~$``
    d'Excel) — un classeur à moitié écrit n'est pas un résultat — ni un lien
    symbolique (on ne sert que ce que le moteur a écrit DANS le dossier).
    """
    try:
        for entry in sorted(Path(run_dir).glob("*.xlsx")):
            if entry.name.startswith((".", "~")) or entry.is_symlink():
                continue
            if entry.is_file():
                return entry.name
    except OSError:
        pass
    return None


def _files_of(run_dir) -> Dict[str, Any]:
    return {"results": (Path(run_dir) / "results.json").is_file(),
            "excel": _excel_name(run_dir)}


def _meta(run_dir) -> Dict[str, Any]:
    meta = _read_json(Path(run_dir) / "meta.json")
    return meta if isinstance(meta, dict) else {}


def _run_config(job_id: str) -> Optional[Dict[str, Any]]:
    """Config d'un run telle qu'écrite à son lancement (``config.json``), ou None
    si le fichier est absent, illisible ou n'est pas un objet JSON.

    Rendue TELLE QUELLE, sans revalidation : elle a été validée à SON lancement,
    et la compléter avec les défauts d'aujourd'hui décrirait un scan qui n'a
    jamais tourné ainsi.
    """
    config = _read_json(_run_dir(job_id) / "config.json")
    return config if isinstance(config, dict) else None


def _mtime_iso(path) -> Optional[str]:
    try:
        return datetime.fromtimestamp(Path(path).stat().st_mtime).isoformat(timespec="seconds")
    except (OSError, ValueError, OverflowError):
        return None


def _created_ts(run_dir: Path) -> float:
    """Instant de création d'un run : mtime de ``meta.json`` (écrit une seule
    fois, au lancement), à défaut celle du dossier.

    La mtime du dossier seule bouge à chaque fichier créé dedans : un
    ``stop.flag`` posé sur un vieux run le ferait passer pour le plus récent.
    """
    for path in (run_dir / "meta.json", run_dir):
        try:
            return path.stat().st_mtime
        except OSError:
            continue
    return 0.0


def _run_dirs() -> List[Path]:
    """Dossiers de run, du plus récent au plus ancien (par création)."""
    base = Path(RUNS_DIR)
    try:
        entries = [d for d in base.iterdir() if _JOB_ID_RE.match(d.name) and d.is_dir()]
    except OSError:
        return []
    return sorted(entries, key=_created_ts, reverse=True)


# ================================================================
#  LANCEMENT
# ================================================================

def _build_cmd(run_dir, username: str) -> List[str]:
    """Ligne de commande du moteur — contrat de ``backend.bots.stockscan``
    (spec §4). Lancé en module depuis la racine du projet : le moteur lit les
    modules du coach (``backend.bots.paper.*``)."""
    run_dir = Path(run_dir)
    # ``--user=<nom>`` en UN argument : un nom commençant par « - » serait
    # sinon pris par argparse pour une option, et le scan finirait en erreur.
    return [sys.executable, "-m", "backend.bots.stockscan",
            "--out", str(run_dir),
            "--config", str(run_dir / "config.json"),
            "--user=%s" % username]


def _reap(proc, job: Dict[str, Any], run_dir) -> None:
    """Attend la fin du moteur — et rien d'autre : aucun pipe à lire.

    Sans ce ``wait()``, un moteur terminé resterait zombie tant qu'uvicorn vit
    et ``os.kill(pid, 0)`` le dirait vivant : « running » à vie. Après un
    restart d'uvicorn, ce fil meurt avec lui et c'est le nouveau parent du
    moteur (init/systemd) qui le récolte.
    """
    try:
        job["returncode"] = proc.wait()
    except Exception:  # noqa: BLE001 — un fil de fond ne doit jamais lever
        return
    job["status"] = _status_from_disk(run_dir)
    job["process"] = None          # en dernier : statut déjà à jour quand il disparaît


def _launch_subprocess(run_dir, job: Dict[str, Any], username: str) -> None:
    """Lance le moteur DÉTACHÉ, sa sortie écrite directement dans run.log."""
    run_dir = Path(run_dir)
    log = open(str(run_dir / "run.log"), "ab")
    try:
        proc = subprocess.Popen(
            _build_cmd(run_dir, username),
            stdin=subprocess.DEVNULL,
            # DIRECTEMENT dans le fichier : pas de pipe, donc pas de lecteur
            # qui meurt au restart d'uvicorn, donc pas de BrokenPipeError au
            # print suivant du moteur.
            stdout=log,
            stderr=subprocess.STDOUT,
            cwd=str(_project_root),
            env=dict(os.environ, PYTHONUNBUFFERED="1"),
            # OBLIGATOIRE : sans session propre, le restart uvicorn de
            # l'auto-deploy (toutes les minutes) tuerait le scan en cours.
            # Et pgid == pid : /stop peut tuer tout le groupe du moteur.
            start_new_session=True,
        )
    finally:
        # Le moteur a hérité de sa propre copie du descripteur.
        log.close()
    job["process"] = proc
    job["status"] = "running"
    try:
        _write_atomic(_pid_path(run_dir), str(proc.pid))
    except OSError as e:
        logger.warning("[Scanner d'actions] pid du run %s non écrit: %r", run_dir.name, e)
    threading.Thread(target=_reap, args=(proc, job, run_dir), daemon=True,
                     name="stockscan-reap-%s" % run_dir.name[:8]).start()
    logger.info("[Scanner d'actions] scan %s lancé par %s (pid %s)",
                run_dir.name, username, proc.pid)


def _live_job_id() -> Optional[str]:
    """Identifiant du scan vivant, s'il y en a un (lu sur le DISQUE)."""
    for d in _run_dirs():
        if _status_from_disk(d) == "running":
            return d.name
    return None


def _start_run(username: str, clean: Dict[str, Any],
               now: Optional[datetime] = None) -> Dict[str, Any]:
    """Démarre un scan, ou rend celui qui tourne déjà.

    On vérifie AVANT de créer le dossier, sous verrou : empiler deux scans
    doublerait les requêtes au screener et à TradingView, dont le coach
    consomme déjà le budget (spec §3.5).
    """
    with _start_lock:
        live = _live_job_id()
        if live:
            return {"job_id": live, "already_running": True}

        # Avant de créer le nouveau dossier : le run précédent est alors le
        # plus récent, donc protégé (sinon /latest se viderait le temps du scan).
        try:
            purge_old_runs()
        except Exception as e:  # noqa: BLE001 — la purge ne bloque jamais un scan
            logger.warning("[Scanner d'actions] purge des vieux runs impossible: %r", e)

        job_id = uuid.uuid4().hex
        run_dir = _run_dir(job_id)
        now = now or datetime.now()
        meta = {
            "job_id": job_id,
            "user": username,
            "created_at": now.isoformat(timespec="seconds"),
            # Date LOCALE, même convention que Market Pulse.
            "date": now.strftime("%Y-%m-%d"),
        }
        created = False
        try:
            run_dir.mkdir(parents=True)
            created = True
            _write_atomic(run_dir / "meta.json", json.dumps(meta, ensure_ascii=False))
            _write_atomic(run_dir / "config.json",
                          json.dumps(clean, ensure_ascii=False, indent=2))
        except OSError:
            logger.exception("[Scanner d'actions] dossier du run %s impossible à préparer",
                             job_id)
            if created:     # jamais un dossier qu'on n'a pas créé nous-mêmes
                shutil.rmtree(str(run_dir), ignore_errors=True)
            raise

        job = {"job_id": job_id, "status": "starting", "process": None}
        _stock_jobs[job_id] = job
        try:
            _launch_subprocess(str(run_dir), job, username)
        except Exception as e:
            _stock_jobs.pop(job_id, None)
            logger.exception("[Scanner d'actions] lancement du run %s impossible", job_id)
            _append_log(run_dir, "[router] lancement du moteur impossible: %r" % (e,))
            raise
        return {"job_id": job_id, "already_running": False}


# ================================================================
#  ARRÊT
# ================================================================

def _signal_group(pid: Optional[int]) -> bool:
    """SIGTERM au GROUPE du moteur (``start_new_session=True`` : pgid == pid).

    Gardes : jamais ``pid <= 1`` (``killpg(0)`` viserait le groupe d'uvicorn
    lui-même, ``killpg(1)`` TOUS les process de l'utilisateur), jamais le
    process ni le groupe courants. Un pid déjà mort n'est pas une erreur : le
    moteur a pu finir entre-temps.
    """
    if not pid or pid <= 1:
        return False
    if pid in (os.getpid(), os.getpgrp()):
        logger.warning("[Scanner d'actions] pid %s = le backend lui-même : signal refusé", pid)
        return False
    try:
        os.killpg(pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError, OverflowError):
        return False
    return True


# ================================================================
#  PURGE
# ================================================================

def purge_old_runs(max_age_days: int = RUN_RETENTION_DAYS,
                   is_alive=_pid_alive) -> List[str]:
    """Supprime les vieux runs. Ne touche jamais un run VIVANT, ni le plus
    récent (sinon ``/latest`` se viderait après une longue absence)."""
    dirs = _run_dirs()
    if not dirs:
        return []
    keep_newest = dirs[0].name
    cutoff = time.time() - max_age_days * 86400
    purged = []  # type: List[str]
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
        _stock_jobs.pop(d.name, None)
        purged.append(d.name)
    return purged


# ================================================================
#  ENDPOINTS
# ================================================================

class RunRequest(BaseModel):
    """Config PARTIELLE d'un scan. Tout est optionnel : ``config.validate``
    tranche (bornes, marchés inconnus) et rend ses avertissements — une faute
    de frappe doit se VOIR, pas se perdre."""
    markets: Optional[List[str]] = None
    min_cap_meur: Optional[float] = None
    min_value_meur: Optional[float] = None
    window_h: Optional[int] = None
    top_n: Optional[int] = None
    shortlist: Optional[int] = None
    exclude_red: Optional[bool] = None
    lang: Optional[str] = None


def _payload(data: Optional[BaseModel]) -> Dict[str, Any]:
    """Champs RENSEIGNÉS du corps (``None`` = absent : ``validate`` met le
    défaut). Lus sur le modèle lui-même, pas sur une liste recopiée où un champ
    ajouté puis oublié serait perdu en silence (piège #61)."""
    if data is None:
        return {}
    dump = getattr(data, "model_dump", None) or data.dict   # pydantic v2, sinon v1
    return dict((k, v) for k, v in dump().items() if v is not None)


@router.get("/config")
def stocks_config(current_user: User = Depends(require_role("admin", "money"))):
    """Tout ce que le formulaire de réglages dessine, en un appel.

    Le catalogue et les bornes voyagent AVEC les défauts : l'UI ne code en dur
    ni la liste des marchés ni les bornes, qui vivraient sinon à deux endroits.
    """
    defaults, _warnings = scan_config.load_defaults()
    return {
        "defaults": defaults,
        "markets": scan_markets.catalogue(),
        "limits": dict((k, [lo, hi]) for k, (lo, hi) in scan_config.LIMITS.items()),
        "windows": list(scan_config.WINDOWS_H),
        "langs": list(scan_config.LANGS),
    }


@router.post("/run")
def stocks_run(data: Optional[RunRequest] = None,
               current_user: User = Depends(require_role("admin", "money"))):
    """Config partielle -> validée, scan lancé, PUIS enregistrée comme défauts.

    Ne lance JAMAIS un second scan par-dessus un scan vivant : on rend celui
    qui tourne (``already_running``). La demande n'a alors donné lieu à AUCUN
    scan, donc elle ne laisse aucune trace :

    - ses réglages ne deviennent pas les défauts : ceux-ci suivent le dernier
      scan réellement LANCÉ, pas le dernier clic (un lancement raté non plus) ;
    - la réponse décrit le scan VIVANT, pas la demande : ``config`` est son
      ``config.json`` tel qu'écrit à son lancement (``None`` s'il est absent
      ou illisible) et ``warnings`` est vide, car les avertissements d'une
      demande refusée ne décrivent aucun scan. L'UI fusionne ``config`` dans
      ses réglages puis affiche ``warnings`` : avec ceux de la demande, elle
      montrerait des réglages et des avertissements qui ne correspondent à
      aucun scan.
    """
    clean, warnings = scan_config.validate(_payload(data))
    try:
        started = _start_run(current_user.username, clean)
    except Exception as e:  # noqa: BLE001 — déjà journalisé par _start_run
        raise HTTPException(status_code=500,
                            detail="Lancement du scan impossible (voir le journal du serveur)"
                            ) from e
    if started["already_running"]:
        return {"job_id": started["job_id"], "already_running": True,
                "warnings": [], "config": _run_config(started["job_id"])}
    try:
        # Le dernier réglage lancé devient le réglage proposé la fois suivante.
        scan_config.save_defaults(clean)
    except OSError as e:
        # Confort seulement : le scan est déjà parti, un disque capricieux ne
        # doit pas transformer son lancement en erreur.
        logger.warning("[Scanner d'actions] défauts non enregistrés: %r", e)
    return {"job_id": started["job_id"], "already_running": started["already_running"],
            "warnings": warnings, "config": clean}


@router.get("/status/{job_id}")
def stocks_status(job_id: str,
                  current_user: User = Depends(require_role("admin", "money"))):
    run_dir = _existing_run_dir(job_id)
    return {
        "job_id": job_id,
        "status": _status_from_disk(run_dir),
        "progress": _read_json(run_dir / "progress.json"),
        "logs": _log_tail(run_dir),
        "meta": _meta(run_dir),
        "files": _files_of(run_dir),
    }


@router.get("/active")
def stocks_active(current_user: User = Depends(require_role("admin", "money"))):
    """Le run le plus récent, QUEL QUE SOIT son statut — pour la reconnexion
    de l'UI. Le badge de l'onglet ne compte que ``status == "running"`` : un
    run terminé ne doit pas l'allumer (défaut du Bond Scanner)."""
    dirs = _run_dirs()
    if not dirs:
        return {"found": False}
    d = dirs[0]
    return {"found": True, "job_id": d.name, "status": _status_from_disk(d),
            "progress": _read_json(d / "progress.json"), "meta": _meta(d)}


@router.post("/stop/{job_id}")
def stocks_stop(job_id: str,
                current_user: User = Depends(require_role("admin", "money"))):
    """Arrêt : ``stop.flag`` (le moteur le lit entre deux étapes et sort en
    code 3) PUIS SIGTERM au groupe du moteur, pid lu sur le DISQUE.

    Le drapeau d'abord : si le moteur meurt sur le coup, le run doit déjà
    s'afficher « stopped » et non « error ».
    """
    run_dir = _existing_run_dir(job_id)
    try:
        (run_dir / "stop.flag").write_text("1", encoding="utf-8")
    except OSError as e:
        logger.warning("[Scanner d'actions] stop.flag du run %s non écrit: %r", job_id, e)
    _signal_group(_read_pid(run_dir))
    job = _stock_jobs.get(job_id)
    if job is not None:
        proc = job.get("process")
        if proc is not None:
            try:
                if proc.poll() is None:
                    proc.terminate()
            except OSError:
                pass
        job["status"] = "stopped"
    logger.info("[Scanner d'actions] scan %s arrêté par %s", job_id, current_user.username)
    return {"status": "stopped", "job_id": job_id}


@router.get("/results/{job_id}")
def stocks_results(job_id: str,
                   current_user: User = Depends(require_role("admin", "money"))):
    run_dir = _existing_run_dir(job_id)
    results = _read_json(run_dir / "results.json")
    if results is None:
        raise HTTPException(status_code=404, detail="Résultats introuvables")
    return results


@router.get("/latest")
def stocks_latest(current_user: User = Depends(require_role("admin", "money"))):
    """Le dernier scan qui a des résultats LISIBLES.

    On saute les runs sans ``results.json`` (ou avec un fichier à moitié
    écrit) : un scan en cours ne doit pas vider la page des résultats
    précédents.
    """
    for d in _run_dirs():
        results = _read_json(d / "results.json")
        if results is None:
            continue
        return {
            "job_id": d.name,
            "status": _status_from_disk(d),
            "ran_at": _meta(d).get("created_at") or _mtime_iso(d),
            "results": results,
        }
    return {"job_id": None, "status": None, "ran_at": None, "results": None}


@router.get("/download/{job_id}")
def stocks_download(job_id: str,
                    current_user: User = Depends(require_role("admin", "money"))):
    run_dir = _existing_run_dir(job_id)
    name = _excel_name(run_dir)
    if not name:
        raise HTTPException(status_code=404, detail="Classeur Excel introuvable")
    # Starlette compose lui-même ``attachment; filename="<nom>"`` — et la forme
    # RFC 5987 ``filename*=`` pour un nom non ASCII, là où un en-tête écrit à
    # la main lèverait UnicodeEncodeError (500).
    return FileResponse(path=str(run_dir / name), filename=name, media_type=_XLSX_MEDIA)
