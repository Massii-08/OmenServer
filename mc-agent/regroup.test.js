'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { pickRegroupTarget, MIN_FAR, COOLDOWN_MS } = require('./regroup');

// Idée Massii (25/07) : rester en groupe jusqu'à ce que chacun ait son armure fer ; après une mort,
// se re-téléporter aux autres. Avec keepInventory, la mort est gratuite — c'est le RETOUR à pied
// (200-400 blocs sous les mobs) qui tue une 2e fois.

const NOW = 1_000_000;
const mate = (name, x, z, extra = {}) => Object.assign({ name, x, z, role: 'worker', at: NOW }, extra);

const BASE = {
  self: { x: 0, z: 0 },
  selfName: 'NethBot1',
  mates: [mate('NethBot2', 300, 0)],
  armorComplete: false,
  now: NOW,
  lastAt: 0,
};

test('mort loin du groupe → /tpa vers le coéquipier', () => {
  const r = pickRegroupTarget(BASE);
  assert.deepEqual(r, { name: 'NethBot2', dist: 300 });
});

test('choisit le PLUS PROCHE (≠ mapperTp qui vise le plus loin)', () => {
  const r = pickRegroupTarget({ ...BASE, mates: [mate('Loin', 900, 0), mate('Proche', 200, 0)] });
  assert.equal(r.name, 'Proche');
});

test('coéquipier trop proche → on marche, pas de TP', () => {
  const r = pickRegroupTarget({ ...BASE, mates: [mate('NethBot2', MIN_FAR - 1, 0)] });
  assert.equal(r, null);
});

test('armure déjà complète → plus de regroupement (règle Massii)', () => {
  assert.equal(pickRegroupTarget({ ...BASE, armorComplete: true }), null);
});

test('les MAPPEURS ne comptent pas comme groupe (ils sont ailleurs par métier)', () => {
  const r = pickRegroupTarget({ ...BASE, mates: [mate('MapBot1', 300, 0, { role: 'mapper' })] });
  assert.equal(r, null);
});

test('présence PÉRIMÉE (>3 min) = coéquipier mort/déco → ignoré', () => {
  const r = pickRegroupTarget({ ...BASE, mates: [mate('NethBot2', 300, 0, { at: NOW - 200000 })] });
  assert.equal(r, null);
});

test('cooldown : pas deux regroupements coup sur coup', () => {
  assert.equal(pickRegroupTarget({ ...BASE, lastAt: NOW - 1000 }), null);
  assert.ok(pickRegroupTarget({ ...BASE, lastAt: NOW - COOLDOWN_MS - 1 }));
});

test('ne se choisit jamais SOI-MÊME', () => {
  const r = pickRegroupTarget({ ...BASE, mates: [mate('NethBot1', 300, 0)] });
  assert.equal(r, null);
});

test('aucun coéquipier / entrées bancales → null, jamais de crash', () => {
  assert.equal(pickRegroupTarget({ ...BASE, mates: [] }), null);
  assert.equal(pickRegroupTarget({ ...BASE, mates: [{ name: 'X' }, null, { x: 1, z: 1 }] }), null);
  assert.equal(pickRegroupTarget({}), null);
  assert.equal(pickRegroupTarget(), null);
});

test('distance calculée en 2D (x,z) et arrondie', () => {
  const r = pickRegroupTarget({ ...BASE, mates: [mate('NethBot2', 300, 400)] });
  assert.equal(r.dist, 500);
});

// ─── SQUAD (Massii 2026-07-26 : « une petite squad qui reste ensemble ») ─────────────────────────

const { squadLeader, squadTarget, SQUAD_NEAR, UNDERGROUND_Y } = require('./regroup');

const T = 1000000;
const fresh = (name, x, z, extra = {}) => ({ name, x, z, at: T, ...extra });

