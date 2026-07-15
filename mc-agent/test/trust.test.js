'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadPolicy, isTrusted, parseTpRequest, parseTradeRequest, gateDecision, buildTrustDocs } = require('../trust');

const TRUSTED = ['Massii_08', 'Pote2'];

test('isTrusted: match insensible à la casse + trim, vide → false', () => {
  assert.strictEqual(isTrusted('massii_08', TRUSTED), true);
  assert.strictEqual(isTrusted('  Pote2 ', TRUSTED), true);
  assert.strictEqual(isTrusted('Intrus', TRUSTED), false);
  assert.strictEqual(isTrusted('Massii_08', []), false);
  assert.strictEqual(isTrusted('', TRUSTED), false);
});

test('parseTpRequest: formats Essentials EN → demandeur, sinon null', () => {
  assert.strictEqual(parseTpRequest('Bob has requested to teleport to you.'), 'Bob');
  assert.strictEqual(parseTpRequest('Bob has requested that you teleport to them.'), 'Bob');
  assert.strictEqual(parseTpRequest('<Bob> salut tout le monde'), null);
  assert.strictEqual(parseTpRequest('random server message'), null);
});

test('parseTpRequest: format Essentials FR', () => {
  assert.strictEqual(parseTpRequest('Bob vous a demandé de se téléporter à vous.'), 'Bob');
});

test('parseTradeRequest: pattern configuré → demandeur ; pattern invalide → null', () => {
  const cfg = { acceptCmd: '/trade accept', requestPattern: '^(\\w+) veut échanger' };
  assert.strictEqual(parseTradeRequest('Bob veut échanger avec toi', cfg), 'Bob');
  assert.strictEqual(parseTradeRequest('rien', cfg), null);
  assert.strictEqual(parseTradeRequest('x', { acceptCmd: '/t', requestPattern: '(' }), null);
  assert.strictEqual(parseTradeRequest('x', null), null);
});

test('gateDecision: liste vide → passe tout (gating off)', () => {
  const d = { reply: 'ok', action: 'mineBlock', args: {}, command: null };
  assert.strictEqual(gateDecision(d, 'NImporteQui', []), d);
});

test('gateDecision: trusted → passe ; non-trusted avec ordre → action+command retirées, reply gardé', () => {
  const d = { reply: 'jarrive', action: 'follow', args: { player: 'x' }, command: '/home' };
  assert.strictEqual(gateDecision(d, 'Massii_08', TRUSTED), d);
  const g = gateDecision(d, 'Intrus', TRUSTED);
  assert.notStrictEqual(g, d);
  assert.strictEqual(g.action, null);
  assert.strictEqual(g.command, null);
  assert.strictEqual(g.reply, 'jarrive');
});

test('gateDecision: non-trusted mais juste une question (pas d ordre) → passe (même ref)', () => {
  const d = { reply: 'oui je suis un bot', action: null, args: {}, command: null };
  assert.strictEqual(gateDecision(d, 'Intrus', TRUSTED), d);
});

test('buildTrustDocs: liste → mentionne les noms ; vide → ""', () => {
  const doc = buildTrustDocs(TRUSTED);
  assert.match(doc, /Massii_08/);
  assert.match(doc, /Pote2/);
  assert.match(doc, /ORDRES/);
  assert.strictEqual(buildTrustDocs([]), '');
});

test('loadPolicy: absent → {trusted:[],trade:null} ; fichier valide → parsé', () => {
  assert.deepStrictEqual(loadPolicy(''), { trusted: [], trade: null, kit_command: '' });
  assert.deepStrictEqual(loadPolicy('/no/such.json'), { trusted: [], trade: null, kit_command: '' });
  const f = path.join(os.tmpdir(), 'mca-policy-' + process.pid + '.json');
  fs.writeFileSync(f, JSON.stringify({ trusted: ['A'], trade: { acceptCmd: '/t accept', requestPattern: 'x' } }));
  try {
    const p = loadPolicy(f);
    assert.deepStrictEqual(p.trusted, ['A']);
    assert.strictEqual(p.trade.acceptCmd, '/t accept');
  } finally { fs.unlinkSync(f); }
});
