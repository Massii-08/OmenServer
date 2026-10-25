'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fillOverflow, fillCapDue, FILL_MAX_STACKS, FILL_CAP_INTERVAL_MS } = require('./fillCap');

const S = (pairs) => pairs.map(([name, count], i) => ({ name, count, slot: 9 + i }));
const names = (arr) => arr.map((x) => x.name + ':' + x.count);

test('constantes : 3 piles, 20 s', () => {
  assert.strictEqual(FILL_MAX_STACKS, 3);
  assert.strictEqual(FILL_CAP_INTERVAL_MS, 20000);
});

test('LIVE NethBot1 : 10 piles de cobble (587) → 7 partent, il en reste 3', () => {
  const inv = S(new Array(9).fill(['cobblestone', 64]).concat([['cobblestone', 11]], [['stone_pickaxe', 1], ['iron_ingot', 5]]));
  const out = fillOverflow(inv);
  assert.strictEqual(out.length, 7);
  assert.strictEqual(out[0].count, 11, 'la plus petite pile d\'abord');
  const left = inv.filter((x) => x.name === 'cobblestone' && !out.includes(x));
  assert.strictEqual(left.length, 3);
  assert.strictEqual(left.reduce((n, x) => n + x.count, 0), 192);
});

test('≤ 3 piles : rien', () => {
  assert.deepStrictEqual(fillOverflow(S([['cobblestone', 64], ['dirt', 64], ['gravel', 64]])), []);
  assert.deepStrictEqual(fillOverflow(S([['stick', 64], ['oak_log', 64], ['coal', 64], ['torch', 64], ['bread', 64]])), []);
});

test('le gravier part avant le cobble ; la DERNIÈRE pile de terre reste (réserve d abri, 25/10)', () => {
  const out = fillOverflow(S([['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 64], ['dirt', 30], ['gravel', 5]]));
  assert.deepStrictEqual(names(out), ['gravel:5', 'cobblestone:64']);
});

test('réserve de terre : une pile en trop part si le reste garde ≥ DIRT_KEEP', () => {
  const out = fillOverflow(S([['dirt', 64], ['dirt', 20], ['cobblestone', 64], ['cobblestone', 64]]));
  assert.deepStrictEqual(names(out), ['dirt:20']);
});

test('jamais sous 64 blocs de remblai au total, même au-delà de 3 piles', () => {
  const out = fillOverflow(S([['dirt', 10], ['gravel', 10], ['tuff', 10], ['granite', 10], ['cobblestone', 30]]));
  // 70 au total : jeter 10 laisse 60 < 64 → rien.
  assert.deepStrictEqual(out, []);
});

test('ne jette JAMAIS outils, bois, minerais, nourriture, utilitaires', () => {
  const keep = ['stone_pickaxe', 'iron_sword', 'shield', 'iron_helmet', 'cooked_beef', 'raw_iron', 'iron_ingot', 'coal',
    'oak_log', 'oak_planks', 'stick', 'crafting_table', 'furnace', 'torch', 'white_bed', 'bucket', 'fishing_rod'];
  const inv = S(keep.map((n) => [n, 1]).concat(new Array(6).fill(['cobblestone', 64])));
  for (const it of fillOverflow(inv)) assert.strictEqual(it.name, 'cobblestone');
});

test('entrées bizarres → [] sans crash', () => {
  for (const bad of [undefined, null, 42, 'x', {}]) assert.deepStrictEqual(fillOverflow(bad), []);
});

test('fillCapDue : au plus une passe / 20 s', () => {
  assert.strictEqual(fillCapDue(1000, 0), true);
  assert.strictEqual(fillCapDue(100000, 90000), false);
  assert.strictEqual(fillCapDue(110000, 90000), true);
});

// ─── OÙ JETER (23/10, NethBot1 session 420) ──────────────────────────────────────────────────────────
// Muré dans son abri de nuit (pit 1×1, `shelter sealed`), le bot jetait « derrière lui » contre la
// paroi : tout lui retombait dessus et était RE-RAMASSÉ (fill_capped ×2 à 9 min d'écart, même liste).
// On ne jette que vers une case OUVERTE sur 2 blocs (pieds + tête) ; sinon on attend la sortie.
const { tossTarget } = require('./fillCap');
const mkWorld = (open) => (p) => {
  const k = `${p.x},${p.y},${p.z}`;
  if (open.has(k)) return { name: 'air', boundingBox: 'empty' };
  return { name: 'stone', boundingBox: 'block' };
};
const at = (x, y, z) => `${x},${y},${z}`;

test('tossTarget : muré (pit 1×1) → null, on ne jette pas', () => {
  const open = new Set([at(0, 64, 0), at(0, 65, 0)]);
  assert.strictEqual(tossTarget({ x: 0.5, y: 64, z: 0.5 }, mkWorld(open)), null);
});

test('tossTarget : une seule case libre devant (le reste muré) → null (il faut 2 blocs ouverts)', () => {
  const open = new Set([at(0, 64, 0), at(0, 65, 0), at(1, 64, 0), at(1, 65, 0)]);
  assert.strictEqual(tossTarget({ x: 0.5, y: 64, z: 0.5 }, mkWorld(open)), null);
});

test('tossTarget : couloir ouvert sur 2 blocs à l\'ouest → vise la case à 2 blocs, hauteur des yeux', () => {
  const open = new Set([at(0, 64, 0), at(0, 65, 0), at(-1, 64, 0), at(-1, 65, 0), at(-2, 64, 0), at(-2, 65, 0)]);
  const t = tossTarget({ x: 0.5, y: 64, z: 0.5 }, mkWorld(open));
  assert.deepStrictEqual(t, { x: -1.5, y: 65.6, z: 0.5 });
});

test('tossTarget : eau ou chunk non chargé = pas ouvert', () => {
  const open = new Set([at(0, 64, 0), at(0, 65, 0), at(1, 64, 0), at(1, 65, 0), at(2, 65, 0)]);
  const bA = (p) => {
    if (p.x === 2 && p.y === 64 && p.z === 0) return { name: 'water', boundingBox: 'empty' };
    if (p.x === 0 && p.z === 1) return null;
    return mkWorld(open)(p);
  };
  assert.strictEqual(tossTarget({ x: 0.5, y: 64, z: 0.5 }, bA), null);
});

test('tossTarget : entrées invalides → null, sans lever', () => {
  assert.strictEqual(tossTarget(null, () => null), null);
  assert.strictEqual(tossTarget({ x: 0, y: 64, z: 0 }, null), null);
  assert.strictEqual(tossTarget({ x: 0, y: 64, z: 0 }, () => { throw new Error('x'); }), null);
});

