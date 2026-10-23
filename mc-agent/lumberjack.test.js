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

test('preferredLumberjack : seuls les ouvriers à 4/4 PORTÉES sont éligibles, nom en départage, jamais un mappeur', () => {
  // `worn` = pièces PORTÉES (heartbeat) ; `armor` compte aussi la poche → il ne suffit pas.
  const mates = [mate('NethBot2', { armor: 1, worn: 1 }), mate('NethBot3', { armor: 4, worn: 4 }),
    mate('MapBot1', { role: 'mapper', armor: 4, worn: 4 }), mate('NethBot1', { armor: 4, worn: 4 })];
  assert.strictEqual(L.preferredLumberjack({ selfName: 'NethBot2', selfArmor: 1, selfWorn: 1, mates, now: NOW }), 'NethBot1');
  // présence périmée exclue
  const m2 = [mate('NethBot1', { armor: 4, worn: 4, at: NOW - L.LUMBERJACK_FRESH_MS - 5 }), mate('NethBot3', { armor: 4, worn: 4 })];
  assert.strictEqual(L.preferredLumberjack({ selfName: 'NethBot2', selfArmor: 1, selfWorn: 1, mates: m2, now: NOW }), 'NethBot3');
});

test('preferredLumberjack : AUCUN bûcheron tant que personne n\'a 4/4 portées (mesure 21/10 : bûcheron nu = 16 morts)', () => {
  const mates = [mate('NethBot1', { armor: 0, worn: 0 }), mate('NethBot3', { armor: 3, worn: 3 })];
  assert.strictEqual(L.preferredLumberjack({ selfName: 'NethBot2', selfArmor: 0, selfWorn: 0, mates, now: NOW }), null);
  // 4 pièces ACQUISES dont une en poche ≠ 4 portées
  const m2 = [mate('NethBot1', { armor: 4, worn: 3 }), mate('NethBot3', { armor: 0, worn: 0 })];
  assert.strictEqual(L.preferredLumberjack({ selfName: 'NethBot2', selfArmor: 4, selfWorn: 3, mates: m2, now: NOW }), null);
  // présence d'un ancien process sans `worn` → pas éligible (sûr)
  const m3 = [mate('NethBot1', { armor: 4 }), mate('NethBot3', { armor: 0 })];
  assert.strictEqual(L.preferredLumberjack({ selfName: 'NethBot2', selfArmor: 0, mates: m3, now: NOW }), null);
});

test('preferredLumberjack : pas d\'élection si je suis le seul ouvrier', () => {
  const mates = [mate('MapBot1', { role: 'mapper', worn: 4 })];
  assert.strictEqual(L.preferredLumberjack({ selfName: 'NethBot1', selfArmor: 4, selfWorn: 4, mates, now: NOW }), null);
});

test('preferredLumberjack : soi compte avec SES pièces portées, pas celles publiées il y a 60 s', () => {
  const mates = [mate('NethBot1', { armor: 2, worn: 2 }), mate('NethBot2', { armor: 0, worn: 0 })];
  assert.strictEqual(L.preferredLumberjack({ selfName: 'NethBot2', selfArmor: 4, selfWorn: 4, mates, now: NOW }), 'NethBot2');
  // un ouvrier nu n'est pas candidat, mais il compte pour « il y a quelqu'un à servir »
  assert.strictEqual(L.preferredLumberjack({ selfName: 'NethBot1', selfArmor: 4, selfWorn: 4,
    mates: [mate('NethBot2', { worn: 0 })], now: NOW }), 'NethBot1');
});

