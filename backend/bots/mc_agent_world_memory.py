"""
Mémoire de monde partagée MC Agent (Phase 1 — biomes + entrées de grotte + associations apprises).

Stdlib uniquement. Un fichier JSON par GROUPE (= serveur) : data/mc_agent_world_memory/<group_id>.json.
Partitionné par MONDE (overworld/nether/end/<label> ex. "mining") car les coordonnées diffèrent d'un
monde à l'autre. Quantifié sur grille 128 + dédup par cellule + cap par (monde, type) → disque borné.

Datapack-agnostique (cf. spec §13) : on enregistre le biome rapporté par le serveur (nom custom OU id
numérique si le nom est inconnu), jamais de validation contre une liste vanilla. Les associations
matériau↔biome sont APPRISES (index `finds`) → robustes aux biomes custom.

Écriture backend-médiée : les bots émettent des events stdout (biome_seen / cave_found / material_found)
que le manager applique via apply_event() puis sauvegarde sous verrou (un seul écrivain). Les fonctions
add_*/apply_event sont PURES (mutent le dict mémoire) → testables sans I/O ; load/save/delete gèrent le fichier.
"""
import json
import re
from pathlib import Path

# backend/bots/mc_agent_world_memory.py → racine projet = parents[2]
_PROJECT_ROOT = Path(__file__).resolve().parents[2]
WORLD_MEMORY_DIR = _PROJECT_ROOT / "data" / "mc_agent_world_memory"

_SAFE_ID = re.compile(r"^[a-z0-9]+$")
GRID = 128   # taille de cellule (quantification x,z) : 1 entrée par région de 128²
CAP = 500    # entrées max par (monde, type) ; au-delà on jette les plus vieilles


def _q(v):
    """Snap une coord sur la grille (floor division → gère correctement les négatifs)."""
    return (int(v) // GRID) * GRID


def empty_memory(group_id):
    return {"group_id": group_id, "updated_at": None, "worlds": {}}


def _world(memory, world):
    w = memory.setdefault("worlds", {}).setdefault(world, {})
    w.setdefault("biomes", [])
    w.setdefault("caves", [])
    w.setdefault("finds", [])
    return w


def add_biome(memory, world, name, x, z, at=None, cap=CAP, id=None):
    """Ajoute un biome (coords quantifiées, dédup par (cellule, identité), capé). Mute + retourne memory.

    Identité = `name` si présent, sinon `id` (biome custom de datapack non nommé par mineflayer).
    Ignoré seulement si NI nom NI id (rien à indexer)."""
    if not world or (not name and id is None):
        return memory
    w = _world(memory, world)
    qx, qz = _q(x), _q(z)
    if name:
        w["biomes"] = [b for b in w["biomes"] if not (b["x"] == qx and b["z"] == qz and b.get("name") == name)]
    else:
        w["biomes"] = [b for b in w["biomes"]
                       if not (b["x"] == qx and b["z"] == qz and not b.get("name") and b.get("id") == id)]
    w["biomes"].append({"name": str(name) if name else None, "id": id, "x": qx, "z": qz, "at": at})
    if len(w["biomes"]) > cap:
        w["biomes"] = w["biomes"][-cap:]  # garde les plus récentes
    if at:
        memory["updated_at"] = at
    return memory


def add_cave(memory, world, x, y, z, at=None, cap=CAP):
    """Ajoute une entrée de grotte (coords RÉELLES, dédup par cellule (x,z), capé). Mute + retourne."""
    if not world:
        return memory
    w = _world(memory, world)
    qx, qz = _q(x), _q(z)
    w["caves"] = [c for c in w["caves"] if not (_q(c["x"]) == qx and _q(c["z"]) == qz)]
    w["caves"].append({"x": int(x), "y": int(y), "z": int(z), "at": at})
    if len(w["caves"]) > cap:
        w["caves"] = w["caves"][-cap:]
    if at:
        memory["updated_at"] = at
    return memory


def add_find(memory, world, material, biome, x, z, at=None, cap=CAP):
    """Enregistre une association matériau↔biome APPRISE (dédup par (matériau, biome), coords MAJ).

    Sert aux récolteurs : un bot frais sait que `material` se trouve dans `biome` à ~(x,z). Robuste aux
    biomes custom (on n'apprend que ce qui a été réellement observé)."""
    if not world or not material or not biome:
        return memory
    w = _world(memory, world)
    w["finds"] = [f for f in w["finds"] if not (f["material"] == material and f["biome"] == biome)]
    w["finds"].append({"material": str(material), "biome": str(biome), "x": int(x), "z": int(z), "at": at})
    if len(w["finds"]) > cap:
        w["finds"] = w["finds"][-cap:]
    if at:
        memory["updated_at"] = at
    return memory


def apply_event(memory, event, at=None):
    """Applique un event bot à la mémoire. Ignore les types inconnus / champs manquants (pas de crash)."""
    if not isinstance(event, dict):
        return memory
    t = event.get("type")
    world = event.get("world")
    try:
        if t == "biome_seen":
            return add_biome(memory, world, event.get("name"), event["x"], event["z"],
                             at=at, id=event.get("id"))
        if t == "cave_found":
            return add_cave(memory, world, event["x"], event["y"], event["z"], at=at)
        if t == "material_found":
            return add_find(memory, world, event["material"], event["biome"], event["x"], event["z"], at=at)
    except (KeyError, TypeError, ValueError):
        return memory
    return memory


def _path(group_id, base_dir=None):
    base = Path(base_dir) if base_dir else WORLD_MEMORY_DIR
    return base / f"{group_id}.json"


def load(group_id, base_dir=None):
    """Charge la mémoire d'un groupe. empty_memory() si absent/illisible/id invalide."""
    if not _SAFE_ID.match(str(group_id or "")):
        return empty_memory(str(group_id))
    try:
        data = json.loads(_path(group_id, base_dir).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return empty_memory(group_id)
    if not isinstance(data, dict) or "worlds" not in data:
        return empty_memory(group_id)
    return data


def save(group_id, memory, base_dir=None):
    """Écrit la mémoire (atomique : temp + rename). False si id invalide."""
    if not _SAFE_ID.match(str(group_id or "")):
        return False
    p = _path(group_id, base_dir)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(memory, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)
    return True


def delete_memory(group_id, base_dir=None):
    """Supprime le fichier mémoire d'un groupe (suppression cascade). True si supprimé."""
    if not _SAFE_ID.match(str(group_id or "")):
        return False
    try:
        _path(group_id, base_dir).unlink()
        return True
    except OSError:
        return False
