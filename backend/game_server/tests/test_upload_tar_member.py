"""
Test tar member traversal sur l'upload de fichiers (issue #6).

upload_file construisait tarfile.TarInfo(name=filename) avec le filename client.
Un filename "../../etc/x" écrirait hors /data DANS le conteneur. On vérifie qu'un
filename traversant est rejeté (400) AVANT toute interaction Docker, et qu'un
filename propre passe la validation (le gate manage est satisfait par l'owner).
"""

import io

import pytest

from backend.game_server.tests.conftest import build_client, OWNER_ID


def _client(user_id=OWNER_ID):
    from backend.game_server import files_router
    holder = {"id": user_id}
    client, _ = build_client(files_router.router, lambda: holder["id"])
    return client


EVIL_FILENAMES = [
    "../../etc/passwd",
    "../escape.txt",
    "sub/dir/file.txt",
    "/abs/path.txt",
    "..\\..\\win.txt",
    "..",
]


@pytest.mark.parametrize("fname", EVIL_FILENAMES)
def test_upload_rejects_traversing_filename(fname):
    client = _client()
    resp = client.post(
        "/api/servers/1/files/upload",
        data={"path": "/"},
        files={"file": (fname, b"pwned", "application/octet-stream")},
    )
    # Rejet de validation attendu (400). Surtout PAS 200 (= écrit) ni 500 via Docker.
    assert resp.status_code == 400, f"{fname!r} should be rejected, got {resp.status_code}: {resp.text}"


def test_upload_clean_filename_passes_validation():
    client = _client()
    resp = client.post(
        "/api/servers/1/files/upload",
        data={"path": "/"},
        files={"file": ("plugin.jar", b"x", "application/java-archive")},
    )
    # Nom propre → passe la validation, atteint Docker (indispo → 500). PAS un 400.
    assert resp.status_code != 400, f"clean filename wrongly rejected: {resp.text}"
