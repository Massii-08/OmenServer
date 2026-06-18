import httpx
import pytest

from backend.bots.harvester.fetch import FetchError, HttpxFetcher, RateLimiter


def _silent_rate():
    return RateLimiter(0.0, clock=lambda: 0.0, sleep=lambda s: None)


def test_rate_limiter_sleeps_remaining_interval():
    t = {"now": 0.0}
    slept = []
    rate = RateLimiter(5.0, clock=lambda: t["now"], sleep=lambda s: slept.append(s))
    rate.wait()              # first call: no wait
    t["now"] = 2.0
    rate.wait()              # only 2s elapsed of 5 -> sleep 3
    assert slept == [3.0]


def test_httpx_fetcher_success_returns_body():
    def handler(request):
        return httpx.Response(200, text="<html>ok</html>")
    client = httpx.Client(transport=httpx.MockTransport(handler))
    f = HttpxFetcher(rate=_silent_rate(), retries=3, client=client)
    assert f.get("https://books.toscrape.com/") == "<html>ok</html>"


def test_httpx_fetcher_retries_then_raises_on_persistent_error():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(503, text="busy")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    f = HttpxFetcher(rate=_silent_rate(), retries=3, client=client,
                     sleep=lambda s: None)
    with pytest.raises(FetchError):
        f.get("https://books.toscrape.com/")
    assert calls["n"] == 3  # retried up to `retries` times


def test_httpx_fetcher_recovers_on_second_try():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(500, text="err")
        return httpx.Response(200, text="<html>good</html>")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    f = HttpxFetcher(rate=_silent_rate(), retries=3, client=client,
                     sleep=lambda s: None)
    assert f.get("https://x.test/") == "<html>good</html>"
    assert calls["n"] == 2
