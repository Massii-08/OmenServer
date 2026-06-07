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

test('collect gelé → borné par collectTimeoutMs, le bot passe à la cible suivante (anti-freeze)', async () => {
  const blocks = {
    '10,40,5': { name: 'iron_ore', position: { x: 10, y: 40, z: 5 } },
    '12,40,5': { name: 'iron_ore', position: { x: 12, y: 40, z: 5 } },
  };
  const bot = makeQuotaBot({ blocks });
  const origCollect = bot.collectBlock.collect;
  let first = true;
  bot.collectBlock.collect = async (b) => {
    if (first) { first = false; return new Promise(() => {}); }  // gèle pour TOUJOURS (1er + retry → 2 gels)
    return origCollect(b);
  };
  const events = [];
  const r = await runResource(bot, {
    memory: mem([
      { material: 'iron_ore', x: 10, y: 40, z: 5 },
      { material: 'iron_ore', x: 12, y: 40, z: 5 },
    ]),
    worldKey: 'overworld',
    emit: (e) => events.push(e),
    goto: async () => {},
    quota: { iron: 1 },
    collectTimeoutMs: 30,                              // gel borné à 30 ms en test
  });
  assert.equal(r.done, true);                          // a fini malgré le gel (cible suivante)
  assert.ok(collect(events, 'resource_failed').length >= 1 || bot._dug.length >= 1);
}); 

test('quota : sélection PLUS PROCHE d\'abord (pas diamant d\'abord) — réduit le voyage', async () => {
  const blocks = {
    '5,60,0': { name: 'iron_ore', position: { x: 5, y: 60, z: 0 } },
    '100,-55,0': { name: 'deepslate_diamond_ore', position: { x: 100, y: -55, z: 0 } },
  };
  const bot = makeQuotaBot({ blocks });
  const order = [];
  const r = await runResource(bot, {
    memory: mem([
      { material: 'deepslate_diamond_ore', x: 100, y: -55, z: 0 },
      { material: 'iron_ore', x: 5, y: 60, z: 0 },
    ]),
    worldKey: 'overworld',
    emit: (e) => { if (e.type === 'resource_target') order.push(e.material); },
    goto: async () => {},
    quota: { diamond: 1, iron: 1 },
  });
  assert.equal(r.done, true);
  assert.deepEqual(order, ['iron_ore', 'deepslate_diamond_ore']);  // le PROCHE d'abord
});

test('unreachable → skip de toute la veine (voisins ≤4 blocs), pas re-tentés', async () => {
  const blocks = { '50,40,0': { name: 'iron_ore', position: { x: 50, y: 40, z: 0 } } };
  const bot = makeQuotaBot({ blocks });
  const tried = [];
  const r = await runResource(bot, {
    memory: mem([
      { material: 'iron_ore', x: 10, y: 40, z: 0 },   // veine inatteignable…
      { material: 'iron_ore', x: 11, y: 41, z: 0 },   // …voisin (≤4) → skip groupé
      { material: 'iron_ore', x: 50, y: 40, z: 0 },   // loin → atteignable
    ]),
    worldKey: 'overworld',
    emit: () => {},
    goto: async (t) => { tried.push(`${t.x},${t.y},${t.z}`); if (t.x < 40) throw new Error('unreachable'); },
    quota: { iron: 1 },
  });
  assert.equal(r.done, true);
  const veinTried = tried.filter((t) => t === '10,40,0' || t === '11,41,0');
  assert.equal(veinTried.length, 1, `1 seul membre de la veine doit être tenté (${tried})`);
  assert.deepEqual(bot._dug, ['50,40,0']);
});

// ─── Phase 2 : minage réel anti-xray (mineFor / relocate / ensureGear) ───

test('phase2 : carte vide → mineFor(type le plus manquant minable), puis recount', async () => {
  const bot = makeQuotaBot({});
  const minedFor = [];
  const events = [];
  const r = await runResource(bot, {
    memory: mem([]),
    worldKey: 'overworld',
    emit: (e) => events.push(e),
    goto: async () => {},
    quota: { iron: 2, lapis: 1 },
    pickTier: () => 2,                                  // stone pick : fer et lapis minables
    sleep: async () => {},
    reloadMemory: () => mem([]),
    mineFor: async (t) => {
      minedFor.push(t);
      // simule la récolte : crédite l'inventaire
      bot._items.push({ name: t === 'iron' ? 'raw_iron' : 'lapis_lazuli', count: 2 });
      return { ok: true };
    },
  });
  assert.equal(r.done, true);
  assert.ok(minedFor.length >= 1);
  assert.ok(['iron', 'lapis'].includes(minedFor[0]));   // déficits égaux (100%) → l'un des deux
  assert.ok(events.some((e) => e.type === 'resource_mine_for'));
});

