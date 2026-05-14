"""
Routes de gestion de l'alimentation — Extinction/réveil programmés.
Version: 2.1 — Validation sudo pré-vol + meilleur logging.

Permet de configurer l'extinction automatique de la machine
entre des heures configurables (ex: 1h→5h du matin).
Utilise rtcwake (Linux) pour programmer le réveil via le BIOS.

Routes:
    GET  /api/power/schedule    → Config actuelle
    PUT  /api/power/schedule    → Modifier la config
    POST /api/power/test        → Test: éteint dans 60s avec réveil 5 min après
    POST /api/power/cancel      → Annuler un shutdown programmé
"""

import subprocess
import logging
import threading
import time
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from backend.auth.utils import get_current_user
from backend.auth.models import User
from backend.scheduler.power_manager import (
    get_power_schedule,
    set_power_schedule,
    graceful_shutdown,
    shutdown_with_rtcwake,
)

logger = logging.getLogger("omenserver")

router = APIRouter(prefix="/api/power", tags=["Power Management"])


# --- Schémas ---

class PowerScheduleUpdate(BaseModel):
    """Données pour modifier le planning d'extinction."""
    enabled: Optional[bool] = None
    shutdown_hour: Optional[str] = None   # "HH:MM"
    wake_hour: Optional[str] = None       # "HH:MM"
    days: Optional[str] = None            # "daily" ou "mon,wed,fri"


# --- Routes ---

@router.get("/schedule")
def get_schedule(current_user: User = Depends(get_current_user)):
    """
    Retourne la configuration actuelle du planning d'extinction.
    """
    config = get_power_schedule()

    # Vérifier si rtcwake est disponible sur le système
    rtcwake_ok = False
    try:
        result = subprocess.run(
            ["which", "rtcwake"],
            capture_output=True, text=True, timeout=5,
        )
        rtcwake_ok = result.returncode == 0
    except Exception:
        pass

    config["rtcwake_available"] = rtcwake_ok

    return config


@router.put("/schedule")
def update_schedule(
    request: PowerScheduleUpdate,
    current_user: User = Depends(get_current_user),
):
    """
    Modifie la configuration du planning d'extinction.
    Réservé aux administrateurs.
    """
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin uniquement")

    # Validation des heures
    for field_name, value in [("shutdown_hour", request.shutdown_hour), ("wake_hour", request.wake_hour)]:
        if value:
            parts = value.split(":")
            if len(parts) != 2:
                raise HTTPException(status_code=400, detail=f"Format invalide pour {field_name} (HH:MM)")
            try:
                h, m = int(parts[0]), int(parts[1])
                if h < 0 or h > 23 or m < 0 or m > 59:
                    raise ValueError
            except ValueError:
                raise HTTPException(status_code=400, detail=f"Heure invalide pour {field_name}")

    try:
        config = set_power_schedule(
            enabled=request.enabled,
            shutdown_hour=request.shutdown_hour,
            wake_hour=request.wake_hour,
            days=request.days,
        )

        # Mettre à jour le job dans le scheduler
        from backend.scheduler.engine import update_power_job
        update_power_job(config)

        return {"message": "✅ Planning d'extinction mis à jour", "config": config}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/test")
def test_power(current_user: User = Depends(get_current_user)):
    """
    Test : éteint la machine dans 60 secondes avec réveil 5 minutes après.
    Permet de vérifier que le système fonctionne.
    """
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin uniquement")

    def _delayed_shutdown():
        """Éteint après 60 secondes."""
        logger.info("🌙 Test: extinction dans 60 secondes...")
        time.sleep(60)
        # Programmer un wake dans 5 minutes
        from datetime import datetime, timedelta
        wake_time = datetime.now() + timedelta(minutes=5)
        wake_str = wake_time.strftime("%H:%M")
        shutdown_with_rtcwake(wake_str)

    thread = threading.Thread(target=_delayed_shutdown, daemon=True)
    thread.start()

    return {
        "message": "🌙 Test lancé — La machine s'éteindra dans 60 secondes. Réveil dans 5 min.",
    }


