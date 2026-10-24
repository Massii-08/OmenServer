'use strict';
// CÂBLAGE (24/10) : handOffPieces (donneur) / receiveGiftFrom (receveur) — le VRAI texte d'index.js
// exécuté dans un bac à sable `vm` strict (pièges #56/#61 : un nom mal branché lève ici, pas en prod).
// Rejoue la livraison perdue de MapBot1 : poche pleine, donneur qui repartait 300 ms après le jet.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Vec3 } = require('vec3');
const H = require('./handoff');
const GH = require('./goalHold');
const { pickJunkToToss } = require('./skills/craft');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(re, label) { const m = SRC.match(re); assert.ok(m, `${label} introuvable`); return m[0]; }
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);
const letSrc = (name) => grab(new RegExp(`^let ${name} = [^;]+;`, 'm'), `let ${name}`);

const PIECES = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];

function sandbox(o = {}) {
  const listeners = {};
  const inv = (o.inv || []).map((x) => Object.assign({}, x));
  const worn = new Set(o.worn || []);
  const ground = (o.ground || []).map((g) => Object.assign({}, g));
  const sb = {
    events: [], clock: 1000, goals: [], tossed: [],
    emit(e) { sb.events.push(e); },
    Object, Math, Number, Array, JSON, Promise, String, Error, Set, Map, Infinity, NaN,
    Date: { now: () => sb.clock },
    sleep: async (ms) => { sb.clock += ms; if (sb.onTick) sb.onTick(sb); },
    _lifeGen: 0,
    lifeStale: (gen) => gen != null && gen !== sb._lifeGen,
    presence: o.presence || null,
    _beatNow: () => { sb.beats = (sb.beats || 0) + 1; },
    _creeperHold: GH.createHoldState(),
    holdGoal: GH.hold, holdSetGoal: (pf, st, g) => GH.holdSetGoal(pf, st, g), releaseGoalHold: GH.release,
    pfGoals: { GoalNear: function GoalNear(x, y, z, r) { this.x = x; this.y = y; this.z = z; this.r = r; } },
    gotoWithTimeout: async (b, goal) => { sb.goals.push(goal); if (sb.onGoto) sb.onGoto(sb, goal); },
    missingIronPieces: (_inv, w) => PIECES.filter((p) => !w.includes(p) && !inv.some((i) => i.name === p && i.count > 0)),
    buildCtxInv: () => ({}),
    _wornArmor: () => new Set(worn),
    ensureArmor: async () => {
      for (const it of inv) if (PIECES.includes(it.name) && it.count > 0) { worn.add(it.name); it.count = 0; }
    },
    pickJunkToToss,
    ground, inv, worn, listeners,
    bot: {
      username: o.me || 'NethBot3',
      entity: { id: 1, position: new Vec3(0, 64, 0) },
      players: {},
      entities: {},
      targetDigBlock: null,
      pathfinder: { setGoal: (g) => { sb.goals.push(g); if (sb.onGoal) sb.onGoal(sb, g); } },
      inventory: {
        items: () => inv.filter((i) => i.count > 0),
        emptySlotCount: () => (o.emptySlots != null ? o.emptySlots : 10) + sb.tossed.length,
      },
      on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
      removeListener(ev, fn) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); },
      lookAt: async (p) => { sb.lookedAt = p; },
      setControlState: () => {},
      tossStack: async (it) => {
        sb.tossed.push(it.name);
        it.count = 0;
        if (sb.onToss) sb.onToss(sb, it.name);
      },
    },
  };
  // entités : joueurs + objets au sol
  const syncEntities = () => {
    sb.bot.entities = {};
    let id = 100;
    for (const g of ground) {
      if (g.gone) continue;
      sb.bot.entities[id] = { id, name: 'item', position: new Vec3(g.x, g.y, g.z), getDroppedItem: () => ({ name: g.name }) };
      id++;
    }
  };
  sb.syncEntities = syncEntities;
  syncEntities();
  for (const [name, pos] of Object.entries(o.players || {})) {
    sb.bot.players[name] = { entity: { username: name, position: new Vec3(pos.x, pos.y, pos.z) } };
  }
  sb.collect = (byName, itemName) => {
    for (const fn of (listeners.playerCollect || [])) fn({ username: byName }, { getDroppedItem: () => ({ name: itemName }) });
  };
  vm.createContext(sb);
  vm.runInContext("'use strict';\n" + [
    `const { HANDOFF_MAX_TRIES, HANDOFF_ENTITY_WAIT_MS, HANDOFF_APPROACH_MS, HANDOFF_POLL_MS, HANDOFF_BEAT_CHECK_MS,
      HANDOFF_RECEIVE_WAIT_MS, isGiftForMe, slotsToFree, pickupTargets, tossReady, deliveryProof, handoffNext, receiverNext } = H;`,
    letSrc('_giftRecvBusy'), fnSrc('_groundItems'), fnSrc('_pocketCount'), fnSrc('_waitPlayerEntity'),
    fnSrc('handOffPieces'), fnSrc('receiveGiftFrom'),
    'this.handOffPieces = handOffPieces; this.receiveGiftFrom = receiveGiftFrom;'].join('\n'),
  Object.assign(sb, { H }));
  return sb;
}

