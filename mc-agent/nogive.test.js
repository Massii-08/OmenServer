'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { isForbiddenCheat } = require('./nogive');

// /kit = give DÉGUISÉ (vécu world_ax2 : le kit 'mapper' contient le set d'armure FER complet →
// les bots ressource en objectif iron_armor le tapaient au spawn → autonomous_done immédiat,
// grind court-circuité). En no-give, /kit est un cheat comme /give. (Le mappeur, non no-give,
// garde son kit — le filtre n'est posé qu'en NO_GIVE.)
test('isForbiddenCheat : /kit bloqué (give déguisé)', () => {
  assert.strictEqual(isForbiddenCheat('/kit mapper'), true);
  assert.strictEqual(isForbiddenCheat('/kit tools'), true);
  assert.strictEqual(isForbiddenCheat('/KIT mapper'), true);
  assert.strictEqual(isForbiddenCheat('/kitx'), false);        // pas de faux positif préfixe
});
