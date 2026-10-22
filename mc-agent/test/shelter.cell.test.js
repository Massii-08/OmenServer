'use strict';
// LA CELLULE FERMÉE (19/10 soir) — l'abri nocturne joué dans un MONDE SIMULÉ, pas avec des bouchons.
//
// Mesure live (20 sessions) : 120 abris → 46 abandonnés (39 `void_below`, 7 `dig_failed`), 10 seulement
// avec un toit. Les tests d'origine bouchaient `mineDown` et `panicWall` : ils ne pouvaient voir AUCUNE
// des trois causes, qui tiennent toutes à la physique du jeu. Ce monde-ci la joue :
//   - la GRAVITÉ sur la vraie boîte du joueur (0,6 de large) : un bot pas centré déborde sur la case
//     voisine et reste DEBOUT sur le bord quand on creuse sous son centre (le cas réel n°1) ;
//   - le DÉLAI DE RAMASSAGE de 10 ticks (0,5 s) des blocs cassés : juste après le coup, la poche est vide ;
//   - `placeBlock(référence, face)` comme le serveur : une pose exige un bloc PLEIN voisin de la cible ;
//   - les chunks pas encore chargés au respawn (`blockAt` → null).
// Le vrai `mineDown` et le vrai `panicWall` tournent dedans.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { shelterUntilDawn, createSpotMemory, SHELTER_PIT_DEPTH, shelterHold } = require('../skills/shelter');

const GROUND = 63;                       // herbe à y=63 : un joueur debout dessus a les pieds à y=64

/**
 * Monde plat : herbe (63), terre (62..59), pierre dessous ; `over` remplace des blocs ("x,y,z" → nom).
 * `at` = position des PIEDS du bot. `loadedAt` = instant (ms simulées) où les chunks deviennent lisibles.
 */
