"""Tests du module mc_agent_secrets — stockage des secrets par bot/groupe, chmod 600."""
import json
import os
import pytest


# ---------------------------------------------------------------------------
# Test imposé (Task 4 spec)
# ---------------------------------------------------------------------------

def test_secret_roundtrip_and_perms(tmp_path, monkeypatch):
    from backend.bots import mc_agent_secrets as K
    monkeypatch.setattr(K, "SECRETS_DIR", tmp_path)
    K.set_secret("grp1", "bot1", "monMdp")
    assert K.get_secret("grp1", "bot1") == "monMdp"
    assert K.has_secret("grp1", "bot1") is True
    assert K.has_secret("grp1", "absent") is False
    mode = (K._path("grp1").stat().st_mode & 0o777)
    assert mode == 0o600
    assert K.set_secret("bad id", "bot1", "x") is False   # _SAFE_ID


# ---------------------------------------------------------------------------
# Validation des IDs
# ---------------------------------------------------------------------------

def test_set_secret_invalid_bot_id(tmp_path, monkeypatch):
    from backend.bots import mc_agent_secrets as K
    monkeypatch.setattr(K, "SECRETS_DIR", tmp_path)
    assert K.set_secret("grp1", "bad bot", "x") is False
    assert K.set_secret("grp1", "Bot1", "x") is False
    assert K.set_secret("grp1", "", "x") is False


def test_set_secret_empty_group(tmp_path, monkeypatch):
    from backend.bots import mc_agent_secrets as K
    monkeypatch.setattr(K, "SECRETS_DIR", tmp_path)
    assert K.set_secret("", "bot1", "x") is False


def test_set_secret_invalid_secret_empty(tmp_path, monkeypatch):
    from backend.bots import mc_agent_secrets as K
    monkeypatch.setattr(K, "SECRETS_DIR", tmp_path)
    assert K.set_secret("grp1", "bot1", "") is False


def test_set_secret_invalid_secret_too_long(tmp_path, monkeypatch):
    from backend.bots import mc_agent_secrets as K
    monkeypatch.setattr(K, "SECRETS_DIR", tmp_path)
    assert K.set_secret("grp1", "bot1", "x" * 257) is False


def test_set_secret_invalid_secret_not_str(tmp_path, monkeypatch):
    from backend.bots import mc_agent_secrets as K
    monkeypatch.setattr(K, "SECRETS_DIR", tmp_path)
    assert K.set_secret("grp1", "bot1", 123) is False


# ---------------------------------------------------------------------------
# get_secret / has_secret — cas bords
# ---------------------------------------------------------------------------

def test_get_secret_missing_group(tmp_path, monkeypatch):
    from backend.bots import mc_agent_secrets as K
    monkeypatch.setattr(K, "SECRETS_DIR", tmp_path)
    assert K.get_secret("grp1", "bot1") is None


def test_get_secret_missing_bot_in_existing_group(tmp_path, monkeypatch):
    from backend.bots import mc_agent_secrets as K
    monkeypatch.setattr(K, "SECRETS_DIR", tmp_path)
    K.set_secret("grp1", "bot1", "secret")
    assert K.get_secret("grp1", "bot2") is None


def test_get_secret_invalid_ids_return_none(tmp_path, monkeypatch):
    from backend.bots import mc_agent_secrets as K
    monkeypatch.setattr(K, "SECRETS_DIR", tmp_path)
    assert K.get_secret("bad group", "bot1") is None
    assert K.get_secret("grp1", "bad bot") is None


def test_has_secret_invalid_ids_return_false(tmp_path, monkeypatch):
    from backend.bots import mc_agent_secrets as K
    monkeypatch.setattr(K, "SECRETS_DIR", tmp_path)
    assert K.has_secret("bad group", "bot1") is False
    assert K.has_secret("grp1", "bad bot") is False


# ---------------------------------------------------------------------------
# Plusieurs bots dans le même groupe
# ---------------------------------------------------------------------------

def test_multiple_bots_same_group(tmp_path, monkeypatch):
    from backend.bots import mc_agent_secrets as K
    monkeypatch.setattr(K, "SECRETS_DIR", tmp_path)
    K.set_secret("grp1", "bot1", "secret1")
    K.set_secret("grp1", "bot2", "secret2")
    assert K.get_secret("grp1", "bot1") == "secret1"
    assert K.get_secret("grp1", "bot2") == "secret2"
    # Un seul fichier JSON pour les deux
    assert len(list(tmp_path.iterdir())) == 1


def test_overwrite_secret(tmp_path, monkeypatch):
    from backend.bots import mc_agent_secrets as K
    monkeypatch.setattr(K, "SECRETS_DIR", tmp_path)
    K.set_secret("grp1", "bot1", "oldSecret")
    K.set_secret("grp1", "bot1", "newSecret")
    assert K.get_secret("grp1", "bot1") == "newSecret"


# ---------------------------------------------------------------------------
# delete_secret
# ---------------------------------------------------------------------------

