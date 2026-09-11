'use strict';

/**
 * tests/outage.test.js — la machine à états « Omen injoignable » (lib/outage.js).
 *
 * Un blip de quelques secondes (redémarrage auto-deploy) doit rester
 * invisible ; seule une VRAIE coupure (deux échecs) doit lever le bandeau,
 * et un succès doit la faire disparaître immédiatement.
 */
const test = require('node:test');
const assert = require('node:assert');

const outage = require('../lib/outage.js');

const T0 = Date.parse('2026-09-11T09:00:00Z');

test('create() rend un état ok, sans sonde programmée', () => {
  assert.deepStrictEqual(outage.create(), { status: 'ok', failures: 0, next_probe_at: null });
});

test('ok + échec -> suspect, invisible, sonde dans PROBE_FIRST_MS', () => {
  const st = outage.onFailure(outage.create(), T0);
  assert.strictEqual(st.status, 'suspect');
  assert.strictEqual(st.failures, 1);
  assert.strictEqual(st.next_probe_at, T0 + outage.PROBE_FIRST_MS);
});

test('suspect + échec -> down, sonde dans PROBE_MS', () => {
  const suspect = outage.onFailure(outage.create(), T0);
  const down = outage.onFailure(suspect, T0 + 1000);
  assert.strictEqual(down.status, 'down');
  assert.strictEqual(down.failures, 2);
  assert.strictEqual(down.next_probe_at, T0 + 1000 + outage.PROBE_MS);
});

test('down + échec -> down (inchangé), sonde REPOUSSÉE de PROBE_MS depuis maintenant', () => {
  let st = outage.onFailure(outage.create(), T0);        /* ok -> suspect */
  st = outage.onFailure(st, T0 + 1000);                  /* suspect -> down */
  st = outage.onFailure(st, T0 + 20000);                 /* down -> down */
  assert.strictEqual(st.status, 'down');
  assert.strictEqual(st.failures, 3);
  assert.strictEqual(st.next_probe_at, T0 + 20000 + outage.PROBE_MS);
});

test('un succès depuis N’IMPORTE QUEL état repart directement à ok', () => {
  assert.deepStrictEqual(outage.onSuccess(outage.create()),
                         { status: 'ok', failures: 0, next_probe_at: null });

  const suspect = outage.onFailure(outage.create(), T0);
  assert.deepStrictEqual(outage.onSuccess(suspect),
                         { status: 'ok', failures: 0, next_probe_at: null });

  let down = outage.onFailure(outage.create(), T0);
  down = outage.onFailure(down, T0 + 1000);
  assert.deepStrictEqual(outage.onSuccess(down),
                         { status: 'ok', failures: 0, next_probe_at: null });
});

test('onFailure et onSuccess sont PURS : l’état passé en entrée n’est jamais muté', () => {
  const before = outage.create();
  const snapshot = JSON.parse(JSON.stringify(before));
  const after = outage.onFailure(before, T0);
  assert.deepStrictEqual(before, snapshot, 'onFailure a muté son entrée');
  assert.notStrictEqual(after, before, 'onFailure doit rendre un NOUVEL objet');

  const beforeSuccess = outage.onFailure(outage.create(), T0);
  const successSnapshot = JSON.parse(JSON.stringify(beforeSuccess));
  const afterSuccess = outage.onSuccess(beforeSuccess);
  assert.deepStrictEqual(beforeSuccess, successSnapshot, 'onSuccess a muté son entrée');
  assert.notStrictEqual(afterSuccess, beforeSuccess, 'onSuccess doit rendre un NOUVEL objet');
});

test('shouldProbe : faux avant la date, vrai à la date et après', () => {
  const st = outage.onFailure(outage.create(), T0);   /* next_probe_at = T0 + 6000 */
  assert.strictEqual(outage.shouldProbe(st, T0), false);
  assert.strictEqual(outage.shouldProbe(st, T0 + outage.PROBE_FIRST_MS - 1), false);
  assert.strictEqual(outage.shouldProbe(st, T0 + outage.PROBE_FIRST_MS), true);
  assert.strictEqual(outage.shouldProbe(st, T0 + outage.PROBE_FIRST_MS + 500), true);
});

test('shouldProbe : ok n’a jamais rien à sonder', () => {
  assert.strictEqual(outage.shouldProbe(outage.create(), T0), false);
  assert.strictEqual(outage.shouldProbe(outage.create(), T0 + 999999), false);
});

test('un état absent ou corrompu retombe sur ok, sans planter', () => {
  assert.strictEqual(outage.shouldProbe(null, T0), false);
  assert.strictEqual(outage.shouldProbe(undefined, T0), false);
  assert.strictEqual(outage.shouldProbe({}, T0), false);
  assert.strictEqual(outage.shouldProbe({ status: 'n’importe quoi' }, T0), false);
  const st = outage.onFailure({ status: 'inconnu', failures: 'abc' }, T0);
  assert.strictEqual(st.status, 'suspect');
  assert.strictEqual(st.failures, 1);
});

test('une date illisible ne programme aucune sonde (jamais un chiffre inventé)', () => {
  const st = outage.onFailure(outage.create(), 'bientôt');
  assert.strictEqual(st.next_probe_at, null);
  assert.strictEqual(outage.shouldProbe(st, T0), false);
  assert.strictEqual(outage.shouldProbe(outage.onFailure(outage.create(), T0), null), false);
});

test('les constantes documentées restent 6 s / 15 s', () => {
  assert.strictEqual(outage.PROBE_FIRST_MS, 6000);
  assert.strictEqual(outage.PROBE_MS, 15000);
});
