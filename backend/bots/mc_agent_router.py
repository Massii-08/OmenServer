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
    host: str
    port: int = 25565
    user: str = "TrainBot"
    model: Optional[str] = None  # Python 3.9 : pas de `str | None` (piège #1)


class SayReq(BaseModel):
    message: str


@router.post("/run")
def run(req: StartReq, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    if not mgr.has_api_key():
        raise HTTPException(status_code=400, detail="ANTHROPIC_API_KEY absente de l'environnement")
    sid = mgr.start_session(req.host, req.port, req.user, req.model)
    return {"session_id": sid}


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
