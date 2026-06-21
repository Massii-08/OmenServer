"""Failles de sécurité — durcissement (branche feat/security-hardening).

Couvre les fixes path-traversal / écriture host arbitraire / webhook SSRF sur :
  #1 gdrive download (dest_path + file_name confinés)
  #2 yield upload (filename basename + confinement job_dir)
  #4 notifications (allowlist webhook Discord + admin gate)
  #6 media libraries (name basename + confinement MEDIA_BASE_DIR)

Tout offline : helpers purs + TestClient avec dépendances surchargées, racines
monkeypatchées vers tmp_path, AUCUN réseau ni vraie DB.
"""
import os

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient


# ============================================================================
#  #1 gdrive — _safe_download_target : confinement sous GDRIVE_DOWNLOADS_DIR
# ============================================================================
from backend.gdrive import router as gd


def _set_gdrive_root(tmp_path, monkeypatch):
    monkeypatch.setattr(gd, "GDRIVE_DOWNLOADS_DIR", tmp_path / "downloads")


def test_gdrive_target_normal_file(tmp_path, monkeypatch):
    _set_gdrive_root(tmp_path, monkeypatch)
    target = gd._safe_download_target("", "rapport.xlsx")
    assert target == (tmp_path / "downloads" / "rapport.xlsx").resolve()


def test_gdrive_target_subfolder_ok(tmp_path, monkeypatch):
    _set_gdrive_root(tmp_path, monkeypatch)
    target = gd._safe_download_target("sub/dir", "x.bin")
    assert target == (tmp_path / "downloads" / "sub" / "dir" / "x.bin").resolve()


def test_gdrive_target_rejects_traversal_in_dest_path(tmp_path, monkeypatch):
    _set_gdrive_root(tmp_path, monkeypatch)
    with pytest.raises(HTTPException) as e:
        gd._safe_download_target("../../.ssh", "authorized_keys")
    assert e.value.status_code == 400


def test_gdrive_target_absolute_dest_path_is_confined_not_escaped(tmp_path, monkeypatch):
    _set_gdrive_root(tmp_path, monkeypatch)
    # un chemin absolu ne doit PAS remplacer la racine : '/etc' est traité comme
    # relatif (lstrip du '/') -> confiné sous la racine, jamais hors d'elle.
    target = gd._safe_download_target("/etc", "passwd")
    root = (tmp_path / "downloads").resolve()
    assert root in target.parents
    assert target == (root / "etc" / "passwd")


def test_gdrive_target_rejects_traversal_in_file_name(tmp_path, monkeypatch):
    # file_name vient des métadonnées Drive (attaquant) -> basename strict
    _set_gdrive_root(tmp_path, monkeypatch)
    target = gd._safe_download_target("", "../../../etc/cron.d/evil")
    # le basename écrase le traversal -> reste dans la racine
    assert target == (tmp_path / "downloads" / "evil").resolve()


def test_gdrive_target_rejects_empty_or_dotdot_filename(tmp_path, monkeypatch):
    _set_gdrive_root(tmp_path, monkeypatch)
    for bad in ("", "..", "/"):
        with pytest.raises(HTTPException):
            gd._safe_download_target("", bad)


def test_gdrive_download_endpoint_requires_admin(tmp_path, monkeypatch):
    # non-admin -> 403 (écriture fichier host = admin strict)
    from backend.auth.utils import get_current_user

    class U:
        is_admin = False
        role = "player"
        username = "bob"

    app = FastAPI()
    app.include_router(gd.router)
    app.dependency_overrides[get_current_user] = lambda: U()
    c = TestClient(app)
    r = c.post("/api/gdrive/download", json={"file_id": "x", "dest_path": "/tmp"})
    assert r.status_code == 403


# ============================================================================
#  #6 media — _safe_library_path : confinement sous MEDIA_BASE_DIR
# ============================================================================
from backend.media import router as md


def test_media_library_path_normal(tmp_path, monkeypatch):
    monkeypatch.setattr(md, "MEDIA_BASE_DIR", str(tmp_path / "media"))
    os.makedirs(str(tmp_path / "media"), exist_ok=True)
    p = md._safe_library_path("films")
    assert p == os.path.realpath(os.path.join(str(tmp_path / "media"), "films"))


