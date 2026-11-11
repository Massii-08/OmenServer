"""Tests du LOT 18 — réparation du médic : dossier de travail dédié,
authentification, vraies issues (pushed/reported/failed), délai de grâce,
verrou anti-chevauchement. Tout est injecté : aucun vrai processus, aucun
Telegram, aucun accès au vrai dossier personnel.
"""
import fcntl
import importlib.util
import json
import shlex
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

_TOOLS_DIR = Path(__file__).resolve().parents[3] / "tools"
_SPEC = importlib.util.spec_from_file_location(
    "coach_medic_lot18", str(_TOOLS_DIR / "coach_medic.py"))
medic = importlib.util.module_from_spec(_SPEC)
sys.modules["coach_medic_lot18"] = medic
_SPEC.loader.exec_module(medic)

MONDAY_NOON = datetime(2026, 8, 31, 12, 0, tzinfo=timezone.utc)
SUNDAY_2200 = datetime(2026, 8, 30, 20, 0, tzinfo=timezone.utc)   # 22h Rome

AUTH_LINE = "Failed to authenticate: OAuth session expired and could not be refreshed"


# --------------------------------------------------------------------------- #
# faux processus / git
# --------------------------------------------------------------------------- #

class _Completed(object):
    def __init__(self, stdout=""):
        self.stdout = stdout
        self.returncode = 0


class _Popen(object):
    """Faux Popen : écrit ``log_text`` dans le journal (stdout) et rend ``rc``."""
    calls = []

    def __init__(self, cmd, **kw):
        self.cmd = cmd
        self.kw = kw
        type(self).calls.append(self)

    def wait(self):
        return type(self).rc


def _popen_factory(rc=0, log_text=""):
    class P(_Popen):
        calls = []

    P.rc = rc

    def _make(cmd, **kw):
        p = P(cmd, **kw)
        kw["stdout"].write(log_text)
        kw["stdout"].flush()
        return p
    _make.cls = P
    return _make


class _GitFake(object):
    """Faux git piloté par commande : ``HEAD`` vaut ``base`` au 1er relevé puis
    ``head`` ; ``origin/main`` vaut ``remote``. ``fail`` = sous-chaîne d'une
    commande qui échoue (``raise_exc`` pour lever)."""

    def __init__(self, base, head, remote, fail=None, raise_exc=False, out="boom"):
        self.base, self.head, self.remote = base, head, remote
        self.fail, self.raise_exc, self.out = fail, raise_exc, out
        self.head_reads = 0
        self.seen = []

    def __call__(self, cmd, **kw):
        self.seen.append((cmd, kw))
        text = " ".join(cmd)
        if self.fail and self.fail in text:
            if self.raise_exc:
                raise OSError(self.out)
            c = _Completed(self.out + "\n")
            c.returncode = 128
            return c
        if cmd[:2] == ["git", "rev-parse"]:
            if cmd[2] == "HEAD":
                self.head_reads += 1
                return _Completed((self.base if self.head_reads == 1 else self.head) + "\n")
            return _Completed(self.remote + "\n")
        return _Completed("")

    def commands(self):
        return [" ".join(c) for c, _ in self.seen]


def _git(base, head, remote, **kw):
    return _GitFake(base, head, remote, **kw)


def _work_dir(tmp_path):
    wd = tmp_path / "medic-work"
    (wd / ".git").mkdir(parents=True, exist_ok=True)
    return wd


def _row(action, accepted, reason=None):
    return {"ts": "2026-08-30T10:00:00", "action": action,
            "accepted": accepted, "reason": reason, "symbol": "", "detail": None}


def _fixtures(tmp_path, broken=True):
    ledger = tmp_path / "l.json"
    rows = ([_row("pass", False, "llm_failed")] * 2) if broken else [_row("hold", True)]
    ledger.write_text(json.dumps(rows), encoding="utf-8")
    coach_state = tmp_path / "s.json"
    coach_state.write_text(json.dumps({"last_pass": MONDAY_NOON.isoformat()}),
                           encoding="utf-8")
    newswatch = tmp_path / "n.json"
    newswatch.write_text("{}", encoding="utf-8")
    return {"ledger_path": ledger, "coach_state_path": coach_state,
            "newswatch_state_path": newswatch, "journal_fetch": lambda: ""}


