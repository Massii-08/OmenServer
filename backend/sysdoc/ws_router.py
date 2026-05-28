"""
WebSocket router pour le module sysdoc (Diagnostic Bot intégré).

Mapping (v4 — multi-machine per user) :

    /ws/sysdoc/agent/{username}/{machine}   ← agent Windows/macOS sur PC <machine>
                                              de l'utilisateur <username>
    /ws/sysdoc/viewer/{username}             ← dashboard reçoit TOUTES les
                                              machines de <username>, sélecteur UI

Auth : JWT classique OmenServer via `?token=...` query param. Le `sub` du JWT
doit matcher le {username} de l'URL (sauf admin qui peut cross-user).

Multi-machine : un user peut avoir plusieurs machines (Mac perso + PC Windows
gaming + serveur dev). Chaque agent s'identifie par un `machine_id` (default
= socket.gethostname() côté agent). Le hub relaye :
  - agent → viewer  : tous les messages enrichis avec `machine` (le viewer
                      filtre selon sa sélection)
  - viewer → agent  : la commande doit inclure `target_machine` (le backend
                      route vers l'agent ciblé)
  - machines_update : envoyé au viewer à chaque connect/disconnect d'agent
                      (liste des machines disponibles pour cet user)
"""

import json
import logging
import threading
from pathlib import Path
from typing import Dict, Optional, Set, List

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from backend.auth.utils import decode_token
from backend.database import SessionLocal
from backend.auth.models import User

logger = logging.getLogger("omenserver.sysdoc")

router = APIRouter()


# ----------------------------------------------------------------------------
# Persistance des machines connues — data/sysdoc_known_machines.json
#
# Pourquoi : sans ça, un viewer ouvert depuis un nouveau browser (ou avec son
# localStorage vidé) ne voit QUE les machines actuellement online. Si une
# machine est éteinte au moment de l'ouverture, elle disparaît visuellement
# comme si elle n'existait pas. Avec ce JSON, le hub garde trace de toute
# machine qui s'est connectée au moins une fois et envoie la liste complète
# au viewer à l'open — le frontend init les machines absentes de la liste
# online en `agentOnline=false` (pill rouge "offline").
#
# Format : { "username": ["machine_id_1", "machine_id_2", ...] }
# Idempotent à l'ajout ; pas de retrait automatique (le user peut "oublier"
# une machine via le menu UI ou en supprimant manuellement le JSON).
# ----------------------------------------------------------------------------

_KNOWN_MACHINES_FILE = Path(__file__).resolve().parent.parent.parent / "data" / "sysdoc_known_machines.json"
_known_machines_lock = threading.Lock()


