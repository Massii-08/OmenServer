"""
Routes Historique — Journalisation des actions utilisateur.

Enregistre et consulte l'historique d'activité du serveur.

Routes:
    GET  /api/servers/{id}/activity    → Liste paginée des actions
    POST /api/servers/{id}/activity    → Ajouter une entrée (usage interne)
"""

import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.auth.utils import get_current_user
from backend.auth.models import User
from backend.game_server.models import GameServer

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/servers", tags=["Historique"])

# Stockage en mémoire (sera migré en DB plus tard si besoin)
_activity_store: dict = {}  # server_id -> [entries]


class ActivityEntry(BaseModel):
    action: str
    details: str = ""


def log_activity(server_id: int, username: str, action: str, details: str = ""):
    """Ajoute une entrée dans l'historique (appelable depuis d'autres routers)."""
    if server_id not in _activity_store:
        _activity_store[server_id] = []
    _activity_store[server_id].insert(0, {
        "timestamp": datetime.now().isoformat(),
        "username": username,
        "action": action,
        "details": details,
    })
    # Garder max 200 entrées
    if len(_activity_store[server_id]) > 200:
        _activity_store[server_id] = _activity_store[server_id][:200]


@router.get("/{server_id}/activity")
def get_activity(
    server_id: int,
    limit: int = Query(50, ge=1, le=200),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Retourne l'historique d'activité du serveur."""
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")

    entries = _activity_store.get(server_id, [])
    return {"entries": entries[:limit], "total": len(entries)}


@router.post("/{server_id}/activity")
def add_activity(
    server_id: int,
    entry: ActivityEntry,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Ajouter une entrée manuellement."""
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")

    log_activity(server_id, current_user.username, entry.action, entry.details)
    return {"message": "Entrée ajoutée"}
