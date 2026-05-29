'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// Vérifie que tous les modules unitaires se chargent sans erreur (catch les imports cassés).
// NB: on n'inclut PAS index.js — il a des effets de bord au chargement (mineflayer.createBot).
test('tous les modules unitaires se requirent sans throw', () => {
  assert.doesNotThrow(() => {
    require('../io');
    require('../state');
    require('../brain');
    require('../skills/say');
    require('../skills/follow');
    require('../skills/goto');
  });
});
