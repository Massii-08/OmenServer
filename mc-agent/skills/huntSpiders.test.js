'use strict';
// CHASSE À LA FICELLE — le maillon manquant de la chaîne nourriture (run world_mn15, 18/08).
// La pêche est le seul plan qui ne s'épuise pas, mais elle exige une canne, donc 2 FICELLES
// (`no_rod` ×444 mesurés pendant que 4 bots blindés mouraient de faim). La ficelle ne se ramasse
// pas : elle se prend sur l'araignée. Ce skill est la pince entre les deux — borné, annulable,
// et qui LÂCHE PRISE dès que la survie dit de décrocher.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const vec3 = require('vec3');
const { huntSpiders, nearestSpider, SPIDERS } = require('./huntSpiders');

const ARMOR = [null, null, null, null, null,
  { name: 'iron_helmet' }, { name: 'iron_chestplate' }, { name: 'iron_leggings' }, { name: 'iron_boots' }];

function mob(name, x, kind = 'Hostile mobs') {
  return { name, kind, type: 'mob', position: vec3(x, 64, 0), isValid: true };
}

function spiderBot({ mobs = [], items = [['iron_sword', 1]], health = 20, food = 20, armored = true } = {}) {
  const calls = { attack: [], equip: [], loot: [], goto: [], stop: 0 };
  const inv = items.map(([name, count]) => ({ name, count }));
  const bot = {
    entity: { position: vec3(0, 64, 0) },
    entities: Object.fromEntries(mobs.map((m, i) => [i, m])),
    health,
    food,
    inventory: { items: () => inv.slice(), slots: armored ? ARMOR : [] },
    nearestEntity(fn) {
      let best = null, bestD = Infinity;
      for (const e of Object.values(this.entities)) {
        if (!fn(e)) continue;
        const d = e.position.distanceTo(this.entity.position);
        if (d < bestD) { bestD = d; best = e; }
      }
      return best;
    },
    equip: async (it) => { calls.equip.push(it.name); },
    pvp: {
      attack: (e) => { calls.attack.push(e.name); calls.target = e; },
      stop: () => { calls.stop++; },
    },
    pathfinder: { goto: async () => {} },
  };
  // simule le ramassage : la ficelle arrive dans l'inventaire
  const addString = (n) => {
    const s = inv.find((i) => i.name === 'string');
    if (s) s.count += n; else inv.push({ name: 'string', count: n });
  };
  const addMob = (m) => { bot.entities[Object.keys(bot.entities).length + 100] = m; };
  return { bot, calls, inv, addString, addMob };
}

// deps par défaut : le butin rapporte `drop` ficelles ; `sleep` ne tue rien (à surcharger).
function deps({ drop = 2, calls, addString, extra = {} } = {}) {
  return Object.assign({
    sleep: async () => {},
    loot: async (o) => { calls.loot.push(o); addString(drop); return 1; },
    emit: () => {},
  }, extra);
}
// La proie ATTAQUÉE meurt au 1er battement — et elle seule (les autres restent chassables).
const killTarget = (calls) => async () => { if (calls.target) calls.target.isValid = false; };

