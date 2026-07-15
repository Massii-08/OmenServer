'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadPolicy } = require('./trust');

test('loadPolicy : préserve kit_command du fichier policy (sinon le bot ne lance jamais /kit)', () => {
  const p = path.join(os.tmpdir(), 'mc_policy_' + process.pid + '.json');
  fs.writeFileSync(p, JSON.stringify({ trusted: [], trade: null, kit_command: '/kit Notch' }));
  try {
    assert.strictEqual(loadPolicy(p).kit_command, '/kit Notch');
  } finally { fs.unlinkSync(p); }
});

test('loadPolicy : kit_command absent / pas de fichier → chaîne vide (jamais undefined)', () => {
  assert.strictEqual(loadPolicy(null).kit_command, '');
  const p = path.join(os.tmpdir(), 'mc_policy2_' + process.pid + '.json');
  fs.writeFileSync(p, JSON.stringify({ trusted: [] }));
  try {
    assert.strictEqual(loadPolicy(p).kit_command, '');
  } finally { fs.unlinkSync(p); }
});
