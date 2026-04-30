"""
Backup Manager — Sauvegarde et restauration des données de serveurs de jeux.

Chaque serveur de jeu stocke ses données dans un volume Docker.
Ce module permet de :
- Créer des archives .tar.gz de ces données
- Lister les sauvegardes existantes
- Restaurer une sauvegarde
- Supprimer les anciennes sauvegardes (rotation)

Les sauvegardes sont stockées dans : data/backups/{server_id}/
"""

import os
import shutil
import tarfile
import logging
from datetime import datetime
from pathlib import Path
from typing import Optional

from backend.config import settings

logger = logging.getLogger(__name__)

# Dossier racine des sauvegardes
BACKUPS_DIR = Path(settings.BASE_DIR) / "data" / "backups"


def _get_backup_dir(server_id: int) -> Path:
    """Retourne le dossier de sauvegardes d'un serveur."""
    backup_dir = BACKUPS_DIR / str(server_id)
    backup_dir.mkdir(parents=True, exist_ok=True)
    return backup_dir


def create_backup(server_id: int, server_name: str, docker_id: str) -> dict:
    """
    Crée une sauvegarde des données d'un serveur.

    1. Copie les fichiers du conteneur Docker vers un dossier temporaire
    2. Compresse le tout en .tar.gz
    3. Retourne les infos de la sauvegarde

    Args:
        server_id:   ID du serveur en base
        server_name: Nom du serveur (pour le nom du fichier)
        docker_id:   ID du conteneur Docker
    """
    try:
        import docker
        client = docker.from_env()
        container = client.containers.get(docker_id)
    except Exception as e:
        raise RuntimeError(f"Conteneur Docker non trouvé: {e}")

    backup_dir = _get_backup_dir(server_id)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_name = server_name.lower().replace(' ', '-').replace('_', '-')
    backup_name = f"{safe_name}_{timestamp}"
    backup_path = backup_dir / f"{backup_name}.tar.gz"
    temp_dir = backup_dir / f"_temp_{backup_name}"

    try:
        # 1. Extraire les données du conteneur
        #    On copie /data (Minecraft) ou / (fallback)
        temp_dir.mkdir(parents=True, exist_ok=True)

        # Essayer de copier /data (dossier standard Minecraft/Valheim)
        data_paths = ["/data", "/server", "/ark", "/valheim", "/terraria"]
        copied = False

        for data_path in data_paths:
            try:
                bits, stat = container.get_archive(data_path)
                archive_path = temp_dir / "container_data.tar"
                with open(archive_path, 'wb') as f:
                    for chunk in bits:
                        f.write(chunk)

                # Extraire l'archive Docker
                with tarfile.open(archive_path, 'r') as tar:
                    tar.extractall(path=temp_dir)

                archive_path.unlink()  # Supprimer le tar intermédiaire
                copied = True
                logger.info(f"Données extraites de {data_path}")
                break
            except Exception:
                continue

        if not copied:
            raise RuntimeError("Impossible de trouver les données du serveur dans le conteneur")

        # 2. Compresser en .tar.gz
        with tarfile.open(backup_path, "w:gz") as tar:
            tar.add(temp_dir, arcname=backup_name)

        # 3. Nettoyer le dossier temporaire
        shutil.rmtree(temp_dir, ignore_errors=True)

        # 4. Calculer la taille
        size_bytes = backup_path.stat().st_size
        size_mb = round(size_bytes / (1024 * 1024), 1)

        logger.info(f"Sauvegarde créée: {backup_path.name} ({size_mb} Mo)")

        return {
            "id": backup_name,
            "filename": backup_path.name,
            "created_at": datetime.now().isoformat(),
            "size_mb": size_mb,
            "size_bytes": size_bytes,
        }

    except Exception as e:
        # Nettoyer en cas d'erreur
        shutil.rmtree(temp_dir, ignore_errors=True)
        if backup_path.exists():
            backup_path.unlink()
        raise RuntimeError(f"Erreur lors de la sauvegarde: {e}")


