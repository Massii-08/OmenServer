"""Router MC Agent — pilotage du bot Minecraft d'entrainement (admin-only)."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from backend.auth.utils import get_current_user
from backend.auth.models import User
from backend.bots import mc_agent_manager as mgr
from backend.bots import mc_agent_servers as servers_store

router = APIRouter(prefix="/api/mc-agent", tags=["mc-agent"])


def _require_admin(user):
    if not getattr(user, "is_admin", False):
        raise HTTPException(status_code=403, detail="Admin uniquement")


class StartReq(BaseModel):
    host: str = ""                  # vide si on lance via server_id
    port: int = 25565
    user: str = "TrainBot"          # pseudo (offline) OU email du compte (microsoft)
    auth: str = "offline"           # "offline" | "microsoft"
    model: Optional[str] = None     # Python 3.9 : pas de `str | None` (piège #1)
    profile: Optional[str] = None   # id de profil de comportement (evident/intermediaire/expert)
    server_id: Optional[str] = None # si fourni : charge un profil serveur (connexion + commandes)
    language: str = "fr"            # langue du champ reply LLM : fr | en | it


class SayReq(BaseModel):
    message: str


class ApiKeyPayload(BaseModel):
    key: str


class ServerPayload(BaseModel):
    name: str = "Sans nom"
    host: str = ""
    port: int = 25565
    user: str = "TrainBot"
    auth: str = "offline"
    intelligence: str = "intermediaire"
    language: str = "fr"
    commands: list = []
    custom: list = []
    trusted: list = []
    trade: Optional[dict] = None


@router.post("/run")
def run(req: StartReq, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    if not mgr.has_api_key():
        raise HTTPException(status_code=400, detail="Aucune cle Claude configuree (renseigne-la dans le bot)")
    host, port, user = req.host, req.port, req.user
    auth, profile, commands, policy = req.auth, req.profile, None, None
    language = req.language
    if req.server_id:
        srv = servers_store.get_server(req.server_id)
        if not srv:
            raise HTTPException(status_code=404, detail="Profil serveur introuvable")
        host, port, user = srv["host"], srv["port"], srv["user"]
        auth, profile = srv["auth"], srv["intelligence"]
        language = srv.get("language", "fr")
        commands = servers_store.resolve_commands(srv)
        policy = servers_store.resolve_policy(srv)
    if not host:
        raise HTTPException(status_code=400, detail="host requis (ou choisis un profil serveur)")
    auth = auth if auth in ("offline", "microsoft") else "offline"
    try:
        sid = mgr.start_session(host, port, user, req.model, auth, profile, commands, policy, server_id=req.server_id, language=language)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Impossible de demarrer Node : {exc}")
    return {"session_id": sid}


@router.get("/settings/api-key")
def get_api_key(current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    return mgr.get_api_key_status()


@router.post("/settings/api-key")
def set_api_key(payload: ApiKeyPayload, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    key = (payload.key or "").strip()
    if not key.startswith("sk-ant-") or len(key) < 20:
        raise HTTPException(status_code=400, detail="Format inattendu : une cle Claude commence par 'sk-ant-'")
    try:
        preview = mgr.set_api_key(key)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Impossible d'ecrire la cle : {exc}")
    return {"message": "Cle enregistree", "preview": preview}


@router.delete("/settings/api-key")
def delete_api_key(current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    mgr.clear_api_key()
    return {"ok": True}


@router.get("/active")
def active(current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    return {"sessions": mgr.list_active()}


@router.get("/profiles")
def profiles(current_user: User = Depends(get_current_user)):
    """Liste des profils de comportement + leurs fiches de tells (corrigé formateur)."""
    _require_admin(current_user)
    return {"profiles": mgr.list_profiles()}


@router.get("/status/{sid}")
def status(sid: int, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    s = mgr.get_status(sid)
    if not s:
        raise HTTPException(status_code=404, detail="Session introuvable")
    return s


@router.get("/chat/{sid}")
def chat(sid: int, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    t = mgr.get_transcript(sid)
    if t is None:
        raise HTTPException(status_code=404, detail="Session introuvable")
    return {"transcript": t}


@router.post("/say/{sid}")
def say(sid: int, req: SayReq, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    if not mgr.send_command(sid, {"type": "say", "message": req.message}):
        raise HTTPException(status_code=404, detail="Session introuvable")
    return {"ok": True}


@router.post("/stop/{sid}")
def stop(sid: int, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    if not mgr.stop_session(sid):
        raise HTTPException(status_code=404, detail="Session introuvable")
    return {"ok": True}


@router.get("/commands-catalog")
def commands_catalog(current_user: User = Depends(get_current_user)):
    """Catalogue de commandes prédéfinies pour la checklist (admin-only)."""
    _require_admin(current_user)
    return {"catalog": servers_store.load_catalog()}


@router.get("/servers")
def list_servers(current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    return {"servers": servers_store.load_servers()}


@router.post("/servers")
def create_server(payload: ServerPayload, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    return servers_store.create_server(payload.model_dump())


@router.put("/servers/{sid}")
def update_server(sid: str, payload: ServerPayload, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    s = servers_store.update_server(sid, payload.model_dump())
    if not s:
        raise HTTPException(status_code=404, detail="Profil introuvable")
    return s


@router.delete("/servers/{sid}")
def delete_server(sid: str, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    if not servers_store.delete_server(sid):
        raise HTTPException(status_code=404, detail="Profil introuvable")
    return {"ok": True}
