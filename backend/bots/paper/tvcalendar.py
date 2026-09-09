"""Volet TradingView de l'agenda — le calendrier économique, à la source.

Décision D6 de la spec (``docs/superpowers/specs/2026-09-09-tv-coach-extension-design.md``) :
l'agenda de l'Omen est enrichi par le calendrier économique de TradingView.
Sondé le 09/09, ``economic-calendar.tradingview.com/events`` répond **200 sans
cookie** depuis le Mac ET depuis l'Omen, et rend un ``result[]`` où chaque
rendez-vous porte son ``title``, son ``country``, son ``importance`` (1 =
haute) et surtout sa ``date`` complète.

⚠️ **Jamais de date construite.** La date d'un rendez-vous vient du champ
``date`` de l'API, point. Le dépôt a déjà payé pour savoir qu'une date
recalculée « à peu près » (fuseau devine, jour ouvré supposé) finit par
annoncer une réunion qui n'a pas lieu — et qu'on ne s'en aperçoit que le jour
où on l'a crue.

Découpage PUR / I-O, comme ``tvnews`` :

  * **PUR** : ``parse_events``, ``soon``, ``window`` — testés sur la fixture
    réelle ``backend/bots/tests/fixtures/tvcoach/tv_calendar.json``.
  * **I-O** : ``fetch`` (client HTTP injecté), et l'état de cache
    ``data/paper_trading/tvcalendar.state.json``.

⚠️ Le POINT dans le radical (``tvcalendar.state.json``) n'est pas cosmétique :
c'est la convention anti-fantôme du dépôt, expliquée en tête de
``paper/calendar.py`` — un fichier ``tvcalendar_state.json`` deviendrait un
compte fantôme nommé « tvcalendar » pour ``radar._users_with_portfolio``.

L'agenda de l'Omen (``paper/calendar.py``) lit le CACHE, jamais le réseau : la
vue ``GET /calendar`` reste locale et instantanée, et un TradingView muet
rétrécit l'agenda sans jamais le faire tomber.
"""
import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger("omenserver")

# --------------------------------------------------------------------------- #
# Constantes
# --------------------------------------------------------------------------- #

EVENTS_URL = ("https://economic-calendar.tradingview.com/events"
              "?from={start}&to={end}&countries={countries}")

# Mêmes en-têtes que ``tvnews`` : on se nomme.
HEADERS = {
    "User-Agent": "Mozilla/5.0 (OmenServer coach)",
    "Origin": "https://www.tradingview.com",
}

# Les pays dont un chiffre déplace VRAIMENT un portefeuille suisse en actions
# et en crypto. Liste courte et assumée : un agenda de 273 lignes n'est pas un
# agenda, c'est un mur.
DEFAULT_COUNTRIES = ("US", "EU", "CH", "GB", "JP", "CN")

# ``importance`` du flux : 1 = haute, 0 = moyenne, -1 = basse.
HIGH_IMPORTANCE = 1

DEFAULT_DAYS = 14

# Le calendrier ne bouge pas d'une minute à l'autre : une heure de cache est
# généreuse pour la fraîcheur et divise par soixante le nombre d'appels.
CACHE_TTL_S = 3600.0

STATE_NAME = "tvcalendar.state.json"

# « Bientôt » pour le push WebSocket ``calendar_soon``.
SOON_MINUTES = 30

# Plafond de l'état : deux semaines de rendez-vous à haute importance tiennent
# largement dedans ; c'est un garde-fou contre une source devenue folle.
MAX_ITEMS = 400

KIND_MACRO = "macro"


# --------------------------------------------------------------------------- #
# PUR — utilitaires
# --------------------------------------------------------------------------- #

def _text(value: Any) -> str:
    return " ".join(str(value if value is not None else "").split())


def _now_dt(now: Any = None) -> datetime:
    if isinstance(now, datetime):
        return now if now.tzinfo else now.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc)


