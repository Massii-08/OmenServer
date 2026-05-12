"""
Système de permissions basé sur les rôles.

Chaque rôle a des permissions prédéfinies.
On peut vérifier si un utilisateur a une permission spécifique.

Rôles (du moins au plus de droits):
    spectator  → Voir le statut des serveurs
    player     → Allumer un serveur (si invité)
    money      → Player + accès au Yield Bot
    moderator  → Créer/gérer ses serveurs + console + backups
    developer  → Créer/gérer ses bots (max 3) + console + logs
    admin      → Tout

Utilisation dans un router:
    from backend.auth.permissions import require_permission

    @router.post("/servers/{id}/start")
    def start(id, user = Depends(require_permission("start"))):
        ...
"""

from fastapi import Depends, HTTPException, status
from backend.auth.models import User
from backend.auth.utils import get_current_user


# Définition des permissions par rôle
ROLE_PERMISSIONS = {
    "spectator": [
        "view",              # Voir le statut des serveurs/bots
    ],
    "player": [
        "view",
        "start",             # Allumer un serveur (si invité)
    ],
    "money": [
        "view",
        "start",
        "yield_bot",         # Accès au Yield Bot
    ],
    "moderator": [
        "view",
        "start",
        "stop",              # Arrêter un serveur
        "restart",           # Redémarrer un serveur
        "console",           # Voir la console + envoyer des commandes
        "backup",            # Créer / restaurer des sauvegardes
        "logs",              # Voir les logs
        "create_server",     # Créer un serveur de jeu
        "invite",            # Créer des invitations (rôle player uniquement)
    ],
    "developer": [
        "view",
        "start",
        "stop",
        "restart",
        "console",
        "logs",
        "create_bot",        # Créer un bot (max 3)
        "invite",            # Créer des invitations (rôle player uniquement)
    ],
    "admin": [
        "view",
        "start",
        "stop",
        "restart",
        "console",
        "backup",
        "logs",
        "create_server",     # Créer un serveur
        "create_bot",        # Créer un bot
        "delete",            # Supprimer un serveur/bot
        "settings",          # Modifier les paramètres
        "invite",            # Gérer les invitations (tous rôles)
        "manage_users",      # Gérer les utilisateurs
        "yield_bot",         # Accès au Yield Bot
    ],
}


# Noms affichables des rôles
ROLE_NAMES = {
    "spectator": "👀 Spectateur",
    "player": "🎮 Joueur",
    "money": "💰 Money",
    "moderator": "🔧 Modérateur",
    "developer": "💻 Développeur",
    "admin": "👑 Administrateur",
}

# Liste ordonnée des rôles (pour la validation)
VALID_ROLES = ["spectator", "player", "money", "moderator", "developer", "admin"]

# Rôles que les non-admins peuvent assigner via invitation
INVITABLE_ROLES = ["player"]


def has_permission(user: User, permission: str) -> bool:
    """Vérifie si un utilisateur a une permission spécifique."""
    # Les admins ont TOUJOURS toutes les permissions
    if user.is_admin:
        return True

    role = getattr(user, 'role', 'player') or 'player'
    permissions = ROLE_PERMISSIONS.get(role, [])
    return permission in permissions


def require_permission(permission: str):
    """
    Dépendance FastAPI qui vérifie une permission.
    Lève une 403 si l'utilisateur n'a pas la permission.

    Usage:
        @router.post("/servers/{id}/start")
        def start(user = Depends(require_permission("start"))):
            ...
    """
    def check(current_user: User = Depends(get_current_user)):
        if not has_permission(current_user, permission):
            role_name = ROLE_NAMES.get(getattr(current_user, 'role', 'player'), 'Joueur')
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Permission insuffisante. Ton rôle ({role_name}) ne permet pas cette action."
            )
        return current_user
    return check


def require_role(*roles: str):
    """
    Dépendance FastAPI qui vérifie que l'utilisateur a un rôle spécifique.

    Usage:
        @router.get("/admin-only")
        def admin_only(user = Depends(require_role("admin"))):
            ...

        @router.get("/yield")
        def yield_bot(user = Depends(require_role("admin", "money"))):
            ...
    """
    def check(current_user: User = Depends(get_current_user)):
        if current_user.is_admin:
            return current_user
        user_role = getattr(current_user, 'role', 'player') or 'player'
        if user_role not in roles:
            role_name = ROLE_NAMES.get(user_role, 'Joueur')
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Accès réservé aux rôles: {', '.join(roles)}. Ton rôle: {role_name}"
            )
        return current_user
    return check
