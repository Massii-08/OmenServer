"""
Gestionnaire de sessions MC Agent.

Spawn le process Node (mc-agent/index.js) en subprocess détaché, lit son stdout
ligne-par-ligne (events JSON), maintient un registre de sessions en mémoire, et
permet de piloter chaque session (stop, say). Pattern miroir de Yield/Scanner.
"""
import json
import os
import signal
import subprocess
import threading
from datetime import datetime, timezone
from pathlib import Path

from . import mc_agent_world_memory as world_memory

# backend/bots/mc_agent_manager.py → racine projet = parents[2], puis mc-agent/
_PROJECT_ROOT = Path(__file__).resolve().parents[2]
MC_AGENT_DIR = _PROJECT_ROOT / "mc-agent"
# Fichiers temp de whitelist de commandes par session (dossier propre au bot, PAS data/servers/).
RUNS_DIR = _PROJECT_ROOT / "data" / "mc_agent_runs"
# Clé Claude posée depuis le dashboard (gitignored, chmod 600). La var d'env prime.
API_KEY_PATH = _PROJECT_ROOT / "data" / "secrets" / "anthropic.key"

_sessions = {}        # session_id (int) -> dict
_lock = threading.Lock()
_counter = 0

# Mémoire de monde partagée par groupe (server_id) : cache en mémoire + verrou (un seul écrivain,
# le process backend). Les events bot biome_seen/cave_found/material_found y sont routés.
_WM_EVENTS = ("biome_seen", "cave_found", "material_found")
_wm_lock = threading.Lock()
_wm_cache = {}        # group_id -> memory dict


def _mask_key(key):
    """Masque une clé pour l'affichage (jamais révélée en clair)."""
    if not key or len(key) < 12:
        return "***"
    return f"{key[:8]}…{key[-4:]}"


def _read_api_key():
    """Clé Claude effective : var d'env (prioritaire) sinon fichier secret, sinon ''."""
    env_key = os.environ.get("ANTHROPIC_API_KEY")
    if env_key:
        return env_key.strip()
    try:
        if API_KEY_PATH.is_file():
            return API_KEY_PATH.read_text(encoding="utf-8").strip()
    except OSError:
        pass
    return ""


def get_api_key_status():
    """État de la clé pour le dashboard (sans la révéler)."""
    if os.environ.get("ANTHROPIC_API_KEY"):
        return {"has_key": True, "preview": _mask_key(_read_api_key()), "source": "env_var"}
    key = _read_api_key()
    if key:
        return {"has_key": True, "preview": _mask_key(key), "source": "file"}
    return {"has_key": False, "preview": None, "source": None}


def set_api_key(key):
    """Écrit la clé Claude dans le fichier secret (chmod 600). Retourne le preview masqué."""
    key = (key or "").strip()
    API_KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
    API_KEY_PATH.write_text(key, encoding="utf-8")
    API_KEY_PATH.chmod(0o600)
    return _mask_key(key)


def clear_api_key():
    """Supprime le fichier de clé (la var d'env, si présente, reste prioritaire)."""
    try:
        API_KEY_PATH.unlink()
        return True
    except FileNotFoundError:
        return False


def parse_event_line(line):
    """Parse une ligne stdout du process Node. Retourne un dict event valide, sinon None."""
    line = (line or "").strip()
    if not line:
        return None
    try:
        obj = json.loads(line)
    except (ValueError, TypeError):
        return None
    if not isinstance(obj, dict) or "type" not in obj:
        return None
    return obj


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _record_world_memory(group_id, event):
    """Route un event de trouvaille (biome/cave/material) vers le store du groupe, sous verrou.

    Cache en mémoire par groupe → évite de relire le fichier à chaque event ; persistance au fil de
    l'eau (save par event, débit faible) pour que la carte survive à la mort d'un bot."""
    if not group_id:
        return
    with _wm_lock:
        mem = _wm_cache.get(group_id)
        if mem is None:
            mem = world_memory.load(group_id)
            _wm_cache[group_id] = mem
        world_memory.apply_event(mem, event, at=_now_iso())
        world_memory.save(group_id, mem)


def _apply_event(session, event):
    """Met à jour l'état d'une session selon l'event reçu."""
    etype = event.get("type")
    if etype == "status":
        session["status"] = event.get("state", session["status"])
    elif etype in ("chat", "say", "msa"):
        # msa = code device-login Microsoft → visible dans le transcript
        session["transcript"].append(event)
        session["transcript"] = session["transcript"][-200:]
    elif etype == "error":
        session["last_error"] = event.get("message")
    session["events"].append(event)
    session["events"] = session["events"][-500:]
    # mémoire de monde partagée : route les trouvailles vers le store du groupe (server_id)
    if etype in _WM_EVENTS and session.get("server_id"):
        _record_world_memory(session["server_id"], event)


