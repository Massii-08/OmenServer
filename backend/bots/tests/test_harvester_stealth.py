"""Tests d'INTÉGRATION du tier stealth (P3b) : on vérifie que le tier se branche
(construction sans toucher patchright + sélection de tier qui dispatche).

La logique d'évasion (warm / attente du challenge / retries) vit dans
StealthFetcher et est testable offline par injection d'un faux BrowserSession —
mais ces tests-là sont l'affaire de l'opérateur (porter `test_stealth.py` de
Feedsmith). Ici on ne teste QUE le câblage dans le harvester."""
from backend.bots.harvester.fetch import HttpxFetcher, RateLimiter
from backend.bots.harvester.fetch_stealth import StealthFetcher


def _rate():
    return RateLimiter(0.0, clock=lambda: 0.0, sleep=lambda s: None)


def test_stealth_constructs_without_touching_patchright():
    # construire la classe ne doit RIEN importer de patchright (lazy au 1er get)
    f = StealthFetcher(_rate(), warm_url="https://x.test/")
    assert f.warm_url == "https://x.test/"
    assert f.rate is not None
    assert callable(f.get)


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
