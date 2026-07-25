"""Cellules ÉPUISÉES persistantes (analyse run world_ax4, 26/07).

Mesure : `explore_directed` a visé la cellule (256,128) **2036 fois sur 2585** — 79 % des
déplacements dirigés vers la MÊME case, celle que les bots avaient rasée. En face,
`directed_exhausted` n'a tiré que 147 fois.

Cause : l'exclusion vivait dans un `Set` PAR PROCESS (`bot._mcaExhausted`). Avec 134 sessions
sur le run, elle était vidée toutes les ~3 minutes : chaque session fraîche réapprenait que la
zone était pelée, puis mourait. Et `directed_exhausted` n'était persisté que via `remove_find`,
qui n'efface qu'un *find* ponctuel — le tier BIOME de `directedTarget` continuait donc à proposer
la même cellule à l'infini.
"""
from backend.bots import mc_agent_world_memory as wm


def test_add_depleted_enregistre_la_cellule():
    m = wm.empty_memory("g1")
    wm.add_depleted(m, "overworld", 256, 128, at=1000)
    dep = m["worlds"]["overworld"]["depleted"]
    assert len(dep) == 1
    assert dep[0]["x"] == 256 and dep[0]["z"] == 128


def test_add_depleted_est_idempotent():
    """Le même point marqué 50× (une fois par session) ne doit pas gonfler la carte."""
    m = wm.empty_memory("g1")
    for _ in range(50):
        wm.add_depleted(m, "overworld", 256, 128, at=1000)
    assert len(m["worlds"]["overworld"]["depleted"]) == 1


def test_event_directed_exhausted_persiste_la_cellule():
    m = wm.empty_memory("g1")
    wm.apply_event(m, {"type": "directed_exhausted", "world": "overworld", "x": 256, "z": 128}, at=1)
    assert len(m["worlds"]["overworld"]["depleted"]) == 1


def test_event_directed_exhausted_efface_toujours_le_find():
    """La sémantique historique (retirer le find pelé) doit rester."""
    m = wm.empty_memory("g1")
    wm.add_find(m, "overworld", "oak_log", "forest", 256, 128, at=1)
    wm.apply_event(m, {"type": "directed_exhausted", "world": "overworld", "x": 256, "z": 128}, at=2)
    assert m["worlds"]["overworld"]["finds"] == []
    assert len(m["worlds"]["overworld"]["depleted"]) == 1


def test_depleted_est_plafonne():
    m = wm.empty_memory("g1")
    for i in range(wm.DEPLETED_CAP + 40):
        wm.add_depleted(m, "overworld", i * 200, 0, at=1000 + i)
    dep = m["worlds"]["overworld"]["depleted"]
    assert len(dep) <= wm.DEPLETED_CAP
    # on garde les plus RÉCENTES (une zone pelée il y a longtemps a pu repousser)
    assert dep[-1]["x"] == (wm.DEPLETED_CAP + 39) * 200


def test_entrees_bancales_ignorees_sans_crash():
    m = wm.empty_memory("g1")
    wm.apply_event(m, {"type": "directed_exhausted", "world": "overworld"}, at=1)
    wm.apply_event(m, {"type": "directed_exhausted", "x": 1, "z": 2}, at=1)
    assert m["worlds"].get("overworld", {}).get("depleted", []) == []
