import httpx
import pytest

from backend.bots.harvester.fetch import FetchError, HttpxFetcher, RateLimiter


def _silent_rate():
    return RateLimiter(0.0, clock=lambda: 0.0, sleep=lambda s: None)


# Garde anti-SSRF no-op : les tests offline (MockTransport, hôtes .test qui ne
# résolvent pas) ne doivent pas toucher au DNS. La logique du guard est testée
# séparément dans test_harvester_ssrf.py.
def _no_guard(url):
    return None


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
    f = HttpxFetcher(rate=_silent_rate(), retries=3, client=client, url_guard=_no_guard)
    assert f.get("https://books.toscrape.com/") == "<html>ok</html>"


def test_httpx_fetcher_retries_then_raises_on_persistent_error():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(503, text="busy")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    f = HttpxFetcher(rate=_silent_rate(), retries=3, client=client,
                     sleep=lambda s: None, url_guard=_no_guard)
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
                     sleep=lambda s: None, url_guard=_no_guard)
    assert f.get("https://x.test/") == "<html>good</html>"
    assert calls["n"] == 2


from backend.bots.harvester.fetch import PushbackError, is_challenge


def test_is_challenge_detects_cloudflare_interstitial():
    assert is_challenge("<html><title>Just a moment...</title></html>") is True
    assert is_challenge("<h1>Checking your browser before accessing</h1>") is True
    assert is_challenge("<html>ok normal page</html>") is False


def test_fetcher_raises_pushback_on_429_with_retry_after():
    def handler(request):
        return httpx.Response(429, text="slow down", headers={"Retry-After": "42"})
    client = httpx.Client(transport=httpx.MockTransport(handler))
    f = HttpxFetcher(rate=_silent_rate(), retries=3, client=client, sleep=lambda s: None, url_guard=_no_guard)
    try:
        f.get("https://x.test/")
        assert False, "should have raised"
    except PushbackError as e:
        assert e.status == 429
        assert e.retry_after == 42.0


def test_fetcher_does_not_internally_retry_a_429():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(429, text="nope")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    f = HttpxFetcher(rate=_silent_rate(), retries=3, client=client, sleep=lambda s: None, url_guard=_no_guard)
    try:
        f.get("https://x.test/")
    except PushbackError:
        pass
    assert calls["n"] == 1  # surfaced to the engine immediately, not hammered


def test_fetcher_raises_pushback_on_challenge_body_even_with_200():
    def handler(request):
        return httpx.Response(200, text="<title>Just a moment...</title>")
    client = httpx.Client(transport=httpx.MockTransport(handler))
    f = HttpxFetcher(rate=_silent_rate(), retries=3, client=client, sleep=lambda s: None, url_guard=_no_guard)
    try:
        f.get("https://x.test/")
        assert False, "should have raised"
    except PushbackError as e:
        assert e.status == 200


def test_pushback_is_a_fetcherror_subclass():
    assert issubclass(PushbackError, FetchError)
