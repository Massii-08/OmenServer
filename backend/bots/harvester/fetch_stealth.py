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

# Cap des dumps de diagnostic par run (anti remplissage disque si la cible
# bloque en boucle). Quelques échantillons suffisent à diagnostiquer.
MAX_BLOCK_DUMPS = int(os.environ.get("FEEDSMITH_MAX_BLOCK_DUMPS", "20"))

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
    "_cf_chl_ctx",
    "/cdn-cgi/challenge-platform",
    "challenge-platform",
    "cf-mitigated",
    "cf-error-details",
    "cloudflare ray id",  # 'ray id' nu collisionnerait avec 'array id' ;
    # 'error 1020' nu écarté : trop générique (un blog parlant de l'erreur CF
    # matcherait) — la page 1020 native porte de toute façon Ray ID + cf-error-details.
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


def _click_challenge(session) -> bool:
    """Best-effort : demande à la session de cliquer la case Turnstile au centre.
    Tolère une session sans ``click_turnstile`` (comme ``_interact``). NE RÉSOUT
    RIEN — un vrai navigateur valide le clic. True si un widget a été cliqué."""
    fn = getattr(session, "click_turnstile", None)
    if callable(fn):
        try:
            return bool(fn())
        except Exception:  # noqa: BLE001 — best-effort
            return False
    return False


