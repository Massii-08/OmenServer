"""Plafond de heap Node des bots MC (anti-OOM machine).

Crash live 2026-07-25 : NethBot2 a alloué ~2 Go de heap en 38 s (A* de fuite non borné) puis
`FATAL ERROR: JavaScript heap out of memory`. Le vrai fix est côté bot
(`movement.applyPathfinderBounds`) ; ceci est la 2e couche : avec le défaut V8 (~2 Go/process)
une flotte de 5 bots peut réclamer 10 Go sur une machine qui en donne déjà 10 au serveur MC
(15 Go au total) → un emballement peut emporter le serveur MC avec lui. Plafonné, le process
fautif meurt vite et le self-healing le relance.
"""
import io

import pytest

from backend.bots import mc_agent_manager as mgr


class FakeProcNoPipe:
    """Faux subprocess SANS stdout (mode production : stdout → fichier)."""

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


def _spawn_cmd(monkeypatch):
    captured = {}

    def fake_popen(cmd, **kw):
        captured["cmd"] = [str(c) for c in cmd]
        return FakeProcNoPipe()

    monkeypatch.setattr(mgr.subprocess, "Popen", fake_popen)
    sid = mgr.start_session("127.0.0.1", 25565, "HeapBot")
    mgr.stop_session(sid)
    return captured["cmd"]


def test_le_heap_node_est_plafonne(monkeypatch):
    cmd = _spawn_cmd(monkeypatch)
    flags = [c for c in cmd if c.startswith("--max-old-space-size=")]
    assert flags, f"aucun plafond de heap dans la commande : {cmd}"
    mb = int(flags[0].split("=", 1)[1])
    assert 256 <= mb <= 1536, f"plafond irréaliste ({mb} Mo)"
    # Relevé le 21/10 (veille autonome) : le banc d'essai LOCAL de ce dépôt fait de nouveau
    # tourner le serveur MC CO-LOCALISÉ sur cette même machine (conteneur docker
    # omen-minecraft-trusted-test, mesuré 6,1/8,5 Go = 71 % le 21/10 20:51) — la prémisse du
    # plafond 1024 (#56, "l'Omen n'héberge plus que les bots, ~8 Go libres") ne tient plus pour
    # ce banc. Sous ce plafond, 48 sessions ont crashé en "JavaScript heap out of memory" sur
    # 10-20/10-21 (≈15 % des sessions du jour), y compris des bots CALMES (aucune mort, aucun
    # téléport) OOM en 86-102 s — un plafond haut n'a pas évité ces crashs, il a seulement laissé
    # la machine (swap 4/4 Go plein) pousser plus loin avant de les détecter. On revient au
    # plafond "anti-co-location" d'origine (#48).
    assert mb <= 768, f"plafond trop haut pour une MC co-localisée sur cette machine ({mb} Mo) — cf. #48/#56"


def test_le_plafond_precede_le_script(monkeypatch):
    """Une option node passée APRÈS index.js irait au script, pas à node."""
    cmd = _spawn_cmd(monkeypatch)
    heap = next(i for i, c in enumerate(cmd) if c.startswith("--max-old-space-size="))
    script = next(i for i, c in enumerate(cmd) if c.endswith("index.js"))
    assert heap < script, f"plafond posé après le script : {cmd}"
