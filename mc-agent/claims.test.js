'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createClaims, pruneExpired } = require('./claims');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-test-'));
  return path.join(dir, 'claims-g1.json');
}

test('tryClaim : pose une claim, refuse celle d\'un autre, accepte la sienne (idempotent)', () => {
  const file = tmpFile();
  let t = 1000;
  const clock = () => t;
  const a = createClaims(file, { username: 'BotA', now: clock });
  const b = createClaims(file, { username: 'BotB', now: clock });
  assert.strictEqual(a.tryClaim('1,2,3'), true);
  assert.strictEqual(b.tryClaim('1,2,3'), false);   // claim fraîche d'un autre
  assert.strictEqual(a.tryClaim('1,2,3'), true);    // la sienne → ok (reprise idempotente)
  assert.strictEqual(b.tryClaim('4,5,6'), true);    // autre ore → ok
});

test('TTL : claim expirée → reprenable par un autre bot', () => {
  const file = tmpFile();
  let t = 1000;
  const clock = () => t;
  const a = createClaims(file, { username: 'BotA', now: clock, ttl: 500 });
  const b = createClaims(file, { username: 'BotB', now: clock, ttl: 500 });
  assert.strictEqual(a.tryClaim('1,2,3'), true);
  t += 499;
  assert.strictEqual(b.tryClaim('1,2,3'), false);   // pas encore expirée
  t += 2;
  assert.strictEqual(b.tryClaim('1,2,3'), true);    // expirée → volée proprement
});

test('refresh : prolonge la claim ; ne touche pas celle des autres', () => {
  const file = tmpFile();
  let t = 1000;
  const clock = () => t;
  const a = createClaims(file, { username: 'BotA', now: clock, ttl: 500 });
  const b = createClaims(file, { username: 'BotB', now: clock, ttl: 500 });
  a.tryClaim('1,2,3');
  t += 400;
  assert.strictEqual(a.refresh('1,2,3'), true);     // re-tamponnée à t=1400
  t += 400;                                          // t=1800 < 1400+500
  assert.strictEqual(b.tryClaim('1,2,3'), false);
  assert.strictEqual(b.refresh('1,2,3'), false);    // pas la sienne
});

test('release : libère immédiatement (et seulement la sienne)', () => {
  const file = tmpFile();
  const a = createClaims(file, { username: 'BotA' });
  const b = createClaims(file, { username: 'BotB' });
  a.tryClaim('1,2,3');
  assert.strictEqual(b.release('1,2,3'), false);    // pas la sienne
  assert.strictEqual(a.release('1,2,3'), true);
  assert.strictEqual(b.tryClaim('1,2,3'), true);    // libre
});

test('fichier corrompu/absent → best-effort, pas de crash', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{pas du json');
  const a = createClaims(file, { username: 'BotA' });
  assert.strictEqual(a.tryClaim('1,2,3'), true);    // reparti d'une map vide
  assert.strictEqual(a.refresh('inconnu'), false);
  assert.strictEqual(a.release('inconnu'), false);
});

test('pruneExpired : purge uniquement les expirées', () => {
  const m = { claims: { a: { by: 'X', at: 0 }, b: { by: 'Y', at: 900 } } };
  pruneExpired(m, 1000, 500);
  assert.deepStrictEqual(Object.keys(m.claims), ['b']);
});

test('persistance inter-clients : le fichier est la source partagée', () => {
  const file = tmpFile();
  const a = createClaims(file, { username: 'BotA' });
  a.tryClaim('9,9,9');
  // nouveau client (autre process simulé) voit la claim
  const c = createClaims(file, { username: 'BotC' });
  assert.strictEqual(c.tryClaim('9,9,9'), false);
});
