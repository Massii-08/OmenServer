"""
Docker Manager — Contrôle les conteneurs Docker pour les serveurs de jeux.

Supporte tous les jeux définis dans games_config.py.
Chaque jeu a sa propre image Docker, ses ports et ses variables d'environnement.
"""

import logging
import os
import socket

from backend.config import settings
from backend.game_server.games_config import get_game_config

logger = logging.getLogger(__name__)

_docker_client = None


def _get_docker_client():
    """Retourne le client Docker, en le créant si nécessaire."""
    global _docker_client
    if _docker_client is None:
        try:
            import docker
            _docker_client = docker.from_env()
            _docker_client.ping()
            logger.info("Connexion Docker établie")
        except Exception as e:
            logger.warning(f"Docker non disponible: {e}")
            _docker_client = None
    return _docker_client


def is_docker_available() -> bool:
    """Vérifie si Docker est installé et lancé."""
    client = _get_docker_client()
    if client is None:
        return False
    try:
        client.ping()
        return True
    except Exception:
        return False


def get_local_ip() -> str:
    """
    Détecte l'IP locale de la machine sur le réseau.
    C'est cette IP que les joueurs utiliseront pour se connecter.
    """
    try:
        # Astuce : on ouvre une connexion UDP vers une IP externe
        # pour trouver quelle interface réseau est utilisée
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def mc_server_ping(port: int) -> dict:
    """
    Ping un serveur Minecraft pour obtenir le nombre de joueurs.
    Utilise le protocole Server List Ping (SLP) de Minecraft.
    Retourne {"online": int, "max": int, "players": [str]} ou None si échec.
    """
    import struct
    import json

    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(3)
        s.connect(("localhost", port))

        # Handshake packet
        host = "localhost"
        data = b""
        data += b"\x00"  # packet id
        data += b"\x00"  # protocol version (doesn't matter for status)
        data += struct.pack(">b", len(host)) + host.encode("utf-8")
        data += struct.pack(">H", port)
        data += b"\x01"  # next state: status
        # Add length prefix
        s.send(struct.pack(">b", len(data)) + data)

        # Status request
        s.send(b"\x01\x00")

        # Read response
        def read_varint(sock):
            result = 0
            for i in range(5):
                byte = sock.recv(1)
                if not byte:
                    return 0
                val = byte[0]
                result |= (val & 0x7F) << (7 * i)
                if not (val & 0x80):
                    break
            return result

        _total_len = read_varint(s)
        _packet_id = read_varint(s)
        json_len = read_varint(s)

        json_data = b""
        while len(json_data) < json_len:
            chunk = s.recv(json_len - len(json_data))
            if not chunk:
                break
            json_data += chunk

        s.close()

        resp = json.loads(json_data.decode("utf-8"))
        players_info = resp.get("players", {})
        return {
            "online": players_info.get("online", 0),
            "max": players_info.get("max", 20),
            "players": [p.get("name", "") for p in players_info.get("sample", [])],
        }
    except Exception:
        return None


