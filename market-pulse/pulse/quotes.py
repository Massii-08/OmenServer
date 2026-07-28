"""Parsing de la réponse chart Yahoo → structures propres (pur, sans I/O)."""
from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class Candle:
    ts: int                    # epoch (début de séance pour l'intervalle 1d)
    open: Optional[float]
    high: Optional[float]
    low: Optional[float]
    close: Optional[float]     # None tant que Yahoo n'a pas consolidé la clôture


@dataclass
class MarketData:
    symbol: str
    name: str
    currency: Optional[str]
    tz_name: str                     # ex. "Europe/Berlin"
    price: Optional[float]           # regularMarketPrice
    prev_close: Optional[float]      # chartPreviousClose
    regular_start: Optional[int]     # currentTradingPeriod.regular.start (epoch)
    regular_end: Optional[int]
    market_time: Optional[int]       # regularMarketTime (epoch de la dernière cotation)
    candles: List[Candle] = field(default_factory=list)


def parse_chart(raw: dict) -> MarketData:
    """Transforme la réponse brute /v8/finance/chart en MarketData.

    Lève ValueError si Yahoo renvoie une erreur ou une structure inattendue.

    Un point ENTIÈREMENT nul (ni ouverture ni clôture) = pas de séance ce
    jour-là (férié, trou de données) → écarté. Un point à moitié rempli est
    CONSERVÉ, avec le côté manquant à None :

    - ouverture seule = la séance a ouvert mais Yahoo n'a pas encore consolidé
      la clôture quotidienne. C'est justement le gap du jour → le jeter
      décalerait toutes les références d'une séance (bug du 2026-07-28 sur
      ^N225 : -6,11 % affiché au lieu de -3,95 %).
    - clôture seule = référence valable pour le gap du lendemain.
    """
    chart = (raw or {}).get("chart") or {}
    if chart.get("error"):
        raise ValueError("yahoo error: %s" % chart["error"])
    results = chart.get("result") or []
    if not results:
        raise ValueError("empty chart result")
    res = results[0]
    meta = res.get("meta") or {}
    tz = meta.get("exchangeTimezoneName")
    if not tz:
        raise ValueError("missing exchangeTimezoneName")

    regular = ((meta.get("currentTradingPeriod") or {}).get("regular")) or {}

    candles: List[Candle] = []
    timestamps = res.get("timestamp") or []
    quote = ((res.get("indicators") or {}).get("quote") or [{}])[0]
    opens = quote.get("open") or []
    highs = quote.get("high") or []
    lows = quote.get("low") or []
    closes = quote.get("close") or []
    for i, ts in enumerate(timestamps):
        try:
            o, h, l, c = opens[i], highs[i], lows[i], closes[i]
        except IndexError:
            break
        if o is None and c is None:
            continue
        known = [v for v in (o, c) if v is not None]
        candles.append(Candle(
            ts=ts, open=o, close=c,
            high=h if h is not None else max(known),
            low=l if l is not None else min(known),
        ))

    return MarketData(
        symbol=meta.get("symbol") or "",
        name=meta.get("shortName") or meta.get("longName") or meta.get("symbol") or "",
        currency=meta.get("currency"),
        tz_name=tz,
        price=meta.get("regularMarketPrice"),
        prev_close=meta.get("chartPreviousClose"),
        regular_start=regular.get("start"),
        regular_end=regular.get("end"),
        market_time=meta.get("regularMarketTime"),
        candles=candles,
    )
