"""
Routes de sauvegarde des serveurs de jeux.

Routes:
    POST   /api/servers/{id}/backup         → Créer une sauvegarde manuelle
    GET    /api/servers/{id}/backups         → Lister les sauvegardes (auto + manual)
    POST   /api/servers/{id}/restore/{bid}   → Restaurer une sauvegarde
    PUT    /api/servers/{id}/backups/{bid}    → Renommer une sauvegarde
    DELETE /api/servers/{id}/backups/{bid}    → Supprimer une sauvegarde
"""

from fastapi import APIRouter, Depends, HTTPException, status, Query
from pydantic import BaseModel
from typing import Optional
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.auth.models import User
from backend.auth.utils import get_current_user
from backend.auth.access_control import can_access_resource
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
    """Créer une sauvegarde manuelle du serveur avec un nom optionnel."""
    server = _get_server(server_id, db)

    # RBAC : seul le propriétaire ou un admin peut créer des backups
    if not can_access_resource(current_user, "server", server_id, db, min_level="manage"):
        raise HTTPException(status_code=403, detail="Tu n'as pas le droit de sauvegarder ce serveur.")

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
            backup_type="manual",
        )
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
    """Lister toutes les sauvegardes d'un serveur (auto + manual séparés)."""
    _get_server(server_id, db)  # Vérifier que le serveur existe

    auto_backups = backup_manager.list_backups(server_id, backup_type="auto")
    manual_backups = backup_manager.list_backups(server_id, backup_type="manual")

    return {
        "auto": auto_backups,
        "manual": manual_backups,
        "auto_count": len(auto_backups),
        "manual_count": len(manual_backups),
        "count": len(auto_backups) + len(manual_backups),
    }


@router.post("/{server_id}/restore/{backup_id}")
def restore_backup(
    server_id: int,
    backup_id: str,
    backup_type: str = Query(default="manual"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Restaurer une sauvegarde (le serveur doit être arrêté)."""
    server = _get_server(server_id, db)

    # RBAC : seul le propriétaire ou un admin peut restaurer
    if not can_access_resource(current_user, "server", server_id, db, min_level="manage"):
        raise HTTPException(status_code=403, detail="Tu n'as pas le droit de restaurer sur ce serveur.")

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
            backup_type=backup_type,
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
    backup_type: str = Query(default="manual"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Renommer une sauvegarde."""
    _get_server(server_id, db)

    # RBAC : seul le propriétaire ou un admin peut renommer
    if not can_access_resource(current_user, "server", server_id, db, min_level="manage"):
        raise HTTPException(status_code=403, detail="Tu n'as pas le droit de modifier les sauvegardes de ce serveur.")

    try:
        result = backup_manager.rename_backup(server_id, backup_id, request.new_name, backup_type=backup_type)
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
    backup_type: str = Query(default="manual"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Supprimer une sauvegarde."""
    _get_server(server_id, db)

    # RBAC : seul le propriétaire ou un admin peut supprimer
    if not can_access_resource(current_user, "server", server_id, db, min_level="manage"):
        raise HTTPException(status_code=403, detail="Tu n'as pas le droit de supprimer les sauvegardes de ce serveur.")

    try:
        backup_manager.delete_backup(server_id, backup_id, backup_type=backup_type)
        return {"message": f"Sauvegarde supprimée ✅"}
    except RuntimeError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )
