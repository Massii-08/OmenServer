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
from pathlib import Path

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


def _pump(session, stream):
    """Boucle de lecture du stdout du process : applique chaque event jusqu'à la fin du flux."""
    for line in stream:
        event = parse_event_line(line)
        if event:
            _apply_event(session, event)
    session["status"] = "stopped"


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


def start_session(host, port, user, model=None, auth="offline", profile=None, commands=None, policy=None, server_id=None, language="fr"):
    """Spawn le process Node détaché et enregistre la session. Retourne son id.

    `commands` : liste d'objets {cmd,syntax,desc} (whitelist serveur). Écrite dans un fichier
    temp passé au bot via --commands (le bot ne tapera que ces commandes).
    """
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
        "cmds_path": str(cmds_path) if cmds_path else None,
        "policy_path": str(policy_path) if policy_path else None,
    }
    _sessions[sid] = session
    t = threading.Thread(target=_pump, args=(session, proc.stdout), daemon=True)
    t.start()
    session["thread"] = t
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
    for key in ("cmds_path", "policy_path"):
        p = s.get(key)
        if p:
            try:
                os.unlink(p)
            except OSError:
                pass
    return True


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
