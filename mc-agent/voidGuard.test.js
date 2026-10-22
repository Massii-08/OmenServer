'use strict';
const test = require('node:test');
const assert = require('node:assert');
const vg = require('./voidGuard');

// Monde jouet : sol plein à y≤42 partout ; colonne d'air (puits) en x=-344,z=358 de y43 à y74 ;
// terrain plein jusqu'à y74 ailleurs (surface = y75).
function world({ shaft = true, surface = 74, holes = [] } = {}) {
  return (p) => {
    const k = `${p.x},${p.y},${p.z}`;
    if (holes.includes(k)) return { name: 'air', boundingBox: 'empty' };
    if (shaft && p.x === -344 && p.z === 358 && p.y >= 43 && p.y <= 74) return { name: 'air', boundingBox: 'empty' };
    if (p.y <= surface) return { name: 'stone', boundingBox: 'block' };
    return { name: 'air', boundingBox: 'empty' };
  };
}

test('groundCheck : au-dessus du puits → void_below ; à côté → ok ; chunk illisible → inconnu', () => {
  const w = world();
  assert.deepStrictEqual(vg.groundCheck(w, { x: -343.4, y: 75, z: 358.7 }), { ok: false, reason: 'void_below', solid: 0 });
  assert.strictEqual(vg.groundCheck(w, { x: -342.5, y: 75, z: 358.5 }).ok, true);
  assert.strictEqual(vg.groundCheck(() => null, { x: 0, y: 70, z: 0 }).ok, null);
  // un seul bloc plein puis du vide : refusé (il en faut 2)
  const thin = world({ shaft: false, holes: ['0,73,0'] });
  assert.strictEqual(vg.groundCheck(thin, { x: 0.5, y: 75, z: 0.5 }).ok, false);
});

test('groundCheck : le cas vécu — home posé EN PLEIN VOL à y59 dans le puits → refusé', () => {
  assert.strictEqual(vg.groundCheck(world(), { x: -343.4, y: 59.3, z: 358.7 }).ok, false);
});

test('groundCheck : eau et plantes ne comptent pas comme sol', () => {
  const w = (p) => (p.y === 69 ? { name: 'water' } : p.y === 68 ? { name: 'short_grass' } : { name: 'stone' });
  assert.strictEqual(vg.groundCheck(w, { x: 0, y: 70, z: 0 }).ok, false);
  assert.strictEqual(vg.isSolid({ name: 'oak_leaves', boundingBox: 'block' }), true);
});

test('dropDepth : 32 blocs au-dessus du puits, 0 sur la terre ferme', () => {
  assert.strictEqual(vg.dropDepth(world(), { x: -343.4, y: 75, z: 358.7 }), 32);
  assert.strictEqual(vg.dropDepth(world(), { x: -340, y: 75, z: 358 }), 0);
});

test('dropDepth : chunk illisible → null (jamais « vide » sur un chunk absent) ; l eau arrête la chute', () => {
  assert.strictEqual(vg.dropDepth(() => null, { x: 0, y: 70, z: 0 }), null);
  const lake = (p) => (p.y >= 60 ? { name: 'air', boundingBox: 'empty' } : { name: 'water' });
  assert.strictEqual(vg.dropDepth(lake, { x: 0, y: 70, z: 0 }), 10);
});

test('nearestSafeStand : depuis le haut du puits, la case voisine (rayon 4) ; rien de sûr → null', () => {
  const s = vg.nearestSafeStand(world(), { x: -343.4, y: 75, z: 358.7 });
  assert.ok(s, 'une case sûre existe');
  assert.strictEqual(s.y, 75);
  assert.ok(Math.abs(s.x + 344) + Math.abs(s.z - 358) === 1, `case adjacente au puits : ${JSON.stringify(s)}`);
  assert.strictEqual(vg.nearestSafeStand(() => ({ name: 'air', boundingBox: 'empty' }), { x: 0, y: 70, z: 0 }), null);
});

