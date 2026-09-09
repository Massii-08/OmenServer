"""Le titre REGARDÉ — dix minutes de priorité pour ce que Massii a sous les yeux.

Levier n°3 de la spec (§7) : le graphique ouvert dans TradingView est scanné à
**60 s** (news TradingView + RSS Yahoo) au lieu des cinq minutes du cycle
ordinaire, et cela même si le titre n'est ni détenu ni en watchlist. L'extension
pose un focus au changement de symbole et le renouvelle tant que l'onglet est
visible ; passé le TTL, il s'éteint tout seul — un focus oublié ne doit jamais
faire scanner un titre pendant des semaines.

Contrat (plan §1.6) : ``POST /api/paper/focus {symbol}`` -> ``{ok, until}`` ;
``GET /api/paper/focus`` -> ``{symbol|null, until|null}``. **Un seul titre par
utilisateur** : poser un focus remplace le précédent, il n'y a pas de file.

État : ``data/paper_trading/focus.state.json``, écriture ATOMIQUE 0o600 via
``store._atomic_write_json``.

⚠️ Le POINT dans le radical n'est pas cosmétique : c'est la convention
anti-fantôme du dépôt (cf. tête de ``paper/calendar.py``) — un
``focus_state.json`` deviendrait un compte fantôme nommé « focus_state » pour
``radar._users_with_portfolio``, à qui la convergence écrirait un carnet.

Tout est PUR sauf la lecture/écriture du fichier, et l'horloge est TOUJOURS
injectable -> tests 100 % hors ligne, sans attente réelle.
"""
import json
import logging
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger("omenserver")

STATE_NAME = "focus.state.json"

# Dix minutes : assez pour une séance d'observation, assez court pour qu'un
# onglet oublié cesse de coûter des requêtes avant la fin du quart d'heure.
FOCUS_TTL_S = 600.0

# Un symbole Yahoo canonique : lettres, chiffres et les trois signes que Yahoo
# utilise (``.SW``, ``BTC-USD``, ``EURUSD=X``, ``^GSPC``). On REJETTE le reste
# plutôt que de nettoyer en silence — même doctrine que ``store``.
_SAFE_SYMBOL = re.compile(r"^[A-Za-z0-9.\-=^]{1,24}$")


def _store():
    """``store`` importé PARESSEUSEMENT : ``store.DATA_DIR`` est monkeypatché
    par les tests, une constante figée à l'import raterait l'isolation."""
    from backend.bots.paper import store
    return store


def state_path() -> Path:
    """Chemin de l'état — relit ``store.DATA_DIR`` à chaque appel."""
    return _store().DATA_DIR / STATE_NAME


def _now_dt(now: Any = None) -> datetime:
    if isinstance(now, datetime):
        return now if now.tzinfo else now.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc)


def _parse_dt(value: Any) -> Optional[datetime]:
    try:
        moment = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def normalize_symbol(symbol: Any) -> str:
    """Symbole en majuscules, validé. Lève ``ValueError`` si la forme n'y est
    pas — on rejette, on ne sanitize jamais en silence."""
    raw = str(symbol or "").strip()
    if not raw or not _SAFE_SYMBOL.fullmatch(raw):
        raise ValueError("symbole invalide: %r" % (symbol,))
    return raw.upper()


