"""Horloge des marchés : ouvert/fermé, calculé depuis les métadonnées Yahoo.

La source des horaires est `currentTradingPeriod.regular` (start/end epoch) de la
réponse chart : Yahoo y intègre déjà week-ends et jours fériés → aucune table de
calendrier à maintenir côté bot. `now_ts` est injectable (tests déterministes).
"""
from dataclasses import dataclass
from datetime import datetime
from typing import Optional
from zoneinfo import ZoneInfo

from .quotes import MarketData


@dataclass
class ClockState:
    status: str                    # "open" | "closed" | "unknown"
    opens_at: Optional[int]        # epoch de la prochaine ouverture connue (si fermé avant séance)
    closes_at: Optional[int]       # epoch de la clôture de la séance courante/du jour
    local_time: str                # heure locale de la place, "HH:MM"
    tz_name: str
    session_open: Optional[str] = None   # heure d'ouverture de la séance, "HH:MM" locale
    session_close: Optional[str] = None  # heure de clôture de la séance, "HH:MM" locale


def _hhmm(ts: Optional[int], tz_name: str) -> Optional[str]:
    if not ts:
        return None
    return datetime.fromtimestamp(ts, ZoneInfo(tz_name)).strftime("%H:%M")


def market_state(md: MarketData, now_ts: int) -> ClockState:
    """État de la place à `now_ts`, d'après la séance annoncée par Yahoo.

    Observé en réel : après la clôture, Yahoo fait AVANCER `currentTradingPeriod`
    vers la séance SUIVANTE (^N225 à 01:49 JST annonçait déjà 09:00-15:30 du
    lendemain) → `opens_at` est renseigné la plupart du temps. Dans la fenêtre
    où la période pointe encore la séance écoulée, on ne devine pas la date de
    réouverture (jours fériés) : on n'expose que l'HEURE de séance, qui, elle,
    est stable.
    """
    local_time = _hhmm(now_ts, md.tz_name)
    start, end = md.regular_start, md.regular_end
    s_open, s_close = _hhmm(start, md.tz_name), _hhmm(end, md.tz_name)
    if not start or not end:
        return ClockState("unknown", None, None, local_time, md.tz_name)
    if start <= now_ts < end:
        return ClockState("open", None, end, local_time, md.tz_name, s_open, s_close)
    if now_ts < start:
        return ClockState("closed", start, end, local_time, md.tz_name, s_open, s_close)
    # Séance écoulée et période pas encore avancée : pas de date de réouverture.
    return ClockState("closed", None, end, local_time, md.tz_name, s_open, s_close)
