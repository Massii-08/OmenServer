"""Tests du WebSocket push ``/ws/paper`` (LOT C, Task 8) — 100 % hors ligne.

Le JETON est un VRAI jeton (``create_access_token``), décodé par le VRAI
``decode_token`` : seule la lecture du compte en base est doublée
(``paper_ws._lookup_user``). Sans ça, un test « rejette sans jeton » ne
prouverait rien — il passerait aussi avec une authentification cassée.

⚠️ Patron DISCRIMINANT (piège documenté du plan) : chaque refus est écrit en
face du cas AUTORISÉ correspondant, et le cas autorisé est OBSERVABLE — le
socket reste ouvert ET reçoit un ``emit``. Un test qui n'épingle que la
fermeture passerait encore le jour où plus personne ne peut se connecter.
"""
import asyncio
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend.auth.utils import create_access_token
from backend.bots import paper_ws


@pytest.fixture(autouse=True)
def _clean_ws_state():
    """Le registre des sockets et la boucle enregistrée sont des états de
    MODULE : sans remise à zéro, ils fuient d'un test à l'autre."""
    paper_ws.manager.clients.clear()
    paper_ws.reset_loop()
    yield
    paper_ws.manager.clients.clear()
    paper_ws.reset_loop()


@pytest.fixture
def app():
    application = FastAPI()
    application.include_router(paper_ws.router)
    return application


def _accounts(monkeypatch, **roles):
    """Doublure de la lecture en base : ``{username: role}``."""
    def _lookup(username):
        if username not in roles:
            return None
        role = roles[username]
        return {"username": username, "role": role, "is_admin": role == "admin"}
    monkeypatch.setattr(paper_ws, "_lookup_user", _lookup)


def _token(username):
    return create_access_token({"sub": username})


# =========================================================================== #
#  Message — forme du contrat
# =========================================================================== #

def test_le_message_porte_les_quatre_champs_du_contrat():
    raw = paper_ws.build_message("news", "AAPL", {"title": "x"})
    body = json.loads(raw)
    assert set(body) == {"type", "symbol", "payload", "ts"}
    assert body["type"] == "news"
    assert body["symbol"] == "AAPL"
    assert body["payload"] == {"title": "x"}
    assert body["ts"]


def test_un_message_sans_symbole_porte_none_et_un_payload_vide():
    body = json.loads(paper_ws.build_message("digest", None, None))
    assert body["symbol"] is None
    assert body["payload"] == {}


def test_un_payload_non_serialisable_part_quand_meme():
    """Un ``datetime`` qui traîne dans un payload ne doit pas faire perdre le
    push : ``default=str`` le rend lisible plutôt que fatal."""
    from datetime import datetime
    body = json.loads(paper_ws.build_message("alert", "BTC-USD",
                                             {"at": datetime(2026, 9, 9)}))
    assert body["payload"]["at"].startswith("2026-09-09")


# =========================================================================== #
#  emit — best-effort absolu
# =========================================================================== #

def test_emit_sans_boucle_enregistree_ne_leve_pas_et_ne_fait_rien():
    paper_ws.reset_loop()
    assert paper_ws.emit("bob", "digest", None, {"a": 1}) is None


def test_emit_avec_une_boucle_fermee_ne_leve_pas():
    loop = asyncio.new_event_loop()
    loop.close()
    paper_ws.set_loop(loop)
    assert paper_ws.emit("bob", "digest", None, {}) is None


def test_emit_avec_un_payload_impossible_ne_leve_pas(monkeypatch):
    loop = asyncio.new_event_loop()
    try:
        paper_ws.set_loop(loop)

        def _boom(*_a, **_k):
            raise RuntimeError("sérialisation cassée")

        monkeypatch.setattr(paper_ws, "build_message", _boom)
        assert paper_ws.emit("bob", "news", "AAPL", {}) is None
    finally:
        loop.close()


# =========================================================================== #
#  Authentification — chaque refus en face de son cas autorisé
# =========================================================================== #

def test_sans_premier_message_le_socket_est_ferme_en_1008(app, monkeypatch):
    _accounts(monkeypatch, bob="trader")
    monkeypatch.setattr(paper_ws, "AUTH_TIMEOUT_S", 0.05)
    client = TestClient(app)
    with pytest.raises(WebSocketDisconnect) as excinfo:
        with client.websocket_connect("/ws/paper") as socket:
            socket.receive_text()
    assert excinfo.value.code == paper_ws.CLOSE_POLICY


def test_un_jeton_invalide_ferme_en_1008(app, monkeypatch):
    _accounts(monkeypatch, bob="trader")
    client = TestClient(app)
    with pytest.raises(WebSocketDisconnect) as excinfo:
        with client.websocket_connect("/ws/paper") as socket:
            socket.send_json({"token": "ceci-n-est-pas-un-jeton"})
            socket.receive_text()
    assert excinfo.value.code == paper_ws.CLOSE_POLICY


def test_un_premier_message_qui_n_est_pas_du_json_ferme_en_1008(app, monkeypatch):
    _accounts(monkeypatch, bob="trader")
    client = TestClient(app)
    with pytest.raises(WebSocketDisconnect) as excinfo:
        with client.websocket_connect("/ws/paper") as socket:
            socket.send_text("bonjour")
            socket.receive_text()
    assert excinfo.value.code == paper_ws.CLOSE_POLICY


