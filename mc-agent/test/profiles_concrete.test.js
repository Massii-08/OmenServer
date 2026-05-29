'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { listProfiles, loadProfile } = require('../profiles');

test('les 3 profils existent, niveaux 1/2/3', () => {
  const ids = listProfiles().map((p) => p.id).sort();
  assert.deepStrictEqual(ids, ['evident', 'expert', 'intermediaire']);
  assert.deepStrictEqual(listProfiles().map((p) => p.level).sort(), [1, 2, 3]);
});

test('chaque profil a une fiche de tells non vide (corrigé)', () => {
  for (const p of listProfiles()) {
    assert.ok(Array.isArray(p.tells) && p.tells.length >= 1, `${p.id} sans tells`);
    assert.ok(p.tells.every((t) => typeof t === 'string' && t.length > 8));
  }
});

test('le réalisme MONTE avec le niveau (latence + variance + taux d erreur)', () => {
  const ev = loadProfile('evident').params;
  const ex = loadProfile('expert').params;
  assert.ok(ex.chat.latencyStdMs > ev.chat.latencyStdMs);
  assert.ok(ex.errorRate > ev.errorRate);
  assert.ok(ev.chat.typoRate === 0);
});

test('le profil Expert a des tells NON statistiques (raisonnement/social/inédit)', () => {
  const joined = loadProfile('expert').tells.join(' ').toLowerCase();
  assert.ok(/raisonnement|social|in[ée]dit|inter-session|contextuel/.test(joined));
});
