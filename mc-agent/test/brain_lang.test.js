'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildLangDocs, buildSystemPrompt, SYSTEM_PROMPT, think } = require('../brain');

test('buildLangDocs: fr/en/it sinon vide', () => {
  assert.match(buildLangDocs('fr'), /francais/i);
  assert.match(buildLangDocs('en'), /anglais/i);
  assert.match(buildLangDocs('it'), /italien/i);
  assert.strictEqual(buildLangDocs(''), '');
  assert.strictEqual(buildLangDocs('xx'), '');
});

test('buildSystemPrompt(null) reste === SYSTEM_PROMPT (invariant pinné)', () => {
  assert.strictEqual(buildSystemPrompt(null), SYSTEM_PROMPT);
});

test('buildSystemPrompt(profil,…,langDocs) inclut la langue', () => {
  const profile = { id: 'x', persona: 'P', tells: ['t'] };
  const out = buildSystemPrompt(profile, '', '', buildLangDocs('it'));
  assert.match(out, /italien/i);
});

test('think: insère l\'historique avant le message courant', async () => {
  let captured = null;
  const client = { messages: { create: async (req) => { captured = req; return { content: [{ text: '{"reply":"ok","action":null,"args":{}}' }] }; } } };
  await think(client, {
    state: {}, message: 'et après ?', model: 'm', limiter: null,
    history: [{ role: 'user', content: 'salut' }, { role: 'assistant', content: 'hello' }], lang: 'fr',
  });
  assert.strictEqual(captured.messages.length, 3);
  assert.strictEqual(captured.messages[0].content, 'salut');
  assert.match(captured.messages[2].content, /et après \?/);
  assert.match(captured.system, /francais/i);
});
