'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore, CLAIM_TTL_MS } = require('./oremap');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oremap-'));
  return path.join(dir, 'oremap-test.json');
}

test('createStore : addOres persiste sur disque, load relit', () => {
  const file = tmpFile();
  const store = createStore(file, { runId: 'r1', zone: { cx: 0, cz: 0, radius: 50 } });
  const added = store.addOres([{ name: 'diamond_ore', x: 1, y: -54, z: 2 }], 'Carto1');
  assert.strictEqual(added, 1);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(onDisk.runId, 'r1');
  assert.strictEqual(onDisk.zone.radius, 50);
  assert.strictEqual(onDisk.ores['1,-54,2'].type, 'diamond');
  assert.ok(onDisk.updatedAt > 0);
  assert.strictEqual(store.load().ores['1,-54,2'].foundBy, 'Carto1');
});

test('deux stores sur le MÊME fichier voient les écritures de l\'autre (multi-process simulé)', () => {
  const file = tmpFile();
  const a = createStore(file, { runId: 'r1' });
  const b = createStore(file, { runId: 'r1' });
  a.addOres([{ name: 'iron_ore', x: 1, y: 0, z: 0 }], 'A');
  b.addOres([{ name: 'iron_ore', x: 2, y: 0, z: 0 }], 'B');
  const m = a.load();
  assert.strictEqual(Object.keys(m.ores).length, 2);  // pas de lost update
});

test('claimNext via store : un seul des deux bots obtient l\'ore', () => {
  const file = tmpFile();
  const a = createStore(file, { runId: 'r1' });
  const b = createStore(file, { runId: 'r1' });
  a.addOres([{ name: 'diamond_ore', x: 5, y: 0, z: 0 }], 'C');
  const oreA = a.claimNext({ type: 'diamond', from: { x: 0, y: 0, z: 0 }, username: 'Res1' });
  const oreB = b.claimNext({ type: 'diamond', from: { x: 0, y: 0, z: 0 }, username: 'Res2' });
  assert.ok(oreA);
  assert.strictEqual(oreB, null);  // claim de Res1 visible et active pour Res2
});

test('markMined + heartbeat + counts via store', () => {
  const file = tmpFile();
  const s = createStore(file, { runId: 'r1' });
  s.addOres([
    { name: 'lapis_ore', x: 1, y: 0, z: 0 },
    { name: 'lapis_ore', x: 2, y: 0, z: 0 },
  ], 'C');
  s.markMined('1,0,0');
  s.heartbeat('Res1', { x: 0, y: 0, z: 0, role: 'resource', quota: { lapis: { have: 4, target: 64 } } });
  const c = s.counts();
  assert.deepStrictEqual(c.lapis, { new: 1, claimed: 0, mined: 1, gone: 0 });
  assert.strictEqual(s.load().bots.Res1.quota.lapis.have, 4);
});

test('lock stale (process mort) : volé après LOCK_STALE_MS, pas de deadlock', () => {
  const file = tmpFile();
  const s = createStore(file, { runId: 'r1' });
  // Simule un lock orphelin ANCIEN (mtime dans le passé)
  fs.mkdirSync(file + '.lock');
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(file + '.lock', past, past);
  const added = s.addOres([{ name: 'iron_ore', x: 1, y: 0, z: 0 }], 'C');  // doit voler le lock
  assert.strictEqual(added, 1);
  assert.ok(!fs.existsSync(file + '.lock'));  // lock relâché après écriture
});

test('fichier corrompu sur disque → load best-effort retourne une map vide (pas de crash)', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{corrompu');
  const s = createStore(file, { runId: 'r1' });
  assert.deepStrictEqual(s.load().ores, {});
  assert.strictEqual(s.addOres([{ name: 'iron_ore', x: 1, y: 0, z: 0 }], 'C'), 1);
});
