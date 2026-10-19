"""Univers du scanner : le screener public de TradingView.

``POST https://scanner.tradingview.com/{market}/scan`` rend, en UNE requête,
toutes les actions d'un marché qui passent les filtres, avec les colonnes
demandées (cours, variation, volume relatif, capitalisation, prochains
résultats…). Données différées d'environ 15 minutes sans cookie — assez pour un
balayage de catalyseurs, pas pour du scalping.

⚠️ Source jamais sondée dans le projet au moment d'écrire ce module : le
conteneur de développement rendait 403 sur ces hôtes. La forme de la requête et
de la réponse vient du code source du paquet open source ``tradingview-screener``
3.2.2 (PyPI, 2026) — ``{"totalCount": N, "data": [{"s": "MIL:ENI", "d": [...]}]}``,
les valeurs de ``d`` dans l'ordre des ``columns`` demandées. La commande
``python -m backend.bots.stockscan --probe <dossier>`` enregistre la vraie
réponse ; tant qu'elle n'a pas tourné, la fixture des tests est SYNTHÉTIQUE.

Découpage habituel : ``build_query`` et ``parse_response`` sont PURS (testables
hors ligne), ``ScreenerClient`` porte l'I/O (fonction ``post`` injectable).

Colonnes renommées : TradingView refuse une requête qui cite une colonne
inconnue. Le client rejoue alors UNE fois avec ``ignore_unknown_fields`` ; les
colonnes revenues vides sur toutes les lignes sont listées par
``parse_response`` (``null_columns``) pour que le moteur les signale — un champ
mort doit se VOIR (piège #61 du dépôt).
"""
import json
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from backend.bots.stockscan import markets as mk

SCAN_URL = "https://scanner.tradingview.com/{market}/scan"

# On se NOMME (doctrine de ``paper/tvnews.py``) ; ``Origin``/``Referer`` sont
# ceux que la page du screener envoie.
HEADERS = {
    "User-Agent": "Mozilla/5.0 (OmenServer stock scanner)",
    "Origin": "https://www.tradingview.com",
    "Referer": "https://www.tradingview.com/",
    "Accept": "application/json",
    "Content-Type": "application/json",
}

# Ordre = ordre des valeurs de ``d`` dans la réponse. Ne JAMAIS réordonner sans
# régénérer les fixtures.
COLUMNS: Tuple[str, ...] = (
    "name", "description", "type", "typespecs", "exchange", "currency",
    "close", "change", "gap", "volume", "relative_volume_10d_calc",
    "average_volume_10d_calc", "Value.Traded", "market_cap_basic",
    "fundamental_currency_code", "sector", "industry", "country",
    "Perf.W", "Perf.1M", "price_52_week_high", "price_52_week_low",
    "earnings_release_next_trading_date_fq", "dividends_yield_current",
    "price_earnings_ttm",
)

# Une colonne n'est déclarée « morte » que si l'échantillon est assez grand :
# sur deux lignes, un champ vide peut être normal (pas de dividende…).
MIN_ROWS_FOR_NULL_CHECK = 5

# Colonnes légitimement vides pour beaucoup de titres : on ne les déclare pas
# mortes même si elles le sont sur tout l'échantillon.
OPTIONAL_COLUMNS = frozenset({
    "dividends_yield_current", "price_earnings_ttm", "gap",
    "earnings_release_next_trading_date_fq", "industry",
})


class ScreenerError(Exception):
    """Le screener n'a pas rendu de données exploitables pour ce marché."""

    def __init__(self, reason: str, status: Optional[int] = None):
        super().__init__(reason)
        self.reason = reason
        self.status = status


# --------------------------------------------------------------------------- #
# PUR — la requête
# --------------------------------------------------------------------------- #

def build_query(market: mk.Market, cfg: Dict[str, Any],
                ignore_unknown: bool = False) -> Dict[str, Any]:
    """Corps JSON de la requête pour un marché.

    Filtres CÔTÉ SERVEUR : action ordinaire, cotation principale (sinon un même
    titre sort une fois par place de cotation), capitalisation minimale
    convertie dans la devise du marché. Tri par montant échangé du jour : les
    titres qui s'échangent le plus sortent en premier, et ce sont justement
    ceux dont l'actualité fait bouger le volume.
    """
    min_cap_local = mk.to_local(float(cfg.get("min_cap_meur") or 0) * 1e6, market)
    return {
        "markets": [market.tv_market],
        "symbols": {},
        "options": {"lang": "en"},
        "columns": list(COLUMNS),
        "filter": [
            {"left": "type", "operation": "equal", "right": "stock"},
            {"left": "typespecs", "operation": "has", "right": ["common"]},
            {"left": "is_primary", "operation": "equal", "right": True},
            {"left": "market_cap_basic", "operation": "egreater",
             "right": round(min_cap_local)},
        ],
        "sort": {"sortBy": "Value.Traded", "sortOrder": "desc"},
        "range": [0, int(market.rows_limit)],
        "ignore_unknown_fields": bool(ignore_unknown),
    }


