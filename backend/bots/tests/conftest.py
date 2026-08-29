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
    config.addinivalue_line(
        "markers",
        "real_coach_trader: le test vise le crochet du compte de trading DU COACH "
        "(coach_trader.maybe_run) -> ne pas le neutraliser",
    )
    config.addinivalue_line(
        "markers",
        "real_coach_book: le test vise la RÉSOLUTION du livre du coach "
        "(convergence._coach_book -> paper_router.coach_book) -> ne pas la "
        "neutraliser",
    )
    config.addinivalue_line(
        "markers",
        "real_ticker_check: le test vise le contrôle de cotation des tickers "
        "d'une hypothèse (radar.mark_unquoted -> quotes.get_quote) -> ne pas "
        "le neutraliser",
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


@pytest.fixture(autouse=True)
def _no_radar_ticker_check(request, monkeypatch):
    """L'hygiène des tickers (LOT 5) ouvre un chemin RÉSEAU à la NAISSANCE
    d'une hypothèse : ``radar.run_once`` appelle ``mark_unquoted``, qui cote
    chaque ticker pour savoir s'il existe. Mesuré : la suite du radar est
    passée de moins d'une seconde à 28 s, en sortant vraiment sur Yahoo depuis
    des tests qui se croient hors ligne.

    Neutralisé partout par défaut — TOUT ticker est réputé cotable, donc aucune
    marque n'est posée, donc le comportement par défaut des tests existants ne
    change pas. Les tests qui visent SPÉCIFIQUEMENT ce contrôle injectent leur
    propre ``is_quoted``, ou re-patchent ``_default_is_quoted`` (leur
    monkeypatch, posé après celui-ci, l'emporte)."""
    if request.node.get_closest_marker("real_ticker_check"):
        return
    try:
        from backend.bots.paper import radar
        monkeypatch.setattr(radar, "_default_is_quoted", lambda symbol: True,
                            raising=False)
    except Exception:
        pass


@pytest.fixture(autouse=True)
def _no_coach_trader_cycle(request, monkeypatch):
    """Le compte de trading DU COACH (LOT 4) ouvre un chemin RÉSEAU + LLM
    depuis le cycle de veille : ``newswatch.run_once`` appelle
    ``coach_trader.maybe_run``, qui tique le compte (cours Yahoo), photographie
    le patrimoine de TOUS les comptes (cours Yahoo) et lance la passe
    quotidienne (CLI Claude). Neutralisé partout par défaut ; les tests qui
    visent SPÉCIFIQUEMENT ce crochet s'exemptent via
    ``@pytest.mark.real_coach_trader`` (même patron que ``_no_backfill_network``
    juste au-dessus).

    ⚠️ Pourquoi UN SEUL point suffit : les trois exécutants du router
    (``tick_coach_account``/``snapshot_equity_all``/``run_coach_daily_pass``) et
    les deux endpoints ``/coach-trader`` ne sont atteints QUE par un appel
    explicite — aucun test « qui ne vise pas le coach » ne les traverse. La
    seule porte qu'un tel test franchit sans le savoir est ce crochet du cycle,
    et c'est donc celle-là qu'on ferme."""
    if request.node.get_closest_marker("real_coach_trader"):
        return
    try:
        from backend.bots.paper import coach_trader
        monkeypatch.setattr(
            coach_trader, "maybe_run",
            lambda **kwargs: {"ticked": False, "snapshotted": False,
                              "passed": False, "reason": "neutralise_en_test"},
            raising=False)
    except Exception:
        pass


@pytest.fixture(autouse=True)
def _no_coach_book_resolution(request, monkeypatch):
    """``convergence.maybe_fire`` résout DÉSORMAIS le compte du coach toute
    seule (c'est la couture du LOT 4 : sans elle, aucun des quatre appelants de
    prod ne faisait agir le coach). Laissée active en test, elle entraînerait
    les appels EXISTANTS de ``maybe_fire`` dans le vrai
    ``paper_router.execute_coach_actions`` — qui CRÉE un compte de coach, passe
    des ordres et écrit un registre dans ``data/paper_trading/`` RÉEL : tous
    les tests qui traversent ``maybe_fire`` ne redirigent pas ``store.DATA_DIR``.

    Neutralisée partout par défaut ; les tests qui valident SPÉCIFIQUEMENT ce
    câblage s'exemptent via ``@pytest.mark.real_coach_book`` (même patron que
    ``_no_backfill_network`` et ``_no_coach_trader_cycle`` juste au-dessus)."""
    if request.node.get_closest_marker("real_coach_book"):
        return
    try:
        from backend.bots.paper import convergence
        monkeypatch.setattr(convergence, "_coach_book", lambda: None,
                            raising=False)
    except Exception:
        pass
