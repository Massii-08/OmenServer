'use strict';
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

// Fake bot : un bloc cible à `target` ; findBlock le voit si bot ≤ maxDistance. goto téléporte.
// collectBlock retire la cible + ajoute au sac.
function makeBot({ target = null, biome = null, worldKey = null } = {}) {
  const calls = { goto: [], collect: [], emits: [] };
  const inv = [];
  let tgt = target;
  const bot = {
    entity: { position: pos(0, 70, 0), yaw: 0 },
    registry: { blocksByName: { oak_log: { id: 17 } } },
    inventory: { items: () => inv.slice() },
    _worldKey: worldKey,
    _emit: (ev) => calls.emits.push(ev),
    nearestEntity() { return null; },
    pvp: { attack() {} },
    async equip() {},
    findBlock({ matching, maxDistance }) {
      if (!tgt) return null;
      return bot.entity.position.distanceTo(tgt) <= (maxDistance || 64)
        ? { name: 'oak_log', position: tgt, boundingBox: 'block', biome: biome ? { name: biome } : undefined } : null;
    },
    pathfinder: {
      async goto(goal) {
        const tx = goal && (goal.x !== undefined ? goal.x : goal.target && goal.target.x);
        const ty = goal && (goal.y !== undefined ? goal.y : goal.target && goal.target.y);
        const tz = goal && (goal.z !== undefined ? goal.z : goal.target && goal.target.z);
        if (typeof tx === 'number') { calls.goto.push({ x: tx, y: ty, z: tz }); bot.entity.position = pos(tx, ty, tz); }
      },
    },
    collectBlock: {
      async collect(b) { calls.collect.push(b); tgt = null; inv.push({ name: 'oak_log', count: 1 }); },
    },
  };
  return { bot, calls };
}

test('gather(explore:true) : trouve le bois lointain en explorant puis le récolte', async () => {
  const { bot, calls } = makeBot({ target: pos(100, 70, 0) }); // hors 64 blocs
  const res = await gather(bot, { name: 'oak_log', count: 1, explore: true });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.got, 1, 'a récolté 1 bois après exploration');
  assert.ok(calls.goto.length >= 1, 'le bot s\'est déplacé pour aller le chercher');
  assert.strictEqual(calls.collect.length, 1);
});

test('gather(explore:true) : aucun bois nulle part → not_found (borné, pas de hang)', async () => {
  const { bot } = makeBot({ target: null });
  const res = await gather(bot, { name: 'oak_log', count: 1, explore: true });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'not_found');
});

test('gather (défaut explore:false) : NE roame PAS — bois lointain → not_found sans bouger', async () => {
  // Verrou : les gather opportunistes (branchMine maxDistance:6) ne doivent pas partir explorer.
  const { bot, calls } = makeBot({ target: pos(100, 70, 0) });
  const res = await gather(bot, { name: 'oak_log', count: 1 }); // explore non passé → false
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'not_found');
  assert.strictEqual(calls.goto.length, 0, 'aucun déplacement : pas d\'exploration sans opt-in');
});

test('gather : bois déjà à portée → récolte direct sans explorer', async () => {
  const { bot, calls } = makeBot({ target: pos(10, 70, 0) }); // dans les 64 blocs
  const res = await gather(bot, { name: 'oak_log', count: 1, explore: true });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.got, 1);
  assert.strictEqual(calls.goto.length, 0, 'pas besoin d\'explorer si déjà à portée');
});

test('gather : émet material_found (matériau↔biome) sur récolte réussie — boucle d\'apprentissage', async () => {
  const { bot, calls } = makeBot({ target: pos(10, 70, 0), biome: 'forest', worldKey: 'minecraft:overworld' });
  const res = await gather(bot, { name: 'oak_log', count: 1 });
  assert.strictEqual(res.ok, true);
  const ev = calls.emits.find((e) => e.type === 'material_found');
  assert.ok(ev, 'un event material_found émis');
  assert.strictEqual(ev.material, 'oak_log');
  assert.strictEqual(ev.biome, 'forest');
  assert.strictEqual(ev.world, 'minecraft:overworld');
});

test('gather : pas de material_found sans worldKey (manuel) ni sans biome connu (datapack)', async () => {
  const a = makeBot({ target: pos(10, 70, 0), biome: 'forest' }); // pas de worldKey (lancement manuel)
  await gather(a.bot, { name: 'oak_log', count: 1 });
  assert.strictEqual(a.calls.emits.filter((e) => e.type === 'material_found').length, 0);
  const b = makeBot({ target: pos(10, 70, 0), worldKey: 'w' }); // biome inconnu (mineflayer sans nom)
  await gather(b.bot, { name: 'oak_log', count: 1 });
  assert.strictEqual(b.calls.emits.filter((e) => e.type === 'material_found').length, 0);
});

