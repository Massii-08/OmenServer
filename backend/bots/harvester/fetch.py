"""Fetcher à tiers — P1 = httpx seul (déjà une dépendance du projet).

RateLimiter et HttpxFetcher prennent clock/sleep/client injectables → test
offline déterministe (httpx.MockTransport, pas de réseau, pas d'horloge réelle).
Les tiers curl_cffi / stealth / unblocker arrivent en P3."""
import time
from typing import Any, Callable, Optional

DEFAULT_UA = "OmenHarvester/0.1 (+https://omenserver.org) polite-crawler"


class FetchError(Exception):
    pass


class RateLimiter(object):
    """Garantit un intervalle minimal entre deux retours de wait()."""

    def __init__(self, min_interval_s: float,
                 clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], None] = time.sleep) -> None:
        self.min_interval_s = min_interval_s
        self._clock = clock
        self._sleep = sleep
        self._last = None  # type: Optional[float]

    def wait(self) -> None:
        now = self._clock()
        if self._last is not None:
            remaining = self.min_interval_s - (now - self._last)
            if remaining > 0:
                self._sleep(remaining)
                now = self._clock()
        self._last = now


class HttpxFetcher(object):
    """Fetcher httpx avec retries à back-off linéaire. `client` injectable."""

    def __init__(self, rate: RateLimiter, retries: int = 3, timeout: float = 20.0,
                 user_agent: str = DEFAULT_UA, client: Optional[Any] = None,
                 sleep: Callable[[float], None] = time.sleep) -> None:
        self.rate = rate
        self.retries = retries
        self.timeout = timeout
        self.user_agent = user_agent
        self._client = client
        self._sleep = sleep

    def _get_client(self):
        if self._client is not None:
            return self._client
        import httpx  # lazy
        self._client = httpx.Client(
            timeout=self.timeout,
            headers={"User-Agent": self.user_agent},
            follow_redirects=True,
        )
        return self._client

    def get(self, url: str) -> str:
        import httpx  # lazy
        client = self._get_client()
        last = None  # type: Optional[str]
        for attempt in range(self.retries):
            self.rate.wait()
            try:
                resp = client.get(url)
                if resp.status_code >= 400:
                    last = "HTTP {0}".format(resp.status_code)
                else:
                    return resp.text
            except httpx.HTTPError as e:
                last = repr(e)
            if attempt < self.retries - 1:
                self._sleep(1.0 * (attempt + 1))  # linear back-off
        raise FetchError("GET {0} failed: {1}".format(url, last))
