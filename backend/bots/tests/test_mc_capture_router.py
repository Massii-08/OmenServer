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
