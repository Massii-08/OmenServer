import io

import pytest

from backend.bots import mc_agent_manager as mgr


@pytest.fixture(autouse=True)
def _clean_sessions():
    """Nettoie le registre global entre les tests (évite les sessions fantômes)."""
    yield
    mgr._sessions.clear()


def test_parse_event_line_valide():
    ev = mgr.parse_event_line('{"type":"status","state":"spawned"}')
    assert ev == {"type": "status", "state": "spawned"}


def test_parse_event_line_rejette_le_bruit():
    assert mgr.parse_event_line("pas du json") is None
    assert mgr.parse_event_line("") is None
    assert mgr.parse_event_line('{"sans":"type"}') is None


def test_apply_event_met_a_jour_statut_et_transcript():
    s = {"status": "starting", "transcript": [], "events": [], "last_error": None}
    mgr._apply_event(s, {"type": "status", "state": "spawned"})
    mgr._apply_event(s, {"type": "chat", "from": "Massii", "message": "salut"})
    mgr._apply_event(s, {"type": "error", "message": "boom"})
    assert s["status"] == "spawned"
    assert s["transcript"] == [{"type": "chat", "from": "Massii", "message": "salut"}]
    assert s["last_error"] == "boom"
    assert len(s["events"]) == 3


def test_pump_lit_un_flux_et_finit_en_stopped():
    s = {"status": "starting", "transcript": [], "events": [], "last_error": None}
    stream = io.StringIO(
        '{"type":"status","state":"spawned"}\n'
        'bruit\n'
        '{"type":"say","message":"coucou"}\n'
    )
    mgr._pump(s, stream)
    assert s["status"] == "stopped"  # flux terminé
    assert len(s["transcript"]) == 1
    assert len(s["events"]) == 2


class FakeProc:
    """Faux subprocess : stdout = flux fini, stdin capturé, pas de vrai process."""
    def __init__(self, stdout_text):
        self.stdout = io.StringIO(stdout_text)
        self.stdin = io.StringIO()
        self.pid = 4242
        self._alive = True
    def poll(self):
        return None if self._alive else 0


def test_has_api_key(monkeypatch, tmp_path):
    # isole le fallback fichier (sinon un anthropic.key réel rendrait le test flaky)
    monkeypatch.setattr(mgr, "API_KEY_PATH", tmp_path / "none.key")
    monkeypatch.setenv("MC_AGENT_LLM", "anthropic")  # déterministe même si .env force gemini
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    assert mgr.has_api_key() is True
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert mgr.has_api_key() is False


def test_has_api_key_gemini(monkeypatch):
    """En mode Gemini, c'est GEMINI_API_KEY qui compte (pas la clé Anthropic)."""
    monkeypatch.setenv("MC_AGENT_LLM", "gemini")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("GEMINI_API_KEY", "AIza-test")
    assert mgr.has_api_key() is True
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    assert mgr.has_api_key() is False


def test_has_api_key_groq(monkeypatch):
    """En mode Groq, c'est GROQ_API_KEY qui compte."""
    monkeypatch.setenv("MC_AGENT_LLM", "groq")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("GROQ_API_KEY", "gsk_test")
    assert mgr.has_api_key() is True
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    assert mgr.has_api_key() is False


def test_api_key_fichier_roundtrip(monkeypatch, tmp_path):
    # Pinne le provider sur anthropic : sinon un .env avec MC_AGENT_LLM=groq + GROQ_API_KEY
    # (chargé par backend.config) ferait passer has_api_key() par Groq → faux négatif ici.
    monkeypatch.setenv("MC_AGENT_LLM", "anthropic")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(mgr, "API_KEY_PATH", tmp_path / "anthropic.key")
    assert mgr.has_api_key() is False
    assert mgr.get_api_key_status()["has_key"] is False
    preview = mgr.set_api_key("sk-ant-abcdef0123456789")
    assert "…" in preview and "0123456789" not in preview  # masquée
    assert mgr.has_api_key() is True
    status = mgr.get_api_key_status()
    assert status["has_key"] is True and status["source"] == "file"
    assert mgr._read_api_key() == "sk-ant-abcdef0123456789"
    assert mgr.clear_api_key() is True
    assert mgr.has_api_key() is False
    assert mgr.clear_api_key() is False  # déjà absent


