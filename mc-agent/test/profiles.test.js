'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { validateProfile } = require('../profiles');

const ok = { id: 'x', level: 1, label: 'X', persona: 'p', params: {}, tells: ['un tell'] };

test('validateProfile accepte un profil avec tells non vide', () => {
  assert.strictEqual(validateProfile(ok), ok);
});

test('validateProfile rejette un profil sans tells (invariant §2)', () => {
  assert.throws(() => validateProfile({ ...ok, tells: [] }), /tells/);
  assert.throws(() => validateProfile({ ...ok, tells: undefined }), /tells/);
});

test('validateProfile rejette un objet invalide ou sans id', () => {
  assert.throws(() => validateProfile(null), /object/);
  assert.throws(() => validateProfile({ ...ok, id: undefined }), /id/);
});
