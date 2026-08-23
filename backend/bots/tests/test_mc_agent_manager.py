import io

import pytest

from backend.bots import mc_agent_manager as mgr


@pytest.fixture(autouse=True)
def _clean_sessions(monkeypatch):
    """Nettoie le registre global entre les tests (évite les sessions fantômes).

    Neutralise aussi l'étalement anti-throttle des batches de mappers (sleep 4.5s
    entre spawns en prod) — la suite resterait correcte mais deviendrait lente."""
    monkeypatch.setattr(mgr, "MAPPER_SPAWN_STAGGER_S", 0)
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


def test_quota_passe_banked_keye_server_user(monkeypatch, tmp_path):
    """Bot ressource (quota + server_id) : --banked <path> keyé server+user → la progression bankée
    survit aux re-créations du tracker (respawn / re-entrée / deploy). Cause racine du plateau."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path)
    captured = {}
    def fake_popen(cmd, **kw):
        captured["cmd"] = cmd
        return FakeProc('{"type":"status","state":"spawned"}\n')
    monkeypatch.setattr(mgr.subprocess, "Popen", fake_popen)
    sid = mgr.start_session("h", 25565, "ResBot1", None, "offline",
                            server_id="8d91a7", objective="resource",
                            quota={"diamond": 64, "iron": 64})
    mgr._sessions[sid]["thread"].join(timeout=2)
    cmd = captured["cmd"]
    assert "--banked" in cmd
    p = cmd[cmd.index("--banked") + 1]
    # keyé par server + user → stable across respawn (même start_for_bot) ET deploy (même user)
    assert "8d91a7" in p and "ResBot1" in p


def test_quota_sans_server_id_pas_de_banked(monkeypatch, tmp_path):
    """Sans server_id (pas de clé stable) : pas de --banked (rétro-compat, jamais de fichier orphelin)."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path)
    captured = {}
    def fake_popen(cmd, **kw):
        captured["cmd"] = cmd
        return FakeProc('{"type":"status","state":"spawned"}\n')
    monkeypatch.setattr(mgr.subprocess, "Popen", fake_popen)
    sid = mgr.start_session("h", 25565, "B", None, "offline",
                            objective="resource", quota={"diamond": 64})
    mgr._sessions[sid]["thread"].join(timeout=2)
    assert "--banked" not in captured["cmd"]


def test_banked_pas_supprime_au_cleanup(monkeypatch, tmp_path):
    """Le fichier banked NE doit PAS être nettoyé à la mort/stop (sinon respawn → progression perdue).
    Durable comme la mémoire de monde (purge manuelle de l'opérateur au swap de monde)."""
    bf = tmp_path / "banked-8d91a7-ResBot1.json"
    bf.write_text('{"diamond": 19}')
    sess = {"banked_path": str(bf), "cmds_path": None, "policy_path": None,
            "world_path": None, "wm_path": None, "quota_path": None, "login_path": None}
    mgr._cleanup_session_files(sess)
    assert bf.exists(), "le cumul bankē doit survivre au cleanup (respawn-durable)"


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


def test_start_session_stealth_flag(monkeypatch):
    """stealth=True → --stealth 1 ; défaut → pas de --stealth MAIS --humanize présent (paquet 1)."""
    import io
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

    monkeypatch.setattr(mgr.subprocess, "Popen", fake_popen)
    mgr.start_session("h", 25565, "TrainBot", stealth=True)
    assert "--stealth" in captured["cmd"]
    assert captured["cmd"][captured["cmd"].index("--stealth") + 1] == "1"
    mgr.start_session("h", 25565, "TrainBot2")
    assert "--stealth" not in captured["cmd"]
    # paquet 1 : le lancement manuel est HUMANISÉ par défaut (bot face à de vrais joueurs)
    assert "--humanize" in captured["cmd"]


def test_start_mappers_sets_respawn_memo_and_humanize(monkeypatch, tmp_path):
    """Spec cartographes : self-healing (memo respawn objective=mapper) + humanisation ciblée."""
    import io
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    cmds = []

    class FakeProc:
        def __init__(self):
            self.stdin = io.StringIO()
            self.stdout = iter(())
            self.pid = 5001
        def poll(self):
            return None

    monkeypatch.setattr(mgr.subprocess, "Popen", lambda cmd, **kw: cmds.append(cmd) or FakeProc())
    monkeypatch.setattr(mgr, "MAPPER_SPAWN_STAGGER_S", 0)
    monkeypatch.setattr(mgr.servers_store, "get_server", lambda gid: {
        "id": gid, "host": "h", "port": 25565, "intelligence": "intermediaire",
        "language": "fr", "has_login": False, "stealth": False,
        "bots": [{"id": "m1", "role": "mapper", "username": "Map1", "auth": "offline"}],
    })
    monkeypatch.setattr(mgr.servers_store, "resolve_commands", lambda g: None)
    monkeypatch.setattr(mgr.servers_store, "resolve_policy", lambda g: None)
    monkeypatch.setattr(mgr.mc_agent_secrets, "get_secret", lambda gid, bid: None)
    out = mgr.start_mappers("g1", 1)
    assert out["launched"] == 1
    assert "--humanize" in cmds[-1]
    sid = out["sessions"][0]
    sess = mgr._sessions.get(sid)
    assert sess is not None and sess.get("respawn", {}).get("objective") == "mapper"
    assert sess["respawn"].get("humanize") is True
    mgr._sessions.pop(sid, None)


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


def test_start_session_passe_world_memory(monkeypatch, tmp_path):
    """server_id présent → bootstrap : écrit la mémoire du groupe + passe --world-memory au bot."""
    import io
    import json as _json
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    captured = {}

    class FakeProc:
        def __init__(self):
            self.stdin = io.StringIO(); self.stdout = iter(()); self.pid = 4400
        def poll(self):
            return None

    def fake_popen(cmd, **kw):
        captured["cmd"] = cmd
        return FakeProc()

    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(mgr.world_memory, "WORLD_MEMORY_DIR", tmp_path / "wm")
    monkeypatch.setattr(mgr.subprocess, "Popen", fake_popen)
    mgr.start_session("h", 25565, "U", server_id="ab12cd")
    assert "--world-memory" in captured["cmd"]
    path = captured["cmd"][captured["cmd"].index("--world-memory") + 1]
    # Depuis le 26/07 le bot lit le fichier LIVE du groupe (voir
    # test_spawn_autres_objectifs_lisent_la_memoire_LIVE) : plus de snapshot par session, donc
    # plus de wm_path a nettoyer au stop.
    assert "--wm-live" in captured["cmd"]
    assert path.endswith("ab12cd.json")
    assert _json is not None


def test_apply_event_route_biome_vers_store(monkeypatch, tmp_path):
    """Un event biome_seen d'une session avec server_id est écrit dans le store du groupe."""
    monkeypatch.setattr(mgr.world_memory, "WORLD_MEMORY_DIR", tmp_path)
    mgr._wm_cache.pop("ab12cd", None)
    s = {"status": "x", "transcript": [], "events": [], "last_error": None, "server_id": "ab12cd"}
    mgr._apply_event(s, {"type": "biome_seen", "world": "w", "name": "forest", "x": 10, "z": 20})
    mem = mgr.world_memory.load("ab12cd")
    assert mem["worlds"]["w"]["biomes"][0]["name"] == "forest"
    mgr._wm_cache.pop("ab12cd", None)


def test_wm_events_includes_ore_events():
    """Les events de minerais exposés sont routés vers le store du groupe (cf. _apply_event)."""
    assert "exposed_ore_found" in mgr._WM_EVENTS
    assert "ore_mined" in mgr._WM_EVENTS
    assert "ore_gone" in mgr._WM_EVENTS


def test_apply_event_no_store_without_server_id(monkeypatch, tmp_path):
    """Sans server_id (lancement manuel) : aucune écriture de mémoire (pas de groupe)."""
    monkeypatch.setattr(mgr.world_memory, "WORLD_MEMORY_DIR", tmp_path)
    s = {"status": "x", "transcript": [], "events": [], "last_error": None, "server_id": None}
    mgr._apply_event(s, {"type": "biome_seen", "world": "w", "name": "forest", "x": 0, "z": 0})
    assert list(tmp_path.glob("*.json")) == []


def test_forget_group_cascade(monkeypatch, tmp_path):
    """forget_group supprime le fichier mémoire + vide le cache (cascade suppression de groupe)."""
    monkeypatch.setattr(mgr.world_memory, "WORLD_MEMORY_DIR", tmp_path)
    m = mgr.world_memory.empty_memory("ab12cd")
    mgr.world_memory.add_biome(m, "w", "forest", 0, 0, at="t1")
    mgr.world_memory.save("ab12cd", m)
    mgr._wm_cache["ab12cd"] = m
    assert mgr.forget_group("ab12cd") is True
    assert "ab12cd" not in mgr._wm_cache
    assert mgr.world_memory.load("ab12cd")["worlds"] == {}


