"""
Module Réseau — Router API.

Monitoring réseau (latence, débit, IP publique) et Wake-on-LAN
pour allumer d'autres PC à distance.

Endpoints:
    GET    /api/network/status       — Statut réseau actuel (ping + IP)
    GET    /api/network/history      — Historique des mesures (24h)
    POST   /api/network/speedtest    — Lancer un test de débit
    POST   /api/network/ping         — Test de latence
    GET    /api/network/devices      — Liste des appareils WoL
    POST   /api/network/devices      — Ajouter un appareil WoL
    DELETE /api/network/devices/{id} — Supprimer un appareil
    POST   /api/network/wake/{id}    — Envoyer un magic packet WoL
"""

import os
import re
import socket
import struct
import subprocess
import logging
import time
import urllib.request
from datetime import datetime, timedelta
from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from backend.database import get_db
from backend.auth.utils import get_current_user
from backend.network.models import WolDevice, NetworkLog

logger = logging.getLogger("omenserver.network")

router = APIRouter(prefix="/api/network", tags=["network"])


# === Modèles Pydantic ===
class WolDeviceCreate(BaseModel):
    name: str
    mac_address: str
    ip_hint: Optional[str] = None


# === Helpers ===

def _ping(host="8.8.8.8", count=3):
    """Ping un hôte et retourne la latence moyenne en ms."""
    try:
        # macOS et Linux utilisent -c pour le nombre de paquets
        result = subprocess.run(
            ["ping", "-c", str(count), "-W", "2", host],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            # Parser la sortie pour trouver la latence moyenne
            # Format: rtt min/avg/max/mdev = 1.234/5.678/9.012/1.234 ms
            match = re.search(r'(?:avg|moy)[^=]*=\s*[\d.]+/([\d.]+)', result.stdout)
            if match:
                return round(float(match.group(1)), 1)
            # Fallback : chercher le pattern min/avg/max
            match = re.search(r'([\d.]+)/([\d.]+)/([\d.]+)', result.stdout)
            if match:
                return round(float(match.group(2)), 1)
        return None
    except Exception as e:
        logger.warning(f"Ping failed: {e}")
        return None


def _get_public_ip():
    """Récupère l'IP publique via un service externe."""
    try:
        response = urllib.request.urlopen("https://api.ipify.org", timeout=5)
        return response.read().decode("utf-8").strip()
    except Exception:
        try:
            response = urllib.request.urlopen("https://ifconfig.me/ip", timeout=5)
            return response.read().decode("utf-8").strip()
        except Exception:
            return None


def _get_local_ip():
    """Récupère l'IP locale."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def _send_wol(mac_address, broadcast="255.255.255.255"):
    """
    Envoie un magic packet Wake-on-LAN.
    Le magic packet = 6 bytes de 0xFF suivis de l'adresse MAC répétée 16 fois.
    """
    # Nettoyer le MAC address
    mac = mac_address.replace(":", "").replace("-", "").replace(".", "")
    if len(mac) != 12:
        raise ValueError(f"Adresse MAC invalide: {mac_address}")

    # Construire le magic packet
    mac_bytes = bytes.fromhex(mac)
    magic_packet = b'\xff' * 6 + mac_bytes * 16

    # Envoyer via UDP broadcast
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.sendto(magic_packet, (broadcast, 9))
    sock.close()

    logger.info(f"📡 Magic packet envoyé à {mac_address}")


# === Routes — Monitoring ===

@router.get("/status")
async def get_network_status(user=Depends(get_current_user)):
    """Statut réseau actuel : latence, IP publique, IP locale."""
    latency = _ping()
    public_ip = _get_public_ip()
    local_ip = _get_local_ip()

    # Déterminer la qualité de la connexion
    if latency is None and public_ip is not None:
        # ICMP bloqué mais internet fonctionne (IP publique résolue)
        quality = "degraded"
        quality_label = "🟡 ICMP bloqué"
    elif latency is None:
        quality = "offline"
        quality_label = "🔴 Hors ligne"
    elif latency < 20:
        quality = "excellent"
        quality_label = "🟢 Excellent"
    elif latency < 50:
        quality = "good"
        quality_label = "🟢 Bon"
    elif latency < 100:
        quality = "average"
        quality_label = "🟡 Moyen"
    else:
        quality = "poor"
        quality_label = "🔴 Mauvais"

    return {
        "online": latency is not None or public_ip is not None,
        "latency_ms": latency,
        "quality": quality,
        "quality_label": quality_label,
        "public_ip": public_ip,
        "local_ip": local_ip,
    }


@router.get("/history")
async def get_history(hours: int = 24, db: Session = Depends(get_db), user=Depends(get_current_user)):
    """Historique des mesures réseau sur les dernières heures."""
    since = datetime.utcnow() - timedelta(hours=hours)
    logs = db.query(NetworkLog).filter(
        NetworkLog.timestamp >= since
    ).order_by(NetworkLog.timestamp.asc()).all()

    return {
        "period_hours": hours,
        "count": len(logs),
        "logs": [
            {
                "timestamp": log.timestamp.isoformat(),
                "latency_ms": log.latency_ms,
                "download_mbps": log.download_mbps,
                "upload_mbps": log.upload_mbps,
                "public_ip": log.public_ip,
            }
            for log in logs
        ],
    }


@router.post("/ping")
async def run_ping(db: Session = Depends(get_db), user=Depends(get_current_user)):
    """Lance un test de latence et enregistre le résultat."""
    latency = _ping()
    public_ip = _get_public_ip()

    # Enregistrer dans l'historique
    log = NetworkLog(
        latency_ms=latency,
        public_ip=public_ip,
    )
    db.add(log)
    db.commit()

    return {
        "latency_ms": latency,
        "public_ip": public_ip,
        "online": latency is not None,
    }


@router.post("/speedtest")
async def run_speedtest(db: Session = Depends(get_db), user=Depends(get_current_user)):
    """
    Lance un test de débit simple.
    Utilise un fichier de test pour mesurer le download, et un ping pour la latence.
    Note: Pour un vrai speed test complet, il faudrait installer 'speedtest-cli'.
    """
    latency = _ping()
    public_ip = _get_public_ip()

    # Test de download simple (télécharger un fichier de 1Mo)
    download_mbps = None
    try:
        start = time.time()
        req = urllib.request.urlopen("http://speedtest.tele2.net/1MB.zip", timeout=15)
        data = req.read()
        elapsed = time.time() - start
        if elapsed > 0:
            download_mbps = round((len(data) * 8) / (elapsed * 1_000_000), 1)  # bits/s → Mbps
    except Exception as e:
        logger.warning(f"Speed test download failed: {e}")

    # Enregistrer dans l'historique
    log = NetworkLog(
        latency_ms=latency,
        download_mbps=download_mbps,
        public_ip=public_ip,
    )
    db.add(log)
    db.commit()

    return {
        "latency_ms": latency,
        "download_mbps": download_mbps,
        "upload_mbps": None,  # Upload test pas encore implémenté
        "public_ip": public_ip,
    }


# === Routes — Wake-on-LAN ===

@router.get("/devices")
async def list_devices(db: Session = Depends(get_db), user=Depends(get_current_user)):
    """Liste les appareils Wake-on-LAN enregistrés."""
    devices = db.query(WolDevice).order_by(WolDevice.created_at.desc()).all()
    return [
        {
            "id": d.id,
            "name": d.name,
            "mac_address": d.mac_address,
            "ip_hint": d.ip_hint,
            "last_wake": d.last_wake.isoformat() if d.last_wake else None,
        }
        for d in devices
    ]


@router.post("/devices")
async def add_device(req: WolDeviceCreate, db: Session = Depends(get_db), user=Depends(get_current_user)):
    """Ajouter un appareil Wake-on-LAN."""
    # Valider le format MAC
    mac = req.mac_address.strip().upper()
    mac_clean = mac.replace(":", "").replace("-", "").replace(".", "")
    if len(mac_clean) != 12 or not all(c in "0123456789ABCDEF" for c in mac_clean):
        raise HTTPException(status_code=400, detail="Adresse MAC invalide. Format: AA:BB:CC:DD:EE:FF")

    # Normaliser le format
    mac_formatted = ":".join(mac_clean[i:i+2] for i in range(0, 12, 2))

    device = WolDevice(
        name=req.name,
        mac_address=mac_formatted,
        ip_hint=req.ip_hint,
    )
    db.add(device)
    db.commit()
    db.refresh(device)

    logger.info(f"📡 Appareil WoL ajouté: {req.name} ({mac_formatted})")
    return {"id": device.id, "name": device.name, "mac_address": device.mac_address, "message": "Appareil ajouté !"}


@router.delete("/devices/{device_id}")
async def delete_device(device_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    """Supprimer un appareil WoL."""
    device = db.query(WolDevice).filter(WolDevice.id == device_id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Appareil non trouvé.")

    db.delete(device)
    db.commit()

    logger.info(f"🗑️ Appareil WoL supprimé: {device.name}")
    return {"success": True, "message": f"Appareil '{device.name}' supprimé."}


@router.post("/wake/{device_id}")
async def wake_device(device_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    """Envoyer un magic packet pour allumer un appareil."""
    device = db.query(WolDevice).filter(WolDevice.id == device_id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Appareil non trouvé.")

    try:
        _send_wol(device.mac_address)
        device.last_wake = datetime.utcnow()
        db.commit()

        return {
            "success": True,
            "message": f"Magic packet envoyé à {device.name} ({device.mac_address}) !",
            "note": "L'appareil devrait démarrer dans quelques secondes (si WoL est activé dans le BIOS).",
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur: {str(e)}")
