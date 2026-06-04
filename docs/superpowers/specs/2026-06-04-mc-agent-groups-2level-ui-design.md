# MC Agent — Groupes & navigation 2 niveaux (UI + comptes bots)

> **Statut** : design validé par Massii (2026-06-04). À implémenter sur `feat/mc-agent-groups-ui`.
> **Origine** : Massii veut organiser le MC Agent par **groupe = serveur**, avec une navigation à 2 niveaux,
> des bots **persistants** (chacun son compte + mot de passe mémorisé), et le lancement de **cartographes**
> directement depuis l'onglet Carte. Companion : [[🎮 MC Agent — Cartographe & Mémoire de monde]].

---

## 1. But

Restructurer l'UI MC Agent (actuellement onglets plats *Lancer / Serveurs / Carte*) en une **navigation à 2 niveaux** organisée par **groupe (= serveur)**. Chaque groupe contient des **bots persistants** (ouvriers + cartographes), chacun avec son **compte (pseudo offline ou compte Microsoft) + mot de passe mémorisé**. Les ouvriers et les cartographes d'un même groupe partagent la **même mémoire de monde / carte**, et on peut lancer **1+ cartographes** depuis l'onglet Carte.

**Non-buts (YAGNI)** : pas de gestion multi-utilisateurs/partage de groupes ; pas de stats avancées ; pas de refonte du moteur du bot (on réutilise objectifs/secteurs/world-memory existants) ; pas de BlueMap (rendu terrain) — la carte reste le viewer 2D existant de la mémoire de monde.

---

## 2. Navigation (2 niveaux)

```
MC-Agent (à l'ouverture) = 2 onglets niveau 1
│
├─ Onglet « Créer groupe »   → formulaire : IP/port, commandes, authentification/login → crée un groupe
│
└─ Onglet « Groupes »         → liste des groupes créés (cartes cliquables : nom, IP, nb bots, statut)
        │
        └─ (clic sur un groupe, ex. « test serveur ») → VUE DU GROUPE = EXACTEMENT 2 onglets :
               ├─ « Multi-bot » → créer plusieurs bots OUVRIERS (chacun : cracké/offline OU compte officiel
               │                  Microsoft) · liste · start/stop
               └─ « Mapping »   → créer plusieurs bots CARTOGRAPHES (même UI, role mapper) · liste · start/stop
                                  · lancer N · + BOUTON « Ouvrir la carte » (carte du serveur où tournent ces bots)
          (+ petit engrenage ⚙ « réglages » dans l'en-tête → édite la config du groupe via PUT /servers/{id})
```

- Niveau 1 = **gestion des groupes** (créer / lister).
- Niveau 2 = **vue d'un groupe** = **2 onglets** : Multi-bot (ouvriers) + Mapping (cartographes + bouton carte). Pas d'onglet « Modifier » → un engrenage ⚙ dans l'en-tête. Fil d'Ariane / « ← retour » ramène à la liste.
- La **carte** s'ouvre via un **bouton** dans Mapping (modale/panneau) — réutilise le viewer carte existant scopé au `group_id`.
- État de navigation persistant en mémoire JS (`BotsModule._mca*`) ; pas de routing hash dédié (pattern SPA existant).

---

## 3. Modèle de données

### 3.1 Groupe (étend les « profils serveur » existants)
Fichier : `data/mc_agent_servers.json` (déjà existant, étendu). Un groupe :
```jsonc
{
  "id": "grp_xxx",
  "name": "Mon serveur",
  "host": "play.exemple.net",
  "port": 25565,                  // optionnel, défaut 25565
  "auth": "offline" | "microsoft",
  "has_login": true,              // le serveur a-t-il un plugin login (AuthMe) ?
  "login_command": "/login {pwd}",// template de la commande login (défaut AuthMe), si has_login
  "register_command": "/register {pwd} {pwd}", // optionnel
  "commands": ["/home", "/tpa", ...],          // whitelist commandes (réglage GÉNÉRAL du groupe)
  "policy": { "trusted": [...], "trade": {...} }, // existant, niveau groupe
  "language": "fr",
  "bots": [                       // NOUVEAU : roster de bots du groupe
    { "id": "bot_xxx", "role": "worker" | "mapper", "username": "MonBot1", "auth": "offline" | "microsoft" }
  ]
}
```
- **Le compte unique actuel d'un profil** (host/port/user/auth) → migré en **1er bot** du roster (`bots[0]`).
- `commands`, `policy`, `language`, `has_login`/`login_command` = **réglages généraux** partagés par tous les bots du groupe.

