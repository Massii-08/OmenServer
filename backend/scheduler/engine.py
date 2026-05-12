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
from apscheduler.triggers.cron import CronTrigger

from backend.database import SessionLocal
from backend.scheduler.models import ScheduledTask
from backend.game_server.models import GameServer
from backend.game_server import backup_manager, docker_manager
from backend.bots.models import Bot

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

        # ---- Tâches serveur de jeux ----
        if task.task_type in ("backup", "restart") and task.server_id:
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
                            backup_type="auto",
                        )
                        # Rotation auto : garder max 10 backups auto
                        backup_manager.cleanup_old_backups(server.id, keep=10, backup_type="auto")
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

        # ---- Tâches bot ----
        elif task.task_type in ("bot_start", "bot_stop", "bot_restart") and task.bot_id:
            bot = db.query(Bot).filter(Bot.id == task.bot_id).first()
            if not bot:
                logger.warning(f"⏰ Tâche #{task.id}: bot #{task.bot_id} introuvable")
                return

            logger.info(f"⏰ Exécution tâche #{task.id}: {task.task_type} pour bot '{bot.name}'")

            try:
                from backend.bots.router import _start_bot_process, _stop_bot_process

                if task.task_type == "bot_start":
                    if bot.status != "running":
                        _start_bot_process(bot, db)
                        logger.info(f"✅ Bot '{bot.name}' démarré par scheduler")
                    else:
                        logger.info(f"ℹ️ Bot '{bot.name}' déjà en cours")

                elif task.task_type == "bot_stop":
                    if bot.status == "running":
                        _stop_bot_process(bot, db)
                        logger.info(f"✅ Bot '{bot.name}' arrêté par scheduler")
                    else:
                        logger.info(f"ℹ️ Bot '{bot.name}' déjà arrêté")

                elif task.task_type == "bot_restart":
                    if bot.status == "running":
                        _stop_bot_process(bot, db)
                    _start_bot_process(bot, db)
                    logger.info(f"✅ Bot '{bot.name}' redémarré par scheduler")

            except Exception as e:
                logger.error(f"❌ Tâche bot échouée: {e}")

        # Mettre à jour les timestamps
        task.last_run = datetime.utcnow()
        if task.schedule_time:
            # Mode cron : next_run sera calculé par APScheduler, on met une approximation
            task.next_run = _calc_next_cron_run(task)
        elif task.interval_hours:
            task.next_run = datetime.utcnow() + timedelta(hours=task.interval_hours)
        db.commit()

    except Exception as e:
        logger.error(f"❌ Erreur tâche planifiée #{task_id}: {e}")
        db.rollback()
    finally:
        db.close()


def _auto_network_ping():
    """
    Ping automatique toutes les 5 minutes.
    Stocke le résultat dans la table network_logs pour l'historique.
    """
    db = SessionLocal()
    try:
        from backend.network.router import _ping, _get_public_ip
        from backend.network.models import NetworkLog

        latency = _ping(count=1)
        public_ip = _get_public_ip()

        log = NetworkLog(
            latency_ms=latency,
            public_ip=public_ip,
        )
        db.add(log)
        db.commit()
    except Exception as e:
        logger.warning(f"📡 Auto-ping échoué: {e}")
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

    # Auto-ping réseau toutes les 5 minutes (V4)
    _scheduler.add_job(
        _auto_network_ping,
        trigger=IntervalTrigger(minutes=5),
        id="auto_network_ping",
        name="Auto Network Ping (5min)",
        replace_existing=True,
    )
    logger.info("📡 Auto-ping réseau activé (toutes les 5 min)")

    # Auto-extinction programmée (Power Schedule)
    from backend.scheduler.power_manager import get_power_schedule
    power_config = get_power_schedule()
    if power_config.get("enabled"):
        _add_power_job(power_config)
    else:
        logger.info("🌙 Extinction programmée: désactivée")


def stop_scheduler():
    """Arrête proprement le scheduler."""
    global _scheduler
    if _scheduler and _scheduler.running:
        _scheduler.shutdown(wait=False)
        logger.info("⏰ Scheduler arrêté")


