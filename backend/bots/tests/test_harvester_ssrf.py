"""Anti-SSRF du Harvester (faille #3).

Deux surfaces :
  - HttpxFetcher : re-valide CHAQUE URL (départ + redirects) via un guard ->
    un 302 vers une cible interne (127.0.0.1) est bloqué, pas suivi.
  - Engine : filtre les URL DÉCOUVERTES (pagination / sitemap) avant le frontier
    -> seules les URL publiques ET du même host entrent.

Tout offline : guard/filter injectables, resolver DNS factice, MockTransport.
"""
import httpx
import pytest

from backend import net_guard
from backend.bots.harvester.engine import _same_host_public_filter
from backend.bots.harvester.fetch import (
    FetchError,
    HttpxFetcher,
    RateLimiter,
    _default_url_guard,
)


def _silent_rate():
    return RateLimiter(0.0, clock=lambda: 0.0, sleep=lambda s: None)


# --- resolver DNS factice : public vs interne sans toucher au réseau ---------
_FAKE_DNS = {
    "public.test": ["93.184.216.34"],        # IP publique (documentation)
    "other-public.test": ["8.8.8.8"],        # autre host public (test cross-host)
    "evil.test": ["127.0.0.1"],              # loopback -> doit être bloqué
    "lan.test": ["192.168.1.10"],            # RFC1918 -> bloqué
    "meta.test": ["169.254.169.254"],        # link-local (metadata) -> bloqué
}


def _fake_resolver(host):
    return _FAKE_DNS.get(host, [])


def _guard_with_fake_dns(url):
    """Guard de prod mais avec resolver injecté (offline)."""
    net_guard.assert_public_url(url, resolver=_fake_resolver)


# ============================================================================
#  HttpxFetcher : garde anti-SSRF + redirects re-validés
# ============================================================================

def test_fetcher_blocks_initial_internal_url():
    # même si le transport répondrait OK, le guard rejette AVANT le GET
    called = {"n": 0}

    def handler(request):
        called["n"] += 1
        return httpx.Response(200, text="<html>secret</html>")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    f = HttpxFetcher(rate=_silent_rate(), retries=2, client=client,
                     sleep=lambda s: None, url_guard=_guard_with_fake_dns)
    with pytest.raises(FetchError):
        f.get("http://evil.test/")
    assert called["n"] == 0  # le GET n'a jamais été émis


def test_fetcher_allows_public_url():
    def handler(request):
        return httpx.Response(200, text="<html>ok</html>")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    f = HttpxFetcher(rate=_silent_rate(), retries=2, client=client,
                     sleep=lambda s: None, url_guard=_guard_with_fake_dns)
    assert f.get("http://public.test/") == "<html>ok</html>"


def test_fetcher_blocks_redirect_to_internal_host():
    # 302 public.test -> http://127.0.0.1/ : le hop interne doit être bloqué
    def handler(request):
        if request.url.host == "public.test":
            return httpx.Response(302, headers={"Location": "http://evil.test/admin"})
        return httpx.Response(200, text="<html>INTERNAL SECRET</html>")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    f = HttpxFetcher(rate=_silent_rate(), retries=1, client=client,
                     sleep=lambda s: None, url_guard=_guard_with_fake_dns)
    with pytest.raises(FetchError):
        f.get("http://public.test/")


def test_fetcher_follows_redirect_to_public_host():
    # 302 public.test -> public.test/final : hop public OK, suivi à la main
    def handler(request):
        if request.url.path == "/start":
            return httpx.Response(302, headers={"Location": "http://public.test/final"})
        return httpx.Response(200, text="<html>final page</html>")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    f = HttpxFetcher(rate=_silent_rate(), retries=1, client=client,
                     sleep=lambda s: None, url_guard=_guard_with_fake_dns)
    assert f.get("http://public.test/start") == "<html>final page</html>"


def test_fetcher_redirect_loop_does_not_hang():
    def handler(request):
        return httpx.Response(302, headers={"Location": "http://public.test/loop"})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    f = HttpxFetcher(rate=_silent_rate(), retries=1, client=client,
                     sleep=lambda s: None, url_guard=_guard_with_fake_dns,
                     max_redirects=3)
    with pytest.raises(FetchError):
        f.get("http://public.test/loop")


def test_default_url_guard_rejects_loopback_literal():
    # le guard par défaut (prod) bloque une IP littérale loopback sans DNS
    with pytest.raises(net_guard.UnsafeUrlError):
        _default_url_guard("http://127.0.0.1:8000/api")


def test_default_url_guard_rejects_non_http_scheme():
    with pytest.raises(net_guard.UnsafeUrlError):
        _default_url_guard("file:///etc/passwd")


# ============================================================================
#  Engine : filtre des URL découvertes (pagination / sitemap)
# ============================================================================

def test_filter_rejects_internal_discovered_url():
    assert _filter("http://evil.test/p2", "http://public.test/p1") is False


def test_filter_rejects_cross_host_url():
    # public mais host différent -> rejeté (la moisson ne doit pas diverger)
    assert _filter("http://other-public.test/p2", "http://public.test/p1") is False


def test_filter_accepts_same_host_public_url():
    assert _filter("http://public.test/p2", "http://public.test/p1") is True


def test_filter_rejects_non_http_scheme():
    assert _filter("javascript:alert(1)", "http://public.test/p1") is False


# helper : _same_host_public_filter avec resolver injecté via monkeypatch ------
def _filter(url, source_url):
    import backend.net_guard as ng
    orig = ng._default_resolver
    ng._default_resolver = _fake_resolver
    try:
        # _same_host_public_filter appelle is_public_url(url) (resolver par défaut)
        return _same_host_public_filter(url, source_url)
    finally:
        ng._default_resolver = orig
