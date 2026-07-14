'use strict';
// Porte de profondeur branchMine (deadlock wrong_depth, run water-wall cycle 2) : un bot SOUS la
// fenêtre [targetY-6, targetY+2] (ex. y=4 pour targetY=16, ramené là par water_rescue → /home safe)
// bouclait à vie : descend_y16.met (y≤18) → iron_deep → bail wrong_depth → re-dérive → idem (vécu
// live NethBot3 : 28× goal_failed wrong_depth à y=4, 0 minage). Or le serpentine mine AU NIVEAU
// COURANT (targetY ne sert qu'à la porte) et « trop profond est SANS RISQUE » (le fer existe sous
// Y16). opts.allowDeeper (opt-in, chaînes armure NO_GIVE) admet le bot SOUS la fenêtre tant qu'il
// reste au-dessus du plancher bedrock (y ≥ -59). Rétro-compat : sans le flag, bail inchangé.
const { test } = require('node:test');
const assert = require('node:assert');
const { branchMine } = require('../skills/branchMine');

// Bot minimal : la porte ne lit que entity.position ; le probe post-porte = countWallable
// (inventaire vide → cobble_low, préuve que la porte est PASSÉE sans lancer le minage réel).
function fakeBot(y) {
  return {
    entity: { position: { x: 0, y, z: 0 }, yaw: 0 },
    inventory: { items: () => [] },
    blockAt: () => null,
  };
}

test('branchMine: trop HAUT (y > targetY+2) → wrong_depth (inchangé)', async () => {
  const r = await branchMine(fakeBot(30), { targetY: 16 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'wrong_depth');
});

test('branchMine: trop PROFOND sans allowDeeper → wrong_depth (rétro-compat)', async () => {
  const r = await branchMine(fakeBot(4), { targetY: 16 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'wrong_depth');
});

test('branchMine: trop profond AVEC allowDeeper → porte passée (probe cobble_low)', async () => {
  const r = await branchMine(fakeBot(4), { targetY: 16, allowDeeper: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'cobble_low'); // ≠ wrong_depth : le minage au niveau courant est admis
});

test('branchMine: allowDeeper ne débloque PAS le trop-haut', async () => {
  const r = await branchMine(fakeBot(30), { targetY: 16, allowDeeper: true });
  assert.strictEqual(r.reason, 'wrong_depth');
});

test('branchMine: allowDeeper a un PLANCHER bedrock (y < -59 → wrong_depth)', async () => {
  const r = await branchMine(fakeBot(-62), { targetY: 16, allowDeeper: true });
  assert.strictEqual(r.reason, 'wrong_depth');
});

test('branchMine: fenêtre historique intacte (y = targetY-6 passe sans flag)', async () => {
  const r = await branchMine(fakeBot(10), { targetY: 16 });
  assert.strictEqual(r.reason, 'cobble_low');
});
