"""WebSocket push ``/ws/paper`` de l'extension TradingView « coach ».

Le panneau ne sonde plus : il ÉCOUTE. C'est le levier n°2 de la spec (§7) —
« menace → notification < 1 s après ``maybe_fire`` », là où un polling à cinq
minutes pouvait laisser passer un quart d'heure.

Contrat (spec §5.3, plan §1.4) :

* le client se connecte, le serveur **accepte**, puis attend un PREMIER message
  ``{"token": "<jwt>"}`` sous ``AUTH_TIMEOUT_S`` secondes ; sinon ``close(1008)``.
  Le jeton ne passe JAMAIS en query string (il finirait dans les journaux
  d'accès du reverse-proxy) ;
* rôle exigé ∈ ``ALLOWED_ROLES`` (``admin``/``money``/``trader``), exactement
  celui de ``require_role`` sur les routes HTTP du simulateur ;
* ``MAX_SOCKETS_PER_USER`` sockets par utilisateur (un onglet = un socket) ;
  au-delà, ``close(1008)`` ;
* ping serveur toutes les ``PING_INTERVAL_S`` secondes (``{"type": "ping"}``),
  le client répond ``{"type": "pong"}`` (le serveur n'exige rien : le ping sert
  surtout à traverser les proxys qui coupent les connexions inactives) ;
* messages serveur : ``{"type": "alert"|"digest"|"threat"|"calendar_soon"|
  "news"|"brief_changed", "symbol": str|None, "payload": {...}, "ts": iso}``.

``emit(username, type_, symbol, payload)`` est le point d'entrée des
PRODUCTEURS (``convergence.maybe_fire``, le volet des alertes de prix,
``tvnews.run``, ``tvcalendar.notify_soon``). Il est appelé depuis le thread du
guetteur, PAS depuis la boucle asyncio : il passe donc par
``asyncio.run_coroutine_threadsafe`` sur une boucle enregistrée. Trois
propriétés non négociables :

1. **il ne lève jamais** — un push perdu ne doit pas faire perdre un digest ;
2. **sans boucle enregistrée, c'est un no-op** — et c'est le bon défaut : sans
   boucle, il n'y a aucun socket, donc personne à qui pousser ;
3. **il n'attend rien** — on ne bloque jamais le guetteur sur le réseau d'un
   navigateur.

La boucle est enregistrée au PREMIER ``accept`` (``set_loop``), pas à
l'import : c'est le premier instant où l'on sait qu'une boucle tourne, et le
seul dont on ait besoin (avant lui, il n'y a rien à pousser).
"""
import asyncio
import json
import logging
import threading
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Set

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger("omenserver")

router = APIRouter(tags=["paper-ws"])

# --------------------------------------------------------------------------- #
# Constantes du protocole — surchargeables en test (aucune attente réelle)
# --------------------------------------------------------------------------- #

AUTH_TIMEOUT_S = 5.0
PING_INTERVAL_S = 25.0
MAX_SOCKETS_PER_USER = 4

ALLOWED_ROLES = ("admin", "money", "trader")

# Les types de messages du contrat. Liste PERMISSIVE : un type inconnu passe
# quand même (le client ignore ce qu'il ne connaît pas), mais il est journalisé
# — un producteur qui se trompe de nom doit laisser une trace.
MESSAGE_TYPES = ("alert", "digest", "threat", "calendar_soon", "news",
                 "brief_changed")

CLOSE_POLICY = 1008          # « policy violation » : auth ratée, quota dépassé


# --------------------------------------------------------------------------- #
# La boucle asyncio du serveur, vue depuis les threads du guetteur
# --------------------------------------------------------------------------- #

_LOOP: Optional[Any] = None
_LOOP_LOCK = threading.Lock()


def set_loop(loop: Any) -> None:
    """Enregistre la boucle asyncio sur laquelle ``emit`` postera."""
    global _LOOP
    with _LOOP_LOCK:
        _LOOP = loop


def get_loop() -> Optional[Any]:
    """La boucle enregistrée, ou ``None``."""
    return _LOOP


def reset_loop() -> None:
    """Oublie la boucle (fin de vie du serveur, isolation entre deux tests)."""
    set_loop(None)


# --------------------------------------------------------------------------- #
# Le registre des sockets
# --------------------------------------------------------------------------- #

