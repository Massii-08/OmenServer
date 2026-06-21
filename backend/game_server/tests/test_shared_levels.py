"""
Tests de granularité des niveaux d'accès partagé (shared_access).

On vérifie que le gate ne se contente pas d'un "tout ou rien" :
  - un user partagé en `view_only` PEUT lire (GET) mais PAS écrire (PUT/POST/DELETE)
  - un user partagé en `start` ne peut PAS faire d'action `manage`
  - un user partagé en `manage` PASSE le gate manage
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.database import Base, get_db
import backend.auth.models  # noqa: F401
import backend.auth.shared_access  # noqa: F401
import backend.game_server.models  # noqa: F401
import backend.bots.models  # noqa: F401
from backend.auth.models import User
from backend.auth.shared_access import SharedAccess
from backend.game_server.models import GameServer
from backend.auth.utils import get_current_user


def _client_with_shared(level):
    """User id=2 reçoit un shared access de niveau `level` sur le serveur 1 (owner=1)."""
    from backend.game_server import players_router

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    SF = sessionmaker(bind=engine)

    db = SF()
    db.add(User(id=1, username="owner", hashed_password="x", is_admin=False, role="player"))
    db.add(User(id=2, username="shared", hashed_password="x", is_admin=False, role="player"))
    db.add(GameServer(id=1, name="S", game_type="minecraft", docker_id="abc", port=25565, owner_id=1, status="stopped"))
    db.add(SharedAccess(resource_type="server", resource_id=1, user_id=2,
                        access_level=level, granted_by=1))
    db.commit()
    db.close()

    app = FastAPI()
    app.include_router(players_router.router)

    def override_db():
        d = SF()
        try:
            yield d
        finally:
            d.close()

    def override_user():
        d = SF()
        try:
            u = d.query(User).filter(User.id == 2).first()
            d.expunge(u)
            return u
        finally:
            d.close()

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_user
    return TestClient(app, raise_server_exceptions=False)


def test_view_only_can_read():
    client = _client_with_shared("view_only")
    resp = client.get("/api/servers/1/players/ops")
    assert resp.status_code != 403, f"view_only should read, got {resp.status_code}"


def test_view_only_cannot_write():
    client = _client_with_shared("view_only")
    resp = client.post("/api/servers/1/players/ops", json={"name": "Bob"})
    assert resp.status_code == 403, f"view_only should NOT write (manage), got {resp.status_code}"


def test_start_level_cannot_manage():
    client = _client_with_shared("start")
    resp = client.post("/api/servers/1/players/ops", json={"name": "Bob"})
    assert resp.status_code == 403, f"start should NOT manage, got {resp.status_code}"


def test_start_level_can_read():
    client = _client_with_shared("start")
    resp = client.get("/api/servers/1/players/ops")
    assert resp.status_code != 403


def test_manage_level_passes_gate():
    client = _client_with_shared("manage")
    resp = client.post("/api/servers/1/players/ops", json={"name": "Bob"})
    assert resp.status_code != 403, f"manage should pass gate, got {resp.status_code}"
