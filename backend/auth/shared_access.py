"""
Modèle SharedAccess — Partage de ressources entre utilisateurs.

Permet au créateur (owner) d'un serveur ou d'un bot d'inviter d'autres
utilisateurs avec un niveau d'accès spécifique.

Niveaux d'accès:
    view_only → Voir le statut uniquement
    start     → Allumer/éteindre la ressource
    manage    → Accès complet au panel (console, fichiers, config, etc.)

Usage:
    # Partager un serveur avec un joueur
    access = SharedAccess(
        resource_type="server",
        resource_id=1,
        user_id=5,
        access_level="start",
        granted_by=2
    )
"""

from datetime import datetime, timezone

from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.orm import relationship

from backend.database import Base


class SharedAccess(Base):
    """
    Table de partage de ressources.

    Chaque ligne = un utilisateur a accès à une ressource spécifique
    avec un certain niveau de permissions.

    Attributs:
        resource_type:  "server" ou "bot"
        resource_id:    ID du serveur ou du bot partagé
        user_id:        ID de l'utilisateur qui reçoit l'accès
        access_level:   "view_only", "start", ou "manage"
        granted_by:     ID de l'utilisateur qui a accordé l'accès (owner)
        created_at:     Date de création du partage
    """
    __tablename__ = "shared_access"

    id = Column(Integer, primary_key=True, index=True)
    resource_type = Column(String(20), nullable=False)   # "server" ou "bot"
    resource_id = Column(Integer, nullable=False)          # ID de la ressource
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    access_level = Column(String(20), default="start")     # "view_only", "start", "manage"
    granted_by = Column(Integer, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    # Contrainte unique : un user ne peut avoir qu'un seul accès par ressource
    __table_args__ = (
        UniqueConstraint("resource_type", "resource_id", "user_id",
                         name="uq_shared_access_resource_user"),
    )

    # Relations
    user = relationship("User", foreign_keys=[user_id])
    granter = relationship("User", foreign_keys=[granted_by])


# Niveaux d'accès valides (du moins au plus de droits)
VALID_ACCESS_LEVELS = ["view_only", "start", "manage"]
