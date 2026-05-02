"""
Routes de sauvegarde des serveurs de jeux.

Routes:
    POST   /api/servers/{id}/backup         → Créer une sauvegarde
    GET    /api/servers/{id}/backups         → Lister les sauvegardes
    POST   /api/servers/{id}/restore/{bid}   → Restaurer une sauvegarde
    PUT    /api/servers/{id}/backups/{bid}    → Renommer une sauvegarde
    DELETE /api/servers/{id}/backups/{bid}    → Supprimer une sauvegarde
"""

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from typing import Optional
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.auth.models import User
from backend.auth.utils import get_current_user
from backend.game_server.models import GameServer
from backend.game_server import backup_manager

router = APIRouter(prefix="/api/servers", tags=["Sauvegardes"])


class CreateBackupRequest(BaseModel):
    backup_name: Optional[str] = None


class RenameBackupRequest(BaseModel):
    new_name: str


def _get_server(server_id: int, db: Session) -> GameServer:
    """Récupère un serveur ou lève une 404."""
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Serveur non trouvé"
        )
    return server


@router.post("/{server_id}/backup")
def create_backup(
    server_id: int,
    request: Optional[CreateBackupRequest] = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Créer une sauvegarde du serveur avec un nom optionnel."""
    server = _get_server(server_id, db)

    if not server.docker_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Ce serveur n'a pas de conteneur Docker associé"
        )

    custom_name = request.backup_name if request else None

    try:
        backup = backup_manager.create_backup(
            server_id=server.id,
            server_name=server.name,
            docker_id=server.docker_id,
            custom_name=custom_name,
        )
        # Rotation automatique : garder les 10 dernières
        backup_manager.cleanup_old_backups(server_id, keep=10)
        return backup
    except RuntimeError as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


@router.get("/{server_id}/backups")
def list_backups(
    server_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Lister toutes les sauvegardes d'un serveur."""
    _get_server(server_id, db)  # Vérifier que le serveur existe
    backups = backup_manager.list_backups(server_id)
    return {"backups": backups, "count": len(backups)}


@router.post("/{server_id}/restore/{backup_id}")
def restore_backup(
    server_id: int,
    backup_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Restaurer une sauvegarde (le serveur doit être arrêté)."""
    server = _get_server(server_id, db)

    if not server.docker_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Ce serveur n'a pas de conteneur Docker associé"
        )

    try:
        backup_manager.restore_backup(
            server_id=server.id,
            backup_id=backup_id,
            docker_id=server.docker_id,
        )
        return {"message": f"Sauvegarde '{backup_id}' restaurée avec succès ✅"}
    except RuntimeError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )


@router.put("/{server_id}/backups/{backup_id}")
def rename_backup(
    server_id: int,
    backup_id: str,
    request: RenameBackupRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Renommer une sauvegarde."""
    _get_server(server_id, db)

    try:
        result = backup_manager.rename_backup(server_id, backup_id, request.new_name)
        return result
    except RuntimeError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )


@router.delete("/{server_id}/backups/{backup_id}")
def delete_backup(
    server_id: int,
    backup_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Supprimer une sauvegarde."""
    _get_server(server_id, db)

    try:
        backup_manager.delete_backup(server_id, backup_id)
        return {"message": f"Sauvegarde supprimée ✅"}
    except RuntimeError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )
