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

// ─── Mode QUOTA (multi-quota par bot, claims, mémoire live) ───────────────────

// Bot mocké avec INVENTAIRE dynamique : collect crédite le drop du minerai.
const DROP_OF = { iron_ore: 'raw_iron', diamond_ore: 'diamond', deepslate_diamond_ore: 'diamond',
  gold_ore: 'raw_gold', redstone_ore: 'redstone', lapis_ore: 'lapis_lazuli' };
function makeQuotaBot({ blocks = {}, inv = [], emptySlots = 30 } = {}) {
  const items = inv.map((i) => ({ ...i }));
  const bot = makeBot({ blocks, emptySlots });
  bot.inventory.items = () => items.map((i) => ({ ...i }));
  bot._items = items;
  const origCollect = bot.collectBlock.collect;
  bot.collectBlock.collect = async (b) => {
    await origCollect(b);
    const drop = DROP_OF[b.name];
    if (drop) {
      const slot = items.find((i) => i.name === drop);
      if (slot) slot.count += 1; else items.push({ name: drop, count: 1 });
    }
  };
  return bot;
}

test('quota : ne vise que les types manquants, s\'arrête quand tout est atteint (quota_done)', async () => {
  // quota {iron:2} déjà à 1 (raw_iron en poche) ; carte : 1 iron + 1 diamond.
  const blocks = {
    '10,40,5': { name: 'iron_ore', position: { x: 10, y: 40, z: 5 } },
    '20,-50,5': { name: 'diamond_ore', position: { x: 20, y: -50, z: 5 } },
  };
  const bot = makeQuotaBot({ blocks, inv: [{ name: 'raw_iron', count: 1 }] });
  const events = [];
  const r = await runResource(bot, {
    memory: mem([
      { material: 'diamond_ore', x: 20, y: -50, z: 5 },
      { material: 'iron_ore', x: 10, y: 40, z: 5 },
    ]),
    worldKey: 'overworld',
    emit: (e) => events.push(e),
    goto: async () => {},
    quota: { iron: 2 },          // diamond N'EST PAS dans le quota → jamais visé
  });
  assert.equal(r.ok, true);
  assert.equal(r.done, true);
  assert.equal(r.mined, 1);
  assert.deepEqual(bot._dug, ['10,40,5']);                       // pas le diamant
  assert.equal(collect(events, 'quota_done').length, 1);
  const prog = collect(events, 'quota_progress');
  assert.ok(prog.length >= 1);
  const last = prog[prog.length - 1].counts;
  assert.deepEqual(last, { iron: { have: 2, target: 2 } });
});

test('quota : carte vide + reloadMemory → resource_waiting puis reprend quand la carte se remplit', async () => {
  const blocks = { '10,40,5': { name: 'iron_ore', position: { x: 10, y: 40, z: 5 } } };
  const bot = makeQuotaBot({ blocks });
  const events = [];
  let reloads = 0;
  const r = await runResource(bot, {
    memory: mem([]),                                  // vide au départ (mappers en cours)
    worldKey: 'overworld',
    emit: (e) => events.push(e),
    goto: async () => {},
    quota: { iron: 1 },
    sleep: async () => {},
    reloadMemory: () => {
      reloads++;
      return reloads >= 2 ? mem([{ material: 'iron_ore', x: 10, y: 40, z: 5 }]) : mem([]);
    },
  });
  assert.equal(r.done, true);
  assert.ok(collect(events, 'resource_waiting').length >= 2);
  assert.equal(r.mined, 1);
});