def test_media_library_path_rejects_traversal(tmp_path, monkeypatch):
    monkeypatch.setattr(md, "MEDIA_BASE_DIR", str(tmp_path / "media"))
    os.makedirs(str(tmp_path / "media"), exist_ok=True)
    for bad in ("../../etc", "../secret", "..", "a/b"):
        # basename collapse -> soit confiné soit rejeté, jamais hors racine
        try:
            p = md._safe_library_path(bad)
        except HTTPException:
            continue
        assert os.path.dirname(p) == os.path.realpath(str(tmp_path / "media"))


def test_media_library_path_rejects_separators_escape(tmp_path, monkeypatch):
    monkeypatch.setattr(md, "MEDIA_BASE_DIR", str(tmp_path / "media"))
    os.makedirs(str(tmp_path / "media"), exist_ok=True)
    # un name contenant un séparateur -> basename ne garde que le dernier segment
    p = md._safe_library_path("/etc/passwd")
    assert os.path.dirname(p) == os.path.realpath(str(tmp_path / "media"))
    assert os.path.basename(p) == "passwd"


def test_media_delete_endpoint_traversal_is_confined(tmp_path, monkeypatch):
    from backend.auth.utils import get_current_user
    monkeypatch.setattr(md, "MEDIA_BASE_DIR", str(tmp_path / "media"))
    os.makedirs(str(tmp_path / "media"), exist_ok=True)
    # une cible HORS racine ne doit pas exister -> 404, jamais de rmdir hors base
    secret = tmp_path / "secret_dir"
    secret.mkdir()

    class U:
        is_admin = True
        role = "admin"
        username = "admin"

    app = FastAPI()
    app.include_router(md.router)
    app.dependency_overrides[get_current_user] = lambda: U()
    c = TestClient(app)
    # %2e%2e = ".." ; basename collapse -> reste dans media -> 404 (n'existe pas)
    r = c.request("DELETE", "/api/media/libraries/..%2f..%2fsecret_dir")
    assert r.status_code in (400, 404)
    assert secret.exists()  # jamais supprimé


# ============================================================================
#  #4 notifications — allowlist webhook Discord + admin gate
# ============================================================================
from backend.notifications import router as nr


def test_discord_webhook_allowlist():
    ok = [
        "https://discord.com/api/webhooks/123456789/abcDEF-_token",
        "https://discordapp.com/api/webhooks/1/x",
        "https://discord.com/api/v10/webhooks/999/tok-en_1",
        "https://ptb.discord.com/api/webhooks/1/x",
    ]
    bad = [
        "http://127.0.0.1:8000/api/webhooks/1/x",      # interne
        "https://evil.com/api/webhooks/1/x",           # mauvais host
        "https://discord.com.evil.com/api/webhooks/1/x",  # lookalike
        "https://discord.com/api/notawebhook/1/x",     # mauvais path
        "ftp://discord.com/api/webhooks/1/x",          # mauvais schéma
        "https://discord.com/api/webhooks/",           # incomplet
        "",
    ]
    for u in ok:
        assert nr._is_valid_discord_webhook(u), u
    for u in bad:
        assert not nr._is_valid_discord_webhook(u), u


def _notif_client(tmp_path, monkeypatch, is_admin):
    from backend.auth.utils import get_current_user
    monkeypatch.setattr(nr, "SETTINGS_FILE", tmp_path / "notif.json")

    class U:
        pass
    u = U()
    u.is_admin = is_admin
    u.role = "admin" if is_admin else "player"
    u.username = "tester"

    app = FastAPI()
    app.include_router(nr.router)
    app.dependency_overrides[get_current_user] = lambda: u
    return TestClient(app)


def test_notif_put_settings_requires_admin(tmp_path, monkeypatch):
    c = _notif_client(tmp_path, monkeypatch, is_admin=False)
    r = c.put("/api/notifications/settings",
              json={"discord_webhook_url": "https://discord.com/api/webhooks/1/x"})
    assert r.status_code == 403


