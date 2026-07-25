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

// ─── Présence partagée (TP-au-mappeur, Massii 15/07) : chaque bot bat sa position (+ rôle) dans
// un fichier partagé du groupe → un bot ressource peut choisir un mappeur LOIN comme cible de /tpa.

const { createPresence } = require('./claims');

test('presence : beat + list — chaque bot voit les positions fraîches des autres', () => {
  const file = path.join(os.tmpdir(), `pres-${Date.now()}-1.json`);
  let t = 1000000;
  const clock = () => t;
  const a = createPresence(file, { username: 'ResBot1', now: clock });
  const b = createPresence(file, { username: 'MapBot1', now: clock });
  a.beat(10, 20, 'worker');
  b.beat(500, -300, 'mapper');
  const seen = a.list();
  assert.strictEqual(seen.length, 2);
  const map = seen.find((p) => p.name === 'MapBot1');
  assert.deepStrictEqual({ x: map.x, z: map.z, role: map.role }, { x: 500, z: -300, role: 'mapper' });
});

test('presence : entrée périmée (TTL 3 min) purgée de list ; re-beat la ravive', () => {
  const file = path.join(os.tmpdir(), `pres-${Date.now()}-2.json`);
  let t = 1000000;
  const clock = () => t;
  const a = createPresence(file, { username: 'ResBot1', now: clock });
  const b = createPresence(file, { username: 'MapBot1', now: clock });
  b.beat(500, -300, 'mapper');
  t += 181000;                                   // 3 min + 1 s
  a.beat(0, 0, 'worker');
  assert.deepStrictEqual(a.list().map((p) => p.name), ['ResBot1']);
  b.beat(600, -300, 'mapper');
  assert.strictEqual(a.list().length, 2);
});

test('presence : beat écrase la position précédente du même bot (pas d\'accumulation)', () => {
  const file = path.join(os.tmpdir(), `pres-${Date.now()}-3.json`);
  const a = createPresence(file, { username: 'ResBot1', now: () => 5000 });
  a.beat(1, 1, 'worker');
  a.beat(2, 2, 'worker');
  const seen = a.list();
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].x, 2);
});

// ─── Statut d'équipe dans le heartbeat (entraide, demande Massii 25/07) ───────
test('presence : beat publie le statut d\'équipe, list() le restitue', () => {
  const file = path.join(os.tmpdir(), `mca-presence-status-${process.pid}.json`);
  try { fs.unlinkSync(file); } catch (e) {}
  let t = 1000;
  const clock = () => t;
  const a = createPresence(file, { username: 'NethBot2', now: clock });
  a.beat(10, 20, 'worker', { armor: 3, ingots: 6, need: 8 });
  const seen = a.list().find((p) => p.name === 'NethBot2');
  assert.strictEqual(seen.armor, 3);
  assert.strictEqual(seen.ingots, 6);
  assert.strictEqual(seen.need, 8);
  assert.strictEqual(seen.role, 'worker');
  try { fs.unlinkSync(file); } catch (e) {}
});

test('presence : beat SANS statut garde l\'ancienne forme (rétro-compat)', () => {
  const file = path.join(os.tmpdir(), `mca-presence-nostatus-${process.pid}.json`);
  try { fs.unlinkSync(file); } catch (e) {}
  const a = createPresence(file, { username: 'MapBot1', now: () => 1000 });
  a.beat(1, 2, 'mapper');
  const seen = a.list().find((p) => p.name === 'MapBot1');
  assert.strictEqual(seen.armor, undefined);
  assert.strictEqual(seen.x, 1);
  try { fs.unlinkSync(file); } catch (e) {}
});
