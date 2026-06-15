'use strict';
// Survie « basique + » du cartographe (spec §5.2) : manger, se nourrir (chasse passive),
// se défendre (1-2 hostiles), fuir (≥3 hostiles ou PV bas). Décisions PURES + tick orchestrateur.
const { test } = require('node:test');
const assert = require('node:assert');
const vec3 = require('vec3');
const {
  combatDecision, isArmored, nearbyHostiles, hasFood, needHunt, nearestPassive, eatAny, survivalTick,
  SWARM_COUNT, LOW_HEALTH, SWARM_UNARMORED, LOW_HEALTH_UNARMORED, HUNT_HUNGER, EAT_HUNGER, RAW_FOODS,
} = require('./survival');

// --- Fake bot (vrai Vec3, leçon dcd874d) ---
function fakeEntity(name, kind, pos) {
  return { name, kind, type: 'mob', position: vec3(pos.x, pos.y, pos.z), isValid: true };
}
function fakeBot({ pos = { x: 0, y: 64, z: 0 }, health = 20, food = 20, items = [], entities = [] } = {}) {
  const calls = { attack: [], flee: 0, equip: [], consume: 0, goto: [] };
  const bot = {
    health, food,
    entity: { position: vec3(pos.x, pos.y, pos.z) },
    entities: Object.fromEntries(entities.map((e, i) => [i, e])),
    inventory: { items: () => items.map(([name, count]) => ({ name, count })) },
    nearestEntity(fn) {
      let best = null, bestD = Infinity;
      for (const e of Object.values(this.entities)) {
        if (!fn(e)) continue;
        const d = e.position.distanceTo(this.entity.position);
        if (d < bestD) { bestD = d; best = e; }
      }
      return best;
    },
    equip: async (it) => { calls.equip.push(it.name); },
    consume: async () => { calls.consume++; },
    pvp: { attack: (e) => calls.attack.push(e.name), stop: () => {} },
    pathfinder: { setGoal: () => {}, goto: async (g) => calls.goto.push(g) },
    registry: { itemsByName: {} },
  };
  return { bot, calls };
}

// --- combatDecision (pur) ---
test('combatDecision : 0 hostile -> null', () => {
  assert.strictEqual(combatDecision({ health: 20, hostileCount: 0 }), null);
});
test('combatDecision : 1-2 hostiles + PV ok -> fight', () => {
  assert.strictEqual(combatDecision({ health: 20, hostileCount: 1 }), 'fight');
  assert.strictEqual(combatDecision({ health: 12, hostileCount: 2 }), 'fight');
});
test('combatDecision : submergé (>=3 hostiles) -> flee', () => {
  assert.strictEqual(combatDecision({ health: 20, hostileCount: SWARM_COUNT }), 'flee');
  assert.strictEqual(combatDecision({ health: 20, hostileCount: 5 }), 'flee');
});
test('combatDecision : PV bas + au moins 1 hostile -> flee', () => {
  assert.strictEqual(combatDecision({ health: LOW_HEALTH, hostileCount: 1 }), 'flee');
});
test('combatDecision : PV bas mais 0 hostile -> null (rien à fuir)', () => {
  assert.strictEqual(combatDecision({ health: 4, hostileCount: 0 }), null);
});

// --- combatDecision armor-aware (paquet 2 : anti « mort par combo » sans armure) ---
test('combatDecision : SANS armure → fuit dès 2 hostiles (vs 3 avec)', () => {
  assert.strictEqual(combatDecision({ health: 20, hostileCount: 2, armored: false }), 'flee');
  assert.strictEqual(combatDecision({ health: 20, hostileCount: 2, armored: true }), 'fight');
});
test('combatDecision : SANS armure → fuit dès PV ≤ 16 (vs ≤ 8 avec)', () => {
  assert.strictEqual(combatDecision({ health: LOW_HEALTH_UNARMORED, hostileCount: 1, armored: false }), 'flee');
  assert.strictEqual(combatDecision({ health: 11, hostileCount: 1, armored: true }), 'fight'); // 11 > 8 → se bat avec armure
});
test('combatDecision : AVEC armure garde les seuils courageux (rétro-compat défaut)', () => {
  assert.strictEqual(combatDecision({ health: 9, hostileCount: 1, armored: true }), 'fight');
  assert.strictEqual(combatDecision({ health: 9, hostileCount: 1 }), 'fight'); // défaut (sans flag) = courageux
  assert.ok(SWARM_UNARMORED < SWARM_COUNT && LOW_HEALTH_UNARMORED > LOW_HEALTH);
});
test('isArmored : vrai si une pièce dans les slots 5-8, faux sinon', () => {
  const armored = { inventory: { slots: [null, null, null, null, null, { name: 'iron_chestplate' }, null, null, null] } };
  const bare = { inventory: { slots: [null, null, null, null, null, null, null, null, null] } };
  assert.strictEqual(isArmored(armored), true);
  assert.strictEqual(isArmored(bare), false);
  assert.strictEqual(isArmored({}), false); // pas d'inventaire → faux (pas de throw)
});

