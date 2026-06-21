"""
Tests zip-slip / arbitrary-archive-selection sur backup_manager (issue #5).

restore_backup prenait `backup_id` brut → backup_path = backup_dir / f"{backup_id}.tar.gz"
(sélection d'archive arbitraire via `..`/`/`) puis tar.extractall SANS filtre
(Python 3.9 n'a pas filter="data") → un membre `../../etc/x` ou un symlink
écrirait hors du dossier d'extraction.

On teste :
  (a) validation de backup_id (rejet de `/`, `..`)
  (b) _safe_extract refuse les membres traversants / symlinks / absolus
"""

import io
import os
import tarfile
import tempfile
from pathlib import Path

import pytest

from backend.game_server import backup_manager


# ---------------------------------------------------------------------------
# (a) validation de backup_id
# ---------------------------------------------------------------------------

EVIL_IDS = [
    "../../../etc/passwd",
    "..%2f..%2fetc",
    "foo/bar",
    "/etc/shadow",
    "a/../../../b",
    "..",
    "foo\x00bar",
]


@pytest.mark.parametrize("bid", EVIL_IDS)
def test_restore_rejects_evil_backup_id(bid):
    # docker_id factice : la validation backup_id doit court-circuiter AVANT Docker.
    with pytest.raises(RuntimeError):
        backup_manager.restore_backup(1, bid, "deadbeef", backup_type="manual")


@pytest.mark.parametrize("bid", EVIL_IDS)
def test_delete_rejects_evil_backup_id(bid):
    with pytest.raises(RuntimeError):
        backup_manager.delete_backup(1, bid, backup_type="manual")


def test_valid_backup_id_passes_validation_but_not_found():
    # Un id valide mais inexistant → "non trouvée", PAS un rejet de validation.
    with pytest.raises(RuntimeError) as exc:
        backup_manager.restore_backup(1, "monbackup_20260101_120000", "deadbeef")
    assert "trouvée" in str(exc.value) or "trouv" in str(exc.value).lower()


# ---------------------------------------------------------------------------
# (b) _safe_extract refuse les membres malveillants
# ---------------------------------------------------------------------------

def _make_tar_with_member(member_name, *, symlink=False, linkname=None):
    """Construit un tar en mémoire avec un membre potentiellement malveillant."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        if symlink:
            info = tarfile.TarInfo(name=member_name)
            info.type = tarfile.SYMTYPE
            info.linkname = linkname or "/etc/passwd"
            tar.addfile(info)
        else:
            data = b"pwned"
            info = tarfile.TarInfo(name=member_name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    buf.seek(0)
    return buf


def test_safe_extract_helper_exists():
    assert hasattr(backup_manager, "_safe_extract"), "_safe_extract helper attendu"


def test_safe_extract_blocks_parent_traversal():
    buf = _make_tar_with_member("../../evil.txt")
    with tempfile.TemporaryDirectory() as dest:
        with tarfile.open(fileobj=buf, mode="r") as tar:
            with pytest.raises(Exception):
                backup_manager._safe_extract(tar, dest)
        # Le fichier ne doit PAS exister au-dessus de dest
        parent = Path(dest).resolve().parent
        assert not (parent / "evil.txt").exists()


def test_safe_extract_blocks_absolute_path():
    buf = _make_tar_with_member("/tmp/omen_zipslip_abs.txt")
    with tempfile.TemporaryDirectory() as dest:
        with tarfile.open(fileobj=buf, mode="r") as tar:
            with pytest.raises(Exception):
                backup_manager._safe_extract(tar, dest)
    assert not os.path.exists("/tmp/omen_zipslip_abs.txt")


def test_safe_extract_blocks_symlink():
    buf = _make_tar_with_member("link", symlink=True, linkname="/etc/passwd")
    with tempfile.TemporaryDirectory() as dest:
        with tarfile.open(fileobj=buf, mode="r") as tar:
            with pytest.raises(Exception):
                backup_manager._safe_extract(tar, dest)


def test_safe_extract_allows_clean_member():
    buf = _make_tar_with_member("world/level.dat")
    with tempfile.TemporaryDirectory() as dest:
        with tarfile.open(fileobj=buf, mode="r") as tar:
            backup_manager._safe_extract(tar, dest)
        assert (Path(dest) / "world" / "level.dat").exists()
