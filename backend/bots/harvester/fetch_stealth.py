"""Optional stealth fetcher tier for Cloudflare-protected public sources.

Reuses the anti-Cloudflare recipe validated live for the Upwork sniper: a
persistent real-Chrome profile (warm ``cf_clearance`` cookie), warm-then-fetch
sequencing, human-jitter pacing, behavioural noise, and challenge detection.
The anti-detection LOGIC lives in :class:`StealthFetcher` and drives an injected
:class:`BrowserSession`, so it is fully testable offline; the real
:class:`PatchrightBrowserSession` is a thin shim validated at deploy.

Hardening levels implemented here:
  * **N1 — comportement** : after every navigation the fetcher asks the session
    to ``interact()`` (mouse moves + scroll) so behavioural scoring sees a human
    before we read the DOM; viewport/UA are kept stable for the whole session.
  * **N2 — cf_clearance chaud** : the warm step loads the *origin root* (the
    cookie is issued domain-wide) and the persistent Chrome profile is keyed
    PER HOST, so the warm ``cf_clearance`` survives across runs and the same
    single browser context is reused for the whole harvest.

Honest limit: this minimises bot-detection strongly but does NOT guarantee it.
It is best-effort, opt-in per feed; the default ``httpx`` tier and clean,
permitted sources remain Feedsmith's durable core. An *aggressive* challenge
(interactive Turnstile / bad IP reputation) needs a residential proxy + a
Turnstile solver, or a managed unblocker tier (P3c).
"""
from __future__ import annotations

import os
import random
import time
import typing
from typing import Callable, Optional
from urllib.parse import urlsplit

from backend.bots.harvester.fetch import FetchError, PushbackError, RateLimiter

# Human pacing bounds between requests (anti speed-flag); overridable via env.
PACE_MIN = float(os.environ.get("FEEDSMITH_PACE_MIN", "3.0"))
PACE_MAX = float(os.environ.get("FEEDSMITH_PACE_MAX", "8.0"))

# Default base dir for the persistent per-host Chrome profiles (N2).
PROFILE_BASE = os.environ.get("FEEDSMITH_PROFILE_BASE", "/tmp/feedsmith_stealth")

# Cloudflare interstitial title tokens (EN/FR). Deliberately narrow so a real
# page title never matches.
_CHALLENGE_TOKENS = (
    "just a moment",
    "un instant",
    "challenge",
    "checking your browser",
    "verifying",
    "attendez",
)


def is_challenge(title: str) -> bool:
    """True if ``title`` indicates an unresolved CF challenge (or no page yet)."""
    t = (title or "").strip().lower()
    if not t:
        return True
    return any(tok in t for tok in _CHALLENGE_TOKENS)


# Body markers (B): a challenge page can have a benign <title> but the HTML
# still carries Turnstile / CF-challenge widgets. Narrow enough that a real
# page never matches.
_CHALLENGE_HTML_MARKERS = (
    "cf-turnstile",
    "__cf_chl",
    "cf_chl_opt",
    "/cdn-cgi/challenge-platform",
    "challenge-platform",
    "cf-mitigated",
    "just a moment",
    "checking your browser",
    "attention required",
)


def is_challenge_html(html: str) -> bool:
    """True if the page BODY carries Cloudflare challenge markers (B).

    Catches the case where the title looks fine but we were actually served an
    interstitial / Turnstile widget instead of the real content."""
    t = (html or "").lower()
    return any(m in t for m in _CHALLENGE_HTML_MARKERS)


def jitter_delay(
    rng: Callable[[float, float], float] = random.uniform,
    lo: float = PACE_MIN,
    hi: float = PACE_MAX,
) -> float:
    """Return a bounded random pacing delay in ``[lo, hi]`` (rng injectable)."""
    return rng(lo, hi)


