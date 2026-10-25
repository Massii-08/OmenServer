'use strict';
// BOUCLE CHAUDE DU BOIS (25/10, NethBot1 session 679) : une bûche à portée que collectBlock ne sait pas
// récolter (collect rejeté aussitôt) + une cible dirigée à < 8 blocs du bot. Chaque tour du planner :
// gather voit la bûche → collect ×2 raté → `failed` (local à l'appel) → explore → goto déjà arrivé →
// findBlock rend LA MÊME bûche morte → « trouvé » (donc pas de directed_exhausted) → gather la rejette →
// not_found en ~20 ms. Tour suivant : `failed` repart vide, même cible dirigée, à l'infini (×21 en 10 min).
const { test } = require('node:test');
const assert = require('node:assert');
const { gather } = require('./gather');

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo(o) { return Math.sqrt((x - o.x) ** 2 + (y - o.y) ** 2 + (z - o.z) ** 2); },
    offset(dx, dy, dz) { return pos(x + dx, y + dy, z + dz); },
    clone() { return pos(x, y, z); },
  };
}

function makeBot() {
  const calls = { goto: 0, collect: 0, emits: [] };
  const dead = pos(-515, 90, 636);          // bûche en haut d'un arbre : collect rejeté à chaque fois
  const bot = {
    entity: { position: pos(-511, 75, 633), yaw: 0 },
    registry: { blocksByName: { oak_log: { id: 17 } } },
    inventory: { items: () => [] },
    _worldKey: 'overworld',
    _worldMemory: { worlds: { overworld: { biomes: [{ x: -512, z: 640, name: 'forest' }] } } },
    _mcaExhausted: new Set(),
    _emit: (ev) => calls.emits.push(ev),
    nearestEntity() { return null; },
    pvp: { attack() {} },
    async equip() {},
    findBlock({ maxDistance }) {
      return bot.entity.position.distanceTo(dead) <= (maxDistance || 64)
        ? { name: 'oak_log', position: dead, boundingBox: 'block' } : null;
    },
    findBlocks({ maxDistance }) {
      return bot.entity.position.distanceTo(dead) <= (maxDistance || 64) ? [dead] : [];
    },
    blockAt(p) { return (p.x === dead.x && p.y === dead.y && p.z === dead.z) ? { name: 'oak_log', position: dead, boundingBox: 'block' } : null; },
    pathfinder: { async goto() { calls.goto++; }, setGoal() {} },   // déjà sur place : rien ne bouge
    collectBlock: { async collect() { calls.collect++; throw new Error('No path'); } },
  };
  return { bot, calls };
}

test('bûche morte + cible dirigée sur place : pas de boucle chaude — bûche bannie entre deux tours, cible épuisée', async () => {
  const { bot, calls } = makeBot();
  const r1 = await gather(bot, { name: 'oak_log', count: 1, explore: true });
  assert.strictEqual(r1.ok, false);
  const collectsAfter1 = calls.collect;
  assert.strictEqual(collectsAfter1, 2, '1er tour : un essai + un re-essai, puis bûche marquée ratée');
  const ex = calls.emits.filter((e) => e.type === 'directed_exhausted');
  assert.strictEqual(ex.length, 1, 'arrivé sur la cible sans bûche RÉCOLTABLE → cible épuisée (et persistée)');
  assert.deepStrictEqual([ex[0].x, ex[0].z], [-512, 640]);

  // Tours suivants du planner : la bûche morte n'est plus re-tentée et la cible n'est plus re-visée.
  const before = calls.emits.length;
  const r2 = await gather(bot, { name: 'oak_log', count: 1, explore: true });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(calls.collect, collectsAfter1, 'la bûche morte n\'est PAS re-tentée au tour suivant');
  const dir2 = calls.emits.slice(before).filter((e) => e.type === 'explore_directed');
  assert.strictEqual(dir2.length, 0, 'la cible épuisée n\'est plus proposée');
});

test('deadBlockIsLive : vivant pendant le TTL, oublié ensuite', () => {
  const { deadBlockIsLive, DEAD_BLOCK_TTL_MS } = require('./gather');
  const m = new Map([['1,2,3', 1000]]);
  assert.strictEqual(deadBlockIsLive(m, '1,2,3', 1000 + DEAD_BLOCK_TTL_MS - 1), true);
  assert.strictEqual(deadBlockIsLive(m, '1,2,3', 1000 + DEAD_BLOCK_TTL_MS), false);
  assert.strictEqual(m.has('1,2,3'), false, 'purgé à l\'expiration');
  assert.strictEqual(deadBlockIsLive(m, 'x', 0), false);
});
