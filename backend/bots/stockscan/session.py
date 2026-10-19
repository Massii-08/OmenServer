"""État de séance d'une ligne du screener (PUR) : de QUAND datent ses chiffres.

Pourquoi : un relevé pris le lundi 19/10/2026 à 13:30 UTC affichait, pour
CoreWeave, une variation de -11,9 % à côté de la dépêche « CoreWeave jumps as
Goldman upgrades ». Cette variation était celle de VENDREDI : les États-Unis
étaient en pré-ouverture, et le screener rend alors la dernière séance
complète. Variation, gap et volume décrivent la séance de la barre journalière,
pas forcément celle d'aujourd'hui — il faut le dire à côté du chiffre.

Trois colonnes du screener, lues sans jamais deviner :

- ``current_session`` -> ``state_of`` : ``open`` / ``pre_open`` / ``closed`` ;
  toute autre valeur rend ``None`` ;
- ``time`` (ouverture de la barre journalière, UNIX UTC) + ``timezone`` (IANA)
  -> ``bar_date`` : le JOUR de cette séance à l'heure de la place (une barre
  ouverte à 23:00 UTC le dimanche est la séance du lundi à Sydney) ;
- ``is_stale`` : la place n'est pas en séance ET ses chiffres datent d'un jour
  antérieur à son jour local — pré-ouverture du lundi (chiffres du vendredi),
  nuit, week-end, jour férié.

Rien ne lève : une valeur illisible rend ``None`` (``False`` pour
``is_stale``), un fuseau absent, inconnu ou invalide se replie sur l'UTC.
Zéro dépendance : ``zoneinfo`` est dans la bibliothèque standard depuis 3.9.
"""
import math
import re
from datetime import date, datetime, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo

# ``current_session`` du flux de cotation TradingView -> état affiché.
_STATES = {
    "market": "open",
    "pre_market": "pre_open",
    "post_market": "closed",
    "out_of_session": "closed",
}

# Un nom IANA (« Europe/Rome », « America/Argentina/Buenos_Aires », « Etc/GMT+5 »),
# jamais un chemin : ``ZoneInfo`` refuse déjà « .. », on ne le lui tend même pas.
_TZ_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_+\-]*(?:/[A-Za-z0-9_+\-]+){0,2}")

STALE_STATES = ("pre_open", "closed")


def state_of(raw: Any) -> Optional[str]:
    """``current_session`` -> ``open`` / ``pre_open`` / ``closed``, sinon ``None``."""
    return _STATES.get(raw) if isinstance(raw, str) else None


def _zone(tz_name: Any) -> Any:
    """Le fuseau de la place, ou l'UTC s'il est absent, inconnu ou invalide."""
    if not isinstance(tz_name, str) or not _TZ_NAME.fullmatch(tz_name):
        return timezone.utc
    try:
        return ZoneInfo(tz_name)
    except Exception:             # noqa: BLE001 — nom inconnu, base absente, nom refusé
        return timezone.utc


def _timestamp(value: Any) -> Optional[float]:
    """Horodatage UNIX en secondes (millisecondes acceptées), ou ``None``."""
    if value is None or isinstance(value, bool):
        return None
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(num) or num <= 0:
        return None
    if num > 1e11:                # millisecondes (même règle que screener._date_of)
        num /= 1000.0
    if num < 1e8:                 # ni secondes ni millisecondes plausibles
        return None
    return num


def bar_date(bar_time: Any, tz_name: Any) -> Optional[str]:
    """Ouverture de la barre journalière -> ``YYYY-MM-DD`` LOCAL de la place."""
    ts = _timestamp(bar_time)
    if ts is None:
        return None
    try:
        return datetime.fromtimestamp(ts, tz=_zone(tz_name)).date().isoformat()
    except Exception:             # noqa: BLE001 — hors des bornes du calendrier
        return None


def local_today(now: Any, tz_name: Any) -> Optional[str]:
    """Le jour de la place à l'instant ``now`` (une horloge sans fuseau est de l'UTC)."""
    if not isinstance(now, datetime):
        return None
    moment = now if now.tzinfo is not None else now.replace(tzinfo=timezone.utc)
    try:
        return moment.astimezone(_zone(tz_name)).date().isoformat()
    except Exception:             # noqa: BLE001
        return None


def _day(value: Any) -> Optional[date]:
    if not isinstance(value, str) or len(value) < 10:
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def is_stale(state: Any, session_date: Any, tz_name: Any, now: Any) -> bool:
    """Les chiffres datent-ils d'une séance ANTÉRIEURE au jour local de la place ?

    Jamais vrai pour une place en séance, ni pour une place clôturée le jour
    même (chiffres de la séance qui vient de finir) ; état ou date inconnus :
    faux — on n'avertit pas sur une supposition.
    """
    if state not in STALE_STATES:
        return False
    figures = _day(session_date)
    today = _day(local_today(now, tz_name))
    if figures is None or today is None:
        return False
    return figures < today
