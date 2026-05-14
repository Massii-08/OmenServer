"""
Module Serveur Web — Modèles SQLAlchemy.

Représente un site web hébergé sur le serveur via Docker.
Chaque site = 1 conteneur Docker (Nginx, Node.js, PHP, ou Python).
"""

from sqlalchemy import Column, Integer, String, DateTime, Boolean, ForeignKey
from datetime import datetime
from backend.database import Base


class Website(Base):
    """
    Un site web hébergé sur le serveur.
    
    Chaque site tourne dans son propre conteneur Docker.
    Types supportés : static (Nginx), node, php, python.
    """
    __tablename__ = "websites"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    site_type = Column(String, default="static")       # static, node, php, python
    port = Column(Integer, nullable=False)              # Port exposé
    domain = Column(String, nullable=True)              # Domaine personnalisé (optionnel)
    status = Column(String, default="stopped")          # running, stopped, error
    container_id = Column(String, nullable=True)        # ID du conteneur Docker
    source_path = Column(String, nullable=True)         # Chemin des fichiers source
    description = Column(String, default="")
    auto_start = Column(Boolean, default=False)         # Redémarrage auto
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=True)  # Propriétaire (RBAC)
    created_at = Column(DateTime, default=datetime.utcnow)
