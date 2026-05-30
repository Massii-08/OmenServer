# MC Agent — Phase 1b.1 (pipeline de capture) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Livrer le **jalon 1b.1** : un **mod client Fabric** (REC/REC-off, touche F8) qui enregistre les inputs+état+chat du joueur-modèle consentant dans un `.jsonl` local, l'**ingestion côté OmenServer** (upload manuel admin-only), la **distillation** `.jsonl` → `style.json` (stats) + `clips/` (motricité réelle segmentée), et une **vue des stats** dans le dashboard. À la fin de ce plan, Massii peut **installer le mod et capturer**.

**Architecture :** Le mod tourne sur le *client* du joueur (aucune dépendance runtime ajoutée sur l'Omen) ; il écrit un fichier local que le joueur **upload manuellement** (consentement renforcé, pattern Yield `.xlsx`). Côté backend Python (stdlib only), un `mc_capture_store.py` range les captures sous `data/mc-captures/<joueur>/` (gitignored, admin-only), un `mc_capture_distill.py` produit `style.json` + `clips/`, et un `mc_capture_router.py` expose upload/list/distill/get-style/delete. Le frontend ajoute un panneau « Captures » dans la carte MC Agent. La logique Java pure (sérialisation, machine d'état REC) est **extraite des hooks Minecraft** pour être testable en JUnit sans client lancé.

**Tech Stack :** Java 21 + Fabric (Loom) côté mod ; Python 3.9 (FastAPI, pytest, **stdlib `statistics`/`json`/`gzip`**) côté backend ; Vanilla JS frontend. Tests : JUnit 5 (Java), pytest (Python).

**Référence spec :** `docs/superpowers/specs/2026-05-29-mc-agent-phase1b-behavioral-capture-design.md` (§2 cadre consentement, §5 mod, §6 transport/stockage, §7 distillation, §10 UI, §11 tests). Tag git d'ancrage de la spec : `mc-agent-phase1b-spec-safe`.

**⚠️ Garde-fous projet (NON négociables) :**
- **Consentement actif/visible (spec §2)** : le mod **ne capture pas** au lancement (`REC-off`) ; F8 démarre (`● REC`) ; **notice de consentement au 1er lancement** ; toute erreur d'I/O → `REC-off`.
- **Transport = upload manuel uniquement** : le mod n'a **aucune** capacité réseau vers l'API. Rien ne part sans action du joueur.
- **Admin-only** sur tous les endpoints capture (`_require_admin`, pattern `mc_agent_router.py`).
- **Données locales gitignored + supprimables** (`data/` déjà gitignored ; endpoint DELETE).
- **Attribution par header** : le `player` vient **du header du fichier**, jamais d'un champ libre UI.
- Repo **auto-deploy sur `main`** (cron git pull + restart). On travaille sur **`feat/mc-agent-phase1b`** (déjà la branche courante). **Ne JAMAIS pusher `main`** pendant le dev ; **ne jamais pusher pendant qu'un scan/bot tourne** (pièges #30f/#33).
- **Isolation 2-sessions** : ce checkout est partagé avec la session Phase 1. Vérifier `git status` propre avant chaque commit et **ne committer que les fichiers de ce plan** (pathspec explicite, jamais `git add -A`).

---

## File Structure

**Java / Fabric — `mc-capture-mod/` (nouveau) :**

| Fichier | Responsabilité |
|---|---|
| `mc-capture-mod/build.gradle` | Fabric Loom, cible MC 1.21.x (Java 21), dépendance Fabric API, JUnit 5 |
| `mc-capture-mod/settings.gradle` | nom du projet + repos Fabric |
| `mc-capture-mod/gradle.properties` | versions épinglées (MC, yarn mappings, loader, fabric-api, mod) |
| `mc-capture-mod/src/main/resources/fabric.mod.json` | métadonnées mod, entrypoint client, dépendances |
| `mc-capture-mod/src/main/java/org/omen/capture/CaptureMod.java` | entrypoint `ClientModInitializer` : keybind F8, hooks tick/chat/HUD, notice de consentement |
| `mc-capture-mod/src/main/java/org/omen/capture/Recorder.java` | **machine d'état REC/OFF pure** (start/stop/erreur→off) + délègue l'écriture |
| `mc-capture-mod/src/main/java/org/omen/capture/SessionWriter.java` | **sérialisation JSONL pure** (header + records) — testable sans client |
| `mc-capture-mod/src/main/java/org/omen/capture/TickRecord.java` | DTO d'un tick (inputs, yaw/pitch, pos, vel, hp, food, held) + `toJson()` |
| `mc-capture-mod/src/main/java/org/omen/capture/RecHud.java` | overlay `● REC` / `REC-off` (HudRenderCallback) |
| `mc-capture-mod/src/test/java/org/omen/capture/SessionWriterTest.java` | JUnit : header bien formé, record bien formé, ordre |
| `mc-capture-mod/src/test/java/org/omen/capture/RecorderTest.java` | JUnit : start→writing, stop→closed, erreur→off |
| `mc-capture-mod/README.md` | build (`./gradlew build`) + install (Fabric Loader + jar dans `mods/`) |

**Python — `backend/bots/` :**

| Fichier | Responsabilité |
|---|---|
| `backend/bots/mc_capture_store.py` | stockage `data/mc-captures/<joueur>/`, validation header, list, delete (stdlib) |
| `backend/bots/mc_capture_distill.py` | `.jsonl` → `style.json` (stats) + `clips/` (segmentation motricité) (stdlib) |
| `backend/bots/mc_capture_router.py` | endpoints `/api/mc-agent/captures*` — admin-only |
| `backend/main.py` | + import/mount `mc_capture_router` (après `mc_agent_router`, l.148/180) |
| `backend/bots/tests/test_mc_capture_store.py` | upload/validation/list/delete |
| `backend/bots/tests/test_mc_capture_distill.py` | distillation stats + segmentation clips (fixtures `.jsonl`) |
| `backend/bots/tests/test_mc_capture_router.py` | endpoints + admin-only (403) |
| `backend/bots/tests/fixtures/capture_sample.jsonl` | capture réelle minimale pour tests distillation |

**Frontend :**

| Fichier | Responsabilité |
|---|---|
| `frontend/js/bots_module.js` | + panneau « Captures » dans `openMCAgent` (dropzone, liste, voir stats, supprimer) + méthodes |
| `frontend/js/lang.js` | clés `mcagent.capture.*` (FR/EN/IT) |
| `frontend/index.html` | bump `?v=` de bots_module.js + lang.js |
| `frontend/sw.js` | bump `CACHE_NAME` |

---

## Task 0 : Point de départ sain (branche + baseline verte)

**Files :** aucun (vérifications)

- [ ] **Step 1 : Confirmer la branche de travail + tree propre**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur"
git branch --show-current
git status --porcelain | head
```
Expected : `feat/mc-agent-phase1b` ; aucune ligne de status (working tree propre). Si des fichiers `mc-agent/` non-à-moi apparaissent (autre session), **STOP** et attendre qu'elle finisse / committe.

- [ ] **Step 2 : Baseline Python verte (point de départ)**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur" && source venv/bin/activate && python -m pytest backend/bots/tests/ -q 2>&1 | tail -3
```
Expected : `... passed` (29 selon le vault ; le nombre exact importe peu, il doit être vert).

- [ ] **Step 3 : Vérifier que Java 21 + Gradle sont dispo (build-time only, machine de dev)**

Run :
```bash
java -version 2>&1 | head -1
```
Expected : version ≥ 17 (idéalement 21). **Si Java absent** : noter qu'il faut l'installer pour builder le mod (`brew install openjdk@21`), mais **les tâches Python (1, 3-8) ne le nécessitent pas** — on peut développer le backend d'abord et builder le mod ensuite. Le wrapper Gradle (`./gradlew`) télécharge Gradle lui-même, pas besoin de l'installer.

---

## Task 1 : Stockage des captures (`mc_capture_store.py`)

**Files :**
- Create : `backend/bots/mc_capture_store.py`
- Test : `backend/bots/tests/test_mc_capture_store.py`

> Module pur (pas de FastAPI) → testable directement. Stockage fichier, pattern miroir de `mc_agent_manager` (chemins via `Path(__file__).resolve().parents[2]`).

- [ ] **Step 1 : Écrire les tests qui échouent**

