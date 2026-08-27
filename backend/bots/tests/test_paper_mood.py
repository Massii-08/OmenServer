"""Tests de la jauge d'humeur du marché (VIX, Lot D3) — 100% hors ligne, cache
en mémoire vidé avant CHAQUE test."""
import pytest

from backend.bots.paper import mood


@pytest.fixture(autouse=True)
def _clear_cache():
    mood.clear_cache()
    yield
    mood.clear_cache()


# --------------------------------------------------------------------------- #
# PUR -- classify / build
# --------------------------------------------------------------------------- #

def test_classify_calme_below_15():
    assert mood.classify(10.0) == "calme"
    assert mood.classify(14.99) == "calme"


def test_classify_normal_between_15_and_20():
    assert mood.classify(15.0) == "normal"
    assert mood.classify(19.99) == "normal"


def test_classify_nerveux_between_20_and_30():
    assert mood.classify(20.0) == "nerveux"
    assert mood.classify(29.99) == "nerveux"


def test_classify_panique_at_or_above_30():
    assert mood.classify(30.0) == "panique"
    assert mood.classify(50.0) == "panique"


def test_classify_none_when_vix_unknown():
    assert mood.classify(None) is None
    assert mood.classify("not-a-number") is None


def test_build_full_shape_when_vix_known():
    assert mood.build(17.2, -1.5) == {"vix": 17.2, "change_pct": -1.5, "mood": "normal"}


def test_build_empty_when_vix_unknown():
    assert mood.build(None, -1.5) == {}


# --------------------------------------------------------------------------- #
# I/O -- get() : injecté, caché, best-effort
# --------------------------------------------------------------------------- #

def test_get_returns_reading_from_injected_quote_fn():
    calls = []

    def _quote(symbol):
        calls.append(symbol)
        return {"price": 17.2, "change_pct": -1.5}

    result = mood.get(quote_fn=_quote)
    assert result == {"vix": 17.2, "change_pct": -1.5, "mood": "normal"}
    assert calls == ["^VIX"]


def test_get_caches_across_calls_within_ttl():
    calls = []

    def _quote(symbol):
        calls.append(symbol)
        return {"price": 10.0, "change_pct": 0.1}

    clock = {"t": 0.0}
    mood._now = lambda: clock["t"]
    try:
        mood.get(quote_fn=_quote)
        clock["t"] = 5.0     # bien avant le TTL (600s)
        mood.get(quote_fn=_quote)
        assert calls == ["^VIX"]     # UN seul appel malgré 2 lectures
    finally:
        import time
        mood._now = time.monotonic


def test_get_refetches_after_ttl_expires():
    calls = []

    def _quote(symbol):
        calls.append(symbol)
        return {"price": 10.0 + len(calls), "change_pct": 0.1}

    clock = {"t": 0.0}
    mood._now = lambda: clock["t"]
    try:
        mood.get(quote_fn=_quote, ttl_s=10.0)
        clock["t"] = 11.0
        mood.get(quote_fn=_quote, ttl_s=10.0)
        assert calls == ["^VIX", "^VIX"]
    finally:
        import time
        mood._now = time.monotonic


def test_get_returns_empty_dict_when_quote_fn_raises():
    def _boom(symbol):
        raise RuntimeError("Yahoo en panne")

    assert mood.get(quote_fn=_boom) == {}


def test_get_returns_empty_dict_when_price_missing():
    assert mood.get(quote_fn=lambda s: {"price": None}) == {}


def test_get_never_raises_when_quote_fn_is_none_and_engine_missing(monkeypatch):
    """Le repli par défaut importe ``quotes`` paresseusement -- si le moteur
    est absent ou en panne, ``get()`` doit rendre {} sans jamais lever."""
    from backend.bots.paper import quotes as quotes_mod

    def _boom(symbol):
        raise RuntimeError("moteur cassé")

    monkeypatch.setattr(quotes_mod, "get_quote", _boom)
    assert mood.get() == {}


def test_default_quote_fn_calls_the_real_quotes_module(monkeypatch):
    from backend.bots.paper import quotes as quotes_mod
    calls = []
    monkeypatch.setattr(quotes_mod, "get_quote",
                        lambda symbol: calls.append(symbol) or
                        {"price": 22.0, "change_pct": 3.0})
    assert mood.get() == {"vix": 22.0, "change_pct": 3.0, "mood": "nerveux"}
    assert calls == ["^VIX"]
