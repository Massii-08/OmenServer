'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { classifyAuthPrompt, genPassword } = require('./auth');

test('classifyAuthPrompt détecte register / login / null', () => {
  assert.strictEqual(classifyAuthPrompt('Please register with /register <password>'), 'register');
  assert.strictEqual(classifyAuthPrompt('Veuillez vous enregistrer: /register <pass> <pass>'), 'register');
  assert.strictEqual(classifyAuthPrompt('Please login with /login <password>'), 'login');
  assert.strictEqual(classifyAuthPrompt('Connecte-toi avec /login <pass>'), 'login');
  assert.strictEqual(classifyAuthPrompt('Welcome to the server!'), null);
});

test('genPassword produit un pw fort et différent à chaque appel', () => {
  const a = genPassword();
  const b = genPassword();
  assert.ok(a.length >= 12);
  assert.notStrictEqual(a, b);
  assert.match(a, /[A-Za-z]/);
  assert.match(a, /[0-9]/);
});