`backend/bots/tests/test_mc_capture_store.py` :
```python
"""Tests du stockage des captures comportementales (Phase 1b.1)."""
import json
import pytest

from backend.bots import mc_capture_store as store


@pytest.fixture
def tmp_root(tmp_path, monkeypatch):
    """Redirige la racine de stockage vers un dossier temporaire."""
    monkeypatch.setattr(store, "CAPTURES_DIR", tmp_path / "mc-captures")
    return tmp_path / "mc-captures"


def _valid_jsonl(player="Massii_08"):
    header = {"schema": 1, "player": player, "mc": "1.21.4", "mod": "0.1.0",
              "consent": True, "startedAt": 1748540000000, "sampleHz": 20}
    tick = {"t": 0, "type": "tick", "in": {"fwd": 1}, "yaw": 1.0, "pitch": 0.0,
            "pos": [0, 64, 0], "vel": [0, 0, 0], "og": 1, "hp": 20, "food": 20, "held": "air"}
    return (json.dumps(header) + "\n" + json.dumps(tick) + "\n").encode("utf-8")


def test_parse_header_extracts_player(tmp_root):
    header = store.parse_header(_valid_jsonl("Bob"))
    assert header["player"] == "Bob"
    assert header["schema"] == 1


def test_parse_header_rejects_missing_consent(tmp_root):
    bad = json.dumps({"schema": 1, "player": "X"}).encode() + b"\n"
    with pytest.raises(ValueError, match="consent"):
        store.parse_header(bad)


def test_parse_header_rejects_bad_schema(tmp_root):
    bad = json.dumps({"schema": 99, "player": "X", "consent": True}).encode() + b"\n"
    with pytest.raises(ValueError, match="schema"):
        store.parse_header(bad)


def test_parse_header_rejects_empty(tmp_root):
    with pytest.raises(ValueError):
        store.parse_header(b"")


def test_save_capture_writes_under_player_dir(tmp_root):
    info = store.save_capture(_valid_jsonl("Massii_08"), "session-1.jsonl")
    assert info["player"] == "Massii_08"
    saved = tmp_root / "Massii_08" / "session-1.jsonl"
    assert saved.is_file()


def test_save_capture_sanitizes_player_name(tmp_root):
    # un player avec des caractères de chemin ne doit pas s'échapper du dossier
    payload = _valid_jsonl("../../etc")
    info = store.save_capture(payload, "s.jsonl")
    # le dossier réel reste sous CAPTURES_DIR
    assert tmp_root in (tmp_root / info["player"]).resolve().parents or \
           (tmp_root / info["player"]).resolve() == (tmp_root / info["player"])
    assert "/" not in info["player"] and ".." not in info["player"]


def test_list_captures_groups_by_player(tmp_root):
    store.save_capture(_valid_jsonl("Bob"), "s1.jsonl")
    store.save_capture(_valid_jsonl("Bob"), "s2.jsonl")
    store.save_capture(_valid_jsonl("Alice"), "s1.jsonl")
    listing = store.list_captures()
    by_player = {p["player"]: p for p in listing}
    assert by_player["Bob"]["sessions"] == 2
    assert by_player["Alice"]["sessions"] == 1


def test_delete_session_removes_one_file(tmp_root):
    store.save_capture(_valid_jsonl("Bob"), "s1.jsonl")
    store.save_capture(_valid_jsonl("Bob"), "s2.jsonl")
    assert store.delete_capture("Bob", "s1.jsonl") is True
    assert not (tmp_root / "Bob" / "s1.jsonl").exists()
    assert (tmp_root / "Bob" / "s2.jsonl").exists()


def test_delete_player_removes_all(tmp_root):
    store.save_capture(_valid_jsonl("Bob"), "s1.jsonl")
    assert store.delete_capture("Bob", None) is True
    assert not (tmp_root / "Bob").exists()


def test_delete_unknown_returns_false(tmp_root):
    assert store.delete_capture("Ghost", None) is False
```

- [ ] **Step 2 : Lancer → échec attendu**

Run : `cd "/Users/massimiliano/omenserver Project/Projet serveur" && source venv/bin/activate && python -m pytest backend/bots/tests/test_mc_capture_store.py -q 2>&1 | tail -5`
Expected : FAIL (`ModuleNotFoundError: backend.bots.mc_capture_store`).

- [ ] **Step 3 : Implémenter `backend/bots/mc_capture_store.py`**

```python
"""
Stockage des captures comportementales (Phase 1b.1).

Range les fichiers .jsonl uploadés (manuellement, depuis le dashboard admin) sous
data/mc-captures/<joueur>/. Le <joueur> vient TOUJOURS du header du fichier (jamais
d'un champ libre UI) → attribution automatique même si un seul admin uploade pour
toute l'équipe. Stdlib uniquement. Pattern de chemins miroir de mc_agent_manager.
"""
import json
import re
import shutil
from pathlib import Path

# backend/bots/mc_capture_store.py → racine projet = parents[2]
_PROJECT_ROOT = Path(__file__).resolve().parents[2]
CAPTURES_DIR = _PROJECT_ROOT / "data" / "mc-captures"

SCHEMA_VERSION = 1
_SAFE_NAME = re.compile(r"[^A-Za-z0-9_.-]")


def _safe_player(name):
    """Réduit un pseudo à un nom de dossier sûr (anti path-traversal)."""
    cleaned = _SAFE_NAME.sub("_", str(name or "").strip())
    cleaned = cleaned.strip(".") or "unknown"
    return cleaned[:64]


def parse_header(payload):
    """Lit et valide la 1re ligne JSON (header) d'une capture. Throw ValueError si invalide."""
    if not payload:
        raise ValueError("capture vide")
    first = payload.split(b"\n", 1)[0].strip()
    if not first:
        raise ValueError("header manquant")
    try:
        header = json.loads(first.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError(f"header illisible: {exc}")
    if not isinstance(header, dict):
        raise ValueError("header doit être un objet JSON")
    if header.get("schema") != SCHEMA_VERSION:
        raise ValueError(f"schema attendu {SCHEMA_VERSION}, reçu {header.get('schema')}")
    if not header.get("player"):
        raise ValueError("header.player requis")
    if header.get("consent") is not True:
        raise ValueError("consent must be true (capture non consentie refusée)")
    return header


def save_capture(payload, filename):
    """Valide le header, range le fichier sous data/mc-captures/<player>/. Retourne un info dict."""
    header = parse_header(payload)
    player = _safe_player(header["player"])
    safe_file = _SAFE_NAME.sub("_", str(filename or "session.jsonl"))
    if not safe_file.endswith((".jsonl", ".jsonl.gz")):
        safe_file += ".jsonl"
    target_dir = CAPTURES_DIR / player
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / safe_file
    target.write_bytes(payload)
    return {"player": player, "file": safe_file, "bytes": len(payload),
            "mc": header.get("mc"), "startedAt": header.get("startedAt")}


def list_captures():
    """Liste les captures groupées par joueur : [{player, sessions, bytes}]."""
    if not CAPTURES_DIR.is_dir():
        return []
    out = []
    for player_dir in sorted(CAPTURES_DIR.iterdir()):
        if not player_dir.is_dir():
            continue
        files = [f for f in player_dir.iterdir() if f.suffix in (".jsonl", ".gz")]
        out.append({
            "player": player_dir.name,
            "sessions": len(files),
            "bytes": sum(f.stat().st_size for f in files),
            "files": sorted(f.name for f in files),
        })
    return out


def delete_capture(player, filename):
    """Supprime une session (filename donné) ou tout un joueur (filename=None). False si absent."""
    safe = _safe_player(player)
    player_dir = CAPTURES_DIR / safe
    if not player_dir.is_dir():
        return False
    if filename is None:
        shutil.rmtree(player_dir)
        return True
    target = player_dir / _SAFE_NAME.sub("_", str(filename))
    if not target.is_file():
        return False
    target.unlink()
    return True
```

- [ ] **Step 4 : Lancer → succès attendu**

Run : `cd "/Users/massimiliano/omenserver Project/Projet serveur" && source venv/bin/activate && python -m pytest backend/bots/tests/test_mc_capture_store.py -q 2>&1 | tail -5`
Expected : `11 passed`.

- [ ] **Step 5 : Commit (pathspec explicite — jamais `git add -A`)**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur"
git add backend/bots/mc_capture_store.py backend/bots/tests/test_mc_capture_store.py
git commit -m "feat(mc-capture): stockage captures par joueur + validation header consenti (TDD)"
```

---

## Task 2 : Fixture de capture réelle (pour la distillation)

**Files :**
- Create : `backend/bots/tests/fixtures/capture_sample.jsonl`

> Une capture minimale mais réaliste : header + une poignée de ticks de locomotion, un stimulus + réaction, un échange de chat. Sert de vérité-terrain aux tests de distillation (Task 3).

- [ ] **Step 1 : Créer la fixture**

`backend/bots/tests/fixtures/capture_sample.jsonl` (une ligne JSON par ligne) :
```jsonl
{"schema":1,"player":"Massii_08","uuid":"u1","mc":"1.21.4","mod":"0.1.0","consent":true,"startedAt":1748540000000,"sampleHz":20}
{"t":0,"type":"tick","in":{"fwd":1,"sprint":1},"yaw":0.0,"pitch":0.0,"pos":[0,64,0],"vel":[0.2,0,0],"og":1,"hp":20,"food":18,"held":"iron_sword"}
{"t":50,"type":"tick","in":{"fwd":1,"sprint":1},"yaw":1.5,"pitch":0.2,"pos":[0,64,0.2],"vel":[0.2,0,0],"og":1,"hp":20,"food":18,"held":"iron_sword"}
{"t":100,"type":"tick","in":{"fwd":1,"sprint":1},"yaw":3.4,"pitch":-0.1,"pos":[0,64,0.4],"vel":[0.2,0,0],"og":1,"hp":20,"food":18,"held":"iron_sword"}
{"t":2000,"type":"mob_appear","kind":"zombie","dist":6.0}
{"t":2240,"type":"tick","in":{"fwd":0,"atk":1},"yaw":12.0,"pitch":2.0,"pos":[1,64,1],"vel":[0,0,0],"og":1,"hp":20,"food":18,"held":"iron_sword"}
{"t":2300,"type":"attack","target":"zombie","dist":2.1}
{"t":3000,"type":"chat_in","from":"Steve","text":"tu peux ramener du bois ?","len":24}
{"t":5600,"type":"chat_out","text":"jarrive 2 sec","len":13}
{"t":5650,"type":"tick","in":{"fwd":1},"yaw":40.0,"pitch":0.0,"pos":[2,64,2],"vel":[0.1,0,0],"og":1,"hp":20,"food":17,"held":"iron_sword"}
```

- [ ] **Step 2 : Vérifier que chaque ligne est du JSON valide**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur"
python3 -c "import json;[json.loads(l) for l in open('backend/bots/tests/fixtures/capture_sample.jsonl') if l.strip()];print('OK toutes lignes valides')"
```
Expected : `OK toutes lignes valides`.

- [ ] **Step 3 : Commit**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur"
git add backend/bots/tests/fixtures/capture_sample.jsonl
git commit -m "test(mc-capture): fixture capture réelle minimale (ticks + stimulus + chat)"
```

---

## Task 3 : Distillation (`mc_capture_distill.py`)

**Files :**
- Create : `backend/bots/mc_capture_distill.py`
- Test : `backend/bots/tests/test_mc_capture_distill.py`

> Produit les **2 sorties** de la spec §7 : `style.json` (stats → calibration 1b.2) et `clips/` (motricité → rejeu 1b.3). Les **coefficients** (seuils, fenêtres) sont volontairement simples en v1 et se tuneront sur de vraies captures ; la spec ne fige que la **forme** des sorties — donc les tests vérifient la **forme et la cohérence**, pas des valeurs magiques.

- [ ] **Step 1 : Écrire les tests qui échouent**

`backend/bots/tests/test_mc_capture_distill.py` :
```python
"""Tests de la distillation .jsonl → style.json + clips (Phase 1b.1)."""
from pathlib import Path

