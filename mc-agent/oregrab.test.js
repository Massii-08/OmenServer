'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { isWantedOre, canHarvest, shouldGrab, isValuableDrop, isDetourWorthy } = require('./oregrab');

test('isWantedOre : fer et deepslate fer, pas le remblai', () => {
  assert.strictEqual(isWantedOre('iron_ore'), true);
  assert.strictEqual(isWantedOre('deepslate_iron_ore'), true);
  assert.strictEqual(isWantedOre('coal_ore'), true);
  assert.strictEqual(isWantedOre('diamond_ore'), true);
  assert.strictEqual(isWantedOre('stone'), false);
  assert.strictEqual(isWantedOre('dirt'), false);
  assert.strictEqual(isWantedOre(null), false);
  assert.strictEqual(isWantedOre(undefined), false);
});

test('canHarvest : aucun outil requis → toujours oui', () => {
  assert.strictEqual(canHarvest({ name: 'dirt' }, 42), true);
  assert.strictEqual(canHarvest({ name: 'dirt' }, null), true);
});

test('canHarvest : outil requis → seulement le bon (sinon on casse le fer pour RIEN)', () => {
  const ironOre = { name: 'iron_ore', harvestTools: { 274: true, 257: true } };
  assert.strictEqual(canHarvest(ironOre, 274), true);
  assert.strictEqual(canHarvest(ironOre, 257), true);
  assert.strictEqual(canHarvest(ironOre, 270), false);   // pioche en bois → 0 drop
  assert.strictEqual(canHarvest(ironOre, null), false);  // main nue
});

test('canHarvest : clés de harvestTools en chaîne (JSON) acceptées', () => {
  assert.strictEqual(canHarvest({ harvestTools: { '274': true } }, 274), true);
});

test('canHarvest : bloc absent → non', () => {
  assert.strictEqual(canHarvest(null, 274), false);
});

test('shouldGrab : au calme → oui', () => {
  assert.strictEqual(shouldGrab({ health: 20 }), true);
  assert.strictEqual(shouldGrab({}), true);
});

test('shouldGrab : jamais au détriment de la survie ni d une tâche critique', () => {
  assert.strictEqual(shouldGrab({ busy: true }), false);
  assert.strictEqual(shouldGrab({ digging: true }), false);
  assert.strictEqual(shouldGrab({ inWater: true }), false);
  assert.strictEqual(shouldGrab({ hostilesNear: true }), false);
  assert.strictEqual(shouldGrab({ health: 6 }), false);
  assert.strictEqual(shouldGrab({ health: 8 }), false);
  assert.strictEqual(shouldGrab({ health: 9 }), true);
});

// ─── VALUABLE_DROPS : ramasser ce qui SERT quand ça traîne au sol ───────────────────────────────
// Massii, live 26/07 : « si il y a des item qui leur servent (genre diamant) il doivent les
// prendre ». Un minerai miné hors de portée de ramassage auto tombe au sol et y reste.
test('isValuableDrop : les ressources qui font avancer la chaîne', () => {
  for (const n of ['diamond', 'raw_iron', 'iron_ingot', 'coal', 'emerald', 'gold_ingot', 'raw_gold', 'redstone', 'lapis_lazuli']) {
    assert.strictEqual(isValuableDrop(n), true, n + ' devrait être ramassé');
  }
});

test('isValuableDrop : on ne se détourne PAS pour du remblai ou du décor', () => {
  for (const n of ['cobblestone', 'dirt', 'gravel', 'andesite', 'oak_leaves', 'poppy', 'seeds']) {
    assert.strictEqual(isValuableDrop(n), false, n + ' ne vaut pas un détour');
  }
});

test('isValuableDrop : entrée vide/inconnue → false (jamais de détour à l aveugle)', () => {
  assert.strictEqual(isValuableDrop(''), false);
  assert.strictEqual(isValuableDrop(null), false);
  assert.strictEqual(isValuableDrop('bloc_inexistant'), false);
});

