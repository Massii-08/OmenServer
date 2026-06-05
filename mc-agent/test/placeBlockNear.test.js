'use strict';
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { placeBlockNear } = require('../skills/placeBlockNear');

// ─── Mock bot factory ────────────────────────────────────────────────────────

function makeBot({ position, blocks = {}, inventory = [], toolFor = null }) {
  // blocks is { 'x,y,z': { name, boundingBox } }
  const blockMap = Object.assign({}, blocks);

  function blockAt(pos) {
    const fx = Math.floor(pos.x), fy = Math.floor(pos.y), fz = Math.floor(pos.z);
    const k = `${fx},${fy},${fz}`;
    if (blockMap[k] === undefined) return null;
    // attache la position (le vrai mineflayer.block en a une ; placeBlock s'en sert)
    return Object.assign({ position: new Vec3(fx, fy, fz) }, blockMap[k]);
  }

  const equipCalls = [];
  const digCalls = [];
  const placeBlockCalls = [];

  return {
    entity: { position: new Vec3(position[0], position[1], position[2]) },
    inventory: {
      items: () => inventory.map((n) => ({ name: n })),
    },
    blockAt,
    _blockMap: blockMap,
    equip: async (item, slot) => { equipCalls.push({ item: item && item.name, slot }); },
    dig: async (block) => {
      digCalls.push({ block });
      // Simulate the block becoming air after digging
      const k = `${Math.floor(block.x)},${Math.floor(block.y)},${Math.floor(block.z)}`;
      blockMap[k] = { name: 'air', boundingBox: 'empty' };
    },
    placeBlock: async (refBlock, face) => {
      placeBlockCalls.push({ refBlock, face });
      // Simule le bloc posé apparaissant à refBlock.position + face (comme le vrai monde)
      if (refBlock && refBlock.position && face) {
        const p = refBlock.position.plus(face);
        blockMap[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`] = { name: 'placed', boundingBox: 'block' };
      }
    },
    // Tracking arrays exposed for assertions
    _equipCalls: equipCalls,
    _digCalls: digCalls,
    _placeBlockCalls: placeBlockCalls,
    // registry for bestToolFor (pickaxe for stone)
    registry: {
      blocksByName: {
        stone: { id: 1 },
        air: { id: 0 },
        crafting_table: { id: 58 },
      },
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('placeBlockNear', () => {

  it('unknown_item: returns {ok:false, reason:"unknown_item"} when item not in inventory', async () => {
    const bot = makeBot({
      position: [0, 64, 0],
      blocks: {},
      inventory: ['dirt'],
    });
    const result = await placeBlockNear(bot, 'crafting_table');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unknown_item');
    assert.equal(bot._digCalls.length, 0);
    assert.equal(bot._placeBlockCalls.length, 0);
  });

  it('open surface: Pass 1 places without digging when east neighbour is air over solid floor', async () => {
    // Bot at (0,64,0); neighbour (1,64,0) = air, floor (1,63,0) = stone
    const bot = makeBot({
      position: [0, 64, 0],
      blocks: {
        '1,63,0': { name: 'stone', boundingBox: 'block' },   // floor under neighbour
        '1,64,0': { name: 'air', boundingBox: 'empty' },     // target = air → replaceable
      },
      inventory: ['crafting_table'],
    });
    const result = await placeBlockNear(bot, 'crafting_table');
    assert.equal(result.ok, true);
    assert.ok(result.pos, 'should return pos');
    assert.equal(result.pos.x, 1);
    assert.equal(result.pos.y, 64);
    assert.equal(result.pos.z, 0);
    assert.equal(bot._digCalls.length, 0, 'dig should NOT be called in Pass 1');
    assert.equal(bot._placeBlockCalls.length, 1, 'placeBlock should be called once');
  });

  it('grass surface: Pass 1 places without digging when neighbour is short_grass (replaceable)', async () => {
    // Bot at (0,64,0); neighbour (1,64,0) = short_grass, floor (1,63,0) = stone
    const bot = makeBot({
      position: [0, 64, 0],
      blocks: {
        '1,63,0': { name: 'stone', boundingBox: 'block' },
        '1,64,0': { name: 'short_grass', boundingBox: 'empty' },
      },
      inventory: ['crafting_table'],
    });
    const result = await placeBlockNear(bot, 'crafting_table');
    assert.equal(result.ok, true);
    assert.ok(result.pos, 'should return pos');
    assert.equal(bot._digCalls.length, 0, 'dig should NOT be called for replaceable cell');
    assert.equal(bot._placeBlockCalls.length, 1);
  });

  it('enclosed shaft: Pass 2 digs one neighbour then places (all 4 sides solid)', async () => {
    // Bot at (0,64,0); all 4 neighbours at y=64 are stone (solid, not replaceable)
    // All floors (y=63) are also stone (solid)
    const bot = makeBot({
      position: [0, 64, 0],
      blocks: {
        // East direction
        '1,63,0': { name: 'stone', boundingBox: 'block' },
        '1,64,0': { name: 'stone', boundingBox: 'block' },
        // West direction
        '-1,63,0': { name: 'stone', boundingBox: 'block' },
        '-1,64,0': { name: 'stone', boundingBox: 'block' },
        // South direction
        '0,63,1': { name: 'stone', boundingBox: 'block' },
        '0,64,1': { name: 'stone', boundingBox: 'block' },
        // North direction
        '0,63,-1': { name: 'stone', boundingBox: 'block' },
        '0,64,-1': { name: 'stone', boundingBox: 'block' },
      },
      inventory: ['crafting_table', 'iron_pickaxe'],
    });
    const result = await placeBlockNear(bot, 'crafting_table');
    assert.equal(result.ok, true, 'should succeed in enclosed shaft via Pass 2');
    assert.ok(result.pos, 'should return pos');
    assert.equal(bot._digCalls.length, 1, 'dig should be called exactly once');
    assert.equal(bot._placeBlockCalls.length, 1, 'placeBlock should be called once');
  });

  it('fully blocked: no solid floor anywhere → {ok:false, reason:"no_space"}', async () => {
    // All neighbours' floors are null (unloaded/air) — no solid floor to place on
    const bot = makeBot({
      position: [0, 64, 0],
      blocks: {
        // Neighbour cells exist as stone but floors below them are absent (null)
        '1,64,0': { name: 'stone', boundingBox: 'block' },
        '-1,64,0': { name: 'stone', boundingBox: 'block' },
        '0,64,1': { name: 'stone', boundingBox: 'block' },
        '0,64,-1': { name: 'stone', boundingBox: 'block' },
        // floors are null (not in map → blockAt returns null)
      },
      inventory: ['crafting_table'],
    });
    const result = await placeBlockNear(bot, 'crafting_table');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_space');
    assert.equal(bot._digCalls.length, 0);
    assert.equal(bot._placeBlockCalls.length, 0);
  });

  it('no_space when neighbour is bedrock (non-diggable): skips, returns no_space', async () => {
    // All 4 neighbours are bedrock — Pass 1 fails (not replaceable), Pass 2 skips (not diggable)
    const bot = makeBot({
      position: [0, 64, 0],
      blocks: {
        '1,63,0': { name: 'stone', boundingBox: 'block' },
        '1,64,0': { name: 'bedrock', boundingBox: 'block' },
        '-1,63,0': { name: 'stone', boundingBox: 'block' },
        '-1,64,0': { name: 'bedrock', boundingBox: 'block' },
        '0,63,1': { name: 'stone', boundingBox: 'block' },
        '0,64,1': { name: 'bedrock', boundingBox: 'block' },
        '0,63,-1': { name: 'stone', boundingBox: 'block' },
        '0,64,-1': { name: 'bedrock', boundingBox: 'block' },
      },
      inventory: ['crafting_table'],
    });
    const result = await placeBlockNear(bot, 'crafting_table');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_space');
    assert.equal(bot._digCalls.length, 0, 'should not dig bedrock');
  });

  it('Pass 1 with cave_air (replaceable): places without digging', async () => {
    const bot = makeBot({
      position: [0, 64, 0],
      blocks: {
        '1,63,0': { name: 'stone', boundingBox: 'block' },
        '1,64,0': { name: 'cave_air', boundingBox: 'empty' },
      },
      inventory: ['crafting_table'],
    });
    const result = await placeBlockNear(bot, 'crafting_table');
    assert.equal(result.ok, true);
    assert.equal(bot._digCalls.length, 0);
    assert.equal(bot._placeBlockCalls.length, 1);
    // pos must be Vec3-like with correct coordinates
    assert.equal(result.pos.x, 1);
    assert.equal(result.pos.y, 64);
    assert.equal(result.pos.z, 0);
  });

  it('enclosed shaft: pos is correct Vec3-like value', async () => {
    // Verify the returned pos in Pass 2 is the first successfully dug direction
    const bot = makeBot({
      position: [0, 64, 0],
      blocks: {
        // Only east side has solid floor; east target is stone → dug
        '1,63,0': { name: 'stone', boundingBox: 'block' },
        '1,64,0': { name: 'stone', boundingBox: 'block' },
        // Other dirs: no floor (null) → Pass 2 skips them
        '-1,64,0': { name: 'stone', boundingBox: 'block' },
        '0,64,1': { name: 'stone', boundingBox: 'block' },
        '0,64,-1': { name: 'stone', boundingBox: 'block' },
      },
      inventory: ['crafting_table', 'iron_pickaxe'],
    });
    const result = await placeBlockNear(bot, 'crafting_table');
    assert.equal(result.ok, true);
    // East is the first direction tried → pos should be (1,64,0)
    assert.equal(result.pos.x, 1);
    assert.equal(result.pos.y, 64);
    assert.equal(result.pos.z, 0);
  });

  it('pedestal (Pass 3): neighbours AND their floors are air → place a support block, then the table', async () => {
    // Le bot se tient sur (0,63,0) solide ; les 4 cases voisines (niveau pieds) ET leurs sols sont
    // en air (il a miné autour de lui en récoltant le cobble). Pass 1/2 échouent ; Pass 3 pose un
    // remblai (dirt) pour combler un sol voisin, puis la table dessus.
    const bot = makeBot({
      position: [0, 64, 0],
      blocks: {
        '0,63,0': { name: 'stone', boundingBox: 'block' },   // sol SOUS le bot (solide)
        '1,64,0': { name: 'air', boundingBox: 'empty' },     // voisins niveau pieds = air
        '-1,64,0': { name: 'air', boundingBox: 'empty' },
        '0,64,1': { name: 'air', boundingBox: 'empty' },
        '0,64,-1': { name: 'air', boundingBox: 'empty' },
        // sols voisins (y=63) absents (null) → pas de sol → Pass 1/2 ne peuvent pas
      },
      inventory: ['crafting_table', 'dirt'],
    });
    const result = await placeBlockNear(bot, 'crafting_table');
    assert.equal(result.ok, true, 'Pass 3 doit réussir sur un piédestal avec un bloc de remblai');
    assert.ok(result.pos, 'should return pos');
    assert.equal(bot._placeBlockCalls.length, 2, 'remblai + table = 2 placeBlock');
    const equipped = bot._equipCalls.map((e) => e.item);
    assert.ok(equipped.includes('dirt'), 'doit équiper le remblai (dirt)');
    assert.ok(equipped.includes('crafting_table'), 'doit équiper la table');
  });

  it('pedestal but only cobblestone (réservé au craft) → no_space, ne sacrifie pas le cobble', async () => {
    const bot = makeBot({
      position: [0, 64, 0],
      blocks: {
        '0,63,0': { name: 'stone', boundingBox: 'block' },
        '1,64,0': { name: 'air', boundingBox: 'empty' },
        '-1,64,0': { name: 'air', boundingBox: 'empty' },
        '0,64,1': { name: 'air', boundingBox: 'empty' },
        '0,64,-1': { name: 'air', boundingBox: 'empty' },
      },
      inventory: ['crafting_table', 'cobblestone'],   // cobblestone EXCLU des remblais
    });
    const result = await placeBlockNear(bot, 'crafting_table');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_space');
    assert.equal(bot._placeBlockCalls.length, 0);
  });

});

// ─── #6 retours live : jamais de bloc flottant / pose fantôme ────────────────

describe('placeBlockNear — garde-fou anti-pose-illégale (#6)', () => {

  it('pose fantôme (placeBlock sans effet serveur) → ok:false, jamais un succès silencieux', async () => {
    const bot = makeBot({
      position: [0, 64, 0],
      blocks: {
        '1,63,0': { name: 'stone', boundingBox: 'block' },  // sol solide à l'est
        '1,64,0': { name: 'air', boundingBox: 'empty' },    // case libre
      },
      inventory: ['crafting_table'],
    });
    // simule une désync : le placeBlock ne crée RIEN dans le monde
    bot.placeBlock = async (refBlock, face) => { bot._placeBlockCalls.push({ refBlock, face }); };
    const result = await placeBlockNear(bot, 'crafting_table');
    assert.equal(result.ok, false, 'une pose non confirmée ne doit JAMAIS être un succès');
  });

  it('chaque placeBlock utilise une référence PLEINE (boundingBox block) — jamais sans support', async () => {
    const bot = makeBot({
      position: [0, 64, 0],
      blocks: {
        '1,63,0': { name: 'stone', boundingBox: 'block' },
        '1,64,0': { name: 'air', boundingBox: 'empty' },
      },
      inventory: ['crafting_table'],
    });
    const result = await placeBlockNear(bot, 'crafting_table');
    assert.equal(result.ok, true);
    for (const call of bot._placeBlockCalls) {
      assert.equal(call.refBlock.boundingBox, 'block', 'référence de pose non pleine');
    }
  });
});
