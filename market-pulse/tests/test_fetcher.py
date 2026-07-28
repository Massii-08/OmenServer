"""Client Yahoo — session, horloge et sleep injectés : aucun réseau."""
import pytest

from pulse.fetcher import FetchError, YahooChartClient


class FakeResponse:
    def __init__(self, status_code, payload=None):
        self.status_code = status_code
        self._payload = payload or {}

    def json(self):
        return self._payload


class FakeSession:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def get(self, url, params=None, timeout=None):
        self.calls.append((url, params))
        return self.responses.pop(0)


def _client(session, clock=None):
    sleeps = []
    t = {"now": 0.0}

    def sleep(s):
        sleeps.append(s)
        t["now"] += s

    def monotonic():
        return t["now"]

    c = YahooChartClient(session=session, sleep=sleep, monotonic=monotonic)
    return c, sleeps


def test_success_first_try():
    sess = FakeSession([FakeResponse(200, {"chart": {"result": [{}]}})])
    client, _ = _client(sess)
    assert client.get_chart("^GSPC") == {"chart": {"result": [{}]}}
    assert sess.calls[0][0].endswith("/chart/^GSPC")
    assert sess.calls[0][1]["range"] == "10d"


def test_retries_on_429_then_succeeds():
    sess = FakeSession([FakeResponse(429), FakeResponse(200, {"ok": True})])
    client, sleeps = _client(sess)
    assert client.get_chart("^GSPC") == {"ok": True}
    assert len(sess.calls) == 2
    assert any(s >= 2.0 for s in sleeps)  # backoff appliqué


def test_gives_up_after_max_retries():
    sess = FakeSession([FakeResponse(429)] * 3)
    client, _ = _client(sess)
    with pytest.raises(FetchError):
        client.get_chart("^GSPC")
    assert len(sess.calls) == 3


def test_definitive_4xx_does_not_retry():
    sess = FakeSession([FakeResponse(404)])
    client, _ = _client(sess)
    with pytest.raises(FetchError):
        client.get_chart("BIDON")
    assert len(sess.calls) == 1


def test_paces_between_calls():
    sess = FakeSession([FakeResponse(200, {}), FakeResponse(200, {})])
    client, sleeps = _client(sess)
    client.get_chart("A")
    client.get_chart("B")
    # Le 2e appel arrive « immédiatement » (horloge factice) → pacing ~1.1 s
    assert any(0 < s <= 1.1 for s in sleeps)


def test_network_exception_is_retried():
    class Boom:
        def __init__(self):
            self.calls = 0

        def get(self, url, params=None, timeout=None):
            self.calls += 1
            if self.calls == 1:
                raise OSError("reset by peer")
            return FakeResponse(200, {"ok": 1})

    sess = Boom()
    client, _ = _client(sess)
    assert client.get_chart("^GSPC") == {"ok": 1}
    assert sess.calls == 2
