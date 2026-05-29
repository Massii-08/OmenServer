'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('node:stream');
const { emit, onCommand } = require('../io');

test('emit écrit une ligne JSON sur stdout', () => {
  const lines = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { lines.push(s); return true; };
  try { emit({ type: 'status', state: 'ok' }); }
  finally { process.stdout.write = orig; }
  assert.strictEqual(lines.length, 1);
  assert.deepStrictEqual(JSON.parse(lines[0]), { type: 'status', state: 'ok' });
  assert.ok(lines[0].endsWith('\n'));
});

test('onCommand parse les lignes JSON et ignore le bruit', () => {
  const stream = new PassThrough();
  const got = [];
  onCommand((cmd) => got.push(cmd), stream);
  stream.write('{"type":"say","message":"hi"}\n');
  stream.write('pas du json\n');
  stream.write('{"type":"quit"}\n');
  return new Promise((resolve) => setImmediate(() => {
    assert.deepStrictEqual(got, [{ type: 'say', message: 'hi' }, { type: 'quit' }]);
    resolve();
  }));
});

test('onCommand rassemble une ligne JSON fragmentée sur plusieurs chunks', () => {
  const stream = new PassThrough();
  const got = [];
  onCommand((cmd) => got.push(cmd), stream);
  stream.write('{"type":"s');           // moitié 1
  stream.write('ay","message":"hi"}\n'); // moitié 2 + newline
  return new Promise((resolve) => setImmediate(() => {
    assert.deepStrictEqual(got, [{ type: 'say', message: 'hi' }]);
    resolve();
  }));
});
