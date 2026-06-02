'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { loadWorld, saveWorld, setObjective, clearObjective } = require('./worldModel');

function tmpFile() {
  return path.join(os.tmpdir(), `mc-world-${process.pid}-${Math.floor(process.hrtime()[1])}.json`);
}

test('loadWorld returns a default shape when file is absent', () => {
  const w = loadWorld(tmpFile());
  assert.deepStrictEqual(w, { home: null, chests: [], waypoints: [], objective: null });
});

test('saveWorld then loadWorld round-trips', () => {
  const f = tmpFile();
  const w = loadWorld(f);
  setObjective(w, { type: 'stone_pickaxe', status: 'in_progress' });
  saveWorld(f, w);
  const w2 = loadWorld(f);
  assert.strictEqual(w2.objective.type, 'stone_pickaxe');
  assert.strictEqual(w2.objective.status, 'in_progress');
  fs.unlinkSync(f);
});

test('clearObjective nulls the objective', () => {
  const w = loadWorld(tmpFile());
  setObjective(w, { type: 'stone_pickaxe', status: 'in_progress' });
  clearObjective(w);
  assert.strictEqual(w.objective, null);
});

test('loadWorld on corrupt JSON returns default shape (no throw)', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{ not json');
  const w = loadWorld(f);
  assert.deepStrictEqual(w, { home: null, chests: [], waypoints: [], objective: null });
  fs.unlinkSync(f);
});
