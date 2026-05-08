"""
Modèles Auth — Utilisateurs et Invitations.

Tables:
    users       — Comptes utilisateurs avec rôles
    invitations — Codes d'invitation pour rejoindre le panel

Rôles disponibles:
    admin      → Accès total
    moderator  → Console, backups, start/stop
    player     → Start/stop uniquement
    spectator  → Voir le statut seulement
"""

from datetime import datetime, timezone
import secrets

from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey
from sqlalchemy.orm import relationship

from backend.database import Base


class User(Base):
    """
    Table des utilisateurs.

    Attributs:
        id:              Numéro unique auto-incrémenté
        username:        Nom d'utilisateur (unique, pas de doublon)
        hashed_password: Mot de passe hashé (jamais stocké en clair !)
        is_admin:        True si c'est l'administrateur principal
        role:            Rôle de l'utilisateur (admin, moderator, player, spectator)
        created_at:      Date de création du compte
        invited_by:      ID de l'utilisateur qui a envoyé l'invitation (null pour le 1er compte)
    """
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, index=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    is_admin = Column(Boolean, default=False)
    role = Column(String(20), default="player")
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    invited_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    allowed_modules = Column(String(500), nullable=True, default=None)  # JSON array, null = tous les modules


class Invitation(Base):
    """
    Table des invitations.

    Un admin génère un code unique que quelqu'un peut utiliser
    pour créer un compte avec un rôle prédéfini.

    Attributs:
        id:           Numéro unique
        code:         Code unique d'invitation (8 caractères)
        role:         Rôle attribué au compte créé avec ce code
        created_by:   ID de l'admin qui a créé l'invitation
        used_by:      ID de l'utilisateur qui a utilisé le code (null si pas encore utilisé)
        used_at:      Date d'utilisation
        created_at:   Date de création
        expires_at:   Date d'expiration (null = pas d'expiration)
        max_uses:     Nombre max d'utilisations (1 par défaut)
        uses:         Nombre d'utilisations actuelles
    """
    __tablename__ = "invitations"

    id = Column(Integer, primary_key=True, index=True)
    code = Column(String(20), unique=True, index=True, nullable=False, default=lambda: secrets.token_urlsafe(6))
    role = Column(String(20), default="player")
    created_by = Column(Integer, ForeignKey("users.id"), nullable=False)
    used_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    used_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    expires_at = Column(DateTime, nullable=True)
    max_uses = Column(Integer, default=1)
    uses = Column(Integer, default=0)

    # Relations
    creator = relationship("User", foreign_keys=[created_by])
