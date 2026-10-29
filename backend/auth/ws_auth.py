"""Authentification des WebSocket du site par PREMIER MESSAGE.

Pourquoi : un JWT passé en ``?token=...`` finit dans les journaux d'accès
(Cloudflare, uvicorn). Le navigateur ne permet pas de poser un en-tête
``Authorization`` sur un WebSocket, donc le jeton voyage dans le premier
message applicatif, une fois la connexion ouverte (même modèle que
``backend/bots/paper_ws.py``).

Contrat :

* le serveur ACCEPTE la connexion, puis attend un premier message JSON
  ``{"type": "auth", "token": "<jwt>"}`` pendant ``WS_AUTH_TIMEOUT_S`` secondes ;
* jeton absent, invalide, expiré, compte inconnu, message illisible ou délai
  dépassé → ``close(1008)`` et ``None`` ;
* **compatibilité** : si ``token`` est encore dans la query string (onglets
  ouverts avec l'ancien JS, clients externes), il est accepté tel quel et un
  WARNING « déprécié » est journalisé — sans jamais écrire le jeton.

Le helper ne décide pas des DROITS (rôle, accès à un serveur, job en attente) :
c'est le travail de ``resolve``, fourni par chaque endpoint.
"""
import asyncio
import json
import logging
from typing import Any, Callable, Optional

from fastapi import WebSocket

logger = logging.getLogger("omenserver")

WS_AUTH_TIMEOUT_S = 10.0     # surchargeable en test
CLOSE_POLICY = 1008          # « policy violation »


def user_from_token(token: Any) -> Optional[Any]:
    """JWT -> ``User`` (même validation que ``get_current_user`` : signature,
    expiration, ``sub`` présent, compte existant), ou ``None``. Ne lève jamais."""
    raw = str(token or "").strip()
    if not raw:
        return None
    try:
        from backend.auth.utils import decode_token
        from backend.auth.models import User
        from backend.database import SessionLocal
        payload = decode_token(raw)
        if not isinstance(payload, dict):
            return None
        username = payload.get("sub")
        if not username:
            return None
        db = SessionLocal()
        try:
            return db.query(User).filter(User.username == username).first()
        finally:
            db.close()
    except Exception:            # noqa: BLE001 — refus sûr
        return None


async def _close(websocket: WebSocket, code: int, reason: str) -> None:
    try:
        await websocket.close(code=code, reason=reason)
    except Exception:            # noqa: BLE001 — socket déjà parti
        pass


def _token_from_message(message: Any) -> Optional[str]:
    """Extrait le jeton d'une trame ASGI ``websocket.receive``."""
    if not isinstance(message, dict):
        return None
    text = message.get("text")
    if text is None and message.get("bytes") is not None:
        try:
            text = message["bytes"].decode("utf-8")
        except Exception:        # noqa: BLE001
            return None
    if not isinstance(text, str):
        return None
    try:
        data = json.loads(text)
    except (TypeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    if data.get("type", "auth") != "auth":
        return None
    token = data.get("token")
    return token if isinstance(token, str) and token else None


async def ws_authenticate(
    websocket: WebSocket,
    resolve: Optional[Callable[[str], Any]] = None,
    *,
    label: str = "ws",
    timeout: Optional[float] = None,
) -> Optional[Any]:
    """Accepte la connexion et authentifie le client.

    ``resolve(token)`` renvoie l'objet autorisé (utilisateur, nom…) ou un
    falsy pour refuser ; par défaut ``user_from_token``. Retourne cet objet, ou
    ``None`` après avoir fermé la connexion en 1008.
    """
    if resolve is None:
        resolve = user_from_token
    await websocket.accept()

    token = websocket.query_params.get("token")
    if token:
        # Ne JAMAIS journaliser le jeton lui-même.
        logger.warning("[%s] token en query, déprécié (passer à l'auth par "
                       "premier message)", label)
    else:
        wait = WS_AUTH_TIMEOUT_S if timeout is None else timeout
        try:
            message = await asyncio.wait_for(websocket.receive(), timeout=wait)
        except asyncio.TimeoutError:
            await _close(websocket, CLOSE_POLICY, "auth timeout")
            return None
        except Exception:        # noqa: BLE001 — socket cassé
            await _close(websocket, CLOSE_POLICY, "auth invalide")
            return None
        if message.get("type") == "websocket.disconnect":
            return None
        token = _token_from_message(message)

    if not token:
        await _close(websocket, CLOSE_POLICY, "auth requise")
        return None
    try:
        who = resolve(token)
    except Exception:            # noqa: BLE001 — refus sûr
        who = None
    if not who:
        await _close(websocket, CLOSE_POLICY, "jeton invalide")
        return None
    return who
