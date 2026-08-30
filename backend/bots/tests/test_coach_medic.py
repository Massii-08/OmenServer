"""Tests de ``tools/coach_medic.py`` — 100 % hors ligne.

Le script n'est PAS un module du paquet ``backend`` (il doit rester
diagnostiquable même si ``backend`` est cassé, cf. tête de fichier du
script) : il est chargé ici via ``importlib`` depuis son chemin réel.
"""
import importlib.util
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

_TOOLS_DIR = Path(__file__).resolve().parents[3] / "tools"
_SPEC = importlib.util.spec_from_file_location(
    "coach_medic", str(_TOOLS_DIR / "coach_medic.py"))
medic = importlib.util.module_from_spec(_SPEC)
sys.modules["coach_medic"] = medic
_SPEC.loader.exec_module(medic)


# --------------------------------------------------------------------------- #
# détection — panne LLM (coach.ledger.json)
# --------------------------------------------------------------------------- #

def _row(action, accepted, reason=None):
    return {"ts": "2026-08-30T10:00:00", "action": action,
           "accepted": accepted, "reason": reason, "symbol": "", "detail": None}


def test_detect_llm_failure_none_when_ledger_is_healthy():
    rows = [_row("hold", True), _row("buy", True)]
    assert medic.detect_llm_failure(rows) is None


def test_detect_llm_failure_on_two_consecutive_llm_failed():
    rows = [_row("pass", False, "llm_failed"), _row("pass", False, "llm_failed")]
    out = medic.detect_llm_failure(rows)
    assert out is not None
    assert out.code == medic.FAIL_LLM


def test_detect_llm_failure_on_two_consecutive_parse_failed():
    rows = [_row("parse", False, "parse_failed"), _row("parse", False, "parse_failed")]
    assert medic.detect_llm_failure(rows) is not None


def test_detect_llm_failure_none_when_only_one_of_two_is_a_failure():
    rows = [_row("pass", False, "llm_failed"), _row("hold", True)]
    assert medic.detect_llm_failure(rows) is None


def test_detect_llm_failure_none_with_fewer_than_two_rows():
    assert medic.detect_llm_failure([_row("pass", False, "llm_failed")]) is None
    assert medic.detect_llm_failure([]) is None
    assert medic.detect_llm_failure(None) is None


def test_detect_llm_failure_ignores_a_stale_failure_further_back():
    """Seules les DEUX PLUS RÉCENTES comptent (tête de liste — le registre est
    le plus récent d'abord)."""
    rows = [_row("hold", True), _row("hold", True),
           _row("pass", False, "llm_failed"), _row("pass", False, "llm_failed")]
    assert medic.detect_llm_failure(rows) is None


def test_detect_llm_failure_signature_is_stable():
    rows = [_row("pass", False, "llm_failed"), _row("pass", False, "llm_failed")]
    a = medic.detect_llm_failure(rows)
    b = medic.detect_llm_failure(list(rows))
    assert a.signature == b.signature


# --------------------------------------------------------------------------- #
# détection — planificateur mort (coach_trader.state.json)
# --------------------------------------------------------------------------- #

MONDAY_NOON = datetime(2026, 8, 24, 12, 0, tzinfo=timezone.utc)


def test_detect_planner_dead_none_when_state_is_absent():
    """Aucune donnée -> pas de panne INVENTÉE (fraîche installation)."""
    assert medic.detect_planner_dead({}, MONDAY_NOON) is None
    assert medic.detect_planner_dead(None, MONDAY_NOON) is None


def test_detect_planner_dead_none_when_the_last_pass_is_recent():
    state = {"last_pass": (MONDAY_NOON - timedelta(hours=2)).isoformat()}
    assert medic.detect_planner_dead(state, MONDAY_NOON) is None


