"""
Test console WebSocket — RCON gating (issue #3).

La console permet d'envoyer des commandes admin de jeu (op/ban/stop via rcon-cli).
Avant le fix, le SEUL gate était min_level="view_only" → un user en lecture seule
pouvait envoyer des commandes. Après : connexion OK en view_only (logs), mais
l'envoi de commande exige min_level="manage".

On monte une mini-app avec le router WS et on patche SessionLocal/get_user_from_token
pour pointer vers une DB SQLite in-memory isolée + un faux conteneur Docker.
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.database import Base
import backend.auth.models  # noqa: F401
import backend.auth.shared_access  # noqa: F401
import backend.game_server.models  # noqa: F401
import backend.bots.models  # noqa: F401
from backend.auth.models import User
from backend.auth.shared_access import SharedAccess
from backend.game_server.models import GameServer


class _FakeExecResult:
    def __init__(self, out=b""):
        self.output = out


class _FakeContainer:
    def __init__(self):
        self.status = "running"

    def logs(self, *a, **k):
        if k.get("stream"):
            return iter([])
        return b""

    def reload(self):
        pass

    def exec_run(self, *a, **k):
        return _FakeExecResult(b"executed")


class _FakeDockerClient:
    class containers:
        @staticmethod
        def get(_id):
            return _FakeContainer()


def _build_ws_app(monkeypatch, viewer_role_level):
    """viewer_role_level ∈ {'view_only','manage'} → niveau du shared access du user id=2."""
    from backend.game_server import websocket as ws_mod

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    SF = sessionmaker(bind=engine)

    db = SF()
    owner = User(id=1, username="owner", hashed_password="x", is_admin=False, role="player")
    viewer = User(id=2, username="viewer", hashed_password="x", is_admin=False, role="player")
    db.add_all([owner, viewer])
    db.add(GameServer(id=1, name="S", game_type="minecraft", docker_id="abc", port=25565, owner_id=1, status="running"))
    db.add(SharedAccess(resource_type="server", resource_id=1, user_id=2,
                        access_level=viewer_role_level, granted_by=1))
    db.commit()
    db.close()

    # Patch SessionLocal partout dans le module websocket
    monkeypatch.setattr(ws_mod, "SessionLocal", SF)
    # get_user_from_token retourne le viewer (id=2)
    monkeypatch.setattr(ws_mod, "get_user_from_token", lambda t: SF().query(User).filter(User.id == 2).first())
    # Docker → faux client
    import docker
    monkeypatch.setattr(docker, "from_env", lambda: _FakeDockerClient())

    app = FastAPI()
    app.include_router(ws_mod.router)
    return TestClient(app)


def test_view_only_user_cannot_send_rcon_command(monkeypatch):
    client = _build_ws_app(monkeypatch, "view_only")
    with client.websocket_connect("/ws/servers/1/console?token=valid") as ws:
        ws.send_json({"type": "command", "data": "op Hacker"})
        # On doit recevoir un message d'erreur "lecture seule" (pas l'exécution).
        got_refusal = False
        for _ in range(10):
            msg = ws.receive_json()
            if msg.get("type") == "error" and "lecture seule" in msg.get("message", "").lower():
                got_refusal = True
                break
            if msg.get("type") == "info" and "executed" in str(msg.get("data", "")).lower():
                pytest.fail("view_only a réussi à exécuter une commande RCON !")
        assert got_refusal, "view_only aurait dû être refusé l'envoi de commande"


def test_manage_user_can_send_rcon_command(monkeypatch):
    client = _build_ws_app(monkeypatch, "manage")
    with client.websocket_connect("/ws/servers/1/console?token=valid") as ws:
        ws.send_json({"type": "command", "data": "say hi"})
        executed = False
        for _ in range(10):
            msg = ws.receive_json()
            if msg.get("type") == "error" and "lecture seule" in msg.get("message", "").lower():
                pytest.fail("manage a été refusé à tort")
            if msg.get("type") == "info":
                executed = True
                break
        assert executed, "manage aurait dû pouvoir envoyer une commande"
