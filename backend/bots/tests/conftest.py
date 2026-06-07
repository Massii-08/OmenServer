"""Fixtures partagées des tests bots."""
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
