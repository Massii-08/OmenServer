'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { teamStatus, pickDonation, allArmored, MIN_GIFT } = require('./teamwork');

// Cas réel qui a motivé la demande Massii (world_ax4, 25/07) : NethBot2 portait 3 pièces et
// gardait 6 lingots d'avance pendant que NethBot3, à 50 blocs, n'avait RIEN et rebouclait sur le
// bootstrap bois. Le fer dormait dans la mauvaise poche.

const NOW = 1_000_000;
const mate = (name, x, z, extra = {}) =>
  Object.assign({ name, x, z, role: 'worker', at: NOW }, extra);

// ─── teamStatus : ce que je publie aux autres ─────────────────────────────────

test('teamStatus compte les pièces PORTÉES et celles en poche', () => {
  const s = teamStatus({ iron_boots: 1, iron_ingot: 6 }, ['iron_helmet', 'iron_leggings']);
  assert.strictEqual(s.armor, 3);
  assert.strictEqual(s.ingots, 6);
  assert.strictEqual(s.need, 8, 'il ne manque que le plastron = 8 lingots');
});

test('teamStatus : bot nu → tout est à faire', () => {
  const s = teamStatus({}, []);
  assert.strictEqual(s.armor, 0);
  assert.strictEqual(s.need, 5 + 8 + 7 + 4);
});

