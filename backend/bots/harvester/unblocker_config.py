"""Config PERSISTANTE du tier débloqueur — posée depuis l'UI du bot (pas le
.env, pas le code). Stockée côté serveur dans ``data/harvester_unblocker.json``
en chmod 600 (même posture que config.json / les secrets).

🔒 La clé brute ne sort JAMAIS par l'API : ``public_view`` la masque. Le path est
injectable (``DEFAULT_PATH`` surchargeable) -> tests offline.
"""
import json
import os
from pathlib import Path

# backend/bots/harvester/unblocker_config.py -> remonte à la racine projet -> data/
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
DEFAULT_PATH = str(_PROJECT_ROOT / "data" / "harvester_unblocker.json")


def load(path=None):
    """Charge la config (dict) ; {} si absente/illisible/corrompue."""
    p = Path(path or DEFAULT_PATH)
    if not p.is_file():
        return {}
    try:
        with open(str(p), "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def save(cfg, path=None):
    """Écrit la config. La clé est un secret -> le fichier NAÎT en 0o600
    (création atomique via ``os.open``, pas de fenêtre world-readable), et
    ``os.fchmod`` couvre le cas d'un fichier pré-existant aux autres permissions."""
    p = Path(path or DEFAULT_PATH)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(p), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)        # fichier pré-existant -> force 0o600 sans race
    except (AttributeError, OSError):
        pass
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def clear(path=None):
    """Supprime la config (idempotent : pas d'erreur si déjà absente)."""
    p = Path(path or DEFAULT_PATH)
    try:
        p.unlink()
    except OSError:
        pass


def public_view(cfg):
    """Vue SANS la clé brute (masquée) -> sûre à renvoyer par l'API."""
    key = cfg.get("key") or ""
    if len(key) >= 4:
        masked = "····" + key[-4:]
    elif key:
        masked = "····"
    else:
        masked = ""
    return {
        "configured": bool(cfg.get("endpoint") and key),
        "endpoint": cfg.get("endpoint", ""),
        "render_js": bool(cfg.get("render_js", False)),
        "method": cfg.get("method", "POST"),
        "key_in": cfg.get("key_in", "body"),
        "key_param": cfg.get("key_param", "apikey"),
        "result_field": cfg.get("result_field", ""),
        "key_masked": masked,
    }
