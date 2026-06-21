"""Tests de l'autorisation du bridge VNC (offline, sans WS ni x11vnc).
La décision d'auth est une fonction PURE (_vnc_authorize) -> testable directement."""
from backend.bots import harvester_router as hr


class FakeUser(object):
    def __init__(self, is_admin):
        self.is_admin = is_admin
        self.username = "tester"


_JOB = "0" * 32


def _admin_ok(token):
    return FakeUser(True) if token == "good" else None


def test_authorize_rejects_no_token(monkeypatch):
    monkeypatch.setattr(hr, "_job_awaiting", lambda job: {"url": "x"})
    ok, reason = hr._vnc_authorize("", _JOB, admin_fn=_admin_ok)
    assert ok is False and reason == "auth"


def test_authorize_rejects_non_admin(monkeypatch):
    monkeypatch.setattr(hr, "_job_awaiting", lambda job: {"url": "x"})
    ok, reason = hr._vnc_authorize("bad", _JOB, admin_fn=_admin_ok)
    assert ok is False and reason == "auth"


def test_authorize_rejects_bad_job_id(monkeypatch):
    monkeypatch.setattr(hr, "_job_awaiting", lambda job: {"url": "x"})
    ok, reason = hr._vnc_authorize("good", "../etc", admin_fn=_admin_ok)
    assert ok is False and reason == "job_id"


def test_authorize_rejects_when_not_awaiting(monkeypatch):
    monkeypatch.setattr(hr, "_job_awaiting", lambda job: None)
    monkeypatch.setitem(hr._harvester_jobs, _JOB, {"job_id": _JOB, "process": None})
    ok, reason = hr._vnc_authorize("good", _JOB, admin_fn=_admin_ok)
    assert ok is False and reason == "not_awaiting"


def test_authorize_ok_when_admin_and_awaiting(monkeypatch):
    monkeypatch.setattr(hr, "_job_awaiting", lambda job: {"url": "x"})
    monkeypatch.setitem(hr._harvester_jobs, _JOB, {"job_id": _JOB, "process": None})
    ok, reason = hr._vnc_authorize("good", _JOB, admin_fn=_admin_ok)
    assert ok is True and reason == "ok"
