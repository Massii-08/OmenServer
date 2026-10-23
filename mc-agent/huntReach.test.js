'use strict';
const test = require('node:test');
const assert = require('node:assert');
const H = require('./huntReach');
const F = require('./food');

const P = (x, y, z) => ({ x, y, z });
const ent = (id, name, x, z, y = 64) => ({ id, name, position: P(x, y, z), isValid: true });

test('portée = portée de suivi des animaux du serveur (96), et la chasse « en vue » l utilise', () => {
  assert.strictEqual(H.HUNT_REACH_RADIUS, 96);
  assert.strictEqual(F.HUNT_SIGHT_RADIUS, H.HUNT_REACH_RADIUS);
});

test('isReachablePrey : une vache à 40 blocs est une cible (le bug : rayon 32)', () => {
  assert.strictEqual(H.isReachablePrey(ent(1, 'cow', 40, 0), P(0, 64, 0)), true);
  assert.strictEqual(H.isReachablePrey(ent(1, 'cow', 97, 0), P(0, 64, 0)), false);
});

test('isReachablePrey : falaise / grotte (|dy| > 20) écartée, hostile écarté, mort écarté, évitée écartée', () => {
  const me = P(0, 64, 0);
  assert.strictEqual(H.isReachablePrey(ent(1, 'pig', 10, 0, 90), me), false);
  assert.strictEqual(H.isReachablePrey(ent(1, 'zombie', 10, 0), me), false);
  assert.strictEqual(H.isReachablePrey(Object.assign(ent(1, 'pig', 10, 0), { isValid: false }), me), false);
  assert.strictEqual(H.isReachablePrey(ent(7, 'pig', 10, 0), me, { avoid: new Set([7]) }), false);
  assert.strictEqual(H.isReachablePrey(ent(7, 'pig', 10, 0), me, { names: ['sheep'] }), false);
});

test('herdSightings : regroupe par cellule de 32, le plus peuplé d abord, accepte l objet bot.entities', () => {
  const ents = { 1: ent(1, 'cow', 40, 40), 2: ent(2, 'cow', 42, 41), 3: ent(3, 'pig', -70, 10), 4: ent(4, 'zombie', 41, 40) };
  const s = H.herdSightings(ents, P(0, 64, 0));
  assert.strictEqual(s.length, 2);
  assert.deepStrictEqual(s[0], { x: 41, z: 41, n: 2, species: ['cow'] });
  assert.strictEqual(s[1].n, 1);
});

test('herdsMerge : une cellule revue est mise à jour, pas dupliquée ; plafond HERD_CAP', () => {
  let l = H.herdsMerge([], [{ x: 40, z: 40, n: 3, species: ['cow'] }], 1000);
  l = H.herdsMerge(l, [{ x: 45, z: 50, n: 1, species: ['cow'] }], 2000);
  assert.strictEqual(l.length, 1);
  assert.strictEqual(l[0].n, 1);
  assert.strictEqual(l[0].at, 2000);
  let big = [];
  for (let i = 0; i < 30; i++) big = H.herdsMerge(big, [{ x: i * 100, z: 0, n: 1 }], 3000 + i);
  assert.strictEqual(big.length, H.HERD_CAP);
  assert.strictEqual(big[big.length - 1].x, 2900, 'les plus récents gardés');
});

test('herdsLoad / herdsPrune : TTL et entrées venues du futur écartées', () => {
  const memo = { [H.HERD_MEMO_KEY]: [{ x: 1, z: 1, n: 1, at: 0 }, { x: 2, z: 2, n: 1, at: H.HERD_TTL_MS }, { x: 3, z: 3, n: 1, at: 10 * H.HERD_TTL_MS }, null, { x: 'a' }] };
  const l = H.herdsLoad(memo, H.HERD_TTL_MS + 10);
  assert.deepStrictEqual(l.map((h) => h.x), [2]);
  assert.deepStrictEqual(H.herdsLoad(null, 0), []);
});

test('pickHerd : le plus proche hors portée de vue, ni trop loin, ni dans une cellule ratée', () => {
  const now = 1000;
  const list = [
    { x: 30, z: 0, n: 5, at: now },          // à 30 : on le verrait d ici (la chasse l aurait pris)
    { x: 150, z: 0, n: 2, at: now },
    { x: 0, z: 120, n: 1, at: now },
    { x: 900, z: 0, n: 9, at: now },         // trop loin
  ];
  const h = H.pickHerd(list, { x: 0, z: 0 }, { now });
  assert.deepStrictEqual({ x: h.x, z: h.z, herd: h.herd, biome: h.biome }, { x: 0, z: 120, herd: true, biome: 'herd' });
  const h2 = H.pickHerd(list, { x: 0, z: 0 }, { now, avoid: [{ x: 5, z: 120 }] });
  assert.strictEqual(h2.x, 150);
  assert.strictEqual(H.pickHerd([], { x: 0, z: 0 }, { now }), null);
});

