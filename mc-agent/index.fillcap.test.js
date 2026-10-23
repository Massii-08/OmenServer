'use strict';
// Câblage du plafond de remblai et de no_pick_stuck (23/10, NethBot1 session 408). La logique est PURE
// (fillCap.js, noPick.js, skills/craft.js) ; ici on fige le câblage dans index.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const fnSrc = (name) => {
  const m = SRC.match(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'));
  assert.ok(m, `function ${name} introuvable au niveau module`);
  return m[0];
};

test('état du plafond au NIVEAU MODULE (piège #56)', () => {
  for (const v of ['_fillCapAt', '_fillCapBusy', '_fillCapTimer', '_lastPickRebuildWhy', '_noPickStuckAt']) {
    assert.match(SRC, new RegExp(`^let ${v} = `, 'm'), v);
  }
});

test('installFillCap : branché sur playerCollect (le bot seulement), appelé dans onSpawn', () => {
  const f = fnSrc('installFillCap');
  assert.match(f, /bot\.on\('playerCollect'/);
  assert.match(f, /collector\.id !== bot\.entity\.id/);
  assert.match(fnSrc('onSpawn'), /installFillCap\(\)/);
});

test('capFillStacks : throttlé, jamais pendant un craft / une fenêtre / un coup de pioche, émet fill_capped', () => {
  const f = fnSrc('capFillStacks');
  assert.match(f, /fillCapDue\(Date\.now\(\), _fillCapAt\)/);
  assert.match(f, /_craftDepth > 0/);
  assert.match(f, /bot\.currentWindow/);
  assert.match(f, /bot\.targetDigBlock/);
  assert.match(f, /fillOverflow\(/);
  assert.match(f, /type: 'fill_capped'/);
});

test('descente : pioche irremplaçable → no_pick_stuck (event + raison), plus de boucle no_pickaxe', () => {
  const f = fnSrc('runGoalSkill');
  const i = f.indexOf("rebuildPickHere('descend')");
  assert.ok(i > 0);
  const tail = f.slice(i, i + 1200);
  assert.match(tail, /type: 'no_pick_stuck'/);
  assert.match(tail, /reason: 'no_pick_stuck'/);
  assert.match(fnSrc('rebuildPickHere'), /_lastPickRebuildWhy = /);
});
