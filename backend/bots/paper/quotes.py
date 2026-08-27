"""Passerelle vers les cours Yahoo — I/O, entièrement INJECTABLE.

Le simulateur ne parle JAMAIS à Yahoo directement : il passe par ici. Ce module
est le seul du lot à connaître deux détails d'infrastructure :

1. le client HTTP vit dans le moteur frère ``market-pulse/`` (répertoire au nom
   tirété, donc ``import pulse.fetcher`` ne marche pas tel quel) — même patron de
   passerelle que ``backend/bots/market_engine.py`` : le chemin s'ajoute à un
   seul endroit, testable, et le backend démarre même si le moteur manque ;
2. Yahoo bloque les clients HTTP « nus » au niveau TLS — ``YahooChartClient``
   utilise curl_cffi avec l'empreinte Chrome et pace ses appels à 1,1 s.

**Deux pièges du dépôt sont câblés ici, ne les défaites pas :**

* piège #67a — une bougie à MOITIÉ écrite (ouverture connue, clôture pas encore
  consolidée) se GARDE. Seul le point entièrement nul (férié, trou de données)
  se jette. La jeter décalerait toutes les références d'une séance ;
* piège #68e — ``chartPreviousClose`` DÉPEND DE LA FENÊTRE DEMANDÉE (mesuré :
  64 611 sur ``range=5d``, 70 062 sur ``range=1mo`` pour le même titre). Il
  n'est JAMAIS utilisé pour calculer une variation. La seule référence honnête
  est la série de bougies.

**Univers couvert (élargi 2026-08-25).** Actions, ETF, CRYPTO (``BTC-USD``) et
FOREX (``EURUSD=X``) — tous servis par le MÊME endpoint chart, donc
``get_quote``/``get_candles``/``fx_to_chf`` n'ont eu besoin d'aucun cas
particulier. Deux simplifications ASSUMÉES, parce que c'est un simulateur
pédagogique et pas une plateforme de change :

* une paire de devises est traitée comme n'importe quel instrument coté dans la
  devise que Yahoo annonce dans ses métadonnées — pour ``EURUSD=X`` c'est
  ``USD``, le prix étant « combien de dollars vaut un euro ». Acheter la paire,
  c'est donc acheter des UNITÉS de ce prix, converties en francs par
  ``fx_to_chf`` comme un titre américain ;
* aucune notion de LOT, de PIP ni de levier : pas de lot standard à 100 000
  unités, pas de marge, pas de swap overnight. Le simulateur enseigne le
  mouvement et le dimensionnement, pas la mécanique d'un courtier FX.

Les indices (``^SSMI``) et les contrats à terme restent HORS de la recherche :
un indice ne se détient pas, un future a des échéances et un levier qui n'ont
rien à faire ici (l'or et le pétrole se jouent via des ETF).

Injection : toutes les fonctions acceptent ``client=`` ; à défaut elles prennent
l'instance module ``_client`` (paresseuse). Les tests posent leur faux client via
``set_client()`` et remplacent ``_fetch_json`` pour la recherche.
"""
import math
import statistics
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import quote_plus

# backend/bots/paper/quotes.py -> racine projet = parents[3]
ENGINE_DIR = Path(__file__).resolve().parents[3] / "market-pulse"

# Fenêtres par défaut. 10 jours pour une cotation : il faut au moins DEUX
# clôtures pour une variation, et un long week-end férié en mange trois.
DEFAULT_RANGE = "5d"
DEFAULT_INTERVAL = "1d"
QUOTE_RANGE = "10d"
FACTS_RANGE = "1y"

FX_TTL_S = 600.0

SEARCH_URL = ("https://query1.finance.yahoo.com/v1/finance/search"
              "?q=%s&quotesCount=8&newsCount=0")
SEARCH_TIMEOUT_S = 20.0

# Ce que la recherche garde, ET le « genre » rendu au client. La table est la
# SOURCE UNIQUE : le filtre en DÉRIVE, donc les deux ne peuvent pas diverger le
# jour où l'on ouvrira l'univers un cran de plus.
#
# ``FUTURE``/``INDEX``/``OPTION`` restent dehors (cf. docstring de module).
KIND_BY_QUOTE_TYPE = {
    "EQUITY": "equity",
    "ETF": "etf",
    "CRYPTOCURRENCY": "crypto",
    "CURRENCY": "forex",
}
SEARCH_KEEP_TYPES = frozenset(KIND_BY_QUOTE_TYPE)
ASSET_KINDS = frozenset(KIND_BY_QUOTE_TYPE.values())
# Repli le moins surprenant : c'est de loin le cas le plus fréquent.
DEFAULT_KIND = "equity"