class ConnectionManager(object):
    """``{username: {WebSocket, ...}}`` — calqué sur ``sysdoc/ws_router.py``.

    Un onglet TradingView = un socket ; ``MAX_SOCKETS_PER_USER`` bornent le
    nombre d'onglets qu'un compte peut tenir ouverts. Le registre vit dans la
    boucle asyncio : toutes ses méthodes s'appellent depuis elle.
    """

    def __init__(self) -> None:
        self.clients: Dict[str, Set[WebSocket]] = {}

    def count(self, username: str) -> int:
        return len(self.clients.get(username) or ())

    def full(self, username: str) -> bool:
        return self.count(username) >= MAX_SOCKETS_PER_USER

    def register(self, username: str, websocket: WebSocket) -> None:
        self.clients.setdefault(username, set()).add(websocket)
        logger.info("[paper-ws] %s connecté (%d socket(s))",
                    username, self.count(username))

    def unregister(self, username: str, websocket: WebSocket) -> None:
        bucket = self.clients.get(username)
        if not bucket:
            return
        bucket.discard(websocket)
        if not bucket:
            self.clients.pop(username, None)

    async def send(self, websocket: WebSocket, message: str) -> bool:
        try:
            await websocket.send_text(message)
            return True
        except Exception:         # noqa: BLE001 — socket mort
            return False

    async def broadcast(self, username: Optional[str], message: str) -> int:
        """Pousse ``message`` à un utilisateur, ou à TOUS si ``username`` est
        ``None`` (un digest de convergence ne s'adresse à personne en
        particulier). Les sockets morts sont retirés au passage."""
        if username is None:
            targets = [(user, ws) for user, bucket in list(self.clients.items())
                       for ws in list(bucket)]
        else:
            targets = [(username, ws)
                       for ws in list(self.clients.get(username) or ())]
        delivered = 0
        for user, websocket in targets:
            if await self.send(websocket, message):
                delivered += 1
            else:
                self.unregister(user, websocket)
        return delivered

    async def broadcast_all(self, message: str) -> int:
        return await self.broadcast(None, message)


manager = ConnectionManager()


# --------------------------------------------------------------------------- #
# Authentification — décodage du jeton, puis rôle
# --------------------------------------------------------------------------- #

def _lookup_user(username: str) -> Optional[Dict[str, Any]]:
    """Le compte en base -> ``{username, role, is_admin}``, ou ``None``.

    Isolé dans sa propre fonction pour être remplaçable en test : le protocole
    du WebSocket se teste sans base de données, mais le décodage du jeton, lui,
    reste le VRAI (cf. ``_resolve_user``).
    """
    try:
        from backend.database import SessionLocal
        from backend.auth.models import User
    except Exception:             # noqa: BLE001 — base indisponible
        return None
    db = None
    try:
        db = SessionLocal()
        user = db.query(User).filter(User.username == username).first()
        if user is None:
            return None
        return {"username": user.username,
                "role": (getattr(user, "role", None) or "player"),
                "is_admin": bool(getattr(user, "is_admin", False))}
    except Exception:             # noqa: BLE001 — requête en panne
        logger.warning("[paper-ws] compte illisible pour %s", username)
        return None
    finally:
        if db is not None:
            try:
                db.close()
            except Exception:     # noqa: BLE001
                pass


def _resolve_user(token: Any) -> Optional[Dict[str, Any]]:
    """Jeton -> compte AUTORISÉ, ou ``None`` (jeton absent/invalide/expiré,
    compte inconnu, rôle insuffisant).

    Le rôle suit exactement ``require_role("admin", "money", "trader")`` : un
    administrateur passe quel que soit son rôle nominal.
    """
    raw = str(token or "").strip()
    if not raw:
        return None
    try:
        from backend.auth.utils import decode_token
        payload = decode_token(raw)
    except Exception:             # noqa: BLE001 — jeton tordu
        return None
    if not isinstance(payload, dict):
        return None
    username = str(payload.get("sub") or "").strip()
    if not username:
        return None
    user = _lookup_user(username)
    if user is None:
        return None
    if user.get("is_admin"):
        return user
    if str(user.get("role") or "") not in ALLOWED_ROLES:
        return None
    return user


# --------------------------------------------------------------------------- #
# Le point d'entrée des producteurs
# --------------------------------------------------------------------------- #

def build_message(type_: str, symbol: Optional[str],
                  payload: Optional[Dict[str, Any]] = None,
                  now: Any = None) -> str:
    """Un message du contrat, sérialisé (PUR).

    ``default=str`` : un payload qui traînerait un ``datetime`` ou un ``Decimal``
    doit partir quand même — un push n'est pas l'endroit où l'on découvre qu'un
    champ n'est pas sérialisable.
    """
    moment = now if isinstance(now, datetime) else datetime.now(timezone.utc)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    kind = str(type_ or "")
    if kind not in MESSAGE_TYPES:
        logger.debug("[paper-ws] type de message hors contrat: %r", kind)
    body = {
        "type": kind,
        "symbol": str(symbol) if symbol else None,
        "payload": payload if isinstance(payload, dict) else {},
        "ts": moment.isoformat(),
    }
    return json.dumps(body, ensure_ascii=False, default=str)


