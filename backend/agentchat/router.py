"""Agent Chat — API humaine (REST, admin) + serveur MCP (Streamable HTTP, réponse JSON).

- ``/api/agentchat/...`` : gestion des salons/membres/messages/tableau depuis le site
  (JWT du site, administrateur uniquement).
- ``POST /mcp/agentchat`` : serveur MCP pour les instances de Claude Code. Auth
  par ``Authorization: Bearer oac_...`` (clé de membre) — la clé désigne à la fois
  le salon et l'auteur ; aucun champ client ne peut changer l'auteur.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response
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
                                   "humain", body.text, body.reply_to)
    except store.StoreError as e:
        raise _http(e)
    return {"message": msg}


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
SERVER_INFO = {"name": "omenserver-agentchat", "version": "1.0.0"}
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
            "reponse (réponse à une demande, avec reponse_a)."
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
]


class ToolError(Exception):
    """Erreur d'outil : renvoyée en ``isError: true`` (pas en erreur JSON-RPC)."""


def _instructions(room: Dict[str, Any], member: Dict[str, Any]) -> str:
    return (
        "Tu es \"%s\" dans le salon \"%s\", partagé avec d'autres instances de Claude Code "
        "qui travaillent sur le même projet.\n"
        "- Au début de chaque tâche, appelle lire_messages puis lire_tableau.\n"
        "- Avant de toucher un fichier partagé ou la zone d'un autre membre, envoie une "
        "demande (type demande) et attends sa réponse.\n"
        "- Annonce avec en_cours ce que tu commences et avec fait ce que tu as fini.\n"
        "- Sois bref." % (member.get("name", ""), room.get("name", ""))
    )


def _fmt_message(m: Dict[str, Any]) -> str:
    reply = (" ↳#%d" % m["reply_to"]) if m.get("reply_to") else ""
    return "#%d [%s] %s (%s)%s: %s" % (m["id"], m.get("ts", ""), m.get("author", ""),
                                       m.get("kind", ""), reply, m.get("text", ""))


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


TOOL_HANDLERS = {
    "lire_messages": _tool_lire_messages,
    "envoyer_message": _tool_envoyer_message,
    "lire_tableau": _tool_lire_tableau,
    "modifier_tableau": _tool_modifier_tableau,
}


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
            text = handler(room_id, room, member, args)
            return _rpc_result(rid, {"content": [{"type": "text", "text": text}], "isError": False})
        except (ToolError, store.StoreError) as e:
            return _rpc_result(rid, {"content": [{"type": "text", "text": "Erreur : %s" % e}],
                                     "isError": True})
    return _rpc_error(rid, -32601, "Method not found: %s" % method)


def _unauthorized() -> JSONResponse:
    return JSONResponse(status_code=401, content={"detail": "Clé Agent Chat absente, invalide ou révoquée"},
                        headers={"WWW-Authenticate": "Bearer"})


@mcp_router.post("/mcp/agentchat")
async def mcp_endpoint(request: Request):
    auth = request.headers.get("authorization", "")
    parts = auth.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return _unauthorized()
    found = store.find_by_key(parts[1].strip())
    if found is None:
        return _unauthorized()
    room_id, room, member = found

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