function world({ at = { x: 0.85, y: GROUND + 1, z: 0.5 }, over = {}, items = [], loadedAt = 0, night = true } = {}) {
  const blocks = new Map(Object.entries(over));
  const clock = { t: 0 };
  const nameAt = (x, y, z) => {
    const k = `${x},${y},${z}`;
    if (blocks.has(k)) return blocks.get(k);
    if (y > GROUND) return 'air';
    if (y === GROUND) return 'grass_block';
    if (y >= GROUND - 4) return 'dirt';
    return 'stone';
  };
  const setName = (x, y, z, n) => blocks.set(`${x},${y},${z}`, n);
  const EMPTY = new Set(['air', 'cave_air', 'void_air', 'water', 'lava', 'short_grass']);
  const block = (x, y, z) => {
    const name = nameAt(x, y, z);
    return { name, boundingBox: EMPTY.has(name) ? 'empty' : 'block', position: new Vec3(x, y, z) };
  };
  const inv = items.map((i) => Object.assign({}, i));
  const drops = [];
  const log = { digs: [], places: [], dug: [] };
  const bot = {
    time: { timeOfDay: night ? 18000 : 6000, day: 3 },
    entity: { position: new Vec3(at.x, at.y, at.z), onGround: true, velocity: new Vec3(0, 0, 0) },
    heldItem: null,
    inventory: { items: () => inv.filter((i) => i.count > 0), slots: [] },
    blockAt(p) {
      if (!p || clock.t < loadedAt) return null;                 // chunk pas encore chargé
      return block(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
    },
    async equip(item) { bot.heldItem = item; },
    async dig(b) {
      const { x, y, z } = b.position;
      const name = nameAt(x, y, z);
      if (name === 'bedrock') throw new Error('dig time for bedrock is Infinity');
      const pick = bot.heldItem && /_pickaxe$/.test(bot.heldItem.name);
      clock.t += /stone|deepslate/.test(name) && !pick ? 7500 : 750;
      log.digs.push(`${x},${y},${z}`);
      log.dug.push(name);
      setName(x, y, z, 'air');
      const drop = name === 'grass_block' ? 'dirt'
        : /_leaves$/.test(name) ? null
          : (/stone|deepslate/.test(name) && !pick) ? null
            : (name === 'stone' ? 'cobblestone' : name);
      if (drop) drops.push({ name: drop, x: x + 0.5, y, z: z + 0.5, at: clock.t });
    },
    async placeBlock(ref, face) {
      const t = ref.position.plus(face);
      if (block(ref.position.x, ref.position.y, ref.position.z).boundingBox !== 'block') throw new Error('ref not solid');
      if (block(t.x, t.y, t.z).boundingBox !== 'empty') throw new Error('target occupied');
      const h = bot.heldItem;
      if (!h || !(h.count > 0)) throw new Error('nothing in hand');
      const p = bot.entity.position;                                 // la boîte du joueur ne doit pas être dans la case
      const hits = t.x < p.x + 0.3 && t.x + 1 > p.x - 0.3 && t.z < p.z + 0.3 && t.z + 1 > p.z - 0.3
        && t.y < p.y + 1.8 && t.y + 1 > p.y;
      if (hits) throw new Error('entity in the way');
      setName(t.x, t.y, t.z, h.name);
      h.count -= 1;
      log.places.push(`${t.x},${t.y},${t.z}`);
    },
    async lookAt() {}, setControlState() {}, clearControlStates() {},
  };
  /** Supporté si UNE des quatre colonnes sous la boîte (0,6 × 0,6) est pleine. */
  const supported = () => {
    const p = bot.entity.position;
    const y = Math.floor(p.y) - 1;
    for (const dx of [-0.3, 0.29]) {
      for (const dz of [-0.3, 0.29]) {
        if (block(Math.floor(p.x + dx), y, Math.floor(p.z + dz)).boundingBox === 'block') return true;
      }
    }
    return false;
  };
  const physics = (ms) => {
    clock.t += ms;
    for (let n = 0; n < 4 && !supported(); n++) bot.entity.position.y = Math.floor(bot.entity.position.y) - 1;
    bot.entity.onGround = supported();
    const p = bot.entity.position;
    for (const d of drops) {
      if (d.taken) continue;
      while (block(Math.floor(d.x), d.y - 1, Math.floor(d.z)).boundingBox === 'empty' && d.y > 0) d.y -= 1;   // l'item tombe
      const near = Math.abs(d.x - p.x) <= 1.3 && Math.abs(d.z - p.z) <= 1.3 && d.y >= p.y - 1 && d.y <= p.y + 2.3;
      if (near && clock.t - d.at >= 500) {                          // 10 ticks de délai de ramassage
        d.taken = true;
        const stack = inv.find((i) => i.name === d.name && i.count > 0);
        if (stack) stack.count += 1; else inv.push({ name: d.name, count: 1 });
      }
    }
  };
  const sleep = async (ms) => physics(ms);
  return { bot, sleep, clock, log, nameAt, setName, inv };
}

/** Lance l'abri et COUPE dès la fin de la mise à l'abri (event `sealed`) : on inspecte la cellule. */
async function buildCell(w, deps = {}) {
  const events = [];
  const token = { cancelled: false };
  const r = await shelterUntilDawn(w.bot, token, Object.assign({
    emit: (e) => { events.push(e); if (e.action === 'sealed') token.cancelled = true; },
    sleep: w.sleep,
    spotMemory: createSpotMemory(),
    stepTo: async (f) => { w.bot.entity.position = new Vec3(f.x + 0.5, f.y, f.z + 0.5); },
  }, deps));
  return { r, events, sealed: events.find((e) => e.action === 'sealed') };
}

/** La cellule autour des pieds : toit plein, 4 côtés pleins à hauteur des pieds ET de la tête. */
function cell(w) {
  const p = w.bot.entity.position;
  const fx = Math.floor(p.x); const fy = Math.floor(p.y); const fz = Math.floor(p.z);
  const solid = (x, y, z) => !['air', 'cave_air', 'water', 'lava'].includes(w.nameAt(x, y, z));
  const sides = [];
  for (const dy of [0, 1]) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) sides.push(solid(fx + dx, fy + dy, fz + dz));
  return { feetY: fy, roof: solid(fx, fy + 2, fz), sides: sides.every(Boolean), open: sides.filter((s) => !s).length };
}

