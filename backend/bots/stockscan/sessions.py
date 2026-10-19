"""Séances de bourse du scanner d'actions (PUR, zéro réseau).

Pourquoi ce module existe (rapports de test réels du 19/10) : un scan lancé
pendant la séance européenne mettait côte à côte deux choses incomparables.

- Le volume relatif 10 j de TradingView (``relative_volume_10d_calc``) d'une
  séance EN COURS compare le volume PARTIEL du jour à une journée moyenne
  COMPLÈTE : médianes européennes 0,27 à 0,40 à 15:30, contre 1,22 pour des
  États-Unis pas encore ouverts (leur dernière séance, complète). Diviser par
  la part de TEMPS écoulée ne suffit pas : les échanges se concentrent à la
  clôture (courbe en U), 77 % du temps n'est pas 77 % du volume — les
  médianes européennes restaient à ~0,31-0,41 contre 1,17. Le « Relative
  Volume at Time » de TradingView (``rel_volume_time`` : volume cumulé rapporté
  à la moyenne À LA MÊME HEURE) donne 0,86-1,06 en Europe et 1,19 aux US ;
  rapporté à la médiane de son marché, chacun revient à 1,0 et un « ×2 » veut
  dire la même chose partout.
- Les cours d'une bourse fermée datent de sa dernière séance : une variation
  du vendredi ne peut ni confirmer ni « rendre en retard » une news du lundi
  (CRWV −11,9 % affiché à côté de « CoreWeave jumps as Goldman upgrades »).

Ce que ce module fournit : l'état de chaque place (ouverte / fermée), la part
de séance écoulée, l'heure de la dernière clôture, le volume rapporté à son
marché et le quota par marché de la présélection.

⚠️ Limites assumées, à connaître :
- les horaires sont une TABLE (mêmes heures que Market Pulse, sondées le
  29/07) : week-ends gérés, **jours fériés NON** — un férié en semaine passe
  pour une séance ouverte ;
- la médiane est celle de l'univers BALAYÉ (les titres les plus échangés de
  chaque marché) : un marché entier en effervescence revient lui aussi vers
  1,0, d'où la borne ``VOLUME_MEDIAN_CLAMP`` — et le volume ne fait que
  CONFIRMER une news, il ne la remplace jamais.
"""
import math
from datetime import datetime, timedelta, timezone
from statistics import median
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from zoneinfo import ZoneInfo

# (fuseau IANA, ouverture, clôture) en heure LOCALE de la place.
HOURS: Dict[str, Tuple[str, str, str]] = {
    "switzerland": ("Europe/Zurich", "09:00", "17:30"),
    "italy": ("Europe/Rome", "09:00", "17:30"),
    "germany": ("Europe/Berlin", "09:00", "17:30"),
    "france": ("Europe/Paris", "09:00", "17:30"),
    "netherlands": ("Europe/Amsterdam", "09:00", "17:30"),
    "spain": ("Europe/Madrid", "09:00", "17:30"),
    "uk": ("Europe/London", "08:00", "16:30"),
    "america": ("America/New_York", "09:30", "16:00"),
}

# Volume relatif rapporté à la médiane de SON marché : en dessous de 8 valeurs,
# une médiane ne dit rien du marché (le volume reste tel quel, diviseur 1).
VOLUME_MEDIAN_MIN_ROWS = 8
# Bornes du DIVISEUR : la correction ne multiplie ni ne divise jamais le volume
# par plus de 2. Une médiane extrême (marché entier en effervescence, colonne
# « à l'heure » morte qui laisse le 10 j partiel d'une séance en cours) ne doit
# ni effacer une vraie anomalie de marché, ni gonfler un volume sans limite.
VOLUME_MEDIAN_CLAMP = (0.5, 2.0)

# Part de la présélection RÉSERVÉE à parts égales entre les marchés présents ;
# le reste va au classement global. Le partage INTÉGRAL (toute la présélection
# répartie à parts égales), rejoué sur le snapshot réel du 19/10 à 13:30 UTC,
# donnait 8 places par marché et une liste finale de 23 lignes dont 4
# américaines et 17 candidats sans catalyseur — pour des États-Unis qui font
# 61 % de l'univers et ont 60 sociétés qui publient leurs résultats sous
# 7 jours. La version de référence (cette moitié + le volume « à l'heure »
# rapporté à la médiane de son marché) donnait 24 US et 4 par place
# européenne, et tous les marchés dans la liste finale (16 US, 9 Europe).
SHORTLIST_RESERVED_SHARE = 0.5


def _hm(text: str) -> Tuple[int, int]:
    hour, minute = text.split(":")
    return int(hour), int(minute)


def _at(day, hm: Tuple[int, int], tz: ZoneInfo) -> datetime:
    return datetime(day.year, day.month, day.day, hm[0], hm[1], tzinfo=tz)


