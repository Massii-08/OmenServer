"""
Modèles pour les tâches planifiées.

Chaque tâche est liée à un serveur de jeux et définit :
- Le type d'action (backup, restart)
- La fréquence (interval en heures, ou cron expression)
- L'état (actif / inactif)
"""

from datetime import datetime

from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey
from sqlalchemy.orm import relationship

from backend.database import Base


class ScheduledTask(Base):
    """
    Table des tâches planifiées.

    Attributs:
        id:            Identifiant unique
        server_id:     ID du serveur de jeux associé
        task_type:     Type de tâche: "backup", "restart"
        interval_hours: Intervalle en heures (ex: 6 = toutes les 6h)
        enabled:       Tâche active ou non
        last_run:      Dernière exécution
        next_run:      Prochaine exécution prévue
        created_at:    Date de création
    """
    __tablename__ = "scheduled_tasks"

    id = Column(Integer, primary_key=True, index=True)
    server_id = Column(Integer, ForeignKey("game_servers.id", ondelete="CASCADE"), nullable=False)
    task_type = Column(String(30), default="backup")   # "backup" ou "restart"
    interval_hours = Column(Integer, default=6)         # Toutes les X heures
    enabled = Column(Boolean, default=True)
    last_run = Column(DateTime, nullable=True)
    next_run = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
