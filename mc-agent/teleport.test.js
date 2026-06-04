'use strict';
// Téléportation (#10 retours live) : détection (forcedMove / gros delta) + ré-ancrage du mapper
// (origine = position ACTUELLE, heading propre, reset anti-stuck, JAMAIS de retour à pied).
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const vec3 = require('vec3');
const { isTeleportJump, createTeleportWatcher, wireTeleportDetection, TP_THRESHOLD } = require('./teleport');
const { runMapper, cellKey } = require('./mapper');

// --- isTeleportJump (pur) ---

test('isTeleportJump : pas de marche normale (deltas ≤ vitesse sprint/tick) → false', () => {
  assert.ok(!isTeleportJump({ x: 0, y: 64, z: 0 }, { x: 0.3, y: 64, z: 0.1 }));
  assert.ok(!isTeleportJump({ x: 10, y: 64, z: 10 }, { x: 10, y: 65.2, z: 10 })); // saut vertical normal
  assert.ok(!isTeleportJump(null, { x: 0, y: 64, z: 0 }));                         // pas de référence
  assert.ok(!isTeleportJump({ x: 0, y: 64, z: 0 }, null));
});

test('isTeleportJump : saut bien au-delà de la marche (TP /tp, /home, portail) → true', () => {
  assert.ok(isTeleportJump({ x: 0, y: 64, z: 0 }, { x: 200, y: 64, z: -300 }));
  assert.ok(isTeleportJump({ x: 0, y: 64, z: 0 }, { x: 0, y: 64 + TP_THRESHOLD + 1, z: 0 })); // TP vertical
  assert.ok(isTeleportJump({ x: 5, y: 64, z: 5 }, { x: 5 + TP_THRESHOLD + 0.5, y: 64, z: 5 }));
});

test('isTeleportJump : seuil configurable', () => {
  assert.ok(isTeleportJump({ x: 0, y: 0, z: 0 }, { x: 6, y: 0, z: 0 }, { threshold: 5 }));
  assert.ok(!isTeleportJump({ x: 0, y: 0, z: 0 }, { x: 6, y: 0, z: 0 }, { threshold: 8 }));
});

// --- createTeleportWatcher ---

test('watcher : une marche continue (petits pas) ne déclenche JAMAIS', () => {
  const w = createTeleportWatcher();
  let hit = null;
  for (let i = 0; i < 500; i++) hit = w.update({ x: i * 0.28, y: 64, z: i * 0.1 }) || hit;
  assert.strictEqual(hit, null);
  assert.strictEqual(w.peek(), null);
});

test('watcher : un saut de position déclenche UNE fois (update suivants → null), consume vide', () => {
  const w = createTeleportWatcher();
  w.update({ x: 0, y: 64, z: 0 });
  const hit = w.update({ x: 500, y: 70, z: -500 });
  assert.ok(hit, 'le TP doit être détecté');
  assert.deepStrictEqual({ x: hit.from.x, z: hit.from.z }, { x: 0, z: 0 });
  assert.deepStrictEqual({ x: hit.to.x, z: hit.to.z }, { x: 500, z: -500 });
  // la marche reprend au nouveau point : pas de re-détection
  assert.strictEqual(w.update({ x: 500.3, y: 70, z: -500 }), null);
  // pending reste lisible jusqu'à consume
  assert.ok(w.peek());
  const c = w.consume();
  assert.ok(c && c.to.x === 500);
  assert.strictEqual(w.consume(), null);
  assert.strictEqual(w.peek(), null);
});

test('watcher : 2 TPs avant consume → le pending reflète le DERNIER lieu réel', () => {
  const w = createTeleportWatcher();
  w.update({ x: 0, y: 64, z: 0 });
  w.update({ x: 300, y: 64, z: 0 });
  w.update({ x: 300, y: 64, z: 900 });
  const c = w.consume();
  assert.strictEqual(c.to.z, 900, 'le ré-ancrage doit viser la DERNIÈRE position réelle');
});

test('watcher : anchor() ré-ancre sans détection (spawn initial, respawn géré ailleurs)', () => {
  const w = createTeleportWatcher();
  w.anchor({ x: 1000, y: 64, z: 1000 });
  assert.strictEqual(w.update({ x: 1000.2, y: 64, z: 1000 }), null);
  assert.strictEqual(w.peek(), null);
});

// --- wireTeleportDetection (câblage bot, fake EventEmitter) ---

function fakeBot(pos) {
  const bot = new EventEmitter();
  bot.entity = { position: vec3(pos.x, pos.y, pos.z) };
  return bot;
}