test('quota : starved après maxIdleMs sans nouvelle cible', async () => {
  const bot = makeQuotaBot({});
  const events = [];
  let t = 0;
  const r = await runResource(bot, {
    memory: mem([]),
    worldKey: 'overworld',
    emit: (e) => events.push(e),
    goto: async () => {},
    quota: { iron: 1 },
    sleep: async () => { t += 60000; },
    now: () => t,
    maxIdleMs: 300000,
    reloadMemory: () => mem([]),                      // jamais rien
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'starved');
  assert.ok(collect(events, 'resource_starved').length === 1);
});

test('claims : ore claimée par un autre → skip temporaire ; la sienne → minée + released', async () => {
  const blocks = {
    '10,40,5': { name: 'iron_ore', position: { x: 10, y: 40, z: 5 } },
    '12,40,5': { name: 'iron_ore', position: { x: 12, y: 40, z: 5 } },
  };
  const bot = makeQuotaBot({ blocks });
  const claimed = new Set(['10,40,5']);               // déjà prise par un autre bot
  const log = [];
  const claims = {
    tryClaim: (k) => { log.push('try:' + k); return !claimed.has(k); },
    refresh: (k) => { log.push('refresh:' + k); return true; },
    release: (k) => { log.push('release:' + k); return true; },
  };
  const events = [];
  const r = await runResource(bot, {
    memory: mem([
      { material: 'iron_ore', x: 10, y: 40, z: 5 },   // plus proche mais claimée
      { material: 'iron_ore', x: 12, y: 40, z: 5 },
    ]),
    worldKey: 'overworld',
    emit: (e) => events.push(e),
    goto: async () => {},
    quota: { iron: 1 },
    claims,
  });
  assert.equal(r.done, true);
  assert.deepEqual(bot._dug, ['12,40,5']);            // a miné la libre, pas la claimée
  assert.ok(log.includes('try:10,40,5') && log.includes('try:12,40,5'));
  assert.ok(log.includes('release:12,40,5'));
});

test('claims : unreachable → release pour qu\'un autre bot retente', async () => {
  const blocks = { '10,40,5': { name: 'iron_ore', position: { x: 10, y: 40, z: 5 } } };
  const bot = makeQuotaBot({ blocks });
  const log = [];
  const claims = {
    tryClaim: () => true,
    refresh: () => true,
    release: (k) => { log.push('release:' + k); return true; },
  };
  let calls = 0;
  const events = [];
  const r = await runResource(bot, {
    memory: mem([{ material: 'iron_ore', x: 10, y: 40, z: 5 }]),
    worldKey: 'overworld',
    emit: (e) => events.push(e),
    goto: async () => { calls++; throw new Error('unreachable'); },
    quota: { iron: 1 },
    claims,
    sleep: async () => {},
    now: (() => { let t = 0; return () => (t += 120000); })(),   // le temps file → starved vite
    maxIdleMs: 200000,
    reloadMemory: () => mem([{ material: 'iron_ore', x: 10, y: 40, z: 5 }]),
  });
  assert.ok(log.includes('release:10,40,5'));
  assert.equal(r.ok, false);                           // seule ore inatteignable → starved
  assert.ok(collect(events, 'resource_unreachable').length >= 1);
});

test('quota : inventaire plein → cleanup (toss junk) appelé, pas deposit', async () => {
  const blocks = { '10,40,5': { name: 'iron_ore', position: { x: 10, y: 40, z: 5 } } };
  const bot = makeQuotaBot({ blocks, emptySlots: 1 }); // plein dès le départ
  let cleaned = 0; let deposited = 0;
  const events = [];
  const r = await runResource(bot, {
    memory: mem([{ material: 'iron_ore', x: 10, y: 40, z: 5 }]),
    worldKey: 'overworld',
    emit: (e) => events.push(e),
    goto: async () => {},
    quota: { iron: 1 },
    cleanup: async () => { cleaned++; },
    deposit: async () => { deposited++; return { ok: true }; },
  });
  assert.equal(r.done, true);
  assert.ok(cleaned >= 1);
  assert.equal(deposited, 0);                          // cleanup PRIME sur deposit en mode quota
});

test('legacy sans quota : comportement inchangé (carte épuisée → done, pas de wait)', async () => {
  const blocks = { '10,40,5': { name: 'iron_ore', position: { x: 10, y: 40, z: 5 } } };
  const bot = makeQuotaBot({ blocks });
  const events = [];
  const r = await runResource(bot, {
    memory: mem([{ material: 'iron_ore', x: 10, y: 40, z: 5 }]),
    worldKey: 'overworld',
    emit: (e) => events.push(e),
    goto: async () => {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.mined, 1);
  assert.equal(r.done, undefined);
  assert.equal(collect(events, 'quota_progress').length, 0);
  assert.equal(collect(events, 'resource_waiting').length, 0);
});
