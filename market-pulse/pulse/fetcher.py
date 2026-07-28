"""Client API chart Yahoo Finance.

Yahoo bloque les clients HTTP « nus » au niveau TLS (429 immédiat, même mur que
Fitch — piège #33) : il faut curl_cffi avec l'empreinte Chrome. L'import est
paresseux pour que les tests injectent une fausse session sans toucher au réseau.

Règles apprises par sonde (2026-07-28) :
- un burst de requêtes = 429 instantané → pacing >= 1.1 s entre les appels ;
- un 429 ponctuel se retente (backoff), 3 essais max.
"""
import time
from typing import Callable, Optional

BASE_URL = "https://query1.finance.yahoo.com/v8/finance/chart/"


class FetchError(Exception):
    """Échec définitif après retries."""


class YahooChartClient:
    def __init__(
        self,
        session=None,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
        min_interval: float = 1.1,
        max_retries: int = 3,
        backoff: float = 2.0,
        timeout: float = 20.0,
    ):
        self._session = session
        self._sleep = sleep
        self._monotonic = monotonic
        self._min_interval = min_interval
        self._max_retries = max_retries
        self._backoff = backoff
        self._timeout = timeout
        self._last_call: Optional[float] = None

    def _ensure_session(self):
        if self._session is None:
            from curl_cffi import requests as creq
            self._session = creq.Session(impersonate="chrome")
        return self._session

    def _pace(self):
        if self._last_call is not None:
            elapsed = self._monotonic() - self._last_call
            if elapsed < self._min_interval:
                self._sleep(self._min_interval - elapsed)
        self._last_call = self._monotonic()

    def get_chart(self, symbol: str, range_: str = "10d", interval: str = "1d") -> dict:
        """Retourne la réponse chart brute (dict JSON) pour un symbole."""
        session = self._ensure_session()
        last_err: Optional[str] = None
        for attempt in range(self._max_retries):
            self._pace()
            try:
                r = session.get(
                    BASE_URL + symbol,
                    params={"range": range_, "interval": interval},
                    timeout=self._timeout,
                )
            except Exception as e:  # réseau/TLS : on retente
                last_err = type(e).__name__
                self._sleep(self._backoff * (attempt + 1))
                continue
            if r.status_code == 200:
                return r.json()
            last_err = "HTTP %s" % r.status_code
            if r.status_code in (429, 500, 502, 503):
                self._sleep(self._backoff * (attempt + 1))
                continue
            break  # 4xx autre = définitif (symbole inconnu, etc.)
        raise FetchError("%s: %s" % (symbol, last_err))
