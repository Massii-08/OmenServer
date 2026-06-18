import pytest

from backend.bots.harvester.llm import _claude, extract_json


class FakeProc(object):
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def test_extract_json_finds_object_in_noise():
    assert extract_json('prefix {"a": 1, "b": [2, 3]} suffix') == {"a": 1, "b": [2, 3]}


def test_extract_json_raises_when_absent():
    with pytest.raises(ValueError):
        extract_json("no json here")


def test_claude_parses_envelope_result():
    captured = {}

    def fake_run(cmd, input=None, capture_output=None, text=None, timeout=None):
        captured["cmd"] = cmd
        captured["input"] = input
        return FakeProc(0, stdout='{"is_error": false, "result": "here: {\\"recipe\\": 1}"}')

    out = _claude("do it", run=fake_run)
    assert out == {"recipe": 1}
    assert captured["cmd"][:4][-3:] == ["-p", "--output-format", "json"]
    assert captured["input"] == "do it"


def test_claude_passes_model_flag():
    def fake_run(cmd, **kw):
        assert "--model" in cmd and "claude-haiku-4-5-20251001" in cmd
        return FakeProc(0, stdout='{"result": "{\\"x\\": 1}"}')

    assert _claude("p", model="claude-haiku-4-5-20251001", run=fake_run) == {"x": 1}


def test_claude_raises_on_nonzero_rc():
    def fake_run(cmd, **kw):
        return FakeProc(2, stdout="", stderr="boom")
    with pytest.raises(RuntimeError):
        _claude("p", run=fake_run)


def test_claude_raises_on_is_error_envelope():
    def fake_run(cmd, **kw):
        return FakeProc(0, stdout='{"is_error": true, "result": "model refused"}')
    with pytest.raises(RuntimeError):
        _claude("p", run=fake_run)