# Mapping jour abrégé → index APScheduler
_DAY_MAP = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}


def _build_trigger(task: ScheduledTask):
    """
    Construit le trigger APScheduler adapté à la tâche.
    - Si schedule_time est défini → CronTrigger (heure fixe, jours spécifiés)
    - Sinon → IntervalTrigger classique
    """
    if task.schedule_time:
        # Parser "HH:MM"
        parts = task.schedule_time.split(":")
        hour = int(parts[0])
        minute = int(parts[1]) if len(parts) > 1 else 0

        # Jours
        days = task.schedule_days or "daily"
        if days == "daily":
            day_of_week = "*"
        else:
            # "mon,wed,fri" → "0,2,4"
            day_indices = []
            for d in days.split(","):
                d = d.strip().lower()
                if d in _DAY_MAP:
                    day_indices.append(str(_DAY_MAP[d]))
            day_of_week = ",".join(day_indices) if day_indices else "*"

        return CronTrigger(hour=hour, minute=minute, day_of_week=day_of_week)
    else:
        return IntervalTrigger(hours=task.interval_hours or 6)


def _calc_next_cron_run(task: ScheduledTask) -> datetime:
    """Estime la prochaine exécution d'une tâche cron."""
    if not task.schedule_time:
        return datetime.utcnow() + timedelta(hours=task.interval_hours or 6)

    parts = task.schedule_time.split(":")
    hour = int(parts[0])
    minute = int(parts[1]) if len(parts) > 1 else 0

    now = datetime.utcnow()
    today_run = now.replace(hour=hour, minute=minute, second=0, microsecond=0)

    if today_run > now:
        return today_run
    else:
        return today_run + timedelta(days=1)


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
        trigger = _build_trigger(task)
        target_label = f"server #{task.server_id}" if task.server_id else f"bot #{task.bot_id}"
        _scheduler.add_job(
            _execute_task,
            trigger=trigger,
            args=[task.id],
            id=job_id,
            name=f"{task.task_type} - {target_label}",
            replace_existing=True,
        )

        # Mettre à jour next_run
        if task.schedule_time:
            task.next_run = _calc_next_cron_run(task)
        elif task.interval_hours:
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


# === Power Schedule (extinction/réveil automatique) ===

def _add_power_job(config: dict):
    """
    Ajoute le job d'extinction automatique au scheduler.
    Utilise un CronTrigger basé sur l'heure configurée.
    """
    global _scheduler
    if not _scheduler:
        return

    # Parser l'heure d'extinction "HH:MM"
    parts = config["shutdown_hour"].split(":")
    hour = int(parts[0])
    minute = int(parts[1]) if len(parts) > 1 else 0

    # Jours
    days = config.get("days", "daily")
    if days == "daily":
        day_of_week = "*"
    else:
        day_indices = []
        for d in days.split(","):
            d = d.strip().lower()
            if d in _DAY_MAP:
                day_indices.append(str(_DAY_MAP[d]))
        day_of_week = ",".join(day_indices) if day_indices else "*"

    from backend.scheduler.power_manager import execute_scheduled_shutdown

    _scheduler.add_job(
        execute_scheduled_shutdown,
        trigger=CronTrigger(hour=hour, minute=minute, day_of_week=day_of_week),
        id="auto_power_shutdown",
        name=f"Auto Power Shutdown ({config['shutdown_hour']})",
        replace_existing=True,
    )
    logger.info(f"🌙 Extinction programmée activée: {config['shutdown_hour']} → réveil {config.get('wake_hour', '?')} ({config.get('mode', 'shutdown')})")


def update_power_job(config: dict):
    """
    Met à jour ou supprime le job d'extinction selon la config.
    Appelé quand la config est modifiée via l'API.
    """
    global _scheduler
    if not _scheduler:
        return

    # Supprimer l'ancien job
    try:
        _scheduler.remove_job("auto_power_shutdown")
    except Exception:
        pass

    # Re-créer si activé
    if config.get("enabled"):
        _add_power_job(config)
    else:
        logger.info("🌙 Extinction programmée: désactivée")

