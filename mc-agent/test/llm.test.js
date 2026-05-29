'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createLLMClient, geminiClient, groqClient } = require('../llm');

// fetch factice : capture la requête et renvoie une réponse contrôlée.
function fakeFetch(captured, responseObj, ok = true, status = 200) {
  return async (url, opts) => {
    captured.url = url;
    captured.opts = opts;
    captured.body = JSON.parse(opts.body);
    return { ok, status, json: async () => responseObj };
  };
}

test('geminiClient mappe system+messages vers le format Gemini et parse la réponse', async () => {
  const captured = {};
  const resp = { candidates: [{ content: { parts: [{ text: '{"reply":"salut"}' }] } }] };
  const client = geminiClient({ apiKey: 'AIzaXXX', fetchImpl: fakeFetch(captured, resp) });
  const out = await client.messages.create({
    model: 'gemini-2.0-flash', max_tokens: 200, system: 'SYS',
    messages: [{ role: 'user', content: 'coucou' }],
  });
  assert.match(captured.url, /models\/gemini-2\.0-flash:generateContent/);
  assert.match(captured.url, /key=AIzaXXX/);
  assert.strictEqual(captured.body.systemInstruction.parts[0].text, 'SYS');
  assert.strictEqual(captured.body.contents[0].parts[0].text, 'coucou');
  assert.strictEqual(captured.body.generationConfig.maxOutputTokens, 200);
  // réponse exposée au format "Anthropic-like" attendu par think()
  assert.strictEqual(out.content[0].text, '{"reply":"salut"}');
});

test('geminiClient omet systemInstruction si system est vide', async () => {
  const captured = {};
  const resp = { candidates: [{ content: { parts: [{ text: 'ok' }] } }] };
  const client = geminiClient({ apiKey: 'k', fetchImpl: fakeFetch(captured, resp) });
  await client.messages.create({ model: 'm', max_tokens: 10, system: '', messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(captured.body.systemInstruction, undefined);
});

test('geminiClient lève une erreur portant le status HTTP sur réponse non-ok (ex: 429)', async () => {
  const captured = {};
  const client = geminiClient({ apiKey: 'k', fetchImpl: fakeFetch(captured, { error: 'quota' }, false, 429) });
  await assert.rejects(
    client.messages.create({ model: 'm', max_tokens: 10, system: '', messages: [{ role: 'user', content: 'hi' }] }),
    (e) => e.status === 429,
  );
});

test('geminiClient retourne un texte vide si la réponse n a pas de candidats', async () => {
  const captured = {};
  const client = geminiClient({ apiKey: 'k', fetchImpl: fakeFetch(captured, {}) });
  const out = await client.messages.create({ model: 'm', max_tokens: 10, system: 'S', messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(out.content[0].text, '');
});

test('createLLMClient(gemini) retourne un client à interface .messages.create', () => {
  const c = createLLMClient('gemini', { apiKey: 'k' });
  assert.strictEqual(typeof c.messages.create, 'function');
});

test('groqClient mappe system+messages vers le format OpenAI et parse la réponse', async () => {
  const captured = {};
  const resp = { choices: [{ message: { content: '{"reply":"ok","action":"collectWood","args":{"count":16}}' } }] };
  const client = groqClient({ apiKey: 'gsk_x', fetchImpl: fakeFetch(captured, resp) });
  const out = await client.messages.create({
    model: 'llama-3.3-70b-versatile', max_tokens: 200, system: 'SYS',
    messages: [{ role: 'user', content: 'coucou' }],
  });
  assert.match(captured.url, /api\.groq\.com\/openai\/v1\/chat\/completions/);
  assert.strictEqual(captured.opts.headers.Authorization, 'Bearer gsk_x');
  assert.strictEqual(captured.body.model, 'llama-3.3-70b-versatile');
  assert.strictEqual(captured.body.messages[0].role, 'system');
  assert.strictEqual(captured.body.messages[0].content, 'SYS');
  assert.strictEqual(captured.body.messages[1].content, 'coucou');
  assert.strictEqual(out.content[0].text, '{"reply":"ok","action":"collectWood","args":{"count":16}}');
});

test('groqClient lève une erreur portant le status sur réponse non-ok', async () => {
  const captured = {};
  const client = groqClient({ apiKey: 'k', fetchImpl: fakeFetch(captured, { error: 'x' }, false, 429) });
  await assert.rejects(
    client.messages.create({ model: 'm', max_tokens: 10, system: '', messages: [{ role: 'user', content: 'hi' }] }),
    (e) => e.status === 429,
  );
});

test('groqClient omet le message system si vide', async () => {
  const captured = {};
  const resp = { choices: [{ message: { content: 'ok' } }] };
  const client = groqClient({ apiKey: 'k', fetchImpl: fakeFetch(captured, resp) });
  await client.messages.create({ model: 'm', max_tokens: 10, system: '', messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(captured.body.messages.length, 1);
  assert.strictEqual(captured.body.messages[0].role, 'user');
});

test('createLLMClient(groq) retourne un client à interface .messages.create', () => {
  const c = createLLMClient('groq', { apiKey: 'k' });
  assert.strictEqual(typeof c.messages.create, 'function');
});
