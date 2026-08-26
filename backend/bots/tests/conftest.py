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


@pytest.fixture(autouse=True)
def _isolated_session_dirs(monkeypatch, tmp_path):
    """Depuis le détachement des sessions (registre + logs stdout), tout spawn écrit
    sessions-registry.json (RUNS_DIR) et session-<sid>.jsonl (LOGS_DIR) → isolés en tmp
    pour ne JAMAIS polluer data/ réel pendant les tests. Un test qui re-patch RUNS_DIR
    lui-même (pattern historique) écrase simplement cette valeur."""
    try:
        from backend.bots import mc_agent_manager as mgr
        monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "mc_agent_runs")
        monkeypatch.setattr(mgr, "LOGS_DIR", tmp_path / "mc_agent_logs")
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


@pytest.fixture(autouse=True)
def _no_backfill_network(request, monkeypatch):
    """Le backfill historique donne à ``radar.run_once`` un chemin RÉSEAU de fin
    de run (``_fill_history`` → Google News). Les fixtures actuelles n'ont pas
    d'ancre donc ne le déclenchent pas — mais un futur test radar/router qui
    poserait un portefeuille AVEC position sortirait sur le réseau en silence.
    Verrou : neutralisé partout ; les tests qui valident SPÉCIFIQUEMENT le
    câblage radar→backfill s'exemptent via ``@pytest.mark.real_backfill``."""
    if request.node.get_closest_marker("real_backfill"):
        return
    try:
        from backend.bots.paper import radar
        monkeypatch.setattr(radar, "_fill_history", lambda *a, **k: None, raising=False)
    except Exception:
        pass