def test_delete_secret_existing(tmp_path, monkeypatch):
    from backend.bots import mc_agent_secrets as K
    monkeypatch.setattr(K, "SECRETS_DIR", tmp_path)
    K.set_secret("grp1", "bot1", "secret")
    result = K.delete_secret("grp1", "bot1")
    assert result is True
    assert K.has_secret("grp1", "bot1") is False


def test_delete_secret_preserves_other_bots(tmp_path, monkeypatch):
    from backend.bots import mc_agent_secrets as K
    monkeypatch.setattr(K, "SECRETS_DIR", tmp_path)
    K.set_secret("grp1", "bot1", "s1")
    K.set_secret("grp1", "bot2", "s2")
    K.delete_secret("grp1", "bot1")
    assert K.has_secret("grp1", "bot2") is True
    assert K.has_secret("grp1", "bot1") is False


def test_delete_secret_absent_returns_false(tmp_path, monkeypatch):
    from backend.bots import mc_agent_secrets as K
    monkeypatch.setattr(K, "SECRETS_DIR", tmp_path)
    assert K.delete_secret("grp1", "absent") is False


def test_delete_secret_invalid_ids_return_false(tmp_path, monkeypatch):
    from backend.bots import mc_agent_secrets as K
    monkeypatch.setattr(K, "SECRETS_DIR", tmp_path)
    assert K.delete_secret("bad group", "bot1") is False
    assert K.delete_secret("grp1", "bad bot") is False


def test_delete_secret_file_stays_chmod600_after_rewrite(tmp_path, monkeypatch):
    """Après suppression d'un bot, le fichier réécrit doit rester chmod 600."""
    from backend.bots import mc_agent_secrets as K
    monkeypatch.setattr(K, "SECRETS_DIR", tmp_path)
    K.set_secret("grp1", "bot1", "s1")
    K.set_secret("grp1", "bot2", "s2")
    K.delete_secret("grp1", "bot1")
    mode = K._path("grp1").stat().st_mode & 0o777
    assert mode == 0o600


# ---------------------------------------------------------------------------
# delete_group_secrets
# ---------------------------------------------------------------------------

def test_delete_group_secrets_existing(tmp_path, monkeypatch):
    from backend.bots import mc_agent_secrets as K
    monkeypatch.setattr(K, "SECRETS_DIR", tmp_path)
    K.set_secret("grp1", "bot1", "s1")
    result = K.delete_group_secrets("grp1")
    assert result is True
    assert not K._path("grp1").exists()


def test_delete_group_secrets_absent_returns_false(tmp_path, monkeypatch):
    from backend.bots import mc_agent_secrets as K
    monkeypatch.setattr(K, "SECRETS_DIR", tmp_path)
    assert K.delete_group_secrets("grp1") is False


def test_delete_group_secrets_invalid_id_returns_false(tmp_path, monkeypatch):
    from backend.bots import mc_agent_secrets as K
    monkeypatch.setattr(K, "SECRETS_DIR", tmp_path)
    assert K.delete_group_secrets("bad group") is False


def test_delete_group_only_removes_target_group(tmp_path, monkeypatch):
    from backend.bots import mc_agent_secrets as K
    monkeypatch.setattr(K, "SECRETS_DIR", tmp_path)
    K.set_secret("grp1", "bot1", "s1")
    K.set_secret("grp2", "bot1", "s2")
    K.delete_group_secrets("grp1")
    assert K.has_secret("grp2", "bot1") is True
    assert not K._path("grp1").exists()


# ---------------------------------------------------------------------------
# Tolérance aux fichiers corrompus
# ---------------------------------------------------------------------------

def test_corrupted_file_is_overwritten(tmp_path, monkeypatch):
    """Un fichier JSON corrompu ne doit pas bloquer un set_secret."""
    from backend.bots import mc_agent_secrets as K
    monkeypatch.setattr(K, "SECRETS_DIR", tmp_path)
    # Écrire un JSON invalide directement
    corrupt = tmp_path / "grp1.json"
    corrupt.write_text("not-valid-json", encoding="utf-8")
    result = K.set_secret("grp1", "bot1", "newSecret")
    assert result is True
    assert K.get_secret("grp1", "bot1") == "newSecret"


def test_corrupted_file_get_returns_none(tmp_path, monkeypatch):
    """get_secret sur fichier corrompu → None sans crasher."""
    from backend.bots import mc_agent_secrets as K
    monkeypatch.setattr(K, "SECRETS_DIR", tmp_path)
    corrupt = tmp_path / "grp1.json"
    corrupt.write_text("not-valid-json", encoding="utf-8")
    assert K.get_secret("grp1", "bot1") is None


# ---------------------------------------------------------------------------
# _path helper
# ---------------------------------------------------------------------------

def test_path_helper(tmp_path, monkeypatch):
    from backend.bots import mc_agent_secrets as K
    monkeypatch.setattr(K, "SECRETS_DIR", tmp_path)
    p = K._path("grp1")
    assert p == tmp_path / "grp1.json"