test('donneur : jette à ≤ 2 blocs en REGARDANT le receveur, et ne conclut qu\'au ramassage vu', async () => {
  const sb = sandbox({ inv: [{ name: 'iron_leggings', count: 1 }, { name: 'iron_helmet', count: 1 }],
    players: { MapBot1: { x: 1, y: 64, z: 0 } } });
  // le receveur ramasse 3 s après le jet (délai de ramassage 2 s)
  let tossAt = null;
  sb.onToss = (s) => { if (tossAt == null) tossAt = s.clock; };
  sb.onTick = (s) => {
    if (tossAt != null && s.clock - tossAt >= 3000 && !s._done) {
      s._done = true; s.collect('MapBot1', 'iron_leggings'); s.collect('MapBot1', 'iron_helmet');
    }
  };
  const r = await sb.handOffPieces('MapBot1', ['iron_leggings', 'iron_helmet']);
  assert.deepStrictEqual([r.given, r.by, r.tries], [2, 'collected', 1]);
  assert.deepStrictEqual(sb.tossed, ['iron_leggings', 'iron_helmet']);
  assert.ok(sb.lookedAt && Math.abs(sb.lookedAt.x - 1) < 1e-9, 'regarde le receveur');
  const ok = sb.events.find((e) => e.type === 'gift_confirmed');
  assert.ok(ok && ok.took_ms >= 3000, 'preuve après le délai de ramassage, pas 500 ms après le TP');
  assert.strictEqual(sb.listeners.playerCollect.length, 0, 'listener retiré');
});

test('donneur : receveur à 5 blocs → s\'approche d\'abord (GoalNear), ne jette pas de loin', async () => {
  const sb = sandbox({ inv: [{ name: 'iron_helmet', count: 1 }], players: { MapBot1: { x: 5, y: 64, z: 0 } } });
  sb.onGoto = (s) => { s.bot.entity.position = new Vec3(4, 64, 0); };
  sb.onToss = (s) => { s.collect('MapBot1', 'iron_helmet'); };
  const r = await sb.handOffPieces('MapBot1', ['iron_helmet']);
  assert.strictEqual(r.given, 1);
  assert.ok(sb.goals.length >= 1 && sb.goals[0].x === 5);
  const t = sb.events.find((e) => e.type === 'gift_tossed');
  assert.ok(t.dist <= H.HANDOFF_TOSS_MAX_DIST);
});

test('donneur : rien de ramassé (poche pleine en face) → reprend, réessaie, given 0 — plus jamais de faux gift_delivered', async () => {
  const sb = sandbox({ inv: [{ name: 'iron_leggings', count: 1 }, { name: 'iron_helmet', count: 1 }],
    players: { MapBot1: { x: 1, y: 64, z: 0 } } });
  // l'objet jeté reste au sol ; quand le donneur va dessus il le reprend
  sb.onToss = (s, name) => { s.ground.push({ name, x: 1, y: 64, z: 0 }); s.syncEntities(); };
  sb.onGoto = (s, goal) => {
    for (const g of s.ground) if (!g.gone && g.x === goal.x) { g.gone = true; const it = s.inv.find((i) => i.name === g.name); it.count = 1; }
    s.syncEntities();
  };
  const r = await sb.handOffPieces('MapBot1', ['iron_leggings', 'iron_helmet']);
  assert.strictEqual(r.given, 0);
  assert.strictEqual(r.tries, 2);
  const retries = sb.events.filter((e) => e.type === 'gift_retry');
  assert.deepStrictEqual(retries.map((e) => e.reason), ['unconfirmed', 'unconfirmed_final']);
  assert.strictEqual(sb.events.some((e) => e.type === 'gift_confirmed'), false);
  assert.strictEqual(sb.inv.filter((i) => i.count > 0).length, 2, 'les pièces sont revenues en poche');
});

test('donneur : preuve par heartbeat — receveur rebattu APRÈS le jet sans les pièces manquantes', async () => {
  const entry = { name: 'MapBot1', at: 0, missing: ['iron_helmet'] };
  const sb = sandbox({ inv: [{ name: 'iron_helmet', count: 1 }], players: { MapBot1: { x: 0.5, y: 64, z: 0 } },
    presence: { list: () => [entry] } });
  sb.onToss = (s) => { entry.at = s.clock + 4000; entry.missing = []; };
  const r = await sb.handOffPieces('MapBot1', ['iron_helmet']);
  assert.deepStrictEqual([r.given, r.by], [1, 'heartbeat']);
});

