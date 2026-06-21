"""
Routes Joueurs — Gestion ops, whitelist et bans via les fichiers JSON.

Lit et écrit dans ops.json, whitelist.json et banned-players.json
directement dans le conteneur Docker du serveur.

Routes:
    GET    /api/servers/{id}/players/ops        → Liste des opérateurs
    POST   /api/servers/{id}/players/ops        → Ajouter un opérateur
    DELETE /api/servers/{id}/players/ops/{name}  → Retirer un opérateur
    GET    /api/servers/{id}/players/whitelist
    POST   /api/servers/{id}/players/whitelist
    DELETE /api/servers/{id}/players/whitelist/{name}
    GET    /api/servers/{id}/players/banned
    POST   /api/servers/{id}/players/banned
    DELETE /api/servers/{id}/players/banned/{name}
"""

import json
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.auth.utils import get_current_user
from backend.auth.models import User
from backend.auth.access_control import require_resource_access
from backend.game_server.models import GameServer
from backend.game_server.settings_router import _docker_exec, _docker_write, _get_server_or_404

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/servers", tags=["Joueurs"])


class PlayerRequest(BaseModel):
    """Ajout d'un joueur par nom."""
    name: str


class BanRequest(BaseModel):
    """Bannir un joueur avec une raison."""
    name: str
    reason: str = "Banned by OmenServer"


# --- Helpers ---

# Chemins des fichiers dans le conteneur
FILES = {
    "ops": "/data/ops.json",
    "whitelist": "/data/whitelist.json",
    "banned": "/data/banned-players.json",
}


def _read_player_file(docker_id: str, file_type: str) -> list:
    """Lit un fichier JSON de joueurs depuis le conteneur."""
    path = FILES[file_type]
    try:
        raw = _docker_exec(docker_id, f"cat {path} 2>/dev/null || echo '[]'")
        raw = raw.strip()
        if not raw or raw == "":
            return []
        return json.loads(raw)
    except (json.JSONDecodeError, RuntimeError):
        return []


def _write_player_file(docker_id: str, file_type: str, data: list):
    """Écrit un fichier JSON de joueurs dans le conteneur."""
    path = FILES[file_type]
    content = json.dumps(data, indent=2)
    _docker_write(docker_id, path, content)


# --- Routes Opérateurs ---

@router.get("/{server_id}/players/ops")
def get_ops(
    server_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Liste des opérateurs du serveur."""
    require_resource_access(current_user, "server", server_id, db, min_level="view_only")
    server = _get_server_or_404(server_id, db)
    players = _read_player_file(server.docker_id, "ops")
    return {"players": players}


@router.post("/{server_id}/players/ops")
def add_op(
    server_id: int,
    request: PlayerRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Ajouter un opérateur."""
    require_resource_access(current_user, "server", server_id, db, min_level="manage")
    server = _get_server_or_404(server_id, db)
    players = _read_player_file(server.docker_id, "ops")

    # Vérifier si déjà op
    if any(p.get("name", "").lower() == request.name.lower() for p in players):
        raise HTTPException(status_code=400, detail="Ce joueur est déjà opérateur")

    players.append({
        "uuid": "00000000-0000-0000-0000-000000000000",
        "name": request.name,
        "level": 4,
        "bypassesPlayerLimit": False,
    })
    _write_player_file(server.docker_id, "ops", players)
    return {"message": f"{request.name} ajouté comme opérateur"}


@router.delete("/{server_id}/players/ops/{name}")
def remove_op(
    server_id: int,
    name: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Retirer un opérateur."""
    require_resource_access(current_user, "server", server_id, db, min_level="manage")
    server = _get_server_or_404(server_id, db)
    players = _read_player_file(server.docker_id, "ops")
    players = [p for p in players if p.get("name", "").lower() != name.lower()]
    _write_player_file(server.docker_id, "ops", players)
    return {"message": f"{name} retiré des opérateurs"}


# --- Routes Whitelist ---

@router.get("/{server_id}/players/whitelist")
def get_whitelist(
    server_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Liste blanche du serveur."""
    require_resource_access(current_user, "server", server_id, db, min_level="view_only")
    server = _get_server_or_404(server_id, db)
    players = _read_player_file(server.docker_id, "whitelist")
    return {"players": players}


@router.post("/{server_id}/players/whitelist")
def add_whitelist(
    server_id: int,
    request: PlayerRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Ajouter un joueur à la whitelist."""
    require_resource_access(current_user, "server", server_id, db, min_level="manage")
    server = _get_server_or_404(server_id, db)
    players = _read_player_file(server.docker_id, "whitelist")

    if any(p.get("name", "").lower() == request.name.lower() for p in players):
        raise HTTPException(status_code=400, detail="Ce joueur est déjà dans la whitelist")

    players.append({
        "uuid": "00000000-0000-0000-0000-000000000000",
        "name": request.name,
    })
    _write_player_file(server.docker_id, "whitelist", players)
    return {"message": f"{request.name} ajouté à la whitelist"}


@router.delete("/{server_id}/players/whitelist/{name}")
def remove_whitelist(
    server_id: int,
    name: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Retirer un joueur de la whitelist."""
    require_resource_access(current_user, "server", server_id, db, min_level="manage")
    server = _get_server_or_404(server_id, db)
    players = _read_player_file(server.docker_id, "whitelist")
    players = [p for p in players if p.get("name", "").lower() != name.lower()]
    _write_player_file(server.docker_id, "whitelist", players)
    return {"message": f"{name} retiré de la whitelist"}


# --- Routes Bannis ---

@router.get("/{server_id}/players/banned")
def get_banned(
    server_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Liste des joueurs bannis."""
    require_resource_access(current_user, "server", server_id, db, min_level="view_only")
    server = _get_server_or_404(server_id, db)
    players = _read_player_file(server.docker_id, "banned")
    return {"players": players}


@router.post("/{server_id}/players/banned")
def ban_player(
    server_id: int,
    request: BanRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Bannir un joueur."""
    require_resource_access(current_user, "server", server_id, db, min_level="manage")
    server = _get_server_or_404(server_id, db)
    players = _read_player_file(server.docker_id, "banned")

    if any(p.get("name", "").lower() == request.name.lower() for p in players):
        raise HTTPException(status_code=400, detail="Ce joueur est déjà banni")

    players.append({
        "uuid": "00000000-0000-0000-0000-000000000000",
        "name": request.name,
        "reason": request.reason,
        "source": "OmenServer",
    })
    _write_player_file(server.docker_id, "banned", players)
    return {"message": f"{request.name} banni du serveur"}


@router.delete("/{server_id}/players/banned/{name}")
def unban_player(
    server_id: int,
    name: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Débannir un joueur."""
    require_resource_access(current_user, "server", server_id, db, min_level="manage")
    server = _get_server_or_404(server_id, db)
    players = _read_player_file(server.docker_id, "banned")
    players = [p for p in players if p.get("name", "").lower() != name.lower()]
    _write_player_file(server.docker_id, "banned", players)
    return {"message": f"{name} débanni"}
