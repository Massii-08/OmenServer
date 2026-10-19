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
  Une table d'horaires ne suffisait pas à le savoir : elle ignore les fériés
  (Hong Kong, lundi 19/10 : hors séance, barre du vendredi) et le différé de
  15 minutes (New York « ouverte » à 09:30 alors que les données étaient
  encore en pré-ouverture). L'état vient donc de TradingView, ligne par ligne.

Ce que ce module fournit : la séance que décrivent les chiffres de chaque
ligne (``row_session`` : état réel, date locale de la barre, chiffres d'une
séance antérieure ou non, instant où les cours ont été figés), un résumé par
marché, le volume rapporté à son marché et le quota par marché de la
présélection.

⚠️ Limites assumées, à connaître :
- la table des horaires (mêmes heures que Market Pulse, sondées le 29/07) ne
  connaît pas les fériés. Elle ne décide plus de l'état qu'en REPLI (univers
  Yahoo, colonnes de séance mortes), où un férié en semaine passe pour une
  séance ouverte. Elle fournit toujours la part de séance écoulée et l'heure
  de clôture : une place absente de la table n'a pas de ``last_close`` ;
- la médiane est celle de l'univers BALAYÉ (les titres les plus échangés de
  chaque marché) : un marché entier en effervescence revient lui aussi vers
  1,0, d'où la borne ``VOLUME_MEDIAN_CLAMP`` — et le volume ne fait que
  CONFIRMER une news, il ne la remplace jamais.
"""
import math
from collections import Counter
from datetime import date, datetime, timedelta, timezone
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

# ``current_session`` de TradingView -> état de séance du scanner. Valeurs VUES
# le 19/10 : market, pre_market, out_of_session (post_market existe aussi).
# Toute autre valeur rend None : un état n'est jamais deviné.
TV_SESSION_STATES: Dict[str, str] = {
    "market": "open",
    "pre_market": "pre_open",
    "post_market": "closed",
    "out_of_session": "closed",
}
SESSION_STATES = ("open", "pre_open", "closed")

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


# --------------------------------------------------------------------------- #
# L'état RÉEL de la séance, lu dans TradingView (fériés compris)
# --------------------------------------------------------------------------- #

def tv_session_state(value: Any) -> Optional[str]:
    """``current_session`` -> ``open`` / ``pre_open`` / ``closed``, sinon None."""
    return TV_SESSION_STATES.get(value) if isinstance(value, str) else None


def _zone(name: Any) -> Optional[ZoneInfo]:
    """Fuseau IANA utilisable, sinon None : absent, inconnu, ou chemin piégé
    (« ../../etc ») — que ZoneInfo refuse lui-même, sans ouvrir de fichier."""
    if not isinstance(name, str) or not name:
        return None
    try:
        return ZoneInfo(name)
    except Exception:             # noqa: BLE001 — ValueError, ZoneInfoNotFoundError, OSError…
        return None


def _local(moment: datetime, tz_name: Any) -> datetime:
    """``moment`` à l'heure de la place ; en UTC si le fuseau est inutilisable."""
    zone = _zone(tz_name)
    if zone is not None:
        try:
            return moment.astimezone(zone)
        except (OverflowError, ValueError, OSError):
            pass
    return moment.astimezone(timezone.utc)


