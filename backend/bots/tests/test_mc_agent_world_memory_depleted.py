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


# ─── run10 (20/10) : nature + âge maximum ─────────────────────────────────────────────────────
# Mesure : les 31 cellules de la carte venaient TOUTES de recherches de BOIS (25/29 sur `logs`)
# et dataient de 82 à 888 min — la zone les lisait comme un épuisement de MINERAI à vie.

def test_event_directed_exhausted_conserve_la_nature():
    m = wm.empty_memory("g1")
    wm.apply_event(m, {"type": "directed_exhausted", "world": "overworld", "x": 1, "z": 2, "kind": "wood"},
                   at="2026-10-20T09:00:00+00:00")
    assert m["worlds"]["overworld"]["depleted"][0]["kind"] == "wood"


def test_nature_inconnue_ou_absente_reste_retro_compatible():
    m = wm.empty_memory("g1")
    wm.add_depleted(m, "overworld", 1, 2, at=1000)
    wm.add_depleted(m, "overworld", 3, 4, at=1000, kind="n'importe quoi")
    for e in m["worlds"]["overworld"]["depleted"]:
        assert "kind" not in e


def test_rafraichir_une_cellule_met_a_jour_sa_nature():
    m = wm.empty_memory("g1")
    wm.add_depleted(m, "overworld", 1, 2, at=1000, kind="wood")
    wm.add_depleted(m, "overworld", 1, 2, at=1001, kind="ore")
    dep = m["worlds"]["overworld"]["depleted"]
    assert len(dep) == 1 and dep[0]["kind"] == "ore" and dep[0]["at"] == 1001


def test_les_cellules_trop_vieilles_sont_elaguees_a_l_ecriture():
    m = wm.empty_memory("g1")
    wm.add_depleted(m, "overworld", 1, 1, at="2026-10-19T08:00:00+00:00")   # 25 h avant
    wm.add_depleted(m, "overworld", 2, 2, at="2026-10-20T00:00:00+00:00")   # 9 h avant
    wm.add_depleted(m, "overworld", 3, 3, at="2026-10-20T09:00:00+00:00")
    xs = [e["x"] for e in m["worlds"]["overworld"]["depleted"]]
    assert xs == [2, 3]
    assert wm.DEPLETED_MAX_AGE_S == 12 * 3600


def test_dates_illisibles_jamais_elaguees():
    """Rétro-compat : une entrée sans date exploitable n'est pas jetée par l'élagage."""
    m = wm.empty_memory("g1")
    m["worlds"]["overworld"] = {"depleted": [{"x": 9, "z": 9, "at": None}, {"x": 8, "z": 8, "at": "??"}]}
    wm.add_depleted(m, "overworld", 3, 3, at="2026-10-20T09:00:00+00:00")
    assert [e["x"] for e in m["worlds"]["overworld"]["depleted"]] == [9, 8, 3]
