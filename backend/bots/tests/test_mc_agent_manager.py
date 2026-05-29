import io
from backend.bots import mc_agent_manager as mgr


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
