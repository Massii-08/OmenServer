"""
Tests anti-IDOR — chaque endbout sensible doit refuser (403) un intrus
(compte loggué non-owner, non-admin, sans shared_access) AVANT tout appel Docker.

On vérifie aussi que l'owner PASSE le gate (ne reçoit PAS 403). Comme l'owner
finit par toucher Docker (indisponible en test), on tolère 500/400/404 pour lui :
l'important est qu'il ne soit JAMAIS bloqué à 403 par le gate.
"""

import pytest

from backend.game_server.tests.conftest import build_client, OWNER_ID, INTRUDER_ID, ADMIN_ID


# ---------------------------------------------------------------------------
# files_router
# ---------------------------------------------------------------------------

def _files_client(user_id):
    from backend.game_server import files_router
    holder = {"id": user_id}
    client, _ = build_client(files_router.router, lambda: holder["id"])
    return client


FILES_READ = [
    ("get", "/api/servers/1/files?path=/", None),
    ("get", "/api/servers/1/files/content?path=/server.properties", None),
]
FILES_WRITE = [
    ("put", "/api/servers/1/files/content", {"path": "/x.txt", "content": "h"}),
    ("post", "/api/servers/1/files/mkdir", {"path": "/newdir"}),
    ("delete", "/api/servers/1/files?path=/foo", None),
    ("post", "/api/servers/1/files/rename", {"old_path": "/a", "new_path": "/b"}),
]


@pytest.mark.parametrize("method,url,body", FILES_READ + FILES_WRITE)
def test_files_intruder_forbidden(method, url, body):
    client = _files_client(INTRUDER_ID)
    resp = getattr(client, method)(url, json=body) if body else getattr(client, method)(url)
    assert resp.status_code == 403, f"{method} {url} should be 403 for intruder, got {resp.status_code}"


@pytest.mark.parametrize("method,url,body", FILES_READ + FILES_WRITE)
def test_files_owner_passes_gate(method, url, body):
    client = _files_client(OWNER_ID)
    resp = getattr(client, method)(url, json=body) if body else getattr(client, method)(url)
    assert resp.status_code != 403, f"{method} {url} should NOT be 403 for owner, got {resp.status_code}"


