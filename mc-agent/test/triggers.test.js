'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { mentionsBot, decideReaction } = require('../triggers');

test('mentionsBot détecte le pseudo en mot entier, insensible à la casse', () => {
  assert.ok(mentionsBot('TrainBot tu viens ?', 'TrainBot'));
  assert.ok(mentionsBot('hey trainbot', 'TrainBot'));
  assert.ok(mentionsBot('regarde TrainBot!', 'TrainBot'));
  assert.ok(!mentionsBot('TrainBotXYZ farme', 'TrainBot')); // pseudo différent → pas de match
  assert.ok(!mentionsBot('quelqu un parle a cote', 'TrainBot'));
});

test('decideReaction: un whisper => répondre en privé', () => {
  const r = decideReaction({ username: 'Massii', message: 'salut', isWhisper: true, botUsername: 'TrainBot' });
  assert.deepStrictEqual(r, { private: true, to: 'Massii', message: 'salut' });
});

test('decideReaction: chat public mentionnant le bot => répondre en public', () => {
  const r = decideReaction({ username: 'Massii', message: 'TrainBot viens', isWhisper: false, botUsername: 'TrainBot' });
  assert.deepStrictEqual(r, { private: false, to: 'Massii', message: 'TrainBot viens' });
});

test('decideReaction: chat général non adressé => null (ignoré, zéro LLM)', () => {
  assert.strictEqual(
    decideReaction({ username: 'Alice', message: 'salut Bob ca va ?', isWhisper: false, botUsername: 'TrainBot' }),
    null,
  );
});

test('decideReaction: ignore ses propres messages', () => {
  assert.strictEqual(
    decideReaction({ username: 'TrainBot', message: 'TrainBot coucou', isWhisper: false, botUsername: 'TrainBot' }),
    null,
  );
});

test('decideReaction: publicMode "never" ignore même une mention publique', () => {
  assert.strictEqual(
    decideReaction({ username: 'Massii', message: 'TrainBot viens', isWhisper: false, botUsername: 'TrainBot', publicMode: 'never' }),
    null,
  );
});

test('decideReaction: publicMode "never" répond quand même aux whispers', () => {
  const r = decideReaction({ username: 'Massii', message: 'hey', isWhisper: true, botUsername: 'TrainBot', publicMode: 'never' });
  assert.ok(r && r.private === true);
});

test('decideReaction: publicMode "always" répond à tout le public', () => {
  const r = decideReaction({ username: 'Alice', message: 'blabla', isWhisper: false, botUsername: 'TrainBot', publicMode: 'always' });
  assert.ok(r && r.private === false);
});
