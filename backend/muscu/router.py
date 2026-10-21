"""Coach Muscu : pont entre l'appli iPhone perso et Claude (clé dédiée, sans JWT)."""

import hmac
import logging
import subprocess
import time
from typing import List, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field, field_validator

from backend import llm_gateway as gw
from backend.muscu import store

logger = logging.getLogger("omenserver")

router = APIRouter(prefix="/api/muscu", tags=["muscu"])


class Message(BaseModel):
    role: str
    content: str = Field(..., min_length=1, max_length=4000)

    @field_validator("role")
    @classmethod
    def _role(cls, v):
        if v not in ("user", "assistant"):
            raise ValueError("role doit être 'user' ou 'assistant'")
        return v


class CoachRequest(BaseModel):
    system: str = Field("", max_length=20000)
    messages: List[Message] = Field(..., min_length=1, max_length=30)

    @field_validator("messages")
    @classmethod
    def _last_user(cls, v):
        if v[-1].role != "user":
            raise ValueError("le dernier message doit être de role 'user'")
        return v


def _check_key(provided: Optional[str]) -> None:
    key = store.load_key()
    if not key:
        raise HTTPException(status_code=503, detail="Clé serveur indisponible.")
    if not provided or not hmac.compare_digest(provided.encode("utf-8"), key.encode("utf-8")):
        raise HTTPException(status_code=401, detail="Clé invalide.")


def flatten(system: str, messages: List[Message]) -> str:
    """Conversation aplatie, finissant par le dernier message utilisateur."""
    lines = []
    for m in messages:
        who = "Utilisateur" if m.role == "user" else "Coach"
        lines.append("%s : %s" % (who, m.content))
    return "\n\n".join(lines)


def _cli_closure(system: str, prompt: str):
    def _cli() -> str:
        from backend.bots.paper import llm as pl
        full = (system.strip() + "\n\n" + prompt) if system.strip() else prompt
        return pl._cli_text(full, pl.DEFAULT_MODEL, 120, subprocess.run,
                            env=gw.cli_env())
    return _cli


@router.get("/ping")
def ping(x_muscu_key: Optional[str] = Header(None)):
    _check_key(x_muscu_key)
    return {"ok": True, "remaining_today": store.remaining_today()}


@router.post("/coach")
def coach(body: CoachRequest, x_muscu_key: Optional[str] = Header(None)):
    _check_key(x_muscu_key)
    ok, why, _ = store.reserve()
    if not ok:
        if why == "rate":
            raise HTTPException(status_code=429,
                                detail="Trop rapide : patiente quelques secondes.")
        raise HTTPException(status_code=429,
                            detail="Quota quotidien atteint (40 appels par jour).")
    prompt = flatten(body.system, body.messages)
    t0 = time.time()
    try:
        res = gw.complete(prompt, label="muscu_coach", tier="sonnet",
                          system=body.system or None, max_tokens=1200,
                          timeout=120, cli=_cli_closure(body.system, prompt))
    except gw.GatewayError:
        logger.warning("muscu: LLM sans réponse (prompt=%d car., %.1fs)",
                       len(prompt), time.time() - t0)
        raise HTTPException(status_code=502, detail="Le coach n'a pas répondu.")
    logger.info("muscu: ok via=%s prompt=%d car. réponse=%d car. %.1fs",
                res.backend, len(prompt), len(res.text), time.time() - t0)
    return {"text": res.text, "via": res.backend,
            "remaining_today": store.remaining_today()}