@router.post("/cancel")
def cancel_scheduled_shutdown(current_user: User = Depends(get_current_user)):
    """
    Annule un shutdown programmé (si shutdown -h +X a été utilisé).
    """
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin uniquement")

    try:
        result = subprocess.run(
            ["sudo", "shutdown", "-c"],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0:
            return {"message": "✅ Shutdown programmé annulé"}
        else:
            return {"message": "ℹ️ Aucun shutdown programmé à annuler"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur: {e}")


@router.post("/reboot")
def reboot_server(current_user: User = Depends(get_current_user)):
    """
    Redémarre le serveur Omen (cerveau).
    Effectue un arrêt gracieux de tous les services avant le reboot.
    Vérifie d'abord que sudo est disponible sans mot de passe.
    """
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin uniquement")

    # Vérifier que sudo fonctionne sans mot de passe
    try:
        check = subprocess.run(
            ["sudo", "-n", "true"],
            capture_output=True, text=True, timeout=5,
        )
        if check.returncode != 0:
            logger.error(f"❌ sudo non disponible sans mot de passe: {check.stderr}")
            raise HTTPException(
                status_code=500,
                detail="sudo nécessite un mot de passe. Configurez /etc/sudoers pour le reboot sans mot de passe."
            )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="sudo timeout — vérifiez la config sudoers")
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="sudo non trouvé sur ce système")

    def _delayed_reboot():
        """Arrêt gracieux + reboot après 15 secondes."""
        logger.info("🔄 Reboot demandé — arrêt gracieux des services...")
        time.sleep(3)
        try:
            graceful_shutdown()
        except Exception as e:
            logger.error(f"❌ Erreur pendant l'arrêt gracieux: {e}")
        time.sleep(5)
        logger.info("🔄 Reboot du serveur...")
        try:
            result = subprocess.run(
                ["sudo", "reboot"],
                capture_output=True, text=True, timeout=30,
            )
            if result.returncode != 0:
                logger.error(f"❌ Reboot échoué (code {result.returncode}): {result.stderr}")
            else:
                logger.info(f"✅ Commande reboot envoyée: {result.stdout}")
        except subprocess.TimeoutExpired:
            logger.error("❌ Reboot timeout — la commande a pris trop de temps")
        except Exception as e:
            logger.error(f"❌ Erreur reboot: {e}")

    thread = threading.Thread(target=_delayed_reboot, daemon=True)
    thread.start()

    return {"message": "🔄 Reboot en cours — arrêt gracieux des services puis redémarrage dans ~15 secondes."}


@router.post("/shutdown")
def shutdown_server(current_user: User = Depends(get_current_user)):
    """
    Éteint le serveur Omen (cerveau).
    Effectue un arrêt gracieux de tous les services avant l'extinction.
    Vérifie d'abord que sudo est disponible sans mot de passe.
    """
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin uniquement")

    # Vérifier que sudo fonctionne sans mot de passe
    try:
        check = subprocess.run(
            ["sudo", "-n", "true"],
            capture_output=True, text=True, timeout=5,
        )
        if check.returncode != 0:
            logger.error(f"❌ sudo non disponible sans mot de passe: {check.stderr}")
            raise HTTPException(
                status_code=500,
                detail="sudo nécessite un mot de passe. Configurez /etc/sudoers pour le shutdown sans mot de passe."
            )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="sudo timeout — vérifiez la config sudoers")
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="sudo non trouvé sur ce système")

    def _delayed_shutdown():
        """Arrêt gracieux + extinction après 15 secondes."""
        logger.info("⏻ Shutdown demandé — arrêt gracieux des services...")
        time.sleep(3)
        try:
            graceful_shutdown()
        except Exception as e:
            logger.error(f"❌ Erreur pendant l'arrêt gracieux: {e}")
        time.sleep(5)
        logger.info("⏻ Extinction du serveur...")
        try:
            result = subprocess.run(
                ["sudo", "shutdown", "-h", "now"],
                capture_output=True, text=True, timeout=30,
            )
            if result.returncode != 0:
                logger.error(f"❌ Shutdown échoué (code {result.returncode}): {result.stderr}")
            else:
                logger.info(f"✅ Commande shutdown envoyée: {result.stdout}")
        except subprocess.TimeoutExpired:
            logger.error("❌ Shutdown timeout — la commande a pris trop de temps")
        except Exception as e:
            logger.error(f"❌ Erreur shutdown: {e}")

    thread = threading.Thread(target=_delayed_shutdown, daemon=True)
    thread.start()

    return {"message": "⏻ Extinction en cours — arrêt gracieux des services puis extinction dans ~15 secondes."}


