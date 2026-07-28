"""Gaps d'ouverture et statistiques historiques (fonctions pures)."""
from dataclasses import dataclass
from datetime import datetime
from typing import Dict, List, Optional
from zoneinfo import ZoneInfo

from .quotes import Candle

WEEKDAYS_IT = ["lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"]


@dataclass
class Gap:
    date: str                        # séance qui a ouvert (YYYY-MM-DD, tz de la place)
    gap_pct: float                   # (open - prev_close) / prev_close * 100
    open: float
    prev_close: float
    prev_date: Optional[str] = None  # séance de la clôture de référence


def _day(ts: int, tz_name: str) -> str:
    return datetime.fromtimestamp(ts, ZoneInfo(tz_name)).strftime("%Y-%m-%d")


def _pair_gap(prev: Candle, cur: Candle, tz_name: str) -> Optional[Gap]:
    """Gap d'une paire adjacente, ou None si la paire n'est pas calculable.

    Il faut une ouverture pour `cur` et une clôture pour `prev` : la bougie du
    jour peut n'avoir que son ouverture (clôture non consolidée), et une bougie
    de séance écourtée peut n'avoir que sa clôture.
    """
    if cur.open is None or not prev.close:
        return None
    pct = (cur.open - prev.close) / prev.close * 100.0
    return Gap(date=_day(cur.ts, tz_name), gap_pct=round(pct, 2),
               open=cur.open, prev_close=prev.close,
               prev_date=_day(prev.ts, tz_name))


def latest_gap(candles: List[Candle], tz_name: str) -> Optional[Gap]:
    """Gap le plus récent CALCULABLE, en remontant depuis la fin.

    On ne saute pas de séance pour fabriquer un gap : on cherche la dernière
    paire adjacente exploitable. Si la bougie du jour n'a pas encore
    d'ouverture, on rend le gap de la séance d'avant (et `date` le dit).
    """
    for i in range(len(candles) - 1, 0, -1):
        gap = _pair_gap(candles[i - 1], candles[i], tz_name)
        if gap is not None:
            return gap
    return None


def all_gaps(candles: List[Candle], tz_name: str) -> List[Gap]:
    """Tous les gaps consécutifs d'une série de bougies (pour les stats V4)."""
    gaps: List[Gap] = []
    for prev, cur in zip(candles, candles[1:]):
        gap = _pair_gap(prev, cur, tz_name)
        if gap is not None:
            gaps.append(gap)
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


def open_is_degenerate(gaps: Optional[List[Gap]], min_n: int = 5,
                       threshold: float = 0.6) -> bool:
    """La série d'ouvertures est-elle inexploitable pour un gap ?

    Certaines places ne publient pas de vrai prix d'ouverture chez Yahoo :
    l'`open` du jour vaut la clôture de la veille, donc le gap est nul par
    construction. Mesuré sur 2 ans le 2026-07-28 :

        ^FTSE      94,8 % de gaps exactement nuls  (|gap| moyen 0,002 %)
        ^STOXX50E   1,4 %                          (mais amplitude comprimée)
        ^GDAXI      0,6 %   ^FCHI 0,8 %   ^GSPC 1,6 %

    Afficher « gap ap. 0,00 % » tous les matins serait un fait FAUX. Mieux vaut
    ne rien afficher et dire pourquoi.

    En dessous de `min_n` points on ne tranche pas : accuser à tort priverait
    le lecteur d'un gap réel.
    """
    if not gaps or len(gaps) < min_n:
        return False
    nulls = sum(1 for g in gaps if g and abs(g.gap_pct) < 0.001)
    return nulls / float(len(gaps)) >= threshold


def biggest_gaps(gaps: List[Gap], n: int = 5) -> List[Gap]:
    return sorted(gaps, key=lambda g: abs(g.gap_pct), reverse=True)[:n]


def is_same_local_day(ts: int, now_ts: int, tz_name: str) -> bool:
    """La bougie date-t-elle d'« aujourd'hui » dans le fuseau de la place ?"""
    return _day(ts, tz_name) == _day(now_ts, tz_name)
