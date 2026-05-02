"""
Notifications Discord — Webhooks pour les événements serveur.

Routes:
    GET    /api/notifications/settings        → Récupérer les réglages
    PUT    /api/notifications/settings        → Sauvegarder les réglages
    POST   /api/notifications/test            → Tester le webhook
"""

import logging
import json
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from backend.auth.utils import get_current_user
from backend.auth.models import User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/notifications", tags=["Notifications"])

SETTINGS_FILE = Path("data/notification_settings.json")


class NotificationSettings(BaseModel):
    discord_webhook_url: Optional[str] = ""
    notify_server_start: bool = True
    notify_server_stop: bool = True
    notify_server_crash: bool = True
    notify_backup_created: bool = True
    notify_player_join: bool = False
    notify_player_leave: bool = False


def _load_settings() -> dict:
    """Charge les réglages depuis le fichier JSON."""
    if SETTINGS_FILE.exists():
        return json.loads(SETTINGS_FILE.read_text())
    return NotificationSettings().dict()


def _save_settings(settings: dict):
    """Sauvegarde les réglages dans le fichier JSON."""
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(settings, indent=2))


async def send_discord_notification(title: str, description: str, color: int = 0x3b82f6, server_name: str = ""):
    """
    Envoie une notification Discord via webhook.
    Appelé par les autres modules (game_server, backup, etc.)
    """
    settings = _load_settings()
    webhook_url = settings.get("discord_webhook_url", "")
    if not webhook_url:
        return

    embed = {
        "title": f"🖥️ OmenServer — {title}",
        "description": description,
        "color": color,
        "footer": {"text": f"Serveur: {server_name}" if server_name else "OmenServer"},
    }

    try:
        async with httpx.AsyncClient() as client:
            r = await client.post(webhook_url, json={
                "username": "OmenServer",
                "avatar_url": "https://cdn-icons-png.flaticon.com/512/2950/2950657.png",
                "embeds": [embed],
            })
            if r.status_code not in (200, 204):
                logger.warning(f"Discord webhook error: {r.status_code}")
    except Exception as e:
        logger.error(f"Discord notification error: {e}")


# --- Colors for Discord embeds ---
COLOR_GREEN = 0x22c55e   # Start, backup OK
COLOR_RED = 0xef4444     # Stop, crash
COLOR_BLUE = 0x3b82f6    # Info
COLOR_YELLOW = 0xf59e0b  # Warning


@router.get("/settings")
def get_settings(current_user: User = Depends(get_current_user)):
    """Récupère les réglages de notification."""
    return _load_settings()


@router.put("/settings")
def update_settings(
    settings: NotificationSettings,
    current_user: User = Depends(get_current_user),
):
    """Sauvegarde les réglages de notification."""
    _save_settings(settings.dict())
    return {"message": "✅ Réglages sauvegardés", **settings.dict()}


@router.post("/test")
async def test_webhook(current_user: User = Depends(get_current_user)):
    """Envoie un message test au webhook Discord."""
    settings = _load_settings()
    webhook_url = settings.get("discord_webhook_url", "")

    if not webhook_url:
        raise HTTPException(status_code=400, detail="Aucun webhook Discord configuré")

    await send_discord_notification(
        title="🧪 Test de notification",
        description="Si tu vois ce message, les notifications OmenServer fonctionnent ! 🎉",
        color=COLOR_GREEN,
        server_name="Test",
    )

    return {"message": "✅ Notification test envoyée !"}
