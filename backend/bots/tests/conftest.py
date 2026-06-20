"""Fixtures partagées des tests bots."""
import threading

import pytest


@pytest.fixture(autouse=True)
def _no_spawn_gate(monkeypatch):
    """Le sérialiseur de spawn (6 s entre joins, anti Connection-throttled) ne doit pas
    ralentir les tests : intervalle à 0."""
    try:
        from backend.bots import mc_agent_manager as mgr
        monkeypatch.setattr(mgr, "SPAWN_MIN_INTERVAL_S", 0.0)
    except Exception:
        pass


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "real_pump_cleanup: le test vérifie le cleanup déclenché par le pump-thread "
        "(mort naturelle) -> ne pas neutraliser le cleanup secondaire",
    )


@pytest.fixture(autouse=True)
def _no_pump_cleanup_race(monkeypatch, request):
    """Anti-flaky : le pump-thread daemon (`_pump`) nettoie les fichiers de session
    dès que le stdout du process se ferme. Les FakeProc des tests ont un stdout VIDE
    -> le pump finit instantanément et supprime world.json/cmds/policy AVANT que le
    test ne les lise (race non déterministe). On neutralise UNIQUEMENT le cleanup
    déclenché depuis un thread secondaire (le pump) ; le cleanup explicite via
    `stop_session` ou un appel direct (thread principal du test) reste intact.

    Les tests qui valident SPÉCIFIQUEMENT le cleanup par mort naturelle (pump-thread)
    s'exemptent via le marqueur ``@pytest.mark.real_pump_cleanup``."""
    if request.node.get_closest_marker("real_pump_cleanup"):
        return
    try:
        from backend.bots import mc_agent_manager as mgr
        _real = mgr._cleanup_session_files

        def _guarded(session):
            if threading.current_thread() is threading.main_thread():
                return _real(session)
            return None  # appel depuis le pump-thread -> ne pas créer la race

        monkeypatch.setattr(mgr, "_cleanup_session_files", _guarded)
    except Exception:
        pass
