'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { panicWall } = require('./panicWall');

// ─── Mock bot factory ────────────────────────────────────────────────────────
// Modelé sur test/placeBlockNear.test.js : blockAt keyé par x,y,z floorés ;
// placeBlock mute le monde (le bloc posé apparaît à refBlock.position + face) ;
// entity.position est un vrai Vec3 (→ .floored() marche).
function makeBot({ position, blocks = {}, inventory = [] }) {
  const blockMap = Object.assign({}, blocks);

  function blockAt(pos) {
    const fx = Math.floor(pos.x), fy = Math.floor(pos.y), fz = Math.floor(pos.z);
    const k = `${fx},${fy},${fz}`;
    if (blockMap[k] === undefined) {
      // par défaut : tout est de l'air (open cave) — c'est exactement le cas piège
      return { name: 'air', position: new Vec3(fx, fy, fz), boundingBox: 'empty' };
    }
    return Object.assign({ position: new Vec3(fx, fy, fz) }, blockMap[k]);
  }

  const equipCalls = [];
  const placeBlockCalls = [];
  let heldItem = null;

  const bot = {
    entity: { position: new Vec3(position[0], position[1], position[2]) },
    get heldItem() { return heldItem; },
    inventory: {
      items: () => inventory.map((n) => ({ name: n })),
    },
    blockAt,
    _blockMap: blockMap,
    equip: async (item, slot) => {
      equipCalls.push({ item: item && item.name, slot });
      heldItem = { name: item && item.name };
    },
    placeBlock: async (refBlock, face) => {
      placeBlockCalls.push({ refBlock, face });
      // Simule le bloc posé apparaissant à refBlock.position + face (comme le vrai monde)
      if (refBlock && refBlock.position && face) {
        const p = refBlock.position.plus(face);
        blockMap[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`] =
          { name: 'cobblestone', boundingBox: 'block' };
      }
    },
    _equipCalls: equipCalls,
    _placeBlockCalls: placeBlockCalls,
  };
  return bot;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('panicWall', () => {

  it('panicWall bridges then walls in an open cave', async () => {
    // Bot à (0,64,0). Le sol SOUS le bot (0,63,0) est solide, mais TOUT le reste est de l'air
    // (grotte ouverte : les voisins flottent, aucun sol sous eux). L'ancien code ne posait RIEN.
    const bot = makeBot({
      position: [0, 64, 0],
      blocks: {
        '0,63,0': { name: 'stone', boundingBox: 'block' }, // le bloc sur lequel le bot se tient
      },
      inventory: ['stone_pickaxe', 'cobblestone'],
    });

    const result = await panicWall(bot);

    assert.equal(result.ok, true, 'un mur doit se former en grotte ouverte');
    assert.ok(result.placed > 0, `placed=${result.placed} doit être > 0`);

    // Preuve du pont (bridge) : au moins une pose a utilisé le bloc SOL DU BOT (0,63,0) comme
    // référence. L'ancien code référençait le bloc sous chaque voisin (air en grotte) → 0 pose.
    const usedFloorRef = bot._placeBlockCalls.some((c) =>
      c.refBlock && c.refBlock.position && c.refBlock.position.equals(new Vec3(0, 63, 0)));
    assert.ok(usedFloorRef, 'au moins une pose doit s\'ancrer sur le bloc sol du bot (le pont)');
  });

  it('panicWall on solid ground walls all 4 sides', async () => {
    // Sol plein partout sous les voisins → le pont est sauté (belowN déjà solide) → mur normal.
    // Chaque direction pose 2 blocs (dy 0 et 1) → 4 directions × 2 = 8.
    const bot = makeBot({
      position: [0, 64, 0],
      blocks: {
        // sols solides sous les 4 voisins (bridge skip)
        '1,63,0': { name: 'stone', boundingBox: 'block' },
        '-1,63,0': { name: 'stone', boundingBox: 'block' },
        '0,63,1': { name: 'stone', boundingBox: 'block' },
        '0,63,-1': { name: 'stone', boundingBox: 'block' },
        // sol sous le bot aussi (cohérence)
        '0,63,0': { name: 'stone', boundingBox: 'block' },
        // les cases murs (y=64, y=65) restent air par défaut
      },
      inventory: ['cobblestone'],
    });

    const result = await panicWall(bot);

    assert.equal(result.ok, true);
    assert.equal(result.placed, 8, 'mur complet 4 côtés × 2 de haut = 8');
  });

  it('panicWall returns no_block with no wall material', async () => {
    const bot = makeBot({
      position: [0, 64, 0],
      blocks: { '0,63,0': { name: 'stone', boundingBox: 'block' } },
      inventory: ['stone_pickaxe'], // aucun bloc posable
    });

    const result = await panicWall(bot);

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_block');
    assert.equal(result.placed, 0);
    assert.equal(bot._placeBlockCalls.length, 0);
  });

});
