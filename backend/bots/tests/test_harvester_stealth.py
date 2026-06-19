"""Tests du SQUELETTE stealth (P3b) : on vérifie l'échafaudage pluggable
(la coquille respecte le contrat + la sélection de tier dispatche), PAS la
logique d'évasion (qui n'est volontairement pas fournie → NotImplementedError)."""
import pytest

from backend.bots.harvester.fetch import FetchError, HttpxFetcher, RateLimiter
from backend.bots.harvester.fetch_stealth import StealthFetcher


def _rate():
    return RateLimiter(0.0, clock=lambda: 0.0, sleep=lambda s: None)


def test_stealth_constructs_without_touching_patchright():
    # construire la coquille ne doit RIEN tenter (pas d'import patchright au ctor)
    f = StealthFetcher(_rate(), warm_url="https://x.test/")
    assert f.warm_url == "https://x.test/"
    assert f.rate is not None


def test_stealth_get_is_not_implemented():
    f = StealthFetcher(_rate())
    with pytest.raises(NotImplementedError):
        f.get("https://x.test/")


def test_stealth_ensure_browser_never_silently_succeeds():
    # patchright absent (CI/Mac) -> FetchError clair ; présent -> NotImplementedError.
    # Dans les deux cas : ne réussit JAMAIS en silence (la coquille est un stub).
    f = StealthFetcher(_rate())
    with pytest.raises((FetchError, NotImplementedError)):
        f._ensure_browser()


def test_build_fetcher_defaults_to_httpx():
    from backend.bots.harvester.__main__ import _build_fetcher
    f = _build_fetcher("httpx", _rate(), "https://x.test/")
    assert isinstance(f, HttpxFetcher)


def test_build_fetcher_selects_stealth_tier():
    from backend.bots.harvester.__main__ import _build_fetcher
    f = _build_fetcher("stealth", _rate(), "https://x.test/")
    assert isinstance(f, StealthFetcher)
    assert f.warm_url == "https://x.test/"


def test_build_fetcher_unknown_tier_falls_back_to_httpx():
    from backend.bots.harvester.__main__ import _build_fetcher
    f = _build_fetcher("banana", _rate(), "https://x.test/")
    assert isinstance(f, HttpxFetcher)
