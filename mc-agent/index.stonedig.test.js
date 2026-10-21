'use strict';
// CÂBLAGE de la pierre « comme un joueur » (21/10) : on exécute le VRAI texte de gatherStone (index.js)
// dans un bac à sable vm strict — un identifiant hors niveau module → ReferenceError ici, pas en prod.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const S = require('./stoneDig');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const fnSrc = (name) => {
  const m = SRC.match(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'));
  assert.ok(m, `function ${name} introuvable au niveau module`);
  return m[0];
};

function sandbox(o = {}) {
  const sb = {
    events: [], calls: [],
    emit(e) { sb.events.push(e); },
    Date, Object, Math, Number, Promise,
    items: (o.items || []).map((i) => Object.assign({}, i)),
    IS_MAPPER: !!o.isMapper,
    taskToken: { cancelled: false },
    pickTier: S.pickTier, stoneBatchWant: S.stoneBatchWant, stoneStairPlan: S.stoneStairPlan,
    survivalTick: async () => {}, eat: async () => {}, fleeFrom: () => {},
    addCobble(n) {
      const c = sb.items.find((i) => i.name === 'cobblestone');
      if (c) c.count += n; else sb.items.push({ name: 'cobblestone', count: n });
    },
    descendDiagonal: async (bot, a, tok) => {
      sb.calls.push(['descend', a.targetY, a.maxDepth]);
      for (let k = 0; k < (o.stairSteps == null ? 99 : o.stairSteps); k++) {
        if (a.stopWhen()) return { ok: true, stopped: true, reachedY: 50 };
        sb.addCobble(2);
      }
      return { ok: false, reason: o.stairReason || 'water_ahead', reachedY: 60 };
    },
    mineDown: async () => { sb.calls.push('mineDown'); return { ok: true }; },
    gather: async (bot, a) => { sb.calls.push(['gather', a.name, a.count, a.explore]); return o.gatherResult || { ok: true, got: a.count }; },
    bot: {
      entity: { position: { x: 0, y: o.y == null ? 70 : o.y, z: 0 } },
      inventory: { items: () => sb.items },
      registry: { blocksByName: { stone: { id: 1 } } },
      findBlock: () => (o.stoneNear ? { position: {} } : null),
    },
  };
  vm.createContext(sb);
  vm.runInContext("'use strict';\n" + fnSrc('gatherStone'), sb);
  return sb;
}
const G = (count, name = 'cobble_furnace') => ({ name, skill: 'gather', args: { name: 'stone', count } });

test('pioche pierre : escalier jusqu\'au LOT (32), aucun collect/explore', async () => {
  const sb = sandbox({ items: [{ name: 'stone_pickaxe', count: 1 }] });
  const r = await vm.runInContext('gatherStone(' + JSON.stringify(G(8)) + ')', sb);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.got, 32);
  assert.deepStrictEqual(sb.calls, [['descend', 20, 40]]);
  const ev = sb.events.find((e) => e.type === 'stone_stair');
  assert.ok(ev && ev.want === 32 && ev.got === 32 && ev.stopped === true);
});

test('pioche en bois : escalier mais seulement le besoin du but (pioche fragile)', async () => {
  const sb = sandbox({ items: [{ name: 'wooden_pickaxe', count: 1 }] });
  const r = await vm.runInContext('gatherStone(' + JSON.stringify(G(3, 'cobble_pick')) + ')', sb);
  assert.strictEqual(r.ok, true);
  assert.ok(r.got >= 3 && r.got <= 4);
});

test('escalier arrêté par l\'eau avant le but → repli historique pour le RESTE seulement', async () => {
  const sb = sandbox({ items: [{ name: 'stone_pickaxe', count: 1 }], stairSteps: 2 });
  const r = await vm.runInContext('gatherStone(' + JSON.stringify(G(8)) + ')', sb);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(sb.calls.slice(1), ['mineDown', ['gather', 'stone', 4, true]]);
});

test('escalier partiel mais but atteint (eau après 8 cobble) → ok sans repli', async () => {
  const sb = sandbox({ items: [{ name: 'stone_pickaxe', count: 1 }], stairSteps: 4 });
  const r = await vm.runInContext('gatherStone(' + JSON.stringify(G(8)) + ')', sb);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(sb.calls.length, 1);
});

test('sans pioche : chemin historique inchangé (mineDown si pas de pierre à 32, puis gather explore)', async () => {
  const sb = sandbox({ items: [] });
  await vm.runInContext('gatherStone(' + JSON.stringify(G(3)) + ')', sb);
  assert.deepStrictEqual(sb.calls, ['mineDown', ['gather', 'stone', 3, true]]);
  const sb2 = sandbox({ items: [], stoneNear: true });
  await vm.runInContext('gatherStone(' + JSON.stringify(G(3)) + ')', sb2);
  assert.deepStrictEqual(sb2.calls, [['gather', 'stone', 3, true]]);
});

test('repli en échec mais lot partiel de l\'escalier en poche → ok (le partiel compte)', async () => {
  const sb = sandbox({ items: [{ name: 'stone_pickaxe', count: 1 }], stairSteps: 1, gatherResult: { ok: false, reason: 'not_found' } });
  const r = await vm.runInContext('gatherStone(' + JSON.stringify(G(8)) + ')', sb);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { ok: true, got: 2 });
});

test('câblage : le but gather pierre passe par gatherStone', () => {
  assert.match(SRC, /if \(goal\.args\.name === 'stone'\) return gatherStone\(goal\);/);
});
