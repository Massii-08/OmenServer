"""
Power Manager — Gestion de l'extinction/réveil automatique.

Programme l'extinction complète de la machine entre des heures
configurables (par défaut 1h→5h du matin) avec un réveil automatique
via le timer RTC du BIOS (rtcwake sur Linux).

Avant l'extinction, le système :
1. Sauvegarde tous les serveurs actifs
2. Arrête proprement tous les conteneurs Docker
3. Arrête tous les bots
4. Log l'événement

Configuration stockée dans data/power_schedule.json.

Commandes Linux utilisées :
- rtcwake -m mem -l -t <timestamp>  → Suspend-to-RAM + programme le réveil BIOS
  (Note: -m off est bloqué par Kernel Lockdown / Secure Boot)
- shutdown -h now                    → Extinction simple (sans réveil auto)
"""

import json
import logging
import os
import subprocess
from datetime import datetime, timedelta
from pathlib import Path

logger = logging.getLogger("omenserver")

# Chemin du fichier de configuration
_CONFIG_DIR = Path(__file__).resolve().parent.parent.parent / "data"
_CONFIG_FILE = _CONFIG_DIR / "power_schedule.json"

# Configuration par défaut
_DEFAULT_CONFIG = {
    "enabled": False,
    "shutdown_hour": "01:00",
    "wake_hour": "05:00",
    "days": "daily",          # "daily" ou "mon,tue,wed,..."
    "last_shutdown": None,
    "last_wake": None,
}


def get_power_schedule() -> dict:
    """
    Retourne la configuration actuelle du planning d'extinction.

    Retour:
    {
        "enabled": true/false,
        "shutdown_hour": "01:00",
        "wake_hour": "05:00",
        "days": "daily",
        "last_shutdown": "2026-05-06T01:00:00" ou null,
        "last_wake": "2026-05-06T05:00:00" ou null
    }
    """
    if not _CONFIG_FILE.exists():
        return _DEFAULT_CONFIG.copy()

    try:
        with open(_CONFIG_FILE, "r") as f:
            config = json.load(f)
        # Compléter avec les valeurs par défaut si des clés manquent
        for key, default in _DEFAULT_CONFIG.items():
            if key not in config:
                config[key] = default
        # Migration: supprimer l'ancien champ "mode" s'il existe
        config.pop("mode", None)
        return config
    except Exception as e:
        logger.warning(f"⚡ Erreur lecture power config: {e}")
        return _DEFAULT_CONFIG.copy()


def set_power_schedule(
    enabled: bool = None,
    shutdown_hour: str = None,
    wake_hour: str = None,
    days: str = None,
) -> dict:
    """
    Met à jour la configuration du planning d'extinction.
    Seuls les champs fournis (non None) sont modifiés.

    Retourne la nouvelle configuration.
    """
    config = get_power_schedule()

    if enabled is not None:
        config["enabled"] = enabled
    if shutdown_hour is not None:
        config["shutdown_hour"] = shutdown_hour
    if wake_hour is not None:
        config["wake_hour"] = wake_hour
    if days is not None:
        config["days"] = days

    _save_config(config)
    return config


def _save_config(config: dict):
    """Sauvegarde la configuration dans le fichier JSON."""
    os.makedirs(_CONFIG_DIR, exist_ok=True)
    with open(_CONFIG_FILE, "w") as f:
        json.dump(config, f, indent=2, default=str)


def _calc_wake_timestamp(wake_hour: str) -> int:
    """
    Calcule le timestamp Unix de la prochaine heure de réveil.
    Si l'heure est déjà passée aujourd'hui, prend demain.

    Retourne un timestamp Unix (int).
    """
    parts = wake_hour.split(":")
    h = int(parts[0])
    m = int(parts[1]) if len(parts) > 1 else 0

    now = datetime.now()
    wake_time = now.replace(hour=h, minute=m, second=0, microsecond=0)

    # Si l'heure de wake est avant maintenant, c'est demain
    if wake_time <= now:
        wake_time += timedelta(days=1)

    return int(wake_time.timestamp())


