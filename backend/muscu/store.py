"""Clé d'accès et quota quotidien du coach Muscu (appli iPhone perso)."""

import json
import logging
import os
import secrets
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional
from zoneinfo import ZoneInfo

logger = logging.getLogger("omenserver")

# Surchargeable dans les tests
DATA_DIR: Path = Path(__file__).resolve().parent.parent.parent / "data"
KEY_FILE = "muscu_coach.key"
USAGE_FILE = "muscu_coach_usage.json"

DAILY_LIMIT = 40
MIN_INTERVAL_S = 3.0
TZ = ZoneInfo("Europe/Zurich")

# Horloges injectables (tests)
_clock: Callable[[], float] = time.time

_lock = threading.Lock()
_last_call: float = 0.0


def _write_new(path: Path, data: str) -> None:
    """Création atomique 0o600 (échoue si le fichier existe déjà)."""
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        try:
            os.fchmod(fd, 0o600)
        except (AttributeError, OSError):
            pass
        os.write(fd, data.encode("utf-8"))
    finally:
        os.close(fd)


def load_key() -> Optional[str]:
    """Lit la clé ; la crée si elle n'existe pas. None si impossible."""
    path = DATA_DIR / KEY_FILE
    try:
        if not path.exists():
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            try:
                _write_new(path, secrets.token_urlsafe(32) + "\n")
                logger.info("muscu: clé d'accès créée (%s)", KEY_FILE)
            except FileExistsError:
                pass
        key = path.read_text(encoding="utf-8").strip()
        return key or None
    except OSError:
        logger.error("muscu: clé d'accès illisible/non créable")
        return None


def _today() -> str:
    return datetime.fromtimestamp(_clock(), TZ).strftime("%Y-%m-%d")


def _read_used(day: str) -> int:
    try:
        data = json.loads((DATA_DIR / USAGE_FILE).read_text(encoding="utf-8"))
        if data.get("day") == day:
            return max(0, int(data.get("count", 0)))
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    return 0


def _write_used(day: str, count: int) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    final = DATA_DIR / USAGE_FILE
    tmp = DATA_DIR / (USAGE_FILE + ".tmp")
    try:
        os.unlink(str(tmp))
    except OSError:
        pass
    _write_new(tmp, json.dumps({"day": day, "count": count}))
    os.replace(str(tmp), str(final))


def remaining_today() -> int:
    with _lock:
        return max(0, DAILY_LIMIT - _read_used(_today()))


def reserve() -> "tuple[bool, str, int]":
    """Réserve un appel. Rend (ok, motif, restant) ; motif 'rate'|'quota'|''."""
    global _last_call
    with _lock:
        now = _clock()
        day = _today()
        used = _read_used(day)
        if used >= DAILY_LIMIT:
            return False, "quota", 0
        if _last_call and 0 <= now - _last_call < MIN_INTERVAL_S:
            return False, "rate", DAILY_LIMIT - used
        try:
            _write_used(day, used + 1)
        except OSError:
            logger.error("muscu: compteur illisible/non écrivable")
            return False, "quota", 0
        _last_call = now
        return True, "", DAILY_LIMIT - used - 1


def reset_state() -> None:
    """Remet le débit à zéro (tests)."""
    global _last_call
    with _lock:
        _last_call = 0.0
