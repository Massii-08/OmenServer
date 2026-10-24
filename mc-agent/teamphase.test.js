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
test('lumberjackRetireForDiamond : phase diamant → rend le rôle tout de suite ; personne ne le reprend', () => {
  assert.deepStrictEqual(L.lumberjackRetireForDiamond({ phase: 'diamond', amLumberjack: true, logs: 48 }), { retire: true, block: true });
  assert.deepStrictEqual(L.lumberjackRetireForDiamond({ phase: 'diamond', amLumberjack: true, logs: 20 }), { retire: true, block: true });
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
  // (24/10 soir) avec ≥ 3 💎 + bâtons + table, la pioche se refait en DIAMANT (diamondPhase.test.js) ;
  // la réouverture de la chaîne fer reste le chemin quand les diamants ne suffisent pas.
  const ctx = { inv: { diamond: 40, stone_pickaxe: 1, furnace: 1, cobblestone: 20, stick: 4, crafting_table: 1 }, y: -54 };
  assert.strictEqual(G.firstUnmet(G.DIAMOND_CHAIN, ctx).name, 'dia_pick');
  ctx.inv.diamond = 2;
  assert.strictEqual(G.firstUnmet(G.DIAMOND_CHAIN, ctx).name, 'iron_ore');
  ctx.inv.raw_iron = 3;
  assert.strictEqual(G.firstUnmet(G.DIAMOND_CHAIN, ctx).name, 'iron_ingot');
});

