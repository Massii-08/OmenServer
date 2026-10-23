'use strict';
// Progression d'équipe (Massii 24/10) : mineurs 4/4 → cartographes 4/4 PORTÉS (plastron d'abord)
// → tout le monde au diamant, 3 piles (192) par bot.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const T = require('./teamwork');
const L = require('./lumberjack');
const G = require('./goals');
const { junkItems } = require('./quota');
const { pickJunkToToss } = require('./skills/craft');

const NOW = 1_800_000_000_000;
const m = (name, o = {}) => Object.assign({ name, at: NOW - 1000, x: 0, z: 0 }, o);

// ─── « servi » = pièces PORTÉES ──────────────────────────────────────────────────────────────────
test('mapperUnserved : worn prime sur armor ; missing vide = pièces en poche (il s’équipe seul)', () => {
  assert.strictEqual(T.mapperUnserved(m('M', { role: 'mapper', armor: 4, worn: 2, missing: ['iron_chestplate'] })), true);
  assert.strictEqual(T.mapperUnserved(m('M', { role: 'mapper', armor: 4, worn: 2, missing: [] })), false);
  assert.strictEqual(T.mapperUnserved(m('M', { role: 'mapper', armor: 4, worn: 4, missing: [] })), false);
  assert.strictEqual(T.mapperUnserved(m('M', { role: 'mapper' })), true);            // statut inconnu = nu
  assert.strictEqual(T.mapperUnserved(m('M', { role: 'mapper', armor: 4 })), false); // ancienne présence → armor
});

test('nextObjectiveAfter : un cartographe 2 pièces portées (bottes + casque) garde la flotte sur mapper_armor', () => {
  const mates = [m('MapBot1', { role: 'mapper', armor: 2, worn: 2, missing: ['iron_chestplate', 'iron_leggings'] }),
    m('MapBot2', { role: 'mapper', armor: 4, worn: 4, missing: [] })];
  assert.strictEqual(G.nextObjectiveAfter('iron_armor', mates), 'mapper_armor');
  assert.strictEqual(G.nextObjectiveAfter('mapper_armor', mates), 'mapper_armor');
  const done = mates.map((x) => Object.assign({}, x, { armor: 4, worn: 4, missing: [] }));
  assert.strictEqual(G.nextObjectiveAfter('mapper_armor', done), 'diamond');
});

test('pickMapperToEquip : le moins équipé en pièces PORTÉES', () => {
  const mates = [m('MapBot1', { role: 'mapper', armor: 3, worn: 3, missing: ['iron_chestplate'] }),
    m('MapBot2', { role: 'mapper', armor: 3, worn: 1, missing: ['iron_chestplate'] })];
  assert.deepStrictEqual(T.pickMapperToEquip({ selfName: 'N', selfStatus: { armor: 4 }, mates, now: NOW }),
    { to: 'MapBot2', armor: 3 });
});

// ─── phase d'équipe ──────────────────────────────────────────────────────────────────────────────
test('teamPhase : miners_armor → mappers_armor → diamond', () => {
  const mappersNaked = [m('MapBot1', { role: 'mapper', worn: 0 }), m('MapBot2', { role: 'mapper', worn: 2, missing: ['iron_chestplate'] })];
  const miners = (w) => [m('NethBot2', { role: 'worker', worn: w }), m('NethBot3', { role: 'lumberjack', worn: 4 })];
  let p = T.teamPhase({ selfName: 'NethBot1', selfRole: 'worker', selfWorn: 4, mates: [...miners(3), ...mappersNaked], now: NOW });
  assert.strictEqual(p.phase, 'miners_armor');
  assert.strictEqual(p.minersArmored, 2); assert.strictEqual(p.miners, 3);
  p = T.teamPhase({ selfName: 'NethBot1', selfRole: 'worker', selfWorn: 4, mates: [...miners(4), ...mappersNaked], now: NOW });
  assert.strictEqual(p.phase, 'mappers_armor');
  const served = mappersNaked.map((x) => Object.assign({}, x, { worn: 4, missing: [] }));
  p = T.teamPhase({ selfName: 'NethBot1', selfRole: 'worker', selfWorn: 4, mates: [...miners(4), ...served], now: NOW });
  assert.deepStrictEqual(p, { phase: 'diamond', miners: 3, minersArmored: 3, mappers: 2, mappersServed: 2 });
  // le bot lui-même compte : 3/4 → miners_armor
  assert.strictEqual(T.teamPhase({ selfName: 'NethBot1', selfRole: 'worker', selfWorn: 3, mates: [...miners(4), ...served], now: NOW }).phase, 'miners_armor');
  // présence périmée ignorée
  const stale = [m('MapBot1', { role: 'mapper', worn: 0, at: NOW - 10 * 60 * 1000 })];
  assert.strictEqual(T.teamPhase({ selfName: 'NethBot1', selfRole: 'worker', selfWorn: 4, mates: stale, now: NOW }).phase, 'diamond');
});