def _run(tmp_path, popen, git_run, sent=None, now=MONDAY_NOON, work_dir=None,
         oauth=None, lock=None, state_path=None, **extra):
    sent = sent if sent is not None else []
    kwargs = dict(
        now=now, disabled_path=tmp_path / "absent",
        state_path=state_path or tmp_path / "state.json",
        runs_dir=tmp_path / "runs", telegram_cfg={},
        notifier=lambda t, c: sent.append(t) or True,
        popen=popen, git_run=git_run, claude_bin="/opt/claude",
        work_dir=work_dir if work_dir is not None else _work_dir(tmp_path),
        oauth_env_path=oauth or tmp_path / "no-oauth.env",
        lock_path=lock or tmp_path / "medic.lock",
    )
    kwargs.update(_fixtures(tmp_path))
    kwargs.update(extra)
    return medic.run_medic(**kwargs)


# --------------------------------------------------------------------------- #
# classification pure
# --------------------------------------------------------------------------- #

def test_is_auth_failure_matches_the_real_line():
    assert medic.is_auth_failure(AUTH_LINE) is True


@pytest.mark.parametrize("line", [
    "Invalid API key", "NOT LOGGED IN - please run /login", "OAuth token has expired",
    "failed to authenticate", "authentication_error"])
def test_is_auth_failure_is_case_insensitive(line):
    assert medic.is_auth_failure("blabla\n" + line + "\n") is True


def test_is_auth_failure_false_on_a_normal_log():
    assert medic.is_auth_failure("tests verts\nrapport écrit\n") is False
    assert medic.is_auth_failure("") is False


def test_is_auth_failure_only_looks_at_the_end_of_the_log():
    text = AUTH_LINE + "\n" + "\n".join("ligne %d" % i for i in range(60))
    assert medic.is_auth_failure(text) is False


def test_last_error_line_is_last_non_empty_and_truncated():
    assert medic.last_error_line("a\nb\n\n  \n") == "b"
    assert medic.last_error_line("") == ""
    assert len(medic.last_error_line("x" * 500)) == 200


def test_classify_outcome_failed_on_nonzero_rc():
    assert medic.classify_outcome(1, False, "boom") == "failed"


def test_classify_outcome_failed_on_real_auth_line_even_with_rc_zero():
    assert medic.classify_outcome(0, False, "x\n" + AUTH_LINE + "\n") == "failed"
    assert medic.classify_outcome(1, False, AUTH_LINE) == "failed"


def test_classify_outcome_pushed_and_reported():
    assert medic.classify_outcome(0, True, "ok") == "pushed"
    assert medic.classify_outcome(0, False, "ok") == "reported"


def test_classify_outcome_failed_when_rc_is_none():
    assert medic.classify_outcome(None, False, "") == "failed"


def test_consecutive_failures_counts_trailing_failed_entries():
    h = [{"outcome": "failed"}, {"outcome": "pushed"},
         {"outcome": "failed"}, {"outcome": "failed"}]
    assert medic.consecutive_failures(h) == 2
    assert medic.consecutive_failures([]) == 0
    assert medic.consecutive_failures([{"outcome": "failed"}, {"outcome": "reported"}]) == 0
    assert medic.consecutive_failures([{"signature": "legacy"}]) == 0


def test_failure_message_wording():
    assert medic.end_message("pushed", "sig", 0, "") == "fix poussé : sig"
    assert medic.end_message("reported", "sig", 0, "") == "rapport sans fix : sig"
    msg = medic.end_message("failed", "sig", 1, "boom")
    assert msg == "ÉCHEC de session (1ʳᵉ d'affilée) : sig — boom"
    assert "3ᵉ d'affilée" in medic.end_message("failed", "sig", 3, "boom")


