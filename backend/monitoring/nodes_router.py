"""
Nodes Router — Monitoring multi-machines.

Les PC du réseau font tourner un agent léger (omen_agent.py) qui envoie
un heartbeat toutes les 10 secondes avec CPU, RAM, Disque, Température, etc.

Les données sont stockées en mémoire (pas en DB) — elles sont éphémères.
Un PC est marqué "offline" si aucun heartbeat reçu depuis 30 secondes.

Sécurité : les agents s'authentifient via une clé API (header X-Agent-Key).
La clé est auto-générée au premier lancement et visible dans les Settings.

Routes:
    POST /api/nodes/heartbeat        → Heartbeat d'un agent (avec X-Agent-Key)
    GET  /api/nodes                  → Liste des PC connectés (auth utilisateur)
    POST /api/nodes/{hostname}/reboot   → Redémarrer un PC à distance (admin)
    POST /api/nodes/{hostname}/shutdown → Éteindre un PC à distance (admin)
    GET  /api/nodes/key              → Voir la clé API agent (admin)
    POST /api/nodes/key/reset        → Régénérer la clé API (admin)
    DELETE /api/nodes/{hostname}      → Retirer un PC de la liste (admin)
"""

import logging
import os
import secrets
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Header, Request
from pydantic import BaseModel

from backend.auth.utils import get_current_user
from backend.auth.models import User

logger = logging.getLogger("omenserver")

router = APIRouter(prefix="/api/nodes", tags=["Nodes Monitoring"])

# --- Stockage en mémoire ---
# { "hostname": { ...stats, "last_seen": timestamp } }
_nodes: dict = {}

# File de commandes en attente
# { "hostname": [{"command": "reboot", "timestamp": ...}, ...] }
_pending_commands: dict = {}

# Durée avant de considérer un PC offline (en secondes)
_OFFLINE_THRESHOLD = 30

# --- Clé API ---
_KEY_DIR = Path(__file__).resolve().parent.parent.parent / "data"
_KEY_FILE = _KEY_DIR / "nodes_api_key.txt"


def _get_or_create_api_key() -> str:
    """Retourne la clé API. La crée si elle n'existe pas encore."""
    if _KEY_FILE.exists():
        return _KEY_FILE.read_text().strip()

    os.makedirs(_KEY_DIR, exist_ok=True)
    key = secrets.token_urlsafe(32)
    _KEY_FILE.write_text(key)
    logger.info(f"🔑 Clé API agents générée : {key[:8]}...")
    return key


def _verify_agent_key(x_agent_key: Optional[str] = Header(None)):
    """Vérifie que la clé API de l'agent est valide."""
    expected = _get_or_create_api_key()
    if not x_agent_key or x_agent_key != expected:
        raise HTTPException(status_code=403, detail="Clé agent invalide")


# --- Schémas ---

class HeartbeatData(BaseModel):
    """Données envoyées par un agent à chaque heartbeat."""
    hostname: str
    os: str = "Linux"
    cpu_percent: float = 0
    cpu_count: int = 1
    ram_total_gb: float = 0
    ram_used_gb: float = 0
    ram_percent: float = 0
    disk_total_gb: float = 0
    disk_used_gb: float = 0
    disk_percent: float = 0
    temperature: Optional[float] = None
    uptime_hours: float = 0


# --- Routes ---

@router.post("/heartbeat")
def heartbeat(data: HeartbeatData, _key=Depends(_verify_agent_key)):
    """
    Reçoit le heartbeat d'un agent PC.
    Appelé toutes les ~10 secondes par chaque PC du réseau.
    """
    now = time.time()

    _nodes[data.hostname] = {
        "hostname": data.hostname,
        "os": data.os,
        "cpu_percent": round(data.cpu_percent, 1),
        "cpu_count": data.cpu_count,
        "ram_total_gb": round(data.ram_total_gb, 1),
        "ram_used_gb": round(data.ram_used_gb, 1),
        "ram_percent": round(data.ram_percent, 1),
        "disk_total_gb": round(data.disk_total_gb, 1),
        "disk_used_gb": round(data.disk_used_gb, 1),
        "disk_percent": round(data.disk_percent, 1),
        "temperature": round(data.temperature, 1) if data.temperature else None,
        "uptime_hours": round(data.uptime_hours, 1),
        "last_seen": now,
        "last_seen_iso": datetime.now().isoformat(),
    }

    # Vérifier s'il y a des commandes en attente pour ce PC
    commands = _pending_commands.pop(data.hostname, [])

    return {"status": "ok", "commands": commands}


