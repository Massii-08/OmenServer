"""Agent Chat — API humaine (REST, admin) + serveur MCP (Streamable HTTP, réponse JSON).

- ``/api/agentchat/...`` : gestion des salons/membres/messages/tableau depuis le site
  (JWT du site, administrateur uniquement).
- ``POST /mcp/agentchat`` : serveur MCP pour les instances de Claude Code. Auth
  par ``Authorization: Bearer oac_...`` (clé de membre) — la clé désigne à la fois
  le salon et l'auteur ; aucun champ client ne peut changer l'auteur.
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

from backend.agentchat import store
from backend.auth.models import User
from backend.auth.utils import get_current_user

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


def _http(e: store.StoreError) -> HTTPException:
    if isinstance(e, store.NotFound):
        return HTTPException(status_code=404, detail=str(e))
    if isinstance(e, store.Conflict):
        return HTTPException(status_code=409, detail=str(e))
    return HTTPException(status_code=400, detail=str(e))


class RoomIn(BaseModel):
    room_id: str
    name: str


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
    return {"rooms": store.list_rooms()}


@router.post("/rooms")
def create_room(body: RoomIn, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    try:
        room = store.create_room(body.room_id, body.name)
    except store.StoreError as e:
        raise _http(e)
    logger.info("Agent Chat: salon %s créé par %s", body.room_id, current_user.username)
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


@router.get("/rooms/{room_id}/messages")
def get_messages(room_id: str, after: int = 0, limit: int = 100,
                 current_user: User = Depends(get_current_user)):
    _require_chat(current_user)
    limit = max(1, min(int(limit), 200))
    try:
        if after <= 0:
            msgs = store.read_messages(room_id, limit=limit, tail=True)
        else:
            msgs = store.read_messages(room_id, after=after, limit=limit)
    except store.StoreError as e:
        raise _http(e)
    return {"messages": msgs}


@router.post("/rooms/{room_id}/messages")
def post_message(room_id: str, body: MessageIn, current_user: User = Depends(get_current_user)):
    _require_chat(current_user)
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
    _require_chat(current_user)
    try:
        store.get_room(room_id)
    except store.StoreError as e:
        raise _http(e)
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
    _require_chat(current_user)
    try:
        meta, path = store.get_file(room_id, file_id)
    except store.StoreError as e:
        raise _http(e)
    return _file_response(meta, path)


@router.get("/rooms/{room_id}/pings")
def room_pings(room_id: str, current_user: User = Depends(get_current_user)):
    _require_chat(current_user)
    try:
        return {"pings": store.open_pings_by_member(room_id)}
    except store.StoreError as e:
        raise _http(e)


@router.get("/rooms/{room_id}/board")
def get_board(room_id: str, current_user: User = Depends(get_current_user)):
    _require_chat(current_user)
    try:
        return {"board": store.get_board(room_id)}
    except store.StoreError as e:
        raise _http(e)


@router.put("/rooms/{room_id}/board")
def put_board(room_id: str, body: BoardIn, current_user: User = Depends(get_current_user)):
    _require_chat(current_user)
    try:
        board = store.set_board(room_id, body.board)
    except store.StoreError as e:
        raise _http(e)
    return {"board": board}


# ================================================================ MCP

SUPPORTED_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
DEFAULT_VERSION = "2025-06-18"
SERVER_INFO = {"name": "omenserver-agentchat", "version": "1.1.0"}
INLINE_DOC_MAX = 4 * 1024 * 1024
IMAGE_INLINE_MAX = 5 * 1024 * 1024
IMAGE_MIMES = ("image/png", "image/jpeg", "image/gif", "image/webp")
TEXT_WINDOW_DEFAULT = 50000
TEXT_WINDOW_MAX = 200000
BYTES_WINDOW_DEFAULT = 48000
BYTES_WINDOW_MAX = 150000

# Origine de la requête MCP en cours (citée dans les commandes curl).
_ORIGIN = contextvars.ContextVar("agentchat_origin", default="<origine du serveur>")
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


class ToolError(Exception):
    """Erreur d'outil : renvoyée en ``isError: true`` (pas en erreur JSON-RPC)."""