test('phase2 : manque tier 3 sans pioche fer → bootstrap mineFor(iron)', async () => {
  const bot = makeQuotaBot({ inv: [{ name: 'raw_iron', count: 64 }, { name: 'lapis_lazuli', count: 64 },
    { name: 'redstone', count: 64 }, { name: 'raw_gold', count: 15 }] });
  const minedFor = [];
  let calls = 0;
  const r = await runResource(bot, {
    memory: mem([]),
    worldKey: 'overworld',
    emit: () => {},
    goto: async () => {},
    quota: { diamond: 1, iron: 1 },                     // diamant manque, fer déjà servi
    pickTier: () => 2,                                  // PAS de pioche fer
    sleep: async () => {},
    reloadMemory: () => mem([]),
    mineFor: async (t) => {
      minedFor.push(t);
      if (++calls >= 2) bot._items.push({ name: 'diamond', count: 1 });  // fin du test
      return { ok: true };
    },
  });
  assert.equal(minedFor[0], 'iron');                    // bootstrap : miner du fer pour la pioche
  assert.equal(r.done, true);
});

test('phase3 : mineFor échoue ×2 → PAS de relocate (un timeout de descente = progrès conservé)', async () => {
  const bot = makeQuotaBot({});
  let relocated = 0;
  let fails = 0;
  const r = await runResource(bot, {
    memory: mem([]),
    worldKey: 'overworld',
    emit: () => {},
    goto: async () => {},
    quota: { iron: 1 },
    pickTier: () => 2,
    sleep: async () => {},
    reloadMemory: () => mem([]),
    mineFor: async () => {
      if (++fails <= 2) return { ok: false, reason: 'timeout' };
      bot._items.push({ name: 'raw_iron', count: 1 });
      return { ok: true };
    },
    relocate: async () => { relocated++; },
  });
  assert.equal(r.done, true);
  assert.equal(relocated, 0);                           // <3 échecs consécutifs → on insiste sur place
});

test('phase3 : mineFor échoue ×3 consécutifs → relocate + reset, puis reprise', async () => {
  const bot = makeQuotaBot({});
  let relocated = 0;
  let fails = 0;
  const r = await runResource(bot, {
    memory: mem([]),
    worldKey: 'overworld',
    emit: () => {},
    goto: async () => {},
    quota: { iron: 1 },
    pickTier: () => 2,
    sleep: async () => {},
    reloadMemory: () => mem([]),
    mineFor: async () => {
      if (++fails <= 3) return { ok: false, reason: 'lava' };
      bot._items.push({ name: 'raw_iron', count: 1 });
      return { ok: true };
    },
    relocate: async () => { relocated++; },
  });
  assert.equal(r.done, true);
  assert.equal(relocated, 1);                           // 3 échecs → 1 relocalisation, puis reprise
});

test('phase3 : pickTier 2 (pas de pioche fer) → le FER passe devant le lapis (bootstrap by design)', async () => {
  const bot = makeQuotaBot({});
  const minedFor = [];
  await runResource(bot, {
    memory: mem([]),
    worldKey: 'overworld',
    emit: () => {},
    goto: async () => {},
    quota: { lapis: 1, iron: 1 },                       // lapis AVANT iron dans l'ordre des clés
    pickTier: () => 2,
    sleep: async () => {},
    reloadMemory: () => mem([]),
    mineFor: async (t) => {
      minedFor.push(t);
      bot._items.push({ name: t === 'iron' ? 'raw_iron' : 'lapis_lazuli', count: 1 });
      return { ok: true };
    },
  });
  assert.equal(minedFor[0], 'iron');                    // fer d'abord tant que tier < 3
});

