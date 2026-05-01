"""
Engine — Moteur de planification APScheduler.

Gère le cycle de vie du scheduler :
- Démarrage au boot du serveur
- Chargement des tâches depuis la DB
- Exécution des actions (backup, restart)
- Mise à jour des timestamps last_run / next_run
"""

import logging
from datetime import datetime, timedelta

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger

from backend.database import SessionLocal
from backend.scheduler.models import ScheduledTask
from backend.game_server.models import GameServer
from backend.game_server import backup_manager, docker_manager

logger = logging.getLogger("omenserver")

# Instance globale du scheduler
_scheduler: BackgroundScheduler = None


def _execute_task(task_id: int):
    """
    Exécute une tâche planifiée.
    Appelé par APScheduler à chaque déclenchement.
    """
    db = SessionLocal()
    try:
        task = db.query(ScheduledTask).filter(ScheduledTask.id == task_id).first()
        if not task or not task.enabled:
            return

        server = db.query(GameServer).filter(GameServer.id == task.server_id).first()
        if not server:
            logger.warning(f"⏰ Tâche #{task.id}: serveur #{task.server_id} introuvable")
            return

        logger.info(f"⏰ Exécution tâche #{task.id}: {task.task_type} pour '{server.name}'")

        if task.task_type == "backup":
            if server.docker_id:
                try:
                    result = backup_manager.create_backup(
                        server_id=server.id,
                        server_name=server.name,
                        docker_id=server.docker_id,
                    )
                    logger.info(f"✅ Backup auto réussi: {result.get('filename', '?')}")
                except Exception as e:
                    logger.error(f"❌ Backup auto échoué: {e}")

        elif task.task_type == "restart":
            if server.docker_id:
                try:
                    docker_manager.stop_container(server.docker_id)
                    docker_manager.start_container(server.docker_id)
                    server.status = "running"
                    logger.info(f"✅ Restart auto réussi: '{server.name}'")
                except Exception as e:
                    logger.error(f"❌ Restart auto échoué: {e}")

        # Mettre à jour les timestamps
        task.last_run = datetime.utcnow()
        task.next_run = datetime.utcnow() + timedelta(hours=task.interval_hours)
        db.commit()

    except Exception as e:
        logger.error(f"❌ Erreur tâche planifiée #{task_id}: {e}")
        db.rollback()
    finally:
        db.close()


def start_scheduler():
    """
    Démarre le scheduler et charge toutes les tâches actives depuis la DB.
    Appelé au démarrage du serveur (startup_event).
    """
    global _scheduler

    if _scheduler and _scheduler.running:
        return

    _scheduler = BackgroundScheduler()
    _scheduler.start()

    # Charger les tâches existantes
    db = SessionLocal()
    try:
        tasks = db.query(ScheduledTask).filter(ScheduledTask.enabled == True).all()
        for task in tasks:
            _add_job(task)
        logger.info(f"⏰ Scheduler démarré: {len(tasks)} tâche(s) active(s)")
    finally:
        db.close()


def stop_scheduler():
    """Arrête proprement le scheduler."""
    global _scheduler
    if _scheduler and _scheduler.running:
        _scheduler.shutdown(wait=False)
        logger.info("⏰ Scheduler arrêté")


def _add_job(task: ScheduledTask):
    """Ajoute une tâche au scheduler APScheduler."""
    global _scheduler
    if not _scheduler:
        return

    job_id = f"task_{task.id}"

    # Supprimer l'ancien job s'il existe
    try:
        _scheduler.remove_job(job_id)
    except Exception:
        pass

    if task.enabled:
        _scheduler.add_job(
            _execute_task,
            trigger=IntervalTrigger(hours=task.interval_hours),
            args=[task.id],
            id=job_id,
            name=f"{task.task_type} - server #{task.server_id}",
            replace_existing=True,
        )

        # Mettre à jour next_run
        task.next_run = datetime.utcnow() + timedelta(hours=task.interval_hours)


def add_task(task: ScheduledTask):
    """Enregistre une nouvelle tâche dans le scheduler."""
    _add_job(task)


def remove_task(task_id: int):
    """Retire une tâche du scheduler."""
    global _scheduler
    if not _scheduler:
        return
    try:
        _scheduler.remove_job(f"task_{task_id}")
    except Exception:
        pass


def update_task(task: ScheduledTask):
    """Met à jour une tâche (changement d'intervalle ou activation/désactivation)."""
    if task.enabled:
        _add_job(task)
    else:
        remove_task(task.id)
