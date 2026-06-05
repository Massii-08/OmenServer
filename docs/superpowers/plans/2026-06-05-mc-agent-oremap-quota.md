# MC Agent Oremap + Bots Ressources Multi-Quota — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cartographes mineflayer qui remplissent une oremap JSON partagée (record-before-unload), bots ressources qui claiment et minent jusqu'à quota par type, endpoint + canvas de visualisation sur omenserver.org.

**Architecture:** Store JSON atomique multi-process (lockfile mkdir + rename atomique, claims TTL 120 s) écrit par les process Node, lu sans lock par le backend Python. Deux nouveaux objectifs autonomes (`cartographer`, `resource_quota`) dispatchés dans `index.js` AVANT le planner à chaînes. Spec : `docs/superpowers/specs/2026-06-05-mc-agent-oremap-quota-design.md`.

**Tech Stack:** Node (mineflayer + pathfinder + collectblock, déjà installés — ZÉRO nouvelle dep), Python FastAPI, vanilla JS canvas. Tests : `node --test` (fake-bots) + `pytest`.

**Worktree:** `.claude/worktrees/feat+mc-agent-oremap-quota` (branche `feat/mc-agent-oremap-quota`, base `feat/mc-agent-diamond`). Toutes les commandes ci-dessous s'exécutent depuis la racine du worktree. ⚠️ JAMAIS de push sur main.

**Conventions du repo à respecter :**
- Skills : signature `async skill(bot, args = {}, token = null) → {ok, reason?, ...}` ; vérifier `token.cancelled`.
- Tests Node : `node:test` + `assert`, fichiers `*.test.js` à côté du code (`mc-agent/test/` n'existe PAS — les tests vivent dans `mc-agent/` et `mc-agent/skills/`, ex. `skills/branchMine.test.js`).
- Charges optionnelles pathfinder dans les skills : `let goals; try { goals = require('mineflayer-pathfinder').goals; } catch (e) { goals = null; }` (pattern branchMine.js:19-24).
- Python 3.9 : pas de `match`, pas de `str | None` (utiliser `Optional`).
- Commits : préfixe `feat(mc-agent):` / `test(mc-agent):`, messages en français.

---

### Task 1: `oremap.js` — logique pure (types, dédup, claims TTL, counts)

**Files:**
- Create: `mc-agent/oremap.js`
- Test: `mc-agent/oremap.test.js`

- [ ] **Step 1.1: Écrire les tests de la logique pure (qui échouent)**

Créer `mc-agent/oremap.test.js` :

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeOreName, addOres, claimNext, refreshClaim, releaseClaim,
  markMined, markGone, heartbeat, counts, emptyMap, CLAIM_TTL_MS, ORE_TYPES,
} = require('./oremap');

test('normalizeOreName mappe les 10 IDs de blocs vers 5 types', () => {
  assert.strictEqual(normalizeOreName('diamond_ore'), 'diamond');
  assert.strictEqual(normalizeOreName('deepslate_diamond_ore'), 'diamond');
  assert.strictEqual(normalizeOreName('gold_ore'), 'gold');
  assert.strictEqual(normalizeOreName('deepslate_redstone_ore'), 'redstone');
  assert.strictEqual(normalizeOreName('lapis_ore'), 'lapis');
  assert.strictEqual(normalizeOreName('deepslate_iron_ore'), 'iron');
  assert.strictEqual(normalizeOreName('stone'), null);
  assert.strictEqual(Object.keys(ORE_TYPES).length, 10);
});

test('addOres ajoute, dédup par position, ignore les noms inconnus', () => {
  const m = emptyMap('r1', { cx: 0, cz: 0, radius: 100 });
  const added = addOres(m, [
    { name: 'diamond_ore', x: 1, y: -54, z: 2 },
    { name: 'diamond_ore', x: 1, y: -54, z: 2 },   // doublon exact
    { name: 'stone', x: 3, y: 0, z: 3 },             // pas une ore
    { name: 'iron_ore', x: 5, y: 20, z: 5 },
  ], 'Carto1', 1000);
  assert.strictEqual(added, 2);
  assert.strictEqual(Object.keys(m.ores).length, 2);
  const d = m.ores['1,-54,2'];
  assert.deepStrictEqual(
    { type: d.type, foundBy: d.foundBy, status: d.status, claimedBy: d.claimedBy },
    { type: 'diamond', foundBy: 'Carto1', status: 'new', claimedBy: null });
});

test('addOres ne ressuscite JAMAIS une ore mined/gone (re-scan cartographe)', () => {
  const m = emptyMap('r1', null);
  addOres(m, [{ name: 'iron_ore', x: 0, y: 0, z: 0 }], 'C1', 1000);
  markMined(m, '0,0,0');
  const added = addOres(m, [{ name: 'iron_ore', x: 0, y: 0, z: 0 }], 'C2', 2000);
  assert.strictEqual(added, 0);
  assert.strictEqual(m.ores['0,0,0'].status, 'mined');
});

test('claimNext choisit la plus proche du type, pose claimedBy/claimedAt', () => {
  const m = emptyMap('r1', null);
  addOres(m, [
    { name: 'diamond_ore', x: 100, y: -54, z: 0 },
    { name: 'diamond_ore', x: 10, y: -54, z: 0 },
    { name: 'iron_ore', x: 1, y: -54, z: 0 },
  ], 'C1', 0);
  const ore = claimNext(m, { type: 'diamond', from: { x: 0, y: -54, z: 0 }, username: 'Res1', now: 5000 });
  assert.strictEqual(ore.x, 10);
  assert.strictEqual(m.ores['10,-54,0'].claimedBy, 'Res1');
  assert.strictEqual(m.ores['10,-54,0'].claimedAt, 5000);
});

test('claimNext respecte la claim active d\'un autre bot, mais reprend une claim expirée', () => {
  const m = emptyMap('r1', null);
  addOres(m, [{ name: 'diamond_ore', x: 10, y: 0, z: 0 }], 'C1', 0);
  claimNext(m, { type: 'diamond', from: { x: 0, y: 0, z: 0 }, username: 'Res1', now: 1000 });
  // claim active (TTL pas écoulé) → Res2 ne la prend pas
  assert.strictEqual(claimNext(m, { type: 'diamond', from: { x: 0, y: 0, z: 0 }, username: 'Res2', now: 1000 + CLAIM_TTL_MS - 1 }), null);
  // claim expirée → Res2 la reprend (bot mort)
  const ore = claimNext(m, { type: 'diamond', from: { x: 0, y: 0, z: 0 }, username: 'Res2', now: 1000 + CLAIM_TTL_MS + 1 });
  assert.strictEqual(ore.x, 10);
  assert.strictEqual(m.ores['10,0,0'].claimedBy, 'Res2');
});

test('claimNext re-rend sa propre claim au même bot + ignore le Set skip', () => {
  const m = emptyMap('r1', null);
  addOres(m, [
    { name: 'iron_ore', x: 1, y: 0, z: 0 },
    { name: 'iron_ore', x: 2, y: 0, z: 0 },
  ], 'C1', 0);
  claimNext(m, { type: 'iron', from: { x: 0, y: 0, z: 0 }, username: 'Res1', now: 0 });
  // re-claim par le même bot (reprise après crash skill) → OK, c'est la sienne
  const again = claimNext(m, { type: 'iron', from: { x: 0, y: 0, z: 0 }, username: 'Res1', now: 10 });
  assert.strictEqual(again.x, 1);
  // skip local : la 1,0,0 est blacklistée → il prend la 2,0,0
  const skipped = claimNext(m, { type: 'iron', from: { x: 0, y: 0, z: 0 }, username: 'Res1', now: 20, skip: new Set(['1,0,0']) });
  assert.strictEqual(skipped.x, 2);
});

test('refreshClaim/releaseClaim ne marchent que pour le propriétaire', () => {
  const m = emptyMap('r1', null);
  addOres(m, [{ name: 'iron_ore', x: 1, y: 0, z: 0 }], 'C1', 0);
  claimNext(m, { type: 'iron', from: { x: 0, y: 0, z: 0 }, username: 'Res1', now: 0 });
  assert.strictEqual(refreshClaim(m, '1,0,0', 'Res2', 100), false);
  assert.strictEqual(refreshClaim(m, '1,0,0', 'Res1', 100), true);
  assert.strictEqual(m.ores['1,0,0'].claimedAt, 100);
  assert.strictEqual(releaseClaim(m, '1,0,0', 'Res2'), false);
  assert.strictEqual(releaseClaim(m, '1,0,0', 'Res1'), true);
  assert.strictEqual(m.ores['1,0,0'].claimedBy, null);
});

test('markMined/markGone sortent l\'ore du pool claimable', () => {
  const m = emptyMap('r1', null);
  addOres(m, [
    { name: 'lapis_ore', x: 1, y: 0, z: 0 },
    { name: 'lapis_ore', x: 2, y: 0, z: 0 },
  ], 'C1', 0);
  markMined(m, '1,0,0');
  markGone(m, '2,0,0');
  assert.strictEqual(claimNext(m, { type: 'lapis', from: { x: 0, y: 0, z: 0 }, username: 'R', now: 0 }), null);
  assert.strictEqual(m.ores['1,0,0'].status, 'mined');
  assert.strictEqual(m.ores['2,0,0'].status, 'gone');
});

test('heartbeat enregistre position/role/quota du bot ; counts agrège par type/statut', () => {
  const m = emptyMap('r1', null);
  addOres(m, [
    { name: 'diamond_ore', x: 1, y: 0, z: 0 },
    { name: 'diamond_ore', x: 2, y: 0, z: 0 },
    { name: 'diamond_ore', x: 3, y: 0, z: 0 },
    { name: 'iron_ore', x: 4, y: 0, z: 0 },
  ], 'C1', 0);
  claimNext(m, { type: 'diamond', from: { x: 0, y: 0, z: 0 }, username: 'Res1', now: 1000 });
  markMined(m, '2,0,0');
  heartbeat(m, 'Res1', { x: 5, y: -50, z: 5, role: 'resource', quota: { diamond: { have: 1, target: 15 } } }, 1000);
  const c = counts(m, 1000);
  assert.deepStrictEqual(c.diamond, { new: 1, claimed: 1, mined: 1, gone: 0 });
  assert.deepStrictEqual(c.iron, { new: 1, claimed: 0, mined: 0, gone: 0 });
  assert.strictEqual(m.bots.Res1.role, 'resource');
  assert.strictEqual(m.bots.Res1.quota.diamond.have, 1);
});
```

- [ ] **Step 1.2: Vérifier que ça échoue**

Run: `cd mc-agent && node --test oremap.test.js`
Expected: FAIL (`Cannot find module './oremap'`)

- [ ] **Step 1.3: Implémenter la logique pure dans `mc-agent/oremap.js`**

```javascript
'use strict';
// Oremap partagée : store JSON multi-process (K cartographes + M bots ressources écrivent,
// le backend Python lit sans lock). Ce fichier contient (a) la LOGIQUE PURE (testable sans
// fs) et (b) le client store I/O (lock mkdir O_EXCL + écriture atomique tmp+rename) —
// cf. spec docs/superpowers/specs/2026-06-05-mc-agent-oremap-quota-design.md (décision D1).
const fs = require('fs');
const path = require('path');

// Claim TTL : un bot rafraîchit sa claim à chaque itération ; bot mort → claim expirée →
// l'ore redevient prenable par un autre bot (pas de coordination explicite nécessaire).
const CLAIM_TTL_MS = 120000;
const LOCK_STALE_MS = 10000;   // lock plus vieux que ça = process mort → on le vole
const LOCK_RETRY_MS = 50;
const LOCK_MAX_WAIT_MS = 5000;

// 10 IDs de blocs (1.20.1 ET 1.21.4) → 5 types logiques.
const ORE_TYPES = {
  diamond_ore: 'diamond', deepslate_diamond_ore: 'diamond',
  gold_ore: 'gold', deepslate_gold_ore: 'gold',
  redstone_ore: 'redstone', deepslate_redstone_ore: 'redstone',
  lapis_ore: 'lapis', deepslate_lapis_ore: 'lapis',
  iron_ore: 'iron', deepslate_iron_ore: 'iron',
};
const TYPES = ['diamond', 'gold', 'redstone', 'lapis', 'iron'];

function normalizeOreName(name) { return ORE_TYPES[name] || null; }

function emptyMap(runId, zone) {
  return { runId: runId || null, zone: zone || null, updatedAt: 0, ores: {}, bots: {} };
}

