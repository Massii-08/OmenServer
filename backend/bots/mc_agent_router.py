"""Router MC Agent — pilotage du bot Minecraft d'entrainement (admin-only)."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

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
    bot_id: Optional[str] = None    # si fourni (avec server_id) : lance ce compte du roster
    language: str = "fr"            # langue du champ reply LLM : fr | en | it
    autonomous: bool = False        # True → lance la boucle planner au spawn (0 LLM)
    objective: str = "stone_pickaxe"  # objectif autonome : stone_pickaxe | iron_pickaxe | diamond | iron_armor | diamond_armor | mapper | resource
    world_label: Optional[str] = None  # clé de monde explicite (ex. "mining") — sinon dimension auto
    quota: Optional[dict] = None    # mode quota (objectif resource) : {diamond|gold|redstone|lapis|iron: n>0}
    humanize: Optional[bool] = None # force l'humanisation complète (clone clips/idle) ; None = défaut du mode
    confine: Optional[str] = None   # "X Z R" → garde le bot dans R blocs de l'ancre (test arène ; cf. confine.js)
    no_give: Optional[bool] = None  # True → ZÉRO /give côté bot (run nether : tout est miné/fondu/crafté)
    regroup: Optional[bool] = None  # True → après une mort, /tpa vers le groupe tant que l'armure fer manque


class SayReq(BaseModel):
    message: str


class MappersStartReq(BaseModel):
    count: int = Field(default=1, ge=1, le=20)


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
    kit_command: str = ""
    has_login: bool = False
    login_command: str = "/login {pwd}"


class BotPayload(BaseModel):
    """Payload de création d'un bot dans un groupe (roster).

    Le champ `secret` (mot de passe AuthMe, token…) est stocké séparément
    et ne doit JAMAIS être renvoyé dans les réponses API.
    """
    role: str = "worker"
    username: str
    auth: str = "offline"
    secret: Optional[str] = None  # stocké via mc_agent_secrets, jamais réémis


_QUOTA_TYPES = ("diamond", "gold", "redstone", "lapis", "iron")


def _clean_quota(quota):
    """Filtre le quota demandé : types connus uniquement, valeurs int > 0. None si vide.

    Lève ValueError si une valeur d'un type CONNU est invalide (mieux qu'un échec silencieux
    côté bot) ; les types inconnus sont simplement ignorés."""
    if not quota:
        return None
    out = {}
    for t in _QUOTA_TYPES:
        if t not in quota:
            continue
        try:
            v = int(quota[t])
        except (TypeError, ValueError):
            raise ValueError(f"Quota invalide pour {t}")
        if v <= 0:
            raise ValueError(f"Quota invalide pour {t} (doit etre > 0)")
        out[t] = v
    return out or None


@router.post("/run")
def run(req: StartReq, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    if not mgr.has_api_key():
        raise HTTPException(status_code=400, detail="Aucune cle Claude configuree (renseigne-la dans le bot)")
    try:
        quota = _clean_quota(req.quota)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    # Lancement par compte du roster : résolution complète côté manager (groupe + bot + login).
    if req.server_id and req.bot_id:
        try:
            # quota passé seulement si présent (rétro-compat monkeypatchs/tests existants)
            extra = {"quota": quota} if quota else {}
            if req.humanize is not None:
                extra["humanize"] = bool(req.humanize)  # clone complet sur bot resource (clips/idle)
            if req.confine:
                extra["confine"] = req.confine  # arène : garder le bot dans R de l'ancre
            if req.no_give:
                extra["no_give"] = True  # run sans /give (rétro-compat : passé seulement si actif)
            if req.regroup:
                extra["regroup"] = True  # regroupement après mort (idem : seulement si demandé)
            sid = mgr.start_for_bot(req.server_id, req.bot_id, model=req.model,
                                    autonomous=req.autonomous, objective=req.objective,
                                    world_label=req.world_label, **extra)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"Impossible de demarrer Node : {exc}")
        return {"session_id": sid}
    host, port, user = req.host, req.port, req.user
    auth, profile, commands, policy = req.auth, req.profile, None, None
    language = req.language
    stealth = False
    if req.server_id:
        srv = servers_store.get_server(req.server_id)
        if not srv:
            raise HTTPException(status_code=404, detail="Profil serveur introuvable")
        host, port, user = srv["host"], srv["port"], srv["user"]
        auth, profile = srv["auth"], srv["intelligence"]
        language = srv.get("language", "fr")
        stealth = bool(srv.get("stealth"))
        commands = servers_store.resolve_commands(srv)
        policy = servers_store.resolve_policy(srv)
    if not host:
        raise HTTPException(status_code=400, detail="host requis (ou choisis un profil serveur)")
    auth = auth if auth in ("offline", "microsoft") else "offline"
    try:
        extra = {"quota": quota} if quota else {}
        if stealth:
            extra["stealth"] = True  # passé seulement si actif (rétro-compat monkeypatchs/tests)
        if req.humanize is not None:
            extra["humanize"] = bool(req.humanize)
        if req.confine:
            extra["confine"] = req.confine  # arène : garder le bot dans R de l'ancre
        if req.no_give:
            extra["no_give"] = True  # run sans /give (rétro-compat : passé seulement si actif)
        if req.regroup:
            extra["regroup"] = True  # regroupement après mort (idem : seulement si demandé)
        sid = mgr.start_session(host, port, user, req.model, auth, profile, commands, policy, server_id=req.server_id, language=language, autonomous=req.autonomous, objective=req.objective, world_label=req.world_label, **extra)
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


@router.get("/events/{sid}")
def events(sid: int, current_user: User = Depends(get_current_user)):
    """Events bruts d'une session (telemetrie ore_approach/tunnel_result/quota_*) — debug admin."""
    _require_admin(current_user)
    s = mgr._sessions.get(sid)
    if not s:
        raise HTTPException(status_code=404, detail="Session introuvable")
    return {"events": list(s.get("events", []))[-200:]}


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


@router.post("/servers/{sid}/mappers/start")
def start_mappers(sid: str, req: MappersStartReq, current_user: User = Depends(get_current_user)):
    """Lance N cartographes du roster du groupe (secteurs auto, cap au nb dispo). Admin-only."""
    _require_admin(current_user)
    if not mgr.has_api_key():
        raise HTTPException(status_code=400, detail="Aucune cle Claude configuree (renseigne-la dans le bot)")
    try:
        return mgr.start_mappers(sid, req.count)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Impossible de demarrer Node : {exc}")


@router.get("/servers/{sid}/memory")
def server_memory(sid: str, current_user: User = Depends(get_current_user)):
    """Mémoire de monde d'un groupe (biomes/caves/finds par monde) pour la vue admin."""
    _require_admin(current_user)
    mgr.flush_world_memory(sid)   # le debounce d'écriture ne doit pas faire mentir la carte
    return world_memory.load(sid)