test('wireTeleportDetection : forcedMove avec gros delta → teleport_detected{from,to} + onTeleport (stop goal)', () => {
  const bot = fakeBot({ x: 0, y: 64, z: 0 });
  const w = createTeleportWatcher();
  const events = []; let stopped = 0;
  wireTeleportDetection(bot, w, { emit: (e) => events.push(e), onTeleport: () => stopped++ });
  bot.emit('move');                                       // position de référence
  bot.entity.position = vec3(250, 70, -120);              // le serveur TP le bot
  bot.emit('forcedMove');
  const tp = events.find((e) => e.type === 'teleport_detected');
  assert.ok(tp, 'teleport_detected doit être émis');
  assert.deepStrictEqual(tp.from, { x: 0, y: 64, z: 0 });
  assert.deepStrictEqual(tp.to, { x: 250, y: 70, z: -120 });
  assert.strictEqual(stopped, 1, 'le goal pathfinder en cours doit être abandonné');
  // les corrections serveur minimes (forcedMove ~1 bloc) ne déclenchent PAS
  bot.entity.position = vec3(250.8, 70, -120);
  bot.emit('forcedMove');
  assert.strictEqual(events.filter((e) => e.type === 'teleport_detected').length, 1);
});

test('wireTeleportDetection : un gros delta vu via move (sans forcedMove) déclenche aussi', () => {
  const bot = fakeBot({ x: 0, y: 64, z: 0 });
  const w = createTeleportWatcher();
  const events = [];
  wireTeleportDetection(bot, w, { emit: (e) => events.push(e) });
  bot.emit('move');
  bot.entity.position = vec3(-400, 64, 0);
  bot.emit('move');
  assert.ok(events.find((e) => e.type === 'teleport_detected'));
});

// --- ré-ancrage du mapper (runMapper + opts.teleport) ---

function fakeMapperBot() {
  return {
    entity: { position: vec3(0, 64, 0), isInWater: false, onGround: true },
    entities: {}, health: 20, food: 20,
    inventory: { items: () => [] },
    nearestEntity: () => null, findBlocks: () => [],
    setControlState: () => {}, clearControlStates: () => {},
    dig: async () => {},
    blockAt(p) {
      if (p.y > 63) return { name: 'air', boundingBox: 'empty', biome: { name: 'plains', id: 1 } };
      return { name: 'stone', boundingBox: 'block', biome: { name: 'plains', id: 1 } };
    },
    pvp: { attack: () => {}, stop: () => {} },
    pathfinder: { setGoal: () => {}, goto: async () => {} },
    registry: { itemsByName: {} },
    equip: async () => {}, consume: async () => {},
  };
}

test('runMapper : TP en cours de route → ré-ancrage (mappe DEPUIS le nouveau lieu, JAMAIS de retour à pied)', async () => {
  const bot = fakeMapperBot();
  const w = createTeleportWatcher();
  w.update({ x: 0, y: 64, z: 0 });
  const events = []; const gotos = [];
  const token = { cancelled: false };
  let legs = 0;
  await runMapper(bot, {
    worldKey: 'overworld',
    teleport: w,
    emit: (e) => events.push(e),
    goto: async (wp) => {
      gotos.push({ x: wp.x, z: wp.z, afterTp: legs > 3 });
      legs++;
      // marche normale = le watcher voit des PETITS deltas (move tick par tick), pas la jambe entière
      const from = { x: bot.entity.position.x, z: bot.entity.position.z };
      for (let f = 0.1; f <= 1.001; f += 0.1) {
        w.update({ x: from.x + (wp.x - from.x) * f, y: 64, z: from.z + (wp.z - from.z) * f });
      }
      bot.entity.position = vec3(wp.x, 64, wp.z);
      if (legs === 3) {                                 // …puis Massii fait /tp 5000 ~ 5000
        bot.entity.position = vec3(5000, 64, 5000);
        w.update({ x: 5000, y: 64, z: 5000 });
      }
      if (legs >= 8) token.cancelled = true;
    },
    sleep: async () => {},
  }, token);
  // ré-ancrage émis avec from/to
  const re = events.find((e) => e.type === 'mapper_reanchor');
  assert.ok(re, 'mapper_reanchor doit être émis après le TP');
  assert.ok(Math.abs(re.to.x - 5000) < 1 && Math.abs(re.to.z - 5000) < 1);
  // toutes les jambes post-TP partent du NOUVEAU lieu (≤ ~200 blocs de 5000,5000), aucune ne revise l'ancien
  const post = gotos.filter((g) => g.afterTp);
  assert.ok(post.length >= 2, 'le mapping doit continuer après le TP');
  for (const g of post) {
    const dNew = Math.hypot(g.x - 5000, g.z - 5000);
    const dOld = Math.hypot(g.x, g.z);
    assert.ok(dNew < 600, `jambe post-TP trop loin du nouveau lieu (${Math.round(dNew)})`);
    assert.ok(dOld > 4000, 'une jambe post-TP repart vers l\'ancien lieu — interdit');
  }
  // le biome du nouveau lieu est enregistré aux coords RÉELLES
  const cells = events.filter((e) => e.type === 'biome_seen').map((e) => cellKey(e.x, e.z));
  assert.ok(cells.includes(cellKey(5000, 5000)), 'biome_seen attendu dans la cellule du nouveau lieu');
});
