'use strict';
// Survie « basique + » du cartographe (spec §5.2) : manger, se nourrir (chasse passive),
// se défendre (1-2 hostiles), fuir (≥3 hostiles ou PV bas). Décisions PURES + tick orchestrateur.
const { test } = require('node:test');
const assert = require('node:assert');
const vec3 = require('vec3');
const {
  combatDecision, isArmored, nearbyHostiles, hasFood, needHunt, nearestPassive, eatAny, survivalTick,
  canDealWith, attackDamage, boldFightAdvised, BOLD_MIN_HEALTH,
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
  // AJUSTÉ (20/10, canDealWith AltoClef) : seul un zombie aux POINGS (canDealWith 2 > 1) ferait désormais
  // combattre — la règle « on gère le nombre et PV > 8 » l'emporte sur le seuil sans-armure. Le cas
  // « fuite plus tôt par la faim » reste vrai quand on NE gère PAS le nombre : 2 zombies.
  const lowHp = LOW_HEALTH_UNARMORED + NO_REGEN_HP_MARGIN;
  const { bot } = fakeBot({
    health: lowHp, food: REGEN_FOOD,   // sans armure (pas de slots) : seuil historique LOW_HEALTH_UNARMORED
    entities: [0, 1].map((i) => fakeEntity('zombie', 'Hostile mobs', { x: 4 + i, y: 64, z: 0 })),
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


// --- canDealWith (AltoClef MobDefenseChain, 20/10) : COMBATTRE quand on gère le nombre ---
test('canDealWith : ceil(armure*3.6/20 + (1+dégât)*0.8) + 1', () => {
  assert.strictEqual(canDealWith(0, 0), 2);              // nu, poings : ceil(0.8)+1
  assert.strictEqual(canDealWith(0, 4), 5);              // nu, épée en bois : ceil(4)+1
  assert.strictEqual(canDealWith(15, 6), 10);            // fer complet + épée fer : ceil(2.7+5.6)+1
});
test('attackDamage : meilleure arme en poche (épée ou hache, valeurs épée), 0 sans arme', () => {
  const inv = (names) => ({ inventory: { items: () => names.map((name) => ({ name })) } });
  assert.strictEqual(attackDamage(inv(['wooden_sword'])), 4);
  assert.strictEqual(attackDamage(inv(['stone_sword', 'iron_sword'])), 6);
  assert.strictEqual(attackDamage(inv(['diamond_sword'])), 7);
  assert.strictEqual(attackDamage(inv(['netherite_sword'])), 8);
  assert.strictEqual(attackDamage(inv(['stone_axe'])), 5);
  assert.strictEqual(attackDamage(inv(['cobblestone'])), 0);
  assert.strictEqual(attackDamage({}), 0);
});
test('boldFightAdvised : canDealWith > nb ET PV > 8 ET au moins 1 mob à combattre', () => {
  assert.strictEqual(boldFightAdvised({ health: 12, fightCount: 2, canDealWith: 5 }), true);
  assert.strictEqual(boldFightAdvised({ health: BOLD_MIN_HEALTH, fightCount: 1, canDealWith: 5 }), false, 'PV = 8 → non');
  assert.strictEqual(boldFightAdvised({ health: 20, fightCount: 2, canDealWith: 2 }), false, 'égalité → non');
  assert.strictEqual(boldFightAdvised({ health: 20, fightCount: 0, canDealWith: 5 }), false, 'rien à combattre');
  assert.strictEqual(boldFightAdvised({ health: 20, fightCount: 1 }), false, 'sans canDealWith → non');
  assert.strictEqual(boldFightAdvised({ health: 20, fightCount: 1, canDealWith: 5, food: 6 }), false, 'faim critique : non');
});
test('combatDecision : canDealWith > nb ET PV > 8 → fight, MÊME nu là où on fuyait (2 mobs / PV 12)', () => {
  const base = { armored: false, hostileCount: 2 };
  assert.strictEqual(combatDecision({ ...base, health: 12 }), 'flee', 'sans canDealWith : historique');
  assert.strictEqual(combatDecision({ ...base, health: 12, canDealWith: 5, fightCount: 2 }), 'fight');
  assert.strictEqual(combatDecision({ ...base, health: 12, canDealWith: 2, fightCount: 2 }), 'flee', 'ne gère pas le nombre');
  assert.strictEqual(combatDecision({ ...base, health: 8, canDealWith: 9, fightCount: 2 }), 'flee', 'PV ≤ 8');
});
test('combatDecision : canDealWith ne passe JAMAIS devant creeper / lave / fleeOnly / mappeur', () => {
  const b = { health: 20, hostileCount: 1, canDealWith: 9, fightCount: 1 };
  assert.strictEqual(combatDecision({ ...b, hasCreeper: true }), 'flee');
  assert.strictEqual(combatDecision({ ...b, lavaNear: true }), 'flee');
  assert.strictEqual(combatDecision({ ...b, fleeOnly: true }), 'flee');
  assert.strictEqual(combatDecision({ ...b, preferFlee: true, nearestDist: 8 }), 'flee', 'mappeur : fuite par défaut');
});

function fusing(dx) {
  const e = fakeEntity('creeper', 'Hostile mobs', { x: dx, y: 64, z: 0 });
  e.metadata = []; e.metadata[16] = 1;
  return e;
}
test('survivalTick : creeper CALME à > 4 blocs → ignoré (pas de fuite, pas de combat, rien)', async () => {
  const { bot, calls } = fakeBot({ entities: [fakeEntity('creeper', 'Hostile mobs', { x: 7, y: 64, z: 0 })] });
  let fled = 0;
  const act = await survivalTick(bot, { fleeFrom: () => { fled++; return true; } });
  assert.strictEqual(act, null);
  assert.strictEqual(fled, 0);
  assert.deepStrictEqual(calls.attack, []);
});
test('survivalTick : creeper qui GONFLE à ≤ 7 blocs → flee', async () => {
  const { bot, calls } = fakeBot({ items: [['iron_sword', 1]], entities: [fusing(6)] });
  let fled = 0;
  const act = await survivalTick(bot, { fleeFrom: () => { fled++; return true; } });
  assert.strictEqual(act, 'flee');
  assert.strictEqual(fled, 1);
  assert.deepStrictEqual(calls.attack, []);
});
test('survivalTick : creeper calme à ≤ 4 blocs → s éloigne (flee), jamais frappé', async () => {
  const { bot, calls } = fakeBot({ items: [['iron_sword', 1]], entities: [fakeEntity('creeper', 'Hostile mobs', { x: 3, y: 64, z: 0 })] });
  const act = await survivalTick(bot, { fleeFrom: () => true });
  assert.strictEqual(act, 'flee');
  assert.deepStrictEqual(calls.attack, []);
});
// Mesuré en prod (NethBot1, 22/10) : goal_trace a compté 15 appels à fleeFrom en 60 s dont 14
// INTERROMPUS — chaque tick de survie (~1,5 s) rappelait fleeFrom même pendant que le trajet de
// fuite précédent était toujours en cours, annulant le but juste posé avant qu'il n'aboutisse.
// Le bot restait sur place à se faire tirer par un squelette au lieu de s'éloigner (puis déconnexion/
// mort). Même parachute que `_lastFightChosenAt` (horloge reculée → prêt, cf. lignes 266-267).
test('survivalTick flee : ne rappelle pas fleeFrom tant que le trajet de fuite précédent est en cours (anti-thrash)', async () => {
  const { bot } = fakeBot({ items: [['iron_sword', 1]], entities: [fakeEntity('creeper', 'Hostile mobs', { x: 3, y: 64, z: 0 })] });
  bot.pathfinder.isMoving = () => true;   // le trajet de fuite posé au tick précédent tourne encore
  let fleeCalls = 0;
  let t = 2e12;
  const deps = { fleeFrom: () => { fleeCalls++; return true; }, now: () => t };

  assert.strictEqual(await survivalTick(bot, deps), 'flee');
  assert.strictEqual(fleeCalls, 1, '1er tick : fleeFrom déclenché');

  t += 1500;   // tick de survie suivant, 1,5 s plus tard, toujours en train de fuir
  assert.strictEqual(await survivalTick(bot, deps), 'flee');
  assert.strictEqual(fleeCalls, 1, '2e tick rapproché pendant la fuite en cours : pas de ré-appel');

  bot.pathfinder.isMoving = () => false;   // le trajet est arrivé/a échoué : on peut reconsidérer tout de suite
  assert.strictEqual(await survivalTick(bot, deps), 'flee');
  assert.strictEqual(fleeCalls, 2, 'trajet terminé (isMoving=false) : nouvel appel même sous le délai');
});
test('survivalTick : zombie + creeper calme lointain → on combat le ZOMBIE (le creeper ne compte pas)', async () => {
  const { bot, calls } = fakeBot({
    items: [['stone_sword', 1]],
    entities: [fakeEntity('creeper', 'Hostile mobs', { x: 2, y: 64, z: 6 }), fakeEntity('zombie', 'Hostile mobs', { x: 4, y: 64, z: 0 })],
  });
  const act = await survivalTick(bot, { fleeFrom: () => true });
  assert.strictEqual(act, 'fight');
  assert.deepStrictEqual(calls.attack, ['zombie']);
});
test('survivalTick : nu + épée de pierre, 2 zombies, PV 12 → fight (canDealWith 6 > 2) + event fight_chosen', async () => {
  const evs = [];
  const { bot, calls } = fakeBot({
    health: 12, items: [['stone_sword', 1]],
    entities: [0, 1].map((i) => fakeEntity('zombie', 'Hostile mobs', { x: 3 + i, y: 64, z: 0 })),
  });
  const act = await survivalTick(bot, { fleeFrom: () => true, emit: (e) => evs.push(e), now: () => 1e9 });
  assert.strictEqual(act, 'fight');
  assert.deepStrictEqual(calls.attack, ['zombie']);
  const fc = evs.find((e) => e.type === 'fight_chosen');
  assert.ok(fc, 'fight_chosen émis');
  assert.strictEqual(fc.canDealWith, 6);
  assert.strictEqual(fc.hostiles, 2);
});
test('survivalTick : mappeur (preferFlee) nu + épée, 1 zombie à 6 blocs → toujours flee', async () => {
  const { bot } = fakeBot({ items: [['iron_sword', 1]], entities: [fakeEntity('zombie', 'Hostile mobs', { x: 6, y: 64, z: 0 })] });
  assert.strictEqual(await survivalTick(bot, { fleeFrom: () => true, preferFlee: true }), 'flee');
});

test('boldFightAdvised : Hard — sans armure (capacité < 7) jamais plus de 2 mobs', () => {
  assert.strictEqual(boldFightAdvised({ health: 20, fightCount: 2, canDealWith: 5 }), true);
  assert.strictEqual(boldFightAdvised({ health: 20, fightCount: 3, canDealWith: 5 }), false, 'nu + épée bois face à 3 → non');
  assert.strictEqual(boldFightAdvised({ health: 20, fightCount: 3, canDealWith: 7 }), true, 'armuré → oui');
});

// NUIT (fix 20/10) : 24/37 morts récentes par zombie ; NethBot1 18:27 UTC `fight_chosen` (1 zombie, 20 PV)
// puis combat poursuivi pendant que d'autres arrivaient → mort. La nuit, au-delà d'1 zombie et PV < 14,
// la règle audacieuse ne s'applique plus (les seuils prudents reprennent la main).
test('boldFightAdvised : nuit + > 1 mob + PV < 14 → non ; 1 mob ou PV ≥ 14 → règle habituelle', () => {
  assert.strictEqual(boldFightAdvised({ health: 13, fightCount: 2, canDealWith: 5, night: true }), false);
  assert.strictEqual(boldFightAdvised({ health: 13, fightCount: 2, canDealWith: 5 }), true, 'de jour : inchangé');
  assert.strictEqual(boldFightAdvised({ health: 13, fightCount: 1, canDealWith: 5, night: true }), true, '1 seul zombie');
  assert.strictEqual(boldFightAdvised({ health: 14, fightCount: 2, canDealWith: 5, night: true }), true, 'PV 14');
});

test('survivalTick : la nuit vient de bot.time (2 zombies, 13 PV, épée pierre → plus de fight_chosen)', async () => {
  const run = async (tod) => {
    const { bot } = fakeBot({ health: 13, items: [['stone_sword', 1]], entities: [
      fakeEntity('zombie', 'Hostile mobs', { x: 2, y: 64, z: 0 }), fakeEntity('zombie', 'Hostile mobs', { x: -2, y: 64, z: 0 })] });
    bot.time = { timeOfDay: tod };
    const out = [];
    await survivalTick(bot, { fleeFrom: () => true, emit: (e) => out.push(e), lavaNear: () => false });
    return out;
  };
  assert.ok((await run(6000)).some((e) => e.type === 'fight_chosen'), 'jour : combat audacieux choisi');
  assert.ok(!(await run(18000)).some((e) => e.type === 'fight_chosen'), 'nuit : plus de combat audacieux');
});

// ABRI TENU (live 22/10, NethBot1 session 206) : enterré, ni fuite ni pvp — frappe sur place.
test('survivalTick holdPosition : 3 hostiles dont un au contact → frappe SUR PLACE, jamais fleeFrom ni pvp', async () => {
  const { bot, calls } = fakeBot({
    entities: [fakeEntity('zombie', 'Hostile mobs', { x: 2, y: 64, z: 0 }),
      fakeEntity('skeleton', 'Hostile mobs', { x: 6, y: 64, z: 0 }), fakeEntity('zombie', 'Hostile mobs', { x: 7, y: 64, z: 0 })],
  });
  let fled = 0; const struck = [];
  const act = await survivalTick(bot, { fleeFrom: () => { fled++; }, holdPosition: () => true, strikeInPlace: (t) => struck.push(t.name) });
  assert.strictEqual(act, 'hold_strike');
  assert.strictEqual(fled, 0);
  assert.deepStrictEqual(calls.attack, []);
  assert.deepStrictEqual(struck, ['zombie']);
});
test('survivalTick holdPosition : hostile hors de portée → null (on reste dans le trou), pas de chasse', async () => {
  const { bot, calls } = fakeBot({ food: 6, entities: [fakeEntity('zombie', 'Hostile mobs', { x: 6, y: 64, z: 0 }),
    fakeEntity('pig', 'Passive mobs', { x: 4, y: 64, z: 0 })] });
  let fled = 0;
  const act = await survivalTick(bot, { fleeFrom: () => { fled++; }, holdPosition: () => true, strikeInPlace: () => {} });
  assert.strictEqual(act, null);
  assert.strictEqual(fled, 0);
  assert.deepStrictEqual(calls.attack, []);
});
