"""
Routes Accès — Gestion des ports dédiés et accès SFTP.

Permet de voir et gérer les ports réseau exposés par le conteneur Docker.

Routes:
    GET    /api/servers/{id}/ports     → Liste des ports exposés
    POST   /api/servers/{id}/ports     → Exposer un nouveau port (nécessite recréation)
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.auth.utils import get_current_user
from backend.auth.models import User
from backend.game_server.models import GameServer
from backend.game_server import docker_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/servers", tags=["Accès"])


class PortInfo(BaseModel):
    """Info d'un port exposé."""
    container_port: str
    host_port: int
    protocol: str = "tcp"
    description: str = ""


# --- Routes ---

@router.get("/{server_id}/ports")
def get_ports(
    server_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Liste tous les ports exposés par le conteneur Docker."""
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")
    if not server.docker_id:
        return {"ports": [], "main_port": server.port}

    client = docker_manager._get_docker_client()
    if not client:
        return {"ports": [{"host_port": server.port, "container_port": str(server.port), "protocol": "tcp", "description": "Port principal"}]}

    try:
        container = client.containers.get(server.docker_id)
        port_bindings = container.attrs.get("HostConfig", {}).get("PortBindings", {}) or {}

        ports = []
        for container_port, bindings in port_bindings.items():
            if bindings:
                for binding in bindings:
                    host_port = int(binding.get("HostPort", 0))
                    proto = "udp" if "/udp" in container_port else "tcp"
                    ports.append({
                        "container_port": container_port.replace("/tcp", "").replace("/udp", ""),
                        "host_port": host_port,
                        "protocol": proto,
                        "description": "Port principal" if host_port == server.port else "",
                    })

        return {
            "ports": sorted(ports, key=lambda p: p["host_port"]),
            "main_port": server.port,
            "server_ip": docker_manager.get_local_ip(),
        }
    except Exception as e:
        logger.error(f"Erreur lecture ports: {e}")
        return {"ports": [{"host_port": server.port, "container_port": str(server.port), "protocol": "tcp", "description": "Port principal"}]}


@router.get("/{server_id}/sftp-info")
def get_sftp_info(
    server_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Retourne les informations de connexion SFTP."""
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")

    return {
        "host": docker_manager.get_local_ip(),
        "port": 2222,
        "username": f"server_{server.id}",
        "directory": f"/data/servers/{server.id}/",
        "note": "Le service SFTP doit être activé sur le serveur hôte",
    }
