"""
Plugin Manager — Recherche et installation de plugins Spigot/Paper/Bukkit.

Utilise l'API Modrinth (gratuite, pas de clé API requise) pour :
- Rechercher des plugins
- Télécharger et installer des plugins dans le conteneur Docker
- Lister et supprimer les plugins installés

Les plugins sont installés dans /data/plugins/ du conteneur.
"""

import os
import logging
import httpx

from pathlib import Path

logger = logging.getLogger(__name__)

MODRINTH_API = "https://api.modrinth.com/v2"
USER_AGENT = "OmenServer/1.0 (contact@omenserver.local)"


def search_plugins(query: str, limit: int = 20, game_version: str = None) -> dict:
    """
    Recherche des plugins sur Modrinth.
    Filtre par type 'plugin' et loaders Bukkit/Spigot/Paper.
    """
    try:
        facets = '[["project_type:plugin"],["categories:paper","categories:spigot","categories:bukkit","categories:purpur","categories:folia"]]'
        if game_version and game_version not in ('LATEST', ''):
            facets = f'[["project_type:plugin"],["categories:paper","categories:spigot","categories:bukkit","categories:purpur","categories:folia"],["versions:{game_version}"]]'
        r = httpx.get(
            f"{MODRINTH_API}/search",
            params={
                "query": query,
                "limit": limit,
                "facets": facets,
            },
            headers={"User-Agent": USER_AGENT},
            timeout=10,
        )
        r.raise_for_status()
        data = r.json()

        plugins = []
        for hit in data.get("hits", []):
            plugins.append({
                "id": hit.get("project_id", ""),
                "slug": hit.get("slug", ""),
                "name": hit.get("title", ""),
                "description": hit.get("description", ""),
                "icon_url": hit.get("icon_url", ""),
                "downloads": hit.get("downloads", 0),
                "categories": hit.get("categories", []),
                "versions": hit.get("versions", []),
            })

        return {"plugins": plugins, "total": data.get("total_hits", 0)}

    except Exception as e:
        logger.error(f"Erreur recherche Modrinth: {e}")
        raise RuntimeError(f"Erreur API Modrinth: {e}")


def get_plugin_versions(project_id: str) -> list:
    """
    Récupère les versions disponibles d'un plugin (fichiers .jar téléchargeables).
    """
    try:
        r = httpx.get(
            f"{MODRINTH_API}/project/{project_id}/version",
            headers={"User-Agent": USER_AGENT},
            timeout=10,
        )
        r.raise_for_status()
        versions = r.json()

        result = []
        for v in versions[:10]:  # Limiter à 10 versions
            files = v.get("files", [])
            primary = next((f for f in files if f.get("primary")), files[0] if files else None)
            if primary:
                result.append({
                    "version_id": v.get("id", ""),
                    "name": v.get("name", ""),
                    "version_number": v.get("version_number", ""),
                    "game_versions": v.get("game_versions", []),
                    "loaders": v.get("loaders", []),
                    "filename": primary.get("filename", ""),
                    "download_url": primary.get("url", ""),
                    "size_bytes": primary.get("size", 0),
                    "size_mb": round(primary.get("size", 0) / (1024 * 1024), 2),
                })

        return result

    except Exception as e:
        logger.error(f"Erreur versions Modrinth: {e}")
        raise RuntimeError(f"Erreur API Modrinth: {e}")


def install_plugin(docker_id: str, download_url: str, filename: str) -> str:
    """
    Télécharge un plugin et le copie dans /data/plugins/ du conteneur Docker.
    """
    import docker
    import tarfile
    import io

    try:
        # 1. Télécharger le .jar
        r = httpx.get(download_url, headers={"User-Agent": USER_AGENT}, timeout=60, follow_redirects=True)
        r.raise_for_status()
        jar_data = r.content

        # 2. Créer un tar avec le fichier pour Docker
        tar_buffer = io.BytesIO()
        with tarfile.open(fileobj=tar_buffer, mode='w') as tar:
            info = tarfile.TarInfo(name=filename)
            info.size = len(jar_data)
            tar.addfile(info, io.BytesIO(jar_data))
        tar_buffer.seek(0)

        # 3. Envoyer au conteneur
        client = docker.from_env()
        container = client.containers.get(docker_id)

        # Créer le dossier plugins s'il n'existe pas
        container.exec_run("mkdir -p /data/plugins", user="root")

        # Copier le fichier
        container.put_archive("/data/plugins", tar_buffer.read())

        size_mb = round(len(jar_data) / (1024 * 1024), 2)
        logger.info(f"Plugin installé: {filename} ({size_mb} Mo)")

        return filename

    except Exception as e:
        logger.error(f"Erreur installation plugin: {e}")
        raise RuntimeError(f"Erreur installation: {e}")


def list_installed_plugins(docker_id: str) -> list:
    """
    Liste les plugins installés dans /data/plugins/ du conteneur.
    """
    import docker

    try:
        client = docker.from_env()
        container = client.containers.get(docker_id)

        result = container.exec_run("ls -la /data/plugins/", demux=True)
        stdout = result.output[0].decode("utf-8", errors="replace") if result.output[0] else ""

        plugins = []
        for line in stdout.strip().split("\n"):
            parts = line.split()
            if len(parts) >= 9 and parts[-1].endswith(".jar"):
                filename = parts[-1]
                try:
                    size_bytes = int(parts[4])
                except (ValueError, IndexError):
                    size_bytes = 0
                plugins.append({
                    "filename": filename,
                    "size_bytes": size_bytes,
                    "size_mb": round(size_bytes / (1024 * 1024), 2),
                })

        return plugins

    except Exception as e:
        logger.error(f"Erreur listing plugins: {e}")
        return []


def remove_plugin(docker_id: str, filename: str) -> bool:
    """
    Supprime un plugin du conteneur.
    """
    import docker

    # Sécurité: empêcher les path traversal
    if "/" in filename or ".." in filename:
        raise ValueError("Nom de fichier invalide")

    try:
        client = docker.from_env()
        container = client.containers.get(docker_id)
        result = container.exec_run(f"rm -f /data/plugins/{filename}", user="root")
        if result.exit_code != 0:
            raise RuntimeError(f"Erreur suppression: exit code {result.exit_code}")
        logger.info(f"Plugin supprimé: {filename}")
        return True
    except Exception as e:
        logger.error(f"Erreur suppression plugin: {e}")
        raise RuntimeError(f"Erreur: {e}")
