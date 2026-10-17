"""Catalogue des marchés du scanner + pont TradingView -> Yahoo (PUR).

Un « marché » est ce que le screener TradingView appelle un ``market`` (un
pays) : une requête par marché rend toutes ses actions. Le catalogue est
FERMÉ : un identifiant inconnu n'est jamais deviné, il est refusé par
``config.validate`` avec un avertissement.

Les taux ``eur_per_unit`` ne servent QU'À convertir les seuils de liquidité
(capitalisation, échanges moyens) dans la devise du marché. Ce sont des ordres
de grandeur : une erreur de 10 % sur un plancher de liquidité ne change pas la
nature de la liste, et une table de change en direct serait une dépendance
réseau de plus pour rien.
"""
from typing import Any, Dict, List, NamedTuple, Optional, Tuple
from urllib.parse import quote


class Market(NamedTuple):
    id: str
    tv_market: str                  # nom du marché côté screener TradingView
    labels: Dict[str, str]          # fr / en / it
    currency: str                   # devise des montants du marché
    eur_per_unit: float             # ≈ valeur d'une unité de devise en EUR
    price_unit: float               # 0.01 quand les cours sont en centièmes (GBX)
    news_langs: Tuple[str, ...]     # langues demandées au flux TradingView
    euronext_suffix: Optional[str]  # suffixe Yahoo d'un ``EURONEXT:`` de ce marché
    rows_limit: int                 # lignes demandées au screener


# ⚠️ Langues des news : seules ``en`` et ``fr`` ont été SONDÉES (coach, 09/09).
# Une langue ajoutée sans sonde peut rendre un flux vide ou un 4xx : ce n'est
# pas grave (best-effort), mais ça coûte une requête du budget pour rien.
MARKETS: Tuple[Market, ...] = (
    Market("switzerland", "switzerland",
           {"fr": "Suisse (SIX)", "en": "Switzerland (SIX)", "it": "Svizzera (SIX)"},
           "CHF", 1.05, 1.0, ("en", "fr"), None, 200),
    Market("italy", "italy",
           {"fr": "Italie (Borsa Italiana)", "en": "Italy (Borsa Italiana)",
            "it": "Italia (Borsa Italiana)"},
           "EUR", 1.0, 1.0, ("en",), None, 200),
    Market("germany", "germany",
           {"fr": "Allemagne (Xetra)", "en": "Germany (Xetra)", "it": "Germania (Xetra)"},
           "EUR", 1.0, 1.0, ("en",), None, 200),
    Market("france", "france",
           {"fr": "France (Euronext Paris)", "en": "France (Euronext Paris)",
            "it": "Francia (Euronext Parigi)"},
           "EUR", 1.0, 1.0, ("en", "fr"), ".PA", 200),
    Market("netherlands", "netherlands",
           {"fr": "Pays-Bas (Euronext Amsterdam)", "en": "Netherlands (Euronext Amsterdam)",
            "it": "Paesi Bassi (Euronext Amsterdam)"},
           "EUR", 1.0, 1.0, ("en",), ".AS", 200),
    Market("spain", "spain",
           {"fr": "Espagne (BME)", "en": "Spain (BME)", "it": "Spagna (BME)"},
           "EUR", 1.0, 1.0, ("en",), None, 200),
    Market("uk", "uk",
           {"fr": "Royaume-Uni (LSE)", "en": "United Kingdom (LSE)", "it": "Regno Unito (LSE)"},
           "GBP", 1.17, 0.01, ("en",), None, 200),
    Market("america", "america",
           {"fr": "États-Unis (NYSE, Nasdaq)", "en": "United States (NYSE, Nasdaq)",
            "it": "Stati Uniti (NYSE, Nasdaq)"},
           "USD", 0.92, 1.0, ("en",), None, 400),
)

DEFAULT_MARKETS: Tuple[str, ...] = ("switzerland", "italy", "germany", "france", "america")

_BY_ID: Dict[str, Market] = {m.id: m for m in MARKETS}

# Repli LOCAL de la table de référence du coach (``brief.TV_EXCHANGE_SUFFIX``),
# pour que ce module reste autonome et testable si ``brief`` ne s'importe pas.
_FALLBACK_SUFFIX: Dict[str, str] = {
    "NASDAQ": "", "NYSE": "", "AMEX": "", "BATS": "", "ARCA": "", "OTC": "",
    "SIX": ".SW", "BX": ".SW",
    "XETR": ".DE", "FWB": ".DE", "TRADEGATE": ".DE",
    "EURONEXT": ".PA",
    "LSE": ".L", "MIL": ".MI", "BME": ".MC",
}

