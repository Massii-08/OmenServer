"""Tests config Telegram persistante + notifier. 100% offline."""
import os
import stat

from backend.bots.harvester import telegram_config as tc


def test_load_absent_returns_empty(tmp_path):
    assert tc.load(str(tmp_path / "none.json")) == {}


def test_save_then_load_roundtrip(tmp_path):
    p = str(tmp_path / "tg.json")
    tc.save({"token": "123:ABC", "chat_id": "42"}, p)
    assert tc.load(p) == {"token": "123:ABC", "chat_id": "42"}


def test_save_is_chmod_600(tmp_path):
    p = str(tmp_path / "tg.json")
    tc.save({"token": "X", "chat_id": "1"}, p)
    assert stat.S_IMODE(os.stat(p).st_mode) == 0o600


def test_save_is_600_even_if_preexisting(tmp_path):
    p = str(tmp_path / "tg.json")
    with open(p, "w") as f:
        f.write("{}")
    os.chmod(p, 0o644)
    tc.save({"token": "X", "chat_id": "1"}, p)
    assert stat.S_IMODE(os.stat(p).st_mode) == 0o600


def test_clear_is_idempotent(tmp_path):
    p = str(tmp_path / "tg.json")
    tc.clear(p)            # absent -> no error
    tc.save({"token": "X", "chat_id": "1"}, p)
    tc.clear(p)
    assert not os.path.exists(p)


def test_public_view_masks_token():
    v = tc.public_view({"token": "123456:ABCDEF", "chat_id": "42"})
    assert v["configured"] is True
    assert v["chat_id"] == "42"
    assert v["token_masked"] == "····CDEF"
    assert "123456" not in str(v)       # le token brut ne sort jamais


def test_public_view_not_configured_without_chat_id():
    v = tc.public_view({"token": "123456:ABCDEF"})
    assert v["configured"] is False
