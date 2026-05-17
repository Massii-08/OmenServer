"""
Routes d'authentification — Login, Register, Setup.

Sécurité :
- Le premier compte créé est automatiquement admin
- Après ça, SEUL un admin connecté peut créer de nouveaux comptes
- Les mots de passe sont hashés avec bcrypt (jamais stockés en clair)
- L'authentification utilise des tokens JWT

Routes:
    POST /api/auth/register     → Créer le premier compte (setup) ou un compte (admin only)
    POST /api/auth/login        → Se connecter (reçoit un token JWT)
    GET  /api/auth/me           → Voir les infos de l'utilisateur connecté
    GET  /api/auth/setup-needed → Vérifier si c'est la première configuration
    POST /api/auth/logout       → Déconnexion (invalide côté client)
"""

import json
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, status, Request
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.auth.models import User
from backend.auth.utils import (
    hash_password,
    verify_password,
    create_access_token,
    get_current_user,
)
from backend.auth.rate_limiter import check_rate_limit, reset_rate_limit

router = APIRouter(prefix="/api/auth", tags=["Authentification"])


# --- Schémas Pydantic ---

class RegisterRequest(BaseModel):
    """Données nécessaires pour créer un compte."""
    username: str
    password: str
    server_name: str = "OmenServer"
    is_admin: bool = False  # L'admin peut créer des comptes admin ou non


class UserResponse(BaseModel):
    """Données renvoyées au frontend (JAMAIS le mot de passe !)."""
    id: int
    username: str
    is_admin: bool
    role: str = "player"
    allowed_modules: Optional[List[str]] = None  # null = tous les modules

    class Config:
        from_attributes = True

    @staticmethod
    def _parse_modules(v):
        if v is None:
            return None
        if isinstance(v, str):
            try:
                return json.loads(v)
            except (json.JSONDecodeError, TypeError):
                return None
        return v

    def __init__(self, **data):
        if 'allowed_modules' in data:
            data['allowed_modules'] = UserResponse._parse_modules(data['allowed_modules'])
        super().__init__(**data)

    @classmethod
    def from_orm(cls, obj):
        data = {
            'id': obj.id,
            'username': obj.username,
            'is_admin': obj.is_admin,
            'role': getattr(obj, 'role', 'player') or 'player',
            'allowed_modules': cls._parse_modules(getattr(obj, 'allowed_modules', None)),
        }
        return cls(**data)


class TokenResponse(BaseModel):
    """Token renvoyé après le login."""
    access_token: str
    token_type: str = "bearer"
    user: UserResponse


# --- Routes ---

@router.get("/setup-needed")
def check_setup_needed(db: Session = Depends(get_db)):
    """
    Vérifie si c'est la première utilisation (aucun utilisateur dans la base).
    Le frontend utilise ça pour afficher le wizard ou le login.
    """
    user_count = db.query(User).count()
    return {"setup_needed": user_count == 0}


