'use strict';
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { placeBlockNear, isBreakableClutter } = require('../skills/placeBlockNear');

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
  const order = [];   // chronologie dig/place (« on casse AVANT de poser »)

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
      order.push('dig:' + (block && block.name));
      // Simulate the block becoming air after digging. Le vrai Block porte `.position` (blockAt
      // l'attache) : on lit la case LÀ — l'ancienne lecture de block.x visait une clé NaN, donc le
      // bloc cassé ne devenait jamais de l'air dans le mock (invisible tant qu'aucun test ne
      // regardait ce qui reste après le cassage).
      const p = (block && block.position) || block;
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
      blockMap[k] = { name: 'air', boundingBox: 'empty' };
    },
    placeBlock: async (refBlock, face) => {
      placeBlockCalls.push({ refBlock, face });
      order.push('place:' + (refBlock && refBlock.name));
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
    _order: order,
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

// ─── Pass 4 : poser CONTRE UNE PAROI (analyse run world_ax4, 26/07) ──────────
// `no_table:no_space` ×71 sur le run, en tunnel de minage. Les passes 1-3 ne savent poser que
// SUR UN SOL. En jeu, un bloc s'accroche à n'importe quelle face pleine : dans un tunnel dont le
// sol de la case voisine manque mais dont le mur est plein, un joueur pose contre le mur.
describe('placeBlockNear — pass 4 (paroi)', () => {
  it('sol voisin ABSENT mais paroi pleine → pose quand même contre la paroi', async () => {
    const bot = makeBot({
      position: [0.5, 64, 0.5],
      blocks: {
        '0,63,0': { name: 'stone', boundingBox: 'block' },      // sol sous le bot
        '1,64,0': { name: 'air', boundingBox: 'empty' },        // case cible : libre
        // PAS de sol en 1,63,0 → passes 1 et 2 abandonnent
        '1,64,1': { name: 'stone', boundingBox: 'block' },      // paroi latérale de la case cible
      },
      inventory: ['crafting_table'],
    });
    const r = await placeBlockNear(bot, 'crafting_table');
    assert.equal(r.ok, true, 'la paroi doit suffire');
    assert.equal(r.pos.x, 1);
  });

  it('aucune face pleine nulle part → no_space (on n\'invente pas)', async () => {
    const bot = makeBot({
      position: [0.5, 64, 0.5],
      blocks: {
        '0,63,0': { name: 'stone', boundingBox: 'block' },
        '1,64,0': { name: 'air', boundingBox: 'empty' },
      },
      inventory: ['crafting_table'],
    });
    const r = await placeBlockNear(bot, 'crafting_table');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_space');
  });
});

// ─── TUNNEL DE MINAGE : les 4 cases au niveau des PIEDS ne suffisent pas ────────────────────────
// Mesure live world_mn11 (28/07) : `no_table:no_space` x8 — sur `furnace` ET `spare_picks` — une
// fois que le correctif combustible a enfin amene le planner jusqu a l etape de craft. Les
// candidats ne couvraient que les 4 voisins horizontaux au niveau des pieds ; dans un tunnel 1x2
// fraichement creuse ces cases sont murees (parois) ou occupees, et le bot abandonnait son craft
// alors qu il avait de la place a HAUTEUR DE TETE et en diagonale. Un joueur pose sa table la.
describe('placeBlockNear : tunnel etroit', () => {
  it('pose a HAUTEUR DE TETE quand les 4 cases au sol sont murees', async () => {
    const blocks = {};
    const solid = { name: 'deepslate', boundingBox: 'block' };
    const air = { name: 'air', boundingBox: 'empty' };
    // Bot en (0,10,0). Tunnel 1x2 : ses 2 cases (pieds+tete) sont libres, tout le reste est plein…
    for (let x = -2; x <= 2; x++) {
      for (let y = 8; y <= 13; y++) {
        for (let z = -2; z <= 2; z++) blocks[`${x},${y},${z}`] = { ...solid };
      }
    }
    blocks['0,10,0'] = { ...air };
    blocks['0,11,0'] = { ...air };
    // … SAUF une poche libre a hauteur de tete, juste a cote : c est la que ca doit se poser.
    blocks['1,11,0'] = { ...air };

    const bot = makeBot({ position: [0.5, 10, 0.5], inventory: ['crafting_table'] });
    Object.assign(bot._blockMap, blocks);
    const r = await placeBlockNear(bot, 'crafting_table');
    assert.equal(r.ok, true, 'une poche a hauteur de tete doit etre utilisee');
  });

  it('pose en DIAGONALE quand les 4 cardinaux sont pris', async () => {
    const blocks = {};
    const solid = { name: 'deepslate', boundingBox: 'block' };
    const air = { name: 'air', boundingBox: 'empty' };
    for (let x = -2; x <= 2; x++) {
      for (let y = 8; y <= 13; y++) {
        for (let z = -2; z <= 2; z++) blocks[`${x},${y},${z}`] = { ...solid };
      }
    }
    blocks['0,10,0'] = { ...air };
    blocks['0,11,0'] = { ...air };
    blocks['1,10,1'] = { ...air };            // seule ouverture : une diagonale au sol

    const bot = makeBot({ position: [0.5, 10, 0.5], inventory: ['crafting_table'] });
    Object.assign(bot._blockMap, blocks);
    const r = await placeBlockNear(bot, 'crafting_table');
    assert.equal(r.ok, true, 'une diagonale libre doit etre utilisee');
  });
});

// Hypothese a EPROUVER : en tunnel INONDE, les 4 voisins sont de l EAU — ni « replaceable »
// (elle n est pas dans REPLACEABLE) ni creusable (elle est dans NON_DIGGABLE) → toutes les passes
// echouent → `no_space`. Or en Minecraft on POSE dans l eau : le bloc chasse le fluide.
describe('placeBlockNear : tunnel INONDE', () => {
  it('reproduit no_space quand tous les voisins sont de l eau', async () => {
    const blocks = {};
    const water = { name: 'water', boundingBox: 'empty' };
    const solid = { name: 'deepslate', boundingBox: 'block' };
    for (let x = -2; x <= 2; x++) {
      for (let y = 8; y <= 13; y++) {
        for (let z = -2; z <= 2; z++) blocks[`${x},${y},${z}`] = { ...solid };
      }
    }
    blocks['0,10,0'] = { name: 'air', boundingBox: 'empty' };
    blocks['0,11,0'] = { name: 'air', boundingBox: 'empty' };
    for (const k of ['1,10,0', '-1,10,0', '0,10,1', '0,10,-1']) blocks[k] = { ...water };

    const bot = makeBot({ position: [0.5, 10, 0.5], inventory: ['crafting_table'] });
    Object.assign(bot._blockMap, blocks);
    const r = await placeBlockNear(bot, 'crafting_table');
    assert.equal(r.ok, true, 'on doit pouvoir poser DANS l eau (le bloc chasse le fluide)');
  });
});

// ─── ENCOMBREMENT CASSABLE : fleurs & petite végétation non solide ───────────────────────────────
// Mesure live (run de 216 sessions) : `no_table:no_space` sur spare_picks ×391, furnace,
// stone_pickaxe, stone_sword, wooden_pickaxe — et un bot EN SURFACE (y≈117, prairie d'altitude) a
// échoué 4/4 `furnace` en 2 minutes. Cause : REPLACEABLE ne connaît que air/eau/herbes/neige. Une
// FLEUR (boundingBox 'empty') n'est ni remplaçable (Pass 1 la saute), ni creusable (Pass 2 ne creuse
// que les blocs PLEINS), ni acceptée par la Pass 4 → dans un champ de fleurs les 4 voisins sont
// « encombrés » alors qu'un joueur casserait la fleur d'un coup de poing et poserait sa table.

const emptyBlock = (name) => ({ name, boundingBox: 'empty' });
const solidBlock = (name) => ({ name, boundingBox: 'block' });

describe('isBreakableClutter', () => {
  it('panel de base : poppy oui ; torche, eau, lave, pierre, air non', () => {
    assert.equal(isBreakableClutter(emptyBlock('poppy')), true);
    assert.equal(isBreakableClutter(emptyBlock('torch')), false);
    assert.equal(isBreakableClutter(emptyBlock('water')), false);
    assert.equal(isBreakableClutter(emptyBlock('lava')), false);
    assert.equal(isBreakableClutter(solidBlock('stone')), false);
    assert.equal(isBreakableClutter(emptyBlock('air')), false);
  });

  it('règle GÉNÉRIQUE : toute petite végétation non solide est cassable (pas une liste de fleurs)', () => {
    const vegetation = [
      'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip',
      'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'torchflower',
      'wither_rose', 'pink_petals', 'dead_bush', 'sweet_berry_bush', 'oak_sapling', 'cherry_sapling',
      'brown_mushroom', 'red_mushroom', 'crimson_fungus', 'warped_fungus', 'crimson_roots',
      'warped_roots', 'nether_sprouts', 'glow_lichen', 'vine', 'hanging_roots', 'small_dripleaf',
      'moss_carpet', 'white_carpet', 'leaf_litter', 'bush', 'firefly_bush', 'cactus_flower',
      'sunflower', 'lilac', 'rose_bush', 'peony', 'tall_seagrass', 'powder_snow', 'sculk_vein',
      // un nom qu'AUCUNE liste ne connaît : seul le boundingBox décide
      'some_future_flower_nobody_listed',
    ];
    for (const n of vegetation) assert.equal(isBreakableClutter(emptyBlock(n)), true, n + ' doit être cassable');
  });

  it('JAMAIS : fluides, feu, portails, colonne de bulles', () => {
    for (const n of ['water', 'flowing_water', 'lava', 'flowing_lava', 'fire', 'soul_fire',
      'nether_portal', 'end_portal', 'end_gateway', 'bubble_column']) {
      assert.equal(isBreakableClutter(emptyBlock(n)), false, n + ' ne doit jamais être cassé');
    }
  });

  it('JAMAIS : torches — ce sont souvent NOS torches de tunnel', () => {
    for (const n of ['torch', 'wall_torch', 'soul_torch', 'soul_wall_torch',
      'redstone_torch', 'redstone_wall_torch']) {
      assert.equal(isBreakableClutter(emptyBlock(n)), false, n + ' ne doit jamais être cassé');
    }
  });

  it('JAMAIS : rails et redstone (mécanismes) — ni leviers, boutons, plaques de pression', () => {
    for (const n of ['rail', 'powered_rail', 'detector_rail', 'activator_rail', 'redstone_wire',
      'tripwire', 'tripwire_hook', 'lever', 'stone_button', 'oak_button', 'crimson_button',
      'polished_blackstone_button', 'stone_pressure_plate', 'oak_pressure_plate',
      'light_weighted_pressure_plate', 'heavy_weighted_pressure_plate']) {
      assert.equal(isBreakableClutter(emptyBlock(n)), false, n + ' ne doit jamais être cassé');
    }
  });

  it('JAMAIS : la toile d\'araignée (20 s à la main — on ne s\'y engage pas)', () => {
    assert.equal(isBreakableClutter(emptyBlock('cobweb')), false);
  });

  it('un bloc PLEIN n\'est pas de l\'encombrement, quel que soit son nom (feuilles, cactus, tronc)', () => {
    for (const n of ['oak_leaves', 'cactus', 'oak_log', 'stone', 'crafting_table']) {
      assert.equal(isBreakableClutter(solidBlock(n)), false, n);
    }
  });

  it('déjà REPLACEABLE → pas « encombrement » (la Pass 1 pose dedans SANS casser)', () => {
    for (const n of ['air', 'cave_air', 'short_grass', 'fern', 'tall_grass', 'snow', 'seagrass', 'kelp']) {
      assert.equal(isBreakableClutter(emptyBlock(n)), false, n);
    }
  });

  it('bloc absent (chunk non chargé, null/undefined) → false', () => {
    assert.equal(isBreakableClutter(null), false);
    assert.equal(isBreakableClutter(undefined), false);
  });
});

describe('placeBlockNear — Pass 1b (encombrement cassable)', () => {
  // 4 voisins = 4 fleurs différentes, 4 sols pleins : le cas « prairie fleurie » du bug
  function meadow() {
    return makeBot({
      position: [0, 64, 0],
      blocks: {
        '1,63,0': solidBlock('grass_block'), '1,64,0': emptyBlock('poppy'),
        '-1,63,0': solidBlock('grass_block'), '-1,64,0': emptyBlock('dandelion'),
        '0,63,1': solidBlock('grass_block'), '0,64,1': emptyBlock('blue_orchid'),
        '0,63,-1': solidBlock('grass_block'), '0,64,-1': emptyBlock('oxeye_daisy'),
      },
      inventory: ['crafting_table'],
    });
  }

  it('fleur sur les 4 voisins : casse la fleur de la 1re direction, PUIS pose la table à sa place', async () => {
    const bot = meadow();
    const r = await placeBlockNear(bot, 'crafting_table');
    assert.equal(r.ok, true, 'la prairie fleurie ne doit plus donner no_space');
    assert.deepEqual([r.pos.x, r.pos.y, r.pos.z], [1, 64, 0]);
    assert.equal(bot._digCalls.length, 1, 'une seule fleur cassée — pas tout le champ');
    assert.equal(bot._digCalls[0].block.name, 'poppy');
    assert.equal(bot._placeBlockCalls.length, 1);
    // la table s'accroche au SOL plein, face du dessus (jamais dans le vide)
    assert.equal(bot._placeBlockCalls[0].refBlock.name, 'grass_block');
    assert.deepEqual(
      [bot._placeBlockCalls[0].face.x, bot._placeBlockCalls[0].face.y, bot._placeBlockCalls[0].face.z],
      [0, 1, 0]);
    assert.deepEqual(bot._order, ['dig:poppy', 'place:grass_block'], 'on casse AVANT de poser');
    assert.ok(bot._equipCalls.some((e) => e.item === 'crafting_table'), 'doit équiper la table');
  });

  it('la fleur est préférée à un MUR : on ne creuse pas la pierre quand une fleur suffit (1b avant 2)', async () => {
    // Est = mur de pierre (la Pass 2 le creuserait en 1er), Ouest = fleur. Avec 1b avant 2,
    // c'est la fleur qui saute — gratuit, sans outil, sans abîmer le décor.
    const bot = makeBot({
      position: [0, 64, 0],
      blocks: {
        '1,63,0': solidBlock('stone'), '1,64,0': solidBlock('stone'),
        '-1,63,0': solidBlock('grass_block'), '-1,64,0': emptyBlock('dandelion'),
      },
      inventory: ['crafting_table'],
    });
    const r = await placeBlockNear(bot, 'crafting_table');
    assert.equal(r.ok, true);
    assert.equal(r.pos.x, -1, 'posée côté fleur');
    assert.equal(bot._digCalls.length, 1);
    assert.equal(bot._digCalls[0].block.name, 'dandelion', 'on ne creuse PAS la pierre');
  });

  it('une torche n\'est JAMAIS cassée : seule la fleur voisine saute', async () => {
    const bot = makeBot({
      position: [0, 64, 0],
      blocks: {
        '1,63,0': solidBlock('grass_block'), '1,64,0': emptyBlock('torch'),
        '-1,63,0': solidBlock('grass_block'), '-1,64,0': emptyBlock('wall_torch'),
        '0,63,1': solidBlock('grass_block'), '0,64,1': emptyBlock('soul_torch'),
        '0,63,-1': solidBlock('grass_block'), '0,64,-1': emptyBlock('poppy'),
      },
      inventory: ['crafting_table'],
    });
    const r = await placeBlockNear(bot, 'crafting_table');
    assert.equal(r.ok, true);
    assert.equal(r.pos.z, -1, 'posée sur la case de la fleur (nord)');
    assert.deepEqual(bot._digCalls.map((c) => c.block.name), ['poppy'], 'aucune torche cassée');
  });

  it('QUE des torches autour : on ne casse rien et on rend no_space (plutôt que d\'éteindre le tunnel)', async () => {
    const bot = makeBot({
      position: [0, 64, 0],
      blocks: {
        '1,63,0': solidBlock('stone'), '1,64,0': emptyBlock('torch'),
        '-1,63,0': solidBlock('stone'), '-1,64,0': emptyBlock('wall_torch'),
        '0,63,1': solidBlock('stone'), '0,64,1': emptyBlock('soul_torch'),
        '0,63,-1': solidBlock('stone'), '0,64,-1': emptyBlock('redstone_wall_torch'),
      },
      inventory: ['crafting_table'],
    });
    const r = await placeBlockNear(bot, 'crafting_table');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_space');
    assert.equal(bot._digCalls.length, 0, 'aucune torche ne doit être cassée');
    assert.equal(bot._placeBlockCalls.length, 0);
  });

  it('eau : comportement inchangé — posée DIRECTEMENT (REPLACEABLE, Pass 1), aucun cassage', async () => {
    const bot = makeBot({
      position: [0, 64, 0],
      blocks: {
        '1,63,0': solidBlock('stone'), '1,64,0': emptyBlock('water'),
        '-1,63,0': solidBlock('stone'), '-1,64,0': emptyBlock('water'),
      },
      inventory: ['crafting_table'],
    });
    const r = await placeBlockNear(bot, 'crafting_table');
    assert.equal(r.ok, true);
    assert.equal(bot._digCalls.length, 0, 'on ne casse pas de l\'eau');
    assert.equal(bot._placeBlockCalls.length, 1);
  });

  it('cassage refusé sur la 1re fleur (rejet) → on tente la direction suivante, sans planter', async () => {
    const bot = meadow();
    const realDig = bot.dig;
    bot.dig = async (block) => {
      if (block.name === 'poppy') throw new Error('dig refusé par le serveur');
      return realDig(block);
    };
    const r = await placeBlockNear(bot, 'crafting_table');
    assert.equal(r.ok, true, 'la 2e fleur doit prendre le relais');
    assert.equal(r.pos.x, -1, 'ouest = direction suivante après l\'est');
    assert.equal(bot._digCalls[bot._digCalls.length - 1].block.name, 'dandelion');
  });

  it('pose fantôme APRÈS cassage (placeBlock sans effet serveur) → jamais un succès silencieux (#6)', async () => {
    // Une seule fleur : chaque pose non confirmée coûte ~1,2 s d'attente réelle (6 × 200 ms).
    const bot = makeBot({
      position: [0, 64, 0],
      blocks: { '1,63,0': solidBlock('grass_block'), '1,64,0': emptyBlock('poppy') },
      inventory: ['crafting_table'],
    });
    bot.placeBlock = async () => { /* aucun effet serveur : la table n'apparaît jamais */ };
    const r = await placeBlockNear(bot, 'crafting_table');
    assert.equal(r.ok, false, 'une pose non confirmée ne doit JAMAIS être un succès');
    assert.equal(r.reason, 'no_space');
    // le diagnostic décrit ce qui RESTE à l'échec : la fleur a bien été cassée (air), le sol est plein
    // → une case parfaitement posable qui n'a rien donné = désync client/serveur, pas un manque de place
    assert.equal(r.around[0], 'air');
    assert.equal(r.under[0], 'grass_block');
  });

  it('Pass 4 : sol voisin ABSENT mais paroi pleine + fleur sur la case → casse la fleur, pose contre la paroi', async () => {
    const bot = makeBot({
      position: [0.5, 64, 0.5],
      blocks: {
        '0,63,0': solidBlock('stone'),              // sol sous le bot
        '1,64,0': emptyBlock('poppy'),              // case cible occupée par une fleur
        // PAS de sol en 1,63,0 → Pass 1/1b/2 abandonnent
        '1,64,1': solidBlock('stone'),              // paroi latérale où s'accrocher
      },
      inventory: ['crafting_table'],
    });
    const r = await placeBlockNear(bot, 'crafting_table');
    assert.equal(r.ok, true, 'la fleur ne doit pas empêcher la pose contre la paroi');
    assert.equal(r.pos.x, 1);
    assert.equal(bot._digCalls.length, 1);
    assert.equal(bot._digCalls[0].block.name, 'poppy');
    assert.deepEqual(bot._order, ['dig:poppy', 'place:stone'], 'on casse AVANT de poser');
    // face = cible − référence (equals : `scaled(-1)` produit des −0 que deepEqual distinguerait de 0)
    assert.ok(bot._placeBlockCalls[0].face.equals(new Vec3(0, 0, -1)), 'face = cible − référence');
  });

  it('Pass 4 : une torche sur la case n\'est PAS cassée, même avec une paroi pleine à côté', async () => {
    const bot = makeBot({
      position: [0.5, 64, 0.5],
      blocks: {
        '0,63,0': solidBlock('stone'),
        '1,64,0': emptyBlock('torch'),
        '1,64,1': solidBlock('stone'),
      },
      inventory: ['crafting_table'],
    });
    const r = await placeBlockNear(bot, 'crafting_table');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_space');
    assert.equal(bot._digCalls.length, 0);
  });

  it('Pass 4 : cassage impossible (rejet) → pas de boucle sur les 6 faces, no_space propre', async () => {
    const bot = makeBot({
      position: [0.5, 64, 0.5],
      blocks: {
        '0,63,0': solidBlock('stone'),
        '1,64,0': emptyBlock('poppy'),
        '1,64,1': solidBlock('stone'),
        '1,64,-1': solidBlock('stone'),
        '2,64,0': solidBlock('stone'),
      },
      inventory: ['crafting_table'],
    });
    let digs = 0;
    bot.dig = async () => { digs += 1; throw new Error('dig refusé'); };
    const r = await placeBlockNear(bot, 'crafting_table');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_space');
    assert.equal(digs, 1, 'un cassage qui échoue ne se retente pas face après face');
  });
});

// ─── DIAGNOSTIC : savoir CE QUI bloque quand tout échoue ─────────────────────────────────────────
// Le prochain `no_table:no_space` ne doit plus être muet : `reason` reste inchangé (des appelants
// testent `reason === 'no_space'` et `'no_table:' + reason`), mais le retour décrit le terrain —
// `around` = les 4 cases voisines (niveau pieds), `under` = les 4 sols voisins, dans l'ordre
// Est, Ouest, Sud (+Z), Nord (−Z).
describe('placeBlockNear — diagnostic d\'échec (around / under)', () => {
  it('échec total : reason inchangé + around/under décrivent les 4 voisins dans l\'ordre E, O, S, N', async () => {
    const bot = makeBot({
      position: [0, 64, 0],
      blocks: {
        '1,63,0': solidBlock('stone'),     '1,64,0': solidBlock('bedrock'),      // est : bedrock (incassable)
        '-1,63,0': solidBlock('dirt'),     '-1,64,0': emptyBlock('torch'),       // ouest : torche (jamais cassée)
        '0,63,1': emptyBlock('water'),     '0,64,1': emptyBlock('cobweb'),       // sud : toile, sol = eau (non plein)
        /* nord : '0,63,-1' absent (chunk non chargé) */ '0,64,-1': emptyBlock('lava'),
      },
      inventory: ['crafting_table'],
    });
    const r = await placeBlockNear(bot, 'crafting_table');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_space', 'reason NE CHANGE PAS : des appelants le testent');
    assert.deepEqual(r.around, ['bedrock', 'torch', 'cobweb', 'lava']);
    assert.deepEqual(r.under, ['stone', 'dirt', 'water', 'unloaded'], 'sol absent = « unloaded »');
  });

  it('unknown_item reste un retour minimal (rien à diagnostiquer côté terrain)', async () => {
    const bot = makeBot({ position: [0, 64, 0], blocks: {}, inventory: ['dirt'] });
    const r = await placeBlockNear(bot, 'crafting_table');
    assert.equal(r.reason, 'unknown_item');
  });
});

// ─── Câblage index.js : l'échec de pose doit être ÉMIS (sinon le diagnostic n'existe qu'en test) ─
// Un test qui injecte ne prouve pas qu'on BRANCHE : withCraftingTable est une closure d'index.js,
// on épingle donc le câblage dans la source (même patron que movement_tempmoves.test.js).
describe('index.js — withCraftingTable émet table_place_failed avant de renvoyer no_table', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

  it('emit({ type: \'table_place_failed\', reason, around, under }) juste avant le return \'no_table:…\'', () => {
    const m = src.match(/emit\(\{\s*type:\s*'table_place_failed'([^}]*)\}\);[\s\S]{0,160}?reason:\s*'no_table:'/);
    assert.ok(m, 'l\'event table_place_failed doit précéder le retour no_table: dans withCraftingTable');
    assert.match(m[1], /reason:\s*place\.reason/);
    assert.match(m[1], /around:\s*place\.around/);
    assert.match(m[1], /under:\s*place\.under/);
  });

  it('un seul site d\'émission (pas de doublon ailleurs dans index.js)', () => {
    assert.equal((src.match(/'table_place_failed'/g) || []).length, 1);
  });
});

