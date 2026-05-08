"""
Routes Bots — CRUD et exécution de bots Python.

Routes:
    GET    /api/bots              → Lister tous les bots
    POST   /api/bots              → Créer un bot
    GET    /api/bots/{id}         → Détails d'un bot
    PUT    /api/bots/{id}         → Modifier un bot
    DELETE /api/bots/{id}         → Supprimer un bot
    POST   /api/bots/{id}/start   → Démarrer un bot
    POST   /api/bots/{id}/stop    → Arrêter un bot
    GET    /api/bots/{id}/logs    → Logs du bot
    GET    /api/bots/{id}/code    → Lire le code source
    PUT    /api/bots/{id}/code    → Sauvegarder le code source
"""

import os
import signal
import subprocess
import logging
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional

from backend.database import get_db
from backend.auth.utils import get_current_user
from backend.auth.models import User
from backend.bots.models import Bot

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/bots", tags=["Bots"])

# Dossier de stockage des bots
_home = Path.home()
BOTS_DIR = Path(os.environ.get("BOTS_DIR", str(_home / "omenserver" / "bots")))

# Stockage des processus en mémoire
_bot_processes: dict[int, subprocess.Popen] = {}
# Stockage des logs en mémoire (dernières 200 lignes par bot)
_bot_logs: dict[int, list] = {}
# Dossier de logs persistants
LOGS_DIR = BOTS_DIR / "logs"


class BotCreate(BaseModel):
    name: str
    description: str = ""
    bot_type: str = "custom"
    code: str = "# Mon bot Python\nimport time\n\nwhile True:\n    print('Bot en cours...')\n    time.sleep(10)\n"


class BotUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    bot_type: Optional[str] = None
    auto_restart: Optional[bool] = None