# Nombre de séances de bourse par période (approximations usuelles).
SESSIONS_1M = 21
SESSIONS_3M = 63
SESSIONS_6M = 126
SESSIONS_1Y = 252
TRADING_DAYS_PER_YEAR = 252

# En dessous, un écart-type de rendements ne veut rien dire.
MIN_VOL_POINTS = 20


# --------------------------------------------------------------------------- #
# Alias -> symbole CANONIQUE Yahoo
#
# Table CURÉE, volontairement courte : un ticker officiel (SIX, Euronext…) que
# Massii tape naturellement mais que Yahoo ne connaît pas sous cette forme.
# Vécu : ``ROG.SW`` (ticker officiel SIX de Roche) rend « No data found » côté
# Yahoo, qui la cote sous ``RO.SW``. On ne DEVINE jamais une correspondance
# (même doctrine que ``entities.py`` — piège #31) : chaque entrée est vérifiée
# à la main avant d'entrer ici.
# --------------------------------------------------------------------------- #
SYMBOL_ALIASES: Dict[str, str] = {
    "ROG.SW": "RO.SW",
}


def canonical(symbol: Any) -> str:
    """Le symbole tel que Yahoo le connaît (PUR — aucun réseau).

    Nettoie (espaces, casse) puis cherche l'entrée dans :data:`SYMBOL_ALIASES`
    (recherche insensible à la casse) ; sans correspondance, rend le symbole
    nettoyé tel quel — c'est le comportement qui existait déjà partout dans ce
    fichier (``.strip().upper()``), désormais centralisé ICI pour que la
    correspondance d'alias s'applique au même endroit.

    Appelée aux POINTS D'ENTRÉE du router (ordre, watchlist, candles,
    analyse…), jamais en profondeur dans ce module : une position ou une ligne
    de watchlist doit être stockée sous le symbole CANONIQUE dès sa création,
    sinon les consommateurs en aval (veille par symbole, backfill, bougies)
    verraient deux identités pour le même titre.
    """
    cleaned = str(symbol or "").strip().upper()
    if not cleaned:
        return ""
    return SYMBOL_ALIASES.get(cleaned, cleaned)


class QuoteError(RuntimeError):
    """Cours indisponible (réseau, TLS, moteur absent, devise inconnue)."""


class EngineUnavailable(QuoteError):
    """Le moteur ``market-pulse/`` n'est pas là où on l'attend."""


class UnknownSymbol(QuoteError):
    """Yahoo ne connaît pas ce symbole, ou n'en donne aucun prix."""


# --------------------------------------------------------------------------- #
# Client (paresseux, injectable)
# --------------------------------------------------------------------------- #
_client = None                       # instance partagée, créée à la demande
_now: Callable[[], float] = time.monotonic   # horloge du cache FX (injectable)
_FX_CACHE: Dict[str, Tuple[float, float]] = {}


def _ensure_path() -> None:
    path = str(ENGINE_DIR)
    if path not in sys.path:
        sys.path.insert(0, path)


def _client_class():
    """La classe ``YahooChartClient`` du moteur, importée à la demande."""
    _ensure_path()
    try:
        from pulse.fetcher import YahooChartClient
    except ImportError as e:
        raise EngineUnavailable("moteur market-pulse introuvable (%s): %s"
                                % (ENGINE_DIR, e))
    return YahooChartClient


def get_client():
    """Le client partagé (créé au premier appel). Porte le pacing 1,1 s."""
    global _client
    if _client is None:
        _client = _client_class()()
    return _client


def set_client(client) -> None:
    """Remplace le client partagé — point d'injection des tests (``None`` réarme
    la création paresseuse)."""
    global _client
    _client = client


def clear_fx_cache() -> None:
    """Vide le cache des taux de change (tests, ou changement de journée)."""
    _FX_CACHE.clear()


def _resolve(client):
    return client if client is not None else get_client()


