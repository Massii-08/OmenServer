'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { countItems, createQuotaTracker, normalizeQuota } = require('../quota');

test('countItems: lingots comptés comme métal récolté (livraison fondue)', () => {
  const c = countItems([
    { name: 'gold_ingot', count: 10 }, { name: 'raw_gold', count: 5 },
    { name: 'iron_ingot', count: 20 }, { name: 'raw_iron', count: 4 },
    { name: 'diamond', count: 3 }, { name: 'redstone', count: 7 }, { name: 'lapis_lazuli', count: 9 },
  ]);
  assert.strictEqual(c.gold, 15);   // raw_gold + gold_ingot
  assert.strictEqual(c.iron, 24);   // raw_iron + iron_ingot
  assert.strictEqual(c.diamond, 3);
  assert.strictEqual(c.redstone, 7);
  assert.strictEqual(c.lapis, 9);
});

test('createQuotaTracker: have = banked + inventaire courant', () => {
  const t = createQuotaTracker({ diamond: 64, gold: 64, iron: 64, redstone: 64, lapis: 64 });
  const inv0 = [{ name: 'diamond', count: 30 }];
  assert.strictEqual(t.progress(inv0).diamond.have, 30);
  // on banke (dépose) les 30 diamants : avant=30, après=0
  t.noteBanked([{ name: 'diamond', count: 30 }], []);
  // inventaire vidé mais le compte tient (banked=30)
  assert.strictEqual(t.progress([]).diamond.have, 30);
  // on re-mine 40 → 30 banked + 40 portés = 70 ≥ 64
  assert.strictEqual(t.progress([{ name: 'diamond', count: 40 }]).diamond.have, 70);
});

test('createQuotaTracker: une MORT (perte inventaire) NE retombe PAS sous le banked', () => {
  const t = createQuotaTracker({ diamond: 64 });
  t.noteBanked([{ name: 'diamond', count: 50 }], []); // 50 bankés en coffre
  // mort → inventaire vide → have reste 50 (les 50 sont saufs dans le coffre)
  assert.strictEqual(t.progress([]).diamond.have, 50);
  assert.strictEqual(t.met([]), false);
});

test('met: quota atteint quand banked+inv couvre tous les types', () => {
  const t = createQuotaTracker({ diamond: 2, iron: 2 });
  t.noteBanked([{ name: 'diamond', count: 2 }, { name: 'iron_ingot', count: 2 }], []);
  assert.strictEqual(t.met([]), true);
});

test('normalizeQuota: 64×5', () => {
  assert.deepStrictEqual(normalizeQuota({ diamond: 64, gold: 64, iron: 64, redstone: 64, lapis: 64 }),
    { diamond: 64, gold: 64, redstone: 64, lapis: 64, iron: 64 });
});

// ─── Persistance du banked (durabilité respawn / re-entrée / deploy) ───
// Cause racine multi-nuits : le tracker est recréé à CHAQUE re-entrée de runResource (même process)
// ET à chaque respawn (nouveau process) → banked repart à 0 → la progression bankée (coffres au sol)
// est OUBLIÉE → plateau. Fix : seed `opts.banked` au démarrage + callback `opts.onBanked` pour persister.

test('createQuotaTracker: opts.banked SEED restaure la progression bankée (respawn-durable)', () => {
  const t = createQuotaTracker({ diamond: 64, iron: 64 }, { banked: { diamond: 19, iron: 15 } });
  // sans rien miner, have = banked rechargé (les 19💎/15 fer sont dans des coffres au sol)
  assert.strictEqual(t.progress([]).diamond.have, 19);
  assert.strictEqual(t.progress([]).iron.have, 15);
  // re-mine 5💎 portés → 19 + 5 = 24
  assert.strictEqual(t.progress([{ name: 'diamond', count: 5 }]).diamond.have, 24);
});

test('createQuotaTracker: opts.banked ignore les types inconnus / valeurs invalides', () => {
  const t = createQuotaTracker({ diamond: 64 }, { banked: { diamond: 10, foo: 99, gold: -3 } });
  assert.strictEqual(t.progress([]).diamond.have, 10);
  // gold n'est même pas dans le quota demandé → absent
  assert.strictEqual(t.progress([]).gold, undefined);
});

test('createQuotaTracker: onBanked fire avec le snapshot CUMULÉ à chaque crédit', () => {
  const snaps = [];
  const t = createQuotaTracker({ diamond: 64 }, { banked: { diamond: 19 },
    onBanked: (s) => snaps.push(s) });
  t.noteBanked([{ name: 'diamond', count: 6 }], []); // dépose 6 → cumul 25
  assert.strictEqual(snaps.length, 1);
  assert.strictEqual(snaps[0].diamond, 25);          // 19 seed + 6 déposés
  t.noteBanked([{ name: 'diamond', count: 4 }], []); // dépose 4 → cumul 29
  assert.strictEqual(snaps.length, 2);
  assert.strictEqual(snaps[1].diamond, 29);
});

test('createQuotaTracker: onBanked ne fire PAS sur un delta nul (rien déposé)', () => {
  let calls = 0;
  const t = createQuotaTracker({ diamond: 64 }, { onBanked: () => { calls++; } });
  t.noteBanked([{ name: 'diamond', count: 5 }], [{ name: 'diamond', count: 5 }]); // inchangé
  assert.strictEqual(calls, 0);
});

test('createQuotaTracker: bankedSnapshot expose une COPIE (pas la ref interne)', () => {
  const t = createQuotaTracker({ diamond: 64 }, { banked: { diamond: 7 } });
  const s = t.bankedSnapshot();
  assert.strictEqual(s.diamond, 7);
  s.diamond = 999;                                   // muter la copie ne touche pas l'interne
  assert.strictEqual(t.bankedSnapshot().diamond, 7);
});
