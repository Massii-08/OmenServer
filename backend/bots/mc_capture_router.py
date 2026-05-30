"""Router d'ingestion des captures comportementales (admin-only) — Phase 1b.1."""
import json
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File

from backend.auth.utils import get_current_user
from backend.auth.models import User
from backend.bots import mc_capture_store as store
from backend.bots import mc_capture_distill as distill

router = APIRouter(prefix="/api/mc-agent", tags=["mc-agent-capture"])

_MAX_BYTES = 200 * 1024 * 1024  # 200 Mo : large (équipe × ~5h compressé reste sous ça)


def _require_admin(user):
    if not getattr(user, "is_admin", False):
        raise HTTPException(status_code=403, detail="Admin uniquement")


@router.post("/captures")
async def upload_capture(file: UploadFile = File(...), current_user: User = Depends(get_current_user)):
    """Upload manuel d'une capture .jsonl(.gz). Le joueur vient du header (attribution auto)."""
    _require_admin(current_user)
    payload = await file.read()
    if len(payload) > _MAX_BYTES:
        raise HTTPException(status_code=413, detail="Fichier trop volumineux")
    try:
        info = store.save_capture(payload, file.filename)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Capture invalide : {exc}")
    return info


@router.get("/captures")
def list_captures(current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    return {"captures": store.list_captures()}


@router.post("/captures/{player}/distill")
def distill_player(player: str, current_user: User = Depends(get_current_user)):
    """(Re)calcule style.json + clips/ pour un joueur depuis toutes ses sessions."""
    _require_admin(current_user)
    player_dir = store.CAPTURES_DIR / store._safe_player(player)
    if not player_dir.is_dir():
        raise HTTPException(status_code=404, detail="Joueur inconnu")
    payloads = [f.read_bytes() for f in sorted(player_dir.iterdir())
                if f.suffix in (".jsonl", ".gz")]
    style = distill.distill_style(payloads, player=player_dir.name)
    (player_dir / "style.json").write_text(json.dumps(style, ensure_ascii=False, indent=2), encoding="utf-8")

    clips_dir = player_dir / "clips"
    clips_dir.mkdir(exist_ok=True)
    total_clips = 0
    for payload in payloads:
        _, records = distill.load_records(payload)
        for clip in distill.segment_clips(records, player=player_dir.name):
            (clips_dir / f"{total_clips:05d}.json").write_text(
                json.dumps(clip, ensure_ascii=False), encoding="utf-8")
            total_clips += 1
    return {"player": player_dir.name, "clips": total_clips, "style": style}


@router.get("/captures/{player}/style")
def get_style(player: str, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    style_path = store.CAPTURES_DIR / store._safe_player(player) / "style.json"
    if not style_path.is_file():
        raise HTTPException(status_code=404, detail="Pas de style (lancer la distillation)")
    return json.loads(style_path.read_text(encoding="utf-8"))


@router.delete("/captures/{player}")
def delete_player(player: str, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    if not store.delete_capture(player, None):
        raise HTTPException(status_code=404, detail="Joueur inconnu")
    return {"ok": True}