def list_backups(server_id: int) -> list:
    """Retourne la liste des sauvegardes d'un serveur."""
    backup_dir = _get_backup_dir(server_id)
    backups = []

    for f in sorted(backup_dir.glob("*.tar.gz"), reverse=True):
        stat = f.stat()
        # Extraire la date du nom de fichier
        name = f.stem.replace('.tar', '')
        parts = name.rsplit('_', 2)
        if len(parts) >= 3:
            date_str = f"{parts[-2]}_{parts[-1]}"
            try:
                created = datetime.strptime(date_str, "%Y%m%d_%H%M%S")
                created_str = created.strftime("%d/%m/%Y %H:%M")
            except ValueError:
                created_str = datetime.fromtimestamp(stat.st_mtime).strftime("%d/%m/%Y %H:%M")
        else:
            created_str = datetime.fromtimestamp(stat.st_mtime).strftime("%d/%m/%Y %H:%M")

        backups.append({
            "id": name,
            "filename": f.name,
            "created_at": created_str,
            "size_mb": round(stat.st_size / (1024 * 1024), 1),
            "size_bytes": stat.st_size,
        })

    return backups


def restore_backup(server_id: int, backup_id: str, docker_id: str) -> bool:
    """
    Restaure une sauvegarde dans le conteneur Docker.

    ⚠️ Le serveur DOIT être arrêté avant de restaurer.

    1. Décompresse l'archive
    2. Copie les fichiers dans le conteneur
    """
    backup_dir = _get_backup_dir(server_id)
    backup_path = backup_dir / f"{backup_id}.tar.gz"

    if not backup_path.exists():
        raise RuntimeError(f"Sauvegarde '{backup_id}' non trouvée")

    try:
        import docker
        client = docker.from_env()
        container = client.containers.get(docker_id)

        # Vérifier que le serveur est arrêté
        if container.status == "running":
            raise RuntimeError("Arrête le serveur avant de restaurer une sauvegarde")

    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError(f"Conteneur Docker non trouvé: {e}")

    temp_dir = backup_dir / f"_restore_{backup_id}"

    try:
        # 1. Décompresser
        temp_dir.mkdir(parents=True, exist_ok=True)
        with tarfile.open(backup_path, "r:gz") as tar:
            tar.extractall(path=temp_dir)

        # 2. Trouver le dossier de données extrait
        extracted_dirs = list(temp_dir.iterdir())
        if not extracted_dirs:
            raise RuntimeError("Archive vide")

        data_dir = extracted_dirs[0]

        # 3. Créer un tar pour l'envoyer au conteneur
        restore_tar = temp_dir / "restore.tar"
        with tarfile.open(restore_tar, "w") as tar:
            for item in data_dir.iterdir():
                tar.add(item, arcname=item.name)

        # 4. Envoyer au conteneur
        with open(restore_tar, "rb") as f:
            container.put_archive("/data", f.read())

        # 5. Nettoyer
        shutil.rmtree(temp_dir, ignore_errors=True)

        logger.info(f"Sauvegarde restaurée: {backup_id}")
        return True

    except Exception as e:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise RuntimeError(f"Erreur lors de la restauration: {e}")


def delete_backup(server_id: int, backup_id: str) -> bool:
    """Supprime une sauvegarde."""
    backup_dir = _get_backup_dir(server_id)
    backup_path = backup_dir / f"{backup_id}.tar.gz"

    if not backup_path.exists():
        raise RuntimeError(f"Sauvegarde '{backup_id}' non trouvée")

    backup_path.unlink()
    logger.info(f"Sauvegarde supprimée: {backup_id}")
    return True


def cleanup_old_backups(server_id: int, keep: int = 5):
    """
    Supprime les anciennes sauvegardes, ne garde que les X plus récentes.
    Appelée automatiquement après chaque nouvelle sauvegarde.
    """
    backups = list_backups(server_id)
    if len(backups) > keep:
        for old_backup in backups[keep:]:
            try:
                delete_backup(server_id, old_backup["id"])
            except Exception:
                pass
