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

  it('pickCoverBlock : prend un bloc sacrifiable, jamais un item précieux', () => {
    assert.equal(pickCoverBlock({ inventory: { items: () => [{ name: 'diamond' }, { name: 'dirt' }] } }).name, 'dirt');
    assert.equal(pickCoverBlock({ inventory: { items: () => [{ name: 'oak_planks' }] } }).name, 'oak_planks');
    assert.equal(pickCoverBlock({ inventory: { items: () => [{ name: 'diamond' }] } }), null);
  });
});