def origin_of(url: str) -> str:
    """Return the ``scheme://host[:port]`` root of ``url`` (N2 warm target).

    cf_clearance is issued for the whole domain, so warming the origin root is
    canonical. Garbage in (no scheme/host) is returned unchanged.
    """
    p = urlsplit(url)
    if not p.scheme or not p.netloc:
        return url
    return "{0}://{1}".format(p.scheme, p.netloc)


def profile_for(base: str, url: str) -> str:
    """Stable, per-host persistent-profile dir (N2 warm cookie reuse).

    Same host -> same profile (so cf_clearance/cookies persist across runs);
    the host is sanitised so it can never escape ``base`` via path separators.
    """
    host = urlsplit(url).netloc or "default"
    safe = "".join(c if (c.isalnum() or c in ".-") else "_" for c in host)
    return os.path.join(base, safe or "default")


def _interact(session: "BrowserSession") -> None:
    """Best-effort behavioural noise (N1). Never raises — interaction must
    never fail a fetch, and sessions without ``interact`` are tolerated."""
    fn = getattr(session, "interact", None)
    if callable(fn):
        try:
            fn()
        except Exception:  # noqa: BLE001 — best-effort, swallow
            pass


class BrowserSession(typing.Protocol):
    """Minimal browser surface the StealthFetcher drives."""

    def goto(self, url: str) -> None: ...

    def title(self) -> str: ...

    def content(self) -> str: ...

    def interact(self) -> None: ...  # human behavioural noise (mouse/scroll)


class StealthFetcher:
    """Anti-detection fetcher: paces like a human, warms cf_clearance on the
    origin root, adds behavioural noise, waits out the Cloudflare challenge, and
    never hammers a persistent wall.

    The :class:`BrowserSession` is injected (default: a lazily-created, per-host
    :class:`PatchrightBrowserSession`) so all logic is testable offline.
    """

    def __init__(
        self,
        rate: RateLimiter,
        session: Optional["BrowserSession"] = None,
        warm_url: Optional[str] = None,
        sleep: Callable[[float], None] = time.sleep,
        jitter: Callable[[], float] = jitter_delay,
        max_wait_s: int = 35,
        retries: int = 2,
        profile_base: str = PROFILE_BASE,
    ) -> None:
        """Configure pacing, warm URL, challenge wait budget, retries, and the
        per-host persistent-profile base dir."""
        self.rate = rate
        self._session = session
        self.warm_url = warm_url
        self._sleep = sleep
        self._jitter = jitter
        self.max_wait_s = max_wait_s
        self.retries = retries
        self._profile_base = profile_base
        self._warmed = False

    def _ensure_session(self) -> "BrowserSession":
        """Return the injected session, or lazily build the real patchright one
        with a stable per-host profile (N2)."""
        if self._session is None:
            profile = profile_for(self._profile_base, self.warm_url or "")
            self._session = PatchrightBrowserSession(profile=profile)
        return self._session

    def _wait_resolved(self, session: "BrowserSession") -> bool:
        """Poll the page title until the CF challenge clears or budget runs out."""
        for _ in range(self.max_wait_s):
            if not is_challenge(session.title()):
                return True
            self._sleep(1)
        return not is_challenge(session.title())

    def _warm(self, session: "BrowserSession") -> None:
        """Load the ORIGIN ROOT once to obtain a hot, domain-wide cf_clearance
        cookie (N2), with a touch of behavioural noise (N1)."""
        if self.warm_url and not self._warmed:
            session.goto(origin_of(self.warm_url))
            self._wait_resolved(session)
            _interact(session)
            self._warmed = True

    def get(self, url: str) -> str:
        """Fetch ``url`` via the stealth browser; raise FetchError if blocked."""
        session = self._ensure_session()
        self.rate.wait()
        self._sleep(self._jitter())  # human pacing (anti speed-flag)
        self._warm(session)

        last_error: Optional[str] = None
        for _ in range(self.retries):
            session.goto(url)
            _interact(session)  # N1: look human before reading the DOM
            if self._wait_resolved(session):
                html = session.content()
                # B: even if the title cleared, the body may still be an
                # interstitial / Turnstile -> never accept it as content.
                if not is_challenge_html(html):
                    return html
                last_error = "challenge markers in body"
            else:
                last_error = "Cloudflare challenge unresolved"
            # cookie may have gone cold -> re-warm before the next attempt.
            self._warmed = False
            self._warm(session)

        # PushbackError (sous-classe de FetchError) -> l'engine recule (pacer)
        # et réessaie l'URL au lieu de la marteler ou de l'abandonner sèchement.
        raise PushbackError(
            "GET {0} blocked: {1}".format(url, last_error), retry_after=None)


