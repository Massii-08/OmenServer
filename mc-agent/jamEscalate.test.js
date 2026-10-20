'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { recordJam, DEFAULT_THRESHOLD, DEFAULT_GIVEUP_ESCALATIONS } = require('./jamEscalate');

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

// ─── 2e TIER : giveUp (relocate PROUVÉ futile) ────────────────────────────────────────────────────
// Live NethBot4 27/07 (world_mn9) : bot NO_GIVE+confine figé À LA SURFACE de son ancre (0,0,~119).
// L'escalade `unjam_relocate` appelle relocateToRegion → sous confine+nogive = safeWarpHome(anchor)
// = warp vers l'ancre confine = LE SPOT DE JAM lui-même → re-jam → re-escalade… boucle infinie (27
// unjam, 0 descente). recordJam ré-escaladait sans fin (reset count à 0 à chaque escalade). Il faut
// un 2e tier : escalades RÉPÉTÉES au MÊME endroit = relocate inutile → giveUp → process.exit (self-heal).
test('une seule escalade → escalate mais PAS giveUp (le relocate mérite sa chance)', () => {
  let s = null, last;
  for (let i = 0; i < 3; i++) { last = recordJam(s, 10, 10, 1000 + i * 6000); s = last.state; }
  assert.equal(last.escalate, true);
  assert.equal(last.giveUp, false);
});

test('escalades répétées AU MÊME endroit → giveUp au 2e seuil (relocate futile, live NethBot4)', () => {
  let s = null, t = 1000, last;
  // 3 escalades successives au même spot (chacune = 3 jams). L'escalade réinitialise count → il faut
  // 3 nouveaux jams pour re-escalader ; le relocate ne bouge pas le bot (warp vers l'ancre = ici).
  let escalations = 0;
  for (let step = 0; step < 12 && escalations < DEFAULT_GIVEUP_ESCALATIONS; step++) {
    last = recordJam(s, 10, 10, t); s = last.state; t += 6000;
    if (last.escalate) escalations++;
  }
  assert.equal(escalations, DEFAULT_GIVEUP_ESCALATIONS);
  assert.equal(last.giveUp, true);   // 3e escalade au même spot → on abandonne (exit + self-heal)
});

test('escalade PUIS déplacement réel → pas de giveUp (le relocate a marché)', () => {
  // 1re escalade à (10,10), puis le bot bouge de 200 blocs (relocate efficace) → l'escalade suivante
  // ailleurs ne cumule PAS le compteur d'escalades → jamais giveUp (bot productif protégé).
  let s = null, t = 1000, last, escAt = [];
  for (let i = 0; i < 3; i++) { last = recordJam(s, 10, 10, t); s = last.state; t += 6000; }
  assert.equal(last.escalate, true); assert.equal(last.giveUp, false); escAt.push([10, 10]);
  // relocate efficace : jams suivants loin (300,300)
  for (let i = 0; i < 3; i++) { last = recordJam(s, 300, 300, t); s = last.state; t += 6000; }
  assert.equal(last.escalate, true);
  assert.equal(last.giveUp, false);   // escalade à un NOUVEAU spot → compteur d'escalades reparti à 1
});

test('escalades au même spot mais HORS fenêtre giveUp → compteur d\'escalades réinitialisé', () => {
  let s = null, t = 1000, last;
  for (let i = 0; i < 3; i++) { last = recordJam(s, 10, 10, t); s = last.state; t += 6000; }
  assert.equal(last.escalate, true); assert.equal(last.giveUp, false);
  // 2e escalade > 5 min après la 1re → hors fenêtre → escCount repart à 1, pas de giveUp
  t += 400000;
  for (let i = 0; i < 3; i++) { last = recordJam(s, 10, 10, t); s = last.state; t += 6000; }
  assert.equal(last.escalate, true);
  assert.equal(last.giveUp, false);
});

test('défaut : giveUp après 3 escalades', () => {
  assert.equal(DEFAULT_GIVEUP_ESCALATIONS, 3);
});

// ─── 3e tier : jam_loop répété d'une session à l'autre (20/10, NethBot1) ─────────────────────────
const { jamLoopMemoWith, jamLoopAtStart, jamLoopCleared, JAM_LOOP_TTL_MS } = require('./jamEscalate');

test('jamLoopMemoWith : fusionne le mémo, cumule au même endroit, repart à 1 ailleurs', () => {
  const T = 1_800_000_000_000;
  const m1 = jamLoopMemoWith({ base: { x: 1 }, woodRequest: { want: 16 } }, { x: -43, y: 40, z: -340 }, T);
  assert.deepStrictEqual(m1.base, { x: 1 });
  assert.deepStrictEqual(m1.woodRequest, { want: 16 });
  assert.strictEqual(m1.jamLoop.count, 1);
  const m2 = jamLoopMemoWith(m1, { x: -42, y: 40, z: -339 }, T + 60000);
  assert.strictEqual(m2.jamLoop.count, 2);
  const m3 = jamLoopMemoWith(m2, { x: 100, y: 40, z: -339 }, T + 120000);
  assert.strictEqual(m3.jamLoop.count, 1);
  const m4 = jamLoopMemoWith(m2, { x: -42, y: 40, z: -339 }, T + 60000 + JAM_LOOP_TTL_MS);
  assert.strictEqual(m4.jamLoop.count, 1, 'trop vieux : pas le même piège');
});

test('jamLoopAtStart : vrai seulement au 2e jam_loop récent, à ≤ 4 blocs', () => {
  const T = 1_800_000_000_000;
  const p = { x: -43, y: 40, z: -340 };
  const one = jamLoopMemoWith(null, p, T);
  assert.strictEqual(jamLoopAtStart(one, p, T + 1000), false);
  const two = jamLoopMemoWith(one, p, T + 60000);
  assert.strictEqual(jamLoopAtStart(two, { x: -41, y: 40, z: -338 }, T + 70000), true);
  assert.strictEqual(jamLoopAtStart(two, { x: -20, y: 40, z: -338 }, T + 70000), false, 'ailleurs');
  assert.strictEqual(jamLoopAtStart(two, p, T + 60000 + JAM_LOOP_TTL_MS), false, 'périmé');
  assert.strictEqual(jamLoopAtStart(null, p, T), false);
  assert.strictEqual(jamLoopAtStart(jamLoopCleared(two), p, T + 70000), false);
  assert.deepStrictEqual(jamLoopCleared({ a: 1, jamLoop: {} }), { a: 1 });
});
