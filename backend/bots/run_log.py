"""
Sortie des subprocess de bots écrite dans un FICHIER, jamais dans un pipe.

Pourquoi : un moteur lancé avec ``stdout=subprocess.PIPE`` dépend du process
qui LIT le pipe. ``start_new_session=True`` protège l'enfant des signaux de
uvicorn, pas de la mort de son lecteur : après un redémarrage (auto-deploy à
chaque push), plus personne ne lit, et la prochaine écriture de l'enfant lève
``BrokenPipeError`` (Python ignore SIGPIPE). Un ``print`` tue le run, un
``logging`` avale l'erreur et perd tous les logs.

Ici l'enfant écrit directement dans ``run.log`` (le noyau tient le fichier
ouvert pour lui, quoi qu'il arrive à uvicorn). Le backend SUIT ce fichier
(tail) pour la progression en direct, et un fil attend la fin du process
(sinon il resterait zombie et ``os.kill(pid, 0)`` le croirait vivant).
"""

import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable, List, Optional

FOLLOW_POLL_S = 0.5


def open_log(path, mode: str = "ab"):
    """Ouvre ``path`` en append, fichier NÉ en 0o600 (création atomique via
    os.open, pas de fenêtre world-readable) ; os.fchmod couvre un fichier
    pré-existant aux autres permissions. Un log de run peut contenir des
    traces sensibles -> même posture que les secrets."""
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.fchmod(fd, 0o600)
    except (AttributeError, OSError):
        pass
    if "b" in mode:
        return os.fdopen(fd, mode)
    return os.fdopen(fd, mode, encoding="utf-8")


def spawn_logged(cmd: List[str], log_path, **popen_kwargs) -> "subprocess.Popen":
    """``Popen`` avec stdout+stderr redirigés dans ``log_path`` (append, 0o600).

    Le descripteur est fermé côté parent juste après le lancement : seul
    l'enfant le garde ouvert, il ne dépend donc plus de uvicorn."""
    logf = open_log(log_path, "ab")
    try:
        return subprocess.Popen(
            cmd,
            stdout=logf,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            **popen_kwargs
        )
    finally:
        logf.close()


def log_size(path) -> int:
    try:
        return os.path.getsize(str(path))
    except OSError:
        return 0


def follow(path, proc, on_line: Callable[[str], None], start: int = 0,
           on_exit: Optional[Callable[[int], None]] = None,
           poll: Optional[float] = None) -> None:
    """Suit ``path`` depuis l'octet ``start`` tant que ``proc`` tourne, appelle
    ``on_line`` pour chaque ligne COMPLÈTE non vide, vide le reste à la fin,
    puis ATTEND le process (faucheur) et appelle ``on_exit(returncode)``.

    Une exception dans ``on_line`` ne coupe jamais le suivi."""
    if poll is None:
        poll = FOLLOW_POLL_S
    pos = start
    buf = b""

    def _drain():
        nonlocal pos, buf
        try:
            with open(str(path), "rb") as f:
                f.seek(pos)
                chunk = f.read()
        except OSError:
            return
        if not chunk:
            return
        pos += len(chunk)
        buf += chunk
        *lines, buf = buf.split(b"\n")
        for raw in lines:
            _emit(raw)

    def _emit(raw):
        line = raw.decode("utf-8", errors="replace").rstrip()
        if not line:
            return
        try:
            on_line(line)
        except Exception:  # noqa: BLE001 — un parseur fautif ne tue pas le suivi
            pass

    try:
        while proc.poll() is None:
            _drain()
            time.sleep(poll)
        _drain()
        if buf:
            _emit(buf)              # dernière ligne sans retour chariot
            buf = b""
    finally:
        try:
            rc = proc.wait()
        except Exception:  # noqa: BLE001
            rc = getattr(proc, "returncode", None)
    if on_exit is not None:
        on_exit(rc)


def start_follower(path, proc, on_line, start: int = 0, on_exit=None,
                   poll: Optional[float] = None) -> threading.Thread:
    t = threading.Thread(target=follow, args=(path, proc, on_line),
                         kwargs={"start": start, "on_exit": on_exit, "poll": poll},
                         daemon=True)
    t.start()
    return t


def tail_lines(path, limit: int = 200, max_bytes: int = 262144) -> List[str]:
    """Dernières lignes non vides de ``path`` (lecture bornée par la fin)."""
    p = Path(path)
    try:
        size = p.stat().st_size
        with open(str(p), "rb") as f:
            if size > max_bytes:
                f.seek(size - max_bytes)
                f.readline()        # jette la 1re ligne partielle
            data = f.read()
    except OSError:
        return []
    lines = [ln.rstrip() for ln in data.decode("utf-8", errors="replace").splitlines()]
    return [ln for ln in lines if ln][-limit:]
