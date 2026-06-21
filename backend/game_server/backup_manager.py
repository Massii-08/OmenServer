"""
Backup Manager — Sauvegarde et restauration des données de serveurs de jeux.

Chaque serveur de jeu stocke ses données dans un volume Docker.
Ce module permet de :
- Créer des archives .tar.gz de ces données (auto ou manuelles)
- Lister les sauvegardes existantes (séparées auto / manuel)
- Restaurer une sauvegarde
- Supprimer les anciennes sauvegardes auto (rotation : max 10)
- Limiter les sauvegardes manuelles à 10 (suppression par l'utilisateur)

Structure de stockage :
    data/backups/{server_id}/auto/    → Backups automatiques (scheduler)
    data/backups/{server_id}/manual/  → Backups manuels (bouton)
"""

import os
import re
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

# backup_id : alphanum + . _ - uniquement (pas de `/`, `..`, NUL → anti path-traversal)
_BACKUP_ID_RE = re.compile(r'^[A-Za-z0-9._-]+\Z')


def _validate_backup_id(backup_id: str) -> str:
    """Valide qu'un backup_id ne permet PAS de sélectionner une archive arbitraire.

    Rejette `/`, `..`, NUL et tout caractère hors `[A-Za-z0-9._-]`. Lève RuntimeError
    si invalide (anti arbitrary-archive-selection sur restore/delete/rename)."""
    if not isinstance(backup_id, str) or not backup_id or backup_id in (".", ".."):
        raise RuntimeError("Identifiant de sauvegarde invalide")
    if ".." in backup_id or "/" in backup_id or "\\" in backup_id or "\x00" in backup_id:
        raise RuntimeError("Identifiant de sauvegarde invalide")
    if not _BACKUP_ID_RE.match(backup_id):
        raise RuntimeError("Identifiant de sauvegarde invalide")
    return backup_id


def _resolve_backup_path(backup_dir: Path, backup_id: str) -> Path:
    """Construit + vérifie le chemin d'une archive : doit rester SOUS backup_dir
    (double garde-fou en plus de _validate_backup_id)."""
    _validate_backup_id(backup_id)
    backup_path = backup_dir / f"{backup_id}.tar.gz"
    resolved = backup_path.resolve()
    base = backup_dir.resolve()
    if base != resolved and base not in resolved.parents:
        raise RuntimeError("Chemin de sauvegarde hors zone autorisée")
    return backup_path


def _safe_extract(tar: tarfile.TarFile, dest):
    """Extrait une archive tar en refusant tout membre dangereux (zip-slip).

    Python 3.9 n'a pas `filter="data"` → on filtre manuellement chaque membre :
      - refus des chemins absolus
      - refus des membres qui s'échappent de `dest` (`..`)
      - refus des liens symboliques / durs (peuvent pointer hors zone à l'extraction)
    À utiliser à la place de tar.extractall(path=dest)."""
    dest_path = Path(dest).resolve()
    safe_members = []
    for member in tar.getmembers():
        name = member.name
        # Chemin absolu interdit
        if name.startswith("/") or name.startswith("\\") or (len(name) > 1 and name[1] == ":"):
            raise RuntimeError(f"Membre d'archive non sûr (chemin absolu): {name}")
        # Liens symboliques / durs interdits
        if member.issym() or member.islnk():
            raise RuntimeError(f"Membre d'archive non sûr (lien): {name}")
        # Vérifier que la destination résolue reste sous dest
        target = (dest_path / name).resolve()
        if target != dest_path and dest_path not in target.parents:
            raise RuntimeError(f"Membre d'archive non sûr (traversal): {name}")
        safe_members.append(member)
    tar.extractall(path=dest, members=safe_members)


def _get_backup_dir(server_id: int, backup_type: str = "manual") -> Path:
    """Retourne le dossier de sauvegardes d'un serveur (auto ou manual)."""
    backup_dir = BACKUPS_DIR / str(server_id) / backup_type
    backup_dir.mkdir(parents=True, exist_ok=True)
    return backup_dir


def _migrate_legacy_backups(server_id: int):
    """
    Migration : déplace les anciens backups (racine) vers manual/.
    Appelée automatiquement quand on list ou crée un backup.
    """
    legacy_dir = BACKUPS_DIR / str(server_id)
    manual_dir = legacy_dir / "manual"
    manual_dir.mkdir(parents=True, exist_ok=True)

    for f in legacy_dir.glob("*.tar.gz"):
        try:
            dest = manual_dir / f.name
            if not dest.exists():
                f.rename(dest)
                logger.info(f"🔧 Migration backup: {f.name} → manual/")
        except Exception:
            pass


