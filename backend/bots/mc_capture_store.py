"""
Stockage des captures comportementales (Phase 1b.1).

Range les fichiers .jsonl uploadés (manuellement, depuis le dashboard admin) sous
data/mc-captures/<joueur>/. Le <joueur> vient TOUJOURS du header du fichier (jamais
d'un champ libre UI) → attribution automatique même si un seul admin uploade pour
toute l'équipe. Stdlib uniquement. Pattern de chemins miroir de mc_agent_manager.
"""
import json
import re
import shutil
from pathlib import Path

# backend/bots/mc_capture_store.py → racine projet = parents[2]
_PROJECT_ROOT = Path(__file__).resolve().parents[2]
CAPTURES_DIR = _PROJECT_ROOT / "data" / "mc-captures"

SCHEMA_VERSION = 1
_SAFE_NAME = re.compile(r"[^A-Za-z0-9_.-]")


def _safe_player(name):
    """Réduit un pseudo à un nom de dossier sûr (anti path-traversal)."""
    cleaned = _SAFE_NAME.sub("_", str(name or "").strip())
    # anti path-traversal : aucune séquence ".." ne doit survivre, même interne
    # (ex. "../../etc" → "_.._etc" garderait ".." sinon).
    cleaned = re.sub(r"\.{2,}", ".", cleaned)
    cleaned = cleaned.strip(".") or "unknown"
    return cleaned[:64]


def parse_header(payload):
    """Lit et valide la 1re ligne JSON (header) d'une capture. Throw ValueError si invalide."""
    if not payload:
        raise ValueError("capture vide")
    first = payload.split(b"\n", 1)[0].strip()
    if not first:
        raise ValueError("header manquant")
    try:
        header = json.loads(first.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError(f"header illisible: {exc}")
    if not isinstance(header, dict):
        raise ValueError("header doit être un objet JSON")
    if header.get("schema") != SCHEMA_VERSION:
        raise ValueError(f"schema attendu {SCHEMA_VERSION}, reçu {header.get('schema')}")
    if not header.get("player"):
        raise ValueError("header.player requis")
    if header.get("consent") is not True:
        raise ValueError("consent must be true (capture non consentie refusée)")
    return header


def save_capture(payload, filename, owner=None):
    """Valide le header, range le fichier sous data/mc-captures/<player>/. Retourne un info dict.

    owner = compte OmenServer uploadeur (distinct du pseudo MC du header). Si fourni, on
    écrit un sidecar `<fichier>.owner` à côté de la capture → permet « chacun voit ses
    propres captures, admin voit tout ».
    """
    header = parse_header(payload)
    player = _safe_player(header["player"])
    safe_file = _SAFE_NAME.sub("_", str(filename or "session.jsonl"))
    if not safe_file.endswith((".jsonl", ".jsonl.gz")):
        safe_file += ".jsonl"
    target_dir = CAPTURES_DIR / player
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / safe_file
    target.write_bytes(payload)
    if owner:
        (target_dir / (safe_file + ".owner")).write_text(str(owner), encoding="utf-8")
    return {"player": player, "file": safe_file, "bytes": len(payload),
            "owner": owner, "mc": header.get("mc"), "startedAt": header.get("startedAt")}


def _session_owner(player_dir, session_file):
    """Lit le compte uploadeur d'une session (sidecar .owner), ou None si absent."""
    owner_path = player_dir / (session_file + ".owner")
    try:
        return owner_path.read_text(encoding="utf-8").strip() if owner_path.is_file() else None
    except OSError:
        return None


def list_captures(owner=None):
    """Liste les captures groupées par joueur : [{player, sessions, bytes, files}].

    owner=None → tout (admin) ; sinon → uniquement les sessions uploadées par ce compte
    (filtrées via le sidecar .owner). Ne compte JAMAIS les sidecars .owner comme sessions.
    """
    if not CAPTURES_DIR.is_dir():
        return []
    out = []
    for player_dir in sorted(CAPTURES_DIR.iterdir()):
        if not player_dir.is_dir():
            continue
        files = [f for f in player_dir.iterdir() if f.suffix in (".jsonl", ".gz")]
        if owner is not None:
            files = [f for f in files if _session_owner(player_dir, f.name) == owner]
        if not files:
            continue
        out.append({
            "player": player_dir.name,
            "sessions": len(files),
            "bytes": sum(f.stat().st_size for f in files),
            "files": sorted(f.name for f in files),
        })
    return out


def delete_capture(player, filename, requester=None):
    """Supprime une session (filename donné) ou tout un joueur (filename=None). False si absent.

    requester=None → admin (aucune vérif d'owner). Sinon → la suppression d'une session
    n'est autorisée que si `requester` est l'owner enregistré (sidecar .owner). La
    suppression d'un joueur entier (filename=None) reste réservée à l'admin.
    """
    safe = _safe_player(player)
    player_dir = CAPTURES_DIR / safe
    if not player_dir.is_dir():
        return False
    if filename is None:
        if requester is not None:
            return False
        shutil.rmtree(player_dir)
        return True
    target = player_dir / _SAFE_NAME.sub("_", str(filename))
    if not target.is_file():
        return False
    if requester is not None and _session_owner(player_dir, target.name) != requester:
        return False
    target.unlink()
    owner_sidecar = player_dir / (target.name + ".owner")
    if owner_sidecar.is_file():
        owner_sidecar.unlink()
    return True