def test_detect_planner_dead_fires_after_36_business_hours():
    # Vendredi 12h -> lundi 12h : 3 jours calendaires, mais seulement 2 jours
    # OUVRÉS pleins (vendredi après-midi + lundi matin) = bien plus de 36h
    # ouvrées ne se sont PAS écoulées en semaine normale... on force un cas
    # sans ambiguïté : 5 jours ouvrés pleins en arrière.
    old = MONDAY_NOON - timedelta(days=7)   # lundi précédent, 12h
    state = {"last_pass": old.isoformat()}
    out = medic.detect_planner_dead(state, MONDAY_NOON)
    assert out is not None
    assert out.code == medic.FAIL_PLANNER_DEAD


def test_detect_planner_dead_a_weekend_does_not_count_as_business_hours():
    """Vendredi 12h -> lundi 12h = 72h calendaires mais seulement 24h
    OUVRÉES (le week-end ne compte pas) -> pas encore de panne."""
    friday_noon = datetime(2026, 8, 21, 12, 0, tzinfo=timezone.utc)
    state = {"last_pass": friday_noon.isoformat()}
    assert medic.detect_planner_dead(state, MONDAY_NOON) is None


# --------------------------------------------------------------------------- #
# détection — cycle de veille figé (newswatch_global.json)
# --------------------------------------------------------------------------- #

def test_detect_newswatch_stuck_none_when_mtime_is_absent():
    assert medic.detect_newswatch_stuck(None, MONDAY_NOON) is None


def test_detect_newswatch_stuck_none_when_recent():
    mtime = MONDAY_NOON - timedelta(minutes=10)
    assert medic.detect_newswatch_stuck(mtime, MONDAY_NOON) is None


def test_detect_newswatch_stuck_fires_past_45_minutes():
    mtime = MONDAY_NOON - timedelta(minutes=46)
    out = medic.detect_newswatch_stuck(mtime, MONDAY_NOON)
    assert out is not None
    assert out.code == medic.FAIL_NEWSWATCH_STUCK


# --------------------------------------------------------------------------- #
# détection — panne de code (traceback backend/bots/paper dans journalctl)
# --------------------------------------------------------------------------- #

_CLEAN_JOURNAL = (
    "Aug 30 10:00:00 omen omenserver[123]: paper coach_trader: tick OK\n"
    "Aug 30 10:00:05 omen omenserver[123]: INFO: 127.0.0.1 - \"GET / HTTP/1.1\" 200\n"
)

_PAPER_TRACEBACK_JOURNAL = (
    "Aug 30 10:00:00 omen omenserver[123]: some earlier line\n"
    "Traceback (most recent call last):\n"
    "  File \"/home/massii08/paper-dev/backend/bots/paper/coach_trader.py\", line 900, in maybe_run\n"
    "    (pass_fn or _default_pass)(local_iso, crypto_only)\n"
    "  File \"/home/massii08/paper-dev/backend/bots/paper_router.py\", line 2340, in run_coach_daily_pass\n"
    "    raise RuntimeError(\"boom\")\n"
    "RuntimeError: boom\n"
    "Aug 30 10:00:01 omen omenserver[123]: some later line\n"
)

_UNRELATED_TRACEBACK_JOURNAL = (
    "Traceback (most recent call last):\n"
    "  File \"/home/massii08/paper-dev/backend/game_server/router.py\", line 12, in start\n"
    "    raise OSError(\"docker down\")\n"
    "OSError: docker down\n"
)


def test_detect_code_error_none_on_a_clean_journal():
    assert medic.detect_code_error(_CLEAN_JOURNAL) is None
    assert medic.detect_code_error("") is None
    assert medic.detect_code_error(None) is None


def test_detect_code_error_none_when_traceback_is_unrelated():
    assert medic.detect_code_error(_UNRELATED_TRACEBACK_JOURNAL) is None


def test_detect_code_error_fires_on_a_paper_traceback():
    out = medic.detect_code_error(_PAPER_TRACEBACK_JOURNAL)
    assert out is not None
    assert out.code == medic.FAIL_CODE_ERROR
    assert "RuntimeError" in out.detail


def test_detect_code_error_signature_distinguishes_different_exceptions():
    other = _PAPER_TRACEBACK_JOURNAL.replace("RuntimeError: boom", "ValueError: autre chose")
    a = medic.detect_code_error(_PAPER_TRACEBACK_JOURNAL)
    b = medic.detect_code_error(other)
    assert a.signature != b.signature


