'use strict';
// Tests de la boucle RESSOURCE : lit worlds[<monde>].ores (minerais EXPOSÉS du cartographe),
// navigue, mine, et MET À JOUR LA CARTE (events ore_mined / ore_gone → remove_ore côté backend).
const test = require('node:test');
const assert = require('node:assert');
const { runResource } = require('./resource');

// Bot mocké minimal : position fixe, monde de blocs adressé par "x,y,z", collect scripté.
function makeBot({ blocks = {}, collectFail = new Set(), emptySlots = 30 } = {}) {
  const dug = [];
  return {
    entity: { position: { x: 0, y: 64, z: 0 } },
    blockAt: (p) => blocks[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`] || null,
    inventory: { items: () => [], emptySlotCount: () => emptySlots },
    equip: async () => {},
    collectBlock: {
      collect: async (b) => {
        const k = `${b.position.x},${b.position.y},${b.position.z}`;
        if (collectFail.has(k)) throw new Error('dig_error');
        dug.push(k);
        delete blocks[k];
      },
    },
    pathfinder: { setGoal: () => {} },
    setControlState: () => {},
    _dug: dug,
  };
}

function mem(ores) { return { worlds: { overworld: { ores } } }; }
function collect(events, type) { return events.filter((e) => e.type === type); }

test('mine un minerai exposé → émet ore_mined {world,x,y,z} et resource_done {mined:1}', async () => {
  const blocks = { '10,40,5': { name: 'iron_ore', position: { x: 10, y: 40, z: 5 } } };
  const bot = makeBot({ blocks });
  const events = [];
  const r = await runResource(bot, {
    memory: mem([{ material: 'iron_ore', x: 10, y: 40, z: 5 }]),
    worldKey: 'overworld',
    emit: (e) => events.push(e),
    goto: async () => {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.mined, 1);
  const minedEv = collect(events, 'ore_mined');
  assert.equal(minedEv.length, 1);
  assert.deepEqual(
    { world: minedEv[0].world, x: minedEv[0].x, y: minedEv[0].y, z: minedEv[0].z },
    { world: 'overworld', x: 10, y: 40, z: 5 });
  assert.equal(collect(events, 'resource_done')[0].mined, 1);
  assert.deepEqual(bot._dug, ['10,40,5']);
});

test('minerai déjà miné (bloc absent) → émet ore_gone, pas ore_mined, passe à la suite', async () => {
  // 2 cibles : la 1re (plus proche) n'existe plus, la 2e est là.
  const blocks = { '30,40,0': { name: 'iron_ore', position: { x: 30, y: 40, z: 0 } } };
  const bot = makeBot({ blocks });
  const events = [];
  const r = await runResource(bot, {
    memory: mem([
      { material: 'iron_ore', x: 5, y: 64, z: 0 },   // absente (air)
      { material: 'iron_ore', x: 30, y: 40, z: 0 },
    ]),
    worldKey: 'overworld',
    emit: (e) => events.push(e),
    goto: async () => {},
  });
  assert.equal(r.mined, 1);
  const gone = collect(events, 'ore_gone');
  assert.equal(gone.length, 1);
  assert.deepEqual({ x: gone[0].x, y: gone[0].y, z: gone[0].z }, { x: 5, y: 64, z: 0 });
  assert.equal(gone[0].world, 'overworld');
  assert.equal(collect(events, 'ore_mined').length, 1);
});

test('bloc présent mais PAS un minerai (remplacé par de la pierre) → ore_gone', async () => {
  const blocks = { '5,64,0': { name: 'stone', position: { x: 5, y: 64, z: 0 } } };
  const bot = makeBot({ blocks });
  const events = [];
  await runResource(bot, {
    memory: mem([{ material: 'iron_ore', x: 5, y: 64, z: 0 }]),
    worldKey: 'overworld',
    emit: (e) => events.push(e),
    goto: async () => {},
  });
  assert.equal(collect(events, 'ore_gone').length, 1);
  assert.equal(collect(events, 'ore_mined').length, 0);
});

test('un AUTRE minerai à la position notée → miné quand même (ore exposé = ore bon à prendre)', async () => {
  const blocks = { '5,64,0': { name: 'deepslate_iron_ore', position: { x: 5, y: 64, z: 0 } } };
  const bot = makeBot({ blocks });
  const events = [];
  const r = await runResource(bot, {
    memory: mem([{ material: 'iron_ore', x: 5, y: 64, z: 0 }]),
    worldKey: 'overworld',
    emit: (e) => events.push(e),
    goto: async () => {},
  });
  assert.equal(r.mined, 1);
  assert.equal(collect(events, 'ore_mined').length, 1);
});

test('cible inatteignable (goto throw) → resource_unreachable, cible skippée, boucle continue', async () => {
  const blocks = {
    '5,64,0': { name: 'iron_ore', position: { x: 5, y: 64, z: 0 } },
    '30,40,0': { name: 'iron_ore', position: { x: 30, y: 40, z: 0 } },
  };
  const bot = makeBot({ blocks });
  const events = [];
  const r = await runResource(bot, {
    memory: mem([
      { material: 'iron_ore', x: 5, y: 64, z: 0 },
      { material: 'iron_ore', x: 30, y: 40, z: 0 },
    ]),
    worldKey: 'overworld',
    emit: (e) => events.push(e),
    goto: async (t) => { if (t.x === 5) throw new Error('unreachable'); },
  });
  assert.equal(collect(events, 'resource_unreachable').length, 1);
  assert.equal(r.mined, 1);          // la 2e cible est minée
  assert.deepEqual(bot._dug, ['30,40,0']);
  // une cible inatteignable n'est PAS retirée de la carte (elle existe peut-être encore)
  assert.equal(collect(events, 'ore_gone').length, 0);
});

test('échec de minage (collect throw ×2) → resource_failed, PAS ore_mined ni ore_gone, skip', async () => {
  const blocks = { '5,64,0': { name: 'iron_ore', position: { x: 5, y: 64, z: 0 } } };
  const bot = makeBot({ blocks, collectFail: new Set(['5,64,0']) });
  const events = [];
  const r = await runResource(bot, {
    memory: mem([{ material: 'iron_ore', x: 5, y: 64, z: 0 }]),
    worldKey: 'overworld',
    emit: (e) => events.push(e),
    goto: async () => {},
  });
  assert.equal(r.mined, 0);
  assert.equal(collect(events, 'resource_failed').length, 1);
  assert.equal(collect(events, 'ore_mined').length, 0);
  assert.equal(collect(events, 'ore_gone').length, 0);
});

test('priorité : le diamant (loin) est miné AVANT le fer (proche) — si la pioche le permet', async () => {
  const blocks = {
    '100,12,0': { name: 'diamond_ore', position: { x: 100, y: 12, z: 0 } },
    '5,64,0': { name: 'iron_ore', position: { x: 5, y: 64, z: 0 } },
  };
  const bot = makeBot({ blocks });
  const events = [];
  await runResource(bot, {
    memory: mem([
      { material: 'iron_ore', x: 5, y: 64, z: 0 },
      { material: 'diamond_ore', x: 100, y: 12, z: 0 },
    ]),
    worldKey: 'overworld',
    emit: (e) => events.push(e),
    goto: async () => {},
    pickTier: () => 3, // pioche fer
  });
  assert.deepEqual(bot._dug, ['100,12,0', '5,64,0']); // diamant d'abord
});

test('pickTier pierre (2) : diamant exclu, seul le fer est miné', async () => {
  const blocks = {
    '100,12,0': { name: 'diamond_ore', position: { x: 100, y: 12, z: 0 } },
    '5,64,0': { name: 'iron_ore', position: { x: 5, y: 64, z: 0 } },
  };
  const bot = makeBot({ blocks });
  const r = await runResource(bot, {
    memory: mem([
      { material: 'iron_ore', x: 5, y: 64, z: 0 },
      { material: 'diamond_ore', x: 100, y: 12, z: 0 },
    ]),
    worldKey: 'overworld',
    emit: () => {},
    goto: async () => {},
    pickTier: () => 2,
  });
  assert.equal(r.mined, 1);
  assert.deepEqual(bot._dug, ['5,64,0']);
});

test('liste ores vide → resource_done {mined:0} immédiat (idle propre, pas de crash)', async () => {
  const bot = makeBot();
  const events = [];
  const r = await runResource(bot, {
    memory: mem([]),
    worldKey: 'overworld',
    emit: (e) => events.push(e),
    goto: async () => {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.mined, 0);
  assert.equal(collect(events, 'resource_done').length, 1);
  assert.equal(collect(events, 'resource_start')[0].ores, 0);
});

test('inventaire plein → deposit appelé avant la cible', async () => {
  const blocks = { '5,64,0': { name: 'iron_ore', position: { x: 5, y: 64, z: 0 } } };
  const bot = makeBot({ blocks, emptySlots: 0 });
  let deposited = 0;
  const events = [];
  await runResource(bot, {
    memory: mem([{ material: 'iron_ore', x: 5, y: 64, z: 0 }]),
    worldKey: 'overworld',
    emit: (e) => events.push(e),
    goto: async () => {},
    deposit: async () => { deposited++; return { ok: true }; },
  });
  assert.equal(deposited, 1);
  assert.equal(collect(events, 'resource_deposit').length, 1);
});

test('token annulé en cours → {cancelled:true}, arrêt immédiat', async () => {
  const blocks = {
    '5,64,0': { name: 'iron_ore', position: { x: 5, y: 64, z: 0 } },
    '30,40,0': { name: 'iron_ore', position: { x: 30, y: 40, z: 0 } },
  };
  const bot = makeBot({ blocks });
  const token = { cancelled: false };
  const r = await runResource(bot, {
    memory: mem([
      { material: 'iron_ore', x: 5, y: 64, z: 0 },
      { material: 'iron_ore', x: 30, y: 40, z: 0 },
    ]),
    worldKey: 'overworld',
    emit: () => {},
    goto: async () => { token.cancelled = true; }, // annulé pendant le 1er trajet
  }, token);
  assert.equal(r.cancelled, true);
  assert.equal(bot._dug.length, 0);
});

test('onTarget (hook survie) appelé avant chaque cible', async () => {
  const blocks = {
    '5,64,0': { name: 'iron_ore', position: { x: 5, y: 64, z: 0 } },
    '30,40,0': { name: 'iron_ore', position: { x: 30, y: 40, z: 0 } },
  };
  const bot = makeBot({ blocks });
  let hooks = 0;
  await runResource(bot, {
    memory: mem([
      { material: 'iron_ore', x: 5, y: 64, z: 0 },
      { material: 'iron_ore', x: 30, y: 40, z: 0 },
    ]),
    worldKey: 'overworld',
    emit: () => {},
    goto: async () => {},
    onTarget: async () => { hooks++; },
  });
  assert.equal(hooks, 2);
});