def _pump(session, stream):
    """Boucle de lecture du stdout du process : applique chaque event jusqu'à la fin du flux."""
    for line in stream:
        event = parse_event_line(line)
        if event:
            _apply_event(session, event)
    session["status"] = "stopped"
    # un cartographe mort (crash/kick, pas via stop_session) → les survivants se re-partagent le cercle
    if session.get("objective") == "mapper":
        try:
            _rebalance_sectors(session.get("server_id"))
        except Exception:  # noqa: BLE001 — thread de pompe : ne jamais le laisser crasher
            pass


def _node_bin():
    """Binaire node : surchargeable via MC_AGENT_NODE_BIN (PATH systemd ≠ PATH shell)."""
    return os.environ.get("MC_AGENT_NODE_BIN", "node")


def _provider():
    """Provider LLM sélectionné (env MC_AGENT_LLM) : 'gemini' (gratuit) ou 'anthropic' (défaut)."""
    return (os.environ.get("MC_AGENT_LLM") or "anthropic").lower()


def has_api_key():
    """True si la clé du provider LLM sélectionné est dispo.

    - gemini    → GEMINI_API_KEY dans l'environnement (héritée du .env via load_dotenv)
    - groq      → GROQ_API_KEY dans l'environnement
    - anthropic → ANTHROPIC_API_KEY (var d'env) OU fichier secret posé via le dashboard
    """
    prov = _provider()
    if prov == "gemini":
        return bool(os.environ.get("GEMINI_API_KEY"))
    if prov == "groq":
        return bool(os.environ.get("GROQ_API_KEY"))
    return bool(_read_api_key())


VALID_OBJECTIVES = ("stone_pickaxe", "iron_pickaxe", "diamond", "mapper")


def _active_mappers(group_id):
    """Sessions cartographe VIVANTES d'un groupe, triées par id (ordre de lancement stable)."""
    if not group_id:
        return []
    return sorted(
        (s for s in list(_sessions.values())
         if s.get("server_id") == group_id and s.get("objective") == "mapper"
         and s.get("proc") and s["proc"].poll() is None),
        key=lambda s: s["id"],
    )


def _rebalance_sectors(group_id):
    """Re-pousse les secteurs (360/N + recouvrement, calcul côté Node) aux mappers actifs du groupe.

    Appelé quand N change (lancement/arrêt d'un mapper) : chaque bot reçoit {'type':'sector',index,count}
    sur stdin → effet au prochain batch de waypoints (pas de redémarrage)."""
    mappers = _active_mappers(group_id)
    n = len(mappers)
    for i, s in enumerate(mappers):
        send_command(s["id"], {"type": "sector", "index": i, "count": n})


def start_session(host, port, user, model=None, auth="offline", profile=None, commands=None, policy=None, server_id=None, language="fr", autonomous=False, objective="stone_pickaxe", world_label=None):
    """Spawn le process Node détaché et enregistre la session. Retourne son id.

    `commands` : liste d'objets {cmd,syntax,desc} (whitelist serveur). Écrite dans un fichier
    temp passé au bot via --commands (le bot ne tapera que ces commandes).
    `autonomous` : si True, seed un world.json avec `objective` (pioche pierre OU pioche fer) +
    passe --world → le bot lance la boucle planner dès le spawn (reprise-au-spawn, 0 token LLM).
    `objective` : 'stone_pickaxe' (défaut) | 'iron_pickaxe' | 'diamond' — sélectionne la chaîne de buts côté Node.
    Le mot de passe AuthMe est géré côté Node (self-persist dans data/mc_agent_secret_<user>.json,
    chmod 600) — pas besoin de --authpw ici (et surtout PAS dans mc_agent_servers.json, exposé par l'API).
    """
    if objective not in VALID_OBJECTIVES:
        objective = "stone_pickaxe"
    global _counter
    with _lock:
        _counter += 1
        sid = _counter
    cmd = [_node_bin(), str(MC_AGENT_DIR / "index.js"),
           "--host", str(host), "--port", str(port), "--user", str(user),
           "--auth", str(auth or "offline")]
    if model:
        cmd += ["--model", str(model)]
    if profile:
        cmd += ["--profile", str(profile)]
    if language:
        cmd += ["--lang", str(language)]
    cmds_path = None
    if commands:
        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        cmds_path = RUNS_DIR / f"cmds-{sid}.json"
        cmds_path.write_text(json.dumps(commands), encoding="utf-8")
        cmd += ["--commands", str(cmds_path)]
    policy_path = None
    if policy:
        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        policy_path = RUNS_DIR / f"policy-{sid}.json"
        policy_path.write_text(json.dumps(policy), encoding="utf-8")
        cmd += ["--policy", str(policy_path)]
    world_path = None
    if autonomous:
        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        world_path = RUNS_DIR / f"world-{sid}.json"
        world_path.write_text(json.dumps({
            "home": None, "chests": [], "waypoints": [],
            "objective": {"type": objective, "status": "in_progress"},
        }), encoding="utf-8")
        cmd += ["--world", str(world_path)]
    # Bootstrap mémoire de monde : passe la mémoire courante du groupe au bot (il sait où chercher).
    wm_path = None
    if server_id:
        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        wm_path = RUNS_DIR / f"worldmem-{sid}.json"
        wm_path.write_text(json.dumps(world_memory.load(server_id)), encoding="utf-8")
        cmd += ["--world-memory", str(wm_path)]
    if world_label:
        cmd += ["--world-label", str(world_label)]  # monde de minage (overworld-type séparé)
    # Multi-cartographes (1c) : secteur assigné au lancement (i = nb de mappers déjà actifs du groupe),
    # puis re-balancé live pour TOUS via stdin (cf. _rebalance_sectors, appelé plus bas).
    if objective == "mapper" and autonomous:
        k = len(_active_mappers(server_id))
        cmd += ["--sector-index", str(k), "--sector-count", str(k + 1)]
    env = dict(os.environ)
    api_key = _read_api_key()  # injecte la clé (fichier ou env) dans l'env du subprocess Node
    if api_key:
        env["ANTHROPIC_API_KEY"] = api_key
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        stdin=subprocess.PIPE,
        text=True,
        bufsize=1,
        cwd=str(MC_AGENT_DIR),
        env=env,
        start_new_session=True,  # détaché : survit à un reload uvicorn (cf. piège #30f)
    )
    session = {
        "id": sid, "proc": proc, "status": "starting",
        "transcript": [], "events": [], "last_error": None,
        "host": host, "user": user, "server_id": server_id,
        "objective": objective if autonomous else None,
        "cmds_path": str(cmds_path) if cmds_path else None,
        "policy_path": str(policy_path) if policy_path else None,
        "world_path": str(world_path) if world_path else None,
        "wm_path": str(wm_path) if wm_path else None,
    }
    _sessions[sid] = session
    t = threading.Thread(target=_pump, args=(session, proc.stdout), daemon=True)
    t.start()
    session["thread"] = t
    if objective == "mapper" and autonomous:
        _rebalance_sectors(server_id)  # les mappers déjà actifs resserrent leur wedge (N a changé)
    return sid