def test_detect_code_error_signature_is_stable_for_the_same_exception():
    a = medic.detect_code_error(_PAPER_TRACEBACK_JOURNAL)
    b = medic.detect_code_error(_PAPER_TRACEBACK_JOURNAL)
    assert a.signature == b.signature


# --------------------------------------------------------------------------- #
# garde-fous — cooldown par signature, plafond quotidien, kill-switch
# --------------------------------------------------------------------------- #

def _session(signature, ts, kind="repair"):
    return {"signature": signature, "ts": ts, "kind": kind}


def test_already_handled_true_within_the_cooldown():
    history = [_session("llm_failed:abc", (MONDAY_NOON - timedelta(hours=2)).isoformat())]
    assert medic.already_handled(history, "llm_failed:abc", MONDAY_NOON) is True


def test_already_handled_false_past_the_cooldown():
    history = [_session("llm_failed:abc", (MONDAY_NOON - timedelta(hours=25)).isoformat())]
    assert medic.already_handled(history, "llm_failed:abc", MONDAY_NOON) is False


def test_already_handled_false_for_a_different_signature():
    history = [_session("llm_failed:abc", MONDAY_NOON.isoformat())]
    assert medic.already_handled(history, "llm_failed:xyz", MONDAY_NOON) is False


def test_already_handled_false_on_an_empty_history():
    assert medic.already_handled([], "llm_failed:abc", MONDAY_NOON) is False
    assert medic.already_handled(None, "llm_failed:abc", MONDAY_NOON) is False


def test_daily_cap_not_reached_below_two_sessions():
    history = [_session("a", MONDAY_NOON.isoformat())]
    assert medic.daily_cap_reached(history, MONDAY_NOON) is False


def test_daily_cap_reached_at_two_sessions_within_24h():
    history = [_session("a", (MONDAY_NOON - timedelta(hours=1)).isoformat()),
              _session("b", (MONDAY_NOON - timedelta(hours=2)).isoformat())]
    assert medic.daily_cap_reached(history, MONDAY_NOON) is True


def test_daily_cap_ignores_sessions_older_than_24h():
    history = [_session("a", (MONDAY_NOON - timedelta(hours=1)).isoformat()),
              _session("b", (MONDAY_NOON - timedelta(hours=30)).isoformat())]
    assert medic.daily_cap_reached(history, MONDAY_NOON) is False


def test_kill_switch_active_true_when_the_file_exists(tmp_path):
    flag = tmp_path / "coach-medic.disabled"
    flag.write_text("", encoding="utf-8")
    assert medic.kill_switch_active(flag) is True


def test_kill_switch_active_false_when_absent(tmp_path):
    assert medic.kill_switch_active(tmp_path / "absent") is False


# --------------------------------------------------------------------------- #
# dossier de panne — le brief qui gouverne toute la session de réparation
# --------------------------------------------------------------------------- #

def test_build_dossier_contains_the_strict_scope():
    failure = medic.Failure(medic.FAIL_LLM, "llm_failed:abc", "détail de la panne")
    dossier = medic.build_dossier(failure, {"registre": "..."}, "2026-08-30T10:00:00")
    assert "backend/bots/paper/" in dossier
    assert "paper_router.py" in dossier
    assert "paper_module.js" in dossier


def test_build_dossier_contains_the_forbidden_zones():
    failure = medic.Failure(medic.FAIL_LLM, "llm_failed:abc", "détail")
    dossier = medic.build_dossier(failure, {}, "2026-08-30T10:00:00")
    assert "auth" in dossier and "power" in dossier
    assert "scheduler" in dossier and "net_guard" in dossier
    assert "pip install" in dossier


def test_build_dossier_contains_the_push_gates():
    failure = medic.Failure(medic.FAIL_LLM, "llm_failed:abc", "détail")
    dossier = medic.build_dossier(failure, {}, "2026-08-30T10:00:00")
    assert "TDD" in dossier
    assert "git push origin medic-fix:main" in dossier
    assert "rapport.md" in dossier


