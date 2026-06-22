'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { recordJam, DEFAULT_THRESHOLD } = require('./jamEscalate');

test('1er jam → pas d\'escalade (le dig de l\'unjam suffit souvent)', () => {
  const r = recordJam(null, 381, 395, 1000);
  assert.equal(r.escalate, false);
  assert.equal(r.state.count, 1);
});

test('jams répétés AU MÊME endroit → escalade au seuil (live ResBot2 381,65,395 ×12)', () => {
  let s = null, last;
  for (let i = 0; i < 3; i++) { last = recordJam(s, 381, 395, 1000 + i * 6000); s = last.state; }
  assert.equal(last.escalate, true);     // 3e jam même spot → escalade
  assert.equal(s.count, 0);              // reset post-escalade (cf. anti-spam, test dédié plus bas)
});

test('jams à des endroits DIFFÉRENTS → pas d\'escalade (flailing normal, chaque unjam avance)', () => {
  let s = recordJam(null, 0, 0, 1000).state;
  const r = recordJam(s, 50, 50, 7000);   // a bougé de ~70 blocs → reset
  assert.equal(r.escalate, false);
  assert.equal(r.state.count, 1);
});

test('jam même spot mais HORS fenêtre → compteur réinitialisé', () => {
  const s = { x: 381, z: 395, t: 1000, count: 2 };
  const r = recordJam(s, 381, 395, 1000 + 200000);  // >120 s plus tard
  assert.equal(r.escalate, false);
  assert.equal(r.state.count, 1);
});

test('seuil/distance/fenêtre configurables', () => {
  const s = { x: 0, z: 0, t: 100, count: 2 };
  const r = recordJam(s, 1, 1, 300, { threshold: 3, sameDist: 4, windowMs: 1000 });
  assert.equal(r.escalate, true);      // 3 dans la fenêtre, ~même spot
  const r2 = recordJam({ x: 0, z: 0, t: 100, count: 1 }, 1, 1, 300, { threshold: 3, sameDist: 4, windowMs: 1000 });
  assert.equal(r2.escalate, false);    // seulement 2
});

test('après escalade, reset du compteur (state.count repart à 0 pour la prochaine fenêtre)', () => {
  let s = null, last;
  for (let i = 0; i < 3; i++) { last = recordJam(s, 10, 10, 1000 + i * 6000); s = last.state; }
  assert.equal(last.escalate, true);
  assert.equal(last.state.count, 0);   // remis à 0 → re-comptera avant de ré-escalader (anti-spam warp)
});

test('défaut : seuil = 3', () => {
  assert.equal(DEFAULT_THRESHOLD, 3);
});
