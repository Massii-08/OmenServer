'use strict';
// HOME `safe` CAMPÉ (live 19/10) — décisions PURES. La glue (veto dans homewarp.goHome/safeWarpHome,
// re-pose, mémo) est testée dans index.homesafety.test.js.
const test = require('node:test');
const assert = require('node:assert');
const H = require('./homeSafety');
const { DEATH_WINDOW_MS } = require('./unstuck');
const { SAFE_HOME_MIN_Y } = require('./homes');

const T0 = 1_700_000_000_000;
const MIN = 60 * 1000;
const HOME = { x: 0, y: 70, z: 0 };
const death = (x, z, agoMs, y = 70) => ({ x, y, z, at: T0 - agoMs });

// ═════════════════════════════ homeCamped ══════════════════════════════════════════════════════════
test('homeCamped : 2 morts à 10 blocs en 5 min → campé', () => {
  assert.strictEqual(H.homeCamped({ home: HOME, deaths: [death(10, 0, 5 * MIN), death(0, 10, 2 * MIN)], now: T0 }), true);
});

test('homeCamped : 1 seule mort → pas campé (un accident n est pas un camp)', () => {
  assert.strictEqual(H.homeCamped({ home: HOME, deaths: [death(3, 0, MIN)], now: T0 }), false);
});

test('homeCamped : morts à 40 blocs → pas campé', () => {
  assert.strictEqual(H.homeCamped({ home: HOME, deaths: [death(40, 0, MIN), death(0, -40, 2 * MIN)], now: T0 }), false);
});

test('homeCamped : morts de plus de 10 min → pas campé (fenêtre exclusive, comme `deaths`)', () => {
  assert.strictEqual(H.homeCamped({ home: HOME, deaths: [death(5, 0, 11 * MIN), death(0, 5, 12 * MIN)], now: T0 }), false);
  assert.strictEqual(H.homeCamped({ home: HOME, deaths: [death(5, 0, 10 * MIN), death(0, 5, 3 * MIN)], now: T0 }), false,
    'pile 10 min = déjà sortie de la fenêtre');
  assert.strictEqual(H.homeCamped({ home: HOME, deaths: [death(5, 0, 10 * MIN - 1), death(0, 5, 3 * MIN)], now: T0 }), true);
});

test('homeCamped : la frontière des 24 blocs est INCLUSE', () => {
  assert.strictEqual(H.homeCamped({ home: HOME, deaths: [death(24, 0, MIN), death(-24, 0, MIN)], now: T0 }), true);
  assert.strictEqual(H.homeCamped({ home: HOME, deaths: [death(24.6, 0, MIN), death(-24.6, 0, MIN)], now: T0 }), false);
});

test('homeCamped : 3D — deux morts au fond de la mine creusée SOUS la base ne campent pas la base', () => {
  assert.strictEqual(H.homeCamped({ home: HOME, deaths: [death(2, 0, MIN, 16), death(0, 3, MIN, 20)], now: T0 }), false);
});

test('homeCamped : altitude illisible (d un côté ou de l autre) → distance horizontale', () => {
  assert.strictEqual(H.homeCamped({ home: HOME, deaths: [death(2, 0, MIN, null), death(0, 3, MIN, null)], now: T0 }), true);
  assert.strictEqual(H.homeCamped({ home: { x: 0, z: 0 }, deaths: [death(2, 0, MIN, 16), death(0, 3, MIN, 20)], now: T0 }), true);
});

test('homeCamped : une mort datée du FUTUR (horloge reculée, mémo d un autre monde) ne compte pas', () => {
  assert.strictEqual(H.homeCamped({ home: HOME, deaths: [death(2, 0, -MIN), death(0, 3, MIN)], now: T0 }), false);
});

test('homeCamped : entrées absurdes → false, jamais de throw', () => {
  for (const o of [{}, { home: null, deaths: [death(1, 1, MIN), death(2, 2, MIN)], now: T0 },
    { home: { x: NaN, z: 0 }, deaths: [death(1, 1, MIN), death(2, 2, MIN)], now: T0 },
    { home: HOME, deaths: 'abc', now: T0 }, { home: HOME, deaths: [null, 3, { x: 'a' }], now: T0 },
    { home: HOME, deaths: [death(1, 1, MIN), death(2, 2, MIN)], now: NaN }]) {
    assert.strictEqual(H.homeCamped(o), false);
  }
  assert.strictEqual(H.homeCamped(), false);
});

