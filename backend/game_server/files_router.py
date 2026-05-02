"""
Routes Fichiers — Explorateur de fichiers dans le conteneur Docker.

Permet de naviguer, lire, écrire, créer et supprimer des fichiers
directement dans le conteneur Docker du serveur.

Routes:
    GET    /api/servers/{id}/files?path=/         → Lister les fichiers
    GET    /api/servers/{id}/files/content?path=  → Lire un fichier
    PUT    /api/servers/{id}/files/content         → Écrire dans un fichier
    POST   /api/servers/{id}/files/mkdir            → Créer un dossier
    DELETE /api/servers/{id}/files?path=            → Supprimer un fichier/dossier
    POST   /api/servers/{id}/files/rename           → Renommer un fichier
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.auth.utils import get_current_user
from backend.auth.models import User
from backend.game_server.models import GameServer
from backend.game_server.settings_router import _docker_exec, _docker_write, _get_server_or_404

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/servers", tags=["Fichiers"])

# Base path inside the container
BASE_PATH = "/data"


class FileWriteRequest(BaseModel):
    path: str
    content: str


class MkdirRequest(BaseModel):
    path: str


class RenameRequest(BaseModel):
    old_path: str
    new_path: str


def _safe_path(path: str) -> str:
    """Sécurise le chemin pour éviter les path traversal."""
    import posixpath
    clean = posixpath.normpath(path)
    if clean.startswith("..") or "/../" in clean:
        raise HTTPException(status_code=400, detail="Chemin invalide")
    if not clean.startswith("/"):
        clean = "/" + clean
    return BASE_PATH + clean


@router.get("/{server_id}/files")
def list_files(
    server_id: int,
    path: str = Query("/", description="Chemin relatif au dossier du serveur"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Liste les fichiers et dossiers à un chemin donné."""
    server = _get_server_or_404(server_id, db)
    full_path = _safe_path(path)

    try:
        # ls -la avec format parseable
        raw = _docker_exec(
            server.docker_id,
            f'ls -la --time-style=long-iso "{full_path}" 2>/dev/null || echo "ERROR"'
        )
        if raw.strip() == "ERROR" or "No such file" in raw:
            return {"files": [], "path": path, "error": "Dossier introuvable"}

        files = []
        for line in raw.strip().splitlines():
            if line.startswith("total") or not line.strip():
                continue
            parts = line.split(None, 7)
            if len(parts) < 8:
                continue
            perms, _, owner, group, size, date, time_str, name = parts
            if name in (".", ".."):
                continue

            is_dir = perms.startswith("d")
            files.append({
                "name": name,
                "is_dir": is_dir,
                "size": int(size) if not is_dir else 0,
                "modified": f"{date} {time_str}",
                "permissions": perms,
            })

        # Tri: dossiers d'abord, puis fichiers
        files.sort(key=lambda f: (not f["is_dir"], f["name"].lower()))
        return {"files": files, "path": path}

    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{server_id}/files/content")
def read_file(
    server_id: int,
    path: str = Query(..., description="Chemin du fichier à lire"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Lit le contenu d'un fichier texte."""
    server = _get_server_or_404(server_id, db)
    full_path = _safe_path(path)

    # Vérifier la taille (max 1 Mo)
    try:
        size_raw = _docker_exec(server.docker_id, f'stat -c %s "{full_path}" 2>/dev/null || echo "0"')
        size = int(size_raw.strip())
        if size > 1048576:
            raise HTTPException(status_code=400, detail="Fichier trop volumineux (max 1 Mo)")
    except ValueError:
        pass

    try:
        content = _docker_exec(server.docker_id, f'cat "{full_path}" 2>/dev/null || echo ""')
        return {"path": path, "content": content, "filename": path.split("/")[-1]}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/{server_id}/files/content")
def write_file(
    server_id: int,
    request: FileWriteRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Écrit du contenu dans un fichier."""
    server = _get_server_or_404(server_id, db)
    full_path = _safe_path(request.path)

    try:
        _docker_write(server.docker_id, full_path, request.content)
        return {"message": f"✅ Fichier sauvegardé", "path": request.path}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{server_id}/files/mkdir")
def make_directory(
    server_id: int,
    request: MkdirRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Crée un nouveau dossier."""
    server = _get_server_or_404(server_id, db)
    full_path = _safe_path(request.path)

    try:
        _docker_exec(server.docker_id, f'mkdir -p "{full_path}"')
        return {"message": f"✅ Dossier créé", "path": request.path}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{server_id}/files")
def delete_file(
    server_id: int,
    path: str = Query(..., description="Chemin du fichier/dossier à supprimer"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Supprime un fichier ou dossier."""
    server = _get_server_or_404(server_id, db)
    full_path = _safe_path(path)

    # Interdire la suppression de la racine
    if full_path == BASE_PATH or full_path == BASE_PATH + "/":
        raise HTTPException(status_code=400, detail="Impossible de supprimer la racine")

    try:
        _docker_exec(server.docker_id, f'rm -rf "{full_path}"')
        return {"message": f"✅ Supprimé", "path": path}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{server_id}/files/rename")
def rename_file(
    server_id: int,
    request: RenameRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Renomme un fichier ou dossier."""
    server = _get_server_or_404(server_id, db)
    old = _safe_path(request.old_path)
    new = _safe_path(request.new_path)

    try:
        _docker_exec(server.docker_id, f'mv "{old}" "{new}"')
        return {"message": f"✅ Renommé", "old": request.old_path, "new": request.new_path}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
