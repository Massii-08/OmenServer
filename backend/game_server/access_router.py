"""
Routes Accès — Gestion des ports dédiés et accès SFTP.

Permet de voir et gérer les ports réseau exposés par le conteneur Docker.

Routes:
    GET    /api/servers/{id}/ports      → Liste des ports exposés
    POST   /api/servers/{id}/ports      → Ajouter un port (recréation du conteneur)
    DELETE /api/servers/{id}/ports/{hp}  → Retirer un port additionnel
    GET    /api/servers/{id}/sftp-info   → Infos SFTP
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


class AddPortRequest(BaseModel):
    """Requête pour ajouter un port."""
    host_port: int
    container_port: int
    protocol: str = "tcp"
    description: str = ""


# --- Helpers ---

def _get_port_bindings(container) -> dict:
    """Récupère les PortBindings actuels d'un conteneur."""
    return container.attrs.get("HostConfig", {}).get("PortBindings", {}) or {}


def _rebuild_container_with_ports(server, new_bindings: dict, db: Session):
    """
    Recréer un conteneur avec de nouveaux ports.
    1. Commit le conteneur actuel en image temporaire
    2. Supprime l'ancien conteneur
    3. Recrée avec les nouveaux ports
    """
    client = docker_manager._get_docker_client()
    if not client:
        raise RuntimeError("Docker non disponible")

    container = client.containers.get(server.docker_id)
    was_running = container.status == "running"

    # Récupérer les infos actuelles
    old_config = container.attrs
    env_list = old_config.get("Config", {}).get("Env", [])
    image = old_config.get("Config", {}).get("Image", "")
    name = old_config.get("Name", "").lstrip("/")
    mem_limit = old_config.get("HostConfig", {}).get("Memory", 0)

    # Arrêter si en cours
    if was_running:
        container.stop(timeout=30)

    # Commit l'état actuel
    temp_image = container.commit(repository=f"omen-temp-{server.id}", tag="rebuild")
    logger.info(f"Image temporaire créée: {temp_image.short_id}")

    # Supprimer l'ancien conteneur
    container.remove(force=True)

    # Recréer avec les nouveaux ports
    new_container = client.containers.create(
        image=temp_image.id,
        name=name,
        ports=new_bindings,
        environment={e.split("=", 1)[0]: e.split("=", 1)[1] for e in env_list if "=" in e},
        mem_limit=mem_limit if mem_limit > 0 else None,
        detach=True,
        restart_policy={"Name": "unless-stopped"},
    )

    # Mettre à jour la DB
    server.docker_id = new_container.id
    db.commit()

    # Redémarrer si c'était en cours
    if was_running:
        new_container.start()

    # Nettoyer l'image temporaire
    try:
        client.images.remove(temp_image.id, force=True)
    except Exception:
        pass

    logger.info(f"Conteneur recréé avec nouveaux ports: {new_container.short_id}")
    return new_container


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
        return {"ports": [{"host_port": server.port, "container_port": str(server.port), "protocol": "tcp", "description": "Port principal du serveur"}]}

    try:
        container = client.containers.get(server.docker_id)
        port_bindings = _get_port_bindings(container)

        ports = []
        for container_port, bindings in port_bindings.items():
            if bindings:
                for binding in bindings:
                    host_port = int(binding.get("HostPort", 0))
                    proto = "udp" if "/udp" in container_port else "tcp"
                    is_main = host_port == server.port
                    ports.append({
                        "container_port": container_port.replace("/tcp", "").replace("/udp", ""),
                        "host_port": host_port,
                        "protocol": proto,
                        "description": "Port principal du serveur" if is_main else "",
                        "is_main": is_main,
                    })

        return {
            "ports": sorted(ports, key=lambda p: p["host_port"]),
            "main_port": server.port,
            "server_ip": docker_manager.get_local_ip(),
        }
    except Exception as e:
        logger.error(f"Erreur lecture ports: {e}")
        return {"ports": [{"host_port": server.port, "container_port": str(server.port), "protocol": "tcp", "description": "Port principal du serveur", "is_main": True}]}


