"""
Modèles Bots — Table pour stocker les bots Python.

Chaque bot a:
    - Un nom et une description
    - Un type (trading, gaming, scraper, custom)
    - Un fichier Python principal (chemin relatif)
    - Un statut (running, stopped, error)
    - Un PID de process si en cours d'exécution
    - Des logs récents
"""

from datetime import datetime
from sqlalchemy import Column, Integer, String, DateTime, Text, Boolean

from backend.database import Base


class Bot(Base):
    """Table des bots Python."""
    __tablename__ = "bots"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    description = Column(String(500), default="")
    bot_type = Column(String(50), default="custom")  # trading, gaming, scraper, analysis, custom
    script_path = Column(String(500), nullable=False)  # chemin relatif vers le script
    status = Column(String(20), default="stopped")  # running, stopped, error
    pid = Column(Integer, nullable=True)  # PID du process si running
    auto_restart = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    last_run = Column(DateTime, nullable=True)
    last_error = Column(Text, nullable=True)