# --------------------------------------------------------------------------- #
# délai de grâce — failed ne compte pas comme traité
# --------------------------------------------------------------------------- #

def _entry(sig, ts, outcome=None, kind="repair"):
    e = {"signature": sig, "ts": ts.isoformat(), "kind": kind}
    if outcome:
        e["outcome"] = outcome
    return e


def test_already_handled_ignores_failed_entries():
    ts = MONDAY_NOON - timedelta(hours=1)
    assert medic.already_handled([_entry("s", ts, "failed")], "s", MONDAY_NOON) is False
    assert medic.already_handled([_entry("s", ts, "reported")], "s", MONDAY_NOON) is True


def test_daily_cap_still_counts_failed_entries():
    h = [_entry("a", MONDAY_NOON - timedelta(hours=1), "failed"),
         _entry("a", MONDAY_NOON - timedelta(hours=2), "failed")]
    assert medic.daily_cap_reached(h, MONDAY_NOON) is True


def test_weekly_gate_ok_allows_retry_after_a_failed_weekly():
    h = [_entry("w", SUNDAY_2200 - timedelta(hours=1), "failed",
                kind=medic.WEEKLY_IMPROVEMENT_KIND)]
    assert medic.weekly_gate_ok(h, SUNDAY_2200) is True
    h[0]["outcome"] = "reported"
    assert medic.weekly_gate_ok(h, SUNDAY_2200) is False


def test_failed_signature_is_retried_next_cycle_then_cap_stops_it(tmp_path):
    state_path = tmp_path / "state.json"
    medic.save_medic_state({"sessions": [
        _entry(medic.detect_llm_failure([_row("pass", False, "llm_failed")] * 2).signature,
               MONDAY_NOON - timedelta(hours=1), "failed")]}, state_path)
    popen = _popen_factory(rc=0, log_text="ok\n")
    out = _run(tmp_path, popen, _git("a", "a", "a"), state_path=state_path)
    assert out["action"] == "repair"                    # relancée
    out2 = _run(tmp_path, popen, _git("a", "a", "a"), state_path=state_path)
    assert out2 == {"action": "cap_reached"}            # puis plafond


# --------------------------------------------------------------------------- #
# session : cwd, git, authentification
# --------------------------------------------------------------------------- #

def test_session_runs_in_work_dir_with_oauth_loaded_when_present(tmp_path):
    oauth = tmp_path / "claude-code-oauth.env"
    oauth.write_text("CLAUDE_CODE_OAUTH_TOKEN=sekrit\n", encoding="utf-8")
    wd = _work_dir(tmp_path)
    popen = _popen_factory(rc=0, log_text="fin\n")
    git = _git("a", "b", "b")
    out = _run(tmp_path, popen, git, work_dir=wd, oauth=oauth)
    call = popen.cls.calls[0]
    assert call.kw["cwd"] == str(wd)
    script = call.cmd[2]
    assert "set -a; . %s; set +a" % str(oauth) in script
    assert script.index("set -a") < script.index("/opt/claude")
    assert "sekrit" not in script                 # le contenu n'est jamais lu
    assert out["outcome"] == "pushed"
    # la détection de poussée lit le dossier de travail, jamais REPO_DIR
    assert all(kw["cwd"] == str(wd) for _, kw in git.seen)


def test_oauth_file_with_a_space_is_quoted(tmp_path):
    d = tmp_path / "dir with space"
    d.mkdir()
    oauth = d / "o.env"
    oauth.write_text("A=b\n", encoding="utf-8")
    popen = _popen_factory()
    _run(tmp_path, popen, _git("a", "a", "a"), oauth=oauth)
    script = popen.cls.calls[0].cmd[2]
    assert "'%s'" % str(oauth) in script


def test_oauth_not_loaded_when_the_file_is_absent(tmp_path):
    popen = _popen_factory()
    _run(tmp_path, popen, _git("a", "a", "a"))
    assert "set -a" not in popen.cls.calls[0].cmd[2]


