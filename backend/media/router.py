"""
Module Média & Streaming — Router API.

Gère le déploiement et la gestion d'un serveur Jellyfin via Docker.
Jellyfin est un serveur multimédia open-source et gratuit (alternative à Plex)
qui permet de streamer films, séries et musique depuis le panel.

Endpoints:
    GET  /api/media/status     — Statut du conteneur Jellyfin
    POST /api/media/setup      — Déployer Jellyfin (premier lancement)
    POST /api/media/start      — Démarrer le conteneur
    POST /api/media/stop       — Arrêter le conteneur
    POST /api/media/restart    — Redémarrer le conteneur
    GET  /api/media/info       — Infos détaillées (version, URL, stockage)
    GET  /api/media/libraries  — Liste des dossiers média configurés
    POST /api/media/libraries  — Ajouter un dossier média
    DELETE /api/media/libraries/{name} — Supprimer un dossier média
    DELETE /api/media/reset    — Supprimer et recréer le conteneur
"""

import os
import logging
import docker
from pathlib import Path
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional
from backend.auth.utils import get_current_user

logger = logging.getLogger("omenserver.media")

router = APIRouter(prefix="/api/media", tags=["media"])

# === Configuration ===
JELLYFIN_CONTAINER_NAME = "omenserver-jellyfin"
JELLYFIN_IMAGE = "jellyfin/jellyfin:latest"
JELLYFIN_PORT = 8096
MEDIA_BASE_DIR = os.path.expanduser("~/omenserver/media")
JELLYFIN_CONFIG_DIR = os.path.expanduser("~/omenserver/jellyfin/config")
JELLYFIN_CACHE_DIR = os.path.expanduser("~/omenserver/jellyfin/cache")


def _safe_library_path(name: str) -> str:
    """Résout le dossier d'une bibliothèque média en le CONFINANT sous
    ``MEDIA_BASE_DIR``. ``name`` est réduit à son basename (rejette ``..`` et
    les séparateurs) puis on vérifie le confinement (anti path-traversal sur
    rmdir/makedirs). Lève HTTPException(400) si le nom s'évade."""
    base = os.path.basename((name or "").strip())
    if not base or base in (".", ".."):
        raise HTTPException(status_code=400, detail="Nom de bibliothèque invalide")
    root = os.path.realpath(MEDIA_BASE_DIR)
    target = os.path.realpath(os.path.join(root, base))
    if target != root and os.path.dirname(target) != root:
        raise HTTPException(status_code=400, detail="Nom de bibliothèque invalide")
    return target


# === Modèles Pydantic ===
class LibraryRequest(BaseModel):
    """Requête pour ajouter un dossier média."""
    name: str           # Nom de la bibliothèque (ex: "Films", "Séries")
    path: str           # Chemin du dossier sur le serveur
    media_type: str = "movies"  # Type : movies, shows, music, books


class SetupRequest(BaseModel):
    """Options pour le setup initial."""
    port: int = 8096


# === Helpers Docker ===
def _get_docker_client():
    """Récupère le client Docker, raise si Docker n'est pas disponible."""
    try:
        client = docker.from_env()
        client.ping()
        return client
    except Exception as e:
        logger.error(f"Docker non disponible: {e}")
        raise HTTPException(status_code=503, detail="Docker n'est pas disponible. Vérifie que Docker est installé et lancé.")


def _get_container(client):
    """Récupère le conteneur Jellyfin s'il existe."""
    try:
        return client.containers.get(JELLYFIN_CONTAINER_NAME)
    except docker.errors.NotFound:
        return None
    except Exception as e:
        logger.error(f"Erreur Docker: {e}")
        return None


def _container_stats(container):
    """Récupère les stats CPU/RAM du conteneur."""
    try:
        stats = container.stats(stream=False)
        # CPU
        cpu_delta = stats["cpu_stats"]["cpu_usage"]["total_usage"] - stats["precpu_stats"]["cpu_usage"]["total_usage"]
        system_delta = stats["cpu_stats"]["system_cpu_usage"] - stats["precpu_stats"]["system_cpu_usage"]
        num_cpus = len(stats["cpu_stats"]["cpu_usage"].get("percpu_usage", [1]))
        cpu_percent = round((cpu_delta / system_delta) * num_cpus * 100, 1) if system_delta > 0 else 0

        # RAM
        mem_usage = stats["memory_stats"].get("usage", 0)
        mem_limit = stats["memory_stats"].get("limit", 1)
        mem_mb = round(mem_usage / 1024 / 1024, 1)
        mem_percent = round((mem_usage / mem_limit) * 100, 1)

        return {"cpu_percent": cpu_percent, "ram_mb": mem_mb, "ram_percent": mem_percent}
    except Exception:
        return {"cpu_percent": 0, "ram_mb": 0, "ram_percent": 0}


# === Routes ===