test('anchorAbove / descentOffset : départ de descente à ≤ 3 blocs de la base → décalé au-delà', () => {
  const base = { x: -343, y: 75, z: 358 };
  const here = { x: -343.4, y: 72, z: 358.7 };
  assert.deepStrictEqual(vg.anchorAbove(here, [base]), base);
  const off = vg.descentOffset(here, [base]);
  assert.ok(off && Math.hypot(off.x - base.x, off.z - base.z) > 3, JSON.stringify(off));
  // déjà loin, ou nettement SOUS l'ancre (mineur à y16) → rien à faire
  assert.strictEqual(vg.anchorAbove({ x: -330, y: 72, z: 358 }, [base]), null);
  assert.strictEqual(vg.anchorAbove({ x: -343, y: 16, z: 358 }, [base]), null);
  assert.strictEqual(vg.descentOffset({ x: -330, y: 72, z: 358 }, [base]), null);
  // deux ancres : le décalage s'éloigne des deux
  const off2 = vg.descentOffset({ x: 0, y: 70, z: 0 }, [{ x: 0, y: 70, z: 0 }, { x: 2, y: 70, z: 0 }]);
  assert.ok(off2.x < 0, JSON.stringify(off2));
});

test('isFallDeathMessage : chute de CE joueur seulement', () => {
  assert.ok(vg.isFallDeathMessage('NethBot3 fell from a high place', 'NethBot3'));
  assert.ok(vg.isFallDeathMessage('NethBot3 was doomed to fall', 'NethBot3'));
  assert.ok(vg.isFallDeathMessage('NethBot3 hit the ground too hard while trying to escape Zombie', 'NethBot3'));
  assert.ok(!vg.isFallDeathMessage('NethBot1 fell from a high place', 'NethBot3'));
  assert.ok(!vg.isFallDeathMessage('NethBot3 was shot by Skeleton', 'NethBot3'));
  assert.ok(!vg.isFallDeathMessage('<Bob> NethBot3 fell from a high place', 'NethBot3'));
});

test('fallDeathLoop : 2 chutes à ≤ 6 blocs en 2 min = boucle ; espacées ou loin = non', () => {
  const now = 1_000_000;
  assert.strictEqual(vg.fallDeathLoop([{ x: -343, z: 359, at: now - 4000 }, { x: -343, z: 359, at: now }], now).loop, true);
  assert.strictEqual(vg.fallDeathLoop([{ x: -343, z: 359, at: now - 200000 }, { x: -343, z: 359, at: now }], now).loop, false);
  assert.strictEqual(vg.fallDeathLoop([{ x: 0, z: 0, at: now - 4000 }, { x: 30, z: 0, at: now }], now).loop, false);
  assert.strictEqual(vg.fallDeathLoop([], now).loop, false);
});

test('deathBelowAnchor : mort au fond du puits sous la base → la base est condamnée', () => {
  const home = { x: -343, y: 75, z: 359 };
  assert.ok(vg.deathBelowAnchor({ x: -343.4, y: 43, z: 358.7 }, home));
  assert.ok(!vg.deathBelowAnchor({ x: -343, y: 74, z: 359 }, home));   // pas plus bas
  assert.ok(!vg.deathBelowAnchor({ x: -330, y: 43, z: 359 }, home));   // autre colonne
});

test('catchBlockPlan : au sommet du puits, remblai sous les pieds contre la paroi', () => {
  const plan = vg.catchBlockPlan(world(), { x: -343.4, y: 75, z: 358.7 });
  assert.ok(plan);
  assert.deepStrictEqual(plan.target, { x: -344, y: 74, z: 358 });
  assert.deepStrictEqual({ x: plan.ref.x + plan.face.x, y: plan.ref.y + plan.face.y, z: plan.ref.z + plan.face.z }, plan.target);
  // tout est air autour : rien à quoi s'accrocher
  assert.strictEqual(vg.catchBlockPlan(() => ({ name: 'air', boundingBox: 'empty' }), { x: 0, y: 70, z: 0 }), null);
});
