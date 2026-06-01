# MC Agent — Accès REC-testeur (rôle + dépôt rec + download mod + tuto) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ouvrir l'espace de capture (jalon 1b.1) à un nouveau rôle **REC-testeur** (`rectester`) : ces comptes (et les admins seulement) peuvent **télécharger le mod** (2 versions), suivre un **tuto d'installation** (mod + Fabric Loader), et **déposer / consulter LEURS propres captures**. Tout le reste du bot (lancer/arrêter l'agent, clé Claude, profils, distillation, captures des autres) reste **admin strict**.

**Architecture :** On étend le RBAC existant (`backend/auth/permissions.py`) avec le rôle `rectester` et une permission `mc_capture`. Le stockage des captures gagne une **notion d'ownership par compte OmenServer** (sidecar `.owner` à côté de chaque `session-*.jsonl`) — distincte du pseudo MC (qui reste la clé de regroupement pour les profils). Le router capture passe d'`_require_admin` global à un gating fin : upload/list/delete = permission `mc_capture` avec filtrage par owner pour les non-admins ; distill/style = admin strict. Un nouvel endpoint sert les jars buildés (committés dans `mc-capture-mod/dist/`). Le frontend affiche une **carte MC Agent réduite** pour les rectester (download mod + tuto + mes captures) et la carte complète pour les admins.

**Tech Stack :** Python 3.9 (FastAPI, pytest, stdlib), Vanilla JS, jars Fabric déjà buildés. Aucune nouvelle dépendance.

**Référence :** plan 1b.1 `docs/superpowers/plans/2026-05-30-mc-agent-phase1b1-capture-pipeline.md` (a créé `mc_capture_store`/`mc_capture_router`/panneau Captures) ; RBAC `backend/auth/permissions.py`.

