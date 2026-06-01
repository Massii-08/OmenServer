"""
Profils serveur MC Agent : connexion + niveau d'intelligence + commandes disponibles.

Stdlib uniquement, persistance fichier JSON (pattern miroir de mc_agent_manager). Un profil
regroupe tout ce qu'il faut pour lancer le bot sur un serveur donné + la whitelist de commandes
que le serveur expose (le bot ne tapera que celles-là). Le catalogue prédéfini est livré dans
mc-agent/commands-catalog.json (source unique, lue aussi pour résoudre la whitelist effective).
"""
import json
import re
import secrets
from pathlib import Path

# backend/bots/mc_agent_servers.py → racine projet = parents[2]
_PROJECT_ROOT = Path(__file__).resolve().parents[2]
SERVERS_PATH = _PROJECT_ROOT / "data" / "mc_agent_servers.json"
CATALOG_PATH = _PROJECT_ROOT / "mc-agent" / "commands-catalog.json"

VALID_INTELLIGENCE = ("evident", "intermediaire", "expert")
VALID_AUTH = ("offline", "microsoft")
_SAFE_ID = re.compile(r"^[a-z0-9]+$")


def load_catalog():
    """Catalogue de commandes prédéfinies (source unique). [] si absent/illisible."""
    try:
        data = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return data if isinstance(data, list) else []


def _catalog_ids():
    return {c.get("id") for c in load_catalog() if isinstance(c, dict) and c.get("id")}


def load_servers():
    """Liste des profils serveur persistés. [] si fichier absent/illisible."""
    try:
        data = json.loads(SERVERS_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return data if isinstance(data, list) else []


def _save_servers(servers):
    SERVERS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SERVERS_PATH.write_text(json.dumps(servers, ensure_ascii=False, indent=2), encoding="utf-8")


def _gen_id(existing):
    """Id court [0-9a-f]{6}, unique dans `existing`."""
    for _ in range(50):
        cand = secrets.token_hex(3)
        if cand not in existing:
            return cand
    raise RuntimeError("id generation failed")


def _clean_custom(raw):
    """Garde les commandes custom valides (objet avec cmd commençant par /)."""
    out = []
    for c in raw or []:
        if isinstance(c, dict) and isinstance(c.get("cmd"), str) and c["cmd"].startswith("/"):
            out.append({
                "cmd": c["cmd"][:40],
                "syntax": str(c.get("syntax") or c["cmd"])[:80],
                "desc": str(c.get("desc") or "")[:160],
            })
    return out


def _clean_server(payload, sid):
    """Normalise/valide un payload de profil serveur (anti-injection, bornes, défauts sûrs)."""
    catalog_ids = _catalog_ids()
    commands = [c for c in (payload.get("commands") or []) if c in catalog_ids]
    intelligence = payload.get("intelligence")
    if intelligence not in VALID_INTELLIGENCE:
        intelligence = "intermediaire"
    auth = payload.get("auth")
    if auth not in VALID_AUTH:
        auth = "offline"
    try:
        port = int(payload.get("port") or 25565)
    except (TypeError, ValueError):
        port = 25565
    port = min(max(port, 1), 65535)
    return {
        "id": sid,
        "name": str(payload.get("name") or "Sans nom")[:60],
        "host": str(payload.get("host") or "")[:120],
        "port": port,
        "user": str(payload.get("user") or "TrainBot")[:48],
        "auth": auth,
        "intelligence": intelligence,
        "commands": commands,
        "custom": _clean_custom(payload.get("custom")),
    }


def create_server(payload):
    servers = load_servers()
    sid = _gen_id({s.get("id") for s in servers})
    server = _clean_server(payload, sid)
    servers.append(server)
    _save_servers(servers)
    return server


def update_server(sid, payload):
    if not _SAFE_ID.match(str(sid or "")):
        return None
    servers = load_servers()
    for i, s in enumerate(servers):
        if s.get("id") == sid:
            servers[i] = _clean_server(payload, sid)
            _save_servers(servers)
            return servers[i]
    return None


def delete_server(sid):
    if not _SAFE_ID.match(str(sid or "")):
        return False
    servers = load_servers()
    kept = [s for s in servers if s.get("id") != sid]
    if len(kept) == len(servers):
        return False
    _save_servers(kept)
    return True


def get_server(sid):
    for s in load_servers():
        if s.get("id") == sid:
            return s
    return None


def resolve_commands(server):
    """Profil → liste d'objets {cmd,syntax,desc} pour le bot (catalogue coché + custom)."""
    by_id = {c["id"]: c for c in load_catalog() if isinstance(c, dict) and c.get("id")}
    out = []
    for cid in server.get("commands", []):
        c = by_id.get(cid)
        if c:
            out.append({"cmd": c["cmd"], "syntax": c.get("syntax", c["cmd"]), "desc": c.get("desc", "")})
    for c in server.get("custom", []):
        out.append({"cmd": c["cmd"], "syntax": c.get("syntax", c["cmd"]), "desc": c.get("desc", "")})
    return out