test('homeCamped : un hostile signalé près du home N entre PAS dans la définition (personne n est encore mort)', () => {
  assert.strictEqual(H.homeCamped({ home: HOME, deaths: [death(3, 0, MIN)], hostilesNearHomeSeen: T0, now: T0 }), false);
});

test('homeCamped : n inspecte que des morts, ne mute pas la liste reçue', () => {
  const deaths = [death(0, 10, 2 * MIN), death(10, 0, 5 * MIN)];
  const snap = JSON.stringify(deaths);
  H.homeCamped({ home: HOME, deaths, now: T0 });
  assert.strictEqual(JSON.stringify(deaths), snap);
});

// ═════════════════════════════ rescueWarpVeto ══════════════════════════════════════════════════════
const CAMP = [death(4, 0, 2 * MIN), death(0, 6, MIN)];

test('rescueWarpVeto : home campé + NUIT → veto (why night)', () => {
  const v = H.rescueWarpVeto({ home: HOME, deaths: CAMP, now: T0, night: true });
  assert.deepStrictEqual(v, { veto: true, camped: true, why: 'night', deaths: 2 });
});

test('rescueWarpVeto : home campé + JOUR + hostile vu près du home il y a 2 min → veto (why hostile_near_home)', () => {
  const v = H.rescueWarpVeto({ home: HOME, deaths: CAMP, now: T0, night: false, hostilesNearHomeSeen: T0 - 2 * MIN });
  assert.strictEqual(v.veto, true);
  assert.strictEqual(v.why, 'hostile_near_home');
});

test('rescueWarpVeto : l hostile signalé prime sur la nuit dans le motif (il est la preuve directe)', () => {
  assert.strictEqual(H.rescueWarpVeto({ home: HOME, deaths: CAMP, now: T0, night: true, hostilesNearHomeSeen: true }).why, 'hostile_near_home');
});

test('rescueWarpVeto : home campé + JOUR + aucun hostile signalé → le secours PART (le camp brûle peut-être au jour)', () => {
  const v = H.rescueWarpVeto({ home: HOME, deaths: CAMP, now: T0, night: false });
  assert.deepStrictEqual(v, { veto: false, camped: true, why: null, deaths: 2 });
});

test('rescueWarpVeto : un hostile vu il y a plus de 5 min est oublié', () => {
  assert.strictEqual(H.rescueWarpVeto({ home: HOME, deaths: CAMP, now: T0, night: false, hostilesNearHomeSeen: T0 - 6 * MIN }).veto, false);
  assert.strictEqual(H.rescueWarpVeto({ home: HOME, deaths: CAMP, now: T0, night: false, hostilesNearHomeSeen: 0 }).veto, false);
});

test('rescueWarpVeto : heure INCONNUE (bot.time pas livré) → pas de veto sur la nuit, seul l hostile compte', () => {
  assert.strictEqual(H.rescueWarpVeto({ home: HOME, deaths: CAMP, now: T0, night: null }).veto, false);
  assert.strictEqual(H.rescueWarpVeto({ home: HOME, deaths: CAMP, now: T0, night: null, hostilesNearHomeSeen: true }).veto, true);
});

test('rescueWarpVeto : home PAS campé → jamais de veto, même la nuit avec un hostile', () => {
  const v = H.rescueWarpVeto({ home: HOME, deaths: [death(3, 0, MIN)], now: T0, night: true, hostilesNearHomeSeen: true });
  assert.deepStrictEqual(v, { veto: false, camped: false, why: null, deaths: 1 });
});

test('rescueWarpVeto : home inconnu → pas de veto (on ne bloque jamais un secours sur une donnée absente)', () => {
  assert.strictEqual(H.rescueWarpVeto({ home: null, deaths: CAMP, now: T0, night: true }).veto, false);
  assert.strictEqual(H.rescueWarpVeto().veto, false);
});

// ═════════════════════════════ safeHomeMove ════════════════════════════════════════════════════════
const HERE = { x: 120, y: 72, z: 40 };
const okMove = (over = {}) => H.safeHomeMove({
  home: HOME, here: HERE, deaths: CAMP, now: T0,
  inWater: false, onGround: true, night: false, nearestHostileDist: null, lastMovedAt: 0, ...over,
});