TV_CHART_URL = "https://www.tradingview.com/chart/?symbol="

# Valeur approximative d'UNE unité de devise en EUR, par devise de cotation —
# pour des SEUILS et des ordres de grandeur, jamais pour un prix affiché.
# ``GBX`` (pence) vaut un centième de livre : un titre de Londres coté 2450 GBX
# vaut 24,50 GBP, et sans cette ligne ses échanges seraient surestimés ×100.
EUR_PER_UNIT: Dict[str, float] = {
    "EUR": 1.0, "CHF": 1.05, "USD": 0.92, "GBP": 1.17, "GBX": 0.0117,
    "SEK": 0.087, "NOK": 0.085, "DKK": 0.134, "CAD": 0.67, "PLN": 0.23,
}


def eur_rate(currency: Any, market: Optional[Market] = None) -> Optional[float]:
    """≈ EUR pour une unité de ``currency`` ; devise inconnue -> taux du marché.

    ``GBp`` (la forme « pence » de certains flux) est lue comme ``GBX``. Une
    devise inconnue SANS marché de repli rend ``None`` : mieux vaut un montant
    absent qu'un montant faux d'un facteur cent.
    """
    if isinstance(currency, str) and currency.strip():
        code = currency.strip()
        # AVANT la mise en majuscules : « GBp » en majuscules deviendrait
        # « GBP », des livres, soit un montant cent fois trop gros.
        code = "GBX" if code == "GBp" else code.upper()
        rate = EUR_PER_UNIT.get(code)
        if rate is not None:
            return rate
    if market is not None:
        return market.eur_per_unit
    return None


def by_id(market_id: Any) -> Optional[Market]:
    """Le marché de cet identifiant, ou ``None`` (jamais deviné)."""
    if not isinstance(market_id, str):
        return None
    return _BY_ID.get(market_id.strip().lower())


def catalogue(lang: str = "fr") -> List[Dict[str, Any]]:
    """La liste que l'UI dessine (ordre du catalogue)."""
    out = []
    for m in MARKETS:
        out.append({
            "id": m.id,
            "label": m.labels.get(lang) or m.labels["fr"],
            "labels": dict(m.labels),
            "currency": m.currency,
            "default": m.id in DEFAULT_MARKETS,
        })
    return out


def split_tv(tv_symbol: Any) -> Optional[Tuple[str, str]]:
    """``EXCHANGE:TICKER`` -> ``(EXCHANGE, TICKER)`` en majuscules, ou ``None``."""
    if not isinstance(tv_symbol, str) or ":" not in tv_symbol:
        return None
    exchange, _, ticker = tv_symbol.strip().upper().partition(":")
    exchange, ticker = exchange.strip(), ticker.strip()
    if not exchange or not ticker:
        return None
    return exchange, ticker


def _canonical(symbol: str) -> str:
    """``quotes.canonical`` du coach (``ROG.SW`` -> ``RO.SW``) si importable."""
    try:
        from backend.bots.paper.quotes import canonical
    except Exception:             # noqa: BLE001 — moteur du coach absent
        return symbol.strip().upper()
    try:
        return canonical(symbol) or symbol.strip().upper()
    except Exception:             # noqa: BLE001
        return symbol.strip().upper()


def _reference_tv_to_yahoo(tv_symbol: str) -> Optional[str]:
    try:
        from backend.bots.paper.brief import tv_to_yahoo
    except Exception:             # noqa: BLE001 — table du coach absente
        tv_to_yahoo = None
    if tv_to_yahoo is not None:
        try:
            mapped = tv_to_yahoo(tv_symbol)
        except Exception:         # noqa: BLE001
            mapped = None
        if mapped:
            return mapped
    parts = split_tv(tv_symbol)
    if parts is None:
        return None
    exchange, ticker = parts
    suffix = _FALLBACK_SUFFIX.get(exchange)
    if suffix is None:
        return None
    if not suffix:
        ticker = ticker.replace(".", "-")
    return ticker + suffix