import pytest

from backend.bots import mc_capture_distill as distill

FIXTURE = Path(__file__).parent / "fixtures" / "capture_sample.jsonl"


def test_load_records_separates_header_and_events():
    header, records = distill.load_records(FIXTURE.read_bytes())
    assert header["player"] == "Massii_08"
    assert len(records) >= 5
    assert any(r["type"] == "tick" for r in records)
    assert any(r["type"] == "chat_out" for r in records)


def test_distill_style_has_canonical_shape():
    style = distill.distill_style([FIXTURE.read_bytes()], player="Massii_08")
    # forme canonique (spec §7.1) — 1:1 avec humanize.js
    assert style["player"] == "Massii_08"
    assert "reaction" in style and {"meanMs", "stdMs", "n"} <= set(style["reaction"])
    assert "chat" in style and {"latencyMeanMs", "latencyStdMs", "typoRate"} <= set(style["chat"])
    assert "errorRate" in style
    dp = style["derivedParams"]
    assert {"chat", "errorRate", "movementJitter"} <= set(dp)
    assert {"latencyMeanMs", "latencyStdMs", "typoRate"} <= set(dp["chat"])


def test_derived_params_chat_mirrors_chat_block():
    style = distill.distill_style([FIXTURE.read_bytes()], player="Massii_08")
    assert style["derivedParams"]["chat"]["latencyMeanMs"] == style["chat"]["latencyMeanMs"]


def test_chat_latency_measured_from_in_to_out():
    # chat_in à t=3000, chat_out à t=5600 → latence ~2600ms
    style = distill.distill_style([FIXTURE.read_bytes()], player="Massii_08")
    assert 2000 <= style["chat"]["latencyMeanMs"] <= 3200


def test_segment_clips_tags_by_context():
    _, records = distill.load_records(FIXTURE.read_bytes())
    clips = distill.segment_clips(records, player="Massii_08")
    assert isinstance(clips, list) and len(clips) >= 1
    for c in clips:
        assert c["ctx"] in ("locomotion", "turn", "idle", "mine", "combat")
        assert c["player"] == "Massii_08"
        assert isinstance(c["frames"], list) and len(c["frames"]) >= 1
        for f in c["frames"]:
            assert "in" in f and "dyaw" in f and "dpitch" in f


def test_combat_clip_detected_around_attack():
    _, records = distill.load_records(FIXTURE.read_bytes())
    clips = distill.segment_clips(records, player="Massii_08")
    assert any(c["ctx"] == "combat" for c in clips)


def test_distill_empty_returns_safe_defaults():
    style = distill.distill_style([], player="Nobody")
    assert style["player"] == "Nobody"
    assert style["derivedParams"]["chat"]["latencyMeanMs"] > 0  # défaut sain, pas 0
```

- [ ] **Step 2 : Lancer → échec attendu**

Run : `cd "/Users/massimiliano/omenserver Project/Projet serveur" && source venv/bin/activate && python -m pytest backend/bots/tests/test_mc_capture_distill.py -q 2>&1 | tail -5`
Expected : FAIL (`ModuleNotFoundError: backend.bots.mc_capture_distill`).

- [ ] **Step 3 : Implémenter `backend/bots/mc_capture_distill.py`**

```python
"""
Distillation des captures comportementales (Phase 1b.1, spec §7).

Deux sorties à partir d'un ou plusieurs .jsonl :
  ① style.json  — statistiques de style (latence chat, réaction, taux de faute) ;
                  bloc derivedParams calé 1:1 sur mc-agent/humanize.js (calibration 1b.2).
  ② clips       — bibliothèque de motricité réelle segmentée par contexte (rejeu 1b.3).

Stdlib uniquement (json, gzip, statistics). Coefficients volontairement simples en v1
(se tunent sur de vraies captures) ; seule la FORME des sorties est figée par la spec.
"""
import gzip
import json
import statistics

# Défauts sains si la capture est trop pauvre pour mesurer (jamais 0 → humanize resterait muet).
_DEFAULTS = {
    "chat": {"latencyMeanMs": 1500, "latencyStdMs": 600, "typoRate": 0.03},
    "errorRate": 0.05,
    "movementJitter": 0.15,
}
_CLIP_MIN_FRAMES = 2


def _maybe_gunzip(payload):
    if payload[:2] == b"\x1f\x8b":  # magic gzip
        return gzip.decompress(payload)
    return payload


def load_records(payload):
    """Décompresse au besoin, parse le .jsonl → (header, [records])."""
    raw = _maybe_gunzip(payload)
    lines = [l for l in raw.decode("utf-8").splitlines() if l.strip()]
    if not lines:
        return {}, []
    header = json.loads(lines[0])
    records = []
    for line in lines[1:]:
        try:
            records.append(json.loads(line))
        except ValueError:
            continue
    return header, records


def _chat_latencies(records):
    """Latences (ms) entre un chat_in et le chat_out suivant — proxy du temps de réponse."""
    lat = []
    pending_in = None
    for r in records:
        if r.get("type") == "chat_in":
            pending_in = r.get("t")
        elif r.get("type") == "chat_out" and pending_in is not None:
            dt = r.get("t", 0) - pending_in
            if dt >= 0:
                lat.append(dt)
            pending_in = None
    return lat


def _typo_rate(records):
    """Heuristique simple : proportion de chat_out contenant un mot 'cassé' (sans voyelle / répétition)."""
    outs = [r.get("text", "") for r in records if r.get("type") == "chat_out"]
    if not outs:
        return None
    suspicious = sum(1 for t in outs if any(len(w) > 2 and not any(v in w.lower() for v in "aeiouy") for w in t.split()))
    return round(suspicious / len(outs), 3)


def _reaction_times(records):
    """Délais (ms) entre un stimulus (mob_appear/damage) et le tick suivant qui change d'input."""
    times = []
    last_stim = None
    last_in = None
    for r in records:
        t = r.get("type")
        if t in ("mob_appear", "damage"):
            last_stim = r.get("t")
        elif t == "tick":
            cur_in = r.get("in", {})
            if last_stim is not None and last_in is not None and cur_in != last_in:
                dt = r.get("t", 0) - last_stim
                if 0 <= dt <= 5000:
                    times.append(dt)
                last_stim = None
            last_in = cur_in
    return times


def _movement_jitter(records):
    """Écart-type des deltas de yaw entre ticks consécutifs (proxy de gigue de visée)."""
    yaws = [r.get("yaw") for r in records if r.get("type") == "tick" and r.get("yaw") is not None]
    if len(yaws) < 2:
        return None
    deltas = [abs(yaws[i + 1] - yaws[i]) for i in range(len(yaws) - 1)]
    try:
        return round(statistics.pstdev(deltas), 3)
    except statistics.StatisticsError:
        return None


def _mean_std(values):
    if not values:
        return None, None
    mean = round(statistics.mean(values))
    std = round(statistics.pstdev(values)) if len(values) > 1 else 0
    return mean, std


def distill_style(payloads, player):
    """Agrège ≥1 captures d'un joueur en un style.json (forme spec §7.1)."""
    all_records = []
    for p in payloads:
        _, recs = load_records(p)
        all_records.extend(recs)

    chat_lat = _chat_latencies(all_records)
    react = _reaction_times(all_records)
    lat_mean, lat_std = _mean_std(chat_lat)
    re_mean, re_std = _mean_std(react)
    typo = _typo_rate(all_records)
    jitter = _movement_jitter(all_records)

    chat_block = {
        "latencyMeanMs": lat_mean if lat_mean is not None else _DEFAULTS["chat"]["latencyMeanMs"],
        "latencyStdMs": lat_std if lat_std is not None else _DEFAULTS["chat"]["latencyStdMs"],
        "typoRate": typo if typo is not None else _DEFAULTS["chat"]["typoRate"],
        "msgs": sum(1 for r in all_records if r.get("type") == "chat_out"),
    }
    error_rate = _DEFAULTS["errorRate"]  # proxy affiné en 1b.2 sur vrais volumes
    movement_jitter = jitter if jitter is not None else _DEFAULTS["movementJitter"]

    return {
        "schema": 1,
        "player": player,
        "ticks": sum(1 for r in all_records if r.get("type") == "tick"),
        "reaction": {"meanMs": re_mean or 0, "stdMs": re_std or 0, "n": len(react)},
        "chat": chat_block,
        "errorRate": error_rate,
        "derivedParams": {
            "chat": {"latencyMeanMs": chat_block["latencyMeanMs"],
                     "latencyStdMs": chat_block["latencyStdMs"],
                     "typoRate": chat_block["typoRate"]},
            "errorRate": error_rate,
            "movementJitter": movement_jitter,
        },
    }


def _classify(prev_tick, cur_tick, recent_attack):
    """Contexte d'un tick : combat (attaque récente), mine (use/atk sur bloc), turn (gros dyaw), idle, locomotion."""
    cin = cur_tick.get("in", {})
    if recent_attack:
        return "combat"
    if cin.get("atk") or cin.get("use"):
        return "mine"
    dyaw = abs((cur_tick.get("yaw", 0) or 0) - (prev_tick.get("yaw", 0) or 0)) if prev_tick else 0
    moving = cin.get("fwd") or cin.get("back") or cin.get("left") or cin.get("right")
    if dyaw > 8:
        return "turn"
    if not moving and dyaw < 1:
        return "idle"
    return "locomotion"


