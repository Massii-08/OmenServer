# MC Agent — Cartographes → Oremap partagée → Bots ressources multi-quota

**Date** : 2026-06-05 · **Branche** : `feat/mc-agent-oremap-quota` (base `feat/mc-agent-diamond` @ dcd874d) · **Mode** : session autonome

## Objectif

K cartographes balayent une zone (centre±rayon ~1500), enregistrent toutes les ores (souterraines incluses, via le cache client mineflayer des chunks chargés) dans un store partagé ; M bots ressources lisent la carte, claiment des ores sans collision, et minent jusqu'à quota par type (💎15, or 15, redstone 64, lapis 64, fer 64). Visualisation canvas top-down sur omenserver.org.

## Décisions d'architecture (brainstorm 2026-06-05)

### D1 — Store : JSON atomique + lockfile (sqlite rejeté)

- `better-sqlite3` = dépendance native (piège #33 auto-deploy) ; `node:sqlite` exige Node ≥22.5 non garanti sur l'Omen. JSON + `fs` natif = zéro dep.
- **Fichier** : `data/mc_agent_runs/oremap-<runId>.json` (`runId` = id de groupe partagé entre les sessions d'un même run, passé via `--oremap`).
- **Écriture** : read-modify-write sous lock — `fs.mkdirSync('<file>.lock')` (atomique O_EXCL), retry 50 ms, vol du lock si mtime > 10 s (process mort). Write = fichier temp + `renameSync` (atomique POSIX).
- **Lecture Python** : sans lock — le rename garantit un contenu toujours cohérent.
- **Claims TTL** : `{claimedBy, claimedAt}` par ore ; TTL **120 s**, rafraîchi par le claimer à chaque itération de sa boucle. Bot mort → claim expirée → ore reprenable. Un bot ne prend jamais une ore avec claim non expirée d'un autre.

### D2 — Comptage quota

| Type | Items comptés | Quota | Pioche pour drop |
|---|---|---|---|
| diamond | `diamond` | 15 | fer+ |
| gold | `raw_gold` | 15 | fer+ |
| redstone | `redstone` | 64 | fer+ |
| lapis | `lapis_lazuli` | 64 | pierre+ |
| iron | `raw_iron` + `iron_ingot` | 64 | pierre+ |

Comptage PAR bot, sur son inventaire (+ ce qu'il a déposé en coffre, tracké dans son état `quota.have` cumulatif — le deposit ne fait pas perdre le compte).

### D3 — Rendu : canvas vanilla

Canvas maison (préférence vanilla, zéro dep) : points colorés projetés (x,z) → pixels, 1 couleur/type, triangles = positions bots, barres de quota HTML sous le canvas.

## Schéma du store

```json
{
  "runId": "carto-abc123",
  "zone": { "cx": 0, "cz": 0, "radius": 750 },
  "updatedAt": 1760000000000,
  "ores": {
    "12,-54,88": { "type": "diamond", "x": 12, "y": -54, "z": 88,
                    "foundBy": "Carto1", "at": 1760000000000,
                    "claimedBy": null, "claimedAt": 0, "status": "new" }
  },
  "bots": {
    "Res1": { "x": 10, "y": -50, "z": 80, "at": 1760000000000, "role": "resource",
               "quota": { "diamond": { "have": 3, "target": 15 } } }
  }
}
```

- Clé `"x,y,z"` → dédup O(1) entre cartographes.
- `status`: `new` → `mined` (miné par un bot) | `gone` (entrée stale, bloc absent à l'arrivée).
- Normalisation type : `deepslate_diamond_ore`/`diamond_ore` → `diamond`, etc. (10 IDs blocs → 5 types).

## Composants

### `mc-agent/oremap.js` (P2)
Client store. Logique pure (sélection, claims, counts) séparée des I/O (lock/load/save) → testable sans fs.
API : `createStore(path, runId, zone)`, `load()`, `withLock(fn)` (read-modify-write), `addOres(list, foundBy)`, `claimNext({type, from, username, now})` → ore la plus proche non-claimée/non-expirée du type, `refreshClaim`, `releaseClaim`, `markMined`, `markGone`, `heartbeat(username, pos, role, quota)`, `counts()`.

### `mc-agent/skills/surveyArea.js` (P1)
`surveyArea(bot, {cx, cz, radius, store}, token)` : serpentin (lawnmower) sur le rectangle, pas de 24 blocs ; à chaque waypoint `pathfinder.goto` (surface) puis `bot.findBlocks({matching: <10 IDs ore>, maxDistance: 32, count: 200})` → `store.addOres()` **immédiatement** (record-before-unload, LA contrainte clé). Pas besoin de descendre : le cache client voit tout le Y des chunks chargés. IDs : {diamond, gold, redstone, lapis, iron}_ore + variantes deepslate (compat 1.20.1 et 1.21.4 — résolution par `blocksByName`, IDs absents ignorés). Émet `survey_progress {done, total, oresFound}`. Goto raté → waypoint suivant (best-effort).

### `mc-agent/skills/resourceQuota.js` (P4)
`resourceQuota(bot, {quota, store}, token)` : boucle —
1. recount inventaire (mapping D2) + MAJ `quota.have` (cumul deposits) ; tous quotas atteints → `{ok:true}`.
2. type manquant → `store.claimNext()` ; aucune ore dispo → wait 5 s + retry (cartographes peuvent encore en ajouter), event `resource_waiting`.
3. goto borné vers l'ore (timeout, persistance de progrès — pattern prior art `gotoOreBounded`).
4. arrivé : bloc absent → `markGone` + boucle. Présent → dig anti-lave (réutilise `isLava`/`neighborsHaveLava`/`wallLava` de branchMine) + collect drop.
5. `markMined` + `refreshClaim` au passage + heartbeat (position + progression).
6. Garde-fous : pioche du bon palier requise sinon skip type (event `resource_blocked {no_pickaxe}`) avec tentative de re-craft (3 iron_ingot + 2 sticks + table) si matos ; inventaire plein → `deposit` (skill existante) en mémorisant les counts ; faim/mobs → réflexes existants ; lave → mur + abandon de l'ore (`markGone` évité, `releaseClaim` pour qu'un autre tente).

### `mc-agent/index.js`
Flags `--zone <path>`, `--quota <path>`, `--oremap <runId>` ; objectifs `cartographer` → surveyArea, `resource_quota` → resourceQuota (dispatch direct, pas de chaîne planner — comportements en boucle, pas des buts monotones).

### Backend (P3)
- `VALID_OBJECTIVES += ("cartographer", "resource_quota")` (mc_agent_manager.py:139).
- `start_session(..., zone=None, quota=None, oremap_run_id=None)` → sidecars `zone-<sid>.json` / `quota-<sid>.json` dans `RUNS_DIR` + flags, enregistrés dans la session, **nettoyés au stop** (pattern world_path exact).
- `GET /api/mc-agent/map/<runId>` (admin-only via `_require_admin`) : lit `oremap-<runId>.json`, retourne `{zone, ores: [liste], counts: {type: {new, mined, gone}}, claims, bots}`. 404 si absent.
- `POST /api/mc-agent/run` accepte `zone {cx, cz, radius}`, `quota {type: n}`, `oremap_run_id`.

### Frontend (P5)
Dans `bots_module.js`, sous la vue session MC Agent : section oremap (visible si la session a un runId oremap) — canvas top-down (poll `/map/<runId>` 3 s), légende couleurs (💎 cyan, or jaune, redstone rouge, lapis bleu, fer beige ; mined = gris), triangles bots + nom, barres de quota par bot ressource. i18n `mcagent.oremap.*` (FR/EN/IT, fallback piège #12). Cache-bust : bump `?v=` de `bots_module.js` et `lang.js` dans index.html + `CACHE_NAME` dans sw.js.

### Orchestration (P6)
Script/runbook : POST K sessions `cartographer` (quadrants de la zone : 4 sous-rectangles), poll `/map/<runId>` ; dès que `counts.new` couvre les quotas ×1.5 de marge, POST M sessions `resource_quota` **en parallèle** (sans attendre la fin des cartographes). Surveillance par bot via `/status/{sid}` + `/chat/{sid}` + `/map`.

## Gestion d'erreurs

| Cas | Comportement |
|---|---|
| Lock contendu | retry 50 ms, max ~5 s, puis steal si mtime lock >10 s |
| Bot ressource meurt | claim expire (TTL 120 s) → un autre bot reprend l'ore |
| Ore stale (déjà minée) | `markGone`, jamais re-sélectionnée |
| Lave autour de l'ore | mur (`wallLava`) + `releaseClaim` + ore suivante |
| Goto inatteignable | `releaseClaim`, skip local (Set), retry possible par un autre bot |
| Carte vide au démarrage du bot ressource | attente active 5 s + event `resource_waiting` |
| Pioche cassée sans matos | event `resource_blocked`, skip des types exigeant ce palier, continue les autres |

## Tests

- **Node** (`node --test`) : oremap (lock/claims/TTL/dédup/counts — fs réel sur tmpdir), surveyArea (fake-bot : findBlocks mocké, vérifie record-before-unload = addOres appelé pendant le balayage), resourceQuota (fake-bot : sélection, claim, stale, quota, deposit, pioche).
- **Python** (`pytest backend/bots/tests/ -q`) : flags `--zone/--quota/--oremap` (monkeypatch Popen), seed + cleanup sidecars, endpoint `/map` (200 admin, 403 non-admin, 404 inconnu, agrégats corrects).
- **Live** : serveur test `omen-minecraft-trusted-test`, checkout dédié hors auto-deploy (`~/mc-agent-carto-test`), zone fraîche (piège #41), vérif UI via Chrome MCP.

## Hors scope (YAGNI)

Fortune/enchantements, ores du Nether, multi-monde, persistance de l'oremap entre runs, partage de quota inter-bots (quota strictement PAR bot), sqlite.
