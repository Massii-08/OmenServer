"""Le score d'un candidat (PUR) — chaque point a sa raison.

Spec §6. Les poids sont des CONSTANTES verrouillées par test : on ne les
« règle » pas en douce, on les change ici et on dit pourquoi dans l'historique.

Philosophie, en trois phrases :

- un catalyseur est OBLIGATOIRE (une news admise, des résultats sous 7 jours,
  une hypothèse du coach ou un dépôt SEC) : un volume anormal sans aucune
  raison connue n'est pas un catalyseur ;
- le volume CONFIRME la news, il ne la remplace pas ;
- une news publique est souvent déjà dans le prix : un titre qui a déjà
  beaucoup bougé est marqué « en retard » et perd des points, une mauvaise
  nouvelle le marque en rouge (et l'exclut si l'utilisateur l'a demandé).

Rien ici ne dit « achète » : la sortie est un classement de CANDIDATS À
ÉTUDIER, avec la liste exacte des raisons.
"""
from datetime import date, datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Set

from backend.bots.stockscan import news as nw

# --- poids (spec §6) --------------------------------------------------------
NEWS_MAX = 30
NEWS_UNIT = 10              # points par unité de « news pondérée »
NEUTRAL_FACTOR = 0.5        # une news neutre pèse moitié moins qu'une pos/watch
SOURCES_TWO = 8
SOURCES_THREE = 15
POSITIVE = 10
UPCOMING = 8
EARNINGS = 10
EARNINGS_DAYS = 7
VOLUME_STEPS = ((4.0, 20), (2.5, 15), (1.5, 8))
ALIGNED = 5
COACH_UP = 10
COACH_DOWN = -10
CROWD = 5
CROWD_MIN = 5
FILING = 5
RED = -25
LATE = -10
LATE_DAY_PCT = 8.0
LATE_WEEK_PCT = 20.0

# Combien de news on garde par ligne dans le résultat (l'écran les déplie).
NEWS_PER_ROW = 6


def _num(value: Any) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return None if out != out else out


def _date(value: Any) -> Optional[date]:
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, str) and len(value) >= 10:
        try:
            return date.fromisoformat(value[:10])
        except ValueError:
            return None
    return None


def volume_points(rel_volume: Any) -> int:
    rv = _num(rel_volume)
    if rv is None:
        return 0
    for threshold, points in VOLUME_STEPS:
        if rv >= threshold:
            return points
    return 0


def earnings_soon(earnings_next: Any, today: date) -> bool:
    """Résultats aujourd'hui ou dans les ``EARNINGS_DAYS`` jours.

    Une date PASSÉE ne compte jamais comme « à venir » (même piège que la
    phase D de Market Pulse : une source peut rendre la dernière publication).
    """
    day = _date(earnings_next)
    return day is not None and today <= day <= today + timedelta(days=EARNINGS_DAYS)


def crowd_buzz(reddit: Any) -> bool:
    if not isinstance(reddit, dict):
        return False
    count = int(_num(reddit.get("count")) or 0)
    prev = int(_num(reddit.get("prev")) or 0)
    return count >= CROWD_MIN and count >= 2 * max(prev, 1)


def is_late(change_pct: Any, perf_w: Any) -> bool:
    day = _num(change_pct)
    week = _num(perf_w)
    return (day is not None and abs(day) >= LATE_DAY_PCT) or \
           (week is not None and abs(week) >= LATE_WEEK_PCT)


def display_news(items: Iterable[Dict[str, Any]], limit: int = NEWS_PER_ROW) -> List[Dict[str, Any]]:
    """Les news montrées pour une ligne : les plus récentes, MAIS toujours au
    moins une mauvaise nouvelle quand il y en a — un drapeau rouge dont on ne
    voit pas la raison serait un drapeau qui ment par omission."""
    merged = nw.merge(items)
    shown = merged[:limit]
    if limit > 0 and not any(i.get("sentiment") == "neg" for i in shown):
        negatives = [i for i in merged if i.get("sentiment") == "neg"]
        if negatives:
            shown = shown[:limit - 1] + [negatives[0]]
    return shown


def pre_score(row: Dict[str, Any], slot: Optional[Dict[str, Any]], today: date) -> float:
    """Classement GRATUIT (zéro réseau) qui choisit la présélection.

    Il favorise ce qui bouge (volume relatif, variation), ce qui est annoncé
    (résultats proches) et ce dont le coach parle déjà.
    """
    score = float(volume_points(row.get("rel_volume")))
    change = _num(row.get("change_pct"))
    if change is not None:
        score += min(10.0, abs(change))
    if earnings_soon(row.get("earnings_next"), today):
        score += EARNINGS
    if slot:
        score += min(20.0, 5.0 * len(slot.get("news") or []))
        if any(h.get("direction") == "up" for h in slot.get("hypotheses") or []):
            score += COACH_UP
        if crowd_buzz(slot.get("reddit")):
            score += CROWD
    return score


