"""
Routes d'invitation — Permet aux admins d'inviter des joueurs.

Flux:
1. L'admin génère un code d'invitation (ex: "aB3kXz9m")
2. L'admin partage le lien: http://serveur:8000/login?invite=aB3kXz9m
3. Le joueur ouvre le lien → formulaire d'inscription avec le code pré-rempli
4. Le joueur crée son compte → rôle assigné automatiquement

Routes:
    POST   /api/auth/invitations       → Créer une invitation (admin only)
    GET    /api/auth/invitations       → Lister les invitations (admin only)
    DELETE /api/auth/invitations/{id}  → Supprimer une invitation (admin only)
    POST   /api/auth/join/{code}       → Créer un compte avec un code d'invitation
    GET    /api/auth/invite-info/{code} → Vérifier si un code est valide
    GET    /api/auth/users             → Lister les utilisateurs (admin only)
    PUT    /api/auth/users/{id}/role   → Changer le rôle d'un utilisateur (admin only)
    DELETE /api/auth/users/{id}        → Supprimer un utilisateur (admin only)
"""

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.auth.models import User, Invitation
from backend.auth.utils import get_current_user, hash_password, create_access_token
from backend.auth.permissions import VALID_ROLES, ROLE_NAMES

router = APIRouter(prefix="/api/auth", tags=["Invitations & Utilisateurs"])


# --- Schémas ---

class CreateInvitationRequest(BaseModel):
    role: str = "player"
    max_uses: int = 1

class JoinRequest(BaseModel):
    username: str
    password: str

class ChangeRoleRequest(BaseModel):
    role: str


# --- Invitations ---

@router.post("/invitations")
def create_invitation(
    request: CreateInvitationRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Créer une invitation (admin uniquement)."""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Réservé aux administrateurs")

    if request.role not in VALID_ROLES or request.role == "admin":
        raise HTTPException(
            status_code=400,
            detail=f"Rôle invalide. Choix possibles: {', '.join(r for r in VALID_ROLES if r != 'admin')}"
        )

    invitation = Invitation(
        role=request.role,
        created_by=current_user.id,
        max_uses=max(1, request.max_uses),
    )
    db.add(invitation)
    db.commit()
    db.refresh(invitation)

    return {
        "id": invitation.id,
        "code": invitation.code,
        "role": invitation.role,
        "role_name": ROLE_NAMES.get(invitation.role, invitation.role),
        "max_uses": invitation.max_uses,
        "uses": 0,
        "created_at": invitation.created_at.strftime("%d/%m/%Y %H:%M"),
    }


@router.get("/invitations")
def list_invitations(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Lister toutes les invitations (admin uniquement)."""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Réservé aux administrateurs")

    invitations = db.query(Invitation).order_by(Invitation.created_at.desc()).all()

    return {
        "invitations": [
            {
                "id": inv.id,
                "code": inv.code,
                "role": inv.role,
                "role_name": ROLE_NAMES.get(inv.role, inv.role),
                "max_uses": inv.max_uses,
                "uses": inv.uses,
                "is_used": inv.uses >= inv.max_uses,
                "created_at": inv.created_at.strftime("%d/%m/%Y %H:%M"),
            }
            for inv in invitations
        ]
    }


@router.delete("/invitations/{invitation_id}")
def delete_invitation(
    invitation_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Supprimer une invitation (admin uniquement)."""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Réservé aux administrateurs")

    invitation = db.query(Invitation).filter(Invitation.id == invitation_id).first()
    if not invitation:
        raise HTTPException(status_code=404, detail="Invitation non trouvée")

    db.delete(invitation)
    db.commit()
    return {"message": "Invitation supprimée ✅"}


@router.get("/invite-info/{code}")
def get_invite_info(code: str, db: Session = Depends(get_db)):
    """Vérifier si un code d'invitation est valide (public)."""
    invitation = db.query(Invitation).filter(Invitation.code == code).first()

    if not invitation:
        raise HTTPException(status_code=404, detail="Code d'invitation invalide")

    if invitation.uses >= invitation.max_uses:
        raise HTTPException(status_code=410, detail="Cette invitation a déjà été utilisée")

    return {
        "valid": True,
        "role": invitation.role,
        "role_name": ROLE_NAMES.get(invitation.role, invitation.role),
    }


@router.post("/join/{code}")
def join_with_invite(
    code: str,
    request: JoinRequest,
    db: Session = Depends(get_db),
):
    """
    Créer un compte avec un code d'invitation.
    Le rôle est assigné automatiquement selon l'invitation.
    """
    # Vérifier le code
    invitation = db.query(Invitation).filter(Invitation.code == code).first()
    if not invitation:
        raise HTTPException(status_code=404, detail="Code d'invitation invalide")

    if invitation.uses >= invitation.max_uses:
        raise HTTPException(status_code=410, detail="Cette invitation a déjà été utilisée")

    # Vérifier le username
    if not request.username or len(request.username) < 2:
        raise HTTPException(status_code=400, detail="Le nom d'utilisateur doit faire au moins 2 caractères")

    existing = db.query(User).filter(User.username == request.username).first()
    if existing:
        raise HTTPException(status_code=400, detail="Ce nom d'utilisateur est déjà pris")

    if len(request.password) < 8:
        raise HTTPException(status_code=400, detail="Le mot de passe doit faire au moins 8 caractères")

    # Créer le compte
    new_user = User(
        username=request.username,
        hashed_password=hash_password(request.password),
        is_admin=False,
        role=invitation.role,
        invited_by=invitation.created_by,
    )
    db.add(new_user)

    # Marquer l'invitation comme utilisée
    invitation.uses += 1
    invitation.used_by = new_user.id
    invitation.used_at = datetime.now(timezone.utc)

    db.commit()
    db.refresh(new_user)

    # Créer le token
    access_token = create_access_token(data={"sub": new_user.username})

    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": {
            "id": new_user.id,
            "username": new_user.username,
            "is_admin": new_user.is_admin,
            "role": new_user.role,
        }
    }