def _instructions(room: Dict[str, Any], member: Dict[str, Any]) -> str:
    return (
        "Tu es \"%s\" dans le salon \"%s\", partagé avec d'autres instances de Claude Code "
        "qui travaillent sur le même projet.\n"
        "- Au début de chaque tâche, appelle lire_messages, mes_pings puis lire_tableau.\n"
        "- Avant de toucher un fichier partagé ou la zone d'un autre membre, envoie une "
        "demande (type demande) et attends sa réponse.\n"
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
    return "message #%d envoyé" % msg["id"]


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
               "%s/mcp/agentchat/fichiers" % (INLINE_DOC_MAX // (1024 * 1024), _KEY_HINT, _ORIGIN.get()))
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
    parts.append('fichier entier : curl -H "Authorization: Bearer %s" %s/mcp/agentchat/fichiers/%s -o "%s"'
                 % (_KEY_HINT, _ORIGIN.get(), file_id, meta["name"]))
    parts += ["---", base64.b64encode(data[start:end]).decode("ascii")]
    return "\n".join(parts)


TOOL_HANDLERS = {
    "lire_messages": _tool_lire_messages,
    "envoyer_message": _tool_envoyer_message,
    "lire_tableau": _tool_lire_tableau,
    "modifier_tableau": _tool_modifier_tableau,
    "mes_pings": _tool_mes_pings,
    "envoyer_document": _tool_envoyer_document,
    "lister_documents": _tool_lister_documents,
    "lire_document": _tool_lire_document,
}

NO_PING_FOOTER = ("mes_pings",)


def _ping_footer(room_id: str, member: Dict[str, Any]) -> str:
    try:
        pings = store.open_pings(room_id, member["name"])
    except store.StoreError:
        return ""
    if not pings:
        return ""
    return "\n\n[PING] %d ping(s) pour toi non traité(s) : %s — appelle mes_pings." % (
        len(pings), ", ".join("#%d" % m["id"] for m in pings))


def _rpc_error(rid: Any, code: int, message: str) -> Dict[str, Any]:
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}


def _rpc_result(rid: Any, result: Any) -> Dict[str, Any]:
    return {"jsonrpc": "2.0", "id": rid, "result": result}


def _handle_one(obj: Any, room_id: str, room: Dict[str, Any],
                member: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Traite une requête JSON-RPC ; renvoie None pour une notification."""
    if not isinstance(obj, dict) or obj.get("jsonrpc") != "2.0" or not isinstance(obj.get("method"), str):
        return _rpc_error(obj.get("id") if isinstance(obj, dict) else None, -32600, "Invalid Request")
    method = obj["method"]
    if "id" not in obj:
        return None  # notification : pas de réponse
    rid = obj["id"]
    params = obj.get("params") or {}
    if not isinstance(params, dict):
        return _rpc_error(rid, -32602, "Invalid params")

    if method == "initialize":
        asked = params.get("protocolVersion")
        version = asked if asked in SUPPORTED_VERSIONS else DEFAULT_VERSION
        return _rpc_result(rid, {
            "protocolVersion": version,
            "capabilities": {"tools": {}},
            "serverInfo": SERVER_INFO,
            "instructions": _instructions(room, member),
        })
    if method == "ping":
        return _rpc_result(rid, {})
    if method == "tools/list":
        return _rpc_result(rid, {"tools": TOOLS})
    if method == "tools/call":
        name = params.get("name")
        args = params.get("arguments") or {}
        handler = TOOL_HANDLERS.get(name) if isinstance(name, str) else None
        try:
            if handler is None:
                raise ToolError("outil inconnu : %s" % name)
            if not isinstance(args, dict):
                raise ToolError("arguments invalides (objet attendu)")
            out = handler(room_id, room, member, args)
            content = [{"type": "text", "text": out}] if isinstance(out, str) else list(out)
            if name not in NO_PING_FOOTER:
                footer = _ping_footer(room_id, member)
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
    return _rpc_error(rid, -32601, "Method not found: %s" % method)


def _unauthorized() -> JSONResponse:
    return JSONResponse(status_code=401, content={"detail": "Clé Agent Chat absente, invalide ou révoquée"},
                        headers={"WWW-Authenticate": "Bearer"})


def _member_from(request: Request) -> Optional[Tuple[str, Dict[str, Any], Dict[str, Any]]]:
    """(room_id, salon, membre) d'après ``Authorization: Bearer oac_...``, ou None."""
    auth = request.headers.get("authorization", "")
    parts = auth.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return store.find_by_key(parts[1].strip())


@mcp_router.post("/mcp/agentchat")
async def mcp_endpoint(request: Request):
    found = _member_from(request)
    if found is None:
        return _unauthorized()
    room_id, room, member = found
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
        out = [r for r in (_handle_one(o, room_id, room, member) for o in payload) if r is not None]
        if not out:
            return Response(status_code=202)
        return JSONResponse(content=out)

    resp = _handle_one(payload, room_id, room, member)
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
    le corps ; l'auteur vient uniquement de la clé."""
    found = _member_from(request)
    if found is None:
        return _unauthorized()
    room_id, room, member = found
    name, data, text, reply_to = await _read_upload(request)
    try:
        msg = store.send_document(room_id, member["name"], "info", name, data, text, reply_to)
    except store.StoreError as e:
        raise _http(e)
    return {"message": msg}


@mcp_router.get("/mcp/agentchat/fichiers/{file_id}")
def agent_download_file(file_id: str, request: Request):
    found = _member_from(request)
    if found is None:
        return _unauthorized()
    try:
        meta, path = store.get_file(found[0], file_id)
    except store.StoreError as e:
        raise _http(e)
    return _file_response(meta, path)


@mcp_router.get("/mcp/agentchat/pings")
def agent_pings(request: Request):
    """Pings ouverts du membre de la clé (lu par le hook Stop de Claude Code)."""
    found = _member_from(request)
    if found is None:
        return _unauthorized()
    room_id, room, member = found
    pings = store.open_pings(room_id, member["name"])
    return {"member": member["name"],
            "pings": [{"id": m["id"], "author": m.get("author", ""),
                       "text": (m.get("text") or "")[:300], "ts": m.get("ts", "")}
                      for m in pings]}
