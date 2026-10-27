"""Stockage fichier du module Agent Chat.

Disposition (dans ``AGENTCHAT_DIR``, surchargeable par monkeypatch) :
- ``rooms.json``      : salons, tableau (board) et membres (clé stockée en sha256 seulement)
- ``<room_id>.jsonl`` : messages, une ligne JSON par message, id croissant à partir de 1

Tous les fichiers NAISSENT en 0o600 (``os.open`` avec mode, puis ``os.fchmod``
best-effort) : jamais ``open()`` puis ``chmod()`` (fenêtre world-readable).
Les écritures passent sous un verrou unique ; ``rooms.json`` est remplacé
atomiquement (fichier temporaire + ``os.replace``).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# backend/agentchat/store.py -> racine du dépôt -> data/agentchat
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
AGENTCHAT_DIR = _PROJECT_ROOT / "data" / "agentchat"

ROOM_ID_RE = re.compile(r"^[a-z0-9-]{1,40}$")
MAX_TEXT = 4000
MAX_BOARD = 8000
MAX_NAME = 60
KEY_PREFIX = "oac_"
KINDS = ("info", "en_cours", "fait", "demande", "reponse", "humain")

_LOCK = threading.Lock()


class StoreError(Exception):
    """Erreur métier du store (message sans emoji, destiné à l'API)."""


class Invalid(StoreError):
    pass


class NotFound(StoreError):
    pass


class Conflict(StoreError):
    pass


# ---------------------------------------------------------------- helpers

def _dir() -> Path:
    return Path(AGENTCHAT_DIR)


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def hash_key(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def validate_room_id(room_id: Any) -> str:
    if not isinstance(room_id, str) or not ROOM_ID_RE.match(room_id):
        raise Invalid("Identifiant de salon invalide (a-z, 0-9, tiret, 40 caractères max)")
    return room_id


def _clean_name(name: Any) -> str:
    if not isinstance(name, str):
        raise Invalid("Nom invalide")
    name = " ".join(name.split())
    if not name or len(name) > MAX_NAME:
        raise Invalid("Nom vide ou trop long (60 caractères max)")
    return name


def _ensure_dir() -> Path:
    d = _dir()
    d.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(str(d), 0o700)
    except OSError:
        pass
    return d


def _write_atomic(path: Path, data: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)
    except (AttributeError, OSError):
        pass
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(data)
        f.flush()
        try:
            os.fsync(f.fileno())
        except OSError:
            pass
    os.replace(str(tmp), str(path))


def _append_line(path: Path, line: str) -> None:
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.fchmod(fd, 0o600)
    except (AttributeError, OSError):
        pass
    with os.fdopen(fd, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def _load_rooms() -> Dict[str, Any]:
    p = _dir() / "rooms.json"
    if not p.is_file():
        return {}
    try:
        with open(str(p), "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_rooms(rooms: Dict[str, Any]) -> None:
    _ensure_dir()
    _write_atomic(_dir() / "rooms.json", json.dumps(rooms, ensure_ascii=False, indent=2))


def _get_room(rooms: Dict[str, Any], room_id: str) -> Dict[str, Any]:
    validate_room_id(room_id)
    room = rooms.get(room_id)
    if room is None:
        raise NotFound("Salon introuvable")
    return room


def public_member(m: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": m.get("id"),
        "name": m.get("name"),
        "created_at": m.get("created_at"),
        "revoked": bool(m.get("revoked")),
    }


def public_room(room_id: str, room: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "room_id": room_id,
        "name": room.get("name", room_id),
        "created_at": room.get("created_at"),
        "members": [public_member(m) for m in room.get("members", [])],
    }


# ---------------------------------------------------------------- salons

def list_rooms() -> List[Dict[str, Any]]:
    rooms = _load_rooms()
    return [public_room(rid, r) for rid, r in sorted(rooms.items())]


def get_room(room_id: str) -> Dict[str, Any]:
    return public_room(room_id, _get_room(_load_rooms(), room_id))


def create_room(room_id: str, name: str) -> Dict[str, Any]:
    validate_room_id(room_id)
    name = _clean_name(name)
    with _LOCK:
        rooms = _load_rooms()
        if room_id in rooms:
            raise Conflict("Ce salon existe déjà")
        rooms[room_id] = {"name": name, "created_at": _now(), "board": "", "members": []}
        _save_rooms(rooms)
        return public_room(room_id, rooms[room_id])


# ---------------------------------------------------------------- membres

def add_member(room_id: str, name: str) -> Tuple[Dict[str, Any], str]:
    """Crée un membre. Renvoie (membre public, clé en clair) — la clé n'est
    jamais stockée en clair, seulement son sha256."""
    name = _clean_name(name)
    with _LOCK:
        rooms = _load_rooms()
        room = _get_room(rooms, room_id)
        members = room.setdefault("members", [])
        for m in members:
            if not m.get("revoked") and m.get("name", "").lower() == name.lower():
                raise Conflict("Un membre actif porte déjà ce nom")
        key = KEY_PREFIX + secrets.token_urlsafe(32)
        member = {
            "id": secrets.token_hex(4),
            "name": name,
            "key_hash": hash_key(key),
            "created_at": _now(),
            "revoked": False,
        }
        members.append(member)
        _save_rooms(rooms)
        return public_member(member), key


def revoke_member(room_id: str, member_id: str) -> Dict[str, Any]:
    with _LOCK:
        rooms = _load_rooms()
        room = _get_room(rooms, room_id)
        for m in room.get("members", []):
            if m.get("id") == member_id:
                m["revoked"] = True
                _save_rooms(rooms)
                return public_member(m)
        raise NotFound("Membre introuvable")


def find_by_key(key: Any) -> Optional[Tuple[str, Dict[str, Any], Dict[str, Any]]]:
    """Retrouve (room_id, room, membre) pour une clé valide et non révoquée."""
    if not isinstance(key, str) or not key.startswith(KEY_PREFIX) or len(key) > 200:
        return None
    h = hash_key(key)
    found = None
    for rid, room in _load_rooms().items():
        for m in room.get("members", []):
            # compare_digest sur tous les membres : pas de court-circuit temporel
            if hmac.compare_digest(str(m.get("key_hash", "")), h) and not m.get("revoked"):
                found = (rid, room, m)
    return found


# ---------------------------------------------------------------- tableau

def get_board(room_id: str) -> str:
    return _get_room(_load_rooms(), room_id).get("board", "") or ""


def set_board(room_id: str, board: Any) -> str:
    if not isinstance(board, str):
        raise Invalid("Tableau invalide")
    if len(board) > MAX_BOARD:
        raise Invalid("Tableau trop long (8000 caractères max)")
    with _LOCK:
        rooms = _load_rooms()
        room = _get_room(rooms, room_id)
        room["board"] = board
        _save_rooms(rooms)
    return board


# ---------------------------------------------------------------- messages

def _messages_path(room_id: str) -> Path:
    validate_room_id(room_id)
    return _dir() / (room_id + ".jsonl")


def _read_all(room_id: str) -> List[Dict[str, Any]]:
    p = _messages_path(room_id)
    if not p.is_file():
        return []
    out = []
    with open(str(p), "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if isinstance(msg, dict) and isinstance(msg.get("id"), int):
                out.append(msg)
    return out


def append_message(room_id: str, author: str, kind: str, text: Any,
                   reply_to: Any = None) -> Dict[str, Any]:
    if kind not in KINDS:
        raise Invalid("Type de message invalide")
    if not isinstance(text, str) or not text.strip():
        raise Invalid("Message vide")
    if len(text) > MAX_TEXT:
        raise Invalid("Message trop long (4000 caractères max)")
    if reply_to is not None:
        if isinstance(reply_to, bool) or not isinstance(reply_to, int) or reply_to < 1:
            raise Invalid("Référence de réponse invalide")
    with _LOCK:
        _get_room(_load_rooms(), room_id)
        msgs = _read_all(room_id)
        next_id = (msgs[-1]["id"] + 1) if msgs else 1
        if reply_to is not None and reply_to >= next_id:
            raise Invalid("Le message cité n'existe pas")
        msg = {
            "id": next_id,
            "ts": _now(),
            "author": author,
            "kind": kind,
            "text": text,
            "reply_to": reply_to,
        }
        _ensure_dir()
        _append_line(_messages_path(room_id), json.dumps(msg, ensure_ascii=False))
        return msg


def read_messages(room_id: str, after: int = 0, limit: int = 50,
                  tail: bool = False) -> List[Dict[str, Any]]:
    """Messages d'id > ``after`` (les ``limit`` premiers), ou les ``limit``
    derniers si ``tail`` est vrai."""
    _get_room(_load_rooms(), room_id)
    limit = max(1, int(limit))
    msgs = _read_all(room_id)
    if tail:
        return msgs[-limit:]
    return [m for m in msgs if m["id"] > after][:limit]


def last_id(room_id: str) -> int:
    msgs = _read_all(room_id)
    return msgs[-1]["id"] if msgs else 0
