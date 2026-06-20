"""Tests P3c — tier 'unblocker' (API managée de débloquage, type ZenRows /
ScrapingBee / Bright Data Web Unlocker).

Le client HTTP est injecté -> 100% offline, aucune dépendance réseau ni clé.
Mêmes contrats que les autres fetchers : `.get(url) -> str`, lève PushbackError
(le serveur/provider pousse -> l'engine recule) ou FetchError (échec dur /
non configuré). 🔒 La clé d'API ne doit JAMAIS apparaître dans un message
d'erreur (un log = un secret fuité).
"""
import httpx
import pytest

from backend.bots.harvester.__main__ import _build_fetcher
from backend.bots.harvester.fetch import FetchError, PushbackError, RateLimiter
from backend.bots.harvester.fetch_unblocker import UnblockerFetcher

_UNSET = object()


class FakeResp(object):
    def __init__(self, status_code=200, text="", headers=None, json_data=_UNSET):
        self.status_code = status_code
        self.text = text
        self.headers = headers or {}
        self._json = json_data

    def json(self):
        if self._json is _UNSET:
            raise ValueError("no json")
        return self._json


class RecordingClient(object):
    """Client httpx factice : enregistre chaque appel et sert une réponse
    (ou lève) de façon déterministe. ``queue`` peut contenir des FakeResp ET
    des exceptions (jouées dans l'ordre) pour tester les retries."""

    def __init__(self, resp=None, error=None, queue=None):
        self.resp = resp
        self.error = error
        self.queue = list(queue) if queue is not None else None
        self.calls = []

    def _next(self):
        if self.queue is not None:
            item = self.queue.pop(0)
            if isinstance(item, Exception):
                raise item
            return item
        if self.error is not None:
            raise self.error
        return self.resp

    def post(self, endpoint, **kwargs):
        self.calls.append(("POST", endpoint, kwargs))
        return self._next()

    def get(self, endpoint, **kwargs):
        self.calls.append(("GET", endpoint, kwargs))
        return self._next()


class CountingRate(object):
    def __init__(self):
        self.waits = 0

    def wait(self):
        self.waits += 1


def _rate():
    return RateLimiter(0.0, clock=lambda: 0.0, sleep=lambda s: None)


def _uf(client, **kw):
    kw.setdefault("endpoint", "https://api.unblocker.test/v1")
    kw.setdefault("api_key", "TESTKEY")
    return UnblockerFetcher(_rate(), client=client, sleep=lambda s: None, **kw)


# ---- configuration manquante ---------------------------------------------

def test_not_configured_raises_clear_error(monkeypatch):
    monkeypatch.delenv("HARVESTER_UNBLOCKER_ENDPOINT", raising=False)
    monkeypatch.delenv("HARVESTER_UNBLOCKER_KEY", raising=False)
    f = UnblockerFetcher(_rate(), client=RecordingClient(resp=FakeResp(text="x")),
                         sleep=lambda s: None)
    with pytest.raises(FetchError) as ei:
        f.get("https://target.test/p")
    assert "HARVESTER_UNBLOCKER_KEY" in str(ei.value)


def test_missing_key_only_raises(monkeypatch):
    monkeypatch.delenv("HARVESTER_UNBLOCKER_KEY", raising=False)
    f = UnblockerFetcher(_rate(), endpoint="https://api.test/v1",
                         client=RecordingClient(resp=FakeResp(text="x")),
                         sleep=lambda s: None)
    with pytest.raises(FetchError):
        f.get("https://target.test/p")


# ---- nominal --------------------------------------------------------------

def test_returns_html_on_200():
    c = RecordingClient(resp=FakeResp(text="<html>real</html>"))
    assert _uf(c).get("https://target.test/p") == "<html>real</html>"


def test_posts_url_and_key_in_body_by_default():
    c = RecordingClient(resp=FakeResp(text="<html>ok</html>"))
    _uf(c).get("https://target.test/p")
    method, endpoint, kwargs = c.calls[0]
    assert method == "POST"
    assert endpoint == "https://api.unblocker.test/v1"
    assert kwargs["json"]["url"] == "https://target.test/p"
    assert kwargs["json"]["apikey"] == "TESTKEY"


