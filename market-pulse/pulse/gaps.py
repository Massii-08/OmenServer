"""Gaps d'ouverture et statistiques historiques (fonctions pures)."""
from dataclasses import dataclass
from datetime import datetime
from typing import Dict, List, Optional
from zoneinfo import ZoneInfo

from .quotes import Candle

WEEKDAYS_IT = ["lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"]


@dataclass
class Gap:
    date: str          # date de la séance qui a ouvert (YYYY-MM-DD, tz de la place)
    gap_pct: float     # (open - prev_close) / prev_close * 100
    open: float
    prev_close: float


def _day(ts: int, tz_name: str) -> str:
    return datetime.fromtimestamp(ts, ZoneInfo(tz_name)).strftime("%Y-%m-%d")


def latest_gap(candles: List[Candle], tz_name: str) -> Optional[Gap]:
    """Gap entre la dernière bougie et la clôture de la précédente."""
    if len(candles) < 2:
        return None
    prev, last = candles[-2], candles[-1]
    if not prev.close:
        return None
    pct = (last.open - prev.close) / prev.close * 100.0
    return Gap(date=_day(last.ts, tz_name), gap_pct=round(pct, 2),
               open=last.open, prev_close=prev.close)


def all_gaps(candles: List[Candle], tz_name: str) -> List[Gap]:
    """Tous les gaps consécutifs d'une série de bougies (pour les stats V4)."""
    gaps: List[Gap] = []
    for prev, cur in zip(candles, candles[1:]):
        if not prev.close:
            continue
        pct = (cur.open - prev.close) / prev.close * 100.0
        gaps.append(Gap(date=_day(cur.ts, tz_name), gap_pct=round(pct, 2),
                        open=cur.open, prev_close=prev.close))
    return gaps


def weekday_stats(gaps: List[Gap]) -> Dict[str, dict]:
    """Stats par jour de semaine : n, gap moyen, |gap| moyen, % de gaps haussiers."""
    buckets: Dict[int, List[float]] = {}
    for g in gaps:
        wd = datetime.strptime(g.date, "%Y-%m-%d").weekday()
        buckets.setdefault(wd, []).append(g.gap_pct)
    out: Dict[str, dict] = {}
    for wd in sorted(buckets):
        vals = buckets[wd]
        out[WEEKDAYS_IT[wd]] = {
            "n": len(vals),
            "avg_gap_pct": round(sum(vals) / len(vals), 3),
            "avg_abs_gap_pct": round(sum(abs(v) for v in vals) / len(vals), 3),
            "pct_up": round(100.0 * sum(1 for v in vals if v > 0) / len(vals), 1),
        }
    return out


def biggest_gaps(gaps: List[Gap], n: int = 5) -> List[Gap]:
    return sorted(gaps, key=lambda g: abs(g.gap_pct), reverse=True)[:n]


def is_same_local_day(ts: int, now_ts: int, tz_name: str) -> bool:
    """La bougie date-t-elle d'« aujourd'hui » dans le fuseau de la place ?"""
    return _day(ts, tz_name) == _day(now_ts, tz_name)