def test_stop_group_stops_only_its_sessions(monkeypatch):
    """stop_group arrête les sessions du groupe ciblé, pas celles des autres groupes."""
    mgr._sessions.clear()
    monkeypatch.setattr(mgr.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(mgr.os, "killpg", lambda pgid, sig: None)

    class P:
        def __init__(self): self.pid = 12345
        def poll(self): return None
        def terminate(self): pass

    mgr._sessions[1] = {"id": 1, "proc": P(), "server_id": "g6", "status": "running"}
    mgr._sessions[2] = {"id": 2, "proc": P(), "server_id": "g6", "status": "running"}
    mgr._sessions[3] = {"id": 3, "proc": P(), "server_id": "g7", "status": "running"}
    assert mgr.stop_group("g6") == 2
    assert mgr._sessions[1]["status"] == "stopped" and mgr._sessions[2]["status"] == "stopped"
    assert mgr._sessions[3]["status"] == "running"


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


def test_start_session_objective_diamond_seeds_world_correctly(monkeypatch, tmp_path):
    """objective='diamond' -> le world.json seedé porte ce type (sélectionne DIAMOND_CHAIN côté Node)."""
    import io
    import json as _json
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    captured = {}

    class FakeProc:
        def __init__(self):
            self.stdin = io.StringIO()
            self.stdout = iter(())
            self.pid = 4330
        def poll(self):
            return None

    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(mgr.subprocess, "Popen", lambda cmd, **kw: (captured.__setitem__("cmd", cmd) or FakeProc()))
    sid = mgr.start_session("h", 25565, "U", autonomous=True, objective="diamond")
    wp = captured["cmd"][captured["cmd"].index("--world") + 1]
    data = _json.loads(open(wp).read())
    assert data["objective"]["type"] == "diamond"
    assert data["objective"]["status"] == "in_progress"


def test_diamond_is_valid_objective():
    """'diamond' doit être dans la whitelist anti-injection."""
    assert "diamond" in mgr.VALID_OBJECTIVES


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


# --- Cartographe (1b/1c) : objectif mapper + secteurs auto-assignés + re-balance live ---

class _MapperProc:
    """Faux subprocess pour les tests mapper : stdin capturé ligne à ligne, vivant jusqu'à kill()."""
    def __init__(self):
        import io as _io
        self.stdin = _io.StringIO()
        self.stdout = iter(())
        self.pid = 5000
        self._alive = True
    def poll(self):
        return None if self._alive else 0


def _spawn_mapper(monkeypatch, tmp_path, captured_cmds, server_id="grp1"):
    procs = []
    def fake_popen(cmd, **kw):
        captured_cmds.append(cmd)
        p = _MapperProc()
        procs.append(p)
        return p
    monkeypatch.setattr(mgr.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(mgr.world_memory, "WORLD_MEMORY_DIR", tmp_path / "wm")
    sid = mgr.start_session("h", 25565, "Mapper", server_id=server_id,
                            autonomous=True, objective="mapper")
    return sid, procs[-1]


def test_mapper_objectif_valide():
    assert "mapper" in mgr.VALID_OBJECTIVES


def test_start_session_mapper_seul_secteur_0_sur_1(monkeypatch, tmp_path):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    cmds = []
    sid, _ = _spawn_mapper(monkeypatch, tmp_path, cmds)
    cmd = cmds[-1]
    assert "--sector-index" in cmd and cmd[cmd.index("--sector-index") + 1] == "0"
    assert "--sector-count" in cmd and cmd[cmd.index("--sector-count") + 1] == "1"
    assert mgr._sessions[sid]["objective"] == "mapper"


def test_deux_mappers_rebalance_le_premier(monkeypatch, tmp_path):
    """Le 2e mapper du groupe est lancé avec (1,2) ET le 1er reçoit {'type':'sector',0,2} sur stdin."""
    import json as _json
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    cmds = []
    sid1, p1 = _spawn_mapper(monkeypatch, tmp_path, cmds)
    sid2, p2 = _spawn_mapper(monkeypatch, tmp_path, cmds)
    cmd2 = cmds[-1]
    assert cmd2[cmd2.index("--sector-index") + 1] == "1"
    assert cmd2[cmd2.index("--sector-count") + 1] == "2"
    lines = [l for l in p1.stdin.getvalue().splitlines() if l.strip()]
    sectors = [_json.loads(l) for l in lines if '"sector"' in l]
    assert sectors and sectors[-1] == {"type": "sector", "index": 0, "count": 2}


def test_stop_mapper_rebalance_le_survivant(monkeypatch, tmp_path):
    """Stop d'un des 2 mappers → le survivant repasse en cercle complet (count 1)."""
    import json as _json
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setattr(mgr.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(mgr.os, "killpg", lambda pgid, sig: None)
    cmds = []
    sid1, p1 = _spawn_mapper(monkeypatch, tmp_path, cmds)
    sid2, p2 = _spawn_mapper(monkeypatch, tmp_path, cmds)
    p2._alive = False  # le process 2 meurt avec le stop
    mgr.stop_session(sid2)
    lines = [l for l in p1.stdin.getvalue().splitlines() if l.strip()]
    sectors = [_json.loads(l) for l in lines if '"sector"' in l]
    assert sectors[-1] == {"type": "sector", "index": 0, "count": 1}


def test_mapper_autre_groupe_pas_compte(monkeypatch, tmp_path):
    """Les mappers d'un AUTRE groupe n'influencent pas l'assignation de secteur."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    cmds = []
    _spawn_mapper(monkeypatch, tmp_path, cmds, server_id="grpA")
    _spawn_mapper(monkeypatch, tmp_path, cmds, server_id="grpB")
    cmd2 = cmds[-1]
    assert cmd2[cmd2.index("--sector-index") + 1] == "0"
    assert cmd2[cmd2.index("--sector-count") + 1] == "1"


def test_non_mapper_pas_de_secteur(monkeypatch, tmp_path):
    """Un objectif non-mapper ne reçoit PAS d'args secteur."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    cmds = []
    def fake_popen(cmd, **kw):
        cmds.append(cmd)
        return _MapperProc()
    monkeypatch.setattr(mgr.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(mgr.world_memory, "WORLD_MEMORY_DIR", tmp_path / "wm")
    mgr.start_session("h", 25565, "U", server_id="grp1", autonomous=True, objective="stone_pickaxe")
    assert "--sector-index" not in cmds[-1]


def test_start_session_passe_world_label(monkeypatch, tmp_path):
    """world_label → --world-label (monde de minage)."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    cmds = []
    def fake_popen(cmd, **kw):
        cmds.append(cmd)
        return _MapperProc()
    monkeypatch.setattr(mgr.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(mgr.world_memory, "WORLD_MEMORY_DIR", tmp_path / "wm")
    mgr.start_session("h", 25565, "U", server_id="grp1", world_label="mining")
    cmd = cmds[-1]
    assert "--world-label" in cmd and cmd[cmd.index("--world-label") + 1] == "mining"


def test_start_session_passe_confine(monkeypatch, tmp_path):
    """confine → --confine "X Z R" (arène : garder le bot près de l'ancre sèche)."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    cmds = []
    def fake_popen(cmd, **kw):
        cmds.append(cmd)
        return _MapperProc()
    monkeypatch.setattr(mgr.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(mgr.world_memory, "WORLD_MEMORY_DIR", tmp_path / "wm")
    mgr.start_session("h", 25565, "U", server_id="grp1", confine="-352 272 14")
    cmd = cmds[-1]
    assert "--confine" in cmd and cmd[cmd.index("--confine") + 1] == "-352 272 14"


def test_start_session_sans_confine_nappend_rien(monkeypatch, tmp_path):
    """Pas de confine → pas de --confine (rétro-compat : comportement de dispersion inchangé)."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    cmds = []
    def fake_popen(cmd, **kw):
        cmds.append(cmd)
        return _MapperProc()
    monkeypatch.setattr(mgr.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(mgr.world_memory, "WORLD_MEMORY_DIR", tmp_path / "wm")
    mgr.start_session("h", 25565, "U", server_id="grp1")
    assert "--confine" not in cmds[-1]


# ---------------------------------------------------------------------------
# Task 6/7 : lancement par bot du roster (start_for_bot / start_mappers) +
# login automatique (login_command, secret jamais en argv)
# ---------------------------------------------------------------------------

def _seed_group(tmp_path, monkeypatch, bots, has_login=False, login_command="/login {pwd}"):
    """Crée un groupe réel via le store (isolé sur tmp_path) + isole les secrets.

    Retourne (group_id, secrets_dir). `bots` = liste de dicts partiels
    {role, username, auth}. Les secrets sont posés à part par l'appelant.
    """
    import json as _json
    servers_file = tmp_path / "mc_agent_servers.json"
    catalog_file = tmp_path / "commands-catalog.json"
    secrets_dir = tmp_path / "mc_agent_secrets"
    catalog_file.write_text("[]", encoding="utf-8")
    monkeypatch.setattr(mgr.servers_store, "SERVERS_PATH", servers_file)
    monkeypatch.setattr(mgr.servers_store, "CATALOG_PATH", catalog_file)
    monkeypatch.setattr(mgr.mc_agent_secrets, "SECRETS_DIR", secrets_dir)
    grp = mgr.servers_store.create_server({
        "name": "G", "host": "play.x", "port": 25570, "auth": "offline",
        "intelligence": "expert", "language": "it",
        "has_login": has_login, "login_command": login_command, "bots": [],
    })
    gid = grp["id"]
    for b in bots:
        created = mgr.servers_store.add_bot(gid, role=b.get("role", "worker"),
                                            username=b["username"], auth=b.get("auth", "offline"))
        b["id"] = created["id"]
    return gid, secrets_dir


def test_start_mappers_assigns_sectors(monkeypatch, tmp_path):
    """start_mappers lance min(count, dispo) mappers avec des secteurs 0..k-1 / count=k."""
    bots = [{"role": "mapper", "username": "M1"}, {"role": "mapper", "username": "M2"},
            {"role": "mapper", "username": "M3"}, {"role": "worker", "username": "W1"}]
    gid, _ = _seed_group(tmp_path, monkeypatch, bots)
    calls = []
    monkeypatch.setattr(mgr, "_spawn_bot", lambda **kw: (calls.append(kw) or (1000 + len(calls))))
    res = mgr.start_mappers(gid, 5)
    assert res["launched"] == 3 and res["available"] == 3
    assert len(calls) == 3
    assert [c["sector_index"] for c in calls] == [0, 1, 2]
    assert all(c["sector_count"] == 3 for c in calls)
    assert all(c["objective"] == "mapper" and c["autonomous"] is True for c in calls)
    assert {c["user"] for c in calls} == {"M1", "M2", "M3"}


def test_start_mappers_staggers_spawns(monkeypatch, tmp_path):
    """Les spawns d'un batch sont étalés (anti connection-throttle MC : ECONNRESET vécu live).

    n spawns → n-1 sleeps de MAPPER_SPAWN_STAGGER_S (pas de sleep avant le premier)."""
    bots = [{"role": "mapper", "username": "M1"}, {"role": "mapper", "username": "M2"},
            {"role": "mapper", "username": "M3"}]
    gid, _ = _seed_group(tmp_path, monkeypatch, bots)
    monkeypatch.setattr(mgr, "MAPPER_SPAWN_STAGGER_S", 4.5)
    sleeps = []
    monkeypatch.setattr(mgr.time, "sleep", lambda s: sleeps.append(s))
    monkeypatch.setattr(mgr, "_spawn_bot", lambda **kw: 1)
    mgr.start_mappers(gid, 3)
    assert sleeps == [4.5, 4.5]


def test_start_mappers_zero_dispo(monkeypatch, tmp_path):
    """Aucun mapper dans le roster → launched 0, available 0, aucune session."""
    gid, _ = _seed_group(tmp_path, monkeypatch, [{"role": "worker", "username": "W1"}])
    monkeypatch.setattr(mgr, "_spawn_bot", lambda **kw: 1)
    res = mgr.start_mappers(gid, 3)
    assert res == {"sessions": [], "launched": 0, "available": 0, "skipped": []}


def test_start_mappers_skips_online_username(monkeypatch, tmp_path):
    """Un mapper dont le username est déjà en ligne (session active du groupe) est exclu du dispo."""
    bots = [{"role": "mapper", "username": "M1"}, {"role": "mapper", "username": "M2"}]
    gid, _ = _seed_group(tmp_path, monkeypatch, bots)

    class P:
        def poll(self):
            return None
    mgr._sessions[9001] = {"id": 9001, "proc": P(), "server_id": gid, "user": "M1", "status": "running"}
    try:
        calls = []
        monkeypatch.setattr(mgr, "_spawn_bot", lambda **kw: (calls.append(kw) or 1))
        res = mgr.start_mappers(gid, 5)
        assert res["available"] == 1 and res["launched"] == 1
        assert calls[0]["user"] == "M2"
    finally:
        mgr._sessions.pop(9001, None)


def test_start_mappers_skips_missing_secret_with_login(monkeypatch, tmp_path):
    """Mapper sans secret sur un serveur à login → SKIPPÉ (pas d'exception), signalé dans skipped."""
    bots = [{"role": "mapper", "username": "M1"}, {"role": "mapper", "username": "M2"}]
    gid, _ = _seed_group(tmp_path, monkeypatch, bots, has_login=True)
    # M1 a un secret, M2 non
    mgr.mc_agent_secrets.set_secret(gid, bots[0]["id"], "pw1")
    calls = []
    monkeypatch.setattr(mgr, "_spawn_bot", lambda **kw: (calls.append(kw) or 1))
    res = mgr.start_mappers(gid, 5)
    assert res["launched"] == 1
    assert res["skipped"] == ["M2"]
    assert calls[0]["user"] == "M1"
    # secteurs recomptés sur les bots EFFECTIVEMENT lancés
    assert calls[0]["sector_count"] == 1 and calls[0]["sector_index"] == 0


def test_start_for_bot_resolves_account(monkeypatch, tmp_path):
    """start_for_bot résout host/port/langue du groupe + le compte (username/auth) du bot."""
    bots = [{"role": "worker", "username": "W1", "auth": "offline"}]
    gid, _ = _seed_group(tmp_path, monkeypatch, bots)
    captured = {}
    monkeypatch.setattr(mgr, "_spawn_bot", lambda **kw: (captured.update(kw) or 42))
    sid = mgr.start_for_bot(gid, bots[0]["id"])
    assert sid == 42
    assert captured["host"] == "play.x" and captured["port"] == 25570
    assert captured["user"] == "W1" and captured["auth"] == "offline"
    assert captured["language"] == "it" and captured["profile"] == "expert"
    assert captured["server_id"] == gid
    assert captured.get("login_command") is None  # pas de login sur ce serveur


def test_start_for_bot_group_introuvable(monkeypatch, tmp_path):
    gid, _ = _seed_group(tmp_path, monkeypatch, [{"username": "W1"}])
    with pytest.raises(LookupError):
        mgr.start_for_bot("zzzzzz", "ffffff")


def test_start_for_bot_bot_introuvable(monkeypatch, tmp_path):
    gid, _ = _seed_group(tmp_path, monkeypatch, [{"username": "W1"}])
    monkeypatch.setattr(mgr, "_spawn_bot", lambda **kw: 1)
    with pytest.raises(LookupError):
        mgr.start_for_bot(gid, "ffffff")


def test_start_for_bot_blocks_same_username_online(monkeypatch, tmp_path):
    """Si un compte du groupe est déjà en ligne (même username), relance refusée (ValueError)."""
    bots = [{"role": "worker", "username": "W1"}]
    gid, _ = _seed_group(tmp_path, monkeypatch, bots)

    class P:
        def poll(self):
            return None
    mgr._sessions[9100] = {"id": 9100, "proc": P(), "server_id": gid, "user": "w1", "status": "running"}
    try:
        monkeypatch.setattr(mgr, "_spawn_bot", lambda **kw: 1)
        with pytest.raises(ValueError):
            mgr.start_for_bot(gid, bots[0]["id"])
    finally:
        mgr._sessions.pop(9100, None)


def test_start_for_bot_missing_secret_with_login_raises(monkeypatch, tmp_path):
    """Serveur à login + pas de secret pour ce bot → ValueError (lancement manuel d'un seul bot)."""
    bots = [{"role": "worker", "username": "W1"}]
    gid, _ = _seed_group(tmp_path, monkeypatch, bots, has_login=True)
    monkeypatch.setattr(mgr, "_spawn_bot", lambda **kw: 1)
    with pytest.raises(ValueError):
        mgr.start_for_bot(gid, bots[0]["id"])


def test_login_command_passed_when_has_login(monkeypatch, tmp_path):
    """has_login + secret → _spawn_bot reçoit login_command avec le secret substitué."""
    bots = [{"role": "worker", "username": "W1"}]
    gid, _ = _seed_group(tmp_path, monkeypatch, bots, has_login=True, login_command="/login {pwd}")
    mgr.mc_agent_secrets.set_secret(gid, bots[0]["id"], "abc")
    captured = {}
    monkeypatch.setattr(mgr, "_spawn_bot", lambda **kw: (captured.update(kw) or 1))
    mgr.start_for_bot(gid, bots[0]["id"])
    assert captured["login_command"] == "/login abc"


def test_spawn_writes_login_file_not_argv(monkeypatch, tmp_path):
    """_spawn_bot(login_command=...) écrit un fichier temp chmod 600, passe --login-command <path>,
    et NE met JAMAIS le secret dans l'argv. stop_session nettoie le fichier."""
    import os
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    captured = {}

    def fake_popen(cmd, **kw):
        captured["cmd"] = cmd
        return _MapperProc()

    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(mgr.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(mgr.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(mgr.os, "killpg", lambda pgid, sig: None)

    # Pompe neutralisée : le stdout du fake proc est fini d'office → la pompe nettoierait les
    # fichiers temp (mort naturelle) AVANT nos assertions. Ici on teste le chemin stop_session.
    class _DeadThread:
        def __init__(self, *a, **kw):
            pass
        def start(self):
            pass
    monkeypatch.setattr(mgr.threading, "Thread", _DeadThread)
    sid = mgr._spawn_bot("h", 25565, "U", login_command="/login abc")
    cmd = captured["cmd"]
    assert "--login-command" in cmd
    lp = cmd[cmd.index("--login-command") + 1]
    assert os.path.exists(lp)
    assert open(lp).read() == "/login abc"
    assert (os.stat(lp).st_mode & 0o777) == 0o600
    assert "abc" not in cmd and "/login abc" not in cmd  # secret jamais en argv
    assert mgr._sessions[sid].get("login_path") == lp
    mgr.stop_session(sid)
    assert not os.path.exists(lp)  # nettoyé au stop


@pytest.mark.real_pump_cleanup
def test_natural_death_cleans_login_file(monkeypatch, tmp_path):
    """Mort naturelle du bot (fin du flux stdout, SANS stop_session) → fichiers temp nettoyés.

    Régression revue finale : le login-<sid>.txt contient le secret en clair — il ne doit pas
    s'accumuler dans RUNS_DIR quand un bot crashe/est kické (cas fréquent des cartographes)."""
    import os
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(mgr.subprocess, "Popen", lambda cmd, **kw: _MapperProc())
    sid = mgr._spawn_bot("h", 25565, "U", login_command="/login abc")
    s = mgr._sessions[sid]
    lp = s["login_path"]
    assert os.path.exists(lp)
    s["thread"].join(timeout=5)  # _MapperProc.stdout est fini → la pompe se termine seule
    assert s["status"] == "stopped"
    assert not os.path.exists(lp)  # nettoyé par la pompe, sans stop_session


def test_spawn_bot_uses_explicit_sectors(monkeypatch, tmp_path):
    """sector_index/sector_count explicites priment sur le calcul auto (compat mapper batch)."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    captured = {}
    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(mgr.world_memory, "WORLD_MEMORY_DIR", tmp_path / "wm")
    monkeypatch.setattr(mgr.subprocess, "Popen", lambda cmd, **kw: (captured.__setitem__("cmd", cmd) or _MapperProc()))
    mgr._spawn_bot("h", 25565, "M", server_id="grp1", autonomous=True, objective="mapper",
                   sector_index=2, sector_count=5)
    cmd = captured["cmd"]
    assert cmd[cmd.index("--sector-index") + 1] == "2"
    assert cmd[cmd.index("--sector-count") + 1] == "5"


def test_resource_is_valid_objective():
    """'resource' (bot ressource : mine les ores exposés de la carte) est un objectif valide."""
    assert "resource" in mgr.VALID_OBJECTIVES


# --- Mode quota (bots ressources multi-quota) ---

def _fake_spawn_env(monkeypatch, tmp_path):
    import io
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    captured = {}

    class FakeProc:
        def __init__(self):
            self.stdin = io.StringIO(); self.stdout = iter(()); self.pid = 4400
        def poll(self):
            return None

    def fake_popen(cmd, **kw):
        captured["cmd"] = cmd
        return FakeProc()

    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(mgr.world_memory, "WORLD_MEMORY_DIR", tmp_path / "wm")
    monkeypatch.setattr(mgr.subprocess, "Popen", fake_popen)
    return captured


def test_spawn_quota_sidecar_et_flag(monkeypatch, tmp_path):
    """quota fourni → sidecar quota-<sid>.json + --quota ; nettoyé au stop."""
    import json as _json
    captured = _fake_spawn_env(monkeypatch, tmp_path)
    sid = mgr.start_session("h", 25565, "U", server_id="ab12cd", objective="resource",
                            quota={"diamond": 15, "iron": 64})
    cmd = captured["cmd"]
    assert "--quota" in cmd
    qpath = cmd[cmd.index("--quota") + 1]
    assert _json.loads(open(qpath).read()) == {"diamond": 15, "iron": 64}
    assert mgr._sessions[sid].get("quota_path") == str(qpath)
    mgr._cleanup_session_files(mgr._sessions[sid])
    import os as _os
    assert not _os.path.exists(qpath)


def test_spawn_resource_wm_live_et_claims(monkeypatch, tmp_path):
    """objective=resource + server_id → --world-memory pointe le fichier LIVE du groupe
    + --wm-live 1 + --claims claims-<group>.json (partagé, PAS nettoyé par session)."""
    captured = _fake_spawn_env(monkeypatch, tmp_path)
    sid = mgr.start_session("h", 25565, "U", server_id="ab12cd", objective="resource")
    cmd = captured["cmd"]
    assert "--wm-live" in cmd
    wm = cmd[cmd.index("--world-memory") + 1]
    assert wm.endswith("ab12cd.json") and "wm" in wm          # chemin LIVE du groupe
    assert "--claims" in cmd
    claims = cmd[cmd.index("--claims") + 1]
    assert claims.endswith("claims-ab12cd.json")
    # le claims path n'est PAS dans les fichiers nettoyés par session (partagé entre bots)
    s = mgr._sessions[sid]
    assert "claims" not in {k: v for k, v in s.items() if k.endswith("_path") and v}.get("claims_path", "")
    assert s.get("wm_path") is None                            # pas de snapshot à nettoyer


def test_spawn_mapper_wm_live_et_frontier(monkeypatch, tmp_path):
    """Phase 2 : mapper → mémoire LIVE + --frontier (couverture partagée), pas de claims."""
    captured = _fake_spawn_env(monkeypatch, tmp_path)
    mgr.start_session("h", 25565, "U", server_id="ab12cd", objective="mapper")
    cmd = captured["cmd"]
    assert "--wm-live" in cmd
    assert "--frontier" in cmd
    assert "--claims" not in cmd
    wm = cmd[cmd.index("--world-memory") + 1]
    assert wm.endswith("ab12cd.json")


def test_spawn_autres_objectifs_lisent_la_memoire_LIVE(monkeypatch, tmp_path):
    """Les objectifs hors resource/mapper lisent la memoire LIVE du groupe, PAS un snapshot.

    Contrat INVERSE le 26/07 (run world_mn3). Avant : snapshot fige au demarrage du process.
    C'etait a l'envers — les mappeurs, qui ECRIVENT la carte, la relisaient en direct, et les
    workers qui la CONSOMMENT travaillaient sur une photo qui vieillit. Mesure : les 2 workers
    jamais plantes tournaient sur un instantane pris juste apres une purge de memoire (donc
    ZERO cellule epuisee) et ont boucle 50 min sur la meme cellule (0,0) que les autres bots
    savaient pelee ; les 2 workers relances apres un crash avaient une carte fraiche et sont
    les seuls a avoir progresse. Le snapshot condamnait le bot le plus ANCIEN a la carte la
    plus perimee.
    """
    captured = _fake_spawn_env(monkeypatch, tmp_path)
    mgr.start_session("h", 25565, "U", server_id="ab12cd", objective="stone_pickaxe")
    cmd = captured["cmd"]
    assert "--wm-live" in cmd
    assert "--frontier" not in cmd          # la frontiere reste propre aux mappeurs
    # Les claims sont partages par TOUS les bots du groupe depuis l'armure des cartographes
    # (26/07) : la cible d'un don est deterministe, sans reservation les 5 workers forgeraient
    # un set pour le meme mappeur.
    assert "--claims" in cmd
    assert cmd[cmd.index("--claims") + 1].endswith("claims-ab12cd.json")
    wm = cmd[cmd.index("--world-memory") + 1]
    assert "worldmem-" not in wm            # plus de snapshot fige
    assert wm.endswith("ab12cd.json")       # fichier LIVE du groupe


def test_apply_event_quota_progress_session(monkeypatch, tmp_path):
    """quota_progress → session['quota'] ; quota_done → session['quota_done']."""
    s = {"status": "x", "transcript": [], "events": [], "last_error": None, "server_id": None}
    counts = {"diamond": {"have": 3, "target": 15}}
    mgr._apply_event(s, {"type": "quota_progress", "counts": counts})
    assert s["quota"] == counts
    mgr._apply_event(s, {"type": "quota_done", "mined": 9})
    assert s["quota_done"] is True


def test_public_expose_quota(monkeypatch):
    """_public inclut quota/quota_done (affichage barres dashboard)."""
    s = {"id": 1, "status": "running", "host": "h", "user": "U", "last_error": None,
         "server_id": "ab12cd", "quota": {"iron": {"have": 1, "target": 64}}, "quota_done": False}
    pub = mgr._public(s)
    assert pub["quota"] == {"iron": {"have": 1, "target": 64}}
    assert pub["quota_done"] is False


def test_wm_events_includes_ores_found():
    assert "ores_found" in mgr._WM_EVENTS


# --- Phase 2 : self-healing (auto-respawn des sessions resource mortes) ---

def test_pump_respawns_dead_resource_session(monkeypatch):
    """Mort naturelle d'une session resource → start_for_bot re-déclenché (timer)."""
    import io
    calls = {}

    def fake_start_for_bot(gid, bid, **kw):
        calls.update({"gid": gid, "bid": bid, **kw})
        return 99

    monkeypatch.setattr(mgr, "start_for_bot", fake_start_for_bot)

    fired = {}

    class FakeTimer:
        def __init__(self, delay, fn):
            fired["delay"] = delay
            self.fn = fn
            self.daemon = False
        def start(self):
            self.fn()          # exécute immédiatement (pas d'attente en test)

    monkeypatch.setattr(mgr.threading, "Timer", FakeTimer)
    mgr._sessions[99] = {"events": [], "transcript": [], "last_error": None, "status": "x"}
    session = {
        "status": "running", "transcript": [], "events": [], "last_error": None,
        "objective": "resource", "server_id": "ab12cd", "respawn_count": 1,
        "respawn": {"group_id": "ab12cd", "bot_id": "b1", "model": None,
                    "autonomous": True, "objective": "resource", "world_label": None,
                    "quota": {"iron": 64}},
        "cmds_path": None, "policy_path": None, "world_path": None,
        "wm_path": None, "quota_path": None, "login_path": None,
    }
    mgr._pump(session, io.StringIO(""))   # flux vide → fin immédiate (mort naturelle)
    assert calls.get("gid") == "ab12cd" and calls.get("bid") == "b1"
    assert calls.get("quota") == {"iron": 64}
    assert 15.0 <= fired["delay"] < 23.0  # 15 s + jitter anti-synchronisation (phase 3)
    # sans spawned_at → vie LONGUE → le compteur de cap est REMIS À ZÉRO (RC2 water-wall :
    # seules les vies courtes consécutives usent le cap, une vie longue pardonne tout)
    assert mgr._sessions[99]["respawn_count"] == 0
    mgr._sessions.pop(99, None)


def test_pump_no_respawn_when_user_stopped(monkeypatch):
    import io
    calls = []
    monkeypatch.setattr(mgr, "start_for_bot", lambda *a, **k: calls.append(a) or 99)

    class FakeTimer:
        def __init__(self, delay, fn): self.fn = fn; self.daemon = False
        def start(self): self.fn()

    monkeypatch.setattr(mgr.threading, "Timer", FakeTimer)
    session = {"status": "running", "transcript": [], "events": [], "last_error": None,
               "objective": "resource", "user_stopped": True, "respawn_count": 0,
               "respawn": {"group_id": "g", "bot_id": "b"},
               "cmds_path": None, "policy_path": None, "world_path": None,
               "wm_path": None, "quota_path": None, "login_path": None}
    mgr._pump(session, io.StringIO(""))
    assert calls == []


def test_pump_respawn_capped(monkeypatch):
    import io
    calls = []
    monkeypatch.setattr(mgr, "start_for_bot", lambda *a, **k: calls.append(a) or 99)

    class FakeTimer:
        def __init__(self, delay, fn): self.fn = fn; self.daemon = False
        def start(self): self.fn()

    monkeypatch.setattr(mgr.threading, "Timer", FakeTimer)
    # Cap NOUVEAU CONTRAT (RC2 water-wall) : 12 respawns à vies COURTES consécutives → abandon.
    # (L'ancien cap absolu tuait la flotte pendant un simple freeze serveur transitoire.)
    session = {"status": "running", "transcript": [], "events": [], "last_error": None,
               "objective": "resource", "respawn_count": 12,
               "spawned_at": mgr.time.time() - 21,        # vie courte (reconnect storm)
               "respawn": {"group_id": "g", "bot_id": "b"},
               "cmds_path": None, "policy_path": None, "world_path": None,
               "wm_path": None, "quota_path": None, "login_path": None}
    mgr._pump(session, io.StringIO(""))
    assert calls == []
    assert any(e.get("type") == "respawn_given_up" and e.get("why") == "cap"
               for e in session["events"])


def test_pump_gives_up_on_crash_on_spawn(monkeypatch):
    """3 morts < 15 s d'affilée → ABANDON (plus de respawn) + event respawn_given_up."""
    import io
    calls = []
    monkeypatch.setattr(mgr, "start_for_bot", lambda *a, **k: calls.append(a) or 99)

    class FakeTimer:
        def __init__(self, delay, fn): self.fn = fn; self.daemon = False
        def start(self): self.fn()

    monkeypatch.setattr(mgr.threading, "Timer", FakeTimer)
    session = {"status": "running", "transcript": [], "events": [], "last_error": None,
               "objective": "resource", "respawn_count": 4, "fast_fail_count": 2,
               "spawned_at": mgr.time.time() - 4,          # morte 4 s après le spawn (3e fois)
               "respawn": {"group_id": "g", "bot_id": "b"},
               "cmds_path": None, "policy_path": None, "world_path": None,
               "wm_path": None, "quota_path": None, "login_path": None}
    mgr._pump(session, io.StringIO(""))
    assert calls == []                                     # PAS de respawn
    assert any(e.get("type") == "respawn_given_up" for e in session["events"])


def test_pump_fast_fail_count_propagates_and_resets(monkeypatch):
    """Mort rapide n°1-2 → respawn avec fast_fail_count hérité ; vie longue → compteur remis à 0."""
    import io
    spawned = {}
    monkeypatch.setattr(mgr, "start_for_bot", lambda *a, **k: 99)

    class FakeTimer:
        def __init__(self, delay, fn): self.fn = fn; self.daemon = False
        def start(self): self.fn()

    monkeypatch.setattr(mgr.threading, "Timer", FakeTimer)
    mgr._sessions[99] = {"events": [], "transcript": [], "last_error": None, "status": "x"}
    base = {"status": "running", "transcript": [], "events": [], "last_error": None,
            "objective": "resource", "respawn_count": 0,
            "respawn": {"group_id": "g", "bot_id": "b"},
            "cmds_path": None, "policy_path": None, "world_path": None,
            "wm_path": None, "quota_path": None, "login_path": None}
    # mort rapide n°1 (fast_fail_count absent → 1)
    s1 = dict(base, spawned_at=mgr.time.time() - 3, events=[])
    mgr._pump(s1, io.StringIO(""))
    assert mgr._sessions[99]["fast_fail_count"] == 1
    # vie LONGUE (>15 s) → compteur remis à 0
    s2 = dict(base, spawned_at=mgr.time.time() - 120, fast_fail_count=2, events=[])
    mgr._pump(s2, io.StringIO(""))
    assert mgr._sessions[99]["fast_fail_count"] == 0
    mgr._sessions.pop(99, None)


def test_pump_adopted_session_none_counters_still_respawn(monkeypatch):
    """Session adoptée du registre : compteurs PRÉSENTS à None (_REG_FIELDS sérialise en null
    les clés jamais posées). Une mort <60 s ne doit pas crasher le plan (None+1) — sinon le
    self-healing meurt en silence dans le thread de pompe pour toute session adoptée."""
    import io
    monkeypatch.setattr(mgr, "start_for_bot", lambda *a, **k: 99)

    class FakeTimer:
        def __init__(self, delay, fn): self.fn = fn; self.daemon = False
        def start(self): self.fn()

    monkeypatch.setattr(mgr.threading, "Timer", FakeTimer)
    mgr._sessions[99] = {"events": [], "transcript": [], "last_error": None, "status": "x"}
    s = {"status": "running", "transcript": [], "events": [], "last_error": None,
         "objective": "resource", "respawn_count": None, "fast_fail_count": None,
         "short_count": None, "spawned_at": mgr.time.time() - 4,
         "respawn": {"group_id": "g", "bot_id": "b"},
         "cmds_path": None, "policy_path": None, "world_path": None,
         "wm_path": None, "quota_path": None, "login_path": None}
    mgr._pump(s, io.StringIO(""))
    assert mgr._sessions[99]["fast_fail_count"] == 1
    mgr._sessions.pop(99, None)


# ── Capture-clone : câblage --style/--clips au niveau du groupe (clone_player) ──
# Si le profil serveur a `clone_player` ET que ses captures REC sont distillées
# (data/mc-captures-distilled/<joueur>/), _spawn_bot passe --style/--clips au bot →
# il rejoue la motricité humaine réelle. Best-effort + rétro-compat strict (absent → inchangé).

def _setup_distilled(tmp_path, monkeypatch, player="Massitom2008"):
    distilled = tmp_path / "distilled"
    pdir = distilled / player
    (pdir / "clips").mkdir(parents=True)
    (pdir / "style.json").write_text('{"player":"%s"}' % player, encoding="utf-8")
    monkeypatch.setattr(mgr, "DISTILLED_DIR", distilled)
    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(mgr.world_memory, "load", lambda gid: {})
    return pdir


def _capture_cmd(monkeypatch):
    captured = {}

    def fake_popen(cmd, **kw):
        captured["cmd"] = cmd
        return FakeProc("")

    monkeypatch.setattr(mgr.subprocess, "Popen", fake_popen)
    return captured


def test_spawn_clone_player_passe_style_et_clips(monkeypatch, tmp_path):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    pdir = _setup_distilled(tmp_path, monkeypatch)
    monkeypatch.setattr(mgr.servers_store, "get_server",
                        lambda gid: {"host": "h", "port": 25566, "clone_player": "Massitom2008"})
    captured = _capture_cmd(monkeypatch)
    mgr.start_session("h", 25566, "Bot", None, server_id="grp1")
    cmd = captured["cmd"]
    assert "--style" in cmd
    assert cmd[cmd.index("--style") + 1] == str(pdir / "style.json")
    assert "--clips" in cmd
    assert cmd[cmd.index("--clips") + 1] == str(pdir / "clips")


def test_spawn_sans_clone_player_inchange(monkeypatch, tmp_path):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    _setup_distilled(tmp_path, monkeypatch)
    monkeypatch.setattr(mgr.servers_store, "get_server",
                        lambda gid: {"host": "h", "port": 25566})  # pas de clone_player
    captured = _capture_cmd(monkeypatch)
    mgr.start_session("h", 25566, "Bot", None, server_id="grp1")
    assert "--style" not in captured["cmd"]
    assert "--clips" not in captured["cmd"]


def test_spawn_clone_player_distill_absent_inchange(monkeypatch, tmp_path):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    _setup_distilled(tmp_path, monkeypatch)  # distille Massitom2008 uniquement
    monkeypatch.setattr(mgr.servers_store, "get_server",
                        lambda gid: {"host": "h", "port": 25566, "clone_player": "Inconnu99"})
    captured = _capture_cmd(monkeypatch)
    mgr.start_session("h", 25566, "Bot", None, server_id="grp1")
    assert "--style" not in captured["cmd"]  # pas de distillation pour Inconnu99 → best-effort
    assert "--clips" not in captured["cmd"]


def test_clone_player_path_traversal_neutralise(monkeypatch, tmp_path):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    _setup_distilled(tmp_path, monkeypatch)
    monkeypatch.setattr(mgr.servers_store, "get_server",
                        lambda gid: {"host": "h", "port": 25566, "clone_player": "../../etc"})
    captured = _capture_cmd(monkeypatch)
    mgr.start_session("h", 25566, "Bot", None, server_id="grp1")
    # nom assaini → aucune évasion de DISTILLED_DIR, aucun fichier ne matche → pas de flags
    assert "--style" not in captured["cmd"]
    assert "--clips" not in captured["cmd"]


# ---------------------------------------------------------------------------
# Run nether 2026-07-13 : objectifs armure + mode sans-give (zéro /give)
# ---------------------------------------------------------------------------

def test_armor_objectives_valides():
    """iron_armor / diamond_armor dans la whitelist anti-injection (chaînes armure Node)."""
    assert "iron_armor" in mgr.VALID_OBJECTIVES
    assert "diamond_armor" in mgr.VALID_OBJECTIVES


def test_armor_objectives_selfheal():
    """Les objectifs armure sont auto-respawnés (nuit sans intervention, comme resource/mapper)."""
    assert "iron_armor" in mgr.RESPAWN_OBJECTIVES
    assert "diamond_armor" in mgr.RESPAWN_OBJECTIVES
    assert "resource" in mgr.RESPAWN_OBJECTIVES and "mapper" in mgr.RESPAWN_OBJECTIVES


def test_start_session_no_give_passe_le_flag(monkeypatch, tmp_path):
    """no_give=True → --no-give 1 dans l'argv Node + world seedé avec l'objectif armure."""
    import io
    import json as _json
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    captured = {}

    class FakeProc:
        def __init__(self):
            self.stdin = io.StringIO()
            self.stdout = iter(())
            self.pid = 4331
        def poll(self):
            return None

    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(mgr.subprocess, "Popen", lambda cmd, **kw: (captured.__setitem__("cmd", cmd) or FakeProc()))
    mgr.start_session("h", 25565, "U", autonomous=True, objective="iron_armor", no_give=True)
    cmd = captured["cmd"]
    assert "--no-give" in cmd and cmd[cmd.index("--no-give") + 1] == "1"
    wp = cmd[cmd.index("--world") + 1]
    assert _json.loads(open(wp).read())["objective"]["type"] == "iron_armor"


def test_start_session_sans_no_give_retro_compat(monkeypatch, tmp_path):
    """Sans no_give → PAS de --no-give dans l'argv (comportement historique inchangé)."""
    import io
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    captured = {}

    class FakeProc:
        def __init__(self):
            self.stdin = io.StringIO()
            self.stdout = iter(())
            self.pid = 4332
        def poll(self):
            return None

    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(mgr.subprocess, "Popen", lambda cmd, **kw: (captured.__setitem__("cmd", cmd) or FakeProc()))
    mgr.start_session("h", 25565, "U", autonomous=True, objective="stone_pickaxe")
    assert "--no-give" not in captured["cmd"]


def test_start_for_bot_no_give_dans_respawn_memo(monkeypatch, tmp_path):
    """no_give survit au self-healing : mémorisé dans le memo respawn du roster."""
    import io
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    cmds = []

    class FakeProc:
        def __init__(self):
            self.stdin = io.StringIO()
            self.stdout = iter(())
            self.pid = 5002
        def poll(self):
            return None

    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(mgr.subprocess, "Popen", lambda cmd, **kw: cmds.append(cmd) or FakeProc())
    monkeypatch.setattr(mgr.servers_store, "get_server", lambda gid: {
        "id": gid, "host": "h", "port": 25565, "intelligence": "intermediaire",
        "language": "fr", "has_login": False, "stealth": False,
        "bots": [{"id": "n1", "role": "worker", "username": "NethBot1", "auth": "offline"}],
    })
    monkeypatch.setattr(mgr.servers_store, "resolve_commands", lambda g: None)
    monkeypatch.setattr(mgr.servers_store, "resolve_policy", lambda g: None)
    monkeypatch.setattr(mgr.mc_agent_secrets, "get_secret", lambda gid, bid: None)
    sid = mgr.start_for_bot("g9", "n1", autonomous=True, objective="iron_armor", no_give=True)
    assert "--no-give" in cmds[-1]
    sess = mgr._sessions.get(sid)
    assert sess is not None and sess["respawn"].get("no_give") is True
    assert sess["respawn"].get("objective") == "iron_armor"
    mgr._sessions.pop(sid, None)


# ── Back-off self-healing (RC2 water-wall) : reconnect storm + freeze serveur transitoire ──
# Vécu 2026-07-14 world_ax1 : vies de ~21 s (join → « moved too quickly » → deco) échappaient à
# la garde crash-on-spawn (<15 s) → respawn toutes les 15 s jusqu'au cap 12 DÉFINITIF, consommé
# pendant un freeze serveur → flotte morte pour la nuit. _respawn_plan = décision PURE :
# back-off progressif sur vies courtes (<60 s), reset complet (cap inclus) sur vie longue.

def test_respawn_plan_vie_longue_reset_complet():
    p = mgr._respawn_plan(lifetime_s=300, throttled=False, fast_fails_prev=2,
                          short_count_prev=5, respawn_count_prev=11)
    assert p["action"] == "respawn"
    assert p["delay_s"] == 15.0
    assert p["fast_fails"] == 0
    assert p["short_count"] == 0
    assert p["respawn_count"] == 0   # vie longue → le cap repart de zéro (freeze transitoire pardonné)


def test_respawn_plan_backoff_progressif_vies_courtes():
    # vie ~21 s (reconnect storm) : délais croissants 15 → 60 → 120 → 300 (cap)
    p1 = mgr._respawn_plan(lifetime_s=21, throttled=False, fast_fails_prev=0,
                           short_count_prev=0, respawn_count_prev=0)
    assert (p1["action"], p1["delay_s"], p1["short_count"]) == ("respawn", 15.0, 1)
    p2 = mgr._respawn_plan(lifetime_s=21, throttled=False, fast_fails_prev=0,
                           short_count_prev=1, respawn_count_prev=1)
    assert (p2["action"], p2["delay_s"], p2["short_count"]) == ("respawn", 60.0, 2)
    p3 = mgr._respawn_plan(lifetime_s=21, throttled=False, fast_fails_prev=0,
                           short_count_prev=2, respawn_count_prev=2)
    assert p3["delay_s"] == 120.0
    p4 = mgr._respawn_plan(lifetime_s=21, throttled=False, fast_fails_prev=0,
                           short_count_prev=3, respawn_count_prev=3)
    assert p4["delay_s"] == 300.0
    p9 = mgr._respawn_plan(lifetime_s=21, throttled=False, fast_fails_prev=0,
                           short_count_prev=9, respawn_count_prev=9)
    assert p9["delay_s"] == 300.0   # plafonné


def test_respawn_plan_crash_on_spawn_inchange():
    # 3 vies < 15 s d'affilée → abandon (poison pill : kit cassé, crash-loop au join)
    p = mgr._respawn_plan(lifetime_s=4, throttled=False, fast_fails_prev=2,
                          short_count_prev=2, respawn_count_prev=2)
    assert p["action"] == "give_up"
    assert p["why"] == "crash_on_spawn"
    # 2 vies courtes seulement → on respawne encore (fast_fails propagé)
    p2 = mgr._respawn_plan(lifetime_s=4, throttled=False, fast_fails_prev=1,
                           short_count_prev=1, respawn_count_prev=1)
    assert p2["action"] == "respawn"
    assert p2["fast_fails"] == 2


def test_respawn_plan_cap_vies_courtes_consecutives():
    # 12 respawns à vies courtes CONSÉCUTIVES → abandon (≈45 min de tentatives espacées)
    p = mgr._respawn_plan(lifetime_s=21, throttled=False, fast_fails_prev=0,
                          short_count_prev=11, respawn_count_prev=12)
    assert p["action"] == "give_up"
    assert p["why"] == "cap"


def test_respawn_plan_throttled_neutre():
    # collision de join (« Connection throttled ») : ni crash ni vie courte — compteurs gelés
    p = mgr._respawn_plan(lifetime_s=3, throttled=True, fast_fails_prev=2,
                          short_count_prev=4, respawn_count_prev=5)
    assert p["action"] == "respawn"
    assert p["fast_fails"] == 0          # comme avant : throttled ne compte pas pour crash_on_spawn
    assert p["short_count"] == 4         # back-off ni monté ni reset
    assert p["respawn_count"] == 5       # n'use pas le cap
    assert p["delay_s"] == 300.0         # délai courant du back-off (short_count 4 → cap)


def test_spawn_bot_passes_positions_file(monkeypatch, tmp_path):
    """TP-au-mappeur : tout bot d'un groupe reçoit --positions positions-<group>.json
    (heartbeat partagé, même dossier que les claims) — workers ET mappers."""
    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(mgr.world_memory, "load", lambda gid: {})
    monkeypatch.setattr(mgr.world_memory, "WORLD_MEMORY_DIR", tmp_path / "wm")
    captured = _capture_cmd(monkeypatch)
    monkeypatch.setattr(mgr.servers_store, "get_server", lambda sid: {
        "id": "g1", "host": "h", "port": 25565, "user": "T", "auth": "offline",
        "intelligence": "intermediaire", "language": "fr", "stealth": False,
        "bots": [{"id": "b1", "role": "worker", "username": "ResBot1", "auth": "offline"},
                 {"id": "b2", "role": "mapper", "username": "MapBot1", "auth": "offline"}],
    })
    monkeypatch.setattr(mgr.servers_store, "resolve_commands", lambda s: [])
    monkeypatch.setattr(mgr.servers_store, "resolve_policy",
                        lambda s: {"trusted": [], "trade": None, "group_bots": ["ResBot1", "MapBot1"]})
    mgr.start_for_bot("g1", "b1", objective="resource")
    cmd = [str(c) for c in captured["cmd"]]
    assert "--positions" in cmd
    assert cmd[cmd.index("--positions") + 1].endswith("positions-g1.json")
    mgr.start_for_bot("g1", "b2", objective="mapper")
    cmd2 = [str(c) for c in captured["cmd"]]
    assert "--positions" in cmd2
    assert cmd2[cmd2.index("--positions") + 1].endswith("positions-g1.json")


# ─── Debounce des écritures de mémoire de monde (25/07/2026) ────────────────────────────────
# Mesuré sur l'Omen : le fichier du groupe fait ~8 Mo (35 k minerais) et `world_memory.save`
# coûte ~300 ms — or il était appelé À CHAQUE event, sous verrou global (donc aussi à chaque
# `ore_mined` des mineurs). Avec l'échantillonnage multi-anneaux du cartographe (jusqu'à 48
# cellules par arrivée) ça devenait 14 s de blocage par arrivée.

def _wm_reset(gid="ab12cd"):
    mgr._wm_cache.pop(gid, None)
    mgr._wm_dirty.pop(gid, None)
    mgr._wm_last_save.pop(gid, None)


def _count_saves(monkeypatch):
    saves = []
    real = mgr.world_memory.save

    def spy(gid, mem, *a, **kw):
        saves.append(gid)
        return real(gid, mem, *a, **kw)

    monkeypatch.setattr(mgr.world_memory, "save", spy)
    return saves


def test_record_world_memory_debounces_saves(monkeypatch, tmp_path):
    """Rafale d'events rapprochés → UNE seule écriture disque (pas une par event)."""
    monkeypatch.setattr(mgr.world_memory, "WORLD_MEMORY_DIR", tmp_path)
    _wm_reset()
    saves = _count_saves(monkeypatch)
    monkeypatch.setattr(mgr, "_wm_clock", lambda: 1000.0)      # horloge figée = rafale instantanée
    for i in range(20):
        mgr._record_world_memory("ab12cd", {"type": "biome_seen", "world": "w",
                                            "name": "forest", "x": i * 128, "z": 0})
    assert len(saves) == 1, f"{len(saves)} écritures disque pour une rafale de 20 events"
    _wm_reset()


def test_record_world_memory_saves_again_after_the_interval(monkeypatch, tmp_path):
    """Passé l'intervalle, l'event suivant repersiste (la carte ne reste pas en RAM)."""
    monkeypatch.setattr(mgr.world_memory, "WORLD_MEMORY_DIR", tmp_path)
    _wm_reset()
    saves = _count_saves(monkeypatch)
    t = [1000.0]
    monkeypatch.setattr(mgr, "_wm_clock", lambda: t[0])
    mgr._record_world_memory("ab12cd", {"type": "biome_seen", "world": "w", "name": "a", "x": 0, "z": 0})
    t[0] += mgr.WM_SAVE_MIN_INTERVAL_S + 0.01
    mgr._record_world_memory("ab12cd", {"type": "biome_seen", "world": "w", "name": "b", "x": 128, "z": 0})
    assert len(saves) == 2
    _wm_reset()


def test_flush_world_memory_persists_pending_events(monkeypatch, tmp_path):
    """Les events retenus par le debounce sont écrits par flush (fin de session, lecture API)."""
    monkeypatch.setattr(mgr.world_memory, "WORLD_MEMORY_DIR", tmp_path)
    _wm_reset()
    monkeypatch.setattr(mgr, "_wm_clock", lambda: 1000.0)
    mgr._record_world_memory("ab12cd", {"type": "biome_seen", "world": "w", "name": "a", "x": 0, "z": 0})
    mgr._record_world_memory("ab12cd", {"type": "biome_seen", "world": "w", "name": "b", "x": 128, "z": 0})
    assert len(mgr.world_memory.load("ab12cd")["worlds"]["w"]["biomes"]) == 1  # le 2e est en attente
    mgr.flush_world_memory("ab12cd")
    assert len(mgr.world_memory.load("ab12cd")["worlds"]["w"]["biomes"]) == 2
    _wm_reset()


def test_on_pump_end_flushes_world_memory(monkeypatch, tmp_path):
    """Mort du bot (crash/kick) → la carte en attente est persistée, jamais perdue."""
    monkeypatch.setattr(mgr.world_memory, "WORLD_MEMORY_DIR", tmp_path)
    _wm_reset()
    monkeypatch.setattr(mgr, "_wm_clock", lambda: 1000.0)
    s = {"status": "x", "transcript": [], "events": [], "last_error": None, "server_id": "ab12cd",
         "objective": "mapper", "id": 1}
    mgr._apply_event(s, {"type": "biome_seen", "world": "w", "name": "a", "x": 0, "z": 0})
    mgr._apply_event(s, {"type": "biome_seen", "world": "w", "name": "b", "x": 128, "z": 0})
    mgr._on_pump_end(s)
    assert len(mgr.world_memory.load("ab12cd")["worlds"]["w"]["biomes"]) == 2
    _wm_reset()


def test_start_session_flushes_world_memory_before_bootstrap(monkeypatch, tmp_path):
    """Un bot qui démarre lit le fichier du groupe : il doit voir la carte COMPLÈTE, pas le disque
    en retard d'un debounce (les cartographes/récolteurs se coordonnent par ce fichier)."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setattr(mgr.world_memory, "WORLD_MEMORY_DIR", tmp_path / "wm")
    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    captured = {}

    def fake_popen(cmd, **kw):
        captured["cmd"] = cmd
        return FakeProc("")

    monkeypatch.setattr(mgr.subprocess, "Popen", fake_popen)
    _wm_reset()
    monkeypatch.setattr(mgr, "_wm_clock", lambda: 1000.0)
    mgr._record_world_memory("ab12cd", {"type": "biome_seen", "world": "w", "name": "a", "x": 0, "z": 0})
    mgr._record_world_memory("ab12cd", {"type": "biome_seen", "world": "w", "name": "b", "x": 128, "z": 0})
    mgr.start_session("h", 25565, "U", server_id="ab12cd")
    path = captured["cmd"][captured["cmd"].index("--world-memory") + 1]
    cells = _json.loads(open(path).read())["worlds"]["w"]["biomes"]
    assert len(cells) == 2, "le bot démarre avec une carte tronquée (debounce non vidé)"
    _wm_reset()


# ── Version protocole forcée + x-ray débridé (run serveur externe, 2026-08-23) ────────────────
# mc_version : le proxy Aternos coupe les status-pings → l'auto-détection mineflayer crashe
# (ECONNRESET). --mc-version <v> la court-circuite. xray : débride le ciblage anti-xray
# (exposedOnly) quand le run l'autorise explicitement.

def _fake_proc_cls(pid):
    import io

    class FakeProc:
        def __init__(self):
            self.stdin = io.StringIO()
            self.stdout = iter(())
            self.pid = pid

        def poll(self):
            return None

    return FakeProc


def test_start_session_mc_version_flag(monkeypatch, tmp_path):
    """mc_version → --mc-version <v> dans l'argv Node ; absent par défaut (rétro-compat)."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    captured = {}
    FakeProc = _fake_proc_cls(4340)
    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(mgr.subprocess, "Popen",
                        lambda cmd, **kw: (captured.__setitem__("cmd", cmd) or FakeProc()))
    mgr.start_session("h", 25565, "U", mc_version="1.21.11")
    cmd = captured["cmd"]
    assert "--mc-version" in cmd and cmd[cmd.index("--mc-version") + 1] == "1.21.11"
    mgr.start_session("h", 25565, "U2")
    assert "--mc-version" not in captured["cmd"]


def test_start_session_xray_flag(monkeypatch, tmp_path):
    """xray=True → --xray 1 ; défaut → absent (le filtre anti-xray reste actif)."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    captured = {}
    FakeProc = _fake_proc_cls(4341)
    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(mgr.subprocess, "Popen",
                        lambda cmd, **kw: (captured.__setitem__("cmd", cmd) or FakeProc()))
    mgr.start_session("h", 25565, "U", xray=True)
    cmd = captured["cmd"]
    assert "--xray" in cmd and cmd[cmd.index("--xray") + 1] == "1"
    mgr.start_session("h", 25565, "U2")
    assert "--xray" not in captured["cmd"]


def _stub_group(monkeypatch, extra=None):
    group = {
        "id": "g10", "host": "h", "port": 25565, "intelligence": "intermediaire",
        "language": "fr", "has_login": False, "stealth": False,
        "bots": [{"id": "n1", "role": "worker", "username": "EmberBot1", "auth": "offline"}],
    }
    group.update(extra or {})
    monkeypatch.setattr(mgr.servers_store, "get_server", lambda gid: group)
    monkeypatch.setattr(mgr.servers_store, "resolve_commands", lambda g: None)
    monkeypatch.setattr(mgr.servers_store, "resolve_policy", lambda g: None)
    monkeypatch.setattr(mgr.mc_agent_secrets, "get_secret", lambda gid, bid: None)
    return group


def test_start_for_bot_propage_mc_version_du_groupe(monkeypatch, tmp_path):
    """La version est RÉSOLUE DU GROUPE à chaque lancement → un respawn la re-résout gratis."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    captured = {}
    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    _stub_group(monkeypatch, {"mc_version": "1.21.11"})
    monkeypatch.setattr(mgr, "_spawn_bot", lambda **kw: (captured.update(kw) or 77))
    mgr.start_for_bot("g10", "n1", autonomous=True, objective="iron_armor")
    assert captured["mc_version"] == "1.21.11"


def test_start_for_bot_sans_mc_version_passe_none(monkeypatch, tmp_path):
    """Groupe sans mc_version (ou "") → None : aucun flag, auto-détection historique."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    captured = {}
    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    _stub_group(monkeypatch, {"mc_version": ""})
    monkeypatch.setattr(mgr, "_spawn_bot", lambda **kw: (captured.update(kw) or 78))
    mgr.start_for_bot("g10", "n1")
    assert captured["mc_version"] is None


def test_start_for_bot_xray_dans_respawn_memo(monkeypatch, tmp_path):
    """xray survit au self-healing : un bot relancé après une mort garde son débridage (#66a)."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    cmds = []
    FakeProc = _fake_proc_cls(5010)
    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(mgr.subprocess, "Popen", lambda cmd, **kw: cmds.append(cmd) or FakeProc())
    _stub_group(monkeypatch, {"mc_version": "1.21.11"})
    sid = mgr.start_for_bot("g10", "n1", autonomous=True, objective="iron_armor", xray=True)
    assert "--xray" in cmds[-1]
    assert "--mc-version" in cmds[-1]
    sess = mgr._sessions.get(sid)
    assert sess is not None and sess["respawn"].get("xray") is True
    mgr._sessions.pop(sid, None)


def test_start_for_bot_sans_xray_memo_false(monkeypatch, tmp_path):
    """Défaut : le memo porte xray=False → un respawn ne débride RIEN par surprise."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    cmds = []
    FakeProc = _fake_proc_cls(5011)
    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(mgr.subprocess, "Popen", lambda cmd, **kw: cmds.append(cmd) or FakeProc())
    _stub_group(monkeypatch)
    sid = mgr.start_for_bot("g10", "n1", autonomous=True, objective="iron_armor")
    assert "--xray" not in cmds[-1]
    sess = mgr._sessions.get(sid)
    assert sess is not None and sess["respawn"].get("xray") is False
    mgr._sessions.pop(sid, None)


def test_start_mappers_propage_mc_version(monkeypatch, tmp_path):
    """start_mappers appelle _spawn_bot DIRECTEMENT : sans ça les cartographes boot en ECONNRESET
    (auto-détection impossible) pendant que les workers, eux, passent."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    captured = {}
    monkeypatch.setattr(mgr, "MAPPER_SPAWN_STAGGER_S", 0)
    monkeypatch.setattr(mgr.servers_store, "get_server", lambda gid: {
        "id": gid, "host": "h", "port": 25565, "intelligence": "intermediaire",
        "language": "fr", "has_login": False, "stealth": False, "mc_version": "1.21.11",
        "bots": [{"id": "m1", "role": "mapper", "username": "EmberMap1", "auth": "offline"}],
    })
    monkeypatch.setattr(mgr.servers_store, "resolve_commands", lambda g: None)
    monkeypatch.setattr(mgr.servers_store, "resolve_policy", lambda g: None)
    monkeypatch.setattr(mgr.mc_agent_secrets, "get_secret", lambda gid, bid: None)
    monkeypatch.setattr(mgr, "_spawn_bot", lambda **kw: (captured.update(kw) or 91))
    out = mgr.start_mappers("g11", 1)
    assert out["launched"] == 1
    assert captured["mc_version"] == "1.21.11"
    mgr._sessions.pop(91, None)


def test_start_mappers_sans_mc_version_passe_none(monkeypatch, tmp_path):
    """Groupe sans mc_version → None → aucun flag (comportement historique des cartographes)."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    captured = {}
    monkeypatch.setattr(mgr, "MAPPER_SPAWN_STAGGER_S", 0)
    monkeypatch.setattr(mgr.servers_store, "get_server", lambda gid: {
        "id": gid, "host": "h", "port": 25565, "intelligence": "intermediaire",
        "language": "fr", "has_login": False, "stealth": False,
        "bots": [{"id": "m1", "role": "mapper", "username": "EmberMap1", "auth": "offline"}],
    })
    monkeypatch.setattr(mgr.servers_store, "resolve_commands", lambda g: None)
    monkeypatch.setattr(mgr.servers_store, "resolve_policy", lambda g: None)
    monkeypatch.setattr(mgr.mc_agent_secrets, "get_secret", lambda gid, bid: None)
    monkeypatch.setattr(mgr, "_spawn_bot", lambda **kw: (captured.update(kw) or 92))
    mgr.start_mappers("g11", 1)
    assert captured["mc_version"] is None
    mgr._sessions.pop(92, None)
