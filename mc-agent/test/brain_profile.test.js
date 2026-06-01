'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildSystemPrompt, think, SYSTEM_PROMPT } = require('../brain');

test('buildSystemPrompt(null) retourne le prompt de base (JSON + actions)', () => {
  const p = buildSystemPrompt(null);
  assert.match(p, /JSON/);
  assert.match(p, /follow|goto/);
});

test('buildSystemPrompt injecte la persona du profil', () => {
  const profile = { id: 'expert', persona: 'TU_ES_UN_JOUEUR_CREDIBLE_XYZ' };
  assert.match(buildSystemPrompt(profile), /TU_ES_UN_JOUEUR_CREDIBLE_XYZ/);
});

test('buildSystemPrompt liste les nouveaux skills (mineBlock/attackNearest/fleeFrom)', () => {
  const p = buildSystemPrompt(null);
  assert.match(p, /mineBlock/);
  assert.match(p, /attackNearest/);
  assert.match(p, /fleeFrom/);
});

test('think transmet le system prompt enrichi par le profil au client', async () => {
  let capturedSystem = null;
  const client = { messages: { create: async (opts) => { capturedSystem = opts.system; return { content: [{ type: 'text', text: '{"reply":"ok"}' }] }; } } };
  const profile = { id: 'expert', persona: 'PERSONA_MARKER_42' };
  await think(client, { state: {}, message: 'hi', model: 'm', limiter: null, profile });
  assert.match(capturedSystem, /PERSONA_MARKER_42/);
});
