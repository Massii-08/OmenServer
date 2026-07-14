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

test('exposedOnly (Garantie B anti-xray) : l\'enterré mappé est IGNORÉ, seul l\'exposé est miné', async () => {
  const blocks = {
    '5,40,0': { name: 'diamond_ore', position: { x: 5, y: 40, z: 0 } },   // enterré (exposed:false)
    '20,40,0': { name: 'iron_ore', position: { x: 20, y: 40, z: 0 } },    // exposé
  };
  const bot = makeBot({ blocks });
  const events = [];
  const r = await runResource(bot, {
    memory: mem([
      { material: 'diamond_ore', x: 5, y: 40, z: 0, exposed: false },
      { material: 'iron_ore', x: 20, y: 40, z: 0, exposed: true },
    ]),
    worldKey: 'overworld',
    emit: (e) => events.push(e),
    goto: async () => {},
    exposedOnly: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.mined, 1, 'seul l\'exposé doit être miné');
  assert.deepEqual(bot._dug, ['20,40,0'], 'le diamant enterré ne doit JAMAIS être creusé');
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

test('quota : cible mappée dont le bloc n\'est PLUS un minerai (chargé) → ore_gone, jamais de strip-mine vers le vide (Massii 2026-06-22)', async () => {
  // Un diamant mappé à (5,-55,5) mais le bloc est de la deepslate (déjà miné par un autre bot/joueur).
  // Le bot doit le RETIRER de la carte (ore_gone) et NE PAS strip-miner (mineFor) vers cet emplacement vide.
  const blocks = { '5,-55,5': { name: 'deepslate', position: { x: 5, y: -55, z: 5 } } };
  const bot = makeQuotaBot({ blocks });
  const events = [];
  let mineForCalled = 0;
  const r = await runResource(bot, {
    memory: mem([{ material: 'deepslate_diamond_ore', x: 5, y: -55, z: 5, exposed: false, wet: false }]),
    worldKey: 'overworld',
    emit: (e) => events.push(e),
    goto: async () => {},
    quota: { diamond: 1 },
    mineFor: async () => { mineForCalled++; return { ok: true }; }, // sans le fix : appelé (deep-serpentine vers le vide)
    sleep: async () => {},
    maxIdleMs: -1,                                                  // plus de cible après pruning → starved tout de suite
    reloadMemory: () => mem([]),
  });
  const gone = collect(events, 'ore_gone');
  assert.equal(gone.length, 1, 'la cible périmée est retirée de la carte');
  assert.deepEqual({ x: gone[0].x, y: gone[0].y, z: gone[0].z }, { x: 5, y: -55, z: 5 });
  assert.equal(mineForCalled, 0, 'jamais de strip-mine vers un emplacement vide');
  assert.equal(r.mined, 0);
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

test('quota : NEAREST-FIRST quand PLUSIEURS types manquent (anti-ruée-diamant, live 22/06 supersede BUG PRIO 3.1)', async () => {
  // LIVE 22/06 (3 ResBots, monde dur) : forcer le diamant DEVANT les autres types tant que son quota
  // manque envoyait les 3 bots se RUER sur le diamant deepslate exposé en GROTTE (profond + souvent
  // humide). Le minage du diamant exposé en cave (mineExposed → cave-first → cave_meander) échoue très
  // souvent (pas de chemin sans creuser, eau, blocages) → le bot skip et re-vise un autre diamant, en
  // boucle → 0 minage, quota FIGÉ sur TOUS les types (diamant compris : 15/0/0 vécu). Les 1721 gold /
  // 2803 redstone exposés accessibles étaient ignorés.
  // Fix : nearest-first en mode quota (priority:[], retour à #42d) → on mine le minerai accessible le
  // plus proche parmi les types manquants → remplit 4/5 quotas vite ET fait DESCENDRE le bot en deep
  // (le strip-mine profond ramasse le diamant au passage, cf. commentaire resource.js). Quand SEUL le
  // diamant reste, allowTypes={diamond} le filtre déjà → focus diamant naturel sans priorité forcée
  // (préserve la préoccupation « 0💎 » du 16/06 : aucune autre cible ne détourne le bot).
  const blocks = {
    '5,-55,0': { name: 'iron_ore', position: { x: 5, y: -55, z: 0 } },
    '100,-55,0': { name: 'deepslate_diamond_ore', position: { x: 100, y: -55, z: 0 } },
  };
  const bot = makeQuotaBot({ blocks });
  const order = [];
  const r = await runResource(bot, {
    memory: mem([
      { material: 'deepslate_diamond_ore', x: 100, y: -55, z: 0 },  // deep mais LOIN
      { material: 'iron_ore', x: 5, y: -55, z: 0 },                 // deep et PROCHE
    ]),
    worldKey: 'overworld',
    emit: (e) => { if (e.type === 'resource_target') order.push(e.material); },
    goto: async () => {},
    quota: { diamond: 1, iron: 1 },
  });
  assert.equal(r.done, true);
  assert.equal(order[0], 'iron_ore', `nearest-first : le fer PROCHE d'abord, pas la ruée diamant (got ${order})`);
});

test('quota : revient au PLUS PROCHE quand le quota diamant est REMPLI (gold/fer/… nearest-first)', async () => {
  // Quand le diamant est déjà servi, plus de priorité diamant → nearest-first classique (réduit le
  // voyage pour les types restants). Garantit que la priorité diamant est bien GATÉE sur "unmet".
  const blocks = {
    '5,60,0': { name: 'iron_ore', position: { x: 5, y: 60, z: 0 } },
    '100,40,0': { name: 'gold_ore', position: { x: 100, y: 40, z: 0 } },
  };
  const bot = makeQuotaBot({ blocks, inv: [{ name: 'diamond', count: 1 }] });  // diamant déjà à 1/1
  const order = [];
  await runResource(bot, {
    memory: mem([
      { material: 'gold_ore', x: 100, y: 40, z: 0 },
      { material: 'iron_ore', x: 5, y: 60, z: 0 },
    ]),
    worldKey: 'overworld',
    emit: (e) => { if (e.type === 'resource_target') order.push(e.material); },
    goto: async () => {},
    quota: { diamond: 1, iron: 1, gold: 1 },
  });
  assert.equal(order[0], 'iron_ore', `proche d'abord quand diamant rempli (got ${order})`);
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

test('quota+mineFor : EAU live près d\'une cible NON-flaggée → ore_wet, veine sacrifiée (garde dure, point #3)', async () => {
  // Cible diamant SANS flag wet en mémoire (périmée) mais EAU réelle à 1 bloc → la garde live doit
  // l'abandonner (skip + voisins) : jamais l'eau, même un diamant (anti-noyade, décision Massii).
  const blocks = {
    '10,-50,5': { name: 'diamond_ore', position: { x: 10, y: -50, z: 5 } },
    '11,-50,5': { name: 'water', position: { x: 11, y: -50, z: 5 } },     // eau adjacente LIVE
  };
  const bot = makeQuotaBot({ blocks });
  const events = [];
  let t = 0;
  const r = await runResource(bot, {
    memory: mem([{ material: 'diamond_ore', x: 10, y: -50, z: 5 }]),       // PAS de wet flag (stale)
    worldKey: 'overworld',
    emit: (e) => events.push(e),
    goto: async () => {},
    quota: { diamond: 1 },
    sleep: async () => {},
    now: () => (t += 60000),
    maxIdleMs: 180000,
    deepQuotaY: 0,                                          // y=-50 < 0 → pas annulé par le deep-first
    mineFor: async () => ({ ok: false }),                  // pas de repli → starved (jamais de noyade)
    reloadMemory: () => mem([{ material: 'diamond_ore', x: 10, y: -50, z: 5 }]),
  });
  assert.ok(collect(events, 'ore_wet').some((e) => e.x === 10 && e.z === 5), 'ore_wet émis sur la cible noyée');
  assert.equal(collect(events, 'ore_mined').length, 0, 'la cible noyée n\'est JAMAIS minée');
  assert.equal(r.ok, false);                               // sacrifiée + pas de repli → starved (pas de noyade)
});

test('quota : diamant exposé PROFOND → cave-first (cave-hopping #1, plus de gate Δy ni de strip-mine)', async () => {
  const bot = makeQuotaBot({});                          // entity à y=64
  let caveCalled = 0, branchCalled = 0;
  const token = { cancelled: false };
  await runResource(bot, {
    memory: mem([{ material: 'diamond_ore', x: 5, y: -10, z: 5, exposed: true, wet: false }]), // profond MAIS exposé
    worldKey: 'overworld',
    emit: () => {},
    goto: async () => {},
    quota: { diamond: 1 },
    sleep: async () => {},
    mineExposed: async () => { caveCalled++; token.cancelled = true; },
    mineFor: async () => { branchCalled++; token.cancelled = true; return { ok: true }; },
  }, token);
  assert.ok(caveCalled >= 1, 'diamant exposé (même profond) → cave-first (le creusage serpentant reach)');
  assert.equal(branchCalled, 0, 'JAMAIS de strip-mine en grille pour le diamant (bug #1 Massii)');
});

test('quota : diamant ENTERRÉ (hors-grotte) → MINAGE PROFOND SERPENTIN (BUG PRIO 3.1, plus de skip)', async () => {
  // Résolution Massii 16/06 : quand les grottes ne donnent plus, on creuse les diamants enterrés au
  // VOLUME via une galerie SERPENTINE à y≈-58 (jamais une grille). L'ancien SKIP plafonnait le débit.
  const bot = makeQuotaBot({});                          // entity à y=64
  let caveCalled = 0, branchCalled = 0, deepEmitted = false, lastOpts = null;
  const token = { cancelled: false };
  const r = await runResource(bot, {
    memory: mem([{ material: 'diamond_ore', x: 5, y: -10, z: 5, exposed: false, wet: false }]), // ENTERRÉ
    worldKey: 'overworld',
    emit: (e) => { if (e.type === 'resource_deep_serpentine') deepEmitted = true; },
    goto: async () => {},
    quota: { diamond: 1 },
    sleep: async () => {},
    pickTier: () => 3,                                   // pioche diamant (tierNow=3)
    mineExposed: async () => { caveCalled++; },
    mineFor: async (mat, n, o) => { branchCalled++; lastOpts = o; token.cancelled = true; return { ok: true }; },
    reloadMemory: () => mem([{ material: 'diamond_ore', x: 5, y: -10, z: 5, exposed: false, wet: false }]),
  }, token);
  assert.ok(deepEmitted, 'event resource_deep_serpentine émis pour le diamant enterré');
  assert.ok(branchCalled >= 1, 'mineFor (minage profond) appelé pour le diamant enterré');
  assert.ok(lastOpts && lastOpts.serpentine === true, 'minage profond en mode SERPENTIN (pas de grille)');
  assert.equal(caveCalled, 0, 'pas de cave-first (pas exposé)');
});

test('quota : diamant EXPOSÉ PROFOND (y≤-30) → strip-mine DESCENDANT direct, PAS de cave-first (fix #5 live 22/06)', async () => {
  // FIX #5 : en deep, le cave-first sur un diamant exposé en grotte 1.18 galère → le bot oscille en
  // surface (relocate boucle) sans jamais atteindre -58 (vécu R1/R3 : 21 resource_cave, 0 deep_serpentine,
  // y5-8). Sous deepCaveCutoff (-30) on route DIRECT vers le deep-serpentine (mineFor force la descente).
  const bot = makeQuotaBot({});
  let caveCalled = 0, branchCalled = 0, lastOpts = null;
  const token = { cancelled: false };
  await runResource(bot, {
    memory: mem([{ material: 'deepslate_diamond_ore', x: 5, y: -55, z: 5, exposed: true, wet: false }]),
    worldKey: 'overworld',
    emit: () => {},
    goto: async () => {},
    quota: { diamond: 1 },
    sleep: async () => {},
    pickTier: () => 3,
    mineExposed: async () => { caveCalled++; throw new Error('cave_unreachable'); },
    mineFor: async (mat, n, o) => { branchCalled++; lastOpts = o; token.cancelled = true; return { ok: true }; },
    reloadMemory: () => mem([{ material: 'deepslate_diamond_ore', x: 5, y: -55, z: 5, exposed: true, wet: false }]),
  }, token);
  assert.equal(caveCalled, 0, 'PAS de cave-first en deep (fix #5 : strip descendant direct)');
  assert.ok(branchCalled >= 1, 'deep-serpentine (mineFor) appelé directement');
  assert.ok(lastOpts && lastOpts.serpentine === true, 'minage profond en mode SERPENTIN');
});

test('quota : ore NON-diamant EXPOSÉ dont le cave-first ÉCHOUE → REPLI strip-mine dirigé (live 22/06 ResBot1 baie)', async () => {
  // Asymétrie corrigée (resource.js) : un iron/lapis/redstone/gold exposé dont mineExposed (cave-first)
  // throw n'avait AUCUN repli (_rr={ok:false}) — seul le DIAMANT avait son deep-serpentine. → le bot
  // perdait jusqu'à 180 s par cible inatteignable (baie côtière, grotte sans chemin piéton), 0 minage
  // (vécu live ResBot1 : toutes cibles iron humides/inaccessibles → cave_meander en boucle). Désormais :
  // même repli que le diamant → strip-mine DIRIGÉ (mineFor heading) vers la cible (pas un beeline X-ray).
  // Cible SHALLOW (y=-20 > deepCaveCutoff -30) → le cave-first s'applique (le fix #5 ne route en
  // deep-serpentine que sous -30) ; on teste donc bien le repli cave_failed des ores exposés peu profonds.
  const bot = makeQuotaBot({});
  let caveCalled = 0, branchCalled = 0, regionFallback = false;
  const token = { cancelled: false };
  await runResource(bot, {
    memory: mem([{ material: 'iron_ore', x: 5, y: -20, z: 5, exposed: true, wet: false }]),
    worldKey: 'overworld',
    emit: (e) => { if (e.type === 'resource_region' && e.fallback === 'cave_failed') regionFallback = true; },
    goto: async () => {},
    quota: { iron: 1 },
    sleep: async () => {},
    pickTier: () => 2,                                   // pioche pierre (fer accessible)
    mineExposed: async () => { caveCalled++; throw new Error('cave_unreachable'); },
    mineFor: async (mat, n, o) => { branchCalled++; token.cancelled = true; return { ok: true }; },
    reloadMemory: () => mem([{ material: 'iron_ore', x: 5, y: -20, z: 5, exposed: true, wet: false }]),
  }, token);
  assert.ok(caveCalled >= 1, 'cave-first tenté en premier (ore SHALLOW exposé)');
  assert.ok(branchCalled >= 1, 'repli strip-mine dirigé après échec cave-first (plus d_abandon sec)');
  assert.ok(regionFallback, 'event resource_region fallback:cave_failed émis');
});

test('quota : redstone EXPOSÉ PROFOND (y≤-30) → deep-serpentine direct, jamais cave-first (fix #5)', async () => {
  // Non-diamant profond : même règle que le diamant → strip-mine descendant direct (le bot DESCEND à
  // Y_OPT puis branch-mine), au lieu de cave-first qui le laissait osciller en surface (vécu R1/R3 deep).
  const bot = makeQuotaBot({});
  let caveCalled = 0, branchCalled = 0, lastOpts = null, deepStrip = false;
  const token = { cancelled: false };
  await runResource(bot, {
    memory: mem([{ material: 'deepslate_redstone_ore', x: 5, y: -50, z: 5, exposed: true, wet: false }]),
    worldKey: 'overworld',
    emit: (e) => { if (e.type === 'resource_deep_serpentine' && e.fallback === 'deep_strip') deepStrip = true; },
    goto: async () => {},
    quota: { redstone: 1 },
    sleep: async () => {},
    pickTier: () => 3,
    mineExposed: async () => { caveCalled++; throw new Error('cave_unreachable'); },
    mineFor: async (mat, n, o) => { branchCalled++; lastOpts = o; token.cancelled = true; return { ok: true }; },
    reloadMemory: () => mem([{ material: 'deepslate_redstone_ore', x: 5, y: -50, z: 5, exposed: true, wet: false }]),
  }, token);
  assert.equal(caveCalled, 0, 'PAS de cave-first en deep (redstone)');
  assert.ok(branchCalled >= 1, 'deep-serpentine appelé directement');
  assert.ok(lastOpts && lastOpts.serpentine === true, 'mode SERPENTIN');
  assert.ok(deepStrip, 'event resource_deep_serpentine fallback:deep_strip émis pour non-diamant');
});

test('quota : TYPE deep (redstone) ciblé SHALLOW exposé → deep-serpentine quand même (fix #5b par type, live 22/06)', async () => {
  // R1/R3 ciblaient des redstone_ore SHALLOW (y0-16) exposés en cave-first (nearest-first les préfère car
  // proches) → restaient en surface, 0 descente. Pour un TYPE intrinsèquement deep (Y_OPT≤-40, passé via
  // deepStripTypes par index.js), on strip-mine TOUJOURS en profondeur même si la cible mappée est shallow
  // → le bot DESCEND au deepslate riche et le récolte au volume.
  const bot = makeQuotaBot({});
  let caveCalled = 0, branchCalled = 0, lastOpts = null;
  const token = { cancelled: false };
  await runResource(bot, {
    memory: mem([{ material: 'redstone_ore', x: 5, y: 10, z: 5, exposed: true, wet: false }]),  // SHALLOW exposé
    worldKey: 'overworld',
    emit: () => {},
    goto: async () => {},
    quota: { redstone: 1 },
    deepStripTypes: ['redstone'],                        // type deep (Y_OPT -58) → forcé en strip profond
    sleep: async () => {},
    pickTier: () => 3,
    mineExposed: async () => { caveCalled++; },
    mineFor: async (mat, n, o) => { branchCalled++; lastOpts = o; token.cancelled = true; return { ok: true }; },
    reloadMemory: () => mem([{ material: 'redstone_ore', x: 5, y: 10, z: 5, exposed: true, wet: false }]),
  }, token);
  assert.equal(caveCalled, 0, 'PAS de cave-first pour un type deep, même cible SHALLOW');
  assert.ok(branchCalled >= 1, 'deep-serpentine (mineFor) appelé → le bot descend');
  assert.ok(lastOpts && lastOpts.serpentine === true, 'mode SERPENTIN');
});

test('quota : carte VIDE + diamant manquant → MINAGE PROFOND SERPENTIN (Path B, BUG PRIO 3.1 live 16/06)', async () => {
  // Monde FRAIS (mémoire vide) : nextOreTarget ne retourne RIEN → Path B (branch-mine). AUCUNE grotte à
  // diamants mappée → le bot doit DESCENDRE deep-serpentine, PAS cave-hop-relocate en boucle EN SURFACE
  // (vécu live ResBot1 16/06 : resource_relocate cavehop_diamond n:1,2,3 sans jamais miner ni descendre).
  const bot = makeQuotaBot({});
  let branchCalled = 0, lastOpts = null, cavehopRelocates = 0, deepEmitted = false;
  const token = { cancelled: false };
  await runResource(bot, {
    memory: mem([]),                                      // CARTE VIDE (monde frais → aucune cible mappée)
    worldKey: 'overworld',
    emit: (e) => {
      if (e.type === 'resource_relocate' && e.cause === 'cavehop_diamond') cavehopRelocates++;
      if (e.type === 'resource_deep_serpentine') deepEmitted = true;
    },
    goto: async () => {},
    quota: { diamond: 1 },
    sleep: async () => {},
    pickTier: () => 3,                                    // pioche diamant (tierNow=3)
    relocate: async () => {},                             // dispo, mais NE doit PAS être cave-hop-bouclé
    mineExposed: async () => {},
    mineFor: async (mat, n, o) => { branchCalled++; lastOpts = o; token.cancelled = true; return { ok: true }; },
    reloadMemory: () => mem([]),
  }, token);
  assert.equal(cavehopRelocates, 0, 'PAS de cave-hop relocate quand AUCUNE grotte à diamants n\'est mappée');
  assert.ok(branchCalled >= 1, 'minage profond appelé (le bot DESCEND au lieu de warper en surface en boucle)');
  assert.ok(lastOpts && lastOpts.serpentine === true, 'minage profond en mode SERPENTIN (anti-grille)');
  assert.ok(deepEmitted, 'event resource_deep_serpentine émis');
});

test('quota : diamant exposé PROCHE (Δy≤24) → cave-first (rétro-compat G-bis)', async () => {
  const bot = makeQuotaBot({});                          // entity à y=64
  let caveCalled = 0;
  const token = { cancelled: false };
  await runResource(bot, {
    memory: mem([{ material: 'diamond_ore', x: 5, y: 60, z: 5, exposed: true, wet: false }]),  // Δy=4 → à portée
    worldKey: 'overworld',
    emit: () => {},
    goto: async () => {},
    quota: { diamond: 1 },
    sleep: async () => {},
    mineExposed: async () => { caveCalled++; token.cancelled = true; },
    mineFor: async () => { token.cancelled = true; return { ok: true }; },
  }, token);
  assert.ok(caveCalled >= 1, 'diamant exposé proche → cave-first (comportement G-bis préservé)');
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

test('§3.G : ore ENTERRÉ non-diamant (fer) mappé → mineFor DIRIGÉ (heading), ZÉRO beeline (le diamant = cave-hop, cf. test dédié)', async () => {
  const bot = makeQuotaBot({});
  let gotoCalls = 0;
  const mineForCalls = [];
  const events = [];
  await runResource(bot, {
    memory: mem([{ material: 'iron_ore', x: 40, y: -16, z: 20 }]),   // région mappée enterrée PROFONDE (fer → strip-mine dirigé)
    worldKey: 'overworld',
    emit: (e) => events.push(e),
    goto: async () => { gotoCalls++; },                              // NE DOIT PAS être appelé
    quota: { iron: 1 },
    pickTier: () => 3,
    sleep: async () => {},
    reloadMemory: () => mem([]),
    mineFor: async (t, n, o) => {
      mineForCalls.push({ t, heading: o && o.heading });
      bot._items.push({ name: 'raw_iron', count: 1 });               // crédite → quota_done
      return { ok: true };
    },
  });
  assert.equal(gotoCalls, 0, 'AUCUN goto direct sur le bloc mappé (pas de beeline X-ray)');
  assert.ok(mineForCalls.length >= 1, 'mineFor (strip-mining dirigé) appelé');
  assert.equal(mineForCalls[0].t, 'iron_ore');
  assert.ok(mineForCalls[0].heading && typeof mineForCalls[0].heading.dx === 'number',
    'mineFor reçoit un heading (cap vers la région, pas une cible exacte)');
  assert.ok(events.some((e) => e.type === 'resource_region'), 'émet resource_region (direction, pas beeline)');
  assert.ok(!events.some((e) => e.type === 'ore_approach'), 'pas d\'ore_approach (le beeline est désactivé en quota)');
});

test('G-bis : diamant EXPOSÉ à PORTÉE de marche → mineExposed (grotte: goto+floodFill), PAS mineFor strip', async () => {
  const bot = makeQuotaBot({});                                                 // bot à y=64
  const mineExposedCalls = [];
  const mineForCalls = [];
  const events = [];
  await runResource(bot, {
    memory: mem([{ material: 'diamond', x: 30, y: 60, z: 10, exposed: true }]),  // exposé en grotte, Δy=4 (à portée, bug #4)
    worldKey: 'overworld',
    emit: (e) => events.push(e),
    goto: async () => {},
    quota: { diamond: 1 },
    pickTier: () => 3,
    sleep: async () => {},
    reloadMemory: () => mem([]),
    mineFor: async (t) => { mineForCalls.push(t); return { ok: true }; },
    mineExposed: async (t) => { mineExposedCalls.push(t); bot._items.push({ name: 'diamond', count: 1 }); },
  });
  assert.equal(mineExposedCalls.length, 1, 'mineExposed appelé pour le diamant exposé (minage grotte)');
  assert.equal(mineForCalls.length, 0, 'mineFor (strip-mine -58) PAS appelé pour un exposé');
  assert.ok(events.some((e) => e.type === 'resource_cave'), 'émet resource_cave (minage en grotte)');
  assert.ok(!events.some((e) => e.type === 'resource_region'), 'pas de resource_region (exposé = grotte, pas strip dirigé)');
});
