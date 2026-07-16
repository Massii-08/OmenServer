"""Tests du store de mémoire de monde partagée (Phase 1a)."""
from backend.bots import mc_agent_world_memory as wm


def test_empty_memory_shape():
    m = wm.empty_memory("abc123")
    assert m["group_id"] == "abc123"
    assert m["worlds"] == {}


def test_add_biome_quantize_and_dedup():
    m = wm.empty_memory("g")
    wm.add_biome(m, "minecraft:overworld", "forest", 650, 130, at="t1")
    wm.add_biome(m, "minecraft:overworld", "forest", 660, 140, at="t2")  # même cellule 128 → dédup
    biomes = m["worlds"]["minecraft:overworld"]["biomes"]
    assert len(biomes) == 1
    assert biomes[0]["name"] == "forest"
    assert biomes[0]["x"] % 128 == 0 and biomes[0]["z"] % 128 == 0  # quantifié
    assert biomes[0]["at"] == "t2"  # recence rafraîchie


def test_add_biome_distinct_cells_and_names():
    m = wm.empty_memory("g")
    wm.add_biome(m, "w", "forest", 0, 0, at="t1")
    wm.add_biome(m, "w", "forest", 300, 0, at="t2")   # cellule différente
    wm.add_biome(m, "w", "desert", 0, 0, at="t3")     # même cellule, nom différent
    assert len(m["worlds"]["w"]["biomes"]) == 3


def test_add_biome_cap_drops_oldest():
    m = wm.empty_memory("g")
    for i in range(5):
        wm.add_biome(m, "w", f"b{i}", i * 300, 0, at=f"t{i}", cap=3)
    names = [b["name"] for b in m["worlds"]["w"]["biomes"]]
    assert len(names) == 3
    assert "b0" not in names and "b1" not in names  # plus vieux jetés
    assert "b4" in names


def test_add_cave_dedup_by_cell_actual_coords():
    m = wm.empty_memory("g")
    wm.add_cave(m, "w", 312, 63, -88, at="t1")
    wm.add_cave(m, "w", 320, 50, -80, at="t2")  # même cellule 128 → dédup
    caves = m["worlds"]["w"]["caves"]
    assert len(caves) == 1
    assert caves[0]["x"] == 320 and caves[0]["y"] == 50 and caves[0]["z"] == -80  # coords RÉELLES, dernières


def test_add_cave_flooded_flag():
    # Massii 2026-06-22 : une grotte inondée est taguée flooded → le bot l'évite (directedTarget Node).
    m = wm.empty_memory("g")
    wm.add_cave(m, "w", 10, 40, 20, at="t1")                  # défaut = sec
    wm.add_cave(m, "w", 300, 30, 300, at="t2", flooded=True)  # noyée
    caves = m["worlds"]["w"]["caves"]
    assert caves[0]["flooded"] is False
    assert caves[1]["flooded"] is True


def test_apply_event_cave_found_flooded():
    m = wm.empty_memory("g")
    wm.apply_event(m, {"type": "cave_found", "world": "w", "x": 1, "y": 60, "z": 2, "flooded": True}, at="t1")
    wm.apply_event(m, {"type": "cave_found", "world": "w", "x": 500, "y": 50, "z": 500}, at="t2")  # pas de champ → sec
    caves = m["worlds"]["w"]["caves"]
    assert caves[0]["flooded"] is True
    assert caves[1]["flooded"] is False


def test_multi_world_partition():
    m = wm.empty_memory("g")
    wm.add_biome(m, "minecraft:overworld", "forest", 0, 0, at="t1")
    wm.add_biome(m, "mining", "forest", 0, 0, at="t2")  # monde de minage séparé
    assert len(m["worlds"]["minecraft:overworld"]["biomes"]) == 1
    assert len(m["worlds"]["mining"]["biomes"]) == 1


def test_apply_event_dispatch():
    m = wm.empty_memory("g")
    wm.apply_event(m, {"type": "biome_seen", "world": "w", "name": "forest", "x": 10, "z": 20}, at="t1")
    wm.apply_event(m, {"type": "cave_found", "world": "w", "x": 1, "y": 60, "z": 2}, at="t2")
    wm.apply_event(m, {"type": "autre"}, at="t3")  # ignoré
    wm.apply_event(m, {"type": "biome_seen", "world": "w"}, at="t4")  # champ manquant → ignoré sans crash
    assert len(m["worlds"]["w"]["biomes"]) == 1
    assert len(m["worlds"]["w"]["caves"]) == 1
    assert m["updated_at"] == "t2"


