# Mappeur terre-only + traversée océan bateau — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Le mappeur ne cartographie que la terre, traverse les océans en bateau crafté (juste traverser, cap vers le large), et s'étend en continu sur plusieurs landmasses jusqu'à l'arrêt manuel.

**Architecture:** On remplace le ciblage frontière à l'aveugle (`nextFrontierCell` + warp `/spreadplayers`) par : (1) marche vers la terre perçue proche (`nextLandLeg`, bornée, jamais l'océan) ; (2) quand la terre locale est épuisée, traversée bateau vers le large (`boat.js`). Décisions PURES testables + actions bot best-effort validées live. Skip de l'émission biome océan → carte terre-only.

**Tech Stack:** Node.js (mineflayer), tests `node:test` (fake bot + samplers injectés, modèle = `mapper.test.js`). Aucune nouvelle dépendance. Spec : `docs/superpowers/specs/2026-07-15-mc-mapper-land-only-boat-crossing-design.md`.

**Worktree :** `feat/mc-mapper-boat-crossing` (déjà créé, base `origin/main` `7d2a7f6`). ⚠️ Symlinker `node_modules` pour les tests : `ln -s "/Users/massimiliano/omenserver Project/Projet serveur/mc-agent/node_modules" mc-agent/node_modules` (gitignoré, ne jamais `git add -A` — cf. piège #42h).

**Fichiers :**
- `mc-agent/frontier.js` (+`.test.js`) — `nextLandLeg` (terre-only bornée).
- `mc-agent/boat.js` (+`.test.js`) — **nouveau** : décisions pures + actions bateau.
- `mc-agent/mapper.js` (+`.test.js`) — intégration boucle + skip biome océan.
- `mc-agent/index.js` — câblage `boat`/centroïde/sampleBlock, retrait warp du mapping.

---

### Task 1: `nextLandLeg` — frontière terre-only bornée

**Files:**
- Modify: `mc-agent/frontier.js` (ajout fonction + export)
- Test: `mc-agent/frontier.test.js`

- [ ] **Step 1: Écrire le test qui échoue**

Ajouter à `mc-agent/frontier.test.js` (importer `nextLandLeg` en haut : `const { GRID, cellKey, coveredCells, nextFrontierCell, nextLandLeg } = require('./frontier');`) :

```js
test('nextLandLeg : ignore les cases océan, renvoie la seule terre, null si tout est océan', () => {
  // (64,64) → cellKey '0,0' couvert ; from = centre de la cellule (0,0)
  const memory = { worlds: { overworld: { biomes: [{ name: 'plains', x: 64, z: 64 }] } } };
  const from = { x: 64, y: 64, z: 64 };
  // seule cellule NON-océan = (0,128) [clé '0,128'] ; tout le reste = océan
  const isOcean = (gx, gz) => !(gx === 0 && gz === 128);
  const cell = nextLandLeg(memory, 'overworld', new Set(), from, { isOcean });
  assert.ok(cell, 'doit trouver la terre');
  assert.strictEqual(cell.key, '0,128');
  // tout océan → null (→ le mapper déclenchera la traversée bateau)
  assert.strictEqual(nextLandLeg(memory, 'overworld', new Set(), from, { isOcean: () => true }), null);
});
```

- [ ] **Step 2: Lancer le test → échec**

Run: `cd mc-agent && node --test --test-name-pattern="nextLandLeg" frontier.test.js`
Expected: FAIL — `nextLandLeg is not a function`.

- [ ] **Step 3: Implémenter `nextLandLeg`**

Dans `mc-agent/frontier.js`, après `nextFrontierCell`, ajouter :

```js
/**
 * Prochaine cellule NON couverte la plus proche de `from` qui est de la TERRE, dans un rayon
 * BORNÉ (pas de ciblage à l'aveugle des cases lointaines). opts = { grid, maxRing (défaut 4 ≈
 * 512 blocs), skip: Set, isOcean: (gx,gz)=>bool }. → { key, center, ring } | null si aucune terre
 * locale (→ le mapper passe en traversée bateau).
 */
function nextLandLeg(memory, worldKey, localSeen, from, opts = {}) {
  const grid = opts.grid || GRID;
  const maxRing = opts.maxRing != null ? opts.maxRing : 4;
  const skip = opts.skip || null;
  const isOcean = opts.isOcean || (() => false);
  if (!from) return null;
  const covered = coveredCells(memory, worldKey, localSeen, grid);
  const cx = Math.floor(from.x / grid);
  const cz = Math.floor(from.z / grid);
  for (let ring = 0; ring <= maxRing; ring++) {
    let best = null, bestD = Infinity;
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dz = -ring; dz <= ring; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
        const gx = (cx + dx) * grid, gz = (cz + dz) * grid;
        const key = gx + ',' + gz;
        if (covered.has(key)) continue;
        if (skip && skip.has(key)) continue;
        if (isOcean(gx, gz)) continue;                 // terre-only
        const center = { x: gx + grid / 2, z: gz + grid / 2 };
        const d = (center.x - from.x) ** 2 + (center.z - from.z) ** 2;
        if (d < bestD) { bestD = d; best = { key, center, ring }; }
      }
    }
    if (best) return best;
  }
  return null;
}
```

Mettre à jour l'export en bas : `module.exports = { GRID, cellKey, coveredCells, nextFrontierCell, nextLandLeg };`

- [ ] **Step 4: Lancer le test → passe**

Run: `cd mc-agent && node --test --test-name-pattern="nextLandLeg" frontier.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mc-agent/frontier.js mc-agent/frontier.test.js
git commit -m "feat(mc-mapper): nextLandLeg — frontière terre-only bornée (jamais l'océan)"
```

---

### Task 2: `boat.js` — décisions pures (heading, détection côte, coincement)

**Files:**
- Create: `mc-agent/boat.js`
- Test: `mc-agent/boat.test.js`

- [ ] **Step 1: Écrire les tests qui échouent**

Créer `mc-agent/boat.test.js` :

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { outwardHeading, landAhead, boatStuck } = require('./boat');

test('outwardHeading : pointe à l’opposé du centroïde mappé', () => {
  const h = outwardHeading({ x: 100, z: 100 }, { x: 0, z: 0 }, null, () => 0.5);
  assert.ok(Math.abs(h - Math.atan2(100, 100)) < 1e-6);   // ~π/4 (NE)
});

test('outwardHeading : au centre exact → cap tiré (pas de NaN)', () => {
  const h = outwardHeading({ x: 0, z: 0 }, { x: 0, z: 0 }, null, () => 0.25);
  assert.ok(Number.isFinite(h) && h >= 0 && h < Math.PI * 2);
});

test('landAhead : détecte la côte (eau puis sol solide au cap +x)', () => {
  const sampler = (x, y, z) => {
    if (y > 64) return { name: 'air', boundingBox: 'empty' };
    if (x < 20) return { name: 'water', boundingBox: 'empty' };
    return { name: 'stone', boundingBox: 'block' };
  };
  const r = landAhead(sampler, { x: 0, y: 64, z: 0 }, 0, { reach: 40, step: 4 });
  assert.strictEqual(r.found, true);
  assert.ok(r.pos.x >= 20 && r.pos.x <= 24);
});

test('landAhead : océan à perte de vue → found:false', () => {
  const sampler = (x, y, z) => (y > 64 ? { name: 'air', boundingBox: 'empty' } : { name: 'water', boundingBox: 'empty' });
  assert.strictEqual(landAhead(sampler, { x: 0, y: 64, z: 0 }, 0, { reach: 40, step: 4 }).found, false);
});

test('boatStuck : immobile assez longtemps → true ; bouge ou trop tôt → false', () => {
  assert.strictEqual(boatStuck({ x: 0, z: 0 }, { x: 0, z: 0 }, 12000), true);
  assert.strictEqual(boatStuck({ x: 0, z: 0 }, { x: 10, z: 0 }, 12000), false);
  assert.strictEqual(boatStuck({ x: 0, z: 0 }, { x: 0, z: 0 }, 5000), false);
});
```

- [ ] **Step 2: Lancer → échec**

Run: `cd mc-agent && node --test boat.test.js`
Expected: FAIL — `Cannot find module './boat'`.

- [ ] **Step 3: Implémenter les décisions pures**

Créer `mc-agent/boat.js` :

```js
'use strict';
// Traversée d'océan en bateau (phase mappeur terre-only). Décisions PURES (testables sans client
// MC) + actions bot best-effort. Le bateau ne sert QU'À traverser l'eau vers la terre neuve —
// jamais à cartographier l'océan.
const { sectorRange, inSector } = require('./sectors');

const TAU = Math.PI * 2;
const _norm = (a) => ((a % TAU) + TAU) % TAU;

const WATER_NAMES = new Set(['water', 'flowing_water', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'bubble_column']);

/** Cap vers le LARGE : à l'opposé du centroïde mappé, contraint au wedge du secteur (fan-out). PUR. */
function outwardHeading(fromPos, centroid, sector, rng) {
  const r = rng || Math.random;
  const dx = fromPos.x - centroid.x, dz = fromPos.z - centroid.z;
  let base = (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6) ? r() * TAU : Math.atan2(dz, dx);
  if (sector && sector.count > 1) {
    const range = sectorRange(sector.index, sector.count, sector.overlapDeg || 15);
    if (!range.full && !inSector(base, range)) {
      const width = _norm(range.end - range.start) || TAU;
      base = range.start + r() * width;
    }
  }
  return _norm(base);
}

/**
 * Terre devant au cap ? Échantillonne le sol le long du heading (colonnes espacées de `step`
 * jusqu'à `reach`) via `sampleBlock(x,y,z)` injecté (block-like {name,boundingBox} | null).
 * → { found:true, pos } sur le 1er sol SOLIDE non-eau ; sinon { found:false }. PUR.
 */
function landAhead(sampleBlock, fromPos, headingYaw, opts = {}) {
  const reach = opts.reach || 40;
  const step = opts.step || 4;
  const seaY = Math.floor(fromPos.y);
  for (let d = step; d <= reach; d += step) {
    const x = Math.floor(fromPos.x + Math.cos(headingYaw) * d);
    const z = Math.floor(fromPos.z + Math.sin(headingYaw) * d);
    for (let y = seaY + 4; y >= seaY - 4; y--) {
      const b = sampleBlock(x, y, z);
      if (!b) break;                                   // non chargé → colonne suivante
      if (WATER_NAMES.has(b.name)) break;              // eau en surface → pas de terre ici
      if (b.name === 'air' || b.boundingBox === 'empty') continue;
      return { found: true, pos: { x, y, z } };        // solide non-eau → côte
    }
  }
  return { found: false };
}

/** Bateau coincé : ~0 déplacement horizontal pendant ≥ stuckMs. PUR. */
function boatStuck(prevPos, curPos, dtMs, opts = {}) {
  const minMove = opts.minMove != null ? opts.minMove : 2;
  const stuckMs = opts.stuckMs != null ? opts.stuckMs : 12000;
  if (dtMs < stuckMs) return false;
  return Math.hypot(curPos.x - prevPos.x, curPos.z - prevPos.z) < minMove;
}

module.exports = { outwardHeading, landAhead, boatStuck, WATER_NAMES };
```

- [ ] **Step 4: Lancer → passe**

Run: `cd mc-agent && node --test boat.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add mc-agent/boat.js mc-agent/boat.test.js
git commit -m "feat(mc-mapper): boat.js décisions pures — cap outward, détection côte, coincement"
```

---

### Task 3: `boat.js` — actions bateau (craft/embarquer/naviguer)

**Files:**
- Modify: `mc-agent/boat.js` (ajout des actions + export)
- Test: `mc-agent/boat.test.js`

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à `mc-agent/boat.test.js` (compléter l'import : `const { outwardHeading, landAhead, boatStuck, ensureBoat, sailToLand } = require('./boat');`) :

```js
test('ensureBoat : bateau déjà en poche → ok sans craft', async () => {
  const bot = { inventory: { items: () => [{ name: 'oak_boat', count: 1 }] } };
  let crafted = false;
  const r = await ensureBoat(bot, { craft: async () => { crafted = true; return { ok: true }; } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(crafted, false);
});

test('ensureBoat : pas de bateau, bois dispo → crafte le bateau de l’essence', async () => {
  const bot = { inventory: { items: () => [{ name: 'birch_planks', count: 8 }] } };
  const calls = [];
  const r = await ensureBoat(bot, { craft: async (a) => { calls.push(a); return { ok: true }; } });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(calls[0], { name: 'birch_boat', count: 1 });
});

test('sailToLand : s’arrête et débarque dès que la terre est détectée devant', async () => {
  let ticks = 0;
  const ctl = {};
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    look: async () => {},
    setControlState: (k, v) => { ctl[k] = v; },
    clearControlStates: () => { ctl.cleared = true; },
    dismount: async () => { ctl.dismounted = true; },
    blockAt: () => null,
  };
  // terre détectée au 3e appel de landAhead
  const sampleBlock = () => (++ticks >= 3 ? { name: 'stone', boundingBox: 'block' } : { name: 'water', boundingBox: 'empty' });
  const r = await sailToLand(bot, 0, {
    sampleBlock, reach: 8, step: 8, tickMs: 0, timeoutMs: 5000,
    now: (() => { let t = 0; return () => (t += 100); })(), sleep: async () => {},
  });
  assert.strictEqual(r.landed, true);
  assert.strictEqual(ctl.cleared, true);
  assert.strictEqual(ctl.dismounted, true);
});

test('sailToLand : jamais de terre + timeout → landed:false, contrôles relâchés', async () => {
  const ctl = {};
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    look: async () => {}, setControlState: () => {},
    clearControlStates: () => { ctl.cleared = true; }, dismount: async () => {}, blockAt: () => null,
  };
  const r = await sailToLand(bot, 0, {
    sampleBlock: () => ({ name: 'water', boundingBox: 'empty' }),
    reach: 8, step: 8, tickMs: 0, timeoutMs: 300,
    now: (() => { let t = 0; return () => (t += 200); })(), sleep: async () => {},
  });
  assert.strictEqual(r.landed, false);
  assert.strictEqual(ctl.cleared, true);
});
```

- [ ] **Step 2: Lancer → échec**

Run: `cd mc-agent && node --test --test-name-pattern="ensureBoat|sailToLand" boat.test.js`
Expected: FAIL — `ensureBoat is not a function`.

- [ ] **Step 3: Implémenter les actions**

Dans `mc-agent/boat.js`, avant `module.exports`, ajouter :

```js
/** Garantit un bateau en poche : sinon crafte celui de l'essence de bois dispo. best-effort. */
async function ensureBoat(bot, opts = {}) {
  const craft = opts.craft;
  const items = (bot.inventory && bot.inventory.items()) || [];
  const has = items.find((i) => /_boat$/.test(i.name));
  if (has) return { ok: true, name: has.name };
  if (!craft) return { ok: false, reason: 'no_craft' };
  const wood = items.find((i) => /_(log|planks)$/.test(i.name));
  const kind = wood ? wood.name.replace(/_(log|planks)$/, '') : 'oak';
  const name = kind + '_boat';
  try {
    const r = await craft({ name, count: 1 });
    return { ok: !!(r && r.ok), name };
  } catch (e) { return { ok: false, reason: 'craft_error' }; }
}

const _bpos = (bot) => {
  const p = bot.entity && bot.entity.position;
  return p ? { x: p.x, y: p.y, z: p.z } : { x: 0, y: 64, z: 0 };
};

/**
 * Navigue au cap `headingYaw` (bot supposé déjà embarqué) jusqu'à détecter la terre devant
 * (`landAhead`) OU coincement OU timeout, puis débarque. `sampleBlock`/`now`/`sleep` injectables.
 * → { landed:boolean, reason }. Relâche TOUJOURS les contrôles + dismount en sortie.
 */
async function sailToLand(bot, headingYaw, opts = {}) {
  const now = opts.now || Date.now;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const sampleBlock = opts.sampleBlock || ((x, y, z) => bot.blockAt({ x, y, z }));
  const tickMs = opts.tickMs != null ? opts.tickMs : 500;
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 90000;
  const t0 = now();
  let prev = _bpos(bot), prevT = t0;
  let landed = false, reason = 'timeout';
  try {
    while (now() - t0 < timeoutMs) {
      try { await bot.look(headingYaw, 0, true); } catch (e) {}
      bot.setControlState('forward', true);
      const here = _bpos(bot);
      const ahead = landAhead(sampleBlock, here, headingYaw, opts);
      if (ahead.found) { landed = true; reason = 'land'; break; }
      const t = now();
      if (boatStuck(prev, here, t - prevT, opts)) { reason = 'stuck'; break; }
      if (t - prevT >= (opts.sampleEvery || 3000)) { prev = here; prevT = t; }
      await sleep(tickMs);
    }
  } finally {
    try { bot.clearControlStates(); } catch (e) {}
    try { await bot.dismount(); } catch (e) {}
  }
  return { landed, reason };
}
```

Mettre à jour l'export : `module.exports = { outwardHeading, landAhead, boatStuck, ensureBoat, sailToLand, WATER_NAMES };`

- [ ] **Step 4: Lancer → passe**

Run: `cd mc-agent && node --test boat.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add mc-agent/boat.js mc-agent/boat.test.js
git commit -m "feat(mc-mapper): boat.js actions — ensureBoat (craft) + sailToLand (débarque à la côte)"
```

---

### Task 4: `mapper.js` — intégration boucle + skip biome océan

**Files:**
- Modify: `mc-agent/mapper.js` (imports, `record` skip océan, branche frontière)
- Test: `mc-agent/mapper.test.js`

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à `mc-agent/mapper.test.js` (après le dernier test frontier) :

```js
test('runMapper frontier terre-only : frontière terre épuisée → traversée bateau (hook), débarque et mappe', async () => {
  const bot = fakeMapperBot();
  const events = [];
  const token = { cancelled: false };
  // tout couvert autour du spawn → nextLandLeg renvoie null → boat cross
  const biomes = [];
  for (let x = -512; x <= 512; x += 128) for (let z = -512; z <= 512; z += 128) biomes.push({ name: 'plains', x, z });
  let crossed = 0;
  await runMapper(bot, {
    worldKey: 'overworld',
    memory: { worlds: { overworld: { biomes } } },
    frontier: true,
    boat: {
      // simule une traversée réussie : téléporte le bot 400 blocs plus loin (terre neuve)
      cross: async () => { crossed++; bot.entity.position = vec3(900, 64, 0); return { ok: true, landed: true }; },
    },
    emit: (e) => { events.push(e); if (crossed >= 1 || events.length > 400) token.cancelled = true; },
    goto: async (wp) => { bot.entity.position = vec3(wp.x, 64, wp.z); },
    sleep: async () => {},
  }, token);
  assert.ok(crossed >= 1, 'doit lancer une traversée bateau quand la terre locale est épuisée');
  assert.ok(events.some((e) => e.type === 'mapper_boat_cross'));
});

test('runMapper : ne mappe PAS l’océan (biome eau → pas de biome_seen)', async () => {
  // bot sur une case océan : blockAt renvoie un biome ocean
  const bot = fakeMapperBot();
  bot.blockAt = (p) => (p.y > 63
    ? { name: 'air', boundingBox: 'empty', biome: { name: 'ocean', id: 0 } }
    : { name: 'water', boundingBox: 'empty', biome: { name: 'ocean', id: 0 } });
  const events = [];
  const token = { cancelled: false };
  let n = 0;
  await runMapper(bot, {
    worldKey: 'overworld', memory: { worlds: { overworld: { biomes: [] } } }, frontier: true,
    boat: { cross: async () => { token.cancelled = true; return { ok: false }; } },
    emit: (e) => { events.push(e); if (++n > 60) token.cancelled = true; },
    goto: async (wp) => { bot.entity.position = vec3(wp.x, 64, wp.z); }, sleep: async () => {},
  }, token);
  assert.ok(!events.some((e) => e.type === 'biome_seen'), 'aucun biome_seen pour l’océan');
});
```

- [ ] **Step 2: Lancer → échec**

Run: `cd mc-agent && node --test --test-name-pattern="terre-only|ne mappe PAS" mapper.test.js`
Expected: FAIL (le 1er : pas de `mapper_boat_cross` ; le bot warpe ou tourne au lieu de traverser).

- [ ] **Step 3: Implémenter l'intégration**

3a. Imports — dans `mc-agent/mapper.js`, remplacer la ligne 22 :

```js
const { nextFrontierCell, nextLandLeg } = require('./frontier');
```

3b. Skip biome océan dans `record()` — le bloc d'émission du biome sous le bot (≈ l.170-174) devient :

```js
        const block = bot.blockAt(bot.entity.position.floored ? bot.entity.position.floored() : bot.entity.position);
        if (block && block.biome) {
          const bname = resolveBiome(bot, block);
          // TERRE-ONLY : on ne cartographie jamais l'océan (juste on le traverse). La case reste
          // dans localSeen (anti-re-ciblage) mais aucun biome_seen n'est émis pour l'eau.
          if (!/ocean|river|water/i.test(String(bname))) {
            emit(biomeSeenEvent(worldKey, { biome: bname }, p));
          }
        }
```

Et le même filtre pour les 8 cellules voisines (≈ l.189-193) :

```js
          const nb = bot.blockAt(_v(nx, Math.floor(p.y), nz));
          if (nb && nb.biome) {
            biomeCells.add(nk);
            const nbn = resolveBiome(bot, nb);
            if (!/ocean|river|water/i.test(String(nbn))) {
              emit(biomeSeenEvent(worldKey, { biome: nbn }, { x: nx, y: p.y, z: nz }));
            }
          }
```

3c. Branche frontière — remplacer le bloc `if (opts.frontier) { … }` (≈ l.337-369, la version actuelle avec le warp) par :

```js
    if (opts.frontier) {
      legs++;
      if (opts.reloadMemory && legs % 3 === 0) {
        try { memory = opts.reloadMemory() || memory; } catch (e) { /* best-effort */ }
      }
      const here0 = _pos(bot);
      const cell = nextLandLeg(memory, worldKey, localSeen, here0, {
        skip: frontierSkip,
        isOcean: (gx, gz) => isOceanCell(memory, worldKey, gx, gz),
      });
      if (cell) {
        // terre locale : on y VA À PIED (jamais de warp aveugle). Eau sur le chemin → skip.
        if (!isOceanCell(memory, worldKey, cell.center.x, cell.center.z) && !waterAhead(bot, here0, cell.center)) {
          try {
            await doGoto({ x: cell.center.x, y: here0.y, z: cell.center.z });
            record();
            continue;
          } catch (e) {
            frontierSkip.add(cell.key);
            emit({ type: 'mapper_frontier_skip', cell: cell.key });
            // fallthrough : jambe aléatoire pour se dégager
          }
        } else {
          frontierSkip.add(cell.key);
          // fallthrough
        }
      } else if (opts.boat && opts.boat.cross) {
        // TERRE LOCALE ÉPUISÉE → traversée bateau vers le large (juste traverser).
        emit({ type: 'mapper_boat_cross' });
        let res = null;
        try { res = await opts.boat.cross(here0); } catch (e) { res = { ok: false, reason: 'error' }; }
        emit({ type: res && res.landed ? 'mapper_boat_landed' : 'mapper_boat_failed', reason: res && res.reason });
        record();
        continue;
      }
      // pas de bateau dispo (ou échec) → marche aléatoire ci-dessous (le crossing nage existant
      // reste le filet anti-blocage)
    }
```

- [ ] **Step 4: Lancer → passe (+ non-régression complète)**

Run: `cd mc-agent && node --test mapper.test.js`
Expected: PASS (tous — les anciens tests frontier warp continuent de passer car la branche warp n'est plus exercée par eux ; le test `warp ÉCHOUÉ` de Task warp-spam reste vert car il n'utilise plus `nextLandLeg`… ⚠️ VÉRIFIER : ce test passait `warp` sans `boat` — voir Step 5).

- [ ] **Step 5: Réconcilier l'ancien test warp-spam**

L'ancien test `runMapper frontier : warp ÉCHOUÉ …` (Task warp-spam) et `runMapper frontier : vise la cellule non couverte la plus proche, warp si lointaine` reposaient sur l'ANCIENNE branche warp (supprimée). Les mettre à jour pour le nouveau modèle : la « frontière lointaine » ne warpe plus mais déclenche `boat.cross`. Remplacer ces 2 tests par le comportement terre-only (le test de Task 4 Step 1 couvre déjà le cas « terre épuisée → bateau »). Concrètement : supprimer les 2 tests devenus obsolètes (warp) de `mapper.test.js` — le contrat warp n'existe plus dans le mapping.

```bash
# après édition, relancer :
cd mc-agent && node --test mapper.test.js
```
Expected: PASS, 0 fail.

- [ ] **Step 6: Parse-check + commit**

```bash
cd mc-agent && node -e "new Function(require('fs').readFileSync('mapper.js','utf8')); console.log('parse OK')"
git add mc-agent/mapper.js mc-agent/mapper.test.js
git commit -m "feat(mc-mapper): boucle terre-only — nextLandLeg + traversée bateau, skip biome océan, warp retiré du mapping"
```

---

### Task 5: `index.js` — câblage boat / centroïde / sampleBlock

**Files:**
- Modify: `mc-agent/index.js` (fonction `startMapper`, appel `runMapper`)

- [ ] **Step 1: Ajouter le hook boat + centroïde avant l'appel `runMapper`**

Dans `startMapper` (≈ l.730), remplacer la définition du `warp` self-service et l'ajouter au `boat.cross`. Juste avant `await runMapper(bot, {`, insérer :

```js
  const boatMod = require('./boat');
  // Centroïde des cellules déjà mappées (référence "vers le large").
  const mappedCentroid = () => {
    const w = bot._worldMemory && bot._worldMemory.worlds && bot._worldMemory.worlds[bot._worldKey];
    const bs = (w && w.biomes) || [];
    if (!bs.length) { const p = bot.entity.position; return { x: p.x, z: p.z }; }
    let sx = 0, sz = 0; for (const b of bs) { sx += b.x; sz += b.z; }
    return { x: sx / bs.length, z: sz / bs.length };
  };
  const sampleBlock = (x, y, z) => { try { return bot.blockAt(new Vec3Boat(x, y, z)); } catch (e) { return null; } };
```

⚠️ `Vec3Boat` : réutiliser le `Vec3` déjà importé dans `index.js` (chercher `require('vec3')` en tête du fichier ; utiliser ce symbole au lieu de `Vec3Boat`). Si `index.js` importe `const Vec3 = require('vec3')`, écrire `bot.blockAt(new Vec3(x, y, z))`.

- [ ] **Step 2: Passer `boat` à `runMapper`, retirer `warp` du mapping**

Dans l'objet options de `runMapper(bot, { … })`, retirer la ligne `warp,` (le warp `/spreadplayers` n'est plus un moyen de mapping) et ajouter :

```js
    boat: {
      cross: async (fromPos) => {
        const sector = mapperSector;
        const heading = boatMod.outwardHeading(fromPos, mappedCentroid(), sector, Math.random);
        const eb = await boatMod.ensureBoat(bot, { craft: (a) => craftSmart(a) });
        if (!eb.ok) return { ok: false, landed: false, reason: 'no_boat' };
        // pose + embarque : au bord de l'eau au cap, best-effort (échec → nage de secours plus bas)
        try {
          const here = bot.entity.position;
          const wx = Math.floor(here.x + Math.cos(heading) * 2), wz = Math.floor(here.z + Math.sin(heading) * 2);
          const water = bot.blockAt(new Vec3(wx, Math.floor(here.y) - 1, wz));
          if (water && boatMod.WATER_NAMES.has(water.name)) {
            const boatItem = bot.inventory.items().find((i) => /_boat$/.test(i.name));
            if (boatItem) { await bot.equip(boatItem, 'hand'); await bot.lookAt(water.position.offset(0, 1, 0), true); await bot.activateItem(); }
            const ent = bot.nearestEntity((e) => /boat/i.test(e.name || '') || /boat/i.test((e.objectType || '')));
            if (ent) { try { await bot.mount(ent); } catch (e) {} }
          }
        } catch (e) { /* best-effort */ }
        const r = await boatMod.sailToLand(bot, heading, { sampleBlock, reach: 40, step: 4, timeoutMs: 90000 });
        if (!r.landed) { try { await escapeWaterHook(); } catch (e) {} }   // nage de secours
        return { ok: true, landed: r.landed, reason: r.reason };
      },
    },
```

Où `escapeWaterHook` = un appel best-effort à la nage de secours existante. Si `startMapper` a déjà accès à un helper d'évasion d'eau, l'utiliser ; sinon définir juste au-dessus :

```js
  const escapeWaterHook = async () => { const { escapeWater } = require('./unstuck'); try { await escapeWater(bot, { emit }); } catch (e) {} };
```

- [ ] **Step 3: Parse-check**

Run: `cd mc-agent && node -e "new Function(require('fs').readFileSync('index.js','utf8')); console.log('parse OK')"`
Expected: `parse OK`.

- [ ] **Step 4: Suite Node complète (non-régression)**

Run: `cd mc-agent && node --test *.test.js 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add mc-agent/index.js
git commit -m "feat(mc-mapper): câble la traversée bateau (cap outward, craft, pose/embarque/navigue) + retire le warp du mapping"
```

---

### Task 6: Validation live + déploiement

**Files:** aucun (opérationnel).

- [ ] **Step 1: Vérifier qu'aucun grind actif ne sera tué (piège #47e)**

`ssh omen 'pgrep -c -f "mc-agent/index.js"'` + rôles via `data/mc_agent_runs/world-*.json`. Un grind iron_armor actif → demander à Massii avant de pusher (le push restart uvicorn).

- [ ] **Step 2: Rebase + push**

```bash
git fetch origin && git rebase origin/main
# vérifier carte + fix warp toujours présents ; puis :
git push origin feat/mc-mapper-boat-crossing:main
```

- [ ] **Step 3: Attendre l'auto-deploy** (poll `ssh omen 'grep -c sailToLand ~/"Projet serveur"/mc-agent/boat.js'` → 1).

- [ ] **Step 4: S'assurer que le serveur MC de test tourne**

`ssh omen 'docker ps --filter name=omen-minecraft-trusted-test'` ; si arrêté (cycle nocturne) → `docker start` (serveur de test agent).

- [ ] **Step 5: Relancer 2 mappeurs** (JWT minté côté Omen, cf. session 2026-07-15) :

`curl -X POST -H "Authorization: Bearer <jwt>" -d '{"count":2}' http://127.0.0.1:8000/api/mc-agent/servers/943e2c/mappers/start`

- [ ] **Step 6: Vérifier l'expansion sur ≥ 2 landmasses**

Sampler soutenu (~8 min) de l'étendue de `data/mc_agent_world_memory/943e2c.json` : le span (min/max x,z) doit **croître franchement** et le bot doit émettre `mapper_boat_cross` + `mapper_boat_landed` (logs serveur MC : embarquement bateau, position qui saute d'une landmasse à l'autre). **Aucune case océan** ajoutée (vérifier qu'aucun biome `ocean/river` n'apparaît dans les nouvelles cellules).

- [ ] **Step 7: MAJ CLAUDE.md (historique + piège) + vault Obsidian.**

---

## Self-review (auteur)

- **Couverture spec** : §4.1 `nextLandLeg`→T1 ; §4.2 pures→T2, actions→T3 ; §4.3 intégration+skip océan→T4 ; §4.4 câblage→T5 ; §5 skip océan→T4/3b ; §6 tests→T1-4 + live T6 ; §7 risques (nage secours, bois, secteurs, #47e)→T3/T5/T6. OK.
- **Placeholders** : aucun TODO/TBD ; code exact fourni pour chaque étape (les actions bateau best-effort sont validées live en T6, comme prévu par la spec §7).
- **Cohérence types** : `nextLandLeg(memory,worldKey,localSeen,from,{isOcean,skip,maxRing})` cohérent T1↔T4 ; `boat.cross(fromPos)→{ok,landed,reason}` cohérent T4↔T5 ; `outwardHeading/landAhead/sailToLand/ensureBoat` signatures identiques T2/T3↔T5.
- **Point d'attention** : T5 Step 1 `Vec3` — le symbole exact dépend de l'import réel de `index.js` (vérifier `require('vec3')` avant d'écrire). Noté dans la tâche.
