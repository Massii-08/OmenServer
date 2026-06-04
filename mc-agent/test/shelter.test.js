'use strict';
// Abri nocturne (survie kit) : détection nuit pure + flow creuser/attendre/sortir.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isNightTime } = require('../skills/shelter');

describe('isNightTime (pur)', () => {
  it('jour (0, 6000, 12000) → false ; nuit (13000, 18000, 23000) → true', () => {
    for (const t of [0, 6000, 12000, 23800]) assert.equal(isNightTime(t), false, `t=${t}`);
    for (const t of [13000, 18000, 23000]) assert.equal(isNightTime(t), true, `t=${t}`);
  });
  it('wrap 24000 + null-safe', () => {
    assert.equal(isNightTime(24000 + 18000), true);
    assert.equal(isNightTime(null), false);
    assert.equal(isNightTime(undefined), false);
  });
});
