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
VALID_LANGUAGE = ("fr", "en", "it")
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


def _migrate(server):
    """Ajoute bots[0] depuis `user` si la clé 'bots' est absente (legacy). Idempotent."""
    if "bots" in server:
        return server, False
    server["bots"] = [{"id": _gen_id(set()), "role": "worker",
                       "username": str(server.get("user") or "TrainBot")[:48],
                       "auth": server.get("auth") if server.get("auth") in VALID_AUTH else "offline"}]
    return server, True


def load_servers():
    """Liste des profils serveur persistés. [] si fichier absent/illisible."""
    try:
        data = json.loads(SERVERS_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(data, list):
        return []
    changed = False
    for i, item in enumerate(data):
        if isinstance(item, dict):
            data[i], migrated = _migrate(item)
            if migrated:
                changed = True
    if changed:
        _save_servers(data)
    return data


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


VALID_ROLE = ("worker", "mapper")


def _clean_bots(raw):
    """Roster : liste de {id, role, username, auth}. Ignore les entrées invalides, cap 20."""
    out, seen = [], set()
    for b in raw or []:
        if not isinstance(b, dict):
            continue
        username = str(b.get("username") or "").strip()[:48]
        if not username:
            continue
        role = b.get("role") if b.get("role") in VALID_ROLE else "worker"
        auth = b.get("auth") if b.get("auth") in VALID_AUTH else "offline"
        bid = str(b.get("id") or "")
        if not _SAFE_ID.match(bid):
            bid = _gen_id(seen)
        if bid in seen:
            continue
        seen.add(bid)
        out.append({"id": bid, "role": role, "username": username, "auth": auth})
        if len(out) >= 20:
            break
    return out


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


def _clean_trusted(raw):
    """Liste de pseudos de confiance : strings trim, dédup insensible casse, cap 50/32 car."""
    out, seen = [], set()
    for u in raw or []:
        if not isinstance(u, str):
            continue
        name = u.strip()[:32]
        key = name.lower()
        if name and key not in seen:
            seen.add(key)
            out.append(name)
        if len(out) >= 50:
            break
    return out


def _clean_trade(raw):
    """Config trade optionnelle : {acceptCmd, requestPattern} ; None si pas d'acceptCmd."""
    if not isinstance(raw, dict):
        return None
    accept = raw.get("acceptCmd")
    if not isinstance(accept, str) or not accept.strip():
        return None
    return {"acceptCmd": accept.strip()[:60], "requestPattern": str(raw.get("requestPattern") or "")[:200]}


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
    language = payload.get("language")
    if language not in VALID_LANGUAGE:
        language = "fr"
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
        "language": language,
        # Mode furtif (phase 3) : humanisation (latence chat, loiter, jitter explore) — OFF par
        # défaut, les bots utilitaires vont à vitesse machine. Toggle gardé pour plus tard.
        "stealth": bool(payload.get("stealth")),
        "commands": commands,
        "custom": _clean_custom(payload.get("custom")),
        "trusted": _clean_trusted(payload.get("trusted")),
        "trade": _clean_trade(payload.get("trade")),
        "has_login": bool(payload.get("has_login")),
        "login_command": str(payload.get("login_command") or "/login {pwd}")[:60],
        "bots": _clean_bots(payload.get("bots")),
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
            updated = _clean_server(payload, sid)
            # Préserve le roster existant si le payload ne transporte pas de clé 'bots'
            if "bots" not in payload:
                updated["bots"] = s.get("bots", [])
            servers[i] = updated
            _save_servers(servers)
            return servers[i]
    return None


def add_bot(sid, role=None, username=None, auth=None):
    """Ajoute un bot au roster du groupe. Retourne le bot créé, ou None si invalide/doublon."""
    if not _SAFE_ID.match(str(sid or "")):
        return None
    servers = load_servers()
    for i, s in enumerate(servers):
        if s.get("id") != sid:
            continue
        entry = _clean_bots([{"role": role, "username": username, "auth": auth}])
        if not entry:
            return None
        bot = entry[0]
        roster = s.get("bots", [])
        # Anti-doublon insensible à la casse
        existing_names = {b.get("username", "").lower() for b in roster}
        if bot["username"].lower() in existing_names:
            return None
        # Id unique par rapport aux ids déjà présents dans le roster
        existing_ids = {b.get("id") for b in roster}
        bot["id"] = _gen_id(existing_ids)
        roster.append(bot)
        servers[i]["bots"] = roster
        _save_servers(servers)
        return bot
    return None


def remove_bot(sid, bot_id):
    """Retire un bot du roster du groupe. Retourne True si supprimé, False sinon."""
    if not _SAFE_ID.match(str(sid or "")):
        return False
    servers = load_servers()
    for i, s in enumerate(servers):
        if s.get("id") != sid:
            continue
        roster = s.get("bots", [])
        new_roster = [b for b in roster if b.get("id") != bot_id]
        if len(new_roster) == len(roster):
            return False
        servers[i]["bots"] = new_roster
        _save_servers(servers)
        return True
    return False


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


def resolve_policy(server):
    """Profil → policy {trusted, trade, kit_command} pour le bot (gating + auto-accept + survie)."""
    return {
        "trusted": server.get("trusted", []),
        "trade": server.get("trade"),
        "kit_command": server.get("kit_command", "") or "",
    }
