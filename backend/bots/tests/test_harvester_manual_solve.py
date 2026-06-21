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


class FlipSession(object):
    """Reste en challenge jusqu'au Nᵉ appel de title(), puis propre."""
    def __init__(self, flip_after):
        self.flip_after = flip_after
        self.title_calls = 0
        self.gotos = 0

    def goto(self, url):
        self.gotos += 1

    def title(self):
        self.title_calls += 1
        return "Real" if self.title_calls > self.flip_after else "Just a moment..."

    def content(self):
        return ("<html>clean</html>" if self.title_calls > self.flip_after
                else '<div class="cf-turnstile">x</div>')

    def interact(self):
        pass

    def click_turnstile(self):
        return False  # l'auto-click ne suffit pas (vrai puzzle) -> manual solve


def _counter_clock(start=0.0, step=1.0):
    state = {"t": start}

    def clock():
        v = state["t"]
        state["t"] += step
        return v
    return clock


def test_await_manual_solve_resolves_and_returns_html():
    s = FlipSession(flip_after=2)
    events = []
    f = _sf(s, on_event=events.append, manual_solve=True,
            manual_solve_timeout=100, solve_poll_s=0.0,
            clock=lambda: 0.0, should_stop=lambda: False)
    out = f._await_manual_solve(s, "https://site.test/x")
    assert out == "<html>clean</html>"
    types = [e["type"] for e in events]
    assert types == ["awaiting_manual_solve", "manual_solve_resolved"]


def test_await_manual_solve_times_out_returns_none():
    s = FlipSession(flip_after=9999)  # jamais résolu
    events = []
    f = _sf(s, on_event=events.append, manual_solve=True,
            manual_solve_timeout=3, solve_poll_s=0.0,
            clock=_counter_clock(), should_stop=lambda: False)
    out = f._await_manual_solve(s, "https://site.test/x")
    assert out is None
    assert [e["type"] for e in events] == ["awaiting_manual_solve", "manual_solve_timeout"]


def test_await_manual_solve_aborts_on_stop():
    s = FlipSession(flip_after=9999)
    events = []
    f = _sf(s, on_event=events.append, manual_solve=True,
            manual_solve_timeout=100, solve_poll_s=0.0,
            clock=lambda: 0.0, should_stop=lambda: True)
    assert f._await_manual_solve(s, "https://site.test/x") is None
    assert [e["type"] for e in events] == ["awaiting_manual_solve", "manual_solve_timeout"]


def test_await_manual_solve_notifies_once_with_url():
    s = FlipSession(flip_after=1)
    sent = []
    f = _sf(s, manual_solve=True, manual_solve_timeout=100, solve_poll_s=0.0,
            clock=lambda: 0.0, should_stop=lambda: False, notify=sent.append)
    f._await_manual_solve(s, "https://site.test/captcha")
    assert len(sent) == 1
    assert "https://site.test/captcha" in sent[0]


def test_get_manual_solve_off_raises_pushback():
    # manual_solve OFF (défaut) -> comportement legacy (PushbackError)
    s = FlipSession(flip_after=9999)
    with pytest.raises(PushbackError):
        _sf(s).get("https://site.test/x")


def test_get_falls_back_to_pushback_on_solve_timeout():
    # manual_solve ON mais jamais résolu -> awaiting puis timeout -> PushbackError
    s = FlipSession(flip_after=9999)
    events = []
    f = _sf(s, on_event=events.append, manual_solve=True, manual_solve_timeout=3,
            solve_poll_s=0.0, clock=_counter_clock(), should_stop=lambda: False)
    with pytest.raises(PushbackError):
        f.get("https://site.test/x")
    assert "awaiting_manual_solve" in [e["type"] for e in events]
    assert "manual_solve_timeout" in [e["type"] for e in events]
