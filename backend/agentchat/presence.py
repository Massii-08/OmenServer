"""Présence des membres Agent Chat (EN MÉMOIRE : éphémère, perdue au redémarrage).

Chaque membre (clé = ``(room_id, member_id)``) peut avoir plusieurs sessions
Claude Code simultanées (même clé installée globalement). Une session pousse son
état via ``POST /mcp/agentchat/statut`` ; les appels MCP/pings « touchent »
le membre sans session. Les limites 5 h / 7 j sont au niveau du membre (même
compte) : on garde la plus récente.

L'horloge est injectable (``now=``) pour les tests.
"""
from __future__ import annotations

import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

ONLINE_TTL_S = 5 * 60          # vu il y a <= 5 min => en ligne
WORKING_TTL_S = 15 * 60        # "working" périmé au bout de 15 min (session crashée)
LIMITS_TTL_S = 6 * 3600        # limites ignorées au-delà de 6 h
SESSION_PURGE_S = 3600         # session oubliée après 1 h sans signe de vie
MAX_SESSIONS = 20
STATES = ("working", "idle", "offline")

_LOCK = threading.Lock()
_STATE = {}  # type: Dict[Tuple[str, str], Dict[str, Any]]


def reset() -> None:
    with _LOCK:
        _STATE.clear()


def _entry(room_id: str, member_id: str) -> Dict[str, Any]:
    key = (room_id, member_id)
    e = _STATE.get(key)
    if e is None:
        e = {"touched": None, "sessions": {}, "limits_at": None,
             "five_hour": None, "seven_day": None}
        _STATE[key] = e
    return e


def _purge(e: Dict[str, Any], now: float) -> None:
    sess = e["sessions"]
    for sid in [s for s, v in sess.items() if now - v["last_seen"] > SESSION_PURGE_S]:
        del sess[sid]
    if len(sess) > MAX_SESSIONS:
        for sid in sorted(sess, key=lambda s: sess[s]["last_seen"])[:len(sess) - MAX_SESSIONS]:
            del sess[sid]


def touch(room_id: str, member_id: str, now: Callable[[], float] = time.time) -> None:
    """Un appel agent authentifié (MCP, pings, fichiers) : le membre est vivant."""
    t = now()
    with _LOCK:
        _entry(room_id, member_id)["touched"] = t


def _clean_limit(pct: Any, resets_at: Any) -> Optional[Dict[str, Any]]:
    if isinstance(pct, bool) or not isinstance(pct, (int, float)) or pct != pct:
        return None
    out = {"pct": max(0.0, min(100.0, float(pct))), "resets_at": None}
    if isinstance(resets_at, int) and not isinstance(resets_at, bool) and resets_at > 0:
        out["resets_at"] = resets_at
    return out


def set_status(room_id: str, member_id: str, session: Optional[str] = None,
               state: Optional[str] = None,
               five_hour_pct: Any = None, five_hour_resets_at: Any = None,
               seven_day_pct: Any = None, seven_day_resets_at: Any = None,
               now: Callable[[], float] = time.time) -> None:
    t = now()
    session = (str(session)[:32] if session else "_") or "_"
    with _LOCK:
        e = _entry(room_id, member_id)
        s = e["sessions"].get(session)
        if s is None:
            s = {"state": "idle", "state_at": t, "last_seen": t}
            e["sessions"][session] = s
        s["last_seen"] = t
        if state in STATES:
            s["state"] = state
            s["state_at"] = t
        got = False
        for name, pct, ra in (("five_hour", five_hour_pct, five_hour_resets_at),
                              ("seven_day", seven_day_pct, seven_day_resets_at)):
            lim = _clean_limit(pct, ra)
            if lim is not None:
                e[name] = lim
                got = True
        if got:
            e["limits_at"] = t
        _purge(e, t)


def view(room_id: str, member_id: str, name: str = "",
         now: Callable[[], float] = time.time) -> Dict[str, Any]:
    """Vue dérivée d'un membre (règles online/working/limites)."""
    t = now()
    with _LOCK:
        e = _STATE.get((room_id, member_id))
        if e is not None:
            _purge(e, t)
            sessions = [dict(v) for v in e["sessions"].values()]
            touched = e["touched"]
            five, seven, limits_at = e["five_hour"], e["seven_day"], e["limits_at"]
        else:
            sessions, touched, five, seven, limits_at = [], None, None, None, None
    seen = [x["last_seen"] for x in sessions]
    if touched is not None:
        seen.append(touched)
    last_seen = max(seen) if seen else None
    live = [x for x in sessions if x["state"] != "offline" and t - x["last_seen"] <= ONLINE_TTL_S]
    working = [x for x in sessions if x["state"] == "working" and t - x["state_at"] <= WORKING_TTL_S]
    touched_ok = touched is not None and t - touched <= ONLINE_TTL_S
    n_working = len(working)
    online = bool(live) or touched_ok or n_working > 0
    is_working = n_working > 0
    limits_ok = limits_at is not None and t - limits_at <= LIMITS_TTL_S
    return {
        "member_id": member_id, "name": name,
        "online": online, "working": is_working,
        "state": "working" if is_working else ("idle" if online else "offline"),
        "last_seen_s": None if last_seen is None else max(0, int(t - last_seen)),
        "sessions_working": n_working,
        "five_hour": dict(five) if (limits_ok and five) else None,
        "seven_day": dict(seven) if (limits_ok and seven) else None,
        "limits_age_s": int(t - limits_at) if limits_ok else None,
    }


def room_view(room: Dict[str, Any], room_id: str,
              now: Callable[[], float] = time.time) -> List[Dict[str, Any]]:
    """Vues des membres NON révoqués d'un salon (``store.get_room``)."""
    return [view(room_id, m["id"], m.get("name", ""), now)
            for m in room.get("members", []) if not m.get("revoked")]


def offline_note(v: Dict[str, Any]) -> Optional[str]:
    """None si le membre est en ligne, sinon « hors ligne (vu il y a N min | ... ) ».

    Seule définition de « hors ligne », partagée par l'API humaine et le MCP."""
    if v.get("online"):
        return None
    s = v.get("last_seen_s")
    if s is None:
        return "hors ligne (pas vu depuis le redémarrage du serveur)"
    return "hors ligne (vu il y a %d min)" % (s // 60)
