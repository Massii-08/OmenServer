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
MC_AGENT_DIR = Path(__file__).resolve().parents[2] / "mc-agent"

_sessions = {}        # session_id (int) -> dict
_lock = threading.Lock()
_counter = 0


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
    elif etype in ("chat", "say"):
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


def has_api_key():
    """True si ANTHROPIC_API_KEY est présente dans l'environnement (chargée via .env)."""
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def start_session(host, port, user, model=None):
    """Spawn le process Node détaché et enregistre la session. Retourne son id."""
    global _counter
    cmd = [_node_bin(), str(MC_AGENT_DIR / "index.js"),
           "--host", str(host), "--port", str(port), "--user", str(user)]
    if model:
        cmd += ["--model", str(model)]
    env = dict(os.environ)  # hérite ANTHROPIC_API_KEY (chargée par backend.config/.env)
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
    with _lock:
        _counter += 1
        sid = _counter
    session = {
        "id": sid, "proc": proc, "status": "starting",
        "transcript": [], "events": [], "last_error": None,
        "host": host, "user": user,
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
    return True
