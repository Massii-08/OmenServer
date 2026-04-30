"""
WebSocket Console — Streaming de logs Docker en temps réel.

Permet de voir la console d'un serveur de jeu en direct
et d'envoyer des commandes (ex: /say Hello dans Minecraft).

Endpoint: ws://localhost:8000/ws/servers/{server_id}/console?token={jwt_token}
"""

import asyncio
import logging
from typing import Optional

from fastapi import WebSocket, WebSocketDisconnect, APIRouter, Query
from sqlalchemy.orm import Session

from backend.database import SessionLocal
from backend.auth.models import User
from backend.auth.utils import decode_token
from backend.game_server.models import GameServer

logger = logging.getLogger(__name__)

router = APIRouter()


def get_user_from_token(token: str) -> Optional[User]:
    """Vérifie le token JWT et retourne l'utilisateur."""
    try:
        payload = decode_token(token)
        if not payload:
            return None
        username = payload.get("sub")
        if not username:
            return None
        db = SessionLocal()
        user = db.query(User).filter(User.username == username).first()
        db.close()
        return user
    except Exception:
        return None


def get_server(server_id: int) -> Optional[GameServer]:
    """Récupère un serveur depuis la DB."""
    db = SessionLocal()
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    db.close()
    return server


@router.websocket("/ws/servers/{server_id}/console")
async def console_websocket(
    websocket: WebSocket,
    server_id: int,
    token: str = Query(default=""),
):
    """
    WebSocket pour la console live d'un serveur.

    - Envoie les logs Docker en temps réel au client
    - Reçoit les commandes du client et les envoie au conteneur
    - Se déconnecte proprement si le conteneur s'arrête
    """
    # 1. Authentification via token dans l'URL
    user = get_user_from_token(token)
    if not user:
        await websocket.close(code=4001, reason="Token invalide")
        return

    # 2. Vérifier que le serveur existe
    server = get_server(server_id)
    if not server or not server.docker_id:
        await websocket.close(code=4004, reason="Serveur non trouvé")
        return

    # 3. Accepter la connexion WebSocket
    await websocket.accept()
    logger.info(f"Console WS connectée: {user.username} → serveur {server.name}")

    # 4. Récupérer le conteneur Docker
    try:
        import docker
        client = docker.from_env()
        container = client.containers.get(server.docker_id)
    except Exception as e:
        await websocket.send_json({
            "type": "error",
            "message": f"Impossible d'accéder au conteneur: {e}"
        })
        await websocket.close()
        return

    # 5. Envoyer les dernières lignes de logs existantes
    try:
        existing_logs = container.logs(tail=50, timestamps=False).decode("utf-8", errors="replace")
        if existing_logs.strip():
            for line in existing_logs.strip().split("\n"):
                await websocket.send_json({"type": "log", "data": line})
    except Exception:
        pass

    # 6. Démarrer le streaming en parallèle
    stop_event = asyncio.Event()

    async def stream_logs():
        """Lit les nouveaux logs Docker et les envoie au client."""
        try:
            # Suivre les nouveaux logs en temps réel
            log_stream = container.logs(
                stream=True,
                follow=True,
                since=int(asyncio.get_event_loop().time()),
                timestamps=False,
            )
            for chunk in log_stream:
                if stop_event.is_set():
                    break
                line = chunk.decode("utf-8", errors="replace").rstrip()
                if line:
                    await websocket.send_json({"type": "log", "data": line})
                # Petit délai pour ne pas surcharger
                await asyncio.sleep(0.05)
        except Exception as e:
            if not stop_event.is_set():
                await websocket.send_json({
                    "type": "error",
                    "message": f"Stream interrompu: {e}"
                })

    async def receive_commands():
        """Reçoit les commandes du client et les envoie au conteneur."""
        try:
            while True:
                data = await websocket.receive_json()
                if data.get("type") == "command":
                    cmd = data.get("data", "").strip()
                    if cmd:
                        try:
                            # Envoyer la commande au conteneur via docker exec
                            # Pour Minecraft, on utilise rcon-cli ou l'entrée standard
                            container.exec_run(
                                f"rcon-cli {cmd}",
                                detach=True,
                            )
                            await websocket.send_json({
                                "type": "info",
                                "data": f"→ Commande envoyée: {cmd}"
                            })
                        except Exception as e:
                            await websocket.send_json({
                                "type": "error",
                                "message": f"Erreur commande: {e}"
                            })
        except WebSocketDisconnect:
            pass
        except Exception:
            pass
        finally:
            stop_event.set()

    # 7. Lancer les deux tâches en parallèle
    try:
        # stream_logs tourne dans un thread séparé (car Docker est bloquant)
        log_task = asyncio.create_task(
            asyncio.to_thread(lambda: asyncio.run(stream_logs()))
        )
        # receive_commands tourne dans la boucle async principale
        await receive_commands()
    except Exception as e:
        logger.warning(f"Console WS fermée: {e}")
    finally:
        stop_event.set()
        logger.info(f"Console WS déconnectée: {user.username} → serveur {server.name}")
