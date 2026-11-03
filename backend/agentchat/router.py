"""Agent Chat — API humaine (REST, admin) + serveur MCP (Streamable HTTP, réponse JSON).

- ``/api/agentchat/...`` : gestion des salons/membres/messages/tableau depuis le site
  (JWT du site, administrateur uniquement).
- ``POST /mcp/agentchat`` : serveur MCP pour les instances de Claude Code. Auth
  par ``Authorization: Bearer oac_...``. Deux sortes de clés :
  * clé de salon (historique) : désigne à la fois le salon et l'auteur ;
  * clé personnelle (un Claude par compte du site) : vaut dans tous les salons où
    sa personne est cochée ; chaque outil prend alors ``salon`` (implicite s'il n'en
    a qu'un). L'auteur reste toujours déterminé par la clé, jamais par un champ client.
- ``/mcp/agentchat/fichiers`` et ``/mcp/agentchat/pings`` : petites routes REST pour
  les agents (même clé Bearer) — gros documents binaires via ``curl`` et lecture
  des pings par le hook ``Stop`` de Claude Code (``tools/agentchat_ping_hook.py``).

Documents : toujours servis en ``attachment`` + ``nosniff`` (jamais inline : un
HTML déposé ne s'exécute pas dans l'origine du site).
"""
from __future__ import annotations

import base64
import binascii
import contextvars
import json
import logging
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.agentchat import presence, store
from backend.auth.models import User
from backend.auth.utils import get_current_user
from backend.database import get_db

logger = logging.getLogger("omenserver")

router = APIRouter(prefix="/api/agentchat", tags=["Agent Chat"])
mcp_router = APIRouter(tags=["Agent Chat MCP"])


# ================================================================ REST humaine

def _require_admin(user: User) -> None:
    """Gestion des salons et des clés : administrateur uniquement."""
    if not getattr(user, "is_admin", False):
        raise HTTPException(status_code=403, detail="Accès réservé aux administrateurs")


CHAT_ROLES = ("developer",)


def _require_chat(user: User) -> None:
    """Lecture/écriture des messages et du tableau : admin ou rôle developer."""
    if getattr(user, "is_admin", False):
        return
    if getattr(user, "role", None) in CHAT_ROLES:
        return
    raise HTTPException(status_code=403, detail="Accès réservé aux administrateurs et développeurs")


def _require_room(user: User, room_id: str) -> Dict[str, Any]:
    """Accès humain à UN salon : admin = tous ; sinon rôle developer ET compte
    listé dans ``room.users``. Un salon non autorisé répond 404, exactement comme
    un salon inexistant (on ne révèle pas son existence). Renvoie le salon public."""
    _require_chat(user)
    try:
        room = store.get_room(room_id)
    except store.StoreError as e:
        raise _http(e)
    if getattr(user, "is_admin", False):
        return room
    if getattr(user, "username", None) not in room.get("users", []):
        raise HTTPException(status_code=404, detail="Salon introuvable")
    return room


def _can_see(user: User, room: Dict[str, Any]) -> bool:
    if getattr(user, "is_admin", False):
        return True
    return getattr(user, "username", None) in room.get("users", [])


def _check_users(db: Session, users: Any) -> List[str]:
    """Nettoie la liste et vérifie que chaque compte existe (400 sinon)."""
    try:
        users = store.clean_users(users)
    except store.StoreError as e:
        raise _http(e)
    if not users:
        return users
    found = set(u for (u,) in db.query(User.username).filter(User.username.in_(users)).all())
    unknown = [u for u in users if u not in found]
    if unknown:
        raise HTTPException(status_code=400, detail="Compte inconnu : %s" % ", ".join(unknown))
    return users


def _http(e: store.StoreError) -> HTTPException:
    if isinstance(e, store.NotFound):
        return HTTPException(status_code=404, detail=str(e))
    if isinstance(e, store.Conflict):
        return HTTPException(status_code=409, detail=str(e))
    return HTTPException(status_code=400, detail=str(e))


class RoomIn(BaseModel):
    room_id: str
    name: str
    users: Optional[List[str]] = None
    claudes: Optional[List[str]] = None


class UsersIn(BaseModel):
    users: List[str]


class MemberIn(BaseModel):
    name: str


class MessageIn(BaseModel):
    text: str
    reply_to: Optional[int] = None
    mentions: Optional[List[str]] = None


class BoardIn(BaseModel):
    board: str


@router.get("/rooms")
def list_rooms(current_user: User = Depends(get_current_user)):
    _require_chat(current_user)
    return {"rooms": [r for r in store.list_rooms() if _can_see(current_user, r)]}


