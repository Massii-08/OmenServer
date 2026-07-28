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


def market_state(md: MarketData, now_ts: int) -> ClockState:
    local_time = datetime.fromtimestamp(now_ts, ZoneInfo(md.tz_name)).strftime("%H:%M")
    start, end = md.regular_start, md.regular_end
    if not start or not end:
        return ClockState("unknown", None, None, local_time, md.tz_name)
    if start <= now_ts < end:
        return ClockState("open", None, end, local_time, md.tz_name)
    if now_ts < start:
        return ClockState("closed", start, end, local_time, md.tz_name)
    # Séance du jour terminée. La prochaine ouverture n'est pas dans cette
    # réponse (Yahoo ne donne que la séance courante) — le consommateur
    # l'affichera comme « fermé » sans heure de réouverture.
    return ClockState("closed", None, end, local_time, md.tz_name)