def segment_clips(records, player):
    """Découpe le flux tick en clips courts taggés par contexte (frames = in + deltas de visée)."""
    ticks = [r for r in records if r.get("type") == "tick"]
    attack_times = [r.get("t", 0) for r in records if r.get("type") == "attack"]

    clips = []
    cur_ctx = None
    frames = []
    prev = None
    for tk in ticks:
        recent_attack = any(abs(tk.get("t", 0) - at) <= 500 for at in attack_times)
        ctx = _classify(prev, tk, recent_attack)
        dyaw = round((tk.get("yaw", 0) or 0) - (prev.get("yaw", 0) or 0), 3) if prev else 0.0
        dpitch = round((tk.get("pitch", 0) or 0) - (prev.get("pitch", 0) or 0), 3) if prev else 0.0
        frame = {"in": tk.get("in", {}), "dyaw": dyaw, "dpitch": dpitch}

        if ctx != cur_ctx and frames:
            if len(frames) >= _CLIP_MIN_FRAMES:
                clips.append({"ctx": cur_ctx, "player": player, "durTicks": len(frames), "frames": frames})
            frames = []
        cur_ctx = ctx
        frames.append(frame)
        prev = tk

    if frames and len(frames) >= _CLIP_MIN_FRAMES:
        clips.append({"ctx": cur_ctx, "player": player, "durTicks": len(frames), "frames": frames})
    return clips
```

> Note test `test_combat_clip_detected_around_attack` : la fixture a `attack` à t=2300 et un tick à t=2240 (≤500ms) → ce tick est taggé `combat`. Les ticks de locomotion initiaux (t=0/50/100) forment un clip `locomotion` (≥2 frames). `test_segment_clips_tags_by_context` exige ≥1 clip — satisfait.

- [ ] **Step 4 : Lancer → succès attendu**

Run : `cd "/Users/massimiliano/omenserver Project/Projet serveur" && source venv/bin/activate && python -m pytest backend/bots/tests/test_mc_capture_distill.py -q 2>&1 | tail -5`
Expected : `7 passed`.

- [ ] **Step 5 : Commit**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur"
git add backend/bots/mc_capture_distill.py backend/bots/tests/test_mc_capture_distill.py
git commit -m "feat(mc-capture): distillation style.json (stats) + clips de motricité (TDD, spec §7)"
```

---

## Task 4 : Router d'ingestion (`mc_capture_router.py`)

**Files :**
- Create : `backend/bots/mc_capture_router.py`
- Test : `backend/bots/tests/test_mc_capture_router.py`

> Endpoints admin-only, pattern exact de `mc_agent_router.py` (`_require_admin`, `Depends(get_current_user)`). La distillation écrit `style.json` + `clips/` à côté des sessions du joueur.

- [ ] **Step 1 : Écrire les tests qui échouent**

`backend/bots/tests/test_mc_capture_router.py` :
```python
"""Tests des endpoints capture (admin-only) — Phase 1b.1."""
import io
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.bots import mc_capture_router as cap
from backend.auth.utils import get_current_user


class _User:
    def __init__(self, is_admin):
        self.is_admin = is_admin
        self.username = "tester"


def _app(admin=True):
    app = FastAPI()
    app.include_router(cap.router)
    app.dependency_overrides[get_current_user] = lambda: _User(admin)
    return app


@pytest.fixture(autouse=True)
def tmp_root(tmp_path, monkeypatch):
    from backend.bots import mc_capture_store as store
    monkeypatch.setattr(store, "CAPTURES_DIR", tmp_path / "mc-captures")
    return tmp_path / "mc-captures"


def _jsonl(player="Massii_08"):
    header = {"schema": 1, "player": player, "mc": "1.21.4", "mod": "0.1.0",
              "consent": True, "startedAt": 1748540000000, "sampleHz": 20}
    tick = {"t": 0, "type": "tick", "in": {"fwd": 1}, "yaw": 1.0, "pitch": 0.0,
            "pos": [0, 64, 0], "vel": [0, 0, 0], "og": 1, "hp": 20, "food": 20, "held": "air"}
    return (json.dumps(header) + "\n" + json.dumps(tick) + "\n").encode()


def test_upload_requires_admin():
    client = TestClient(_app(admin=False))
    files = {"file": ("s.jsonl", io.BytesIO(_jsonl()), "application/octet-stream")}
    r = client.post("/api/mc-agent/captures", files=files)
    assert r.status_code == 403


def test_upload_stores_and_returns_player():
    client = TestClient(_app(admin=True))
    files = {"file": ("s.jsonl", io.BytesIO(_jsonl("Bob")), "application/octet-stream")}
    r = client.post("/api/mc-agent/captures", files=files)
    assert r.status_code == 200
    assert r.json()["player"] == "Bob"


def test_upload_rejects_bad_header():
    client = TestClient(_app(admin=True))
    bad = json.dumps({"schema": 1, "player": "X"}).encode() + b"\n"  # consent manquant
    files = {"file": ("s.jsonl", io.BytesIO(bad), "application/octet-stream")}
    r = client.post("/api/mc-agent/captures", files=files)
    assert r.status_code == 400


def test_list_captures_admin_only():
    client = TestClient(_app(admin=False))
    assert client.get("/api/mc-agent/captures").status_code == 403


def test_list_after_upload():
    client = TestClient(_app(admin=True))
    client.post("/api/mc-agent/captures",
                files={"file": ("s.jsonl", io.BytesIO(_jsonl("Bob")), "application/octet-stream")})
    r = client.get("/api/mc-agent/captures")
    assert r.status_code == 200
    assert any(p["player"] == "Bob" for p in r.json()["captures"])


def test_distill_then_get_style():
    client = TestClient(_app(admin=True))
    client.post("/api/mc-agent/captures",
                files={"file": ("s.jsonl", io.BytesIO(_jsonl("Bob")), "application/octet-stream")})
    d = client.post("/api/mc-agent/captures/Bob/distill")
    assert d.status_code == 200
    s = client.get("/api/mc-agent/captures/Bob/style")
    assert s.status_code == 200
    assert s.json()["player"] == "Bob"
    assert "derivedParams" in s.json()


def test_delete_player():
    client = TestClient(_app(admin=True))
    client.post("/api/mc-agent/captures",
                files={"file": ("s.jsonl", io.BytesIO(_jsonl("Bob")), "application/octet-stream")})
    assert client.delete("/api/mc-agent/captures/Bob").status_code == 200
    r = client.get("/api/mc-agent/captures")
    assert all(p["player"] != "Bob" for p in r.json()["captures"])
```

- [ ] **Step 2 : Lancer → échec attendu**

Run : `cd "/Users/massimiliano/omenserver Project/Projet serveur" && source venv/bin/activate && python -m pytest backend/bots/tests/test_mc_capture_router.py -q 2>&1 | tail -5`
Expected : FAIL (`ModuleNotFoundError: backend.bots.mc_capture_router`).

- [ ] **Step 3 : Implémenter `backend/bots/mc_capture_router.py`**

```python
"""Router d'ingestion des captures comportementales (admin-only) — Phase 1b.1."""
import json
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File

from backend.auth.utils import get_current_user
from backend.auth.models import User
from backend.bots import mc_capture_store as store
from backend.bots import mc_capture_distill as distill

router = APIRouter(prefix="/api/mc-agent", tags=["mc-agent-capture"])

_MAX_BYTES = 200 * 1024 * 1024  # 200 Mo : large (équipe × ~5h compressé reste sous ça)


def _require_admin(user):
    if not getattr(user, "is_admin", False):
        raise HTTPException(status_code=403, detail="Admin uniquement")


@router.post("/captures")
async def upload_capture(file: UploadFile = File(...), current_user: User = Depends(get_current_user)):
    """Upload manuel d'une capture .jsonl(.gz). Le joueur vient du header (attribution auto)."""
    _require_admin(current_user)
    payload = await file.read()
    if len(payload) > _MAX_BYTES:
        raise HTTPException(status_code=413, detail="Fichier trop volumineux")
    try:
        info = store.save_capture(payload, file.filename)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Capture invalide : {exc}")
    return info


@router.get("/captures")
def list_captures(current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    return {"captures": store.list_captures()}


@router.post("/captures/{player}/distill")
def distill_player(player: str, current_user: User = Depends(get_current_user)):
    """(Re)calcule style.json + clips/ pour un joueur depuis toutes ses sessions."""
    _require_admin(current_user)
    player_dir = store.CAPTURES_DIR / store._safe_player(player)
    if not player_dir.is_dir():
        raise HTTPException(status_code=404, detail="Joueur inconnu")
    payloads = [f.read_bytes() for f in sorted(player_dir.iterdir())
                if f.suffix in (".jsonl", ".gz")]
    style = distill.distill_style(payloads, player=player_dir.name)
    (player_dir / "style.json").write_text(json.dumps(style, ensure_ascii=False, indent=2), encoding="utf-8")

    clips_dir = player_dir / "clips"
    clips_dir.mkdir(exist_ok=True)
    total_clips = 0
    for payload in payloads:
        _, records = distill.load_records(payload)
        for clip in distill.segment_clips(records, player=player_dir.name):
            (clips_dir / f"{total_clips:05d}.json").write_text(
                json.dumps(clip, ensure_ascii=False), encoding="utf-8")
            total_clips += 1
    return {"player": player_dir.name, "clips": total_clips, "style": style}


@router.get("/captures/{player}/style")
def get_style(player: str, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    style_path = store.CAPTURES_DIR / store._safe_player(player) / "style.json"
    if not style_path.is_file():
        raise HTTPException(status_code=404, detail="Pas de style (lancer la distillation)")
    return json.loads(style_path.read_text(encoding="utf-8"))


@router.delete("/captures/{player}")
def delete_player(player: str, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    if not store.delete_capture(player, None):
        raise HTTPException(status_code=404, detail="Joueur inconnu")
    return {"ok": True}
```

- [ ] **Step 4 : Lancer → succès attendu**

Run : `cd "/Users/massimiliano/omenserver Project/Projet serveur" && source venv/bin/activate && python -m pytest backend/bots/tests/test_mc_capture_router.py -q 2>&1 | tail -5`
Expected : `7 passed`.