class PatchrightBrowserSession:
    """Real stealth browser session (patchright + persistent Chrome profile).

    Lazy: Chrome launches on first use. Headful under xvfb passes Cloudflare's
    managed challenge (pure headless does NOT). patchright is imported lazily so
    importing this module never requires the optional ``[stealth]`` extra.

    Viewport/UA stay fixed for the whole session (``no_viewport`` keeps the real
    window size, ``channel="chrome"`` keeps the genuine Chrome UA + TLS
    fingerprint that cf_clearance is bound to — N1/N2 stability).
    """

    # Behavioural-noise bounds (N1), overridable via env.
    MOVES_MIN = int(os.environ.get("FEEDSMITH_MOVES_MIN", "2"))
    MOVES_MAX = int(os.environ.get("FEEDSMITH_MOVES_MAX", "4"))

    def __init__(
        self,
        profile: str = PROFILE_BASE,
        headless: bool = False,
    ) -> None:
        """Store the persistent profile dir and headless flag."""
        self.profile = profile
        self.headless = headless
        self._pw = None
        self._ctx = None
        self._page = None

    def _ensure(self) -> None:
        """Launch Chrome on first use; raise FetchError if patchright is absent."""
        if self._page is not None:
            return
        try:
            from patchright.sync_api import sync_playwright
        except ImportError:
            raise FetchError(
                "patchright not installed; pip install '.[stealth]'"
            )
        os.makedirs(self.profile, exist_ok=True)
        self._pw = sync_playwright().start()
        self._ctx = self._pw.chromium.launch_persistent_context(
            self.profile,
            channel="chrome",
            headless=self.headless,
            no_viewport=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        self._page = self._ctx.pages[0] if self._ctx.pages else self._ctx.new_page()

    def goto(self, url: str) -> None:
        """Navigate to ``url`` (domcontentloaded, 60s timeout)."""
        self._ensure()
        self._page.goto(url, wait_until="domcontentloaded", timeout=60000)

    def title(self) -> str:
        """Return the current page title."""
        self._ensure()
        return self._page.title()

    def content(self) -> str:
        """Return the current page HTML."""
        self._ensure()
        return self._page.content()

    def interact(self) -> None:
        """Behavioural noise (N1): a few human-ish mouse moves + a scroll.

        Best-effort — any failure is swallowed so it never breaks a fetch.
        """
        self._ensure()
        try:
            for _ in range(random.randint(self.MOVES_MIN, self.MOVES_MAX)):
                self._page.mouse.move(
                    random.randint(40, 1200), random.randint(40, 760),
                    steps=random.randint(5, 15),
                )
                self._page.wait_for_timeout(random.randint(120, 420))
            self._page.mouse.wheel(0, random.randint(200, 900))
            self._page.wait_for_timeout(random.randint(150, 500))
        except Exception:  # noqa: BLE001 — best-effort behavioural noise
            pass

    def close(self) -> None:
        """Close the context and stop playwright (best-effort)."""
        try:
            if self._ctx is not None:
                self._ctx.close()
            if self._pw is not None:
                self._pw.stop()
        finally:
            self._pw = self._ctx = self._page = None