def _public(session):
    """Vue sérialisable d'une session (sans proc/thread)."""
    return {
        "id": session["id"], "status": session["status"], "host": session["host"],
        "user": session["user"], "last_error": session["last_error"],
        "server_id": session.get("server_id"),
    }


def get_status(sid):
    s = _sessions.get(sid)
    return _public(s) if s else None


def get_transcript(sid):
    s = _sessions.get(sid)
    return list(s["transcript"]) if s else None


def list_active():
    # list(...) : snapshot des valeurs avant itération → évite RuntimeError si start_session
    # insère une session sur un autre thread pendant un poll /active concurrent.
    return [_public(s) for s in list(_sessions.values())
            if s.get("proc") is None or s["proc"].poll() is None]


def send_command(sid, command):
    """Envoie une commande JSON sur le stdin du process Node. False si session inconnue."""
    s = _sessions.get(sid)
    if not s or not s.get("proc") or not s["proc"].stdin:
        return False
    try:
        s["proc"].stdin.write(json.dumps(command) + "\n")
        s["proc"].stdin.flush()
    except (ValueError, OSError):
        return False
    return True


def stop_session(sid):
    """Arrête une session (SIGTERM au groupe de process). False si session inconnue."""
    s = _sessions.get(sid)
    if not s:
        return False
    proc = s.get("proc")
    if proc and proc.poll() is None:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            proc.terminate()
    s["status"] = "stopped"
    for key in ("cmds_path", "policy_path", "world_path", "wm_path"):
        p = s.get(key)
        if p:
            try:
                os.unlink(p)
            except OSError:
                pass
    if s.get("objective") == "mapper":
        _rebalance_sectors(s.get("server_id"))  # les survivants élargissent leur wedge
    return True


def stop_group(group_id):
    """Arrête toutes les sessions actives d'un groupe (server_id). Retourne le nb arrêté."""
    if not group_id:
        return 0
    n = 0
    for sid, s in list(_sessions.items()):
        if s.get("server_id") == group_id and s.get("proc") and s["proc"].poll() is None:
            if stop_session(sid):
                n += 1
    return n


def forget_group(group_id):
    """Cascade : oublie le cache mémoire + supprime le fichier mémoire du groupe. True si supprimé."""
    with _wm_lock:
        _wm_cache.pop(group_id, None)
    return world_memory.delete_memory(group_id)


_LIST_PROFILES_JS = MC_AGENT_DIR / "bin" / "list-profiles.js"


def list_profiles():
    """Profils + fiches de tells, lus depuis les fichiers Node (source unique). [] si échec."""
    try:
        res = subprocess.run(
            [_node_bin(), str(_LIST_PROFILES_JS)],
            cwd=str(MC_AGENT_DIR),
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    if res.returncode != 0 or not res.stdout:
        return []
    try:
        data = json.loads(res.stdout)
    except (ValueError, TypeError):
        return []
    return data if isinstance(data, list) else []
