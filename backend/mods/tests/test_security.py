"""
Tests de sécurité du module mods (SSRF, IDOR, tar traversal).

Tous OFFLINE : aucune vraie requête réseau ni appel Docker. On monkeypatch
les couches sortantes (requests.get / httpx.get / docker) pour PROUVER qu'elles
ne sont JAMAIS appelées quand l'URL est rejetée par l'allowlist, et que les
intrus non-owner reçoivent un 403.

DB : SQLite in-memory ISOLÉE (jamais la vraie omenserver.db).
"""

import pytest
from fastapi import FastAPI, Depends
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.database import Base, get_db
# Importer tous les modèles pour que create_all crée bien les tables
import backend.auth.models  # noqa: F401
import backend.auth.shared_access  # noqa: F401
import backend.game_server.models  # noqa: F401
import backend.bots.models  # noqa: F401

from backend.auth.models import User
from backend.auth.shared_access import SharedAccess
from backend.game_server.models import GameServer
from backend.auth.utils import get_current_user

from backend.mods.router import router as mods_router
from backend.mods.plugin_router import router as plugins_router


# ── Fixtures DB ──────────────────────────────────────────────

@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    TestingSession = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    session = TestingSession()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


@pytest.fixture
def seeded(db_session):
    """Crée: admin, owner (non-admin), intruder (non-admin), et 1 serveur
    appartenant à owner avec un docker_id."""
    admin = User(username="admin", hashed_password="x",
                 is_admin=True, role="admin")
    owner = User(username="owner", hashed_password="x",
                 is_admin=False, role="player")
    intruder = User(username="intruder", hashed_password="x",
                    is_admin=False, role="player")
    db_session.add_all([admin, owner, intruder])
    db_session.commit()

    server = GameServer(
        name="srv", game_type="minecraft",
        owner_id=owner.id, docker_id="deadbeef", status="stopped",
    )
    db_session.add(server)
    db_session.commit()

    return {
        "admin": admin, "owner": owner, "intruder": intruder,
        "server": server, "server_id": server.id,
    }


def make_client(db_session, as_user):
    """App minimale qui monte les 2 routers, override get_db + get_current_user."""
    app = FastAPI()
    app.include_router(mods_router)
    app.include_router(plugins_router)
    app.dependency_overrides[get_db] = lambda: db_session
    app.dependency_overrides[get_current_user] = lambda: as_user
    return TestClient(app, raise_server_exceptions=False)


# ── Garde réseau : aucune sortie autorisée quand l'URL est rejetée ──

@pytest.fixture
def network_tripwires(monkeypatch):
    """Fait exploser tout appel réseau/docker sortant. Si l'allowlist a fait
    son boulot, ces fonctions ne sont jamais atteintes."""
    def boom(*a, **k):
        raise AssertionError("Fetch réseau/docker ne devrait PAS être appelé "
                             "(URL non allowlistée doit être rejetée AVANT)")
    import backend.mods.curseforge as cf
    import backend.mods.plugin_manager as pm
    import backend.mods.datapack_manager as dm
    monkeypatch.setattr(cf.requests, "get", boom)
    monkeypatch.setattr(pm.httpx, "get", boom)
    monkeypatch.setattr(dm.httpx, "get", boom)
    # docker.from_env ne doit jamais être atteint non plus
    import docker
    monkeypatch.setattr(docker, "from_env", boom)
    return boom


# ── 1. SSRF : download_url interne / non-allowlisté → rejet sans fetch ──

INTERNAL_URLS = [
    "http://127.0.0.1:8000/secret",
    "http://localhost/x",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/x",
    "http://192.168.1.1/x",
    "http://evil.com/payload.jar",
    "https://forgecdn.net.evil.com/x.jar",   # lookalike
    "file:///etc/passwd",
    "ftp://forgecdn.net/x",
]


@pytest.mark.parametrize("bad_url", INTERNAL_URLS)
def test_install_mod_rejects_non_allowlisted_url(seeded, db_session, network_tripwires, bad_url):
    client = make_client(db_session, seeded["admin"])  # admin: passe le gate IDOR
    r = client.post("/api/mods/install", json={
        "server_id": seeded["server_id"], "mod_name": "m",
        "download_url": bad_url, "filename": "m.jar",
    })
    assert r.status_code == 400, (bad_url, r.status_code, r.text)


@pytest.mark.parametrize("bad_url", INTERNAL_URLS)
def test_install_plugin_rejects_non_allowlisted_url(seeded, db_session, network_tripwires, bad_url):
    client = make_client(db_session, seeded["admin"])
    r = client.post("/api/plugins/install", json={
        "server_id": seeded["server_id"], "plugin_name": "p",
        "download_url": bad_url, "filename": "p.jar",
    })
    assert r.status_code == 400, (bad_url, r.status_code, r.text)


