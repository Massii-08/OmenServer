'use strict';
// Pose `itemName` (ex. crafting_table) sur un bloc solide adjacent au sol du bot.
// Pass 1 : case vide/replaceable adjacente → pose directe.
// Pass 2 : toutes les cases sont solides → creuse une case puis pose (cas underground/enclosed).
const { Vec3 } = require('vec3');
const { bestToolFor } = require('../tools');

// Noms de blocs qu'on peut REMPLACER sans creuser (case traitée comme "libre")
const REPLACEABLE = new Set([
  'air', 'cave_air', 'void_air',
  'short_grass', 'grass', 'tall_grass',
  'fern', 'large_fern',
  'snow', 'seagrass',
]);

// Blocs qu'on ne peut PAS creuser même si boundingBox === 'block'
const NON_DIGGABLE = new Set([
  'bedrock', 'water', 'lava', 'flowing_water', 'flowing_lava',
]);

// Blocs "remblai" sacrifiables pour créer un sol manquant (Pass 3). On EXCLUT cobblestone
// (réservé au craft de la pioche pierre) et la table elle-même.
const SUPPORT_BLOCKS = new Set([
  'dirt', 'coarse_dirt', 'rooted_dirt', 'grass_block', 'gravel', 'sand', 'red_sand',
  'stone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'cobbled_deepslate',
  'netherrack', 'dripstone_block', 'calcite', 'mud', 'clay',
]);

// #6 retours live : TOUTE pose se fait contre la face d'un bloc PLEIN réel (sinon pose illégale →
// bloc flottant, flag anti-cheat, signature de bot). Référence re-validée juste avant la pose.
const MAX_PLACE_REACH = 5; // ~4.5 depuis les yeux + coussin (les refs ici sont adjacentes de toute façon)
function _refOk(bot, ref) {
  if (!ref || ref.boundingBox !== 'block') return false;
  const p = ref.position;
  if (p && p.distanceTo && bot.entity && bot.entity.position) {
    if (p.distanceTo(bot.entity.position) > MAX_PLACE_REACH) return false;
  }
  return true;
}

