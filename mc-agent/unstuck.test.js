'use strict';
// Anti-stuck eau (#1 retours live) : détection + évasion vers la terre ferme.
const { test } = require('node:test');
const assert = require('node:assert');
const vec3 = require('vec3');
const { isInWater, findLandTarget, escapeWater, WATER } = require('./unstuck');

function waterBot({ inWater = true, landAt = null, pos = { x: 0, y: 62, z: 0 } } = {}) {
  const bot = {
    entity: { position: vec3(pos.x, pos.y, pos.z), isInWater: inWater },
    controls: {},
    setControlState(c, v) { this.controls[c] = v; },
    pathfinder: { setGoal: () => {}, goto: async () => {} },
    findBlocks({ count }) {
      if (!landAt) return [];
      return [vec3(landAt.x, landAt.y, landAt.z)];
    },
    blockAt(p) {
      if (landAt && p.x === landAt.x && p.z === landAt.z) {
        if (p.y === landAt.y) return { name: 'grass_block', boundingBox: 'block' };
        return { name: 'air', boundingBox: 'empty' };                 // l'air au-dessus de la terre
      }
      return { name: 'water', boundingBox: 'empty' };
    },
  };
  return bot;
}

test('isInWater : flag mineflayer prioritaire, fallback bloc aux pieds', () => {
  assert.ok(isInWater(waterBot({ inWater: true })));
  assert.ok(!isInWater(waterBot({ inWater: false })));
  // fallback : pas de flag → bloc aux pieds
  const b = waterBot({}); delete b.entity.isInWater;
  assert.ok(isInWater(b)); // blockAt → water
});

test('findLandTarget : trouve le bloc solide avec 2 airs au-dessus, rejette le fond marin', () => {
  const bot = waterBot({ landAt: { x: 10, y: 63, z: 4 } });
  const land = findLandTarget(bot);
  assert.ok(land && land.x === 10 && land.z === 4);
  // fond marin (y trop bas sous le bot) → rejeté
  const deep = waterBot({ landAt: { x: 10, y: 40, z: 4 } });
  assert.strictEqual(findLandTarget(deep), null);
});

test('escapeWater : nage (jump) + goto vers la terre → ok quand sorti de l\'eau', async () => {
  const bot = waterBot({ landAt: { x: 10, y: 63, z: 4 } });
  const gotos = [];
  const events = [];
  const r = await escapeWater(bot, {
    emit: (e) => events.push(e),
    sleep: async () => {},
    goto: async (p) => { gotos.push(p); bot.entity.isInWater = false; }, // atteindre la terre = sorti
  });
  assert.ok(r.ok);
  assert.strictEqual(gotos.length, 1);
  assert.strictEqual(gotos[0].x, 10);
  assert.strictEqual(bot.controls.jump, false);               // contrôles relâchés à la fin
  assert.ok(events.some((e) => e.type === 'unstuck' && e.cause === 'water'));
});

test('escapeWater : borné dans le temps — rend ok:false si toujours dans l\'eau (pas de boucle infinie)', async () => {
  const bot = waterBot({ landAt: null });                     // aucune terre en vue
  const r = await escapeWater(bot, { sleep: async () => {}, timeoutMs: 1, goto: async () => {} });
  assert.strictEqual(r.ok, false);
});

test('WATER couvre les blocs aquatiques courants', () => {
  for (const n of ['water', 'flowing_water', 'kelp', 'seagrass']) assert.ok(WATER.has(n));
});

// --- #9 lianes / #8 flottant ---
const { clearSnares, isFloatingStuck, recoverFloating, SNARES } = require('./unstuck');

test('clearSnares : casse les lianes adjacentes (pieds/tête/voisins), no-op sinon', async () => {
  const dug = [];
  const bot = {
    entity: { position: vec3(0.5, 64, 0.5) },
    blockAt(p) {
      if (p.x === 0 && p.y === 65 && p.z === 0) return { name: 'vine', boundingBox: 'empty', position: p };
      if (p.x === 1 && p.y === 64 && p.z === 0) return { name: 'cobweb', boundingBox: 'empty', position: p };
      return { name: 'air', boundingBox: 'empty', position: p };
    },
    dig: async (b) => { dug.push(b.name); },
  };
  const n = await clearSnares(bot);
  assert.strictEqual(n, 2);
  assert.ok(dug.includes('vine') && dug.includes('cobweb'));
  // monde propre → 0
  bot.blockAt = (p) => ({ name: 'air', boundingBox: 'empty', position: p });
  assert.strictEqual(await clearSnares(bot), 0);
});