# --------------------------------------------------------------------------- #
# PUR — la réponse
# --------------------------------------------------------------------------- #

def _num(value: Any) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    if out != out or out in (float("inf"), float("-inf")):
        return None
    return out


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _date_of(value: Any) -> Optional[str]:
    """Date de prochains résultats -> ``YYYY-MM-DD`` (UTC), ou ``None``.

    Le screener rend un horodatage UNIX en secondes ; on accepte aussi les
    millisecondes et une chaîne ISO, parce que la forme exacte n'a pas encore
    été sondée.
    """
    if isinstance(value, str) and value.strip():
        raw = value.strip()
        try:
            return datetime.fromisoformat(raw.replace("Z", "+00:00")).date().isoformat()
        except ValueError:
            return raw[:10] if len(raw) >= 10 and raw[4] == "-" and raw[7] == "-" else None
    num = _num(value)
    if num is None or num <= 0:
        return None
    if num > 1e11:            # millisecondes
        num = num / 1000.0
    if num < 1e8:             # ni secondes ni millisecondes plausibles
        return None
    try:
        return datetime.fromtimestamp(num, tz=timezone.utc).date().isoformat()
    except (OverflowError, OSError, ValueError):
        return None


def _meur(amount: Optional[float], currency: Any, market: mk.Market) -> Optional[float]:
    """Un montant dans ``currency`` -> millions d'EUR (ordre de grandeur)."""
    if amount is None:
        return None
    rate = mk.eur_rate(currency, market)
    if rate is None:
        return None
    return round(amount * rate / 1e6, 2)