def test_key_in_header():
    c = RecordingClient(resp=FakeResp(text="<html>ok</html>"))
    _uf(c, key_in="header", key_param="X-API-Key").get("https://target.test/p")
    _, _, kwargs = c.calls[0]
    assert kwargs["headers"]["X-API-Key"] == "TESTKEY"
    assert "apikey" not in kwargs["json"]          # pas dupliquée dans le body


def test_key_in_query():
    c = RecordingClient(resp=FakeResp(text="<html>ok</html>"))
    _uf(c, key_in="query").get("https://target.test/p")
    _, _, kwargs = c.calls[0]
    assert kwargs["params"]["apikey"] == "TESTKEY"
    assert "apikey" not in kwargs["json"]


def test_render_js_param_included():
    c = RecordingClient(resp=FakeResp(text="<html>ok</html>"))
    _uf(c, render_js=True).get("https://target.test/p")
    _, _, kwargs = c.calls[0]
    assert kwargs["json"]["render_js"] is True


def test_no_render_param_when_off():
    c = RecordingClient(resp=FakeResp(text="<html>ok</html>"))
    _uf(c, render_js=False).get("https://target.test/p")
    _, _, kwargs = c.calls[0]
    assert "render_js" not in kwargs["json"]


def test_extra_params_merged():
    c = RecordingClient(resp=FakeResp(text="<html>ok</html>"))
    _uf(c, params={"country": "fr", "premium": True}).get("https://target.test/p")
    _, _, kwargs = c.calls[0]
    assert kwargs["json"]["country"] == "fr"
    assert kwargs["json"]["premium"] is True


def test_result_field_extracts_html_from_json_envelope():
    c = RecordingClient(resp=FakeResp(
        text='{"html":"<html>wrapped</html>"}',
        json_data={"html": "<html>wrapped</html>", "status": 200}))
    out = _uf(c, result_field="html").get("https://target.test/p")
    assert out == "<html>wrapped</html>"


def test_result_field_falls_back_to_text_when_not_json():
    c = RecordingClient(resp=FakeResp(text="<html>plain</html>"))
    out = _uf(c, result_field="html").get("https://target.test/p")
    assert out == "<html>plain</html>"


def test_get_method_uses_query():
    c = RecordingClient(resp=FakeResp(text="<html>ok</html>"))
    _uf(c, method="GET", key_in="query").get("https://target.test/p")
    method, _, kwargs = c.calls[0]
    assert method == "GET"
    assert kwargs["params"]["url"] == "https://target.test/p"
    assert kwargs["params"]["apikey"] == "TESTKEY"


# ---- pushback / blocage ---------------------------------------------------

def test_429_raises_pushback():
    c = RecordingClient(resp=FakeResp(status_code=429, text="rate limited"))
    with pytest.raises(PushbackError) as ei:
        _uf(c).get("https://target.test/p")
    assert ei.value.status == 429


def test_503_with_retry_after_raises_pushback_with_value():
    c = RecordingClient(resp=FakeResp(status_code=503, text="busy",
                                      headers={"Retry-After": "12"}))
    with pytest.raises(PushbackError) as ei:
        _uf(c).get("https://target.test/p")
    assert ei.value.retry_after == 12.0


def test_challenge_body_raises_pushback():
    c = RecordingClient(resp=FakeResp(text='<div class="cf-turnstile">x</div>'))
    with pytest.raises(PushbackError):
        _uf(c).get("https://target.test/p")


# ---- erreurs dures + retries ----------------------------------------------

def test_http_error_retries_then_fetcherror():
    c = RecordingClient(queue=[httpx.ConnectError("boom"),
                               httpx.ConnectError("boom")])
    with pytest.raises(FetchError):
        _uf(c, retries=2).get("https://target.test/p")
    assert len(c.calls) == 2          # a bien réessayé


def test_http_error_then_success():
    c = RecordingClient(queue=[httpx.ConnectError("boom"),
                               FakeResp(text="<html>ok</html>")])
    assert _uf(c, retries=2).get("https://target.test/p") == "<html>ok</html>"


