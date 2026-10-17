"""Moteur détaché dont la sortie va dans un FICHIER, jamais dans un pipe.

Pourquoi (piège #70) : un moteur lancé avec ``start_new_session=True`` survit au
restart d'uvicorn que fait l'auto-deploy, mais si sa sortie est un pipe, le fil
qui le lit vit dans uvicorn et meurt avec lui. Le bout de lecture se ferme, et
le write suivant du moteur lève ``BrokenPipeError`` (Python ignore SIGPIPE).

Ici le moteur écrit dans ``log_path``. Pour les routers qui affichent une
progression parsée ligne à ligne, ``follow`` relit le fichier pendant que le
moteur tourne : si uvicorn redémarre, seul le suivi s'arrête, jamais le moteur.
"""

import subprocess
import time
from typing import Callable


def launch_to_file(cmd, log_path, **popen_kwargs) -> subprocess.Popen:
    """Lance ``cmd`` DÉTACHÉ, stdout+stderr ajoutés à la fin de ``log_path``."""
    log = open(str(log_path), "ab")
    try:
        return subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            # OBLIGATOIRE : sans session propre, le restart uvicorn de
            # l'auto-deploy tuerait le moteur en cours.
            start_new_session=True,
            **popen_kwargs,
        )
    finally:
        log.close()   # le moteur a sa propre copie du descripteur


def follow(proc, log_path, on_line: Callable[[str], None],
           poll_s: float = 0.25, start: int = 0) -> None:
    """Appelle ``on_line`` pour chaque ligne complète écrite dans ``log_path``
    à partir de l'octet ``start``, jusqu'à la fin de ``proc`` (fichier vidé).

    Une ligne à moitié écrite reste en tampon jusqu'à son ``\\n`` ; ce qui
    reste sans ``\\n`` à la fin du moteur est rendu tel quel.
    """
    buf = b""
    with open(str(log_path), "rb") as f:
        f.seek(start)
        while True:
            chunk = f.read()
            if chunk:
                buf += chunk
                *lines, buf = buf.split(b"\n")
                for raw in lines:
                    on_line(raw.decode("utf-8", errors="replace"))
                continue
            if proc.poll() is not None:
                # Dernier passage : le moteur est fini, tout est sur le disque.
                chunk = f.read()
                buf += chunk
                for raw in buf.split(b"\n"):
                    if raw:
                        on_line(raw.decode("utf-8", errors="replace"))
                return
            time.sleep(poll_s)
