# MC Agent — Groupes & navigation 2 niveaux — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Réorganiser l'UI MC Agent en navigation 2 niveaux (Créer groupe / Mes serveurs → vue groupe : Bots ouvriers / Carte / Modifier), avec des bots persistants par groupe (chacun son compte + secret mémorisé) et le lancement de 1+ cartographes depuis l'onglet Carte.

**Architecture:** Le « groupe » étend le profil serveur existant (`data/mc_agent_servers.json`) avec un roster `bots[]` + flags login ; les secrets (mdp AuthMe / token MS) vivent dans un fichier séparé chmod 600 hors API. Le frontend (`frontend/js/bots_module.js`) passe de 3 onglets plats à 2 niveaux. Le moteur bot (objectif `mapper`, secteurs, world-memory) est réutilisé tel quel.

**Tech Stack:** Python stdlib (backend), Vanilla JS/CSS (frontend, pas de framework), FastAPI, pytest, node:test, Chrome MCP (verify-ui).

**Spec:** `docs/superpowers/specs/2026-06-04-mc-agent-groups-2level-ui-design.md`

**Référence projet:** lire `CLAUDE.md` (pièges #38/#39/#40/#41, conventions i18n + cache-bust + admin-only).

---

## File Structure

| Fichier | Responsabilité | Action |
|---|---|---|
| `backend/bots/mc_agent_servers.py` | schéma groupe + roster bots + migration + CRUD bots | Modifier |
| `backend/bots/mc_agent_secrets.py` | stockage secrets par bot (chmod 600, hors API) | **Créer** |
| `backend/bots/mc_agent_router.py` | endpoints bot CRUD + `/run` avec `bot_id` + multi-cartographe | Modifier |
| `backend/bots/mc_agent_manager.py` | passe compte+secret+secteur au subprocess ; `/login` auto | Modifier |
| `backend/bots/tests/test_mc_agent_servers.py` | tests groupe/roster/migration | Modifier |
| `backend/bots/tests/test_mc_agent_secrets.py` | tests secrets hors API | **Créer** |
| `backend/bots/tests/test_mc_agent_router.py` | tests endpoints bots (admin-only, no-leak) | Modifier |
| `frontend/js/bots_module.js` | nav 2 niveaux + roster UI + lancer cartographes | Modifier |
| `frontend/js/lang.js` | clés i18n FR/EN/IT | Modifier |
| `frontend/index.html` + `frontend/sw.js` | cache-bust | Modifier |

---

## PHASE 1 — Backend : groupe = profil + roster de bots + migration

### Task 1: Schéma `bots[]` + flags login dans `_clean_server`

**Files:**
- Modify: `backend/bots/mc_agent_servers.py` (`_clean_server`)
- Test: `backend/bots/tests/test_mc_agent_servers.py`

- [ ] **Step 1: Test échec** — un profil nettoyé expose `bots` (liste), `has_login` (bool), `login_command` (str).

```python
def test_clean_server_has_roster_and_login_fields():
    from backend.bots import mc_agent_servers as S
    s = S._clean_server({"name": "X", "host": "h", "has_login": True,
                         "login_command": "/login {pwd}", "bots": "pasuneliste"}, "abc123")
    assert s["bots"] == []                      # défaut sûr (string → [])
    assert s["has_login"] is True
    assert s["login_command"] == "/login {pwd}"
```

- [ ] **Step 2: Run → FAIL** (`KeyError: 'bots'`). `cd backend && python -m pytest bots/tests/test_mc_agent_servers.py::test_clean_server_has_roster_and_login_fields -v`

- [ ] **Step 3: Implémenter** — ajouter dans le `return {...}` de `_clean_server` :

```python
        "has_login": bool(payload.get("has_login")),
        "login_command": str(payload.get("login_command") or "/login {pwd}")[:60],
        "bots": _clean_bots(payload.get("bots")),
```

et le helper (au-dessus de `_clean_server`) :

```python
VALID_ROLE = ("worker", "mapper")

def _clean_bots(raw):
    """Roster : liste de {id, role, username, auth}. Ignore les entrées invalides, cap 20."""
    out, seen = [], set()
    for b in raw or []:
        if not isinstance(b, dict):
            continue
        username = str(b.get("username") or "").strip()[:48]
        if not username:
            continue
        role = b.get("role") if b.get("role") in VALID_ROLE else "worker"
        auth = b.get("auth") if b.get("auth") in VALID_AUTH else "offline"
        bid = str(b.get("id") or "")
        if not _SAFE_ID.match(bid):
            bid = _gen_id(seen)
        if bid in seen:
            continue
        seen.add(bid)
        out.append({"id": bid, "role": role, "username": username, "auth": auth})
        if len(out) >= 20:
            break
    return out
```

- [ ] **Step 4: Run → PASS**.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(mc-agent): schéma groupe — roster bots[] + flags login"`

### Task 2: Migration idempotente ancien profil → `bots[0]`

**Files:** Modify `mc_agent_servers.py` (`load_servers`), Test same file.

- [ ] **Step 1: Test** — un profil legacy (`user` sans `bots`) gagne `bots[0]` (role worker, username=user) au load ; un 2e load ne duplique pas.

```python
def test_migration_legacy_profile_gets_first_bot(tmp_path, monkeypatch):
    from backend.bots import mc_agent_servers as S
    monkeypatch.setattr(S, "SERVERS_PATH", tmp_path / "srv.json")
    S._save_servers([{"id": "abc123", "name": "Old", "host": "h", "user": "OldBot", "auth": "offline"}])
    one = S.load_servers()[0]
    assert len(one["bots"]) == 1
    assert one["bots"][0]["username"] == "OldBot" and one["bots"][0]["role"] == "worker"
    bid = one["bots"][0]["id"]
    two = S.load_servers()[0]                    # idempotent
    assert len(two["bots"]) == 1 and two["bots"][0]["id"] == bid
```

- [ ] **Step 2: Run → FAIL**.
- [ ] **Step 3: Implémenter** — `load_servers` applique `_migrate` à chaque profil et **persiste si modifié** :

```python
def _migrate(server):
    """Ajoute bots[0] depuis `user` si roster absent/vide. Mute + retourne (changed:bool)."""
    if server.get("bots"):
        return server, False
    server["bots"] = [{"id": _gen_id(set()), "role": "worker",
                       "username": str(server.get("user") or "TrainBot")[:48],
                       "auth": server.get("auth") if server.get("auth") in VALID_AUTH else "offline"}]
    return server, True
```

Dans `load_servers`, après avoir chargé `data` : appliquer `_migrate` à chaque élément, et si au moins un `changed` → `_save_servers(data)`. (Garder le retour `data`.)

- [ ] **Step 4: Run → PASS**.
- [ ] **Step 5: Commit** — `"feat(mc-agent): migration profil→bots[0] idempotente"`

### Task 3: CRUD bots du roster

**Files:** Modify `mc_agent_servers.py`, Test same.

- [ ] **Step 1: Test** — `add_bot`/`remove_bot` mutent le roster persisté ; `add_bot` refuse un username déjà présent (insensible casse).

```python
def test_add_remove_bot(tmp_path, monkeypatch):
    from backend.bots import mc_agent_servers as S
    monkeypatch.setattr(S, "SERVERS_PATH", tmp_path / "srv.json")
    g = S.create_server({"name": "G", "host": "h"})
    b = S.add_bot(g["id"], role="mapper", username="Mapper1", auth="offline")
    assert b["role"] == "mapper" and b["username"] == "Mapper1"
    assert S.add_bot(g["id"], role="mapper", username="mapper1", auth="offline") is None  # dup casse
    assert S.remove_bot(g["id"], b["id"]) is True
    assert S.get_server(g["id"])["bots"] == []
```

- [ ] **Step 2: Run → FAIL**.
- [ ] **Step 3: Implémenter** `add_bot(sid, role, username, auth)` (valide via `_clean_bots` sur l'entrée unique, refuse dup username, append, save, retourne le bot ou `None`) et `remove_bot(sid, bot_id)` (filtre, save, bool). Réutiliser `get_server`/`_save_servers`/`_SAFE_ID`.

- [ ] **Step 4: Run → PASS**.
- [ ] **Step 5: Commit** — `"feat(mc-agent): CRUD bots du roster (add/remove, anti-dup username)"`

---

## PHASE 2 — Backend : secrets par bot (hors API, chmod 600)

### Task 4: Module `mc_agent_secrets`

**Files:** Create `backend/bots/mc_agent_secrets.py` + `backend/bots/tests/test_mc_agent_secrets.py`.

- [ ] **Step 1: Test** — `set_secret`/`get_secret` round-trip ; le fichier est chmod 600 ; `has_secret` reflète la présence ; clés invalides rejetées.

```python
def test_secret_roundtrip_and_perms(tmp_path, monkeypatch):
    from backend.bots import mc_agent_secrets as K
    monkeypatch.setattr(K, "SECRETS_DIR", tmp_path)
    K.set_secret("grp1", "bot1", "monMdp")
    assert K.get_secret("grp1", "bot1") == "monMdp"
    assert K.has_secret("grp1", "bot1") is True
    assert K.has_secret("grp1", "absent") is False
    mode = (K._path("grp1") .stat().st_mode & 0o777)
    assert mode == 0o600
    assert K.set_secret("bad id", "bot1", "x") is False   # _SAFE_ID
```

- [ ] **Step 2: Run → FAIL**.
- [ ] **Step 3: Implémenter** — fichier par groupe `SECRETS_DIR/<group_id>.json` = `{bot_id: secret}` ; `os.chmod(path, 0o600)` après écriture ; `_SAFE_ID` sur group/bot ; `SECRETS_DIR = _PROJECT_ROOT/"data"/"mc_agent_secrets"`. Fonctions : `set_secret`, `get_secret`, `has_secret`, `delete_group_secrets`. **Stdlib only.** (S'inspirer du pattern AuthMe `mc_agent_secret_<user>.json` existant — généralisé.)

- [ ] **Step 4: Run → PASS**.
- [ ] **Step 5: Commit** — `"feat(mc-agent): module secrets par bot (chmod 600, hors API)"`

---

## PHASE 3 — Backend : endpoints

### Task 5: Endpoints bot CRUD (admin-only) + secret hors réponse

**Files:** Modify `mc_agent_router.py`, Test `test_mc_agent_router.py`.

- [ ] **Step 1: Test** — `POST /servers/{id}/bots` crée un bot ; le `secret` passé en body est stocké mais **jamais** renvoyé (ni par ce POST ni par `GET /servers`) ; non-admin → 403 ; `DELETE /servers/{id}/bots/{bot_id}` supprime.

```python
def test_create_bot_stores_secret_but_never_leaks(admin_client, monkeypatch, tmp_path):
    # ... fixtures isolant SERVERS_PATH + SECRETS_DIR sur tmp_path
    g = admin_client.post("/api/mc-agent/servers", json={"name": "G", "host": "h"}).json()
    r = admin_client.post(f"/api/mc-agent/servers/{g['id']}/bots",
                          json={"role": "mapper", "username": "M1", "auth": "offline", "secret": "pw"})
    assert r.status_code == 200 and "secret" not in r.json() and "pw" not in r.text
    allsrv = admin_client.get("/api/mc-agent/servers").text
    assert "pw" not in allsrv                         # GET /servers ne fuit jamais
    assert r.json().get("has_secret") is True

def test_create_bot_requires_admin(user_client):
    assert user_client.post("/api/mc-agent/servers/x/bots", json={"username": "M"}).status_code == 403
```

- [ ] **Step 2: Run → FAIL**.
- [ ] **Step 3: Implémenter** dans `mc_agent_router.py` (réutiliser le garde admin existant `_require_admin` / dépendance courante) :

```python
@router.post("/servers/{sid}/bots")
def create_bot(sid: str, payload: dict = Body(...), current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    bot = mc_agent_servers.add_bot(sid, role=payload.get("role"),
                                   username=payload.get("username"), auth=payload.get("auth"))
    if bot is None:
        raise HTTPException(400, "bot invalide ou username déjà présent")
    secret = payload.get("secret")
    if isinstance(secret, str) and secret:
        mc_agent_secrets.set_secret(sid, bot["id"], secret)
    return {**bot, "has_secret": mc_agent_secrets.has_secret(sid, bot["id"])}

@router.delete("/servers/{sid}/bots/{bot_id}")
def delete_bot(sid: str, bot_id: str, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    return {"ok": mc_agent_servers.remove_bot(sid, bot_id)}
```

⚠️ Vérifier le pattern admin réel dans le fichier (`_require_admin` vs `Depends`) et le matcher. **`GET /servers` doit déjà exclure les secrets** (ils ne sont pas dans `mc_agent_servers.json`) — ajouter `has_secret` par bot dans la sérialisation de `GET /servers` si l'UI en a besoin.

- [ ] **Step 4: Run → PASS**.
- [ ] **Step 5: Commit** — `"feat(mc-agent): endpoints bot CRUD admin-only + secret jamais renvoyé"`

### Task 6: `/run` avec `bot_id` + lancement multi-cartographe

**Files:** Modify `mc_agent_router.py` + `mc_agent_manager.py`, Test both.

- [ ] **Step 1: Test (manager)** — `start_session` reçoit `bot_id` → résout username+secret+role du roster ; un helper `start_mappers(group_id, n)` démarre n sessions `objective=mapper` avec secteurs `0..n-1`, en n'utilisant que des bots `role=mapper` distincts (cap au nb dispo).

```python
def test_start_mappers_assigns_sectors(monkeypatch):
    from backend.bots import mc_agent_manager as M
    # roster avec 3 mappers ; stub _spawn pour capturer les args
    calls = []
    monkeypatch.setattr(M, "_spawn_bot", lambda **kw: calls.append(kw) or {"id": "s"+str(len(calls))})
    M.start_mappers("grp1", 5)                       # demande 5, seulement 3 dispo
    assert len(calls) == 3
    assert sorted(c["sector_index"] for c in calls) == [0, 1, 2]
    assert all(c["sector_count"] == 3 for c in calls)
    assert all(c["objective"] == "mapper" for c in calls)
```

- [ ] **Step 2: Run → FAIL**.
- [ ] **Step 3: Implémenter** — adapter `start_session`/`_spawn_bot` du manager pour accepter `bot_id` (résoudre username via `get_server`, secret via `mc_agent_secrets.get_secret`, passer `--user <username>`, et l'AuthMe `/login` via `login_command` du groupe + secret). Ajouter `start_mappers(group_id, n)` : filtrer `bots role=mapper` (exclure ceux déjà en ligne), prendre `min(n, dispo)`, démarrer chacun avec `sector_index=i, sector_count=k`. Endpoint `/run` : accepter `bot_id` (single) ; nouvel endpoint `POST /servers/{sid}/mappers/start` body `{count}` → `start_mappers`. Garde-fou : ne pas lancer 2 bots même username en ligne (cf. `_mcaActiveByServer`/sessions existantes).

- [ ] **Step 4: Run → PASS** (manager + router).
- [ ] **Step 5: Commit** — `"feat(mc-agent): /run par bot_id + start_mappers (secteurs auto, cap dispo)"`

### Task 7: AuthMe `/login` auto via login_command + secret

**Files:** Modify `mc_agent_manager.py` (+ éventuel passage d'arg au bot Node), Test manager.

- [ ] **Step 1: Test** — quand `group.has_login` et bot a un secret, le spawn passe la commande de login résolue (`login_command.replace("{pwd}", secret)`) au bot (via `--login-command` ou fichier temp comme `--policy`).

```python
def test_login_command_passed_when_has_login(monkeypatch):
    from backend.bots import mc_agent_manager as M
    captured = {}
    monkeypatch.setattr(M, "_spawn_bot", lambda **kw: captured.update(kw) or {"id": "s1"})
    # group has_login=True, login_command "/login {pwd}", bot secret "abc"
    M.start_session("grp1", bot_id="bot1")
    assert captured["login_command"] == "/login abc"
```

- [ ] **Step 2: Run → FAIL**.
- [ ] **Step 3: Implémenter** — résoudre `login_command` rempli avec le secret ; le passer au subprocess via un fichier temp `data/mc_agent_runs/login-<sid>.txt` (nettoyé au stop, pattern `--policy`/`--commands` existant) OU arg `--login-command`. Côté Node : à la connexion (après spawn/AuthMe), si `--login-command` fourni → `bot.chat(loginCommand)` une fois (déjà partiellement géré par l'AuthMe self-persist Node #41 — vérifier et router vers ce mécanisme). **Le secret n'apparaît jamais dans `mc_agent_servers.json` ni dans les logs** (masquer dans tout log).

- [ ] **Step 4: Run → PASS**.
- [ ] **Step 5: Commit** — `"feat(mc-agent): /login auto (login_command + secret, jamais loggé)"`

---

## PHASE 4 — Frontend : navigation 2 niveaux

> Frontend = `frontend/js/bots_module.js` (gros fichier existant : LIRE la section MC Agent `renderMCAgent*`/`switchMCATab`/`_mcaTab`/`_mcaMap*` AVANT d'éditer). Tests = **verify-ui** (Chrome MCP) car canvas/SPA. Chaque task : implémenter → vérifier visuellement (screenshot + console sans erreur) → commit.

### Task 8: État de navigation 2 niveaux

**Files:** Modify `bots_module.js` (état `_mca`), `lang.js`, `index.html`+`sw.js` (cache-bust).

- [ ] **Step 1: Implémenter** — remplacer les onglets plats par : niveau 1 = `_mcaView ∈ {create, list}` + niveau 2 = `_mcaGroupId` (null = niveau 1) + `_mcaGroupTab ∈ {workers, map, edit}`. Fonctions `renderMCA()` (router : si `_mcaGroupId` → vue groupe, sinon niveau 1), `openGroup(id)`, `backToList()`. Barre d'onglets niveau 1 (Créer un groupe / Mes serveurs) + niveau 2 (Bots ouvriers / Carte / Modifier) avec fil d'Ariane retour. Clés i18n `mcagent.nav.*`. Bump `?v=` + `CACHE_NAME`.
- [ ] **Step 2: Vérif visuelle** — `verify-ui` : ouvrir omenserver.org (ou dashboard local), aller MC Agent → voir les 2 onglets niveau 1 ; cliquer un groupe (en créer un d'abord) → voir les 3 onglets niveau 2 + retour. Console sans erreur.
- [ ] **Step 3: Commit** — `"feat(mc-agent): nav 2 niveaux (create/list → groupe: workers/map/edit)"`

### Task 9: Onglet « Créer un groupe » + « Mes serveurs » (liste)

**Files:** Modify `bots_module.js`, `lang.js`.

- [ ] **Step 1: Implémenter** — `renderGroupCreate()` (formulaire : nom, host, port, has_login + login_command conditionnel, commandes (réutilise le sélecteur catalogue existant), langue/intelligence) → `POST /servers` → bascule sur la liste. `renderGroupList()` : cartes des groupes (`GET /servers`) avec nom, host, nb bots, statut en ligne ; clic → `openGroup(id)`. Bouton supprimer groupe (confirme) → `DELETE /servers/{id}`.
- [ ] **Step 2: Vérif visuelle** — créer un groupe → apparaît dans la liste → clic ouvre la vue groupe. Console OK.
- [ ] **Step 3: Commit** — `"feat(mc-agent): onglets Créer un groupe + Mes serveurs"`

---

## PHASE 5 — Frontend : roster bots + carte + cartographes

### Task 10: Onglet « Bots ouvriers » (roster + create + start/stop)

**Files:** Modify `bots_module.js`, `lang.js`.

- [ ] **Step 1: Implémenter** — `renderWorkers(group)` : liste des `bots role=worker` (username, statut, `has_secret`), bouton `[+ Bot ouvrier]` → formulaire inline (username, auth offline/microsoft, mdp si `group.has_login`) → `POST /servers/{id}/bots` (role=worker). Start/stop par bot → `POST /api/mc-agent/run {server_id, bot_id, objective}` (objectif par défaut = configurable) / `POST /stop/{session}`. Bouton supprimer bot → `DELETE .../bots/{bot_id}`. Auth microsoft : afficher le flux device-code (lien + code) à la 1ʳᵉ connexion, puis « ✓ lié ».
- [ ] **Step 2: Vérif visuelle** — ajouter un bot ouvrier, le voir listé, le démarrer (statut → en ligne sur le serveur test), l'arrêter. Console OK.
- [ ] **Step 3: Commit** — `"feat(mc-agent): onglet Bots ouvriers (roster, create, start/stop)"`

### Task 11: Onglet « Carte » scopé groupe + section Cartographes

**Files:** Modify `bots_module.js` (réutilise `_mcaMap*` existant), `lang.js`.

- [ ] **Step 1: Implémenter** — `renderMap(group)` : **réutilise le viewer carte existant** mais **scopé `group.id`** (supprimer le sélecteur serveur `mca-map-server`, garder le sélecteur de monde + auto-refresh). Ajouter une **section Cartographes** : liste des `bots role=mapper` + `[+ Cartographe]` (formulaire username/auth/mdp) + **`[Lancer N cartographes]`** (input nombre 1..nbMappers) → `POST /servers/{id}/mappers/start {count}` + start/stop individuels. Quand des cartographes tournent → la carte se remplit (auto-refresh existant).
- [ ] **Step 2: Vérif visuelle (LIVE)** — créer 2 cartographes, cliquer « Lancer 2 » → 2 bots sur le serveur test Omen (`ssh omen`, docker `omen-minecraft-trusted-test`), la **carte se remplit en live** (biomes apparaissent), secteurs divergents. Screenshot. Console OK.
- [ ] **Step 3: Commit** — `"feat(mc-agent): onglet Carte scopé groupe + lancer N cartographes"`

### Task 12: Onglet « Modifier » (édition config groupe)

**Files:** Modify `bots_module.js`, `lang.js`.

- [ ] **Step 1: Implémenter** — `renderEdit(group)` : réutilise le formulaire de création **pré-rempli** → `PUT /servers/{id}`. Ne touche pas au roster (géré dans les autres onglets). Champs secrets : jamais pré-remplis (juste « ✓ enregistré » + option re-saisir).
- [ ] **Step 2: Vérif visuelle** — modifier le nom/commandes d'un groupe → persiste → reflété dans la liste. Console OK.
- [ ] **Step 3: Commit** — `"feat(mc-agent): onglet Modifier (édition config groupe)"`

---

## PHASE 6 — Finition

### Task 13: i18n complet FR/EN/IT + cache-bust final

- [ ] **Step 1:** Vérifier que toutes les clés `mcagent.nav.*` / `mcagent.group.*` / `mcagent.bot.*` / `mcagent.map.*` existent en **FR, EN, IT** (`lang.js`). Aucun texte hardcodé (piège i18n).
- [ ] **Step 2:** Bump final `?v=` (index.html, tous les JS modifiés) + `CACHE_NAME` (sw.js) — cf. pièges #9/#11/#35-bis.
- [ ] **Step 3: Commit** — `"chore(mc-agent): i18n FR/EN/IT + cache-bust groupes UI"`

### Task 14: Revue + validation end-to-end

- [ ] **Step 1:** `cd backend && python -m pytest bots/tests/ -q` → tout vert. `cd mc-agent && node --test` → tout vert.
- [ ] **Step 2: verify-ui complet** : parcours entier (créer groupe → ajouter ouvrier + cartographe → lancer cartographes → carte se remplit → modifier → supprimer). Screenshots. Console sans erreur.
- [ ] **Step 3:** MAJ Obsidian : page concept [[🎮 MC Agent — Cartographe & Mémoire de monde]] (section UI groupes) + daily. **NE PAS merger vers main** (revue + merge délibéré avec Massii, comme la carte).
- [ ] **Step 4: Commit** — `"docs(mc-agent): groupes 2 niveaux validés end-to-end"`

---

## Notes d'exécution
- **Worktree** : `feat/mc-agent-groups-ui` (déjà créé, basé sur `main` à jour avec la carte).
- **Anti-blocage** (runs live) : timeout strict sur tout SSH/bot live ; tuer un hang ; petits commits.
- **Sécurité** : les secrets ne doivent JAMAIS apparaître dans une réponse API, un log, ou `mc_agent_servers.json`. Tests dédiés (Task 4, 5).
- **Réutilisation** : objectif `mapper`, secteurs (`--sector-index/count`), world-memory, viewer carte = EXISTANT, ne pas réécrire.
- **Pas de merge prod** sans validation live + accord Massii.

---

## ✅ Exécution (2026-06-04, session autonome subagent-driven)

**14/14 tasks faites** — branche `feat/mc-agent-groups-ui`, **PAS mergée** (revue Massii requise).

- Backend Tasks 1-7 : TDD strict (209 pytest ✓, dont migration idempotente, no-leak secrets, start_mappers secteurs, login_command jamais argv/log). Node 342 ✓ (`resolveAuthChat`).
- Frontend Tasks 8-12 : nav 2 niveaux + groupe (workers/map/edit) — vérifiée visuellement à chaque task (Chrome headless CDP, console 0 erreur).
- Task 11 LIVE : 2 cartographes lancés depuis l'onglet Carte → serveur test Omen (Tailscale), carte remplie en temps réel (secteurs divergents), stop UI, cascade delete vérifiée sur disque.
- Fix live : `MAPPER_SPAWN_STAGGER_S=4.5s` (connection-throttle Paper → ECONNRESET du 2e bot simultané).
- Revue finale (subagent) : 1 Important corrigé (`_cleanup_session_files` aussi à la mort naturelle — fichier login en clair ne s'accumule plus) + 1 Mineur corrigé (onclick id-only, username jamais dans un handler). Restent en suivi cosmétique : clés i18n `*_soon` mortes, `args.authpw` legacy Node, UX d'attente du batch N mappers (requête sync ~4.5s/bot).
- Déviation assumée : niveau 1 = 3 onglets (Créer / Mes serveurs / **Outils** = ancien panneau Lancer complet, zéro perte fonctionnelle).
