"""Tests P3c+ — config persistante du débloqueur (clé posée depuis l'UI, pas le
.env). Stockée côté serveur en chmod 600 ; la clé brute ne sort JAMAIS de la
vue publique (masquée). Path injectable -> test offline.
"""
import os
import stat

from backend.bots.harvester import unblocker_config as uc


def test_load_missing_returns_empty(tmp_path):
    assert uc.load(str(tmp_path / "nope.json")) == {}


def test_save_then_load_roundtrip(tmp_path):
    p = str(tmp_path / "cfg.json")
    uc.save({"endpoint": "https://api.test/v1", "key": "K", "render_js": True}, p)
    out = uc.load(p)
    assert out["endpoint"] == "https://api.test/v1"
    assert out["key"] == "K"
    assert out["render_js"] is True


def test_save_is_chmod_600(tmp_path):
    p = str(tmp_path / "cfg.json")
    uc.save({"endpoint": "https://a/v1", "key": "SECRET"}, p)
    mode = stat.S_IMODE(os.stat(p).st_mode)
    assert mode == 0o600


def test_save_is_600_even_if_chmod_unavailable(tmp_path, monkeypatch):
    # défense en profondeur : le secret doit NAÎTRE en 0o600 (création atomique),
    # pas via un chmod post-création (fenêtre 0o644 + reste 0o644 si chmod échoue).
    def _boom(*a, **k):
        raise OSError("chmod unavailable")
    monkeypatch.setattr(uc.os, "chmod", _boom)
    if hasattr(uc.os, "fchmod"):
        monkeypatch.setattr(uc.os, "fchmod", _boom)
    p = str(tmp_path / "cfg.json")
    uc.save({"endpoint": "https://a/v1", "key": "SECRET"}, p)
    mode = stat.S_IMODE(os.stat(p).st_mode)
    assert mode == 0o600


def test_clear_removes_file(tmp_path):
    p = str(tmp_path / "cfg.json")
    uc.save({"key": "K"}, p)
    uc.clear(p)
    assert not os.path.exists(p)
    uc.clear(p)  # idempotent : pas d'erreur si déjà absent


def test_load_corrupt_returns_empty(tmp_path):
    p = tmp_path / "cfg.json"
    p.write_text("{not json", encoding="utf-8")
    assert uc.load(str(p)) == {}


def test_public_view_masks_key():
    pv = uc.public_view({"endpoint": "https://a/v1", "key": "ABCD1234WXYZ",
                         "render_js": True, "method": "GET", "key_in": "query"})
    assert pv["configured"] is True
    assert pv["endpoint"] == "https://a/v1"
    assert pv["render_js"] is True
    assert pv["method"] == "GET"
    assert pv["key_in"] == "query"
    # la clé BRUTE ne doit jamais apparaître ; seulement masquée
    assert "ABCD1234WXYZ" not in str(pv)
    assert pv["key_masked"].endswith("WXYZ")
    assert "key" not in pv          # pas de champ 'key' brut


def test_public_view_not_configured_without_key():
    pv = uc.public_view({"endpoint": "https://a/v1"})
    assert pv["configured"] is False
    assert pv["key_masked"] == ""


def test_public_view_not_configured_without_endpoint():
    pv = uc.public_view({"key": "K"})
    assert pv["configured"] is False
