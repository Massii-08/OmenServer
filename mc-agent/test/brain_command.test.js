'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseDecision, buildSystemPrompt, SYSTEM_PROMPT } = require('../brain');

test('parseDecision extrait le champ command (string) sinon null', () => {
  assert.strictEqual(parseDecision('{"reply":"ok","command":"/home"}').command, '/home');
  assert.strictEqual(parseDecision('{"reply":"ok"}').command, null);
  assert.strictEqual(parseDecision('{"reply":"ok","command":123}').command, null);
});

test('buildSystemPrompt(null) sans commandDocs reste EXACTEMENT SYSTEM_PROMPT', () => {
  assert.strictEqual(buildSystemPrompt(null), SYSTEM_PROMPT);
  assert.strictEqual(buildSystemPrompt(null, ''), SYSTEM_PROMPT);
});

test('buildSystemPrompt injecte le bloc commandes quand fourni (avec ou sans profil)', () => {
  const docs = 'Commandes serveur disponibles : /home [nom].';
  assert.match(buildSystemPrompt(null, docs), /\/home \[nom\]/);
  assert.match(buildSystemPrompt({ persona: 'X' }, docs), /\/home \[nom\]/);
});
