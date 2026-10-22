'use strict';
const test = require('node:test');
const assert = require('node:assert');
const rc = require('./respawnCamp');

const P = { x: 94.7, y: 64.75, z: -49.3 };   // le point de réapparition live de NethBot3

function lifeSeq(spec, t0 = 1000000) {
  // spec : [[pos, lifeMs|null]] — null = vie en cours
  let lives = [];
  let t = t0;
  for (const [pos, lifeMs] of spec) {
    lives = rc.livesNoteSpawn(lives, pos, t);
    if (lifeMs != null) { t += lifeMs; lives = rc.livesNoteDeath(lives, t); }
    t += 2000;   // écran de mort
  }
  return { lives, t };
}

test('le cas live : 2 vies de 6-12 s au même point → campé (avec le nombre de morts)', () => {
  const { lives, t } = lifeSeq([[P, 6000], [{ x: 95, z: -50 }, 12000]]);
  assert.deepStrictEqual(rc.campedRespawn(lives, t), { x: 95, z: -50, deaths: 2 });
});

test('une seule vie brève → pas campé ; deux vies longues → pas campé', () => {
  assert.strictEqual(rc.campedRespawn(lifeSeq([[P, 6000]]).lives, 1010000), null);
  const { lives, t } = lifeSeq([[P, 70000], [P, 90000]]);
  assert.strictEqual(rc.campedRespawn(lives, t), null);
});

test('morts brèves mais à des points DIFFÉRENTS (> 8 blocs) : pas ce point-là', () => {
  const { lives, t } = lifeSeq([[{ x: 0, z: 0 }, 5000], [{ x: 40, z: 0 }, 5000]]);
  assert.strictEqual(rc.campedRespawn(lives, t), null);
});

test('le verdict porte sur le DERNIER point : après le déplacement du spawnpoint, le vieux camp ne compte plus', () => {
  const { lives, t } = lifeSeq([[P, 5000], [P, 5000], [{ x: 57, z: -23 }, null]]);
  assert.strictEqual(rc.campedRespawn(lives, t), null);
});

test('vie en cours (pas encore morte) ignorée ; fenêtre 10 min', () => {
  const { lives, t } = lifeSeq([[P, 5000], [P, 5000]]);
  assert.ok(rc.campedRespawn(lives, t));
  assert.strictEqual(rc.campedRespawn(lives, t + rc.LIVES_WINDOW_MS), null);
});

test('livesNoteDeath ne clôt que la vie ouverte ; livesPrune jette le futur et l absurde, cap', () => {
  let l = rc.livesNoteSpawn([], P, 100);
  l = rc.livesNoteDeath(l, 200);
  l = rc.livesNoteDeath(l, 300);   // pas de vie ouverte : rien ne change
  assert.deepStrictEqual(l, [{ x: 95, z: -49, t: 100, d: 200 }]);
  assert.deepStrictEqual(rc.livesPrune([{ x: 1, z: 1, t: 999 }, { x: 'a' }, null], 500), []);
  let many = [];
  for (let i = 0; i < 30; i++) many = rc.livesNoteSpawn(many, P, 1000 + i);
  assert.strictEqual(many.length, rc.LIVES_CAP);
});

test('mémo : fusion qui préserve les autres champs (base, dette, lit…)', () => {
  const memo = { base: { x: 1, z: 2 }, deaths: [5], bed: { x: 3, y: 4, z: 5 } };
  const m2 = rc.livesMemoWith(memo, [{ x: 1, z: 1, t: 10 }], 20);
  assert.deepStrictEqual(m2.base, memo.base);
  assert.deepStrictEqual(m2.bed, memo.bed);
  assert.deepStrictEqual(rc.livesLoad(m2, 20), [{ x: 1, z: 1, t: 10 }]);
  assert.deepStrictEqual(rc.livesLoad(null, 20), []);
  assert.strictEqual(memo.respawnLives, undefined, 'entrée non mutée');
});

test('camps : ajout dédoublonné, TTL 30 min, campedNear (rayon 24)', () => {
  let m = rc.campedMemoWith({ base: 1 }, { x: 95, z: -50, deaths: 2 }, 1000);
  m = rc.campedMemoWith(m, { x: 97, z: -48, deaths: 4 }, 2000);   // même camp → remplacé
  assert.strictEqual(m.base, 1);
  assert.deepStrictEqual(rc.campedList(m, 2000), [{ x: 97, z: -48, at: 2000, deaths: 4 }]);
  assert.ok(rc.campedNear(m, { x: 110, z: -40 }, 3000));
  assert.strictEqual(rc.campedNear(m, { x: 57, z: -23 }, 3000), null);
  assert.strictEqual(rc.campedNear(m, { x: 97, z: -48 }, 2000 + rc.CAMPED_TTL_MS), null);
});

test('bedIsCampedPoint : lit à côté du point campé → oui ; ailleurs → non', () => {
  assert.strictEqual(rc.bedIsCampedPoint({ x: 93, y: 64, z: -50 }, { x: 95, z: -49 }), true);
  assert.strictEqual(rc.bedIsCampedPoint({ x: 60, y: 64, z: -20 }, { x: 95, z: -49 }), false);
  assert.strictEqual(rc.bedIsCampedPoint(null, { x: 95, z: -49 }), false);
});