def score_row(row: Dict[str, Any], news_items: Iterable[Dict[str, Any]],
              slot: Optional[Dict[str, Any]], followed: Set[str],
              now: datetime, window_h: float, exclude_red: bool = False,
              news_verified: bool = True,
              price_asof: Optional[datetime] = None) -> Dict[str, Any]:
    """Note un candidat -> ``{score, components, reasons, flags, catalyst,
    excluded, news}``.

    ``news_items`` : news ADMISES (fenêtre + non-conseils), toutes sources
    fusionnées. ``slot`` : signaux du coach pour ce symbole (ou ``None``).

    ``price_asof`` : instant où les cours ont été figés quand la bourse est
    FERMÉE (``None`` = cours vivants). Si TOUTES les news sont postérieures,
    le cours et le volume datent d'avant elles : ils ne peuvent ni les
    confirmer (pas de points volume/aligné) ni dire qu'elles sont déjà dans le
    prix (pas de « en retard ») — la ligne est marquée « attend l'ouverture ».
    """
    slot = slot or {}
    items = [i for i in news_items or [] if isinstance(i, dict)]
    today = now.date()
    components: Dict[str, int] = {}
    reasons: List[Dict[str, Any]] = []
    flags: List[str] = []

    negatives = [i for i in items if i.get("sentiment") == "neg"]
    others = [i for i in items if i.get("sentiment") != "neg"]
    has_pos = any(i.get("sentiment") == "pos" for i in items)
    has_watch = any(i.get("sentiment") == "watch" for i in items)

    weighted = 0.0
    for item in others:
        factor = 1.0 if item.get("sentiment") in ("pos", "watch") else NEUTRAL_FACTOR
        weighted += nw.recency_weight(nw.age_hours(item.get("published"), now)) * factor
    news_pts = min(NEWS_MAX, int(round(NEWS_UNIT * weighted)))
    if news_pts:
        components["news"] = news_pts
    if others:
        reasons.append({"code": "news", "value": len(others), "hours": int(window_h)})

    hypotheses = [h for h in slot.get("hypotheses") or [] if isinstance(h, dict)]
    families = {i.get("family") for i in items if i.get("family")}
    if hypotheses:
        families.add("coach")
    if len(families) >= 3:
        components["sources"] = SOURCES_THREE
    elif len(families) == 2:
        components["sources"] = SOURCES_TWO
    if len(families) >= 2:
        reasons.append({"code": "sources", "value": len(families)})

    if has_pos:
        components["positive"] = POSITIVE
        reasons.append({"code": "positive"})
    if has_watch:
        components["upcoming"] = UPCOMING
        reasons.append({"code": "upcoming"})

    stale_prices = False
    if price_asof is not None and items:
        stamps = [nw.parse_ts(i.get("published")) for i in items]
        stale_prices = all(t is not None and t > price_asof for t in stamps)
    if stale_prices:
        reasons.append({"code": "awaiting_open"})
        flags.append("awaiting_open")

    soon = earnings_soon(row.get("earnings_next"), today)
    if soon:
        components["earnings"] = EARNINGS
        reasons.append({"code": "earnings", "value": str(row.get("earnings_next"))[:10]})
        flags.append("earnings_soon")

    vol = 0 if stale_prices else volume_points(row.get("rel_volume"))
    if vol:
        components["volume"] = vol
        reasons.append({"code": "volume", "value": round(_num(row.get("rel_volume")), 1)})

    change = _num(row.get("change_pct"))
    if not stale_prices and change is not None and change > 0 and (has_pos or has_watch):
        components["aligned"] = ALIGNED
        reasons.append({"code": "aligned", "value": round(change, 2)})

    if any(h.get("direction") == "up" for h in hypotheses):
        components["coach_up"] = COACH_UP
        reasons.append({"code": "coach_up"})
    if any(h.get("direction") == "down" for h in hypotheses):
        components["coach_down"] = COACH_DOWN
        flags.append("coach_down")

    reddit = slot.get("reddit")
    if crowd_buzz(reddit):
        components["crowd"] = CROWD
        reasons.append({"code": "crowd", "value": int(reddit.get("count") or 0)})
        flags.append("crowd")

    filings = [f for f in slot.get("filings") or []
               if isinstance(f, dict) and nw.in_window(f.get("published"), now, window_h)]
    if filings:
        components["filing"] = FILING
        reasons.append({"code": "filing", "value": filings[0].get("form") or ""})

    red = bool(negatives)
    if red:
        components["red"] = RED
        flags.append("red")
    if not stale_prices and is_late(change, row.get("perf_w")):
        components["late"] = LATE
        flags.append("late")

    if row.get("symbol") and row.get("symbol") in followed:
        flags.append("followed")
    if not news_verified:
        flags.append("news_unverified")

    catalyst = bool(items) or soon or bool(hypotheses) or bool(filings)
    excluded = None
    if not catalyst:
        excluded = "no_catalyst"
    elif exclude_red and red:
        excluded = "red"

    total = sum(components.values())
    return {
        "score": int(max(0, min(100, total))),
        "components": components,
        "reasons": reasons,
        "flags": flags,
        "catalyst": catalyst,
        "excluded": excluded,
        "news": display_news(items),
    }
