"""
Stockage des secrets par bot (mot de passe AuthMe, token…), par groupe.

Chaque groupe possède un fichier JSON dédié :
    SECRETS_DIR/<group_id>.json  →  {bot_id: secret}

Accès strictement hors API — les fonctions publiques ne logguent rien et
les secrets ne doivent jamais apparaître dans des exceptions ou repr.

Toutes les fonctions qui écrivent appliquent os.chmod(path, 0o600) après
chaque écriture pour garantir que le fichier reste lisible par le seul
process propriétaire.
"""
import json
import os
import re
from pathlib import Path

# backend/bots/mc_agent_secrets.py → racine projet = parents[2]
_PROJECT_ROOT = Path(__file__).resolve().parents[2]

SECRETS_DIR = _PROJECT_ROOT / "data" / "mc_agent_secrets"

# Seuls les identifiants [a-z0-9]+ sont autorisés (anti path-traversal)
_SAFE_ID = re.compile(r"^[a-z0-9]+$")

_SECRET_MAX_LEN = 256


# ---------------------------------------------------------------------------
# Helpers internes
# ---------------------------------------------------------------------------

def _path(group_id):
    """Retourne le Path du fichier JSON du groupe (sans valider l'id)."""
    return SECRETS_DIR / (group_id + ".json")


def _valid_id(value):
    """Vrai si value est une chaîne non vide matchant _SAFE_ID."""
    return isinstance(value, str) and bool(_SAFE_ID.match(value))


def _valid_secret(value):
    """Vrai si value est une chaîne non vide de longueur raisonnable."""
    return isinstance(value, str) and 1 <= len(value) <= _SECRET_MAX_LEN


def _load(group_id):
    """Lit le dictionnaire {bot_id: secret} du groupe. {} si absent ou corrompu."""
    p = _path(group_id)
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except (OSError, ValueError):
        pass
    return {}


def _write(group_id, data):
    """Écrit le dictionnaire et applique chmod 600."""
    p = _path(group_id)
    SECRETS_DIR.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.chmod(p, 0o600)


# ---------------------------------------------------------------------------
# API publique
# ---------------------------------------------------------------------------

def set_secret(group_id, bot_id, secret):
    """Enregistre le secret du bot dans le groupe.

    Retourne True si l'écriture a réussi, False si un identifiant est invalide
    ou si le secret ne satisfait pas les contraintes (non vide, ≤ 256 car.).
    """
    if not _valid_id(group_id) or not _valid_id(bot_id) or not _valid_secret(secret):
        return False
    data = _load(group_id)
    data[bot_id] = secret
    _write(group_id, data)
    return True


def get_secret(group_id, bot_id):
    """Retourne le secret du bot dans le groupe, ou None si absent / ids invalides."""
    if not _valid_id(group_id) or not _valid_id(bot_id):
        return None
    return _load(group_id).get(bot_id)


def has_secret(group_id, bot_id):
    """Vrai si un secret existe pour ce bot dans ce groupe."""
    if not _valid_id(group_id) or not _valid_id(bot_id):
        return False
    return bot_id in _load(group_id)


def delete_secret(group_id, bot_id):
    """Retire l'entrée du bot dans le fichier du groupe.

    Retourne True si l'entrée existait et a été supprimée, False sinon
    (ids invalides, groupe absent, bot absent).
    """
    if not _valid_id(group_id) or not _valid_id(bot_id):
        return False
    data = _load(group_id)
    if bot_id not in data:
        return False
    del data[bot_id]
    _write(group_id, data)
    return True


def delete_group_secrets(group_id):
    """Supprime le fichier JSON du groupe (cascade suppression de groupe).

    Retourne True si le fichier existait et a été supprimé, False sinon
    (id invalide ou groupe absent).
    """
    if not _valid_id(group_id):
        return False
    p = _path(group_id)
    if not p.exists():
        return False
    p.unlink()
    return True
