"""Config Telegram persistante (token + chat_id) posée depuis l'UI — pas le .env,
pas le code. Stockée côté serveur dans ``data/harvester_telegram.json`` en chmod
600 (même posture que unblocker_config / les secrets).

🔒 Le token brut ne sort JAMAIS par l'API : ``public_view`` le masque. Le path est
injectable (``DEFAULT_PATH`` surchargeable) -> tests offline."""
import json
import os
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
DEFAULT_PATH = str(_PROJECT_ROOT / "data" / "harvester_telegram.json")


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
    """Écrit la config. Le token est un secret -> le fichier NAÎT en 0o600
    (création atomique via ``os.open``, pas de fenêtre world-readable) ;
    ``os.fchmod`` couvre un fichier pré-existant aux autres permissions."""
    p = Path(path or DEFAULT_PATH)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(p), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)
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
    """Vue SANS le token brut (masqué) -> sûre à renvoyer par l'API."""
    token = cfg.get("token") or ""
    if len(token) >= 4:
        masked = "····" + token[-4:]
    elif token:
        masked = "····"
    else:
        masked = ""
    return {
        "configured": bool(token and cfg.get("chat_id")),
        "chat_id": cfg.get("chat_id", ""),
        "token_masked": masked,
    }