describe('abri : la cellule fermée, dans un monde qui joue la physique', () => {
  it('LE CAS RÉEL : herbe plate, bot PAS centré, poche VIDE → cellule fermée (3 blocs creusés, toit à fleur du sol) en ≤ 10 s', async () => {
    const w = world();
    const { events, sealed } = await buildCell(w);
    const c = cell(w);
    assert.equal(c.feetY, GROUND - 2, 'le bot (2 blocs de haut) tient ENTIER sous la surface');
    assert.equal(c.roof, true, 'tête sous un bloc');
    assert.equal(c.sides, true, '4 côtés pleins aux pieds ET à la tête');
    assert.equal(w.nameAt(0, GROUND, 0), 'dirt', 'le toit, c est la terre qu il vient de creuser');
    assert.deepEqual(w.log.digs, ['0,63,0', '0,62,0', '0,61,0'], 'trois coups, droit sous ses pieds — aucune paroi minée');
    assert.ok(w.clock.t <= 10000, `mise à l abri en ${w.clock.t} ms`);
    assert.equal(sealed.sealed, true);
    assert.equal(sealed.why, 'ok');
    assert.equal(sealed.mode, 'pit');
    assert.equal(sealed.depth, SHELTER_PIT_DEPTH);
    assert.equal(events.filter((e) => e.action === 'sealed').length, 1, 'UNE ligne par abri');
    assert.ok(events.some((e) => e.action === 'roofed'));
  });

  it('respawn : chunks pas encore chargés (blockAt → null) → on ATTEND le monde au lieu d abandonner en void_below', async () => {
    const w = world({ loadedAt: 1200, at: { x: 4.5, y: GROUND + 1, z: -2.5 } });
    const { sealed } = await buildCell(w);
    assert.equal(sealed.sealed, true, JSON.stringify(sealed));
    assert.equal(cell(w).roof, true);
  });

  it('debout sur du feuillage au-dessus d une grotte → 1 pas vers un voisin au sol plein, PUIS on creuse', async () => {
    const over = { '0,63,0': 'oak_leaves', '0,62,0': 'cave_air', '0,61,0': 'cave_air', '0,60,0': 'cave_air' };
    const w = world({ at: { x: 0.5, y: GROUND + 1, z: 0.5 }, over });
    const { sealed } = await buildCell(w);
    assert.equal(sealed.sealed, true, JSON.stringify(sealed));
    assert.equal(sealed.moved, true);
    const p = w.bot.entity.position;
    assert.ok(Math.abs(Math.floor(p.x)) + Math.abs(Math.floor(p.z)) >= 1, 'il a quitté la case du feuillage');
    assert.ok(Math.hypot(Math.floor(p.x), Math.floor(p.z)) <= 3, 'à 3 blocs au plus');
    assert.ok(!w.log.digs.includes('0,63,0'), 'il ne creuse pas le feuillage (rien dessous)');
  });

  it('grotte sous le 3e bloc : on s arrête à 2 de profondeur (pas de chute dans la grotte) et le toit tient quand même, posé sur un SUPPORT', async () => {
    const w = world({ at: { x: 0.5, y: GROUND + 1, z: 0.5 }, over: { '0,60,0': 'cave_air', '0,59,0': 'cave_air' } });
    const { sealed } = await buildCell(w);
    const c = cell(w);
    assert.equal(c.feetY, GROUND - 1, 'pieds à 62 : arrêté au-dessus de la grotte');
    assert.ok(!w.log.digs.includes('0,61,0'), 'le 3e coup aurait ouvert la grotte : refusé');
    assert.equal(c.roof, true, 'toit au-dessus de la surface, posé contre un support');
    assert.equal(c.sides, true);
    assert.equal(sealed.sealed, true, JSON.stringify(sealed));
    assert.equal(sealed.roof, 'support');
    assert.equal(sealed.depth, 2);
  });

  it('grotte sous le 2e bloc (puits d 1 seul bloc : la tête dépasse) → noté, et UN essai à côté donne un vrai puits', async () => {
    const w = world({ at: { x: 0.5, y: GROUND + 1, z: 0.5 }, over: { '0,61,0': 'cave_air', '0,60,0': 'cave_air' } });
    const memory = createSpotMemory();
    const { sealed } = await buildCell(w, { spotMemory: memory });
    assert.equal(sealed.sealed, true, JSON.stringify(sealed));
    assert.equal(sealed.moved, true);
    assert.equal(sealed.depth, SHELTER_PIT_DEPTH);
    assert.equal(memory.fails(0, 0, Date.now()), 0, 'réussi à côté (à ≤ 2 blocs) : l endroit n est plus compté comme raté');
  });

  it('poche de grotte CONTRE le puits (pieds et tête à nu d un côté) → colmatée contre la roche voisine, sans pont : les 3 blocs creusés suffisent', async () => {
    // la poche descend SOUS le niveau des pieds : panicWall (qui ne pose que sur le bloc du dessous) devait
    // d'abord ponter en (1,60,0) — un 4e bloc qu'on n'a pas
    const w = world({ at: { x: 0.5, y: GROUND + 1, z: 0.5 }, over: { '1,60,0': 'cave_air', '1,61,0': 'cave_air', '1,62,0': 'cave_air' } });
    const { sealed } = await buildCell(w);
    const c = cell(w);
    assert.equal(c.feetY, GROUND - 2);
    assert.equal(c.sides, true, 'les deux trous du côté grotte sont bouchés');
    assert.equal(c.roof, true);
    assert.equal(w.log.places.length, 3, `toit + 2 côtés, aucun bloc gâché en pont (${w.log.places})`);
    assert.ok(!w.log.places.includes('1,60,0'), 'pas de pont SOUS le côté (ce que faisait panicWall)');
    assert.equal(sealed.sealed, true, JSON.stringify(sealed));
  });

  it('impossible de creuser (bedrock) ET aucun voisin : plan B « mur sur place » avec ce qu on a en poche → cellule murée et couverte', async () => {
    const over = {};
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) over[`${dx},63,${dz}`] = 'bedrock';
    const w = world({ at: { x: 0.5, y: GROUND + 1, z: 0.5 }, over, items: [{ name: 'dirt', count: 12 }] });
    const { r, sealed, events } = await buildCell(w);
    assert.ok(events.some((e) => e.action === 'walled_in'), 'plan B joué');
    assert.equal(sealed.mode, 'walled');
    const c = cell(w);
    assert.equal(c.sides, true, 'murs aux pieds et à la tête');
    assert.equal(c.roof, true, 'toit posé sur un mur');
    assert.equal(sealed.sealed, true, JSON.stringify(sealed));
    assert.equal(r.reason, 'cancelled', 'coupé par le test après la mise à l abri');
  });

  it('2 échecs AU MÊME ENDROIT → au 3e abri, plan B direct : on ne re-creuse plus un endroit prouvé impossible', async () => {
    const over = {};
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) over[`${dx},63,${dz}`] = 'bedrock';
    const memory = createSpotMemory();
    const tries = [];
    for (let i = 0; i < 3; i++) {
      const w = world({ at: { x: 0.5, y: GROUND + 1, z: 0.5 }, over, items: [{ name: 'dirt', count: 12 }] });
      let digCalls = 0;
      const realDig = w.bot.dig;
      w.bot.dig = async (b) => { digCalls++; return realDig(b); };
      await buildCell(w, { spotMemory: memory });
      tries.push(digCalls);
    }
    assert.ok(tries[0] >= 1 && tries[1] >= 1, `les deux premiers abris tentent de creuser (${tries})`);
    assert.equal(tries[2], 0, `le 3e passe directement au mur (${tries})`);
  });

  it('sans rien pouvoir faire (bedrock partout, poche vide) → abandon TRACÉ : sealed:false + why', async () => {
    const over = {};
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) over[`${dx},63,${dz}`] = 'bedrock';
    const w = world({ at: { x: 0.5, y: GROUND + 1, z: 0.5 }, over });
    const { r, sealed, events } = await buildCell(w);
    assert.equal(r.ok, false);
    assert.ok(events.some((e) => e.action === 'abort'));
    assert.equal(sealed.sealed, false);
    assert.match(sealed.why, /^abort:/);
  });

  it('sol de PIERRE sans pioche (rien ne tombe, 7,5 s par bloc) → on va creuser la terre voisine plutôt que s y user les mains', async () => {
    const over = {};
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let y = 59; y <= 63; y++) over[`${dx},${y},${dz}`] = 'stone';
    const w = world({ at: { x: 0.5, y: GROUND + 1, z: 0.5 }, over });
    const { sealed } = await buildCell(w);
    assert.equal(sealed.sealed, true, JSON.stringify(sealed));
    assert.equal(sealed.moved, true);
    assert.ok(w.clock.t <= 10000, `${w.clock.t} ms`);
  });

  it('poche vide et un trou où rien ne tombe (grotte plafond ouvert) → sealed:false honnête, avec la raison', async () => {
    // pierre sans pioche partout autour : creuser donne 0 bloc → pas de toit possible
    const over = {};
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let y = 59; y <= 63; y++) over[`${dx},${y},${dz}`] = 'stone';
    const w = world({ at: { x: 0.5, y: GROUND + 1, z: 0.5 }, over });
    const { sealed } = await buildCell(w);
    assert.equal(sealed.sealed, false);
    assert.equal(sealed.why, 'no_block');
  });
});