test('squadLeader : déterministe — les 3 bots désignent le MÊME chef', () => {
  const mates = [fresh('NethBot2', 0, 0), fresh('NethBot3', 0, 0)];
  assert.strictEqual(squadLeader({ selfName: 'NethBot1', mates, now: T }), 'NethBot1');
  const m2 = [fresh('NethBot1', 0, 0), fresh('NethBot3', 0, 0)];
  assert.strictEqual(squadLeader({ selfName: 'NethBot2', mates: m2, now: T }), 'NethBot1');
  const m3 = [fresh('NethBot1', 0, 0), fresh('NethBot2', 0, 0)];
  assert.strictEqual(squadLeader({ selfName: 'NethBot3', mates: m3, now: T }), 'NethBot1');
});

test('squadLeader : ignore les mappeurs et les présences périmées', () => {
  const mates = [fresh('AaaMapper', 0, 0, { role: 'mapper' }), { name: 'AabMort', x: 0, z: 0, at: 0 }];
  assert.strictEqual(squadLeader({ selfName: 'NethBot1', mates, now: T }), 'NethBot1');
});

test('squadLeader : personne → null', () => {
  assert.strictEqual(squadLeader({ selfName: null, mates: [], now: T }), null);
});

test('squadTarget : le CHEF ne suit personne (sinon la squad fuit sa propre queue)', () => {
  const mates = [fresh('NethBot2', 500, 500), fresh('NethBot3', 500, 500)];
  assert.strictEqual(
    squadTarget({ self: { x: 0, z: 0 }, selfName: 'NethBot1', mates, now: T }), null);
});

test('squadTarget : un suiveur trop loin rejoint le chef', () => {
  const mates = [fresh('NethBot1', 300, 0), fresh('NethBot3', 0, 0)];
  const r = squadTarget({ self: { x: 0, z: 0 }, selfName: 'NethBot2', mates, now: T });
  assert.strictEqual(r.name, 'NethBot1');
  assert.strictEqual(r.dist, 300);
});

test('squadTarget : assez près → on ne bouge pas (le seuil est 64, pas 120)', () => {
  const mates = [fresh('NethBot1', SQUAD_NEAR, 0)];
  assert.strictEqual(
    squadTarget({ self: { x: 0, z: 0 }, selfName: 'NethBot2', mates, now: T }), null);
  const mates2 = [fresh('NethBot1', SQUAD_NEAR + 5, 0)];
  assert.ok(squadTarget({ self: { x: 0, z: 0 }, selfName: 'NethBot2', mates: mates2, now: T }));
});

test('squadTarget : cooldown respecté', () => {
  const mates = [fresh('NethBot1', 300, 0)];
  const args = { self: { x: 0, z: 0 }, selfName: 'NethBot2', mates, now: T };
  assert.strictEqual(squadTarget({ ...args, lastAt: T - 1000 }), null);
  assert.ok(squadTarget({ ...args, lastAt: T - 90000 }));
});

test('squadTarget : armure complète → chacun reprend sa route (règle historique)', () => {
  const mates = [fresh('NethBot1', 300, 0)];
  assert.strictEqual(squadTarget({
    self: { x: 0, z: 0 }, selfName: 'NethBot2', mates, now: T, armorComplete: true,
  }), null);
});

// PIÈGE #42c : ne JAMAIS tp un bot en plein goto/minage — l'interruption rejette la promesse
// pathfinder → unreachable → le bot RELÂCHE sa claim et repart explorer (churn mesuré 27/07 :
// worker qui rebondit y15↔y69 pendant qu'il mine son fer). L'enforcement confine respectait déjà
// ce garde-fou (shouldEnforceConfine busy) ; le squad, plus agressif (20 s, seuil 64), ne le
// faisait PAS → il yankait les mineurs toutes les ~30 s. Le confine tient déjà la poche : différer
// le /tpa pendant un minage actif ne coûte pas la cohésion.
test('squadTarget : occupé (minage/tâche en cours) → pas de /tpa, même trop loin (piège #42c)', () => {
  const mates = [fresh('NethBot1', 300, 0)];
  const args = { self: { x: 0, z: 0 }, selfName: 'NethBot2', mates, now: T };
  assert.ok(squadTarget({ ...args }), 'témoin : loin + libre → cible');   // sanity
  assert.strictEqual(squadTarget({ ...args, busy: true }), null);
});

