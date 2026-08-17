'use strict';
// Survie « basique + » du cartographe (spec §5.2) : manger, se nourrir (chasse passive),
// se défendre (1-2 hostiles), fuir (≥3 hostiles ou PV bas). Décisions PURES + tick orchestrateur.
const { test } = require('node:test');
const assert = require('node:assert');
const vec3 = require('vec3');
const {
  combatDecision, isArmored, nearbyHostiles, hasFood, needHunt, nearestPassive, eatAny, survivalTick,
  hasFleeOnly, FLEE_ONLY_LOWHP_THRESHOLD, combatCapability, armorPoints, weaponDamage,
  SWARM_COUNT, LOW_HEALTH, SWARM_UNARMORED, LOW_HEALTH_UNARMORED, HUNT_HUNGER, EAT_HUNGER, RAW_FOODS,
  CRITICAL_HUNGER, REGEN_FOOD, NO_REGEN_HP_MARGIN,
} = require('./survival');

// --- Fake bot (vrai Vec3, leçon dcd874d) ---
function fakeEntity(name, kind, pos) {
  return { name, kind, type: 'mob', position: vec3(pos.x, pos.y, pos.z), isValid: true };
}
function fakeBot({ pos = { x: 0, y: 64, z: 0 }, health = 20, food = 20, items = [], entities = [], slots = null } = {}) {
  const calls = { attack: [], flee: 0, equip: [], consume: 0, goto: [] };
  const bot = {
    health, food,
    entity: { position: vec3(pos.x, pos.y, pos.z) },
    entities: Object.fromEntries(entities.map((e, i) => [i, e])),
    // slots (optionnel) : armure portée pour les tests isArmored/armorPoints via survivalTick.
    // Omis par défaut → inventory.slots reste undefined, comportement historique intact.
    inventory: { items: () => items.map(([name, count]) => ({ name, count })), ...(slots ? { slots } : {}) },
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

// --- combatDecision creeper-aware (live 22/06 R3 : fight creeper → explosion → mort en deep) ---
test('combatDecision : CREEPER → flee même PV plein + armure + 1 seul hostile (jamais mêlée)', () => {
  assert.strictEqual(combatDecision({ health: 20, hostileCount: 1, armored: true, hasCreeper: true }), 'flee');
});
test('combatDecision : sans creeper, comportement inchangé (fight si PV ok)', () => {
  assert.strictEqual(combatDecision({ health: 20, hostileCount: 1, armored: true, hasCreeper: false }), 'fight');
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

// --- combatDecision faim-aware (food, Massii : 167 morts/3h dont beaucoup « starved to death while
// fighting » — un bot affamé se battait comme s'il allait régénérer). food absent/undefined DOIT
// laisser le comportement STRICTEMENT identique (aucun test existant ci-dessus ne doit changer).
test('combatDecision : food absent → seuil bas-santé inchangé (pas de +2 fantôme)', () => {
  // Sans food, le seuil relevé (LOW_HEALTH + marge) ne doit PAS s'appliquer : à cette santé, fight.
  assert.strictEqual(combatDecision({ health: LOW_HEALTH + NO_REGEN_HP_MARGIN, hostileCount: 1, armored: true }), 'fight');
});
test('combatDecision : food absent → armure jamais forcée à false (pas de swarm fantôme)', () => {
  // Sans food, armored:true garde le seuil de swarm courageux même à 2 hostiles.
  assert.strictEqual(combatDecision({ health: 20, hostileCount: SWARM_UNARMORED, armored: true }), 'fight');
});
test('combatDecision : food EXPLICITEMENT null (bot jamais reçu de packet) → comportement inchangé', () => {
  assert.strictEqual(combatDecision({ health: LOW_HEALTH_UNARMORED, hostileCount: 1, armored: false, food: null }), 'flee');
});

test('combatDecision : food critique (≤ CRITICAL_HUNGER) EN ARMURE COMPLÈTE → seuils SANS ARMURE (swarm)', () => {
  // 2 hostiles + armored:true → historiquement 'fight' (SWARM_COUNT=3) ; food critique force
  // les seuils non-armurés (SWARM_UNARMORED=2) même en armure complète.
  assert.strictEqual(combatDecision({ health: 20, hostileCount: SWARM_UNARMORED, armored: true, food: CRITICAL_HUNGER }), 'flee');
  assert.strictEqual(combatDecision({ health: 20, hostileCount: SWARM_UNARMORED, armored: true, food: CRITICAL_HUNGER - 1 }), 'flee');
});
test('combatDecision : food critique (≤ CRITICAL_HUNGER) EN ARMURE COMPLÈTE → seuils SANS ARMURE (PV bas)', () => {
  assert.strictEqual(combatDecision({ health: LOW_HEALTH_UNARMORED, hostileCount: 1, armored: true, food: CRITICAL_HUNGER }), 'flee');
});
test('combatDecision : food JUSTE au-dessus du critique → armure PAS forcée (seul le +2 régén joue)', () => {
  assert.strictEqual(combatDecision({ health: 20, hostileCount: SWARM_UNARMORED, armored: true, food: CRITICAL_HUNGER + 1 }), 'fight');
});

test('combatDecision : food ≤ REGEN_FOOD (pas de régén) → seuil de fuite relevé de +NO_REGEN_HP_MARGIN (armure)', () => {
  const lowHp = LOW_HEALTH + NO_REGEN_HP_MARGIN;
  assert.strictEqual(combatDecision({ health: lowHp, hostileCount: 1, armored: true, food: REGEN_FOOD }), 'flee');
  assert.strictEqual(combatDecision({ health: lowHp + 1, hostileCount: 1, armored: true, food: REGEN_FOOD }), 'fight');
});
test('combatDecision : food ≤ REGEN_FOOD (pas de régén) → seuil de fuite relevé de +NO_REGEN_HP_MARGIN (sans armure)', () => {
  const lowHp = LOW_HEALTH_UNARMORED + NO_REGEN_HP_MARGIN;
  assert.strictEqual(combatDecision({ health: lowHp, hostileCount: 1, armored: false, food: REGEN_FOOD }), 'flee');
  assert.strictEqual(combatDecision({ health: lowHp + 1, hostileCount: 1, armored: false, food: REGEN_FOOD }), 'fight');
});

test('combatDecision : food > REGEN_FOOD (régén active) → comportement normal (pas de marge, armure pas forcée)', () => {
  assert.strictEqual(combatDecision({ health: LOW_HEALTH + NO_REGEN_HP_MARGIN, hostileCount: 1, armored: true, food: REGEN_FOOD + 1 }), 'fight');
  assert.strictEqual(combatDecision({ health: 20, hostileCount: SWARM_UNARMORED, armored: true, food: 20 }), 'fight');
});

test('combatDecision : faim (même critique) n\'écrase PAS les priorités creeper/lave/fleeOnly/preferFlee', () => {
  assert.strictEqual(combatDecision({ health: 20, hostileCount: 1, armored: true, hasCreeper: true, food: CRITICAL_HUNGER }), 'flee');
  assert.strictEqual(combatDecision({ health: 20, hostileCount: 1, armored: true, lavaNear: true, food: CRITICAL_HUNGER }), 'flee');
  assert.strictEqual(combatDecision({ health: 20, hostileCount: 1, armored: true, fleeOnly: true, food: 20 }), 'flee');
  // preferFlee garde sa propre règle de distance, la faim ne la court-circuite pas :
  assert.strictEqual(combatDecision({ health: 20, hostileCount: 1, armored: true, preferFlee: true, nearestDist: 2, food: CRITICAL_HUNGER }), 'fight');
  assert.strictEqual(combatDecision({ health: 20, hostileCount: 1, armored: true, preferFlee: true, nearestDist: 10, food: 20 }), 'flee');
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

test('nearbyHostiles : EXCLUT l\'enderman (neutre, bug #3) même classé Hostile mobs', () => {
  const { bot } = fakeBot({
    entities: [
      fakeEntity('enderman', 'Hostile mobs', { x: 3, y: 64, z: 0 }),  // proche MAIS neutre → exclu
      fakeEntity('zombie', 'Hostile mobs', { x: 4, y: 64, z: 0 }),    // proche, vrai hostile
    ],
  });
  const hostiles = nearbyHostiles(bot, 10);
  assert.strictEqual(hostiles.length, 1, 'l\'enderman ne doit jamais être ciblé');
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

// --- survivalTick : câblage réel food -> combatDecision (bot.food, Massii 167 morts/3h) ---
test('survivalTick : food critique EN ARMURE COMPLÈTE → flee via les seuils sans-armure (câblage bout-en-bout)', async () => {
  const armorSlots = [null, null, null, null, null, { name: 'iron_chestplate' }, null, null, null];
  const { bot } = fakeBot({
    food: CRITICAL_HUNGER, slots: armorSlots,
    entities: [0, 1].map((i) => fakeEntity('zombie', 'Hostile mobs', { x: 3 + i, y: 64, z: 0 })), // 2 hostiles
  });
  assert.strictEqual(isArmored(bot), true, 'préalable : le fake bot est bien détecté armuré');
  let fled = 0;
  const act = await survivalTick(bot, { fleeFrom: () => { fled++; return true; } });
  assert.strictEqual(act, 'flee', 'armure complète MAIS food critique → seuils sans-armure (2 hostiles = submergé)');
  assert.strictEqual(fled, 1);
});

test('survivalTick : food ≤ REGEN_FOOD → fuite plus tôt (+NO_REGEN_HP_MARGIN) même sans armure explicite', async () => {
  const lowHp = LOW_HEALTH_UNARMORED + NO_REGEN_HP_MARGIN;
  const { bot } = fakeBot({
    health: lowHp, food: REGEN_FOOD,   // sans armure (pas de slots) : seuil historique LOW_HEALTH_UNARMORED
    entities: [fakeEntity('zombie', 'Hostile mobs', { x: 4, y: 64, z: 0 })],
  });
  let fled = 0;
  const act = await survivalTick(bot, { fleeFrom: () => { fled++; return true; } });
  assert.strictEqual(act, 'flee', `${lowHp} PV > seuil historique (${LOW_HEALTH_UNARMORED}) mais <= seuil relevé par la faim`);
  assert.strictEqual(fled, 1);
});

test('survivalTick : food = 20 (rassasié, défaut) → seuils historiques intacts (rétro-compat bout-en-bout)', async () => {
  const { bot } = fakeBot({
    health: LOW_HEALTH_UNARMORED + NO_REGEN_HP_MARGIN,   // fuirait SI la faim jouait, mais food=20 ici
    entities: [fakeEntity('zombie', 'Hostile mobs', { x: 4, y: 64, z: 0 })],
  });
  const act = await survivalTick(bot, { fleeFrom: () => true });
  assert.strictEqual(act, 'fight', 'rassasié → le seuil relevé ne doit jamais s\'appliquer');
});

test('combatDecision preferFlee (mappeur) : fuit par défaut, se défend UNIQUEMENT à portée de coup (≤3)', () => {
  const base = { health: 20, hostileCount: 1, armored: true, hasCreeper: false, lavaNear: false, preferFlee: true };
  assert.strictEqual(combatDecision({ ...base, nearestDist: 10 }), 'flee');
  assert.strictEqual(combatDecision({ ...base, nearestDist: 2.5 }), 'fight');
  assert.strictEqual(combatDecision({ ...base, hasCreeper: true, nearestDist: 2 }), 'flee'); // creeper : jamais mêlée
});

// --- FLEE-ONLY (AltoClef getUniversallyDangerousMob) : mobs trop dangereux pour le contact ---
test('hasFleeOnly : wither_skeleton TOUJOURS (même PV plein)', () => {
  assert.strictEqual(hasFleeOnly([{ name: 'wither_skeleton' }], 20), true);
  assert.strictEqual(hasFleeOnly([{ name: 'zombie' }], 20), false);
});
test('hasFleeOnly : hoglin/zoglin seulement si PV bas (< seuil)', () => {
  assert.strictEqual(hasFleeOnly([{ name: 'hoglin' }], 20), false);                       // PV plein → toléré
  assert.strictEqual(hasFleeOnly([{ name: 'hoglin' }], FLEE_ONLY_LOWHP_THRESHOLD - 1), true); // bas → fuir
  assert.strictEqual(hasFleeOnly([{ name: 'zoglin' }], 5), true);
});
test('combatDecision : fleeOnly → flee AVANT la branche fight (même PV plein + armure)', () => {
  assert.strictEqual(combatDecision({ health: 20, hostileCount: 1, armored: true, fleeOnly: true }), 'flee');
  // sans le flag, comportement inchangé (rétro-compat)
  assert.strictEqual(combatDecision({ health: 20, hostileCount: 1, armored: true }), 'fight');
});
test('survivalTick : wither_skeleton proche → flee (jamais riposté), reason=flee_only', async () => {
  const evs = [];
  const { bot, calls } = fakeBot({
    items: [['iron_sword', 1]],
    entities: [fakeEntity('wither_skeleton', 'Hostile mobs', { x: 4, y: 64, z: 0 })],
  });
  const act = await survivalTick(bot, { fleeFrom: () => true, emit: (e) => evs.push(e) });
  assert.strictEqual(act, 'flee');
  assert.deepStrictEqual(calls.attack, []);                          // n'a PAS engagé
  assert.strictEqual(evs.find((e) => e.action === 'flee').reason, 'flee_only');
});
test('survivalTick : hoglin à PV plein → toujours fight (pas flee-only à pleine vie)', async () => {
  const { bot, calls } = fakeBot({
    health: 20, items: [['iron_sword', 1]],
    entities: [fakeEntity('hoglin', 'Hostile mobs', { x: 4, y: 64, z: 0 })],
  });
  const act = await survivalTick(bot, { fleeFrom: () => true });
  assert.strictEqual(act, 'fight');
  assert.deepStrictEqual(calls.attack, ['hoglin']);
});

// --- canDealWith (AltoClef) : capacité de combat graduée, CAUTIOUS-ONLY + multi-mob-only ---
test('combatCapability : formule AltoClef (nu+sans épée=1 ; fer complet+épée fer=7)', () => {
  assert.strictEqual(combatCapability(0, 0), 1);        // nu, mains nues : gère 0 mob
  assert.strictEqual(combatCapability(15, 3), 7);       // armure fer (15) + épée fer (3)
  assert.strictEqual(combatCapability(1, 0), 2);        // 1 botte cuir, sans épée
});
test('combatDecision : capability ≤ count ET ≥2 mobs → flee (gère pas le nombre)', () => {
  assert.strictEqual(combatDecision({ health: 20, hostileCount: 2, armored: true, capability: 2 }), 'flee');
});
test('combatDecision : capability CAUTIOUS-ONLY — ne s\'applique JAMAIS à 1 seul mob', () => {
  // 1 mob : le gate hostileCount>=2 ne s'applique pas → comportement inchangé (fight)
  assert.strictEqual(combatDecision({ health: 20, hostileCount: 1, armored: true, capability: 1 }), 'fight');
});
test('combatDecision : capability suffisante (>count) → fight (bot bien équipé, 0 régression)', () => {
  assert.strictEqual(combatDecision({ health: 20, hostileCount: 2, armored: true, capability: 5 }), 'fight');
});
test('combatDecision : sans capability → comportement historique inchangé', () => {
  assert.strictEqual(combatDecision({ health: 20, hostileCount: 2, armored: true }), 'fight');
});
test('armorPoints / weaponDamage : lecture des slots portés + meilleure épée', () => {
  const bot = {
    inventory: {
      slots: [null, null, null, null, null, { name: 'iron_chestplate' }, null, null, { name: 'leather_boots' }],
      items: () => [{ name: 'stone_sword' }, { name: 'iron_sword' }, { name: 'cobblestone' }],
    },
  };
  assert.strictEqual(armorPoints(bot), 7);              // iron_chestplate(6) + leather_boots(1)
  assert.strictEqual(weaponDamage(bot), 3);             // meilleure épée = iron_sword
  assert.strictEqual(weaponDamage({ inventory: { items: () => [] } }), 0);
});