# --- Gestion des utilisateurs ---

@router.get("/users")
def list_users(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Lister tous les utilisateurs (admin uniquement)."""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Réservé aux administrateurs")

    users = db.query(User).order_by(User.created_at.asc()).all()
    return {
        "users": [
            {
                "id": u.id,
                "username": u.username,
                "is_admin": u.is_admin,
                "role": getattr(u, 'role', 'player') or 'player',
                "role_name": ROLE_NAMES.get(getattr(u, 'role', 'player') or 'player', 'Joueur'),
                "created_at": u.created_at.strftime("%d/%m/%Y %H:%M") if u.created_at else "",
            }
            for u in users
        ]
    }


@router.put("/users/{user_id}/role")
def change_user_role(
    user_id: int,
    request: ChangeRoleRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Changer le rôle d'un utilisateur (admin uniquement)."""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Réservé aux administrateurs")

    if request.role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail=f"Rôle invalide: {request.role}")

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Utilisateur non trouvé")

    if user.id == current_user.id:
        raise HTTPException(status_code=400, detail="Tu ne peux pas changer ton propre rôle")

    user.role = request.role
    user.is_admin = (request.role == "admin")
    db.commit()

    return {
        "message": f"Rôle de '{user.username}' changé en {ROLE_NAMES.get(request.role)} ✅",
        "user": {
            "id": user.id,
            "username": user.username,
            "role": user.role,
            "is_admin": user.is_admin,
        }
    }


@router.delete("/users/{user_id}")
def delete_user(
    user_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Supprimer un utilisateur (admin uniquement)."""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Réservé aux administrateurs")

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Utilisateur non trouvé")

    if user.id == current_user.id:
        raise HTTPException(status_code=400, detail="Tu ne peux pas te supprimer toi-même")

    db.delete(user)
    db.commit()
    return {"message": f"Utilisateur '{user.username}' supprimé ✅"}
