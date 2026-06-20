"""Tests du garde d'autorisation factorisé require_resource_access.

Lève HTTPException(403) quand l'utilisateur n'a pas le niveau requis sur la
ressource — utilisé par les sous-routers serveur (files/settings/players/...)
qui faisaient leur lookup SANS vérifier l'ownership (IDOR).
"""
import pytest
from fastapi import HTTPException

from backend.auth import access_control as ac


class _FakeUser(object):
    def __init__(self, uid, is_admin=False, role="player"):
        self.id = uid
        self.is_admin = is_admin
        self.role = role


def _patch_access(monkeypatch, *, owner_id=None, shared_level=None):
    """Neutralise la couche DB : on pilote owner/shared directement."""
    def fake_is_owner(user, rtype, rid, db):
        return owner_id is not None and user.id == owner_id

    class _Shared(object):
        access_level = shared_level

    def fake_get_shared(user, rtype, rid, db):
        return _Shared() if shared_level is not None else None

    monkeypatch.setattr(ac, "is_owner", fake_is_owner)
    monkeypatch.setattr(ac, "get_shared_access", fake_get_shared)


def test_admin_passes(monkeypatch):
    _patch_access(monkeypatch)
    ac.require_resource_access(_FakeUser(1, is_admin=True), "server", 9, db=None,
                               min_level="manage")  # ne lève pas


def test_owner_passes(monkeypatch):
    _patch_access(monkeypatch, owner_id=7)
    ac.require_resource_access(_FakeUser(7), "server", 9, db=None, min_level="manage")


def test_shared_manage_passes_for_manage(monkeypatch):
    _patch_access(monkeypatch, shared_level="manage")
    ac.require_resource_access(_FakeUser(3), "server", 9, db=None, min_level="manage")


def test_shared_view_only_denied_for_manage(monkeypatch):
    _patch_access(monkeypatch, shared_level="view_only")
    with pytest.raises(HTTPException) as e:
        ac.require_resource_access(_FakeUser(3), "server", 9, db=None, min_level="manage")
    assert e.value.status_code == 403


def test_no_access_denied(monkeypatch):
    _patch_access(monkeypatch)  # ni owner ni shared
    with pytest.raises(HTTPException) as e:
        ac.require_resource_access(_FakeUser(3), "server", 9, db=None, min_level="view_only")
    assert e.value.status_code == 403