- [ ] **Step 5 : Commit**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur"
git add backend/bots/mc_capture_router.py backend/bots/tests/test_mc_capture_router.py
git commit -m "feat(mc-capture): router upload/list/distill/style/delete (admin-only, TDD)"
```

---

## Task 5 : Monter le router dans `main.py`

**Files :**
- Modify : `backend/main.py` (import après l.148 ; mount après l.180)

- [ ] **Step 1 : Ajouter l'import du router**

Dans `backend/main.py`, juste après la ligne :
```python
from backend.bots.mc_agent_router import router as mc_agent_router
```
ajouter :
```python
from backend.bots.mc_capture_router import router as mc_capture_router
```

- [ ] **Step 2 : Monter le router**

Dans `backend/main.py`, juste après la ligne :
```python
app.include_router(mc_agent_router)
```
ajouter :
```python
app.include_router(mc_capture_router)
```

- [ ] **Step 3 : Vérifier que l'app importe sans erreur**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur" && source venv/bin/activate && python -c "import backend.main; print('import OK')"
```
Expected : `import OK` (aucune ImportError ni collision de route).

- [ ] **Step 4 : Suite Python complète verte (non-régression)**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur" && source venv/bin/activate && python -m pytest backend/bots/tests/ -q 2>&1 | tail -3
```
Expected : tout vert (baseline + 25 nouveaux : 11 store + 7 distill + 7 router).

- [ ] **Step 5 : Commit**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur"
git add backend/main.py
git commit -m "feat(mc-capture): monte le router capture dans l'app FastAPI"
```

---

## Task 6 : Frontend — panneau « Captures » (i18n + UI + cache-bust)

**Files :**
- Modify : `frontend/js/lang.js` (clés `mcagent.capture.*`, 3 langues)
- Modify : `frontend/js/bots_module.js` (panneau dans `openMCAgent` + méthodes)
- Modify : `frontend/index.html` (bump `?v=`)
- Modify : `frontend/sw.js` (bump `CACHE_NAME`)

> ⚠️ Échappement HTML obligatoire à l'affichage des stats (anti-XSS, piège transcript). Pas de `Content-Type: application/json` sur l'upload `FormData` (piège #5 — `Auth.apiCall` le gère).

- [ ] **Step 1 : Ajouter les clés i18n (3 langues)**

Repérer les 3 sections `mcagent:` :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur" && grep -n "mcagent:" frontend/js/lang.js
```
Dans **chaque** bloc `mcagent: { ... }`, ajouter ces clés (traduire selon la langue) :

FR :
```js
      capture_title: 'Captures (entraînement copie-humaine)',
      capture_hint: 'Importer un fichier .jsonl enregistré par le mod (touche F8 en jeu).',
      capture_import: 'Importer une capture',
      capture_distill: 'Analyser',
      capture_delete: 'Supprimer',
      capture_none: 'Aucune capture pour le moment.',
      capture_sessions: 'sessions',
      capture_stats: 'Statistiques de style',
```
EN :
```js
      capture_title: 'Captures (human-copy training)',
      capture_hint: 'Upload a .jsonl recorded by the mod (press F8 in game).',
      capture_import: 'Import a capture',
      capture_distill: 'Analyze',
      capture_delete: 'Delete',
      capture_none: 'No capture yet.',
      capture_sessions: 'sessions',
      capture_stats: 'Style statistics',
```
IT :
```js
      capture_title: 'Catture (addestramento copia-umana)',
      capture_hint: 'Carica un file .jsonl registrato dal mod (tasto F8 in gioco).',
      capture_import: 'Importa una cattura',
      capture_distill: 'Analizza',
      capture_delete: 'Elimina',
      capture_none: 'Nessuna cattura per ora.',
      capture_sessions: 'sessioni',
      capture_stats: 'Statistiche di stile',
```

- [ ] **Step 2 : Insérer le panneau « Captures » dans `openMCAgent`**

Dans `frontend/js/bots_module.js`, repérer la fin du formulaire de `openMCAgent` (juste **avant** la ligne `<div id="mca-transcript"` ~l.1067) et insérer ce bloc HTML dans le template :
```js
        <div style="border-top:1px solid var(--border);margin:14px 0;padding-top:12px;">
          <div style="font-weight:600;margin-bottom:4px;">${Lang.t('mcagent.capture_title')}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">${Lang.t('mcagent.capture_hint')}</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;">
            <input id="mca-capfile" type="file" accept=".jsonl,.gz" class="form-input" style="flex:1;min-width:200px;" />
            <button class="btn btn-secondary btn-sm" onclick="BotsModule.uploadCapture()">${Lang.t('mcagent.capture_import')}</button>
          </div>
          <div id="mca-captures"></div>
        </div>
```

- [ ] **Step 3 : Ajouter les méthodes JS (après `startMCAgent` ou en fin d'objet `BotsModule`)**

Dans `frontend/js/bots_module.js`, ajouter ces méthodes à l'objet `BotsModule` :
```js
  _escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },

  async loadCaptures() {
    const box = document.getElementById('mca-captures');
    if (!box) return;
    try {
      const r = await Auth.apiCall('/api/mc-agent/captures');
      const data = await r.json();
      const caps = (data && data.captures) || [];
      if (!caps.length) { box.innerHTML = `<div style="font-size:12px;color:var(--text-dim);">${Lang.t('mcagent.capture_none')}</div>`; return; }
      box.innerHTML = caps.map((c) => {
        const p = this._escapeHtml(c.player);
        const mb = (c.bytes / 1048576).toFixed(1);
        return `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 8px;background:var(--bg-elev-2);border:1px solid var(--border);border-radius:8px;margin-bottom:6px;">
          <span style="font-family:var(--font-mono);">${p} — ${c.sessions} ${Lang.t('mcagent.capture_sessions')} (${mb} Mo)</span>
          <span style="display:flex;gap:6px;">
            <button class="btn btn-ghost btn-sm" onclick="BotsModule.distillCapture('${p}')">${Lang.t('mcagent.capture_distill')}</button>
            <button class="btn btn-ghost btn-sm" onclick="BotsModule.deleteCapture('${p}')">${Lang.t('mcagent.capture_delete')}</button>
          </span></div>
          <div id="mca-style-${p}" style="font-size:12px;color:var(--text-muted);margin:-2px 0 8px 8px;"></div>`;
      }).join('');
    } catch (e) { box.innerHTML = `<div style="color:var(--danger);font-size:12px;">${this._escapeHtml(String(e))}</div>`; }
  },

  async uploadCapture() {
    const input = document.getElementById('mca-capfile');
    if (!input || !input.files || !input.files[0]) return;
    const fd = new FormData();
    fd.append('file', input.files[0]);
    const r = await Auth.apiCall('/api/mc-agent/captures', { method: 'POST', body: fd });
    if (r.ok) { input.value = ''; Toast.show(Lang.t('mcagent.capture_import') + ' ✓'); this.loadCaptures(); }
    else { const e = await r.json().catch(() => ({})); Toast.show((e.detail || 'Upload KO'), 'error'); }
  },

  async distillCapture(player) {
    const r = await Auth.apiCall(`/api/mc-agent/captures/${encodeURIComponent(player)}/distill`, { method: 'POST' });
    const data = await r.json().catch(() => ({}));
    const el = document.getElementById('mca-style-' + player);
    if (r.ok && el) {
      const dp = (data.style && data.style.derivedParams) || {};
      const chat = dp.chat || {};
      el.innerHTML = `${Lang.t('mcagent.capture_stats')} — latence chat ${this._escapeHtml(chat.latencyMeanMs)}±${this._escapeHtml(chat.latencyStdMs)}ms · ` +
                     `fautes ${this._escapeHtml(chat.typoRate)} · jitter ${this._escapeHtml(dp.movementJitter)} · ${this._escapeHtml(data.clips)} clips`;
    }
  },

  async deleteCapture(player) {
    if (!confirm(player + ' ?')) return;
    const r = await Auth.apiCall(`/api/mc-agent/captures/${encodeURIComponent(player)}`, { method: 'DELETE' });
    if (r.ok) this.loadCaptures();
  },
```

- [ ] **Step 4 : Appeler `loadCaptures()` à l'ouverture du panneau**

Dans `openMCAgent`, repérer la fin (où il y a déjà `this._loadMCAgentKey();` et `this.loadMCAgentProfiles();` ~l.1073-1074) et ajouter juste après :
```js
    this.loadCaptures();
```

- [ ] **Step 5 : Valider le parse JS (piège #28 — pas de SyntaxError silencieuse)**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur"
node -e "new Function(require('fs').readFileSync('frontend/js/bots_module.js','utf8')); console.log('bots_module.js parse OK')"
node -e "new Function(require('fs').readFileSync('frontend/js/lang.js','utf8')); console.log('lang.js parse OK')"
```
Expected : les deux `parse OK`.

- [ ] **Step 6 : Cache-bust (pièges #9/#11/#35-bis)**

Repérer les valeurs courantes :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur" && grep -nE "bots_module.js\?v=|lang.js\?v=" frontend/index.html && grep -n "CACHE_NAME" frontend/sw.js
```
Bumper le `?v=` de `bots_module.js` ET `lang.js` à une valeur franche supérieure dans `frontend/index.html`, et incrémenter `CACHE_NAME` dans `frontend/sw.js`.

- [ ] **Step 7 : Commit**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur"
git add frontend/js/bots_module.js frontend/js/lang.js frontend/index.html frontend/sw.js
git commit -m "feat(mc-capture): panneau Captures (upload/list/analyse/suppr) + i18n + cache-bust"
```

---

## Task 7 : Le mod Fabric — logique pure testable (`SessionWriter` + `Recorder`)

**Files :**
- Create : `mc-capture-mod/build.gradle`, `settings.gradle`, `gradle.properties`
- Create : `mc-capture-mod/src/main/java/org/omen/capture/TickRecord.java`
- Create : `mc-capture-mod/src/main/java/org/omen/capture/SessionWriter.java`
- Create : `mc-capture-mod/src/main/java/org/omen/capture/Recorder.java`
- Test : `mc-capture-mod/src/test/java/org/omen/capture/SessionWriterTest.java`, `RecorderTest.java`

> On code d'abord la **logique pure** (sérialisation + machine d'état), **sans aucune dépendance Minecraft**, pour qu'elle soit testable en JUnit sans client. Les hooks MC (Task 8) ne feront qu'appeler cette logique.

