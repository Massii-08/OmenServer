'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { mineDown } = require('../skills/mineDown');

function makeBot(belowNames) {
  let i = 0;
  const calls = { dig: 0 };
  return {
    calls,
    inventory: { items: () => [{ name: 'diamond_pickaxe' }] },
    entity: { position: { offset: (dx, dy) => ({ k: dy }) } },
    blockAt: (p) => {
      // p.k = -1 (sous les pieds) ou -2
      if (p.k === -1) { const n = belowNames[i] || 'air'; return { name: n }; }
      return { name: belowNames[i + 1] || 'stone' };
    },
    equip: async () => {},
    dig: async () => { calls.dig++; i++; },
  };
}

test('mineDown: vide en dessous → void_below', async () => {
  const r = await mineDown(makeBot(['air']), { count: 3 });
  assert.deepStrictEqual(r, { ok: false, reason: 'void_below' });
});

test('mineDown: lave en dessous → danger_below', async () => {
  const r = await mineDown(makeBot(['lava']), { count: 3 });
  assert.deepStrictEqual(r, { ok: false, reason: 'danger_below' });
});

test('mineDown: creuse n blocs de pierre', async () => {
  const bot = makeBot(['stone', 'stone', 'stone', 'stone']);
  const r = await mineDown(bot, { count: 3 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(bot.calls.dig, 3);
});

// ─── ATTERRISSAGE (opt-in `land`, abri nocturne 19/10 soir) ──────────────────────────────────────
// `bot.dig` rend la main dès que le bloc est cassé, AVANT que le bot soit retombé : le tour suivant
// relisait le bloc sous des pieds encore en l'air (l'air qu'on vient de creuser) → `void_below`, et
// « creuser 3 blocs » n'en creusait qu'un. Avec `land`, on attend le fond avant le coup suivant.
const { Vec3 } = require('vec3');

/** Colonne de terrain + chute réaliste : le bot ne tombe qu'au `sleep` qui suit le coup (physique). */
function columnBot({ layers, feetY = 64, falls = true }) {
  const world = new Map(Object.entries(layers).map(([y, n]) => [Number(y), n]));
  const nameAt = (y) => world.get(y) || 'air';
  const bot = {
    calls: { dig: 0, sleeps: 0 },
    inventory: { items: () => [] },
    entity: { position: new Vec3(0.5, feetY, 0.5), onGround: true },
    blockAt: (p) => ({ name: nameAt(Math.floor(p.y)), position: p }),
    equip: async () => {},
    dig: async (b) => { bot.calls.dig++; world.set(Math.floor(b.position.y), 'air'); bot.entity.onGround = false; },
  };
  const sleep = async () => {
    bot.calls.sleeps++;
    if (!falls) { bot.entity.onGround = true; return; }
    const y = Math.floor(bot.entity.position.y);
    if (nameAt(y - 1) === 'air') bot.entity.position.y = y - 1;      // un bloc de chute par pas
    bot.entity.onGround = nameAt(Math.floor(bot.entity.position.y) - 1) !== 'air';
  };
  return { bot, sleep };
}
const DIRT = { 63: 'grass_block', 62: 'dirt', 61: 'dirt', 60: 'dirt', 59: 'stone' };

test('mineDown: SANS land, le bug d origine est là — le 2e coup voit l air qu on vient de creuser', async () => {
  const { bot } = columnBot({ layers: DIRT });
  const r = await mineDown(bot, { count: 3 });
  assert.deepStrictEqual(r, { ok: false, dug: 1, reason: 'void_below' }, 'contrat d origine inchangé pour les autres appelants');
});

test('mineDown: AVEC land → attend le fond entre deux coups et creuse VRAIMENT 3 blocs', async () => {
  const { bot, sleep } = columnBot({ layers: DIRT });
  const r = await mineDown(bot, { count: 3, land: { sleep } });
  assert.deepStrictEqual(r, { ok: true, dug: 3 });
  assert.strictEqual(bot.entity.position.y, 61, 'pieds 3 blocs plus bas');
  assert.strictEqual(bot.calls.dig, 3);
});

test('mineDown: AVEC land, un bot qui ne retombe pas (debout sur le bord) → no_fall, borné (~1,5 s), jamais un 2e coup dans le vide', async () => {
  const { bot, sleep } = columnBot({ layers: DIRT, falls: false });
  const r = await mineDown(bot, { count: 3, land: { sleep } });
  assert.deepStrictEqual(r, { ok: false, dug: 1, reason: 'no_fall' });
  assert.strictEqual(bot.calls.dig, 1);
  assert.ok(bot.calls.sleeps <= 31, `attente bornée (${bot.calls.sleeps} pas de 50 ms)`);
});

test('mineDown: AVEC land, grotte DEUX blocs plus bas → on ne perce pas (on tomberait dedans) : cave_below', async () => {
  const { bot, sleep } = columnBot({ layers: { 63: 'grass_block', 62: 'dirt', 61: 'cave_air', 60: 'stone' } });
  const r = await mineDown(bot, { count: 3, land: { sleep } });
  assert.deepStrictEqual(r, { ok: false, dug: 1, reason: 'cave_below' }, 'un bloc creusé, puis arrêt au-dessus de la grotte');
  assert.strictEqual(bot.entity.position.y, 63);
});

test('mineDown: AVEC land, les gardes lave/vide d origine tiennent toujours', async () => {
  const lava = columnBot({ layers: { 63: 'grass_block', 62: 'lava' } });
  assert.deepStrictEqual(await mineDown(lava.bot, { count: 3, land: { sleep: lava.sleep } }), { ok: false, reason: 'danger_below' });
  const empty = columnBot({ layers: { 62: 'dirt' } });
  assert.deepStrictEqual(await mineDown(empty.bot, { count: 3, land: { sleep: empty.sleep } }), { ok: false, reason: 'void_below' });
});
