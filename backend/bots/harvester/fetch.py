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


def _default_url_guard(url):
    """Garde anti-SSRF par défaut : lève si l'URL vise une cible interne/privée
    ou un schéma non-http(s). Importé paresseusement pour rester découplé du
    package backend en test (le guard est injectable)."""
    from backend import net_guard
    net_guard.assert_public_url(url)


class HttpxFetcher(object):
    """Fetcher httpx avec retries à back-off linéaire. `client` injectable.

    ⚠️ Anti-SSRF : ``url_guard`` est appelé AVANT chaque GET (URL de départ ET
    chaque hop de redirect — voir ``follow_redirects=False`` + suivi manuel
    ci-dessous). Défaut = ``net_guard.assert_public_url`` (rejette loopback /
    IP privée / link-local / schéma non-http(s)). Injectable -> les tests
    offline passent un guard permissif (les hôtes ``x.test`` ne résolvent pas).
    """

    def __init__(self, rate: RateLimiter, retries: int = 3, timeout: float = 20.0,
                 user_agent: str = DEFAULT_UA, client: Optional[Any] = None,
                 sleep: Callable[[float], None] = time.sleep,
                 url_guard: Optional[Callable[[str], None]] = None,
                 max_redirects: int = 5) -> None:
        self.rate = rate
        self.retries = retries
        self.timeout = timeout
        self.user_agent = user_agent
        self._client = client
        self._sleep = sleep
        # None -> guard par défaut (résolu paresseusement) ; les tests injectent
        # un no-op pour ne pas toucher au DNS.
        self._url_guard = url_guard if url_guard is not None else _default_url_guard
        self.max_redirects = max_redirects

    def _get_client(self):
        if self._client is not None:
            return self._client
        import httpx  # lazy
        # follow_redirects=False : on suit les redirects À LA MAIN (_request) pour
        # re-valider chaque hop via le guard (un 302 vers 127.0.0.1 doit être
        # bloqué, pas suivi en aveugle).
        self._client = httpx.Client(
            timeout=self.timeout,
            headers={"User-Agent": self.user_agent},
            follow_redirects=False,
        )
        return self._client

    def _request(self, client, url):
        """GET avec suivi MANUEL des redirects, chaque hop re-validé par le guard.
        Lève FetchError si un hop vise une cible interne (anti-SSRF via redirect)."""
        import httpx  # lazy
        from urllib.parse import urljoin
        current = url
        for _ in range(self.max_redirects + 1):
            # garde anti-SSRF AVANT chaque requête (URL de départ + chaque hop)
            try:
                self._url_guard(current)
            except Exception as e:  # UnsafeUrlError ou autre -> erreur de fetch propre
                raise FetchError("URL bloquée (SSRF guard): {0}".format(type(e).__name__))
            resp = client.get(current)
            if resp.status_code in (301, 302, 303, 307, 308):
                loc = resp.headers.get("Location") or resp.headers.get("location")
                if not loc:
                    return resp
                current = urljoin(current, loc)
                continue
            return resp
        raise FetchError("Trop de redirections pour {0}".format(url))

    def get(self, url: str) -> str:
        import httpx  # lazy
        client = self._get_client()
        last = None  # type: Optional[str]
        for attempt in range(self.retries):
            self.rate.wait()
            try:
                resp = self._request(client, url)
            except FetchError as e:
                # SSRF-block / too-many-redirects : pas de retry réseau utile,
                # surfacé directement (le guard est déterministe).
                raise
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
