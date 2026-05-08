"""
Modèles pour les tâches planifiées.

Chaque tâche est liée à un serveur de jeux OU un bot et définit :
- Le type d'action (backup, restart, bot_start, bot_stop, bot_restart)
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
        server_id:     ID du serveur de jeux associé (nullable si bot)
        bot_id:        ID du bot associé (nullable si serveur)
        task_type:     Type: "backup", "restart", "bot_start", "bot_stop", "bot_restart"
        interval_hours: Intervalle en heures (ex: 6 = toutes les 6h) — mode intervalle
        schedule_time: Heure fixe d'exécution "HH:MM" (ex: "14:30") — mode cron
        schedule_days: Jours d'exécution "daily" ou "mon,wed,fri" — mode cron
        enabled:       Tâche active ou non
        last_run:      Dernière exécution
        next_run:      Prochaine exécution prévue
        created_at:    Date de création
    """
    __tablename__ = "scheduled_tasks"

    id = Column(Integer, primary_key=True, index=True)
    server_id = Column(Integer, ForeignKey("game_servers.id", ondelete="CASCADE"), nullable=True)
    bot_id = Column(Integer, ForeignKey("bots.id", ondelete="CASCADE"), nullable=True)
    task_type = Column(String(30), default="backup")   # "backup", "restart", "bot_start", "bot_stop", "bot_restart"
    interval_hours = Column(Integer, default=6, nullable=True)  # Mode intervalle (toutes les X heures)
    schedule_time = Column(String(5), nullable=True)    # Mode cron: heure "HH:MM"
    schedule_days = Column(String(50), nullable=True)   # Mode cron: "daily" ou "mon,tue,wed,thu,fri,sat,sun"
    enabled = Column(Boolean, default=True)
    last_run = Column(DateTime, nullable=True)
    next_run = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

