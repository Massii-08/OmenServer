'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('./lumberjack');

const NOW = 1_800_000_000_000;
const mate = (name, o = {}) => Object.assign({ name, x: 0, z: 0, role: 'worker', at: NOW - 1000, armor: 0 }, o);

test('isWoodGoal : seuls les buts gatherLog', () => {
  assert.strictEqual(L.isWoodGoal({ name: 'logs', skill: 'gatherLog' }), true);
  assert.strictEqual(L.isWoodGoal({ name: 'gift_planks', skill: 'gatherLog' }), true);
  assert.strictEqual(L.isWoodGoal({ name: 'planks', skill: 'craftPlanks' }), false);
  assert.strictEqual(L.isWoodGoal(null), false);
});

test('woodWantFor : plancher 16, plafond 32', () => {
  assert.strictEqual(L.woodWantFor({ args: { count: 3 } }), 16);
  assert.strictEqual(L.woodWantFor({ args: { count: 24 } }), 24);
  assert.strictEqual(L.woodWantFor({ args: { count: 99 } }), 32);
  assert.strictEqual(L.woodWantFor({}), 16);
});

test('logCount : toutes essences, ignore le reste', () => {
  assert.strictEqual(L.logCount({ oak_log: 3, birch_log: 2, oak_planks: 9, stripped_oak_log: 1 }), 6);
  assert.strictEqual(L.logCount(null), 0);
});

test('activeLumberjack : rôle lumberjack FRAIS, jamais soi-même', () => {
  const mates = [mate('A'), mate('B', { role: 'lumberjack' })];
  assert.strictEqual(L.activeLumberjack({ mates, selfName: 'A', now: NOW }), 'B');
  assert.strictEqual(L.activeLumberjack({ mates, selfName: 'B', now: NOW }), null);
  const stale = [mate('B', { role: 'lumberjack', at: NOW - L.LUMBERJACK_FRESH_MS - 1 })];
  assert.strictEqual(L.activeLumberjack({ mates: stale, selfName: 'A', now: NOW }), null);
});

test('woodWaitDecision : bûcheron/mappeur/sans bûcheron → self', () => {
  assert.strictEqual(L.woodWaitDecision({ isLumberjack: true, lumberjack: 'B', now: NOW }).action, 'self');
  assert.strictEqual(L.woodWaitDecision({ isMapper: true, lumberjack: 'B', now: NOW }).action, 'self');
  const d = L.woodWaitDecision({ lumberjack: null, request: { want: 16, at: NOW - 1000 }, now: NOW });
  assert.strictEqual(d.action, 'self');
  assert.strictEqual(d.clear, true, 'une demande sans bûcheron est retirée');
});

test('woodWaitDecision : première fois → request, puis wait, puis timeout à 4 min', () => {
  assert.strictEqual(L.woodWaitDecision({ lumberjack: 'B', request: null, now: NOW }).action, 'request');
  const w = L.woodWaitDecision({ lumberjack: 'B', request: { want: 16, at: NOW - 60000 }, now: NOW });
  assert.strictEqual(w.action, 'wait');
  assert.strictEqual(w.remainingMs, L.WOOD_REQUEST_TTL_MS - 60000);
  const t = L.woodWaitDecision({ lumberjack: 'B', request: { want: 16, at: NOW - L.WOOD_REQUEST_TTL_MS }, now: NOW });
  assert.strictEqual(t.action, 'timeout');
});

test('woodWaitDecision : demande PÉRIMÉE (process d\'il y a longtemps) → nouvelle demande, pas un faux timeout', () => {
  const d = L.woodWaitDecision({ lumberjack: 'B', request: { want: 16, at: NOW - 3 * L.WOOD_REQUEST_TTL_MS }, now: NOW });
  assert.strictEqual(d.action, 'request');
});

