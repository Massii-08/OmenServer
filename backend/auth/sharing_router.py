"""
Routes Sharing — Gestion du partage de ressources entre utilisateurs.

Permet au propriétaire d'un serveur ou d'un bot d'accorder l'accès
à d'autres utilisateurs avec un niveau de permissions spécifique.

Routes:
    POST   /api/sharing/grant                    → Accorder un accès
    DELETE /api/sharing/{id}                     → Révoquer un accès
    GET    /api/sharing/resource/{type}/{id}     → Lister les accès d'une ressource
    PUT    /api/sharing/{id}                     → Modifier le niveau d'accès
    GET    /api/sharing/users/search             → Rechercher un utilisateur
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session
from typing import Optional

from backend.database import get_db
from backend.auth.utils import get_current_user
from backend.auth.models import User
from backend.auth.shared_access import SharedAccess, VALID_ACCESS_LEVELS
from backend.auth.access_control import is_owner

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/sharing", tags=["Partage de ressources"])


# --- Schémas ---

class GrantAccessRequest(BaseModel):
    resource_type: str       # "server" ou "bot"
    resource_id: int         # ID de la ressource
    username: str            # Pseudo de l'utilisateur à inviter
    access_level: str = "start"  # "view_only", "start", "manage"


class UpdateAccessRequest(BaseModel):
    access_level: str        # "view_only", "start", "manage"


# --- Routes ---

@router.post("/grant")
def grant_access(
    data: GrantAccessRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Accorder l'accès à une ressource (réservé au propriétaire et admins)."""
    # Valider le type de ressource
    if data.resource_type not in ("server", "bot"):
        raise HTTPException(400, "Type de ressource invalide (server ou bot)")

    # Valider le niveau d'accès
    if data.access_level not in VALID_ACCESS_LEVELS:
        raise HTTPException(400, f"Niveau d'accès invalide. Valeurs: {', '.join(VALID_ACCESS_LEVELS)}")

    # Vérifier que l'utilisateur est propriétaire (ou admin)
    if not current_user.is_admin and not is_owner(current_user, data.resource_type, data.resource_id, db):
        raise HTTPException(403, "Seul le propriétaire peut partager cette ressource.")

    # Trouver l'utilisateur cible par pseudo
    target_user = db.query(User).filter(User.username == data.username).first()
    if not target_user:
        raise HTTPException(404, f"Utilisateur '{data.username}' non trouvé.")

    # Interdire de se partager à soi-même
    if target_user.id == current_user.id:
        raise HTTPException(400, "Tu ne peux pas te partager une ressource à toi-même.")

    # Vérifier si un accès existe déjà
    existing = db.query(SharedAccess).filter(
        SharedAccess.resource_type == data.resource_type,
        SharedAccess.resource_id == data.resource_id,
        SharedAccess.user_id == target_user.id,
    ).first()

    if existing:
        # Mettre à jour le niveau d'accès
        existing.access_level = data.access_level
        db.commit()
        logger.info(f"🔄 Accès mis à jour: {data.resource_type}#{data.resource_id} → {target_user.username} ({data.access_level})")
        return {"message": f"Accès de {target_user.username} mis à jour → {data.access_level}"}

    # Créer l'accès
    access = SharedAccess(
        resource_type=data.resource_type,
        resource_id=data.resource_id,
        user_id=target_user.id,
        access_level=data.access_level,
        granted_by=current_user.id,
    )
    db.add(access)
    db.commit()

    logger.info(f"✅ Accès accordé: {data.resource_type}#{data.resource_id} → {target_user.username} ({data.access_level})")
    return {
        "message": f"Accès accordé à {target_user.username} ({data.access_level})",
        "access_id": access.id,
    }


@router.get("/resource/{resource_type}/{resource_id}")
def list_resource_access(
    resource_type: str,
    resource_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Lister tous les utilisateurs ayant accès à une ressource."""
    if resource_type not in ("server", "bot"):
        raise HTTPException(400, "Type de ressource invalide")

    # Vérifier que l'utilisateur est propriétaire (ou admin)
    if not current_user.is_admin and not is_owner(current_user, resource_type, resource_id, db):
        raise HTTPException(403, "Seul le propriétaire peut voir les accès.")

    accesses = db.query(SharedAccess).filter(
        SharedAccess.resource_type == resource_type,
        SharedAccess.resource_id == resource_id,
    ).all()

    return [
        {
            "id": a.id,
            "user_id": a.user_id,
            "username": a.user.username if a.user else "?",
            "access_level": a.access_level,
            "granted_by": a.granter.username if a.granter else "?",
            "created_at": a.created_at.isoformat() if a.created_at else None,
        }
        for a in accesses
    ]


@router.put("/{access_id}")
def update_access(
    access_id: int,
    data: UpdateAccessRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Modifier le niveau d'accès d'un partage existant."""
    if data.access_level not in VALID_ACCESS_LEVELS:
        raise HTTPException(400, f"Niveau d'accès invalide. Valeurs: {', '.join(VALID_ACCESS_LEVELS)}")

    access = db.query(SharedAccess).filter(SharedAccess.id == access_id).first()
    if not access:
        raise HTTPException(404, "Accès non trouvé")

    # Vérifier que l'utilisateur est propriétaire (ou admin)
    if not current_user.is_admin and not is_owner(current_user, access.resource_type, access.resource_id, db):
        raise HTTPException(403, "Seul le propriétaire peut modifier les accès.")

    access.access_level = data.access_level
    db.commit()
    return {"message": f"Niveau d'accès mis à jour → {data.access_level}"}


@router.delete("/{access_id}")
def revoke_access(
    access_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Révoquer un accès partagé."""
    access = db.query(SharedAccess).filter(SharedAccess.id == access_id).first()
    if not access:
        raise HTTPException(404, "Accès non trouvé")

    # Vérifier que l'utilisateur est propriétaire (ou admin)
    if not current_user.is_admin and not is_owner(current_user, access.resource_type, access.resource_id, db):
        raise HTTPException(403, "Seul le propriétaire peut révoquer un accès.")

    username = access.user.username if access.user else "?"
    db.delete(access)
    db.commit()

    logger.info(f"❌ Accès révoqué: {access.resource_type}#{access.resource_id} ← {username}")
    return {"message": f"Accès de {username} révoqué"}


@router.get("/users/search")
def search_users(
    q: str = Query(..., min_length=1, description="Rechercher un utilisateur par pseudo"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Rechercher un utilisateur par pseudo (pour le partage)."""
    users = db.query(User).filter(
        User.username.ilike(f"%{q}%"),
        User.id != current_user.id,  # Exclure soi-même
    ).limit(10).all()

    return [
        {
            "id": u.id,
            "username": u.username,
            "role": u.role or "player",
        }
        for u in users
    ]
