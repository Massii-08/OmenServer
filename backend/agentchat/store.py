"""Stockage fichier du module Agent Chat.

Disposition (dans ``AGENTCHAT_DIR``, surchargeable par monkeypatch) :
- ``rooms.json``      : salons, tableau (board) et membres (clé stockée en sha256 seulement)
- ``<room_id>.jsonl`` : messages, une ligne JSON par message, id croissant à partir de 1
- ``files/<room_id>/<file_id>`` (+ ``<file_id>.json``) : documents joints aux messages ;
  ``file_id`` = 16 hex aléatoires, le nom fourni par l'utilisateur ne sert JAMAIS de
  chemin (il ne vit que dans la méta)

Tous les fichiers NAISSENT en 0o600 (``os.open`` avec mode, puis ``os.fchmod``
best-effort) : jamais ``open()`` puis ``chmod()`` (fenêtre world-readable).
Les écritures passent sous un verrou unique ; ``rooms.json`` est remplacé
atomiquement (fichier temporaire + ``os.replace``).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import mimetypes
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
FILE_ID_RE = re.compile(r"^[0-9a-f]{16}$")
MAX_FILE = 25 * 1024 * 1024
MAX_ROOM_FILES = 500 * 1024 * 1024
MAX_FILE_NAME = 120
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f/\\]")
_ALL_RE = re.compile(r"(?<![\w@])@(tous|all)(?![\w])", re.IGNORECASE)
# Types absents de la table ``mimetypes`` de Python 3.9 (sinon octet-stream).
_EXTRA_MIMES = {".md": "text/markdown", ".markdown": "text/markdown",
                ".lua": "text/x-lua", ".luau": "text/x-lua"}

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


def _active_names(room: Dict[str, Any]) -> List[str]:
    return [m.get("name", "") for m in room.get("members", [])
            if not m.get("revoked") and m.get("name")]


def compute_mentions(text: str, active: List[str], author: str,
                     explicit: Any = None) -> List[str]:
    """Membres actifs mentionnés par ``@Nom`` (insensible à la casse, ordre
    d'apparition, sans doublon). Les noms les plus longs sont cherchés d'abord
    et leurs occurrences effacées, pour qu'un nom préfixe (``@Claude``) ne
    compte pas dans ``@Claude de Massii``. ``@tous``/``@all`` = tous les actifs
    sauf l'auteur. ``explicit`` (liste de noms) est fusionné, filtré sur les
    actifs. L'auteur n'est jamais mentionné (un auto-ping n'a pas de sens)."""
    author_l = (author or "").lower()
    low = (text or "").lower()
    found = []  # (position, nom)
    for name in sorted(active, key=len, reverse=True):
        pat = re.compile(r"(?<![\w@])" + re.escape("@" + name.lower()) + r"(?![\w])")
        positions = [mt.start() for mt in pat.finditer(low)]
        if not positions:
            continue
        found.append((positions[0], name))
        low = pat.sub(lambda mt: " " * len(mt.group(0)), low)
    found.sort(key=lambda x: x[0])
    out = []
    for _, name in found:
        if name.lower() != author_l and name not in out:
            out.append(name)
    if _ALL_RE.search(low):
        for name in active:
            if name.lower() != author_l and name not in out:
                out.append(name)
    if explicit is not None:
        if not isinstance(explicit, list) or not all(isinstance(x, str) for x in explicit):
            raise Invalid("Mentions invalides (liste de noms attendue)")
        by_lower = {n.lower(): n for n in active}
        for x in explicit:
            name = by_lower.get(" ".join(x.split()).lower().lstrip("@"))
            if name and name.lower() != author_l and name not in out:
                out.append(name)
    return out


def _check_message(kind: str, text: Any, reply_to: Any, attachment: Any) -> None:
    if kind not in KINDS:
        raise Invalid("Type de message invalide")
    if not isinstance(text, str):
        raise Invalid("Message vide")
    if not text.strip() and not attachment:
        raise Invalid("Message vide")
    if len(text) > MAX_TEXT:
        raise Invalid("Message trop long (4000 caractères max)")
    if reply_to is not None:
        if isinstance(reply_to, bool) or not isinstance(reply_to, int) or reply_to < 1:
            raise Invalid("Référence de réponse invalide")


def append_message(room_id: str, author: str, kind: str, text: Any,
                   reply_to: Any = None, attachment: Optional[Dict[str, Any]] = None,
                   mentions: Any = None) -> Dict[str, Any]:
    """Ajoute un message. ``attachment`` = méta d'un document (seuls id, name,
    size, mime sont recopiés) : le texte peut alors être vide. ``mentions``
    (liste de noms) complète les ``@Nom`` détectés dans le texte."""
    if text is None and attachment:
        text = ""
    _check_message(kind, text, reply_to, attachment)
    with _LOCK:
        room = _get_room(_load_rooms(), room_id)
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
            "mentions": compute_mentions(text, _active_names(room), author, mentions),
        }
        if attachment:
            msg["attachment"] = {k: attachment.get(k) for k in ("id", "name", "size", "mime")}
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


# ---------------------------------------------------------------- pings

def _pings_from(msgs: List[Dict[str, Any]], name: str) -> List[Dict[str, Any]]:
    """Pings ouverts de ``name`` : messages qui le mentionnent, écrits par
    quelqu'un d'autre, auxquels il n'a encore répondu par aucun message
    (``reply_to`` == id du ping)."""
    nl = name.lower()
    answered = set()
    for m in msgs:
        if str(m.get("author", "")).lower() == nl and isinstance(m.get("reply_to"), int):
            answered.add(m["reply_to"])
    out = []
    for m in msgs:
        ments = m.get("mentions") or []
        if not isinstance(ments, list):
            continue
        if str(m.get("author", "")).lower() == nl:
            continue
        if any(isinstance(x, str) and x.lower() == nl for x in ments) and m["id"] not in answered:
            out.append(m)
    return out


def open_pings(room_id: str, member_name: str) -> List[Dict[str, Any]]:
    _get_room(_load_rooms(), room_id)
    return _pings_from(_read_all(room_id), member_name)


def open_pings_by_member(room_id: str) -> Dict[str, List[int]]:
    """{nom de membre actif: [ids des pings ouverts]} (liste vide si aucun)."""
    room = _get_room(_load_rooms(), room_id)
    msgs = _read_all(room_id)
    return {name: [m["id"] for m in _pings_from(msgs, name)] for name in _active_names(room)}


# ---------------------------------------------------------------- documents

def _files_dir(room_id: str) -> Path:
    validate_room_id(room_id)
    return _dir() / "files" / room_id


def _mkdir_700(p: Path) -> None:
    p.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(str(p), 0o700)
    except OSError:
        pass


def clean_file_name(name: Any) -> str:
    if not isinstance(name, str):
        name = ""
    name = os.path.basename(name.replace("\\", "/"))
    name = _CTRL_RE.sub("", name).strip()
    if name in (".", ".."):
        name = ""
    name = name[:MAX_FILE_NAME].strip()
    return name or "document"


def validate_file_id(file_id: Any) -> str:
    if not isinstance(file_id, str) or not FILE_ID_RE.match(file_id):
        raise Invalid("Identifiant de document invalide")
    return file_id


def _load_meta(p: Path) -> Optional[Dict[str, Any]]:
    try:
        with open(str(p), "r", encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(d, dict) or not isinstance(d.get("id"), str) or not FILE_ID_RE.match(d["id"]):
        return None
    return d


def _list_metas(room_id: str) -> List[Dict[str, Any]]:
    d = _files_dir(room_id)
    if not d.is_dir():
        return []
    out = []
    for p in d.glob("*.json"):
        meta = _load_meta(p)
        if meta is not None and (d / meta["id"]).is_file():
            out.append(meta)
    out.sort(key=lambda m: (str(m.get("ts", "")), int(m.get("seq", 0) or 0)))
    return out


def _guess_mime(name: str) -> str:
    mime = mimetypes.guess_type(name)[0]
    if mime:
        return mime
    return _EXTRA_MIMES.get(os.path.splitext(name)[1].lower(), "application/octet-stream")


def save_file(room_id: str, name: Any, data: Any, uploaded_by: str) -> Dict[str, Any]:
    """Enregistre un document (contenu 0o600 + méta 0o600). Refuse un fichier
    vide, plus gros que ``MAX_FILE`` ou qui ferait dépasser le quota du salon."""
    if not isinstance(data, (bytes, bytearray)):
        raise Invalid("Contenu de document invalide")
    if not data:
        raise Invalid("Document vide")
    if len(data) > MAX_FILE:
        raise Invalid("Document trop gros (%d Mo max)" % (MAX_FILE // (1024 * 1024)))
    name = clean_file_name(name)
    with _LOCK:
        _get_room(_load_rooms(), room_id)
        metas = _list_metas(room_id)
        used = sum(int(m.get("size", 0) or 0) for m in metas)
        if used + len(data) > MAX_ROOM_FILES:
            raise Invalid("Quota du salon atteint (500 Mo)")
        _ensure_dir()
        _mkdir_700(_dir() / "files")
        d = _files_dir(room_id)
        _mkdir_700(d)
        while True:
            file_id = secrets.token_hex(8)
            if not (d / file_id).exists():
                break
        fd = os.open(str(d / file_id), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.fchmod(fd, 0o600)
        except (AttributeError, OSError):
            pass
        with os.fdopen(fd, "wb") as f:
            f.write(bytes(data))
        meta = {
            "id": file_id,
            "name": name,
            "size": len(data),
            "mime": _guess_mime(name),
            "sha256": hashlib.sha256(bytes(data)).hexdigest(),
            "uploaded_by": uploaded_by,
            "ts": _now(),
            "seq": len(metas) + 1,
        }
        _write_atomic(d / (file_id + ".json"), json.dumps(meta, ensure_ascii=False))
        return public_file(meta)


def public_file(meta: Dict[str, Any]) -> Dict[str, Any]:
    return {k: meta.get(k) for k in ("id", "name", "size", "mime", "sha256", "uploaded_by", "ts")}


def _delete_file(room_id: str, file_id: str) -> None:
    d = _files_dir(room_id)
    for p in (d / file_id, d / (file_id + ".json")):
        try:
            os.remove(str(p))
        except OSError:
            pass


def get_file(room_id: str, file_id: Any) -> Tuple[Dict[str, Any], Path]:
    validate_file_id(file_id)
    _get_room(_load_rooms(), room_id)
    d = _files_dir(room_id)
    meta = _load_meta(d / (file_id + ".json"))
    path = d / file_id
    if meta is None or meta.get("id") != file_id or not path.is_file():
        raise NotFound("Document introuvable")
    return public_file(meta), path


def list_files(room_id: str) -> List[Dict[str, Any]]:
    _get_room(_load_rooms(), room_id)
    return [public_file(m) for m in _list_metas(room_id)]


def send_document(room_id: str, author: str, kind: str, name: Any, data: Any,
                  text: Any = "", reply_to: Any = None,
                  mentions: Any = None) -> Dict[str, Any]:
    """Enregistre un document puis le message qui le porte. Le message est
    validé AVANT l'écriture du fichier ; si son ajout échoue malgré tout, le
    fichier est supprimé (pas de document orphelin)."""
    if text is None:
        text = ""
    _check_message(kind, text, reply_to, True)
    meta = save_file(room_id, name, data, author)
    try:
        return append_message(room_id, author, kind, text, reply_to,
                              attachment=meta, mentions=mentions)
    except Exception:
        _delete_file(room_id, meta["id"])
        raise