// ─── plastron d'abord + besoin restant ───────────────────────────────────────────────────────────
test('mapperGiftNeed : coût des pièces manquantes hors poche ; inconnu → 24', () => {
  assert.strictEqual(L.mapperGiftNeed(m('M', { role: 'mapper', missing: ['iron_boots'] }), []), 4);
  assert.strictEqual(L.mapperGiftNeed(m('M', { role: 'mapper', missing: ['iron_chestplate', 'iron_leggings'] }), ['iron_chestplate']), 7);
  assert.strictEqual(L.mapperGiftNeed(m('M', { role: 'mapper', armor: 0 }), []), 24);
  assert.strictEqual(L.mapperGiftNeed(m('M', { role: 'mapper', armor: 2 }), []), 24);  // ancienne présence : set complet
});

test('giftBatchFor : ordre de protection, 24 lingots → set complet, plastron en tête ; pièce en poche gratuite même derrière', () => {
  const target = m('MapBot2', { role: 'mapper', armor: 0, missing: ['iron_boots', 'iron_helmet', 'iron_leggings', 'iron_chestplate'] });
  assert.deepStrictEqual(L.giftBatchFor({ target, ingots: 24, pocket: [], now: NOW }).pieces,
    ['iron_chestplate', 'iron_leggings', 'iron_helmet', 'iron_boots']);
  // 6 lingots + des bottes en poche : le plastron n'est pas abordable → on ne forge RIEN, mais les bottes partent
  assert.deepStrictEqual(L.giftBatchFor({ target, ingots: 6, pocket: ['iron_boots'], now: NOW }).pieces, ['iron_boots']);
  assert.strictEqual(L.giftBatchFor({ target, ingots: 6, pocket: [], now: NOW }), null);
});

test('MAPPER_ARMOR_CHAIN : la mine vise le BESOIN restant (giftNeed), pas 24 fixes', () => {
  const gi = G.MAPPER_ARMOR_CHAIN.find((g) => g.name === 'gift_iron');
  const ctx = (o) => Object.assign({ inv: { raw_iron: 5 }, mapperTarget: 'MapBot2', y: 16 }, o);
  assert.strictEqual(gi.met(ctx({ giftNeed: 4 })), true);           // il ne manque que les bottes
  assert.strictEqual(gi.met(ctx({ giftNeed: 8 })), false);
  assert.strictEqual(gi.met(ctx({})), false);                       // inconnu → 24
});

// ─── bûcheron : fin de rôle en phase diamant ─────────────────────────────────────────────────────
test('lumberjackRetireForDiamond : phase diamant + stock plein → rend le rôle ; stock incomplet → le finit ; personne ne le reprend', () => {
  assert.deepStrictEqual(L.lumberjackRetireForDiamond({ phase: 'diamond', amLumberjack: true, logs: 48 }), { retire: true, block: true });
  assert.deepStrictEqual(L.lumberjackRetireForDiamond({ phase: 'diamond', amLumberjack: true, logs: 20 }), { retire: false, block: true });
  assert.deepStrictEqual(L.lumberjackRetireForDiamond({ phase: 'diamond', amLumberjack: false, logs: 64 }), { retire: false, block: true });
  assert.deepStrictEqual(L.lumberjackRetireForDiamond({ phase: 'mappers_armor', amLumberjack: true, logs: 64 }), { retire: false, block: false });
});

// ─── diamant : 3 piles, cible configurable, durée ────────────────────────────────────────────────
test('DIAMOND_TARGET = 192 (3 piles) ; cible surchargée par l’objectif', () => {
  assert.strictEqual(G.DIAMOND_TARGET, 192);
  assert.strictEqual(G.diamondTargetOf({ type: 'diamond' }), 192);
  assert.strictEqual(G.diamondTargetOf({ type: 'diamond', target: 64 }), 64);
  assert.strictEqual(G.diamondTargetOf({ type: 'diamond', target: 'x' }), 192);
  const last = (ch) => ch[ch.length - 1];
  assert.strictEqual(last(G.chainFor('diamond')).met({ inv: { diamond: 191, iron_pickaxe: 1 } }), false);
  assert.strictEqual(last(G.chainFor('diamond')).met({ inv: { diamond: 192, iron_pickaxe: 1 } }), true);
  const c64 = G.chainFor('diamond', { diamondTarget: 64 });
  assert.strictEqual(last(c64).met({ inv: { diamond: 64, iron_pickaxe: 1 } }), true);
  assert.strictEqual(G.chainFor('diamond', { diamondTarget: 64 }), c64, 'chaîne mémoïsée par cible');
});