// --- nearbyHostiles ---
test('nearbyHostiles : filtre kind=Hostile mobs ET rayon', () => {
  const { bot } = fakeBot({
    entities: [
      fakeEntity('zombie', 'Hostile mobs', { x: 5, y: 64, z: 0 }),    // proche
      fakeEntity('skeleton', 'Hostile mobs', { x: 50, y: 64, z: 0 }), // trop loin
      fakeEntity('cow', 'Passive mobs', { x: 3, y: 64, z: 0 }),       // pas hostile
    ],
  });
  const hostiles = nearbyHostiles(bot, 10);
  assert.strictEqual(hostiles.length, 1);
  assert.strictEqual(hostiles[0].name, 'zombie');
});

// --- nourriture ---
test('hasFood : vrai avec du cuit, vrai avec du cru, faux sans rien', () => {
  assert.ok(hasFood(fakeBot({ items: [['bread', 1]] }).bot));
  assert.ok(hasFood(fakeBot({ items: [['beef', 2]] }).bot));        // cru accepté (RAW_FOODS)
  assert.ok(!hasFood(fakeBot({ items: [['cobblestone', 9]] }).bot));
});
test('needHunt : faim + pas de nourriture -> true ; sinon false', () => {
  assert.ok(needHunt(fakeBot({ food: HUNT_HUNGER, items: [] }).bot));
  assert.ok(!needHunt(fakeBot({ food: HUNT_HUNGER, items: [['bread', 1]] }).bot));
  assert.ok(!needHunt(fakeBot({ food: 20, items: [] }).bot));
});
test('nearestPassive : la vache la plus proche, ignore les hostiles', () => {
  const { bot } = fakeBot({
    entities: [
      fakeEntity('cow', 'Passive mobs', { x: 8, y: 64, z: 0 }),
      fakeEntity('pig', 'Passive mobs', { x: 4, y: 64, z: 0 }),
      fakeEntity('zombie', 'Hostile mobs', { x: 2, y: 64, z: 0 }),
    ],
  });
  assert.strictEqual(nearestPassive(bot, 24).name, 'pig');
});
test('eatAny : mange du cru quand faim ; rien si pas faim ; rien sans nourriture', async () => {
  const a = fakeBot({ food: 8, items: [['porkchop', 1]] });
  assert.ok(await eatAny(a.bot));
  assert.strictEqual(a.calls.consume, 1);
  const b = fakeBot({ food: 20, items: [['porkchop', 1]] });
  assert.ok(!(await eatAny(b.bot)));
  const c = fakeBot({ food: 8, items: [] });
  assert.ok(!(await eatAny(c.bot)));
});
test('RAW_FOODS contient les viandes crues de chasse', () => {
  for (const f of ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit']) assert.ok(RAW_FOODS.has(f));
});

// --- survivalTick (orchestrateur) ---
test('survivalTick : 3 hostiles proches -> flee (fleeFrom appelé)', async () => {
  const { bot } = fakeBot({
    entities: [0, 1, 2].map((i) => fakeEntity('zombie', 'Hostile mobs', { x: 3 + i, y: 64, z: 0 })),
  });
  let fled = 0;
  const act = await survivalTick(bot, { fleeFrom: () => { fled++; return true; } });
  assert.strictEqual(act, 'flee');
  assert.strictEqual(fled, 1);
});
test('survivalTick : 1 hostile proche -> fight (pvp.attack + équipe une arme)', async () => {
  const { bot, calls } = fakeBot({
    items: [['stone_sword', 1]],
    entities: [fakeEntity('zombie', 'Hostile mobs', { x: 4, y: 64, z: 0 })],
  });
  const act = await survivalTick(bot, { fleeFrom: () => true });
  assert.strictEqual(act, 'fight');
  assert.deepStrictEqual(calls.attack, ['zombie']);
  assert.deepStrictEqual(calls.equip, ['stone_sword']);
});
test('survivalTick : faim + nourriture en poche -> eat', async () => {
  const { bot, calls } = fakeBot({ food: 6, items: [['bread', 1]] });
  const act = await survivalTick(bot, { fleeFrom: () => true });
  assert.strictEqual(act, 'eat');
  assert.strictEqual(calls.consume, 1);
});
test('survivalTick : faim + rien à manger + cochon proche -> hunt (attaque le passif)', async () => {
  const { bot, calls } = fakeBot({
    food: 6,
    entities: [fakeEntity('pig', 'Passive mobs', { x: 6, y: 64, z: 0 })],
  });
  const act = await survivalTick(bot, { fleeFrom: () => true });
  assert.strictEqual(act, 'hunt');
  assert.deepStrictEqual(calls.attack, ['pig']);
});
test('survivalTick : rien à signaler -> null', async () => {
  const { bot } = fakeBot();
  assert.strictEqual(await survivalTick(bot, { fleeFrom: () => true }), null);
});
test('survivalTick : faim + rien à manger + AUCUN passif -> null (n\'engage pas)', async () => {
  const { bot, calls } = fakeBot({ food: 6 });
  assert.strictEqual(await survivalTick(bot, { fleeFrom: () => true }), null);
  assert.deepStrictEqual(calls.attack, []);
});
