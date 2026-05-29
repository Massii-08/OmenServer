import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.bots import mc_agent_router as r
from backend.bots import mc_agent_manager as mgr
from backend.auth.utils import get_current_user


class FakeUser:
    def __init__(self, is_admin):
        self.is_admin = is_admin
        self.role = "admin" if is_admin else "player"


def make_client(is_admin=True):
    app = FastAPI()
    app.include_router(r.router)
    app.dependency_overrides[get_current_user] = lambda: FakeUser(is_admin)
    return TestClient(app)


def test_run_refuse_les_non_admins():
    c = make_client(is_admin=False)
    resp = c.post("/api/mc-agent/run", json={"host": "h"})
    assert resp.status_code == 403


def test_run_400_si_pas_de_cle(monkeypatch):
    monkeypatch.setattr(mgr, "has_api_key", lambda: False)
    c = make_client()
    resp = c.post("/api/mc-agent/run", json={"host": "h"})
    assert resp.status_code == 400


def test_run_demarre_une_session(monkeypatch):
    monkeypatch.setattr(mgr, "has_api_key", lambda: True)
    monkeypatch.setattr(mgr, "start_session", lambda host, port, user, model=None: 7)
    c = make_client()
    resp = c.post("/api/mc-agent/run", json={"host": "play.x.net", "user": "TrainBot"})
    assert resp.status_code == 200
    assert resp.json()["session_id"] == 7


def test_status_404_si_inconnu(monkeypatch):
    monkeypatch.setattr(mgr, "get_status", lambda sid: None)
    c = make_client()
    assert c.get("/api/mc-agent/status/999").status_code == 404


def test_stop_ok(monkeypatch):
    monkeypatch.setattr(mgr, "stop_session", lambda sid: True)
    c = make_client()
    resp = c.post("/api/mc-agent/stop/3")
    assert resp.status_code == 200 and resp.json()["ok"] is True
