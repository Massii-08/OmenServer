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


import json as _json
import httpx

from backend.bots.harvester import notify


def test_send_posts_to_telegram_api():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["json"] = _json.loads(request.content)
        return httpx.Response(200, json={"ok": True})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    ok = notify.send("hello", {"token": "TKN", "chat_id": "CID"}, client=client)
    assert ok is True
    assert "/botTKN/sendMessage" in seen["url"]
    assert seen["json"] == {"chat_id": "CID", "text": "hello"}


def test_send_returns_false_without_config():
    assert notify.send("x", {}, client=httpx.Client(
        transport=httpx.MockTransport(lambda r: httpx.Response(200)))) is False


def test_send_swallows_errors_and_returns_false():
    def boom(request):
        raise httpx.ConnectError("down")
    client = httpx.Client(transport=httpx.MockTransport(boom))
    assert notify.send("x", {"token": "T", "chat_id": "C"}, client=client) is False


def test_send_returns_false_on_http_error_status():
    client = httpx.Client(transport=httpx.MockTransport(
        lambda r: httpx.Response(403, json={"ok": False})))
    assert notify.send("x", {"token": "T", "chat_id": "C"}, client=client) is False


# --------------------------------------------------------------------------- #
#  Le jeton ne doit JAMAIS finir dans les logs système
#
#  Mesuré en prod (journalctl) : « httpx | HTTP Request: POST
#  https://api.telegram.org/bot<TOKEN>/sendMessage » — httpx logge l'URL
#  COMPLÈTE en INFO, or l'URL Telegram porte le jeton du bot.
# --------------------------------------------------------------------------- #

import importlib
import logging


def test_importer_notify_fait_taire_les_logs_httpx_de_niveau_info():
    assert logging.getLogger("httpx").getEffectiveLevel() >= logging.WARNING


def test_le_module_repose_le_niveau_meme_si_quelquun_l_a_rabaisse():
    """Preuve que c'est bien CE module qui pose le garde-fou (et pas un état
    hérité d'un autre import de la session de test) : on rabaisse le logger à
    INFO, on recharge le module, il doit être remonté."""
    httpx_logger = logging.getLogger("httpx")
    previous = httpx_logger.level
    try:
        httpx_logger.setLevel(logging.INFO)
        assert httpx_logger.getEffectiveLevel() == logging.INFO   # bien rabaissé
        importlib.reload(notify)
        assert httpx_logger.getEffectiveLevel() >= logging.WARNING
    finally:
        httpx_logger.setLevel(max(previous, logging.WARNING))


def test_aucune_url_telegram_n_est_loguee_pendant_un_envoi():
    """Ceinture : pendant un envoi réel (transport bouchonné), RIEN ne doit
    passer par logging avec le jeton ou l'hôte de l'API."""
    records = []

    class _Catch(logging.Handler):
        def emit(self, record):
            records.append(record.getMessage())

    handler = _Catch()
    root = logging.getLogger()
    root.addHandler(handler)
    previous_level = root.level
    root.setLevel(logging.DEBUG)
    try:
        client = httpx.Client(transport=httpx.MockTransport(
            lambda r: httpx.Response(200, json={"ok": True})))
        assert notify.send("x", {"token": "SECRET-TOKEN", "chat_id": "C"},
                           client=client) is True
    finally:
        root.removeHandler(handler)
        root.setLevel(previous_level)

    assert not any("SECRET-TOKEN" in msg for msg in records)
    assert not any("api.telegram.org" in msg for msg in records)
