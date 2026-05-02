"""
Routes Monitoring — Stats temps réel du conteneur Docker.

Retourne les statistiques CPU, RAM et réseau du conteneur.

Routes:
    GET /api/servers/{id}/stats       → Stats en temps réel
    GET /api/servers/{id}/stats/live  → Snapshot rapide pour les graphiques
"""

import logging
import time

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.auth.utils import get_current_user
from backend.auth.models import User
from backend.game_server.models import GameServer
from backend.game_server import docker_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/servers", tags=["Monitoring"])


def _calc_cpu_percent(stats: dict) -> float:
    """Calcule le % CPU à partir des stats Docker."""
    try:
        cpu_delta = stats["cpu_stats"]["cpu_usage"]["total_usage"] - \
                    stats["precpu_stats"]["cpu_usage"]["total_usage"]
        system_delta = stats["cpu_stats"]["system_cpu_usage"] - \
                       stats["precpu_stats"]["system_cpu_usage"]
        n_cpus = stats["cpu_stats"].get("online_cpus", 1)
        if system_delta > 0 and cpu_delta > 0:
            return round((cpu_delta / system_delta) * n_cpus * 100, 2)
    except (KeyError, TypeError, ZeroDivisionError):
        pass
    return 0.0


@router.get("/{server_id}/stats")
def get_stats(
    server_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Retourne les stats complètes du conteneur."""
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")
    if not server.docker_id:
        return {"error": "Pas de conteneur Docker"}

    client = docker_manager._get_docker_client()
    if not client:
        return {"error": "Docker non disponible"}

    try:
        container = client.containers.get(server.docker_id)
        if container.status != "running":
            return {
                "status": "stopped",
                "cpu_percent": 0, "ram_used_mb": 0, "ram_limit_mb": 0,
                "ram_percent": 0, "net_rx_mb": 0, "net_tx_mb": 0,
            }

        stats = container.stats(stream=False)

        # CPU
        cpu_percent = _calc_cpu_percent(stats)

        # RAM
        mem = stats.get("memory_stats", {})
        ram_used = mem.get("usage", 0)
        ram_limit = mem.get("limit", 0)
        # Soustraire le cache si disponible
        cache = mem.get("stats", {}).get("cache", 0)
        ram_used_net = ram_used - cache

        ram_used_mb = round(ram_used_net / (1024**2), 1)
        ram_limit_mb = round(ram_limit / (1024**2), 1)
        ram_percent = round((ram_used_net / ram_limit) * 100, 1) if ram_limit > 0 else 0

        # Réseau
        networks = stats.get("networks", {})
        net_rx = sum(n.get("rx_bytes", 0) for n in networks.values())
        net_tx = sum(n.get("tx_bytes", 0) for n in networks.values())

        return {
            "status": "running",
            "cpu_percent": cpu_percent,
            "ram_used_mb": ram_used_mb,
            "ram_limit_mb": ram_limit_mb,
            "ram_percent": ram_percent,
            "net_rx_mb": round(net_rx / (1024**2), 2),
            "net_tx_mb": round(net_tx / (1024**2), 2),
            "timestamp": int(time.time()),
        }

    except Exception as e:
        logger.error(f"Erreur stats: {e}")
        return {"error": str(e), "status": "error"}
