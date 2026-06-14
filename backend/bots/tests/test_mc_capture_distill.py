"""Tests de la distillation .jsonl → style.json + clips (Phase 1b.1)."""
from pathlib import Path

import pytest

from backend.bots import mc_capture_distill as distill

FIXTURE = Path(__file__).parent / "fixtures" / "capture_sample.jsonl"


def test_load_records_separates_header_and_events():
    header, records = distill.load_records(FIXTURE.read_bytes())
    assert header["player"] == "Massii_08"
    assert len(records) >= 5
    assert any(r["type"] == "tick" for r in records)
    assert any(r["type"] == "chat_out" for r in records)


def test_distill_style_has_canonical_shape():
    style = distill.distill_style([FIXTURE.read_bytes()], player="Massii_08")
    # forme canonique (spec §7.1) — 1:1 avec humanize.js
    assert style["player"] == "Massii_08"
    assert "reaction" in style and {"meanMs", "stdMs", "n"} <= set(style["reaction"])
    assert "chat" in style and {"latencyMeanMs", "latencyStdMs", "typoRate"} <= set(style["chat"])
    assert "errorRate" in style
    dp = style["derivedParams"]
    assert {"chat", "errorRate", "movementJitter"} <= set(dp)
    assert {"latencyMeanMs", "latencyStdMs", "typoRate"} <= set(dp["chat"])


def test_derived_params_chat_mirrors_chat_block():
    style = distill.distill_style([FIXTURE.read_bytes()], player="Massii_08")
    assert style["derivedParams"]["chat"]["latencyMeanMs"] == style["chat"]["latencyMeanMs"]


def test_chat_latency_measured_from_in_to_out():
    # chat_in à t=3000, chat_out à t=5600 → latence ~2600ms
    style = distill.distill_style([FIXTURE.read_bytes()], player="Massii_08")
    assert 2000 <= style["chat"]["latencyMeanMs"] <= 3200


def test_segment_clips_tags_by_context():
    _, records = distill.load_records(FIXTURE.read_bytes())
    clips = distill.segment_clips(records, player="Massii_08")
    assert isinstance(clips, list) and len(clips) >= 1
    for c in clips:
        assert c["ctx"] in ("locomotion", "turn", "idle", "mine", "combat")
        assert c["player"] == "Massii_08"
        assert isinstance(c["frames"], list) and len(c["frames"]) >= 1
        for f in c["frames"]:
            assert "in" in f and "dyaw" in f and "dpitch" in f


def test_combat_clip_detected_around_attack():
    _, records = distill.load_records(FIXTURE.read_bytes())
    clips = distill.segment_clips(records, player="Massii_08")
    assert any(c["ctx"] == "combat" for c in clips)


def test_distill_empty_returns_safe_defaults():
    style = distill.distill_style([], player="Nobody")
    assert style["player"] == "Nobody"
    assert style["derivedParams"]["chat"]["latencyMeanMs"] > 0  # défaut sain, pas 0


def _synthetic_session(blocks=12):
    """Payload .jsonl synthétique alternant locomotion/idle → beaucoup de clips courts."""
    import json as _json
    lines = [_json.dumps({"schema": 1, "player": "P", "mc": "1.21", "mod": "t",
                          "consent": True, "startedAt": 0, "sampleHz": 20})]
    t = 0
    x = 0.0
    for blk in range(blocks):
        moving = blk % 2 == 0
        for _ in range(4):
            t += 50
            if moving:
                x += 1.0
            lines.append(_json.dumps({"t": t, "type": "tick",
                                      "in": ({"sprint": 1, "fwd": 1} if moving else {}),
                                      "yaw": x * 0.1, "pitch": 0, "pos": [x, 70, 0],
                                      "vel": [1 if moving else 0, 0, 0], "og": True,
                                      "hp": 20, "food": 20, "held": "minecraft:air"}))
    return "\n".join(lines)


def test_distill_caps_clips_per_ctx(tmp_path):
    """max_per_ctx tronque chaque contexte à un échantillon représentatif (clips légers, fleet)."""
    import json as _json
    pf = tmp_path / "session-1.jsonl"
    pf.write_text(_synthetic_session(12))
    out = tmp_path / "out"
    r = distill.distill_to_dir([str(pf)], str(out), "P", max_per_ctx=2)
    assert r["max_per_ctx"] == 2
    assert r["capped"], "le rapport capped doit lister les ctx tronqués (pas de cap silencieux)"
    for f in (out / "clips").glob("*.json"):
        assert len(_json.loads(f.read_text())) <= 2


def test_distill_no_cap_when_zero(tmp_path):
    """max_per_ctx=0 → aucun cap (rétro-compat distillation complète)."""
    pf = tmp_path / "session-1.jsonl"
    pf.write_text(_synthetic_session(12))
    r = distill.distill_to_dir([str(pf)], str(tmp_path / "out0"), "P", max_per_ctx=0)
    assert r["capped"] == {}
