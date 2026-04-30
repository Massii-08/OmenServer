"""
Modèle GameServer — Représente un serveur de jeu dans la base de données.

Chaque serveur de jeu que tu crées (ex: "Mon Minecraft Survival") est stocké
dans cette table avec ses paramètres et son état.
"""

from datetime import datetime

from sqlalchemy import Column, Integer, String, DateTime

from backend.database import Base


class GameServer(Base):
    """
    Table des serveurs de jeux.

    Attributs:
        id:            Numéro unique auto-incrémenté
        name:          Nom du serveur (ex: "Minecraft Survie")
        game_type:     Type de jeu (ex: "minecraft")
        version:       Version du jeu (ex: "1.21.4")
        docker_id:     ID du conteneur Docker (rempli quand le serveur est créé)
        port:          Port du serveur (ex: 25565 pour Minecraft)
        memory_mb:     RAM allouée en Mo (ex: 2048 = 2 Go)
        status:        État actuel: "stopped", "running", "starting", "error"
        created_at:    Date de création
    """
    __tablename__ = "game_servers"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    game_type = Column(String(50), default="minecraft")
    version = Column(String(20), default="LATEST")
    docker_id = Column(String(100), nullable=True)
    port = Column(Integer, default=25565)
    memory_mb = Column(Integer, default=2048)
    status = Column(String(20), default="stopped")
    created_at = Column(DateTime, default=datetime.utcnow)