@router.get("/status")
async def get_status(user=Depends(get_current_user)):
    """
    Récupère le statut du serveur Jellyfin.
    Retourne si le conteneur existe, son état, et les infos de base.
    """
    client = _get_docker_client()
    container = _get_container(client)

    if not container:
        return {
            "installed": False,
            "status": "not_installed",
            "url": None,
            "port": JELLYFIN_PORT,
        }

    status = container.status  # running, exited, paused, etc.
    stats = _container_stats(container) if status == "running" else {}

    return {
        "installed": True,
        "status": status,
        "url": f"http://localhost:{JELLYFIN_PORT}" if status == "running" else None,
        "port": JELLYFIN_PORT,
        "container_id": container.short_id,
        **stats,
    }


@router.post("/setup")
async def setup_jellyfin(req: SetupRequest = SetupRequest(), user=Depends(get_current_user)):
    """
    Déploie le conteneur Jellyfin pour la première fois.
    Crée les dossiers nécessaires et lance le conteneur Docker.
    """
    # Sécurité : admin uniquement
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Seuls les administrateurs peuvent déployer Jellyfin.")

    client = _get_docker_client()

    # Vérifier si déjà installé
    existing = _get_container(client)
    if existing:
        raise HTTPException(status_code=409, detail="Jellyfin est déjà installé. Utilise /reset pour réinstaller.")

    # Créer les dossiers
    for d in [MEDIA_BASE_DIR, JELLYFIN_CONFIG_DIR, JELLYFIN_CACHE_DIR]:
        os.makedirs(d, exist_ok=True)
    # Créer des sous-dossiers par défaut
    for sub in ["films", "series", "musique"]:
        os.makedirs(os.path.join(MEDIA_BASE_DIR, sub), exist_ok=True)

    logger.info(f"🎬 Déploiement Jellyfin sur le port {req.port}...")

    try:
        # Pull de l'image
        logger.info(f"📥 Téléchargement de l'image {JELLYFIN_IMAGE}...")
        client.images.pull(JELLYFIN_IMAGE)

        # Créer et démarrer le conteneur
        container = client.containers.run(
            JELLYFIN_IMAGE,
            name=JELLYFIN_CONTAINER_NAME,
            detach=True,
            restart_policy={"Name": "unless-stopped"},
            ports={f"8096/tcp": req.port},
            volumes={
                JELLYFIN_CONFIG_DIR: {"bind": "/config", "mode": "rw"},
                JELLYFIN_CACHE_DIR: {"bind": "/cache", "mode": "rw"},
                MEDIA_BASE_DIR: {"bind": "/media", "mode": "rw"},
            },
            environment={
                "JELLYFIN_PublishedServerUrl": f"http://localhost:{req.port}",
            },
        )

        logger.info(f"Jellyfin déployé ! Conteneur: {container.short_id}")
        return {
            "success": True,
            "message": "Jellyfin installé et démarré !",
            "url": f"http://localhost:{req.port}",
            "container_id": container.short_id,
        }

    except Exception as e:
        logger.error(f"❌ Erreur setup Jellyfin: {e}")
        raise HTTPException(status_code=500, detail=f"Erreur lors du déploiement: {str(e)}")


@router.post("/start")
async def start_jellyfin(user=Depends(get_current_user)):
    """Démarrer le conteneur Jellyfin."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Seuls les administrateurs peuvent gérer Jellyfin.")
    client = _get_docker_client()
    container = _get_container(client)

    if not container:
        raise HTTPException(status_code=404, detail="Jellyfin n'est pas installé. Lance le setup d'abord.")

    if container.status == "running":
        return {"message": "Jellyfin est déjà en cours d'exécution."}

    container.start()
    logger.info("▶️ Jellyfin démarré")
    return {"message": "Jellyfin démarré !", "url": f"http://localhost:{JELLYFIN_PORT}"}


@router.post("/stop")
async def stop_jellyfin(user=Depends(get_current_user)):
    """Arrêter le conteneur Jellyfin."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Seuls les administrateurs peuvent gérer Jellyfin.")
    client = _get_docker_client()
    container = _get_container(client)

    if not container:
        raise HTTPException(status_code=404, detail="Jellyfin n'est pas installé.")

    if container.status != "running":
        return {"message": "Jellyfin est déjà arrêté."}

    container.stop(timeout=10)
    logger.info("⏹️ Jellyfin arrêté")
    return {"message": "Jellyfin arrêté."}