test('woodWaitDecision : après un timeout, 10 min d\'autonomie bois', () => {
  const d = L.woodWaitDecision({ lumberjack: 'B', request: null, timedOutAt: NOW - 60000, now: NOW });
  assert.strictEqual(d.action, 'self');
  const d2 = L.woodWaitDecision({ lumberjack: 'B', request: null, timedOutAt: NOW - L.WOOD_REQUEST_COOLDOWN_MS, now: NOW });
  assert.strictEqual(d2.action, 'request');
});

test('preferredLumberjack : le mieux armé, nom en départage, jamais un mappeur', () => {
  const mates = [mate('NethBot2', { armor: 1 }), mate('NethBot3', { armor: 4 }), mate('MapBot1', { role: 'mapper', armor: 4 }),
    mate('NethBot1', { armor: 4 })];
  assert.strictEqual(L.preferredLumberjack({ selfName: 'NethBot2', selfArmor: 1, mates, now: NOW }), 'NethBot1');
  // présence périmée exclue
  const m2 = [mate('NethBot1', { armor: 4, at: NOW - L.LUMBERJACK_FRESH_MS - 5 }), mate('NethBot3', { armor: 4 })];
  assert.strictEqual(L.preferredLumberjack({ selfName: 'NethBot2', selfArmor: 1, mates: m2, now: NOW }), 'NethBot3');
});

test('preferredLumberjack : pas d\'élection si je suis le seul ouvrier', () => {
  const mates = [mate('MapBot1', { role: 'mapper' })];
  assert.strictEqual(L.preferredLumberjack({ selfName: 'NethBot1', selfArmor: 4, mates, now: NOW }), null);
});

test('preferredLumberjack : soi compte avec SON armure, pas celle publiée il y a 60 s', () => {
  const mates = [mate('NethBot1', { armor: 2 }), mate('NethBot2', { armor: 0 })];
  assert.strictEqual(L.preferredLumberjack({ selfName: 'NethBot2', selfArmor: 3, mates, now: NOW }), 'NethBot2');
});

test('lumberjackVerdict : claim à un autre frais → follower ; à moi → keep ; libre → claim si préféré', () => {
  const base = { selfName: 'A', now: NOW };
  assert.strictEqual(L.lumberjackVerdict({ ...base, holder: { by: 'B', at: NOW - 1000 }, preferred: 'A' }), 'follower');
  assert.strictEqual(L.lumberjackVerdict({ ...base, holder: { by: 'A', at: NOW - 1000 }, preferred: 'B' }), 'keep');
  assert.strictEqual(L.lumberjackVerdict({ ...base, holder: null, preferred: 'A' }), 'claim');
  assert.strictEqual(L.lumberjackVerdict({ ...base, holder: null, preferred: 'B' }), 'follower');
  // sticky : déjà bûcheron, claim perdue (expirée) → on la reprend même si un autre serait préféré
  assert.strictEqual(L.lumberjackVerdict({ ...base, holder: null, preferred: 'B', amLumberjack: true }), 'claim');
  // plus aucun coéquipier (preferred null) : un bûcheron rend le rôle
  assert.strictEqual(L.lumberjackVerdict({ ...base, holder: { by: 'A', at: NOW }, preferred: null, amLumberjack: true }), 'release');
});

test('pickWoodRequest : la demande la plus ANCIENNE, quantité bornée par stock − réserve', () => {
  const mates = [
    mate('B', { woodWant: 16, woodAt: NOW - 30000 }),
    mate('C', { woodWant: 24, woodAt: NOW - 90000 }),
    mate('D'),
  ];
  assert.deepStrictEqual(L.pickWoodRequest({ mates, selfName: 'A', now: NOW, stock: 48 }), { to: 'C', amount: 24, want: 24 });
  assert.deepStrictEqual(L.pickWoodRequest({ mates, selfName: 'A', now: NOW, stock: 20 }), { to: 'C', amount: 12, want: 24 });
  // stock trop maigre pour un don utile
  assert.strictEqual(L.pickWoodRequest({ mates, selfName: 'A', now: NOW, stock: 11 }), null);
  // déjà servi / réservé
  assert.deepStrictEqual(L.pickWoodRequest({ mates, selfName: 'A', now: NOW, stock: 48, skip: new Set(['C']) }), { to: 'B', amount: 16, want: 16 });
});

