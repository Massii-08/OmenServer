"""Router MC Agent — pilotage du bot Minecraft d'entrainement (admin-only)."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from backend.auth.utils import get_current_user
from backend.auth.models import User
from backend.bots import mc_agent_manager as mgr

router = APIRouter(prefix="/api/mc-agent", tags=["mc-agent"])


def _require_admin(user):
    if not getattr(user, "is_admin", False):
        raise HTTPException(status_code=403, detail="Admin uniquement")


class StartReq(BaseModel):
    host: str                       # IP ou domaine du serveur MC
    port: int = 25565
    user: str = "TrainBot"          # pseudo (offline) OU email du compte (microsoft)
    auth: str = "offline"           # "offline" | "microsoft"
    model: Optional[str] = None     # Python 3.9 : pas de `str | None` (piège #1)


class SayReq(BaseModel):
    message: str


class ApiKeyPayload(BaseModel):
    key: str


@router.post("/run")
def run(req: StartReq, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    if not mgr.has_api_key():
        raise HTTPException(status_code=400, detail="Aucune cle Claude configuree (renseigne-la dans le bot)")
    auth = req.auth if req.auth in ("offline", "microsoft") else "offline"
    try:
        sid = mgr.start_session(req.host, req.port, req.user, req.model, auth)
    except OSError as exc:
        # ex: Node introuvable (FileNotFoundError) — message propre, pas de traceback en réponse
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