def test_save_load_delete_roundtrip(tmp_path):
    m = wm.empty_memory("g6")
    wm.add_biome(m, "w", "forest", 0, 0, at="t1")
    assert wm.save("g6", m, base_dir=tmp_path) is True
    loaded = wm.load("g6", base_dir=tmp_path)
    assert loaded["worlds"]["w"]["biomes"][0]["name"] == "forest"
    assert wm.delete_memory("g6", base_dir=tmp_path) is True
    assert wm.load("g6", base_dir=tmp_path)["worlds"] == {}  # après suppression → vide


def test_load_missing_or_bad_id_returns_empty(tmp_path):
    assert wm.load("nope", base_dir=tmp_path)["worlds"] == {}
    assert wm.load("../etc", base_dir=tmp_path)["worlds"] == {}  # id invalide (traversal) → vide, pas de crash


# --- Datapacks : biomes custom (id sans nom) + index d'associations apprises (finds) ---

def test_add_biome_with_id_no_name():
    m = wm.empty_memory("g")
    wm.add_biome(m, "w", None, 10, 20, at="t1", id=42)  # biome custom sans nom connu → gardé via id
    biomes = m["worlds"]["w"]["biomes"]
    assert len(biomes) == 1
    assert biomes[0]["id"] == 42
    assert not biomes[0].get("name")


def test_add_biome_dedup_by_id_when_no_name():
    m = wm.empty_memory("g")
    wm.add_biome(m, "w", None, 10, 20, at="t1", id=42)
    wm.add_biome(m, "w", None, 30, 40, at="t2", id=42)   # même cellule + même id → dédup
    wm.add_biome(m, "w", None, 10, 20, at="t3", id=99)   # même cellule, id différent → distinct
    assert len(m["worlds"]["w"]["biomes"]) == 2


def test_add_biome_drops_only_if_no_name_and_no_id():
    m = wm.empty_memory("g")
    wm.add_biome(m, "w", None, 0, 0, at="t1", id=None)  # ni nom ni id → ignoré (rien à indexer)
    w = m["worlds"].get("w")
    assert w is None or w["biomes"] == []


def test_add_find_and_dedup():
    m = wm.empty_memory("g")
    wm.add_find(m, "w", "oak_log", "forest", 100, 50, at="t1")
    wm.add_find(m, "w", "oak_log", "forest", 120, 60, at="t2")  # même (matériau,biome) → dédup, coords MAJ
    wm.add_find(m, "w", "oak_log", "taiga", 200, 0, at="t3")    # autre biome → distinct
    finds = m["worlds"]["w"]["finds"]
    assert len(finds) == 2
    oak_forest = [f for f in finds if f["biome"] == "forest"][0]
    assert oak_forest["x"] == 120 and oak_forest["at"] == "t2"


def test_apply_event_material_found():
    m = wm.empty_memory("g")
    wm.apply_event(m, {"type": "material_found", "world": "w", "material": "iron_ore",
                       "biome": "datapack:crystal_hills", "x": 5, "z": 9}, at="t1")  # biome custom OK
    finds = m["worlds"]["w"]["finds"]
    assert len(finds) == 1 and finds[0]["material"] == "iron_ore" and finds[0]["biome"] == "datapack:crystal_hills"


# --- Minerais exposés (ores) : positions 3D EXACTES, non quantifiées ---

def test_add_ore_exact_position():
    m = wm.empty_memory("g")
    wm.add_ore(m, "w", "iron_ore", 312, 47, -88, at="t1")
    ores = m["worlds"]["w"]["ores"]
    assert len(ores) == 1
    o = ores[0]
    assert o["material"] == "iron_ore"
    assert o["x"] == 312 and o["y"] == 47 and o["z"] == -88  # coords RÉELLES, non quantifiées
    assert o["at"] == "t1"
    assert m["updated_at"] == "t1"


def test_add_ore_dedup_by_exact_position():
    m = wm.empty_memory("g")
    wm.add_ore(m, "w", "iron_ore", 312, 47, -88, at="t1")
    wm.add_ore(m, "w", "diamond_ore", 312, 47, -88, at="t2")  # même position exacte → remplacé
    ores = m["worlds"]["w"]["ores"]
    assert len(ores) == 1
    assert ores[0]["material"] == "diamond_ore"  # material corrigé
    assert ores[0]["at"] == "t2"


def test_add_ore_distinct_positions_not_quantized():
    m = wm.empty_memory("g")
    wm.add_ore(m, "w", "iron_ore", 312, 47, -88, at="t1")
    wm.add_ore(m, "w", "iron_ore", 313, 47, -88, at="t2")  # +1 en x → distinct (PAS quantifié)
    assert len(m["worlds"]["w"]["ores"]) == 2