// Ajoute une liste de {name|type, x, y, z}. Dédup par clé "x,y,z" : une entrée existante
// n'est JAMAIS écrasée (un re-scan cartographe ne ressuscite pas une ore mined/gone et ne
// vole pas une claim). Retourne le nombre d'entrées réellement ajoutées.
function addOres(map, list, foundBy, now) {
  let added = 0;
  for (const o of list || []) {
    const type = TYPES.indexOf(o.type) !== -1 ? o.type : normalizeOreName(o.name);
    if (!type) continue;
    const k = `${o.x},${o.y},${o.z}`;
    if (map.ores[k]) continue;
    map.ores[k] = {
      type, x: o.x, y: o.y, z: o.z,
      foundBy: foundBy || null, at: now,
      claimedBy: null, claimedAt: 0, status: 'new',
    };
    added++;
  }
  return added;
}

function isClaimActive(ore, now, ttl) {
  return !!ore.claimedBy && (now - ore.claimedAt) < (ttl || CLAIM_TTL_MS);
}

// L'ore 'new' du type demandé la plus proche de `from`, hors claims actives d'AUTRES bots
// (sa propre claim est re-rendable : reprise idempotente) et hors Set `skip` local.
// Pose la claim avant de retourner. null si aucune dispo.
function claimNext(map, { type, from, username, now, ttl, skip }) {
  let best = null, bestD = Infinity;
  for (const k of Object.keys(map.ores)) {
    const o = map.ores[k];
    if (o.status !== 'new' || o.type !== type) continue;
    if (skip && skip.has(k)) continue;
    if (isClaimActive(o, now, ttl) && o.claimedBy !== username) continue;
    const d = (o.x - from.x) ** 2 + (o.y - from.y) ** 2 + (o.z - from.z) ** 2;
    if (d < bestD) { bestD = d; best = o; }
  }
  if (best) { best.claimedBy = username; best.claimedAt = now; }
  return best;
}

function refreshClaim(map, key, username, now) {
  const o = map.ores[key];
  if (!o || o.claimedBy !== username) return false;
  o.claimedAt = now;
  return true;
}

function releaseClaim(map, key, username) {
  const o = map.ores[key];
  if (!o || o.claimedBy !== username) return false;
  o.claimedBy = null; o.claimedAt = 0;
  return true;
}

function _setStatus(map, key, status) {
  const o = map.ores[key];
  if (!o) return false;
  o.status = status; o.claimedBy = null; o.claimedAt = 0;
  return true;
}
function markMined(map, key) { return _setStatus(map, key, 'mined'); }
function markGone(map, key) { return _setStatus(map, key, 'gone'); }

function heartbeat(map, username, info, now) {
  map.bots[username] = {
    x: info.x, y: info.y, z: info.z,
    role: info.role || 'resource', quota: info.quota || null, at: now,
  };
}

function counts(map, now) {
  const out = {};
  for (const k of Object.keys(map.ores)) {
    const o = map.ores[k];
    const c = out[o.type] || (out[o.type] = { new: 0, claimed: 0, mined: 0, gone: 0 });
    if (o.status === 'new') c[isClaimActive(o, now) ? 'claimed' : 'new']++;
    else if (c[o.status] !== undefined) c[o.status]++;
  }
  return out;
}

module.exports = {
  CLAIM_TTL_MS, LOCK_STALE_MS, LOCK_RETRY_MS, LOCK_MAX_WAIT_MS,
  ORE_TYPES, TYPES,
  normalizeOreName, emptyMap, addOres, isClaimActive, claimNext,
  refreshClaim, releaseClaim, markMined, markGone, heartbeat, counts,
};
```

- [ ] **Step 1.4: Vérifier que ça passe**

Run: `cd mc-agent && node --test oremap.test.js`
Expected: PASS (9 tests)

- [ ] **Step 1.5: Commit**

```bash
git add mc-agent/oremap.js mc-agent/oremap.test.js
git commit -m "feat(mc-agent): oremap — logique pure (types, dédup, claims TTL, counts)"
```

---

### Task 2: `oremap.js` — store I/O (lockfile + écriture atomique)

**Files:**
- Modify: `mc-agent/oremap.js` (ajout de la section I/O en bas, avant `module.exports`)
- Test: `mc-agent/oremap.store.test.js`

- [ ] **Step 2.1: Écrire les tests I/O (qui échouent)**

Créer `mc-agent/oremap.store.test.js` :

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore, CLAIM_TTL_MS } = require('./oremap');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oremap-'));
  return path.join(dir, 'oremap-test.json');
}

test('createStore : addOres persiste sur disque, load relit', () => {
  const file = tmpFile();
  const store = createStore(file, { runId: 'r1', zone: { cx: 0, cz: 0, radius: 50 } });
  const added = store.addOres([{ name: 'diamond_ore', x: 1, y: -54, z: 2 }], 'Carto1');
  assert.strictEqual(added, 1);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(onDisk.runId, 'r1');
  assert.strictEqual(onDisk.zone.radius, 50);
  assert.strictEqual(onDisk.ores['1,-54,2'].type, 'diamond');
  assert.ok(onDisk.updatedAt > 0);
  assert.strictEqual(store.load().ores['1,-54,2'].foundBy, 'Carto1');
});

test('deux stores sur le MÊME fichier voient les écritures de l\'autre (multi-process simulé)', () => {
  const file = tmpFile();
  const a = createStore(file, { runId: 'r1' });
  const b = createStore(file, { runId: 'r1' });
  a.addOres([{ name: 'iron_ore', x: 1, y: 0, z: 0 }], 'A');
  b.addOres([{ name: 'iron_ore', x: 2, y: 0, z: 0 }], 'B');
  const m = a.load();
  assert.strictEqual(Object.keys(m.ores).length, 2);  // pas de lost update
});

test('claimNext via store : un seul des deux bots obtient l\'ore', () => {
  const file = tmpFile();
  const a = createStore(file, { runId: 'r1' });
  const b = createStore(file, { runId: 'r1' });
  a.addOres([{ name: 'diamond_ore', x: 5, y: 0, z: 0 }], 'C');
  const oreA = a.claimNext({ type: 'diamond', from: { x: 0, y: 0, z: 0 }, username: 'Res1' });
  const oreB = b.claimNext({ type: 'diamond', from: { x: 0, y: 0, z: 0 }, username: 'Res2' });
  assert.ok(oreA);
  assert.strictEqual(oreB, null);  // claim de Res1 visible et active pour Res2
});

test('markMined + heartbeat + counts via store', () => {
  const file = tmpFile();
  const s = createStore(file, { runId: 'r1' });
  s.addOres([
    { name: 'lapis_ore', x: 1, y: 0, z: 0 },
    { name: 'lapis_ore', x: 2, y: 0, z: 0 },
  ], 'C');
  s.markMined('1,0,0');
  s.heartbeat('Res1', { x: 0, y: 0, z: 0, role: 'resource', quota: { lapis: { have: 4, target: 64 } } });
  const c = s.counts();
  assert.deepStrictEqual(c.lapis, { new: 1, claimed: 0, mined: 1, gone: 0 });
  assert.strictEqual(s.load().bots.Res1.quota.lapis.have, 4);
});

test('lock stale (process mort) : volé après LOCK_STALE_MS, pas de deadlock', () => {
  const file = tmpFile();
  const s = createStore(file, { runId: 'r1' });
  // Simule un lock orphelin ANCIEN (mtime dans le passé)
  fs.mkdirSync(file + '.lock');
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(file + '.lock', past, past);
  const added = s.addOres([{ name: 'iron_ore', x: 1, y: 0, z: 0 }], 'C');  // doit voler le lock
  assert.strictEqual(added, 1);
  assert.ok(!fs.existsSync(file + '.lock'));  // lock relâché après écriture
});

test('fichier corrompu sur disque → load best-effort retourne une map vide (pas de crash)', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{corrompu');
  const s = createStore(file, { runId: 'r1' });
  assert.deepStrictEqual(s.load().ores, {});
  assert.strictEqual(s.addOres([{ name: 'iron_ore', x: 1, y: 0, z: 0 }], 'C'), 1);
});
```

- [ ] **Step 2.2: Vérifier que ça échoue**

Run: `cd mc-agent && node --test oremap.store.test.js`
Expected: FAIL (`createStore is not a function`)

- [ ] **Step 2.3: Ajouter la section I/O dans `mc-agent/oremap.js`** (avant le `module.exports`, et ajouter `createStore` aux exports)

```javascript
// ---------- I/O multi-process : lockfile mkdir (O_EXCL) + écriture atomique ----------

// Sleep SYNCHRONE (on est dans une section critique courte ; pas d'await possible dans
// un read-modify-write qui doit rester atomique vis-à-vis du process courant).
function _sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch (e) { const end = Date.now() + ms; while (Date.now() < end) { /* busy */ } }
}

// Acquiert <file>.lock via mkdirSync (atomique au niveau OS). Lock plus vieux que staleMs
// (process mort) → volé. Au-delà de maxWaitMs → throw (le caller retentera son itération).
function _acquireLock(file, staleMs, maxWaitMs) {
  const lockDir = file + '.lock';
  const deadline = Date.now() + (maxWaitMs || LOCK_MAX_WAIT_MS);
  for (;;) {
    try { fs.mkdirSync(lockDir); return lockDir; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = fs.statSync(lockDir);
        if (Date.now() - st.mtimeMs > (staleMs || LOCK_STALE_MS)) {
          try { fs.rmdirSync(lockDir); } catch (e2) { /* course : un autre l'a volé */ }
          continue;
        }
      } catch (e2) { continue; } // lock disparu entre-temps → retente immédiatement
      if (Date.now() > deadline) throw new Error('oremap_lock_timeout');
      _sleepSync(LOCK_RETRY_MS);
    }
  }
}

function _readMap(file, runId, zone) {
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (m && typeof m === 'object' && m.ores && typeof m.ores === 'object') return m;
  } catch (e) { /* absent ou corrompu → map vide (best-effort) */ }
  return emptyMap(runId, zone);
}

// Écriture atomique : temp + rename (POSIX). Un lecteur (backend Python) voit toujours un
// fichier ENTIER (l'ancien ou le nouveau), jamais un fichier à moitié écrit.
function _writeMapAtomic(file, map) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(map));
  fs.renameSync(tmp, file);
}

// Client store : chaque mutation = read-modify-write SOUS LOCK (zéro lost update entre
// process). La lecture seule (load/counts) se fait SANS lock (rename atomique suffit).
function createStore(file, opts) {
  const { runId, zone, now } = opts || {};
  const clock = now || Date.now;
  function withLock(fn) {
    const lock = _acquireLock(file);
    try {
      const map = _readMap(file, runId, zone);
      if (zone && !map.zone) map.zone = zone;
      const result = fn(map, clock());
      map.updatedAt = clock();
      _writeMapAtomic(file, map);
      return result;
    } finally {
      try { fs.rmdirSync(lock); } catch (e) { /* déjà volé/supprimé */ }
    }
  }
  return {
    file,
    load() { return _readMap(file, runId, zone); },
    addOres(list, foundBy) { return withLock((m, t) => addOres(m, list, foundBy, t)); },
    claimNext(o) { return withLock((m, t) => claimNext(m, Object.assign({ now: t }, o))); },
    refreshClaim(key, username) { return withLock((m, t) => refreshClaim(m, key, username, t)); },
    releaseClaim(key, username) { return withLock((m) => releaseClaim(m, key, username)); },
    markMined(key) { return withLock((m) => markMined(m, key)); },
    markGone(key) { return withLock((m) => markGone(m, key)); },
    heartbeat(username, info) { return withLock((m, t) => heartbeat(m, username, info, t)); },
    counts() { return counts(_readMap(file, runId, zone), clock()); },
  };
}
```

Et dans `module.exports`, ajouter `createStore`.

⚠️ Note pour `claimNext` via store : le caller passe `{type, from, username, skip}` — le `now` est injecté par `withLock`. `Object.assign({ now: t }, o)` laisse le caller surcharger `now` dans les tests si besoin.

- [ ] **Step 2.4: Vérifier que tout passe**

Run: `cd mc-agent && node --test oremap.test.js oremap.store.test.js`
Expected: PASS (15 tests)

- [ ] **Step 2.5: Suite complète (non-régression)**

Run: `cd mc-agent && node --test`
Expected: tous verts (176 existants + 15 nouveaux)

- [ ] **Step 2.6: Commit**

```bash
git add mc-agent/oremap.js mc-agent/oremap.store.test.js
git commit -m "feat(mc-agent): oremap — store I/O multi-process (lockfile mkdir + rename atomique)"
```

---

### Task 3: Skill `surveyArea` (cartographe, record-before-unload)

**Files:**
- Create: `mc-agent/skills/surveyArea.js`
- Modify: `mc-agent/skills/branchMine.js:265` (exporter les helpers anti-lave — additif)
- Test: `mc-agent/skills/surveyArea.test.js`

- [ ] **Step 3.1: Exporter les helpers anti-lave de branchMine (préparation Task 4, additif)**

Dans `mc-agent/skills/branchMine.js`, remplacer la dernière ligne :