@router.get("")
def list_nodes(current_user: User = Depends(get_current_user)):
    """
    Retourne la liste de tous les PC connus avec leur statut.
    """
    now = time.time()
    result = []

    for hostname, info in _nodes.items():
        age = now - info["last_seen"]
        online = age < _OFFLINE_THRESHOLD

        node = {
            **info,
            "online": online,
            "last_seen_seconds_ago": round(age, 0),
        }

        # Enlever les stats si offline depuis longtemps (>5 min)
        if age > 300:
            node["cpu_percent"] = 0
            node["ram_percent"] = 0
            node["disk_percent"] = 0
            node["temperature"] = None

        result.append(node)

    # Trier: online d'abord, puis par nom
    result.sort(key=lambda n: (not n["online"], n["hostname"].lower()))

    return result


@router.get("/key")
def get_api_key(current_user: User = Depends(get_current_user)):
    """Retourne la clé API pour les agents. Admin uniquement."""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin uniquement")

    return {"key": _get_or_create_api_key()}


@router.post("/key/reset")
def reset_api_key(current_user: User = Depends(get_current_user)):
    """Régénère la clé API. Les agents devront être mis à jour."""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin uniquement")

    key = secrets.token_urlsafe(32)
    os.makedirs(_KEY_DIR, exist_ok=True)
    _KEY_FILE.write_text(key)
    logger.info(f"🔑 Clé API agents régénérée : {key[:8]}...")

    return {"key": key, "message": "⚠️ Mettez à jour la clé sur tous les agents !"}


@router.delete("/{hostname}")
def remove_node(hostname: str, current_user: User = Depends(get_current_user)):
    """Retirer un PC de la liste."""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin uniquement")

    if hostname in _nodes:
        del _nodes[hostname]
        _pending_commands.pop(hostname, None)
        return {"message": f"✅ '{hostname}' retiré"}
    else:
        raise HTTPException(status_code=404, detail="PC non trouvé")


# --- Commandes à distance ---

@router.post("/{hostname}/reboot")
def reboot_node(hostname: str, current_user: User = Depends(get_current_user)):
    """
    Envoie une commande de redémarrage à un PC distant.
    La commande sera exécutée par l'agent au prochain heartbeat.
    """
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin uniquement")

    if hostname not in _nodes:
        raise HTTPException(status_code=404, detail="PC non trouvé")

    # Vérifier que le PC est en ligne
    age = time.time() - _nodes[hostname]["last_seen"]
    if age > _OFFLINE_THRESHOLD:
        raise HTTPException(status_code=400, detail="PC hors ligne — impossible d'envoyer la commande")

    if hostname not in _pending_commands:
        _pending_commands[hostname] = []

    _pending_commands[hostname].append({
        "command": "reboot",
        "timestamp": datetime.now().isoformat(),
    })

    logger.info(f"🔄 Commande REBOOT envoyée à '{hostname}'")
    return {"message": f"🔄 Redémarrage de '{hostname}' demandé — exécution au prochain heartbeat"}


@router.post("/{hostname}/shutdown")
def shutdown_node(hostname: str, current_user: User = Depends(get_current_user)):
    """
    Envoie une commande d'extinction à un PC distant.
    La commande sera exécutée par l'agent au prochain heartbeat.
    """
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin uniquement")

    if hostname not in _nodes:
        raise HTTPException(status_code=404, detail="PC non trouvé")

    age = time.time() - _nodes[hostname]["last_seen"]
    if age > _OFFLINE_THRESHOLD:
        raise HTTPException(status_code=400, detail="PC hors ligne — impossible d'envoyer la commande")

    if hostname not in _pending_commands:
        _pending_commands[hostname] = []

    _pending_commands[hostname].append({
        "command": "shutdown",
        "timestamp": datetime.now().isoformat(),
    })

    logger.info(f"⏻ Commande SHUTDOWN envoyée à '{hostname}'")
    return {"message": f"⏻ Extinction de '{hostname}' demandée — exécution au prochain heartbeat"}
