"""Tests du garde anti-SSRF des requêtes sortantes (backend/net_guard.py).

Le resolver DNS est INJECTABLE -> tests 100% offline/déterministes (pas de vrai
DNS). On vérifie que loopback/privé/link-local/multicast/réservé sont rejetés,
que seul http(s) passe, et que l'allowlist d'hôtes fonctionne.
"""
import pytest

from backend import net_guard as ng


# --- resolver factice : mappe un host -> IP(s) sans toucher au réseau ---
def _fake_resolver(mapping):
    def resolve(host):
        if host not in mapping:
            raise OSError("name resolution failed: {0}".format(host))
        return list(mapping[host])
    return resolve


def test_loopback_is_unsafe():
    r = _fake_resolver({"localhost": ["127.0.0.1"]})
    assert ng.is_public_url("http://localhost/x", resolver=r) is False


def test_explicit_loopback_ip_is_unsafe():
    assert ng.is_public_url("http://127.0.0.1:8000/api", resolver=_fake_resolver({})) is False


def test_link_local_metadata_is_unsafe():
    assert ng.is_public_url("http://169.254.169.254/latest/meta-data",
                            resolver=_fake_resolver({})) is False


def test_private_rfc1918_is_unsafe():
    for ip in ("10.0.0.5", "192.168.1.5", "172.16.0.1"):
        assert ng.is_public_url("http://" + ip + "/", resolver=_fake_resolver({})) is False


def test_ipv6_loopback_is_unsafe():
    assert ng.is_public_url("http://[::1]/", resolver=_fake_resolver({})) is False


def test_non_http_scheme_is_unsafe():
    for u in ("file:///etc/passwd", "ftp://host/x", "gopher://h/", "dict://h/"):
        assert ng.is_public_url(u, resolver=_fake_resolver({"host": ["1.2.3.4"]})) is False


def test_hostname_resolving_to_private_is_unsafe():
    # DNS-rebinding style : un nom public qui pointe vers une IP interne -> bloqué
    r = _fake_resolver({"evil.example.com": ["192.168.0.10"]})
    assert ng.is_public_url("http://evil.example.com/", resolver=r) is False


def test_hostname_with_mixed_ips_blocked_if_any_private():
    r = _fake_resolver({"sneaky.com": ["1.2.3.4", "127.0.0.1"]})
    assert ng.is_public_url("http://sneaky.com/", resolver=r) is False


def test_public_url_is_safe():
    r = _fake_resolver({"example.com": ["93.184.216.34"]})
    assert ng.is_public_url("https://example.com/page", resolver=r) is True


def test_unresolvable_host_is_unsafe():
    assert ng.is_public_url("https://does-not-exist.invalid/", resolver=_fake_resolver({})) is False


def test_assert_public_url_raises_on_internal():
    with pytest.raises(ng.UnsafeUrlError):
        ng.assert_public_url("http://127.0.0.1/", resolver=_fake_resolver({}))


def test_assert_public_url_ok_on_public():
    r = _fake_resolver({"example.com": ["93.184.216.34"]})
    ng.assert_public_url("https://example.com/", resolver=r)  # ne lève pas


def test_host_allowed_suffix_match():
    assert ng.host_allowed("https://media.forgecdn.net/files/1/2/mod.jar",
                           ("forgecdn.net", "cdn.modrinth.com")) is True
    assert ng.host_allowed("https://cdn.modrinth.com/data/x.jar",
                           ("forgecdn.net", "cdn.modrinth.com")) is True


def test_host_allowed_rejects_lookalike():
    # un attaquant ne doit pas passer avec forgecdn.net.evil.com
    assert ng.host_allowed("https://forgecdn.net.evil.com/x",
                           ("forgecdn.net",)) is False
    assert ng.host_allowed("http://127.0.0.1/forgecdn.net", ("forgecdn.net",)) is False
