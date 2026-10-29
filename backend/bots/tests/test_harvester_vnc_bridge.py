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


# --- D2 : bridge WebSocket (rejet au niveau WS) ----------------------------

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect


def _ws_client(monkeypatch, tmp_path, admin_token=None):
    monkeypatch.setattr(hr, "HARVESTER_RUNS_DIR", tmp_path)
    app = FastAPI()
    app.include_router(hr.router)
    return TestClient(app)


def test_ws_bridge_rejects_unauthorized(monkeypatch, tmp_path):
    monkeypatch.setattr(hr, "_ws_admin_from_token", lambda t: None)
    c = _ws_client(monkeypatch, tmp_path)
    with pytest.raises(WebSocketDisconnect) as ei:
        with c.websocket_connect(
            "/api/bots/harvester/vnc/{0}?token=bad".format(_JOB)) as ws:
            ws.receive_bytes()
    assert ei.value.code == 1008


def test_ws_bridge_rejects_bad_token_in_first_message(monkeypatch, tmp_path):
    monkeypatch.setattr(hr, "_ws_admin_from_token", lambda t: None)
    c = _ws_client(monkeypatch, tmp_path)
    with c.websocket_connect("/api/bots/harvester/vnc/{0}".format(_JOB)) as ws:
        ws.send_text('{"type": "auth", "token": "bad"}')
        with pytest.raises(WebSocketDisconnect) as ei:
            ws.receive_bytes()
    assert ei.value.code == 1008


def test_ws_bridge_first_message_auth_then_closes_on_socket_unavailable(monkeypatch, tmp_path):
    # DISCRIMINANT (auth par premier message) : l'auth passe, PUIS 1011 (x11vnc
    # indispo) — distinct du 1008 d'un refus d'auth.
    seen = []

    def _authorize(token, job_id):
        seen.append(token)
        return (token == "good", "ok")
    monkeypatch.setattr(hr, "_vnc_authorize", _authorize)

    async def _boom(path):
        raise OSError("no x11vnc socket")
    monkeypatch.setattr(hr.asyncio, "open_unix_connection", _boom)

    c = _ws_client(monkeypatch, tmp_path)
    with c.websocket_connect("/api/bots/harvester/vnc/{0}".format(_JOB)) as ws:
        ws.send_text('{"type": "auth", "token": "good"}')
        with pytest.raises(WebSocketDisconnect) as ei:
            ws.receive_bytes()
    assert ei.value.code == 1011
    assert seen == ["good"]


def test_ws_bridge_accepts_authorized_then_closes_on_socket_unavailable(monkeypatch, tmp_path):
    # DISCRIMINANT (compat ?token= déprécié) : avec un job autorisé (admin +
    # awaiting) mais x11vnc indispo, le bridge passe l'auth PUIS ferme 1011 —
    # distinct du rejet d'auth (1008) du cas non autorisé. Prouve que la route
    # existe ET que la porte d'autorisation laisse bien passer le cas légitime.
    monkeypatch.setattr(hr, "_vnc_authorize", lambda token, job_id: (True, "ok"))

    async def _boom(path):
        raise OSError("no x11vnc socket")
    monkeypatch.setattr(hr.asyncio, "open_unix_connection", _boom)

    c = _ws_client(monkeypatch, tmp_path)
    accepted = False
    with c.websocket_connect(
            "/api/bots/harvester/vnc/{0}?token=good".format(_JOB)) as ws:
        accepted = True                 # __enter__ réussi => accept() a eu lieu
        with pytest.raises(WebSocketDisconnect) as ei:
            ws.receive_bytes()
    assert accepted
    assert ei.value.code == 1011        # fermeture serveur (socket indispo)
