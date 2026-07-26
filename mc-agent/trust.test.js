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

// ── group_bots : c'est LUI qui autorise l'auto-accept du /tpa entre bots du meme groupe ─────────
// Il etait STRIPPE par loadPolicy alors que le backend l'ecrivait : avec `trusted` vide,
// isTrusted() renvoie false, donc l'auto-accept etait TOUJOURS refuse. Mesure world_mn5 :
// 0 /tpaccept dans le log serveur, 38 echecs de regroupement sur 47, un worker abandonne
// a 236 blocs du groupe.
test('loadPolicy : preserve group_bots (sans lui, aucun bot n_accepte le /tpa d_un coequipier)', () => {
  const p = path.join(os.tmpdir(), 'mc_policy_gb_' + process.pid + '.json');
  fs.writeFileSync(p, JSON.stringify({
    trusted: [], trade: null, kit_command: '',
    group_bots: ['MapBot1', 'NethBot1', 'NethBot2'],
  }));
  try {
    assert.deepStrictEqual(loadPolicy(p).group_bots, ['MapBot1', 'NethBot1', 'NethBot2']);
  } finally { fs.unlinkSync(p); }
});

test('loadPolicy : group_bots absent / pas de fichier → tableau vide (jamais undefined)', () => {
  assert.deepStrictEqual(loadPolicy(null).group_bots, []);
  const p = path.join(os.tmpdir(), 'mc_policy_gb2_' + process.pid + '.json');
  fs.writeFileSync(p, JSON.stringify({ trusted: [] }));
  try {
    assert.deepStrictEqual(loadPolicy(p).group_bots, []);
  } finally { fs.unlinkSync(p); }
});

test('loadPolicy : group_bots filtre les entrees non-string (fichier corrompu)', () => {
  const p = path.join(os.tmpdir(), 'mc_policy_gb3_' + process.pid + '.json');
  fs.writeFileSync(p, JSON.stringify({ group_bots: ['Ok', 42, null, { a: 1 }, 'Aussi'] }));
  try {
    assert.deepStrictEqual(loadPolicy(p).group_bots, ['Ok', 'Aussi']);
  } finally { fs.unlinkSync(p); }
});

// Le contrat complet de la condition d'auto-accept d'index.js, reproduit ici :
//   tpTrusted = isTrusted(who, policy.trusted) || policy.group_bots.includes(who)
test('la condition d_auto-accept passe pour un coequipier meme avec `trusted` VIDE', () => {
  const { isTrusted } = require('./trust');
  const p = path.join(os.tmpdir(), 'mc_policy_gb4_' + process.pid + '.json');
  fs.writeFileSync(p, JSON.stringify({ trusted: [], group_bots: ['NethBot1', 'NethBot2'] }));
  try {
    const policy = loadPolicy(p);
    const accept = (who) => isTrusted(who, policy.trusted) || (policy.group_bots || []).includes(who);
    assert.strictEqual(accept('NethBot2'), true);    // coequipier → accepte
    assert.strictEqual(accept('Etranger'), false);   // inconnu → refuse (le gating tient)
  } finally { fs.unlinkSync(p); }
});
