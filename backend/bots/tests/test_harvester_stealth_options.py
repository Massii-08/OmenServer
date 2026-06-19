"""Tests — options avancées du tier stealth (lues du plan) :
proxy, pacing/attente/retries par feed, settle JS, locale/timezone, re-warm
périodique du cf_clearance, et dump screenshot+HTML au blocage (diagnostic).
Session injectée -> aucune dépendance patchright.
"""
import pytest

from backend.bots.harvester.__main__ import _build_fetcher
from backend.bots.harvester.fetch import PushbackError, RateLimiter
from backend.bots.harvester.fetch_stealth import StealthFetcher


def _rate():
    return RateLimiter(0.0, clock=lambda: 0.0, sleep=lambda s: None)


class BlockSession(object):
    """Sert toujours une page de challenge -> bloque (pour tester le dump)."""

    def __init__(self):
        self.shots = []

    def goto(self, url):
        pass

    def title(self):
        return "Welcome"        # titre bénin

    def content(self):
        return '<div class="cf-turnstile">verify</div>'   # corps = challenge

    def interact(self):
        pass

    def screenshot(self, path):
        self.shots.append(path)


class CountSession(object):
    """Compte les goto (pour tester le re-warm périodique)."""

    def __init__(self):
        self.gotos = []

    def goto(self, url):
        self.gotos.append(url)

    def title(self):
        return "Real"

    def content(self):
        return "<html>ok</html>"

    def interact(self):
        pass

    def screenshot(self, path):
        pass


# ---- _build_fetcher lit les options du plan -------------------------------

def test_build_fetcher_stealth_reads_plan_options():
    plan = {"fetch_tier": "stealth", "max_wait": 60, "retries": 4,
            "proxy": {"server": "http://p:8080"}, "locale": "en-US",
            "timezone": "America/New_York", "wait_after": 1500,
            "pace_min": 5, "pace_max": 9, "rewarm_every": 10}
    f = _build_fetcher("stealth", _rate(), "https://s.test/p", plan, "/tmp/run")
    assert isinstance(f, StealthFetcher)
    assert f.max_wait_s == 60
    assert f.retries == 4
    assert f.run_dir == "/tmp/run"
    assert f.rewarm_every == 10
    assert f._browser_opts["proxy"] == {"server": "http://p:8080"}
    assert f._browser_opts["locale"] == "en-US"
    assert f._browser_opts["timezone_id"] == "America/New_York"
    assert f._browser_opts["settle_ms"] == 1500


def test_build_fetcher_proxy_string_is_wrapped():
    f = _build_fetcher("stealth", _rate(), "https://s.test/p",
                       {"proxy": "http://host:3128"}, None)
    assert f._browser_opts["proxy"] == {"server": "http://host:3128"}


def test_build_fetcher_stealth_defaults_without_options():
    f = _build_fetcher("stealth", _rate(), "https://s.test/p",
                       {"fetch_tier": "stealth"}, None)
    assert f.max_wait_s == 35
    assert f.retries == 2
    assert f.rewarm_every == 0
    assert f._browser_opts["proxy"] is None


# ---- screenshot + HTML au blocage (diagnostic) ----------------------------

def test_block_dumps_screenshot_and_html(tmp_path):
    s = BlockSession()
    f = StealthFetcher(_rate(), session=s, warm_url="https://s.test/p",
                       sleep=lambda x: None, jitter=lambda: 0.0, retries=1,
                       run_dir=str(tmp_path))
    with pytest.raises(PushbackError):
        f.get("https://s.test/x")
    htmls = list((tmp_path / "blocks").glob("*.html"))
    assert len(s.shots) == 1                       # screenshot tenté
    assert len(htmls) == 1
    assert "cf-turnstile" in htmls[0].read_text(encoding="utf-8")


def test_no_dump_without_run_dir():
    s = BlockSession()
    f = StealthFetcher(_rate(), session=s, warm_url="https://s.test/p",
                       sleep=lambda x: None, jitter=lambda: 0.0, retries=1)
    with pytest.raises(PushbackError):
        f.get("https://s.test/x")
    assert s.shots == []                           # pas de run_dir -> pas de dump