def test_files_upload_intruder_forbidden():
    client = _files_client(INTRUDER_ID)
    resp = client.post(
        "/api/servers/1/files/upload",
        data={"path": "/"},
        files={"file": ("a.txt", b"hi", "text/plain")},
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# settings_router
# ---------------------------------------------------------------------------

def _settings_client(user_id):
    from backend.game_server import settings_router
    holder = {"id": user_id}
    client, _ = build_client(settings_router.router, lambda: holder["id"])
    return client


SETTINGS_ROUTES = [
    ("get", "/api/servers/1/properties", None),
    ("put", "/api/servers/1/properties", {"properties": {"motd": "x"}}),
    ("get", "/api/servers/1/config/server.properties", None),
    ("put", "/api/servers/1/config/server.properties", {"content": "x=y"}),
]


@pytest.mark.parametrize("method,url,body", SETTINGS_ROUTES)
def test_settings_intruder_forbidden(method, url, body):
    client = _settings_client(INTRUDER_ID)
    resp = getattr(client, method)(url, json=body) if body else getattr(client, method)(url)
    assert resp.status_code == 403, f"{method} {url} should be 403, got {resp.status_code}"


@pytest.mark.parametrize("method,url,body", SETTINGS_ROUTES)
def test_settings_owner_passes_gate(method, url, body):
    client = _settings_client(OWNER_ID)
    resp = getattr(client, method)(url, json=body) if body else getattr(client, method)(url)
    assert resp.status_code != 403, f"{method} {url} owner blocked, got {resp.status_code}"


# ---------------------------------------------------------------------------
# players_router
# ---------------------------------------------------------------------------

def _players_client(user_id):
    from backend.game_server import players_router
    holder = {"id": user_id}
    client, _ = build_client(players_router.router, lambda: holder["id"])
    return client


PLAYERS_ROUTES = [
    ("get", "/api/servers/1/players/ops", None),
    ("post", "/api/servers/1/players/ops", {"name": "Bob"}),
    ("delete", "/api/servers/1/players/ops/Bob", None),
    ("get", "/api/servers/1/players/whitelist", None),
    ("post", "/api/servers/1/players/whitelist", {"name": "Bob"}),
    ("delete", "/api/servers/1/players/whitelist/Bob", None),
    ("get", "/api/servers/1/players/banned", None),
    ("post", "/api/servers/1/players/banned", {"name": "Bob"}),
    ("delete", "/api/servers/1/players/banned/Bob", None),
]


@pytest.mark.parametrize("method,url,body", PLAYERS_ROUTES)
def test_players_intruder_forbidden(method, url, body):
    client = _players_client(INTRUDER_ID)
    resp = getattr(client, method)(url, json=body) if body else getattr(client, method)(url)
    assert resp.status_code == 403, f"{method} {url} should be 403, got {resp.status_code}"


@pytest.mark.parametrize("method,url,body", PLAYERS_ROUTES)
def test_players_owner_passes_gate(method, url, body):
    client = _players_client(OWNER_ID)
    resp = getattr(client, method)(url, json=body) if body else getattr(client, method)(url)
    assert resp.status_code != 403, f"{method} {url} owner blocked, got {resp.status_code}"


# ---------------------------------------------------------------------------
# access_router (le plus critique : get_sftp_info fuit le mot de passe)
# ---------------------------------------------------------------------------

def _access_client(user_id):
    from backend.game_server import access_router
    holder = {"id": user_id}
    client, factory = build_client(access_router.router, lambda: holder["id"])
    return client, factory


ACCESS_ROUTES = [
    ("get", "/api/servers/1/ports", None),
    ("post", "/api/servers/1/ports", {"host_port": 30000, "container_port": 25565}),
    ("delete", "/api/servers/1/ports/30000", None),
    ("get", "/api/servers/1/sftp-info", None),
]


@pytest.mark.parametrize("method,url,body", ACCESS_ROUTES)
def test_access_intruder_forbidden(method, url, body):
    client, _ = _access_client(INTRUDER_ID)
    resp = getattr(client, method)(url, json=body) if body else getattr(client, method)(url)
    assert resp.status_code == 403, f"{method} {url} should be 403, got {resp.status_code}"


def test_sftp_info_does_not_leak_password_to_intruder():
    """Régression critique : un intrus ne doit jamais voir server.sftp_password."""
    client, factory = _access_client(INTRUDER_ID)
    # Pré-remplir un mot de passe SFTP
    from backend.game_server.models import GameServer
    db = factory()
    srv = db.query(GameServer).filter(GameServer.id == 1).first()
    srv.sftp_password = "SUPERSECRET123"
    db.commit()
    db.close()

    resp = client.get("/api/servers/1/sftp-info")
    assert resp.status_code == 403
    assert "SUPERSECRET123" not in resp.text


@pytest.mark.parametrize("method,url,body", ACCESS_ROUTES)
def test_access_owner_passes_gate(method, url, body):
    client, _ = _access_client(OWNER_ID)
    resp = getattr(client, method)(url, json=body) if body else getattr(client, method)(url)
    assert resp.status_code != 403, f"{method} {url} owner blocked, got {resp.status_code}"


# ---------------------------------------------------------------------------
# router.py — worlds + database
# ---------------------------------------------------------------------------

def _main_client(user_id):
    from backend.game_server import router as gs_router
    holder = {"id": user_id}
    client, _ = build_client(gs_router.router, lambda: holder["id"])
    return client


MAIN_ROUTES = [
    ("get", "/api/servers/1/worlds", None),
    ("delete", "/api/servers/1/worlds/world", None),
    ("post", "/api/servers/1/database", {}),
    ("get", "/api/servers/1/database", None),
    ("delete", "/api/servers/1/database", None),
]


@pytest.mark.parametrize("method,url,body", MAIN_ROUTES)
def test_main_intruder_forbidden(method, url, body):
    client = _main_client(INTRUDER_ID)
    resp = getattr(client, method)(url, json=body) if body is not None else getattr(client, method)(url)
    assert resp.status_code == 403, f"{method} {url} should be 403, got {resp.status_code}"


@pytest.mark.parametrize("method,url,body", MAIN_ROUTES)
def test_main_owner_passes_gate(method, url, body):
    client = _main_client(OWNER_ID)
    resp = getattr(client, method)(url, json=body) if body is not None else getattr(client, method)(url)
    assert resp.status_code != 403, f"{method} {url} owner blocked, got {resp.status_code}"


# ---------------------------------------------------------------------------
# Admin doit toujours passer (jamais 403)
# ---------------------------------------------------------------------------

def test_admin_passes_files_gate():
    from backend.game_server import files_router
    holder = {"id": ADMIN_ID}
    client, _ = build_client(files_router.router, lambda: holder["id"])
    resp = client.get("/api/servers/1/files?path=/")
    assert resp.status_code != 403