```javascript
module.exports = { branchMine, cardinalFromYaw, leftOf };
```

par :

```javascript
// isLava/neighborsHaveLava/wallLava exportés pour resourceQuota (réutilise l'anti-lave).
module.exports = { branchMine, cardinalFromYaw, leftOf, isLava, neighborsHaveLava, wallLava };
```

Run: `cd mc-agent && node --test skills/branchMine.test.js` → Expected: PASS (aucune régression).

- [ ] **Step 3.2: Écrire les tests surveyArea (qui échouent)**

Créer `mc-agent/skills/surveyArea.test.js` :

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { surveyArea, lawnmowerWaypoints, scanLoadedOres } = require('./surveyArea');

// Fake bot minimal : registry avec IDs d'ore, findBlocks mocké, pathfinder qui téléporte.
function makeBot({ oresByWaypoint = {}, findBlocksMissing = false } = {}) {
  const calls = { goto: [], findBlocks: 0 };
  const bot = {
    username: 'Carto1',
    registry: {
      blocksByName: {
        diamond_ore: { id: 1 }, deepslate_diamond_ore: { id: 2 },
        gold_ore: { id: 3 }, deepslate_gold_ore: { id: 4 },
        redstone_ore: { id: 5 }, deepslate_redstone_ore: { id: 6 },
        lapis_ore: { id: 7 }, deepslate_lapis_ore: { id: 8 },
        iron_ore: { id: 9 }, deepslate_iron_ore: { id: 10 },
      },
    },
    entity: { position: { x: 0, y: 64, z: 0 } },
    pathfinder: {
      goto: async (goal) => {
        calls.goto.push({ x: goal.x, z: goal.z });
        bot.entity.position = { x: goal.x, y: 64, z: goal.z };
      },
    },
    findBlocks(opts) {
      calls.findBlocks++;
      const key = `${bot.entity.position.x},${bot.entity.position.z}`;
      return (oresByWaypoint[key] || []).map((o) => ({ x: o.x, y: o.y, z: o.z }));
    },
    blockAt(p) {
      const key = `${bot.entity.position.x},${bot.entity.position.z}`;
      const found = (oresByWaypoint[key] || []).find((o) => o.x === p.x && o.y === p.y && o.z === p.z);
      return found ? { name: found.name, position: p } : { name: 'stone', position: p };
    },
  };
  if (findBlocksMissing) delete bot.findBlocks;
  bot._calls = calls;
  return bot;
}

// Store espion : enregistre les addOres + l'ordre des appels (record-before-unload).
function makeStore() {
  const added = [];
  return {
    added,
    addOres(list, foundBy) { added.push({ list, foundBy }); return list.length; },
    heartbeat() {},
  };
}

test('lawnmowerWaypoints couvre le rectangle en serpentin', () => {
  const wps = lawnmowerWaypoints(0, 0, 24, 24);
  // x ∈ {-24, 0, 24}, z ∈ {-24, 0, 24} → 9 waypoints
  assert.strictEqual(wps.length, 9);
  assert.deepStrictEqual(wps[0], { x: -24, z: -24 });
  assert.deepStrictEqual(wps[2], { x: -24, z: 24 });
  assert.deepStrictEqual(wps[3], { x: 0, z: 24 });   // serpentin : z redescend
  assert.deepStrictEqual(wps[5], { x: 0, z: -24 });
});

test('scanLoadedOres résout les IDs depuis le registry et retourne {name,x,y,z}', () => {
  const bot = makeBot({ oresByWaypoint: { '0,0': [{ name: 'deepslate_diamond_ore', x: 3, y: -54, z: 7 }] } });
  const ores = scanLoadedOres(bot);
  assert.deepStrictEqual(ores, [{ name: 'deepslate_diamond_ore', x: 3, y: -54, z: 7 }]);
});

test('scanLoadedOres tolère un registry partiel (1.20.1 : IDs manquants ignorés) et findBlocks absent', () => {
  const bot = makeBot({});
  delete bot.registry.blocksByName.deepslate_diamond_ore;
  assert.deepStrictEqual(scanLoadedOres(bot), []);
  const noFB = makeBot({ findBlocksMissing: true });
  assert.deepStrictEqual(scanLoadedOres(noFB), []);
});

test('surveyArea balaye, scanne et ENREGISTRE à CHAQUE waypoint (record-before-unload)', async () => {
  const bot = makeBot({
    oresByWaypoint: {
      '-24,-24': [{ name: 'diamond_ore', x: -20, y: -54, z: -20 }],
      '24,24': [{ name: 'iron_ore', x: 20, y: 10, z: 20 }],
    },
  });
  const store = makeStore();
  const events = [];
  const r = await surveyArea(bot, { cx: 0, cz: 0, radius: 24, step: 24, store, emit: (e) => events.push(e) });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.done, 9);
  // 1 scan initial + 1 scan PAR waypoint → les écritures arrivent pendant le balayage,
  // jamais en lot à la fin (sinon les chunks seraient déchargés → données perdues).
  assert.strictEqual(store.added.length, 10);
  assert.strictEqual(r.oresFound, 2);
  assert.ok(events.some((e) => e.type === 'survey_progress'));
  assert.ok(events.some((e) => e.type === 'survey_done'));
});

test('surveyArea : waypoint inatteignable (goto throw) → continue avec le suivant', async () => {
  const bot = makeBot({});
  let first = true;
  bot.pathfinder.goto = async (goal) => {
    if (first) { first = false; throw new Error('no path'); }
    bot.entity.position = { x: goal.x, y: 64, z: goal.z };
  };
  const store = makeStore();
  const r = await surveyArea(bot, { cx: 0, cz: 0, radius: 24, step: 24, store });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.done, 9);  // les 9 waypoints traités malgré l'échec du 1er goto
});

test('surveyArea : token.cancelled interrompt proprement', async () => {
  const bot = makeBot({});
  const store = makeStore();
  const token = { cancelled: false };
  let n = 0;
  bot.pathfinder.goto = async (goal) => {
    n++; if (n === 2) token.cancelled = true;
    bot.entity.position = { x: goal.x, y: 64, z: goal.z };
  };
  const r = await surveyArea(bot, { cx: 0, cz: 0, radius: 24, step: 24, store }, token);
  assert.strictEqual(r.cancelled, true);
  assert.ok(r.done < 9);
});

test('surveyArea sans store → {ok:false, reason:no_store}', async () => {
  const r = await surveyArea(makeBot({}), { cx: 0, cz: 0, radius: 24 });
  assert.deepStrictEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: 'no_store' });
});
```

- [ ] **Step 3.3: Vérifier que ça échoue**

Run: `cd mc-agent && node --test skills/surveyArea.test.js`
Expected: FAIL (`Cannot find module './surveyArea'`)

- [ ] **Step 3.4: Implémenter `mc-agent/skills/surveyArea.js`**

```javascript
'use strict';
// Cartographe : balaye un rectangle centre±rayon en serpentin (lawnmower). À CHAQUE
// waypoint, bot.findBlocks (cache client mineflayer = TOUS les blocs des chunks chargés,
// y compris souterrains) sur les 10 IDs d'ore, et écrit IMMÉDIATEMENT dans le store
// partagé — record-before-unload : les chunks se déchargent dès qu'on s'éloigne, toute
// donnée non écrite est PERDUE (contrainte clé de la spec).
//
// Le pas (step 24) reste sous le rayon de scan (32) → les bandes se recouvrent, pas de
// trou de couverture entre deux waypoints.
const { ORE_TYPES } = require('../oremap');

let goals;
try { goals = require('mineflayer-pathfinder').goals; } catch (e) { goals = null; }

const ORE_BLOCK_NAMES = Object.keys(ORE_TYPES);

// Waypoints en serpentin : colonnes x espacées de `step`, z alterné montant/descendant
// (minimise la distance parcourue entre deux waypoints consécutifs).
function lawnmowerWaypoints(cx, cz, radius, step) {
  const s = step || 24;
  const wps = [];
  let dir = 1;
  for (let x = cx - radius; x <= cx + radius; x += s) {
    if (dir > 0) { for (let z = cz - radius; z <= cz + radius; z += s) wps.push({ x, z }); }
    else { for (let z = cz + radius; z >= cz - radius; z -= s) wps.push({ x, z }); }
    dir = -dir;
  }
  return wps;
}

