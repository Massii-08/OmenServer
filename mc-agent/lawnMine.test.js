'use strict';
// TRACÉ EN LACETS du branch-mine fer (22/10). Mesure du chrono world_oct22 : NethBot3 a passé 29 min
// en iron_deep pour 8 fers, en 10 appels de serpentin aléatoire tous repartis à < 25 blocs du même
// home work : une marche au hasard se recroise et longe ses propres galeries, chaque bloc de paroi
// déjà vu n'apporte plus rien. Un joueur trace des galeries PARALLÈLES espacées de 3 (2 blocs de
// pilier) : chaque bloc de paroi n'est découvert qu'une fois.
const test = require('node:test');
const assert = require('node:assert');
const L = require('./lawnMine');

function seededRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// Simule un tracé sur une grille 2D vide (aucun obstacle) et compte les cases de PAROI uniques
// (voisines 4-connexes non creusées) découvertes par case creusée.
function simulate(steps, next) {
  const dug = new Set(['0,0']);
  let x = 0, z = 0, digs = 0;
  for (let n = 0; n < steps; n++) {
    const h = next();
    x += h.dx; z += h.dz;
    const k = x + ',' + z;
    if (!dug.has(k)) { dug.add(k); digs++; }
  }
  const wall = new Set();
  for (const k of dug) {
    const [a, b] = k.split(',').map(Number);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const w = (a + dx) + ',' + (b + dz);
      if (!dug.has(w)) wall.add(w);
    }
  }
  return { digs, steps, wall: wall.size, perStep: wall.size / steps };
}

// L'ancienne règle du serpentin (branchMine) : segments de 4 à 8, virage gauche/droite au hasard.
function oldSerpentine(rng) {
  let h = { dx: 1, dz: 0 };
  let left = 4 + Math.floor(rng() * 5);
  return () => {
    const cur = h;
    if (--left <= 0) {
      h = rng() < 0.5 ? { dx: -h.dz, dz: h.dx } : { dx: h.dz, dz: -h.dx };
      left = 4 + Math.floor(rng() * 5);
    }
    return cur;
  };
}

function lawn(rng) {
  let st = L.lawnInit({ dx: 1, dz: 0 }, { rng });
  return () => {
    const cur = st.heading;
    st = L.lawnAfterStep(st, { rng });
    return cur;
  };
}

test('lacets : galeries parallèles espacées de 3, jamais un bloc re-creusé', () => {
  const r = simulate(400, lawn(seededRng(1)));
  assert.strictEqual(r.digs, r.steps, 'chaque pas creuse une case NEUVE (aucun recroisement)');
});

test('lacets : ≥ 1,3× plus de paroi découverte par pas que le serpentin aléatoire (moyenne de 8 graines)', () => {
  let a = 0, b = 0;
  for (let s = 1; s <= 8; s++) {
    a += simulate(400, lawn(seededRng(s))).perStep;
    b += simulate(400, oldSerpentine(seededRng(s))).perStep;
  }
  assert.ok(a / b >= 1.3, `lacets ${(a / 8).toFixed(2)} vs serpentin ${(b / 8).toFixed(2)} paroi/pas`);
});

test('lacets : motif long → décalage de 3 → long en sens inverse, le décalage toujours du même côté', () => {
  let st = L.lawnInit({ dx: 1, dz: 0 }, { rng: () => 0, length: 6, spacing: 3 });
  const hs = [];
  for (let i = 0; i < 6 + 3 + 6 + 3 + 6; i++) { hs.push(st.heading.dx + ',' + st.heading.dz); st = L.lawnAfterStep(st, { rng: () => 0, length: 6, spacing: 3 }); }
  const runs = [];
  for (const h of hs) { if (runs.length && runs[runs.length - 1][0] === h) runs[runs.length - 1][1]++; else runs.push([h, 1]); }
  assert.deepStrictEqual(runs.map((r) => r[1]), [6, 3, 6, 3, 6]);
  assert.strictEqual(runs[0][0], '1,0');
  assert.strictEqual(runs[2][0], '-1,0', 'retour en sens inverse');
  assert.strictEqual(runs[4][0], '1,0');
  assert.strictEqual(runs[1][0], runs[3][0], 'le décalage avance toujours du même côté (pas d\'aller-retour)');
});