# --------------------------------------------------------------------------- #
# Récupération brute
# --------------------------------------------------------------------------- #
def _result(raw: Any, symbol: str) -> Dict[str, Any]:
    """Le premier ``result`` de la réponse chart, ou une erreur parlante."""
    chart = (raw or {}).get("chart") if isinstance(raw, dict) else None
    chart = chart or {}
    if chart.get("error"):
        raise UnknownSymbol("symbole inconnu de Yahoo: %s" % symbol)
    results = chart.get("result") or []
    if not results or not isinstance(results[0], dict):
        raise UnknownSymbol("aucune donnée de cours pour %s" % symbol)
    return results[0]


def _chart(symbol: str, range_: str, interval: str, client=None) -> Dict[str, Any]:
    """Appelle Yahoo et rend le bloc ``result``. Toute panne devient QuoteError."""
    sym = str(symbol or "").strip()
    if not sym:
        raise UnknownSymbol("symbole vide")
    cli = _resolve(client)
    try:
        raw = cli.get_chart(sym, range_=range_, interval=interval)
    except QuoteError:
        raise
    except Exception as e:
        # FetchError du moteur, panne réseau, TLS... on ne fait pas remonter la
        # trace d'une dépendance dans un endpoint : un message, un type.
        raise QuoteError("cours indisponible pour %s (%s)" % (sym, type(e).__name__))
    return _result(raw, sym)


