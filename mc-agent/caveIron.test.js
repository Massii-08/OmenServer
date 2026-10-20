'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('./caveIron');

const ore = (x, y, z, o = {}) => Object.assign({ material: 'iron_ore', x, y, z, exposed: true, wet: false, at: 't' }, o);
// Grappe de n minerais alignés tous les 2 blocs à partir de (x,y,z).
const wall = (x, y, z, n, o = {}) => Array.from({ length: n }, (_, i) => ore(x + 2 * i, y, z, o));
const FROM = { x: 0, y: 64, z: 0 };

test('exposedIronOres : fer exposé seulement (deepslate compris), dédupliqué, wet conservé', () => {
  const r = C.exposedIronOres([
    ore(1, 2, 3), ore(1, 2, 3), ore(4, 5, 6, { material: 'deepslate_iron_ore', wet: true }),
    ore(7, 8, 9, { exposed: false }), ore(7, 8, 9, { material: 'coal_ore' }), { material: 'iron_ore', x: 'a' }, null,
    ore(9, 9, 9, { exposed: undefined }),
  ]);
  assert.deepStrictEqual(r.map((o) => [o.x, o.wet]), [[1, false], [4, true]]);
});

test('clusterOres : chaînage transitif à ≤ 6 blocs, séparation au-delà', () => {
  const g = C.clusterOres([{ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 30, y: 0, z: 0 }]);
  const sizes = g.map((a) => a.length).sort();
  assert.deepStrictEqual(sizes, [1, 3]);
  // 3D : 4,4,4 → 6.93 > 6 → séparés
  assert.strictEqual(C.clusterOres([{ x: 0, y: 0, z: 0 }, { x: 4, y: 4, z: 4 }]).length, 2);
  assert.deepStrictEqual(C.clusterOres([]), []);
});

test('pickIronCave : une grappe de 3 est choisie, un minerai isolé jamais', () => {
  assert.strictEqual(C.pickIronCave([ore(10, 40, 10), ore(60, 40, 60)], FROM), null);
  const c = C.pickIronCave(wall(20, 40, 0, 3), FROM);
  assert.ok(c);
  assert.strictEqual(c.count, 3);
  assert.strictEqual(c.key, C.caveKey({ x: c.x, y: c.y, z: c.z }));
  assert.ok(c.key.startsWith('cave:'));
  assert.strictEqual(c.ores.length, 3);
});

test('pickIronCave : rentabilité = minerais / (distance + profondeur)', () => {
  const near3 = wall(30, 60, 0, 3);           // ~33 blocs, peu profond
  const far10 = wall(60, 60, 0, 10);           // ~69 blocs, 10 minerais : 10/74 ≈ 0.135 > 3/38 ≈ 0.079
  const c = C.pickIronCave([...near3, ...far10], FROM);
  assert.strictEqual(c.count, 10);
  const tooFar = wall(160, 60, 0, 10);         // 10/174 ≈ 0.057 < 0.079 → la petite proche gagne
  assert.strictEqual(C.pickIronCave([...near3, ...tooFar], FROM).count, 3);
  // recalcul explicite pour verrouiller la formule
  const r = C.rankIronCaves([...near3, ...far10], FROM);
  for (const x of r) {
    const d = Math.hypot(x.x - FROM.x, x.y - FROM.y, x.z - FROM.z);
    assert.ok(Math.abs(x.score - x.count / (d + Math.max(0, FROM.y - x.y) + 1)) < 1e-9);
  }
  assert.ok(r[0].score >= r[1].score);
});

test('pickIronCave : la profondeur pénalise (même distance, grappe en dessous moins rentable)', () => {
  const above = wall(0, 64, 40, 3);            // même altitude
  const below = wall(0, 24, 0, 3);             // 40 blocs plus bas
  const c = C.pickIronCave([...above, ...below], FROM);
  assert.strictEqual(c.y, 64);
});

test('pickIronCave : > 200 blocs exclu', () => {
  assert.strictEqual(C.pickIronCave(wall(210, 64, 0, 5), FROM), null);
  assert.ok(C.pickIronCave(wall(190, 64, 0, 3), FROM));
  assert.strictEqual(C.pickIronCave(wall(100, 64, 0, 5), FROM, { maxDist: 50 }), null);
});