// ─── DETOUR pour un minerai de VALEUR visible (Massii, live 26/07) ─────────────────────────────
// « neth 4 a reussi a esquiver une cave, alors que dans la cave il y avait un diamant ». Le
// ramassage opportuniste ne mordait qu'a portee de BRAS (4,2 blocs) : un diamant visible a dix
// blocs, dans une grotte qu'on longe, etait ignore — et pendant la DESCENTE `caveHunt` ne tourne
// pas encore. Certains minerais valent qu'on se detourne de quelques blocs, meme en pleine tache.
test('isDetourWorthy : diamant/emeraude/debris valent un detour', () => {
  for (const n of ['diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'deepslate_emerald_ore', 'ancient_debris']) {
    assert.strictEqual(isDetourWorthy(n), true, n);
  }
});

test('isDetourWorthy : le tout-venant ne justifie PAS de quitter sa tache', () => {
  for (const n of ['iron_ore', 'coal_ore', 'copper_ore', 'stone', 'redstone_ore']) {
    assert.strictEqual(isDetourWorthy(n), false, n);
  }
});

// ── CUIVRE : ne plus se detourner pour un minerai que junkItems fera jeter (mesure 27/07) ───────
// 106 `ore_grabbed` de cuivre pour 27 de fer sur world_mn5 : 78 % des detours servaient un minerai
// inutile aux chaines fer et diamant. Le bot minait pour jeter, et saturait son inventaire.
test('le cuivre n_est plus un minerai a ramasser', () => {
  assert.strictEqual(isWantedOre('copper_ore'), false);
  assert.strictEqual(isWantedOre('deepslate_copper_ore'), false);
});

test('le cuivre au sol ne vaut plus un detour', () => {
  assert.strictEqual(isValuableDrop('raw_copper'), false);
  assert.strictEqual(isValuableDrop('copper_ingot'), false);
});

test('ce qui SERT aux chaines reste ramasse (garde-fou anti-sur-filtrage)', () => {
  for (const n of ['iron_ore', 'deepslate_iron_ore', 'coal_ore', 'diamond_ore', 'gold_ore']) {
    assert.strictEqual(isWantedOre(n), true, n);
  }
  for (const n of ['raw_iron', 'iron_ingot', 'coal', 'diamond']) {
    assert.strictEqual(isValuableDrop(n), true, n);
  }
});

// ─── Quelques pas pour du minerai visible (Massii 27/07, photo de 3 veines de fer intactes) ─────
// « Certains ont encore des pioches mais ils ne creusent pas le fer » : ce n'était pas l'outil,
// c'était le contrat « portée de bras, aucun déplacement ». Dans une salle creusée le fer est
// dans les PAROIS, à 5-10 blocs. Un joueur fait trois pas.
const { oreStepPlan, ORE_STEP_MAX, ORE_REACH } = require('./oregrab');

test('minerai deja a portee de bras : on mine sans bouger', () => {
  assert.strictEqual(oreStepPlan({ name: 'iron_ore', dist: 2 }), 'reach');
  assert.strictEqual(oreStepPlan({ name: 'deepslate_iron_ore', dist: ORE_REACH }), 'reach');
});

test('minerai a quelques pas : on y va (c est le cas de la photo)', () => {
  assert.strictEqual(oreStepPlan({ name: 'iron_ore', dist: 8 }), 'walk');
  assert.strictEqual(oreStepPlan({ name: 'iron_ore', dist: ORE_STEP_MAX }), 'walk');
});

test('minerai trop loin : on laisse (ce serait un detour, plus une ponctuation)', () => {
  assert.strictEqual(oreStepPlan({ name: 'iron_ore', dist: ORE_STEP_MAX + 1 }), null);
});

test('bloc sans interet : on ne bouge pas, meme colle au nez', () => {
  assert.strictEqual(oreStepPlan({ name: 'stone', dist: 1 }), null);
  assert.strictEqual(oreStepPlan({ name: 'copper_ore', dist: 1 }), null);
});

test('entrees absurdes : on laisse', () => {
  assert.strictEqual(oreStepPlan({ name: 'iron_ore', dist: NaN }), null);
  assert.strictEqual(oreStepPlan({ name: 'iron_ore' }), null);
  assert.strictEqual(oreStepPlan({}), null);
  assert.strictEqual(oreStepPlan(), null);
});

// ─── LE RAMASSAGE NE VOLE PLUS LE TRAJET EN COURS (mesure goal_trace, 19/10) ───────────────────
// Premier appelant qui interrompait un `pathfinder.goto` en cours : `Timeout._onTimeout@index.js:6083`
// = la marche 'walk' de ce timer. Ses goto (marche, ramassage d'un drop, approche hors ligne de vue)
// écrasaient le but du planner → GoalChanged → explore / branch-mine / migration ratés.
const { grabScope, mayApproach } = require('./oregrab');

test('grabScope : pendant une MIGRATION le timer ne fait RIEN', () => {
  const s = grabScope({ migrating: true });
  assert.strictEqual(s.run, false);
  assert.strictEqual(s.detour, false);
  assert.strictEqual(s.walk, false);
  assert.strictEqual(s.drops, false);
  assert.strictEqual(s.approach, false);
});

test('grabScope : la migration prime même sans autre but posé', () => {
  assert.strictEqual(grabScope({ migrating: true, goal: null }).run, false);
  assert.strictEqual(grabScope({ migrating: true, goal: {} }).run, false);
});

test('grabScope : un AUTRE but actif → portée de bras seulement, mais le détour rare reste permis', () => {
  const s = grabScope({ goal: { planner: true } });
  assert.strictEqual(s.run, true);
  assert.strictEqual(s.detour, true, 'diamant/émeraude/débris : rare, vaut l interruption');
  assert.strictEqual(s.walk, false, 'plus de quelques pas vers du fer');
  assert.strictEqual(s.drops, false, 'plus de marche vers un item au sol');
  assert.strictEqual(s.approach, false, 'plus de goto pour contourner une paroi');
  assert.strictEqual(s.maxDist, ORE_REACH);
  assert.ok(s.scan >= ORE_REACH && s.scan < ORE_STEP_MAX, 'le scan se limite à ce qu on a le droit de miner');
});

test('grabScope : en portée de bras, oreStepPlan ne rend plus jamais walk', () => {
  const { maxDist } = grabScope({ goal: { planner: true } });
  assert.strictEqual(oreStepPlan({ name: 'iron_ore', dist: 3, maxDist }), 'reach');
  assert.strictEqual(oreStepPlan({ name: 'iron_ore', dist: 8, maxDist }), null);
});

test('grabScope : aucun but → comportement d avant, inchangé', () => {
  const s = grabScope({ goal: null });
  assert.deepStrictEqual(
    { run: s.run, detour: s.detour, walk: s.walk, drops: s.drops, approach: s.approach, maxDist: s.maxDist, scan: s.scan },
    { run: true, detour: true, walk: true, drops: true, approach: true, maxDist: ORE_STEP_MAX, scan: ORE_STEP_MAX },
  );
  assert.strictEqual(oreStepPlan({ name: 'iron_ore', dist: 8, maxDist: s.maxDist }), 'walk');
  assert.deepStrictEqual(grabScope(), grabScope({ goal: null }));
});

test('grabScope : le RELIQUAT de notre propre but n est pas « un autre trajet »', () => {
  // NoPath / chemin vide : mineflayer-pathfinder ne remet PAS `goal` à null — sans cette règle, un
  // minerai inatteignable une fois mettrait le timer en portée de bras jusqu'au prochain trajet.
  const ours = { ore: true };
  assert.strictEqual(grabScope({ goal: ours, ownGoal: ours }).walk, true);
  assert.strictEqual(grabScope({ goal: { other: true }, ownGoal: ours }).walk, false);
});

test('mayApproach : contourner une paroi = un goto → seulement sans autre trajet, ou pour du rare', () => {
  const free = grabScope({ goal: null });
  const busy = grabScope({ goal: { planner: true } });
  const mig = grabScope({ migrating: true });
  assert.strictEqual(mayApproach(free, 'iron_ore'), true);
  assert.strictEqual(mayApproach(busy, 'iron_ore'), false);
  assert.strictEqual(mayApproach(busy, 'deepslate_diamond_ore'), true);
  assert.strictEqual(mayApproach(mig, 'diamond_ore'), false);
  assert.strictEqual(mayApproach(null, 'diamond_ore'), false);
});