def test_build_dossier_contains_the_failure_signature_and_extracts():
    failure = medic.Failure(medic.FAIL_LLM, "llm_failed:abc", "2 dernières passes en échec")
    dossier = medic.build_dossier(failure, {"registre": "extrait du ledger ici"},
                                  "2026-08-30T10:00:00")
    assert "llm_failed:abc" in dossier
    assert "2 dernières passes en échec" in dossier
    assert "extrait du ledger ici" in dossier


# --------------------------------------------------------------------------- #
# I/O — lecteurs tolérants
# --------------------------------------------------------------------------- #

def test_read_json_list_returns_empty_when_absent(tmp_path):
    assert medic._read_json_list(tmp_path / "absent.json") == []


def test_read_json_list_returns_empty_when_not_a_list(tmp_path):
    p = tmp_path / "x.json"
    p.write_text(json.dumps({"not": "a list"}), encoding="utf-8")
    assert medic._read_json_list(p) == []


def test_read_json_list_returns_the_list(tmp_path):
    p = tmp_path / "x.json"
    p.write_text(json.dumps([{"a": 1}]), encoding="utf-8")
    assert medic._read_json_list(p) == [{"a": 1}]


def test_read_json_list_returns_empty_on_corrupt_json(tmp_path):
    p = tmp_path / "x.json"
    p.write_text("{not json", encoding="utf-8")
    assert medic._read_json_list(p) == []


def test_read_json_dict_returns_empty_when_absent(tmp_path):
    assert medic._read_json_dict(tmp_path / "absent.json") == {}


def test_read_json_dict_returns_the_dict(tmp_path):
    p = tmp_path / "x.json"
    p.write_text(json.dumps({"last_pass": "2026-08-30T10:00:00"}), encoding="utf-8")
    assert medic._read_json_dict(p) == {"last_pass": "2026-08-30T10:00:00"}


def test_mtime_or_none_returns_none_when_absent(tmp_path):
    assert medic._mtime_or_none(tmp_path / "absent") is None


def test_mtime_or_none_returns_an_aware_datetime(tmp_path):
    p = tmp_path / "x.json"
    p.write_text("{}", encoding="utf-8")
    out = medic._mtime_or_none(p)
    assert out is not None and out.tzinfo is not None


# --------------------------------------------------------------------------- #
# Telegram — urllib pur, jamais le token en clair dans les logs
# --------------------------------------------------------------------------- #

def test_load_telegram_cfg_returns_empty_when_absent(tmp_path):
    assert medic.load_telegram_cfg(tmp_path / "absent.json") == {}


def test_load_telegram_cfg_reads_the_file(tmp_path):
    p = tmp_path / "tg.json"
    p.write_text(json.dumps({"token": "T", "chat_id": "C"}), encoding="utf-8")
    assert medic.load_telegram_cfg(p) == {"token": "T", "chat_id": "C"}


class _FakeResponse(object):
    def __init__(self, status=200):
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_notify_false_without_a_configured_channel():
    assert medic.notify("hello", cfg={}) is False
    assert medic.notify("hello", cfg={"token": "T"}) is False


def test_notify_true_on_a_successful_call():
    captured = {}

    def _opener(req, timeout=10):
        captured["url"] = req.full_url
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return _FakeResponse(200)

    ok = medic.notify("hello world", cfg={"token": "SECRET123", "chat_id": "42"},
                      opener=_opener)
    assert ok is True
    assert captured["body"] == {"chat_id": "42", "text": "hello world"}
    assert "SECRET123" in captured["url"]      # le jeton voyage sur le fil...


def test_notify_false_on_a_failing_call():
    def _opener(req, timeout=10):
        return _FakeResponse(500)
    assert medic.notify("hello", cfg={"token": "T", "chat_id": "C"},
                        opener=_opener) is False


def test_notify_false_when_the_opener_raises():
    def _opener(req, timeout=10):
        raise OSError("http://api.telegram.org/botSECRET123/sendMessage timed out")
    assert medic.notify("hello", cfg={"token": "SECRET123", "chat_id": "C"},
                        opener=_opener) is False


