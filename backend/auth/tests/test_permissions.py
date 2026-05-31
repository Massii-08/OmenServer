"""Tests RBAC du rôle REC-testeur (accès capture only)."""
from backend.auth import permissions as perms


class _U:
    def __init__(self, role, is_admin=False):
        self.role = role
        self.is_admin = is_admin


def test_rectester_is_a_valid_role():
    assert "rectester" in perms.VALID_ROLES
    assert perms.ROLE_NAMES.get("rectester")


def test_rectester_has_mc_capture_permission():
    assert perms.has_permission(_U("rectester"), "mc_capture") is True
    assert perms.has_permission(_U("rectester"), "view") is True


def test_rectester_cannot_admin_things():
    u = _U("rectester")
    for forbidden in ("settings", "manage_users", "start", "create_bot", "yield_bot"):
        assert perms.has_permission(u, forbidden) is False, forbidden


def test_admin_keeps_mc_capture():
    assert perms.has_permission(_U("admin", is_admin=True), "mc_capture") is True


def test_other_roles_lack_mc_capture():
    for role in ("player", "money", "moderator", "developer", "spectator"):
        assert perms.has_permission(_U(role), "mc_capture") is False, role