### 3.2 Identifiants (secrets) — SÉPARÉS, jamais dans l'API
Réutilise le pattern AuthMe existant (`data/mc_agent_secret_<user>.json`, chmod 600) **généralisé par bot** :
- Fichier secrets par groupe ou par bot, **chmod 600**, hors `mc_agent_servers.json`.
- Contient : mot de passe AuthMe (offline) **ou** refresh-token Microsoft (compte officiel) par bot.
- **L'API `GET /servers` ne renvoie JAMAIS les secrets** (déjà le cas pour l'AuthMe ; étendre au roster). Le frontend n'affiche jamais les mdp (juste « ✓ enregistré » / champ pour (re)saisir).

### 3.3 Mémoire de monde (déjà par groupe — inchangé)
`data/mc_agent_world_memory/<group_id>.json` → `worlds[<monde>] = {biomes,caves,finds}`. Ouvriers ET cartographes du groupe émettent les events (`biome_seen`/`cave_found`/`material_found`) → même carte. L'onglet Carte lit `GET /servers/{group_id}/memory` (existant).

---

## 4. Composants

### 4.1 Backend (`backend/bots/`)
- **`mc_agent_servers.py`** : étendre le schéma profil → groupe (champ `bots[]`, `has_login`/`login_command`). Fonctions CRUD bots : `add_bot(group_id, role, username, auth)`, `remove_bot`, `list_bots`. `resolve_*` (commands/policy) inchangées (niveau groupe). **Migration** idempotente au chargement : ancien profil → `bots[0]` à partir de `user`/`auth`.
- **Secrets** : module/fonctions `set_bot_secret(group_id, bot_id, secret)` / `get_bot_secret(...)` → fichier chmod 600 hors API. Généralise `mc_agent_secret_*`.
- **`mc_agent_router.py`** : endpoints (tous **admin-only**, cohérent existant) —
  - `POST /servers` (créer groupe) / `PUT /servers/{id}` (modifier) / `DELETE /servers/{id}` (cascade : stop bots + `forget_group` mémoire, existant).
  - `POST /servers/{id}/bots` (créer bot : role, username, auth, + secret en body → stocké séparé) / `DELETE /servers/{id}/bots/{bot_id}`.
  - `POST /run` (existant) : prend `server_id` + `bot_id` (quel compte lancer) + `objective` (`mapper` pour cartographe) + secteur auto pour multi. `POST /stop/{session}` (existant).
  - `GET /servers/{id}/memory` (existant, carte).
- **`mc_agent_manager.py`** : `start_session` passe le **bon compte** (username + secret du bot) au subprocess + `--objective mapper` + `--sector-index/count` (multi-cartographe, existant). AuthMe : `/login` auto via `login_command` du groupe + secret du bot. **Lancement multi-cartographe** : helper qui démarre N bots `mapper` du roster avec secteurs `0..N-1`.

### 4.2 Frontend (`frontend/js/bots_module.js`)
Refonte de la section MC Agent (`_mcaTab` / `switchMCATab` / `renderMCAgent*`) :
- **Niveau 1** : `renderGroupCreate()` (formulaire) + `renderGroupList()` (cartes des groupes, clic → `openGroup(id)`).
- **Niveau 2** (`openGroup`) : barre de 3 sous-onglets (`workers` / `map` / `edit`) + fil d'Ariane retour.
  - `renderWorkers(group)` : `[+ Bot ouvrier]` (formulaire inline : username + offline/MS + mdp si login), liste, start/stop (réutilise `/run` + `/stop`).
  - `renderMap(group)` : **réutilise le viewer carte existant** (`_mcaMap*`) **scopé au group_id** (plus besoin du sélecteur serveur, il est implicite) + section **Cartographes** : `[+ Cartographe]`, liste, **[Lancer N cartographes]** (sélecteur 1–N), start/stop. Auto-refresh existant.
  - `renderEdit(group)` : formulaire de la config générale (réutilise le formulaire de création pré-rempli).
- i18n **FR/EN/IT** (clés `mcagent.*`) + **cache-bust** (`?v=` index.html + `CACHE_NAME` sw.js).

