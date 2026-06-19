"""Tests OFFLINE de la logique d'évasion durcie (niveaux 1 & 2) du StealthFetcher.

On injecte un faux BrowserSession (aucun patchright) et on vérifie :
  - N1 comportemental : interaction humaine (souris/scroll) après chaque goto,
    avant lecture ; échec d'interaction non bloquant (best-effort).
  - N2 cf_clearance chaud : warm sur la RACINE du domaine (pas l'URL profonde),
    profil persistant PAR HOST, un seul contexte réutilisé sur tout le run.
"""
from backend.bots.harvester.fetch import RateLimiter
from backend.bots.harvester.fetch_stealth import (
    StealthFetcher, origin_of, profile_for,
)


class FakeSession(object):
    """Faux BrowserSession qui journalise l'ordre des appels."""

    def __init__(self, html="<html>OK</html>", interact_raises=False):
        self.calls = []                 # liste ordonnée de (methode, arg)
        self._html = html
        self._interact_raises = interact_raises
        self.interact_count = 0

    def goto(self, url):
        self.calls.append(("goto", url))

    def title(self):
        return "Real Page Title"        # jamais un challenge -> resolved direct

    def content(self):
        self.calls.append(("content", None))
        return self._html

    def interact(self):
        self.calls.append(("interact", None))
        self.interact_count += 1
        if self._interact_raises:
            raise RuntimeError("interaction boom")


def _fetcher(session, warm_url="https://site.test/deep/page-1.html"):
    return StealthFetcher(
        RateLimiter(0.0, clock=lambda: 0.0, sleep=lambda s: None),
        session=session, warm_url=warm_url,
        sleep=lambda s: None, jitter=lambda: 0.0,
    )


# ---- helpers purs --------------------------------------------------------

def test_origin_of_returns_scheme_host_root():
    assert origin_of("https://a.b/c/d?e=1") == "https://a.b"
    assert origin_of("http://h.test:8080/x/y") == "http://h.test:8080"


def test_origin_of_passthrough_on_garbage():
    assert origin_of("notaurl") == "notaurl"


def test_profile_for_is_per_host_and_stable():
    p_same1 = profile_for("/base", "https://a.b/x")
    p_same2 = profile_for("/base", "https://a.b/y")
    p_other = profile_for("/base", "https://c.d/x")
    assert p_same1 == p_same2          # meme host -> meme profil (cookie reuse)
    assert p_same1 != p_other          # host different -> profil different
    assert "a.b" in p_same1


def test_profile_for_sanitizes_host():
    # pas de separateur de chemin injecte via un host bizarre
    p = profile_for("/base", "https://a.b:99/x")
    assert "/" not in p.rsplit("/", 1)[1]


# ---- N2 : warm cf_clearance ----------------------------------------------

def test_warm_targets_origin_root_not_deep_url():
    s = FakeSession()
    _fetcher(s, warm_url="https://site.test/deep/page-1.html").get(
        "https://site.test/deep/page-2.html")
    gotos = [a for (m, a) in s.calls if m == "goto"]
    assert gotos[0] == "https://site.test"                      # warm = racine
    assert gotos[1] == "https://site.test/deep/page-2.html"     # puis la cible


def test_single_session_warmed_once_across_gets():
    s = FakeSession()
    f = _fetcher(s, warm_url="https://site.test/p1")
    f.get("https://site.test/a")
    f.get("https://site.test/b")
    gotos = [a for (m, a) in s.calls if m == "goto"]
    assert gotos.count("https://site.test") == 1                # warm 1 seule fois


# ---- N1 : interaction comportementale ------------------------------------

def test_get_interacts_after_goto_before_content():
    s = FakeSession()
    _fetcher(s).get("https://site.test/x")
    methods = [m for (m, _a) in s.calls]
    last_goto = max(i for i, m in enumerate(methods) if m == "goto")
    first_content = methods.index("content")
    # une interaction se produit entre le dernier goto et la lecture du contenu
    assert "interact" in methods[last_goto:first_content]


def test_interact_called_during_warm_too():
    s = FakeSession()
    _fetcher(s).get("https://site.test/x")
    assert s.interact_count >= 2          # 1x au warm + 1x sur la cible


def test_interaction_failure_does_not_break_fetch():
    s = FakeSession(interact_raises=True)
    assert _fetcher(s).get("https://site.test/x") == "<html>OK</html>"


def test_constructs_without_patchright_and_keeps_warm_url():
    f = StealthFetcher(
        RateLimiter(0.0, clock=lambda: 0.0, sleep=lambda s: None),
        warm_url="https://x.test/")
    assert f.warm_url == "https://x.test/"
    assert callable(f.get)