def test_claude_bin_uses_the_env_var(monkeypatch):
    monkeypatch.setenv("CLAUDE_BIN", "/tmp/faux-claude")
    assert medic._claude_bin() == "/tmp/faux-claude"


def test_claude_bin_falls_back_to_the_omen_path(monkeypatch, tmp_path):
    monkeypatch.delenv("CLAUDE_BIN", raising=False)
    fake = tmp_path / "claude"
    fake.write_text("", encoding="utf-8")
    monkeypatch.setattr(medic, "_OMEN_CLAUDE_PATH", str(fake))
    assert medic._claude_bin() == str(fake)


# --------------------------------------------------------------------------- #
# session de réparation — git + subprocess, tout injectable
# --------------------------------------------------------------------------- #

class _FakeCompleted(object):
    def __init__(self, stdout=""):
        self.stdout = stdout
        self.returncode = 0


def test_git_remote_head_returns_the_stripped_output():
    def _run(cmd, **kw):
        assert cmd == ["git", "rev-parse", "origin/main"]
        return _FakeCompleted("abc123\n")
    assert medic.git_remote_head(run=_run) == "abc123"


def test_git_remote_head_returns_none_on_failure():
    def _boom(cmd, **kw):
        raise OSError("no git")
    assert medic.git_remote_head(run=_boom) is None


class _FakePopen(object):
    def __init__(self, cmd, **kw):
        self.cmd = cmd
        self.kw = kw
        self._rc = 0

    def wait(self):
        return self._rc


def test_run_repair_session_builds_the_expected_shell_pipeline(tmp_path):
    captured = {}

    def _popen(cmd, **kw):
        captured["cmd"] = cmd
        captured["kw"] = kw
        return _FakePopen(cmd, **kw)

    dossier = tmp_path / "dossier.md"
    dossier.write_text("brief", encoding="utf-8")
    log_path = tmp_path / "session.log"

    rc = medic.run_repair_session(dossier, log_path, model="sonnet",
                                  claude_bin="/opt/claude", popen=_popen,
                                  cwd=tmp_path)
    assert rc == 0
    assert captured["cmd"][0] == "bash" and captured["cmd"][1] == "-c"
    script = captured["cmd"][2]
    assert "git fetch origin" in script
    assert "git checkout -B medic-fix origin/main" in script
    assert "/opt/claude" in script and "--dangerously-skip-permissions" in script
    assert "--model sonnet" in script
    assert str(dossier) in script
    assert captured["kw"].get("start_new_session") is True
    assert captured["kw"].get("cwd") == str(tmp_path)


# --------------------------------------------------------------------------- #
# état du médecin — persistance
# --------------------------------------------------------------------------- #

def test_load_medic_state_empty_when_absent(tmp_path):
    assert medic.load_medic_state(tmp_path / "absent.json") == {"sessions": []}


def test_save_then_load_medic_state_round_trips(tmp_path):
    path = tmp_path / "state.json"
    medic.save_medic_state({"sessions": [{"signature": "a", "ts": "x", "kind": "repair"}]},
                           path)
    assert medic.load_medic_state(path) == {
        "sessions": [{"signature": "a", "ts": "x", "kind": "repair"}]}


def test_save_medic_state_is_0600(tmp_path):
    path = tmp_path / "state.json"
    medic.save_medic_state({"sessions": []}, path)
    assert (path.stat().st_mode & 0o777) == 0o600


# --------------------------------------------------------------------------- #
# diagnose — combine les 4 détecteurs
# --------------------------------------------------------------------------- #

def test_diagnose_returns_empty_on_a_healthy_system(tmp_path):
    ledger = tmp_path / "l.json"
    ledger.write_text(json.dumps([_row("hold", True)]), encoding="utf-8")
    coach_state = tmp_path / "s.json"
    coach_state.write_text(json.dumps({"last_pass": MONDAY_NOON.isoformat()}),
                           encoding="utf-8")
    newswatch = tmp_path / "n.json"
    newswatch.write_text("{}", encoding="utf-8")
    out = medic.diagnose(now=MONDAY_NOON, ledger_path=ledger,
                         coach_state_path=coach_state,
                         newswatch_state_path=newswatch,
                         journal_fetch=lambda: _CLEAN_JOURNAL)
    assert out == []