- [ ] **Step 1 : Fichiers Gradle (build 1.21.x, Java 21)**

`mc-capture-mod/gradle.properties` :
```properties
org.gradle.jvmargs=-Xmx2G
minecraft_version=1.21.4
yarn_mappings=1.21.4+build.1
loader_version=0.16.9
fabric_version=0.110.0+1.21.4
mod_version=0.1.0
maven_group=org.omen.capture
archives_base_name=mc-capture
```
> Si une version épinglée n'existe pas au build, ajuster via https://fabricmc.net/develop (1.21.x). Le build échouera proprement avec un message clair si un coordonnée Maven est introuvable.

`mc-capture-mod/settings.gradle` :
```groovy
pluginManagement {
    repositories {
        maven { url = 'https://maven.fabricmc.net/' }
        gradlePluginPortal()
    }
}
rootProject.name = 'mc-capture'
```

`mc-capture-mod/build.gradle` :
```groovy
plugins {
    id 'fabric-loom' version '1.8-SNAPSHOT'
    id 'java'
}

version = project.mod_version
group = project.maven_group
base { archivesName = project.archives_base_name }

repositories { mavenCentral() }

dependencies {
    minecraft "com.mojang:minecraft:${project.minecraft_version}"
    mappings "net.fabricmc:yarn:${project.yarn_mappings}:v2"
    modImplementation "net.fabricmc:fabric-loader:${project.loader_version}"
    modImplementation "net.fabricmc.fabric-api:fabric-api:${project.fabric_version}"

    testImplementation platform('org.junit:junit-bom:5.10.2')
    testImplementation 'org.junit.jupiter:junit-jupiter'
}

java {
    sourceCompatibility = JavaVersion.VERSION_21
    targetCompatibility = JavaVersion.VERSION_21
}

test { useJUnitPlatform() }
```

`mc-capture-mod/src/main/resources/fabric.mod.json` :
```json
{
  "schemaVersion": 1,
  "id": "mc_capture",
  "version": "${version}",
  "name": "OmenCapture",
  "description": "Enregistreur d'inputs consenti (REC/F8) pour l'entrainement de la moderation OmenServer.",
  "environment": "client",
  "entrypoints": { "client": ["org.omen.capture.CaptureMod"] },
  "depends": { "fabricloader": ">=0.16.0", "minecraft": "~1.21", "fabric-api": "*" }
}
```

- [ ] **Step 2 : Écrire les tests JUnit qui échouent**

`mc-capture-mod/src/test/java/org/omen/capture/SessionWriterTest.java` :
```java
package org.omen.capture;

import org.junit.jupiter.api.Test;
import java.io.ByteArrayOutputStream;
import static org.junit.jupiter.api.Assertions.*;

class SessionWriterTest {

    @Test
    void headerHasSchemaPlayerConsent() {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        SessionWriter w = new SessionWriter(out);
        w.writeHeader("Massii_08", "1.21.4", "0.1.0", 1748540000000L, 20);
        String line = out.toString().strip();
        assertTrue(line.contains("\"schema\":1"), line);
        assertTrue(line.contains("\"player\":\"Massii_08\""), line);
        assertTrue(line.contains("\"consent\":true"), line);
    }

    @Test
    void tickRecordSerializesInputsAndLook() {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        SessionWriter w = new SessionWriter(out);
        TickRecord r = new TickRecord();
        r.t = 1234; r.yaw = -12.4; r.pitch = 3.1;
        r.forward = true; r.sprint = true;
        w.writeTick(r);
        String line = out.toString().strip();
        assertTrue(line.contains("\"type\":\"tick\""), line);
        assertTrue(line.contains("\"t\":1234"), line);
        assertTrue(line.contains("\"fwd\":1"), line);
        assertTrue(line.contains("\"yaw\":-12.4"), line);
    }

    @Test
    void playerNameIsJsonEscaped() {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        SessionWriter w = new SessionWriter(out);
        w.writeHeader("ev\"il", "1.21.4", "0.1.0", 1L, 20);
        String line = out.toString();
        assertTrue(line.contains("ev\\\"il"), line);  // guillemet échappé
    }
}
```

`mc-capture-mod/src/test/java/org/omen/capture/RecorderTest.java` :
```java
package org.omen.capture;

import org.junit.jupiter.api.Test;
import java.io.ByteArrayOutputStream;
import static org.junit.jupiter.api.Assertions.*;

class RecorderTest {

    @Test
    void startsOff() {
        Recorder rec = new Recorder(() -> new ByteArrayOutputStream());
        assertFalse(rec.isRecording());
    }

    @Test
    void startThenRecording() {
        Recorder rec = new Recorder(() -> new ByteArrayOutputStream());
        rec.start("Massii_08", "1.21.4", "0.1.0", 1L, 20);
        assertTrue(rec.isRecording());
    }

    @Test
    void stopReturnsToOff() {
        Recorder rec = new Recorder(() -> new ByteArrayOutputStream());
        rec.start("Massii_08", "1.21.4", "0.1.0", 1L, 20);
        rec.stop();
        assertFalse(rec.isRecording());
    }

    @Test
    void ioErrorOnStartFallsBackToOff() {
        // sink qui throw à l'écriture → start doit retomber OFF (jamais bloqué en REC)
        Recorder rec = new Recorder(() -> { throw new RuntimeException("disk full"); });
        rec.start("Massii_08", "1.21.4", "0.1.0", 1L, 20);
        assertFalse(rec.isRecording(), "une erreur d'I/O doit forcer REC-off");
    }

    @Test
    void recordTickOnlyWhenRecording() {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        Recorder rec = new Recorder(() -> out);
        TickRecord r = new TickRecord();
        rec.recordTick(r);                  // OFF → ignoré
        assertEquals(0, out.size());
        rec.start("p", "1.21.4", "0.1.0", 1L, 20);
        rec.recordTick(r);                  // ON → écrit
        assertTrue(out.size() > 0);
    }
}
```

- [ ] **Step 3 : Lancer → échec attendu**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/mc-capture-mod" && ./gradlew test 2>&1 | tail -15
```
Expected : échec de compilation (classes `SessionWriter`/`Recorder`/`TickRecord` absentes). *(1er run : Gradle se télécharge — peut être long. Si `gradlew` absent, lancer `gradle wrapper` une fois, ou `brew install gradle`.)*

- [ ] **Step 4 : Implémenter les 3 classes pures**

`mc-capture-mod/src/main/java/org/omen/capture/TickRecord.java` :
```java
package org.omen.capture;

/** DTO d'un tick capturé. Champs publics (POJO simple), rempli par les hooks puis sérialisé. */
public class TickRecord {
    public long t;
    public boolean forward, back, left, right, jump, sneak, sprint, attack, use;
    public double yaw, pitch;
    public double x, y, z, vx, vy, vz;
    public boolean onGround = true;
    public int health = 20, food = 20;
    public String held = "air";
}
```

`mc-capture-mod/src/main/java/org/omen/capture/SessionWriter.java` :
```java
package org.omen.capture;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Sérialisation JSONL PURE (aucune dépendance Minecraft). Écrit le header puis un objet
 * JSON par tick sur l'OutputStream fourni. JSON construit à la main (pas de lib) pour
 * rester sans dépendance et 100% testable.
 */
public class SessionWriter {
    private final OutputStream out;

    public SessionWriter(OutputStream out) { this.out = out; }

    private static String esc(String s) {
        if (s == null) return "";
        StringBuilder b = new StringBuilder();
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default: b.append(c);
            }
        }
        return b.toString();
    }

    private void writeLine(String json) {
        try {
            out.write(json.getBytes(StandardCharsets.UTF_8));
            out.write('\n');
            out.flush();
        } catch (IOException e) {
            throw new RuntimeException(e);  // remonté à Recorder → REC-off
        }
    }

    public void writeHeader(String player, String mc, String mod, long startedAt, int sampleHz) {
        writeLine("{\"schema\":1,\"player\":\"" + esc(player) + "\",\"mc\":\"" + esc(mc)
                + "\",\"mod\":\"" + esc(mod) + "\",\"consent\":true,\"startedAt\":" + startedAt
                + ",\"sampleHz\":" + sampleHz + "}");
    }

    private static int b(boolean v) { return v ? 1 : 0; }

    public void writeTick(TickRecord r) {
        writeLine("{\"t\":" + r.t + ",\"type\":\"tick\",\"in\":{"
                + "\"fwd\":" + b(r.forward) + ",\"back\":" + b(r.back) + ",\"left\":" + b(r.left)
                + ",\"right\":" + b(r.right) + ",\"jump\":" + b(r.jump) + ",\"sneak\":" + b(r.sneak)
                + ",\"sprint\":" + b(r.sprint) + ",\"atk\":" + b(r.attack) + ",\"use\":" + b(r.use)
                + "},\"yaw\":" + r.yaw + ",\"pitch\":" + r.pitch
                + ",\"pos\":[" + r.x + "," + r.y + "," + r.z + "]"
                + ",\"vel\":[" + r.vx + "," + r.vy + "," + r.vz + "]"
                + ",\"og\":" + b(r.onGround) + ",\"hp\":" + r.health + ",\"food\":" + r.food
                + ",\"held\":\"" + esc(r.held) + "\"}");
    }

    public void writeChat(long t, String dir, String from, String text, int len) {
        StringBuilder b = new StringBuilder("{\"t\":").append(t)
                .append(",\"type\":\"").append(dir).append("\"");
        if (from != null) b.append(",\"from\":\"").append(esc(from)).append("\"");
        if (text != null) b.append(",\"text\":\"").append(esc(text)).append("\"");
        b.append(",\"len\":").append(len).append("}");
        writeLine(b.toString());
    }
}
```

`mc-capture-mod/src/main/java/org/omen/capture/Recorder.java` :
```java
package org.omen.capture;

import java.io.OutputStream;
import java.util.function.Supplier;

/**
 * Machine d'état REC/OFF PURE (aucune dépendance Minecraft). Garantit l'invariant de
 * consentement : par défaut OFF ; toute erreur d'I/O au démarrage ou à l'écriture force OFF.
 * Le Supplier<OutputStream> est injecté (fichier en prod, mémoire en test).
 */