test('squadTarget : chef sans position connue → null (pas de cible inventée)', () => {
  const mates = [{ name: 'NethBot1', at: T }];
  assert.strictEqual(
    squadTarget({ self: { x: 0, z: 0 }, selfName: 'NethBot2', mates, now: T }), null);
});

// ─── LE CHEF DE SQUAD DOIT ETRE LE MINEUR, PAS LE PREMIER DANS L ALPHABET ───────────────────────
// Massii, live 27/07 : « les bots qui sont en difficulte ou qui ne font rien doivent se tp vers
// ceux qui sont SOUS TERRE et qui farment le fer pour les aider — le team fonctionne mais ils se
// tp aux bots en SURFACE donc ils ne descendent jamais ».
// `squadLeader` prenait le nom le plus petit (deterministe, mais AVEUGLE) : si ce bot traînait en
// surface, toute la squad remontait le rejoindre et personne ne minait. On garde le determinisme
// — indispensable pour que tous convergent au meme endroit sans se coordonner — mais le critere
// devient le TRAVAIL : le mineur souterrain le plus productif.

// (T et le helper `fresh` du bloc squad sont reutilises ; ici un helper a champs nommes)
const worker = (o) => Object.assign({ at: T, role: 'worker' }, o);

test('chef : un mineur souterrain productif bat le premier dans l alphabet', () => {
  const mates = [
    worker({ name: 'Aaa', x: 0, z: 0, y: 70, ironZone: 0 }),   // en surface, ne produit rien
    worker({ name: 'Zzz', x: 50, z: 0, y: 12, ironZone: 9 }),  // sous terre, produit
  ];
  assert.strictEqual(squadLeader({ selfName: 'Mmm', mates, now: T }), 'Zzz');
});

test('chef : entre deux mineurs, le PLUS productif', () => {
  const mates = [
    worker({ name: 'Aaa', x: 0, z: 0, y: 12, ironZone: 3 }),
    worker({ name: 'Zzz', x: 5, z: 0, y: 14, ironZone: 20 }),
  ];
  assert.strictEqual(squadLeader({ selfName: 'Mmm', mates, now: T }), 'Zzz');
});

test('chef : a productivite egale, depart deterministe par le nom (la squad converge)', () => {
  const mates = [
    worker({ name: 'Zzz', x: 0, z: 0, y: 12, ironZone: 5 }),
    worker({ name: 'Aaa', x: 5, z: 0, y: 12, ironZone: 5 }),
  ];
  const a = squadLeader({ selfName: 'Mmm', mates, now: T });
  const b = squadLeader({ selfName: 'Mmm', mates: mates.slice().reverse(), now: T });
  assert.strictEqual(a, 'Aaa');
  assert.strictEqual(a, b, 'l ordre du tableau ne doit jamais changer le chef');
});

test('chef : un bot en SURFACE qui a du fer en poche ne compte pas comme mineur', () => {
  const mates = [
    worker({ name: 'Aaa', x: 0, z: 0, y: 80, ironZone: 50 }),  // riche mais en surface
    worker({ name: 'Zzz', x: 5, z: 0, y: 10, ironZone: 2 }),   // sous terre, au travail
  ];
  assert.strictEqual(squadLeader({ selfName: 'Mmm', mates, now: T }), 'Zzz');
});

test('chef : personne ne mine => on retombe sur l ancien critere alphabetique', () => {
  const mates = [
    worker({ name: 'Zzz', x: 0, z: 0, y: 70, ironZone: 0 }),
    worker({ name: 'Aaa', x: 5, z: 0, y: 72, ironZone: 0 }),
  ];
  assert.strictEqual(squadLeader({ selfName: 'Mmm', mates, now: T }), 'Aaa');
});

