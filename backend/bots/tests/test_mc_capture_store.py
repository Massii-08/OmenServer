"""Tests du stockage des captures comportementales (Phase 1b.1)."""
import json
import pytest

from backend.bots import mc_capture_store as store


@pytest.fixture
def tmp_root(tmp_path, monkeypatch):
    """Redirige la racine de stockage vers un dossier temporaire."""
    monkeypatch.setattr(store, "CAPTURES_DIR", tmp_path / "mc-captures")
    return tmp_path / "mc-captures"


def _valid_jsonl(player="Massii_08"):
    header = {"schema": 1, "player": player, "mc": "1.21.4", "mod": "0.1.0",
              "consent": True, "startedAt": 1748540000000, "sampleHz": 20}
    tick = {"t": 0, "type": "tick", "in": {"fwd": 1}, "yaw": 1.0, "pitch": 0.0,
            "pos": [0, 64, 0], "vel": [0, 0, 0], "og": 1, "hp": 20, "food": 20, "held": "air"}
    return (json.dumps(header) + "\n" + json.dumps(tick) + "\n").encode("utf-8")


def test_parse_header_extracts_player(tmp_root):
    header = store.parse_header(_valid_jsonl("Bob"))
    assert header["player"] == "Bob"
    assert header["schema"] == 1


def test_parse_header_rejects_missing_consent(tmp_root):
    bad = json.dumps({"schema": 1, "player": "X"}).encode() + b"\n"
    with pytest.raises(ValueError, match="consent"):
        store.parse_header(bad)


def test_parse_header_rejects_bad_schema(tmp_root):
    bad = json.dumps({"schema": 99, "player": "X", "consent": True}).encode() + b"\n"
    with pytest.raises(ValueError, match="schema"):
        store.parse_header(bad)


def test_parse_header_rejects_empty(tmp_root):
    with pytest.raises(ValueError):
        store.parse_header(b"")


def test_save_capture_writes_under_player_dir(tmp_root):
    info = store.save_capture(_valid_jsonl("Massii_08"), "session-1.jsonl")
    assert info["player"] == "Massii_08"
    saved = tmp_root / "Massii_08" / "session-1.jsonl"
    assert saved.is_file()


def test_save_capture_sanitizes_player_name(tmp_root):
    # un player avec des caractères de chemin ne doit pas s'échapper du dossier
    payload = _valid_jsonl("../../etc")
    info = store.save_capture(payload, "s.jsonl")
    # le dossier réel reste sous CAPTURES_DIR
    assert tmp_root in (tmp_root / info["player"]).resolve().parents or \
           (tmp_root / info["player"]).resolve() == (tmp_root / info["player"])
    assert "/" not in info["player"] and ".." not in info["player"]


def test_list_captures_groups_by_player(tmp_root):
    store.save_capture(_valid_jsonl("Bob"), "s1.jsonl")
    store.save_capture(_valid_jsonl("Bob"), "s2.jsonl")
    store.save_capture(_valid_jsonl("Alice"), "s1.jsonl")
    listing = store.list_captures()
    by_player = {p["player"]: p for p in listing}
    assert by_player["Bob"]["sessions"] == 2
    assert by_player["Alice"]["sessions"] == 1


def test_delete_session_removes_one_file(tmp_root):
    store.save_capture(_valid_jsonl("Bob"), "s1.jsonl")
    store.save_capture(_valid_jsonl("Bob"), "s2.jsonl")
    assert store.delete_capture("Bob", "s1.jsonl") is True
    assert not (tmp_root / "Bob" / "s1.jsonl").exists()
    assert (tmp_root / "Bob" / "s2.jsonl").exists()


def test_delete_player_removes_all(tmp_root):
    store.save_capture(_valid_jsonl("Bob"), "s1.jsonl")
    assert store.delete_capture("Bob", None) is True
    assert not (tmp_root / "Bob").exists()


def test_delete_unknown_returns_false(tmp_root):
    assert store.delete_capture("Ghost", None) is False