test('safeHomeMove : surface, au sec, de jour, au calme, home campé → on re-pose ICI', () => {
  assert.deepStrictEqual(okMove(), { move: true, reason: 'camped', deaths: 2 });
});

test('safeHomeMove : home pas campé → rien à faire', () => {
  assert.strictEqual(okMove({ deaths: [death(3, 0, MIN)] }).reason, 'not_camped');
  assert.strictEqual(okMove({ home: null }).move, false);
});

test('safeHomeMove : de NUIT → non ; heure inconnue → non (« de jour » doit être SU)', () => {
  assert.deepStrictEqual([okMove({ night: true }).move, okMove({ night: true }).reason], [false, 'night']);
  assert.deepStrictEqual([okMove({ night: null }).move, okMove({ night: null }).reason], [false, 'time_unknown']);
});

test('safeHomeMove : hostile à ≤ 24 blocs → non ; à 30 → oui', () => {
  assert.strictEqual(okMove({ nearestHostileDist: 10 }).reason, 'hostile_near');
  assert.strictEqual(okMove({ nearestHostileDist: 24 }).move, false);
  assert.strictEqual(okMove({ nearestHostileDist: 30 }).move, true);
  assert.strictEqual(okMove({ nearestHostileDist: NaN }).move, false, 'mesure illisible → pas calme');
});

test('safeHomeMove : sous terre / dans l eau / en l air → non (même garde que tout `safe`)', () => {
  assert.strictEqual(okMove({ here: { x: 120, y: SAFE_HOME_MIN_Y - 1, z: 40 } }).reason, 'not_surface');
  assert.strictEqual(okMove({ inWater: true }).reason, 'not_surface');
  assert.strictEqual(okMove({ onGround: false }).reason, 'airborne');
  assert.strictEqual(okMove({ here: { x: 120, z: 40 } }).reason, 'not_surface', 'y illisible → refus');
});

test('safeHomeMove : au plus 1 fois / 5 min', () => {
  assert.strictEqual(okMove({ lastMovedAt: T0 - 4 * MIN }).reason, 'cooldown');
  assert.strictEqual(okMove({ lastMovedAt: T0 - 5 * MIN }).move, true);
});

test('safeHomeMove : « ailleurs » veut dire HORS du camp — pas à 10 blocs du home, pas là où l on meurt aussi', () => {
  assert.strictEqual(okMove({ here: { x: 10, y: 70, z: 0 } }).reason, 'too_close_to_home');
  const deathsHere = CAMP.concat([death(121, 41, MIN), death(118, 39, 2 * MIN)]);
  assert.strictEqual(okMove({ deaths: deathsHere }).reason, 'camped_here');
});

// ═════════════════════════════ spawnSafeHomeAction ═════════════════════════════════════════════════
const SPAWN = { x: -3, y: 70, z: -1 };
const SPAWN_CAMP = [death(-1, 0, 2 * MIN), death(-5, -3, MIN)];
const FAR = { x: 300, y: 75, z: 80, at: T0 - 3 * MIN, why: 'camped' };

test('spawnSafeHomeAction : spawn sain → on pose (comportement historique)', () => {
  assert.deepStrictEqual(H.spawnSafeHomeAction({ here: SPAWN, deaths: [], now: T0, hasSafe: false, persisted: FAR }),
    { act: 'pose', camped: false });
});

test('spawnSafeHomeAction : spawn CAMPÉ + home persisté sain → on l ADOPTE au lieu de re-poser dans le camp', () => {
  const a = H.spawnSafeHomeAction({ here: SPAWN, deaths: SPAWN_CAMP, now: T0, hasSafe: false, persisted: FAR });
  assert.strictEqual(a.act, 'adopt');
  assert.deepStrictEqual({ x: a.home.x, y: a.home.y, z: a.home.z }, { x: 300, y: 75, z: 80 });
});

test('spawnSafeHomeAction : spawn campé + un safe déjà en main (amélioration surface) → on le GARDE', () => {
  assert.deepStrictEqual(H.spawnSafeHomeAction({ here: SPAWN, deaths: SPAWN_CAMP, now: T0, hasSafe: true, persisted: FAR }),
    { act: 'keep', camped: true });
});

