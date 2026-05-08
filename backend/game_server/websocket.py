"""
WebSocket Console — Streaming de logs Docker en temps réel.

Permet de voir la console d'un serveur de jeu en direct
et d'envoyer des commandes (ex: /say Hello dans Minecraft).

Endpoint: ws://localhost:8000/ws/servers/{server_id}/console?token={jwt_token}
"""

import asyncio
import logging
import threading
from typing import Optional
from queue import Queue, Empty

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


def _stream_logs_thread(container, log_queue: Queue, stop_event: threading.Event):
    """Thread bloquant qui lit les logs Docker et les met dans une queue."""
    try:
        log_stream = container.logs(
            stream=True,
            follow=True,
            tail=0,
            timestamps=False,
        )
        for chunk in log_stream:
            if stop_event.is_set():
                break
            line = chunk.decode("utf-8", errors="replace").rstrip()
            if line:
                log_queue.put(line)
    except Exception as e:
        if not stop_event.is_set():
            log_queue.put(f"__ERROR__:Stream interrompu: {e}")


@router.websocket("/ws/servers/{server_id}/console")
async def console_websocket(
    websocket: WebSocket,
    server_id: int,
    token: str = Query(default=""),
):
    """
    WebSocket pour la console live d'un serveur.

    - Supporte l'authentification via query string (legacy) OU premier message (recommandé)
    - Envoie les logs Docker en temps réel au client
    - Reçoit les commandes du client et les envoie au conteneur
    - Se déconnecte proprement si le conteneur s'arrête
    """
    # 1. Authentification : d'abord essayer via query string (rétro-compatible)
    user = None
    if token:
        user = get_user_from_token(token)

    # Si pas de token en query, accepter la connexion et attendre un message d'auth
    if not user:
        await websocket.accept()
        try:
            # Attendre le premier message d'authentification (timeout 10s)
            auth_msg = await asyncio.wait_for(websocket.receive_json(), timeout=10.0)
            if auth_msg.get("type") == "auth":
                user = get_user_from_token(auth_msg.get("token", ""))
            if not user:
                await websocket.send_json({"type": "error", "message": "Token invalide"})
                await websocket.close(code=4001, reason="Token invalide")
                return
        except (asyncio.TimeoutError, Exception):
            await websocket.close(code=4001, reason="Authentification requise")
            return
    else:
        # Token query valide → accepter la connexion
        await websocket.accept()

    # 2. Vérifier que le serveur existe
    server = get_server(server_id)
    if not server or not server.docker_id:
        await websocket.send_json({"type": "error", "message": "Serveur non trouvé"})
        await websocket.close(code=4004, reason="Serveur non trouvé")
        return

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

    # 6. Streaming en temps réel via thread + queue
    log_queue = Queue()
    stop_event = threading.Event()

    # Lancer le thread de streaming
    log_thread = threading.Thread(
        target=_stream_logs_thread,
        args=(container, log_queue, stop_event),
        daemon=True,
    )
    log_thread.start()

    async def forward_logs():
        """Lit la queue et envoie les logs au WebSocket."""
        while not stop_event.is_set():
            try:
                line = log_queue.get_nowait()
                if line.startswith("__ERROR__:"):
                    await websocket.send_json({
                        "type": "error",
                        "message": line.replace("__ERROR__:", "")
                    })
                else:
                    await websocket.send_json({"type": "log", "data": line})
            except Empty:
                await asyncio.sleep(0.1)

    async def receive_commands():
        """Reçoit les commandes du client et les envoie au conteneur."""
        try:
            while True:
                data = await websocket.receive_json()
                if data.get("type") == "command":
                    cmd = data.get("data", "").strip()
                    if cmd:
                        try:
                            # Envoyer la commande au conteneur via rcon-cli
                            result = container.exec_run(
                                f"rcon-cli {cmd}",
                                detach=False,
                            )
                            output = result.output.decode("utf-8", errors="replace").strip() if result.output else ""
                            if output:
                                await websocket.send_json({
                                    "type": "info",
                                    "data": f"[RCON] {output}"
                                })
                            else:
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
        log_task = asyncio.create_task(forward_logs())
        await receive_commands()
    except Exception as e:
        logger.warning(f"Console WS fermée: {e}")
    finally:
        stop_event.set()
        log_task.cancel()
        logger.info(f"Console WS déconnectée: {user.username} → serveur {server.name}")