// TÉLÉPORT ≠ RECUL (live 22/10, NethBot1 session 206 : `dig_in → reflex fight skeleton → teleported dist:6
// → reflex flee → teleported dist:8 → walled_in after:teleported → mort`). Un recul de quelques blocs
// pendant le creusage abandonnait le trou commencé pour en recommencer un ailleurs, à découvert.
describe('abri : un RECUL pendant le creusage ramène dans le trou commencé', () => {
  it('reculé de 5 blocs après le 1er coup → `pushed`, retour dans la colonne, puits fini (3 blocs), jamais `teleported`', async () => {
    const w = world({ at: { x: 0.5, y: GROUND + 1, z: 0.5 } });
    const dig0 = w.bot.dig;
    let n = 0;
    w.bot.dig = async (b) => {
      await dig0(b);
      n++;
      if (n === 1) w.bot.entity.position = new Vec3(5.5, w.bot.entity.position.y, 0.5);   // flèche / fuite
    };
    const { events, sealed } = await buildCell(w);
    assert.ok(events.some((e) => e.action === 'pushed'), 'recul tracé');
    assert.ok(!events.some((e) => e.action === 'teleported'), 'un recul n est pas un téléport');
    assert.ok(!events.some((e) => e.action === 'walled_in'), 'pas de plan B');
    const p = w.bot.entity.position;
    assert.equal(Math.floor(p.x), 0, 'revenu dans la colonne du trou commencé');
    assert.equal(sealed.depth, SHELTER_PIT_DEPTH);
    assert.ok(w.log.digs.every((k) => k.startsWith('0,') && k.endsWith(',0')), 'un seul puits, au même endroit');
  });
  it('vrai téléport (≥ 10 blocs) pendant le creusage → `teleported`, pas de retour', async () => {
    const w = world({ at: { x: 0.5, y: GROUND + 1, z: 0.5 } });
    const dig0 = w.bot.dig;
    let n = 0;
    w.bot.dig = async (b) => {
      await dig0(b);
      n++;
      if (n === 1) w.bot.entity.position = new Vec3(400.5, GROUND + 1, 300.5);   // /home safe
    };
    const { events } = await buildCell(w);
    assert.ok(events.some((e) => e.action === 'teleported'));
    assert.ok(!events.some((e) => e.action === 'pushed'));
  });
  it('la case est « tenue » pendant l abri et RELÂCHÉE à la fin', async () => {
    const w = world({ at: { x: 0.5, y: GROUND + 1, z: 0.5 } });
    let held = false;
    const dig0 = w.bot.dig;
    w.bot.dig = async (b) => { held = held || !!w.bot._mcaShelterCell; await dig0(b); };
    await buildCell(w);
    assert.ok(held);
    assert.equal(w.bot._mcaShelterCell, null);
  });
});

describe('shelterHold (PUR)', () => {
  const cell = { x: 0.5, y: 64, z: 0.5, walled: false };
  it('enterré dans sa colonne → tenu ; encore en surface → pas tenu ; sorti de la colonne → pas tenu', () => {
    assert.equal(shelterHold(cell, { x: 0.5, y: 63, z: 0.5 }), true);
    assert.equal(shelterHold(cell, { x: 0.5, y: 61, z: 0.6 }), true);
    assert.equal(shelterHold(cell, { x: 0.5, y: 64, z: 0.5 }), false);
    assert.equal(shelterHold(cell, { x: 3.5, y: 63, z: 0.5 }), false);
  });
  it('muré au niveau du sol → tenu dans sa case ; donnée absente → false', () => {
    assert.equal(shelterHold({ x: 0.5, y: 64, z: 0.5, walled: true }, { x: 0.6, y: 64, z: 0.5 }), true);
    assert.equal(shelterHold(null, { x: 0, y: 0, z: 0 }), false);
    assert.equal(shelterHold(cell, null), false);
  });
});