def session_state(market_id: Any, now: datetime) -> Dict[str, Any]:
    """État de la place à ``now`` (datetime conscient).

    ``{state: open|closed|unknown, elapsed, last_close, local_time, opens, closes, tz}``
    — ``elapsed`` (0-1) seulement si ouverte ; ``last_close`` = ISO UTC de la
    dernière clôture PASSÉE (ce que valent les cours d'une place fermée).
    """
    hours = HOURS.get(market_id) if isinstance(market_id, str) else None
    if hours is None:
        return {"state": "unknown", "elapsed": None, "last_close": None,
                "local_time": None, "opens": None, "closes": None, "tz": None}
    tz_name, opens, closes = hours
    tz = ZoneInfo(tz_name)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    local = now.astimezone(tz)
    o_hm, c_hm = _hm(opens), _hm(closes)
    today_open, today_close = _at(local, o_hm, tz), _at(local, c_hm, tz)
    trading_day = local.weekday() < 5

    state, elapsed = "closed", None
    if trading_day and today_open <= local < today_close:
        state = "open"
        elapsed = (local - today_open).total_seconds() / (today_close - today_open).total_seconds()

    # Dernière clôture passée : aujourd'hui si la séance est finie, sinon le
    # jour ouvré précédent.
    day = local.date()
    if not (trading_day and local >= today_close):
        day -= timedelta(days=1)
        while day.weekday() >= 5:
            day -= timedelta(days=1)
    last_close = _at(day, c_hm, tz).astimezone(timezone.utc)
    return {"state": state, "elapsed": elapsed,
            "last_close": last_close.isoformat(timespec="seconds"),
            "local_time": local.strftime("%H:%M"), "opens": opens, "closes": closes,
            "tz": tz_name}


def _finite(value: Any) -> Optional[float]:
    """Un nombre fini, ou ``None`` (booléens, NaN et ±inf compris)."""
    if value is None or isinstance(value, bool):
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def normalize_volume(rows: List[Dict[str, Any]]) -> Dict[Any, Optional[float]]:
    """Rapporte le volume relatif de chaque ligne à la médiane de son marché.

    Signal d'une ligne : ``rel_volume_time`` (« à l'heure ») s'il est connu,
    sinon ``rel_volume`` (10 j). Médiane du signal par marché à partir de
    ``VOLUME_MEDIAN_MIN_ROWS`` valeurs, diviseur = cette médiane bornée par
    ``VOLUME_MEDIAN_CLAMP`` (1 sans médiane). Modifie les lignes en place :
    ``rel_volume_raw`` = le signal, ``rel_volume`` = signal ÷ diviseur arrondi
    au centième — la valeur que le score et le départage lisent déjà. Les
    valeurs non finies sont ignorées (et remises à ``None`` : jamais
    d'``Infinity`` dans results.json). Rend ``{marché: médiane au millième ou
    None}``.
    """
    groups: Dict[Any, List[Tuple[Dict[str, Any], Optional[float]]]] = {}
    for row in rows:
        at_time = _finite(row.get("rel_volume_time"))
        row["rel_volume_time"] = at_time
        signal = at_time if at_time is not None else _finite(row.get("rel_volume"))
        groups.setdefault(row.get("market"), []).append((row, signal))
    low, high = VOLUME_MEDIAN_CLAMP
    medians: Dict[Any, Optional[float]] = {}
    for market_id, group in groups.items():
        values = [signal for _, signal in group if signal is not None]
        mid = median(values) if len(values) >= VOLUME_MEDIAN_MIN_ROWS else None
        divisor = min(max(mid, low), high) if mid is not None else 1.0
        for row, signal in group:
            row["rel_volume_raw"] = signal
            row["rel_volume"] = round(signal / divisor, 2) if signal is not None else None
        medians[market_id] = round(mid, 3) if mid is not None else None
    return medians


def shortlist_with_quota(ranked: Sequence[Dict[str, Any]], size: int,
                         markets: Iterable[str]) -> List[Dict[str, Any]]:
    """Présélection de ``size`` lignes : la part ``SHORTLIST_RESERVED_SHARE``
    est RÉSERVÉE à parts égales entre les marchés présents (chacun ses
    meilleurs titres, au moins une place), le reste au classement global.

    Les places qu'un marché ne remplit pas reviennent au classement global ;
    jamais plus de ``size`` lignes ; la sortie garde l'ordre de ``ranked``
    (avec un seul marché, cela revient à couper le classement).
    """
    size = max(0, int(size))
    present = [m for m in dict.fromkeys(markets) if any(r.get("market") == m for r in ranked)]
    chosen = set()
    if present and size:
        per_market = max(1, int(size * SHORTLIST_RESERVED_SHARE) // len(present))
        for market_id in present:
            taken = 0
            for index, row in enumerate(ranked):
                if taken >= per_market:
                    break
                if row.get("market") == market_id:
                    chosen.add(index)
                    taken += 1
    for index in range(len(ranked)):
        if len(chosen) >= size:
            break
        chosen.add(index)
    return [ranked[i] for i in sorted(chosen)][:size]


def states_for(markets: Iterable[str], now: datetime) -> Dict[str, Dict[str, Any]]:
    return {m: session_state(m, now) for m in dict.fromkeys(markets)}


def price_asof(state: Optional[Dict[str, Any]]) -> Optional[datetime]:
    """Instant auquel les cours d'une place FERMÉE ont été figés, ``None`` si
    la place est ouverte (cours vivants) ou d'état inconnu."""
    if not state or state.get("state") != "closed" or not state.get("last_close"):
        return None
    try:
        return datetime.fromisoformat(state["last_close"])
    except ValueError:
        return None
