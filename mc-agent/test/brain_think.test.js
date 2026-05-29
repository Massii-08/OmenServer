'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { think, RateLimiter, SYSTEM_PROMPT } = require('../brain');

function fakeClient(text) {
  return { messages: { create: async () => ({ content: [{ type: 'text', text }] }) } };
}

test('think appelle le client (system+model+message) et retourne la décision parsée', async () => {
  let captured;
  const client = { messages: { create: async (a) => {
    captured = a;
    return { content: [{ type: 'text', text: '{"reply":"j arrive","action":"follow","args":{"player":"Massii"}}' }] };
  } } };
  const d = await think(client, { state: { username: 'Bot' }, message: 'suis moi', model: 'm', limiter: null });
  assert.strictEqual(d.reply, 'j arrive');
  assert.strictEqual(d.action, 'follow');
  // verrouille le contrat d'appel : system prompt, modèle, et message transmis
  assert.strictEqual(captured.system, SYSTEM_PROMPT);
  assert.strictEqual(captured.model, 'm');
  assert.ok(captured.messages[0].content.includes('suis moi'));
});

test('think retourne null si le rate-limiter bloque', async () => {
  let now = 0;
  const limiter = new RateLimiter(0, 1000, () => now); // 0 appel autorisé
  const client = fakeClient('{"reply":"x"}');
  const d = await think(client, { state: {}, message: 'hi', model: 'm', limiter });
  assert.strictEqual(d, null);
});

test('SYSTEM_PROMPT exige une réponse JSON et l\'honnêteté', () => {
  assert.match(SYSTEM_PROMPT, /JSON/);
  assert.match(SYSTEM_PROMPT, /honn[êe]te/i);   // contrat d'honnêteté pinné (pas le fallback "bot")
  assert.match(SYSTEM_PROMPT, /confirmer/i);
});