test('spawnSafeHomeAction : spawn campé sans rien d autre → on pose quand même (un home connu, même campé, est mis sous veto ; un home inconnu ne peut pas l être)', () => {
  assert.deepStrictEqual(H.spawnSafeHomeAction({ here: SPAWN, deaths: SPAWN_CAMP, now: T0, hasSafe: false, persisted: null }),
    { act: 'pose', camped: true });
  const campedPersisted = { x: -2, y: 70, z: 0, at: T0 - MIN };
  assert.strictEqual(H.spawnSafeHomeAction({ here: SPAWN, deaths: SPAWN_CAMP, now: T0, hasSafe: false, persisted: campedPersisted }).act, 'pose');
});

// ═════════════════════════════ positions de mort persistées (`deathPos`) ═══════════════════════════
test('deathPosPrune : garde les valides, arrondit, trie, cape à 10, jette futur et périmé, ne mute pas', () => {
  const list = [
    { x: 1.4, y: 70.6, z: -2.5, at: T0 - 3 * MIN }, { x: 0, z: 0, at: T0 - 11 * MIN }, { x: 0, z: 0, at: T0 + 1 },
    null, 'x', { x: 'a', z: 0, at: T0 }, { x: 5, y: null, z: 5, at: T0 - MIN },
  ];
  const snap = JSON.stringify(list);
  assert.deepStrictEqual(H.deathPosPrune(list, T0), [{ x: 1, y: 71, z: -2, at: T0 - 3 * MIN }, { x: 5, y: null, z: 5, at: T0 - MIN }]);
  assert.strictEqual(JSON.stringify(list), snap);
  const many = Array.from({ length: 15 }, (_, i) => ({ x: i, y: 70, z: 0, at: T0 - (15 - i) * 1000 }));
  const kept = H.deathPosPrune(many, T0);
  assert.strictEqual(kept.length, H.DEATH_POS_CAP);
  assert.strictEqual(kept[kept.length - 1].x, 14, 'on garde les PLUS RÉCENTES');
  assert.deepStrictEqual(H.deathPosPrune('abc', T0), []);
  assert.deepStrictEqual(H.deathPosPrune([], NaN), []);
});

test('deathPosLoad : mémo d ANCIEN format (sans `deathPos`) / absent → [] (rétro-compat)', () => {
  for (const memo of [null, {}, { deaths: [T0 - 1000] }, { deathPos: 'abc' }]) assert.deepStrictEqual(H.deathPosLoad(memo, T0), []);
  assert.deepStrictEqual(H.deathPosLoad({ deathPos: [{ x: 1, y: 70, z: 2, at: T0 - 1000 }] }, T0), [{ x: 1, y: 70, z: 2, at: T0 - 1000 }]);
});

test('deathPosMemoWith : seul `deathPos` change — deaths/base/dette/zone/safeHome traversent intacts', () => {
  const memo = {
    base: { x: 10, y: 70, z: -4 }, personal: true, deaths: [T0 - 30000], deathDebt: { x: 1, y: 2, z: 3, at: T0 },
    zone: { anchoredAt: T0 - 5000 }, safeHome: { x: 9, y: 70, z: 9, at: T0 - 9000 },
  };
  const out = H.deathPosMemoWith(memo, [{ x: 3, y: 70, z: 4, at: T0 - 1000 }], T0);
  assert.deepStrictEqual(out.deathPos, [{ x: 3, y: 70, z: 4, at: T0 - 1000 }]);
  for (const k of Object.keys(memo)) assert.deepStrictEqual(out[k], memo[k], `${k} doit traverser`);
  assert.ok(!('deathPos' in memo), 'le mémo d entrée n est pas muté');
  assert.deepStrictEqual(H.deathPosMemoWith(null, [], T0), { deathPos: [] });
});

// ═════════════════════════════ home safe persisté (`safeHome`) ═════════════════════════════════════
test('safeHomeMemoWith / safeHomeLoad : aller-retour, arrondi, motif conservé, le reste traverse', () => {
  const memo = { base: { x: 1, y: 70, z: 1 }, deathPos: [{ x: 0, y: 70, z: 0, at: T0 }] };
  const out = H.safeHomeMemoWith(memo, { x: 12.6, y: 71.2, z: -3.5 }, T0, 'camped');
  assert.deepStrictEqual(out.safeHome, { x: 13, y: 71, z: -3, at: T0, why: 'camped' });
  assert.deepStrictEqual(out.base, memo.base);
  assert.deepStrictEqual(out.deathPos, memo.deathPos);
  assert.deepStrictEqual(H.safeHomeLoad(out), { x: 13, y: 71, z: -3, at: T0, why: 'camped' });
});