def parse_response(payload: Any, market: mk.Market,
                   columns: Sequence[str] = COLUMNS) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Réponse brute -> ``(lignes, infos)``. Ne lève jamais.

    Une ligne sans symbole lisible ou sans cours est JETÉE : on ne peut ni la
    relier aux news ni la vérifier. ``infos`` = ``{total, returned, dropped,
    null_columns}``.
    """
    info: Dict[str, Any] = {"total": None, "returned": 0, "dropped": 0, "null_columns": []}
    if not isinstance(payload, dict):
        return [], info
    info["total"] = int(_num(payload.get("totalCount")) or 0)
    raw_rows = payload.get("data")
    if not isinstance(raw_rows, list):
        return [], info

    cols = list(columns)
    seen_values: Dict[str, bool] = {c: False for c in cols}
    rows: List[Dict[str, Any]] = []
    seen_symbols = set()
    for raw in raw_rows:
        if not isinstance(raw, dict):
            info["dropped"] += 1
            continue
        tv_symbol = _text(raw.get("s")).upper()
        values = raw.get("d")
        if mk.split_tv(tv_symbol) is None or not isinstance(values, list):
            info["dropped"] += 1
            continue
        if tv_symbol in seen_symbols:
            continue
        seen_symbols.add(tv_symbol)
        d = dict(zip(cols, list(values) + [None] * max(0, len(cols) - len(values))))
        for c in cols:
            if d.get(c) not in (None, "", []):
                seen_values[c] = True

        price = _num(d.get("close"))
        if price is None or price <= 0:
            info["dropped"] += 1
            continue
        exchange, tv_ticker = mk.split_tv(tv_symbol)
        currency = _text(d.get("currency")) or market.currency
        avg_volume = _num(d.get("average_volume_10d_calc"))
        avg_value_local = (avg_volume * price) if avg_volume is not None else None
        # devise COMPTABLE : celle de market_cap_basic ET de Value.Traded
        cap_currency = _text(d.get("fundamental_currency_code")) or currency

        rows.append({
            "tv_symbol": tv_symbol,
            "symbol": mk.tv_to_yahoo(tv_symbol, market.id),
            "ticker": _text(d.get("name")) or tv_ticker,
            "name": _text(d.get("description")) or _text(d.get("name")) or tv_ticker,
            "market": market.id,
            "exchange": _text(d.get("exchange")) or exchange,
            "currency": currency,
            "price": price,
            "change_pct": _num(d.get("change")),
            "gap_pct": _num(d.get("gap")),
            "volume": _num(d.get("volume")),
            "rel_volume": _num(d.get("relative_volume_10d_calc")),
            "avg_value_meur": _meur(avg_value_local, currency, market),
            # Value.Traded est exprimé dans la devise COMPTABLE, pas dans la devise
            # de cotation. Mesure réelle du 19/10/2026 (8 marchés), rapport
            # Value.Traded / (volume × close) : 1,0 quand les deux devises
            # coïncident (USD/USD, EUR/EUR, CHF/CHF) ; 0,01 pour GBX/GBP (Londres :
            # cours en pence, valeur en livres — 100 fois trop petite en lisant
            # ``currency``) ; le taux de change quand elles diffèrent (USD/GBP
            # 0,7503, EUR/GBP 0,8431, USD/EUR 0,8899). ``avg_value_meur``, lui,
            # reste en devise de cotation : c'est un nombre de titres × le cours.
            "value_traded_meur": _meur(_num(d.get("Value.Traded")), cap_currency, market),
            "market_cap_meur": _meur(_num(d.get("market_cap_basic")), cap_currency, market),
            "sector": _text(d.get("sector")) or None,
            "industry": _text(d.get("industry")) or None,
            "country": _text(d.get("country")) or None,
            "perf_w": _num(d.get("Perf.W")),
            "perf_1m": _num(d.get("Perf.1M")),
            "high_52w": _num(d.get("price_52_week_high")),
            "low_52w": _num(d.get("price_52_week_low")),
            "earnings_next": _date_of(d.get("earnings_release_next_trading_date_fq")),
            "dividend_yield": _num(d.get("dividends_yield_current")),
            "pe": _num(d.get("price_earnings_ttm")),
        })

    info["returned"] = len(rows)
    if len(raw_rows) >= MIN_ROWS_FOR_NULL_CHECK:
        info["null_columns"] = [c for c in cols
                                if not seen_values[c] and c not in OPTIONAL_COLUMNS]
    return rows, info


# --------------------------------------------------------------------------- #
# I/O — le client
# --------------------------------------------------------------------------- #

def _default_post(url: str, json_body: Dict[str, Any], headers: Dict[str, str],
                  timeout: float):
    import httpx                  # paresseux : les tests n'en ont pas besoin
    return httpx.post(url, json=json_body, headers=headers, timeout=timeout)


class ScreenerClient:
    """Client du screener : pacing, retries sur 429/5xx, rejeu « colonnes ».

    ``post(url, json_body, headers, timeout)`` est injecté (défaut : httpx) ;
    il rend un objet façon httpx (``status_code``, ``text``, ``json()``).
    """

    def __init__(self, post: Optional[Callable[..., Any]] = None,
                 sleep: Callable[[float], None] = time.sleep,
                 monotonic: Callable[[], float] = time.monotonic,
                 min_interval: float = 1.5, timeout: float = 25.0,
                 max_retries: int = 2, backoff: float = 3.0,
                 url: str = SCAN_URL):
        self._post = post or _default_post
        self._sleep = sleep
        self._monotonic = monotonic
        self._min_interval = min_interval
        self._timeout = timeout
        self._max_retries = max_retries
        self._backoff = backoff
        self._url = url
        self._last_call: Optional[float] = None

    def _pace(self) -> None:
        if self._last_call is not None:
            elapsed = self._monotonic() - self._last_call
            if elapsed < self._min_interval:
                self._sleep(self._min_interval - elapsed)
        self._last_call = self._monotonic()

    def _send(self, tv_market: str, body: Dict[str, Any]) -> Tuple[Optional[Any], int, str]:
        """``(json|None, statut, extrait du corps)`` ; jamais d'exception."""
        self._pace()
        try:
            resp = self._post(self._url.format(market=tv_market), body,
                              dict(HEADERS), self._timeout)
        except Exception as exc:  # noqa: BLE001 — réseau/TLS
            return None, 0, type(exc).__name__
        status = getattr(resp, "status_code", 0)
        try:
            status = int(status)
        except (TypeError, ValueError):
            status = 0
        text = getattr(resp, "text", "")
        snippet = text[:300] if isinstance(text, str) else ""
        if status != 200:
            return None, status, snippet
        try:
            return resp.json(), status, snippet
        except Exception:         # noqa: BLE001 — JSON cassé
            try:
                return json.loads(text), status, snippet
            except (TypeError, ValueError):
                return None, status, "json illisible"

    def scan(self, market: mk.Market, cfg: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
        """Le relevé d'un marché -> ``(payload, meta)`` ou ``ScreenerError``.

        ``meta`` = ``{"status", "attempts", "ignored_unknown"}``.
        """
        ignore_unknown = False
        attempts = 0
        last = ""
        status = 0
        unknown_retry_done = False
        while attempts < self._max_retries + 2:
            attempts += 1
            body = build_query(market, cfg, ignore_unknown=ignore_unknown)
            payload, status, snippet = self._send(market.tv_market, body)
            if payload is not None:
                if isinstance(payload, dict) and payload.get("error") and not payload.get("data"):
                    last = str(payload.get("error"))[:200]
                    if not unknown_retry_done and "unknown" in last.lower():
                        unknown_retry_done, ignore_unknown = True, True
                        continue
                    raise ScreenerError(last, status)
                return payload, {"status": status, "attempts": attempts,
                                 "ignored_unknown": ignore_unknown}
            last = snippet or ("HTTP %s" % status)
            if status == 400 and not unknown_retry_done and "unknown" in last.lower():
                unknown_retry_done, ignore_unknown = True, True
                continue
            if status in (0, 429, 500, 502, 503, 504) and attempts <= self._max_retries:
                self._sleep(self._backoff * attempts)
                continue
            break
        raise ScreenerError(last or "HTTP %s" % status, status)