def test_un_role_insuffisant_ferme_en_1008(app, monkeypatch):
    """Même jeton VALIDE, même protocole : seul le rôle change."""
    _accounts(monkeypatch, joe="player")
    client = TestClient(app)
    with pytest.raises(WebSocketDisconnect) as excinfo:
        with client.websocket_connect("/ws/paper") as socket:
            socket.send_json({"token": _token("joe")})
            socket.receive_text()
    assert excinfo.value.code == paper_ws.CLOSE_POLICY


def test_un_compte_inconnu_ferme_en_1008(app, monkeypatch):
    _accounts(monkeypatch, bob="trader")
    client = TestClient(app)
    with pytest.raises(WebSocketDisconnect) as excinfo:
        with client.websocket_connect("/ws/paper") as socket:
            socket.send_json({"token": _token("fantome")})
            socket.receive_text()
    assert excinfo.value.code == paper_ws.CLOSE_POLICY


@pytest.mark.parametrize("role", ["admin", "money", "trader"])
def test_un_jeton_valide_ouvre_le_socket_et_recoit_un_emit(app, monkeypatch, role):
    """LE cas discriminant : le socket RESTE ouvert et un ``emit`` arrive."""
    _accounts(monkeypatch, **{"bob": role})
    client = TestClient(app)
    with client.websocket_connect("/ws/paper") as socket:
        socket.send_json({"token": _token("bob")})
        hello = socket.receive_json()
        assert hello["type"] == "brief_changed"
        assert paper_ws.manager.count("bob") == 1

        paper_ws.emit("bob", "threat", "NESN.SW", {"why": "held_risk"})
        pushed = socket.receive_json()
        assert pushed["type"] == "threat"
        assert pushed["symbol"] == "NESN.SW"
        assert pushed["payload"] == {"why": "held_risk"}


def test_un_emit_diffuse_a_tous_quand_l_utilisateur_est_none(app, monkeypatch):
    _accounts(monkeypatch, bob="trader")
    client = TestClient(app)
    with client.websocket_connect("/ws/paper") as socket:
        socket.send_json({"token": _token("bob")})
        socket.receive_json()                       # bonjour
        paper_ws.emit(None, "digest", None, {"n": 3})
        pushed = socket.receive_json()
        assert pushed["type"] == "digest"
        assert pushed["payload"] == {"n": 3}


def test_un_emit_adresse_a_un_autre_compte_n_arrive_pas(app, monkeypatch):
    """Le pendant du test précédent : la diffusion est CIBLÉE, pas globale."""
    _accounts(monkeypatch, bob="trader")
    client = TestClient(app)
    with client.websocket_connect("/ws/paper") as socket:
        socket.send_json({"token": _token("bob")})
        socket.receive_json()                       # bonjour
        paper_ws.emit("alice", "digest", None, {"n": 1})
        paper_ws.emit("bob", "news", "AAPL", {"n": 2})
        pushed = socket.receive_json()
        assert pushed["payload"] == {"n": 2}        # celui d'alice n'est pas passé


def test_le_cinquieme_socket_du_meme_compte_est_refuse(app, monkeypatch):
    _accounts(monkeypatch, bob="trader")
    client = TestClient(app)
    token = _token("bob")
    opened = []
    try:
        for _ in range(paper_ws.MAX_SOCKETS_PER_USER):
            socket = client.websocket_connect("/ws/paper").__enter__()
            socket.send_json({"token": token})
            socket.receive_json()                   # bonjour -> vraiment ouvert
            opened.append(socket)
        assert paper_ws.manager.count("bob") == paper_ws.MAX_SOCKETS_PER_USER

        with pytest.raises(WebSocketDisconnect) as excinfo:
            with client.websocket_connect("/ws/paper") as extra:
                extra.send_json({"token": token})
                extra.receive_text()
        assert excinfo.value.code == paper_ws.CLOSE_POLICY
    finally:
        for socket in opened:
            try:
                socket.close()
            except Exception:
                pass


def test_le_serveur_envoie_un_ping(app, monkeypatch):
    _accounts(monkeypatch, bob="trader")
    monkeypatch.setattr(paper_ws, "PING_INTERVAL_S", 0.05)
    client = TestClient(app)
    with client.websocket_connect("/ws/paper") as socket:
        socket.send_json({"token": _token("bob")})
        socket.receive_json()                       # bonjour
        assert socket.receive_json() == {"type": "ping"}
        socket.send_json({"type": "pong"})          # le client répond, rien ne casse
        assert socket.receive_json() == {"type": "ping"}


def test_un_socket_ferme_est_retire_du_registre(app, monkeypatch):
    _accounts(monkeypatch, bob="trader")
    client = TestClient(app)
    with client.websocket_connect("/ws/paper") as socket:
        socket.send_json({"token": _token("bob")})
        socket.receive_json()
        assert paper_ws.manager.count("bob") == 1
    assert paper_ws.manager.count("bob") == 0