@router.get("")
def list_bots(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Liste tous les bots."""
    bots = db.query(Bot).order_by(Bot.created_at.desc()).all()

    # Mettre à jour les statuts des bots
    result = []
    for b in bots:
        status = b.status
        if b.id in _bot_processes:
            proc = _bot_processes[b.id]
            if proc.poll() is not None:
                # Le process est terminé
                status = "error" if proc.returncode != 0 else "stopped"
                del _bot_processes[b.id]
                b.status = status
                b.pid = None
                db.commit()

        result.append({
            "id": b.id,
            "name": b.name,
            "description": b.description,
            "bot_type": b.bot_type,
            "status": status,
            "auto_restart": b.auto_restart,
            "created_at": b.created_at.isoformat() if b.created_at else None,
            "last_run": b.last_run.isoformat() if b.last_run else None,
            "last_error": b.last_error,
        })
    return result


@router.post("")
def create_bot(
    data: BotCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Créer un nouveau bot."""
    # Créer le dossier de stockage
    BOTS_DIR.mkdir(parents=True, exist_ok=True)

    # Créer le bot en DB
    bot = Bot(
        name=data.name,
        description=data.description,
        bot_type=data.bot_type,
        script_path=f"bot_{int(datetime.utcnow().timestamp())}.py",
    )
    db.add(bot)
    db.commit()
    db.refresh(bot)

    # Écrire le fichier script
    script_file = BOTS_DIR / bot.script_path
    script_file.write_text(data.code, encoding="utf-8")

    return {"id": bot.id, "name": bot.name, "message": "Bot créé"}


@router.get("/{bot_id}")
def get_bot(
    bot_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Détails d'un bot."""
    bot = db.query(Bot).filter(Bot.id == bot_id).first()
    if not bot:
        raise HTTPException(404, "Bot non trouvé")
    return {
        "id": bot.id, "name": bot.name, "description": bot.description,
        "bot_type": bot.bot_type, "status": bot.status,
        "auto_restart": bot.auto_restart, "script_path": bot.script_path,
        "created_at": bot.created_at.isoformat() if bot.created_at else None,
        "last_run": bot.last_run.isoformat() if bot.last_run else None,
        "last_error": bot.last_error,
    }


@router.put("/{bot_id}")
def update_bot(
    bot_id: int,
    data: BotUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Modifier un bot."""
    bot = db.query(Bot).filter(Bot.id == bot_id).first()
    if not bot:
        raise HTTPException(404, "Bot non trouvé")

    if data.name is not None:
        bot.name = data.name
    if data.description is not None:
        bot.description = data.description
    if data.bot_type is not None:
        bot.bot_type = data.bot_type
    if data.auto_restart is not None:
        bot.auto_restart = data.auto_restart

    db.commit()
    return {"message": "Bot mis à jour"}


@router.delete("/{bot_id}")
def delete_bot(
    bot_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Supprimer un bot (arrête d'abord si running)."""
    bot = db.query(Bot).filter(Bot.id == bot_id).first()
    if not bot:
        raise HTTPException(404, "Bot non trouvé")

    # Arrêter si en cours
    if bot_id in _bot_processes:
        try:
            _bot_processes[bot_id].terminate()
            del _bot_processes[bot_id]
        except Exception:
            pass

    # Supprimer le fichier
    script_file = BOTS_DIR / bot.script_path
    if script_file.exists():
        script_file.unlink()

    db.delete(bot)
    db.commit()
    return {"message": "Bot supprimé"}


# --- Fonctions helper (appelables par le scheduler) ---

def _start_bot_process(bot: Bot, db: Session):
    """Démarrer un bot (sans passer par l'API auth). Utilisé par le scheduler."""
    import threading

    if bot.id in _bot_processes and _bot_processes[bot.id].poll() is None:
        return  # Déjà en cours

    script_file = BOTS_DIR / bot.script_path
    if not script_file.exists():
        logger.error(f"Script bot introuvable: {script_file}")
        return

    _bot_logs[bot.id] = []

    proc = subprocess.Popen(
        ["python3", str(script_file)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        cwd=str(BOTS_DIR),
    )
    _bot_processes[bot.id] = proc
    bot.status = "running"
    bot.pid = proc.pid
    bot.last_run = datetime.utcnow()
    bot.last_error = None
    db.commit()

    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    log_file = LOGS_DIR / f"bot_{bot.id}.log"

    def _capture_logs(pid, proc, bot_id, log_file):
        try:
            with open(log_file, "a", encoding="utf-8") as fh:
                for line in proc.stdout:
                    stripped = line.rstrip()
                    if bot_id not in _bot_logs:
                        _bot_logs[bot_id] = []
                    _bot_logs[bot_id].append(stripped)
                    if len(_bot_logs[bot_id]) > 200:
                        _bot_logs[bot_id] = _bot_logs[bot_id][-200:]
                    fh.write(stripped + "\n")
                    fh.flush()
        except Exception:
            pass

    t = threading.Thread(target=_capture_logs, args=(proc.pid, proc, bot.id, log_file), daemon=True)
    t.start()


def _stop_bot_process(bot: Bot, db: Session):
    """Arrêter un bot (sans passer par l'API auth). Utilisé par le scheduler."""
    if bot.id in _bot_processes:
        proc = _bot_processes[bot.id]
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        del _bot_processes[bot.id]

    bot.status = "stopped"
    bot.pid = None
    db.commit()



@router.post("/{bot_id}/start")
def start_bot(
    bot_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Démarrer un bot."""
    bot = db.query(Bot).filter(Bot.id == bot_id).first()
    if not bot:
        raise HTTPException(404, "Bot non trouvé")

    if bot_id in _bot_processes and _bot_processes[bot_id].poll() is None:
        raise HTTPException(400, "Bot déjà en cours d'exécution")

    script_file = BOTS_DIR / bot.script_path
    if not script_file.exists():
        raise HTTPException(404, "Script introuvable")

    try:
        # Initialiser les logs
        _bot_logs[bot_id] = []

        proc = subprocess.Popen(
            ["python3", str(script_file)],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            cwd=str(BOTS_DIR),
        )
        _bot_processes[bot_id] = proc
        bot.status = "running"
        bot.pid = proc.pid
        bot.last_run = datetime.utcnow()
        bot.last_error = None
        db.commit()

        # Lancer un thread pour capturer les logs
        import threading
        LOGS_DIR.mkdir(parents=True, exist_ok=True)
        log_file = LOGS_DIR / f"bot_{bot_id}.log"

        def _capture_logs(pid, proc, bot_id, log_file):
            try:
                with open(log_file, "a", encoding="utf-8") as fh:
                    for line in proc.stdout:
                        stripped = line.rstrip()
                        if bot_id not in _bot_logs:
                            _bot_logs[bot_id] = []
                        _bot_logs[bot_id].append(stripped)
                        if len(_bot_logs[bot_id]) > 200:
                            _bot_logs[bot_id] = _bot_logs[bot_id][-200:]
                        fh.write(stripped + "\n")
                        fh.flush()
            except Exception:
                pass
        t = threading.Thread(target=_capture_logs, args=(proc.pid, proc, bot_id, log_file), daemon=True)
        t.start()

        return {"message": f"Bot '{bot.name}' démarré (PID {proc.pid})"}
    except Exception as e:
        bot.status = "error"
        bot.last_error = str(e)
        db.commit()
        raise HTTPException(500, f"Erreur au démarrage: {e}")


@router.post("/{bot_id}/stop")
def stop_bot(
    bot_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Arrêter un bot."""
    bot = db.query(Bot).filter(Bot.id == bot_id).first()
    if not bot:
        raise HTTPException(404, "Bot non trouvé")

    if bot_id in _bot_processes:
        proc = _bot_processes[bot_id]
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        del _bot_processes[bot_id]

    bot.status = "stopped"
    bot.pid = None
    db.commit()
    return {"message": f"Bot '{bot.name}' arrêté"}


@router.get("/{bot_id}/logs")
def get_bot_logs(
    bot_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Récupérer les logs d'un bot."""
    bot = db.query(Bot).filter(Bot.id == bot_id).first()
    if not bot:
        raise HTTPException(404, "Bot non trouvé")

    logs = _bot_logs.get(bot_id, [])
    # Fallback: charger depuis le fichier si mémoire vide
    if not logs:
        log_file = LOGS_DIR / f"bot_{bot_id}.log"
        if log_file.exists():
            lines = log_file.read_text(encoding="utf-8").splitlines()
            logs = lines[-200:]  # Dernières 200 lignes
    return {"logs": logs, "count": len(logs)}


@router.get("/{bot_id}/code")
def get_bot_code(
    bot_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Lire le code source d'un bot."""
    bot = db.query(Bot).filter(Bot.id == bot_id).first()
    if not bot:
        raise HTTPException(404, "Bot non trouvé")

    script_file = BOTS_DIR / bot.script_path
    if not script_file.exists():
        return {"code": "# Fichier introuvable\n"}

    return {"code": script_file.read_text(encoding="utf-8")}


@router.put("/{bot_id}/code")
def save_bot_code(
    bot_id: int,
    data: dict,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Sauvegarder le code source d'un bot."""
    bot = db.query(Bot).filter(Bot.id == bot_id).first()
    if not bot:
        raise HTTPException(404, "Bot non trouvé")

    code = data.get("code", "")
    BOTS_DIR.mkdir(parents=True, exist_ok=True)
    script_file = BOTS_DIR / bot.script_path
    script_file.write_text(code, encoding="utf-8")

    return {"message": "Code sauvegardé"}