def create_game_server(
    name: str,
    game_type: str = "minecraft",
    port: int = None,
    memory_mb: int = None,
    version: str = "LATEST",
    custom_image: str = None,
    server_type: str = "VANILLA",
    cf_page_url: str = None,
    cf_file_id: int = None,
) -> dict:
    """
    Crée un conteneur Docker pour n'importe quel jeu supporté.

    Args:
        name:         Nom du serveur
        game_type:    Type de jeu (minecraft, ark, valheim, etc.)
        port:         Port du serveur (utilise le port par défaut du jeu si None)
        memory_mb:    RAM en Mo (utilise la valeur par défaut du jeu si None)
        version:      Version du jeu (si supporté par le jeu)
        custom_image: Image Docker personnalisée (pour game_type="custom")
        server_type:  Variante du serveur (VANILLA, PAPER, FORGE, FABRIC, etc.)
        cf_page_url:  URL CurseForge du modpack
        cf_file_id:   ID fichier CurseForge (version précise)
    """
    client = _get_docker_client()
    if not client:
        raise RuntimeError("Docker n'est pas disponible. Lance Docker Desktop.")

    # Récupérer la config du jeu
    game_config = get_game_config(game_type)

    # Utiliser les valeurs par défaut du jeu si non spécifié
    if port is None:
        port = game_config["default_port"]
    if memory_mb is None:
        memory_mb = game_config["default_memory_mb"]

    # Image Docker à utiliser
    image_name = custom_image if (game_type == "custom" and custom_image) else game_config["image"]
    if not image_name:
        raise RuntimeError("Aucune image Docker spécifiée pour ce jeu")

    # Nom du conteneur Docker (pas d'espaces ni caractères spéciaux)
    safe_name = name.lower().replace(' ', '-').replace('_', '-')
    container_name = f"omen-{game_type}-{safe_name}"

    # Variables d'environnement du jeu
    env = dict(game_config.get("env", {}))

    # Support modpack CurseForge via AUTO_CURSEFORGE (priorité sur server_type)
    if cf_page_url and game_type == "minecraft":
        env["TYPE"] = "AUTO_CURSEFORGE"
        env["CF_API_KEY"] = os.environ.get("CURSEFORGE_API_KEY", "")
        env["CF_PAGE_URL"] = cf_page_url
        if cf_file_id:
            env["CF_FILE_ID"] = str(cf_file_id)
        logger.info(f"Modpack CurseForge: {cf_page_url} (file: {cf_file_id})")
    elif game_type == "minecraft" and server_type:
        # Mode normal : VANILLA, PAPER, FORGE, FABRIC, etc.
        env["TYPE"] = server_type.upper()

    # Ajouter la version si le jeu le supporte
    if game_config.get("version_env") and version:
        env[game_config["version_env"]] = version

    # Ajouter la mémoire si le jeu le supporte
    if game_config.get("memory_env"):
        memory_str = f"{memory_mb // 1024}G" if memory_mb >= 1024 else f"{memory_mb}M"
        env[game_config["memory_env"]] = memory_str

    # Configuration des ports
    protocol = game_config.get("port_protocol", "tcp")
    ports_config = {f"{game_config['default_port']}/{protocol}": port}

    # Ajouter les ports supplémentaires (ARK, Valheim en ont besoin)
    extra_ports = game_config.get("extra_ports", {})
    ports_config.update(extra_ports)

    try:
        # Télécharger l'image Docker si elle n'existe pas
        try:
            client.images.get(image_name)
            logger.info(f"Image {image_name} déjà présente")
        except Exception:
            logger.info(f"Téléchargement de {image_name}... (peut prendre quelques minutes)")
            client.images.pull(image_name)
            logger.info(f"Image {image_name} téléchargée")

        # Supprimer un conteneur existant avec le même nom (cas de conflit)
        try:
            old = client.containers.get(container_name)
            logger.warning(f"Conteneur '{container_name}' existe déjà, suppression...")
            old.remove(force=True)
        except Exception:
            pass

        container = client.containers.create(
            image=image_name,
            name=container_name,
            ports=ports_config,
            environment=env,
            mem_limit=f"{memory_mb + 512}m",
            detach=True,
            restart_policy={"Name": "unless-stopped"},
        )

        logger.info(f"Conteneur créé: {container_name} (ID: {container.short_id})")
        return {
            "docker_id": container.id,
            "container_name": container_name,
            "status": "created",
        }

    except Exception as e:
        logger.error(f"Erreur création conteneur: {e}")
        raise RuntimeError(f"Impossible de créer le serveur: {e}")


def start_container(docker_id: str) -> bool:
    """Démarre un conteneur Docker existant."""
    client = _get_docker_client()
    if not client:
        raise RuntimeError("Docker non disponible")
    try:
        container = client.containers.get(docker_id)
        container.start()
        logger.info(f"Conteneur démarré: {container.short_id}")
        return True
    except Exception as e:
        logger.error(f"Erreur démarrage: {e}")
        raise RuntimeError(f"Impossible de démarrer: {e}")