test('lacets : longueur des longues galeries irrégulière (jamais métronomique), décalage FIXE à 3', () => {
  const rng = seededRng(4);
  let st = L.lawnInit({ dx: 0, dz: 1 }, { rng });
  const lens = [];
  let cur = st.heading, run = 0, legs = [];
  for (let i = 0; i < 300; i++) {
    if (st.heading.dx === cur.dx && st.heading.dz === cur.dz) run++;
    else { legs.push(run); cur = st.heading; run = 1; }
    st = L.lawnAfterStep(st, { rng });
  }
  const longs = legs.filter((_, i) => i % 2 === 0);
  const shorts = legs.filter((_, i) => i % 2 === 1);
  for (const s of shorts) assert.strictEqual(s, L.LAWN_SPACING);
  assert.ok(new Set(longs).size >= 2, `longueurs variées : ${JSON.stringify(longs)}`);
  for (const l of longs) assert.ok(l >= L.LAWN_LENGTH && l < L.LAWN_LENGTH + L.LAWN_JITTER, `long=${l}`);
  void lens;
});

test('lacets : obstacle sur une longue galerie → on prend le décalage TOUT DE SUITE (pas un virage au hasard)', () => {
  let st = L.lawnInit({ dx: 1, dz: 0 }, { rng: () => 0, length: 10 });
  st = L.lawnAfterStep(st, {});
  const ob = L.lawnObstacle(st, {});
  assert.strictEqual(ob.leg, 'short');
  assert.deepStrictEqual([ob.heading.dx, ob.heading.dz], [0, 1]);
  assert.strictEqual(ob.left, L.LAWN_SPACING);
  // obstacle pendant le décalage → la longue galerie suivante démarre là, sens inverse
  const ob2 = L.lawnObstacle(ob, { rng: () => 0, length: 10 });
  assert.strictEqual(ob2.leg, 'long');
  assert.deepStrictEqual([ob2.heading.dx, ob2.heading.dz], [-1, 0]);
});

test('lacets : état invalide / absent → reparti proprement du cap donné', () => {
  assert.strictEqual(L.lawnValid(null), false);
  assert.strictEqual(L.lawnValid({ heading: { dx: 2, dz: 0 }, leg: 'long', turn: 1, left: 3 }), false);
  assert.strictEqual(L.lawnValid({ heading: { dx: 1, dz: 0 }, leg: 'long', turn: 1, left: 3 }), true);
  assert.strictEqual(L.lawnValid({ heading: { dx: 1, dz: 1 }, leg: 'long', turn: 1, left: 3 }), false, 'diagonale');
});

// ── Reprise au FRONT (mémo base) ─────────────────────────────────────────────────────────────
test('lawnResume : bot au front mémorisé (≤ 8 blocs, même couche) → reprend l\'état ; ailleurs → null', () => {
  const st = L.lawnInit({ dx: 1, dz: 0 }, { rng: () => 0 });
  const saved = { state: st, x: 100, y: 15, z: -40, at: 1000 };
  assert.deepStrictEqual(L.lawnResume(saved, { x: 104, y: 15, z: -38 }, 2000), st);
  assert.strictEqual(L.lawnResume(saved, { x: 130, y: 15, z: -40 }, 2000), null, 'trop loin = autre chantier');
  assert.strictEqual(L.lawnResume(saved, { x: 100, y: 40, z: -40 }, 2000), null, 'autre couche');
  assert.strictEqual(L.lawnResume(saved, { x: 100, y: 15, z: -40 }, 1000 + L.LAWN_RESUME_TTL_MS + 1), null, 'périmé');
  assert.strictEqual(L.lawnResume({ state: { junk: 1 }, x: 100, y: 15, z: -40, at: 1000 }, { x: 100, y: 15, z: -40 }, 2000), null);
  assert.strictEqual(L.lawnResume(null, { x: 0, y: 0, z: 0 }, 0), null);
});
