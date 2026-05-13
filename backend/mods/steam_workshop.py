"""
Client Steam Workshop.

Communique avec l'API publique Steam pour récupérer les métadonnées
des items Workshop, et installe les mods via SteamCMD dans les conteneurs Docker.

API Steam (sans clé requise) :
    https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/

Installation via SteamCMD :
    steamcmd +login anonymous +workshop_download_item <APP_ID> <WORKSHOP_ID> +quit

Workshop path dans le conteneur :
    /home/steam/steamapps/workshop/content/<APP_ID>/<WORKSHOP_ID>/
"""

import re
import subprocess
import logging
from pathlib import Path
from typing import Optional

import requests

logger = logging.getLogger("omenserver")

# API publique Steam (pas de clé requise)
STEAM_API_URL = "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/"

# Dossier Workshop dans les conteneurs SteamCMD
WORKSHOP_BASE_PATH = "/home/steam/steamapps/workshop/content"


def parse_workshop_id(input_str: str) -> Optional[str]:
    """
    Extrait l'ID Workshop depuis une URL Steam ou un identifiant direct.

    Exemples acceptés :
        - "111111111"
        - "https://steamcommunity.com/sharedfiles/filedetails/?id=111111111"
        - "https://steamcommunity.com/workshop/filedetails/?id=111111111"

    Returns:
        L'ID numérique sous forme de string, ou None si invalide.
    """
    input_str = input_str.strip()

    # Vérifier si c'est un entier direct
    if input_str.isdigit():
        return input_str

    # Extraire depuis une URL Steam
    match = re.search(r"[?&]id=(\d+)", input_str)
    if match:
        return match.group(1)

    return None


def get_workshop_item_details(workshop_id: str) -> dict:
    """
    Récupère les métadonnées d'un item Steam Workshop via l'API publique.

    Args:
        workshop_id: ID numérique de l'item Workshop

    Returns:
        dict avec : id, title, description, preview_url, file_size, subscriptions,
                    tags, creator, time_updated, app_id

    Raises:
        RuntimeError: Si l'item n'existe pas ou si l'API est indisponible.
    """
    try:
        r = requests.post(
            STEAM_API_URL,
            data={"itemcount": 1, "publishedfileids[0]": workshop_id},
            timeout=10,
        )
        r.raise_for_status()
        data = r.json()

        items = data.get("response", {}).get("publishedfiledetails", [])
        if not items:
            raise RuntimeError(f"Item Workshop {workshop_id} introuvable.")

        item = items[0]
        result = item.get("result", 0)

        # result=1 signifie succès, result=9 = item privé/inexistant
        if result != 1:
            raise RuntimeError(
                f"Item Workshop {workshop_id} introuvable ou inaccessible (result={result})."
            )

        # Taille en Mo
        file_size_bytes = int(item.get("file_size", 0))
        size_mb = round(file_size_bytes / (1024 * 1024), 2) if file_size_bytes else None

        # Tags
        tags = [t.get("tag", "") for t in item.get("tags", [])]

        return {
            "id": workshop_id,
            "app_id": str(item.get("consumer_app_id", "")),
            "title": item.get("title", ""),
            "description": item.get("short_description", item.get("description", ""))[:300],
            "preview_url": item.get("preview_url", ""),
            "file_size_mb": size_mb,
            "subscriptions": item.get("subscriptions", 0),
            "tags": tags,
            "creator": item.get("creator", ""),
            "time_updated": item.get("time_updated", 0),
            "visibility": item.get("visibility", 0),
            "url": f"https://steamcommunity.com/sharedfiles/filedetails/?id={workshop_id}",
        }

    except requests.exceptions.RequestException as e:
        logger.error(f"Erreur API Steam Workshop: {e}")
        raise RuntimeError(f"Erreur API Steam: {e}")


