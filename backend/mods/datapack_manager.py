"""
Datapack Manager — Installation de datapacks depuis CurseForge.

Les datapacks sont installés dans /data/world/datapacks/ du conteneur.
Utilise put_archive qui fonctionne même si le serveur est éteint.
"""

import io
import logging
import os
import tarfile

import docker
import httpx

logger = logging.getLogger(__name__)


def install_datapack(docker_id: str, download_url: str, filename: str) -> str:
    """
    Télécharge un datapack et l'installe dans /data/world/datapacks/.
    Fonctionne que le conteneur soit allumé ou éteint.
    """
    # Sécurité: empêcher le tar member traversal (le filename vient du client).
    safe_name = os.path.basename(filename)
    if not safe_name or "/" in filename or ".." in filename:
        raise ValueError("Nom de fichier invalide")

    try:
        # 1. Télécharger le fichier
        # follow_redirects=False (anti-SSRF) : un CDN allowlisté ne doit pas
        # pouvoir rediriger vers localhost/LAN et contourner l'allowlist d'hôtes.
        r = httpx.get(download_url, timeout=60, follow_redirects=False)
        r.raise_for_status()
        file_data = r.content

        # 2. Créer un tar pour Docker
        tar_buffer = io.BytesIO()
        with tarfile.open(fileobj=tar_buffer, mode='w') as tar:
            info = tarfile.TarInfo(name=safe_name)
            info.size = len(file_data)
            tar.addfile(info, io.BytesIO(file_data))
        tar_buffer.seek(0)

        # 3. Copier dans le conteneur
        client = docker.from_env()
        container = client.containers.get(docker_id)

        # Créer le dossier datapacks s'il n'existe pas (via busybox si arrêté)
        if container.status == "running":
            container.exec_run("mkdir -p /data/world/datapacks", user="root")
        else:
            import subprocess
            subprocess.run(
                ["docker", "run", "--rm", "--volumes-from", docker_id,
                 "busybox", "mkdir", "-p", "/data/world/datapacks"],
                capture_output=True, timeout=15
            )

        container.put_archive("/data/world/datapacks", tar_buffer.read())

        size_mb = round(len(file_data) / (1024 * 1024), 2)
        logger.info(f"Datapack installé: {filename} ({size_mb} Mo)")
        return filename

    except Exception as e:
        logger.error(f"Erreur installation datapack: {e}")
        raise RuntimeError(f"Erreur installation: {e}")


def list_installed_datapacks(docker_id: str) -> list:
    """
    Liste les datapacks installés dans /data/world/datapacks/.
    Fonctionne serveur allumé ou éteint via docker cp.
    """
    from backend.game_server.settings_router import _docker_exec

    try:
        raw = _docker_exec(
            docker_id,
            'ls -la /data/world/datapacks/ 2>/dev/null || echo ""'
        )

        datapacks = []
        for line in raw.strip().split("\n"):
            parts = line.split()
            if len(parts) >= 8:
                name = parts[-1]
                if name in (".", ".."):
                    continue
                is_dir = parts[0].startswith("d")
                try:
                    size_bytes = int(parts[4])
                except (ValueError, IndexError):
                    size_bytes = 0
                # Datapacks sont des .zip ou des dossiers
                if name.endswith(".zip") or is_dir:
                    datapacks.append({
                        "filename": name,
                        "is_dir": is_dir,
                        "size_bytes": size_bytes,
                        "size_mb": round(size_bytes / (1024 * 1024), 2),
                    })

        return datapacks

    except Exception as e:
        logger.error(f"Erreur listing datapacks: {e}")
        return []


def remove_datapack(docker_id: str, filename: str) -> bool:
    """Supprime un datapack du conteneur."""
    from backend.game_server.settings_router import _docker_exec

    if "/" in filename or ".." in filename:
        raise ValueError("Nom de fichier invalide")

    try:
        _docker_exec(docker_id, f"rm -rf /data/world/datapacks/{filename}")
        logger.info(f"Datapack supprimé: {filename}")
        return True
    except Exception as e:
        logger.error(f"Erreur suppression datapack: {e}")
        raise RuntimeError(f"Erreur: {e}")