test('receveur : poche PLEINE → libère une case par pièce, va chercher le cadeau à ≤ 4 blocs, s\'équipe, rebat', async () => {
  const sb = sandbox({ me: 'MapBot1', emptySlots: 0,
    inv: [{ name: 'dirt', count: 64 }, { name: 'gravel', count: 40 }, { name: 'cobblestone', count: 64 }, { name: 'dirt', count: 30 }],
    worn: ['iron_chestplate', 'iron_boots'],
    players: { NethBot3: { x: 1, y: 64, z: 0 } } });
  let t0 = null;
  sb.onTick = (s) => {
    if (t0 == null) t0 = s.clock;
    if (!s._dropped && s.clock - t0 >= 1000) {   // le donneur jette 1 s après mon arrêt
      s._dropped = true;
      s.ground.push({ name: 'iron_leggings', x: 2, y: 64, z: 1 }, { name: 'iron_helmet', x: 2, y: 64, z: 1 });
      s.syncEntities();
    }
  };
  sb.onGoal = (s, g) => {
    if (!g || g.r !== 0) return;
    for (const it of s.ground) if (!it.gone && it.x === g.x) { it.gone = true; s.inv.push({ name: it.name, count: 1 }); }
    s.syncEntities();
  };
  await sb.receiveGiftFrom('NethBot3');
  const room = sb.events.find((e) => e.type === 'gift_receive_room');
  assert.ok(room && room.tossed.length === 2, 'deux cases libérées');
  assert.ok(room.tossed.every((t) => /^(dirt|gravel)/.test(t)), 'que du remblai');
  const got = sb.events.find((e) => e.type === 'gift_received');
  assert.deepStrictEqual([got.outcome, got.worn, got.gained], ['done', 4, 2]);
  assert.ok(sb.beats >= 1, 'heartbeat immédiat = preuve pour le donneur');
  assert.strictEqual(sb._creeperHold.owner, null, 'verrou de but relâché');
});

test('receveur : personne ne jette → s\'arrête au plus tard à 30 s', async () => {
  const sb = sandbox({ me: 'MapBot1', worn: ['iron_boots'], players: {} });
  const t0 = sb.clock;
  await sb.receiveGiftFrom('NethBot3');
  const got = sb.events.find((e) => e.type === 'gift_received');
  assert.strictEqual(got.outcome, 'timeout');
  assert.ok(sb.clock - t0 <= H.HANDOFF_RECEIVE_WAIT_MS + 1000);
});

test('receveur : ne vole jamais le verrou de but à la fuite creeper', async () => {
  const sb = sandbox({ me: 'MapBot1', worn: ['iron_boots'], players: {},
    ground: [{ name: 'iron_helmet', x: 1, y: 64, z: 0 }] });
  GH.hold(sb._creeperHold, sb.clock + 60000, 'creeper');
  await sb.receiveGiftFrom('NethBot3');
  assert.strictEqual(sb._creeperHold.owner, 'creeper');
  assert.strictEqual(sb.goals.length, 0, 'aucun but posé par-dessus la fuite');
});

test('deliverMapperArmor : gift_delivered n\'est plus émis qu\'après la preuve de handOffPieces', () => {
  const i = SRC.indexOf("if (goal.skill === 'deliverMapperArmor')");
  const j = SRC.indexOf("if (goal.skill === 'ensureArmor')", i);
  const body = SRC.slice(i, j);
  const ho = body.indexOf('await handOffPieces(');
  const unconf = body.indexOf("type: 'gift_unconfirmed'");
  const deliv = body.indexOf("type: 'gift_delivered'");
  assert.ok(ho > 0 && unconf > ho && deliv > unconf, 'handoff → sortie non prouvée → gift_delivered');
  assert.ok(!/giveItem\(/.test(body), 'plus de jet à l\'aveugle');
});

test('handler /tpaccept : une livraison qui me vise déclenche receiveGiftFrom', () => {
  const i = SRC.indexOf("bot.chat('/tpaccept'); emit({ type: 'command', command: '/tpaccept'");
  const seg = SRC.slice(i, i + 600);
  assert.ok(/_teamClaims\.peek\('marmor:' \+ bot\.username\)/.test(seg));
  assert.ok(/isGiftForMe\(/.test(seg) && /receiveGiftFrom\(tpWho\)/.test(seg));
});

test('deliverMapperArmor : budget de skill élargi (TP + remise prouvée + 1 nouvel essai ne tiennent pas en 90 s)', () => {
  assert.match(SRC, /deliverMapperArmor: 180000 \}/);
});
