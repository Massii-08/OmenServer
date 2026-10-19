'use strict';
// Abri nocturne (survie kit) : détection nuit pure + flow creuser/attendre/sortir.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isNightTime } = require('../skills/shelter');

describe('isNightTime (pur)', () => {
  it('jour (0, 6000, 12000) → false ; nuit (13000, 18000, 23000) → true', () => {
    for (const t of [0, 6000, 12000, 23800]) assert.equal(isNightTime(t), false, `t=${t}`);
    for (const t of [13000, 18000, 23000]) assert.equal(isNightTime(t), true, `t=${t}`);
  });
  it('wrap 24000 + null-safe', () => {
    assert.equal(isNightTime(24000 + 18000), true);
    assert.equal(isNightTime(null), false);
    assert.equal(isNightTime(undefined), false);
  });
});

// ─── PLAN B : se murer quand creuser est impossible (mesure live world_ax4, 25/07) ──
// 40 % des abris échouaient : void_below 19, dig_failed 17, danger_below 9. Or un abri raté =
// une nuit ENTIÈRE à découvert, tous mobs confondus (squelette 52 morts, zombie 23, creeper 17).
// Creuser n'est pas la seule mise à l'abri : un vrai joueur se boxe avec ce qu'il a.
const { shelterUntilDawn } = require('../skills/shelter');
const { Vec3 } = require('vec3');

function nightBot() {
  return {
    time: { timeOfDay: 13000 },            // nuit → la boucle d'attente s'arme
    entity: { position: { floored: () => ({ x: 0, y: 64, z: 0, offset: () => ({ x: 0, y: 66, z: 0 }), plus: () => ({ x: 1, y: 64, z: 0 }) }) } },
    inventory: { items: () => [] },
    blockAt: () => null,
    dig: async () => {},
    equip: async () => {},
    placeBlock: async () => {},
  };
}

