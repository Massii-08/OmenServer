"""Fetcher à tiers — P1 = httpx seul (déjà une dépendance du projet).

RateLimiter et HttpxFetcher prennent clock/sleep/client injectables → test
offline déterministe (httpx.MockTransport, pas de réseau, pas d'horloge réelle).
Les tiers curl_cffi / stealth / unblocker arrivent en P3."""
import time
from typing import Any, Callable, Optional

DEFAULT_UA = "OmenHarvester/0.1 (+https://omenserver.org) polite-crawler"


class FetchError(Exception):
    pass


class PushbackError(FetchError):
    """Le serveur demande de ralentir (429/Retry-After) ou nous challenge.
    Porte le status + un éventuel délai Retry-After (secondes)."""

    def __init__(self, message, status=None, retry_after=None):
        FetchError.__init__(self, message)
        self.status = status
        self.retry_after = retry_after


_CHALLENGE_TOKENS = (
    "just a moment",
    "checking your browser",
    "attention required",
    "verify you are human",
    "cf-challenge",
)


def is_challenge(text):
    t = (text or "").lower()
    return any(tok in t for tok in _CHALLENGE_TOKENS)


def _parse_retry_after(value):
    if not value:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None  # HTTP-date form ignored (we just fall back to multiplicative)


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
            except httpx.HTTPError as e:
                last = repr(e)
            else:
                sc = resp.status_code
                # pushback : surfacé tout de suite (l'engine adapte le pacing)
                if sc == 429 or (sc == 503 and resp.headers.get("Retry-After")):
                    raise PushbackError(
                        "HTTP {0}".format(sc), status=sc,
                        retry_after=_parse_retry_after(resp.headers.get("Retry-After")))
                if sc >= 400:
                    last = "HTTP {0}".format(sc)
                else:
                    text = resp.text
                    if is_challenge(text):
                        raise PushbackError("challenge page", status=sc, retry_after=None)
                    return text
            if attempt < self.retries - 1:
                self._sleep(1.0 * (attempt + 1))  # linear back-off (transient errors)
        raise FetchError("GET {0} failed: {1}".format(url, last))
