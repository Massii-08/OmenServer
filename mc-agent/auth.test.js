'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { classifyAuthPrompt, genPassword, resolveAuthChat } = require('./auth');

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

test('resolveAuthChat — login avec login-command serveur : chatte la commande, action login', () => {
  const res = resolveAuthChat({ kind: 'login', loginCommand: '/login monMdp', pw: 'irrelevant' });
  assert.deepStrictEqual(res, { chat: '/login monMdp', action: 'login' });
});

test('resolveAuthChat — login avec pw self-persist (pas de login-command) : /login <pw>', () => {
  const res = resolveAuthChat({ kind: 'login', loginCommand: null, pw: 'Aabc1234567890def7' });
  assert.deepStrictEqual(res, { chat: '/login Aabc1234567890def7', action: 'login' });
});

test('resolveAuthChat — login sans pw ni login-command : null (rien à chatter)', () => {
  assert.strictEqual(resolveAuthChat({ kind: 'login', loginCommand: null, pw: null }), null);
});

test('resolveAuthChat — register avec pw : /register <pw> <pw> (login-command ignorée)', () => {
  const res = resolveAuthChat({ kind: 'register', loginCommand: '/login x', pw: 'Pw123456789012ab7' });
  assert.deepStrictEqual(res, { chat: '/register Pw123456789012ab7 Pw123456789012ab7', action: 'register' });
});

test('resolveAuthChat — register sans pw : null (l’appelant doit générer le pw d’abord)', () => {
  assert.strictEqual(resolveAuthChat({ kind: 'register', loginCommand: null, pw: null }), null);
});

test('resolveAuthChat — kind null : null', () => {
  assert.strictEqual(resolveAuthChat({ kind: null, loginCommand: '/login x', pw: 'p' }), null);
});