@router.post("/register", response_model=TokenResponse)
def register(
    request: RegisterRequest,
    db: Session = Depends(get_db),
):
    """
    Créer un nouveau compte.
    
    Règles de sécurité :
    - Si c'est le premier compte → autorisé sans authentification (setup wizard)
    - Sinon → SEUL un admin connecté peut créer des comptes
    """
    # Validation du mot de passe (min 8 caractères)
    if len(request.password) < 8:
        raise HTTPException(
            status_code=400,
            detail="Le mot de passe doit contenir au moins 8 caractères."
        )

    is_first_user = db.query(User).count() == 0

    # Si ce n'est pas le premier compte, vérifier que c'est un admin qui crée
    if not is_first_user:
        # On doit vérifier le token manuellement ici car le premier register
        # ne nécessite pas d'authentification
        from fastapi import Request
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Seul un administrateur peut créer de nouveaux comptes. Utilise /api/auth/admin/create-user."
        )

    # Vérifier si le nom d'utilisateur existe déjà
    existing_user = db.query(User).filter(User.username == request.username).first()
    if existing_user:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Ce nom d'utilisateur est déjà pris"
        )

    # Créer l'utilisateur admin
    new_user = User(
        username=request.username,
        hashed_password=hash_password(request.password),
        is_admin=True,  # Premier utilisateur = toujours admin
        role="admin",
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    # Créer et retourner le token
    access_token = create_access_token(data={"sub": new_user.username})
    return TokenResponse(
        access_token=access_token,
        user=UserResponse.from_orm(new_user)
    )


@router.post("/admin/create-user", response_model=UserResponse)
def admin_create_user(
    request: RegisterRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Créer un nouveau compte (réservé aux admins).
    L'admin peut décider si le nouveau compte est aussi admin ou non.
    """
    if not current_user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Seul un administrateur peut créer des comptes"
        )

    existing_user = db.query(User).filter(User.username == request.username).first()
    if existing_user:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Ce nom d'utilisateur est déjà pris"
        )

    new_user = User(
        username=request.username,
        hashed_password=hash_password(request.password),
        is_admin=request.is_admin,
        role="admin" if request.is_admin else "player",
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    return new_user


@router.post("/login", response_model=TokenResponse)
def login(
    request: Request,
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db)
):
    """
    Se connecter avec username + password.
    Retourne un token JWT si les identifiants sont corrects.
    Protégé par rate limiting (5 tentatives/minute par IP).
    """
    # Vérifier le rate limit avant toute tentative
    check_rate_limit(request, endpoint="login")

    user = db.query(User).filter(User.username == form_data.username).first()

    if not user or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Nom d'utilisateur ou mot de passe incorrect",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Login réussi → réinitialiser le compteur de tentatives
    reset_rate_limit(request, endpoint="login")

    access_token = create_access_token(data={"sub": user.username})
    return TokenResponse(
        access_token=access_token,
        user=UserResponse.from_orm(user)
    )


@router.get("/me", response_model=UserResponse)
def get_me(current_user: User = Depends(get_current_user)):
    """Retourne les infos de l'utilisateur actuellement connecté."""
    return UserResponse.from_orm(current_user)


class ChangePasswordRequest(BaseModel):
    """Données pour changer le mot de passe."""
    current_password: str
    new_password: str


@router.put("/change-password")
def change_password(
    request: ChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Changer le mot de passe de l'utilisateur connecté.
    Nécessite le mot de passe actuel pour confirmer l'identité.
    """
    # Vérifier l'ancien mot de passe
    if not verify_password(request.current_password, current_user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Mot de passe actuel incorrect"
        )

    # Vérifier que le nouveau mot de passe est différent
    if request.current_password == request.new_password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Le nouveau mot de passe doit être différent de l'ancien"
        )

    # Vérifier la longueur minimum
    if len(request.new_password) < 8:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Le mot de passe doit faire au moins 8 caractères"
        )

    # Mettre à jour
    current_user.hashed_password = hash_password(request.new_password)
    db.commit()

    return {"message": "Mot de passe modifié avec succès ✅"}


@router.post("/logout")
def logout(current_user: User = Depends(get_current_user)):
    """
    Déconnexion côté serveur.
    Note: Le vrai logout se fait côté client (suppression du token).
    Cette route confirme simplement que le token était valide.
    """
    return {"message": f"Utilisateur '{current_user.username}' déconnecté"}


# --- Administration des utilisateurs ---

@router.get("/admin/users")
def list_users(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Liste tous les utilisateurs (admin seulement)."""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Accès réservé aux administrateurs")
    users = db.query(User).all()
    return [
        {
            "id": u.id,
            "username": u.username,
            "is_admin": u.is_admin,
            "role": u.role or "player",
            "created_at": u.created_at.isoformat() if u.created_at else None,
            "allowed_modules": json.loads(u.allowed_modules) if u.allowed_modules else None,
        }
        for u in users
    ]


class ChangeRoleRequest(BaseModel):
    """Données pour changer le rôle d'un utilisateur."""
    role: str  # admin, moderator, player, spectator


@router.put("/admin/users/{user_id}/role")
def change_user_role(
    user_id: int,
    request: ChangeRoleRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Change le rôle d'un utilisateur (admin seulement)."""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Accès réservé aux administrateurs")

    valid_roles = ["admin", "moderator", "developer", "money", "player", "spectator"]
    if request.role not in valid_roles:
        raise HTTPException(status_code=400, detail=f"Rôle invalide. Choisis parmi: {', '.join(valid_roles)}")

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Utilisateur non trouvé")

    if user.id == current_user.id:
        raise HTTPException(status_code=400, detail="Tu ne peux pas changer ton propre rôle")

    user.role = request.role
    user.is_admin = (request.role == "admin")
    db.commit()

    return {"message": f"Rôle de '{user.username}' changé en '{request.role}' ✅"}


class UpdateModulesRequest(BaseModel):
    """Données pour modifier les modules autorisés d'un utilisateur."""
    allowed_modules: Optional[List[str]] = None  # null = tous, [] = aucun


@router.put("/admin/users/{user_id}/modules")
def update_user_modules(
    user_id: int,
    request: UpdateModulesRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Change les modules autorisés pour un utilisateur (admin seulement)."""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Accès réservé aux administrateurs")

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Utilisateur non trouvé")

    if user.id == current_user.id:
        raise HTTPException(status_code=400, detail="Tu ne peux pas modifier tes propres modules")

    # null = tous les modules, sinon JSON array
    if request.allowed_modules is None:
        user.allowed_modules = None
    else:
        user.allowed_modules = json.dumps(request.allowed_modules)
    db.commit()

    return {
        "message": f"Modules de '{user.username}' mis à jour ✅",
        "allowed_modules": request.allowed_modules,
    }


@router.delete("/admin/users/{user_id}")
def delete_user(
    user_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Supprime un utilisateur (admin seulement)."""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Accès réservé aux administrateurs")

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Utilisateur non trouvé")

    if user.id == current_user.id:
        raise HTTPException(status_code=400, detail="Tu ne peux pas te supprimer toi-même")

    username = user.username
    db.delete(user)
    db.commit()

    return {"message": f"Utilisateur '{username}' supprimé ✅"}
