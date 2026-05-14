"""
SFTP Manager — Gère le conteneur SFTP dédié pour les serveurs de jeux.

Utilise l'image Docker `atmoz/sftp` pour créer un service SFTP isolé
avec un utilisateur par serveur de jeux (chrooté dans ses propres données).

Le conteneur est recréé à chaque ajout/suppression de serveur.
"""

import logging
import secrets
import string

logger = logging.getLogger(__name__)

SFTP_CONTAINER_NAME = "omen-sftp"
SFTP_IMAGE = "atmoz/sftp"
SFTP_PORT = 2222


def generate_sftp_password(length: int = 12) -> str:
    """Génère un mot de passe SFTP aléatoire sécurisé."""
    alphabet = string.ascii_letters + string.digits
    return ''.join(secrets.choice(alphabet) for _ in range(length))


def rebuild_sftp_container(db_session) -> dict:
    """
    Arrête, supprime et recrée le conteneur SFTP avec tous les users actuels.
    
    Chaque serveur de jeux actif (avec un docker_id) obtient un utilisateur
    SFTP dédié, chrooté dans le volume /data du conteneur du serveur.
    
    Returns:
        dict avec status et nombre d'utilisateurs configurés
    """
    try:
        import docker
        client = docker.from_env()
        client.ping()
    except Exception as e:
        logger.warning(f"Docker non disponible pour SFTP: {e}")
        return {"status": "docker_unavailable", "users": 0}

    from backend.game_server.models import GameServer

    # Récupérer tous les serveurs avec un conteneur Docker actif et un mdp SFTP
    servers = db_session.query(GameServer).filter(
        GameServer.docker_id.isnot(None),
        GameServer.sftp_password.isnot(None),
    ).all()

    if not servers:
        logger.info("Aucun serveur avec SFTP, pas de conteneur SFTP à créer")
        _stop_sftp_container(client)
        return {"status": "no_servers", "users": 0}

    # Construire la liste des utilisateurs SFTP
    # Format atmoz/sftp: "user:password:uid:gid:dir"
    users_args = []
    volumes_from = []

    for s in servers:
        username = f"mc_{s.id}"
        uid = 1000 + s.id  # UID unique par serveur
        users_args.append(f"{username}:{s.sftp_password}:{uid}:1000:data")
        
        # Ajouter --volumes-from pour accéder aux données du serveur
        if s.docker_id:
            try:
                container = client.containers.get(s.docker_id)
                volumes_from.append(container.name or s.docker_id)
            except Exception:
                logger.warning(f"Conteneur {s.docker_id} introuvable pour SFTP")

    # Arrêter l'ancien conteneur SFTP
    _stop_sftp_container(client)

    if not volumes_from:
        logger.warning("Aucun conteneur source trouvé, SFTP non créé")
        return {"status": "no_containers", "users": 0}

    try:
        # Télécharger l'image si nécessaire
        try:
            client.images.get(SFTP_IMAGE)
        except Exception:
            logger.info(f"Téléchargement de {SFTP_IMAGE}...")
            client.images.pull(SFTP_IMAGE)

        # Créer le conteneur SFTP
        container = client.containers.run(
            SFTP_IMAGE,
            command=" ".join(users_args),
            name=SFTP_CONTAINER_NAME,
            ports={"22/tcp": SFTP_PORT},
            volumes_from=volumes_from,
            detach=True,
            restart_policy={"Name": "unless-stopped"},
        )

        logger.info(f"Conteneur SFTP créé: {container.short_id} avec {len(users_args)} utilisateurs")
        return {"status": "running", "users": len(users_args), "container_id": container.short_id}

    except Exception as e:
        logger.error(f"Erreur création conteneur SFTP: {e}")
        return {"status": "error", "error": str(e), "users": 0}


def _stop_sftp_container(client):
    """Arrête et supprime le conteneur SFTP existant."""
    try:
        old = client.containers.get(SFTP_CONTAINER_NAME)
        old.remove(force=True)
        logger.info("Ancien conteneur SFTP supprimé")
    except Exception:
        pass  # Pas de conteneur existant


def get_sftp_status() -> dict:
    """Vérifie si le conteneur SFTP tourne."""
    try:
        import docker
        client = docker.from_env()
        container = client.containers.get(SFTP_CONTAINER_NAME)
        return {
            "running": container.status == "running",
            "status": container.status,
            "port": SFTP_PORT,
        }
    except Exception:
        return {"running": False, "status": "not_found", "port": SFTP_PORT}