test('teamStatus : armure complète → plus aucun besoin', () => {
  const s = teamStatus({ iron_ingot: 3 },
    ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']);
  assert.strictEqual(s.armor, 4);
  assert.strictEqual(s.need, 0);
  assert.strictEqual(s.ingots, 3);
});

test('teamStatus : entrées vides → jamais de crash', () => {
  assert.strictEqual(teamStatus(null, null).armor, 0);
});

// ─── pickDonation : qui donne quoi à qui ──────────────────────────────────────

const RICHE = { armor: 3, ingots: 12, need: 8 };   // 12 lingots, 8 pour lui → 4 de surplus

test('surplus + coéquipier nu à portée → don (le cas NethBot2 → NethBot3)', () => {
  const r = pickDonation({
    self: { x: 0, z: 0 }, selfName: 'NethBot2', selfStatus: RICHE,
    mates: [mate('NethBot3', 50, 0, { armor: 0, need: 24 })], now: NOW,
  });
  assert.deepEqual(r, { to: 'NethBot3', amount: 4 });
});

test('on ne donne JAMAIS ce dont on a besoin pour finir sa propre armure', () => {
  const r = pickDonation({
    self: { x: 0, z: 0 }, selfName: 'A', selfStatus: { armor: 3, ingots: 8, need: 8 },
    mates: [mate('B', 10, 0, { armor: 0, need: 24 })], now: NOW,
  });
  assert.strictEqual(r, null, 'surplus nul → pas de don');
});

test('le MOINS ÉQUIPÉ est servi en premier (pas le plus proche)', () => {
  const r = pickDonation({
    self: { x: 0, z: 0 }, selfName: 'A', selfStatus: RICHE,
    mates: [mate('Proche', 5, 0, { armor: 2, need: 9 }), mate('Nu', 40, 0, { armor: 0, need: 24 })],
    now: NOW,
  });
  assert.strictEqual(r.to, 'Nu');
});

test('à égalité d\'armure, le plus proche gagne', () => {
  const r = pickDonation({
    self: { x: 0, z: 0 }, selfName: 'A', selfStatus: RICHE,
    mates: [mate('Loin', 60, 0, { armor: 1, need: 20 }), mate('Pres', 10, 0, { armor: 1, need: 20 })],
    now: NOW,
  });
  assert.strictEqual(r.to, 'Pres');
});

test('on ne donne pas plus que le besoin du receveur', () => {
  const r = pickDonation({
    self: { x: 0, z: 0 }, selfName: 'A', selfStatus: { armor: 4, ingots: 20, need: 0 },
    mates: [mate('B', 10, 0, { armor: 3, need: 4 })], now: NOW,
  });
  assert.strictEqual(r.amount, 4, 'il lui manque 4 lingots, pas 20');
});

test('coéquipier DÉJÀ équipé → aucun don', () => {
  const r = pickDonation({
    self: { x: 0, z: 0 }, selfName: 'A', selfStatus: RICHE,
    mates: [mate('B', 10, 0, { armor: 4, need: 0 })], now: NOW,
  });
  assert.strictEqual(r, null);
});

test('trop loin (>64) ou présence périmée → aucun don', () => {
  const base = { self: { x: 0, z: 0 }, selfName: 'A', selfStatus: RICHE, now: NOW };
  assert.strictEqual(pickDonation({ ...base, mates: [mate('B', 300, 0, { armor: 0, need: 24 })] }), null);
  assert.strictEqual(pickDonation({ ...base, mates: [mate('B', 10, 0, { armor: 0, need: 24, at: NOW - 999999 })] }), null);
});

test('un CARTOGRAPHE ne reçoit rien (il ne monte pas d\'armure)', () => {
  const r = pickDonation({
    self: { x: 0, z: 0 }, selfName: 'A', selfStatus: RICHE,
    mates: [mate('MapBot1', 10, 0, { role: 'mapper', armor: 0 })], now: NOW,
  });
  assert.strictEqual(r, null);
});

test('don minuscule (< MIN_GIFT) → on ne se déplace pas pour ça', () => {
  const r = pickDonation({
    self: { x: 0, z: 0 }, selfName: 'A', selfStatus: { armor: 4, ingots: MIN_GIFT - 1, need: 0 },
    mates: [mate('B', 10, 0, { armor: 0, need: 24 })], now: NOW,
  });
  assert.strictEqual(r, null);
});

// ─── opts.reserve : lingots RÉSERVÉS (armure d'un cartographe en cours d'assemblage) ──────────
// world_mn12, 28/07 : un worker sur `mapper_armor` (need=0) voit TOUT son fer compté en surplus
// et le team_gift périodique le vide vers les stragglers AVANT qu'il ait pu réunir les 24 lingots
// d'un set — mesuré : 21 lingots donnés depuis mapper_armor, 0 set livré, mappeurs 0/4 toute la
// nuit. On earmarke donc GIFT_SET_INGOTS tant qu'une cible mappeur est réservée.

test('reserve earmarke le fer du set mappeur → pas de don pendant l\'accumulation', () => {
  const base = {
    self: { x: 0, z: 0 }, selfName: 'NethBot1',
    selfStatus: { armor: 4, ingots: 9, need: 0 },
    mates: [mate('NethBot2', 10, 0, { armor: 3, need: 5 })], now: NOW,
  };
  // Sans réserve, il donnerait son surplus (9) au straggler.
  assert.strictEqual(pickDonation(base).to, 'NethBot2');
  // Avec 24 lingots réservés pour le set mappeur, 9 - 0 - 24 < 0 → aucun don.
  assert.strictEqual(pickDonation({ ...base, opts: { reserve: 24 } }), null);
});

test('reserve : seul le fer AU-DESSUS du set réservé est donnable', () => {
  const r = pickDonation({
    self: { x: 0, z: 0 }, selfName: 'A', selfStatus: { armor: 4, ingots: 30, need: 0 },
    mates: [mate('B', 10, 0, { armor: 2, need: 10 })], now: NOW,
    opts: { reserve: 24 },
  });
  assert.strictEqual(r.amount, 6, '30 - 24 réservés = 6 donnables (< les 10 manquants de B)');
});

// ─── allArmored : le signal de SÉPARATION ─────────────────────────────────────

test('tous équipés → séparation', () => {
  assert.strictEqual(allArmored({ armor: 4 },
    [mate('B', 1, 1, { armor: 4 }), mate('C', 2, 2, { armor: 4 })], { now: NOW }), true);
});

test('un seul retardataire → on RESTE groupés', () => {
  assert.strictEqual(allArmored({ armor: 4 },
    [mate('B', 1, 1, { armor: 4 }), mate('C', 2, 2, { armor: 1 })], { now: NOW }), false);
});

test('moi pas équipé → on reste groupés', () => {
  assert.strictEqual(allArmored({ armor: 2 }, [mate('B', 1, 1, { armor: 4 })], { now: NOW }), false);
});

test('statut inconnu = NON équipé (on ne se sépare pas sur une supposition)', () => {
  assert.strictEqual(allArmored({ armor: 4 }, [mate('B', 1, 1)], { now: NOW }), false);
});

test('les cartographes ne comptent pas dans la décision de séparation', () => {
  assert.strictEqual(allArmored({ armor: 4 },
    [mate('MapBot1', 1, 1, { role: 'mapper' })], { now: NOW }), true);
});

// ─── DÉFENSE MUTUELLE (Massii 25/07 : « qu'ils s'aident aussi contre les mobs ») ──
const { pickMobAssist, ASSIST_MIN_HEALTH } = require('./teamwork');

const SELF = { x: 0, z: 0, health: 20 };
const COPAIN = [{ name: 'NethBot3', x: 10, z: 0 }];

test('un mob colle un coéquipier à portée → on va le taper', () => {
  const r = pickMobAssist({ self: SELF, mates: COPAIN, hostiles: [{ name: 'zombie', x: 12, z: 0 }] });
  assert.strictEqual(r.mob.name, 'zombie');
  assert.strictEqual(r.mate, 'NethBot3');
  assert.strictEqual(r.dist, 12);
});

test('mob qui traîne LOIN du coéquipier → on ne bouge pas (il n\'agresse personne)', () => {
  const r = pickMobAssist({ self: SELF, mates: COPAIN, hostiles: [{ name: 'zombie', x: 3, z: 0 }] });
  assert.strictEqual(r, null, 'à 7 blocs du copain, il ne le menace pas');
});

test('je suis moi-même en danger → je me sauve, on ne meurt pas à deux', () => {
  const r = pickMobAssist({
    self: { ...SELF, health: ASSIST_MIN_HEALTH - 1 }, mates: COPAIN,
    hostiles: [{ name: 'zombie', x: 12, z: 0 }],
  });
  assert.strictEqual(r, null);
});

test('mob trop loin de MOI (>20) → j\'arriverais après la bataille', () => {
  const r = pickMobAssist({
    self: SELF, mates: [{ name: 'B', x: 60, z: 0 }],
    hostiles: [{ name: 'zombie', x: 62, z: 0 }],
  });
  assert.strictEqual(r, null);
});

test('mob FLEE-ONLY (wither_skeleton) → on n\'y envoie personne', () => {
  const r = pickMobAssist({
    self: SELF, mates: COPAIN, hostiles: [{ name: 'wither_skeleton', x: 12, z: 0 }],
    isFleeOnly: (n) => n === 'wither_skeleton',
  });
  assert.strictEqual(r, null);
});

test('plusieurs menaces → on prend la plus proche de MOI', () => {
  const r = pickMobAssist({
    self: SELF, mates: [{ name: 'B', x: 10, z: 0 }, { name: 'C', x: 18, z: 0 }],
    hostiles: [{ name: 'zombie', x: 19, z: 0 }, { name: 'spider', x: 11, z: 0 }],
  });
  assert.strictEqual(r.mob.name, 'spider');
});

test('aucun coéquipier / entrées vides → null, jamais de crash', () => {
  assert.strictEqual(pickMobAssist({ self: SELF, mates: [], hostiles: [{ name: 'zombie', x: 1, z: 0 }] }), null);
  assert.strictEqual(pickMobAssist({ self: SELF, mates: COPAIN, hostiles: [] }), null);
  assert.strictEqual(pickMobAssist({}), null);
  assert.strictEqual(pickMobAssist(), null);
});

// ── ARMURER LES CARTOGRAPHES (Massii 26/07) ─────────────────────────────────────────────────────
const { pickMapperToEquip, giftSetPlan, allMappersArmored } = require('./teamwork');

const MNOW = 1_000_000;
const mapper = (name, armor, at = MNOW) => ({ name, role: 'mapper', x: 0, z: 0, armor, at });
const worker = (name, armor, at = MNOW) => ({ name, role: 'worker', x: 0, z: 0, armor, at });
const ARMORED = { armor: 4, ingots: 0, need: 0 };

test('pickMapperToEquip: je ne pars equiper personne tant que MON armure est incomplete', () => {
  const mates = [mapper('MapBot1', 0)];
  for (const a of [0, 1, 2, 3]) {
    assert.strictEqual(
      pickMapperToEquip({ selfName: 'W1', selfStatus: { armor: a }, mates, now: MNOW }), null);
  }
});

test('pickMapperToEquip: choisit le mappeur le MOINS equipe', () => {
  const mates = [mapper('MapBot1', 3), mapper('MapBot2', 0), mapper('MapBot3', 2)];
  const r = pickMapperToEquip({ selfName: 'W1', selfStatus: ARMORED, mates, now: MNOW });
  assert.deepStrictEqual(r, { to: 'MapBot2', armor: 0 });
});

test('pickMapperToEquip: a egalite, choix DETERMINISTE par nom (2 workers ne convergent pas)', () => {
  const mates = [mapper('MapBot3', 0), mapper('MapBot1', 0), mapper('MapBot2', 0)];
  const a = pickMapperToEquip({ selfName: 'W1', selfStatus: ARMORED, mates, now: MNOW });
  const b = pickMapperToEquip({ selfName: 'W2', selfStatus: ARMORED, mates, now: MNOW });
  assert.strictEqual(a.to, 'MapBot1');
  assert.deepStrictEqual(a, b);
});

test('pickMapperToEquip: une cible RESERVEE par un autre worker est ignoree', () => {
  const mates = [mapper('MapBot1', 0), mapper('MapBot2', 1)];
  const r = pickMapperToEquip({
    selfName: 'W1', selfStatus: ARMORED, mates, claimed: new Set(['MapBot1']), now: MNOW });
  assert.deepStrictEqual(r, { to: 'MapBot2', armor: 1 });
});

test('pickMapperToEquip: ignore les workers, les mappeurs equipes et les presences perimees', () => {
  assert.strictEqual(pickMapperToEquip({
    selfName: 'W1', selfStatus: ARMORED, mates: [worker('W2', 0)], now: MNOW }), null);
  assert.strictEqual(pickMapperToEquip({
    selfName: 'W1', selfStatus: ARMORED, mates: [mapper('MapBot1', 4)], now: MNOW }), null);
  assert.strictEqual(pickMapperToEquip({
    selfName: 'W1', selfStatus: ARMORED, mates: [mapper('MapBot1', 0, MNOW - 999_999)], now: MNOW }), null);
});

test('pickMapperToEquip: statut inconnu = considere NU (on n_abandonne pas sur une supposition)', () => {
  const mates = [{ name: 'MapBot1', role: 'mapper', x: 0, z: 0, at: MNOW }];  // pas de champ armor
  const r = pickMapperToEquip({ selfName: 'W1', selfStatus: ARMORED, mates, now: MNOW });
  assert.deepStrictEqual(r, { to: 'MapBot1', armor: 0 });
});

test('giftSetPlan: poche vide → 4 pieces manquantes, 24 lingots a miner', () => {
  const r = giftSetPlan([]);
  assert.strictEqual(r.ready, false);
  assert.deepStrictEqual(r.missing,
    ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']);
  assert.strictEqual(r.ingotsShort, 24);
});

test('giftSetPlan: les lingots en poche reduisent ce qu_il reste a miner', () => {
  assert.strictEqual(giftSetPlan([{ name: 'iron_ingot', count: 10 }]).ingotsShort, 14);
  assert.strictEqual(giftSetPlan([{ name: 'iron_ingot', count: 30 }]).ingotsShort, 0);
});

test('giftSetPlan: set complet en poche → ready, plus rien a miner', () => {
  const items = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']
    .map((name) => ({ name, count: 1 }));
  const r = giftSetPlan(items);
  assert.strictEqual(r.ready, true);
  assert.deepStrictEqual(r.missing, []);
  assert.strictEqual(r.ingotsShort, 0);
});

test('giftSetPlan: une piece deja forgee retire SON cout, pas un cout moyen', () => {
  const r = giftSetPlan([{ name: 'iron_chestplate', count: 1 }]);   // 8 lingots economises
  assert.deepStrictEqual(r.have, ['iron_chestplate']);
  assert.strictEqual(r.ingotsShort, 24 - 8);
});

test('allMappersArmored: gate de la phase diamant', () => {
  assert.strictEqual(allMappersArmored([mapper('M1', 4), mapper('M2', 4)], { now: MNOW }), true);
  assert.strictEqual(allMappersArmored([mapper('M1', 4), mapper('M2', 3)], { now: MNOW }), false);
  assert.strictEqual(allMappersArmored([], { now: MNOW }), true);          // aucun mappeur = rien a attendre
  // un mappeur au statut inconnu bloque le passage au diamant
  assert.strictEqual(allMappersArmored(
    [{ name: 'M1', role: 'mapper', at: MNOW }], { now: MNOW }), false);
  // un mappeur PERIME (mort/deco) ne bloque pas
  assert.strictEqual(allMappersArmored([mapper('M1', 0, MNOW - 999_999)], { now: MNOW }), true);
});