def install_workshop_mod(container_id: str, app_id: int, workshop_id: str) -> dict:
    """
    Installe un mod Steam Workshop dans un conteneur Docker via SteamCMD.

    Args:
        container_id: ID du conteneur Docker
        app_id: App ID Steam du jeu (ex: 376030 pour ARK)
        workshop_id: ID de l'item Workshop

    Returns:
        dict avec 'success', 'message', 'path'

    Raises:
        RuntimeError: Si SteamCMD échoue ou est absent du conteneur.
    """
    # Vérifier si steamcmd est disponible dans le conteneur
    check_cmd = [
        "docker", "exec", container_id,
        "which", "steamcmd"
    ]
    check = subprocess.run(check_cmd, capture_output=True, text=True, timeout=10)
    if check.returncode != 0:
        raise RuntimeError(
            "SteamCMD n'est pas disponible dans ce conteneur. "
            "Utilisez une image compatible SteamCMD (ex: ich777/steamcmd)."
        )

    # Lancer le téléchargement via SteamCMD
    steamcmd_cmd = [
        "docker", "exec", container_id,
        "steamcmd",
        "+login", "anonymous",
        "+workshop_download_item", str(app_id), str(workshop_id),
        "+quit"
    ]

    logger.info(f"Installation Workshop {workshop_id} (App {app_id}) dans {container_id[:12]}...")

    try:
        result = subprocess.run(
            steamcmd_cmd,
            capture_output=True,
            text=True,
            timeout=300,  # 5 min max
        )

        output = result.stdout + result.stderr

        if result.returncode != 0:
            logger.error(f"SteamCMD erreur: {output[-500:]}")
            raise RuntimeError(f"SteamCMD a échoué (code {result.returncode})")

        # Vérifier que le téléchargement s'est bien passé
        if "Success" not in output and "Downloading item" not in output:
            logger.warning(f"SteamCMD output inattendu: {output[-300:]}")

        mod_path = f"{WORKSHOP_BASE_PATH}/{app_id}/{workshop_id}"
        logger.info(f"✅ Workshop {workshop_id} installé → {mod_path}")

        return {
            "success": True,
            "message": f"Mod Workshop {workshop_id} installé avec succès.",
            "path": mod_path,
            "workshop_id": workshop_id,
        }

    except subprocess.TimeoutExpired:
        raise RuntimeError("Timeout : le téléchargement a pris trop longtemps (>5 min).")
    except subprocess.SubprocessError as e:
        raise RuntimeError(f"Erreur Docker exec: {e}")


def list_installed_workshop_mods(container_id: str, app_id: int) -> list:
    """
    Liste les mods Workshop installés dans le conteneur Docker.

    Args:
        container_id: ID du conteneur Docker
        app_id: App ID Steam du jeu

    Returns:
        Liste de dicts avec 'workshop_id' et 'size_mb'
    """
    workshop_path = f"{WORKSHOP_BASE_PATH}/{app_id}"

    # Lister les sous-dossiers (chaque sous-dossier = un workshop_id)
    cmd = ["docker", "exec", container_id, "ls", "-1", workshop_path]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)

    if result.returncode != 0:
        # Le dossier n'existe pas encore = aucun mod installé
        return []

    mods = []
    for line in result.stdout.strip().split("\n"):
        workshop_id = line.strip()
        if workshop_id.isdigit():
            # Calculer la taille du dossier
            size_cmd = ["docker", "exec", container_id, "du", "-sm", f"{workshop_path}/{workshop_id}"]
            size_result = subprocess.run(size_cmd, capture_output=True, text=True, timeout=10)
            size_mb = 0
            if size_result.returncode == 0:
                try:
                    size_mb = int(size_result.stdout.split("\t")[0])
                except (ValueError, IndexError):
                    pass

            mods.append({
                "workshop_id": workshop_id,
                "size_mb": size_mb,
                "path": f"{workshop_path}/{workshop_id}",
            })

    return mods


def remove_workshop_mod(container_id: str, app_id: int, workshop_id: str) -> bool:
    """
    Supprime un mod Workshop du conteneur Docker.

    Args:
        container_id: ID du conteneur Docker
        app_id: App ID Steam du jeu
        workshop_id: ID de l'item Workshop à supprimer

    Returns:
        True si supprimé avec succès.

    Raises:
        FileNotFoundError: Si le mod n'est pas installé.
        RuntimeError: Si la suppression échoue.
    """
    mod_path = f"{WORKSHOP_BASE_PATH}/{app_id}/{workshop_id}"

    # Vérifier que le dossier existe
    check_cmd = ["docker", "exec", container_id, "test", "-d", mod_path]
    check = subprocess.run(check_cmd, capture_output=True, timeout=10)
    if check.returncode != 0:
        raise FileNotFoundError(f"Mod Workshop {workshop_id} non trouvé dans ce serveur.")

    # Supprimer
    rm_cmd = ["docker", "exec", container_id, "rm", "-rf", mod_path]
    result = subprocess.run(rm_cmd, capture_output=True, text=True, timeout=30)

    if result.returncode != 0:
        raise RuntimeError(f"Impossible de supprimer le mod: {result.stderr}")

    logger.info(f"🗑️ Mod Workshop {workshop_id} supprimé de {container_id[:12]}")
    return True