describe('huntSpiders (la ficelle qui débloque la pêche)', () => {
  it('tue l\'araignée la plus proche, épée équipée, ramasse le butin, compte la ficelle', async () => {
    const near = mob('spider', 5); const far = mob('spider', 20);
    const { bot, calls, addString } = spiderBot({ mobs: [far, near] });
    const r = await huntSpiders(bot, deps({
      calls, addString,
      extra: { sleep: async () => { near.isValid = false; } },
    }), { count: 2 });
    assert.equal(r.ok, true);
    assert.equal(r.strings, 2);
    assert.equal(r.kills, 1);
    assert.equal(r.reason, 'target');              // la ficelle suffit → on n'en tue pas plus
    assert.deepEqual(calls.attack, ['spider']);
    assert.deepEqual(calls.equip, ['iron_sword']); // JAMAIS au poing (1 dégât contre 5)
    assert.equal(calls.loot.length, 1);            // le drop reste au sol sans ce balayage
  });

  it('s\'arrête dès que la ficelle SUFFIT, sans épuiser le compteur de kills', async () => {
    const a = mob('spider', 4); const b = mob('spider', 6);
    const { bot, calls, addString } = spiderBot({ mobs: [a, b] });
    const r = await huntSpiders(bot, deps({
      calls, addString, drop: 2, extra: { sleep: killTarget(calls) },
    }), { count: 4, targetStrings: 2 });
    assert.equal(r.kills, 1);
    assert.equal(r.reason, 'target');
    assert.equal(calls.attack.length, 1);
  });

  it('un drop maigre (0-2 par araignée) → enchaîne jusqu\'au compte, rend ce qu\'il a', async () => {
    const a = mob('spider', 4); const b = mob('spider', 6);
    const { bot, calls, addString } = spiderBot({ mobs: [a, b] });
    const r = await huntSpiders(bot, deps({
      calls, addString, drop: 0,                    // rien ne tombe : ça arrive
      extra: { sleep: killTarget(calls) },
    }), { count: 2, targetStrings: 2 });
    assert.equal(r.kills, 2);
    assert.equal(r.strings, 0);
    assert.equal(r.ok, false);                      // « ok » = on ramène de la ficelle, pas des cadavres
    assert.equal(r.reason, 'count');
  });

  it('cave_spider IGNORÉ (venimeux) — on ne chasse que l\'araignée commune', async () => {
    const { bot, calls, addString } = spiderBot({ mobs: [mob('cave_spider', 3)] });
    const r = await huntSpiders(bot, deps({ calls, addString }), { count: 1 });
    assert.equal(r.reason, 'no_spider');
    assert.equal(calls.attack.length, 0);
    assert.equal(SPIDERS.has('spider'), true);
    assert.equal(SPIDERS.has('cave_spider'), false);
  });

  it('aucune araignée / trop loin → sortie propre, zéro attaque', async () => {
    const { bot, calls, addString } = spiderBot({ mobs: [mob('spider', 60)] });
    const r = await huntSpiders(bot, deps({ calls, addString }), { count: 1, maxDistance: 24 });
    assert.equal(r.ok, false);
    assert.equal(r.strings, 0);
    assert.equal(r.reason, 'no_spider');
    assert.equal(calls.attack.length, 0);
  });

  it('la survie PRIME : creeper à côté → on décroche AVANT d\'engager', async () => {
    const { bot, calls, addString } = spiderBot({ mobs: [mob('spider', 5), mob('creeper', 4)] });
    const r = await huntSpiders(bot, deps({ calls, addString }), { count: 1 });
    assert.equal(r.reason, 'flee');
    assert.equal(calls.attack.length, 0);           // aucune ficelle ne vaut une explosion
  });

  it('la survie PRIME AUSSI en plein combat : la meute arrive → on lâche prise', async () => {
    const sp = mob('spider', 5);
    const { bot, calls, addString, addMob } = spiderBot({ mobs: [sp] });
    let polls = 0;
    const r = await huntSpiders(bot, deps({
      calls, addString,
      extra: {
        sleep: async () => { if (++polls === 1) { addMob(mob('zombie', 3)); addMob(mob('skeleton', 4)); } },
      },
    }), { count: 1 });
    assert.equal(r.reason, 'flee');
    assert.equal(calls.attack.length, 1);           // engagé, puis décroché
    assert.ok(calls.stop >= 1, 'doit couper le pvp en partant');
  });

  it('PV bas → on ne chasse pas du tout (la faim tue moins vite qu\'une araignée)', async () => {
    const { bot, calls, addString } = spiderBot({ mobs: [mob('spider', 5)], health: 4 });
    const r = await huntSpiders(bot, deps({ calls, addString }), { count: 1 });
    assert.equal(r.reason, 'flee');
    assert.equal(calls.attack.length, 0);
  });

  it('araignée qui survit au délai de mise à mort → sortie propre, pas d\'acharnement', async () => {
    const tough = mob('spider', 5);
    const { bot, calls, addString } = spiderBot({ mobs: [tough] });
    const r = await huntSpiders(bot, deps({ calls, addString }), { count: 3, killTimeoutMs: 1 });
    assert.equal(r.kills, 0);
    assert.equal(r.reason, 'kill_timeout');
    assert.equal(calls.attack.length, 1);           // une seule tentative, pas trois
    assert.ok(calls.stop >= 1);
  });

  it('token annulé → sort immédiatement (une tâche plus urgente a la main)', async () => {
    const sp = mob('spider', 5);
    const { bot, calls, addString } = spiderBot({ mobs: [sp] });
    const token = { cancelled: false };
    const r = await huntSpiders(bot, deps({
      calls, addString,
      extra: { sleep: async () => { token.cancelled = true; } },
    }), { count: 5, token });
    assert.equal(r.reason, 'cancelled');
    assert.ok(calls.attack.length <= 1);
  });

  it('token déjà annulé avant l\'appel → zéro action', async () => {
    const { bot, calls, addString } = spiderBot({ mobs: [mob('spider', 5)] });
    const r = await huntSpiders(bot, deps({ calls, addString }), { count: 2, token: { cancelled: true } });
    assert.equal(r.reason, 'cancelled');
    assert.equal(calls.attack.length, 0);
  });

  it('budget total épuisé → timeout, jamais de chasse qui s\'éternise (piège #47d)', async () => {
    const { bot, calls, addString } = spiderBot({ mobs: [mob('spider', 5)] });
    const r = await huntSpiders(bot, deps({ calls, addString }), { count: 3, totalMs: 0 });
    assert.equal(r.reason, 'timeout');
    assert.equal(calls.attack.length, 0);
  });

  it('budget épuisé EN COURS de chasse → s\'arrête entre deux araignées', async () => {
    const a = mob('spider', 4); const b = mob('spider', 6);
    const { bot, calls, addString } = spiderBot({ mobs: [a, b] });
    let t = 0;
    const r = await huntSpiders(bot, deps({
      calls, addString, drop: 0,
      extra: {
        now: () => t,
        sleep: async () => { t += 30000; if (calls.target) calls.target.isValid = false; },
      },
    }), { count: 5, totalMs: 20000 });
    assert.equal(r.kills, 1);
    assert.equal(r.reason, 'timeout');
    assert.equal(calls.attack.length, 1);
  });

  it('sans balayage de butin injecté → repli sur un déplacement vers le cadavre (best-effort)', async () => {
    const sp = mob('spider', 5);
    const { bot, calls, addString } = spiderBot({ mobs: [sp] });
    const gotos = [];
    const r = await huntSpiders(bot, {
      sleep: async () => { sp.isValid = false; },
      goto: async (p) => { gotos.push(p); addString(2); },
      emit: () => {},
    }, { count: 1 });
    assert.equal(r.kills, 1);
    assert.equal(r.strings, 2);
    assert.equal(gotos.length, 1);
    assert.equal(gotos[0].x, 5);
    assert.equal(calls.loot.length, 0);
  });

  it('UN SEUL événement string_hunt par tentative, avec le compte réel', async () => {
    const a = mob('spider', 4); const b = mob('spider', 6);
    const { bot, calls, addString } = spiderBot({ mobs: [a, b] });
    const events = [];
    await huntSpiders(bot, deps({
      calls, addString, drop: 1,
      extra: { emit: (e) => events.push(e), sleep: killTarget(calls) },
    }), { count: 2, targetStrings: 2 });
    const hunts = events.filter((e) => e.type === 'string_hunt');
    assert.equal(hunts.length, 1, 'pas de spam : une trace par tentative');
    assert.equal(hunts[0].kills, 2);
    assert.equal(hunts[0].strings, 2);
    assert.equal(hunts[0].reason, 'target');
  });

  it('un échec parle aussi (le silence est un bug, #55a)', async () => {
    const { bot, calls, addString } = spiderBot({ mobs: [] });
    const events = [];
    await huntSpiders(bot, deps({ calls, addString, extra: { emit: (e) => events.push(e) } }), { count: 1 });
    const hunts = events.filter((e) => e.type === 'string_hunt');
    assert.equal(hunts.length, 1);
    assert.equal(hunts[0].reason, 'no_spider');
    assert.equal(hunts[0].strings, 0);
  });

  it('bot sans API de combat → échec net, jamais de crash', async () => {
    const { bot, calls, addString } = spiderBot({ mobs: [mob('spider', 5)] });
    delete bot.pvp;
    const r = await huntSpiders(bot, deps({ calls, addString }), { count: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_pvp');
  });

  it('un balayage de butin qui échoue ne fait pas tomber la chasse', async () => {
    const sp = mob('spider', 5);
    const { bot, calls } = spiderBot({ mobs: [sp] });
    const r = await huntSpiders(bot, {
      sleep: async () => { sp.isValid = false; },
      loot: async () => { throw new Error('inatteignable'); },
      emit: () => {},
    }, { count: 1 });
    assert.equal(r.kills, 1);
    assert.equal(r.strings, 0);
    assert.equal(calls.stop >= 1, true);
  });
});

describe('nearestSpider', () => {
  it('rend l\'araignée commune la plus proche dans le rayon', () => {
    const { bot } = spiderBot({ mobs: [mob('spider', 9), mob('spider', 3), mob('cave_spider', 1)] });
    const s = nearestSpider(bot, 24);
    assert.equal(s.name, 'spider');
    assert.equal(s.position.x, 3);
  });
  it('ignore les mortes et celles hors rayon', () => {
    const dead = mob('spider', 2); dead.isValid = false;
    const { bot } = spiderBot({ mobs: [dead, mob('spider', 40)] });
    assert.equal(nearestSpider(bot, 24), null);
  });
  it('bot sans position → null (jamais d\'exception)', () => {
    assert.equal(nearestSpider({}, 24), null);
  });
});