def test_diagnose_finds_the_llm_failure(tmp_path):
    ledger = tmp_path / "l.json"
    ledger.write_text(json.dumps([_row("pass", False, "llm_failed"),
                                  _row("pass", False, "llm_failed")]),
                      encoding="utf-8")
    out = medic.diagnose(now=MONDAY_NOON, ledger_path=ledger,
                         coach_state_path=tmp_path / "absent.json",
                         newswatch_state_path=tmp_path / "absent2.json",
                         journal_fetch=lambda: "")
    assert [f.code for f in out] == [medic.FAIL_LLM]


# --------------------------------------------------------------------------- #
# run_medic — orchestration complète, tout injecté
# --------------------------------------------------------------------------- #

def _healthy_fixtures(tmp_path):
    ledger = tmp_path / "l.json"
    ledger.write_text(json.dumps([_row("hold", True)]), encoding="utf-8")
    coach_state = tmp_path / "s.json"
    coach_state.write_text(json.dumps({"last_pass": MONDAY_NOON.isoformat()}),
                           encoding="utf-8")
    newswatch = tmp_path / "n.json"
    newswatch.write_text("{}", encoding="utf-8")
    return {"ledger_path": ledger, "coach_state_path": coach_state,
           "newswatch_state_path": newswatch, "journal_fetch": lambda: _CLEAN_JOURNAL}


def test_run_medic_disabled_by_the_kill_switch(tmp_path):
    flag = tmp_path / "coach-medic.disabled"
    flag.write_text("", encoding="utf-8")
    out = medic.run_medic(now=MONDAY_NOON, disabled_path=flag,
                          state_path=tmp_path / "state.json",
                          **_healthy_fixtures(tmp_path))
    assert out == {"action": "disabled"}


def test_run_medic_idle_on_a_healthy_system(tmp_path):
    out = medic.run_medic(now=MONDAY_NOON, disabled_path=tmp_path / "absent",
                          state_path=tmp_path / "state.json",
                          **_healthy_fixtures(tmp_path))
    assert out == {"action": "idle", "failures": []}


def test_run_medic_respects_the_daily_cap(tmp_path):
    state_path = tmp_path / "state.json"
    medic.save_medic_state({"sessions": [
        {"signature": "a", "ts": (MONDAY_NOON - timedelta(hours=1)).isoformat(), "kind": "repair"},
        {"signature": "b", "ts": (MONDAY_NOON - timedelta(hours=2)).isoformat(), "kind": "repair"},
    ]}, state_path)
    fixtures = _healthy_fixtures(tmp_path)
    fixtures["ledger_path"].write_text(
        json.dumps([_row("pass", False, "llm_failed"), _row("pass", False, "llm_failed")]),
        encoding="utf-8")
    out = medic.run_medic(now=MONDAY_NOON, disabled_path=tmp_path / "absent",
                          state_path=state_path, **fixtures)
    assert out == {"action": "cap_reached"}


def test_run_medic_skips_a_failure_already_handled_recently(tmp_path):
    fixtures = _healthy_fixtures(tmp_path)
    fixtures["ledger_path"].write_text(
        json.dumps([_row("pass", False, "llm_failed"), _row("pass", False, "llm_failed")]),
        encoding="utf-8")
    failure = medic.detect_llm_failure(json.loads(fixtures["ledger_path"].read_text()))
    state_path = tmp_path / "state.json"
    medic.save_medic_state({"sessions": [
        {"signature": failure.signature, "ts": (MONDAY_NOON - timedelta(hours=1)).isoformat(),
         "kind": "repair"}]}, state_path)
    out = medic.run_medic(now=MONDAY_NOON, disabled_path=tmp_path / "absent",
                          state_path=state_path, **fixtures)
    assert out == {"action": "idle", "failures": [medic.FAIL_LLM]}