// Scan best-effort des chunks chargés : résout les IDs depuis le registry (1.20.1 n'a pas
// exactement les mêmes défs que 1.21.4 → IDs absents ignorés), findBlocks → positions,
// blockAt → nom exact (findBlocks ne donne que la position).
function scanLoadedOres(bot, maxDistance, count) {
  if (typeof bot.findBlocks !== 'function') return [];
  const ids = [];
  for (const n of ORE_BLOCK_NAMES) {
    const def = bot.registry.blocksByName[n];
    if (def) ids.push(def.id);
  }
  if (!ids.length) return [];
  let positions;
  try { positions = bot.findBlocks({ matching: ids, maxDistance: maxDistance || 32, count: count || 200 }) || []; }
  catch (e) { return []; }
  const out = [];
  for (const p of positions) {
    const b = bot.blockAt(p);
    if (b && ORE_TYPES[b.name]) out.push({ name: b.name, x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
  }
  return out;
}

function _buildGoal(x, z) {
  if (goals && goals.GoalNearXZ) return new goals.GoalNearXZ(x, z, 8);
  if (goals && goals.GoalXZ) return new goals.GoalXZ(x, z);
  return { x, z }; // fallback POJO pour les tests sans pathfinder réel
}

function _heartbeatSafe(bot, store) {
  try {
    const p = bot.entity.position;
    store.heartbeat(bot.username, { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), role: 'cartographer', quota: null });
  } catch (e) { /* heartbeat best-effort */ }
}

async function surveyArea(bot, opts = {}, token = null) {
  const { cx = 0, cz = 0, radius = 100, step = 24, store, emit = () => {}, scanDistance = 32, scanCount = 200 } = opts;
  if (!store) return { ok: false, reason: 'no_store' };
  const wps = lawnmowerWaypoints(cx, cz, radius, step);
  let oresFound = 0;
  let done = 0;
  // Scan initial : ce que les chunks déjà chargés au spawn contiennent.
  oresFound += store.addOres(scanLoadedOres(bot, scanDistance, scanCount), bot.username);
  for (const wp of wps) {
    if (token && token.cancelled) return { ok: true, cancelled: true, oresFound, done, total: wps.length };
    try { await bot.pathfinder.goto(_buildGoal(wp.x, wp.z)); }
    catch (e) { /* waypoint inatteignable → on scanne quand même là où on est, puis suivant */ }
    // RECORD-BEFORE-UNLOAD : scan + écriture immédiats, à chaque waypoint.
    oresFound += store.addOres(scanLoadedOres(bot, scanDistance, scanCount), bot.username);
    done++;
    _heartbeatSafe(bot, store);
    emit({ type: 'survey_progress', done, total: wps.length, oresFound });
  }
  emit({ type: 'survey_done', oresFound, total: wps.length });
  return { ok: true, oresFound, done, total: wps.length };
}

module.exports = { surveyArea, lawnmowerWaypoints, scanLoadedOres };
```

- [ ] **Step 3.5: Vérifier que ça passe**

Run: `cd mc-agent && node --test skills/surveyArea.test.js skills/branchMine.test.js`
Expected: PASS (7 nouveaux + branchMine inchangé)

- [ ] **Step 3.6: Commit**

```bash
git add mc-agent/skills/surveyArea.js mc-agent/skills/surveyArea.test.js mc-agent/skills/branchMine.js
git commit -m "feat(mc-agent): surveyArea — cartographe lawnmower + findBlocks, record-before-unload"
```

---

### Task 4: Skill `resourceQuota` (claim → goto → mine anti-lave → quota)

**Files:**
- Create: `mc-agent/skills/resourceQuota.js`
- Test: `mc-agent/skills/resourceQuota.test.js`

- [ ] **Step 4.1: Écrire les tests (qui échouent)**

Créer `mc-agent/skills/resourceQuota.test.js` :

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { resourceQuota, pickaxeTier, haveByType, QUOTA_ITEMS, TIER_REQUIRED } = require('./resourceQuota');
const { emptyMap, addOres, claimNext, refreshClaim, releaseClaim, markMined, markGone, heartbeat, counts } = require('../oremap');

// Store en mémoire : même API que createStore mais sans fs (tests rapides, déterministes).
function memStore(initialOres = []) {
  const map = emptyMap('test', null);
  addOres(map, initialOres, 'C', 0);
  let t = 0;
  const tick = () => (t += 1000);
  return {
    map,
    addOres(list, by) { return addOres(map, list, by, tick()); },
    claimNext(o) { return claimNext(map, Object.assign({ now: tick() }, o)); },
    refreshClaim(k, u) { return refreshClaim(map, k, u, tick()); },
    releaseClaim(k, u) { return releaseClaim(map, k, u); },
    markMined(k) { return markMined(map, k); },
    markGone(k) { return markGone(map, k); },
    heartbeat(u, i) { return heartbeat(map, u, i, tick()); },
    counts() { return counts(map, t); },
  };
}

// Fake bot : inventaire mutable, blockAt configurable, mine = ajoute le drop à l'inventaire.
function makeBot({ inv = {}, pickaxe = 'iron_pickaxe', world = {}, digFails = false } = {}) {
  const inventory = Object.assign({}, inv);
  if (pickaxe) inventory[pickaxe] = 1;
  const bot = {
    username: 'Res1',
    entity: { position: { x: 0, y: -50, z: 0 } },
    registry: { blocksByName: {}, itemsByName: {} },
    inventory: {
      items: () => Object.keys(inventory).filter((n) => inventory[n] > 0)
        .map((n) => ({ name: n, count: inventory[n], type: 1 })),
      emptySlotCount: () => 30,
    },
    blockAt(p) {
      const k = `${p.x},${p.y},${p.z}`;
      return world[k] ? { name: world[k], position: p, boundingBox: 'block' } : { name: 'stone', position: p, boundingBox: 'block' };
    },
    equip: async () => {},
    collectBlock: {
      collect: async (block) => {
        if (digFails) throw new Error('dig failed');
        const k = `${block.position.x},${block.position.y},${block.position.z}`;
        const drops = { diamond_ore: 'diamond', deepslate_diamond_ore: 'diamond', iron_ore: 'raw_iron', deepslate_iron_ore: 'raw_iron', gold_ore: 'raw_gold', redstone_ore: 'redstone', lapis_ore: 'lapis_lazuli' };
        const drop = drops[world[k]];
        if (drop) inventory[drop] = (inventory[drop] || 0) + 1;
        delete world[k];
      },
    },
    _inv: inventory,
  };
  return bot;
}

const fastOpts = { goto: async () => {}, sleep: async () => {}, maxIdleRounds: 2 };

test('pickaxeTier : meilleur palier en inventaire (fer=2, pierre=1, aucun=-1)', () => {
  assert.strictEqual(pickaxeTier(makeBot({ pickaxe: 'iron_pickaxe' })), 2);
  assert.strictEqual(pickaxeTier(makeBot({ pickaxe: 'stone_pickaxe' })), 1);
  assert.strictEqual(pickaxeTier(makeBot({ pickaxe: null })), -1);
  assert.strictEqual(pickaxeTier(makeBot({ pickaxe: 'netherite_pickaxe' })), 4);
});

test('haveByType : raw_iron + iron_ingot comptent pour le fer (décision D2)', () => {
  const bot = makeBot({ inv: { raw_iron: 3, iron_ingot: 2, raw_gold: 1, diamond: 4 } });
  const have = haveByType(bot, {});
  assert.strictEqual(have.iron, 5);
  assert.strictEqual(have.gold, 1);
  assert.strictEqual(have.diamond, 4);
  // cumul deposits : le compte ne se perd pas au déposit coffre
  assert.strictEqual(haveByType(bot, { iron: 10 }).iron, 15);
});

test('boucle nominale : claim → goto → mine → markMined, jusqu\'au quota', async () => {
  const world = { '5,-54,0': 'diamond_ore', '8,-54,0': 'diamond_ore' };
  const bot = makeBot({ world });
  const store = memStore([
    { name: 'diamond_ore', x: 5, y: -54, z: 0 },
    { name: 'diamond_ore', x: 8, y: -54, z: 0 },
  ]);
  const events = [];
  const r = await resourceQuota(bot, Object.assign({ quota: { diamond: 2 }, store, emit: (e) => events.push(e) }, fastOpts));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.counts.diamond, 2);
  assert.strictEqual(store.map.ores['5,-54,0'].status, 'mined');
  assert.strictEqual(store.map.ores['8,-54,0'].status, 'mined');
  assert.ok(events.some((e) => e.type === 'ore_mined'));
  assert.ok(events.some((e) => e.type === 'resource_done'));
});

test('entrée stale (bloc absent à l\'arrivée) → markGone, jamais re-tentée', async () => {
  // L'oremap annonce un diamant en 5,-54,0 mais le monde n'a que de la stone (déjà miné).
  const bot = makeBot({ world: { '8,-54,0': 'diamond_ore' } });
  const store = memStore([
    { name: 'diamond_ore', x: 5, y: -54, z: 0 },
    { name: 'diamond_ore', x: 8, y: -54, z: 0 },
  ]);
  const r = await resourceQuota(bot, Object.assign({ quota: { diamond: 1 }, store }, fastOpts));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(store.map.ores['5,-54,0'].status, 'gone');
  assert.strictEqual(store.map.ores['8,-54,0'].status, 'mined');
});

test('goto échoue → releaseClaim + skip local, l\'ore reste prenable par un autre', async () => {
  const bot = makeBot({ world: { '5,-54,0': 'diamond_ore' } });
  const store = memStore([{ name: 'diamond_ore', x: 5, y: -54, z: 0 }]);
  const gotoFail = async () => { throw new Error('no path'); };
  const r = await resourceQuota(bot, { quota: { diamond: 1 }, store, goto: gotoFail, sleep: async () => {}, maxIdleRounds: 2 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'map_exhausted');                  // skip local → plus rien à claim
  assert.strictEqual(store.map.ores['5,-54,0'].claimedBy, null);  // claim relâchée
  assert.strictEqual(store.map.ores['5,-54,0'].status, 'new');    // PAS gone : un autre bot peut réussir
});

test('palier pioche : pioche pierre → diamant/or/redstone SKIPPÉS, lapis/fer minés', async () => {
  const world = { '2,0,0': 'lapis_ore', '4,0,0': 'iron_ore' };
  const bot = makeBot({ pickaxe: 'stone_pickaxe', world });
  const store = memStore([
    { name: 'diamond_ore', x: 9, y: 0, z: 0 },
    { name: 'lapis_ore', x: 2, y: 0, z: 0 },
    { name: 'iron_ore', x: 4, y: 0, z: 0 },
  ]);
  const r = await resourceQuota(bot, Object.assign({ quota: { diamond: 1, lapis: 1, iron: 1 }, store }, fastOpts));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_pickaxe');           // diamant inminable, pas de craft possible
  assert.strictEqual(r.counts.lapis, 1);                // mais lapis et fer ont été minés AVANT
  assert.strictEqual(r.counts.iron, 1);
  assert.strictEqual(store.map.ores['9,0,0'].status, 'new');  // le diamant reste pour un bot équipé
});

test('re-craft pioche : pioche cassée + matos → craft iron_pickaxe et continue', async () => {
  const world = { '5,-54,0': 'diamond_ore' };
  const bot = makeBot({ pickaxe: null, inv: { iron_ingot: 3, stick: 2 }, world });
  const store = memStore([{ name: 'diamond_ore', x: 5, y: -54, z: 0 }]);
  const craft = async (args) => {
    assert.strictEqual(args.name, 'iron_pickaxe');
    bot._inv.iron_pickaxe = 1; bot._inv.iron_ingot -= 3; bot._inv.stick -= 2;
    return { ok: true };
  };
  const r = await resourceQuota(bot, Object.assign({ quota: { diamond: 1 }, store, craft }, fastOpts));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.counts.diamond, 1);
});

test('carte vide → resource_waiting puis map_exhausted après maxIdleRounds', async () => {
  const bot = makeBot({});
  const store = memStore([]);
  const events = [];
  const r = await resourceQuota(bot, Object.assign({ quota: { diamond: 1 }, store, emit: (e) => events.push(e) }, fastOpts));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'map_exhausted');
  assert.ok(events.some((e) => e.type === 'resource_waiting'));
});

test('inventaire plein → deposit, le cumul have ne se perd pas', async () => {
  const world = { '5,0,0': 'iron_ore', '7,0,0': 'iron_ore' };
  const bot = makeBot({ world, inv: { raw_iron: 0 } });
  bot.inventory.emptySlotCount = () => 0;  // toujours plein → deposit après chaque mine
  const store = memStore([
    { name: 'iron_ore', x: 5, y: 0, z: 0 },
    { name: 'iron_ore', x: 7, y: 0, z: 0 },
  ]);
  const deposit = async () => { bot._inv.raw_iron = 0; return { ok: true }; };  // coffre vide l'inventaire
  const r = await resourceQuota(bot, Object.assign({ quota: { iron: 2 }, store, deposit }, fastOpts));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.counts.iron, 2);  // 2 minés : 2 au coffre + 0 en poche = quota atteint
});

test('lave autour de l\'ore non murable → releaseClaim + skip (pas markGone)', async () => {
  const world = { '5,0,0': 'diamond_ore', '6,0,0': 'lava' };
  const bot = makeBot({ world });
  bot.inventory.items = () => [{ name: 'iron_pickaxe', count: 1, type: 1 }];  // pas de cobble → mur impossible
  const store = memStore([{ name: 'diamond_ore', x: 5, y: 0, z: 0 }]);
  const events = [];
  const r = await resourceQuota(bot, Object.assign({ quota: { diamond: 1 }, store, emit: (e) => events.push(e) }, fastOpts));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(store.map.ores['5,0,0'].status, 'new');
  assert.ok(events.some((e) => e.type === 'resource_lava'));
});

test('token.cancelled → arrêt propre + claim relâchée', async () => {
  const world = { '5,0,0': 'diamond_ore' };
  const bot = makeBot({ world });
  const store = memStore([{ name: 'diamond_ore', x: 5, y: 0, z: 0 }]);
  const token = { cancelled: false };
  const gotoCancel = async () => { token.cancelled = true; };
  const r = await resourceQuota(bot, { quota: { diamond: 1 }, store, goto: gotoCancel, sleep: async () => {} }, token);
  assert.strictEqual(r.cancelled, true);
  assert.strictEqual(store.map.ores['5,0,0'].claimedBy, null);
});

test('émet heartbeat avec la progression quota (lisible par le frontend)', async () => {
  const world = { '5,0,0': 'diamond_ore' };
  const bot = makeBot({ world });
  const store = memStore([{ name: 'diamond_ore', x: 5, y: 0, z: 0 }]);
  await resourceQuota(bot, Object.assign({ quota: { diamond: 1 } , store }, fastOpts));
  assert.ok(store.map.bots.Res1);
  assert.strictEqual(store.map.bots.Res1.role, 'resource');
  assert.strictEqual(store.map.bots.Res1.quota.diamond.target, 1);
  assert.strictEqual(store.map.bots.Res1.quota.diamond.have, 1);
});
```

- [ ] **Step 4.2: Vérifier que ça échoue**

Run: `cd mc-agent && node --test skills/resourceQuota.test.js`
Expected: FAIL (`Cannot find module './resourceQuota'`)

- [ ] **Step 4.3: Implémenter `mc-agent/skills/resourceQuota.js`**

```javascript
'use strict';
// Bot ressource : lit l'oremap partagée, claim l'ore la plus proche du type encore
// manquant (priorité diamant→or→redstone→lapis→fer), pathfinde, mine avec l'anti-lave de
// branchMine, recompte, boucle jusqu'à quota. Tout est injectable (goto/deposit/craft/
// sleep) → testable en fake-bot sans pathfinder réel.
//
// Comptage (décision D2) : fer = raw_iron + iron_ingot ; or = raw_gold ; diamant/redstone/
// lapis = items de drop directs. Cumul `deposited` : vider l'inventaire au coffre ne fait
// PAS perdre la progression.
const { bestToolFor } = require('../tools');
const { isLava, neighborsHaveLava, wallLava } = require('./branchMine');
const { ORE_TYPES } = require('../oremap');
const { Vec3 } = require('vec3');

const QUOTA_ITEMS = {
  diamond: ['diamond'],
  gold: ['raw_gold'],
  redstone: ['redstone'],
  lapis: ['lapis_lazuli'],
  iron: ['raw_iron', 'iron_ingot'],
};
const TYPE_PRIORITY = ['diamond', 'gold', 'redstone', 'lapis', 'iron'];
// Palier minimal pour que l'ore DROP (pas juste casser) : 1 = pierre, 2 = fer.
const TIER_REQUIRED = { diamond: 2, gold: 2, redstone: 2, lapis: 1, iron: 1 };
// La pioche en or mine comme le bois (palier 0) — elle ne fait dropper ni fer ni diamant.
const PICKAXE_TIERS = {
  wooden_pickaxe: 0, golden_pickaxe: 0, stone_pickaxe: 1,
  iron_pickaxe: 2, diamond_pickaxe: 3, netherite_pickaxe: 4,
};

function _invCount(bot, names) {
  const set = Array.isArray(names) ? names : [names];
  return ((bot.inventory && bot.inventory.items()) || [])
    .filter((i) => set.indexOf(i.name) !== -1)
    .reduce((s, i) => s + i.count, 0);
}

// Meilleur palier de pioche en inventaire. -1 si aucune pioche.
function pickaxeTier(bot) {
  let best = -1;
  for (const i of (bot.inventory && bot.inventory.items()) || []) {
    const t = PICKAXE_TIERS[i.name];
    if (t !== undefined && t > best) best = t;
  }
  return best;
}

// Progression par type : items en poche + cumul déposé en coffre.
function haveByType(bot, deposited) {
  const out = {};
  for (const t of TYPE_PRIORITY) out[t] = (deposited[t] || 0) + _invCount(bot, QUOTA_ITEMS[t]);
  return out;
}

function _isInventoryFull(bot) {
  if (bot.inventory && typeof bot.inventory.emptySlotCount === 'function') {
    return bot.inventory.emptySlotCount() === 0;
  }
  return false;
}

function _heartbeat(bot, store, targets, have) {
  try {
    const p = bot.entity.position;
    const quota = {};
    for (const t of Object.keys(targets)) quota[t] = { have: Math.min(have[t], targets[t]), target: targets[t] };
    store.heartbeat(bot.username, { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), role: 'resource', quota });
  } catch (e) { /* best-effort */ }
}

// Re-craft une pioche fer si le matos est là (3 lingots + 2 bâtons). craft = craftSmart
// injecté par index.js (gère la table portable).
async function _tryCraftPickaxe(bot, craft) {
  if (!craft) return false;
  if (_invCount(bot, 'iron_ingot') < 3 || _invCount(bot, 'stick') < 2) return false;
  try { const r = await craft({ name: 'iron_pickaxe', count: 1 }); return !!(r && r.ok); }
  catch (e) { return false; }
}

let goals;
try { goals = require('mineflayer-pathfinder').goals; } catch (e) { goals = null; }
// Goto par défaut (si index.js n'injecte pas sa version bornée withTimeout).
async function _defaultGoto(bot, ore) {
  if (!bot.pathfinder || !bot.pathfinder.goto) return;
  const g = goals && goals.GoalNear ? new goals.GoalNear(ore.x, ore.y, ore.z, 2) : { x: ore.x, y: ore.y, z: ore.z };
  await bot.pathfinder.goto(g);
}

async function resourceQuota(bot, opts = {}, token = null) {
  const {
    quota = {}, store, emit = () => {}, deposit = null, craft = null,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    maxIdleRounds = 24, // 24 × 5 s = 2 min sans rien à claim → map_exhausted
  } = opts;
  const gotoFn = opts.goto || ((ore) => _defaultGoto(bot, ore));
  if (!store) return { ok: false, reason: 'no_store' };

  const targets = {};
  for (const t of TYPE_PRIORITY) {
    const n = Number(quota[t]);
    if (n > 0) targets[t] = n;
  }
  if (!Object.keys(targets).length) return { ok: false, reason: 'no_quota' };

  emit({ type: 'resource_start', quota: targets });
  const deposited = {};      // cumul des items déjà déposés en coffre, par type
  const skip = new Set();    // cibles localement infaisables (terrain/lave) — un AUTRE bot peut réussir
  let idleRounds = 0;

  for (;;) {
    if (token && token.cancelled) return { ok: false, cancelled: true, counts: haveByType(bot, deposited) };

    const have = haveByType(bot, deposited);
    _heartbeat(bot, store, targets, have);
    const missing = TYPE_PRIORITY.filter((t) => targets[t] && have[t] < targets[t]);
    if (!missing.length) {
      emit({ type: 'resource_done', counts: have });
      return { ok: true, counts: have };
    }

    // Palier de pioche : on ne vise que les types que la pioche en poche fait DROPPER.
    let minable = missing.filter((t) => TIER_REQUIRED[t] <= pickaxeTier(bot));
    if (!minable.length) {
      if (await _tryCraftPickaxe(bot, craft)) continue;   // pioche fer re-craftée → re-dérive
      emit({ type: 'resource_blocked', reason: 'no_pickaxe', missing });
      return { ok: false, reason: 'no_pickaxe', counts: have };
    }

    // Claim de l'ore la plus proche, types par priorité (diamant d'abord : le plus rare).
    const pos = bot.entity.position;
    let ore = null;
    for (const t of minable) {
      ore = store.claimNext({ type: t, from: { x: pos.x, y: pos.y, z: pos.z }, username: bot.username, skip });
      if (ore) break;
    }
    if (!ore) {
      idleRounds++;
      if (idleRounds >= maxIdleRounds) return { ok: false, reason: 'map_exhausted', counts: have };
      emit({ type: 'resource_waiting', missing });   // les cartographes peuvent encore en ajouter
      await sleep(5000);
      continue;
    }
    idleRounds = 0;
    const key = `${ore.x},${ore.y},${ore.z}`;
    emit({ type: 'resource_target', oreType: ore.type, x: ore.x, y: ore.y, z: ore.z });

    // Déplacement borné (index.js injecte withTimeout 240 s + stopMotion).
    try { await gotoFn(ore); }
    catch (e) {
      store.releaseClaim(key, bot.username);
      skip.add(key);
      emit({ type: 'resource_unreachable', key });
      continue;
    }
    if (token && token.cancelled) {
      store.releaseClaim(key, bot.username);
      return { ok: false, cancelled: true, counts: haveByType(bot, deposited) };
    }
    store.refreshClaim(key, bot.username);   // le goto a pu durer ~TTL → re-arme la claim

    // Entrée stale ? (ore déjà minée par un joueur/bot hors carte)
    const target = new Vec3(ore.x, ore.y, ore.z);
    const block = bot.blockAt(target);
    if (!block || !ORE_TYPES[block.name]) {
      store.markGone(key);
      emit({ type: 'ore_gone', key });
      continue;
    }

    // Anti-lave (helpers branchMine) : mur si possible, sinon on laisse l'ore à un autre.
    const lava = neighborsHaveLava(bot, target);
    if (lava) {
      const walled = await wallLava(bot, lava.ahead);
      if (!walled) {
        store.releaseClaim(key, bot.username);
        skip.add(key);
        emit({ type: 'resource_lava', key });
        continue;
      }
    }

    // Mine + collect (collectBlock ramasse le drop ; cf. branchMine — un drop au sol ne
    // compte pas dans l'inventaire).
    const tool = bestToolFor(bot, block);
    if (tool) { try { await bot.equip(tool, 'hand'); } catch (e) {} }
    try {
      if (bot.collectBlock && bot.collectBlock.collect) await bot.collectBlock.collect(block);
      else await bot.dig(block);
    } catch (e) {
      store.releaseClaim(key, bot.username);
      skip.add(key);
      emit({ type: 'resource_dig_failed', key });
      continue;
    }
    store.markMined(key);
    emit({ type: 'ore_mined', key, oreType: ore.type });

    // Inventaire plein → deposit coffre, cumul préservé dans `deposited`.
    if (deposit && _isInventoryFull(bot)) {
      const before = {};
      for (const t of Object.keys(targets)) before[t] = _invCount(bot, QUOTA_ITEMS[t]);
      let ok = false;
      try { const r = await deposit(bot); ok = !!(r && r.ok); } catch (e) { ok = false; }
      if (ok) for (const t of Object.keys(targets)) deposited[t] = (deposited[t] || 0) + before[t] - _invCount(bot, QUOTA_ITEMS[t]);
      emit({ type: 'resource_deposit', ok });
    }
  }
}

module.exports = { resourceQuota, pickaxeTier, haveByType, QUOTA_ITEMS, TIER_REQUIRED, TYPE_PRIORITY };
```

⚠️ Subtilité comptage deposit : on mesure `before - after` par type autour du deposit réussi → seul ce qui a VRAIMENT quitté l'inventaire est ajouté au cumul (un deposit partiel ne fausse rien).

- [ ] **Step 4.4: Vérifier que ça passe**

Run: `cd mc-agent && node --test skills/resourceQuota.test.js`
Expected: PASS (12 tests)

- [ ] **Step 4.5: Suite Node complète**

Run: `cd mc-agent && node --test`
Expected: tous verts

- [ ] **Step 4.6: Commit**

```bash
git add mc-agent/skills/resourceQuota.js mc-agent/skills/resourceQuota.test.js
git commit -m "feat(mc-agent): resourceQuota — claim/goto/mine anti-lave en boucle jusqu'au quota"
```

---

### Task 5: `index.js` — flags `--zone/--quota/--oremap` + dispatch des 2 objectifs

**Files:**
- Modify: `mc-agent/index.js` (imports l.44, helpers après l.215, branche dans `startAutonomous` l.218)

- [ ] **Step 5.1: Ajouter les imports** (après la ligne 44 `const { branchMine } = ...`)

```javascript
const { surveyArea } = require('./skills/surveyArea');
const { resourceQuota } = require('./skills/resourceQuota');
const { createStore } = require('./oremap');
```

Et modifier la ligne 4 pour récupérer les goals pathfinder :

```javascript
const { pathfinder, Movements, goals: pfGoals } = require('mineflayer-pathfinder');
```

- [ ] **Step 5.2: Ajouter les helpers** (juste avant `async function startAutonomous` l.218)

```javascript
// --- Objectifs oremap (cartographer / resource_quota) : flags --zone --quota --oremap ---
function readJsonArg(p) {
  if (!p) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}
// runId sanitizé : le chemin du store est data/mc_agent_runs/oremap-<runId>.json — aucun
// caractère de traversal possible.
function oremapStorePath() {
  const runId = String(args.oremap || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!runId) return null;
  return path.join(__dirname, '..', 'data', 'mc_agent_runs', `oremap-${runId}.json`);
}
// Goto borné vers une ore : GoalNear range 2 + timeout (pathfinder peut geler à jamais sur
// une cible inatteignable, cf. garde-fou anti-freeze existant).
async function gotoOreBounded(ore) {
  const g = pfGoals && pfGoals.GoalNear ? new pfGoals.GoalNear(ore.x, ore.y, ore.z, 2) : { x: ore.x, y: ore.y, z: ore.z };
  const r = await withTimeout(bot.pathfinder.goto(g), 240000, () => { try { stopMotion(); } catch (e) {} });
  if (r && r.ok === false) throw new Error(r.reason || 'goto_failed');
}

// Boucle des 2 objectifs oremap. Hors planner à chaînes : ce sont des comportements en
// boucle (pas des buts monotones) — même contrat d'events que startAutonomous.
async function startOreObjective(objType, sender) {
  const storePath = oremapStorePath();
  if (!storePath) { emit({ type: 'error', message: 'objectif ' + objType + ' : --oremap <runId> requis' }); return; }
  const zone = readJsonArg(args.zone);
  const store = createStore(storePath, { runId: String(args.oremap), zone: zone || undefined });
  setObjective(world, { type: objType, status: 'in_progress' });
  saveWorld(worldFile, world);
  taskToken = taskCtl.begin('autonomous', stopMotion);
  emit({ type: 'autonomous_start', objective: objType });
  let res;
  if (objType === 'cartographer') {
    const z = zone || {};
    res = await withTimeout(
      surveyArea(bot, { cx: Number(z.cx) || 0, cz: Number(z.cz) || 0, radius: Number(z.radius) || 100, store, emit }, taskToken),
      3600000, () => { try { stopMotion(); } catch (e) {} });
  } else {
    const quota = readJsonArg(args.quota) || {};
    res = await withTimeout(
      resourceQuota(bot, {
        quota, store, emit,
        goto: gotoOreBounded,
        deposit: () => deposit(bot),
        craft: (a) => craftSmart(a),
      }, taskToken),
      7200000, () => { try { stopMotion(); } catch (e) {} });
  }
  if (taskToken.cancelled) return;
  if (res && res.ok) {
    clearObjective(world); saveWorld(worldFile, world);
    if (sender) ackPrivate(sender, doneWord());
    emit({ type: 'autonomous_done' });
  } else {
    emit({ type: 'autonomous_stalled', goal: objType, reason: (res && res.reason) || 'unknown' });
  }
}
```

- [ ] **Step 5.3: Brancher dans `startAutonomous`** — au début de la fonction (l.218), après le calcul de `objType` :

```javascript
async function startAutonomous(sender) {
  // objectif : depuis le world (seedé par le backend/launch), sinon --objective, sinon pioche pierre.
  const objType = (world.objective && world.objective.type) || args.objective || 'stone_pickaxe';
  if (objType === 'cartographer' || objType === 'resource_quota') {
    return startOreObjective(objType, sender);   // boucle dédiée, pas de chaîne planner
  }
  setObjective(world, { type: objType, status: 'in_progress' });
  // ... (reste inchangé)
```

- [ ] **Step 5.4: Valider le parse + non-régression**

Run: `cd mc-agent && node --check index.js && node --test`
Expected: parse OK, tous les tests verts (le dispatch est exercé live en P7 ; la logique des skills est couverte par les Tasks 3-4)

- [ ] **Step 5.5: Commit**

```bash
git add mc-agent/index.js
git commit -m "feat(mc-agent): index — flags --zone/--quota/--oremap + dispatch cartographer/resource_quota"
```

---

### Task 6: Backend — module oremap + flags manager + cleanup

**Files:**
- Create: `backend/bots/mc_agent_oremap.py`
- Modify: `backend/bots/mc_agent_manager.py:139` (VALID_OBJECTIVES), `:142` (signature start_session + sidecars), `:270` (cleanup)
- Test: `backend/bots/tests/test_mc_agent_oremap.py`, ajouts dans `backend/bots/tests/test_mc_agent_manager.py`

- [ ] **Step 6.1: Tests du module oremap Python (qui échouent)**

Créer `backend/bots/tests/test_mc_agent_oremap.py` :

```python
import json

from backend.bots import mc_agent_oremap as om


def _sample_map():
    return {
        "runId": "r1",
        "zone": {"cx": 0, "cz": 0, "radius": 100},
        "updatedAt": 123,
        "ores": {
            "1,-54,2": {"type": "diamond", "x": 1, "y": -54, "z": 2, "status": "new",
                         "claimedBy": None, "claimedAt": 0},
            "3,-54,2": {"type": "diamond", "x": 3, "y": -54, "z": 2, "status": "new",
                         "claimedBy": "Res1", "claimedAt": 1000},
            "5,10,2": {"type": "iron", "x": 5, "y": 10, "z": 2, "status": "mined",
                        "claimedBy": None, "claimedAt": 0},
            "7,10,2": {"type": "iron", "x": 7, "y": 10, "z": 2, "status": "gone",
                        "claimedBy": None, "claimedAt": 0},
        },
        "bots": {"Res1": {"x": 0, "y": -50, "z": 0, "role": "resource", "at": 1000,
                            "quota": {"diamond": {"have": 3, "target": 15}}}},
    }


def test_is_valid_run_id_anti_traversal():
    assert om.is_valid_run_id("carto-abc_123")
    assert not om.is_valid_run_id("../etc/passwd")
    assert not om.is_valid_run_id("a/b")
    assert not om.is_valid_run_id("")
    assert not om.is_valid_run_id(None)
    assert not om.is_valid_run_id("x" * 65)


def test_read_map_ok_et_404(tmp_path):
    p = tmp_path / "oremap-r1.json"
    p.write_text(json.dumps(_sample_map()), encoding="utf-8")
    data = om.read_map(tmp_path, "r1")
    assert data["runId"] == "r1"
    assert om.read_map(tmp_path, "inconnu") is None
    assert om.read_map(tmp_path, "../r1") is None  # run_id invalide → jamais de path construit


def test_read_map_corrompu(tmp_path):
    (tmp_path / "oremap-bad.json").write_text("{pas du json", encoding="utf-8")
    assert om.read_map(tmp_path, "bad") is None


def test_summarize_counts_et_claims():
    s = om.summarize(_sample_map(), now_ms=1000 + 60000)  # claim Res1 encore active (TTL 120 s)
    assert s["counts"]["diamond"] == {"new": 1, "claimed": 1, "mined": 0, "gone": 0}
    assert s["counts"]["iron"] == {"new": 0, "claimed": 0, "mined": 1, "gone": 1}
    claimed = [o for o in s["ores"] if o["claimedBy"]]
    assert len(claimed) == 1 and claimed[0]["claimedBy"] == "Res1"
    assert s["bots"]["Res1"]["quota"]["diamond"]["have"] == 3
    assert s["zone"]["radius"] == 100


def test_summarize_claim_expiree():
    s = om.summarize(_sample_map(), now_ms=1000 + 300000)  # TTL dépassé → plus claimed
    assert s["counts"]["diamond"] == {"new": 2, "claimed": 0, "mined": 0, "gone": 0}
    assert all(o["claimedBy"] is None for o in s["ores"])
```

Run: `pytest backend/bots/tests/test_mc_agent_oremap.py -q` → Expected: FAIL (module inexistant)

- [ ] **Step 6.2: Implémenter `backend/bots/mc_agent_oremap.py`**

```python
"""Lecture de l'oremap partagée (écrite par les bots Node) + agrégats pour l'API.

Le fichier data/mc_agent_runs/oremap-<runId>.json est écrit par les process Node en
rename atomique → on lit SANS lock (on voit toujours un JSON entier). Lecture seule
côté Python : la moindre mutation appartient aux bots.
"""
import json
import re
import time
from pathlib import Path

# Miroir de CLAIM_TTL_MS dans mc-agent/oremap.js.
CLAIM_TTL_MS = 120000

_RUN_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def is_valid_run_id(run_id):
    """Anti path-traversal : le runId est interpolé dans un nom de fichier."""
    return bool(run_id and isinstance(run_id, str) and _RUN_ID_RE.match(run_id))


def read_map(runs_dir, run_id):
    """Charge l'oremap brute. None si runId invalide, fichier absent ou corrompu."""
    if not is_valid_run_id(run_id):
        return None
    path = Path(runs_dir) / f"oremap-{run_id}.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("ores"), dict):
        return None
    return data


def summarize(data, now_ms=None):
    """Vue API : liste d'ores + counts par type/statut + claims actives + bots."""
    if now_ms is None:
        now_ms = int(time.time() * 1000)
    counts = {}
    ores = []
    for entry in data.get("ores", {}).values():
        otype = entry.get("type")
        status = entry.get("status", "new")
        c = counts.setdefault(otype, {"new": 0, "claimed": 0, "mined": 0, "gone": 0})
        claimed_by = entry.get("claimedBy")
        active = bool(claimed_by) and (now_ms - int(entry.get("claimedAt") or 0)) < CLAIM_TTL_MS
        if status == "new":
            c["claimed" if active else "new"] += 1
        elif status in c:
            c[status] += 1
        ores.append({
            "type": otype,
            "x": entry.get("x"), "y": entry.get("y"), "z": entry.get("z"),
            "status": status,
            "claimedBy": claimed_by if (active and status == "new") else None,
        })
    return {
        "runId": data.get("runId"),
        "zone": data.get("zone"),
        "updatedAt": data.get("updatedAt"),
        "counts": counts,
        "ores": ores,
        "bots": data.get("bots", {}),
    }
```

Run: `pytest backend/bots/tests/test_mc_agent_oremap.py -q` → Expected: PASS (5 tests)

- [ ] **Step 6.3: Tests manager (flags + cleanup, qui échouent)** — à AJOUTER en fin de `backend/bots/tests/test_mc_agent_manager.py` (réutiliser le `FakeProc` du fichier) :

```python
def test_valid_objectives_inclut_cartographer_et_resource_quota():
    assert "cartographer" in mgr.VALID_OBJECTIVES
    assert "resource_quota" in mgr.VALID_OBJECTIVES


def test_start_session_zone_quota_oremap_flags(monkeypatch, tmp_path):
    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    captured = {}

    def fake_popen(cmd, **kw):
        captured["cmd"] = cmd
        return FakeProc('{"type":"status","state":"spawned"}\n')

    monkeypatch.setattr(mgr.subprocess, "Popen", fake_popen)
    sid = mgr.start_session(
        "h", 25565, "Carto1", autonomous=True, objective="cartographer",
        zone={"cx": 100, "cz": -200, "radius": 750},
        quota={"diamond": 15, "iron": 64},
        oremap_run_id="carto-run1",
    )
    cmd = captured["cmd"]
    # --zone : sidecar JSON avec le contenu exact
    zp = cmd[cmd.index("--zone") + 1]
    assert json.loads(open(zp).read()) == {"cx": 100, "cz": -200, "radius": 750}
    assert mgr._sessions[sid]["zone_path"] == str(zp)
    # --quota : sidecar JSON
    qp = cmd[cmd.index("--quota") + 1]
    assert json.loads(open(qp).read()) == {"diamond": 15, "iron": 64}
    assert mgr._sessions[sid]["quota_path"] == str(qp)
    # --oremap : runId direct (pas un fichier)
    assert cmd[cmd.index("--oremap") + 1] == "carto-run1"
    # objectif seedé dans le world.json
    wp = cmd[cmd.index("--world") + 1]
    assert json.loads(open(wp).read())["objective"]["type"] == "cartographer"


def test_start_session_oremap_run_id_invalide_ignore(monkeypatch, tmp_path):
    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    captured = {}

    def fake_popen(cmd, **kw):
        captured["cmd"] = cmd
        return FakeProc("")

    monkeypatch.setattr(mgr.subprocess, "Popen", fake_popen)
    mgr.start_session("h", 25565, "U", oremap_run_id="../evil")
    assert "--oremap" not in captured["cmd"]


def test_stop_session_nettoie_zone_et_quota(monkeypatch, tmp_path):
    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(mgr.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(mgr.os, "killpg", lambda pgid, sig: None)
    monkeypatch.setattr(mgr.subprocess, "Popen", lambda cmd, **kw: FakeProc(""))
    sid = mgr.start_session("h", 25565, "U", zone={"cx": 0, "cz": 0, "radius": 10}, quota={"iron": 64})
    zp, qp = mgr._sessions[sid]["zone_path"], mgr._sessions[sid]["quota_path"]
    assert os.path.exists(zp) and os.path.exists(qp)
    mgr.stop_session(sid)
    assert not os.path.exists(zp) and not os.path.exists(qp)


def test_get_oremap_agrege(monkeypatch, tmp_path):
    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path)
    (tmp_path / "oremap-r9.json").write_text(json.dumps({
        "runId": "r9", "zone": None, "updatedAt": 1,
        "ores": {"1,0,0": {"type": "iron", "x": 1, "y": 0, "z": 0, "status": "new",
                              "claimedBy": None, "claimedAt": 0}},
        "bots": {},
    }), encoding="utf-8")
    data = mgr.get_oremap("r9")
    assert data["counts"]["iron"]["new"] == 1
    assert mgr.get_oremap("absent") is None
```

(Si `import json` / `import os` manquent en tête du fichier de tests, les ajouter.)

Run: `pytest backend/bots/tests/test_mc_agent_manager.py -q` → Expected: FAIL (nouveaux tests)

- [ ] **Step 6.4: Modifier `backend/bots/mc_agent_manager.py`**

(a) Import en tête (après les imports existants) :

```python
from backend.bots import mc_agent_oremap
```

(b) Ligne 139 :

```python
VALID_OBJECTIVES = ("stone_pickaxe", "iron_pickaxe", "diamond", "cartographer", "resource_quota")
```

(c) Signature `start_session` (l.142) — ajouter les 3 kwargs en fin :

```python
def start_session(host, port, user, model=None, auth="offline", profile=None, commands=None, policy=None, server_id=None, language="fr", autonomous=False, objective="stone_pickaxe", zone=None, quota=None, oremap_run_id=None):
```

(d) Après le bloc `world_path` (l.188), AVANT `env = dict(os.environ)` :

```python
    # Objectifs oremap : zone/quota = sidecars JSON (pattern --world, nettoyés au stop) ;
    # oremap_run_id = identifiant du store PARTAGÉ entre les sessions d'un même run
    # (passé en valeur directe, le fichier oremap-<runId>.json est créé par les bots).
    zone_path = None
    if zone:
        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        zone_path = RUNS_DIR / f"zone-{sid}.json"
        zone_path.write_text(json.dumps(zone), encoding="utf-8")
        cmd += ["--zone", str(zone_path)]
    quota_path = None
    if quota:
        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        quota_path = RUNS_DIR / f"quota-{sid}.json"
        quota_path.write_text(json.dumps(quota), encoding="utf-8")
        cmd += ["--quota", str(quota_path)]
    if oremap_run_id and mc_agent_oremap.is_valid_run_id(oremap_run_id):
        cmd += ["--oremap", str(oremap_run_id)]
```

(e) Dans le dict `session` (l.204-211), ajouter :

```python
        "zone_path": str(zone_path) if zone_path else None,
        "quota_path": str(quota_path) if quota_path else None,
```

(f) Dans `stop_session` (l.270), étendre le tuple de cleanup :

```python
    for key in ("cmds_path", "policy_path", "world_path", "zone_path", "quota_path"):
```

(g) En fin de fichier, après `list_profiles` :

```python
def get_oremap(run_id):
    """Oremap agrégée pour l'API. None si runId invalide ou fichier absent."""
    data = mc_agent_oremap.read_map(RUNS_DIR, run_id)
    return mc_agent_oremap.summarize(data) if data else None
```

- [ ] **Step 6.5: Vérifier**

Run: `pytest backend/bots/tests/ -q`
Expected: tous verts (108 existants + nouveaux)

- [ ] **Step 6.6: Commit**

```bash
git add backend/bots/mc_agent_oremap.py backend/bots/mc_agent_manager.py backend/bots/tests/test_mc_agent_oremap.py backend/bots/tests/test_mc_agent_manager.py
git commit -m "feat(mc-agent): backend — objectifs oremap, sidecars zone/quota, lecture oremap agrégée"
```

---

### Task 7: Router — StartReq étendu + `GET /api/mc-agent/map/{run_id}`

**Files:**
- Modify: `backend/bots/mc_agent_router.py:20-31` (StartReq), `:76` (run), nouvel endpoint après `/stop/{sid}`
- Test: ajouts dans `backend/bots/tests/test_mc_agent_router.py`

- [ ] **Step 7.1: Tests router (qui échouent)** — à ajouter en fin de `test_mc_agent_router.py`, en réutilisant les fixtures/clients admin et non-admin existants du fichier (les noms exacts sont dans le fichier — typiquement un `client` + override de `get_current_user`) :

```python
def test_run_passe_zone_quota_oremap_au_manager(admin_client, monkeypatch):
    captured = {}

    def fake_start(host, port, user, model=None, auth="offline", profile=None,
                   commands=None, policy=None, server_id=None, language="fr",
                   autonomous=False, objective="stone_pickaxe",
                   zone=None, quota=None, oremap_run_id=None):
        captured.update(zone=zone, quota=quota, oremap_run_id=oremap_run_id, objective=objective)
        return 42

    monkeypatch.setattr(mgr, "start_session", fake_start)
    monkeypatch.setattr(mgr, "has_api_key", lambda: True)
    r = admin_client.post("/api/mc-agent/run", json={
        "host": "h", "user": "Carto1", "autonomous": True, "objective": "cartographer",
        "zone": {"cx": 0, "cz": 0, "radius": 750},
        "quota": {"diamond": 15},
        "oremap_run_id": "run-1",
    })
    assert r.status_code == 200
    assert captured["zone"] == {"cx": 0, "cz": 0, "radius": 750}
    assert captured["quota"] == {"diamond": 15}
    assert captured["oremap_run_id"] == "run-1"
    assert captured["objective"] == "cartographer"


def test_map_endpoint_admin_ok(admin_client, monkeypatch):
    monkeypatch.setattr(mgr, "get_oremap", lambda rid: {"runId": rid, "counts": {}, "ores": [], "bots": {}, "zone": None, "updatedAt": 0})
    r = admin_client.get("/api/mc-agent/map/run-1")
    assert r.status_code == 200
    assert r.json()["runId"] == "run-1"


def test_map_endpoint_404(admin_client, monkeypatch):
    monkeypatch.setattr(mgr, "get_oremap", lambda rid: None)
    assert admin_client.get("/api/mc-agent/map/absent").status_code == 404


def test_map_endpoint_403_non_admin(user_client):
    assert user_client.get("/api/mc-agent/map/run-1").status_code == 403
```

⚠️ Adapter `admin_client`/`user_client`/`mgr` aux fixtures réelles du fichier existant (lire le haut du fichier avant : il y a déjà des tests 403 — copier leur mécanique exacte).

Run: `pytest backend/bots/tests/test_mc_agent_router.py -q` → Expected: FAIL

- [ ] **Step 7.2: Modifier `backend/bots/mc_agent_router.py`**

(a) Champs StartReq (après `objective`, l.30) :

```python
    zone: Optional[dict] = None       # {cx, cz, radius} — objectif cartographer
    quota: Optional[dict] = None      # {type: n} — objectif resource_quota
    oremap_run_id: Optional[str] = None  # store partagé entre les sessions d'un run
```

(b) Appel `start_session` (l.76) :

```python
        sid = mgr.start_session(host, port, user, req.model, auth, profile, commands, policy, server_id=req.server_id, language=language, autonomous=req.autonomous, objective=req.objective, zone=req.zone, quota=req.quota, oremap_run_id=req.oremap_run_id)
```

(c) Nouvel endpoint après `/stop/{sid}` (l.152) :

```python
@router.get("/map/{run_id}")
def oremap(run_id: str, current_user: User = Depends(get_current_user)):
    """Oremap partagée d'un run : positions + counts par type + claims + bots (admin-only)."""
    _require_admin(current_user)
    data = mgr.get_oremap(run_id)
    if data is None:
        raise HTTPException(status_code=404, detail="Oremap introuvable")
    return data
```

- [ ] **Step 7.3: Vérifier**

Run: `pytest backend/bots/tests/ -q`
Expected: tous verts

- [ ] **Step 7.4: Commit**

```bash
git add backend/bots/mc_agent_router.py backend/bots/tests/test_mc_agent_router.py
git commit -m "feat(mc-agent): endpoint GET /api/mc-agent/map/{runId} + zone/quota/oremap dans /run"
```

---

### Task 8: Frontend — canvas oremap + barres quota + i18n + cache-bust

**Files:**
- Modify: `frontend/js/bots_module.js` (UI lancement l.1096-1105, section carte après l.1122, fonctions + `unload`)
- Modify: `frontend/js/lang.js` (clés `mcagent.oremap_*` ×3 langues)
- Modify: `frontend/index.html:90,104` (`lang.js?v=215`, `bots_module.js?v=215`)
- Modify: `frontend/sw.js:10` (`CACHE_NAME = 'omenserver-v94'`)

Pas de test automatisé ici (vanilla DOM) — validation : `node --check` du parse + vérif visuelle Chrome MCP en P7. ⚠️ Piège #28 : après l'édition, TOUJOURS valider le parse.

- [ ] **Step 8.1: i18n** — dans `frontend/js/lang.js`, ajouter dans CHAQUE langue à côté des clés `mcagent.*` existantes (mêmes objets) :

FR : `oremap_title: "Carte des minerais"`, `oremap_show: "Afficher la carte"`, `oremap_hide: "Masquer la carte"`, `oremap_runid: "Run ID partagé"`, `oremap_zone: "Zone (centre X, centre Z, rayon)"`, `oremap_nodata: "Pas encore de données pour ce run"`, `oremap_bots: "Bots"`, `obj_carto: "Cartographe (remplit la carte)"`, `obj_quota: "Bot ressources (quotas)"`.
EN : `"Ore map"`, `"Show map"`, `"Hide map"`, `"Shared run ID"`, `"Zone (center X, center Z, radius)"`, `"No data for this run yet"`, `"Bots"`, `"Cartographer (fills the map)"`, `"Resource bot (quotas)"`.
IT : `"Mappa dei minerali"`, `"Mostra mappa"`, `"Nascondi mappa"`, `"Run ID condiviso"`, `"Zona (centro X, centro Z, raggio)"`, `"Ancora nessun dato per questo run"`, `"Bot"`, `"Cartografo (riempie la mappa)"`, `"Bot risorse (quote)"`.

(Suivre la structure exacte du fichier : si les clés mcagent sont à plat `'mcagent.obj_diamond': "..."`, faire pareil ; si imbriquées, imbriquer.)

- [ ] **Step 8.2: UI lancement** — dans `bots_module.js`, (a) ajouter 2 options au `<select id="mca-objective">` (l.1098-1102) :

```html
<option value="cartographer">${Lang.t('mcagent.obj_carto')}</option>
<option value="resource_quota">${Lang.t('mcagent.obj_quota')}</option>
```

(b) Juste après le `</select>` de l'objectif, ajouter le bloc de config oremap (caché par défaut) :

```html
<div id="mca-oremap-cfg" style="display:none;margin-bottom:12px;">
  <label class="form-label">${Lang.t('mcagent.oremap_runid')}</label>
  <input id="mca-oremap-runid" class="form-input" placeholder="carto-1" style="max-width:200px;margin-bottom:8px;" />
  <label class="form-label">${Lang.t('mcagent.oremap_zone')}</label>
  <div style="display:flex;gap:8px;">
    <input id="mca-zone-cx" class="form-input" placeholder="0" style="max-width:90px;" />
    <input id="mca-zone-cz" class="form-input" placeholder="0" style="max-width:90px;" />
    <input id="mca-zone-radius" class="form-input" placeholder="750" style="max-width:90px;" />
  </div>
</div>
```

(c) Sur le `<select id="mca-objective">`, ajouter `onchange="BotsModule.toggleOremapCfg()"`, et la méthode :

```javascript
toggleOremapCfg() {
  const obj = (document.getElementById('mca-objective') || {}).value;
  const cfg = document.getElementById('mca-oremap-cfg');
  if (cfg) cfg.style.display = (obj === 'cartographer' || obj === 'resource_quota') ? '' : 'none';
},
```

(d) Dans `startMCAgent()` (l.1206-1218), après la lecture de `objective`, enrichir `bodyData` :

```javascript
if (objective === 'cartographer' || objective === 'resource_quota') {
  const runId = ((document.getElementById('mca-oremap-runid') || {}).value || '').trim();
  if (!runId) { Toast.error((Lang.t('mcagent.oremap_runid') || 'Run ID')); return; }
  bodyData.oremap_run_id = runId;
  bodyData.zone = {
    cx: parseInt((document.getElementById('mca-zone-cx') || {}).value, 10) || 0,
    cz: parseInt((document.getElementById('mca-zone-cz') || {}).value, 10) || 0,
    radius: parseInt((document.getElementById('mca-zone-radius') || {}).value, 10) || 750,
  };
  if (objective === 'resource_quota') {
    bodyData.quota = { diamond: 15, gold: 15, redstone: 64, lapis: 64, iron: 64 };
  }
  const mapInput = document.getElementById('mca-map-runid');
  if (mapInput && !mapInput.value) mapInput.value = runId;   // pré-remplit la carte
}
```

(Vérifier comment les toasts sont appelés ailleurs dans le fichier — `Toast.error(...)` ou autre — et copier le pattern exact.)

- [ ] **Step 8.3: Section carte** — après le bloc transcript (l.1122-1126), ajouter :

```html
<div style="margin-top:16px;">
  <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">
    <span style="font-weight:600;">${Lang.t('mcagent.oremap_title')}</span>
    <input id="mca-map-runid" class="form-input" placeholder="carto-1" style="max-width:160px;" />
    <button id="mca-map-toggle" class="btn btn-secondary btn-sm" onclick="BotsModule.toggleOremap()">${Lang.t('mcagent.oremap_show')}</button>
  </div>
  <div id="mca-oremap-wrap" style="display:none;">
    <canvas id="mca-oremap-canvas" width="640" height="640" style="width:100%;max-width:640px;background:var(--bg-elev-3);border:1px solid var(--border);border-radius:8px;"></canvas>
    <div id="mca-oremap-legend" style="display:flex;gap:14px;flex-wrap:wrap;font-size:12px;margin-top:6px;font-family:var(--font-mono);"></div>
    <div id="mca-oremap-quotas" style="margin-top:10px;"></div>
  </div>
</div>
```

- [ ] **Step 8.4: Fonctions de rendu** — ajouter à `BotsModule` :

```javascript
_oremapTimer: null,
OREMAP_COLORS: { diamond: '#4FD1C5', gold: '#FACC15', redstone: '#F87171', lapis: '#60A5FA', iron: '#D4B896' },

toggleOremap() {
  const wrap = document.getElementById('mca-oremap-wrap');
  const btn = document.getElementById('mca-map-toggle');
  if (!wrap) return;
  if (this._oremapTimer) {
    clearInterval(this._oremapTimer); this._oremapTimer = null;
    wrap.style.display = 'none';
    if (btn) btn.textContent = Lang.t('mcagent.oremap_show');
    return;
  }
  wrap.style.display = '';
  if (btn) btn.textContent = Lang.t('mcagent.oremap_hide');
  this._pollOremap();
  this._oremapTimer = setInterval(() => this._pollOremap(), 3000);
},

async _pollOremap() {
  const runId = ((document.getElementById('mca-map-runid') || {}).value || '').trim();
  if (!runId) return;
  try {
    const r = await Auth.apiCall(`/api/mc-agent/map/${encodeURIComponent(runId)}`);
    if (!r.ok) {
      const legend = document.getElementById('mca-oremap-legend');
      if (legend) legend.textContent = Lang.t('mcagent.oremap_nodata');
      return;
    }
    this._renderOremap(await r.json());
  } catch (e) { /* poll silencieux */ }
},

_renderOremap(data) {
  const canvas = document.getElementById('mca-oremap-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  // Bornes : zone si dispo, sinon bounding box des ores.
  let x0, z0, span;
  if (data.zone && data.zone.radius) {
    x0 = data.zone.cx - data.zone.radius; z0 = data.zone.cz - data.zone.radius;
    span = data.zone.radius * 2 || 1;
  } else if (data.ores && data.ores.length) {
    const xs = data.ores.map(o => o.x), zs = data.ores.map(o => o.z);
    x0 = Math.min(...xs); z0 = Math.min(...zs);
    span = Math.max(Math.max(...xs) - x0, Math.max(...zs) - z0, 1);
  } else { x0 = 0; z0 = 0; span = 1; }
  const sc = Math.min(W, H) / (span + 1);
  const px = (x) => (x - x0) * sc;
  const pz = (z) => (z - z0) * sc;
  // Ores : un point par position (gris si mined/gone, anneau si claimed).
  for (const o of data.ores || []) {
    const dead = o.status !== 'new';
    ctx.fillStyle = dead ? '#3F3F46' : (this.OREMAP_COLORS[o.type] || '#FFFFFF');
    ctx.fillRect(px(o.x) - 1.5, pz(o.z) - 1.5, 3, 3);
    if (o.claimedBy) {
      ctx.strokeStyle = '#F4F4F5';
      ctx.strokeRect(px(o.x) - 3, pz(o.z) - 3, 6, 6);
    }
  }
  // Bots : triangle + nom.
  for (const name of Object.keys(data.bots || {})) {
    const b = data.bots[name];
    const bx = px(b.x), bz = pz(b.z);
    ctx.fillStyle = b.role === 'cartographer' ? '#C084FC' : '#4ADE80';
    ctx.beginPath();
    ctx.moveTo(bx, bz - 6); ctx.lineTo(bx - 5, bz + 4); ctx.lineTo(bx + 5, bz + 4);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#F4F4F5';
    ctx.font = '10px var(--font-mono, monospace)';
    ctx.fillText(name, bx + 7, bz + 3);
  }
  // Légende : counts par type.
  const legend = document.getElementById('mca-oremap-legend');
  if (legend) {
    legend.innerHTML = Object.keys(this.OREMAP_COLORS).map((t) => {
      const c = (data.counts || {})[t] || { new: 0, claimed: 0, mined: 0, gone: 0 };
      return `<span><span style="display:inline-block;width:9px;height:9px;background:${this.OREMAP_COLORS[t]};border-radius:2px;margin-right:4px;"></span>${t} ${c.new + c.claimed}/${c.mined}⛏</span>`;
    }).join('');
  }
  // Barres de quota par bot ressource.
  const quotas = document.getElementById('mca-oremap-quotas');
  if (quotas) {
    let html = '';
    for (const name of Object.keys(data.bots || {})) {
      const b = data.bots[name];
      if (b.role !== 'resource' || !b.quota) continue;
      html += `<div style="margin-bottom:8px;"><span style="font-family:var(--font-mono);font-size:12px;">${name}</span>`;
      for (const t of Object.keys(b.quota)) {
        const q = b.quota[t];
        const pct = Math.min(100, Math.round((q.have / (q.target || 1)) * 100));
        html += `<div style="display:flex;align-items:center;gap:8px;margin-top:2px;">
          <span style="width:70px;font-size:11px;color:var(--text-muted);">${t}</span>
          <div style="flex:1;height:8px;background:var(--bg-elev-3);border-radius:4px;overflow:hidden;">
            <div style="width:${pct}%;height:100%;background:${this.OREMAP_COLORS[t] || 'var(--accent)'};"></div>
          </div>
          <span style="font-family:var(--font-mono);font-size:11px;">${q.have}/${q.target}</span>
        </div>`;
      }
      html += `</div>`;
    }
    quotas.innerHTML = html;
  }
},
```

Et dans `unload()` du module (le trouver — il cleare déjà d'autres intervals) :

```javascript
if (this._oremapTimer) { clearInterval(this._oremapTimer); this._oremapTimer = null; }
```

- [ ] **Step 8.5: Cache-bust** — `frontend/index.html` : `lang.js?v=215` (l.90), `bots_module.js?v=215` (l.104). `frontend/sw.js:10` : `CACHE_NAME = 'omenserver-v94'`.

- [ ] **Step 8.6: Valider le parse (piège #28)**

Run: `node -e "new Function(require('fs').readFileSync('frontend/js/bots_module.js','utf8'))" && node -e "new Function(require('fs').readFileSync('frontend/js/lang.js','utf8'))"`
Expected: aucune sortie (parse OK)

- [ ] **Step 8.7: Commit**

```bash
git add frontend/js/bots_module.js frontend/js/lang.js frontend/index.html frontend/sw.js
git commit -m "feat(mc-agent): UI carte oremap canvas + barres quota + i18n FR/EN/IT + cache-bust"
```

---

### Task 9: Orchestrateur K cartographes + M bots ressources

**Files:**
- Create: `backend/bots/mc_agent_orchestrate.py` (helpers purs + CLI stdlib)
- Test: `backend/bots/tests/test_mc_agent_orchestrate.py`

- [ ] **Step 9.1: Tests des helpers purs (qui échouent)**

Créer `backend/bots/tests/test_mc_agent_orchestrate.py` :

```python
from backend.bots.mc_agent_orchestrate import quadrants, coverage_ok


def test_quadrants_decoupe_la_zone_en_4():
    qs = quadrants(0, 0, 750)
    assert len(qs) == 4
    assert {"cx": -375, "cz": -375, "radius": 375} in qs
    assert {"cx": 375, "cz": 375, "radius": 375} in qs
    # l'union des quadrants couvre exactement la zone d'origine
    for q in qs:
        assert abs(q["cx"]) + q["radius"] == 750
        assert abs(q["cz"]) + q["radius"] == 750


def test_coverage_ok_avec_marge():
    quota = {"diamond": 15, "iron": 64}
    # 2 bots × quotas × 1.5 de marge : diamant 45, fer 192
    counts_insuffisant = {"diamond": {"new": 44, "claimed": 0}, "iron": {"new": 200, "claimed": 0}}
    counts_suffisant = {"diamond": {"new": 40, "claimed": 5}, "iron": {"new": 192, "claimed": 0}}
    assert not coverage_ok(counts_insuffisant, quota, bots=2, margin=1.5)
    assert coverage_ok(counts_suffisant, quota, bots=2, margin=1.5)  # new + claimed comptent


def test_coverage_ok_type_absent_de_la_carte():
    assert not coverage_ok({}, {"diamond": 15}, bots=1, margin=1.5)
```

Run: `pytest backend/bots/tests/test_mc_agent_orchestrate.py -q` → Expected: FAIL

- [ ] **Step 9.2: Implémenter `backend/bots/mc_agent_orchestrate.py`**

```python
"""Orchestrateur du run carto→ressources : K cartographes (quadrants), poll de la carte,
lancement des M bots ressources EN PARALLÈLE dès couverture suffisante (sans attendre la
fin des cartographes — le but du parallélisme : voir plusieurs problèmes à la fois).

Usage (sur l'Omen, checkout de test, backend local) :
    python3 -m backend.bots.mc_agent_orchestrate \
        --base http://127.0.0.1:8000 --token <JWT admin> \
        --host <ip mc> --port 25565 --run-id carto-1 \
        --cx 0 --cz 0 --radius 750 --cartographers 4 --resource-bots 2
"""
import argparse
import json
import sys
import time
import urllib.request

DEFAULT_QUOTA = {"diamond": 15, "gold": 15, "redstone": 64, "lapis": 64, "iron": 64}


def quadrants(cx, cz, radius):
    """Découpe centre±radius en 4 sous-zones (1 cartographe chacune)."""
    h = radius // 2
    return [
        {"cx": cx - h, "cz": cz - h, "radius": radius - h},
        {"cx": cx + h, "cz": cz - h, "radius": radius - h},
        {"cx": cx - h, "cz": cz + h, "radius": radius - h},
        {"cx": cx + h, "cz": cz + h, "radius": radius - h},
    ]


def coverage_ok(counts, quota, bots, margin=1.5):
    """True si la carte contient assez d'ores dispo (new + claimed) pour couvrir
    quota × bots × margin pour CHAQUE type demandé."""
    for otype, target in quota.items():
        c = counts.get(otype) or {}
        avail = int(c.get("new") or 0) + int(c.get("claimed") or 0)
        if avail < target * bots * margin:
            return False
    return True


def _api(base, token, path, payload=None):
    req = urllib.request.Request(
        base.rstrip("/") + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST" if payload is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--token", required=True)
    ap.add_argument("--host", required=True)
    ap.add_argument("--port", type=int, default=25565)
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--cx", type=int, default=0)
    ap.add_argument("--cz", type=int, default=0)
    ap.add_argument("--radius", type=int, default=750)
    ap.add_argument("--cartographers", type=int, default=4)
    ap.add_argument("--resource-bots", type=int, default=2)
    ap.add_argument("--margin", type=float, default=1.5)
    ap.add_argument("--poll", type=int, default=15)
    args = ap.parse_args(argv)

    quota = DEFAULT_QUOTA
    zones = quadrants(args.cx, args.cz, args.radius)[: args.cartographers]
    carto_sids = []
    for i, z in enumerate(zones):
        r = _api(args.base, args.token, "/api/mc-agent/run", {
            "host": args.host, "port": args.port, "user": f"Carto{i + 1}",
            "autonomous": True, "objective": "cartographer",
            "zone": z, "oremap_run_id": args.run_id,
        })
        carto_sids.append(r["session_id"])
        print(f"[carto] Carto{i + 1} sid={r['session_id']} zone={z}", flush=True)
        time.sleep(4.5)  # étalement anti-burst (cf. prior art mappers)

    # Poll la carte ; lance les bots ressources dès la couverture atteinte.
    res_sids = []
    while not res_sids:
        time.sleep(args.poll)
        try:
            m = _api(args.base, args.token, f"/api/mc-agent/map/{args.run_id}")
        except Exception as exc:  # carte pas encore créée
            print(f"[map] pas encore de carte ({exc})", flush=True)
            continue
        print(f"[map] counts={m['counts']}", flush=True)
        if coverage_ok(m["counts"], quota, bots=args.resource_bots, margin=args.margin):
            for i in range(args.resource_bots):
                r = _api(args.base, args.token, "/api/mc-agent/run", {
                    "host": args.host, "port": args.port, "user": f"Res{i + 1}",
                    "autonomous": True, "objective": "resource_quota",
                    "quota": quota, "oremap_run_id": args.run_id,
                    "zone": {"cx": args.cx, "cz": args.cz, "radius": args.radius},
                })
                res_sids.append(r["session_id"])
                print(f"[res] Res{i + 1} sid={r['session_id']}", flush=True)
                time.sleep(4.5)

    # Surveillance : statut + progression par bot jusqu'à quota (ou Ctrl+C).
    while True:
        time.sleep(args.poll)
        try:
            m = _api(args.base, args.token, f"/api/mc-agent/map/{args.run_id}")
            for name, b in (m.get("bots") or {}).items():
                if b.get("role") == "resource" and b.get("quota"):
                    prog = " ".join(f"{t}:{q['have']}/{q['target']}" for t, q in b["quota"].items())
                    print(f"[quota] {name} {prog}", flush=True)
            done = [name for name, b in (m.get("bots") or {}).items()
                    if b.get("role") == "resource" and b.get("quota")
                    and all(q["have"] >= q["target"] for q in b["quota"].values())]
            if done and len(done) >= args.resource_bots:
                print(f"[done] quotas atteints : {done}", flush=True)
                return 0
        except KeyboardInterrupt:
            return 1
        except Exception as exc:
            print(f"[warn] {exc}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 9.3: Vérifier**

Run: `pytest backend/bots/tests/test_mc_agent_orchestrate.py -q && pytest backend/bots/tests/ -q`
Expected: tous verts

- [ ] **Step 9.4: Commit**

```bash
git add backend/bots/mc_agent_orchestrate.py backend/bots/tests/test_mc_agent_orchestrate.py
git commit -m "feat(mc-agent): orchestrateur K cartographes (quadrants) + M bots ressources (couverture ×1.5)"
```

---

### Task 10: Suites complètes + doc

- [ ] **Step 10.1: Tout vert**

Run: `cd mc-agent && node --test && cd .. && pytest backend/bots/tests/ -q`
Expected: 100 % verts (≈176+34 Node, ≈108+12 Python)

- [ ] **Step 10.2: Commit doc plan coché** (mettre à jour les checkboxes de CE fichier au fil de l'exécution)

```bash
git add docs/superpowers/plans/2026-06-05-mc-agent-oremap-quota.md
git commit -m "docs(mc-agent): plan oremap-quota exécuté (P1-P6 code + tests)"
```

---

### Task 11 (P7, live — exécutée par l'orchestrateur principal, PAS par un subagent)

Hors scope subagents : SSH Omen (IP via omenserver.org → module Réseau), checkout dédié `~/mc-agent-carto-test` (hors auto-deploy), serveur docker `omen-minecraft-trusted-test`, zone fraîche (piège #41), op + give pioches fer aux bots ressources via rcon-cli, run `mc_agent_orchestrate`, surveillance `/active` + `/status` + `/chat` + `/map`, vérif UI omenserver.org via Chrome MCP (skill verify-ui), `.carto-build-report.md` + CLAUDE.md + Daily note Obsidian.