test('pickWoodRequest : demandes expirées, mappeurs et soi-même ignorés', () => {
  const mates = [
    mate('B', { woodWant: 16, woodAt: NOW - L.WOOD_REQUEST_TTL_MS - 1 }),
    mate('M', { role: 'mapper', woodWant: 16, woodAt: NOW - 1000 }),
    mate('A', { woodWant: 16, woodAt: NOW - 1000 }),
    mate('E', { woodWant: 16, woodAt: NOW - 1000, at: NOW - L.LUMBERJACK_FRESH_MS - 1 }),
  ];
  assert.strictEqual(L.pickWoodRequest({ mates, selfName: 'A', now: NOW, stock: 48 }), null);
});

test('tossPlan : répartit la quantité sur les piles de bûches', () => {
  const items = [{ name: 'oak_log', type: 1, count: 10 }, { name: 'stone', type: 2, count: 64 }, { name: 'birch_log', type: 3, count: 20 }];
  assert.deepStrictEqual(L.tossPlan(items, 16), [{ type: 1, name: 'oak_log', count: 10 }, { type: 3, name: 'birch_log', count: 6 }]);
  assert.deepStrictEqual(L.tossPlan(items, 0), []);
});

// ─── ARMURE DU BÛCHERON (20/10 soir) ───────────────────────────────────────────────────────────────
test('missingIronPieces : pièces fer-ou-mieux manquantes, la moins chère d\'abord (poche comprise)', () => {
  assert.deepStrictEqual(L.missingIronPieces({}, []), ['iron_boots', 'iron_helmet', 'iron_leggings', 'iron_chestplate']);
  assert.deepStrictEqual(L.missingIronPieces({ iron_boots: 1 }, ['iron_helmet', 'diamond_chestplate']), ['iron_leggings']);
  // le cuir ne couvre pas un slot (rang < fer)
  assert.deepStrictEqual(L.missingIronPieces({}, ['leather_boots', 'iron_helmet', 'iron_leggings', 'iron_chestplate']), ['iron_boots']);
  assert.strictEqual(L.missingIronPieces(null, null).length, 4);
});

test('ownArmorAction : enfiler une pièce de poche d\'abord, sinon forger la moins chère abordable, sinon rien', () => {
  // NethBot3 réel (présence 20/10) : 2 pièces portées, 10 lingots → forge les jambières (7)
  assert.deepStrictEqual(L.ownArmorAction({ worn: ['iron_helmet', 'iron_boots'], pocket: [], ingots: 10 }),
    { act: 'forge', piece: 'iron_leggings', ingots: 7 });
  // une pièce fer SAINE en poche pour un slot vide → l'enfiler (gratuit)
  assert.deepStrictEqual(L.ownArmorAction({ worn: ['iron_helmet', 'iron_boots', 'iron_leggings'], pocket: ['iron_chestplate'], ingots: 0 }),
    { act: 'equip', piece: 'iron_chestplate' });
  // il manque le plastron (8), 5 lingots : rien d'abordable
  assert.strictEqual(L.ownArmorAction({ worn: ['iron_helmet', 'iron_boots', 'iron_leggings'], pocket: [], ingots: 5 }), null);
  // complet
  assert.strictEqual(L.ownArmorAction({ worn: ['iron_helmet', 'iron_boots', 'iron_leggings', 'iron_chestplate'], pocket: [], ingots: 30 }), null);
});

