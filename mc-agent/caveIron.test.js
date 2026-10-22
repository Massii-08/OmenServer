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

test('pickIronCave : > 80 blocs exclu', () => {
  assert.strictEqual(C.pickIronCave(wall(100, 64, 0, 5), FROM), null);
  assert.ok(C.pickIronCave(wall(70, 64, 0, 3), FROM));
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
  const a = wall(70, 64, 0, 5);
  assert.ok(C.pickIronCave(a, FROM));
  assert.strictEqual(C.pickIronCave(a, FROM, { confine: { x: 0, z: 0, radius: 60 } }), null);
  assert.ok(C.pickIronCave(a, FROM, { confine: { x: 70, z: 0, radius: 60 } }));
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

test('disjoncteur unreachable : 2 échecs → cible, 3 → null, repos écoulé → cible, autre motif ignoré', () => {
  const now = 50_000_000;
  const far = (x) => ({ x, y: 64, z: 0, key: 'k' + x });
  const mk = (whys, ages) => whys.reduce((f, w, i) => C.caveFailsAdd(f, far(500 + i * 50), w, now - ages[i]), []);
  const target = wall(20, 64, 0, 4);
  const MIN = 60_000;
  assert.ok(C.pickIronCave(target, FROM, { now, fails: mk(['unreachable', 'unreachable'], [3 * MIN, 2 * MIN]) }));
  const three = mk(['unreachable', 'unreachable', 'unreachable'], [5 * MIN, 3 * MIN, MIN]);
  assert.strictEqual(C.pickIronCave(target, FROM, { now, fails: three }), null);
  assert.ok(C.caveCooldownUntil(three, now) > now);
  // 3e échec il y a > 20 min (mais < 30 min, TTL) : repos fini
  const old = mk(['unreachable', 'unreachable', 'unreachable'], [28 * MIN, 26 * MIN, 24 * MIN]);
  assert.ok(C.pickIronCave(target, FROM, { now, fails: old }));
  // autres motifs ne comptent pas
  assert.ok(C.pickIronCave(target, FROM, { now, fails: mk(['unreachable', 'timeout', 'unreachable'], [5 * MIN, 3 * MIN, MIN]) }));
  // 3 échecs étalés sur plus de 15 min ne déclenchent pas
  assert.ok(C.pickIronCave(target, FROM, { now, fails: mk(['unreachable', 'unreachable', 'unreachable'], [25 * MIN, 12 * MIN, MIN]) }));
  assert.strictEqual(C.CAVE_MAX_DIST, 80);
});

// ── ACCÈS PLAUSIBLE + ESCALADE (21/10, mesure 3 h : 25 `unreachable` sur 32 cibles, 11 à > 24 blocs
// en vertical du bot ; mêmes grappes reprises toutes les 30 min — (79,11,-44) ×4).
test('grappe PROFONDE ciblable sans entrée de grotte connue (22/10 : l\'escalier dirigé y mène)', () => {
  const deep = wall(20, 30, 0, 4);                       // 34 blocs sous le bot (y 64)
  assert.ok(C.pickIronCave(deep, FROM), 'plus de filtre « accès plausible »');
  assert.ok(C.pickIronCave(wall(20, 90, 0, 4), FROM), 'au-dessus : idem');
  // la profondeur reste payée : à nombre égal, la grappe la moins profonde passe devant
  const both = wall(20, 30, 0, 4).concat(wall(-20, 60, 0, 4));
  assert.strictEqual(C.pickIronCave(both, FROM).y, 60);
  // une grappe noyée reste exclue
  const wet = wall(20, 30, 0, 4).map((o, i) => (i < 2 ? Object.assign({}, o, { wet: true }) : o));
  assert.strictEqual(C.pickIronCave(wet, FROM), null);
});

test('stairPlan : départ `drop` blocs avant la grappe sur l\'axe principal, cap tourné vers elle', () => {
  const pl = C.stairPlan({ x: 0, y: 70, z: 0 }, { x: 50, y: 20, z: 10 });
  assert.deepStrictEqual(pl.dir, { dx: 1, dz: 0 });
  assert.strictEqual(pl.drop, 50);
  assert.deepStrictEqual(pl.start, { x: 0, z: 10 });
  assert.strictEqual(pl.targetY, 20);
  const pz = C.stairPlan({ x: 0, y: 70, z: 0 }, { x: 3, y: 40, z: -60 });
  assert.deepStrictEqual(pz.dir, { dx: 0, dz: -1 });
  assert.deepStrictEqual(pz.start, { x: 3, z: -30 });
  assert.strictEqual(C.stairPlan({ x: 0, y: 70, z: 0 }, { x: 10, y: 67, z: 0 }), null, 'à ≤ 4 blocs : pas d\'escalier');
  assert.strictEqual(C.stairPlan({ x: 0, y: 70, z: 0 }, { x: 10, y: 90, z: 0 }), null, 'au-dessus : pas d\'escalier');
  assert.strictEqual(C.stairPlan(null, { x: 0, y: 0, z: 0 }), null);
});

test('portée : 80 à plat ET 80 de dénivelé (pas 80 en 3D — le fer profond sous la surface restait hors de portée)', () => {
  assert.ok(C.pickIronCave(wall(60, -6, 0, 4), FROM), '63 à plat, 70 de dénivelé (3D ≈ 95) : ciblable');
  assert.strictEqual(C.pickIronCave(wall(84, 60, 0, 4), FROM), null, '> 80 à plat');
  assert.strictEqual(C.pickIronCave(wall(10, -20, 0, 4), FROM), null, '84 de dénivelé');
  assert.strictEqual(C.CAVE_MAX_DROP, 80);
});

test('yawOf : inverse exact de descendDiagonal.cardinalFromYaw', () => {
  const { cardinalFromYaw } = require('./skills/descendDiagonal');
  for (const d of [{ dx: 1, dz: 0 }, { dx: -1, dz: 0 }, { dx: 0, dz: 1 }, { dx: 0, dz: -1 }]) {
    assert.deepStrictEqual(cardinalFromYaw(C.yawOf(d)), d);
  }
});

test('caveAccessible : PUR, entrées absurdes → false', () => {
  assert.strictEqual(C.caveAccessible({ x: 0, y: 30, z: 0 }, { x: 0, y: 64, z: 0 }, null), false);
  assert.strictEqual(C.caveAccessible({ x: 0, y: 50, z: 0 }, { x: 0, y: 64, z: 0 }, null), true);
  assert.strictEqual(C.caveAccessible(null, { x: 0, y: 64, z: 0 }, []), false);
});

test('escalade : 2e déclenchement du disjoncteur en 2 h → grottes désactivées 2 h', () => {
  const H = 3600_000, MIN = 60_000;
  const t0 = 100 * H;
  // 1er déclenchement (repos jusqu'à t0+20min)
  let trips = C.caveBreakerNote([], t0 + C.CAVE_COOLDOWN_MS, t0);
  assert.strictEqual(trips.length, 1);
  assert.strictEqual(C.caveDisabledUntil(trips, t0), 0, 'un seul déclenchement : repos simple');
  // le même repos revu à chaque pas du planner : pas un nouveau déclenchement
  trips = C.caveBreakerNote(trips, t0 + C.CAVE_COOLDOWN_MS, t0 + 5 * MIN);
  trips = C.caveBreakerNote(trips, t0 + C.CAVE_COOLDOWN_MS + 3 * MIN, t0 + 6 * MIN);   // until prolongé = même repos
  assert.strictEqual(trips.length, 1);
  // 2e déclenchement 1 h plus tard → désactivé 2 h à compter de lui
  const t1 = t0 + H;
  trips = C.caveBreakerNote(trips, t1 + C.CAVE_COOLDOWN_MS, t1);
  assert.strictEqual(trips.length, 2);
  assert.strictEqual(C.caveDisabledUntil(trips, t1), t1 + C.CAVE_DISABLE_MS);
  assert.ok(C.caveDisabledUntil(trips, t1 + C.CAVE_DISABLE_MS - 1) > 0);
  assert.strictEqual(C.caveDisabledUntil(trips, t1 + C.CAVE_DISABLE_MS + 1), 0, 'au bout de 2 h : retour');
  // deux déclenchements espacés de plus de 2 h : pas d'escalade
  let far = C.caveBreakerNote([], t0 + C.CAVE_COOLDOWN_MS, t0);
  far = C.caveBreakerNote(far, t0 + 3 * H + C.CAVE_COOLDOWN_MS, t0 + 3 * H);
  assert.strictEqual(C.caveDisabledUntil(far, t0 + 3 * H), 0);
  // entrées absurdes / futur
  assert.deepStrictEqual(C.caveBreakerNote(null, 0, t0), []);
  assert.strictEqual(C.caveDisabledUntil([{ at: t0 + H, until: 0 }, { at: 'x' }], t0), 0);
});