def create_backup(
    server_id: int,
    server_name: str,
    docker_id: str,
    custom_name: str = None,
    backup_type: str = "manual",
) -> dict:
    """
    Crée une sauvegarde des données d'un serveur.

    1. Copie les fichiers du conteneur Docker vers un dossier temporaire
    2. Compresse le tout en .tar.gz
    3. Retourne les infos de la sauvegarde

    Args:
        server_id:   ID du serveur en base
        server_name: Nom du serveur (pour le nom du fichier)
        docker_id:   ID du conteneur Docker
        custom_name: Nom personnalisé pour la sauvegarde (optionnel)
        backup_type: "auto" ou "manual"
    """
    # Migration des anciens backups
    _migrate_legacy_backups(server_id)

    # Vérifier la limite pour les backups manuels
    if backup_type == "manual":
        existing = list_backups(server_id, backup_type="manual")
        if len(existing) >= 10:
            raise RuntimeError("Limite de 10 sauvegardes manuelles atteinte. Supprime une sauvegarde avant d'en créer une nouvelle.")

    try:
        import docker
        client = docker.from_env()
        container = client.containers.get(docker_id)
    except Exception as e:
        raise RuntimeError(f"Conteneur Docker non trouvé: {e}")

    backup_dir = _get_backup_dir(server_id, backup_type)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    
    if custom_name and custom_name.strip():
        safe_custom = custom_name.strip().replace(' ', '-').replace('/', '-').replace('\\', '-')
        backup_name = f"{safe_custom}_{timestamp}"
    else:
        safe_name = server_name.lower().replace(' ', '-').replace('_', '-')
        prefix = "auto" if backup_type == "auto" else safe_name
        backup_name = f"{prefix}_{timestamp}"
    
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

                # Extraire l'archive Docker (filtre anti zip-slip sur chaque membre)
                with tarfile.open(archive_path, 'r') as tar:
                    _safe_extract(tar, temp_dir)

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

        logger.info(f"Sauvegarde créée [{backup_type}]: {backup_path.name} ({size_mb} Mo)")

        return {
            "id": backup_name,
            "filename": backup_path.name,
            "backup_type": backup_type,
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


def list_backups(server_id: int, backup_type: str = None) -> list:
    """
    Retourne la liste des sauvegardes d'un serveur.
    
    Args:
        backup_type: "auto", "manual", ou None pour toutes
    """
    # Migration des anciens backups
    _migrate_legacy_backups(server_id)

    results = []
    types_to_scan = [backup_type] if backup_type else ["auto", "manual"]

    for btype in types_to_scan:
        backup_dir = _get_backup_dir(server_id, btype)
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

            results.append({
                "id": name,
                "filename": f.name,
                "backup_type": btype,
                "created_at": created_str,
                "size_mb": round(stat.st_size / (1024 * 1024), 1),
                "size_bytes": stat.st_size,
            })

    return results


def rename_backup(server_id: int, backup_id: str, new_name: str, backup_type: str = "manual") -> dict:
    """Renomme une sauvegarde."""
    backup_dir = _get_backup_dir(server_id, backup_type)
    # Validation stricte du backup_id source (anti renommage d'un fichier arbitraire).
    old_path = _resolve_backup_path(backup_dir, backup_id)

    if not old_path.exists():
        raise RuntimeError(f"Sauvegarde '{backup_id}' non trouvée")

    # Extraire le timestamp de l'ancien nom
    parts = backup_id.rsplit('_', 2)
    if len(parts) >= 3:
        timestamp = f"{parts[-2]}_{parts[-1]}"
    else:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    # Créer le nouveau nom (puis valider/confiner — le nom cible doit rester
    # sous backup_dir et ne contenir que des caractères sûrs).
    safe_name = new_name.strip().replace(' ', '-').replace('/', '-').replace('\\', '-')
    safe_name = safe_name.replace('..', '-')
    new_id = f"{safe_name}_{timestamp}"
    new_path = _resolve_backup_path(backup_dir, new_id)

    if new_path.exists():
        raise RuntimeError(f"Une sauvegarde avec ce nom existe déjà")

    old_path.rename(new_path)
    logger.info(f"Sauvegarde renommée: {backup_id} -> {new_id}")

    stat = new_path.stat()
    return {
        "id": new_id,
        "filename": new_path.name,
        "size_mb": round(stat.st_size / (1024 * 1024), 1),
        "message": "Sauvegarde renommée",
    }


def restore_backup(server_id: int, backup_id: str, docker_id: str, backup_type: str = "manual") -> bool:
    """
    Restaure une sauvegarde dans le conteneur Docker.

    ⚠️ Le serveur DOIT être arrêté avant de restaurer.

    1. Décompresse l'archive
    2. Copie les fichiers dans le conteneur
    """
    backup_dir = _get_backup_dir(server_id, backup_type)
    # Validation stricte du backup_id + confinement sous backup_dir (anti
    # sélection d'archive arbitraire via `..`/`/`).
    backup_path = _resolve_backup_path(backup_dir, backup_id)

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
        # 1. Décompresser (filtre anti zip-slip sur chaque membre)
        temp_dir.mkdir(parents=True, exist_ok=True)
        with tarfile.open(backup_path, "r:gz") as tar:
            _safe_extract(tar, temp_dir)

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


def delete_backup(server_id: int, backup_id: str, backup_type: str = "manual") -> bool:
    """Supprime une sauvegarde."""
    backup_dir = _get_backup_dir(server_id, backup_type)
    # Validation stricte (anti suppression d'un fichier arbitraire via `..`/`/`).
    backup_path = _resolve_backup_path(backup_dir, backup_id)

    if not backup_path.exists():
        raise RuntimeError(f"Sauvegarde '{backup_id}' non trouvée")

    backup_path.unlink()
    logger.info(f"Sauvegarde supprimée [{backup_type}]: {backup_id}")
    return True


def cleanup_old_backups(server_id: int, keep: int = 10, backup_type: str = "auto"):
    """
    Supprime les anciennes sauvegardes, ne garde que les X plus récentes.
    Ne s'applique qu'aux backups du type spécifié (par défaut: auto).
    Appelée automatiquement après chaque nouveau backup auto.
    """
    backups = list_backups(server_id, backup_type=backup_type)
    if len(backups) > keep:
        for old_backup in backups[keep:]:
            try:
                delete_backup(server_id, old_backup["id"], backup_type=backup_type)
            except Exception:
                pass
