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
    kind: str        # "index" | "future" | "fx" | "commodity" | "rate" | "volatility"


# `kind` pilote la MISE EN FORME, pas le calcul :
#   index/future/commodity → niveau + variation en %
#   fx                     → niveau à 4 décimales
#   rate                   → le « prix » EST un taux : niveau en %, variation en
#                            points de base (un +0,04 sur 4,59 % = +4 pb ; parler
#                            de « +0,9 % » induirait en erreur)
#   volatility             → niveau + variation en %, lu comme un thermomètre


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
    Instrument("^IBEX", "IBEX 35 (Madrid)", "europe", "index"),
    Instrument("^SSMI", "SMI (Zurigo)", "europe", "index"),
    Instrument("^STOXX50E", "Euro Stoxx 50", "europe", "index"),
    # — Indici Asia —
    Instrument("^N225", "Nikkei 225 (Tokyo)", "asia", "index"),
    Instrument("^HSI", "Hang Seng (Hong Kong)", "asia", "index"),
    Instrument("000001.SS", "Shanghai Composite", "asia", "index"),
    # — Futures / FX / Materie prime —
    #
    # ⚠️ Il n'existe PAS de future européen sur Yahoo (sondé le 2026-07-28 :
    # FESX=F et STXE=F → HTTP 404). L'ouverture européenne ne peut donc pas
    # être « prédite » par un future de la place : le rapport se contente
    # d'aligner les faits qui la précèdent (clôture asiatique, futures US, FX,
    # matières premières) sans annoncer de gap européen chiffré.
    Instrument("ES=F", "Futures S&P 500", "global", "future"),
    Instrument("NQ=F", "Futures Nasdaq", "global", "future"),
    Instrument("EURUSD=X", "EUR/USD", "global", "fx"),
    Instrument("BZ=F", "Petrolio Brent", "global", "commodity"),
    Instrument("GC=F", "Oro", "global", "commodity"),
    # — Contexte : taux et volatilité —
    # Le rendement du Treasury 10 ans parle directement à un investisseur
    # obligataire (les deux autres bots de la suite sont des outils à
    # obligations) ; le VIX explique la nervosité d'une séance.
    Instrument("^TNX", "Treasury USA 10 anni", "global", "rate"),
    Instrument("^VIX", "VIX (volatilità)", "global", "volatility"),
]
