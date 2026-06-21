"""Tests features A (auto-click case) + B (résolution manuelle) du tier stealth.
100% offline : BrowserSession factice + clock/sleep/should_stop/notify injectés."""
import pytest

from backend.bots.harvester.fetch import PushbackError, RateLimiter
from backend.bots.harvester.fetch_stealth import StealthFetcher


def _rate():
    return RateLimiter(0.0, clock=lambda: 0.0, sleep=lambda s: None)


def _sf(session, **kw):
    kw.setdefault("warm_url", "https://site.test/p1")
    kw.setdefault("sleep", lambda s: None)
    kw.setdefault("jitter", lambda: 0.0)
    kw.setdefault("retries", 2)
    kw.setdefault("max_wait_s", 1)
    return StealthFetcher(_rate(), session=session, **kw)


class ClickSession(object):
    """Reste en challenge jusqu'au click de la case, puis sert du contenu propre."""
    def __init__(self):
        self._clicked = False
        self.click_calls = 0
        self.gotos = 0

    def goto(self, url):
        self.gotos += 1

    def title(self):
        return "Real page" if self._clicked else "Just a moment..."

    def content(self):
        return ("<html><body>clean</body></html>" if self._clicked
                else '<div class="cf-turnstile">verify</div>')

    def interact(self):
        pass

    def click_turnstile(self):
        self.click_calls += 1
        self._clicked = True
        return True


class NoClickSession(object):
    """Session sans click_turnstile : l'auto-click doit être toléré (no-op)."""
    def __init__(self, html, title="OK"):
        self._html = html
        self._title = title

    def goto(self, url):
        pass

    def title(self):
        return self._title

    def content(self):
        return self._html

    def interact(self):
        pass


def test_autoclick_resolves_checkbox_challenge():
    s = ClickSession()
    out = _sf(s).get("https://site.test/x")
    assert out == "<html><body>clean</body></html>"
    assert s.click_calls == 1


def test_no_click_method_is_tolerated_and_still_pushes_back():
    # corps challenge + pas de click_turnstile -> PushbackError (comportement legacy)
    s = NoClickSession('<div class="cf-turnstile">x</div>', title="Welcome")
    with pytest.raises(PushbackError):
        _sf(s).get("https://site.test/x")
