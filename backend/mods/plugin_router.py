"""
Routes API pour la gestion des plugins Spigot/Paper/Bukkit.

Utilise Modrinth comme source de plugins.

Routes:
    GET    /api/plugins/search              → Rechercher sur Modrinth
    GET    /api/plugins/{project_id}/versions → Versions dispo
    POST   /api/plugins/install              → Installer un plugin
    GET    /api/plugins/server/{server_id}   → Plugins installés
    DELETE /api/plugins/server/{server_id}/{filename} → Supprimer
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.auth.utils import get_current_user
from backend.auth.models import User
from backend.game_server.models import GameServer
from backend.mods import plugin_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plugins", tags=["Plugins Modrinth"])


class InstallPluginRequest(BaseModel):
    """Données pour installer un plugin."""
    server_id: int
    plugin_name: str
    download_url: str
    filename: str


@router.get("/search")
def search_plugins(
    q: str = Query(..., min_length=2, description="Terme de recherche"),
    game_version: str = Query(None, description="Version MC pour filtrer"),
    limit: int = Query(20, ge=1, le=50),
    current_user: User = Depends(get_current_user),
):
    """Recherche des plugins sur Modrinth."""
    try:
        return plugin_manager.search_plugins(query=q, limit=limit, game_version=game_version)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))


@router.get("/{project_id}/versions")
def get_plugin_versions(
    project_id: str,
    current_user: User = Depends(get_current_user),
):
    """Récupère les versions d'un plugin."""
    try:
        versions = plugin_manager.get_plugin_versions(project_id)
        return {"versions": versions}
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))


@router.post("/install")
def install_plugin(
    request: InstallPluginRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Télécharge et installe un plugin sur un serveur."""
    server = db.query(GameServer).filter(GameServer.id == request.server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")
    if not server.docker_id:
        raise HTTPException(status_code=400, detail="Pas de conteneur Docker")

    try:
        filename = plugin_manager.install_plugin(
            docker_id=server.docker_id,
            download_url=request.download_url,
            filename=request.filename,
        )
        return {
            "message": f"Plugin '{request.plugin_name}' installé !",
            "filename": filename,
        }
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/server/{server_id}")
def list_installed_plugins(
    server_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Liste les plugins installés sur un serveur."""
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")
    if not server.docker_id:
        return {"plugins": [], "count": 0}

    plugins = plugin_manager.list_installed_plugins(server.docker_id)
    return {"plugins": plugins, "count": len(plugins)}


@router.delete("/server/{server_id}/{filename}")
def remove_plugin(
    server_id: int,
    filename: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Supprime un plugin d'un serveur."""
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")
    if not server.docker_id:
        raise HTTPException(status_code=400, detail="Pas de conteneur Docker")

    try:
        plugin_manager.remove_plugin(server.docker_id, filename)
        return {"message": f"Plugin '{filename}' supprimé"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
