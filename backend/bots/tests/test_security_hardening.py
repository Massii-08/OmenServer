"""Failles de sécurité — durcissement (branche feat/security-hardening).

Couvre les fixes path-traversal / écriture host arbitraire / webhook SSRF sur :
  #2 yield upload (filename basename + confinement job_dir)
  #4 notifications (allowlist webhook Discord + admin gate)

Tout offline : helpers purs + TestClient avec dépendances surchargées, racines
monkeypatchées vers tmp_path, AUCUN réseau ni vraie DB.
"""
import os

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient


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
