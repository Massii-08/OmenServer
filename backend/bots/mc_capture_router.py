"""Router d'ingestion des captures comportementales — Phase 1b.

Gating fin (Phase 1b.4) :
- upload / list / suppression d'UNE session = permission ``mc_capture`` (admin OU rôle
  ``rectester``), avec filtrage par owner pour les non-admins (chacun ne voit/supprime
  que SES propres captures).
- distillation / style / suppression d'un joueur ENTIER = admin strict (inchangé).
- téléchargement du mod client (liste + jar) = permission ``mc_capture``, whitelist de
  versions (pas de path-traversal possible).
"""
import json
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse

from backend.auth.utils import get_current_user
from backend.auth.models import User
from backend.auth.permissions import has_permission
from backend.bots import mc_capture_store as store
from backend.bots import mc_capture_distill as distill

router = APIRouter(prefix="/api/mc-agent", tags=["mc-agent-capture"])

_MAX_BYTES = 200 * 1024 * 1024  # 200 Mo : large (équipe × ~5h compressé reste sous ça)

# backend/bots/mc_capture_router.py → racine projet = parents[2]
_MOD_DIST = Path(__file__).resolve().parents[2] / "mc-capture-mod" / "dist"
# Versions Fabric MC pour lesquelles on builde le mod. La fonction
# ``list_mod_versions`` filtre par ``Path.is_file()``, donc une version listée ici
# mais dont le jar n'a pas encore été buildé est silencieusement absente côté API
# (zéro régression côté UI). Pour builder une version manquante :
#     cd mc-capture-mod && ./build-all-versions.sh 1.20.4
# (sans argument = builde TOUTES les versions de la matrice).
_MOD_JARS = {
    # 1.20.x — Java 17
    "1.20.1": "mc-capture-0.1.0-mc1.20.1.jar",
    "1.20.4": "mc-capture-0.1.0-mc1.20.4.jar",
    "1.20.6": "mc-capture-0.1.0-mc1.20.6.jar",
    # 1.21.x — Java 21
    "1.21":   "mc-capture-0.1.0-mc1.21.jar",
    "1.21.1": "mc-capture-0.1.0-mc1.21.1.jar",
    "1.21.4": "mc-capture-0.1.0-mc1.21.4.jar",
    "1.21.5": "mc-capture-0.1.0-mc1.21.5.jar",
}


def _require_admin(user):
    if not getattr(user, "is_admin", False):
        raise HTTPException(status_code=403, detail="Admin uniquement")


def _require_capture(user):
    if not has_permission(user, "mc_capture"):
        raise HTTPException(status_code=403, detail="Accès capture refusé")


def _owner_filter(user):
    """None pour un admin (voit tout) ; sinon le compte courant (filtrage owner)."""
    return None if getattr(user, "is_admin", False) else getattr(user, "username", None)


@router.post("/captures")
async def upload_capture(file: UploadFile = File(...), current_user: User = Depends(get_current_user)):
    """Upload manuel d'une capture .jsonl(.gz). Le joueur vient du header (attribution auto)."""
    _require_capture(current_user)
    payload = await file.read()
    if len(payload) > _MAX_BYTES:
        raise HTTPException(status_code=413, detail="Fichier trop volumineux")
    try:
        info = store.save_capture(payload, file.filename, owner=getattr(current_user, "username", None))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Capture invalide : {exc}")
    return info


@router.get("/captures")
def list_captures(current_user: User = Depends(get_current_user)):
    _require_capture(current_user)
    return {"captures": store.list_captures(owner=_owner_filter(current_user))}


@router.get("/mod")
def list_mod_versions(current_user: User = Depends(get_current_user)):
    """Liste les versions du mod client disponibles au téléchargement."""
    _require_capture(current_user)
    return {"versions": [{"version": v, "file": f}
                         for v, f in _MOD_JARS.items() if (_MOD_DIST / f).is_file()]}


@router.get("/mod/{version}")
def download_mod(version: str, current_user: User = Depends(get_current_user)):
    """Télécharge le .jar du mod pour une version whitelistée (anti path-traversal)."""
    _require_capture(current_user)
    jar = _MOD_JARS.get(version)
    if not jar:
        raise HTTPException(status_code=404, detail="Version inconnue")
    path = _MOD_DIST / jar
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Jar introuvable (à builder)")
    return FileResponse(str(path), media_type="application/java-archive", filename=jar)


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


@router.delete("/captures/{player}/{filename}")
def delete_session(player: str, filename: str, current_user: User = Depends(get_current_user)):
    """Supprime UNE session. Owner-gated : un non-admin ne peut effacer que ses captures."""
    _require_capture(current_user)
    if not store.delete_capture(player, filename, requester=_owner_filter(current_user)):
        raise HTTPException(status_code=403, detail="Suppression refusée (pas ta capture)")
    return {"ok": True}


@router.delete("/captures/{player}")
def delete_player(player: str, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    if not store.delete_capture(player, None):
        raise HTTPException(status_code=404, detail="Joueur inconnu")
    return {"ok": True}