public class Recorder {
    private final Supplier<OutputStream> sinkFactory;
    private SessionWriter writer;
    private boolean recording = false;

    public Recorder(Supplier<OutputStream> sinkFactory) { this.sinkFactory = sinkFactory; }

    public boolean isRecording() { return recording; }

    /** Démarre une session. En cas d'erreur d'ouverture/écriture → reste OFF (consentement sûr). */
    public void start(String player, String mc, String mod, long startedAt, int sampleHz) {
        try {
            OutputStream out = sinkFactory.get();
            writer = new SessionWriter(out);
            writer.writeHeader(player, mc, mod, startedAt, sampleHz);
            recording = true;
        } catch (RuntimeException e) {
            writer = null;
            recording = false;  // ⇐ « si problème = REC-off »
        }
    }

    public void stop() { writer = null; recording = false; }

    public void recordTick(TickRecord r) {
        if (!recording || writer == null) return;
        try { writer.writeTick(r); }
        catch (RuntimeException e) { stop(); }  // erreur d'écriture → REC-off
    }

    public void recordChat(long t, String dir, String from, String text, int len) {
        if (!recording || writer == null) return;
        try { writer.writeChat(t, dir, from, text, len); }
        catch (RuntimeException e) { stop(); }
    }
}
```

- [ ] **Step 5 : Lancer → succès attendu**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/mc-capture-mod" && ./gradlew test 2>&1 | tail -15
```
Expected : `BUILD SUCCESSFUL`, 3 + 5 tests passés.

- [ ] **Step 6 : Commit**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur"
git add mc-capture-mod/build.gradle mc-capture-mod/settings.gradle mc-capture-mod/gradle.properties \
        mc-capture-mod/src/main/resources/fabric.mod.json \
        mc-capture-mod/src/main/java/org/omen/capture/TickRecord.java \
        mc-capture-mod/src/main/java/org/omen/capture/SessionWriter.java \
        mc-capture-mod/src/main/java/org/omen/capture/Recorder.java \
        mc-capture-mod/src/test/java/org/omen/capture/SessionWriterTest.java \
        mc-capture-mod/src/test/java/org/omen/capture/RecorderTest.java
git commit -m "feat(mc-capture-mod): logique pure JSONL + machine d'état REC (consentement, TDD JUnit)"
```

---

## Task 8 : Le mod Fabric — hooks Minecraft (HUD + F8 + tick + chat)

**Files :**
- Create : `mc-capture-mod/src/main/java/org/omen/capture/CaptureMod.java`
- Create : `mc-capture-mod/src/main/java/org/omen/capture/RecHud.java`
- Create : `mc-capture-mod/README.md`

> Ces classes touchent l'API Minecraft → **pas de test unitaire** (validé par build + smoke en jeu). Elles se contentent de **brancher** les hooks sur la logique pure de Task 7. Si un nom de mapping yarn diffère sur la version épinglée, l'erreur de compilation l'indiquera précisément.

- [ ] **Step 1 : `CaptureMod.java` (entrypoint client)**

`mc-capture-mod/src/main/java/org/omen/capture/CaptureMod.java` :
```java
package org.omen.capture;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keybinding.v1.KeyBindingHelper;
import net.fabricmc.fabric.api.client.message.v1.ClientReceiveMessageEvents;
import net.fabricmc.fabric.api.client.message.v1.ClientSendMessageEvents;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.client.util.InputUtil;
import org.lwjgl.glfw.GLFW;

import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;

/**
 * Entrypoint client OmenCapture. Branche F8 (toggle REC), le tick (échantillonnage des
 * inputs/état) et le chat (in+out) sur le Recorder pur. Le HUD affiche l'état REC en continu
 * (consentement visible). Aucune capacité réseau : le fichier reste LOCAL (upload manuel).
 */
public class CaptureMod implements ClientModInitializer {
    public static final Recorder RECORDER = newFileRecorder();
    private static boolean consentShown = false;
    private static long startMs = 0;

    private KeyBinding toggleKey;

