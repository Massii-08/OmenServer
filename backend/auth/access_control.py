"""
Contrôle d'accès centralisé — Ownership & partage de ressources.

Fonctions utilitaires pour vérifier si un utilisateur peut accéder
à un serveur ou un bot, basé sur:
    1. Le rôle de l'utilisateur (admin = tout voir)
    2. La propriété de la ressource (owner_id)
    3. Les accès partagés (table shared_access)

Usage dans un router:
    from backend.auth.access_control import can_access_resource, get_accessible_server_ids

    # Vérifier l'accès à un serveur spécifique
    if not can_access_resource(user, "server", server_id, db, min_level="start"):
        raise HTTPException(403, "Accès refusé")

    # Obtenir tous les serveurs visibles par l'utilisateur
    ids = get_accessible_server_ids(user, db)
    servers = db.query(GameServer).filter(GameServer.id.in_(ids)).all()
"""

import logging

from fastapi import HTTPException
from sqlalchemy.orm import Session

from backend.auth.models import User
from backend.auth.shared_access import SharedAccess, VALID_ACCESS_LEVELS

logger = logging.getLogger("omenserver.access_control")


def require_resource_access(user, resource_type, resource_id, db, min_level="view_only"):
    """Garde d'autorisation factorisé : lève HTTPException(403) si ``user`` n'a
    pas le niveau ``min_level`` sur la ressource. À appeler en tête des endpoints
    qui agissent sur une ressource (anti-IDOR) — admin/owner/shared sont gérés
    par ``can_access_resource``."""
    if not can_access_resource(user, resource_type, resource_id, db, min_level):
        raise HTTPException(status_code=403, detail="Accès refusé à cette ressource")


def _access_level_rank(level: str) -> int:
    """Retourne le rang numérique d'un niveau d'accès (0=view_only, 1=start, 2=manage)."""
    try:
        return VALID_ACCESS_LEVELS.index(level)
    except ValueError:
        return -1


def is_owner(user: User, resource_type: str, resource_id: int, db: Session) -> bool:
    """Vérifie si l'utilisateur est le propriétaire d'une ressource."""
    if resource_type == "server":
        from backend.game_server.models import GameServer
        srv = db.query(GameServer).filter(GameServer.id == resource_id).first()
        return srv is not None and srv.owner_id == user.id
    elif resource_type == "bot":
        from backend.bots.models import Bot
        bot = db.query(Bot).filter(Bot.id == resource_id).first()
        return bot is not None and bot.owner_id == user.id
    return False


def get_shared_access(user: User, resource_type: str, resource_id: int, db: Session):
    """Retourne l'objet SharedAccess si l'utilisateur a un accès partagé, sinon None."""
    return db.query(SharedAccess).filter(
        SharedAccess.resource_type == resource_type,
        SharedAccess.resource_id == resource_id,
        SharedAccess.user_id == user.id,
    ).first()


def can_access_resource(
    user: User,
    resource_type: str,
    resource_id: int,
    db: Session,
    min_level: str = "view_only"
) -> bool:
    """
    Vérifie si un utilisateur peut accéder à une ressource avec un niveau minimum.

    Args:
        user:          L'utilisateur courant
        resource_type: "server" ou "bot"
        resource_id:   ID de la ressource
        db:            Session SQLAlchemy
        min_level:     Niveau minimum requis ("view_only", "start", "manage")

    Returns:
        True si l'utilisateur a le droit, False sinon
    """
    # Admins ont accès à tout
    if user.is_admin:
        return True

    # Le propriétaire a accès total
    if is_owner(user, resource_type, resource_id, db):
        return True

    # Vérifier les accès partagés
    access = get_shared_access(user, resource_type, resource_id, db)
    if access is None:
        return False

    # Comparer le niveau d'accès
    return _access_level_rank(access.access_level) >= _access_level_rank(min_level)


def get_user_access_level(user: User, resource_type: str, resource_id: int, db: Session) -> str:
    """
    Retourne le niveau d'accès effectif d'un utilisateur sur une ressource.

    Returns:
        "owner", "manage", "start", "view_only", ou None si aucun accès
    """
    if user.is_admin:
        return "owner"

    if is_owner(user, resource_type, resource_id, db):
        return "owner"

    access = get_shared_access(user, resource_type, resource_id, db)
    if access:
        return access.access_level

    return None


def get_accessible_resource_ids(user: User, resource_type: str, db: Session) -> list:
    """
    Retourne la liste des IDs de ressources accessibles par l'utilisateur.

    Pour les admins: retourne None (= tout voir, le router ne filtre pas).
    Pour les autres: retourne les IDs dont l'user est owner OU a un shared_access.
    """
    if user.is_admin:
        return None  # None = pas de filtre, tout est visible

    ids = set()

    # Ressources dont l'utilisateur est propriétaire
    if resource_type == "server":
        from backend.game_server.models import GameServer
        owned = db.query(GameServer.id).filter(GameServer.owner_id == user.id).all()
        ids.update(r[0] for r in owned)
    elif resource_type == "bot":
        from backend.bots.models import Bot
        owned = db.query(Bot.id).filter(Bot.owner_id == user.id).all()
        ids.update(r[0] for r in owned)

    # Ressources partagées avec l'utilisateur
    shared = db.query(SharedAccess.resource_id).filter(
        SharedAccess.resource_type == resource_type,
        SharedAccess.user_id == user.id,
    ).all()
    ids.update(r[0] for r in shared)

    return list(ids)


def get_bot_count(user: User, db: Session) -> int:
    """Retourne le nombre de bots créés par un utilisateur."""
    from backend.bots.models import Bot
    return db.query(Bot).filter(Bot.owner_id == user.id).count()


def check_bot_quota(user: User, db: Session, max_bots: int = 3) -> bool:
    """
    Vérifie si un développeur peut encore créer un bot.

    Args:
        user:     L'utilisateur
        db:       Session SQLAlchemy
        max_bots: Nombre maximum de bots (défaut: 3 pour les developers)

    Returns:
        True si le quota n'est pas atteint, False sinon
    """
    role = getattr(user, 'role', 'player') or 'player'

    # Les admins n'ont pas de quota
    if user.is_admin or role == "admin":
        return True

    # Seuls les développeurs ont un quota
    if role != "developer":
        return False  # Les autres rôles ne peuvent pas créer de bots

    count = get_bot_count(user, db)
    return count < max_bots