def test_run_medic_runs_a_full_repair_session_and_records_it(tmp_path):
    fixtures = _healthy_fixtures(tmp_path)
    fixtures["ledger_path"].write_text(
        json.dumps([_row("pass", False, "llm_failed"), _row("pass", False, "llm_failed")]),
        encoding="utf-8")
    state_path = tmp_path / "state.json"
    runs_dir = tmp_path / "medic-runs"
    sent = []

    def _notifier(text, cfg):
        sent.append(text)
        return True

    heads = iter(["before123", "after456"])

    def _git_run(cmd, **kw):
        return _FakeCompleted(next(heads) + "\n")

    def _popen(cmd, **kw):
        (Path(kw["cwd"]) if False else None)  # no-op, garde la signature lisible
        return _FakePopen(cmd, **kw)

    out = medic.run_medic(now=MONDAY_NOON, disabled_path=tmp_path / "absent",
                          state_path=state_path, runs_dir=runs_dir,
                          telegram_cfg={"token": "T", "chat_id": "C"},
                          notifier=_notifier, popen=_popen, git_run=_git_run,
                          claude_bin="/opt/claude", **fixtures)

    assert out["action"] == "repair"
    assert out["pushed"] is True
    assert len(sent) == 2 and "session de réparation" in sent[0]
    assert "fix pouss" in sent[1] or "fix poussé" in sent[1]

    saved = medic.load_medic_state(state_path)
    assert len(saved["sessions"]) == 1
    assert saved["sessions"][0]["outcome"] == "pushed"

    dossiers = list(runs_dir.glob("*/dossier.md"))
    assert len(dossiers) == 1 and "llm_failed" in dossiers[0].read_text(encoding="utf-8")


def test_run_medic_reports_without_pushing_when_no_new_commit(tmp_path):
    fixtures = _healthy_fixtures(tmp_path)
    fixtures["ledger_path"].write_text(
        json.dumps([_row("pass", False, "llm_failed"), _row("pass", False, "llm_failed")]),
        encoding="utf-8")

    def _git_run(cmd, **kw):
        return _FakeCompleted("same789\n")     # avant == après -> pas poussé

    out = medic.run_medic(now=MONDAY_NOON, disabled_path=tmp_path / "absent",
                          state_path=tmp_path / "state.json",
                          runs_dir=tmp_path / "medic-runs",
                          telegram_cfg={}, notifier=lambda t, c: True,
                          popen=lambda cmd, **kw: _FakePopen(cmd, **kw),
                          git_run=_git_run, claude_bin="/opt/claude", **fixtures)
    assert out["pushed"] is False
    assert out["action"] == "repair"


# --------------------------------------------------------------------------- #
# main — l'entrée CLI ne lève jamais
# --------------------------------------------------------------------------- #

def test_main_returns_0_and_calls_run_medic(monkeypatch):
    calls = []
    monkeypatch.setattr(medic, "run_medic", lambda: calls.append(1) or {"action": "idle"})
    assert medic.main() == 0
    assert calls == [1]


def test_main_returns_1_when_run_medic_raises(monkeypatch):
    def _boom():
        raise RuntimeError("boom")
    monkeypatch.setattr(medic, "run_medic", _boom)
    assert medic.main() == 1


def test_notify_never_logs_the_token(caplog):
    """... mais AUCUNE trace écrite par ``notify`` (succès, échec HTTP, ou
    exception dont le message embarque l'URL) ne doit jamais le porter."""
    import logging as _logging
    caplog.set_level(_logging.DEBUG, logger="coach_medic")

    def _boom(req, timeout=10):
        raise OSError("http://api.telegram.org/botSECRET123/sendMessage timed out")

    medic.notify("hello", cfg={"token": "SECRET123", "chat_id": "C"}, opener=_boom)
    medic.notify("hello", cfg={"token": "SECRET123", "chat_id": "C"},
                 opener=lambda req, timeout=10: _FakeResponse(200))
    for record in caplog.records:
        assert "SECRET123" not in record.getMessage()
