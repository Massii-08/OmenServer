"""
Client CurseForge API v2.

Communique avec l'API CurseForge pour :
- Rechercher des mods par nom
- Obtenir les détails d'un mod
- Télécharger les fichiers de mods

Docs API : https://docs.curseforge.com/
Game ID Minecraft Java = 432
"""

import os
import logging
import requests
from typing import Optional
from pathlib import Path

from backend.config import settings

logger = logging.getLogger("omenserver")

# CurseForge API
CF_BASE_URL = "https://api.curseforge.com"
CF_API_KEY = os.getenv("CURSEFORGE_API_KEY", "")

# Game IDs CurseForge
GAME_IDS = {
    "minecraft": 432,
}

# Mod class IDs (type de contenu)
MOD_CLASS_IDS = {
    "mods": 6,         # Mods
    "modpacks": 4471,  # Modpacks
    "textures": 12,    # Resource packs
    "worlds": 17,      # Maps
    "datapacks": 6945, # Data Packs
    "shaders": 6552,   # Shaders
}


def _headers():
    """Headers pour l'API CurseForge."""
    if not CF_API_KEY:
        raise RuntimeError("Clé API CurseForge non configurée. Ajoute CURSEFORGE_API_KEY dans .env")
    return {
        "Accept": "application/json",
        "x-api-key": CF_API_KEY,
    }


def search_mods(
    query: str,
    game_type: str = "minecraft",
    category: str = "mods",
    page: int = 0,
    page_size: int = 20,
    sort_field: int = 2,  # 2 = Popularity
    game_version: str = None,
) -> dict:
    """
    Recherche des mods sur CurseForge.

    Args:
        query:      Terme de recherche
        game_type:  Type de jeu (minecraft)
        category:   Catégorie (mods, modpacks, textures, worlds)
        page:       Page (0-indexed)
        page_size:  Nombre de résultats par page
        sort_field:  Tri (1=Featured, 2=Popularity, 3=LastUpdated, 6=TotalDownloads)

    Returns:
        dict avec 'mods' (liste) et 'pagination' (infos pagination)
    """
    game_id = GAME_IDS.get(game_type, 432)
    class_id = MOD_CLASS_IDS.get(category, 6)

    params = {
        "gameId": game_id,
        "classId": class_id,
        "searchFilter": query,
        "sortField": sort_field,
        "sortOrder": "desc",
        "index": page * page_size,
        "pageSize": page_size,
    }
    if game_version and game_version not in ('LATEST', ''):
        params['gameVersion'] = game_version

    try:
        r = requests.get(f"{CF_BASE_URL}/v1/mods/search", headers=_headers(), params=params, timeout=10)
        r.raise_for_status()
        data = r.json()

        mods = []
        for mod in data.get("data", []):
            logo = mod.get("logo", {})
            mods.append({
                "id": mod["id"],
                "name": mod["name"],
                "summary": mod.get("summary", ""),
                "author": mod.get("authors", [{}])[0].get("name", "Inconnu"),
                "downloads": mod.get("downloadCount", 0),
                "icon_url": logo.get("thumbnailUrl", "") if logo else "",
                "url": mod.get("links", {}).get("websiteUrl", ""),
                "date_modified": mod.get("dateModified", ""),
                "game_versions": [v for v in mod.get("latestFilesIndexes", [])[:5]],
            })

        return {
            "mods": mods,
            "pagination": {
                "page": page,
                "page_size": page_size,
                "total": data.get("pagination", {}).get("totalCount", 0),
            }
        }
    except requests.exceptions.RequestException as e:
        logger.error(f"Erreur CurseForge search: {e}")
        raise RuntimeError(f"Erreur API CurseForge: {e}")


def get_mod_files(mod_id: int, game_version: str = None) -> list:
    """
    Récupère les fichiers disponibles pour un mod.

    Args:
        mod_id:        ID du mod CurseForge
        game_version:  Filtrer par version du jeu (ex: "1.20.1")

    Returns:
        Liste de fichiers avec leurs infos
    """
    params = {"pageSize": 20}
    if game_version:
        params["gameVersion"] = game_version

    try:
        r = requests.get(f"{CF_BASE_URL}/v1/mods/{mod_id}/files", headers=_headers(), params=params, timeout=10)
        r.raise_for_status()
        data = r.json()

        files = []
        for f in data.get("data", []):
            files.append({
                "id": f["id"],
                "name": f["fileName"],
                "size_mb": round(f.get("fileLength", 0) / (1024 * 1024), 2),
                "game_versions": f.get("gameVersions", []),
                "download_url": f.get("downloadUrl", ""),
                "release_type": {1: "Release", 2: "Beta", 3: "Alpha"}.get(f.get("releaseType"), "?"),
                "date": f.get("fileDate", ""),
            })

        return files
    except requests.exceptions.RequestException as e:
        logger.error(f"Erreur CurseForge files: {e}")
        raise RuntimeError(f"Erreur API CurseForge: {e}")


def download_mod(download_url: str, dest_dir: str, filename: str) -> str:
    """
    Télécharge un fichier de mod dans le dossier spécifié.

    Args:
        download_url:  URL de téléchargement
        dest_dir:      Dossier de destination (ex: /data/servers/1/mods/)
        filename:      Nom du fichier

    Returns:
        Chemin complet du fichier téléchargé
    """
    dest_path = Path(dest_dir)
    dest_path.mkdir(parents=True, exist_ok=True)
    filepath = dest_path / filename

    try:
        r = requests.get(download_url, stream=True, timeout=30)
        r.raise_for_status()

        with open(filepath, "wb") as f:
            for chunk in r.iter_content(chunk_size=8192):
                f.write(chunk)

        logger.info(f"✅ Mod téléchargé: {filename} → {dest_dir}")
        return str(filepath)
    except Exception as e:
        logger.error(f"❌ Erreur téléchargement mod: {e}")
        raise RuntimeError(f"Impossible de télécharger: {e}")


def list_installed_mods(server_data_dir: str) -> list:
    """
    Liste les mods installés dans le dossier mods/ d'un serveur.

    Returns:
        Liste de fichiers .jar avec taille
    """
    mods_dir = Path(server_data_dir) / "mods"
    if not mods_dir.exists():
        return []

    mods = []
    for f in sorted(mods_dir.iterdir()):
        if f.is_file() and f.suffix == ".jar":
            mods.append({
                "filename": f.name,
                "size_mb": round(f.stat().st_size / (1024 * 1024), 2),
            })
    return mods


def remove_mod(server_data_dir: str, filename: str) -> bool:
    """Supprime un mod du dossier mods/ d'un serveur."""
    filepath = Path(server_data_dir) / "mods" / filename
    if filepath.exists() and filepath.is_file():
        filepath.unlink()
        logger.info(f"🗑️ Mod supprimé: {filename}")
        return True
    raise FileNotFoundError(f"Mod introuvable: {filename}")