def _parse_iso(value: Any) -> Optional[datetime]:
    """Horodatage ISO du flux (``2026-09-10T12:15:00.000Z``) -> datetime UTC.

    ``None`` si illisible — l'entrée est alors JETÉE, jamais rattrapée par une
    date de repli.
    """
    raw = _text(value)
    if not raw:
        return None
    try:
        moment = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def _iso_z(moment: datetime) -> str:
    """Instant -> ``AAAA-MM-JJTHH:MM:SS.000Z`` (la forme que l'API attend)."""
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


# --------------------------------------------------------------------------- #
# PUR — parseur
# --------------------------------------------------------------------------- #

def parse_events(payload: Any,
                 countries: Any = DEFAULT_COUNTRIES,
                 min_importance: int = HIGH_IMPORTANCE) -> List[Dict[str, Any]]:
    """Charge utile du calendrier -> entrées à la forme COMPLÈTE et stable ::

        {"id", "date": "AAAA-MM-JJ", "time_utc": "HH:MM", "kind": "macro",
         "label": "{PAYS} · {titre}", "country", "importance",
         "source": "tradingview"}

    Filtres : pays de ``countries`` (``None`` = tous) et
    ``importance >= min_importance`` (1 = haute). Une entrée sans ``date``
    lisible ou sans titre est jetée.

    Trié par instant croissant, puis par libellé — deux passages sur la même
    charge utile rendent exactement la même liste.
    """
    if isinstance(payload, dict):
        rows = payload.get("result")
    else:
        rows = payload
    if not isinstance(rows, (list, tuple)):
        return []

    wanted = None
    if countries is not None:
        wanted = {_text(c).upper() for c in countries if _text(c)}

    try:
        floor = int(min_importance)
    except (TypeError, ValueError):
        floor = HIGH_IMPORTANCE

    out: List[Dict[str, Any]] = []
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        country = _text(row.get("country")).upper()
        if wanted is not None and country not in wanted:
            continue
        try:
            importance = int(row.get("importance"))
        except (TypeError, ValueError):
            continue
        if importance < floor:
            continue
        moment = _parse_iso(row.get("date"))
        title = _text(row.get("title"))
        if moment is None or not title:
            continue
        ident = _text(row.get("id")) or ("%s|%s|%s" % (country, _iso_z(moment), title))
        if ident in seen:
            continue
        seen.add(ident)
        out.append({
            "id": ident,
            "date": moment.strftime("%Y-%m-%d"),
            "time_utc": moment.strftime("%H:%M"),
            "kind": KIND_MACRO,
            "label": "%s · %s" % (country, title) if country else title,
            "country": country,
            "importance": importance,
            "source": "tradingview",
        })
    out.sort(key=lambda e: (e["date"], e["time_utc"], e["label"]))
    return out


def window(items: Any, now: Any = None, days: int = DEFAULT_DAYS) -> List[Dict[str, Any]]:
    """Les entrées comprises entre aujourd'hui et ``days`` jours plus tard (PUR)."""
    now_dt = _now_dt(now)
    try:
        span = max(0, int(days))
    except (TypeError, ValueError):
        span = DEFAULT_DAYS
    first = now_dt.strftime("%Y-%m-%d")
    last = (now_dt + timedelta(days=span)).strftime("%Y-%m-%d")
    out = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        day = _text(item.get("date"))
        if day and first <= day <= last:
            out.append(dict(item))
    return out


def soon(items: Any, now: Any = None, minutes: int = SOON_MINUTES) -> List[Dict[str, Any]]:
    """Les rendez-vous qui tombent dans les ``minutes`` prochaines (PUR).

    Strictement à VENIR : un rendez-vous déjà passé n'est plus « bientôt », et
    un rendez-vous sans heure lisible est ignoré plutôt que supposé à minuit.
    """
    now_dt = _now_dt(now)
    try:
        span = max(0, int(minutes))
    except (TypeError, ValueError):
        span = SOON_MINUTES
    horizon = now_dt + timedelta(minutes=span)
    out = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        moment = _parse_iso("%sT%s:00+00:00" % (_text(item.get("date")),
                                                _text(item.get("time_utc"))))
        if moment is None:
            continue
        if now_dt <= moment <= horizon:
            out.append(dict(item))
    out.sort(key=lambda e: (e["date"], e["time_utc"]))
    return out


