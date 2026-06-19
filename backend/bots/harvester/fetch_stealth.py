"""Optional stealth fetcher tier for Cloudflare-protected public sources.

Reuses the anti-Cloudflare recipe validated live for the Upwork sniper: a
persistent real-Chrome profile (warm ``cf_clearance`` cookie), warm-then-fetch
sequencing, human-jitter pacing, and challenge detection. The anti-detection
LOGIC lives in :class:`StealthFetcher` and drives an injected
:class:`BrowserSession`, so it is fully testable offline; the real
:class:`PatchrightBrowserSession` is a thin shim validated at deploy.

Honest limit: this minimises bot-detection strongly but does NOT guarantee it.
It is best-effort, opt-in per feed; the default ``httpx`` tier and clean,
permitted sources remain Feedsmith's durable core.
"""
from __future__ import annotations

import os
import random
import time
import typing
from typing import Callable, Optional

from backend.bots.harvester.fetch import FetchError, RateLimiter

# Human pacing bounds between requests (anti speed-flag); overridable via env.
PACE_MIN = float(os.environ.get("FEEDSMITH_PACE_MIN", "3.0"))
PACE_MAX = float(os.environ.get("FEEDSMITH_PACE_MAX", "8.0"))

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


def jitter_delay(
    rng: Callable[[float, float], float] = random.uniform,
    lo: float = PACE_MIN,
    hi: float = PACE_MAX,
) -> float:
    """Return a bounded random pacing delay in ``[lo, hi]`` (rng injectable)."""
    return rng(lo, hi)


class BrowserSession(typing.Protocol):
    """Minimal browser surface the StealthFetcher drives."""

    def goto(self, url: str) -> None: ...

    def title(self) -> str: ...

    def content(self) -> str: ...


class StealthFetcher:
    """Anti-detection fetcher: paces like a human, warms cf_clearance, waits out
    the Cloudflare challenge, and never hammers a persistent wall.

    The :class:`BrowserSession` is injected (default: a lazily-created
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
    ) -> None:
        """Configure pacing, warm URL, challenge wait budget, and retries."""
        self.rate = rate
        self._session = session
        self.warm_url = warm_url
        self._sleep = sleep
        self._jitter = jitter
        self.max_wait_s = max_wait_s
        self.retries = retries
        self._warmed = False

    def _ensure_session(self) -> "BrowserSession":
        """Return the injected session, or lazily build the real patchright one."""
        if self._session is None:
            self._session = PatchrightBrowserSession()
        return self._session

    def _wait_resolved(self, session: "BrowserSession") -> bool:
        """Poll the page title until the CF challenge clears or budget runs out."""
        for _ in range(self.max_wait_s):
            if not is_challenge(session.title()):
                return True
            self._sleep(1)
        return not is_challenge(session.title())

    def _warm(self, session: "BrowserSession") -> None:
        """Load the warm URL once to obtain a hot cf_clearance cookie."""
        if self.warm_url and not self._warmed:
            session.goto(self.warm_url)
            self._wait_resolved(session)
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
            if self._wait_resolved(session):
                return session.content()
            last_error = "Cloudflare challenge unresolved"
            # cookie may have gone cold -> re-warm before the next attempt.
            self._warmed = False
            self._warm(session)

        raise FetchError("GET {0} blocked: {1}".format(url, last_error))


class PatchrightBrowserSession:
    """Real stealth browser session (patchright + persistent Chrome profile).

    Lazy: Chrome launches on first use. Headful under xvfb passes Cloudflare's
    managed challenge (pure headless does NOT). patchright is imported lazily so
    importing this module never requires the optional ``[stealth]`` extra.
    """

    def __init__(
        self,
        profile: str = "/tmp/feedsmith_stealth",
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

    def close(self) -> None:
        """Close the context and stop playwright (best-effort)."""
        try:
            if self._ctx is not None:
                self._ctx.close()
            if self._pw is not None:
                self._pw.stop()
        finally:
            self._pw = self._ctx = self._page = None
