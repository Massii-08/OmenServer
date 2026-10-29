"""Tests de l'auth WebSocket par PREMIER MESSAGE (backend/auth/ws_auth.py) et
de son branchement sur les WS consommés par le frontend du site.

Piège TestClient : ``websocket_connect`` lève ``WebSocketDisconnect`` pour
n'importe quel chemin, même inexistant. Chaque cas ACCEPTÉ doit donc recevoir
un vrai message applicatif, et chaque refus vérifie le CODE de fermeture.
"""
import json

import pytest
from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from starlette.websockets import WebSocketDisconnect

from backend.auth import ws_auth


# --------------------------------------------------------------------------- #
# Helper isolé
# --------------------------------------------------------------------------- #

def _app(monkeypatch):
    monkeypatch.setattr(ws_auth, "WS_AUTH_TIMEOUT_S", 0.3)
    app = FastAPI()

    @app.websocket("/t")
    async def endpoint(websocket: WebSocket):
        who = await ws_auth.ws_authenticate(
            websocket, lambda t: {"user": "alice"} if t == "good" else None,
            label="test")
        if who is None:
            return
        await websocket.send_json({"type": "hello", "user": who["user"]})
        await websocket.close()

    return TestClient(app)


def test_auth_par_premier_message_ok(monkeypatch):
    c = _app(monkeypatch)
    with c.websocket_connect("/t") as ws:
        ws.send_text(json.dumps({"type": "auth", "token": "good"}))
        assert ws.receive_json() == {"type": "hello", "user": "alice"}


def test_mauvais_token_ferme_1008(monkeypatch):
    c = _app(monkeypatch)
    with c.websocket_connect("/t") as ws:
        ws.send_text(json.dumps({"type": "auth", "token": "bad"}))
        with pytest.raises(WebSocketDisconnect) as ei:
            ws.receive_json()
    assert ei.value.code == 1008


def test_pas_de_message_ferme_1008_au_timeout(monkeypatch):
    c = _app(monkeypatch)
    with c.websocket_connect("/t") as ws:
        with pytest.raises(WebSocketDisconnect) as ei:
            ws.receive_json()
    assert ei.value.code == 1008


def test_message_illisible_ou_mauvais_type_ferme_1008(monkeypatch):
    c = _app(monkeypatch)
    for payload in ("pas du json", json.dumps({"type": "command", "token": "good"}),
                    json.dumps(["good"])):
        with c.websocket_connect("/t") as ws:
            ws.send_text(payload)
            with pytest.raises(WebSocketDisconnect) as ei:
                ws.receive_json()
        assert ei.value.code == 1008


def test_token_en_query_toujours_accepte(monkeypatch, caplog):
    c = _app(monkeypatch)
    with caplog.at_level("WARNING", logger="omenserver"):
        with c.websocket_connect("/t?token=good") as ws:
            assert ws.receive_json() == {"type": "hello", "user": "alice"}
    assert any("déprécié" in r.getMessage() for r in caplog.records)
    # le jeton ne doit jamais apparaître dans les journaux
    assert not any("good" in r.getMessage() for r in caplog.records)


def test_token_en_query_invalide_ferme_1008(monkeypatch):
    c = _app(monkeypatch)
    with c.websocket_connect("/t?token=bad") as ws:
        with pytest.raises(WebSocketDisconnect) as ei:
            ws.receive_json()
    assert ei.value.code == 1008


# --------------------------------------------------------------------------- #
# user_from_token : même validation que get_current_user
# --------------------------------------------------------------------------- #

def _memory_db(monkeypatch):
    from backend.database import Base
    import backend.auth.models  # noqa: F401
    import backend.database as database
    from backend.auth.models import User
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    SF = sessionmaker(bind=engine)
    db = SF()
    db.add(User(id=1, username="alice", hashed_password="x", is_admin=False,
                role="player"))
    db.commit()
    db.close()
    monkeypatch.setattr(database, "SessionLocal", SF)
    return SF


def test_user_from_token_valide_et_refus(monkeypatch):
    from backend.auth.utils import create_access_token
    _memory_db(monkeypatch)
    user = ws_auth.user_from_token(create_access_token({"sub": "alice"}))
    assert user is not None and user.username == "alice"
    assert ws_auth.user_from_token(create_access_token({"sub": "inconnu"})) is None
    assert ws_auth.user_from_token("n'importe.quoi.jwt") is None
    assert ws_auth.user_from_token("") is None
    assert ws_auth.user_from_token(None) is None


# --------------------------------------------------------------------------- #
# Branchement : sysdoc viewer
# --------------------------------------------------------------------------- #

def _sysdoc_client(monkeypatch):
    from backend.sysdoc import ws_router as sd
    monkeypatch.setattr(ws_auth, "WS_AUTH_TIMEOUT_S", 0.3)
    monkeypatch.setattr(sd, "_resolve_username",
                        lambda t: "alice" if t == "good" else None)
    monkeypatch.setattr(sd, "_is_admin", lambda u: False)
    monkeypatch.setattr(sd, "_get_known_machines", lambda u: [])
    app = FastAPI()
    app.include_router(sd.router)
    return TestClient(app)


def test_sysdoc_viewer_premier_message(monkeypatch):
    c = _sysdoc_client(monkeypatch)
    with c.websocket_connect("/ws/sysdoc/viewer/alice") as ws:
        ws.send_text(json.dumps({"type": "auth", "token": "good"}))
        assert ws.receive_json()["type"] == "machines_update"


def test_sysdoc_viewer_query_legacy(monkeypatch):
    c = _sysdoc_client(monkeypatch)
    with c.websocket_connect("/ws/sysdoc/viewer/alice?token=good") as ws:
        assert ws.receive_json()["type"] == "machines_update"


def test_sysdoc_viewer_mauvais_token_et_mauvais_user(monkeypatch):
    c = _sysdoc_client(monkeypatch)
    with c.websocket_connect("/ws/sysdoc/viewer/alice") as ws:
        ws.send_text(json.dumps({"type": "auth", "token": "bad"}))
        with pytest.raises(WebSocketDisconnect) as ei:
            ws.receive_json()
    assert ei.value.code == 1008
    with c.websocket_connect("/ws/sysdoc/viewer/bob") as ws:
        ws.send_text(json.dumps({"type": "auth", "token": "good"}))
        with pytest.raises(WebSocketDisconnect) as ei:
            ws.receive_json()
    assert ei.value.code == 1008


def test_sysdoc_agent_reste_en_query(monkeypatch):
    """L'endpoint AGENT (client externe) n'attend PAS de premier message :
    sans ?token= il ferme aussitôt en 1008 (comportement inchangé)."""
    c = _sysdoc_client(monkeypatch)
    with c.websocket_connect("/ws/sysdoc/agent/alice/mac") as ws:
        with pytest.raises(WebSocketDisconnect) as ei:
            ws.receive_json()
    assert ei.value.code == 1008
