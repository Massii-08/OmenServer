"""Assemblage du snapshot complet — LE contrat d'interface du moteur.

Tout consommateur (router backend, rapport italien, Excel, dashboard) ne lit QUE
cette structure. `fetch_chart` et `now_ts` sont injectés → testable hors ligne.
"""
from dataclasses import asdict
from typing import Callable, List, Optional

from .clock import market_state
from .config import Instrument
from .gaps import all_gaps, is_same_local_day, latest_gap
from .quotes import parse_chart


def _change_pct(price: Optional[float], prev: Optional[float]) -> Optional[float]:
    if price is None or not prev:
        return None
    return round((price - prev) / prev * 100.0, 2)


def _effective_prev_close(md) -> Optional[float]:
    """Clôture de référence pour la variation « du jour ».

    ⚠️ `meta.chartPreviousClose` est la clôture qui précède le DÉBUT du range
    demandé (10 j ici), pas la veille — l'utiliser donnerait une variation sur
    10 jours. La vraie référence est la clôture de l'avant-dernière bougie
    (marché ouvert : veille ; marché fermé : séance précédant la dernière).
    """
    if len(md.candles) >= 2:
        return md.candles[-2].close
    return md.prev_close


def build_snapshot(
    fetch_chart: Callable[[str], dict],
    instruments: List[Instrument],
    now_ts: int,
) -> dict:
    """Construit le snapshot marché : horloge + cotations + gaps.

    Un instrument en échec n'invalide pas le snapshot : il part dans `errors`.
    """
    markets = []
    errors = []
    for inst in instruments:
        try:
            md = parse_chart(fetch_chart(inst.symbol))
            clock = market_state(md, now_ts)
            gap = latest_gap(md.candles, md.tz_name)
            gap_is_today = bool(
                gap and md.candles
                and is_same_local_day(md.candles[-1].ts, now_ts, md.tz_name)
            )
            prev = _effective_prev_close(md)
            markets.append({
                "symbol": inst.symbol,
                "label": inst.label,
                "region": inst.region,
                "kind": inst.kind,
                "name": md.name,
                "currency": md.currency,
                "price": md.price,
                "prev_close": prev,
                "change_pct": _change_pct(md.price, prev),
                "clock": asdict(clock),
                "gap": asdict(gap) if gap else None,
                "gap_is_today": gap_is_today,
            })
        except Exception as e:
            errors.append({"symbol": inst.symbol, "error": "%s: %s" % (type(e).__name__, e)})
    return {"generated_at": now_ts, "markets": markets, "errors": errors}


def build_history_stats(
    fetch_chart: Callable[[str], dict],
    instruments: List[Instrument],
    range_: str = "1y",
) -> dict:
    """Stats historiques d'ouverture (V4) par instrument, sur `range_`.

    Le fetcher injecté doit accepter (symbol, range_) — voir main.py.
    """
    from .gaps import biggest_gaps, weekday_stats  # import local : garde le module léger

    out = {}
    errors = []
    for inst in instruments:
        try:
            md = parse_chart(fetch_chart(inst.symbol, range_))
            gaps = all_gaps(md.candles, md.tz_name)
            out[inst.symbol] = {
                "label": inst.label,
                "n_sessions": len(md.candles),
                "weekday_stats": weekday_stats(gaps),
                "biggest_gaps": [asdict(g) for g in biggest_gaps(gaps)],
            }
        except Exception as e:
            errors.append({"symbol": inst.symbol, "error": "%s: %s" % (type(e).__name__, e)})
    return {"stats": out, "errors": errors}
