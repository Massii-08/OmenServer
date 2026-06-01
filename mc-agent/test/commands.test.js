'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadCommands, commandName, isAllowed, buildCommandDocs } = require('../commands');

const WL = [
  { cmd: '/msg', syntax: '/msg <j> <m>', desc: 'mp' },
  { cmd: '/home', syntax: '/home [nom]', desc: 'maison' },
];

test('isAllowed: chat normal (sans /) toujours autorisé', () => {
  assert.strictEqual(isAllowed('salut ça va', WL), true);
  assert.strictEqual(isAllowed('', WL), true);
});

test('isAllowed: commande whitelistée autorisée (insensible casse/espaces)', () => {
  assert.strictEqual(isAllowed('/home', WL), true);
  assert.strictEqual(isAllowed('/HOME nom', WL), true);
  assert.strictEqual(isAllowed('  /msg Bob hello', WL), true);
});

test('isAllowed: commande absente bloquée', () => {
  assert.strictEqual(isAllowed('/tpa Bob', WL), false);
  assert.strictEqual(isAllowed('/op Bob', WL), false);
});

test('isAllowed: whitelist vide bloque toute commande mais laisse le chat', () => {
  assert.strictEqual(isAllowed('/home', []), false);
  assert.strictEqual(isAllowed('bonjour', []), true);
});

test('commandName extrait le nom normalisé', () => {
  assert.strictEqual(commandName('/TPA Bob'), 'tpa');
  assert.strictEqual(commandName('pas une commande'), '');
});

test('buildCommandDocs liste cmd + syntaxe + mentionne le champ command, vide si []', () => {
  const doc = buildCommandDocs(WL);
  assert.match(doc, /\/msg <j> <m>/);
  assert.match(doc, /\/home \[nom\]/);
  assert.match(doc, /command/);
  assert.strictEqual(buildCommandDocs([]), '');
});

test('loadCommands: fichier absent ou chemin vide → []', () => {
  assert.deepStrictEqual(loadCommands('/no/such/file.json'), []);
  assert.deepStrictEqual(loadCommands(''), []);
});

test('loadCommands: lit un fichier JSON valide', () => {
  const f = path.join(os.tmpdir(), 'mca-cmds-test-' + process.pid + '.json');
  fs.writeFileSync(f, JSON.stringify(WL));
  try {
    const got = loadCommands(f);
    assert.strictEqual(got.length, 2);
    assert.strictEqual(got[0].cmd, '/msg');
  } finally { fs.unlinkSync(f); }
});