@pytest.mark.parametrize("bad_url", INTERNAL_URLS)
def test_install_datapack_rejects_non_allowlisted_url(seeded, db_session, network_tripwires, bad_url):
    client = make_client(db_session, seeded["admin"])
    r = client.post("/api/mods/datapacks/install", json={
        "server_id": seeded["server_id"], "mod_name": "d",
        "download_url": bad_url, "filename": "d.zip",
    })
    assert r.status_code == 400, (bad_url, r.status_code, r.text)


# ── 2. IDOR : intrus non-owner → 403 (avant tout fetch) ──

def test_install_mod_intruder_forbidden(seeded, db_session, network_tripwires):
    client = make_client(db_session, seeded["intruder"])
    r = client.post("/api/mods/install", json={
        "server_id": seeded["server_id"], "mod_name": "m",
        "download_url": "https://edge.forgecdn.net/files/1/2/m.jar",
        "filename": "m.jar",
    })
    assert r.status_code == 403, r.text


def test_install_plugin_intruder_forbidden(seeded, db_session, network_tripwires):
    client = make_client(db_session, seeded["intruder"])
    r = client.post("/api/plugins/install", json={
        "server_id": seeded["server_id"], "plugin_name": "p",
        "download_url": "https://cdn.modrinth.com/data/x/p.jar",
        "filename": "p.jar",
    })
    assert r.status_code == 403, r.text


def test_install_datapack_intruder_forbidden(seeded, db_session, network_tripwires):
    client = make_client(db_session, seeded["intruder"])
    r = client.post("/api/mods/datapacks/install", json={
        "server_id": seeded["server_id"], "mod_name": "d",
        "download_url": "https://edge.forgecdn.net/files/1/2/d.zip",
        "filename": "d.zip",
    })
    assert r.status_code == 403, r.text


def test_remove_mod_intruder_forbidden(seeded, db_session, network_tripwires):
    client = make_client(db_session, seeded["intruder"])
    r = client.delete(f"/api/mods/server/{seeded['server_id']}/m.jar")
    assert r.status_code == 403, r.text


def test_remove_plugin_intruder_forbidden(seeded, db_session, network_tripwires):
    client = make_client(db_session, seeded["intruder"])
    r = client.delete(f"/api/plugins/server/{seeded['server_id']}/p.jar")
    assert r.status_code == 403, r.text


def test_remove_datapack_intruder_forbidden(seeded, db_session, network_tripwires):
    client = make_client(db_session, seeded["intruder"])
    r = client.delete(f"/api/mods/datapacks/{seeded['server_id']}/d.zip")
    assert r.status_code == 403, r.text


# ── owner / shared "manage" passent le gate (mais peuvent échouer plus loin) ──

def test_install_mod_owner_passes_gate(seeded, db_session, monkeypatch):
    """Owner d'un CDN légitime → on ne doit PAS être bloqué en 400/403.
    On stoppe le fetch en mockant download_mod pour rester offline."""
    import backend.mods.curseforge as cf
    called = {}
    def fake_dl(download_url, dest_dir, filename):
        called["url"] = download_url
        return f"{dest_dir}/{filename}"
    monkeypatch.setattr(cf, "download_mod", fake_dl)

    client = make_client(db_session, seeded["owner"])
    r = client.post("/api/mods/install", json={
        "server_id": seeded["server_id"], "mod_name": "m",
        "download_url": "https://edge.forgecdn.net/files/1/2/m.jar",
        "filename": "m.jar",
    })
    assert r.status_code == 200, r.text
    assert called.get("url") == "https://edge.forgecdn.net/files/1/2/m.jar"


def test_shared_manage_passes_gate(seeded, db_session, monkeypatch):
    """Un user avec shared_access 'manage' passe le gate."""
    shared = SharedAccess(
        resource_type="server", resource_id=seeded["server_id"],
        user_id=seeded["intruder"].id, access_level="manage",
        granted_by=seeded["owner"].id,
    )
    db_session.add(shared)
    db_session.commit()

    import backend.mods.curseforge as cf
    monkeypatch.setattr(cf, "download_mod", lambda **k: "ok")

    client = make_client(db_session, seeded["intruder"])
    r = client.post("/api/mods/install", json={
        "server_id": seeded["server_id"], "mod_name": "m",
        "download_url": "https://media.forgecdn.net/files/1/2/m.jar",
        "filename": "m.jar",
    })
    assert r.status_code == 200, r.text


