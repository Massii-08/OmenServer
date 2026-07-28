"""Parsing de la réponse chart Yahoo → structures propres (pur, sans I/O)."""
from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class Candle:
    ts: int          # epoch (début de séance pour l'intervalle 1d)
    open: float
    high: float
    low: float
    close: float


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
    Les points sans open/close (None, séance en cours sur certains marchés)
    sont ignorés dans la liste des bougies.
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
        if o is None or c is None:
            continue
        candles.append(Candle(ts=ts, open=o, high=h if h is not None else max(o, c),
                              low=l if l is not None else min(o, c), close=c))

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