def test_run_repair_session_default_cwd_is_work_dir_not_repo(tmp_path, monkeypatch):
    wd = _work_dir(tmp_path)
    monkeypatch.setattr(medic, "WORK_DIR", wd)
    seen = {}

    def _popen(cmd, **kw):
        seen.update(kw)
        return type("P", (), {"wait": lambda self: 0})()

    d = tmp_path / "d.md"
    d.write_text("x", encoding="utf-8")
    medic.run_repair_session(d, tmp_path / "s.log", popen=_popen, claude_bin="/c",
                             oauth_env_path=tmp_path / "none")
    assert seen["cwd"] == str(wd)


def test_work_dir_default_comes_from_env(monkeypatch, tmp_path):
    monkeypatch.setenv("COACH_MEDIC_WORK_DIR", str(tmp_path / "w"))
    assert medic.default_work_dir() == tmp_path / "w"
    monkeypatch.delenv("COACH_MEDIC_WORK_DIR")
    assert medic.default_work_dir() == Path.home() / "medic-work"


# --------------------------------------------------------------------------- #
# gardes du dossier de travail
# --------------------------------------------------------------------------- #

def _assert_no_session(tmp_path, wd):
    popen = _popen_factory()
    sent = []
    out = _run(tmp_path, popen, _git("a", "b", "b"), sent=sent, work_dir=wd)
    assert popen.cls.calls == []
    assert out["outcome"] == "failed" and out["error"] == "no_work_dir"
    assert len(sent) == 1 and "ÉCHEC de session" in sent[0] and "no_work_dir" in sent[0]
    saved = medic.load_medic_state(tmp_path / "state.json")["sessions"]
    assert saved[0]["outcome"] == "failed" and saved[0]["error"] == "no_work_dir"


def test_missing_work_dir_blocks_the_session(tmp_path):
    _assert_no_session(tmp_path, tmp_path / "nope")


def test_work_dir_without_git_blocks_the_session(tmp_path):
    wd = tmp_path / "plain"
    wd.mkdir()
    _assert_no_session(tmp_path, wd)


def test_work_dir_equal_to_repo_dir_blocks_the_session(tmp_path):
    _assert_no_session(tmp_path, medic.REPO_DIR)


def test_work_dir_symlinked_to_repo_dir_blocks_the_session(tmp_path):
    link = tmp_path / "link"
    link.symlink_to(medic.REPO_DIR)
    _assert_no_session(tmp_path, link)


# --------------------------------------------------------------------------- #
# issues
# --------------------------------------------------------------------------- #

def test_real_auth_failure_is_recorded_as_failed_with_telegram(tmp_path):
    popen = _popen_factory(rc=1, log_text="début\n" + AUTH_LINE + "\n")
    sent = []
    out = _run(tmp_path, popen, _git("a", "a", "a"), sent=sent)
    assert out["outcome"] == "failed" and out["rc"] == 1
    assert out["error"] == AUTH_LINE
    assert sent[-1] == "ÉCHEC de session (1ʳᵉ d'affilée) : %s — %s" % (
        out["signature"], AUTH_LINE)
    entry = medic.load_medic_state(tmp_path / "state.json")["sessions"][0]
    assert entry["outcome"] == "failed" and entry["rc"] == 1
    assert entry["error"] == AUTH_LINE


def test_second_consecutive_failure_is_counted(tmp_path):
    state_path = tmp_path / "state.json"
    medic.save_medic_state({"sessions": [
        _entry("old", MONDAY_NOON - timedelta(hours=30), "failed")]}, state_path)
    popen = _popen_factory(rc=1, log_text="boom\n")
    sent = []
    _run(tmp_path, popen, _git("a", "a", "a"), sent=sent, state_path=state_path)
    assert "2ᵉ d'affilée" in sent[-1]


