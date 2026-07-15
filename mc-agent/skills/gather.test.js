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

test('gather(explore:true) : les events explore (explore_directed) remontent via bot._emit — observabilité live', async () => {
  const { bot, calls } = makeBot({ target: pos(200, 70, 0), worldKey: 'w' }); // hors 64 blocs
  bot._worldMemory = { worlds: { w: { finds: [{ material: 'oak_log', biome: 'forest', x: 200, z: 0 }], biomes: [] } } };
  const res = await gather(bot, { name: 'oak_log', count: 1, explore: true });
  assert.strictEqual(res.ok, true);
  const ev = calls.emits.find((e) => e.type === 'explore_directed');
  assert.ok(ev, 'explore_directed émis dans le flux stdout du bot (run.log)');
  assert.strictEqual(ev.learned, true);
});

test('gather : bloc inconnu du registry → not_found immédiat (jamais findBlock(matching:null))', async () => {
  const { bot, calls } = makeBot({ target: pos(10, 70, 0) });
  let badMatching = false;
  const origFind = bot.findBlock.bind(bot);
  bot.findBlock = (o) => { if (!o || o.matching == null) badMatching = true; return origFind(o); };
  const res = await gather(bot, { name: 'totally_unknown_block', count: 1, explore: true });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'not_found');
  assert.strictEqual(badMatching, false, 'findBlock jamais appelé avec matching null/undefined');
  assert.strictEqual(calls.goto.length, 0, 'pas d\'exploration pour un bloc que le registre ne connaît pas');
});

test('gather(explore:true) : cible locale INATTEIGNABLE (collect échoue ×2) → tente explore/directed avant d\'abandonner', async () => {
  // Vu live HarvT6 : diamant enterré vu par findBlock(64) mais immin able → collect_failed direct,
  // alors que la carte connaissait une cave. Le local raté ne doit pas court-circuiter la mémoire.
  const { bot, calls } = makeBot({ target: pos(10, 20, 0), worldKey: 'w' }); // « enterré » sous le bot
  bot._worldMemory = { worlds: { w: { finds: [{ material: 'oak_log', biome: 'forest', x: 300, z: 0 }], biomes: [] } } };
  let collectCalls = 0;
  const goodTarget = pos(300, 70, 0);
  bot.collectBlock.collect = async (b) => {
    collectCalls++;
    if (b.position.y === 20) throw new Error('unreachable'); // la cible enterrée échoue TOUJOURS
    calls.collect.push(b);
  };
  // après le voyage dirigé, findBlock rend la VRAIE cible près de la cave apprise
  const origFind = bot.findBlock.bind(bot);
  bot.findBlock = ({ maxDistance }) => {
    const d1 = bot.entity.position.distanceTo(pos(10, 20, 0));
    const d2 = bot.entity.position.distanceTo(goodTarget);
    if (d2 <= (maxDistance || 64)) return { name: 'oak_log', position: goodTarget, boundingBox: 'block' };
    if (d1 <= (maxDistance || 64)) return { name: 'oak_log', position: pos(10, 20, 0), boundingBox: 'block' };
    return null;
  };
  const res = await gather(bot, { name: 'oak_log', count: 1, explore: true });
  assert.strictEqual(res.ok, true, `récolté via le directed malgré l'échec local (res=${JSON.stringify(res)})`);
  assert.ok(calls.collect.length >= 1, 'la cible dirigée a été récoltée');
});

test('gather : échec final → mouvement résiduel STOPPÉ (setGoal(null), pas de creusage fantôme)', async () => {
  const { bot } = makeBot({ target: pos(10, 20, 0) });
  let goalCleared = false;
  bot.pathfinder.setGoal = (g) => { if (g === null) goalCleared = true; };
  bot.collectBlock.collect = async () => { throw new Error('unreachable'); };
  const res = await gather(bot, { name: 'oak_log', count: 1 });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'collect_failed');
  assert.strictEqual(goalCleared, true, 'pathfinder.setGoal(null) appelé après l\'échec (anti-creusage fantôme)');
});

test('gather : collect qui HANG est borné (collectTimeoutMs) → ne fige pas, collect_failed — bug review #6', async () => {
  // collectBlock.collect peut ne JAMAIS se résoudre (cible inminable/désync) → sans borne, branchMine
  // (gather opportuniste) gèle jusqu'à 900s, hors de portée des watchdogs. La borne doit rejeter et
  // laisser le catch retomber proprement (retry borné puis collect_failed), pas hang.
  const { bot } = makeBot({ target: pos(10, 70, 0) });
  let collectCalls = 0;
  bot.collectBlock.collect = () => { collectCalls++; return new Promise(() => {}); }; // hang éternel
  const t0 = Date.now();
  const res = await gather(bot, { name: 'oak_log', count: 1, collectTimeoutMs: 40 });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'collect_failed');
  assert.ok(collectCalls >= 2, `a retenté une fois malgré le hang (collectCalls=${collectCalls})`);
  assert.ok(Date.now() - t0 < 2000, 'borné (pas de hang)');
});

test('gather : pas de material_found sans worldKey (manuel) ni sans biome connu (datapack)', async () => {
  const a = makeBot({ target: pos(10, 70, 0), biome: 'forest' }); // pas de worldKey (lancement manuel)
  await gather(a.bot, { name: 'oak_log', count: 1 });
  assert.strictEqual(a.calls.emits.filter((e) => e.type === 'material_found').length, 0);
  const b = makeBot({ target: pos(10, 70, 0), worldKey: 'w' }); // biome inconnu (mineflayer sans nom)
  await gather(b.bot, { name: 'oak_log', count: 1 });
  assert.strictEqual(b.calls.emits.filter((e) => e.type === 'material_found').length, 0);
});

// Expédition bois (Massii 15/07) : « si il n'y a plus de bois au spawn ils vont plus loin, s'ils
// grappillent les miettes des arbres restants ils perdent trop de temps » → quand il faut VOYAGER
// (aucun bois local), faire le PLEIN en un trajet (gros lot) au lieu de revenir pour 3 bûches.
const { woodExpeditionCount } = require('./gather');

test('woodExpeditionCount : bois local présent → lot de base (pas de sur-collecte inutile)', () => {
  assert.strictEqual(woodExpeditionCount(3, true), 3);
  assert.strictEqual(woodExpeditionCount(6, true), 6);
});
test('woodExpeditionCount : pas de bois local (voyage requis) → gros lot ≥12 (le plein en 1 trajet)', () => {
  assert.strictEqual(woodExpeditionCount(3, false), 12);
  assert.strictEqual(woodExpeditionCount(6, false), 12);
});
test('woodExpeditionCount : ne réduit jamais un lot déjà gros', () => {
  assert.strictEqual(woodExpeditionCount(16, false), 16);
  assert.strictEqual(woodExpeditionCount(16, true), 16);
});