def _load_known_machines() -> Dict[str, List[str]]:
    """Charge la map {username: [machine_id, ...]} ; {} si fichier absent/invalide."""
    if not _KNOWN_MACHINES_FILE.exists():
        return {}
    try:
        with open(_KNOWN_MACHINES_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {}
        return {
            u: [m for m in (lst or []) if isinstance(m, str)]
            for u, lst in data.items()
            if isinstance(u, str) and isinstance(lst, list)
        }
    except Exception as exc:
        logger.warning(f"[sysdoc] Failed to load known machines: {exc}")
        return {}


def _add_known_machine(username: str, machine: str) -> None:
    """Ajoute (username, machine) au JSON si pas déjà présent. Thread-safe, idempotent."""
    with _known_machines_lock:
        data = _load_known_machines()
        lst = data.setdefault(username, [])
        if machine in lst:
            return
        lst.append(machine)
        try:
            _KNOWN_MACHINES_FILE.parent.mkdir(parents=True, exist_ok=True)
            with open(_KNOWN_MACHINES_FILE, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            logger.info(f"[sysdoc] Registered known machine {username}/{machine}")
        except Exception as exc:
            logger.error(f"[sysdoc] Failed to save known machines: {exc}")


def _get_known_machines(username: str) -> List[str]:
    """Liste triée des machines déjà vues pour un user."""
    return sorted(_load_known_machines().get(username, []))


class ConnectionManager:
    """
    Stocke les sockets agents (N machines par user) et viewers (N par user).

    self.agents = {
        "Massii08": {
            "macbook-air-de-stefano": <WebSocket>,
            "pc-windows-massii":      <WebSocket>,
        },
        ...
    }
    """

    def __init__(self):
        self.agents: Dict[str, Dict[str, WebSocket]] = {}
        self.viewers: Dict[str, Set[WebSocket]] = {}

    # ---- Agents ----------------------------------------------------------

    async def register_agent(self, username: str, machine: str, ws: WebSocket):
        bucket = self.agents.setdefault(username, {})
        existing = bucket.get(machine)
        if existing is not None:
            try:
                await existing.close(code=1000, reason="Replaced by new agent connection")
            except Exception:
                pass
        bucket[machine] = ws
        logger.info(f"[sysdoc] Agent {username}/{machine} connected (total: {len(bucket)} machines).")

    def unregister_agent(self, username: str, machine: str, ws: WebSocket):
        bucket = self.agents.get(username)
        if not bucket:
            return
        if bucket.get(machine) is ws:
            del bucket[machine]
            logger.info(f"[sysdoc] Agent {username}/{machine} disconnected.")
            if not bucket:
                del self.agents[username]

    def list_machines(self, username: str) -> List[str]:
        return sorted(self.agents.get(username, {}).keys())

    async def relay_to_agent(self, username: str, machine: str, message: str) -> bool:
        agent = self.agents.get(username, {}).get(machine)
        if agent is None:
            return False
        try:
            await agent.send_text(message)
            return True
        except Exception as exc:
            logger.debug(f"[sysdoc] relay_to_agent({username}/{machine}) failed: {exc}")
            return False

    # ---- Viewers --------------------------------------------------------

    def register_viewer(self, username: str, ws: WebSocket):
        self.viewers.setdefault(username, set()).add(ws)
        count = len(self.viewers[username])
        logger.info(f"[sysdoc] Viewer {username} connected (total: {count}).")

    def unregister_viewer(self, username: str, ws: WebSocket):
        bucket = self.viewers.get(username)
        if not bucket:
            return
        bucket.discard(ws)
        remaining = len(bucket)
        if not bucket:
            del self.viewers[username]
        logger.info(f"[sysdoc] Viewer {username} disconnected (remaining: {remaining}).")

    async def relay_to_viewer(self, username: str, message: str) -> bool:
        bucket = self.viewers.get(username)
        if not bucket:
            return False
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

    async def broadcast_machines_update(self, username: str):
        """Envoie aux viewers la liste à jour des machines connectées."""
        machines = self.list_machines(username)
        await self.relay_to_viewer(
            username,
            json.dumps({"type": "machines_update", "data": {"machines": machines}}),
        )


manager = ConnectionManager()


def _resolve_username(token: str) -> Optional[str]:
    if not token:
        return None
    payload = decode_token(token)
    if not payload:
        return None
    return payload.get("sub")


def _is_admin(username: str) -> bool:
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


# ----------------------------------------------------------------------------
# AGENT endpoint — un par machine de l'utilisateur
# ----------------------------------------------------------------------------

@router.websocket("/ws/sysdoc/agent/{username}/{machine}")
async def agent_endpoint(websocket: WebSocket, username: str, machine: str):
    """L'agent envoie ici. Messages enrichis avec machine_id et relayés au viewer."""
    if await _auth_and_accept(websocket, username, allow_admin_cross_user=False) is None:
        return

    await manager.register_agent(username, machine, websocket)
    # Persiste la machine pour qu'elle reste visible (offline rouge) même quand
    # le viewer s'ouvre depuis un autre browser ou avec localStorage vidé.
    _add_known_machine(username, machine)
    await manager.broadcast_machines_update(username)
    await manager.relay_to_viewer(
        username,
        json.dumps({
            "type": "agent_status",
            "data": {"online": True, "machine": machine},
        }),
    )

    try:
        while True:
            data = await websocket.receive_text()
            try:
                parsed = json.loads(data)
            except json.JSONDecodeError:
                logger.debug(f"[sysdoc:agent:{username}/{machine}] invalid JSON ignored")
                continue
            # Enrichit le message avec le machine_id pour que le viewer puisse demux
            if isinstance(parsed, dict):
                parsed["machine"] = machine
                await manager.relay_to_viewer(username, json.dumps(parsed))
            else:
                # Pas un objet — relai brut (cas pathologique)
                await manager.relay_to_viewer(username, data)
    except WebSocketDisconnect:
        pass
    except RuntimeError as exc:
        if "not connected" in str(exc).lower() or "after sending" in str(exc).lower():
            pass
        else:
            raise
    finally:
        manager.unregister_agent(username, machine, websocket)
        # Notifier les viewers que cette machine est partie
        if username not in manager.agents or machine not in manager.agents.get(username, {}):
            await manager.relay_to_viewer(
                username,
                json.dumps({
                    "type": "agent_status",
                    "data": {"online": False, "machine": machine},
                }),
            )
            await manager.broadcast_machines_update(username)


# ----------------------------------------------------------------------------
# VIEWER endpoint — un user-level (pas par machine), reçoit tout
# ----------------------------------------------------------------------------

@router.websocket("/ws/sysdoc/viewer/{username}")
async def viewer_endpoint(websocket: WebSocket, username: str):
    """
    Le dashboard reçoit ici (par user, pas par machine).

    Le viewer reçoit les messages de TOUTES les machines de cet user, taggés
    avec `machine` (pour pouvoir demux dans l'UI).

    Quand il envoie une commande, il DOIT spécifier `target_machine` :
        {"command": "START_MONITORING", "target_machine": "macbook-air"}
    Le backend route vers l'agent de cette machine.
    """
    sub = await _auth_and_accept(websocket, username, allow_admin_cross_user=True)
    if sub is None:
        return

    manager.register_viewer(username, websocket)

    # Envoyer l'état initial : liste des machines + status de chacune
    try:
        # D'abord : la liste historique persistée côté backend. Permet au viewer
        # d'afficher les machines déjà connues même si elles sont actuellement
        # offline (pill rouge). Le frontend init `agentOnline=false` par défaut ;
        # les agent_status:online qui suivent passent les actually-online à true.
        known = _get_known_machines(username)
        if known:
            await websocket.send_text(
                json.dumps({"type": "known_machines", "data": {"machines": known}})
            )

        machines = manager.list_machines(username)
        await websocket.send_text(
            json.dumps({"type": "machines_update", "data": {"machines": machines}})
        )
        for m in machines:
            await websocket.send_text(
                json.dumps({
                    "type": "agent_status",
                    "data": {"online": True, "machine": m},
                })
            )
    except Exception:
        pass

    try:
        while True:
            data = await websocket.receive_text()
            try:
                parsed = json.loads(data)
            except json.JSONDecodeError:
                logger.debug(f"[sysdoc:viewer:{username}] invalid JSON ignored")
                continue
            if not isinstance(parsed, dict):
                continue

            target_machine = parsed.get("target_machine")
            if not target_machine:
                # Pas de target → on ignore (le viewer doit toujours spécifier)
                try:
                    await websocket.send_text(json.dumps({
                        "type": "command_result",
                        "result": {"status": "error", "message": "target_machine manquant dans la commande"},
                    }))
                except Exception:
                    pass
                continue

            # Strip le target_machine avant de forward (l'agent n'en a pas besoin)
            forward = {k: v for k, v in parsed.items() if k != "target_machine"}
            relayed = await manager.relay_to_agent(
                username, target_machine, json.dumps(forward),
            )
            if not relayed:
                try:
                    await websocket.send_text(json.dumps({
                        "type": "command_result",
                        "machine": target_machine,
                        "result": {
                            "status": "error",
                            "message": f"Agent {target_machine} non connecté",
                        },
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