test('pickMapperForLumberjack : le cartographe le plus nu, les pièces qu\'il n\'a pas, dans le budget lingots', () => {
  const mates = [
    mate('MapBot2', { role: 'mapper', armor: 0, missing: ['iron_boots', 'iron_helmet', 'iron_leggings', 'iron_chestplate'] }),
    mate('MapBot1', { role: 'mapper', armor: 1, missing: ['iron_boots', 'iron_leggings', 'iron_chestplate'] }),
    mate('NethBot1', { armor: 2 }),
  ];
  // 10 lingots → bottes (4) + casque (5) pour MapBot2 (le plus nu)
  assert.deepStrictEqual(L.pickMapperForLumberjack({ mates, selfName: 'NethBot3', now: NOW, ingots: 10 }),
    { to: 'MapBot2', armor: 0, pieces: ['iron_boots', 'iron_helmet'], ingots: 9 });
  // MapBot2 déjà servi → MapBot1 : il a le casque, on ne lui en forge pas un deuxième
  assert.deepStrictEqual(L.pickMapperForLumberjack({ mates, selfName: 'NethBot3', now: NOW, ingots: 12, skip: new Set(['MapBot2']) }),
    { to: 'MapBot1', armor: 1, pieces: ['iron_boots', 'iron_leggings'], ingots: 11 });
  // une pièce DÉJÀ en poche ne coûte rien
  assert.deepStrictEqual(L.pickMapperForLumberjack({ mates, selfName: 'NethBot3', now: NOW, ingots: 0, pocket: ['iron_chestplate'] }),
    { to: 'MapBot2', armor: 0, pieces: ['iron_chestplate'], ingots: 0 });
  // moins de 4 lingots, rien en poche → personne
  assert.strictEqual(L.pickMapperForLumberjack({ mates, selfName: 'NethBot3', now: NOW, ingots: 3 }), null);
});

test('pickMapperForLumberjack : statut inconnu, présence périmée, pièce usée en poche', () => {
  // armure > 0 sans `missing` publié (process d'avant) : on ne sait pas QUOI forger → on passe
  assert.strictEqual(L.pickMapperForLumberjack({ mates: [mate('M', { role: 'mapper', armor: 2 })], selfName: 'A', now: NOW, ingots: 24 }), null);
  // armure 0 sans `missing` : tout manque, c'est certain
  assert.deepStrictEqual(L.pickMapperForLumberjack({ mates: [mate('M', { role: 'mapper', armor: 0 })], selfName: 'A', now: NOW, ingots: 4 }).pieces, ['iron_boots']);
  // présence périmée
  assert.strictEqual(L.pickMapperForLumberjack({ mates: [mate('M', { role: 'mapper', armor: 0, at: NOW - L.LUMBERJACK_FRESH_MS - 1 })], selfName: 'A', now: NOW, ingots: 24 }), null);
  // cartographe complet
  assert.strictEqual(L.pickMapperForLumberjack({ mates: [mate('M', { role: 'mapper', armor: 4, missing: [] })], selfName: 'A', now: NOW, ingots: 24 }), null);
  // une pièce USÉE du même nom traîne en poche : giveItem lancerait aussi celle-là → on ne la planifie pas
  assert.deepStrictEqual(L.pickMapperForLumberjack({ mates: [mate('M', { role: 'mapper', armor: 0 })], selfName: 'A', now: NOW, ingots: 9, brokenPocket: ['iron_boots'] }).pieces, ['iron_helmet']);
});

test('ljGiftReady : prêt quand toutes les pièces prévues sont en poche', () => {
  assert.strictEqual(L.ljGiftReady(['iron_boots', 'iron_helmet'], ['iron_helmet', 'iron_boots', 'stick']), true);
  assert.strictEqual(L.ljGiftReady(['iron_boots', 'iron_helmet'], ['iron_helmet']), false);
  assert.strictEqual(L.ljGiftReady([], []), false);
});