// --- P7 (Marathon run#8) : bûche de canopée inatteignable → findBlock retourne TOUJOURS la même
// cible, collect échoue, boucle infinie de collect_failed. gather doit BLACKLISTER la cible morte
// et passer à la suivante (findBlocks), au lieu de re-buter éternellement sur la première.
test('P7: cible incollectable → blacklist + récolte la suivante', async () => {
  const inv = [];
  const bad = pos(5, 80, 0);   // canopée flottante : collect échoue toujours
  const good = pos(6, 70, 0);  // tronc accessible
  const bot = {
    entity: { position: pos(0, 70, 0), yaw: 0 },
    registry: { blocksByName: { oak_log: { id: 17 } } },
    inventory: { items: () => inv.slice() },
    nearestEntity() { return null; },
    pvp: { attack() {} },
    async equip() {},
    findBlocks() { return [bad, good]; },
    findBlock() { return { name: 'oak_log', position: bad, boundingBox: 'block' }; },
    blockAt(p) { return { name: 'oak_log', position: p, boundingBox: 'block' }; },
    pathfinder: { async goto() {} },
    collectBlock: { async collect(block) {
      if (block.position.y === 80) throw new Error('unreachable');
      inv.push({ name: 'oak_log', count: 1 });
    } },
  };
  const r = await gather(bot, { name: 'oak_log', count: 1 });
  assert.strictEqual(r.ok, true, `attendu ok (got ${JSON.stringify(r)})`);
  assert.strictEqual(r.got, 1);
});

// --- Retour Massii A (anti-détection) : JAMAIS de beeline vers un ore CACHÉ -----------------------
const { isExposed } = require('./gather');

function oreBot({ exposed }) {
  // un diamond_ore à (5,10,0) ; ses 6 voisins : pierre partout, sauf 1 face air si exposed
  const ore = pos(5, 10, 0);
  const bot = {
    entity: { position: pos(0, 10, 0), yaw: 0 },
    registry: { blocksByName: { deepslate_diamond_ore: { id: 57 }, stone: { id: 1 }, air: { id: 0 } } },
    inventory: { items: () => [{ name: 'iron_pickaxe', count: 1 }] },
    nearestEntity() { return null; },
    pvp: { attack() {} },
    async equip() {},
    findBlock() { return { name: 'deepslate_diamond_ore', position: ore, boundingBox: 'block' }; },
    findBlocks() { return [ore]; },
    blockAt(p) {
      const q = typeof p.floored === 'function' ? p.floored() : p;
      if (q.x === 5 && q.y === 10 && q.z === 0) return { name: 'deepslate_diamond_ore', position: q, boundingBox: 'block' };
      if (exposed && q.x === 6 && q.y === 10 && q.z === 0) return { name: 'air', position: q, boundingBox: 'empty' };
      return { name: 'stone', position: q, boundingBox: 'block' };
    },
    pathfinder: { async goto() {} },
    collectBlock: { async collect(b) { bot._collected = (bot._collected || 0) + 1; } },
  };
  return bot;
}

test('anti-xray: isExposed vrai si ≥1 face air, faux si 100% enterré', () => {
  assert.strictEqual(isExposed(oreBot({ exposed: true }), pos(5, 10, 0)), true);
  assert.strictEqual(isExposed(oreBot({ exposed: false }), pos(5, 10, 0)), false);
});

test('anti-xray: gather REFUSE un ore enterré (pas de beeline x-ray)', async () => {
  const bot = oreBot({ exposed: false });
  const r = await gather(bot, { name: 'deepslate_diamond_ore', count: 1 });
  assert.strictEqual(r.ok, false);
  assert.ok(!bot._collected, 'ne doit PAS avoir percé vers l\'ore caché');
});

test('anti-xray: gather accepte un ore À FLANC DE PAROI (1 face air)', async () => {
  const bot = oreBot({ exposed: true });
  const r = await gather(bot, { name: 'deepslate_diamond_ore', count: 1 });
  assert.strictEqual(r.ok, true);
});

test('anti-xray: les blocs NON-ore (bois/pierre) ne sont pas filtrés', async () => {
  // un log enterré (cas absurde mais : le filtre ne s'applique qu'aux ORES)
  const ore = pos(5, 10, 0);
  const bot = oreBot({ exposed: false });
  bot.registry.blocksByName.oak_log = { id: 17 };
  bot.findBlock = () => ({ name: 'oak_log', position: ore, boundingBox: 'block' });
  bot.findBlocks = () => [ore];
  bot.blockAt = (p) => {
    const q = typeof p.floored === 'function' ? p.floored() : p;
    if (q.x === 5 && q.y === 10 && q.z === 0) return { name: 'oak_log', position: q, boundingBox: 'block' };
    return { name: 'stone', position: q, boundingBox: 'block' };
  };
  const r = await gather(bot, { name: 'oak_log', count: 1 });
  assert.strictEqual(r.ok, true);
});