def emit(username: Optional[str], type_: str, symbol: Optional[str],
         payload: Optional[Dict[str, Any]] = None) -> None:
    """Pousse un message aux sockets d'un utilisateur (``None`` = à tous).

    Best-effort ABSOLU : jamais d'exception, jamais d'attente. Sans boucle
    enregistrée (aucun socket n'a jamais été accepté), c'est un no-op — cf. la
    tête de fichier.
    """
    loop = _LOOP
    if loop is None:
        return None
    try:
        if loop.is_closed():
            return None
    except Exception:             # noqa: BLE001 — objet boucle exotique
        return None
    try:
        message = build_message(type_, symbol, payload)
    except Exception:             # noqa: BLE001 — payload impossible
        logger.debug("[paper-ws] message non sérialisable, push abandonné")
        return None
    target = str(username) if username else None
    try:
        asyncio.run_coroutine_threadsafe(manager.broadcast(target, message), loop)
    except Exception:             # noqa: BLE001 — boucle arrêtée entre-temps
        logger.debug("[paper-ws] boucle indisponible, push abandonné")
    return None


# --------------------------------------------------------------------------- #
# L'endpoint
# --------------------------------------------------------------------------- #

async def _close(websocket: WebSocket, code: int, reason: str) -> None:
    """Fermeture best-effort : un socket déjà parti ne doit pas lever ici."""
    try:
        await websocket.close(code=code, reason=reason)
    except Exception:             # noqa: BLE001
        pass


async def _ping_forever(websocket: WebSocket) -> None:
    """Ping applicatif toutes les ``PING_INTERVAL_S`` secondes.

    Relit la constante à CHAQUE tour : un test qui la rétrécit n'a pas à
    recréer la connexion pour que la nouvelle cadence s'applique.
    """
    while True:
        await asyncio.sleep(PING_INTERVAL_S)
        try:
            await websocket.send_text(json.dumps({"type": "ping"}))
        except Exception:         # noqa: BLE001 — socket parti
            return


@router.websocket("/ws/paper")
async def paper_ws_endpoint(websocket: WebSocket) -> None:
    """Le socket du panneau TradingView (cf. la tête de fichier pour le
    contrat complet)."""
    await websocket.accept()
    # Premier instant où l'on SAIT qu'une boucle tourne : c'est là qu'on
    # l'enregistre pour ``emit`` (cf. tête de fichier).
    # ``get_running_loop`` et non ``get_event_loop`` : on est DANS une coroutine,
    # et ``get_event_loop`` hors boucle est déprécié depuis 3.10 (la prod
    # tourne en 3.14).
    try:
        set_loop(asyncio.get_running_loop())
    except Exception:             # noqa: BLE001
        pass

    try:
        raw = await asyncio.wait_for(websocket.receive_text(),
                                     timeout=AUTH_TIMEOUT_S)
    except asyncio.TimeoutError:
        await _close(websocket, CLOSE_POLICY, "auth timeout")
        return
    except (WebSocketDisconnect, RuntimeError):
        return
    except Exception:             # noqa: BLE001 — trame binaire, socket cassé
        await _close(websocket, CLOSE_POLICY, "auth invalide")
        return

    try:
        first = json.loads(raw)
    except (TypeError, ValueError):
        first = None
    token = first.get("token") if isinstance(first, dict) else None

    user = _resolve_user(token)
    if user is None:
        await _close(websocket, CLOSE_POLICY, "jeton invalide")
        return

    username = str(user.get("username") or "")
    if manager.full(username):
        await _close(websocket, CLOSE_POLICY, "trop de sockets")
        return

    manager.register(username, websocket)
    try:
        await websocket.send_text(build_message("brief_changed", None,
                                                {"connected": True}))
    except Exception:             # noqa: BLE001 — parti aussitôt
        manager.unregister(username, websocket)
        return

    ping_task = asyncio.ensure_future(_ping_forever(websocket))
    try:
        while True:
            # Le contenu client ne sert à rien d'autre qu'à tenir la
            # connexion (``{"type":"pong"}``) : on lit, on jette. Aucune
            # commande n'entre par ce canal — le WebSocket est un canal de
            # PUSH, les actions passent par les routes HTTP authentifiées.
            await websocket.receive_text()
    except (WebSocketDisconnect, RuntimeError):
        pass
    except Exception:             # noqa: BLE001 — socket cassé
        pass
    finally:
        ping_task.cancel()
        manager.unregister(username, websocket)
