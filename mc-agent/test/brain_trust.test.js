'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildSystemPrompt, think, SYSTEM_PROMPT } = require('../brain');

test('buildSystemPrompt(null) reste EXACTEMENT SYSTEM_PROMPT (sans docs)', () => {
  assert.strictEqual(buildSystemPrompt(null), SYSTEM_PROMPT);
  assert.strictEqual(buildSystemPrompt(null, '', ''), SYSTEM_PROMPT);
});

test('buildSystemPrompt injecte trustDocs quand fourni', () => {
  const td = 'Joueurs de confiance : Massii_08.';
  assert.match(buildSystemPrompt(null, '', td), /Massii_08/);
  assert.match(buildSystemPrompt({ persona: 'X' }, '', td), /Massii_08/);
});

test('think transmet trustDocs au system et le sender au message', async () => {
  let captured;
  const client = { messages: { create: async (a) => { captured = a; return { content: [{ type: 'text', text: '{"reply":"ok"}' }] }; } } };
  await think(client, { state: {}, message: 'va chercher du bois', model: 'm', limiter: null, trustDocs: 'MARK_TRUST', sender: 'Intrus' });
  assert.match(captured.system, /MARK_TRUST/);
  assert.match(captured.messages[0].content, /De: Intrus/);
  assert.match(captured.messages[0].content, /va chercher du bois/);
});