# --------------------------------------------------------------------------- #
# I-O — collecte (client injecté) et cache disque
# --------------------------------------------------------------------------- #

def _store():
    """``store`` importé PARESSEUSEMENT : ``store.DATA_DIR`` est monkeypatché
    par les tests, une constante figée à l'import raterait l'isolation."""
    from backend.bots.paper import store
    return store


def state_path() -> Path:
    """Chemin du cache — relit ``store.DATA_DIR`` à chaque appel."""
    return _store().DATA_DIR / STATE_NAME


def load_state() -> Dict[str, Any]:
    """Le cache, ou un état vierge. Corrompu -> vierge, jamais une exception."""
    path = state_path()
    if not path.is_file():
        return {"fetched_at": None, "items": [], "soon_sent": {}}
    try:
        with open(str(path), "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        logger.warning("paper tvcalendar: cache illisible, repart de zéro")
        return {"fetched_at": None, "items": [], "soon_sent": {}}
    if not isinstance(data, dict):
        return {"fetched_at": None, "items": [], "soon_sent": {}}
    items = data.get("items")
    sent = data.get("soon_sent")
    return {
        "fetched_at": data.get("fetched_at") or None,
        "items": [row for row in (items or []) if isinstance(row, dict)]
                 if isinstance(items, list) else [],
        "soon_sent": sent if isinstance(sent, dict) else {},
    }


def save_state(state: Dict[str, Any]) -> None:
    """Écriture ATOMIQUE 0o600 — le patron obligatoire du dépôt."""
    payload = {
        "fetched_at": (state or {}).get("fetched_at") or None,
        "items": list((state or {}).get("items") or [])[:MAX_ITEMS],
        "soon_sent": dict((state or {}).get("soon_sent") or {}),
    }
    _store()._atomic_write_json(state_path(), payload)


def fetch(client: Any, days: int = DEFAULT_DAYS, now: Any = None,
          countries: Any = DEFAULT_COUNTRIES,
          min_importance: int = HIGH_IMPORTANCE) -> List[Dict[str, Any]]:
    """Interroge le calendrier -> entrées parsées. Panne -> ``[]``.

    Le client est INJECTÉ (objet façon ``httpx`` : ``.get(url, headers=...)``).
    Un statut != 200 ou un corps illisible rend une liste vide sans lever.
    """
    now_dt = _now_dt(now)
    try:
        span = max(1, int(days))
    except (TypeError, ValueError):
        span = DEFAULT_DAYS
    code_list = ",".join(_text(c).upper() for c in (countries or ()) if _text(c))
    url = EVENTS_URL.format(start=_iso_z(now_dt),
                            end=_iso_z(now_dt + timedelta(days=span)),
                            countries=code_list or ",".join(DEFAULT_COUNTRIES))
    if client is None:
        return []
    try:
        response = client.get(url, headers=dict(HEADERS))
    except Exception as exc:      # noqa: BLE001 — réseau/TLS/HTTP
        logger.warning("paper tvcalendar: appel échoué (%s)", type(exc).__name__)
        return []
    if isinstance(response, (dict, list)):
        payload = response
    else:
        status = getattr(response, "status_code", 200)
        try:
            status = int(status)
        except (TypeError, ValueError):
            status = 200
        if status != 200:
            logger.warning("paper tvcalendar: statut %s", status)
            return []
        getter = getattr(response, "json", None)
        payload = None
        if callable(getter):
            try:
                payload = getter()
            except Exception:     # noqa: BLE001 — JSON cassé
                payload = None
        elif isinstance(getattr(response, "text", None), str):
            try:
                payload = json.loads(response.text)
            except ValueError:
                payload = None
    if payload is None:
        return []
    return parse_events(payload, countries=countries,
                        min_importance=min_importance)


def _stale(state: Dict[str, Any], now_dt: datetime, ttl_s: float) -> bool:
    """Le cache est-il froid ? (Horodatage illisible -> oui.)"""
    raw = (state or {}).get("fetched_at")
    if not raw:
        return True
    try:
        last = datetime.fromisoformat(str(raw))
    except (TypeError, ValueError):
        return True
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    delta = (now_dt - last).total_seconds()
    return delta < 0 or delta >= ttl_s


def refresh(client: Any = None, now: Any = None, days: int = DEFAULT_DAYS,
            force: bool = False, ttl_s: float = CACHE_TTL_S) -> List[Dict[str, Any]]:
    """Rafraîchit le cache si besoin -> les entrées à jour.

    Cache CHAUD (< ``ttl_s``) ou client absent -> on rend le cache tel quel,
    sans réseau. Collecte VIDE -> le cache précédent est CONSERVÉ : une source
    momentanément muette ne doit pas effacer un agenda déjà connu (§11 de la
    spec : « jamais une valeur périmée présentée comme fraîche », mais jamais
    non plus un agenda vidé par un 429).
    """
    now_dt = _now_dt(now)
    state = load_state()
    if client is not None and (force or _stale(state, now_dt, ttl_s)):
        items = fetch(client, days=days, now=now_dt)
        if items:
            state["items"] = items[:MAX_ITEMS]
            state["fetched_at"] = now_dt.isoformat()
            try:
                save_state(state)
            except (OSError, ImportError):
                logger.warning("paper tvcalendar: cache non persisté")
    return list(state.get("items") or [])


def cached_items(now: Any = None, days: Optional[int] = None) -> List[Dict[str, Any]]:
    """Le cache, fenêtré sur ``days`` jours (``None`` = tel quel). AUCUN réseau.

    C'est ce que lit l'agenda de l'Omen (``paper/calendar.py``) : la vue reste
    locale, donc instantanée, et un TradingView muet la rétrécit sans la
    casser.
    """
    items = list(load_state().get("items") or [])
    if days is None:
        return items
    return window(items, now=now, days=days)


def notify_soon(state: Dict[str, Any], now: Any = None,
                minutes: int = SOON_MINUTES,
                emit: Optional[Callable[..., Any]] = None) -> List[Dict[str, Any]]:
    """Pousse ``calendar_soon`` pour les rendez-vous imminents (best-effort).

    Un rendez-vous n'est poussé QU'UNE FOIS (``state["soon_sent"]``, purgé des
    entrées passées) : sans cette trace, chaque cycle de cinq minutes
    repousserait le même chiffre pendant une demi-heure.

    Mute ``state`` en place et rend ce qui a été poussé. ``emit`` est injecté
    (défaut ``paper_ws.emit``) et n'est jamais laissé lever.
    """
    now_dt = _now_dt(now)
    state = state if isinstance(state, dict) else {}
    sent = state.setdefault("soon_sent", {})
    if not isinstance(sent, dict):
        sent = {}
        state["soon_sent"] = sent

    today = now_dt.strftime("%Y-%m-%d")
    for key in [k for k, v in sent.items() if _text(v) < today]:
        del sent[key]

    due = [item for item in soon(state.get("items"), now_dt, minutes)
           if _text(item.get("id")) not in sent]
    if not due:
        return []

    pusher = emit
    if pusher is None:
        try:
            from backend.bots import paper_ws
            pusher = paper_ws.emit
        except Exception:         # noqa: BLE001 — module absent
            pusher = None
    for item in due:
        sent[_text(item.get("id"))] = _text(item.get("date"))
        if pusher is None:
            continue
        try:
            pusher(None, "calendar_soon", None, dict(item))
        except Exception:         # noqa: BLE001 — un push perdu n'est rien
            logger.debug("paper tvcalendar: push WS impossible")
    return due