**⚠️ Garde-fous projet (NON négociables) :**
- **Moindre privilège** : un `rectester` ne peut JAMAIS lancer le bot, lire/écrire la clé Claude, lister les profils, distiller, ni voir/supprimer les captures d'autrui. Gate **backend** (pas seulement UI). Tests 403 dédiés.
- **Ownership = compte OmenServer** (`current_user.username`), écrit côté serveur à l'upload (jamais un champ client). Le pseudo MC (header) reste la clé de regroupement pour les profils.
- **Admin inchangé** : un admin garde l'accès total (voit tout, supprime tout, distille).
- **Python 3.9** : `Optional[str]`, pas de `str | None` (#1).
- Branche **`feat/mc-agent-phase1b-impl`** (worktree isolé). Jamais `main`. Commits par **pathspec explicite**. `git status` propre avant chaque commit.
- **Cache-bust** frontend (#9/#11), **parse JS** avant fin (#28), **échappement XSS** sur tout affichage.

---

## File Structure

**Backend :**

| Fichier | Responsabilité |
|---|---|
| `backend/auth/permissions.py` | + rôle `rectester` (VALID_ROLES, ROLE_PERMISSIONS, ROLE_NAMES) + permission `mc_capture` |
| `backend/bots/mc_capture_store.py` | + ownership : `save_capture(..., owner)` écrit sidecar `.owner` ; `list_captures(owner=None)` filtre ; `delete_capture(..., requester=None)` vérifie owner ; `session_owner(...)` |
| `backend/bots/mc_capture_router.py` | gating fin (`mc_capture` perm + filtrage owner) ; distill/style admin strict ; `GET /mod/{version}` (download jar) ; `GET /mod` (liste versions) |
| `backend/bots/tests/test_mc_capture_store.py` | + tests ownership (sidecar, filtre, delete gated) |
| `backend/bots/tests/test_mc_capture_router.py` | + tests rectester (upload OK, list filtré, delete sien OK / autrui 403, distill 403, download OK) |
| `backend/auth/tests/test_permissions.py` | + tests rôle rectester (a `mc_capture`, pas `settings`/`start`) |

**Mod (jars + tuto) :**

| Fichier | Responsabilité |
|---|---|
| `mc-capture-mod/dist/mc-capture-0.1.0-mc1.21.4.jar` | jar buildé committé (servi en prod) |
| `mc-capture-mod/dist/mc-capture-0.1.0-mc1.20.1.jar` | idem 1.20.1 |
| `mc-capture-mod/INSTALL.md` | tuto FR : Fabric Loader + Fabric API + jar + F8 + upload |

**Frontend :**

| Fichier | Responsabilité |
|---|---|
| `frontend/js/bots_module.js` | carte MC Agent réduite pour rectester (download mod + tuto + mes captures) ; carte complète admin ; `loadCaptures` adapté (vue filtrée) |
| `frontend/js/app.js` | rôle `rectester` dans les 3 sélecteurs (invite / create user / edit user) |
| `frontend/js/lang.js` | clés `mcagent.mod_*`, `mcagent.tuto_*`, `users.role_rectester`, `settings.invite_rectester` (FR/EN/IT) |
| `frontend/index.html` | bump `?v=` bots_module.js + app.js + lang.js |
| `frontend/sw.js` | bump `CACHE_NAME` |

---

## Task 0 : Baseline verte

- [ ] **Step 1 : Branche + tree propre**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl"
git branch --show-current
git status --porcelain | grep -vE "build/|\.gradle/" || echo "clean"
```
Expected : `feat/mc-agent-phase1b-impl`, pas de fichier étranger.

- [ ] **Step 2 : Python vert**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl" && source "/Users/massimiliano/omenserver Project/Projet serveur/venv/bin/activate" && python -m pytest backend/ -q 2>&1 | tail -3
```
Expected : tout vert (baseline).

---

## Task 1 : Rôle `rectester` + permission `mc_capture` (RBAC)

**Files :**
- Modify : `backend/auth/permissions.py`
- Test : `backend/auth/tests/test_permissions.py` (créer si absent)

- [ ] **Step 1 : Écrire le test qui échoue**

Créer/compléter `backend/auth/tests/test_permissions.py` :
```python
"""Tests RBAC du rôle REC-testeur (accès capture only)."""
from backend.auth import permissions as perms


class _U:
    def __init__(self, role, is_admin=False):
        self.role = role
        self.is_admin = is_admin


def test_rectester_is_a_valid_role():
    assert "rectester" in perms.VALID_ROLES
    assert perms.ROLE_NAMES.get("rectester")  # a un nom affichable


def test_rectester_has_mc_capture_permission():
    assert perms.has_permission(_U("rectester"), "mc_capture") is True
    assert perms.has_permission(_U("rectester"), "view") is True


def test_rectester_cannot_admin_things():
    u = _U("rectester")
    for forbidden in ("settings", "manage_users", "start", "create_bot", "yield_bot"):
        assert perms.has_permission(u, forbidden) is False, forbidden


def test_admin_keeps_mc_capture():
    assert perms.has_permission(_U("admin", is_admin=True), "mc_capture") is True


def test_other_roles_lack_mc_capture():
    for role in ("player", "money", "moderator", "developer", "spectator"):
        assert perms.has_permission(_U(role), "mc_capture") is False, role
```

- [ ] **Step 2 : Lancer → échec attendu**

Run : `cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl" && source "/Users/massimiliano/omenserver Project/Projet serveur/venv/bin/activate" && python -m pytest backend/auth/tests/test_permissions.py -q 2>&1 | tail -5`
Expected : FAIL (`rectester` absent).

- [ ] **Step 3 : Modifier `backend/auth/permissions.py`**

Dans `ROLE_PERMISSIONS`, ajouter une entrée `rectester` **après** `spectator` (rôle de faible privilège, accès capture uniquement) :
```python
    "rectester": [
        "view",              # Voir le bot MC Agent (vue réduite)
        "mc_capture",        # Déposer/consulter SES propres captures + télécharger le mod
    ],
```
Dans la liste des permissions de `"admin"`, ajouter (pour cohérence du lookup explicite — l'admin a déjà tout via `is_admin`, mais on l'ajoute pour la lisibilité) :
```python
        "mc_capture",        # Captures comportementales (admin = toutes)
```
Dans `ROLE_NAMES`, ajouter :
```python
    "rectester": "REC-testeur",
```
Dans `VALID_ROLES`, insérer `"rectester"` après `"spectator"` :
```python
VALID_ROLES = ["spectator", "rectester", "player", "money", "moderator", "developer", "admin"]
```

- [ ] **Step 4 : Lancer → succès attendu**

Run : `cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl" && source "/Users/massimiliano/omenserver Project/Projet serveur/venv/bin/activate" && python -m pytest backend/auth/tests/test_permissions.py -q 2>&1 | tail -5`
Expected : `5 passed`.

- [ ] **Step 5 : Commit**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl"
git add backend/auth/permissions.py backend/auth/tests/test_permissions.py
git commit -m "feat(rbac): rôle REC-testeur (rectester) + permission mc_capture (capture-only, TDD)"
```

---

## Task 2 : Ownership des captures (sidecar `.owner`)

**Files :**
- Modify : `backend/bots/mc_capture_store.py`
- Test : `backend/bots/tests/test_mc_capture_store.py`

> Le `player` (header) reste la clé de dossier (regroupement pour profils). On ajoute QUI a uploadé (compte OmenServer) via un sidecar `session-*.jsonl.owner` → permet « chacun voit les siennes ».

- [ ] **Step 1 : Écrire les tests qui échouent**

Ajouter à `backend/bots/tests/test_mc_capture_store.py` :
```python
def test_save_capture_records_owner(tmp_root):
    info = store.save_capture(_valid_jsonl("BobMC"), "s1.jsonl", owner="bob_account")
    assert info["owner"] == "bob_account"
    owner_file = tmp_root / "BobMC" / "s1.jsonl.owner"
    assert owner_file.is_file()
    assert owner_file.read_text(encoding="utf-8").strip() == "bob_account"


def test_list_captures_filters_by_owner(tmp_root):
    store.save_capture(_valid_jsonl("BobMC"), "s1.jsonl", owner="bob")
    store.save_capture(_valid_jsonl("AliceMC"), "s1.jsonl", owner="alice")
    bob_view = store.list_captures(owner="bob")
    players = {p["player"] for p in bob_view}
    assert players == {"BobMC"}  # bob ne voit pas AliceMC


def test_list_captures_admin_sees_all(tmp_root):
    store.save_capture(_valid_jsonl("BobMC"), "s1.jsonl", owner="bob")
    store.save_capture(_valid_jsonl("AliceMC"), "s1.jsonl", owner="alice")
    all_view = store.list_captures(owner=None)  # None = admin
    assert len(all_view) == 2


def test_owner_view_counts_only_own_sessions(tmp_root):
    # deux comptes déposent SOUS le même pseudo MC (cas réel : 2 PC, ou rejeu)
    store.save_capture(_valid_jsonl("TeamMC"), "s1.jsonl", owner="bob")
    store.save_capture(_valid_jsonl("TeamMC"), "s2.jsonl", owner="alice")
    bob = [p for p in store.list_captures(owner="bob") if p["player"] == "TeamMC"][0]
    assert bob["sessions"] == 1  # bob ne compte que la sienne


def test_delete_capture_owner_can_delete_own(tmp_root):
    store.save_capture(_valid_jsonl("BobMC"), "s1.jsonl", owner="bob")
    assert store.delete_capture("BobMC", "s1.jsonl", requester="bob") is True
    assert not (tmp_root / "BobMC" / "s1.jsonl").exists()
    assert not (tmp_root / "BobMC" / "s1.jsonl.owner").exists()


def test_delete_capture_non_owner_refused(tmp_root):
    store.save_capture(_valid_jsonl("BobMC"), "s1.jsonl", owner="bob")
    assert store.delete_capture("BobMC", "s1.jsonl", requester="mallory") is False
    assert (tmp_root / "BobMC" / "s1.jsonl").exists()  # toujours là


def test_delete_capture_admin_bypasses_owner(tmp_root):
    store.save_capture(_valid_jsonl("BobMC"), "s1.jsonl", owner="bob")
    assert store.delete_capture("BobMC", "s1.jsonl", requester=None) is True  # None = admin
```

- [ ] **Step 2 : Lancer → échec attendu**

Run : `... python -m pytest backend/bots/tests/test_mc_capture_store.py -q 2>&1 | tail -6`
Expected : FAIL (`save_capture()` n'accepte pas `owner`).

- [ ] **Step 3 : Modifier `backend/bots/mc_capture_store.py`**

Modifier `save_capture` pour accepter `owner` et écrire le sidecar :
```python
def save_capture(payload, filename, owner=None):
    """Valide le header, range le fichier sous data/mc-captures/<player>/. owner = compte OmenServer uploadeur."""
    header = parse_header(payload)
    player = _safe_player(header["player"])
    safe_file = _SAFE_NAME.sub("_", str(filename or "session.jsonl"))
    if not safe_file.endswith((".jsonl", ".jsonl.gz")):
        safe_file += ".jsonl"
    target_dir = CAPTURES_DIR / player
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / safe_file
    target.write_bytes(payload)
    if owner:
        (target_dir / (safe_file + ".owner")).write_text(str(owner), encoding="utf-8")
    return {"player": player, "file": safe_file, "bytes": len(payload),
            "owner": owner, "mc": header.get("mc"), "startedAt": header.get("startedAt")}
```

Ajouter un helper de lecture d'owner :
```python
def _session_owner(player_dir, session_file):
    """Lit le compte uploadeur d'une session (sidecar .owner), ou None si absent."""
    owner_path = player_dir / (session_file + ".owner")
    try:
        return owner_path.read_text(encoding="utf-8").strip() if owner_path.is_file() else None
    except OSError:
        return None
```

Réécrire `list_captures` pour filtrer par owner (None = admin = tout) et ne compter que les `.jsonl` (jamais les `.owner`) :
```python
def list_captures(owner=None):
    """Captures groupées par joueur. owner=None → tout (admin) ; sinon → sessions de ce compte uniquement."""
    if not CAPTURES_DIR.is_dir():
        return []
    out = []
    for player_dir in sorted(CAPTURES_DIR.iterdir()):
        if not player_dir.is_dir():
            continue
        files = [f for f in player_dir.iterdir() if f.suffix in (".jsonl", ".gz")]
        if owner is not None:
            files = [f for f in files if _session_owner(player_dir, f.name) == owner]
        if not files:
            continue
        out.append({
            "player": player_dir.name,
            "sessions": len(files),
            "bytes": sum(f.stat().st_size for f in files),
            "files": sorted(f.name for f in files),
        })
    return out
```

Réécrire `delete_capture` pour vérifier le requester (None = admin = bypass) :
```python
def delete_capture(player, filename, requester=None):
    """Supprime une session (ou tout un joueur si filename=None).
    requester=None → admin (aucune vérif d'owner). Sinon → seulement si requester est l'owner. False si refusé/absent."""
    safe = _safe_player(player)
    player_dir = CAPTURES_DIR / safe
    if not player_dir.is_dir():
        return False
    if filename is None:
        # suppression de tout un joueur : admin uniquement
        if requester is not None:
            return False
        shutil.rmtree(player_dir)
        return True
    target = player_dir / _SAFE_NAME.sub("_", str(filename))
    if not target.is_file():
        return False
    if requester is not None and _session_owner(player_dir, target.name) != requester:
        return False  # pas l'owner → refus
    target.unlink()
    # nettoie le sidecar .owner associé
    owner_sidecar = player_dir / (target.name + ".owner")
    if owner_sidecar.is_file():
        owner_sidecar.unlink()
    return True
```

> ⚠️ Vérifier que les tests 1b.1 existants restent verts : `delete_capture("Bob", None)` (sans `requester`) garde son comportement admin (le défaut `requester=None`). `list_captures()` sans arg = admin = tout. Rétro-compatible.

- [ ] **Step 4 : Lancer → succès attendu**

Run : `... python -m pytest backend/bots/tests/test_mc_capture_store.py -q 2>&1 | tail -6`
Expected : tout vert (anciens 1b.1 + 7 nouveaux).

- [ ] **Step 5 : Commit**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl"
git add backend/bots/mc_capture_store.py backend/bots/tests/test_mc_capture_store.py
git commit -m "feat(mc-capture): ownership par compte (sidecar .owner) — list filtré + delete gated (TDD)"
```

---

## Task 3 : Jars committés + tuto INSTALL.md

**Files :**
- Create : `mc-capture-mod/dist/mc-capture-0.1.0-mc1.21.4.jar`, `mc-capture-mod/dist/mc-capture-0.1.0-mc1.20.1.jar`
- Create : `mc-capture-mod/INSTALL.md`
- Modify : `mc-capture-mod/.gitignore` (NE PAS ignorer `dist/`)

- [ ] **Step 1 : Copier les jars buildés dans `dist/` (versionnés)**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl/mc-capture-mod"
mkdir -p dist
cp ~/Downloads/mc-capture-0.1.0-mc1.21.4.jar dist/
cp ~/Downloads/mc-capture-0.1.0-mc1.20.1.jar dist/
ls -la dist/
```
Expected : 2 jars (~11 Ko chacun). *(Si absents de ~/Downloads, rebuild via `/tmp/build-both.sh`.)*

- [ ] **Step 2 : S'assurer que `dist/` n'est PAS gitignoré**

`mc-capture-mod/.gitignore` doit contenir `build/` et `.gradle/` mais **pas** `dist/`. Vérifier :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl"
git check-ignore mc-capture-mod/dist/mc-capture-0.1.0-mc1.21.4.jar && echo "IGNORÉ (à corriger)" || echo "OK trackable"
```
Expected : `OK trackable`. Si ignoré, retirer la règle correspondante du `.gitignore`.

- [ ] **Step 3 : Écrire le tuto `mc-capture-mod/INSTALL.md`**

```markdown
# Installer OmenCapture — guide REC-testeur

OmenCapture enregistre TES déplacements, clics et messages en jeu, pour entraîner l'équipe
de modération d'OmenServer à reconnaître les bots. **Tu contrôles tout** : rien n'est enregistré
sans que tu appuies sur la touche, et rien n'est envoyé sans que tu uploades le fichier toi-même.

## 1. Quelle version ?

Regarde la version de ton Minecraft (écran d'accueil, en bas à gauche) :
- **1.21.x** → prends `mc-capture-0.1.0-mc1.21.4.jar`
- **1.20.x** → prends `mc-capture-0.1.0-mc1.20.1.jar`

Les deux se téléchargent depuis le dashboard (Bots → MC Agent → Télécharger le mod).

## 2. Installer Fabric Loader (une seule fois)

1. Va sur **https://fabricmc.net/use/installer/** et télécharge l'installeur.
2. Lance-le. Onglet **« Client »** :
   - **Game Version** : choisis ta version (1.21.x ou 1.20.x).
   - Laisse **Loader Version** par défaut.
   - Coche **« Create profile »**.
3. Clique **Install**.
4. Au lancement du launcher Minecraft, choisis le profil **« fabric-loader-… »** en bas à gauche.

## 3. Installer Fabric API + OmenCapture

1. Ouvre le dossier `mods` de Minecraft :
   - **Windows** : touche Windows + R → tape `%appdata%\.minecraft\mods` → Entrée (crée le dossier `mods` s'il n'existe pas).
   - **macOS** : Finder → Aller → Aller au dossier… → `~/Library/Application Support/minecraft/mods`.
2. Télécharge **Fabric API** pour ta version sur https://modrinth.com/mod/fabric-api → mets le `.jar` dans `mods`.
3. Mets aussi **`mc-capture-….jar`** (téléchargé au point 1) dans `mods`.

## 4. Enregistrer

1. Lance Minecraft avec le profil Fabric, rejoins le serveur.
2. En haut à gauche tu vois **`REC-off`** (gris) → rien n'est enregistré.
3. Appuie sur **F8** → un message de consentement s'affiche, puis **`● REC`** (rouge) → ça enregistre.
4. Joue normalement.
5. Appuie sur **F8** pour arrêter (`REC-off` revient).
6. Ton fichier est dans le dossier `mc-capture` de Minecraft (à côté de `mods`), nommé `session-….jsonl`.

## 5. Déposer ta capture

Dashboard → **Bots → MC Agent → Mes captures → Importer** → choisis ton `session-….jsonl`.
C'est tout. Tu peux en déposer autant que tu veux. L'admin te dira quand il les récupère.

> Changer la touche F8 : Échap → Options → Commandes → cherche « OmenCapture ».
```

- [ ] **Step 4 : Commit**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl"
git add mc-capture-mod/dist/mc-capture-0.1.0-mc1.21.4.jar mc-capture-mod/dist/mc-capture-0.1.0-mc1.20.1.jar mc-capture-mod/INSTALL.md mc-capture-mod/.gitignore
git commit -m "feat(mc-capture-mod): jars 1.21.4+1.20.1 dans dist/ + tuto INSTALL.md (REC-testeur)"
```

---

## Task 4 : Router — gating fin + download mod

**Files :**
- Modify : `backend/bots/mc_capture_router.py`
- Test : `backend/bots/tests/test_mc_capture_router.py`

- [ ] **Step 1 : Écrire les tests qui échouent**

Ajouter à `backend/bots/tests/test_mc_capture_router.py` (le fichier a déjà un helper `_app(admin=…)` ; ajouter un helper rectester) :
```python
def _app_role(role, is_admin=False):
    from fastapi import FastAPI
    app = FastAPI()
    app.include_router(cap.router)
    class _U:
        def __init__(self): self.role = role; self.is_admin = is_admin; self.username = "tester1"
    app.dependency_overrides[get_current_user] = lambda: _U()
    return app


def test_rectester_can_upload(tmp_root):
    from fastapi.testclient import TestClient
    client = TestClient(_app_role("rectester"))
    files = {"file": ("s.jsonl", io.BytesIO(_jsonl("BobMC")), "application/octet-stream")}
    r = client.post("/api/mc-agent/captures", files=files)
    assert r.status_code == 200
    assert r.json()["owner"] == "tester1"


def test_rectester_list_is_filtered_to_own(tmp_root):
    from fastapi.testclient import TestClient
    # tester1 dépose ; un autre compte dépose
    c1 = TestClient(_app_role("rectester"))  # username tester1
    c1.post("/api/mc-agent/captures", files={"file": ("s.jsonl", io.BytesIO(_jsonl("BobMC")), "application/octet-stream")})
    # admin dépose pour AliceMC
    ca = TestClient(_app(admin=True))
    ca.post("/api/mc-agent/captures", files={"file": ("s.jsonl", io.BytesIO(_jsonl("AliceMC")), "application/octet-stream")})
    r = c1.get("/api/mc-agent/captures")
    players = {p["player"] for p in r.json()["captures"]}
    assert players == {"BobMC"}  # tester1 ne voit pas AliceMC


def test_rectester_cannot_distill(tmp_root):
    from fastapi.testclient import TestClient
    client = TestClient(_app_role("rectester"))
    client.post("/api/mc-agent/captures", files={"file": ("s.jsonl", io.BytesIO(_jsonl("BobMC")), "application/octet-stream")})
    assert client.post("/api/mc-agent/captures/BobMC/distill").status_code == 403


def test_rectester_cannot_get_style(tmp_root):
    from fastapi.testclient import TestClient
    assert TestClient(_app_role("rectester")).get("/api/mc-agent/captures/BobMC/style").status_code == 403


def test_player_role_cannot_upload(tmp_root):
    from fastapi.testclient import TestClient
    client = TestClient(_app_role("player"))
    files = {"file": ("s.jsonl", io.BytesIO(_jsonl("BobMC")), "application/octet-stream")}
    assert client.post("/api/mc-agent/captures", files=files).status_code == 403


def test_rectester_delete_own_ok_other_403(tmp_root):
    from fastapi.testclient import TestClient
    c1 = TestClient(_app_role("rectester"))  # tester1
    c1.post("/api/mc-agent/captures", files={"file": ("s.jsonl", io.BytesIO(_jsonl("BobMC")), "application/octet-stream")})
    # admin dépose AliceMC (owner = admin username "tester" du _app helper)
    TestClient(_app(admin=True)).post("/api/mc-agent/captures",
        files={"file": ("s.jsonl", io.BytesIO(_jsonl("AliceMC")), "application/octet-stream")})
    assert c1.delete("/api/mc-agent/captures/BobMC/s.jsonl").status_code == 200      # sa session
    assert c1.delete("/api/mc-agent/captures/AliceMC/s.jsonl").status_code == 403    # pas la sienne


def test_download_mod_versions(tmp_root):
    from fastapi.testclient import TestClient
    client = TestClient(_app_role("rectester"))
    lst = client.get("/api/mc-agent/mod")
    assert lst.status_code == 200
    assert any("1.21" in v["version"] for v in lst.json()["versions"])
    dl = client.get("/api/mc-agent/mod/1.21.4")
    assert dl.status_code == 200
    assert dl.headers["content-type"] in ("application/java-archive", "application/octet-stream")


def test_download_mod_rejects_bad_version(tmp_root):
    from fastapi.testclient import TestClient
    assert TestClient(_app_role("rectester")).get("/api/mc-agent/mod/9.9.9").status_code == 404


def test_download_mod_path_traversal_blocked(tmp_root):
    from fastapi.testclient import TestClient
    r = TestClient(_app_role("rectester")).get("/api/mc-agent/mod/..%2F..%2Fetc%2Fpasswd")
    assert r.status_code in (404, 400)
```

- [ ] **Step 2 : Lancer → échec attendu**

Run : `... python -m pytest backend/bots/tests/test_mc_capture_router.py -q 2>&1 | tail -8`
Expected : FAIL (rectester rejeté en upload car endpoints encore `_require_admin` ; `/mod` absent).

- [ ] **Step 3 : Modifier `backend/bots/mc_capture_router.py`**

Remplacer les imports + ajouter le gating fin. En tête :
```python
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse

from backend.auth.utils import get_current_user
from backend.auth.models import User
from backend.auth.permissions import has_permission
from backend.bots import mc_capture_store as store
from backend.bots import mc_capture_distill as distill

router = APIRouter(prefix="/api/mc-agent", tags=["mc-agent-capture"])

_MAX_BYTES = 200 * 1024 * 1024

# Racine des jars committés (servis en prod via auto-deploy ; pas de build sur l'Omen).
_MOD_DIST = Path(__file__).resolve().parents[2] / "mc-capture-mod" / "dist"
# Versions exposées → nom de fichier jar (whitelist stricte, anti path-traversal).
_MOD_JARS = {
    "1.21.4": "mc-capture-0.1.0-mc1.21.4.jar",
    "1.20.1": "mc-capture-0.1.0-mc1.20.1.jar",
}


def _require_admin(user):
    if not getattr(user, "is_admin", False):
        raise HTTPException(status_code=403, detail="Admin uniquement")


def _require_capture(user):
    """Admin OU REC-testeur (permission mc_capture)."""
    if not has_permission(user, "mc_capture"):
        raise HTTPException(status_code=403, detail="Accès capture refusé")


def _owner_filter(user):
    """None si admin (voit tout) ; sinon le username (ne voit que les siennes)."""
    return None if getattr(user, "is_admin", False) else getattr(user, "username", None)
```

`upload` → permission `mc_capture`, owner = compte courant :
```python
@router.post("/captures")
async def upload_capture(file: UploadFile = File(...), current_user: User = Depends(get_current_user)):
    """Upload manuel d'une capture .jsonl(.gz). Admin ou REC-testeur. owner = compte uploadeur."""
    _require_capture(current_user)
    payload = await file.read()
    if len(payload) > _MAX_BYTES:
        raise HTTPException(status_code=413, detail="Fichier trop volumineux")
    try:
        info = store.save_capture(payload, file.filename, owner=getattr(current_user, "username", None))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Capture invalide : {exc}")
    return info
```

`list` → filtré par owner :
```python
@router.get("/captures")
def list_captures(current_user: User = Depends(get_current_user)):
    _require_capture(current_user)
    return {"captures": store.list_captures(owner=_owner_filter(current_user))}
```

`distill` et `style` → **admin strict** (inchangés, gardent `_require_admin`).

`delete` → permission capture + requester :
```python
@router.delete("/captures/{player}/{filename}")
def delete_session(player: str, filename: str, current_user: User = Depends(get_current_user)):
    _require_capture(current_user)
    if not store.delete_capture(player, filename, requester=_owner_filter(current_user)):
        raise HTTPException(status_code=403, detail="Suppression refusée (pas ta capture)")
    return {"ok": True}


@router.delete("/captures/{player}")
def delete_player(player: str, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)  # supprimer TOUT un joueur = admin only
    if not store.delete_capture(player, None):
        raise HTTPException(status_code=404, detail="Joueur inconnu")
    return {"ok": True}
```

Download mod (admin ou rectester) :
```python
@router.get("/mod")
def list_mod_versions(current_user: User = Depends(get_current_user)):
    """Versions du mod téléchargeables (selon les jars présents dans dist/)."""
    _require_capture(current_user)
    versions = [{"version": v, "file": f} for v, f in _MOD_JARS.items()
                if (_MOD_DIST / f).is_file()]
    return {"versions": versions}


@router.get("/mod/{version}")
def download_mod(version: str, current_user: User = Depends(get_current_user)):
    """Télécharge le jar du mod pour une version MC (whitelist stricte)."""
    _require_capture(current_user)
    jar = _MOD_JARS.get(version)            # lookup whitelist → path-traversal impossible
    if not jar:
        raise HTTPException(status_code=404, detail="Version inconnue")
    path = _MOD_DIST / jar
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Jar indisponible (non déployé)")
    return FileResponse(str(path), media_type="application/java-archive", filename=jar)
```

> Note : l'ancien `delete_player` (1b.1) devient `delete_session` (par fichier) + `delete_player` (tout, admin). Le frontend 1b.1 appelait `DELETE /captures/{player}` → mis à jour en Task 5.

- [ ] **Step 4 : Lancer → succès attendu + suite complète**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl" && source "/Users/massimiliano/omenserver Project/Projet serveur/venv/bin/activate"
python -m pytest backend/bots/tests/test_mc_capture_router.py -q 2>&1 | tail -6
python -c "import backend.main; print('import OK')"
```
Expected : tout vert + `import OK`.

- [ ] **Step 5 : Commit**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl"
git add backend/bots/mc_capture_router.py backend/bots/tests/test_mc_capture_router.py
git commit -m "feat(mc-capture): router — gating mc_capture + owner-filter + download mod (TDD)"
```

---

## Task 5 : Frontend — carte réduite rectester + download + tuto + rôle

**Files :**
- Modify : `frontend/js/bots_module.js`, `frontend/js/app.js`, `frontend/js/lang.js`, `frontend/index.html`, `frontend/sw.js`

- [ ] **Step 1 : i18n (3 langues)**

Dans chaque bloc `mcagent:` de `lang.js`, ajouter (traduire) :
```js
      mod_download: 'Télécharger le mod',
      mod_pick: 'Choisis la version de ton Minecraft :',
      tuto_title: 'Comment installer (clique pour déplier)',
      my_captures: 'Mes captures',
```
Dans `users:` ajouter `role_rectester: 'REC-testeur',` (FR) / `'REC-tester'` (EN) / `'REC-tester'` (IT).
Dans `settings:` ajouter `invite_rectester: 'REC-testeur',` (3 langues).

- [ ] **Step 2 : Carte MC Agent — vue selon le rôle**

Dans `frontend/js/bots_module.js`, remplacer le gate `const canSeeMCAgent = u && u.is_admin;` par :
```js
    const isRecTester = u && u.role === 'rectester';
    const canSeeMCAgent = u && (u.is_admin || isRecTester);
```
Et dans `openMCAgent`, encadrer les contrôles réservés admin (clé Claude, host/port/profil/start/stop/transcript, distill) par `if (!isRecTester) { ... }` côté rendu, en gardant TOUJOURS visible : le bloc download mod + tuto + panneau « Mes captures » (upload + liste + delete, **sans** bouton Analyser pour les rectester).
> Concrètement : définir `const isRecTester = (App.currentUser && App.currentUser.role === 'rectester');` en tête de `openMCAgent`, et n'inclure les sections admin dans le template que si `!isRecTester`. Le bouton « Analyser » de `loadCaptures` n'est rendu que si `!isRecTester`.

- [ ] **Step 3 : Bloc download mod + tuto (visible pour tous ceux qui voient la carte)**

Ajouter dans le template d' `openMCAgent`, en haut du panneau :
```js
        <div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:10px;">
          <div style="font-weight:600;margin-bottom:6px;">${Lang.t('mcagent.mod_download')}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">${Lang.t('mcagent.mod_pick')}</div>
          <div id="mca-mod-versions" style="display:flex;gap:8px;flex-wrap:wrap;"></div>
          <details style="margin-top:10px;">
            <summary style="cursor:pointer;font-size:13px;">${Lang.t('mcagent.tuto_title')}</summary>
            <ol style="font-size:12px;color:var(--text-muted);line-height:1.7;margin:8px 0 0;padding-left:18px;">
              <li>Fabric Loader : <a href="https://fabricmc.net/use/installer/" target="_blank" rel="noopener">fabricmc.net/use/installer</a> → onglet Client → ta version → Install.</li>
              <li>Fabric API : <a href="https://modrinth.com/mod/fabric-api" target="_blank" rel="noopener">modrinth.com/mod/fabric-api</a> → le .jar dans le dossier <code>mods</code>.</li>
              <li>Mets le jar OmenCapture (ci-dessus) dans <code>mods</code> aussi.</li>
              <li>En jeu : <b>F8</b> démarre/arrête l'enregistrement (HUD <b>● REC</b>).</li>
              <li>Reviens ici → <b>${Lang.t('mcagent.my_captures')}</b> → Importer ton fichier <code>session-….jsonl</code>.</li>
            </ol>
          </details>
        </div>
```

- [ ] **Step 4 : Charger les versions du mod (boutons download)**

Ajouter une méthode et l'appeler dans `openMCAgent` (après le rendu) :
```js
  async loadModVersions() {
    const box = document.getElementById('mca-mod-versions');
    if (!box) return;
    try {
      const r = await Auth.apiCall('/api/mc-agent/mod');
      const data = await r.json();
      box.innerHTML = (data.versions || []).map((v) =>
        `<button class="btn btn-secondary btn-sm" onclick="BotsModule.downloadMod('${this._escapeHtml(v.version)}')">MC ${this._escapeHtml(v.version)}</button>`
      ).join('') || `<span style="font-size:12px;color:var(--text-dim);">—</span>`;
    } catch (e) { /* silencieux */ }
  },

  async downloadMod(version) {
    const r = await Auth.apiCall('/api/mc-agent/mod/' + encodeURIComponent(version));
    if (!r.ok) { Toast.show('Téléchargement impossible', 'error'); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `mc-capture-${version}.jar`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  },
```

- [ ] **Step 5 : Adapter `deleteCapture` (nouvelle route par session)**

Le 1b.1 supprimait par joueur (`DELETE /captures/{player}`). Pour un rectester, on supprime **une session**. Mettre à jour le bouton supprimer dans `loadCaptures` pour cibler une session précise via `DELETE /captures/{player}/{file}` (itérer sur `c.files`), et garder le delete-joueur global réservé à l'admin (bouton visible seulement si `!isRecTester`).
> Rendu minimal côté rectester : pour chaque capture, lister ses fichiers avec un bouton supprimer par fichier appelant :
```js
  async deleteSession(player, file) {
    const r = await Auth.apiCall(`/api/mc-agent/captures/${encodeURIComponent(player)}/${encodeURIComponent(file)}`, { method: 'DELETE' });
    if (r.ok) this.loadCaptures(); else Toast.show('Suppression refusée', 'error');
  },
```

- [ ] **Step 6 : Rôle `rectester` dans les sélecteurs (`app.js`)**

Dans `frontend/js/app.js`, ajouter l'option `rectester` dans les 3 `<select>` de rôle :
- invite (`#invite-role`) : après `spectator`
- create user (`#new-user-role`) : après `spectator`
- edit user (ligne ~1195, la liste `+ '<option value="..."'`) : ajouter
```js
 + '<option value="rectester"' + (u.role === 'rectester' ? ' selected' : '') + '>' + Lang.t('users.role_rectester') + '</option>'
```

- [ ] **Step 7 : Parse JS + cache-bust**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl"
node -e "['frontend/js/bots_module.js','frontend/js/app.js','frontend/js/lang.js'].forEach(f=>new Function(require('fs').readFileSync(f,'utf8')));console.log('JS parse OK')"
```
Expected : `JS parse OK`. Puis bumper `?v=` de bots_module.js + app.js + lang.js dans `index.html` + `CACHE_NAME` dans `sw.js`.

- [ ] **Step 8 : Commit**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl"
git add frontend/js/bots_module.js frontend/js/app.js frontend/js/lang.js frontend/index.html frontend/sw.js
git commit -m "feat(mc-capture): UI REC-testeur (carte réduite + download mod + tuto + rôle sélecteurs)"
```

---

## Task 6 : Doc + vérification finale

**Files :**
- Modify : `CLAUDE.md`

- [ ] **Step 1 : Historique + piège CLAUDE.md**

Ajouter le piège #37 dans `## ⚠️ Pièges connus` :
```markdown
37. **Rôle REC-testeur (`rectester`) = capture-only** : nouveau rôle RBAC (entre spectator et player dans `VALID_ROLES`). Permission `mc_capture` → accès UNIQUEMENT à : download mod (2 jars), tuto, déposer/voir/supprimer SES captures. **Ownership = compte OmenServer** (`current_user.username`) écrit en sidecar `data/mc-captures/<pseudoMC>/session-*.jsonl.owner` à l'upload — distinct du pseudo MC (clé de regroupement profils). `list_captures(owner=…)`/`delete_capture(requester=…)` : `None`=admin (voit/supprime tout), sinon filtré. distill/style/lancer-bot/clé/profils restent **admin strict** (gate backend, pas juste UI). Jars servis depuis `mc-capture-mod/dist/` (committés → auto-deploy, pas de build sur l'Omen) via `GET /api/mc-agent/mod/{version}` (whitelist `_MOD_JARS` → path-traversal impossible).
```
Et la ligne d'historique en tête du tableau :
```markdown
| 2026-05-31 | 👥 **MC Agent — accès REC-testeur** : nouveau rôle RBAC `rectester` (permission `mc_capture`, capture-only) → download mod (jars 1.21.4+1.20.1 committés dans `dist/`, endpoint `/api/mc-agent/mod/{v}`), tuto install (Fabric Loader + API + F8, `INSTALL.md` + panneau dépliable UI), dépôt rec avec **ownership par compte** (sidecar `.owner`, chacun voit/supprime les siennes, admin voit tout). distill/bot/clé/profils restent admin strict. Carte MC Agent réduite pour rectester. Tests RBAC + store ownership + router gating. Piège #37. |
```

- [ ] **Step 2 : Vérification complète**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl" && source "/Users/massimiliano/omenserver Project/Projet serveur/venv/bin/activate"
python -m pytest backend/ -q 2>&1 | tail -3
python -c "import backend.main; print('import OK')"
node -e "['frontend/js/bots_module.js','frontend/js/app.js','frontend/js/lang.js'].forEach(f=>new Function(require('fs').readFileSync(f,'utf8')));console.log('JS OK')"
```
Expected : Python tout vert, `import OK`, `JS OK`.

- [ ] **Step 3 : Commit**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl"
git add CLAUDE.md
git commit -m "docs(mc-capture): rôle REC-testeur + ownership + download mod (piège #37 + historique)"
```

- [ ] **Step 4 : Smoke e2e manuel (Massii)**

1. Settings → créer un user rôle **REC-testeur** (ou inviter).
2. Se connecter avec ce compte → la carte **MC Agent** est visible mais **réduite** : download mod + tuto + Mes captures (pas de clé/host/start/profils).
3. Télécharger un jar → vérifier le fichier.
4. Uploader une capture → elle apparaît dans « Mes captures ». Un autre rectester ne la voit pas.
5. Reconnexion admin → voit TOUTES les captures + peut Analyser.

> « Terminé » : rectester voit la carte réduite (testé backend 403 sur distill/style/bot) · ownership respecté (chacun les siennes, testé) · download mod OK (whitelist, testé) · tuto présent · admin inchangé · tous tests verts.

---

## Self-Review (auteur)

**1. Couverture des 4 demandes :**
- Mod installable depuis le bot → Task 3 (jars dist/) + Task 4 (`/mod/{version}`) + Task 5 (boutons). ✅
- Tuto (mod + Fabric Loader) → Task 3 (`INSTALL.md`) + Task 5 (panneau dépliable). ✅
- Rôle REC-testeur (accès bot réservé admin+rectester) → Task 1 (RBAC) + Task 4 (gating) + Task 5 (carte). ✅
- Espace dépôt rec (chacun les siennes, admin récupère) → Task 2 (ownership) + Task 4 (filtre/delete gated) + Task 5 (Mes captures). ✅

**2. Placeholders :** aucun ; code complet.

**3. Cohérence signatures :**
- `has_permission(user, "mc_capture")` — défini Task 1, consommé Task 4. ✅
- `save_capture(payload, filename, owner=None)` / `list_captures(owner=None)` / `delete_capture(player, filename, requester=None)` — définis Task 2, consommés Task 4. Rétro-compat 1b.1 (défauts = admin). ✅
- `_MOD_JARS` whitelist (Task 4) ↔ fichiers `dist/` (Task 3). Mêmes noms. ✅
- Frontend `downloadMod`/`loadModVersions`/`deleteSession`/`isRecTester` — définis Task 5, câblés Task 5. ✅
- Route renommée : 1b.1 `DELETE /captures/{player}` → désormais `delete_session` (`/{player}/{filename}`) + `delete_player` admin. Frontend mis à jour Task 5 Step 5. ✅

**4. Sécurité :**
- Gate **backend** sur chaque endpoint (pas juste UI) — tests 403 pour player (Task 4) + distill/style rectester. ✅
- Ownership écrit **serveur** (`current_user.username`), jamais client. ✅
- Download : whitelist dict (pas de concat de chemin) → path-traversal testé bloqué. ✅
- `_safe_player` (1b.1) collapse déjà `..`. ✅

**5. Pièges projet :** #1 (Optional), #9/#11 (cache-bust), #28 (parse JS), #5 (FormData upload — `Auth.apiCall` gère). ✅