# ---- re-warm périodique du cf_clearance -----------------------------------

def test_periodic_rewarm_rewarms_origin():
    s = CountSession()
    f = StealthFetcher(_rate(), session=s, warm_url="https://s.test/deep/p",
                       sleep=lambda x: None, jitter=lambda: 0.0, rewarm_every=2)
    f.get("https://s.test/a")
    f.get("https://s.test/b")
    f.get("https://s.test/c")
    origin = [g for g in s.gotos if g == "https://s.test"]
    assert len(origin) == 2                        # warm au #1 + re-warm au #3


def test_no_rewarm_by_default():
    s = CountSession()
    f = StealthFetcher(_rate(), session=s, warm_url="https://s.test/deep/p",
                       sleep=lambda x: None, jitter=lambda: 0.0)
    f.get("https://s.test/a")
    f.get("https://s.test/b")
    f.get("https://s.test/c")
    origin = [g for g in s.gotos if g == "https://s.test"]
    assert len(origin) == 1                         # warm une seule fois (défaut)


# ---- robustesse des options (fixes revue) ---------------------------------

def test_as_int_tolerant_and_clamped():
    from backend.bots.harvester.__main__ import _as_int
    assert _as_int("60.0", 35) == 60                # string décimale OK
    assert _as_int("abc", 35) == 35                 # non-numérique -> défaut
    assert _as_int(None, 35) == 35
    assert _as_int(999, 35, hi=120) == 120          # clamp haut
    assert _as_int(-5, 2, lo=1) == 1                # clamp bas


def test_build_fetcher_bad_numeric_falls_back_to_default():
    f = _build_fetcher("stealth", _rate(), "https://s.test/p",
                       {"max_wait": "abc", "retries": "x", "rewarm_every": "no"}, None)
    assert f.max_wait_s == 35
    assert f.retries == 2
    assert f.rewarm_every == 0


def test_build_fetcher_decimal_string_max_wait():
    f = _build_fetcher("stealth", _rate(), "https://s.test/p", {"max_wait": "60.0"}, None)
    assert f.max_wait_s == 60


def test_build_fetcher_pacing_bounds_are_sorted():
    f = _build_fetcher("stealth", _rate(), "https://s.test/p",
                       {"pace_min": 9, "pace_max": 2}, None)
    assert f._jitter.keywords["lo"] == 2.0          # fenêtre triée min<=max
    assert f._jitter.keywords["hi"] == 9.0


def test_build_fetcher_proxy_without_server_is_dropped():
    f = _build_fetcher("stealth", _rate(), "https://s.test/p",
                       {"proxy": {"username": "u"}}, None)
    assert f._browser_opts["proxy"] is None


def test_block_dump_respects_cap(tmp_path):
    from backend.bots.harvester.fetch_stealth import MAX_BLOCK_DUMPS
    s = BlockSession()
    f = StealthFetcher(_rate(), session=s, warm_url="https://s.test/p",
                       sleep=lambda x: None, jitter=lambda: 0.0, retries=1,
                       run_dir=str(tmp_path))
    for i in range(MAX_BLOCK_DUMPS + 5):
        with pytest.raises(PushbackError):
            f.get("https://s.test/x{0}".format(i))
    htmls = list((tmp_path / "blocks").glob("*.html"))
    assert len(htmls) == MAX_BLOCK_DUMPS            # capé, pas de remplissage disque


def test_block_dump_includes_url(tmp_path):
    s = BlockSession()
    f = StealthFetcher(_rate(), session=s, warm_url="https://s.test/p",
                       sleep=lambda x: None, jitter=lambda: 0.0, retries=1,
                       run_dir=str(tmp_path))
    with pytest.raises(PushbackError):
        f.get("https://s.test/blocked-page")
    html = list((tmp_path / "blocks").glob("*.html"))[0].read_text(encoding="utf-8")
    assert "blocked-page" in html                  # l'URL bloquée est tracée