def load_state() -> Dict[str, Any]:
    """L'état, ou un état vierge. Corrompu -> vierge, jamais une exception."""
    path = state_path()
    if not path.is_file():
        return {"users": {}}
    try:
        with open(str(path), "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        logger.warning("paper focus: état illisible, repart de zéro")
        return {"users": {}}
    if not isinstance(data, dict):
        return {"users": {}}
    users = data.get("users")
    if not isinstance(users, dict):
        return {"users": {}}
    clean: Dict[str, Any] = {}
    for username, row in users.items():
        if isinstance(username, str) and isinstance(row, dict):
            clean[username] = {"symbol": row.get("symbol") or None,
                               "until": row.get("until") or None}
    return {"users": clean}


def save_state(state: Dict[str, Any]) -> None:
    """Écriture ATOMIQUE 0o600 — le patron obligatoire du dépôt."""
    users = (state or {}).get("users")
    payload = {"users": dict(users) if isinstance(users, dict) else {}}
    _store()._atomic_write_json(state_path(), payload)


def _prune(state: Dict[str, Any], now_dt: datetime) -> bool:
    """Retire EN PLACE les focus expirés. Rend ``True`` si l'état a changé.

    Une échéance illisible est traitée comme EXPIRÉE : un focus qu'on ne sait
    pas dater ne doit pas faire scanner un titre pour toujours.
    """
    users = state.setdefault("users", {})
    dead = []
    for username, row in users.items():
        until = _parse_dt((row or {}).get("until"))
        if until is None or until <= now_dt or not (row or {}).get("symbol"):
            dead.append(username)
    for username in dead:
        del users[username]
    return bool(dead)


def set_focus(username: str, symbol: Any, now: Any = None,
              ttl_s: float = FOCUS_TTL_S) -> Dict[str, Any]:
    """Pose (ou renouvelle) le focus d'un utilisateur -> ``{ok, symbol, until}``.

    Remplace le focus précédent : un utilisateur regarde UN graphique. Le nom
    d'utilisateur et le symbole sont validés (``ValueError`` sinon), et la
    pose purge au passage les focus expirés des autres comptes — le fichier ne
    grossit donc jamais tout seul.
    """
    user = _store()._sanitize_username(username)
    sym = normalize_symbol(symbol)
    now_dt = _now_dt(now)
    try:
        ttl = max(1.0, float(ttl_s))
    except (TypeError, ValueError):
        ttl = FOCUS_TTL_S
    until = (now_dt + timedelta(seconds=ttl)).isoformat()

    state = load_state()
    _prune(state, now_dt)
    state["users"][user] = {"symbol": sym, "until": until}
    save_state(state)
    return {"ok": True, "symbol": sym, "until": until}


def get_focus(username: str, now: Any = None) -> Dict[str, Any]:
    """Le focus courant d'un utilisateur -> ``{symbol|None, until|None}``.

    Expiré ou absent -> les deux champs à ``None`` (forme COMPLÈTE et stable :
    l'appelant n'a jamais à se demander quelles clés existent).
    """
    user = _store()._sanitize_username(username)
    now_dt = _now_dt(now)
    row = load_state()["users"].get(user) or {}
    until = _parse_dt(row.get("until"))
    if not row.get("symbol") or until is None or until <= now_dt:
        return {"symbol": None, "until": None}
    return {"symbol": row.get("symbol"), "until": row.get("until")}


def clear_focus(username: str) -> Dict[str, Any]:
    """Éteint le focus d'un utilisateur -> ``{symbol: None, until: None}``."""
    user = _store()._sanitize_username(username)
    state = load_state()
    if state["users"].pop(user, None) is not None:
        save_state(state)
    return {"symbol": None, "until": None}


def all_active(now: Any = None) -> Dict[str, str]:
    """CONTRAT PUBLIC (``newswatch.run_once``) : ``{username: symbole}`` des
    focus ENCORE VALIDES.

    Lecture PURE : cette fonction ne purge rien sur le disque (le cycle de
    veille la traverse à chaque passage, il n'a pas à réécrire un fichier pour
    lire). Les entrées expirées sont simplement absentes du retour ; c'est
    ``set_focus`` qui nettoie.
    """
    now_dt = _now_dt(now)
    out: Dict[str, str] = {}
    for username, row in load_state()["users"].items():
        until = _parse_dt((row or {}).get("until"))
        symbol = (row or {}).get("symbol")
        if symbol and until is not None and until > now_dt:
            out[username] = str(symbol)
    return out


def active_symbols(now: Any = None) -> List[str]:
    """Les symboles en focus, dédupliqués, ordre stable (tri alphabétique)."""
    return sorted({sym.upper() for sym in all_active(now).values() if sym})
