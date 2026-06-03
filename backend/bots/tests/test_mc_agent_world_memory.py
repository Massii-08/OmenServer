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