def tv_to_yahoo(tv_symbol: Any, market_id: Any = None) -> Optional[str]:
    """Symbole TradingView d'une ligne du screener -> symbole Yahoo canonique.

    La table du coach (``brief.tv_to_yahoo``) fait foi, avec deux exceptions
    qui dépendent du MARCHÉ balayé, information que la table n'a pas :

    - ``EURONEXT:`` couvre Paris, Amsterdam, Bruxelles… ; la table suppose
      Paris. Balayer ``netherlands`` donne ``.AS`` (sinon ASML deviendrait
      ``ASML.PA``, un symbole qui n'est pas celui du coach) ;
    - ``BME:`` (Madrid) n'est pas dans la table du coach : ``.MC``.

    Puis ``quotes.canonical`` (alias vérifiés à la main, ex. Roche). Place
    inconnue -> ``None`` : jamais un symbole inventé.
    """
    parts = split_tv(tv_symbol)
    if parts is None:
        return None
    exchange, ticker = parts
    market = by_id(market_id)
    if exchange == "EURONEXT" and market is not None and market.euronext_suffix:
        return _canonical(ticker + market.euronext_suffix)
    if exchange == "BME":
        return _canonical(ticker + ".MC")
    mapped = _reference_tv_to_yahoo("%s:%s" % (exchange, ticker))
    return _canonical(mapped) if mapped else None


# Symbole Yahoo -> marché, pour l'univers de REPLI (qui part de symboles Yahoo).
_SUFFIX_MARKET: Dict[str, str] = {
    ".MI": "italy", ".DE": "germany", ".F": "germany", ".PA": "france",
    ".AS": "netherlands", ".MC": "spain", ".SW": "switzerland", ".L": "uk",
}
# Symbole Yahoo -> place TradingView, même usage. Un ticker américain nu est
# un PARI (``NASDAQ:``) : le flux répond 422 s'il est au NYSE, et le titre reste
# simplement sans news fraîches — jamais une news d'un autre titre.
_MARKET_TV_PREFIX: Dict[str, str] = {
    "italy": "MIL", "germany": "XETR", "france": "EURONEXT", "netherlands": "EURONEXT",
    "spain": "BME", "switzerland": "SIX", "uk": "LSE", "america": "NASDAQ",
}
# Alias INVERSES vérifiés (le ticker Yahoo n'est pas le ticker de la place).
_YAHOO_TV_OVERRIDES: Dict[str, str] = {"RO.SW": "SIX:ROG"}


def market_of_yahoo(symbol: Any) -> Optional[str]:
    """``ENI.MI`` -> ``italy`` ; ticker nu (ou classe ``BRK-B``) -> ``america``."""
    if not isinstance(symbol, str) or not symbol.strip():
        return None
    sym = symbol.strip().upper()
    if any(ch in sym for ch in "=^"):
        return None
    if "." not in sym:
        return "america"
    suffix = sym[sym.rfind("."):]
    return _SUFFIX_MARKET.get(suffix)


def yahoo_to_tv(symbol: Any) -> Optional[str]:
    """Symbole Yahoo d'une action -> ``EXCHANGE:TICKER`` interrogeable, ou ``None``."""
    if not isinstance(symbol, str) or not symbol.strip():
        return None
    sym = symbol.strip().upper()
    if sym in _YAHOO_TV_OVERRIDES:
        return _YAHOO_TV_OVERRIDES[sym]
    market = market_of_yahoo(sym)
    prefix = _MARKET_TV_PREFIX.get(market or "")
    if not prefix:
        return None
    base = sym if market == "america" else sym[:sym.rfind(".")]
    if market == "america":
        base = base.replace("-", ".")
    return "%s:%s" % (prefix, base)


def chart_url(tv_symbol: Any) -> Optional[str]:
    """Lien du graphique TradingView (vérification à la main d'une ligne)."""
    if split_tv(tv_symbol) is None:
        return None
    return TV_CHART_URL + quote(tv_symbol.strip().upper(), safe="")


def to_local(amount_eur: float, market: Market) -> float:
    """Un montant en EUR -> la devise du marché (ordre de grandeur)."""
    rate = market.eur_per_unit or 1.0
    return float(amount_eur) / rate


def to_eur(amount_local: Optional[float], market: Market) -> Optional[float]:
    """Un montant dans la devise du marché -> EUR (ordre de grandeur)."""
    if amount_local is None:
        return None
    return float(amount_local) * (market.eur_per_unit or 1.0)
