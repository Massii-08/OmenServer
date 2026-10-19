"""Séances de bourse du scanner d'actions (PUR, zéro réseau).

Pourquoi ce module existe (rapport de test réel du 19/10) : un scan lancé
pendant la séance européenne mettait côte à côte deux choses incomparables.

- Le volume relatif TradingView (``relative_volume_10d_calc``) d'une séance EN
  COURS compare le volume PARTIEL du jour à une journée moyenne COMPLÈTE :
  médianes européennes 0,22 à 0,30 en début d'après-midi. Celui d'une bourse
  FERMÉE est celui de sa dernière séance complète : médiane américaine 1,17.
  Résultat : 21 lignes américaines sur 25.
- Les cours d'une bourse fermée datent de sa dernière séance : une variation
  du vendredi ne peut ni confirmer ni « rendre en retard » une news du lundi
  (CRWV −11,9 % affiché à côté de « CoreWeave jumps as Goldman upgrades »).

Ce que ce module fournit : l'état de chaque place (ouverte / fermée), la part
de séance écoulée, l'heure de la dernière clôture, l'ajustement du volume et
le quota par marché de la présélection.

⚠️ Limites assumées, à connaître :
- les horaires sont une TABLE (mêmes heures que Market Pulse, sondées le
  29/07) : week-ends gérés, **jours fériés NON** — un férié en semaine passe
  pour une séance ouverte. Le garde-fou ``IMPLAUSIBLE_MEDIAN`` rattrape le cas
  le plus visible (le screener rend alors la séance précédente complète) ;
- le volume d'une séance n'est pas réparti uniformément (beaucoup à
  l'ouverture et à la clôture) : diviser par la part de TEMPS écoulée
  surestime un peu le matin. D'où le plancher ``MIN_ELAPSED`` et le fait que
  le volume ne fait que CONFIRMER une news, il ne la remplace jamais.
"""
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

# Part de séance minimale pour diviser : 5 minutes après l'ouverture, diviser
# par 0,01 ferait d'un ordre isolé une anomalie ×100.
MIN_ELAPSED = 0.2
# Médiane AJUSTÉE au-delà de laquelle on refuse d'ajuster un marché : un
# marché entier qui échange trois fois sa moyenne, c'est presque toujours une
# séance qu'on croit ouverte et qui ne l'est pas (férié).
IMPLAUSIBLE_MEDIAN = 3.0

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


def adjust_rel_volume(rows: List[Dict[str, Any]],
                      states: Dict[str, Dict[str, Any]]) -> Dict[str, List[str]]:
    """Ramène le volume relatif d'une séance EN COURS à une journée entière.

    Modifie les lignes en place (``rel_volume`` ajusté, ``rel_volume_raw``
    gardé pour l'affichage) et rend ``{adjusted, skipped}`` par marché.
    """
    by_market: Dict[str, List[Dict[str, Any]]] = {}
    for row in rows:
        by_market.setdefault(row.get("market"), []).append(row)
    adjusted: List[str] = []
    skipped: List[str] = []
    for market_id, group in by_market.items():
        state = states.get(market_id) or {}
        if state.get("state") != "open" or state.get("elapsed") is None:
            continue
        fraction = max(float(state["elapsed"]), MIN_ELAPSED)
        values = [r["rel_volume"] for r in group if isinstance(r.get("rel_volume"), (int, float))
                  and not isinstance(r.get("rel_volume"), bool)]
        if values and median(values) / fraction > IMPLAUSIBLE_MEDIAN:
            skipped.append(market_id)
            continue
        for row in group:
            raw = row.get("rel_volume")
            if isinstance(raw, (int, float)) and not isinstance(raw, bool):
                row["rel_volume_raw"] = raw
                row["rel_volume"] = round(raw / fraction, 4)
        adjusted.append(market_id)
    return {"adjusted": sorted(adjusted), "skipped": sorted(skipped)}


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