# --------------------------------------------------------------------------- #
# Parsing — PUR (aucun réseau) : c'est ici que vit le piège #67a
# --------------------------------------------------------------------------- #
def parse_candles(result: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Bougies ``{ts, open, high, low, close, volume}``, chronologiques.

    Un point ENTIÈREMENT nul (ni ouverture ni clôture) est écarté : il n'y a pas
    eu de séance. Un point à MOITIÉ écrit est CONSERVÉ, côté manquant à ``None``,
    et ses ``high``/``low`` absents sont reconstruits depuis les extrémités
    connues (piège #67a).
    """
    result = result or {}
    timestamps = result.get("timestamp") or []
    quote_blocks = ((result.get("indicators") or {}).get("quote") or [{}])
    quote = quote_blocks[0] if isinstance(quote_blocks[0], dict) else {}
    opens = quote.get("open") or []
    highs = quote.get("high") or []
    lows = quote.get("low") or []
    closes = quote.get("close") or []
    volumes = quote.get("volume") or []

    out: List[Dict[str, Any]] = []
    for i, ts in enumerate(timestamps):
        o = _at(opens, i)
        h = _at(highs, i)
        l = _at(lows, i)
        c = _at(closes, i)
        if o is None and c is None:
            continue                      # pas de séance ce jour-là
        known = [v for v in (o, c) if v is not None]
        out.append({
            "ts": int(ts) if ts is not None else 0,
            "open": o,
            "high": h if h is not None else max(known),
            "low": l if l is not None else min(known),
            "close": c,
            "volume": _at(volumes, i),
        })
    return out


def _at(series: Any, index: int) -> Optional[float]:
    """Valeur numérique du point ``index`` d'une série Yahoo, ou ``None``."""
    if not isinstance(series, (list, tuple)) or index >= len(series):
        return None
    value = series[index]
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_meta(result: Dict[str, Any]) -> Dict[str, Any]:
    """Métadonnées normalisées de la réponse chart.

    ``chart_previous_close`` est exposé pour l'inspection MAIS ne doit servir à
    AUCUN calcul de variation (piège #68e) — il dépend de la fenêtre demandée.
    """
    meta = (result or {}).get("meta") or {}
    name = meta.get("longName") or meta.get("shortName") or meta.get("symbol") or ""
    return {
        "symbol": meta.get("symbol") or "",
        "name": name,
        "currency": (meta.get("currency") or "").upper(),
        "price": _num(meta.get("regularMarketPrice")),
        "chart_previous_close": _num(meta.get("chartPreviousClose")),
        "exchange": meta.get("fullExchangeName") or meta.get("exchangeName") or "",
        "timezone": meta.get("exchangeTimezoneName") or "",
    }


def _num(value: Any) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _closes(candles: List[Dict[str, Any]]) -> List[float]:
    return [c["close"] for c in (candles or []) if c.get("close") is not None]


def _last_close(candles: List[Dict[str, Any]]) -> Optional[float]:
    closes = _closes(candles)
    return closes[-1] if closes else None


def change_pct(candles: List[Dict[str, Any]], price: Optional[float]) -> Optional[float]:
    """Variation en % du cours courant contre la clôture de la séance PRÉCÉDENTE.

    La référence est la dernière clôture connue **hors dernière bougie** : la
    dernière bougie EST la séance en cours (sa clôture, quand Yahoo l'a
    consolidée, est le cours courant lui-même — la comparer à elle-même rendrait
    toujours 0 %). Ce détour gère aussi la bougie à moitié écrite, qui n'a pas
    encore de clôture du tout.

    ``None`` si la série est trop courte : mieux vaut ne rien afficher qu'une
    variation calculée contre la mauvaise séance.
    """
    if price is None or not candles:
        return None
    ref = None
    for candle in reversed(candles[:-1]):
        close = candle.get("close")
        if close is not None:
            ref = close
            break
    if ref is None or ref == 0:
        return None
    return round((price - ref) / ref * 100.0, 2)


# --------------------------------------------------------------------------- #
# API publique — cours
# --------------------------------------------------------------------------- #
def get_candles(symbol: str, range_: str = DEFAULT_RANGE,
                interval: str = DEFAULT_INTERVAL, client=None) -> List[Dict[str, Any]]:
    """Les bougies du titre sur la fenêtre demandée (voir ``parse_candles``)."""
    return parse_candles(_chart(symbol, range_, interval, client))


def get_meta(symbol: str, range_: str = DEFAULT_RANGE,
             interval: str = DEFAULT_INTERVAL, client=None) -> Dict[str, Any]:
    """Les métadonnées du titre (devise, dernier cours, nom, place)."""
    return parse_meta(_chart(symbol, range_, interval, client))


def get_quote(symbol: str, client=None) -> Dict[str, Any]:
    """Cotation courante : ``{symbol, price, currency, change_pct, name}``.

    Le prix est ``regularMarketPrice`` ; à défaut la dernière clôture connue.
    Aucun prix du tout -> ``UnknownSymbol`` (le router en fait un 404 : on ne
    passe pas un ordre sur un titre dont on ne connaît pas le cours).
    """
    result = _chart(symbol, QUOTE_RANGE, "1d", client)
    meta = parse_meta(result)
    candles = parse_candles(result)

    price = meta.get("price")
    if price is None:
        price = _last_close(candles)
    if price is None:
        raise UnknownSymbol("aucun cours disponible pour %s" % symbol)

    return {
        "symbol": meta.get("symbol") or str(symbol).strip().upper(),
        "price": price,
        "currency": meta.get("currency") or "",
        "change_pct": change_pct(candles, price),
        "name": meta.get("name") or "",
    }


def fx_to_chf(currency: str, client=None) -> float:
    """Taux devise -> CHF (1.0 pour le franc), caché 10 minutes.

    Lève ``QuoteError`` si le taux est introuvable : c'est bloquant pour un
    ordre (sans taux, le montant en francs serait inventé), le router en fait un
    502. Un ``UnknownSymbol`` sur la paire est requalifié — le symbole fautif
    est la PAIRE, pas le titre que l'utilisateur a demandé.
    """
    code = str(currency or "").strip().upper()
    if not code:
        raise QuoteError("devise inconnue: taux de change impossible")
    if code == "CHF":
        return 1.0

    cached = _FX_CACHE.get(code)
    if cached is not None and (_now() - cached[1]) < FX_TTL_S:
        return cached[0]

    pair = "%sCHF=X" % code
    try:
        result = _chart(pair, "5d", "1d", client)
    except UnknownSymbol:
        raise QuoteError("taux %s->CHF indisponible (paire %s inconnue)" % (code, pair))
    rate = _last_close(parse_candles(result))
    if rate is None:
        rate = parse_meta(result).get("price")
    if rate is None or rate <= 0:
        raise QuoteError("taux %s->CHF indisponible" % code)

    rate = float(rate)
    _FX_CACHE[code] = (rate, _now())
    return rate


def kind_for_quote_type(quote_type: Any) -> str:
    """Genre d'instrument depuis le ``quoteType`` Yahoo (PUR).

    ``EQUITY`` -> ``equity``, ``ETF`` -> ``etf``, ``CRYPTOCURRENCY`` ->
    ``crypto``, ``CURRENCY`` -> ``forex``. Type inconnu -> ``equity``.
    """
    return KIND_BY_QUOTE_TYPE.get(str(quote_type or "").strip().upper(), DEFAULT_KIND)


def kind_from_symbol(symbol: Any) -> str:
    """Genre DEVINÉ depuis la forme du symbole Yahoo (PUR) — ``EURUSD=X`` ->
    ``forex``, ``BTC-USD`` -> ``crypto``, tout le reste -> ``equity``.

    C'est un REPLI, jamais une source : il ne sert que là où personne n'a fourni
    de ``quoteType`` (une idée écrite par le LLM, typiquement). Un ETF ne se
    distingue pas d'une action par son ticker — deviner ne remplace pas savoir.
    """
    text = str(symbol or "").strip().upper()
    if not text:
        return DEFAULT_KIND
    if text.endswith("=X"):
        return "forex"
    # Yahoo cote les cryptos en paires ``PIÈCE-FIAT`` (BTC-USD, ETH-EUR…).
    for fiat in ("-USD", "-EUR", "-CHF", "-GBP", "-JPY"):
        if text.endswith(fiat):
            return "crypto"
    return DEFAULT_KIND


def search(q: str, client=None) -> List[Dict[str, Any]]:
    """Recherche de ticker Yahoo -> ``[{symbol, name, exchange, currency, kind}]``.

    Garde les actions, les ETF, les CRYPTOS et les DEVISES (cf. docstring de
    module : univers élargi 2026-08-25 pour le niveau spéculatif du coach) ;
    jette le reste, indices et futures en tête. ``kind`` dit lequel des quatre
    genres est rendu — champ ADDITIF, les appelants d'avant l'ignorent.

    Une requête de moins de 2 caractères rend ``[]`` sans appel réseau.

    ``client`` est accepté pour la symétrie des signatures mais N'EST PAS utilisé :
    l'endpoint de recherche n'est pas l'endpoint chart, il passe par
    ``_fetch_json`` (que les tests remplacent).
    """
    term = str(q or "").strip()
    if len(term) < 2:
        return []
    try:
        payload = _fetch_json(SEARCH_URL % quote_plus(term))
    except Exception as e:
        raise QuoteError("recherche indisponible (%s)" % type(e).__name__)
    if not payload:
        return []

    out: List[Dict[str, Any]] = []
    for quote in (payload.get("quotes") or []):
        if not isinstance(quote, dict):
            continue
        quote_type = str(quote.get("quoteType") or "").strip().upper()
        if quote_type not in SEARCH_KEEP_TYPES:
            continue
        symbol = quote.get("symbol")
        if not symbol:
            continue
        out.append({
            "symbol": symbol,
            "name": quote.get("longname") or quote.get("shortname") or symbol,
            "exchange": quote.get("exchDisp") or quote.get("exchange") or "",
            # Yahoo n'annonce PAS de devise sur une paire de change ni sur
            # certaines cryptos : chaîne vide, comme pour tout champ absent.
            "currency": (quote.get("currency") or "").upper(),
            "kind": kind_for_quote_type(quote_type),
        })
    return out


def _fetch_json(url: str) -> Optional[Dict[str, Any]]:
    """GET JSON avec l'empreinte Chrome (même mur TLS que le chart Yahoo).

    Session réutilisée entre les appels (attribut de fonction, comme
    ``pulse/resolve.py``). Remplacée en bloc par les tests.
    """
    from curl_cffi import requests as creq
    session = getattr(_fetch_json, "_session", None)
    if session is None:
        session = creq.Session(impersonate="chrome")
        _fetch_json._session = session
    response = session.get(url, timeout=SEARCH_TIMEOUT_S)
    if getattr(response, "status_code", None) != 200:
        return None
    try:
        return response.json()
    except ValueError:
        return None


# --------------------------------------------------------------------------- #
# Fiche d'analyse — chiffres, rien que des chiffres
# --------------------------------------------------------------------------- #
def fiche_facts(symbol: str, client=None) -> Dict[str, Any]:
    """Les faits chiffrés d'un titre sur un an — matière première du LLM.

    TOUT est calculé depuis les bougies : aucune donnée n'est inventée, et un
    champ que la série ne permet pas de calculer vaut ``None`` (le prompt dira
    alors où la chercher, plutôt que de la fabriquer).
    """
    result = _chart(symbol, FACTS_RANGE, "1d", client)
    return build_facts(parse_meta(result), parse_candles(result))


def build_facts(meta: Dict[str, Any], candles: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Assemble la fiche à partir de métadonnées + bougies — PUR, testable."""
    meta = meta or {}
    candles = candles or []
    closes = _closes(candles)

    price = meta.get("price")
    if price is None and closes:
        price = closes[-1]

    highs = [c["high"] for c in candles if c.get("high") is not None]
    lows = [c["low"] for c in candles if c.get("low") is not None]
    week52_high = max(highs) if highs else (max(closes) if closes else None)
    week52_low = min(lows) if lows else (min(closes) if closes else None)

    pos_in_range = None
    if price is not None and week52_high is not None and week52_low is not None \
            and week52_high > week52_low:
        pos_in_range = round((price - week52_low) / (week52_high - week52_low) * 100.0, 1)

    sma50 = _sma(closes, 50)
    sma200 = _sma(closes, 200)

    volumes = [c["volume"] for c in candles[-SESSIONS_3M:] if c.get("volume") is not None]
    avg_volume = int(round(sum(volumes) / float(len(volumes)))) if volumes else None

    return {
        "symbol": meta.get("symbol") or "",
        "name": meta.get("name") or "",
        "currency": meta.get("currency") or "",
        "price": round(price, 4) if price is not None else None,
        "change_1d_pct": change_pct(candles, price),
        "week52_high": round(week52_high, 4) if week52_high is not None else None,
        "week52_low": round(week52_low, 4) if week52_low is not None else None,
        "pos_in_range_pct": pos_in_range,
        "sma50": sma50,
        "sma200": sma200,
        "trend": _trend(price, sma50, sma200),
        "volatility_ann_pct": _volatility_ann_pct(closes),
        "avg_volume_3m": avg_volume,
        "perf_1m_pct": _perf(closes, price, SESSIONS_1M),
        "perf_6m_pct": _perf(closes, price, SESSIONS_6M),
        "perf_1y_pct": _perf(closes, price, SESSIONS_1Y),
        "n_sessions": len(closes),
    }


def _sma(closes: List[float], window: int) -> Optional[float]:
    """Moyenne mobile simple. ``None`` si la série est plus courte que la
    fenêtre — une « moyenne 200 jours » calculée sur 60 jours est un mensonge."""
    if len(closes) < window:
        return None
    return round(sum(closes[-window:]) / float(window), 4)


def _trend(price: Optional[float], sma50: Optional[float],
           sma200: Optional[float]) -> Optional[str]:
    """Lecture de tendance : prix contre moyennes. ``None`` si non calculable."""
    if price is None or sma50 is None:
        return None
    if sma200 is None:
        if price > sma50:
            return "haussier"
        if price < sma50:
            return "baissier"
        return "neutre"
    if price > sma50 > sma200:
        return "haussier"
    if price < sma50 < sma200:
        return "baissier"
    return "neutre"


def _volatility_ann_pct(closes: List[float]) -> Optional[float]:
    """Volatilité annualisée : écart-type des rendements quotidiens x sqrt(252).

    ``None`` sous ``MIN_VOL_POINTS`` rendements — un écart-type sur trois points
    n'est pas une volatilité, c'est du bruit.
    """
    returns = []
    for previous, current in zip(closes, closes[1:]):
        if previous and previous > 0:
            returns.append(current / previous - 1.0)
    if len(returns) < MIN_VOL_POINTS:
        return None
    try:
        sigma = statistics.stdev(returns)
    except statistics.StatisticsError:
        return None
    return round(sigma * math.sqrt(TRADING_DAYS_PER_YEAR) * 100.0, 2)


def _perf(closes: List[float], price: Optional[float], sessions: int) -> Optional[float]:
    """Performance en % sur ``sessions`` séances.

    Si la série est un peu plus courte que la fenêtre (Yahoo rend ~250 séances
    pour ``range=1y``, pas 253), on prend la plus ancienne clôture disponible —
    c'est « environ un an » et c'est dit dans ``n_sessions``. En dessous de 80 %
    de la fenêtre, on rend ``None`` plutôt qu'un chiffre trompeur.
    """
    if price is None or not closes:
        return None
    if len(closes) > sessions:
        ref = closes[-(sessions + 1)]
    elif len(closes) >= int(sessions * 0.8):
        ref = closes[0]
    else:
        return None
    if ref <= 0:
        return None
    return round((price / ref - 1.0) * 100.0, 2)