def shutdown_with_rtcwake(wake_hour: str) -> bool:
    """
    Met la machine en veille (suspend-to-RAM) et programme le réveil via rtcwake.

    Utilise deux étapes pour que les hooks systemd fonctionnent au réveil :
    1. rtcwake -m no  → Programme le timer RTC sans suspendre
    2. systemctl suspend → Suspend via systemd (déclenche /etc/systemd/system-sleep/)

    Au réveil, le script omen-resume.sh redémarre cloudflared + omenserver.

    Note: -m off est bloqué par Kernel Lockdown (Secure Boot activé sur le HP Omen).

    Args:
        wake_hour: Heure de réveil au format "HH:MM"

    Retourne True si la commande a été lancée.
    """
    wake_ts = _calc_wake_timestamp(wake_hour)
    wake_dt = datetime.fromtimestamp(wake_ts)

    try:
        logger.info(f"🌙 rtcwake: réveil prévu à {wake_dt.strftime('%H:%M')} (timestamp {wake_ts})")

        # Étape 1 : Programmer le timer RTC du BIOS (sans suspendre)
        # -m no : programme seulement le réveil, ne suspend pas
        # -l : utilise l'heure locale
        # -t : timestamp de réveil
        result = subprocess.run(
            ["sudo", "rtcwake", "-m", "no", "-l", "-t", str(wake_ts)],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode != 0:
            logger.error(f"⚡ rtcwake -m no échoué: {result.stderr}")
            return False

        logger.info("🌙 Timer RTC programmé — lancement du suspend via systemd")

        # Étape 2 : Suspend via systemd (déclenche les hooks system-sleep)
        # Au réveil, /etc/systemd/system-sleep/omen-resume.sh restart les services
        subprocess.Popen(["sudo", "systemctl", "suspend"])
        logger.info("🌙 systemctl suspend lancé — mise en veille imminente")
        return True

    except Exception as e:
        logger.error(f"⚡ Erreur rtcwake/suspend: {e}")
        # Fallback : shutdown simple sans réveil programmé
        logger.warning("⚡ Fallback: shutdown -h now (sans réveil automatique)")
        try:
            subprocess.Popen(["sudo", "shutdown", "-h", "now"])
            return True
        except Exception as e2:
            logger.error(f"⚡ Erreur shutdown fallback: {e2}")
            return False


def graceful_shutdown() -> dict:
    """
    Arrêt gracieux de tous les services avant l'extinction.

    Séquence :
    1. Sauvegarde automatique de tous les serveurs actifs
    2. Arrêt de tous les conteneurs Docker (serveurs de jeux)
    3. Arrêt de tous les bots
    4. Log de l'événement

    Retourne un résumé des actions effectuées.
    """
    from backend.database import SessionLocal
    from backend.game_server.models import GameServer
    from backend.game_server import docker_manager, backup_manager
    from backend.bots.models import Bot

    summary = {
        "backups_created": 0,
        "servers_stopped": 0,
        "bots_stopped": 0,
        "errors": [],
    }

    db = SessionLocal()
    try:
        # 1. Sauvegarder les serveurs actifs
        servers = db.query(GameServer).filter(GameServer.status == "running").all()
        for server in servers:
            if server.docker_id:
                try:
                    backup_manager.create_backup(
                        server_id=server.id,
                        server_name=server.name,
                        docker_id=server.docker_id,
                        backup_type="auto",
                    )
                    summary["backups_created"] += 1
                    logger.info(f"🌙 Backup pré-extinction: '{server.name}'")
                except Exception as e:
                    error_msg = f"Backup '{server.name}' échoué: {e}"
                    summary["errors"].append(error_msg)
                    logger.warning(f"🌙 {error_msg}")

        # 2. Arrêter les serveurs Docker
        for server in servers:
            if server.docker_id:
                try:
                    docker_manager.stop_container(server.docker_id)
                    server.status = "stopped"
                    summary["servers_stopped"] += 1
                    logger.info(f"🌙 Serveur arrêté: '{server.name}'")
                except Exception as e:
                    error_msg = f"Arrêt '{server.name}' échoué: {e}"
                    summary["errors"].append(error_msg)
                    logger.warning(f"🌙 {error_msg}")

        # 3. Arrêter les bots
        bots = db.query(Bot).filter(Bot.status == "running").all()
        for bot in bots:
            try:
                from backend.bots.router import _stop_bot_process
                _stop_bot_process(bot, db)
                summary["bots_stopped"] += 1
                logger.info(f"🌙 Bot arrêté: '{bot.name}'")
            except Exception as e:
                error_msg = f"Arrêt bot '{bot.name}' échoué: {e}"
                summary["errors"].append(error_msg)
                logger.warning(f"🌙 {error_msg}")

        db.commit()
    except Exception as e:
        logger.error(f"🌙 Erreur pendant l'arrêt gracieux: {e}")
        summary["errors"].append(str(e))
        db.rollback()
    finally:
        db.close()

    logger.info(
        f"🌙 Arrêt gracieux terminé: {summary['backups_created']} backup(s), "
        f"{summary['servers_stopped']} serveur(s), {summary['bots_stopped']} bot(s) arrêté(s)"
    )
    return summary


def execute_scheduled_shutdown():
    """
    Fonction appelée par le scheduler à l'heure d'extinction.

    Séquence complète :
    1. Vérifier que c'est bien activé
    2. Arrêt gracieux de tous les services
    3. Mettre à jour last_shutdown
    4. Éteindre la machine avec rtcwake (réveil BIOS programmé)
    """
    config = get_power_schedule()

    if not config["enabled"]:
        logger.info("🌙 Extinction programmée ignorée (désactivé)")
        return

    logger.info("🌙 === EXTINCTION PROGRAMMÉE DÉMARRÉE ===")

    # 1. Arrêt gracieux de tous les services
    summary = graceful_shutdown()

    # 2. Mettre à jour la config
    config["last_shutdown"] = datetime.now().isoformat()
    _save_config(config)

    # 3. Petit délai avant l'extinction pour s'assurer que tout est bien arrêté
    import time
    time.sleep(5)

    # 4. Éteindre avec rtcwake (programme le réveil BIOS automatiquement)
    wake_hour = config["wake_hour"]
    logger.info(f"🌙 Extinction complète — Réveil BIOS prévu à {wake_hour}")
    shutdown_with_rtcwake(wake_hour)