def test_add_ore_cap_drops_oldest():
    m = wm.empty_memory("g")
    for i in range(5):
        wm.add_ore(m, "w", "iron_ore", i, 50, 0, at=f"t{i}", cap=3)
    ores = m["worlds"]["w"]["ores"]
    assert len(ores) == 3
    xs = [o["x"] for o in ores]
    assert 0 not in xs and 1 not in xs  # plus vieux jetés
    assert 4 in xs


def test_add_ore_falsy_world_or_material_ignored():
    m = wm.empty_memory("g")
    wm.add_ore(m, "", "iron_ore", 1, 2, 3, at="t1")     # world falsy → ignoré
    wm.add_ore(m, "w", "", 1, 2, 3, at="t2")            # material falsy → ignoré
    wm.add_ore(m, "w", None, 1, 2, 3, at="t3")          # material None → ignoré
    w = m["worlds"].get("w")
    assert w is None or w["ores"] == []


def test_remove_ore_exact():
    m = wm.empty_memory("g")
    wm.add_ore(m, "w", "iron_ore", 312, 47, -88, at="t1")
    wm.add_ore(m, "w", "iron_ore", 313, 47, -88, at="t2")
    wm.remove_ore(m, "w", 312, 47, -88, at="t3")
    ores = m["worlds"]["w"]["ores"]
    assert len(ores) == 1
    assert ores[0]["x"] == 313
    assert m["updated_at"] == "t3"  # MAJ car quelque chose retiré


def test_remove_ore_noop_when_absent():
    m = wm.empty_memory("g")
    wm.add_ore(m, "w", "iron_ore", 312, 47, -88, at="t1")
    wm.remove_ore(m, "w", 999, 0, 0, at="t2")  # position inexistante → no-op
    assert len(m["worlds"]["w"]["ores"]) == 1
    assert m["updated_at"] == "t1"  # rien retiré → updated_at inchangé
    wm.remove_ore(m, "absent_world", 0, 0, 0, at="t3")  # monde absent → no-op silencieux


def test_apply_event_exposed_ore_found_missing_y_no_crash():
    m = wm.empty_memory("g")
    wm.apply_event(m, {"type": "exposed_ore_found", "world": "w",
                       "material": "iron_ore", "x": 5, "z": 9}, at="t1")  # pas de y → ignoré
    w = m["worlds"].get("w")
    assert w is None or w["ores"] == []


def test_world_seed_has_empty_ores():
    m = wm.empty_memory("g")
    w = wm._world(m, "w")
    assert w["ores"] == []



def test_apply_event_exposed_ore_found():
    m = wm.empty_memory("g")
    wm.apply_event(m, {"type": "exposed_ore_found", "world": "w", "material": "diamond_ore",
                       "x": 100, "y": 11, "z": -5}, at="t1")
    ores = m["worlds"]["w"]["ores"]
    assert len(ores) == 1 and ores[0]["material"] == "diamond_ore" and ores[0]["y"] == 11


def test_apply_event_ore_mined_and_gone_remove():
    m = wm.empty_memory("g")
    wm.add_ore(m, "w", "iron_ore", 100, 11, -5, at="t1")
    wm.add_ore(m, "w", "iron_ore", 200, 11, -5, at="t1")
    wm.apply_event(m, {"type": "ore_mined", "world": "w", "x": 100, "y": 11, "z": -5}, at="t2")
    assert len(m["worlds"]["w"]["ores"]) == 1
    wm.apply_event(m, {"type": "ore_gone", "world": "w", "x": 200, "y": 11, "z": -5}, at="t3")
    assert m["worlds"]["w"]["ores"] == []


def test_apply_event_ore_events_missing_fields_no_crash():
    m = wm.empty_memory("g")
    wm.apply_event(m, {"type": "exposed_ore_found", "world": "w"}, at="t1")       # champs manquants
    wm.apply_event(m, {"type": "ore_mined", "world": "w"}, at="t2")              # champs manquants
    wm.apply_event(m, {"type": "exposed_ore_found", "world": "w", "material": "iron_ore",
                       "x": "nan", "y": 1, "z": 2}, at="t3")                      # x invalide
    w = m["worlds"].get("w")
    assert w is None or w.get("ores", []) == []