@router.post("/{server_id}/ports")
def add_port(
    server_id: int,
    request: AddPortRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Ajouter un port au conteneur.
    Le conteneur est arrêté, recréé avec le nouveau port, puis redémarré.
    """
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")
    if not server.docker_id:
        raise HTTPException(status_code=400, detail="Pas de conteneur Docker")

    # Validation
    if request.host_port < 1024 or request.host_port > 65535:
        raise HTTPException(status_code=400, detail="Le port doit être entre 1024 et 65535")

    client = docker_manager._get_docker_client()
    if not client:
        raise HTTPException(status_code=500, detail="Docker non disponible")

    try:
        container = client.containers.get(server.docker_id)
        current_bindings = _get_port_bindings(container)

        # Construire les nouveaux bindings (format Docker API)
        proto = request.protocol.lower()
        key = f"{request.container_port}/{proto}"

        # Vérifier si le port host est déjà utilisé
        for cp, binds in current_bindings.items():
            if binds:
                for b in binds:
                    if int(b.get("HostPort", 0)) == request.host_port:
                        raise HTTPException(status_code=400, detail=f"Le port {request.host_port} est déjà utilisé")

        # Convertir les bindings actuels au format ports_config pour containers.create
        new_bindings = {}
        for cp, binds in current_bindings.items():
            if binds:
                new_bindings[cp] = int(binds[0].get("HostPort", 0))

        # Ajouter le nouveau port
        new_bindings[key] = request.host_port

        # Recréer le conteneur
        _rebuild_container_with_ports(server, new_bindings, db)

        return {
            "message": f"Port {request.host_port} ajouté",
            "host_port": request.host_port,
            "container_port": request.container_port,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Erreur ajout port: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{server_id}/ports/{host_port}")
def remove_port(
    server_id: int,
    host_port: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Retirer un port additionnel (pas le port principal)."""
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")
    if not server.docker_id:
        raise HTTPException(status_code=400, detail="Pas de conteneur Docker")
    if host_port == server.port:
        raise HTTPException(status_code=400, detail="Impossible de supprimer le port principal")

    client = docker_manager._get_docker_client()
    if not client:
        raise HTTPException(status_code=500, detail="Docker non disponible")

    try:
        container = client.containers.get(server.docker_id)
        current_bindings = _get_port_bindings(container)

        # Reconstruire sans le port à supprimer
        new_bindings = {}
        found = False
        for cp, binds in current_bindings.items():
            if binds:
                hp = int(binds[0].get("HostPort", 0))
                if hp == host_port:
                    found = True
                    continue
                new_bindings[cp] = hp

        if not found:
            raise HTTPException(status_code=404, detail="Port non trouvé")

        _rebuild_container_with_ports(server, new_bindings, db)
        return {"message": f"Port {host_port} supprimé"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Erreur suppression port: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{server_id}/sftp-info")
def get_sftp_info(
    server_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Retourne les informations de connexion SFTP avec les vrais credentials."""
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")

    ip = docker_manager.get_local_ip()
    username = f"mc_{server.id}"

    # Générer un mot de passe SFTP si pas encore fait
    if not server.sftp_password:
        from backend.game_server.sftp_manager import generate_sftp_password
        server.sftp_password = generate_sftp_password()
        db.commit()

    return {
        "host": ip,
        "port": 2222,
        "username": username,
        "password": server.sftp_password,
        "directory": "/data",
        "winscp_url": f"sftp://{username}@{ip}:2222/",
    }


@router.post("/{server_id}/sftp-reset")
def reset_sftp_password(
    server_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Régénère le mot de passe SFTP d'un serveur et recrée le conteneur SFTP."""
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")

    # Vérifier que l'utilisateur est le propriétaire ou admin
    if not current_user.is_admin and server.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Accès refusé")

    from backend.game_server.sftp_manager import generate_sftp_password, rebuild_sftp_container
    server.sftp_password = generate_sftp_password()
    db.commit()

    # Recréer le conteneur SFTP avec le nouveau mot de passe
    result = rebuild_sftp_container(db)
    logger.info(f"SFTP password reset pour serveur {server_id}: {result}")

    return {
        "message": "Mot de passe SFTP régénéré",
        "new_password": server.sftp_password,
        "sftp_status": result,
    }


@router.get("/sftp-status")
def get_sftp_global_status(
    current_user: User = Depends(get_current_user),
):
    """Retourne le statut global du conteneur SFTP."""
    from backend.game_server.sftp_manager import get_sftp_status
    return get_sftp_status()

