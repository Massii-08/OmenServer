"""
Routes Paramètres serveur — Lecture/écriture des fichiers de configuration.

Permet de lire et modifier server.properties et d'autres fichiers
de configuration directement dans le conteneur Docker.

Routes:
    GET  /api/servers/{id}/properties       → Lire les propriétés du serveur
    PUT  /api/servers/{id}/properties       → Modifier les propriétés
    GET  /api/servers/{id}/config/{file}    → Lire un fichier config quelconque
    PUT  /api/servers/{id}/config/{file}    → Écrire dans un fichier config
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

router = APIRouter(prefix="/api/servers", tags=["Paramètres serveur"])


# --- Schémas ---

class PropertiesUpdateRequest(BaseModel):
    """Données pour mettre à jour des propriétés du serveur."""
    properties: dict  # {"motd": "Mon serveur", "max-players": "20", ...}


class ConfigFileUpdateRequest(BaseModel):
    """Écrire du contenu brut dans un fichier config."""
    content: str


# --- Helpers Docker ---

def _docker_exec(docker_id: str, cmd: str) -> str:
    """Exécute une commande dans le conteneur et retourne la sortie."""
    client = docker_manager._get_docker_client()
    if not client:
        raise RuntimeError("Docker non disponible")
    try:
        container = client.containers.get(docker_id)
        result = container.exec_run(["sh", "-c", cmd], demux=True)
        stdout = result.output[0] if result.output[0] else b""
        return stdout.decode("utf-8", errors="replace")
    except Exception as e:
        logger.error(f"Erreur docker exec: {e}")
        raise RuntimeError(f"Erreur d'exécution: {e}")


def _docker_write(docker_id: str, path: str, content: str):
    """Écrit du contenu dans un fichier à l'intérieur du conteneur."""
    import base64
    client = docker_manager._get_docker_client()
    if not client:
        raise RuntimeError("Docker non disponible")
    try:
        container = client.containers.get(docker_id)
        # Encode en base64 pour éviter les problèmes d'échappement
        b64 = base64.b64encode(content.encode("utf-8")).decode("ascii")
        container.exec_run(["sh", "-c", f"echo '{b64}' | base64 -d > {path}"])
    except Exception as e:
        logger.error(f"Erreur docker write: {e}")
        raise RuntimeError(f"Erreur d'écriture: {e}")


def _get_server_or_404(server_id: int, db: Session) -> GameServer:
    """Récupère un serveur ou lève une 404."""
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")
    if not server.docker_id:
        raise HTTPException(status_code=400, detail="Conteneur Docker non trouvé")
    return server


# --- Parsing server.properties ---

def _parse_properties(raw: str) -> dict:
    """Parse un fichier server.properties en dictionnaire."""
    props = {}
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            key, _, value = line.partition("=")
            props[key.strip()] = value.strip()
    return props


def _build_properties(props: dict, original_raw: str) -> str:
    """
    Reconstruit le fichier server.properties en préservant l'ordre
    et les commentaires de l'original.
    """
    lines = []
    seen_keys = set()
    for line in original_raw.splitlines():
        stripped = line.strip()
        if stripped.startswith("#") or not stripped:
            lines.append(line)
            continue
        if "=" in stripped:
            key, _, _ = stripped.partition("=")
            key = key.strip()
            seen_keys.add(key)
            if key in props:
                lines.append(f"{key}={props[key]}")
            else:
                lines.append(line)
        else:
            lines.append(line)
    # Ajouter les nouvelles clés
    for key, value in props.items():
        if key not in seen_keys:
            lines.append(f"{key}={value}")
    return "\n".join(lines) + "\n"


# --- Routes ---

@router.get("/{server_id}/properties")
def get_properties(
    server_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Lire toutes les propriétés du server.properties."""
    server = _get_server_or_404(server_id, db)
    try:
        # Le fichier est dans /data/server.properties pour l'image itzg/minecraft-server
        raw = _docker_exec(server.docker_id, "cat /data/server.properties 2>/dev/null || echo ''")
        props = _parse_properties(raw)
        return {"properties": props, "raw": raw}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/{server_id}/properties")
def update_properties(
    server_id: int,
    request: PropertiesUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Modifier des propriétés dans server.properties.
    Seules les clés envoyées sont modifiées, les autres restent intactes.
    """
    server = _get_server_or_404(server_id, db)
    try:
        # Lire l'original
        raw = _docker_exec(server.docker_id, "cat /data/server.properties 2>/dev/null || echo ''")
        current = _parse_properties(raw)

        # Fusionner les modifications
        current.update(request.properties)

        # Reconstruire et écrire
        new_content = _build_properties(current, raw)
        _docker_write(server.docker_id, "/data/server.properties", new_content)

        return {"message": "Propriétés mises à jour ✅", "properties": current}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{server_id}/config/{filename}")
def get_config_file(
    server_id: int,
    filename: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Lire un fichier de configuration du serveur.
    Fichiers autorisés : server.properties, spigot.yml, bukkit.yml,
    paper-global.yml, paper-world-defaults.yml
    """
    allowed = [
        "server.properties", "spigot.yml", "bukkit.yml",
        "paper-global.yml", "paper-world-defaults.yml",
        "config/paper-global.yml", "config/paper-world-defaults.yml",
    ]
    if filename not in allowed:
        raise HTTPException(status_code=400, detail="Fichier non autorisé")

    server = _get_server_or_404(server_id, db)
    try:
        content = _docker_exec(server.docker_id, f"cat /data/{filename} 2>/dev/null || echo ''")
        return {"filename": filename, "content": content}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/{server_id}/config/{filename}")
def update_config_file(
    server_id: int,
    filename: str,
    request: ConfigFileUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Écrire dans un fichier de configuration autorisé."""
    allowed = [
        "server.properties", "spigot.yml", "bukkit.yml",
        "paper-global.yml", "paper-world-defaults.yml",
    ]
    if filename not in allowed:
        raise HTTPException(status_code=400, detail="Fichier non autorisé")

    server = _get_server_or_404(server_id, db)
    try:
        _docker_write(server.docker_id, f"/data/{filename}", request.content)
        return {"message": f"{filename} mis à jour ✅"}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