test('wornIronCount : pièces fer (ou mieux) portées, une par emplacement', () => {
  assert.strictEqual(L.wornIronCount(['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']), 4);
  assert.strictEqual(L.wornIronCount(['diamond_helmet', 'iron_chestplate', 'netherite_leggings', 'iron_boots']), 4);
  assert.strictEqual(L.wornIronCount(['leather_helmet', 'iron_chestplate', 'golden_boots']), 1);
  assert.strictEqual(L.wornIronCount(new Set(['iron_boots'])), 1);
  assert.strictEqual(L.wornIronCount(null), 0);
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

test('lumberjackVerdict : bûcheron qui perd une pièce (usure) → il rend le rôle, même s\'il tient la claim', () => {
  const base = { selfName: 'A', now: NOW, selfEligible: false };
  assert.strictEqual(L.lumberjackVerdict({ ...base, holder: { by: 'A', at: NOW }, preferred: 'B', amLumberjack: true }), 'release');
  assert.strictEqual(L.lumberjackVerdict({ ...base, holder: null, preferred: 'B', amLumberjack: true }), 'release');
  assert.strictEqual(L.lumberjackVerdict({ ...base, holder: { by: 'A', at: NOW }, preferred: null }), 'release');
  // non bûcheron, non éligible : simple suiveur (jamais de claim)
  assert.strictEqual(L.lumberjackVerdict({ ...base, holder: null, preferred: 'B' }), 'follower');
  assert.strictEqual(L.lumberjackVerdict({ ...base, holder: null, preferred: null }), 'follower');
  // claim d'un autre : suiveur
  assert.strictEqual(L.lumberjackVerdict({ ...base, holder: { by: 'B', at: NOW }, preferred: 'B', amLumberjack: true }), 'follower');
  // éligible : comportement historique inchangé
  assert.strictEqual(L.lumberjackVerdict({ selfName: 'A', holder: null, preferred: 'B', amLumberjack: true, selfEligible: true }), 'claim');
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

// ─── 20/10 : bois manquant pour un craft + armure cartographe par lots ─────────────────────────
const { craftWoodShortage, woodShortForFailure, giftBatchFor } = require('./lumberjack');

test('craftWoodShortage : 1 planche sans table ni bâtons → manque ; 1 bûche suffit pour les bâtons', () => {
  assert.strictEqual(craftWoodShortage({ planks: 1 }), true);
  assert.strictEqual(craftWoodShortage({ planks: 6 }), false);
  assert.strictEqual(craftWoodShortage({ logs: 1, table: true }), false);
  assert.strictEqual(craftWoodShortage({ planks: 0, sticks: 4, table: true }), false, 'rien à crafter en bois');
});

test('woodShortForFailure : cas réel NethBot2 session 312 (1 acacia_planks, 0 bûche, pas de table)', () => {
  const inv = { acacia_planks: 1, iron_ingot: 11, cobbled_deepslate: 18, cobblestone: 39 };
  assert.strictEqual(woodShortForFailure({ reason: 'pick_recovery:no_sticks', goalName: 'gift_pick', inv }), true);
  assert.strictEqual(woodShortForFailure({ reason: 'no_table:unknown_item', goalName: 'gift_craft', inv }), true);
  // une table à portée + pièce d'armure : il ne manque PAS de bois
  assert.strictEqual(woodShortForFailure({ reason: 'no_table:unknown_item', goalName: 'gift_craft', inv, hasTable: true }), false);
  // raison sans rapport avec le bois
  assert.strictEqual(woodShortForFailure({ reason: 'tpa_failed', goalName: 'gift_deliver', inv }), false);
  // assez de bois en poche : l'échec vient d'ailleurs
  assert.strictEqual(woodShortForFailure({ reason: 'pick_recovery:no_sticks', goalName: 'gift_pick', inv: { oak_log: 3 } }), false);
});

test('giftBatchFor : 11 lingots, MapBot2 nu → bottes + casque (9), plus cher reporté', () => {
  const now = 1_800_000_000_000;
  const target = { name: 'MapBot2', role: 'mapper', at: now, armor: 0,
    missing: ['iron_boots', 'iron_helmet', 'iron_leggings', 'iron_chestplate'] };
  const b = giftBatchFor({ target, ingots: 11, pocket: [], now });
  assert.deepStrictEqual(b.pieces, ['iron_boots', 'iron_helmet']);
  assert.strictEqual(b.ingots, 9);
  assert.strictEqual(b.to, 'MapBot2');
});

test('giftBatchFor : rien d’abordable → null ; pièce déjà en poche = gratuite', () => {
  const now = 1_800_000_000_000;
  const target = { name: 'MapBot1', role: 'mapper', at: now, armor: 1,
    missing: ['iron_helmet', 'iron_leggings', 'iron_chestplate'] };
  assert.strictEqual(giftBatchFor({ target, ingots: 2, pocket: [], now }), null);
  const b = giftBatchFor({ target, ingots: 2, pocket: ['iron_chestplate'], now });
  assert.deepStrictEqual(b.pieces, ['iron_chestplate']);
  assert.strictEqual(b.ingots, 0);
  assert.strictEqual(giftBatchFor({ target: null, ingots: 20, now }), null);
});

// ─── bûcheron oisif → fer (21/10) ─────────────────────────────────────────────────────────────────
{
  const base = { rawIron: 0, ingots: 0, cobble: 0, hasFurnace: false, hasStonePick: true, caveAvailable: true,
    nightLock: false, now: 1e6, lastSliceAt: 0 };
  test('ljIronSlicePlan : fer brut + four (ou 8 cobble) → fondre d\'abord', () => {
    assert.strictEqual(L.ljIronSlicePlan({ ...base, rawIron: 4, hasFurnace: true }), 'smelt');
    assert.strictEqual(L.ljIronSlicePlan({ ...base, rawIron: 4, cobble: 8 }), 'smelt');
    assert.strictEqual(L.ljIronSlicePlan({ ...base, rawIron: 4, cobble: 7 }), 'cave', 'pas de quoi fondre → miner encore');
    assert.strictEqual(L.ljIronSlicePlan({ ...base, rawIron: 3, hasFurnace: true }), 'cave', 'lot de 4 tant qu\'une grotte reste');
    assert.strictEqual(L.ljIronSlicePlan({ ...base, rawIron: 3, hasFurnace: true, caveAvailable: false }), 'smelt', 'plus de grotte → fondre le reste');
    assert.strictEqual(L.ljIronSlicePlan({ ...base, rawIron: 4, hasFurnace: true, nightLock: true }), 'smelt', 'fondre se fait dans l\'abri');
  });
  test('ljIronSlicePlan : grappe connue + pioche pierre + jour → grotte', () => {
    assert.strictEqual(L.ljIronSlicePlan(base), 'cave');
    assert.strictEqual(L.ljIronSlicePlan({ ...base, caveAvailable: false }), null);
    assert.strictEqual(L.ljIronSlicePlan({ ...base, hasStonePick: false }), null);
    assert.strictEqual(L.ljIronSlicePlan({ ...base, nightLock: true }), null);
  });
  test('ljIronSlicePlan : assez de fer → rien ; tranche récente → rien (anti boucle chaude)', () => {
    assert.strictEqual(L.ljIronSlicePlan({ ...base, ingots: 20, rawIron: 4 }), null, '24 en poche, rien pour fondre');
    assert.strictEqual(L.ljIronSlicePlan({ ...base, ingots: 24 }), null);
    assert.strictEqual(L.ljIronSlicePlan({ ...base, lastSliceAt: base.now - 5000 }), null);
    assert.strictEqual(L.ljIronSlicePlan({ ...base, lastSliceAt: base.now - 25000 }), 'cave');
  });
}

test('ljIronSlicePlan : aucune grappe connue mais de quoi miner → tranche de branch-mine', () => {
  const base = { rawIron: 0, ingots: 0, cobble: 0, hasFurnace: false, hasStonePick: true, caveAvailable: false,
    nightLock: false, now: 1e6, lastSliceAt: 0 };
  assert.strictEqual(L.ljIronSlicePlan({ ...base, canMine: true }), 'mine');
  assert.strictEqual(L.ljIronSlicePlan({ ...base, canMine: true, caveAvailable: true }), 'cave', 'la grotte d abord');
  assert.strictEqual(L.ljIronSlicePlan({ ...base, canMine: true, nightLock: true }), null);
  assert.strictEqual(L.ljIronSlicePlan({ ...base, canMine: true, hasStonePick: false }), null);
  assert.strictEqual(L.ljIronSlicePlan({ ...base, canMine: true, ingots: 24 }), null);
  assert.strictEqual(L.ljIronSlicePlan({ ...base, canMine: false }), null);
  assert.strictEqual(L.LJ_MINE_COBBLE, 8);
});

test('ljMineTargetY : 28 blocs sous les pieds, jamais sous Y16', () => {
  assert.strictEqual(L.ljMineTargetY(70), 42);
  assert.strictEqual(L.ljMineTargetY(40.6), 16);
  assert.strictEqual(L.ljMineTargetY(10), 16);
});

test('woodWaitDecision : en surface → self (retire une demande héritée), sous terre → request', () => {
  assert.strictEqual(L.woodWaitDecision({ lumberjack: 'B', request: null, underground: false, now: NOW }).action, 'self');
  const d = L.woodWaitDecision({ lumberjack: 'B', request: { want: 16, at: NOW - 1000 }, underground: false, now: NOW });
  assert.strictEqual(d.action, 'self');
  assert.strictEqual(d.clear, true);
  assert.strictEqual(L.woodWaitDecision({ lumberjack: 'B', request: null, underground: true, now: NOW }).action, 'request');
  assert.strictEqual(L.WOOD_UNDERGROUND_Y, 50);
});

test('ljSwitchBlock (22/10) : seuls le planner et son watchdog sont préemptés ; ordre, migration, secours → refus motivé', () => {
  const L2 = require('./lumberjack');
  const b = (o) => L2.ljSwitchBlock(Object.assign({ active: 'autonomous', migrating: false, switching: false, inProgress: true }, o));
  assert.strictEqual(b({}), null);
  assert.strictEqual(b({ active: 'planner_watchdog' }), null);
  assert.strictEqual(b({ switching: true }), 'switching');
  assert.strictEqual(b({ migrating: true }), 'migration');
  assert.strictEqual(b({ active: 'migration' }), 'migration');
  assert.strictEqual(b({ inProgress: false }), 'no_objective');
  assert.strictEqual(b({ active: 'death_camp_flee' }), 'safety');
  assert.strictEqual(b({ active: 'dig_out' }), 'safety');
  assert.strictEqual(b({ active: null }), 'no_planner');
  for (const a of ['follow', 'guard', 'take', 'goto', 'loiter', 'pvp', 'order']) assert.strictEqual(b({ active: a }), 'order', a);
});

// ─── MINEURS D'ABORD (23/10, run live : NethBot1 bûcheron forge bottes+casque pour MapBot2 pendant
// que NethBot2/NethBot3 restaient à 2 pièces — `gift_craft iron_boots to:MapBot2 by:lumberjack`) ───
const miner = (name, o = {}) => mate(name, Object.assign({ role: 'worker' }, o));
const mapperM = (name, o = {}) => mate(name, Object.assign({ role: 'mapper' }, o));

test('pickArmorTargetForLumberjack : un mineur à 2 pièces passe AVANT un cartographe nu', () => {
  const mates = [
    mapperM('MapBot2', { armor: 0, worn: 0, missing: ['iron_boots', 'iron_helmet', 'iron_leggings', 'iron_chestplate'] }),
    miner('NethBot2', { armor: 2, worn: 2, missing: ['iron_leggings', 'iron_chestplate'] }),
  ];
  const p = L.pickArmorTargetForLumberjack({ mates, selfName: 'NethBot1', now: NOW, ingots: 9 });
  assert.deepStrictEqual(p, { to: 'NethBot2', armor: 2, pieces: ['iron_leggings'], ingots: 7, role: 'worker' });
});

test('pickArmorTargetForLumberjack : mineur en manque mais lingots insuffisants → PERSONNE (le cartographe attend)', () => {
  const mates = [
    mapperM('MapBot2', { armor: 0, worn: 0, missing: ['iron_boots', 'iron_helmet', 'iron_leggings', 'iron_chestplate'] }),
    miner('NethBot2', { armor: 2, worn: 2, missing: ['iron_leggings', 'iron_chestplate'] }),
  ];
  assert.strictEqual(L.pickArmorTargetForLumberjack({ mates, selfName: 'NethBot1', now: NOW, ingots: 6 }), null);
});

test('pickArmorTargetForLumberjack : le mineur le moins équipé d\'abord ; une pièce saine en poche est gratuite', () => {
  const mates = [
    miner('NethBot3', { armor: 3, worn: 3, missing: ['iron_chestplate'] }),
    miner('NethBot2', { armor: 2, worn: 2, missing: ['iron_leggings', 'iron_chestplate'] }),
  ];
  assert.deepStrictEqual(L.pickArmorTargetForLumberjack({ mates, selfName: 'NethBot1', now: NOW, ingots: 0, pocket: ['iron_chestplate'] }),
    { to: 'NethBot2', armor: 2, pieces: ['iron_chestplate'], ingots: 0, role: 'worker' });
});

test('pickArmorTargetForLumberjack : tous les mineurs 4/4 portés → le cartographe est servi (plan historique)', () => {
  const mates = [
    miner('NethBot2', { armor: 4, worn: 4, missing: [] }),
    miner('NethBot3', { armor: 4, worn: 4, missing: [] }),
    mapperM('MapBot2', { armor: 0, worn: 0, missing: ['iron_boots', 'iron_helmet', 'iron_leggings', 'iron_chestplate'] }),
  ];
  assert.deepStrictEqual(L.pickArmorTargetForLumberjack({ mates, selfName: 'NethBot1', now: NOW, ingots: 9 }),
    { to: 'MapBot2', armor: 0, pieces: ['iron_boots', 'iron_helmet'], ingots: 9, role: 'mapper' });
});

test('pickArmorTargetForLumberjack : 4 pièces ACQUISES mais pas portées (worn 3) = toujours un mineur à servir → cartographe bloqué', () => {
  const mates = [
    miner('NethBot2', { armor: 4, worn: 3, missing: [] }),
    mapperM('MapBot2', { armor: 0, worn: 0, missing: ['iron_boots'] }),
  ];
  assert.strictEqual(L.pickArmorTargetForLumberjack({ mates, selfName: 'NethBot1', now: NOW, ingots: 9 }), null);
});

test('pickArmorTargetForLumberjack : mineur périmé ou déjà servi (skip) ne bloque pas… sauf s\'il est encore en manque frais', () => {
  const stale = [miner('NethBot2', { worn: 2, missing: ['iron_leggings'], at: NOW - 10 * 60 * 1000 }),
    mapperM('MapBot2', { armor: 0, worn: 0, missing: ['iron_boots'] })];
  assert.strictEqual(L.pickArmorTargetForLumberjack({ mates: stale, selfName: 'NethBot1', now: NOW, ingots: 4 }).to, 'MapBot2');
  // Servi il y a < 90 s : son heartbeat ne reflète pas encore la livraison → on ne le resert pas, et on
  // n'habille pas le cartographe pour autant (il est peut-être encore en manque).
  const served = [miner('NethBot2', { worn: 2, missing: ['iron_leggings'] }), mapperM('MapBot2', { armor: 0, worn: 0, missing: ['iron_boots'] })];
  assert.strictEqual(L.pickArmorTargetForLumberjack({ mates: served, selfName: 'NethBot1', now: NOW, ingots: 9, skip: new Set(['NethBot2']) }), null);
});

test('pickArmorTargetForLumberjack : soi-même et le statut sans champ `worn` (ancienne présence) → armor', () => {
  const mates = [miner('NethBot1', { worn: 0, missing: ['iron_boots'] }), miner('NethBot2', { armor: 4 }),
    mapperM('MapBot2', { armor: 0, missing: ['iron_boots'] })];
  assert.strictEqual(L.pickArmorTargetForLumberjack({ mates, selfName: 'NethBot1', now: NOW, ingots: 4 }).to, 'MapBot2');
});

// ─── BOIS : buts de craft et zone sans bois (23/10, NethBot2 `sticks no_wood:planks` ×8 à y 54) ───
test('woodWaitDecision : en surface MAIS zone prouvée sans bois → demande au bûcheron', () => {
  assert.strictEqual(L.woodWaitDecision({ lumberjack: 'NethBot1', request: null, now: NOW, underground: false }).action, 'self');
  assert.strictEqual(L.woodWaitDecision({ lumberjack: 'NethBot1', request: null, now: NOW, underground: false, noWoodHere: true }).action, 'request');
});

test('woodGoalShortage : buts de craft bois (planches / table / bâtons / pioche bois) sans la matière', () => {
  assert.strictEqual(L.woodGoalShortage({ goalName: 'planks', inv: { cobblestone: 50 } }), true);
  assert.strictEqual(L.woodGoalShortage({ goalName: 'planks', inv: { oak_log: 1 } }), false);
  assert.strictEqual(L.woodGoalShortage({ goalName: 'crafting_table', inv: { oak_planks: 3 } }), true);
  assert.strictEqual(L.woodGoalShortage({ goalName: 'crafting_table', inv: { oak_log: 1 } }), false);
  assert.strictEqual(L.woodGoalShortage({ goalName: 'sticks', inv: { oak_planks: 1, stick: 1 } }), true);
  assert.strictEqual(L.woodGoalShortage({ goalName: 'sticks', inv: { birch_planks: 6, oak_planks: 2, stick: 1 } }), false);
  assert.strictEqual(L.woodGoalShortage({ goalName: 'wooden_pickaxe', inv: { oak_planks: 4, stick: 2 }, hasTable: true }), false);
  assert.strictEqual(L.woodGoalShortage({ goalName: 'wooden_pickaxe', inv: { oak_planks: 2, stick: 2 }, hasTable: true }), true);
  assert.strictEqual(L.woodGoalShortage({ goalName: 'iron_deep', inv: {} }), false);
});

// ─── TRANCHE 'mine' NOYÉE (23/10, NethBot1 : `water_ahead` en 7 s toutes les ~37 s, même départ) ───
test('ljSliceRetryMs : 20 s, puis délai doublé par tranche ratée, plafond 10 min', () => {
  assert.strictEqual(L.ljSliceRetryMs(0), L.LJ_IRON_RETRY_MS);
  assert.strictEqual(L.ljSliceRetryMs(1), 2 * L.LJ_IRON_RETRY_MS);
  assert.strictEqual(L.ljSliceRetryMs(3), 8 * L.LJ_IRON_RETRY_MS);
  assert.strictEqual(L.ljSliceRetryMs(50), L.LJ_SLICE_RETRY_MAX_MS);
  assert.strictEqual(L.ljSliceRetryMs(undefined), L.LJ_IRON_RETRY_MS);
});

test('ljIronSlicePlan : retryMs remplace le répit fixe', () => {
  const sig = { hasStonePick: true, canMine: true, now: NOW, lastSliceAt: NOW - 60000 };
  assert.strictEqual(L.ljIronSlicePlan(sig), 'mine');
  assert.strictEqual(L.ljIronSlicePlan({ ...sig, retryMs: 160000 }), null);
  assert.strictEqual(L.ljIronSlicePlan({ ...sig, now: NOW + 100000, retryMs: 160000 }), 'mine');
});

test('ljSliceFailsAfter : +1 sur une tranche sans fer, 0 dès qu\'elle rapporte, inchangé si coupée par une demande de bois', () => {
  assert.strictEqual(L.ljSliceFailsAfter(2, { ok: false, reason: 'water_ahead', raw: 0, ingots: 0 }), 3);
  assert.strictEqual(L.ljSliceFailsAfter(2, { ok: true, reason: null, raw: 0, ingots: 0 }), 3);
  assert.strictEqual(L.ljSliceFailsAfter(4, { ok: true, raw: 3, ingots: 0 }), 0);
  assert.strictEqual(L.ljSliceFailsAfter(4, { ok: true, raw: 0, ingots: 4 }), 0);
  assert.strictEqual(L.ljSliceFailsAfter(2, { ok: false, reason: 'wood_request', raw: 0, ingots: 0 }), 2);
  assert.strictEqual(L.ljSliceFailsAfter(2, { ok: false, reason: 'cancelled', raw: 0, ingots: 0 }), 2);
});

test('isWaterFailReason', () => {
  assert.strictEqual(L.isWaterFailReason('water_ahead'), true);
  assert.strictEqual(L.isWaterFailReason('flooded'), true);
  assert.strictEqual(L.isWaterFailReason('lava_ahead'), false);
  assert.strictEqual(L.isWaterFailReason(null), false);
});

test('ljMineDetour : départ sur un site noyé → cible à 30-50 blocs, hors de tout site banni ; cap qui tourne', () => {
  const W = require('./workDrown');
  const site = { x: -412, z: 114 };
  const sites = W.noteDrownedSite([], site, NOW);
  assert.strictEqual(L.ljMineDetour({ pos: { x: 0, z: 0 }, drownedSites: sites, seed: 1, now: NOW }), null);
  const d1 = L.ljMineDetour({ pos: { x: -410, z: 112 }, drownedSites: sites, seed: 1, now: NOW });
  assert.ok(d1);
  const dist = Math.hypot(d1.x - (-410), d1.z - 112);
  assert.ok(dist >= 14 && dist <= 66, 'décalage ~30-50 depuis le départ : ' + dist);
  assert.strictEqual(W.isDrownedNear(sites, d1, NOW), false);
  assert.ok(d1.seed > 1);
  const d2 = L.ljMineDetour({ pos: { x: -410, z: 112 }, drownedSites: sites, seed: d1.seed, now: NOW });
  assert.notDeepStrictEqual([d2.x, d2.z], [d1.x, d1.z], 'le cap tourne entre deux essais');
  // banni expiré (> 30 min) : plus de détour
  assert.strictEqual(L.ljMineDetour({ pos: { x: -410, z: 112 }, drownedSites: sites, seed: 1, now: NOW + W.DROWNED_SITE_TTL_MS + 1 }), null);
  // la cible elle-même retombe dans un site banni → on repousse
  const many = [site, { x: d1.x, z: d1.z }].reduce((acc, s) => W.noteDrownedSite(acc, s, NOW), []);
  const d3 = L.ljMineDetour({ pos: { x: -410, z: 112 }, drownedSites: many, seed: 1, now: NOW });
  assert.strictEqual(W.isDrownedNear(many, d3, NOW), false);
});