test('phase3 : SANS pioche (tier<2) + rien de minable → starved no_pickaxe rapide', async () => {
  const bot = makeQuotaBot({});
  const events = [];
  let t = 0;
  const r = await runResource(bot, {
    memory: mem([]),
    worldKey: 'overworld',
    emit: (e) => events.push(e),
    goto: async () => {},
    quota: { iron: 1 },
    pickTier: () => -1,                                 // aucune pioche (kit raté)
    sleep: async () => { t += 30000; },
    now: () => t,
    noPickMaxMs: 120000,
    maxIdleMs: 3600000,                                 // l'ancien chemin (10 min × relocations) ne doit PAS être nécessaire
    reloadMemory: () => mem([]),
    mineFor: async () => ({ ok: true }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'starved');
  assert.ok(events.some((e) => e.type === 'resource_starved' && e.why === 'no_pickaxe'));
});

test('phase2 : starvation sans mineFor → relocate (cap maxRelocations) puis starved', async () => {
  const bot = makeQuotaBot({});
  let relocated = 0;
  let t = 0;
  const r = await runResource(bot, {
    memory: mem([]),
    worldKey: 'overworld',
    emit: () => {},
    goto: async () => {},
    quota: { iron: 1 },
    sleep: async () => { t += 60000; },
    now: () => t,
    maxIdleMs: 120000,
    maxRelocations: 2,
    reloadMemory: () => mem([]),
    relocate: async () => { relocated++; },
  });
  assert.equal(relocated, 2);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'starved');
});

test('phase2 : ensureGear appelé avec les types manquants à chaque itération', async () => {
  const blocks = { '10,40,5': { name: 'iron_ore', position: { x: 10, y: 40, z: 5 } } };
  const bot = makeQuotaBot({ blocks });
  const gearCalls = [];
  const r = await runResource(bot, {
    memory: mem([{ material: 'iron_ore', x: 10, y: 40, z: 5 }]),
    worldKey: 'overworld',
    emit: () => {},
    goto: async () => {},
    quota: { iron: 1 },
    ensureGear: async (types) => { gearCalls.push([...types]); },
  });
  assert.equal(r.done, true);
  assert.ok(gearCalls.length >= 1);
  assert.deepEqual(gearCalls[0], ['iron']);
});

test('phase2 : ≥4 unreachable consécutifs → relocate (zone pourrie) + reset, puis reprise', async () => {
  const blocks = { '300,40,0': { name: 'iron_ore', position: { x: 300, y: 40, z: 0 } } };
  const bot = makeQuotaBot({ blocks });
  let relocated = 0;
  let calls = 0;
  const ores = [
    { material: 'iron_ore', x: 10, y: 40, z: 0 },
    { material: 'iron_ore', x: 20, y: 40, z: 10 },
    { material: 'iron_ore', x: 30, y: 40, z: 20 },
    { material: 'iron_ore', x: 40, y: 40, z: 30 },
    { material: 'iron_ore', x: 50, y: 40, z: 40 },
  ];
  const r = await runResource(bot, {
    memory: mem(ores),
    worldKey: 'overworld',
    emit: () => {},
    quota: { iron: 1 },
    sleep: async () => {},
    reloadMemory: () => mem([{ material: 'iron_ore', x: 300, y: 40, z: 0 }]),
    failRelocateAt: 4,
    maxTargetDist: 1000,
    goto: async (t) => {
      calls++;
      if (t.x < 200) throw new Error('unreachable');   // toute la zone de spawn est pourrie
      bot.entity.position = { x: t.x, y: t.y, z: t.z };
    },
    relocate: async () => { relocated++; bot.entity.position = { x: 290, y: 64, z: 0 }; },
  });
  assert.equal(relocated, 1, 'relocate après 4 échecs consécutifs');
  assert.equal(r.done, true);                          // après relocate + reload → cible saine minée
});

test('phase2 : cibles mappées au-delà de maxTargetDist ignorées → mineFor local', async () => {
  const bot = makeQuotaBot({});
  const minedFor = [];
  const r = await runResource(bot, {
    memory: mem([{ material: 'iron_ore', x: 5000, y: 40, z: 0 }]),   // l'autre bout de la carte
    worldKey: 'overworld',
    emit: () => {},
    goto: async () => { throw new Error('ne devrait jamais y aller'); },
    quota: { iron: 1 },
    pickTier: () => 2,
    sleep: async () => {},
    maxTargetDist: 200,
    reloadMemory: () => mem([{ material: 'iron_ore', x: 5000, y: 40, z: 0 }]),
    mineFor: async (t) => { minedFor.push(t); bot._items.push({ name: 'raw_iron', count: 1 }); return { ok: true }; },
  });
  assert.equal(r.done, true);
  assert.deepEqual(minedFor, ['iron']);                // mineFor local, pas de trek de 5000 blocs
});
