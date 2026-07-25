"""Plomberie du drapeau `regroup` (regroupement après mort — idée Massii 25/07).

Le bot sait rejoindre le groupe en /tpa après une mort tant que l'armure fer n'est pas là
(`mc-agent/regroup.js`). Ce drapeau est **ÉTEINT par défaut** et doit le rester : on l'active
run par run, explicitement. Ces tests verrouillent les deux moitiés du contrat :
  - sans demande → AUCUN `--regroup` sur la ligne de commande (le comportement ne change pas) ;
  - avec demande → le drapeau arrive au bot ET survit au respawn du self-healing.
"""
import io

import pytest

from backend.bots import mc_agent_manager as mgr


class FakeProcNoPipe:
    def __init__(self):
        self.stdout = None
        self.stdin = io.StringIO()
        self.pid = 54321
        self._alive = True

    def poll(self):
        return None if self._alive else 0

    def terminate(self):
        self._alive = False


@pytest.fixture(autouse=True)
def _clean_sessions():
    mgr._sessions.clear()
    yield
    mgr._sessions.clear()


def _spawn_cmd(monkeypatch, **kwargs):
    captured = {}

    def fake_popen(cmd, **kw):
        captured["cmd"] = [str(c) for c in cmd]
        return FakeProcNoPipe()

    monkeypatch.setattr(mgr.subprocess, "Popen", fake_popen)
    sid = mgr.start_session("127.0.0.1", 25565, "RegroupBot", **kwargs)
    mgr.stop_session(sid)
    return captured["cmd"]


def test_par_defaut_aucun_regroup_sur_la_ligne_de_commande(monkeypatch):
    """Le défaut est SACRÉ : un run existant ne doit pas changer de comportement."""
    assert "--regroup" not in _spawn_cmd(monkeypatch)


def test_demande_explicite_le_drapeau_arrive_au_bot(monkeypatch):
    cmd = _spawn_cmd(monkeypatch, regroup=True)
    assert "--regroup" in cmd
    assert cmd[cmd.index("--regroup") + 1] == "1"


def test_regroup_false_reste_absent(monkeypatch):
    assert "--regroup" not in _spawn_cmd(monkeypatch, regroup=False)


def test_le_plan_de_respawn_conserve_le_drapeau(monkeypatch):
    """Sinon un bot relancé par le self-healing perdrait le regroupement en route."""
    monkeypatch.setattr(mgr.subprocess, "Popen", lambda cmd, **kw: FakeProcNoPipe())
    monkeypatch.setattr(mgr, "_registry_sync", lambda *a, **k: None)

    captured = {}

    def fake_get_server(gid):
        return {"id": gid, "host": "127.0.0.1", "port": 25565, "auth": "offline",
                "intelligence": "intermediaire", "language": "fr",
                "bots": [{"id": "b1", "username": "RegroupBot", "role": "worker", "auth": "offline"}]}

    monkeypatch.setattr(mgr.servers_store, "get_server", fake_get_server)
    monkeypatch.setattr(mgr.servers_store, "resolve_commands", lambda s: None)
    monkeypatch.setattr(mgr.servers_store, "resolve_policy", lambda s: None)
    monkeypatch.setattr(mgr.mc_agent_secrets, "get_secret", lambda g, b: None)
    monkeypatch.setattr(mgr, "_resolve_login_command", lambda *a, **k: None)

    def fake_spawn_bot(*a, **kw):
        captured.update(kw)
        mgr._sessions[1] = {"id": 1, "status": "spawned"}
        return 1

    monkeypatch.setattr(mgr, "_spawn_bot", fake_spawn_bot)
    mgr.start_for_bot("g1", "b1", regroup=True)
    assert captured.get("regroup") is True, "le drapeau n'atteint pas le process du bot"
    assert mgr._sessions[1]["respawn"]["regroup"] is True, "perdu au respawn du self-healing"


def test_le_plan_de_respawn_reste_a_false_par_defaut(monkeypatch):
    monkeypatch.setattr(mgr, "_registry_sync", lambda *a, **k: None)
    monkeypatch.setattr(mgr.servers_store, "get_server", lambda gid: {
        "id": gid, "host": "127.0.0.1", "port": 25565, "auth": "offline",
        "intelligence": "intermediaire", "language": "fr",
        "bots": [{"id": "b1", "username": "RegroupBot", "role": "worker", "auth": "offline"}]})
    monkeypatch.setattr(mgr.servers_store, "resolve_commands", lambda s: None)
    monkeypatch.setattr(mgr.servers_store, "resolve_policy", lambda s: None)
    monkeypatch.setattr(mgr.mc_agent_secrets, "get_secret", lambda g, b: None)
    monkeypatch.setattr(mgr, "_resolve_login_command", lambda *a, **k: None)
    monkeypatch.setattr(mgr, "_spawn_bot", lambda *a, **kw: mgr._sessions.setdefault(2, {"id": 2}) and 2 or 2)
    mgr.start_for_bot("g1", "b1")
    assert mgr._sessions[2]["respawn"]["regroup"] is False
