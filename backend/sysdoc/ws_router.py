"""
WebSocket router pour le module sysdoc (Diagnostic Bot intégré).

Deux endpoints :
  - /ws/sysdoc/agent/{username}   ← l'agent Windows/macOS pousse ses métriques
  - /ws/sysdoc/viewer/{username}  ← le dashboard frontend reçoit et envoie

Auth : JWT classique OmenServer via `?token=...` query param.
  - sub du token DOIT matcher le {username} du path (strict 1:1)
  - Sauf si le token appartient à un admin → peut viewer n'importe quel agent

Relais : le backend ne fait QUE forwarder les messages entre agent et viewer
appartenant au même username. Aucun traitement métier côté hub — c'est l'agent
qui exécute les actions (suspend, clear cache, etc.).
"""

import json
import logging
from typing import Dict, Optional, Set

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from backend.auth.utils import decode_token
from backend.database import SessionLocal
from backend.auth.models import User

logger = logging.getLogger("omenserver.sysdoc")

router = APIRouter()


class ConnectionManager:
    """
    Stocke les sockets agents (strict 1:1) et viewers (N par user) par username.

    Pourquoi N viewers par user :
      - L'utilisateur peut avoir 2 onglets/devices ouverts sur Diagnostic en même
        temps (PWA mobile + desktop, ou par accident 2 tabs). Forcer le 1:1 fait
        un combat infini où chaque nouveau tab kicke le précédent (storm de
        reconnexions à 3s, pollue les logs, consomme du CPU).
      - On broadcast les metrics de l'agent à TOUS les viewers du user.
      - Les viewers qui meurent (network drop, tab fermé) sont nettoyés à la
        prochaine tentative de send.

    Pourquoi 1 agent par user (strict) :
      - Un user a 1 PC physique. 2 agents pour le même username = bug d'install.
        On garde le `_replace` qui kicke le précédent pour éviter de polluer
        avec un agent zombie qui survit après reboot.
    """

    def __init__(self):
        self.agents: Dict[str, WebSocket] = {}
        self.viewers: Dict[str, Set[WebSocket]] = {}

    async def _replace_agent(self, username: str, ws: WebSocket):
        existing = self.agents.get(username)
        if existing is not None:
            try:
                await existing.close(code=1000, reason="Replaced by new agent connection")
            except Exception:
                pass
        self.agents[username] = ws

    async def register_agent(self, username: str, ws: WebSocket):
        await self._replace_agent(username, ws)
        logger.info(f"[sysdoc] Agent {username} connected.")

    def register_viewer(self, username: str, ws: WebSocket):
        # Pas de _replace — on ajoute au set
        self.viewers.setdefault(username, set()).add(ws)
        count = len(self.viewers[username])
        logger.info(f"[sysdoc] Viewer {username} connected (total: {count}).")

    def unregister_agent(self, username: str, ws: WebSocket):
        if self.agents.get(username) is ws:
            del self.agents[username]
            logger.info(f"[sysdoc] Agent {username} disconnected.")

    def unregister_viewer(self, username: str, ws: WebSocket):
        bucket = self.viewers.get(username)
        if not bucket:
            return
        bucket.discard(ws)
        remaining = len(bucket)
        if not bucket:
            del self.viewers[username]
        logger.info(f"[sysdoc] Viewer {username} disconnected (remaining: {remaining}).")

    def viewer_count(self, username: str) -> int:
        return len(self.viewers.get(username, ()))

    async def relay_to_viewer(self, username: str, message: str) -> bool:
        """
        Broadcast à TOUS les viewers du username. Retourne True si ≥1 viewer
        a reçu le message. Les sockets dead sont removed du set.
        """
        bucket = self.viewers.get(username)
        if not bucket:
            return False
        # Snapshot pour éviter mutation pendant l'itération
        dead: list = []
        delivered = 0
        for viewer in list(bucket):
            try:
                await viewer.send_text(message)
                delivered += 1
            except Exception as exc:
                logger.debug(f"[sysdoc] relay_to_viewer({username}) drop dead socket: {exc}")
                dead.append(viewer)
        for ws in dead:
            bucket.discard(ws)
        if not bucket:
            self.viewers.pop(username, None)
        return delivered > 0

    async def relay_to_agent(self, username: str, message: str) -> bool:
        agent = self.agents.get(username)
        if agent is None:
            return False
        try:
            await agent.send_text(message)
            return True
        except Exception as exc:
            logger.debug(f"[sysdoc] relay_to_agent({username}) failed: {exc}")
            return False