def session_date(time_value: Any, tz_name: Any) -> Optional[str]:
    """Date LOCALE (``YYYY-MM-DD``) de la séance que décrivent les chiffres.

    ``time`` de TradingView = ouverture de la barre journalière, UNIX en
    secondes (millisecondes tolérées). Sydney 1792360800 = 18/10 22:00 UTC,
    soit le LUNDI 19/10 sur place : la date UTC serait fausse. Fuseau absent,
    inconnu ou invalide -> date UTC ; horodatage illisible -> None. Ne lève
    jamais.
    """
    stamp = _finite(time_value)
    if stamp is None or stamp <= 0:
        return None
    if stamp > 1e11:              # millisecondes
        stamp /= 1000.0
    if stamp < 1e8:               # ni secondes ni millisecondes plausibles
        return None
    try:
        moment = datetime.fromtimestamp(stamp, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None
    return _local(moment, tz_name).date().isoformat()


def local_today(tz_name: Any, now: datetime) -> str:
    """Le jour qu'il est SUR PLACE à ``now`` (en UTC si le fuseau est inutilisable)."""
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return _local(now, tz_name).date().isoformat()


def is_stale(day: Any, tz_name: Any, now: datetime) -> bool:
    """Les chiffres datent-ils d'une séance ANTÉRIEURE au jour local de la place ?

    Quel que soit l'état : pré-ouverture du lundi (chiffres du vendredi),
    week-end, nuit, férié, ou titre sans échange aujourd'hui dans une séance
    ouverte. Une place clôturée le jour même n'est PAS en retard.
    """
    try:
        return date.fromisoformat(day) < date.fromisoformat(local_today(tz_name, now))
    except (TypeError, ValueError):
        return False


def _close_of(market_id: Any, day: str) -> Optional[datetime]:
    """Clôture de la séance ``day`` d'après ``HOURS`` (None : place absente de
    la table, date illisible — jamais supposée)."""
    hours = HOURS.get(market_id) if isinstance(market_id, str) else None
    if hours is None:
        return None
    try:
        session_day = date.fromisoformat(day)
    except (TypeError, ValueError):
        return None
    return _at(session_day, _hm(hours[2]), ZoneInfo(hours[0])).astimezone(timezone.utc)


def _round3(value: Any) -> Optional[float]:
    return round(value, 3) if isinstance(value, float) else None


def row_session(row: Dict[str, Any], now: datetime) -> Dict[str, Any]:
    """La séance que décrivent les chiffres d'une ligne (PUR).

    TradingView (``session_state`` ET ``session_date`` connus) : l'état réel,
    fériés compris — la table croyait Hong Kong ouverte un lundi férié, et les
    États-Unis ouverts à 09:30 alors que les données différées étaient encore
    en pré-ouverture. Sinon (repli Yahoo, colonnes mortes) : la table.

    ``{source, state, date, stale, elapsed, local_time, last_close}`` —
    ``elapsed`` seulement si TradingView ET la table disent la place ouverte ;
    ``last_close`` (ISO UTC) = la clôture de la séance des chiffres quand les
    cours sont figés (place pas ouverte, ou chiffres d'une séance antérieure),
    jamais une clôture encore à venir ni celle d'une place absente de la table.
    """
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    market_id = row.get("market")
    table = session_state(market_id, now)
    state, day = row.get("session_state"), row.get("session_date")
    if state in SESSION_STATES and isinstance(day, str) and day:
        stale = is_stale(day, row.get("session_tz"), now)
        elapsed = table["elapsed"] if state == "open" and table["state"] == "open" else None
        last_close = None
        if state != "open" or stale:
            close = _close_of(market_id, day)
            if close is not None and close <= now:
                last_close = close.isoformat(timespec="seconds")
        return {"source": "tradingview", "state": state, "date": day, "stale": stale,
                "elapsed": _round3(elapsed), "local_time": table["local_time"],
                "last_close": last_close}
    return {"source": "table", "state": table["state"], "date": None, "stale": False,
            "elapsed": _round3(table["elapsed"]), "local_time": table["local_time"],
            # place ouverte : cours vivants, rien n'est figé
            "last_close": table["last_close"] if table["state"] == "closed" else None}


def market_sessions(rows: Iterable[Dict[str, Any]], now: datetime) -> Dict[Any, Dict[str, Any]]:
    """Résumé par marché, dérivé des lignes de son univers : l'état le plus
    fréquent, la date la plus fréquente parmi ces lignes, et ``stale`` /
    ``elapsed`` / ``source`` d'une ligne qui porte cet état et cette date."""
    groups: Dict[Any, List[Dict[str, Any]]] = {}
    for row in rows:
        groups.setdefault(row.get("market"), []).append(row_session(row, now))
    summary: Dict[Any, Dict[str, Any]] = {}
    for market_id, sessions in groups.items():
        state = Counter(s["state"] for s in sessions).most_common(1)[0][0]
        same_state = [s for s in sessions if s["state"] == state]
        days = Counter(s["date"] for s in same_state if s["date"])
        day = days.most_common(1)[0][0] if days else None
        ref = next(s for s in same_state if s["date"] == day)
        summary[market_id] = {"state": state, "date": day, "stale": ref["stale"],
                              "elapsed": ref["elapsed"], "source": ref["source"]}
    return summary


def price_asof(session: Optional[Dict[str, Any]]) -> Optional[datetime]:
    """Instant auquel les chiffres d'une ligne ont été figés : la ``last_close``
    de sa séance (``row_session``), ``None`` quand les cours sont vivants ou
    que la séance est inconnue."""
    last_close = session.get("last_close") if isinstance(session, dict) else None
    if not isinstance(last_close, str):
        return None
    try:
        return datetime.fromisoformat(last_close)
    except ValueError:
        return None