def test_4xx_retries_then_fetcherror():
    c = RecordingClient(resp=FakeResp(status_code=403, text="forbidden"))
    with pytest.raises(FetchError):
        _uf(c, retries=2).get("https://target.test/p")
    assert len(c.calls) == 2


# ---- 🔒 sécurité : la clé ne fuit jamais ----------------------------------

def test_key_never_in_error_on_http_error():
    c = RecordingClient(error=httpx.ConnectError("connect failed"))
    with pytest.raises(FetchError) as ei:
        _uf(c, api_key="SUPERSECRET", key_in="query", retries=1).get(
            "https://target.test/p")
    assert "SUPERSECRET" not in str(ei.value)


def test_key_never_in_error_on_pushback():
    c = RecordingClient(resp=FakeResp(status_code=429, text="nope"))
    with pytest.raises(PushbackError) as ei:
        _uf(c, api_key="SUPERSECRET").get("https://target.test/p")
    assert "SUPERSECRET" not in str(ei.value)


# ---- rate limiter respecté ------------------------------------------------

def test_rate_wait_called_each_attempt():
    rate = CountingRate()
    f = UnblockerFetcher(rate, endpoint="https://api.test/v1", api_key="K",
                         client=RecordingClient(resp=FakeResp(text="<html>ok</html>")),
                         sleep=lambda s: None)
    f.get("https://target.test/p")
    assert rate.waits == 1


# ---- env defaults ---------------------------------------------------------

def test_env_defaults_used(monkeypatch):
    monkeypatch.setenv("HARVESTER_UNBLOCKER_ENDPOINT", "https://env.test/v1")
    monkeypatch.setenv("HARVESTER_UNBLOCKER_KEY", "ENVKEY")
    c = RecordingClient(resp=FakeResp(text="<html>ok</html>"))
    f = UnblockerFetcher(_rate(), client=c, sleep=lambda s: None)
    f.get("https://target.test/p")
    _, endpoint, kwargs = c.calls[0]
    assert endpoint == "https://env.test/v1"
    assert kwargs["json"]["apikey"] == "ENVKEY"


def test_plan_overrides_env(monkeypatch):
    monkeypatch.setenv("HARVESTER_UNBLOCKER_ENDPOINT", "https://env.test/v1")
    monkeypatch.setenv("HARVESTER_UNBLOCKER_KEY", "ENVKEY")
    c = RecordingClient(resp=FakeResp(text="<html>ok</html>"))
    f = UnblockerFetcher(_rate(), endpoint="https://plan.test/v2",
                         api_key="PLANKEY", client=c, sleep=lambda s: None)
    f.get("https://target.test/p")
    _, endpoint, kwargs = c.calls[0]
    assert endpoint == "https://plan.test/v2"
    assert kwargs["json"]["apikey"] == "PLANKEY"


# ---- _build_fetcher branche 'unblocker' -----------------------------------

def test_build_fetcher_unblocker_returns_unblocker():
    plan = {"fetch_tier": "unblocker",
            "unblocker_endpoint": "https://api.test/v1",
            "unblocker_key": "K", "render_js": True,
            "unblocker_key_in": "header", "unblocker_key_param": "Authorization",
            "unblocker_params": {"country": "us"},
            "unblocker_retries": 4, "unblocker_timeout": 120}
    f = _build_fetcher("unblocker", _rate(), "https://t.test/p", plan, "/tmp/run")
    assert isinstance(f, UnblockerFetcher)
    assert f._endpoint == "https://api.test/v1"
    assert f.render_js is True
    assert f.key_in == "header"
    assert f.key_param == "Authorization"
    assert f.params == {"country": "us"}
    assert f.retries == 4


def test_build_fetcher_unblocker_without_config_builds_but_get_raises(monkeypatch):
    monkeypatch.delenv("HARVESTER_UNBLOCKER_ENDPOINT", raising=False)
    monkeypatch.delenv("HARVESTER_UNBLOCKER_KEY", raising=False)
    # build NE doit PAS crasher (cohérent avec stealth : l'absence de dépendance
    # n'est surfacée qu'à l'exécution) — on injecte un client pour rester offline.
    f = _build_fetcher("unblocker", _rate(), "https://t.test/p",
                       {"fetch_tier": "unblocker"}, None)
    assert isinstance(f, UnblockerFetcher)
    f._client = RecordingClient(resp=FakeResp(text="x"))
    with pytest.raises(FetchError):
        f.get("https://t.test/p")