test('DIAMOND : pioche fer CASSÉE après des diamants → la chaîne fer se rouvre (plus de stall sur iron_pickaxe)', () => {
  const ctx = { inv: { diamond: 40, stone_pickaxe: 1, furnace: 1, cobblestone: 20, stick: 4, crafting_table: 1 }, y: -54 };
  assert.strictEqual(G.firstUnmet(G.DIAMOND_CHAIN, ctx).name, 'iron_ore');
  ctx.inv.raw_iron = 3;
  assert.strictEqual(G.firstUnmet(G.DIAMOND_CHAIN, ctx).name, 'iron_ingot');
});

test('DIAMOND : pioche de rechange avec le fer DÉJÀ en poche, buts optionnels et sautables', () => {
  const base = { iron_pickaxe: 1, cobblestone: 16, diamond: 5, furnace: 1, coal: 2 };
  const goal = (inv) => G.firstUnmet(G.DIAMOND_CHAIN, { inv: Object.assign({}, base, inv), y: -54, hasTable: false });
  // rien à fondre ni à forger → droit à la chasse
  assert.strictEqual(goal({}).name, 'diamond_caves');
  // 3 fer brut + four + charbon → fondre
  assert.strictEqual(goal({ raw_iron: 3, stick: 2, crafting_table: 1 }).name, 'dia_spare_smelt');
  // 3 lingots + bâtons + table → forger la rechange
  assert.strictEqual(goal({ iron_ingot: 3, stick: 2, crafting_table: 1 }).name, 'dia_spare_pick');
  // lingots mais 0 bâton, des planches → bâtons d'abord
  assert.strictEqual(goal({ iron_ingot: 3, oak_planks: 4, crafting_table: 1 }).name, 'dia_spare_sticks');
  // déjà 2 pioches → plus rien
  assert.strictEqual(goal({ iron_pickaxe: 2, iron_ingot: 9, stick: 4, crafting_table: 1 }).name, 'diamond_caves');
  for (const n of ['dia_spare_sticks', 'dia_spare_smelt', 'dia_spare_pick']) {
    assert.strictEqual(G.DIAMOND_CHAIN.find((g) => g.name === n).optional, true, n + ' optionnel');
  }
});

test('les diamants ne sont JAMAIS jetés (junk du mode quota, place pour un craft)', () => {
  const items = [{ name: 'diamond', count: 64 }, { name: 'diamond', count: 64 }, { name: 'diamond', count: 20 },
    { name: 'dirt', count: 3 }, { name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 64 }];
  assert.ok(!junkItems(items).some((i) => i.name === 'diamond'));
  for (let k = 0; k < 5; k++) {
    const j = pickJunkToToss(items, { exclude: [] });
    assert.ok(!j || j.name !== 'diamond');
  }
});

// ─── câblage index.js (source) ───────────────────────────────────────────────────────────────────
const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
test('câblage : tick de phase, events team_phase / diamond_progress, heartbeat diamonds, retour diamant → mapper_armor', () => {
  assert.match(SRC, /setInterval\(\(\) => \{ teamPhaseTick\(\)\.catch\(\(\) => \{\}\); \}, TEAM_PHASE_TICK_MS\);/);
  assert.match(SRC, /type: 'team_phase', phase: ph\.phase/);
  assert.match(SRC, /type: 'diamond_progress', have: buildCtxInv\(bot\)\.diamond \|\| 0, target: diamondTargetOf\(world\.objective\)/);
  assert.match(SRC, /ironZone: _zoneIronMined, diamonds: _dia/);
  assert.match(SRC, /switchObjective\('mapper_armor', 'team_mappers_armor'\)/);
  assert.match(SRC, /why === 'team_diamond' \? 'diamond'/);
  assert.match(SRC, /chainFor\(objType, \{ diamondTarget: diamondTargetOf\(world\.objective\) \}\)/);
  // variables lues par timers : niveau MODULE (piège #56)
  for (const v of ['_teamPhaseLast', '_diamondProgressAt', '_teamSwitchAt', '_objSwitching', '_giftNeed']) {
    assert.match(SRC, new RegExp('^let ' + v + ' = ', 'm'), v);
  }
  assert.match(SRC, /^const _optionalFailAt = new Map\(\);/m);
});