test('safeHomeLoad : absent / incomplet → null (on n adopte pas un home sur une lecture ratée)', () => {
  for (const memo of [null, {}, { safeHome: null }, { safeHome: { x: 1, z: 2, at: T0 } }, { safeHome: { x: 1, y: 70, z: 2 } },
    { safeHome: { x: 'a', y: 70, z: 2, at: T0 } }]) {
    assert.strictEqual(H.safeHomeLoad(memo), null);
  }
});

test('safeHomeMemoWith : position invalide → le mémo est rendu tel quel (copie)', () => {
  const memo = { safeHome: { x: 1, y: 70, z: 1, at: T0 - 1 } };
  const out = H.safeHomeMemoWith(memo, { x: NaN, y: 70, z: 0 }, T0, 'spawn');
  assert.deepStrictEqual(out, memo);
  assert.notStrictEqual(out, memo);
});

// ═════════════════════════════ hostiles autour d un point ══════════════════════════════════════════
const mob = (x, z, name = 'zombie', y = 70) => ({ name, kind: 'Hostile mobs', position: { x, y, z } });
const isHostile = (e) => e.kind === 'Hostile mobs';

test('nearestHostile : le plus proche, en 3D ; aucun → null', () => {
  const r = H.nearestHostile({ pos: HOME, entities: [mob(20, 0), mob(5, 0, 'creeper'), { name: 'cow', kind: 'Passive mobs', position: { x: 1, y: 70, z: 0 } }], isHostile });
  assert.deepStrictEqual(r, { dist: 5, mob: 'creeper' });
  assert.strictEqual(H.nearestHostile({ pos: HOME, entities: [], isHostile }), null);
  assert.strictEqual(H.nearestHostile({ pos: null, entities: [mob(1, 0)], isHostile }), null);
});

test('nearestHostile : un prédicat qui lève sur UNE entité ne masque pas les autres', () => {
  const boom = { name: 'boom', position: { x: 1, y: 70, z: 0 } };
  const pred = (e) => { if (e.name === 'boom') throw new Error('x'); return isHostile(e); };
  assert.deepStrictEqual(H.nearestHostile({ pos: HOME, entities: [boom, mob(9, 0)], isHostile: pred }), { dist: 9, mob: 'zombie' });
});

test('hostileNearHome : à ≤ 24 blocs du HOME (pas du bot) → vrai ; à 30 → faux', () => {
  assert.strictEqual(H.hostileNearHome({ home: HOME, entities: [mob(10, 10)], isHostile }), true);
  assert.strictEqual(H.hostileNearHome({ home: HOME, entities: [mob(30, 0)], isHostile }), false);
  assert.strictEqual(H.hostileNearHome({ home: null, entities: [mob(1, 0)], isHostile }), false);
});

test('hostileSeenRecently : true, horodatage frais (≤ 5 min), sinon non', () => {
  assert.strictEqual(H.hostileSeenRecently(true, T0), true);
  assert.strictEqual(H.hostileSeenRecently(T0 - 4 * MIN, T0), true);
  assert.strictEqual(H.hostileSeenRecently(T0 - 6 * MIN, T0), false);
  assert.strictEqual(H.hostileSeenRecently(0, T0), false);
  assert.strictEqual(H.hostileSeenRecently(null, T0), false);
  assert.strictEqual(H.hostileSeenRecently(T0 + MIN, T0), false, 'pas d observation du futur');
});

// ═════════════════════════════ une seule définition ═══════════════════════════════════════════════
test('constantes : 24 blocs, 2 morts, 10 min = la fenêtre de l historique `deaths` (pas deux qui divergent)', () => {
  assert.strictEqual(H.CAMP_RADIUS, 24);
  assert.strictEqual(H.CAMP_MIN_DEATHS, 2);
  assert.strictEqual(H.CAMP_WINDOW_MS, DEATH_WINDOW_MS);
  assert.strictEqual(H.MOVE_EVERY_MS, 5 * MIN);
  assert.strictEqual(H.CAMPED_EVENT_EVERY_MS, MIN);
  assert.strictEqual(H.MOVE_CALM_RADIUS, 24);
});
