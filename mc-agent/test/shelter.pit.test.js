'use strict';
// SORTIE DU PUITS VÉRIFIÉE (live 25/10, NethBot3) — `shelter out {ok:true}` 2 s après l'aube, et le bot
// est resté 15+ min au fond du puits (-54,64,-169) : sol cobble y=63, cobble sur les 4 côtés à y=64 ET 65,
// ouvert au-dessus. `pillarUp` rend `ok` sur une montée PARTIELLE et `_exitCell` rendait toujours ok:true.
// Désormais : on vérifie, on retente le pilier (borné), puis on taille un escalier (borné), et on le DIT.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { inPit, pitClimbNeeded, escapePit, exitPendingShelter, PIT_STAIR_MAX } = require('../skills/shelter');

const GROUND = 66;   // surface pleine jusqu'à y=66 : un joueur dehors a les pieds à y=67

/** Monde : plein (pierre) jusqu'à GROUND, air au-dessus ; puits 1×1 creusé en (0, 64..66, 0). */
function pitWorld({ over = {}, items = [] } = {}) {
  const blocks = new Map(Object.entries(over));
  for (const y of [64, 65, 66]) if (!blocks.has(`0,${y},0`)) blocks.set(`0,${y},0`, 'air');
  const nameAt = (x, y, z) => {
    const k = `${x},${y},${z}`;
    if (blocks.has(k)) return blocks.get(k);
    return y > GROUND ? 'air' : (y === 63 ? 'cobblestone' : 'stone');
  };
  const read = (x, y, z) => {
    const name = nameAt(x, y, z);
    return { name, boundingBox: /air/.test(name) ? 'empty' : 'block', position: new Vec3(x, y, z),
      diggable: name !== 'bedrock' };
  };
  const inv = items.map((i) => Object.assign({}, i));
  const log = { digs: [] };
  const bot = {
    time: { timeOfDay: 4183 },
    entity: { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), yaw: 0 },
    inventory: { items: () => inv.filter((i) => i.count > 0) },
    blockAt: (p) => (p ? read(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) : null),
    async dig(b) {
      const { x, y, z } = b.position;
      if (nameAt(x, y, z) === 'bedrock') throw new Error('bedrock');
      blocks.set(`${x},${y},${z}`, 'air');
      log.digs.push(`${x},${y},${z}`);
    },
    async equip() {}, async lookAt() {}, setControlState() {}, clearControlStates() {},
  };
  // la marche : le bot monte sur la case visée si elle est libre (pieds + tête) et posée sur du plein
  const stepUp = async (b, to) => {
    if (read(to.x, to.y, to.z).boundingBox !== 'empty' || read(to.x, to.y + 1, to.z).boundingBox !== 'empty') return false;
    if (read(to.x, to.y - 1, to.z).boundingBox !== 'block') return false;
    b.entity.position = new Vec3(to.x + 0.5, to.y, to.z + 0.5);
    return true;
  };
  return { bot, read, log, blocks, stepUp };
}

describe('inPit / pitClimbNeeded (purs)', () => {
  it('4 côtés pleins aux pieds ET à la tête → dans le puits ; un côté ouvert à la tête → non', () => {
    const w = pitWorld();
    assert.equal(inPit(w.read, { x: 0, y: 64, z: 0 }), true);
    w.blocks.set('1,65,0', 'air');
    assert.equal(inPit(w.read, { x: 0, y: 64, z: 0 }), false);
  });
  it('bloc inconnu (chunk pas chargé) → pas de conclusion « piégé »', () => {
    assert.equal(inPit(() => null, { x: 0, y: 64, z: 0 }), false);
  });
  it('hauteur à gagner : du fond (64) il faut 2 blocs pour avoir la tête au-dessus du bord', () => {
    const w = pitWorld();
    assert.equal(pitClimbNeeded(w.read, { x: 0, y: 64, z: 0 }), 2);
    assert.equal(pitClimbNeeded(w.read, { x: 0, y: 65, z: 0 }), 1);
  });
});