test('herdsObserve : un troupeau mémorisé tout près qu on ne voit plus est oublié ; un lointain reste', () => {
  const now = 5000;
  const list = [{ x: 10, z: 10, n: 3, at: now - 1000 }, { x: 200, z: 0, n: 2, at: now - 1000 }];
  const l = H.herdsObserve(list, [{ x: -40, z: 70, n: 1, species: ['pig'] }], { x: 0, z: 0 }, now);
  assert.deepStrictEqual(l.map((h) => h.x).sort((a, b) => a - b), [-40, 200]);
  const kept = H.herdsObserve(list, [{ x: 12, z: 11, n: 4 }], { x: 0, z: 0 }, now);
  assert.strictEqual(kept.find((h) => Math.abs(h.x - 12) <= 2).n, 4, 'revu : effectif à jour');
});

test('herdsForget / herdsChanged', () => {
  const l = [{ x: 0, z: 0, n: 1, at: 1 }, { x: 200, z: 0, n: 1, at: 1 }];
  assert.deepStrictEqual(H.herdsForget(l, { x: 10, z: 10 }).map((h) => h.x), [200]);
  assert.strictEqual(H.herdsChanged(l, l.slice()), false);
  assert.strictEqual(H.herdsChanged(l, [l[0]]), true);
  assert.strictEqual(H.herdsChanged(l, [l[0], Object.assign({}, l[1], { n: 4 })]), true);
});

// ── 23/10 : la porte de descente doit savoir s'il reste un troupeau CONNU à portée de marche ──
test('knownHerdNear : le troupeau connu le plus proche à ≤ 200 blocs, sans distance MINIMALE (la porte, pas l expédition)', () => {
  const now = 1000;
  const list = [
    { x: 30, z: 0, n: 1, at: now },          // tout près : compte (≠ pickHerd, qui l'écarte)
    { x: 150, z: 0, n: 2, at: now },
    { x: 900, z: 0, n: 9, at: now },         // trop loin
  ];
  const h = H.knownHerdNear(list, { x: 0, z: 0 }, { now });
  assert.deepStrictEqual([h.x, h.z, Math.round(h.dist)], [30, 0, 30]);
  assert.strictEqual(H.knownHerdNear([{ x: 250, z: 0, n: 1, at: now }], { x: 0, z: 0 }, { now }), null, 'au-delà de 200 → rien');
  assert.strictEqual(H.KNOWN_HERD_GATE_DIST, 200);
});

test('knownHerdNear : périmé (TTL), écarté (cellule ratée), entrée illisible → ignoré', () => {
  const now = 10 * 3600000;
  assert.strictEqual(H.knownHerdNear([{ x: 10, z: 0, n: 1, at: now - H.HERD_TTL_MS - 1 }], { x: 0, z: 0 }, { now }), null);
  assert.strictEqual(H.knownHerdNear([{ x: 100, z: 0, n: 1, at: now }], { x: 0, z: 0 }, { now, avoid: [{ x: 110, z: 5 }] }), null);
  assert.strictEqual(H.knownHerdNear(null, { x: 0, z: 0 }, { now }), null);
  assert.strictEqual(H.knownHerdNear([{ x: 10, z: 0, n: 1, at: now }], null, { now }), null);
});

test('herdToMarkAfterFail : la cellule de troupeau la plus proche à < 64 blocs, hors cellules déjà ratées', () => {
  const now = 1000;
  const list = [{ x: 55, z: 0, n: 2, at: now }, { x: 10, z: 5, n: 1, at: now }, { x: 100, z: 0, n: 3, at: now }];
  const h = H.herdToMarkAfterFail(list, { x: 0, z: 0 }, { now });
  assert.deepStrictEqual([h.x, h.z], [10, 5]);
  const h2 = H.herdToMarkAfterFail(list, { x: 0, z: 0 }, { now, avoid: [{ x: 12, z: 4 }] });
  assert.deepStrictEqual([h2.x, h2.z], [55, 0]);
  assert.strictEqual(H.herdToMarkAfterFail([{ x: 100, z: 0, n: 3, at: now }], { x: 0, z: 0 }, { now }), null, '≥ 64 : c est l expédition qui s en charge');
  assert.strictEqual(H.HERD_FAIL_MARK_DIST, 64);
});
