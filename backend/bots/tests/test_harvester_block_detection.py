"""Tests B — détection de blocage.

  - StealthFetcher : une page dont le CORPS porte des marqueurs de challenge
    (cf-turnstile, __cf_chl, challenge-platform...) n'est PAS rendue comme du
    contenu, même si le <title> est bénin ; un blocage persistant lève
    PushbackError (l'engine recule au lieu de marteler).
  - Engine : une page qui extrait 0 record émet un événement `zero_items`
    (visibilité) ; option `pushback_on_empty` -> retry borné de la même URL.
"""
import pytest

from backend.bots.harvester.engine import Engine
from backend.bots.harvester.fetch import PushbackError, RateLimiter
from backend.bots.harvester.fetch_stealth import StealthFetcher, is_challenge_html
from backend.bots.harvester.store import Store


# ---- StealthFetcher : challenge dans le corps -----------------------------

class HtmlSession(object):
    def __init__(self, html, title="OK"):
        self._html = html
        self._title = title
        self.gotos = 0

    def goto(self, url):
        self.gotos += 1

    def title(self):
        return self._title          # bénin -> _wait_resolved passe

    def content(self):
        return self._html

    def interact(self):
        pass


def _sf(session, **kw):
    return StealthFetcher(
        RateLimiter(0.0, clock=lambda: 0.0, sleep=lambda s: None),
        session=session, warm_url="https://site.test/p1",
        sleep=lambda s: None, jitter=lambda: 0.0, retries=2, **kw)


def test_is_challenge_html_detects_markers():
    assert is_challenge_html('<div class="cf-turnstile"></div>')
    assert is_challenge_html('<script>window.__cf_chl_opt={}</script>')
    assert is_challenge_html('<a href="/cdn-cgi/challenge-platform/x">x</a>')
    assert is_challenge_html('<title>Just a moment...</title>')


def test_is_challenge_html_false_on_real_page():
    assert not is_challenge_html('<html><body><h3>A real book</h3></body></html>')


def test_challenge_body_with_benign_title_is_not_returned():
    # titre bénin mais corps = widget Turnstile -> doit lever PushbackError
    s = HtmlSession('<div class="cf-turnstile">verify</div>', title="Welcome")
    with pytest.raises(PushbackError):
        _sf(s).get("https://site.test/x")


def test_clean_html_is_returned():
    s = HtmlSession("<html><body>clean</body></html>", title="Real")
    assert _sf(s).get("https://site.test/x") == "<html><body>clean</body></html>"


def test_persistent_block_raises_pushback_not_plain_fetcherror():
    # PushbackError EST une FetchError, mais le type précis déclenche le
    # back-off pacer-aware de l'engine.
    s = HtmlSession('__cf_chl_opt', title="ok")
    err = None
    try:
        _sf(s).get("https://site.test/x")
    except PushbackError as e:
        err = e
    assert isinstance(err, PushbackError)


# ---- Engine : zero_items + pushback_on_empty ------------------------------

class FakeRecipe(object):
    def __init__(self, items):
        self._items = items

    def extract(self, html):
        return list(self._items)

    def field_names(self):
        return ["x"]


class PassPolicy(object):
    def validate(self, raw):
        return raw


class FakeFetcher(object):
    def __init__(self, html="<html></html>"):
        self._html = html

    def get(self, url):
        return self._html


class FakePacer(object):
    def __init__(self):
        self.penalized = 0
        self.relaxed = 0

    def interval(self):
        return 0.0

    def penalize(self, retry_after=None):
        self.penalized += 1

    def relax(self):
        self.relaxed += 1


def _engine(tmp_path, items, plan, pacer=None, **kw):
    store = Store(str(tmp_path / "store.json"))
    store.add_todo("https://e.test/p1")
    return store, Engine(store, FakeRecipe(items), FakeFetcher(), PassPolicy(),
                         plan, sleep=lambda s: None, pacer=pacer, **kw)


def test_engine_emits_zero_items_event(tmp_path):
    events = []
    store, eng = _engine(tmp_path, [], {"mode": "single"}, on_event=events.append)
    eng.step()
    assert any(e.get("type") == "zero_items" for e in events)


def test_engine_no_event_when_records_extracted(tmp_path):
    events = []
    store, eng = _engine(tmp_path, [{"x": "1"}], {"mode": "single"},
                         on_event=events.append)
    eng.step()
    assert not any(e.get("type") == "zero_items" for e in events)
    assert store.counts()["records"] == 1


def test_pushback_on_empty_retries_same_url(tmp_path):
    pacer = FakePacer()
    store, eng = _engine(tmp_path, [], {"mode": "single", "pushback_on_empty": True},
                         pacer=pacer, max_pushback_retries=3)
    assert eng.step() is True
    assert pacer.penalized == 1
    assert store.next_todo() == "https://e.test/p1"   # pas marquée done -> retry
    assert store.counts()["done"] == 0


def test_pushback_on_empty_gives_up_after_max(tmp_path):
    pacer = FakePacer()
    store, eng = _engine(tmp_path, [], {"mode": "single", "pushback_on_empty": True},
                         pacer=pacer, max_pushback_retries=2)
    eng.step()   # essai 1 (retry)
    eng.step()   # essai 2 -> abandon, marque done + erreur
    assert store.next_todo() is None
    assert store.counts()["errors"] == 1


def test_zero_items_without_flag_does_not_retry(tmp_path):
    pacer = FakePacer()
    store, eng = _engine(tmp_path, [], {"mode": "single"}, pacer=pacer)
    eng.step()
    assert store.next_todo() is None          # marquée done normalement
    assert pacer.penalized == 0
