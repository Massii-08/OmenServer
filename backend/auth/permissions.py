"""
Système de permissions basé sur les rôles.

Chaque rôle a des permissions prédéfinies.
On peut vérifier si un utilisateur a une permission spécifique.

Rôles (du moins au plus de droits):
    spectator → Voir le statut des serveurs
    player    → Démarrer / arrêter les serveurs
    moderator → Player + console + sauvegardes
    admin     → Tout

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
        "view",          # Voir le statut des serveurs
    ],
    "player": [
        "view",
        "start",         # Démarrer un serveur
        "stop",          # Arrêter un serveur
        "restart",       # Redémarrer un serveur
    ],
    "moderator": [
        "view",
        "start",
        "stop",
        "restart",
        "console",       # Voir la console + envoyer des commandes
        "backup",        # Créer / restaurer des sauvegardes
        "logs",          # Voir les logs
    ],
    "admin": [
        "view",
        "start",
        "stop",
        "restart",
        "console",
        "backup",
        "logs",
        "create",        # Créer un serveur
        "delete",        # Supprimer un serveur
        "settings",      # Modifier les paramètres
        "invite",        # Gérer les invitations
        "manage_users",  # Gérer les utilisateurs
    ],
}


# Noms affichables des rôles
ROLE_NAMES = {
    "spectator": "👀 Spectateur",
    "player": "🎮 Joueur",
    "moderator": "🔧 Modérateur",
    "admin": "👑 Administrateur",
}

# Liste ordonnée des rôles (pour la validation)
VALID_ROLES = ["spectator", "player", "moderator", "admin"]


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