manager = ConnectionManager()


def _resolve_username(token: str) -> Optional[str]:
    """Décode le token et retourne le sub (username), ou None si invalide."""
    if not token:
        return None
    payload = decode_token(token)
    if not payload:
        return None
    return payload.get("sub")


def _is_admin(username: str) -> bool:
    """Vérifie si le user a is_admin=True (pour autoriser cross-user viewing)."""
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.username == username).first()
        return bool(user and user.is_admin)
    finally:
        db.close()


async def _auth_and_accept(
    websocket: WebSocket,
    path_username: str,
    *,
    allow_admin_cross_user: bool = False,
) -> Optional[str]:
    """
    Accepte le handshake puis valide le JWT.
    Retourne le `sub` du token (= username effectif) ou None (et ferme la socket).

    Règle :
      - sub du token == path_username  → OK
      - allow_admin_cross_user=True + token est admin → OK (admin peut viewer tous)
      - sinon → fermeture 1008
    """
    await websocket.accept()
    token = websocket.query_params.get("token")
    sub = _resolve_username(token)
    if not sub:
        await websocket.close(code=1008, reason="Missing or invalid JWT")
        return None
    if sub != path_username:
        if not (allow_admin_cross_user and _is_admin(sub)):
            await websocket.close(code=1008, reason="Username mismatch")
            return None
    return sub


@router.websocket("/ws/sysdoc/agent/{username}")
async def agent_endpoint(websocket: WebSocket, username: str):
    """L'agent envoie ici. Messages relayés au viewer du même username."""
    # Agents : auth strict (pas d'override admin — un agent ne peut représenter qu'un user)
    if await _auth_and_accept(websocket, username, allow_admin_cross_user=False) is None:
        return

    await manager.register_agent(username, websocket)
    await manager.relay_to_viewer(
        username,
        json.dumps({"type": "agent_status", "data": {"online": True}}),
    )

    try:
        while True:
            data = await websocket.receive_text()
            try:
                json.loads(data)
            except json.JSONDecodeError:
                logger.debug(f"[sysdoc:agent:{username}] invalid JSON ignored")
                continue
            await manager.relay_to_viewer(username, data)
    except WebSocketDisconnect:
        pass
    except RuntimeError as exc:
        # Starlette : "WebSocket is not connected. Need to call accept first." quand
        # _replace() a fermé la socket sous nos pieds. Traiter comme disconnect.
        if "not connected" in str(exc).lower() or "after sending" in str(exc).lower():
            pass
        else:
            raise
    finally:
        manager.unregister_agent(username, websocket)
        if username not in manager.agents:
            await manager.relay_to_viewer(
                username,
                json.dumps({"type": "agent_status", "data": {"online": False}}),
            )


@router.websocket("/ws/sysdoc/viewer/{username}")
async def viewer_endpoint(websocket: WebSocket, username: str):
    """Le dashboard reçoit ici. Messages forward à l'agent du même username."""
    # Viewers : admin peut viewer d'autres users (utile pour debug / support)
    sub = await _auth_and_accept(websocket, username, allow_admin_cross_user=True)
    if sub is None:
        return

    manager.register_viewer(username, websocket)

    agent_online = username in manager.agents
    try:
        await websocket.send_text(
            json.dumps({"type": "agent_status", "data": {"online": agent_online}})
        )
    except Exception:
        pass

    try:
        while True:
            data = await websocket.receive_text()
            try:
                json.loads(data)
            except json.JSONDecodeError:
                logger.debug(f"[sysdoc:viewer:{username}] invalid JSON ignored")
                continue
            relayed = await manager.relay_to_agent(username, data)
            if not relayed:
                try:
                    await websocket.send_text(json.dumps({
                        "type": "command_result",
                        "result": {"status": "error", "message": "Agent not connected"},
                    }))
                except Exception:
                    pass
    except WebSocketDisconnect:
        pass
    except RuntimeError as exc:
        if "not connected" in str(exc).lower() or "after sending" in str(exc).lower():
            pass
        else:
            raise
    finally:
        manager.unregister_viewer(username, websocket)