test('isFloatingStuck : flottant immobile ≥1.5s → true ; au sol / dans l\'eau / en mouvement → false', () => {
  const prev = { x: 0, z: 0, t: 0 };
  assert.ok(isFloatingStuck(prev, { x: 0.1, z: 0, t: 2000 }, { onGround: false, inWater: false }));
  assert.ok(!isFloatingStuck(prev, { x: 0.1, z: 0, t: 2000 }, { onGround: true, inWater: false }));
  assert.ok(!isFloatingStuck(prev, { x: 0.1, z: 0, t: 2000 }, { onGround: false, inWater: true }));
  assert.ok(!isFloatingStuck(prev, { x: 5, z: 5, t: 2000 }, { onGround: false, inWater: false }));   // bouge
  assert.ok(!isFloatingStuck(prev, { x: 0.1, z: 0, t: 800 }, { onGround: false, inWater: false }));  // trop tôt
});

test('recoverFloating : relâche TOUT + coupe le pathfinder + retombe au sol', async () => {
  let cleared = 0, goalCleared = 0, polls = 0;
  const bot = {
    entity: { position: vec3(0, 66, 0), onGround: false },
    clearControlStates() { cleared++; },
    pathfinder: { setGoal: (g) => { if (g === null) goalCleared++; } },
    blockAt: (p) => ({ name: 'air', boundingBox: 'empty', position: p }),
    dig: async () => {},
  };
  const r = await recoverFloating(bot, {
    sleep: async () => { polls++; if (polls >= 2) bot.entity.onGround = true; }, // retombe après 2 polls
  });
  assert.ok(r.ok);
  assert.strictEqual(cleared, 1);
  assert.ok(goalCleared >= 1);
});

test('SNARES couvre lianes jungle + cave vines + cobweb', () => {
  for (const n of ['vine', 'cave_vines', 'twisting_vines', 'weeping_vines', 'cobweb']) assert.ok(SNARES.has(n), n);
});

// --- P26 (run#30) : puits d'eau 1×1 — la nage atteint la surface puis regl isse → boucle infinie
// unstuck water. Sortie déterministe = COMBLER la colonne sous les pieds (pose contre la paroi).
const { fillBelow } = require('./unstuck');

test('P26: fillBelow pose un scaffold dans la cellule d\'eau sous les pieds (contre la paroi)', async () => {
  const mkpos = (x, y, z) => ({ x, y, z, offset(dx, dy, dz) { return mkpos(x + dx, y + dy, z + dz); },
    floored() { return mkpos(Math.floor(x), Math.floor(y), Math.floor(z)); } });
  const placed = [];
  const bot = {
    entity: { position: mkpos(0.5, 59.4, 0.5) },
    inventory: { items: () => [{ name: 'cobblestone', count: 32 }] },
    blockAt(p) {
      const q = p.floored ? p.floored() : p;
      // colonne d'eau en (0, *, 0) ; parois pierre tout autour
      if (q.x === 0 && q.z === 0) return { name: 'water', position: q, boundingBox: 'empty' };
      return { name: 'stone', position: q, boundingBox: 'block' };
    },
    async equip() {},
    async placeBlock(ref, face) { placed.push({ ref: { x: ref.position.x, y: ref.position.y, z: ref.position.z }, face }); },
  };
  const r = await fillBelow(bot);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(placed.length, 1);
  // la pose vise la cellule (0,58,0) : ref = une paroi adjacente, face pointant vers la cellule
  const tgt = { x: placed[0].ref.x + placed[0].face.x, y: placed[0].ref.y + placed[0].face.y, z: placed[0].ref.z + placed[0].face.z };
  assert.deepStrictEqual(tgt, { x: 0, y: 58, z: 0 });
});

test('P26: fillBelow sans scaffold en poche → no_blocks (pas de throw)', async () => {
  const mkpos = (x, y, z) => ({ x, y, z, offset(dx, dy, dz) { return mkpos(x + dx, y + dy, z + dz); },
    floored() { return mkpos(Math.floor(x), Math.floor(y), Math.floor(z)); } });
  const bot = {
    entity: { position: mkpos(0.5, 59.4, 0.5) },
    inventory: { items: () => [] },
    blockAt() { return { name: 'water', boundingBox: 'empty', position: mkpos(0, 58, 0) }; },
    async equip() {}, async placeBlock() {},
  };
  const r = await fillBelow(bot);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_blocks');
});