def test_rc_zero_without_push_is_reported(tmp_path):
    popen = _popen_factory(rc=0, log_text="rapport écrit\n")
    sent = []
    out = _run(tmp_path, popen, _git("s", "s", "s"), sent=sent)
    assert out["outcome"] == "reported" and out["pushed"] is False
    assert sent[-1] == "rapport sans fix : %s" % out["signature"]
    assert medic.load_medic_state(tmp_path / "state.json")["sessions"][0]["rc"] == 0


def test_moved_remote_ref_is_pushed(tmp_path):
    popen = _popen_factory(rc=0, log_text="poussé\n")
    sent = []
    out = _run(tmp_path, popen, _git("a", "b", "b"), sent=sent)
    assert out["outcome"] == "pushed" and out["pushed"] is True
    assert sent[-1] == "fix poussé : %s" % out["signature"]


# --------------------------------------------------------------------------- #
# dossier de mission
# --------------------------------------------------------------------------- #

def test_dossier_gives_the_exact_test_command_with_current_interpreter():
    f = medic.Failure(medic.FAIL_LLM, "llm_failed:abc", "d")
    d = medic.build_dossier(f, {}, "2026-08-30T10:00:00")
    assert "Lance les tests avec : `%s -m pytest backend/bots/tests -q`" % shlex.quote(sys.executable) in d
    assert "clone dédié" in d and "medic-fix:main" in d


# --------------------------------------------------------------------------- #
# verrou
# --------------------------------------------------------------------------- #

def test_busy_when_the_lock_is_held_and_no_side_effect(tmp_path):
    lock = tmp_path / "medic.lock"
    held = open(str(lock), "w")
    fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
    try:
        popen = _popen_factory()
        sent = []
        out = _run(tmp_path, popen, _git("a", "b", "b"), sent=sent, lock=lock)
        assert out == {"action": "busy"}
        assert popen.cls.calls == [] and sent == []
        assert not (tmp_path / "state.json").exists()
        assert not (tmp_path / "runs").exists()
    finally:
        held.close()


def test_lock_is_released_after_the_cycle(tmp_path):
    lock = tmp_path / "medic.lock"
    popen = _popen_factory(rc=0, log_text="ok\n")
    _run(tmp_path, popen, _git("a", "a", "a"), lock=lock)
    probe = open(str(lock), "w")
    try:
        fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)      # ne doit pas lever
    finally:
        probe.close()


def test_lock_is_released_even_if_the_cycle_raises(tmp_path):
    lock = tmp_path / "medic.lock"

    def _boom(cmd, **kw):
        raise RuntimeError("boom")
    with pytest.raises(RuntimeError):
        _run(tmp_path, _boom, _git("a", "a", "a"), lock=lock)
    probe = open(str(lock), "w")
    try:
        fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
    finally:
        probe.close()


# --------------------------------------------------------------------------- #
# lot 18 bis — préparation git en Python, détection de poussée par commit
# --------------------------------------------------------------------------- #

def test_session_script_no_longer_contains_git(tmp_path):
    popen = _popen_factory()
    git = _git("a", "a", "a")
    _run(tmp_path, popen, git)
    script = popen.cls.calls[0].cmd[2]
    assert "git " not in script and "/opt/claude" in script
    assert script.startswith("set -e")
    cmds = git.commands()
    # Les restes d'une session précédente (fichiers modifiés jamais commités)
    # sont mis de côté AVANT tout : sans ça ils suivraient le checkout et
    # finiraient dans le commit de la session suivante.
    assert cmds[0].startswith("git stash push --include-untracked")
    assert cmds[1] == "git fetch origin"
    assert cmds[2] == "git checkout -B medic-fix origin/main"
    wd = str(tmp_path / "medic-work")
    assert all(kw["cwd"] == wd for _, kw in git.seen)


@pytest.mark.parametrize("fail", ["fetch", "checkout"])
def test_git_prepare_failure_blocks_the_session(tmp_path, fail):
    popen = _popen_factory()
    sent = []
    git = _git("a", "a", "a", fail=fail, out="fatal: pas de réseau")
    out = _run(tmp_path, popen, git, sent=sent)
    assert popen.cls.calls == []
    assert out["outcome"] == "failed"
    assert out["error"] == "git_prepare: fatal: pas de réseau"
    assert "git_prepare" in sent[-1] and "ÉCHEC" in sent[-1]
    entry = medic.load_medic_state(tmp_path / "state.json")["sessions"][0]
    assert entry["outcome"] == "failed"