test('pickIronCave : grappe claimée par un coéquipier exclue → la suivante', () => {
  const a = wall(20, 64, 0, 4), b = wall(-80, 64, 0, 3);
  const first = C.pickIronCave([...a, ...b], FROM);
  const second = C.pickIronCave([...a, ...b], FROM, { isClaimed: (k) => k === first.key });
  assert.notStrictEqual(second.key, first.key);
  assert.strictEqual(C.pickIronCave([...a], FROM, { isClaimed: () => true }), null);
  // un isClaimed qui jette ne casse rien
  assert.ok(C.pickIronCave([...a], FROM, { isClaimed: () => { throw new Error('x'); } }));
});

test('pickIronCave : échec < 30 min exclu, au-delà la grappe revient', () => {
  const now = 10_000_000;
  const a = wall(20, 64, 0, 4);
  const c = C.pickIronCave(a, FROM, { now });
  const fails = C.caveFailsAdd([], c, 'unreachable', now - 60_000);
  assert.strictEqual(C.pickIronCave(a, FROM, { now, fails }), null);
  const old = C.caveFailsAdd([], c, 'unreachable', now - C.CAVE_FAIL_TTL_MS - 1);
  assert.ok(C.pickIronCave(a, FROM, { now, fails: old }));
  // le centre a bougé de quelques blocs (une partie minée) : c'est toujours la même grotte
  const shifted = wall(24, 64, 0, 3);
  assert.strictEqual(C.pickIronCave(shifted, FROM, { now, fails }), null);
});

test('pickIronCave : grotte noyée (≥ 1/3 wet) exclue, wet jamais compté ni visité', () => {
  const g = [...wall(20, 64, 0, 3), ore(21, 64, 1, { wet: true }), ore(23, 64, 1, { wet: true })];
  assert.strictEqual(C.pickIronCave(g, FROM), null);                   // 2/5 wet
  const g2 = [...wall(20, 64, 0, 4), ore(21, 64, 1, { wet: true })];   // 1/5
  const c = C.pickIronCave(g2, FROM);
  assert.strictEqual(c.count, 4);
  assert.ok(c.ores.every((o) => !o.wet));
  // 2 secs + 1 wet : pas assez de secs
  assert.strictEqual(C.pickIronCave([...wall(20, 64, 0, 2), ore(22, 64, 2, { wet: true })], FROM), null);
});

test('pickIronCave : hors confinement exclu', () => {
  const a = wall(120, 64, 0, 5);
  assert.ok(C.pickIronCave(a, FROM));
  assert.strictEqual(C.pickIronCave(a, FROM, { confine: { x: 0, z: 0, radius: 100 } }), null);
  assert.ok(C.pickIronCave(a, FROM, { confine: { x: 100, z: 0, radius: 100 } }));
});

test('pickIronCave : entrées absurdes → null, jamais de throw', () => {
  assert.strictEqual(C.pickIronCave(null, FROM), null);
  assert.strictEqual(C.pickIronCave(wall(20, 64, 0, 3), null), null);
  assert.strictEqual(C.pickIronCave('x', { x: NaN }), null);
});

test('orderOres : plus proche voisin depuis le bot', () => {
  const r = C.orderOres([{ x: 10, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 6, y: 0, z: 0 }], { x: 0, y: 0, z: 0 });
  assert.deepStrictEqual(r.map((o) => o.x), [2, 6, 10]);
});

test('caveFailsPrune/Add : TTL, futur rejeté, plafond', () => {
  const now = 50_000_000;
  let f = [];
  for (let i = 0; i < 60; i++) f = C.caveFailsAdd(f, { x: i * 100, y: 0, z: 0 }, 'x', now);
  assert.strictEqual(f.length, C.CAVE_FAILS_CAP);
  assert.strictEqual(f[f.length - 1].x, 5900);                         // les plus récents gardés
  const mixed = [{ x: 0, y: 0, z: 0, at: now + 1000 }, { x: 0, y: 0, z: 0, at: now - 10 }, { bad: 1 }, null];
  assert.strictEqual(C.caveFailsPrune(mixed, now).length, 1);
  assert.deepStrictEqual(C.caveFailsAdd(null, null, 'x', now), []);
});

test('caveKey : cellule 16³ du centre', () => {
  assert.strictEqual(C.caveKey({ x: 17, y: -3, z: 31 }), 'cave:1,-1,1');
});