@router.post("/restart")
async def restart_jellyfin(user=Depends(get_current_user)):
    """Redémarrer le conteneur Jellyfin."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Seuls les administrateurs peuvent gérer Jellyfin.")
    client = _get_docker_client()
    container = _get_container(client)

    if not container:
        raise HTTPException(status_code=404, detail="Jellyfin n'est pas installé.")

    container.restart(timeout=10)
    logger.info("🔄 Jellyfin redémarré")
    return {"message": "Jellyfin redémarré !", "url": f"http://localhost:{JELLYFIN_PORT}"}


@router.get("/info")
async def get_info(user=Depends(get_current_user)):
    """
    Infos détaillées sur le serveur Jellyfin.
    Inclut la version, l'utilisation disque, les bibliothèques configurées.
    """
    client = _get_docker_client()
    container = _get_container(client)

    if not container:
        raise HTTPException(status_code=404, detail="Jellyfin n'est pas installé.")

    # Taille du dossier média
    media_size = 0
    for dirpath, dirnames, filenames in os.walk(MEDIA_BASE_DIR):
        for f in filenames:
            fp = os.path.join(dirpath, f)
            if os.path.exists(fp):
                media_size += os.path.getsize(fp)

    # Taille config
    config_size = 0
    for dirpath, dirnames, filenames in os.walk(JELLYFIN_CONFIG_DIR):
        for f in filenames:
            fp = os.path.join(dirpath, f)
            if os.path.exists(fp):
                config_size += os.path.getsize(fp)

    # Lister les sous-dossiers média
    libraries = []
    if os.path.exists(MEDIA_BASE_DIR):
        for entry in os.scandir(MEDIA_BASE_DIR):
            if entry.is_dir():
                # Compter les fichiers dans le dossier
                file_count = sum(1 for _, _, files in os.walk(entry.path) for f in files)
                dir_size = sum(
                    os.path.getsize(os.path.join(dp, fn))
                    for dp, _, fns in os.walk(entry.path)
                    for fn in fns
                    if os.path.exists(os.path.join(dp, fn))
                )
                libraries.append({
                    "name": entry.name,
                    "path": entry.path,
                    "file_count": file_count,
                    "size_mb": round(dir_size / 1024 / 1024, 1),
                })

    return {
        "status": container.status,
        "image": JELLYFIN_IMAGE,
        "url": f"http://localhost:{JELLYFIN_PORT}" if container.status == "running" else None,
        "port": JELLYFIN_PORT,
        "media_dir": MEDIA_BASE_DIR,
        "media_size_gb": round(media_size / 1024 / 1024 / 1024, 2),
        "config_size_mb": round(config_size / 1024 / 1024, 1),
        "libraries": libraries,
        "container_id": container.short_id,
    }


@router.get("/libraries")
async def list_libraries(user=Depends(get_current_user)):
    """Liste les dossiers média disponibles."""
    libraries = []
    if os.path.exists(MEDIA_BASE_DIR):
        for entry in os.scandir(MEDIA_BASE_DIR):
            if entry.is_dir():
                file_count = sum(1 for _, _, files in os.walk(entry.path) for f in files)
                dir_size = sum(
                    os.path.getsize(os.path.join(dp, fn))
                    for dp, _, fns in os.walk(entry.path)
                    for fn in fns
                    if os.path.exists(os.path.join(dp, fn))
                )
                libraries.append({
                    "name": entry.name,
                    "path": f"/media/{entry.name}",
                    "host_path": entry.path,
                    "file_count": file_count,
                    "size_mb": round(dir_size / 1024 / 1024, 1),
                })
    return {"libraries": libraries}


@router.post("/libraries")
async def add_library(req: LibraryRequest, user=Depends(get_current_user)):
    """Ajouter un nouveau dossier de bibliothèque média."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Seuls les administrateurs peuvent ajouter des bibliothèques.")
    # normalise puis CONFINE sous MEDIA_BASE_DIR (anti path-traversal via name)
    lib_path = _safe_library_path(req.name.lower().replace(" ", "_"))
    if os.path.exists(lib_path):
        raise HTTPException(status_code=409, detail=f"Le dossier '{req.name}' existe déjà.")

    os.makedirs(lib_path, exist_ok=True)
    logger.info(f"📁 Bibliothèque créée: {req.name} → {lib_path}")

    return {
        "success": True,
        "message": f"Bibliothèque '{req.name}' créée !",
        "path": lib_path,
    }


@router.delete("/libraries/{name}")
async def delete_library(name: str, user=Depends(get_current_user)):
    """Supprimer un dossier de bibliothèque (le dossier doit être vide)."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Seuls les administrateurs peuvent supprimer des bibliothèques.")
    # CONFINE sous MEDIA_BASE_DIR (anti path-traversal via {name} sur rmdir)
    lib_path = _safe_library_path(name)
    if not os.path.exists(lib_path):
        raise HTTPException(status_code=404, detail=f"Dossier '{name}' non trouvé.")

    # Vérifier si le dossier est vide
    file_count = sum(1 for _, _, files in os.walk(lib_path) for f in files)
    if file_count > 0:
        raise HTTPException(status_code=400, detail=f"Le dossier contient {file_count} fichier(s). Vide-le d'abord.")

    os.rmdir(lib_path)
    logger.info(f"🗑️ Bibliothèque supprimée: {name}")
    return {"success": True, "message": f"Bibliothèque '{name}' supprimée."}


@router.delete("/reset")
async def reset_jellyfin(user=Depends(get_current_user)):
    """Supprimer le conteneur Jellyfin (les données média sont conservées)."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Seuls les administrateurs peuvent réinitialiser Jellyfin.")
    client = _get_docker_client()
    container = _get_container(client)

    if not container:
        raise HTTPException(status_code=404, detail="Jellyfin n'est pas installé.")

    # Arrêter si en cours
    if container.status == "running":
        container.stop(timeout=10)

    container.remove()
    logger.info("🗑️ Conteneur Jellyfin supprimé")

    return {
        "success": True,
        "message": "Jellyfin supprimé. Les fichiers média sont conservés dans ~/omenserver/media/",
    }