---

## 5. Flux principaux

1. **Créer un groupe** : onglet « Créer un groupe » → saisir nom/IP/commandes/login → `POST /servers` → apparaît dans « Mes serveurs ».
2. **Ajouter un bot** : ouvrir le groupe → onglet Ouvriers ou Carte → `[+ Bot …]` → username + offline/MS + (mdp si login) → `POST /servers/{id}/bots` (+ secret stocké séparé). Persistant.
3. **Lancer** : start un bot → `POST /run {server_id, bot_id, objective}`. Le manager récupère le secret du bot → AuthMe `/login` auto. Cartographe = `objective:mapper`.
4. **Lancer N cartographes** : bouton Carte → démarre N bots `mapper` du roster, secteurs auto 0..N-1 (divergents, anti-chevauchement existant) → la carte se remplit (auto-refresh).
5. **Modifier** : onglet Modifier → `PUT /servers/{id}`.
6. **Supprimer un groupe** : `DELETE /servers/{id}` → stop tous ses bots + efface la mémoire de monde (cascade existante) + secrets.

---

## 6. Erreurs & cas limites
- **Pseudo en double en ligne** : 2 bots avec le même username ne peuvent pas être en ligne ensemble → garde-fou : empêcher de lancer 2 bots de même username ; à la création, avertir si username déjà dans le roster.
- **Lancer N cartographes > nb de comptes cartographes existants** : ne lancer que ceux qui existent + message « crée plus de comptes cartographes pour en lancer davantage » (pas de création auto de comptes).
- **Login échoue** (mauvais mdp / format AuthMe différent) : event d'échec remonté, bot non bloquant (cf. pièges #39/#40) ; UI montre « login échoué » sur le bot.
- **Secret manquant** alors que `has_login` : bloquer le lancement avec message clair.
- **Compte Microsoft (officiel) ≠ pseudo offline** : « mémoriser son compte » diffère selon l'auth —
  - *offline* : un **pseudo** + (si `has_login`) un **mot de passe AuthMe** stocké → `/login` auto à chaque join.
  - *microsoft* : auth **device-code one-shot** (mineflayer affiche un code à autoriser sur microsoft.com **une fois**), puis **refresh-token mis en cache** (réutilisé sans ré-auth). L'UI doit guider ce flux à la 1ʳᵉ connexion du bot (afficher le code/lien) et marquer le bot « ✓ lié » ensuite. ⚠️ 2 bots = 2 comptes MS distincts (un compte MS ne peut pas être en ligne 2×).
- **Migration** : un ancien profil sans `bots[]` → créer `bots[0]` depuis `user` ; idempotent (ne pas dupliquer au rechargement).

## 7. Sécurité
- Mots de passe / tokens **uniquement côté serveur**, fichiers **chmod 600**, **jamais** renvoyés par l'API ni loggés. Le frontend ne reçoit que `has_secret: true/false`.
- Endpoints **admin-only** (cohérent avec l'existant MC Agent).
- Anti path-traversal sur `group_id`/`bot_id` (réutiliser `_SAFE_ID` du world_memory).

## 8. Tests
- **Python** : CRUD groupes + bots (`mc_agent_servers`), migration profil→bots[0] idempotente, secrets stockés hors API (`GET /servers` ne fuit pas), garde-fous (username dup, secret manquant), endpoints bots (admin-only → 403 sinon).
- **Node** : le manager passe le bon compte + secret + objectif/secteur au bot (lancement multi-cartographe → secteurs 0..N-1).
- **Visuel** (verify-ui / Chrome) : navigation 2 niveaux, création groupe, ajout bot, onglet Carte avec section cartographes + lancement, onglet Modifier. Données réelles via un mapper live (serveur test Omen).

## 9. Migration / déploiement
- **Rétro-compat** : les profils serveur existants deviennent des groupes (1 bot chacun) sans perte. La carte/mémoire existante (par group_id) reste valide.
- **Aucune nouvelle dépendance** attendue (réutilise le moteur bot + mineflayer microsoft auth déjà présent). Si l'auth Microsoft officielle exige une dep non présente → la flaguer (cf. #33, `npm install` manuel sur l'Omen).
- Onglet Carte déjà en prod (PR du 04/06) → cette feature la réorganise sous le niveau 2.
