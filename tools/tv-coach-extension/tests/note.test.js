'use strict';

/**
 * tests/note.test.js — la note rapide au carnet d'idées.
 */
const test = require('node:test');
const assert = require('node:assert');

const note = require('../lib/note.js');

test('la note est nettoyée sans être dénaturée', () => {
  assert.strictEqual(note.normalize('  cassure du VWAP  '), 'cassure du VWAP');
  assert.strictEqual(note.normalize('deux\r\nlignes'), 'deux\nlignes');
  assert.strictEqual(note.normalize(null), '');
  assert.strictEqual(note.normalize(undefined), '');
  assert.strictEqual(note.normalize(42), '42');
});

test('au-delà de 500 caractères on COUPE, on ne refuse pas', () => {
  const long = 'x'.repeat(600);
  assert.strictEqual(note.normalize(long).length, 500);
  assert.strictEqual(note.MAX_LEN, 500);
  assert.strictEqual(note.build({ text: long }).text.length, 500);
});

test('le compteur dit ce qui reste', () => {
  assert.strictEqual(note.remaining(''), 500);
  assert.strictEqual(note.remaining('abc'), 497);
  assert.strictEqual(note.remaining('x'.repeat(900)), 0);
});

test('une note vide n’est pas une note', () => {
  assert.strictEqual(note.build({ text: '' }), null);
  assert.strictEqual(note.build({ text: '   \n  ' }), null);
  assert.strictEqual(note.build({}), null);
  assert.strictEqual(note.build(null), null);
});

test('la charge utile a la forme de POST /ideas/note', () => {
  const payload = note.build({ text: 'range serré', symbol: 'BTC-USD', lang: 'it' });
  assert.deepStrictEqual(payload, { text: 'range serré', lang: 'it', symbol: 'BTC-USD' });
});

test('sans titre connu, la clé symbol est ABSENTE (jamais un null typé str)', () => {
  const payload = note.build({ text: 'idée en l’air', symbol: null, lang: 'fr' });
  assert.deepStrictEqual(Object.keys(payload).sort(), ['lang', 'text']);
  assert.strictEqual(note.build({ text: 'x', symbol: '  ' }).symbol, undefined);
});

test('une langue inconnue retombe sur le français', () => {
  assert.strictEqual(note.build({ text: 'x', lang: 'de' }).lang, 'fr');
  assert.strictEqual(note.build({ text: 'x' }).lang, 'fr');
  assert.strictEqual(note.build({ text: 'x', lang: 'IT-ch' }).lang, 'it');
  assert.strictEqual(note.normalizeLang('EN'), 'en');
});

test('Ctrl/Cmd+Entrée envoie, Entrée seule non', () => {
  assert.strictEqual(note.isSendKey({ key: 'Enter', ctrlKey: true }), true);
  assert.strictEqual(note.isSendKey({ key: 'Enter', metaKey: true }), true);
  assert.strictEqual(note.isSendKey({ key: 'NumpadEnter', ctrlKey: true }), true);
  assert.strictEqual(note.isSendKey({ key: 'Enter' }), false);
  assert.strictEqual(note.isSendKey({ key: 'a', ctrlKey: true }), false);
  assert.strictEqual(note.isSendKey(null), false);
});