describe('escapePit : pilier vérifié, retenté, puis escalier', () => {
  it('cas NethBot3 : aucun bloc pour le pilier → escalier taillé dans la paroi, le bot sort', async () => {
    const w = pitWorld();
    const r = await escapePit(w.bot, null, { pitStepUp: w.stepUp, sleep: async () => {} });
    assert.equal(r.escaped, true, JSON.stringify(r));
    assert.ok(r.stairs >= 1 && r.stairs <= PIT_STAIR_MAX, `marches : ${r.stairs}`);
    assert.equal(r.placed, 0);
    assert.ok(Math.floor(w.bot.entity.position.y) >= 66, `pieds à ${w.bot.entity.position.y}`);
    assert.ok(w.log.digs.length > 0);
  });

  it('pilier PARTIEL → retenté pour la profondeur restante, puis sorti', async () => {
    const w = pitWorld();
    const heights = [];
    const fakePillar = async (bot, { height }) => {
      heights.push(height);
      const p = bot.entity.position;
      const fx = Math.floor(p.x); const fy = Math.floor(p.y); const fz = Math.floor(p.z);
      w.blocks.set(`${fx},${fy},${fz}`, 'cobblestone');      // UN bloc posé seulement
      bot.entity.position = new Vec3(p.x, fy + 1, p.z);
      return heights.length === 1 ? { ok: true, placed: 1, reason: 'place_failed' } : { ok: true, placed: 1 };
    };
    const r = await escapePit(w.bot, null, { pillarUp: fakePillar, pitStepUp: w.stepUp, sleep: async () => {} });
    assert.equal(r.escaped, true, JSON.stringify(r));
    assert.deepEqual(heights, [2, 1], 'retente pour la profondeur RESTANTE');
    assert.equal(r.placed, 2);
    assert.equal(r.stairs, 0, 'pas d\'escalier quand le pilier suffit');
  });

  it('parois incassables, pas de bloc → échec PROPRE, borné, et dit pourquoi', async () => {
    const over = {};
    for (const y of [64, 65, 66, 67]) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) over[`${dx},${y},${dz}`] = 'bedrock';
    const w = pitWorld({ over });
    const r = await escapePit(w.bot, null, { pitStepUp: w.stepUp, sleep: async () => {} });
    assert.equal(r.escaped, false);
    assert.equal(r.ok, false);
    assert.ok(r.reason, 'raison tracée');
    assert.equal(Math.floor(w.bot.entity.position.y), 64);
  });

  it('pas dans un puits → rien à faire, escaped tout de suite', async () => {
    const w = pitWorld();
    w.bot.entity.position = new Vec3(5.5, 67, 5.5);
    let called = 0;
    const r = await escapePit(w.bot, null, { pillarUp: async () => { called++; return { ok: true, placed: 0 }; }, pitStepUp: w.stepUp });
    assert.equal(r.escaped, true);
    assert.equal(called, 0);
  });
});

describe('sortie d\'abri (_exitCell via exitPendingShelter) : l\'event `out` dit la vérité', () => {
  it('pilier qui ne pose rien, escalier qui sort → out {escaped:true, placed:0, reason}', async () => {
    const w = pitWorld();
    w.bot._mcaShelterPending = { mode: 'pit', depth: 3, dugIn: true };
    const ev = [];
    const r = await exitPendingShelter(w.bot, null, { emit: (e) => ev.push(e), sleep: async () => {}, pitStepUp: w.stepUp });
    const out = ev.find((e) => e.action === 'out');
    assert.ok(out, 'event out');
    assert.equal(out.escaped, true);
    assert.equal(out.placed, 0);
    assert.equal(out.reason, 'no_blocks');
    assert.equal(r.ok, true);
  });

  it('coincé pour de bon → out {escaped:false} et la sortie rend ok:false still_in_pit', async () => {
    const over = {};
    for (const y of [64, 65, 66, 67]) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) over[`${dx},${y},${dz}`] = 'bedrock';
    const w = pitWorld({ over });
    w.bot._mcaShelterPending = { mode: 'pit', depth: 3, dugIn: true };
    const ev = [];
    const r = await exitPendingShelter(w.bot, null, { emit: (e) => ev.push(e), sleep: async () => {}, pitStepUp: w.stepUp });
    const out = ev.find((e) => e.action === 'out');
    assert.equal(out.escaped, false);
    assert.equal(out.ok, false);
    assert.deepEqual(r, { ok: false, pending: true, reason: 'still_in_pit' });
  });
});