def test_save_load_preserves_ores(tmp_path):
    m = wm.empty_memory("g7")
    wm.add_ore(m, "w", "diamond_ore", 100, 11, -5, at="t1")
    assert wm.save("g7", m, base_dir=tmp_path) is True
    loaded = wm.load("g7", base_dir=tmp_path)
    ores = loaded["worlds"]["w"]["ores"]
    assert len(ores) == 1 and ores[0]["material"] == "diamond_ore" and ores[0]["y"] == 11


# --- Scan complet : flag exposed + event batché ores_found ---

def test_add_ore_exposed_flag_default_true():
    m = wm.empty_memory("g")
    wm.add_ore(m, "w", "iron_ore", 1, 2, 3, at="t1")
    assert m["worlds"]["w"]["ores"][0]["exposed"] is True


def test_add_ore_exposed_false_stored():
    m = wm.empty_memory("g")
    wm.add_ore(m, "w", "deepslate_diamond_ore", 1, -55, 3, at="t1", exposed=False)
    o = m["worlds"]["w"]["ores"][0]
    assert o["exposed"] is False and o["material"] == "deepslate_diamond_ore"


def test_apply_event_ores_found_batch():
    m = wm.empty_memory("g")
    wm.apply_event(m, {"type": "ores_found", "world": "w", "ores": [
        {"material": "iron_ore", "x": 1, "y": 40, "z": 2, "exposed": True},
        {"material": "diamond_ore", "x": 5, "y": -52, "z": 9, "exposed": False},
    ]}, at="t1")
    ores = m["worlds"]["w"]["ores"]
    assert len(ores) == 2
    assert {o["material"] for o in ores} == {"iron_ore", "diamond_ore"}
    assert m["updated_at"] == "t1"


def test_apply_event_ores_found_skips_bad_entries():
    m = wm.empty_memory("g")
    wm.apply_event(m, {"type": "ores_found", "world": "w", "ores": [
        {"material": "iron_ore", "x": 1, "y": 40, "z": 2},          # ok (exposed défaut True)
        {"material": "", "x": 1, "y": 1, "z": 1},                    # material falsy → skip
        {"material": "gold_ore", "x": "nan", "y": 1, "z": 1},        # coord invalide → skip
        "pas_un_dict",                                                # type invalide → skip
    ]}, at="t1")
    ores = m["worlds"]["w"]["ores"]
    assert len(ores) == 1 and ores[0]["material"] == "iron_ore" and ores[0]["exposed"] is True


def test_apply_event_ores_found_not_a_list_no_crash():
    m = wm.empty_memory("g")
    wm.apply_event(m, {"type": "ores_found", "world": "w", "ores": "oops"}, at="t1")
    wm.apply_event(m, {"type": "ores_found", "world": "w"}, at="t2")
    w = m["worlds"].get("w")
    assert w is None or w.get("ores", []) == []


def test_apply_event_exposed_ore_found_legacy_sets_exposed_true():
    m = wm.empty_memory("g")
    wm.apply_event(m, {"type": "exposed_ore_found", "world": "w", "material": "iron_ore",
                       "x": 1, "y": 2, "z": 3}, at="t1")
    assert m["worlds"]["w"]["ores"][0]["exposed"] is True


def test_ore_cap_phase2_huge():
    assert wm.ORE_CAP >= 50000  # phase 2 : pas de troncature (supersède le 800/type de la phase 1)


# --- Cap PAR TYPE (le fer ne doit pas évincer les diamants) ---

def test_add_ore_cap_is_per_base_type():
    m = wm.empty_memory("g")
    # 1 diamant puis un déluge de fer au-delà du cap : le diamant SURVIT
    wm.add_ore(m, "w", "deepslate_diamond_ore", 0, -55, 0, at="t0", cap=5)
    for i in range(1, 12):
        wm.add_ore(m, "w", "iron_ore", i, 40, 0, at=f"t{i}", cap=5)
    ores = m["worlds"]["w"]["ores"]
    bases = [o["material"] for o in ores]
    assert "deepslate_diamond_ore" in bases            # pas évincé par le fer
    assert sum(1 for b in bases if b.endswith("iron_ore")) == 5   # fer capé à 5
    assert len(ores) == 6




# --- Phase 2 : structures + ores sans troncature ---

def test_add_structure_basic():
    m = wm.empty_memory("g")
    wm.add_structure(m, "w", "village", 320, 64, -480, at="t1")
    st = m["worlds"]["w"]["structures"]
    assert len(st) == 1
    s = st[0]
    assert s["kind"] == "village" and s["x"] == 320 and s["y"] == 64 and s["z"] == -480
    assert m["updated_at"] == "t1"