test('chef : moi-meme mineur productif => c est MOI le chef, je ne remonte pas', () => {
  const mates = [worker({ name: 'Aaa', x: 0, z: 0, y: 70, ironZone: 0 })];
  const me = { name: 'Zzz', y: 10, ironZone: 12 };
  assert.strictEqual(squadLeader({ selfName: 'Zzz', mates, now: T, self: me }), 'Zzz');
});

test('chef : les mappeurs restent exclus (ils sont ailleurs par metier)', () => {
  const mates = [
    worker({ name: 'Aaa', role: 'mapper', x: 0, z: 0, y: 10, ironZone: 99 }),
    worker({ name: 'Zzz', x: 5, z: 0, y: 70, ironZone: 0 }),
  ];
  // le mappeur 'Aaa' minerait le plus, mais il ne doit JAMAIS etre chef
  assert.notStrictEqual(squadLeader({ selfName: 'Mmm', mates, now: T }), 'Aaa');
});

test('seuil souterrain : coherent avec le reste du code', () => {
  assert.ok(UNDERGROUND_Y < 58, 'sous terre = sous le niveau de surface utilise partout ailleurs');
});

// Le TP vers le mineur doit vraiment partir : c'est tout l'objet de la demande.
test('squadTarget : un bot de surface rejoint le mineur souterrain', () => {
  const mates = [worker({ name: 'Miner', x: 300, z: 0, y: 11, ironZone: 15 })];
  const r = squadTarget({
    self: { x: 0, z: 0 }, selfName: 'Idle', mates, armorComplete: false, now: T, lastAt: 0,
  });
  assert.ok(r, 'un TP doit etre decide');
  assert.strictEqual(r.name, 'Miner');
});

// ─── LA DISTANCE DE SQUAD IGNORAIT LA VERTICALE (mesure live 27/07) ────────────────────────────
// Massii : « il y a neth 4-5 qui sont toujours en surface ». Le chef etait pourtant bien le
// mineur (NethBot3, y=12, ironZone=48) — mais `_d` ne mesure que X/Z :
//     NethBot4 (218, 14, y=56)  vs  NethBot3 (232, 3, y=12)  =>  17 blocs => « deja assez pres »
// 17 blocs a plat, 44 blocs de ROCHE entre eux. Le bot de surface ne descendait donc JAMAIS.
// Un coequipier separe par 44 blocs de pierre n'est pas « a cote » : il est inaccessible.

test('squad : meme X/Z mais 44 blocs plus bas => on descend le rejoindre', () => {
  const mates = [worker({ name: 'Miner', x: 232, z: 3, y: 12, ironZone: 48 })];
  const r = squadTarget({
    self: { x: 218, z: 14, y: 56, ironZone: 0 }, selfName: 'Surface',
    mates, armorComplete: false, now: T, lastAt: 0,
  });
  assert.ok(r, 'le TP doit partir malgre les 17 blocs a plat');
  assert.strictEqual(r.name, 'Miner');
});

test('squad : vraiment a cote (meme profondeur, quelques blocs) => on ne TP pas', () => {
  const mates = [worker({ name: 'Miner', x: 232, z: 3, y: 12, ironZone: 48 })];
  const r = squadTarget({
    self: { x: 235, z: 5, y: 13, ironZone: 20 }, selfName: 'Autre',
    mates, armorComplete: false, now: T, lastAt: 0,
  });
  assert.strictEqual(r, null);
});

test('squad : y inconnu des deux cotes => comportement horizontal d origine (retro-compat)', () => {
  const mates = [worker({ name: 'Aaa', x: 300, z: 0 })];
  const r = squadTarget({
    self: { x: 0, z: 0 }, selfName: 'Zzz', mates, armorComplete: false, now: T, lastAt: 0,
  });
  assert.ok(r, 'a 300 blocs a plat, le TP part comme avant');
});
