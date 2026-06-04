"""Router MC Agent — pilotage du bot Minecraft d'entrainement (admin-only)."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from backend.auth.utils import get_current_user
from backend.auth.models import User
from backend.bots import mc_agent_manager as mgr
from backend.bots import mc_agent_servers as servers_store
from backend.bots import mc_agent_world_memory as world_memory
from backend.bots import mc_agent_secrets

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
    autonomous: bool = False        # True → lance la boucle planner au spawn (0 LLM)
    objective: str = "stone_pickaxe"  # objectif autonome : stone_pickaxe | iron_pickaxe | diamond | mapper
    world_label: Optional[str] = None  # clé de monde explicite (ex. "mining") — sinon dimension auto


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


class BotPayload(BaseModel):
    """Payload de création d'un bot dans un groupe (roster).

    Le champ `secret` (mot de passe AuthMe, token…) est stocké séparément
    et ne doit JAMAIS être renvoyé dans les réponses API.
    """
    role: str = "worker"
    username: str
    auth: str = "offline"
    secret: Optional[str] = None  # stocké via mc_agent_secrets, jamais réémis


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
        sid = mgr.start_session(host, port, user, req.model, auth, profile, commands, policy, server_id=req.server_id, language=language, autonomous=req.autonomous, objective=req.objective, world_label=req.world_label)
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
    servers = servers_store.load_servers()
    # Enrichit chaque bot avec has_secret (sans muter le fichier persisté)
    enriched = []
    for srv in servers:
        srv_copy = dict(srv)
        sid = srv_copy.get("id", "")
        bots_copy = []
        for bot in srv_copy.get("bots", []):
            bots_copy.append({**bot, "has_secret": mc_agent_secrets.has_secret(sid, bot.get("id", ""))})
        srv_copy["bots"] = bots_copy
        enriched.append(srv_copy)
    return {"servers": enriched}


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
    # cascade : supprimer le groupe stoppe tous ses bots, oublie sa mémoire de monde
    # et supprime les secrets du groupe (libère le disque de l'Omen)
    stopped = mgr.stop_group(sid)
    mgr.forget_group(sid)
    mc_agent_secrets.delete_group_secrets(sid)
    return {"ok": True, "bots_stopped": stopped}


@router.post("/servers/{sid}/bots")
def create_bot(sid: str, payload: BotPayload, current_user: User = Depends(get_current_user)):
    """Ajoute un bot au roster du groupe (admin-only).

    Le secret est stocké séparément via mc_agent_secrets — il ne figure JAMAIS
    dans la réponse, même partiellement.
    """
    _require_admin(current_user)
    bot = servers_store.add_bot(sid, role=payload.role, username=payload.username, auth=payload.auth)
    if bot is None:
        raise HTTPException(status_code=400, detail="Bot invalide ou username deja present")
    if payload.secret:
        mc_agent_secrets.set_secret(sid, bot["id"], payload.secret)
    return {**bot, "has_secret": mc_agent_secrets.has_secret(sid, bot["id"])}


@router.delete("/servers/{sid}/bots/{bot_id}")
def delete_bot(sid: str, bot_id: str, current_user: User = Depends(get_current_user)):
    """Retire un bot du roster et supprime son secret (admin-only)."""
    _require_admin(current_user)
    if not servers_store.remove_bot(sid, bot_id):
        raise HTTPException(status_code=404, detail="Bot introuvable")
    mc_agent_secrets.delete_secret(sid, bot_id)
    return {"ok": True}


@router.get("/servers/{sid}/memory")
def server_memory(sid: str, current_user: User = Depends(get_current_user)):
    """Mémoire de monde d'un groupe (biomes/caves/finds par monde) pour la vue admin."""
    _require_admin(current_user)
    return world_memory.load(sid)