def stop_container(docker_id: str) -> bool:
    """Arrête un conteneur Docker proprement."""
    client = _get_docker_client()
    if not client:
        raise RuntimeError("Docker non disponible")
    try:
        container = client.containers.get(docker_id)
        container.stop(timeout=30)
        logger.info(f"Conteneur arrêté: {container.short_id}")
        return True
    except Exception as e:
        logger.error(f"Erreur arrêt: {e}")
        raise RuntimeError(f"Impossible d'arrêter: {e}")


def get_container_status(docker_id: str) -> dict:
    """Retourne le statut détaillé d'un conteneur."""
    client = _get_docker_client()
    if not client:
        return {"status": "unknown", "docker_available": False}
    try:
        container = client.containers.get(docker_id)
        status_info = {
            "status": container.status,
            "docker_available": True,
        }
        if container.status == "running":
            try:
                stats = container.stats(stream=False)
                mem_usage = stats.get("memory_stats", {}).get("usage", 0)
                mem_limit = stats.get("memory_stats", {}).get("limit", 0)
                status_info["memory_usage_mb"] = round(mem_usage / (1024 ** 2), 1)
                status_info["memory_limit_mb"] = round(mem_limit / (1024 ** 2), 1)
            except Exception:
                pass
        return status_info
    except Exception as e:
        logger.warning(f"Conteneur introuvable: {e}")
        return {"status": "not_found", "docker_available": True}


def get_container_logs(docker_id: str, tail: int = 100) -> str:
    """Retourne les dernières lignes de logs du conteneur."""
    client = _get_docker_client()
    if not client:
        return "Docker non disponible"
    try:
        container = client.containers.get(docker_id)
        logs = container.logs(tail=tail, timestamps=False).decode("utf-8", errors="replace")
        return logs
    except Exception as e:
        return f"Erreur lecture logs: {e}"


def delete_container(docker_id: str) -> bool:
    """Supprime un conteneur Docker (l'arrête d'abord si nécessaire)."""
    client = _get_docker_client()
    if not client:
        raise RuntimeError("Docker non disponible")
    try:
        container = client.containers.get(docker_id)
        container.remove(force=True)
        logger.info(f"Conteneur supprimé: {container.short_id}")
        return True
    except Exception as e:
        logger.error(f"Erreur suppression: {e}")
        raise RuntimeError(f"Impossible de supprimer: {e}")


def update_container_resources(docker_id: str, memory_mb: int, cpu_percent: int) -> dict:
    """
    Met à jour les ressources (RAM + CPU) d'un conteneur Docker.

    Args:
        docker_id:    ID du conteneur Docker
        memory_mb:    RAM en Mo (ex: 2048 = 2 Go)
        cpu_percent:  % CPU (100 = 1 cœur, 200 = 2 cœurs)

    Docker utilise:
        - mem_limit: limite RAM en bytes
        - nano_cpus: CPU en nano-CPUs (1 cœur = 1_000_000_000)
    """
    client = _get_docker_client()
    if not client:
        raise RuntimeError("Docker non disponible")
    try:
        container = client.containers.get(docker_id)

        # Convertir en unités Docker
        mem_bytes = memory_mb * 1024 * 1024
        # cpu_period = 100000 µs (par défaut), cpu_quota = période * (percent / 100)
        cpu_period = 100000
        cpu_quota = int(cpu_period * cpu_percent / 100)

        container.update(
            mem_limit=mem_bytes,
            memswap_limit=mem_bytes * 2,  # Swap = 2x la RAM
            cpu_period=cpu_period,
            cpu_quota=cpu_quota,
        )

        logger.info(f"Ressources mises à jour: {container.short_id} → {memory_mb}Mo RAM, {cpu_percent}% CPU")
        return {
            "memory_mb": memory_mb,
            "cpu_percent": cpu_percent,
        }
    except Exception as e:
        logger.error(f"Erreur mise à jour ressources: {e}")
        raise RuntimeError(f"Impossible de modifier les ressources: {e}")
