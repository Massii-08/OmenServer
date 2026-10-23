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

// dig_failed ×8 de la descente (23/10, session 408) : câblage escalier ↔ ramassage opportuniste.
test('descente : _stairDepth au NIVEAU MODULE, incrémenté par le descendDiagonal gardé ET le TP /home work', () => {
  assert.match(SRC, /^let _stairDepth = 0;/m);
  const f = fnSrc('descendDiagonal');
  assert.match(f, /_stairDepth\+\+/);
  assert.match(f, /finally \{ _stairDepth = Math\.max\(0, _stairDepth - 1\); \}/);
  const g = fnSrc('runGoalSkill');
  const i = g.indexOf("type: 'descend_via_home_work'");
  assert.ok(i > 0);
  assert.match(g.slice(i, i + 600), /_stairDepth\+\+[\s\S]*goHome\(bot, HOME_WORK\)[\s\S]*_stairDepth - 1/);
});

test('ramassage opportuniste : scope `stair` pendant une descente, jamais de dig par-dessus celui d\'un autre', () => {
  assert.match(SRC, /stair: _stairDepth > 0,/);
  const i = SRC.indexOf('oregrab.mayStartDig(bot.targetDigBlock)');
  const j = SRC.indexOf('await withTimeout(bot.dig(blk)');
  assert.ok(i > 0 && j > i && j - i < 300, 'garde juste avant le dig du ramassage');
});

test('goal_failed transmet `err` quand le skill en donne un (dig_failed : quelle erreur ?)', () => {
  assert.match(SRC, /type: 'goal_failed', name: g\.name, reason: \(r && r\.reason\) \|\| 'unknown' \}, \(r && r\.err\) \? \{ err:/);
});

test('capFillStacks : jamais dans l\'abri ni dans un espace fermé — vise une case ouverte (tossTarget), sinon attend', () => {
  const f = fnSrc('capFillStacks');
  assert.match(f, /if \(_shelterInFlight\) return;/);
  assert.match(f, /tossTarget\(/);
  assert.match(f, /type: 'fill_cap_deferred'/);
  assert.match(f, /bot\.lookAt\(vec3Lib\(aim\.x, aim\.y, aim\.z\), true\)/);
  assert.doesNotMatch(f, /yaw \+ Math\.PI/, 'plus de jet aveugle « derrière soi »');
  // le report n'arme pas le throttle : la passe reprend au premier ramassage après la sortie
  assert.ok(f.indexOf('_fillCapAt = Date.now()') > f.indexOf("type: 'fill_cap_deferred'"));
  assert.match(SRC, /^let _fillCapDeferAt = 0;/m);
});
