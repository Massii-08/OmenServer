"""
Routes API pour la gestion des mods.

Routes:
    GET    /api/mods/search              → Rechercher sur CurseForge
    GET    /api/mods/{mod_id}/files       → Fichiers dispo pour un mod
    POST   /api/mods/install              → Télécharger + installer un mod
    GET    /api/mods/server/{server_id}   → Mods installés sur un serveur
    DELETE /api/mods/server/{server_id}/{filename} → Supprimer un mod
"""

import os
import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session
from typing import Optional

from backend.database import get_db
from backend.auth.utils import get_current_user
from backend.auth.models import User
from backend.game_server.models import GameServer
from backend.mods import curseforge
from backend.config import settings

logger = logging.getLogger("omenserver")

router = APIRouter(prefix="/api/mods", tags=["Mods CurseForge"])


# --- Schémas ---

class InstallModRequest(BaseModel):
    """Données pour installer un mod."""
    server_id: int
    mod_name: str
    download_url: str
    filename: str


# --- Routes ---

@router.get("/search")
def search_mods(
    q: str = Query(..., min_length=2, description="Terme de recherche"),
    category: str = Query("mods", description="Catégorie: mods, modpacks, textures, worlds"),
    page: int = Query(0, ge=0),
    current_user: User = Depends(get_current_user),
):
    """Recherche des mods sur CurseForge."""
    try:
        result = curseforge.search_mods(query=q, category=category, page=page)
        return result
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))


@router.get("/{mod_id}/files")
def get_mod_files(
    mod_id: int,
    game_version: Optional[str] = None,
    current_user: User = Depends(get_current_user),
):
    """Récupère les fichiers disponibles pour un mod."""
    try:
        files = curseforge.get_mod_files(mod_id=mod_id, game_version=game_version)
        return {"files": files}
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))


@router.post("/install")
def install_mod(
    request: InstallModRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Télécharge et installe un mod sur un serveur."""
    server = db.query(GameServer).filter(GameServer.id == request.server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")

    if not request.download_url:
        raise HTTPException(status_code=400, detail="URL de téléchargement manquante")

    # Dossier mods du serveur
    server_data_dir = os.path.join(settings.SERVERS_DATA_DIR, str(server.id))
    mods_dir = os.path.join(server_data_dir, "mods")

    try:
        filepath = curseforge.download_mod(
            download_url=request.download_url,
            dest_dir=mods_dir,
            filename=request.filename,
        )
        return {
            "message": f"✅ Mod '{request.mod_name}' installé !",
            "filename": request.filename,
            "path": filepath,
        }
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/server/{server_id}")
def list_installed_mods(
    server_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Liste les mods installés sur un serveur."""
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")

    server_data_dir = os.path.join(settings.SERVERS_DATA_DIR, str(server.id))
    mods = curseforge.list_installed_mods(server_data_dir)
    return {"mods": mods, "count": len(mods)}


@router.delete("/server/{server_id}/{filename}")
def remove_mod(
    server_id: int,
    filename: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Supprime un mod d'un serveur."""
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")

    server_data_dir = os.path.join(settings.SERVERS_DATA_DIR, str(server.id))
    try:
        curseforge.remove_mod(server_data_dir, filename)
        return {"message": f"✅ Mod '{filename}' supprimé"}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