@router.get("/candidates")
def list_candidates(current_user: User = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    """Comptes qu'on peut inviter dans un salon : rôle developer (l'admin a déjà
    accès à tout, inutile de le proposer)."""
    _require_admin(current_user)
    rows = (db.query(User).filter(User.role.in_(CHAT_ROLES))
            .order_by(User.username).all())
    return {"candidates": [{"username": u.username, "role": u.role}
                           for u in rows if not u.is_admin]}


@router.post("/rooms")
def create_room(body: RoomIn, current_user: User = Depends(get_current_user),
                db: Session = Depends(get_db)):
    _require_admin(current_user)
    users = _check_users(db, body.users)
    # Noms des Claude validés AVANT de créer quoi que ce soit (pas de salon à moitié fait).
    claudes = []  # type: List[str]
    taken = [n.lower() for n in store.personal_names_for(users + [current_user.username])]
    try:
        for n in body.claudes or []:
            n = store.clean_member_name(n)
            if n.lower() in [c.lower() for c in claudes]:
                raise store.Invalid("Deux Claude portent le même nom : %s" % n)
            if n.lower() in taken:
                raise store.Invalid("%s est déjà le Claude personnel d'une personne cochée : "
                                    "il sera ajouté automatiquement" % n)
            claudes.append(n)
        room = store.create_room(body.room_id, body.name, users,
                                 created_by=current_user.username)
        keys = []
        for n in claudes:
            member, key = store.add_member(body.room_id, n)
            keys.append({"member": member["name"], "key": key})
        if claudes:
            room = store.get_room(body.room_id)
    except store.StoreError as e:
        raise _http(e)
    logger.info("Agent Chat: salon %s créé par %s (%d personne(s), %d Claude)",
                body.room_id, current_user.username, len(users), len(claudes))
    return {"room": room, "keys": keys}


@router.put("/rooms/{room_id}/users")
def put_users(room_id: str, body: UsersIn, current_user: User = Depends(get_current_user),
              db: Session = Depends(get_db)):
    _require_admin(current_user)
    try:
        store.get_room(room_id)
    except store.StoreError as e:
        raise _http(e)
    users = _check_users(db, body.users)
    try:
        room = store.set_users(room_id, users)
    except store.StoreError as e:
        raise _http(e)
    logger.info("Agent Chat: personnes du salon %s mises à jour par %s : %s",
                room_id, current_user.username, ", ".join(users) or "(aucune)")
    return {"room": room}


@router.post("/rooms/{room_id}/members")
def add_member(room_id: str, body: MemberIn, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    try:
        member, key = store.add_member(room_id, body.name)
    except store.StoreError as e:
        raise _http(e)
    logger.info("Agent Chat: membre %s ajouté au salon %s", member["name"], room_id)
    return {"member": member, "key": key}


@router.post("/rooms/{room_id}/members/{member_id}/revoke")
def revoke_member(room_id: str, member_id: str, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    try:
        member = store.revoke_member(room_id, member_id)
    except store.StoreError as e:
        raise _http(e)
    logger.info("Agent Chat: membre %s révoqué (salon %s)", member["name"], room_id)
    return {"member": member}


@router.delete("/rooms/{room_id}/members/{member_id}")
def delete_member(room_id: str, member_id: str, current_user: User = Depends(get_current_user)):
    """Retire définitivement un membre déjà révoqué (409 s'il est actif)."""
    _require_admin(current_user)
    try:
        store.delete_member(room_id, member_id)
    except store.StoreError as e:
        raise _http(e)
    logger.info("Agent Chat: membre révoqué %s retiré du salon %s", member_id, room_id)
    return {"ok": True}


# ---------------------------------------------------------------- Claude personnels

PERSONAL_ROLES = ("developer", "admin")


class ClaudeIn(BaseModel):
    name: str


def _mcp_base(request: Request) -> str:
    """URL du serveur MCP d'après la requête. Derrière le tunnel, uvicorn peut voir
    ``http://omenserver.org`` : on repasse en https sauf pour localhost."""
    base = str(request.base_url).rstrip("/")
    host = (request.url.hostname or "").lower()
    if base.startswith("http://") and host not in ("localhost", "127.0.0.1", "::1", "testserver"):
        base = "https://" + base[len("http://"):]
    return base + "/mcp/agentchat"


def _mcp_command(request: Request, key: str) -> str:
    return ('claude mcp add --transport http -s user agentchat %s --header "Authorization: Bearer %s"'
            % (_mcp_base(request), key))


def _personal_account(db: Session, username: str) -> User:
    u = db.query(User).filter(User.username == username).first()
    if u is None:
        raise HTTPException(status_code=400, detail="Compte inconnu : %s" % username)
    if not (u.is_admin or u.role in PERSONAL_ROLES):
        raise HTTPException(status_code=400,
                            detail="Ce compte n'a pas accès à la Discussion (rôle developer requis)")
    return u


@router.get("/claudes")
def list_claudes(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Comptes developer + admin, avec leur Claude personnel (jamais de hash)."""
    _require_admin(current_user)
    rows = db.query(User).order_by(User.username).all()
    personal = {c["username"]: c for c in store.list_personal()}
    out = []
    for u in rows:
        if not (u.is_admin or u.role in CHAT_ROLES):
            continue
        out.append({"username": u.username, "role": u.role, "is_admin": bool(u.is_admin),
                    "claude": personal.get(u.username)})
    return {"accounts": out}


@router.post("/claudes/{username}")
def create_claude(username: str, body: ClaudeIn, request: Request,
                  current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Crée ou régénère la clé personnelle (l'ancienne cesse de marcher). Clé montrée une fois."""
    _require_admin(current_user)
    _personal_account(db, username)
    try:
        claude, key = store.create_or_rotate_personal(username, body.name)
    except store.StoreError as e:
        raise _http(e)
    claude = next((c for c in store.list_personal() if c["username"] == username), claude)
    logger.info("Agent Chat: clé personnelle de %s (%s) générée par %s",
                username, claude["name"], current_user.username)
    return {"claude": claude, "key": key, "mcp_command": _mcp_command(request, key)}


@router.post("/claudes/{username}/rename")
def rename_claude(username: str, body: ClaudeIn, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    try:
        claude = store.rename_personal(username, body.name)
    except store.StoreError as e:
        raise _http(e)
    return {"claude": claude}


@router.post("/claudes/{username}/revoke")
def revoke_claude(username: str, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    try:
        claude = store.revoke_personal(username)
    except store.StoreError as e:
        raise _http(e)
    logger.info("Agent Chat: Claude personnel de %s révoqué par %s", username, current_user.username)
    return {"claude": claude}


@router.get("/rooms/{room_id}/messages")
def get_messages(room_id: str, after: int = 0, limit: int = 100,
                 current_user: User = Depends(get_current_user)):
    _require_room(current_user, room_id)
    limit = max(1, min(int(limit), 200))
    try:
        if after <= 0:
            msgs = store.read_messages(room_id, limit=limit, tail=True)
        else:
            msgs = store.read_messages(room_id, after=after, limit=limit)
    except store.StoreError as e:
        raise _http(e)
    return {"messages": msgs}


@router.get("/rooms/{room_id}/presence")
def get_presence(room_id: str, current_user: User = Depends(get_current_user)):
    room = _require_room(current_user, room_id)
    return {"members": presence.room_view(room, room_id)}


@router.post("/rooms/{room_id}/messages")
def post_message(room_id: str, body: MessageIn, current_user: User = Depends(get_current_user)):
    _require_room(current_user, room_id)
    try:
        msg = store.append_message(room_id, "%s (humain)" % current_user.username,
                                   "humain", body.text, body.reply_to,
                                   mentions=body.mentions)
    except store.StoreError as e:
        raise _http(e)
    return {"message": msg}


# ---------------------------------------------------------------- documents

async def _read_upload(request: Request) -> Tuple[str, bytes, str, Optional[int]]:
    """Lit un formulaire multipart ``file`` (+ ``text``, ``reply_to`` optionnels).
    Ne lit jamais plus de ``MAX_FILE + 1`` octets du fichier (413 au-delà)."""
    too_big = HTTPException(status_code=413, detail="Document trop gros (%d Mo max)"
                            % max(1, store.MAX_FILE // (1024 * 1024)))
    try:
        # Refus avant parsing : Starlette écrirait tout le corps sur disque d'abord.
        if int(request.headers.get("content-length") or 0) > store.MAX_FILE + 1024 * 1024:
            raise too_big
    except ValueError:
        pass
    try:
        form = await request.form()
    except Exception:
        raise HTTPException(status_code=400, detail="Formulaire multipart invalide")
    up = form.get("file")
    if up is None or isinstance(up, str) or not hasattr(up, "read"):
        raise HTTPException(status_code=400, detail="Champ file manquant")
    data = await up.read(store.MAX_FILE + 1)
    if len(data) > store.MAX_FILE:
        raise HTTPException(status_code=413, detail="Document trop gros (%d Mo max)"
                            % max(1, store.MAX_FILE // (1024 * 1024)))
    text = form.get("text")
    if text is None:
        text = ""
    if not isinstance(text, str):
        raise HTTPException(status_code=400, detail="Champ text invalide")
    reply_raw = form.get("reply_to")
    reply_to = None  # type: Optional[int]
    if reply_raw is not None:
        if not isinstance(reply_raw, str):
            raise HTTPException(status_code=400, detail="Champ reply_to invalide")
        if reply_raw.strip():
            try:
                reply_to = int(reply_raw.strip())
            except ValueError:
                raise HTTPException(status_code=400, detail="Champ reply_to invalide")
    return getattr(up, "filename", None) or "", data, text, reply_to


def _file_response(meta: Dict[str, Any], path: Any) -> FileResponse:
    """Toujours en pièce jointe + nosniff : jamais d'affichage inline (XSS)."""
    disp = "attachment; filename*=UTF-8''" + quote(meta.get("name") or "document", safe="")
    return FileResponse(
        str(path),
        media_type=meta.get("mime") or "application/octet-stream",
        headers={"Content-Disposition": disp, "X-Content-Type-Options": "nosniff"},
    )


@router.post("/rooms/{room_id}/files")
async def upload_file(room_id: str, request: Request, current_user: User = Depends(get_current_user)):
    _require_room(current_user, room_id)
    name, data, text, reply_to = await _read_upload(request)
    try:
        msg = store.send_document(room_id, "%s (humain)" % current_user.username, "humain",
                                  name, data, text, reply_to)
    except store.StoreError as e:
        raise _http(e)
    logger.info("Agent Chat: document %s déposé par %s (salon %s)",
                msg["attachment"]["id"], current_user.username, room_id)
    return {"message": msg}


@router.get("/rooms/{room_id}/files/{file_id}")
def download_file(room_id: str, file_id: str, current_user: User = Depends(get_current_user)):
    _require_room(current_user, room_id)
    try:
        meta, path = store.get_file(room_id, file_id)
    except store.StoreError as e:
        raise _http(e)
    return _file_response(meta, path)


@router.get("/rooms/{room_id}/pings")
def room_pings(room_id: str, current_user: User = Depends(get_current_user)):
    _require_room(current_user, room_id)
    try:
        return {"pings": store.open_pings_by_member(room_id)}
    except store.StoreError as e:
        raise _http(e)


@router.get("/rooms/{room_id}/board")
def get_board(room_id: str, current_user: User = Depends(get_current_user)):
    _require_room(current_user, room_id)
    try:
        return {"board": store.get_board(room_id)}
    except store.StoreError as e:
        raise _http(e)


@router.put("/rooms/{room_id}/board")
def put_board(room_id: str, body: BoardIn, current_user: User = Depends(get_current_user)):
    _require_room(current_user, room_id)
    try:
        board = store.set_board(room_id, body.board)
    except store.StoreError as e:
        raise _http(e)
    return {"board": board}


# ================================================================ MCP

SUPPORTED_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
DEFAULT_VERSION = "2025-06-18"
SERVER_INFO = {"name": "omenserver-agentchat", "version": "1.2.0"}
INLINE_DOC_MAX = 4 * 1024 * 1024
IMAGE_INLINE_MAX = 5 * 1024 * 1024
IMAGE_MIMES = ("image/png", "image/jpeg", "image/gif", "image/webp")
TEXT_WINDOW_DEFAULT = 50000
TEXT_WINDOW_MAX = 200000
BYTES_WINDOW_DEFAULT = 48000
BYTES_WINDOW_MAX = 150000

# Origine de la requête MCP en cours (citée dans les commandes curl).
_ORIGIN = contextvars.ContextVar("agentchat_origin", default="<origine du serveur>")
# « ?salon=<id> » à ajouter aux URL curl quand la clé est personnelle (sinon vide).
_SALON_Q = contextvars.ContextVar("agentchat_salon_q", default="")
_KEY_HINT = "<clé dans ~/.claude.json → mcpServers.agentchat.headers.Authorization>"
SENDABLE_KINDS = ["info", "en_cours", "fait", "demande", "reponse"]

TOOLS = [
    {
        "name": "lire_messages",
        "description": (
            "Lit les messages du salon. Sans depuis_id : les derniers messages. "
            "Avec depuis_id : seulement les messages plus récents que cet id."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "depuis_id": {"type": "integer", "minimum": 0, "default": 0,
                              "description": "Renvoie les messages d'id strictement supérieur (0 = les derniers)."},
                "limite": {"type": "integer", "minimum": 1, "maximum": 100, "default": 30,
                           "description": "Nombre maximum de messages (100 max)."},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "envoyer_message",
        "description": (
            "Envoie un message au salon. type : info, en_cours (ce que tu commences), "
            "fait (ce que tu as fini), demande (avant de toucher la zone d'un autre), "
            "reponse (réponse à une demande, avec reponse_a). Mentionne un membre avec "
            "@Nom (ou @tous) pour lui envoyer un ping."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "texte": {"type": "string", "maxLength": store.MAX_TEXT, "description": "Contenu du message."},
                "type": {"type": "string", "enum": SENDABLE_KINDS, "default": "info"},
                "reponse_a": {"type": "integer", "minimum": 1,
                              "description": "Id du message auquel tu réponds."},
            },
            "required": ["texte"],
            "additionalProperties": False,
        },
    },
    {
        "name": "lire_tableau",
        "description": "Lit le tableau du salon (répartition des zones, règles) et la liste des membres actifs.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "modifier_tableau",
        "description": "Remplace tout le tableau du salon. Un message info est posté automatiquement.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "texte": {"type": "string", "maxLength": store.MAX_BOARD,
                          "description": "Nouveau contenu complet du tableau."},
            },
            "required": ["texte"],
            "additionalProperties": False,
        },
    },
    {
        "name": "mes_pings",
        "description": (
            "Liste les pings qui te sont adressés (messages qui te mentionnent avec @Nom ou "
            "@tous) et auxquels tu n'as pas encore répondu avec reponse_a."
        ),
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "presence",
        "description": (
            "Liste les membres actifs du salon : travaille, en ligne inactif ou hors ligne "
            "(vu il y a N min), avec leur % de limite 5 h si connu. Un membre hors ligne "
            "ne répondra pas : ne l'attends pas, décide toi-même et annonce-le avec fait."
        ),
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "envoyer_document",
        "description": (
            "Envoie un document au salon, attaché à un message. contenu = texte brut, ou "
            "base64 si base64=true. 4 Mo max ici ; au-delà (ex. modèles .fbx/.blend), "
            "utiliser curl sur /mcp/agentchat/fichiers."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "nom": {"type": "string", "description": "Nom du fichier (ex. notes.md, pet.png)."},
                "contenu": {"type": "string", "description": "Contenu du fichier (texte, ou base64)."},
                "base64": {"type": "boolean", "default": False,
                           "description": "Vrai si contenu est encodé en base64 (fichier binaire)."},
                "texte": {"type": "string", "maxLength": store.MAX_TEXT,
                          "description": "Message qui accompagne le document (optionnel)."},
                "reponse_a": {"type": "integer", "minimum": 1,
                              "description": "Id du message auquel tu réponds."},
            },
            "required": ["nom", "contenu"],
            "additionalProperties": False,
        },
    },
    {
        "name": "lister_documents",
        "description": "Liste les documents du salon : id, nom, taille, auteur, date (plus récents en dernier).",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "lire_document",
        "description": (
            "Lit un document par fenêtres. Texte : caractères [debut, debut+longueur). "
            "Image (png/jpeg/gif/webp, 5 Mo max) : renvoyée comme image. Binaire : octets en base64."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Id du document (16 caractères hexadécimaux)."},
                "debut": {"type": "integer", "minimum": 0, "default": 0,
                          "description": "Début de la fenêtre (caractères pour un texte, octets pour un binaire)."},
                "longueur": {"type": "integer", "minimum": 1,
                             "description": "Taille de la fenêtre (texte : 50000 par défaut, 200000 max ; "
                                            "binaire : 48000 octets par défaut, 150000 max)."},
            },
            "required": ["id"],
            "additionalProperties": False,
        },
    },
]


TOOLS.insert(0, {
    "name": "lister_salons",
    "description": (
        "Liste tes salons : id, nom, membres actifs et nombre de pings ouverts pour toi. "
        "Avec une clé personnelle, passe ensuite salon=<id> aux autres outils."
    ),
    "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
})
SALON_PROP = {"type": "string", "maxLength": 40,
              "description": "Id du salon (voir lister_salons). Facultatif si tu n'as qu'un salon."}
for _t in TOOLS:
    if _t["name"] != "lister_salons":
        _t["inputSchema"]["properties"]["salon"] = SALON_PROP


class ToolError(Exception):
    """Erreur d'outil : renvoyée en ``isError: true`` (pas en erreur JSON-RPC)."""


_RULES = (
        "- Avant de toucher un fichier partagé ou la zone d'un autre membre, envoie une "
        "demande (type demande) et attends sa réponse SEULEMENT si le destinataire est en "
        "ligne. S'il est hors ligne (outil presence, ou avertissement renvoyé par "
        "envoyer_message), n'attends pas : prends la décision toi-même, agis, puis annonce-la "
        "avec le type fait en expliquant ta décision pour qu'il la lise à son retour.\n"
        "- Annonce avec en_cours ce que tu commences et avec fait ce que tu as fini.\n"
        "- Pour demander quelque chose à un membre précis, mentionne-le avec @Nom (ou @tous) : "
        "il reçoit un ping. Un ping qui t'est adressé reste ouvert tant que tu n'y as pas "
        "répondu avec envoyer_message(reponse_a=<id>).\n"
        "- Documents : envoyer_document pour partager un fichier, lister_documents et "
        "lire_document pour les lire ; les gros binaires passent par curl sur "
        "/mcp/agentchat/fichiers avec ta clé.\n"
        "- Sois bref.")


def _instructions_personal(ident: Dict[str, Any]) -> str:
    rooms = ident["rooms"]
    if rooms:
        listing = ", ".join("%s (« %s »)" % (rid, room.get("name", rid)) for rid, room, _ in rooms)
    else:
        listing = "aucun pour l'instant"
    salon_rule = ("- Passe salon=<id> à chaque appel d'outil (et ?salon=<id> aux URL curl). "
                  "Une nouvelle discussion où ta personne est cochée apparaît d'elle-même : "
                  "appelle lister_salons pour la voir.\n")
    if len(rooms) == 1:
        salon_rule = ("- Tu n'as qu'un salon : salon est facultatif. Si d'autres discussions "
                      "apparaissent (lister_salons), passe alors salon=<id> à chaque appel.\n")
    return (
        "Tu es \"%s\", le Claude de %s, dans les salons Agent Chat où ta personne est "
        "conviée, partagés avec d'autres instances de Claude Code. Tes salons : %s.\n%s"
        "- Au début de chaque tâche, appelle lire_messages, mes_pings puis lire_tableau "
        "(dans le salon du projet en cours).\n" % (
            ident["claude"].get("name", ""), ident["username"], listing, salon_rule)
        + _RULES)


def _instructions(room: Dict[str, Any], member: Dict[str, Any]) -> str:
    return (
        "Tu es \"%s\" dans le salon \"%s\", partagé avec d'autres instances de Claude Code "
        "qui travaillent sur le même projet.\n"
        "- Au début de chaque tâche, appelle lire_messages, mes_pings puis lire_tableau.\n"
        "- Avant de toucher un fichier partagé ou la zone d'un autre membre, envoie une "
        "demande (type demande) et attends sa réponse SEULEMENT si le destinataire est en "
        "ligne. S'il est hors ligne (outil presence, ou avertissement renvoyé par "
        "envoyer_message), n'attends pas : prends la décision toi-même, agis, puis annonce-la "
        "avec le type fait en expliquant ta décision pour qu'il la lise à son retour.\n"
        "- Annonce avec en_cours ce que tu commences et avec fait ce que tu as fini.\n"
        "- Pour demander quelque chose à un membre précis, mentionne-le avec @Nom (ou @tous) : "
        "il reçoit un ping. Un ping qui t'est adressé reste ouvert tant que tu n'y as pas "
        "répondu avec envoyer_message(reponse_a=<id>).\n"
        "- Documents : envoyer_document pour partager un fichier, lister_documents et "
        "lire_document pour les lire ; les gros binaires passent par curl sur "
        "/mcp/agentchat/fichiers avec ta clé.\n"
        "- Sois bref." % (member.get("name", ""), room.get("name", ""))
    )


def _fmt_size(n: Any) -> str:
    try:
        n = int(n)
    except (TypeError, ValueError):
        return "?"
    if n < 1024:
        return "%d o" % n
    if n < 1024 * 1024:
        return ("%.1f Ko" % (n / 1024.0)).replace(".", ",")
    return ("%.1f Mo" % (n / (1024.0 * 1024.0))).replace(".", ",")


def _fmt_message(m: Dict[str, Any]) -> str:
    reply = (" ↳#%d" % m["reply_to"]) if m.get("reply_to") else ""
    line = "#%d [%s] %s (%s)%s: %s" % (m["id"], m.get("ts", ""), m.get("author", ""),
                                       m.get("kind", ""), reply, m.get("text", ""))
    att = m.get("attachment")
    if isinstance(att, dict) and att.get("id"):
        line += " [doc %s « %s » %s]" % (att.get("id"), att.get("name", ""), _fmt_size(att.get("size")))
    ments = m.get("mentions")
    if isinstance(ments, list) and ments:
        line += " [pour : %s]" % ", ".join("@" + str(x) for x in ments)
    return line


def _int_arg(args: Dict[str, Any], name: str, default: int, lo: int, hi: int) -> int:
    v = args.get(name, default)
    if v is None:
        return default
    if isinstance(v, bool) or not isinstance(v, int):
        raise ToolError("argument %s : entier attendu" % name)
    if v < lo:
        raise ToolError("argument %s : doit être >= %d" % (name, lo))
    return min(v, hi)


def _tool_lire_messages(room_id, room, member, args):
    depuis = _int_arg(args, "depuis_id", 0, 0, 10 ** 12)
    limite = _int_arg(args, "limite", 30, 1, 100)
    if depuis == 0:
        msgs = store.read_messages(room_id, limit=limite, tail=True)
    else:
        msgs = store.read_messages(room_id, after=depuis, limit=limite)
    lines = [_fmt_message(m) for m in msgs] or ["(aucun nouveau message)"]
    lines.append("dernier id : %d" % store.last_id(room_id))
    return "\n".join(lines)


def _tool_envoyer_message(room_id, room, member, args):
    texte = args.get("texte")
    if not isinstance(texte, str) or not texte.strip():
        raise ToolError("argument texte requis (chaîne non vide)")
    kind = args.get("type", "info") or "info"
    if kind not in SENDABLE_KINDS:
        raise ToolError("argument type invalide (valeurs : %s)" % ", ".join(SENDABLE_KINDS))
    reply_to = args.get("reponse_a")
    if reply_to is not None and (isinstance(reply_to, bool) or not isinstance(reply_to, int)):
        raise ToolError("argument reponse_a : entier attendu")
    msg = store.append_message(room_id, member["name"], kind, texte, reply_to)
    out = "message #%d envoyé" % msg["id"]
    try:
        views = {v["name"].lower(): v for v in presence.room_view(store.get_room(room_id), room_id)}
        for name in msg.get("mentions") or []:
            v = views.get(str(name).lower())
            if v is None or v["member_id"] == member.get("id"):
                continue
            note = presence.offline_note(v)
            if note:
                out += ("\nAttention : %s est %s. N'attends pas sa réponse : décide toi-même "
                        "et annonce ta décision avec type \"fait\"." % (v["name"], note))
    except store.StoreError:
        pass
    return out


def _fmt_presence(v: Dict[str, Any]) -> str:
    note = presence.offline_note(v)
    if note:
        status = note
    elif v["working"]:
        status = "travaille"
    else:
        status = "en ligne, inactif"
    fh = v.get("five_hour")
    lim = (" · 5 h : %d %%" % round(fh["pct"])) if fh else ""
    return "- %s : %s%s" % (v["name"], status, lim)


def _tool_presence(room_id, room, member, args):
    views = presence.room_view(store.get_room(room_id), room_id)
    if not views:
        return "Aucun membre actif."
    return "Présence :\n" + "\n".join(_fmt_presence(v) for v in views)


def _tool_lire_tableau(room_id, room, member, args):
    board = store.get_board(room_id)
    current = store.get_room(room_id)
    actifs = [m["name"] for m in current["members"] if not m["revoked"]]
    return "Tableau :\n%s\n\nMembres actifs : %s" % (
        board if board.strip() else "(vide)", ", ".join(actifs) or "(aucun)")


def _tool_modifier_tableau(room_id, room, member, args):
    texte = args.get("texte")
    if not isinstance(texte, str):
        raise ToolError("argument texte requis (chaîne)")
    store.set_board(room_id, texte)
    msg = store.append_message(room_id, member["name"], "info",
                               "tableau modifié par %s" % member["name"])
    return "tableau enregistré (message #%d)" % msg["id"]


def _tool_mes_pings(room_id, room, member, args):
    pings = store.open_pings(room_id, member["name"])
    if not pings:
        return "Aucun ping ouvert pour toi."
    lines = ["%d ping(s) ouvert(s) pour toi :" % len(pings)]
    lines += [_fmt_message(m) for m in pings]
    lines.append('Fais ce qui est demandé puis réponds avec envoyer_message(type="reponse" '
                 'ou "fait", reponse_a=<id>) ; c\'est ce qui ferme le ping.')
    return "\n".join(lines)


def _tool_envoyer_document(room_id, room, member, args):
    nom = args.get("nom")
    contenu = args.get("contenu")
    if not isinstance(nom, str) or not nom.strip():
        raise ToolError("argument nom requis (chaîne non vide)")
    if not isinstance(contenu, str):
        raise ToolError("argument contenu requis (chaîne)")
    b64 = args.get("base64", False)
    if b64 is None:
        b64 = False
    if not isinstance(b64, bool):
        raise ToolError("argument base64 : booléen attendu")
    texte = args.get("texte", "")
    if texte is None:
        texte = ""
    if not isinstance(texte, str):
        raise ToolError("argument texte : chaîne attendue")
    reply_to = args.get("reponse_a")
    if reply_to is not None and (isinstance(reply_to, bool) or not isinstance(reply_to, int)):
        raise ToolError("argument reponse_a : entier attendu")
    too_big = ("document trop gros pour l'envoi en ligne (%d Mo max ici). Envoie-le avec curl : "
               'curl -H "Authorization: Bearer %s" -F "file=@<chemin>" -F "text=<message>" '
               "%s/mcp/agentchat/fichiers%s" % (INLINE_DOC_MAX // (1024 * 1024), _KEY_HINT, _ORIGIN.get(),
                                     _SALON_Q.get()))
    if b64:
        compact = "".join(contenu.split())
        if len(compact) > (INLINE_DOC_MAX // 3 + 1) * 4:
            raise ToolError(too_big)
        try:
            data = base64.b64decode(compact, validate=True)
        except (binascii.Error, ValueError):
            raise ToolError("argument contenu : base64 invalide")
    else:
        data = contenu.encode("utf-8")
    if len(data) > INLINE_DOC_MAX:
        raise ToolError(too_big)
    msg = store.send_document(room_id, member["name"], "info", nom, data, texte, reply_to)
    return "document %s envoyé (message #%d)" % (msg["attachment"]["id"], msg["id"])


def _tool_lister_documents(room_id, room, member, args):
    files = store.list_files(room_id)
    if not files:
        return "(aucun document)"
    return "\n".join("%s  %s  %s  %s  %s" % (f["id"], f["name"], _fmt_size(f["size"]),
                                            f.get("uploaded_by", ""), f.get("ts", ""))
                     for f in files)


def _tool_lire_document(room_id, room, member, args):
    file_id = args.get("id")
    if not isinstance(file_id, str) or not store.FILE_ID_RE.match(file_id):
        raise ToolError("argument id invalide (16 caractères hexadécimaux)")
    debut = _int_arg(args, "debut", 0, 0, 10 ** 12)
    meta, path = store.get_file(room_id, file_id)
    head = "document %s « %s » (%s, %s, déposé par %s le %s)" % (
        meta["id"], meta["name"], meta["mime"], _fmt_size(meta["size"]),
        meta.get("uploaded_by", ""), meta.get("ts", ""))
    with open(str(path), "rb") as f:
        data = f.read()

    if meta["mime"] in IMAGE_MIMES and len(data) <= IMAGE_INLINE_MAX:
        return [
            {"type": "image", "data": base64.b64encode(data).decode("ascii"), "mimeType": meta["mime"]},
            {"type": "text", "text": head},
        ]

    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        text = None

    if text is not None:
        longueur = _int_arg(args, "longueur", TEXT_WINDOW_DEFAULT, 1, TEXT_WINDOW_MAX)
        total = len(text)
        start = min(debut, total)
        end = min(start + longueur, total)
        parts = [head, "caractères %d-%d sur %d" % (start, end, total)]
        if end < total:
            parts.append('suite : lire_document(id="%s", debut=%d)' % (file_id, end))
        parts += ["---", text[start:end]]
        return "\n".join(parts)

    longueur = _int_arg(args, "longueur", BYTES_WINDOW_DEFAULT, 1, BYTES_WINDOW_MAX)
    total = len(data)
    start = min(debut, total)
    end = min(start + longueur, total)
    parts = [head, "binaire : octets %d-%d sur %d (base64 ci-dessous)" % (start, end, total)]
    if end < total:
        parts.append('suite : lire_document(id="%s", debut=%d)' % (file_id, end))
    parts.append('fichier entier : curl -H "Authorization: Bearer %s" "%s/mcp/agentchat/fichiers/%s%s" -o "%s"'
                 % (_KEY_HINT, _ORIGIN.get(), file_id, _SALON_Q.get(), meta["name"]))
    parts += ["---", base64.b64encode(data[start:end]).decode("ascii")]
    return "\n".join(parts)


TOOL_HANDLERS = {
    "lire_messages": _tool_lire_messages,
    "envoyer_message": _tool_envoyer_message,
    "lire_tableau": _tool_lire_tableau,
    "modifier_tableau": _tool_modifier_tableau,
    "mes_pings": _tool_mes_pings,
    "presence": _tool_presence,
    "envoyer_document": _tool_envoyer_document,
    "lister_documents": _tool_lister_documents,
    "lire_document": _tool_lire_document,
}

NO_PING_FOOTER = ("mes_pings", "lister_salons")


def _ping_footer(room_id: str, member: Dict[str, Any]) -> str:
    try:
        pings = store.open_pings(room_id, member["name"])
    except store.StoreError:
        return ""
    if not pings:
        return ""
    return "\n\n[PING] %d ping(s) pour toi non traité(s) : %s — appelle mes_pings." % (
        len(pings), ", ".join("#%d" % m["id"] for m in pings))


def _personal_pings(ident: Dict[str, Any], only: Optional[str] = None) -> List[Tuple[str, Dict[str, Any]]]:
    """[(room_id, message)] des pings ouverts du Claude personnel, tous salons
    (ou seulement ``only``)."""
    out = []  # type: List[Tuple[str, Dict[str, Any]]]
    for rid, room, member in ident["rooms"]:
        if only is not None and rid != only:
            continue
        try:
            out += [(rid, m) for m in store.open_pings(rid, member["name"])]
        except store.StoreError:
            continue
    return out


def _ping_footer_personal(ident: Dict[str, Any]) -> str:
    pings = _personal_pings(ident)
    if not pings:
        return ""
    return ("\n\n[PING] %d ping(s) pour toi non traité(s) : %s — appelle mes_pings "
            "avec le salon concerné." % (len(pings), ", ".join("%s #%d" % (rid, m["id"])
                                                               for rid, m in pings)))


def _salon_list(ident: Dict[str, Any]) -> str:
    return ", ".join(rid for rid, _, _ in ident["rooms"]) or "(aucun)"


def _resolve_room(ident: Dict[str, Any], salon: Any) -> Tuple[str, Dict[str, Any], Dict[str, Any]]:
    """(room_id, salon, membre) visé par un appel. ToolError sinon."""
    if salon is not None and not isinstance(salon, str):
        raise ToolError("argument salon : chaîne attendue")
    salon = (salon or "").strip() or None
    if ident["kind"] == "room":
        if salon is not None and salon != ident["room_id"]:
            raise ToolError("salon introuvable : %s (ta clé ne vaut que pour %s)"
                            % (salon, ident["room_id"]))
        return ident["room_id"], ident["room"], ident["member"]
    rooms = ident["rooms"]
    if salon is not None:
        for rid, room, member in rooms:
            if rid == salon:
                return rid, room, member
        raise ToolError("salon introuvable : %s (tes salons : %s)" % (salon, _salon_list(ident)))
    if len(rooms) == 1:
        return rooms[0]
    if not rooms:
        raise ToolError("tu n'es membre d'aucun salon pour l'instant (lister_salons pour vérifier)")
    raise ToolError("précise salon=<id> : tu es dans plusieurs salons (%s)" % _salon_list(ident))


def _touch(ident: Dict[str, Any], room_id: Optional[str] = None) -> None:
    """Présence : le membre du salon visé, sinon tous les membres de l'identité."""
    if ident["kind"] == "room":
        if ident["member"].get("id"):
            presence.touch(ident["room_id"], ident["member"]["id"])
        return
    for rid, _, member in ident["rooms"]:
        if (room_id is None or rid == room_id) and member.get("id"):
            presence.touch(rid, member["id"])


def _tool_lister_salons(ident: Dict[str, Any]) -> str:
    if ident["kind"] == "room":
        rooms = [(ident["room_id"], ident["room"], ident["member"])]
    else:
        rooms = ident["rooms"]
    if not rooms:
        return "Aucun salon pour l'instant : ta personne n'est cochée dans aucune discussion."
    lines = ["Tes salons :"]
    for rid, room, member in rooms:
        actifs = [m.get("name", "") for m in room.get("members", []) if not m.get("revoked")]
        try:
            n = len(store.open_pings(rid, member["name"]))
        except store.StoreError:
            n = 0
        lines.append("- %s « %s » · membres actifs : %s · pings ouverts pour toi : %d"
                     % (rid, room.get("name", rid), ", ".join(actifs) or "(aucun)", n))
    return "\n".join(lines)


def _rpc_error(rid: Any, code: int, message: str) -> Dict[str, Any]:
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}


def _rpc_result(rid: Any, result: Any) -> Dict[str, Any]:
    return {"jsonrpc": "2.0", "id": rid, "result": result}


def _handle_one(obj: Any, ident: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Traite une requête JSON-RPC ; renvoie None pour une notification."""
    personal = ident["kind"] == "personal"
    if not isinstance(obj, dict) or obj.get("jsonrpc") != "2.0" or not isinstance(obj.get("method"), str):
        return _rpc_error(obj.get("id") if isinstance(obj, dict) else None, -32600, "Invalid Request")
    method = obj["method"]
    if "id" not in obj:
        if personal:
            _touch(ident)
        return None  # notification : pas de réponse
    rid = obj["id"]
    params = obj.get("params") or {}
    if not isinstance(params, dict):
        return _rpc_error(rid, -32602, "Invalid params")

    if method != "tools/call" and personal:
        _touch(ident)
    if method == "initialize":
        asked = params.get("protocolVersion")
        version = asked if asked in SUPPORTED_VERSIONS else DEFAULT_VERSION
        return _rpc_result(rid, {
            "protocolVersion": version,
            "capabilities": {"tools": {}},
            "serverInfo": SERVER_INFO,
            "instructions": (_instructions_personal(ident) if personal
                             else _instructions(ident["room"], ident["member"])),
        })
    if method == "ping":
        return _rpc_result(rid, {})
    if method == "tools/list":
        return _rpc_result(rid, {"tools": TOOLS})
    if method == "tools/call":
        name = params.get("name")
        args = params.get("arguments") or {}
        handler = TOOL_HANDLERS.get(name) if isinstance(name, str) else None
        touched = False
        try:
            if name == "lister_salons":
                if personal:
                    _touch(ident)
                    touched = True
                out = _tool_lister_salons(ident)
            else:
                if handler is None:
                    raise ToolError("outil inconnu : %s" % name)
                if not isinstance(args, dict):
                    raise ToolError("arguments invalides (objet attendu)")
                args = dict(args)
                room_id, room, member = _resolve_room(ident, args.pop("salon", None))
                if personal:
                    _touch(ident, room_id)
                    touched = True
                _SALON_Q.set(("?salon=" + room_id) if personal else "")
                out = handler(room_id, room, member, args)
            content = [{"type": "text", "text": out}] if isinstance(out, str) else list(out)
            if name not in NO_PING_FOOTER:
                footer = _ping_footer_personal(ident) if personal else _ping_footer(room_id, member)
                if footer:
                    for c in reversed(content):
                        if c.get("type") == "text":
                            c["text"] += footer
                            break
                    else:
                        content.append({"type": "text", "text": footer.lstrip("\n")})
            return _rpc_result(rid, {"content": content, "isError": False})
        except (ToolError, store.StoreError) as e:
            return _rpc_result(rid, {"content": [{"type": "text", "text": "Erreur : %s" % e}],
                                     "isError": True})
        finally:
            if personal and not touched:
                _touch(ident)
    return _rpc_error(rid, -32601, "Method not found: %s" % method)


def _unauthorized() -> JSONResponse:
    return JSONResponse(status_code=401, content={"detail": "Clé Agent Chat absente, invalide ou révoquée"},
                        headers={"WWW-Authenticate": "Bearer"})


def _identity_from(request: Request) -> Optional[Dict[str, Any]]:
    """Identité d'après ``Authorization: Bearer oac_...`` (clé de salon ou personnelle)."""
    auth = request.headers.get("authorization", "")
    parts = auth.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return store.find_identity(parts[1].strip())


def _member_from(request: Request, touch: bool = True) -> Optional[Tuple[str, Dict[str, Any], Dict[str, Any]]]:
    """(room_id, salon, membre) pour une CLÉ DE SALON, ou None (compatibilité).

    Une requête authentifiée met à jour la présence (``last_seen``) du membre."""
    ident = _identity_from(request)
    if ident is None or ident["kind"] != "room":
        return None
    if touch:
        _touch(ident)
    return ident["room_id"], ident["room"], ident["member"]


def _agent_room(request: Request, touch: bool = True
                ) -> Tuple[Optional[Dict[str, Any]], Optional[Tuple[str, Dict[str, Any], Dict[str, Any]]]]:
    """Routes REST agents : (identité, (room_id, salon, membre)) d'après la clé et
    le paramètre ``?salon=`` (obligatoire pour une clé personnelle à plusieurs
    salons). (None, None) si la clé est invalide ; HTTP 400/404 si le salon ne va pas."""
    ident = _identity_from(request)
    if ident is None:
        return None, None
    try:
        target = _resolve_room(ident, request.query_params.get("salon"))
    except ToolError as e:
        if touch:
            _touch(ident)
        code = 404 if str(e).startswith("salon introuvable") else 400
        raise HTTPException(status_code=code, detail=str(e))
    if touch:
        _touch(ident, target[0])
    return ident, target


@mcp_router.post("/mcp/agentchat")
async def mcp_endpoint(request: Request):
    ident = _identity_from(request)
    if ident is None:
        return _unauthorized()
    if ident["kind"] == "room":
        _touch(ident)
    _ORIGIN.set(str(request.base_url).rstrip("/"))

    raw = await request.body()
    try:
        payload = json.loads(raw.decode("utf-8")) if raw else None
    except (ValueError, UnicodeDecodeError):
        return JSONResponse(content=_rpc_error(None, -32700, "Parse error"))
    if payload is None:
        return JSONResponse(content=_rpc_error(None, -32700, "Parse error"))

    if isinstance(payload, list):
        if not payload:
            return JSONResponse(content=_rpc_error(None, -32600, "Invalid Request"))
        out = [r for r in (_handle_one(o, ident) for o in payload) if r is not None]
        if not out:
            return Response(status_code=202)
        return JSONResponse(content=out)

    resp = _handle_one(payload, ident)
    if resp is None:
        return Response(status_code=202)
    return JSONResponse(content=resp)


@mcp_router.get("/mcp/agentchat")
def mcp_get():
    return JSONResponse(status_code=405, content={"detail": "Méthode non supportée : utiliser POST"},
                        headers={"Allow": "POST"})


# ================================================================ REST agents (clé Bearer)

@mcp_router.post("/mcp/agentchat/fichiers")
async def agent_upload_file(request: Request):
    """Dépôt d'un document par un agent (multipart ``file``, ``text``, ``reply_to``),
    pour les fichiers trop gros pour envoyer_document. Auth vérifiée AVANT de lire
    le corps ; l'auteur vient uniquement de la clé. Clé personnelle : ``?salon=<id>``."""
    ident, target = _agent_room(request)
    if ident is None:
        return _unauthorized()
    room_id, room, member = target
    name, data, text, reply_to = await _read_upload(request)
    try:
        msg = store.send_document(room_id, member["name"], "info", name, data, text, reply_to)
    except store.StoreError as e:
        raise _http(e)
    return {"message": msg}


@mcp_router.get("/mcp/agentchat/fichiers/{file_id}")
def agent_download_file(file_id: str, request: Request):
    ident, target = _agent_room(request)
    if ident is None:
        return _unauthorized()
    try:
        meta, path = store.get_file(target[0], file_id)
    except store.StoreError as e:
        raise _http(e)
    return _file_response(meta, path)


def _ping_out(m: Dict[str, Any]) -> Dict[str, Any]:
    return {"id": m["id"], "author": m.get("author", ""),
            "text": (m.get("text") or "")[:300], "ts": m.get("ts", "")}


@mcp_router.get("/mcp/agentchat/pings")
def agent_pings(request: Request):
    """Pings ouverts du membre de la clé (lu par le hook Stop de Claude Code).
    Clé personnelle : tous ses salons (chaque ping porte ``salon``), ou seulement
    ``?salon=<id>``."""
    ident = _identity_from(request)
    if ident is None:
        return _unauthorized()
    if ident["kind"] == "room":
        _touch(ident)
        room_id, member = ident["room_id"], ident["member"]
        pings = store.open_pings(room_id, member["name"])
        return {"member": member["name"], "pings": [_ping_out(m) for m in pings]}
    only = request.query_params.get("salon") or None
    if only is not None:
        ident, target = _agent_room(request)
        only = target[0]
    else:
        _touch(ident)
    out = []
    for rid, m in _personal_pings(ident, only):
        p = _ping_out(m)
        p["salon"] = rid
        out.append(p)
    return {"member": ident["claude"].get("name", ""), "pings": out}


def _num(v: Any) -> Optional[float]:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v)


@mcp_router.post("/mcp/agentchat/statut")
async def agent_status(request: Request):
    """Statut poussé par le script client (hook/statusline Claude Code).

    Membre = clé uniquement. Champs optionnels invalides : ignorés. Ne compte pas
    comme un appel MCP (un SessionEnd ne doit pas laisser le membre « en ligne »)."""
    ident = _identity_from(request)
    if ident is None:
        return _unauthorized()
    if ident["kind"] == "room":
        targets = [(ident["room_id"], ident["member"])]
    elif request.query_params.get("salon"):
        _, target = _agent_room(request, touch=False)
        targets = [(target[0], target[2])]
    else:
        targets = [(rid, m) for rid, _, m in ident["rooms"]]
    try:
        body = json.loads((await request.body()).decode("utf-8") or "{}")
    except (ValueError, UnicodeDecodeError):
        body = {}
    if not isinstance(body, dict):
        body = {}
    state = body.get("state")
    session = body.get("session")
    if not isinstance(session, str) or not session.strip():
        session = None
    ts = lambda k: body.get(k) if isinstance(body.get(k), int) else None  # noqa: E731
    for room_id, member in targets:
        if member.get("id"):
            presence.set_status(
                room_id, member["id"], session=session,
                state=state if state in presence.STATES else None,
                five_hour_pct=_num(body.get("five_hour_pct")), five_hour_resets_at=ts("five_hour_resets_at"),
                seven_day_pct=_num(body.get("seven_day_pct")), seven_day_resets_at=ts("seven_day_resets_at"))
    return {"ok": True}
