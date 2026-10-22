'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { takeCover, pickCoverBlock } = require('./takeCover');

// Harnais calqué sur panicWall.test.js : blockAt keyé x,y,z floorés, placeBlock mute le monde.
function makeBot({ position, blocks = {}, inventory = [] }) {
  const blockMap = Object.assign({}, blocks);

  function blockAt(pos) {
    const fx = Math.floor(pos.x), fy = Math.floor(pos.y), fz = Math.floor(pos.z);
    const k = `${fx},${fy},${fz}`;
    if (blockMap[k] === undefined) {
      return { name: 'air', position: new Vec3(fx, fy, fz), boundingBox: 'empty' };
    }
    return Object.assign({ position: new Vec3(fx, fy, fz) }, blockMap[k]);
  }

  const placeBlockCalls = [];
  let heldItem = null;

  return {
    entity: { position: new Vec3(position[0], position[1], position[2]) },
    get heldItem() { return heldItem; },
    inventory: { items: () => inventory.map((n) => ({ name: n })) },
    blockAt,
    equip: async (item) => { heldItem = { name: item && item.name }; },
    placeBlock: async (refBlock, face) => {
      placeBlockCalls.push({ ref: refBlock && refBlock.position, face });
      if (refBlock && refBlock.position && face) {
        const p = refBlock.position.plus(face);
        blockMap[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`] =
          { name: 'cobblestone', boundingBox: 'block' };
      }
    },
    _placed: placeBlockCalls,
    _blockMap: blockMap,
  };
}

const GROUND = {
  '0,63,0': { name: 'grass_block', boundingBox: 'block' },   // sol sous le bot
  '1,63,0': { name: 'grass_block', boundingBox: 'block' },   // sol de la case est
};

describe('takeCover', () => {

  it('pose un muret 2 de haut côté tireur (le cas « was shot by Skeleton »)', async () => {
    const bot = makeBot({ position: [0.5, 64, 0.5], blocks: GROUND, inventory: ['cobblestone'] });
    const r = await takeCover(bot, { position: new Vec3(14, 64, 0) });   // squelette à l'est
    assert.equal(r.ok, true);
    assert.equal(r.placed, 2);
    // le mur existe bien en (1,64,0) et (1,65,0) → la ligne de vue est coupée
    assert.equal(bot._blockMap['1,64,0'].boundingBox, 'block');
    assert.equal(bot._blockMap['1,65,0'].boundingBox, 'block');
  });

  it('sans bloc en poche → no_block, aucune pose tentée', async () => {
    const bot = makeBot({ position: [0.5, 64, 0.5], blocks: GROUND, inventory: ['diamond'] });
    const r = await takeCover(bot, { position: new Vec3(14, 64, 0) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_block');
    assert.equal(bot._placed.length, 0);
  });

  it('un côté déjà masqué compte comme couvert (on ne repose pas par-dessus)', async () => {
    const blocks = Object.assign({}, GROUND, {
      '1,64,0': { name: 'stone', boundingBox: 'block' },
      '1,65,0': { name: 'stone', boundingBox: 'block' },
    });
    const bot = makeBot({ position: [0.5, 64, 0.5], blocks, inventory: ['cobblestone'] });
    const r = await takeCover(bot, { position: new Vec3(14, 64, 0) });
    assert.equal(r.ok, true);
    assert.equal(bot._placed.length, 0, 'aucun bloc gaspillé sur un mur déjà là');
  });

  it('sol manquant côté tireur → s\'accroche à un côté solide', async () => {
    // Pas de sol en (1,63,0) : la pose par le dessous est impossible, mais (2,64,0) est solide.
    const blocks = { '0,63,0': { name: 'grass_block', boundingBox: 'block' },
                     '2,64,0': { name: 'stone', boundingBox: 'block' } };
    const bot = makeBot({ position: [0.5, 64, 0.5], blocks, inventory: ['dirt'] });
    const r = await takeCover(bot, { position: new Vec3(14, 64, 0) });
    assert.equal(r.placed >= 1, true, 'doit poser au moins le bloc niveau pieds');
  });

  it('tireur sans position / bot au même endroit → no_direction, jamais de crash', async () => {
    const bot = makeBot({ position: [0.5, 64, 0.5], blocks: GROUND, inventory: ['cobblestone'] });
    const r = await takeCover(bot, { position: new Vec3(0.5, 70, 0.5) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_direction');
  });

  it('un refus du serveur sur la 2e pose n\'annule pas la 1re (best-effort)', async () => {
    const bot = makeBot({ position: [0.5, 64, 0.5], blocks: GROUND, inventory: ['cobblestone'] });
    const orig = bot.placeBlock;
    let n = 0;
    bot.placeBlock = async (ref, face) => {
      n += 1;
      if (n === 2) throw new Error('placement refusé par le serveur');
      return orig(ref, face);
    };
    const r = await takeCover(bot, { position: new Vec3(14, 64, 0) });
    assert.equal(r.ok, true);
    assert.equal(r.placed, 1, 'le bloc pieds reste posé (demi-couvert vaut mieux que rien)');
  });

  it('un refus sur la pose PIEDS ne jette pas — et la tête ne flotte pas', async () => {
    // Mécanique réelle : le bloc tête s'appuie sur le bloc pieds. Si les pieds échouent, il n'y a
    // plus rien où s'accrocher (ni dessous, ni sur les côtés) → 0 posé, mais AUCUNE exception.
    const bot = makeBot({ position: [0.5, 64, 0.5], blocks: GROUND, inventory: ['cobblestone'] });
    bot.placeBlock = async () => { throw new Error('placement refusé par le serveur'); };
    const r = await takeCover(bot, { position: new Vec3(14, 64, 0) });
    assert.equal(r.ok, false);
    assert.equal(r.placed, 0);
  });

  // ── 22/10 : `take_cover placed:0 ok:false` sans raison (session 155, mort 0,5 s après ; 1121/2431 au total) ──
  it('chaque échec DIT pourquoi : rien où s accrocher → no_support', async () => {
    const bot = makeBot({ position: [0.5, 64, 0.5], blocks: {}, inventory: ['cobblestone'] });
    const r = await takeCover(bot, { position: new Vec3(14, 64, 0) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_support');
    assert.deepEqual(r.cells, ['no_support', 'no_support']);
  });

  it('pose refusée par le serveur → reason place_rejected (et le message est gardé)', async () => {
    const bot = makeBot({ position: [0.5, 64, 0.5], blocks: GROUND, inventory: ['cobblestone'] });
    bot.placeBlock = async () => { throw new Error('No block has been placed : the block is still air'); };
    const r = await takeCover(bot, { position: new Vec3(14, 64, 0) });
    assert.equal(r.reason, 'place_rejected');
    assert.match(r.error, /still air/);
  });

  it('equip qui ne prend pas (main toujours occupée) → equip_failed, AUCUNE pose avec la nourriture en main', async () => {
    const bot = makeBot({ position: [0.5, 64, 0.5], blocks: GROUND, inventory: ['cobblestone'] });
    bot.equip = async () => {};                       // le serveur n a pas suivi : la main tient toujours rien
    const r = await takeCover(bot, { position: new Vec3(14, 64, 0) });
    assert.equal(r.reason, 'equip_failed');
    assert.equal(bot._placed.length, 0);
  });

  it('en train de MANGER (usingHeldItem) → on lâche la nourriture avant d équiper le bloc', async () => {
    const bot = makeBot({ position: [0.5, 64, 0.5], blocks: GROUND, inventory: ['cobblestone'] });
    bot.usingHeldItem = true;
    let deact = 0;
    bot.deactivateItem = () => { deact++; bot.usingHeldItem = false; };
    const r = await takeCover(bot, { position: new Vec3(14, 64, 0) });
    assert.equal(deact, 1);
    assert.equal(r.placed, 2);
  });

  it('pose jamais confirmée (mineflayer attend 5 s) → bornée PAR POSE, reason place_timeout, le budget global tient', async () => {
    const bot = makeBot({ position: [0.5, 64, 0.5], blocks: GROUND, inventory: ['cobblestone'] });
    bot.placeBlock = () => new Promise(() => {});      // le blockUpdate n arrive jamais
    const t0 = Date.now();
    const r = await takeCover(bot, { position: new Vec3(14, 64, 0) }, { placeTimeoutMs: 30, budgetMs: 200 });
    assert.ok(Date.now() - t0 < 500, 'rend la main dans son budget, pas après 3 s de timeout extérieur');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'place_timeout');
  });

  it('pose confirmée EN RETARD (bloc solide après la borne) → comptée', async () => {
    const bot = makeBot({ position: [0.5, 64, 0.5], blocks: GROUND, inventory: ['cobblestone'] });
    bot.placeBlock = (ref, face) => {
      const p = ref.position.plus(face);
      bot._blockMap[`${p.x},${p.y},${p.z}`] = { name: 'cobblestone', boundingBox: 'block' };
      return new Promise(() => {});
    };
    const r = await takeCover(bot, { position: new Vec3(14, 64, 0) }, { placeTimeoutMs: 20 });
    assert.equal(r.ok, true);
    assert.equal(r.placed, 2);
  });

  it('DEUX couverts concurrents (réflexe defensive + flee, session 155) → un seul pose, l autre le rejoint', async () => {
    const bot = makeBot({ position: [0.5, 64, 0.5], blocks: GROUND, inventory: ['cobblestone'] });
    const [a, b] = await Promise.all([
      takeCover(bot, { position: new Vec3(14, 64, 0) }),
      takeCover(bot, { position: new Vec3(14, 64, 0) }),
    ]);
    assert.equal(bot._placed.length, 2, 'pas de pose en double ni d equip croisé');
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(b.joined, true);
    assert.equal(bot._mcaCoverInFlight, null);
  });

  it('pickCoverBlock : prend un bloc sacrifiable, jamais un item précieux', () => {
    assert.equal(pickCoverBlock({ inventory: { items: () => [{ name: 'diamond' }, { name: 'dirt' }] } }).name, 'dirt');
    assert.equal(pickCoverBlock({ inventory: { items: () => [{ name: 'oak_planks' }] } }).name, 'oak_planks');
    assert.equal(pickCoverBlock({ inventory: { items: () => [{ name: 'diamond' }] } }), null);
  });
});