describe('abri : plan B « se murer »', () => {
  it('creuser impossible (void_below) + blocs dispo → SE MURE au lieu d\'abandonner', async () => {
    const events = [];
    const bot = nightBot();
    bot.time.timeOfDay = 1000;             // jour : on ne bloque pas sur l'attente
    const r = await shelterUntilDawn(bot, null, {
      emit: (e) => events.push(e),
      sleep: async () => {},
      mineDown: async () => ({ ok: false, reason: 'void_below' }),
      wallIn: async () => ({ ok: true, placed: 6 }),
    });
    assert.equal(r.ok, true, 'l\'abri doit réussir par le mur');
    const walled = events.find((e) => e.action === 'walled_in');
    assert.ok(walled, 'event walled_in attendu');
    assert.equal(walled.after, 'void_below', 'la raison du creusage raté est tracée');
    assert.equal(events.some((e) => e.action === 'abort'), false, 'plus d\'abandon');
  });

  it('creuser impossible ET murer impossible → abandon (comportement d\'origine)', async () => {
    const events = [];
    const bot = nightBot();
    bot.time.timeOfDay = 1000;
    const r = await shelterUntilDawn(bot, null, {
      emit: (e) => events.push(e),
      sleep: async () => {},
      mineDown: async () => ({ ok: false, reason: 'dig_failed' }),
      wallIn: async () => ({ ok: false, reason: 'no_block' }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'dig_failed');
    assert.ok(events.some((e) => e.action === 'abort'));
  });

  it('sortie d\'un abri MURÉ : on perce une paroi, pas de pilier', async () => {
    const events = [];
    const bot = nightBot();
    bot.time.timeOfDay = 1000;
    await shelterUntilDawn(bot, null, {
      emit: (e) => events.push(e),
      sleep: async () => {},
      mineDown: async () => ({ ok: false, reason: 'void_below' }),
      wallIn: async () => ({ ok: true, placed: 4 }),
    });
    const out = events.find((e) => e.action === 'out');
    assert.equal(out.mode, 'walled', 'un bot muré au sol n\'a pas de trou à remonter');
  });
});

// ─── L'AUBE N'EST PAS LA FIN DES MONSTRES (live 19/10, spawn sous la canopée d'une vieille forêt) ──
// Mesuré : 14 des 17 morts des 10 dernières minutes = « shot by Skeleton », toujours la séquence
//   shelter dig_in → shelter dawn → shelter out → goal logs → reflex fight_ranged → reflex flee →
//   take_cover placed:0 ok:false → mort.
// L'abri sortait dès que `isNight` devenait faux. À l'ombre d'une canopée, zombies et squelettes ne
// brûlent PAS au lever du jour : les monstres de la nuit attendent dehors. Étape 3bis : tant qu'un
// hostile est à portée ET que le bot est nu, on RESTE (re-vérifié toutes les 3 s, borne dure 120 s —
// vitesse : rien ne doit traîner).

// Abri muré (pas de pilier réel à jouer) ; l'horloge de test = le sleep injecté (instantané).
function dawnHarness(over = {}) {
  const events = [];
  const sleeps = [];
  const deps = {
    emit: (e) => events.push(e),
    sleep: async (ms) => { sleeps.push(ms); },
    mineDown: async () => ({ ok: false, reason: 'void_below' }),
    wallIn: async () => ({ ok: true, placed: 4 }),
    ...over,
  };
  const bot = nightBot();
  bot.time.timeOfDay = 1000;               // le jour s'est levé : la boucle de nuit est déjà finie
  return { bot, deps, events, sleeps };
}
const actions = (events) => events.map((e) => e.action);

describe('abri : attente à l\'aube tant que des monstres rôdent (étape 3bis)', () => {
  it('nu + hostiles dehors à l\'aube → RESTE dans l\'abri, re-vérifie toutes les 3 s, sort quand c\'est dégagé', async () => {
    let reads = 0;
    const { bot, deps, events, sleeps } = dawnHarness({
      hostilesNear: () => (++reads <= 5 ? 3 : 0),     // 5 relevés avec 3 hostiles, puis dégagé
      worn: () => 0,
    });
    const r = await shelterUntilDawn(bot, null, deps);
    assert.equal(r.ok, true);
    assert.deepEqual(sleeps, [3000, 3000, 3000, 3000, 3000], 'un relevé toutes les 3 s');
    assert.equal(reads, 6, 'relu à CHAQUE pas, jamais mis en cache : 5 « il y en a » + le « dégagé »');
    const waits = events.filter((e) => e.action === 'dawn_wait');
    assert.equal(waits.length, 1, 'UN seul event à la sortie de l\'attente, pas un par tick');
    assert.equal(waits[0].type, 'shelter');
    assert.equal(waits[0].hostiles, 3);
    assert.equal(waits[0].waited_s, 15);
    assert.equal(waits[0].reason, 'clear');
    assert.equal(waits[0].hostiles_left, 0);
    // la séquence qui tuait : dawn → (maintenant) dawn_wait → out. Jamais « out » avant la fin de l'attente.
    const order = actions(events);
    assert.ok(order.indexOf('dawn') < order.indexOf('dawn_wait'), `dawn avant dawn_wait : ${order}`);
    assert.ok(order.indexOf('dawn_wait') < order.indexOf('out'), `dawn_wait avant out : ${order}`);
  });

  it('les monstres ne partent JAMAIS (canopée) → borne dure de 120 s, puis on sort quand même', async () => {
    const { bot, deps, events, sleeps } = dawnHarness({ hostilesNear: () => 2, worn: () => 0 });
    const r = await shelterUntilDawn(bot, null, deps);
    assert.equal(r.ok, true, 'on sort : la vitesse prime sur la prudence au-delà de la borne');
    assert.equal(sleeps.length, 40, '120 s / 3 s = 40 relevés, pas un de plus (boucle bornée même avec un sleep instantané)');
    const w = events.filter((e) => e.action === 'dawn_wait');
    assert.equal(w.length, 1);
    assert.equal(w[0].waited_s, 120);
    assert.equal(w[0].reason, 'timeout');
    assert.equal(w[0].hostiles, 2);
    assert.equal(w[0].hostiles_left, 2);
    assert.ok(actions(events).includes('out'), 'et il ressort bel et bien');
  });

  it('ARMÉ (≥2 pièces) → sort tout de suite, comme avant : aucune attente, aucun event', async () => {
    let reads = 0;
    const { bot, deps, events, sleeps } = dawnHarness({ hostilesNear: () => { reads++; return 4; }, worn: () => 3 });
    await shelterUntilDawn(bot, null, deps);
    assert.deepEqual(sleeps, []);
    assert.equal(events.some((e) => e.action === 'dawn_wait'), false);
    assert.ok(actions(events).includes('out'));
    assert.ok(reads <= 1, 'au plus UN relevé : un bot armé ne s\'attarde pas à compter les monstres');
  });

  it('aucun hostile à l\'aube → sort tout de suite, aucune attente, aucun event', async () => {
    const { bot, deps, events, sleeps } = dawnHarness({ hostilesNear: () => 0, worn: () => 0 });
    await shelterUntilDawn(bot, null, deps);
    assert.deepEqual(sleeps, []);
    assert.equal(events.some((e) => e.action === 'dawn_wait'), false);
    assert.ok(actions(events).includes('out'));
  });

  it('prédicat NON injecté → comportement d\'origine à l\'identique (aucune attente, aucun event de plus)', async () => {
    const { bot, deps, events, sleeps } = dawnHarness();
    const r = await shelterUntilDawn(bot, null, deps);
    assert.equal(r.ok, true);
    assert.deepEqual(sleeps, []);
    // la séquence EXACTE d'avant l'étape 3bis : on ne rajoute aucun event à qui ne l'a pas demandé — sauf la
    // ligne `sealed` (19/10 soir), UNE par abri, la mesure live du taux de cellules fermées
    assert.deepEqual(actions(events), ['dig_in', 'walled_in', 'no_roof', 'sealed', 'dawn', 'out']);
  });

  it('le relevé d\'hostiles qui LÈVE = « aucun » (on ne reste jamais coincé dans le trou sur une erreur)', async () => {
    const { bot, deps, events, sleeps } = dawnHarness({ hostilesNear: () => { throw new Error('entities'); }, worn: () => 0 });
    const r = await shelterUntilDawn(bot, null, deps);
    assert.equal(r.ok, true);
    assert.deepEqual(sleeps, []);
    assert.ok(actions(events).includes('out'));
  });

  it('l\'armure arrive PENDANT l\'attente → on sort (raison « armed »)', async () => {
    let worn = 0;
    const { bot, deps, events, sleeps } = dawnHarness({ hostilesNear: () => 3, worn: () => worn });
    deps.sleep = async (ms) => { sleeps.push(ms); if (sleeps.length === 2) worn = 2; };
    await shelterUntilDawn(bot, null, deps);
    assert.equal(sleeps.length, 2);
    const w = events.find((e) => e.action === 'dawn_wait');
    assert.equal(w.reason, 'armed');
    assert.equal(w.waited_s, 6);
  });

  it('annulé PENDANT l\'attente → {ok:false, reason:cancelled}, on ne sort PAS du trou, l\'event le trace', async () => {
    const token = { cancelled: false };
    const { bot, deps, events, sleeps } = dawnHarness({ hostilesNear: () => 2, worn: () => 0 });
    deps.sleep = async (ms) => { sleeps.push(ms); if (sleeps.length === 2) token.cancelled = true; };
    const r = await shelterUntilDawn(bot, token, deps);
    assert.deepEqual(r, { ok: false, reason: 'cancelled' });
    assert.equal(actions(events).includes('out'), false, 'annulé = pas de sortie : le nouveau maître de la tâche décide');
    const w = events.filter((e) => e.action === 'dawn_wait');
    assert.equal(w.length, 1);
    assert.equal(w[0].reason, 'cancelled');
  });

  it('le jour se lève PENDANT la nuit d\'attente : la boucle de nuit finit, PUIS l\'attente des monstres commence', async () => {
    const { bot, deps, events, sleeps } = dawnHarness({ hostilesNear: (() => { let n = 0; return () => (++n <= 2 ? 1 : 0); })(), worn: () => 0 });
    bot.time.timeOfDay = 13000;                              // pleine nuit
    deps.sleep = async (ms) => { sleeps.push(ms); if (ms === 5000) bot.time.timeOfDay = 1000; };   // 1er pas de nuit : l'aube
    await shelterUntilDawn(bot, null, deps);
    assert.deepEqual(sleeps, [5000, 3000, 3000], 'un pas de nuit (5 s) puis deux relevés de monstres (3 s)');
    const order = actions(events);
    assert.ok(order.indexOf('dawn') < order.indexOf('dawn_wait') && order.indexOf('dawn_wait') < order.indexOf('out'), String(order));
  });

  it('abri CREUSÉ (pas muré) : même attente avant de remonter en pilier', async () => {
    const { bot, deps, events, sleeps } = dawnHarness({
      mineDown: async () => ({ ok: true }),
      hostilesNear: (() => { let n = 0; return () => (++n <= 3 ? 2 : 0); })(),
      worn: () => 1,
    });
    await shelterUntilDawn(bot, null, deps);
    assert.equal(sleeps.length, 3);
    const order = actions(events);
    assert.ok(order.indexOf('dawn_wait') < order.indexOf('out'), String(order));
    assert.equal(events.find((e) => e.action === 'out').mode, undefined, 'sortie par pilier, pas par paroi');
  });

  it('borne en TEMPS RÉEL : si les sleeps durent plus que prévu (process qui rame), 120 s restent 120 s', async () => {
    const realNow = Date.now;
    let clock = 1_700_000_000_000;
    Date.now = () => clock;
    try {
      const { bot, deps, events, sleeps } = dawnHarness({ hostilesNear: () => 2, worn: () => 0 });
      deps.sleep = async (ms) => { sleeps.push(ms); clock += 10000; };      // chaque « 3 s » en dure 10 (serveur qui lag)
      await shelterUntilDawn(bot, null, deps);
      assert.equal(sleeps.length, 12, 'coupé à 120 s d\'horloge murale, pas à 40 relevés (= 400 s réelles)');
      const w = events.find((e) => e.action === 'dawn_wait');
      assert.equal(w.reason, 'timeout');
      assert.equal(w.waited_s, 120);
    } finally { Date.now = realNow; }
  });

  it('borne et pas injectables (deps.dawnWaitMaxMs / deps.dawnCheckMs) — pour que les tests ne dépendent pas de 120 s', async () => {
    const { bot, deps, events, sleeps } = dawnHarness({ hostilesNear: () => 1, worn: () => 0, dawnWaitMaxMs: 10000, dawnCheckMs: 2000 });
    await shelterUntilDawn(bot, null, deps);
    assert.deepEqual(sleeps, [2000, 2000, 2000, 2000, 2000]);
    assert.equal(events.find((e) => e.action === 'dawn_wait').waited_s, 10);
  });

  it('worn NON injecté → lu sur l\'inventaire du bot (slots 5-8) : 2 pièces portées = armé = pas d\'attente', async () => {
    const piece = { name: 'iron_helmet' };
    const armed = dawnHarness({ hostilesNear: () => 3 });
    armed.bot.inventory.slots = [null, null, null, null, null, piece, piece, null, null];
    await shelterUntilDawn(armed.bot, null, armed.deps);
    assert.deepEqual(armed.sleeps, []);

    const nude = dawnHarness({ hostilesNear: (() => { let n = 0; return () => (++n <= 2 ? 3 : 0); })() });
    nude.bot.inventory.slots = [null, null, null, null, null, piece, null, null, null];     // 1 seule pièce
    await shelterUntilDawn(nude.bot, null, nude.deps);
    assert.deepEqual(nude.sleeps, [3000, 3000]);
  });
});

// ─── ABRI QUITTÉ PENDANT L'ATTENTE (discipline de nuit, 19/10 soir) ─────────────────────────────
// Le bot DÉLOGÉ de son trou (fuite, combat, sauvetage, /home d'urgence) ne doit plus « attendre
// l'aube » debout dehors : l'abri se TERMINE ({ok:false, reason:'displaced'}) et l'appelant (la
// discipline de nuit d'index.js) peut se ré-abriter là où il est.
function movableBot(at = { x: 0.5, y: 63, z: 0.5 }) {
  const bot = nightBot();
  // Un Vec3 MUTÉ EN PLACE par le serveur (piège #73d) : l'abri doit garder une COPIE de son ancre.
  bot.entity.position = new Vec3(at.x, at.y, at.z);
  // Monde plein et chargé (la cellule elle-même est testée dans test/shelter.cell.test.js) : toit et côtés
  // déjà pleins → aucune pose, aucune attente — on ne teste ici que la boucle d'attente.
  bot.blockAt = () => ({ name: 'dirt', boundingBox: 'block' });
  return bot;
}
// Le puits creusé : le bot descend VRAIMENT de 3 blocs (l'abri mesure la profondeur à la position).
const descend = async (b) => { b.entity.position.y -= 3; return { ok: true, dug: 3 }; };

describe('abri : délogé pendant l\'attente → l\'abri se termine (plus de nuit « à l\'abri » dehors)', () => {
  it('poussé/sorti de son trou en pleine nuit → {ok:false, reason:displaced}, event tracé, pas de sortie en pilier', async () => {
    const events = [];
    const sleeps = [];
    const bot = movableBot();
    const r = await shelterUntilDawn(bot, null, {
      emit: (e) => events.push(e),
      sleep: async (ms) => { sleeps.push(ms); if (sleeps.length === 2) bot.entity.position.x += 3; },   // mutation EN PLACE
      mineDown: descend,
      endWhenDisplaced: true,
    });
    assert.deepEqual(r, { ok: false, reason: 'displaced' });
    const d = events.find((e) => e.action === 'displaced');
    assert.ok(d, 'event displaced attendu');
    assert.equal(d.type, 'shelter');
    assert.equal(d.dist, 3);
    assert.equal(sleeps.length, 2, 'détecté au pas suivant, la nuit n\'est pas attendue');
    assert.equal(actions(events).includes('out'), false, 'pas de pilier pour sortir d\'un trou où l\'on n\'est plus');
    assert.equal(actions(events).includes('dawn'), false);
  });

  it('immobile dans son trou → attend l\'aube exactement comme avant (aucun event de plus)', async () => {
    const events = [];
    const sleeps = [];
    const bot = movableBot();
    const r = await shelterUntilDawn(bot, null, {
      emit: (e) => events.push(e),
      sleep: async (ms) => { sleeps.push(ms); bot.entity.position.x += 0.1; if (sleeps.length === 3) bot.time.timeOfDay = 1000; },
      mineDown: descend,
      endWhenDisplaced: true,
    });
    assert.equal(r.ok, true);
    assert.equal(sleeps.length, 3);
    assert.equal(events.some((e) => e.action === 'displaced'), false);
    assert.ok(actions(events).includes('dawn'));
    assert.ok(actions(events).includes('out'));
  });

  it('délogé pendant l\'attente des monstres À L\'AUBE → on arrête d\'attendre (raison displaced), pas de pilier', async () => {
    const { bot: b0, deps, events, sleeps } = dawnHarness({ hostilesNear: () => 3, worn: () => 0, mineDown: descend, endWhenDisplaced: true });
    const bot = movableBot();
    bot.time.timeOfDay = b0.time.timeOfDay;          // le jour est levé : on est directement dans l'étape 3bis
    deps.sleep = async (ms) => { sleeps.push(ms); if (sleeps.length === 2) bot.entity.position.y += 2; };
    const r = await shelterUntilDawn(bot, null, deps);
    assert.deepEqual(r, { ok: false, reason: 'displaced' });
    const w = events.find((e) => e.action === 'dawn_wait');
    assert.equal(w.reason, 'displaced');
    assert.equal(actions(events).includes('out'), false);
  });
});

describe('abri : sans `endWhenDisplaced`, comportement d\'origine (bots armés, autres appelants)', () => {
  it('délogé en pleine nuit mais option absente → l\'abri attend l\'aube comme avant (aucun event displaced)', async () => {
    const events = [];
    const sleeps = [];
    const bot = movableBot();
    const r = await shelterUntilDawn(bot, null, {
      emit: (e) => events.push(e),
      sleep: async (ms) => { sleeps.push(ms); if (sleeps.length === 1) bot.entity.position.x += 40; if (sleeps.length === 3) bot.time.timeOfDay = 1000; },
      mineDown: descend,
    });
    assert.equal(r.ok, true);
    assert.equal(sleeps.length, 3);
    assert.equal(events.some((e) => e.action === 'displaced'), false);
  });
});

describe('abri : `endWhenDisplaced` en PRÉDICAT (relu au moment du délogement)', () => {
  it('prédicat faux (bot armé) → délogé mais l\'abri continue ; prédicat qui lève → idem (jamais d\'erreur)', async () => {
    for (const pred of [() => false, () => { throw new Error('boom'); }]) {
      const events = [];
      const sleeps = [];
      const bot = movableBot();
      const r = await shelterUntilDawn(bot, null, {
        emit: (e) => events.push(e),
        sleep: async (ms) => { sleeps.push(ms); if (sleeps.length === 1) bot.entity.position.x += 5; if (sleeps.length === 3) bot.time.timeOfDay = 1000; },
        mineDown: descend,
        endWhenDisplaced: pred,
      });
      assert.equal(r.ok, true);
      assert.equal(events.some((e) => e.action === 'displaced'), false);
    }
  });

  it('prédicat qui DEVIENT vrai (la nuit tombe pendant l\'abri) → l\'abri se termine au pas suivant', async () => {
    let lockdown = false;
    const sleeps = [];
    const bot = movableBot();
    const r = await shelterUntilDawn(bot, null, {
      emit: () => {},
      sleep: async (ms) => { sleeps.push(ms); if (sleeps.length === 1) bot.entity.position.x += 5; if (sleeps.length === 2) lockdown = true; },
      mineDown: descend,
      endWhenDisplaced: () => lockdown,
    });
    assert.deepEqual(r, { ok: false, reason: 'displaced' });
    assert.equal(sleeps.length, 2);
  });
});