    private static Recorder newFileRecorder() {
        return new Recorder(() -> {
            try {
                Path dir = MinecraftClient.getInstance().runDirectory.toPath().resolve("mc-capture");
                Files.createDirectories(dir);
                Path file = dir.resolve("session-" + System.currentTimeMillis() + ".jsonl");
                return Files.newOutputStream(file, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
            } catch (Exception e) {
                throw new RuntimeException(e);  // → Recorder reste OFF
            }
        });
    }

    @Override
    public void onInitializeClient() {
        toggleKey = KeyBindingHelper.registerKeyBinding(new KeyBinding(
                "key.mc_capture.toggle", InputUtil.Type.KEYSYM, GLFW.GLFW_KEY_F8, "key.categories.mc_capture"));

        RecHud.register();

        ClientTickEvents.END_CLIENT_TICK.register(client -> {
            while (toggleKey.wasPressed()) toggleRecording(client);
            if (RECORDER.isRecording() && client.player != null) sampleTick(client);
        });

        ClientSendMessageEvents.CHAT.register(message -> {
            if (RECORDER.isRecording())
                RECORDER.recordChat(elapsed(), "chat_out", null, message, message.length());
        });
        ClientReceiveMessageEvents.CHAT.register((message, signedMessage, sender, params, receptionTimestamp) -> {
            if (RECORDER.isRecording()) {
                String txt = message.getString();
                String from = sender != null ? sender.getName() : null;
                RECORDER.recordChat(elapsed(), "chat_in", from, txt, txt.length());
            }
        });
    }

    private void toggleRecording(MinecraftClient client) {
        if (RECORDER.isRecording()) {
            RECORDER.stop();
            if (client.player != null) client.player.sendMessage(net.minecraft.text.Text.literal("[OmenCapture] REC-off"), false);
            return;
        }
        if (!consentShown && client.player != null) {
            client.player.sendMessage(net.minecraft.text.Text.literal(
                "[OmenCapture] Ce mod enregistre tes inputs, deplacements et le chat pour l'entrainement de la moderation. "
                + "Rien n'est envoye automatiquement — tu choisis d'uploader. F8 = demarrer/arreter."), false);
            consentShown = true;
        }
        startMs = System.currentTimeMillis();
        String name = client.player != null ? client.player.getGameProfile().getName() : "unknown";
        String mc = client.getGameVersion();
        RECORDER.start(name, mc, "0.1.0", startMs, 20);
        if (client.player != null) {
            String msg = RECORDER.isRecording() ? "[OmenCapture] ● REC" : "[OmenCapture] Echec demarrage (REC-off)";
            client.player.sendMessage(net.minecraft.text.Text.literal(msg), false);
        }
    }

    private static long elapsed() { return System.currentTimeMillis() - startMs; }

    private void sampleTick(MinecraftClient client) {
        var p = client.player;
        var opt = client.options;
        TickRecord r = new TickRecord();
        r.t = elapsed();
        r.forward = opt.forwardKey.isPressed();
        r.back = opt.backKey.isPressed();
        r.left = opt.leftKey.isPressed();
        r.right = opt.rightKey.isPressed();
        r.jump = opt.jumpKey.isPressed();
        r.sneak = opt.sneakKey.isPressed();
        r.sprint = opt.sprintKey.isPressed();
        r.attack = opt.attackKey.isPressed();
        r.use = opt.useKey.isPressed();
        r.yaw = p.getYaw();
        r.pitch = p.getPitch();
        r.x = p.getX(); r.y = p.getY(); r.z = p.getZ();
        r.vx = p.getVelocity().x; r.vy = p.getVelocity().y; r.vz = p.getVelocity().z;
        r.onGround = p.isOnGround();
        r.health = (int) p.getHealth();
        r.food = p.getHungerManager().getFoodLevel();
        r.held = p.getMainHandStack().getItem().toString();
        RECORDER.recordTick(r);
    }
}
```
> ⚠️ Les noms d'API (`forwardKey`, `getHungerManager`, signatures d'events chat) suivent les mappings yarn 1.21.x. Si le build signale un nom inconnu, le corriger via la doc/mappings de la version épinglée — c'est le seul ajustement version-spécifique attendu.

- [ ] **Step 2 : `RecHud.java` (overlay REC permanent)**

`mc-capture-mod/src/main/java/org/omen/capture/RecHud.java` :
```java
package org.omen.capture;

import net.fabricmc.fabric.api.client.rendering.v1.HudRenderCallback;
import net.minecraft.client.MinecraftClient;

/** Overlay coin haut-gauche : "● REC" (rouge) quand on enregistre, "REC-off" (gris) sinon. */
public class RecHud {
    public static void register() {
        HudRenderCallback.EVENT.register((ctx, tickDelta) -> {
            MinecraftClient mc = MinecraftClient.getInstance();
            if (mc.options.hudHidden) return;
            boolean rec = CaptureMod.RECORDER.isRecording();
            String label = rec ? "● REC" : "REC-off";
            int color = rec ? 0xFFFF5555 : 0xFF888888;
            ctx.drawText(mc.textRenderer, label, 6, 6, color, true);
        });
    }
}
```

- [ ] **Step 3 : `README.md` (build + install)**

`mc-capture-mod/README.md` :
```markdown
# OmenCapture — mod de capture consentie (Phase 1b.1)

Enregistre tes inputs/déplacements/chat en jeu pour l'entraînement de la modération OmenServer.
**Consentement** : OFF au lancement (`REC-off`). **F8** démarre/arrête (`● REC` rouge à l'écran).
Rien n'est envoyé automatiquement — le fichier reste local, tu l'uploades via le dashboard.

## Build (machine de dev, Java 21)
    cd mc-capture-mod
    ./gradlew build
Le jar est dans `build/libs/mc-capture-<version>.jar`.

## Install (client du joueur)
1. Installer **Fabric Loader** pour la version MC qui correspond (https://fabricmc.net/use/installer/).
2. Installer **Fabric API** (jar) dans `.minecraft/mods/`.
3. Copier `mc-capture-<version>.jar` dans `.minecraft/mods/`.
4. Lancer MC avec le profil Fabric → en jeu, **F8** pour enregistrer.
5. Les captures sont dans `.minecraft/mc-capture/session-*.jsonl`.
6. Uploader le fichier dans le dashboard → MC Agent → Captures.

## Multi-version
Cible validée : **1.21.x** (épinglée dans `gradle.properties`). Pour 1.20.x : changer
`minecraft_version`/`yarn_mappings`/`fabric_version` et rebuild.
```

- [ ] **Step 4 : Vérifier que le mod compile (build complet)**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/mc-capture-mod" && ./gradlew build 2>&1 | tail -20
```
Expected : `BUILD SUCCESSFUL` + jar présent (`ls build/libs/*.jar`). En cas d'échec sur un nom de mapping, corriger le nom et relancer (cf. note Step 1).

- [ ] **Step 5 : `.gitignore` du mod (ne pas committer les artefacts de build)**

`mc-capture-mod/.gitignore` :
```gitignore
.gradle/
build/
run/
```
Run pour confirmer qu'aucun artefact n'est stagé :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur"
git status --porcelain mc-capture-mod/ | grep -E "build/|\.gradle/" && echo "⚠️ artefacts à ignorer" || echo "OK propre"
```
Expected : `OK propre`.

- [ ] **Step 6 : Commit**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur"
git add mc-capture-mod/src/main/java/org/omen/capture/CaptureMod.java \
        mc-capture-mod/src/main/java/org/omen/capture/RecHud.java \
        mc-capture-mod/README.md mc-capture-mod/.gitignore
git commit -m "feat(mc-capture-mod): hooks Fabric (F8 toggle + HUD REC + tick + chat in/out)"
```

---

## Task 9 : Documentation projet (CLAUDE.md) + smoke e2e

**Files :**
- Modify : `CLAUDE.md` (pièges Fabric + historique)

- [ ] **Step 1 : Ajouter un piège « mod Fabric » dans CLAUDE.md**

Dans `CLAUDE.md`, à la fin de la section `## ⚠️ Pièges connus`, ajouter :
```markdown
35. **Mod Fabric `mc-capture-mod/` = build-time only** : c'est un mod CLIENT (tourne sur la machine du joueur, pas sur l'Omen). L'Omen ne gagne AUCUNE dépendance runtime — il ne fait qu'ingérer/distiller les `.jsonl` uploadés (Python stdlib). Java 21 + Gradle requis SEULEMENT pour builder le `.jar` (machine de dev). Le mod est **version-MC-spécifique** : `gradle.properties` épingle 1.21.x ; changer les coordonnées + rebuild pour 1.20.x. Logique pure (`SessionWriter`/`Recorder`) testable en JUnit sans client ; les hooks (`CaptureMod`/`RecHud`) validés au build + smoke en jeu. **Consentement câblé** : Recorder OFF par défaut, toute erreur d'I/O force REC-off.
36. **Captures comportementales = admin-only + consenties** : `data/mc-captures/<joueur>/` (gitignored). Le `player` vient TOUJOURS du header du `.jsonl` (jamais d'un champ UI) → attribution auto même si un seul admin uploade pour toute l'équipe. Upload manuel uniquement (le mod n'a aucune capacité réseau). `_safe_player()` anti path-traversal sur le nom de dossier.
```

- [ ] **Step 2 : Ajouter l'entrée d'historique**

Dans `CLAUDE.md`, en tête du tableau `## 📝 Historique récent`, ajouter :
```markdown
| 2026-05-30 | 🎮 **MC Agent Phase 1b.1 — pipeline de capture** (branche `feat/mc-agent-phase1b`). Mod client **Fabric** OmenCapture (REC/REC-off **F8**, HUD permanent, consentement OFF par défaut + erreur→off, chat in+out, cible 1.21.x) → `.jsonl` local → **upload manuel** dashboard. Backend **stdlib** : `mc_capture_store` (rangé par joueur, attribution par header, anti-traversal), `mc_capture_distill` (→ `style.json` stats + `clips/` motricité, spec §7), `mc_capture_router` (upload/list/distill/style/delete, **admin-only**). Panneau « Captures » UI + i18n. Tests Python (store 11 + distill 7 + router 7) + JUnit (writer 3 + recorder 5). Mod = build-time only, l'Omen ne gagne aucune dép runtime. Pièges #35/#36. |
```

- [ ] **Step 3 : Suite complète verte (Python) + parse JS + build mod**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur" && source venv/bin/activate && python -m pytest backend/bots/tests/ -q 2>&1 | tail -3
node -e "new Function(require('fs').readFileSync('frontend/js/bots_module.js','utf8'));new Function(require('fs').readFileSync('frontend/js/lang.js','utf8'));console.log('JS parse OK')"
cd "/Users/massimiliano/omenserver Project/Projet serveur/mc-capture-mod" && ./gradlew test 2>&1 | tail -3
```
Expected : Python tout vert · `JS parse OK` · Gradle `BUILD SUCCESSFUL`.

- [ ] **Step 4 : Commit**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur"
git add CLAUDE.md
git commit -m "docs(mc-capture): pièges Fabric/captures + historique Phase 1b.1"
```

- [ ] **Step 5 : Smoke e2e manuel (Massii — nécessite client MC + serveur)**

Prérequis fournis par Massii : un client MC avec Fabric Loader + le `.jar` buildé dans `mods/`, et le backend lancé (`uvicorn` dans son terminal). Procédure :
1. En jeu, vérifier le HUD **`REC-off`** au lancement (consentement : pas d'enregistrement passif).
2. **F8** → notice de consentement affichée + HUD **`● REC`** rouge.
3. Jouer ~1 min (bouger, viser, miner, taper un message dans le chat).
4. **F8** → HUD repasse `REC-off`. Vérifier le fichier `.minecraft/mc-capture/session-*.jsonl`.
5. Dashboard (admin) → Bots → MC Agent → **Captures** → importer le `.jsonl` → la ligne du joueur apparaît.
6. **Analyser** → les stats s'affichent (latence chat, jitter, nb de clips).
7. **Supprimer** → la ligne disparaît (droit à l'effacement).

> Définition de « 1b.1 terminé » : HUD REC visible et fidèle à l'état · capture écrite localement · upload admin-only OK · distillation produit `style.json` + `clips/` · stats visibles dans l'UI · suppression OK · tous les tests verts. Les jalons 1b.2 (calibration), 1b.3 (clone hybride) et 1b.4 (dream team) feront l'objet de plans séparés.

---

## Self-Review (auteur)

**1. Couverture de la spec (1b.1) :**
- §2 consentement (OFF par défaut, F8, notice, erreur→off) → Task 7 (`Recorder`) + Task 8 (`CaptureMod`/`RecHud`). ✅
- §2 upload manuel (pas de réseau dans le mod) → Task 8 (aucun appel réseau ; fichier local) + Task 4 (upload). ✅
- §2 admin-only → Task 4 (`_require_admin` sur tous les endpoints) + test 403. ✅
- §2 attribution par header → Task 1 (`save_capture` lit `header["player"]`) + test. ✅
- §5 schéma de capture (header + tick + chat) → Task 7 (`SessionWriter`) + Task 8 (sampleTick/chat). ✅
- §5 chat complet (in+out, contenu) → Task 8 (`ClientReceive`/`ClientSend` + `text`). ✅
- §6 stockage `data/mc-captures/<joueur>/` + gz + delete → Task 1. ✅
- §7 `style.json` (forme canonique, derivedParams 1:1 humanize) → Task 3 + tests de forme. ✅
- §7 `clips/` segmentés par contexte → Task 3 (`segment_clips`) + Task 4 (écriture clips/). ✅
- §10 UI panneau Captures + i18n + échappement → Task 6. ✅
- §11 tests Java pur + Python → Tasks 1,3,4,7. ✅
- §12 mod build-time only / Omen sans dép runtime → Task 9 (piège #35) + README Task 8. ✅
- Hors 1b.1 (calibration/clone/composite) → explicitement renvoyés aux plans 1b.2/1b.3/1b.4. ✅

**2. Placeholders :** aucun « TODO »/« à compléter » ; code complet à chaque step. Les coefficients de distillation sont des valeurs concrètes (défauts explicites), la spec n'exigeant que la forme. ✅

**3. Cohérence des types/signatures :**
- `store.save_capture(payload, filename) → {player,file,bytes,...}` — défini Task 1, consommé Task 4 (router upload). ✅
- `store.parse_header`, `store.list_captures`, `store.delete_capture`, `store.CAPTURES_DIR`, `store._safe_player` — définis Task 1, consommés Task 4. ✅
- `distill.load_records → (header, records)`, `distill.distill_style(payloads, player)`, `distill.segment_clips(records, player)` — définis Task 3, consommés Task 4. ✅
- `derivedParams.{chat:{latencyMeanMs,latencyStdMs,typoRate},errorRate,movementJitter}` — produit Task 3, affiché Task 6, **forme identique** aux `params` de `mc-agent/humanize.js` (pour merge 1b.2). ✅
- Java : `Recorder(Supplier<OutputStream>)`, `start(player,mc,mod,startedAt,sampleHz)`, `isRecording()`, `recordTick(TickRecord)`, `recordChat(t,dir,from,text,len)` — définis Task 7, appelés Task 8. `SessionWriter(OutputStream)` + `writeHeader/writeTick/writeChat` — définis Task 7, utilisés par `Recorder`. ✅
- Routes : prefix `/api/mc-agent` partagé avec `mc_agent_router` mais **chemins distincts** (`/captures*`) → pas de collision (vérifié Task 5 `import OK`). ✅
- Frontend : `loadCaptures`/`uploadCapture`/`distillCapture`/`deleteCapture`/`_escapeHtml` — définis Task 6, câblés dans le HTML de Task 6 + appel `loadCaptures()` à l'ouverture. ✅

**4. Pièges projet appliqués :** #5 (FormData sans Content-Type), #9/#11/#35-bis (cache-bust JS individuels), #28 (parse JS avant fin), #1 (Python 3.9 : pas de `str|None` — `Optional` non requis ici, code stdlib compatible). ✅
