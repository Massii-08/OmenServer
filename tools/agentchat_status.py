#!/usr/bin/env python3
"""Statut Agent Chat pour Claude Code : en ligne / travaille / limites 5 h et 7 j.

Deux modes, à brancher dans ``~/.claude/settings.json`` (global : le script
poste vers TOUS les serveurs MCP ``agentchat*`` de ``~/.claude.json``, un salon
par clé) ou dans ``.claude/settings.json`` d'un projet ::

    {
      "statusLine": {"type": "command",
                     "command": "python3 /chemin/tools/agentchat_status.py statusline"},
      "hooks": {
        "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "python3 /chemin/tools/agentchat_status.py hook"}]}],
        "PreToolUse":       [{"hooks": [{"type": "command", "command": "python3 /chemin/tools/agentchat_status.py hook"}]}],
        "Stop":             [{"hooks": [{"type": "command", "command": "python3 /chemin/tools/agentchat_status.py hook"}]}],
        "SessionEnd":       [{"hooks": [{"type": "command", "command": "python3 /chemin/tools/agentchat_status.py hook"}]}]
      }
    }

- ``hook``  : UserPromptSubmit/PreToolUse -> working, Stop -> idle, SessionEnd ->
  offline. N'écrit rien sur stdout, sort toujours 0, throttle 20 s sur PreToolUse.
- ``statusline`` : lit ``rate_limits`` (five_hour / seven_day) et imprime une ligne
  courte (``5h 42% · 7j 13%``). Throttle 60 s (immédiat si le pourcentage change).

La session est identifiée par les 12 premiers caractères d'un sha256 du
``session_id`` (jamais l'id brut). Configuration : voir ``load_all_configs`` de
``agentchat_ping_hook.py`` (AGENTCHAT_URL/AGENTCHAT_KEY, puis ``~/.claude.json``).
Stdlib uniquement, Python 3.9.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import urllib.request
from typing import Any, Callable, Dict, List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import agentchat_ping_hook as _ph  # noqa: E402

TIMEOUT = 3.0
HOOK_THROTTLE_S = 20
LINE_THROTTLE_S = 60
EVENT_STATE = {"UserPromptSubmit": "working", "PreToolUse": "working",
               "Stop": "idle", "SessionEnd": "offline"}


def status_url(url: str) -> str:
    url = url.rstrip("/")
    for suffix in ("/pings", "/statut"):
        if url.endswith(suffix):
            url = url[:-len(suffix)]
    return url + "/statut"


def session_hash(session_id: Any) -> Optional[str]:
    if not isinstance(session_id, str) or not session_id:
        return None
    return hashlib.sha256(session_id.encode("utf-8")).hexdigest()[:12]


def post_status(url: str, auth: str, body: Dict[str, Any], timeout: float = TIMEOUT) -> None:
    req = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"), method="POST",
        headers={"Authorization": auth, "Content-Type": "application/json",
                 "User-Agent": "omenserver-agentchat/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        resp.read()


def _cache_path(cache_dir: str, url: str, auth: str, session: Optional[str]) -> str:
    h = hashlib.sha256(("%s|%s|%s" % (url, auth, session or "")).encode("utf-8")).hexdigest()[:24]
    return os.path.join(cache_dir, h + ".json")


def _read_cache(path: str) -> Dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_cache(path: str, data: Dict[str, Any]) -> None:
    try:
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f)
    except OSError:
        pass


def _limit(rate_limits: Any, name: str) -> Tuple[Optional[float], Optional[int]]:
    d = rate_limits.get(name) if isinstance(rate_limits, dict) else None
    if not isinstance(d, dict):
        return None, None
    pct = d.get("used_percentage")
    if isinstance(pct, bool) or not isinstance(pct, (int, float)):
        pct = None
    ra = d.get("resets_at")
    if isinstance(ra, bool) or not isinstance(ra, (int, float)):
        ra = None
    return (float(pct) if pct is not None else None), (int(ra) if ra is not None else None)


def format_line(rate_limits: Any) -> str:
    parts = []
    for name, label in (("five_hour", "5h"), ("seven_day", "7j")):
        pct, _ = _limit(rate_limits, name)
        if pct is not None:
            parts.append("%s %d%%" % (label, round(pct)))
    return " · ".join(parts)


def _send_all(confs: List[Tuple[str, str]], body: Dict[str, Any], session: Optional[str],
              cache_dir: str, throttle_s: float, now: float,
              post: Callable[..., Any], key_extra: str = "",
              force: bool = False, throttle_key: str = "") -> None:
    """Poste vers chaque (url, clé) non throttlé ; le cache est par (url, clé, session)."""
    for url, auth in confs:
        path = _cache_path(cache_dir, url, auth, session)
        cache = _read_cache(path)
        last = cache.get("at_" + throttle_key)
        if (not force and isinstance(last, (int, float)) and 0 <= now - last < throttle_s
                and cache.get("sig_" + throttle_key) == key_extra):
            continue
        try:
            post(status_url(url), auth, body, TIMEOUT)
        except Exception:
            continue
        cache["at_" + throttle_key] = now
        cache["sig_" + throttle_key] = key_extra
        _write_cache(path, cache)


def run_hook(data: Any, env: Dict[str, str], config_path: str, cache_dir: str,
             post: Callable[..., Any] = post_status, now: Callable[[], float] = time.time) -> None:
    if not isinstance(data, dict):
        return
    state = EVENT_STATE.get(str(data.get("hook_event_name")))
    if state is None:
        return
    cwd = data.get("cwd")
    confs = _ph.load_all_configs(cwd if isinstance(cwd, str) else None, env, config_path)
    if not confs:
        return
    session = session_hash(data.get("session_id"))
    body = {"state": state}  # type: Dict[str, Any]
    if session:
        body["session"] = session
    pre = data.get("hook_event_name") == "PreToolUse"
    _send_all(confs, body, session, cache_dir, HOOK_THROTTLE_S if pre else 0, now(),
              post, key_extra=state, force=not pre, throttle_key="hook")


def run_statusline(data: Any, env: Dict[str, str], config_path: str, cache_dir: str,
                   post: Callable[..., Any] = post_status,
                   now: Callable[[], float] = time.time) -> str:
    if not isinstance(data, dict):
        return ""
    rl = data.get("rate_limits")
    line = format_line(rl)
    if not line:
        return ""
    five, five_ra = _limit(rl, "five_hour")
    seven, seven_ra = _limit(rl, "seven_day")
    body = {}  # type: Dict[str, Any]
    if five is not None:
        body["five_hour_pct"] = five
        if five_ra:
            body["five_hour_resets_at"] = five_ra
    if seven is not None:
        body["seven_day_pct"] = seven
        if seven_ra:
            body["seven_day_resets_at"] = seven_ra
    session = session_hash(data.get("session_id"))
    if session:
        body["session"] = session
    cwd = data.get("cwd")
    if not isinstance(cwd, str):
        ws = data.get("workspace")
        cwd = ws.get("current_dir") if isinstance(ws, dict) else None
    confs = _ph.load_all_configs(cwd if isinstance(cwd, str) else None, env, config_path)
    if confs:
        sig = "%s|%s" % (round(five) if five is not None else "", round(seven) if seven is not None else "")
        _send_all(confs, body, session, cache_dir, LINE_THROTTLE_S, now(), post,
                  key_extra=sig, throttle_key="line")
    return line


def main(argv: Optional[List[str]] = None, stdin: Any = None, stdout: Any = None,
         env: Optional[Dict[str, str]] = None, config_path: Optional[str] = None,
         cache_dir: Optional[str] = None,
         post: Callable[..., Any] = post_status) -> int:
    argv = sys.argv[1:] if argv is None else argv
    stdin = stdin if stdin is not None else sys.stdin
    stdout = stdout if stdout is not None else sys.stdout
    env = dict(os.environ) if env is None else env
    config_path = config_path or os.path.expanduser("~/.claude.json")
    cache_dir = cache_dir or os.path.expanduser("~/.cache/agentchat-status")
    try:
        mode = argv[0] if argv else ""
        try:
            raw = stdin.read()
            data = json.loads(raw) if raw and raw.strip() else {}
        except (OSError, ValueError):
            data = {}
        if mode == "hook":
            run_hook(data, env, config_path, cache_dir, post)
        elif mode == "statusline":
            line = run_statusline(data, env, config_path, cache_dir, post)
            if line:
                stdout.write(line + "\n")
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