test('DIAMOND : pioche de rechange avec le fer DÉJÀ en poche, buts optionnels et sautables', () => {
  const base = { iron_pickaxe: 1, cobblestone: 16, diamond: 5, furnace: 1, coal: 2 };
  // diaPickUpgraded : l'amélioration fer → diamant (unique) est déjà faite — sinon dia_pick passe devant.
  const goal = (inv) => G.firstUnmet(G.DIAMOND_CHAIN, { inv: Object.assign({}, base, inv), y: -54, hasTable: false, diaPickUpgraded: true });
  assert.strictEqual(G.firstUnmet(G.DIAMOND_CHAIN, { inv: Object.assign({}, base, { stick: 2, crafting_table: 1 }), y: -54 }).name, 'dia_pick');
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
  assert.match(SRC, /const _have = buildCtxInv\(bot\)\.diamond \|\| 0;/);
  assert.match(SRC, /type: 'diamond_progress', have: _have, target: diamondTargetOf\(world\.objective\)/);
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

// ─── CLIQUET de phase (fix 24/10 soir) ───────────────────────────────────────────────────────────
// Vécu : diamond → mappers_armor → miners_armor → … parce que l'armure S'USE (NethBot1 4 → 2 portées)
// → élection du bûcheron rouverte → NethBot2 (28 diamants, le meilleur) réélu bûcheron.
const W = (name, o = {}) => m(name, Object.assign({ role: 'worker', worn: 4 }, o));
const MP = (name, o = {}) => m(name, Object.assign({ role: 'mapper', worn: 4, missing: [] }, o));
test('latchedTeamPhase : une fois diamond atteint, l’usure ne fait plus redescendre la phase', () => {
  const worn = [W('NethBot2', { worn: 2 }), W('NethBot3'), MP('MapBot1', { worn: 3, missing: ['iron_boots'] }), MP('MapBot2')];
  const raw = T.teamPhase({ selfName: 'NethBot1', selfRole: 'worker', selfWorn: 4, mates: worn, now: NOW });
  assert.strictEqual(raw.phase, 'miners_armor');
  const r = T.latchedTeamPhase({ raw, latch: { at: NOW - 60000 }, mates: worn, selfName: 'NethBot1', selfRole: 'worker', selfWorn: 4, now: NOW });
  assert.strictEqual(r.phase, 'diamond');
  assert.strictEqual(r.latched, true);
  assert.strictEqual(r.nakedMapper, null, 'un cartographe à 3 pièces n’est pas nu');
  assert.deepStrictEqual(r.latch, { at: NOW });
});
test('latchedTeamPhase : diamond brut pose le cliquet ; sans cliquet la phase brute passe', () => {
  const ok = [W('NethBot2'), MP('MapBot1')];
  const raw = T.teamPhase({ selfName: 'NethBot1', selfRole: 'worker', selfWorn: 4, mates: ok, now: NOW });
  const r = T.latchedTeamPhase({ raw, latch: null, mates: ok, selfName: 'NethBot1', selfRole: 'worker', selfWorn: 4, now: NOW });
  assert.strictEqual(r.phase, 'diamond'); assert.strictEqual(r.latched, true); assert.deepStrictEqual(r.latch, { at: NOW });
  const bad = [W('NethBot2', { worn: 1 })];
  const raw2 = T.teamPhase({ selfName: 'NethBot1', selfRole: 'worker', selfWorn: 4, mates: bad, now: NOW });
  const r2 = T.latchedTeamPhase({ raw: raw2, latch: null, mates: bad, selfName: 'NethBot1', selfRole: 'worker', selfWorn: 4, now: NOW });
  assert.strictEqual(r2.phase, 'miners_armor'); assert.strictEqual(r2.latched, false); assert.strictEqual(r2.latch, null);
});
test('latchedTeamPhase : cliquet périmé (flotte arrêtée > 30 min) ou venu du futur = ignoré ; un coéquipier cliqueté le propage', () => {
  const bad = [W('NethBot2', { worn: 1 })];
  const raw = T.teamPhase({ selfName: 'NethBot1', selfRole: 'worker', selfWorn: 4, mates: bad, now: NOW });
  const base = { raw, mates: bad, selfName: 'NethBot1', selfRole: 'worker', selfWorn: 4, now: NOW };
  assert.strictEqual(T.latchedTeamPhase(Object.assign({}, base, { latch: { at: NOW - T.TEAM_LATCH_STALE_MS - 1 } })).phase, 'miners_armor');
  assert.strictEqual(T.latchedTeamPhase(Object.assign({}, base, { latch: { at: NOW + 3600000 } })).phase, 'miners_armor');
  const prop = [W('NethBot2', { worn: 1, phaseLatched: true })];
  const rawP = T.teamPhase({ selfName: 'NethBot1', selfRole: 'worker', selfWorn: 4, mates: prop, now: NOW });
  assert.strictEqual(T.latchedTeamPhase(Object.assign({}, base, { raw: rawP, mates: prop, latch: null })).phase, 'diamond');
  // présence périmée : ne propage rien
  const old = [W('NethBot2', { worn: 1, phaseLatched: true, at: NOW - 10 * 60 * 1000 })];
  assert.strictEqual(T.latchedTeamPhase(Object.assign({}, base, { mates: old, latch: null })).phase, 'miners_armor');
});
test('latchedTeamPhase : seul un cartographe VRAIMENT nu (≤ 1 pièce portée) est signalé', () => {
  const mates = [W('NethBot2'), MP('MapBot1', { worn: 2, missing: ['iron_chestplate', 'iron_leggings'] }), MP('MapBot2', { worn: 1, missing: ['iron_chestplate'] })];
  const raw = T.teamPhase({ selfName: 'NethBot1', selfRole: 'worker', selfWorn: 4, mates, now: NOW });
  const r = T.latchedTeamPhase({ raw, latch: { at: NOW }, mates, selfName: 'NethBot1', selfRole: 'worker', selfWorn: 4, now: NOW });
  assert.strictEqual(r.phase, 'diamond');
  assert.strictEqual(r.nakedMapper, 'MapBot2');
  // pièces en poche (missing vide) : il s'équipe seul → pas nu
  const pocket = [MP('MapBot2', { worn: 0, missing: [] })];
  assert.strictEqual(T.latchedTeamPhase({ raw, latch: { at: NOW }, mates: pocket, selfName: 'NethBot1', selfRole: 'worker', selfWorn: 4, now: NOW }).nakedMapper, null);
  assert.strictEqual(T.NAKED_MAPPER_MAX_WORN, 1);
});
test('pickDivertedMiner : celui qui a le MOINS de diamants (4/4 porté), jamais le meilleur', () => {
  const mates = [W('NethBot2', { diamonds: 28 }), W('NethBot3', { diamonds: 5 }), MP('MapBot1', { diamonds: 0 })];
  assert.strictEqual(T.pickDivertedMiner({ selfName: 'NethBot1', selfDiamonds: 12, selfWorn: 4, mates, now: NOW }), 'NethBot3');
  assert.strictEqual(T.pickDivertedMiner({ selfName: 'NethBot1', selfDiamonds: 2, selfWorn: 4, mates, now: NOW }), 'NethBot1');
  // un mineur pas 4/4 ne peut servir personne → écarté
  assert.strictEqual(T.pickDivertedMiner({ selfName: 'NethBot1', selfDiamonds: 0, selfWorn: 2, mates, now: NOW }), 'NethBot3');
  // départage par nom
  const eq = [W('NethBot3', { diamonds: 4 })];
  assert.strictEqual(T.pickDivertedMiner({ selfName: 'NethBot1', selfDiamonds: 4, selfWorn: 4, mates: eq, now: NOW }), 'NethBot1');
  assert.strictEqual(T.pickDivertedMiner({ selfName: 'NethBot1', selfDiamonds: 0, selfWorn: 0, mates: [], now: NOW }), null);
});
test('pickMapperToEquip : opts.maxWorn ne retient que les cartographes vraiment nus', () => {
  const mates = [MP('MapBot1', { worn: 2, missing: ['iron_chestplate'] }), MP('MapBot2', { worn: 3, missing: ['iron_boots'] })];
  assert.strictEqual(T.pickMapperToEquip({ selfName: 'N', selfStatus: { armor: 4 }, mates, now: NOW, opts: { maxWorn: 1 } }), null);
  assert.strictEqual(T.pickMapperToEquip({ selfName: 'N', selfStatus: { armor: 4 }, mates, now: NOW }).to, 'MapBot1');
});
test('lumberjackRetireForDiamond : bûcheron en phase diamant → retour au diamant IMMÉDIAT, stock ou pas', () => {
  assert.deepStrictEqual(L.lumberjackRetireForDiamond({ phase: 'diamond', amLumberjack: true, logs: 3 }), { retire: true, block: true });
});
test('preferredLumberjack : à armure égale, celui qui a le MOINS de diamants (pas le meilleur mineur)', () => {
  const mates = [m('NethBot1', { role: 'worker', armor: 4, worn: 4, diamonds: 3 }), m('NethBot3', { role: 'worker', armor: 4, worn: 4, diamonds: 10 })];
  assert.strictEqual(L.preferredLumberjack({ selfName: 'NethBot2', selfArmor: 4, selfWorn: 4, selfDiamonds: 28, mates, now: NOW }), 'NethBot1');
  assert.strictEqual(L.preferredLumberjack({ selfName: 'NethBot2', selfArmor: 4, selfWorn: 4, selfDiamonds: 0, mates, now: NOW }), 'NethBot2');
});
test('armorRepairs : emplacements NOUVELLEMENT couverts (fer ou mieux), le reste ignoré', () => {
  assert.deepStrictEqual(T.armorRepairs(['iron_helmet', 'iron_boots'], ['iron_helmet', 'iron_boots', 'iron_chestplate']),
    [{ slot: 'chestplate', item: 'iron_chestplate' }]);
  assert.deepStrictEqual(T.armorRepairs(['iron_helmet'], ['iron_helmet']), []);
  assert.deepStrictEqual(T.armorRepairs([], ['leather_boots']), []);
  assert.deepStrictEqual(T.armorRepairs(['iron_boots'], ['diamond_boots']), [], 'emplacement déjà couvert');
  assert.deepStrictEqual(T.armorRepairs(null, ['diamond_leggings']), [{ slot: 'leggings', item: 'diamond_leggings' }]);
});
