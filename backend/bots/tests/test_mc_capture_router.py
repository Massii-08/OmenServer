"""Tests des endpoints capture (admin-only) — Phase 1b.1."""
import io
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.bots import mc_capture_router as cap
from backend.auth.utils import get_current_user


class _User:
    def __init__(self, is_admin):
        self.is_admin = is_admin
        self.username = "tester"


def _app(admin=True):
    app = FastAPI()
    app.include_router(cap.router)
    app.dependency_overrides[get_current_user] = lambda: _User(admin)
    return app


def _app_role(role, is_admin=False):
    from fastapi import FastAPI
    app = FastAPI()
    app.include_router(cap.router)
    class _U:
        def __init__(self): self.role = role; self.is_admin = is_admin; self.username = "tester1"
    app.dependency_overrides[get_current_user] = lambda: _U()
    return app


@pytest.fixture(autouse=True)
def tmp_root(tmp_path, monkeypatch):
    from backend.bots import mc_capture_store as store
    monkeypatch.setattr(store, "CAPTURES_DIR", tmp_path / "mc-captures")
    return tmp_path / "mc-captures"


def _jsonl(player="Massii_08"):
    header = {"schema": 1, "player": player, "mc": "1.21.4", "mod": "0.1.0",
              "consent": True, "startedAt": 1748540000000, "sampleHz": 20}
    tick = {"t": 0, "type": "tick", "in": {"fwd": 1}, "yaw": 1.0, "pitch": 0.0,
            "pos": [0, 64, 0], "vel": [0, 0, 0], "og": 1, "hp": 20, "food": 20, "held": "air"}
    return (json.dumps(header) + "\n" + json.dumps(tick) + "\n").encode()


def test_upload_requires_admin():
    client = TestClient(_app(admin=False))
    files = {"file": ("s.jsonl", io.BytesIO(_jsonl()), "application/octet-stream")}
    r = client.post("/api/mc-agent/captures", files=files)
    assert r.status_code == 403


def test_upload_stores_and_returns_player():
    client = TestClient(_app(admin=True))
    files = {"file": ("s.jsonl", io.BytesIO(_jsonl("Bob")), "application/octet-stream")}
    r = client.post("/api/mc-agent/captures", files=files)
    assert r.status_code == 200
    assert r.json()["player"] == "Bob"


def test_upload_rejects_bad_header():
    client = TestClient(_app(admin=True))
    bad = json.dumps({"schema": 1, "player": "X"}).encode() + b"\n"  # consent manquant
    files = {"file": ("s.jsonl", io.BytesIO(bad), "application/octet-stream")}
    r = client.post("/api/mc-agent/captures", files=files)
    assert r.status_code == 400


def test_list_captures_admin_only():
    client = TestClient(_app(admin=False))
    assert client.get("/api/mc-agent/captures").status_code == 403


def test_list_after_upload():
    client = TestClient(_app(admin=True))
    client.post("/api/mc-agent/captures",
                files={"file": ("s.jsonl", io.BytesIO(_jsonl("Bob")), "application/octet-stream")})
    r = client.get("/api/mc-agent/captures")
    assert r.status_code == 200
    assert any(p["player"] == "Bob" for p in r.json()["captures"])


def test_distill_then_get_style():
    client = TestClient(_app(admin=True))
    client.post("/api/mc-agent/captures",
                files={"file": ("s.jsonl", io.BytesIO(_jsonl("Bob")), "application/octet-stream")})
    d = client.post("/api/mc-agent/captures/Bob/distill")
    assert d.status_code == 200
    s = client.get("/api/mc-agent/captures/Bob/style")
    assert s.status_code == 200
    assert s.json()["player"] == "Bob"
    assert "derivedParams" in s.json()


def test_delete_player():
    client = TestClient(_app(admin=True))
    client.post("/api/mc-agent/captures",
                files={"file": ("s.jsonl", io.BytesIO(_jsonl("Bob")), "application/octet-stream")})
    assert client.delete("/api/mc-agent/captures/Bob").status_code == 200
    r = client.get("/api/mc-agent/captures")
    assert all(p["player"] != "Bob" for p in r.json()["captures"])


def test_rectester_can_upload(tmp_root):
    from fastapi.testclient import TestClient
    client = TestClient(_app_role("rectester"))
    files = {"file": ("s.jsonl", io.BytesIO(_jsonl("BobMC")), "application/octet-stream")}
    r = client.post("/api/mc-agent/captures", files=files)
    assert r.status_code == 200
    assert r.json()["owner"] == "tester1"


def test_rectester_list_is_filtered_to_own(tmp_root):
    from fastapi.testclient import TestClient
    c1 = TestClient(_app_role("rectester"))
    c1.post("/api/mc-agent/captures", files={"file": ("s.jsonl", io.BytesIO(_jsonl("BobMC")), "application/octet-stream")})
    ca = TestClient(_app(admin=True))
    ca.post("/api/mc-agent/captures", files={"file": ("s.jsonl", io.BytesIO(_jsonl("AliceMC")), "application/octet-stream")})
    r = c1.get("/api/mc-agent/captures")
    players = {p["player"] for p in r.json()["captures"]}
    assert players == {"BobMC"}


def test_rectester_cannot_distill(tmp_root):
    from fastapi.testclient import TestClient
    client = TestClient(_app_role("rectester"))
    client.post("/api/mc-agent/captures", files={"file": ("s.jsonl", io.BytesIO(_jsonl("BobMC")), "application/octet-stream")})
    assert client.post("/api/mc-agent/captures/BobMC/distill").status_code == 403


def test_rectester_cannot_get_style(tmp_root):
    from fastapi.testclient import TestClient
    assert TestClient(_app_role("rectester")).get("/api/mc-agent/captures/BobMC/style").status_code == 403


def test_player_role_cannot_upload(tmp_root):
    from fastapi.testclient import TestClient
    client = TestClient(_app_role("player"))
    files = {"file": ("s.jsonl", io.BytesIO(_jsonl("BobMC")), "application/octet-stream")}
    assert client.post("/api/mc-agent/captures", files=files).status_code == 403


def test_rectester_delete_own_ok_other_403(tmp_root):
    from fastapi.testclient import TestClient
    c1 = TestClient(_app_role("rectester"))
    c1.post("/api/mc-agent/captures", files={"file": ("s.jsonl", io.BytesIO(_jsonl("BobMC")), "application/octet-stream")})
    TestClient(_app(admin=True)).post("/api/mc-agent/captures",
        files={"file": ("s.jsonl", io.BytesIO(_jsonl("AliceMC")), "application/octet-stream")})
    assert c1.delete("/api/mc-agent/captures/BobMC/s.jsonl").status_code == 200
    assert c1.delete("/api/mc-agent/captures/AliceMC/s.jsonl").status_code == 403


def test_download_mod_versions(tmp_root):
    from fastapi.testclient import TestClient
    client = TestClient(_app_role("rectester"))
    lst = client.get("/api/mc-agent/mod")
    assert lst.status_code == 200
    assert any("1.21" in v["version"] for v in lst.json()["versions"])
    dl = client.get("/api/mc-agent/mod/1.21.4")
    assert dl.status_code == 200


def test_download_mod_rejects_bad_version(tmp_root):
    from fastapi.testclient import TestClient
    assert TestClient(_app_role("rectester")).get("/api/mc-agent/mod/9.9.9").status_code == 404


def test_download_mod_path_traversal_blocked(tmp_root):
    from fastapi.testclient import TestClient
    r = TestClient(_app_role("rectester")).get("/api/mc-agent/mod/..%2F..%2Fetc%2Fpasswd")
    assert r.status_code in (404, 400)