def test_git_prepare_exception_blocks_the_session(tmp_path):
    popen = _popen_factory()
    git = _git("a", "a", "a", fail="fetch", raise_exc=True, out="no git")
    out = _run(tmp_path, popen, git)
    assert popen.cls.calls == [] and out["error"] == "git_prepare: no git"


def test_git_prepare_error_is_truncated(tmp_path):
    git = _git("a", "a", "a", fail="fetch", out="x" * 500)
    out = _run(tmp_path, _popen_factory(), git)
    assert out["error"] == "git_prepare: " + "x" * 200


def test_foreign_push_during_session_is_not_pushed(tmp_path):
    # HEAD n'a pas bougé, mais origin/main oui (quelqu'un d'autre a poussé)
    out = _run(tmp_path, _popen_factory(rc=0, log_text="ok\n"), _git("a", "a", "c"))
    assert out["outcome"] == "reported" and out["pushed"] is False


def test_session_commit_not_on_remote_is_not_pushed(tmp_path):
    out = _run(tmp_path, _popen_factory(rc=0, log_text="ok\n"), _git("a", "b", "a"))
    assert out["outcome"] == "reported"


def test_session_commit_not_on_remote_after_foreign_push_is_not_pushed(tmp_path):
    out = _run(tmp_path, _popen_factory(rc=0, log_text="ok\n"), _git("a", "b", "c"))
    assert out["outcome"] == "reported"


def test_pushed_wins_over_nonzero_rc_and_keeps_rc_and_error(tmp_path):
    out = _run(tmp_path, _popen_factory(rc=2, log_text="poussé puis planté\n"),
               _git("a", "b", "b"))
    assert out["outcome"] == "pushed" and out["rc"] == 2
    assert out["error"] == "poussé puis planté"
    entry = medic.load_medic_state(tmp_path / "state.json")["sessions"][0]
    assert entry["rc"] == 2 and entry["error"] == "poussé puis planté"


def test_classify_outcome_pushed_beats_failures():
    assert medic.classify_outcome(1, True, AUTH_LINE) == "pushed"
    assert medic.classify_outcome(None, True, "") == "pushed"


def test_oauth_word_in_a_successful_report_is_not_a_failure():
    log = "travail\nJ'ai corrigé le rafraîchissement OAuth, suite verte\n"
    assert medic.is_auth_failure(log) is False
    assert medic.classify_outcome(0, False, log) == "reported"


def test_oauth_session_with_words_before_expired_is_a_failure():
    assert medic.is_auth_failure("OAuth session has already expired") is True


def test_dossier_quotes_an_interpreter_path_with_a_space(monkeypatch):
    monkeypatch.setattr(medic.sys, "executable", "/home/massii08/Projet serveur/venv/bin/python3")
    f = medic.Failure(medic.FAIL_LLM, "llm_failed:abc", "d")
    d = medic.build_dossier(f, {}, "2026-08-30T10:00:00")
    assert "`'/home/massii08/Projet serveur/venv/bin/python3' -m pytest backend/bots/tests -q`" in d


def test_dossier_exit_gates_compare_with_the_baseline():
    f = medic.Failure(medic.FAIL_LLM, "llm_failed:abc", "d")
    d = medic.build_dossier(f, {}, "2026-08-30T10:00:00")
    assert "NOTE les tests déjà rouges" in d
    assert "NOUVEAU rouge" in d
    assert "test_paper_*" in d and "test_coach_*" in d and "test_tvcoach_*" in d
    assert "message de commit" in d and "test_mc_agent_*" in d
    assert "au moindre doute" in d.lower() and "rapport.md" in d
    assert "git push origin medic-fix:main" in d