def test_build_fetcher_unblocker_bad_numeric_falls_back():
    f = _build_fetcher("unblocker", _rate(), "https://t.test/p",
                       {"fetch_tier": "unblocker", "unblocker_endpoint": "https://a/v1",
                        "unblocker_key": "K", "unblocker_retries": "abc",
                        "unblocker_timeout": "x"}, None)
    assert f.retries == 2
    assert f.timeout == 90.0


# ---- revue #4 : aucune exception ne fuit la clé (pas que httpx.HTTPError) --

def test_key_never_in_error_on_non_http_error():
    # une exception NON-httpx.HTTPError (ex. httpx.InvalidURL, ou un ValueError)
    # ne doit ni se propager telle quelle ni fuiter la clé : get() est la
    # frontière qui réduit TOUTE exception de requête à son nom de classe.
    c = RecordingClient(error=ValueError("bad request with SUPERSECRET in it"))
    with pytest.raises(FetchError) as ei:
        _uf(c, api_key="SUPERSECRET", key_in="query", retries=1).get(
            "https://target.test/p")
    assert "SUPERSECRET" not in str(ei.value)


def test_invalid_url_exception_is_caught_as_fetcherror():
    c = RecordingClient(error=httpx.InvalidURL("nope"))
    with pytest.raises(FetchError):
        _uf(c, retries=1).get("https://target.test/p")


# ---- revue #10 : timeout clampé même en construction directe ---------------

def test_negative_timeout_clamped_in_init():
    f = UnblockerFetcher(_rate(), endpoint="https://a/v1", api_key="K", timeout=-5)
    assert f.timeout == 90.0


def test_bad_timeout_type_clamped_in_init():
    f = UnblockerFetcher(_rate(), endpoint="https://a/v1", api_key="K", timeout="abc")
    assert f.timeout == 90.0


# ---- revue #1 : enveloppe JSON qui signale un blocage cible (HTTP 200) -----

def test_envelope_reports_target_4xx_raises_fetcherror():
    # provider renvoie HTTP 200 mais l'enveloppe dit que la CIBLE a renvoyé 403
    c = RecordingClient(resp=FakeResp(text="{}",
                                      json_data={"status_code": 403, "html": ""}))
    with pytest.raises(FetchError):
        _uf(c, result_field="html").get("https://target.test/p")


def test_envelope_reports_target_429_raises_pushback():
    c = RecordingClient(resp=FakeResp(text="{}",
                                      json_data={"status_code": 429, "html": ""}))
    with pytest.raises(PushbackError):
        _uf(c, result_field="html").get("https://target.test/p")


def test_envelope_error_field_raises_fetcherror():
    c = RecordingClient(resp=FakeResp(text="{}",
                                      json_data={"error": "target blocked"}))
    with pytest.raises(FetchError):
        _uf(c, result_field="html").get("https://target.test/p")


def test_envelope_empty_result_field_raises_fetcherror():
    # result_field configuré mais vide -> ne PAS rendre "" comme un faux succès
    c = RecordingClient(resp=FakeResp(text="{}", json_data={"html": ""}))
    with pytest.raises(FetchError):
        _uf(c, result_field="html").get("https://target.test/p")


def test_envelope_success_returns_html():
    c = RecordingClient(resp=FakeResp(
        text="{}", json_data={"status_code": 200, "html": "<html>ok</html>"}))
    assert _uf(c, result_field="html").get("https://target.test/p") == "<html>ok</html>"


def test_envelope_error_message_never_leaks_key():
    c = RecordingClient(resp=FakeResp(text="{}", json_data={"error": "blocked"}))
    with pytest.raises(FetchError) as ei:
        _uf(c, api_key="SUPERSECRET", result_field="html").get("https://target.test/p")
    assert "SUPERSECRET" not in str(ei.value)