def test_add_structure_dedup_by_kind_and_cell():
    m = wm.empty_memory("g")
    wm.add_structure(m, "w", "mineshaft", 100, 20, 100, at="t1")
    wm.add_structure(m, "w", "mineshaft", 110, 25, 90, at="t2")    # même cellule 64 → remplacé
    wm.add_structure(m, "w", "dungeon", 100, 20, 100, at="t3")     # autre kind même cellule → distinct
    wm.add_structure(m, "w", "mineshaft", 400, 20, 100, at="t4")   # autre cellule → distinct
    st = m["worlds"]["w"]["structures"]
    assert len(st) == 3
    kinds = sorted((s["kind"], s["x"]) for s in st)
    assert kinds == [("dungeon", 100), ("mineshaft", 110), ("mineshaft", 400)]


def test_add_structure_falsy_ignored():
    m = wm.empty_memory("g")
    wm.add_structure(m, "", "village", 1, 2, 3, at="t1")
    wm.add_structure(m, "w", "", 1, 2, 3, at="t2")
    w = m["worlds"].get("w")
    assert w is None or w.get("structures", []) == []


def test_apply_event_structure_found():
    m = wm.empty_memory("g")
    wm.apply_event(m, {"type": "structure_found", "world": "w", "kind": "stronghold",
                       "x": -800, "y": 30, "z": 1200}, at="t1")
    st = m["worlds"]["w"]["structures"]
    assert len(st) == 1 and st[0]["kind"] == "stronghold"
    # champs manquants → no-crash
    wm.apply_event(m, {"type": "structure_found", "world": "w", "kind": "village"}, at="t2")
    assert len(m["worlds"]["w"]["structures"]) == 1


def test_ore_cap_no_truncation_phase2():
    # anti-xray : liste sparse, on ne droppe JAMAIS un ore nécessaire
    assert wm.ORE_CAP >= 50000


def test_world_seed_has_structures():
    m = wm.empty_memory("g")
    w = wm._world(m, "w")
    assert w["structures"] == []


def test_biome_default_cap_does_not_truncate_normal_exploration():
    # Régression bug carte : l'ancien défaut (CAP=500) tronquait la carte à 500 cellules →
    # la gauche/ouest (mappée en premier = plus vieille) disparaissait + îlots déconnectés.
    # La légende du site sommait EXACTEMENT 500. Le défaut biome doit être large.
    assert wm.BIOME_CAP >= 20000
    m = wm.empty_memory("g")
    for i in range(600):  # 600 cellules distinctes (>500) toutes nommées "forest"
        wm.add_biome(m, "w", "forest", i * 300, 0, at=f"t{i}")
    assert len(m["worlds"]["w"]["biomes"]) == 600  # aucune évincée


def test_structure_default_cap_is_generous():
    assert wm.STRUCT_CAP >= 5000
    m = wm.empty_memory("g")
    for i in range(600):  # 600 cellules distinctes (>500 héritage)
        wm.add_structure(m, "w", "mineshaft", i * 200, 30, 0, at=f"t{i}")
    assert len(m["worlds"]["w"]["structures"]) == 600


def test_apply_event_directed_exhausted_retire_le_find():
    """Persistance de l'exclusion (16/07) : un find PELÉ re-ciblé en boucle par chaque session
    fraîche (le Set process-local meurt au churn) → l'event directed_exhausted du bot retire le
    find de la carte PARTAGÉE → plus aucune session ne le re-propose."""
    mem = {"worlds": {}}
    wm.apply_event(mem, {"type": "material_found", "world": "w", "material": "oak_log",
                         "biome": "plains", "x": -459, "z": -292})
    wm.apply_event(mem, {"type": "material_found", "world": "w", "material": "oak_log",
                         "biome": "forest", "x": -600, "z": -400})
    assert len(mem["worlds"]["w"]["finds"]) == 2
    wm.apply_event(mem, {"type": "directed_exhausted", "world": "w", "x": -459, "z": -292})
    finds = mem["worlds"]["w"]["finds"]
    assert len(finds) == 1
    assert finds[0]["x"] == -600            # le find sain reste


def test_apply_event_directed_exhausted_robuste():
    mem = {"worlds": {}}
    # monde/point inconnus → no-crash, no-op
    wm.apply_event(mem, {"type": "directed_exhausted", "world": "nope", "x": 1, "z": 2})
    assert mem == {"worlds": {}} or "nope" not in mem.get("worlds", {}) or not mem["worlds"]["nope"].get("finds")


def test_wm_events_route_directed_exhausted():
    from backend.bots import mc_agent_manager as mgr
    assert "directed_exhausted" in mgr._WM_EVENTS