def test_notif_put_settings_rejects_bad_webhook(tmp_path, monkeypatch):
    c = _notif_client(tmp_path, monkeypatch, is_admin=True)
    r = c.put("/api/notifications/settings",
              json={"discord_webhook_url": "http://127.0.0.1:9000/api/webhooks/1/x"})
    assert r.status_code == 400


def test_notif_put_settings_accepts_valid_webhook(tmp_path, monkeypatch):
    c = _notif_client(tmp_path, monkeypatch, is_admin=True)
    url = "https://discord.com/api/webhooks/123/abc-_DEF"
    r = c.put("/api/notifications/settings", json={"discord_webhook_url": url})
    assert r.status_code == 200
    assert r.json()["discord_webhook_url"] == url


def test_notif_put_settings_allows_empty_webhook(tmp_path, monkeypatch):
    # vider le webhook (désactiver) doit rester possible
    c = _notif_client(tmp_path, monkeypatch, is_admin=True)
    r = c.put("/api/notifications/settings", json={"discord_webhook_url": ""})
    assert r.status_code == 200


def test_notif_test_requires_admin(tmp_path, monkeypatch):
    c = _notif_client(tmp_path, monkeypatch, is_admin=False)
    r = c.post("/api/notifications/test")
    assert r.status_code == 403


def test_notif_test_rejects_internal_url_in_stale_settings(tmp_path, monkeypatch):
    # un fichier settings antérieur au fix peut contenir une URL interne :
    # /test doit refuser de POSTer dessus (défense en profondeur).
    import json
    (tmp_path / "notif.json").write_text(
        json.dumps({"discord_webhook_url": "http://169.254.169.254/latest/meta-data"}))
    c = _notif_client(tmp_path, monkeypatch, is_admin=True)
    r = c.post("/api/notifications/test")
    assert r.status_code == 400


# ============================================================================
#  #2 yield — upload : filename basename + confinement job_dir
# ============================================================================
from backend.bots import yield_router as yr


def _yield_client(tmp_path, monkeypatch):
    from backend.auth.utils import get_current_user
    monkeypatch.setattr(yr, "UPLOADS_DIR", tmp_path / "uploads")

    class U:
        is_admin = True
        role = "admin"
        username = "admin"

    app = FastAPI()
    app.include_router(yr.router)
    app.dependency_overrides[get_current_user] = lambda: U()
    return TestClient(app)


def test_yield_upload_traversal_filename_is_confined(tmp_path, monkeypatch):
    c = _yield_client(tmp_path, monkeypatch)
    # nom malveillant : tente de sortir d'UPLOADS_DIR/<job_id>/
    files = {"file": ("../../../tmp/evil.xlsx", b"PK\x03\x04stub", "application/octet-stream")}
    r = c.post("/api/bots/yield/upload", files=files)
    assert r.status_code == 200
    body = r.json()
    # le fichier réellement écrit reste sous uploads/<job_id>/ et porte le basename
    assert body["filename"] == "evil.xlsx"
    job_dir = tmp_path / "uploads" / body["job_id"]
    written = list(job_dir.glob("*.xlsx"))
    assert written == [job_dir / "evil.xlsx"]
    # AUCUN fichier écrit hors de la racine uploads
    assert not (tmp_path / "tmp" / "evil.xlsx").exists()
    assert not (tmp_path.parent / "evil.xlsx").exists()


def test_yield_upload_rejects_non_xlsx(tmp_path, monkeypatch):
    c = _yield_client(tmp_path, monkeypatch)
    files = {"file": ("data.txt", b"hello", "text/plain")}
    r = c.post("/api/bots/yield/upload", files=files)
    assert r.status_code == 400


def test_yield_upload_rejects_xlsx_extension_disguise(tmp_path, monkeypatch):
    # un nom sans .xlsx final (ex: ".xlsx.sh") est rejeté
    c = _yield_client(tmp_path, monkeypatch)
    files = {"file": ("payload.xlsx.sh", b"x", "application/octet-stream")}
    r = c.post("/api/bots/yield/upload", files=files)
    assert r.status_code == 400