def test_start_session_enregistre_et_pompe(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    created = {}
    def fake_popen(cmd, **kw):
        created["cmd"] = cmd
        created["env_has_key"] = kw.get("env", {}).get("ANTHROPIC_API_KEY") == "sk-test"
        return FakeProc('{"type":"status","state":"spawned"}\n')
    monkeypatch.setattr(mgr.subprocess, "Popen", fake_popen)
    sid = mgr.start_session("play.exemple.net", 25565, "TrainBot", "claude-haiku-4-5-20251001")
    mgr._sessions[sid]["thread"].join(timeout=2)
    assert created["env_has_key"] is True
    assert "--host" in created["cmd"] and "play.exemple.net" in created["cmd"]
    assert "--auth" in created["cmd"]  # auth toujours passé (défaut offline)
    st = mgr.get_status(sid)
    assert st["status"] in ("spawned", "stopped")
    assert any(s["id"] == sid for s in mgr.list_active())


def test_send_command_ecrit_sur_stdin(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setattr(mgr.subprocess, "Popen", lambda cmd, **kw: FakeProc(""))
    sid = mgr.start_session("h", 25565, "B", None)
    mgr._sessions[sid]["thread"].join(timeout=2)
    assert mgr.send_command(sid, {"type": "say", "message": "hi"}) is True
    assert mgr.send_command(99999, {"type": "say", "message": "x"}) is False


def test_get_status_inconnu_retourne_none():
    assert mgr.get_status(123456) is None


def test_apply_event_cape_le_transcript_a_200():
    s = {"status": "starting", "transcript": [], "events": [], "last_error": None}
    for i in range(205):
        mgr._apply_event(s, {"type": "chat", "message": str(i)})
    assert len(s["transcript"]) == 200
    assert s["transcript"][-1]["message"] == "204"  # garde les plus récents


def test_apply_event_cape_les_events_a_500():
    s = {"status": "starting", "transcript": [], "events": [], "last_error": None}
    for i in range(505):
        mgr._apply_event(s, {"type": "error", "message": str(i)})
    assert len(s["events"]) == 500


def test_start_session_passe_le_profil(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    captured = {}
    def fake_popen(cmd, **kw):
        captured["cmd"] = cmd
        return FakeProc('{"type":"status","state":"spawned"}\n')
    monkeypatch.setattr(mgr.subprocess, "Popen", fake_popen)
    sid = mgr.start_session("h", 25565, "B", None, "offline", profile="expert")
    mgr._sessions[sid]["thread"].join(timeout=2)
    assert "--profile" in captured["cmd"]
    i = captured["cmd"].index("--profile")
    assert captured["cmd"][i + 1] == "expert"


def test_list_profiles_parse_la_sortie_node(monkeypatch):
    payload = '[{"id":"evident","level":1,"label":"Évident","summary":"s","tells":["t1"]}]'
    class R:
        returncode = 0
        stdout = payload
        stderr = ""
    monkeypatch.setattr(mgr.subprocess, "run", lambda *a, **k: R())
    profs = mgr.list_profiles()
    assert profs[0]["id"] == "evident"
    assert profs[0]["tells"] == ["t1"]


def test_list_profiles_retourne_vide_si_node_echoue(monkeypatch):
    def boom(*a, **k):
        raise OSError("node introuvable")
    monkeypatch.setattr(mgr.subprocess, "run", boom)
    assert mgr.list_profiles() == []


import io
import json as _json


def test_start_session_writes_commands_file(monkeypatch, tmp_path):
    from backend.bots import mc_agent_manager as mgr

    class FakeProc:
        def __init__(self):
            self.stdin = io.StringIO()
            self.stdout = iter(())
            self.pid = 4321

        def poll(self):
            return None

    captured = {}

    def fake_popen(cmd, **kw):
        captured["cmd"] = cmd
        return FakeProc()

    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(mgr.subprocess, "Popen", fake_popen)
    sid = mgr.start_session("h", 25565, "U",
                            commands=[{"cmd": "/home", "syntax": "/home", "desc": "h"}])
    assert isinstance(sid, int)
    assert "--commands" in captured["cmd"]
    path = captured["cmd"][captured["cmd"].index("--commands") + 1]
    data = _json.loads(open(path).read())
    assert data[0]["cmd"] == "/home"


def test_start_session_writes_policy_file(monkeypatch, tmp_path):
    from backend.bots import mc_agent_manager as mgr

    class FakeProc:
        def __init__(self):
            self.stdin = io.StringIO()
            self.stdout = iter(())
            self.pid = 4322

        def poll(self):
            return None

    captured = {}

    def fake_popen(cmd, **kw):
        captured["cmd"] = cmd
        return FakeProc()

    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(mgr.subprocess, "Popen", fake_popen)
    sid = mgr.start_session("h", 25565, "U",
                            policy={"trusted": ["Bob"], "trade": None})
    assert "--policy" in captured["cmd"]
    path = captured["cmd"][captured["cmd"].index("--policy") + 1]
    data = _json.loads(open(path).read())
    assert data["trusted"] == ["Bob"]


def test_start_session_stores_server_id(monkeypatch, tmp_path):
    """La session retient le server_id (profil) → /active permet de mapper carte ↔ session."""
    from backend.bots import mc_agent_manager as mgr

    class FakeProc:
        def __init__(self):
            self.stdin = io.StringIO()
            self.stdout = iter(())
            self.pid = 4323

        def poll(self):
            return None

    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(mgr.subprocess, "Popen", lambda cmd, **kw: FakeProc())
    sid = mgr.start_session("h", 25565, "U", server_id="ab12cd")
    assert mgr.get_status(sid)["server_id"] == "ab12cd"
    # défaut : None quand non fourni (lancement manuel)
    sid2 = mgr.start_session("h", 25565, "U")
    assert mgr.get_status(sid2)["server_id"] is None


def test_start_session_adds_lang_flag(monkeypatch):
    import io
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    captured = {}

    class FakeProc:
        def __init__(self):
            self.stdin = io.StringIO()
            self.stdout = iter(())
            self.pid = 4324
        def poll(self):
            return None

    def fake_popen(cmd, **kw):
        captured["cmd"] = cmd
        return FakeProc()

    monkeypatch.setattr(mgr.subprocess, "Popen", fake_popen)
    sid = mgr.start_session("h", 25565, "TrainBot", None, "offline", None, None, None, language="it")
    assert "--lang" in captured["cmd"]
    assert captured["cmd"][captured["cmd"].index("--lang") + 1] == "it"


def test_start_session_autonomous_seeds_world_objective(monkeypatch, tmp_path):
    """autonomous=True → écrit un world.json avec l'objectif MVP + passe --world (le bot
    reprend la boucle planner au spawn). C'est le mécanisme « lancer en autonome » du dashboard."""
    import io
    import json as _json
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    captured = {}

    class FakeProc:
        def __init__(self):
            self.stdin = io.StringIO()
            self.stdout = iter(())
            self.pid = 4325
        def poll(self):
            return None

    def fake_popen(cmd, **kw):
        captured["cmd"] = cmd
        return FakeProc()

    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(mgr.subprocess, "Popen", fake_popen)
    sid = mgr.start_session("h", 25565, "U", autonomous=True)
    assert "--world" in captured["cmd"]
    path = captured["cmd"][captured["cmd"].index("--world") + 1]
    data = _json.loads(open(path).read())
    assert data["objective"]["type"] == "stone_pickaxe"
    assert data["objective"]["status"] == "in_progress"
    # la session retient le chemin world pour le nettoyer au stop
    assert mgr._sessions[sid].get("world_path") == str(path)


def test_start_session_no_world_when_not_autonomous(monkeypatch, tmp_path):
    """Par défaut (mode réactif) : pas de --world, pas d'objectif seedé."""
    import io
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    captured = {}

    class FakeProc:
        def __init__(self):
            self.stdin = io.StringIO()
            self.stdout = iter(())
            self.pid = 4326
        def poll(self):
            return None

    def fake_popen(cmd, **kw):
        captured["cmd"] = cmd
        return FakeProc()

    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(mgr.subprocess, "Popen", fake_popen)
    sid = mgr.start_session("h", 25565, "U")
    assert "--world" not in captured["cmd"]
    assert mgr._sessions[sid].get("world_path") is None


def test_stop_session_cleans_world_file(monkeypatch, tmp_path):
    """stop_session supprime le world.json temp (comme cmds/policy)."""
    import io
    import os
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")

    class FakeProc:
        def __init__(self):
            self.stdin = io.StringIO()
            self.stdout = iter(())
            self.pid = 4327
        def poll(self):
            return None
        def terminate(self):
            pass

    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(mgr.subprocess, "Popen", lambda cmd, **kw: FakeProc())
    # neutralise le kill réel (pid factice) → ne touche aucun process de la machine
    monkeypatch.setattr(mgr.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(mgr.os, "killpg", lambda pgid, sig: None)
    sid = mgr.start_session("h", 25565, "U", autonomous=True)
    wp = mgr._sessions[sid]["world_path"]
    assert os.path.exists(wp)
    mgr.stop_session(sid)
    assert not os.path.exists(wp)


def test_start_session_objective_seeds_iron_in_world(monkeypatch, tmp_path):
    """objective='iron_pickaxe' -> le world.json seedé porte ce type (sélectionne la chaîne fer Node)."""
    import io
    import json as _json
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    captured = {}

    class FakeProc:
        def __init__(self):
            self.stdin = io.StringIO()
            self.stdout = iter(())
            self.pid = 4328
        def poll(self):
            return None

    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(mgr.subprocess, "Popen", lambda cmd, **kw: (captured.__setitem__("cmd", cmd) or FakeProc()))
    sid = mgr.start_session("h", 25565, "U", autonomous=True, objective="iron_pickaxe")
    wp = captured["cmd"][captured["cmd"].index("--world") + 1]
    data = _json.loads(open(wp).read())
    assert data["objective"]["type"] == "iron_pickaxe"


def test_start_session_invalid_objective_defaults_stone(monkeypatch, tmp_path):
    """Un objective inconnu retombe sur stone_pickaxe (anti-injection)."""
    import io
    import json as _json
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    captured = {}

    class FakeProc:
        def __init__(self):
            self.stdin = io.StringIO()
            self.stdout = iter(())
            self.pid = 4329
        def poll(self):
            return None

    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(mgr.subprocess, "Popen", lambda cmd, **kw: (captured.__setitem__("cmd", cmd) or FakeProc()))
    sid = mgr.start_session("h", 25565, "U", autonomous=True, objective="rm -rf")
    wp = captured["cmd"][captured["cmd"].index("--world") + 1]
    data = _json.loads(open(wp).read())
    assert data["objective"]["type"] == "stone_pickaxe"
