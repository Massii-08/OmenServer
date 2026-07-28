"""Watchlist Market Pulse — instruments suivis par défaut.

Symboles Yahoo Finance, tous validés par sonde le 2026-07-28 (16/16 OK).
Les labels sont en italien : c'est la langue du rapport (grand-père).
"""
from dataclasses import dataclass
from typing import List


@dataclass(frozen=True)
class Instrument:
    symbol: str      # symbole Yahoo (ex. ^GSPC, FTSEMIB.MI, ES=F)
    label: str       # nom affiché (italien)
    region: str      # "usa" | "europe" | "asia" | "global"
    kind: str        # "index" | "future" | "fx" | "commodity"


DEFAULT_WATCHLIST: List[Instrument] = [
    # — Indici USA —
    Instrument("^GSPC", "S&P 500", "usa", "index"),
    Instrument("^IXIC", "Nasdaq Composite", "usa", "index"),
    Instrument("^DJI", "Dow Jones", "usa", "index"),
    # — Indici Europa —
    Instrument("FTSEMIB.MI", "FTSE MIB (Milano)", "europe", "index"),
    Instrument("^GDAXI", "DAX (Francoforte)", "europe", "index"),
    Instrument("^FCHI", "CAC 40 (Parigi)", "europe", "index"),
    Instrument("^FTSE", "FTSE 100 (Londra)", "europe", "index"),
    Instrument("^STOXX50E", "Euro Stoxx 50", "europe", "index"),
    # — Indici Asia —
    Instrument("^N225", "Nikkei 225 (Tokyo)", "asia", "index"),
    Instrument("^HSI", "Hang Seng (Hong Kong)", "asia", "index"),
    Instrument("000001.SS", "Shanghai Composite", "asia", "index"),
    # — Futures / FX / Materie prime —
    Instrument("ES=F", "Futures S&P 500", "global", "future"),
    Instrument("NQ=F", "Futures Nasdaq", "global", "future"),
    Instrument("EURUSD=X", "EUR/USD", "global", "fx"),
    Instrument("BZ=F", "Petrolio Brent", "global", "commodity"),
    Instrument("GC=F", "Oro", "global", "commodity"),
]