// ─── EXPÉDITION FORESTIÈRE ─────────────────────────────────────────────────────────────────────────
test('stockFails : 2 échecs lj_stock en 10 min déclenchent l\'expédition ; les vieux s\'oublient', () => {
  let l = L.stockFailsAdd([], NOW - 9 * 60000);
  assert.strictEqual(L.needsForestTrip(l, NOW), false);
  l = L.stockFailsAdd(l, NOW);
  assert.strictEqual(L.needsForestTrip(l, NOW), true);
  assert.strictEqual(L.needsForestTrip(l, NOW + 2 * 60000), false, 'le premier sort de la fenêtre');
  // entrées illisibles / du futur ignorées
  assert.deepStrictEqual(L.stockFailsPrune([NOW + 600000, 'x', null, NOW - 1000], NOW), [NOW - 1000]);
  // bornée
  let big = [];
  for (let i = 0; i < 30; i++) big = L.stockFailsAdd(big, NOW - i * 1000);
  assert.ok(big.length <= 6);
});

test('isForestBiome : forêts et jungles oui, eau/plaines non', () => {
  for (const b of ['forest', 'birch_forest', 'old_growth_birch_forest', 'minecraft:taiga', 'sparse_jungle', 'dark_forest', 'cherry_grove', 'mangrove_swamp'])
    assert.strictEqual(L.isForestBiome(b), true, b);
  for (const b of ['plains', 'river', 'ocean', 'desert', 'beach', '', null]) assert.strictEqual(L.isForestBiome(b), false, String(b));
});

test('pickForestCell : forêt connue la plus proche, hors zones rasées, hors ratées, dans la poche de la base', () => {
  const from = { x: -40, z: 46 };
  const anchor = { x: -40, z: 40 };
  const biomes = [
    { name: 'old_growth_birch_forest', x: -128, z: 0 },  // la cellule où il échoue : point visé à 0 bloc (< 48)
    { name: 'plains', x: 0, z: 128 },
    { name: 'forest', x: 0, z: -128 },                    // point visé (32, -33) : ≈ 107 du bot, ≈ 103 de la base
    { name: 'birch_forest', x: 128, z: 0 },               // point visé (160, 46) : 200 de la base → hors poche (> 150)
    { name: 'river', x: -256, z: 0 },
    { name: 'taiga', x: -256, z: 128 },                   // point visé (-161, 160) : ≈ 170 de la base → hors poche
  ];
  const r = L.pickForestCell({ from, anchor, biomes, now: NOW });
  assert.strictEqual(r.biome, 'forest');
  assert.deepStrictEqual([r.x, r.z], [32, -33]);
  assert.strictEqual(r.dist, 107);
  // la forêt est notée rasée (kind wood) → plus rien d'éligible
  assert.strictEqual(L.pickForestCell({ from, anchor, biomes, depleted: [{ x: r.x + 10, z: r.z, kind: 'wood', at: NOW - 1000 }], now: NOW }), null);
  // un épuisement de MINERAI n'enlève pas les arbres (leçon world_mn12)
  assert.strictEqual(L.pickForestCell({ from, anchor, biomes, depleted: [{ x: r.x, z: r.z, kind: 'ore', at: NOW - 1000 }], now: NOW }).biome, 'forest');
  // cellule ratée il y a 5 min → écartée
  assert.strictEqual(L.pickForestCell({ from, anchor, biomes, avoid: [{ x: r.x, z: r.z, at: NOW - 300000 }], now: NOW }), null);
  // sans ancre : la plus proche reste la forest
  assert.strictEqual(L.pickForestCell({ from, biomes, now: NOW }).biome, 'forest');
  assert.strictEqual(L.pickForestCell({ from, anchor, biomes: [], now: NOW }), null);
  assert.strictEqual(L.pickForestCell({ from: null, biomes, now: NOW }), null);
});

test('forestTriedAdd/Prune : mémoire des forêts ratées, 30 min, bornée', () => {
  let l = L.forestTriedAdd([], { x: 10, z: 20 }, NOW);
  assert.deepStrictEqual(l, [{ x: 10, z: 20, at: NOW }]);
  assert.deepStrictEqual(L.forestTriedPrune(l, NOW + L.LJ_FOREST_AVOID_MS + 1), []);
  for (let i = 0; i < 20; i++) l = L.forestTriedAdd(l, { x: i * 200, z: 0 }, NOW + i);
  assert.ok(l.length <= 8);
});