class BrowserSession(typing.Protocol):
    """Minimal browser surface the StealthFetcher drives."""

    def goto(self, url: str) -> None: ...

    def title(self) -> str: ...

    def content(self) -> str: ...

    def interact(self) -> None: ...  # human behavioural noise (mouse/scroll)

    def screenshot(self, path: str) -> None: ...  # diagnostic au blocage

    def click_turnstile(self) -> bool: ...  # auto-click case (best-effort, optionnel)


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
        run_dir: Optional[str] = None,
        browser_opts: Optional[dict] = None,
        rewarm_every: int = 0,
    ) -> None:
        """Configure pacing, warm URL, challenge wait budget, retries, per-host
        profile, diagnostics run_dir, browser options (proxy/locale/tz/settle),
        and periodic cf_clearance re-warm (0 = jamais)."""
        self.rate = rate
        self._session = session
        self.warm_url = warm_url
        self._sleep = sleep
        self._jitter = jitter
        self.max_wait_s = max_wait_s
        self.retries = retries
        self._profile_base = profile_base
        self.run_dir = run_dir
        self._browser_opts = browser_opts or {}
        self.rewarm_every = rewarm_every
        self._warmed = False
        self._req_count = 0
        # seed depuis les dumps existants -> une reprise n'écrase pas les anciens
        self._block_n = 0
        if run_dir:
            try:
                import glob
                self._block_n = len(glob.glob(
                    os.path.join(run_dir, "blocks", "block-*.html")))
            except Exception:  # noqa: BLE001
                pass
        self._attempt_error = None  # cause du dernier essai (A/B)

    def _ensure_session(self) -> "BrowserSession":
        """Return the injected session, or lazily build the real patchright one
        with a stable per-host profile (N2) + browser options."""
        if self._session is None:
            profile = profile_for(self._profile_base, self.warm_url or "")
            self._session = PatchrightBrowserSession(profile=profile,
                                                     **self._browser_opts)
        return self._session

    def _dump_block(self, session: "BrowserSession", url: str) -> None:
        """Diagnostic au blocage : enregistre screenshot + HTML dans run_dir/blocks
        pour que l'opérateur voie CE qui bloque (Turnstile ? IP ? rate-limit ?).
        Best-effort, ne lève jamais."""
        if not self.run_dir or self._block_n >= MAX_BLOCK_DUMPS:
            return  # cap : pas de remplissage disque si la cible bloque en boucle
        try:
            d = os.path.join(self.run_dir, "blocks")
            os.makedirs(d, exist_ok=True)
            self._block_n += 1
            base = os.path.join(d, "block-{0}".format(self._block_n))
            shot = getattr(session, "screenshot", None)
            if callable(shot):
                shot(base + ".png")
            with open(base + ".html", "w", encoding="utf-8") as f:
                f.write("<!-- blocked url: {0} -->\n".format(url))
                f.write(session.content() or "")
        except Exception:  # noqa: BLE001 — diagnostic best-effort
            pass

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
        # re-warm périodique du cf_clearance (cookie ~30 min) pour les longs runs
        if self.rewarm_every and self._req_count > 0 \
                and self._req_count % self.rewarm_every == 0:
            self._warmed = False
        self._req_count += 1
        self._warm(session)

        last_error: Optional[str] = None
        for _ in range(self.retries):
            html = self._attempt(session, url)
            if html is not None:
                return html
            last_error = self._attempt_error
            # cookie may have gone cold -> re-warm before the next attempt.
            self._warmed = False
            self._warm(session)

        self._dump_block(session, url)  # diagnostic : screenshot + HTML au blocage
        return self._raise_block(url, last_error)

    def _attempt(self, session: "BrowserSession", url: str):
        """Un essai : goto + bruit + attente ; si le challenge persiste, auto-click
        GÉNÉRIQUE de la case puis ré-attente. Retourne le HTML propre, ou None.
        Mémorise la cause dans ``self._attempt_error``."""
        session.goto(url)
        _interact(session)  # N1: look human before reading the DOM
        if self._wait_resolved(session):
            html = session.content()
            # B: même si le titre est clean, le corps peut rester un
            # interstitiel / Turnstile -> ne jamais l'accepter comme contenu.
            if not is_challenge_html(html):
                self._attempt_error = None
                return html
            self._attempt_error = "challenge markers in body"
        else:
            self._attempt_error = "Cloudflare challenge unresolved"
        # A: challenge persiste -> auto-click générique de la case + ré-attente.
        if _click_challenge(session) and self._wait_resolved(session):
            html = session.content()
            if not is_challenge_html(html):
                self._attempt_error = None
                return html
        return None

    def _raise_block(self, url: str, last_error):
        """Lève PushbackError (sous-classe de FetchError) -> l'engine recule
        (pacer) et réessaie l'URL au lieu de la marteler. Surchargé en B."""
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
        proxy=None,
        locale=None,
        timezone_id=None,
        settle_ms: int = 0,
    ) -> None:
        """Profil persistant + options : proxy (dict playwright), locale,
        timezone_id (cohérence fingerprint), settle_ms (attente JS post-goto)."""
        self.profile = profile
        self.headless = headless
        self.proxy = proxy
        self.locale = locale
        self.timezone_id = timezone_id
        self.settle_ms = settle_ms
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
            proxy=self.proxy,             # None = pas de proxy
            locale=self.locale,
            timezone_id=self.timezone_id,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        self._page = self._ctx.pages[0] if self._ctx.pages else self._ctx.new_page()

    def goto(self, url: str) -> None:
        """Navigate to ``url`` (domcontentloaded, 60s) + settle JS optionnel."""
        self._ensure()
        self._page.goto(url, wait_until="domcontentloaded", timeout=60000)
        if self.settle_ms:
            self._page.wait_for_timeout(self.settle_ms)   # contenu rendu en JS

    def title(self) -> str:
        """Return the current page title."""
        self._ensure()
        return self._page.title()

    def content(self) -> str:
        """Return the current page HTML."""
        self._ensure()
        return self._page.content()

    def screenshot(self, path: str) -> None:
        """Capture la page (diagnostic au blocage). Best-effort."""
        self._ensure()
        try:
            self._page.screenshot(path=path)   # viewport (borné), pas full_page
        except Exception:  # noqa: BLE001 — diagnostic best-effort
            pass

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

    def click_turnstile(self) -> bool:
        """Localise le widget Turnstile / l'iframe challenge et clique AU CENTRE
        (bounding box). Ne touche JAMAIS l'intérieur de l'iframe (sélecteur
        obfusqué) -> robuste & générique. NE RÉSOUT RIEN. True si trouvé+cliqué.
        Best-effort : toute erreur -> False (jamais de crash de fetch)."""
        self._ensure()
        try:
            for sel in (".cf-turnstile",
                        "iframe[src*='challenges.cloudflare.com']",
                        "iframe[title*='challenge' i]"):
                loc = self._page.locator(sel).first
                if loc.count() == 0:
                    continue
                box = loc.bounding_box()
                if not box:
                    continue
                self._page.mouse.click(box["x"] + box["width"] / 2.0,
                                       box["y"] + box["height"] / 2.0)
                return True
        except Exception:  # noqa: BLE001 — best-effort, jamais fatal
            return False
        return False

    def close(self) -> None:
        """Close the context and stop playwright (best-effort)."""
        try:
            if self._ctx is not None:
                self._ctx.close()
            if self._pw is not None:
                self._pw.stop()
        finally:
            self._pw = self._ctx = self._page = None