// #6 : confirme que le bloc EXISTE vraiment après la pose (1er check immédiat, puis poll court) —
// une pose fantôme (désync client/serveur) ne doit JAMAIS être traitée comme un succès.
async function _confirmPlaced(bot, pos, tries = 6, delayMs = 200) {
  for (let i = 0; i < tries; i++) {
    const b = bot.blockAt(pos);
    if (b && b.boundingBox === 'block') return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

/**
 * Pose itemName sur le sol adjacent au bot.
 * Retourne { ok:true, pos:Vec3 } ou { ok:false, reason:string }.
 */
async function placeBlockNear(bot, itemName) {
  const item = bot.inventory.items().find((i) => i.name === itemName);
  if (!item) return { ok: false, reason: 'unknown_item' };

  const base = bot.entity.position.floored();
  const dirs = [
    new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(0, 0, -1),
  ];

  // ── Pass 1 : cherche une case libre/replaceable avec sol solide ──────────
  for (const d of dirs) {
    const groundPos = base.plus(d).offset(0, -1, 0);
    const targetPos = base.plus(d);
    const ground = bot.blockAt(groundPos);
    const target = bot.blockAt(targetPos);

    if (!ground || ground.boundingBox !== 'block') continue;
    if (!target) continue;                               // null/unloaded → skip
    if (!REPLACEABLE.has(target.name)) continue;         // not a free cell

    try {
      if (!_refOk(bot, ground)) continue;            // #6 : jamais de pose sans référence pleine
      await bot.equip(item, 'hand');
      await bot.placeBlock(ground, new Vec3(0, 1, 0));
      if (!(await _confirmPlaced(bot, targetPos))) continue;  // #6 : pose fantôme → autre direction
      return { ok: true, pos: base.plus(d) };
    } catch (e) { /* essaie la direction suivante */ }
  }

  // ── Pass 2 : creuse une case solide adjacente puis pose ──────────────────
  for (const d of dirs) {
    const groundPos = base.plus(d).offset(0, -1, 0);
    const targetPos = base.plus(d);
    const ground = bot.blockAt(groundPos);
    const target = bot.blockAt(targetPos);

    if (!ground || ground.boundingBox !== 'block') continue;
    if (!target) continue;                               // unloaded → skip
    if (target.boundingBox !== 'block') continue;        // not a solid block to dig
    if (NON_DIGGABLE.has(target.name)) continue;         // can't dig this
    if (target.name === itemName) continue;              // don't dig what we're placing

    try {
      const tool = bestToolFor(bot, target);
      if (tool) await bot.equip(tool, 'hand');
      await bot.dig(target);
      if (!_refOk(bot, bot.blockAt(groundPos))) continue;  // #6 : re-vérifie après le dig
      await bot.equip(item, 'hand');                     // re-equip after dig
      await bot.placeBlock(ground, new Vec3(0, 1, 0));
      if (!(await _confirmPlaced(bot, targetPos))) continue;  // #6 : pose fantôme → autre direction
      return { ok: true, pos: base.plus(d) };
    } catch (e) { /* essaie la direction suivante */ }
  }

  // ── Pass 3 : "piédestal" — voisins ET sols-voisins en air (le bot a miné autour de lui en récoltant
  // le cobble). On comble le sol d'une case voisine avec un bloc de remblai (posé contre la face
  // LATÉRALE du bloc sous les pieds = seul solide adjacent garanti), puis on pose la table dessus. ──
  const floor = bot.blockAt(base.offset(0, -1, 0));        // bloc sous les pieds (solide : le bot est dessus)
  if (floor && floor.boundingBox === 'block') {
    const support = bot.inventory.items().find((i) => SUPPORT_BLOCKS.has(i.name));
    if (support) {
      for (const d of dirs) {
        const cellPos = base.plus(d);                      // case voisine (niveau pieds) → ira la table
        const underPos = base.plus(d).offset(0, -1, 0);    // sol manquant (== floor.position + d)
        const under = bot.blockAt(underPos);
        if (under && under.boundingBox === 'block') continue;   // sol déjà présent → Pass 1/2 gère

        const cell = bot.blockAt(cellPos);
        // la case voisine doit être (ou devenir) vide pour accueillir la table
        if (cell && cell.boundingBox === 'block') {
          if (NON_DIGGABLE.has(cell.name)) continue;
          try {
            const tool = bestToolFor(bot, cell);
            if (tool) await bot.equip(tool, 'hand');
            await bot.dig(cell);
          } catch (e) { continue; }
        } else if (cell && cell.name !== 'air' && !REPLACEABLE.has(cell.name)) {
          continue;
        }

        try {
          // 1) poser le remblai pour combler underPos (réf = floor, face = d → floor + d == underPos)
          if (!_refOk(bot, floor)) continue;             // #6 : le sol sous les pieds doit être plein
          await bot.equip(support, 'hand');
          await bot.placeBlock(floor, d);
          if (!(await _confirmPlaced(bot, underPos))) continue;   // #6 : remblai fantôme → stop
          // 2) poser la table sur le remblai fraîchement posé
          const sup = bot.blockAt(underPos);
          if (!_refOk(bot, sup)) continue;               // #6 : référence pleine obligatoire
          await bot.equip(item, 'hand');
          await bot.placeBlock(sup, new Vec3(0, 1, 0));
          if (!(await _confirmPlaced(bot, cellPos))) continue;    // #6 : pose fantôme → autre direction
          return { ok: true, pos: cellPos };
        } catch (e) { /* essaie la direction suivante */ }
      }
    }
  }

  // ── Pass 4 : poser CONTRE UNE PAROI (analyse run world_ax4, 26/07 : `no_table:no_space` ×71,
  // en tunnel de minage). Les passes 1-3 ne savent poser QUE sur un sol (`placeBlock(sol, +Y)`).
  // Or en jeu un bloc s'accroche à N'IMPORTE QUELLE face d'un voisin plein : dans un tunnel dont
  // le sol de la case voisine manque mais dont les murs sont pleins, un joueur pose contre le mur.
  // Pour remplir la case C, il suffit d'un voisin plein N et de la face (C − N).
  const SIDES = [
    new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1),
    new Vec3(0, 1, 0), new Vec3(0, -1, 0),
  ];
  for (const d of dirs) {
    const cellPos = base.plus(d);
    const cell = bot.blockAt(cellPos);
    if (!cell || !REPLACEABLE.has(cell.name)) continue;      // la case doit être libre
    for (const s of SIDES) {
      const refPos = cellPos.plus(s);
      const ref = bot.blockAt(refPos);
      if (!ref || ref.boundingBox !== 'block') continue;     // il faut une face pleine où s'accrocher
      if (!_refOk(bot, ref)) continue;
      try {
        await bot.equip(item, 'hand');
        await bot.placeBlock(ref, s.scaled(-1));             // ref + (−s) == cellPos
        if (!(await _confirmPlaced(bot, cellPos))) continue;
        return { ok: true, pos: cellPos };
      } catch (e) { /* face suivante */ }
    }
  }

  return { ok: false, reason: 'no_space' };
}

module.exports = { placeBlockNear };