def test_shared_view_only_forbidden(seeded, db_session, network_tripwires):
    """view_only < manage → 403 (anti-IDOR par niveau)."""
    shared = SharedAccess(
        resource_type="server", resource_id=seeded["server_id"],
        user_id=seeded["intruder"].id, access_level="view_only",
        granted_by=seeded["owner"].id,
    )
    db_session.add(shared)
    db_session.commit()

    client = make_client(db_session, seeded["intruder"])
    r = client.post("/api/mods/install", json={
        "server_id": seeded["server_id"], "mod_name": "m",
        "download_url": "https://media.forgecdn.net/files/1/2/m.jar",
        "filename": "m.jar",
    })
    assert r.status_code == 403, r.text


# ── 3. host_allowed : vrais CDN acceptés, intrus refusés ──

def test_host_allowed_accepts_real_cdns():
    from backend import net_guard
    from backend.mods.router import ALLOWED_DOWNLOAD_HOSTS
    good = [
        "https://edge.forgecdn.net/files/1/2/x.jar",
        "https://media.forgecdn.net/files/1/2/x.jar",
        "https://cdn.modrinth.com/data/AbC/versions/v/x.jar",
        "https://api.modrinth.com/v2/x",
    ]
    for url in good:
        assert net_guard.host_allowed(url, ALLOWED_DOWNLOAD_HOSTS), url


def test_host_allowed_rejects_lookalike_and_internal():
    from backend import net_guard
    from backend.mods.router import ALLOWED_DOWNLOAD_HOSTS
    bad = [
        "https://forgecdn.net.evil.com/x.jar",
        "http://127.0.0.1/x.jar",
        "http://localhost/x.jar",
        "https://evil.com/x.jar",
    ]
    for url in bad:
        assert not net_guard.host_allowed(url, ALLOWED_DOWNLOAD_HOSTS), url


# ── tar member traversal : basename forcé ──

def _fake_docker(monkeypatch, captured, container_status=None):
    """Patche docker.from_env pour capturer le tar envoyé à put_archive."""
    import tarfile, io
    import docker

    class FakeContainer:
        status = container_status
        def exec_run(self, *a, **k): return None
        def put_archive(self, path, data):
            captured["path"] = path
            tf = tarfile.open(fileobj=io.BytesIO(data), mode="r")
            captured["names"] = tf.getnames()

    class FakeClient:
        class containers:
            @staticmethod
            def get(_id): return FakeContainer()

    monkeypatch.setattr(docker, "from_env", lambda: FakeClient())


class _FakeResp:
    content = b"DATA"
    def raise_for_status(self): pass


def test_plugin_tar_member_rejects_traversal(monkeypatch):
    """install_plugin doit REFUSER un filename contenant un chemin (traversal)
    AVANT tout fetch — harmonisé avec remove_plugin."""
    import backend.mods.plugin_manager as pm

    def boom(*a, **k):
        raise AssertionError("Fetch ne doit pas être atteint sur un filename invalide")
    monkeypatch.setattr(pm.httpx, "get", boom)

    for bad in ("../../etc/evil.jar", "sub/evil.jar", "..", "/abs/evil.jar"):
        with pytest.raises(ValueError):
            pm.install_plugin("cid", "https://cdn.modrinth.com/x.jar", bad)


def test_plugin_tar_member_clean_basename(monkeypatch):
    """Un filename propre produit bien un membre tar = basename uniquement."""
    import backend.mods.plugin_manager as pm

    captured = {}
    monkeypatch.setattr(pm.httpx, "get", lambda *a, **k: _FakeResp())
    _fake_docker(monkeypatch, captured)

    pm.install_plugin("cid", "https://cdn.modrinth.com/x.jar", "myplugin.jar")
    assert captured["names"] == ["myplugin.jar"], captured.get("names")


def test_datapack_tar_member_rejects_traversal(monkeypatch):
    import backend.mods.datapack_manager as dm

    def boom(*a, **k):
        raise AssertionError("Fetch ne doit pas être atteint sur un filename invalide")
    monkeypatch.setattr(dm.httpx, "get", boom)

    for bad in ("../../sub/evil.zip", "sub/evil.zip", "..", "/abs/evil.zip"):
        with pytest.raises(ValueError):
            dm.install_datapack("cid", "https://media.forgecdn.net/x.zip", bad)


def test_datapack_tar_member_clean_basename(monkeypatch):
    import backend.mods.datapack_manager as dm

    captured = {}
    monkeypatch.setattr(dm.httpx, "get", lambda *a, **k: _FakeResp())
    _fake_docker(monkeypatch, captured, container_status="running")

    dm.install_datapack("cid", "https://media.forgecdn.net/x.zip", "mypack.zip")
    assert captured["names"] == ["mypack.zip"], captured.get("names")