// ─── 22/10 (NethBot3 session 246) : pose juste APRÈS un téléport → chunks pas encore reçus ──────
describe('placeBlockNear — voisinage non chargé (après un TP) et niche à hauteur de tête', () => {
  it('voisinage « unloaded » : attend les chunks (borné) puis pose — au lieu de no_space en 1 ms', async () => {
    const bot = makeBot({ position: [0, 64, 0], blocks: {}, inventory: ['crafting_table'] });
    let waited = 0;
    bot.waitForChunksToLoad = async () => {
      waited++;
      bot._blockMap['0,63,0'] = { name: 'stone', boundingBox: 'block' };
      bot._blockMap['1,64,0'] = { name: 'air', boundingBox: 'empty' };
      bot._blockMap['1,63,0'] = { name: 'stone', boundingBox: 'block' };
    };
    const r = await placeBlockNear(bot, 'crafting_table');
    assert.equal(waited, 1);
    assert.equal(r.ok, true);
    assert.deepEqual([r.pos.x, r.pos.y, r.pos.z], [1, 64, 0]);
  });

  it('chunks qui n\'arrivent jamais : rend no_space (reason inchangée) sans attendre au-delà de la borne', async () => {
    const bot = makeBot({ position: [0, 64, 0], blocks: {}, inventory: ['crafting_table'] });
    bot.waitForChunksToLoad = () => new Promise(() => {});      // ne résout jamais
    const t0 = Date.now();
    const r = await placeBlockNear(bot, 'crafting_table', { chunkWaitMs: 50 });
    assert.ok(Date.now() - t0 < 1000, 'borné');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_space');
    assert.equal(r.unloaded, true, 'le retour dit que le monde n\'était pas chargé');
  });

  it('voisinage chargé : n\'appelle PAS waitForChunksToLoad', async () => {
    const bot = makeBot({
      position: [0, 64, 0],
      blocks: { '0,63,0': { name: 'stone', boundingBox: 'block' }, '1,64,0': { name: 'air', boundingBox: 'empty' }, '1,63,0': { name: 'stone', boundingBox: 'block' },
        '-1,64,0': { name: 'stone', boundingBox: 'block' }, '0,64,1': { name: 'stone', boundingBox: 'block' }, '0,64,-1': { name: 'stone', boundingBox: 'block' },
        '-1,63,0': { name: 'stone', boundingBox: 'block' }, '0,63,1': { name: 'stone', boundingBox: 'block' }, '0,63,-1': { name: 'stone', boundingBox: 'block' } },
      inventory: ['crafting_table'],
    });
    let waited = 0;
    bot.waitForChunksToLoad = async () => { waited++; };
    const r = await placeBlockNear(bot, 'crafting_table');
    assert.equal(r.ok, true);
    assert.equal(waited, 0);
  });

  it('niche à hauteur de TÊTE : voisins des pieds pleins mais increusables, cases de tête libres → pose sur le voisin', async () => {
    // Pieds entourés de bedrock (Pass 2 ne creuse pas), pas de remblai en poche (Pass 3), cases des pieds
    // pleines (Pass 4 : pas de case libre). La tête (y 65) au-dessus d'un voisin est creusable → niche.
    const blocks = { '0,63,0': { name: 'stone', boundingBox: 'block' } };
    for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      blocks[`${x},64,${z}`] = { name: 'bedrock', boundingBox: 'block' };
      blocks[`${x},63,${z}`] = { name: 'bedrock', boundingBox: 'block' };
      blocks[`${x},65,${z}`] = { name: 'stone', boundingBox: 'block' };
    }
    const bot = makeBot({ position: [0, 64, 0], blocks, inventory: ['crafting_table'] });
    const r = await placeBlockNear(bot, 'crafting_table');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.pos.y, 65, 'posée dans la niche creusée à hauteur de tête');
    assert.equal(bot._digCalls.length, 1, 'une seule niche creusée');
  });
});
