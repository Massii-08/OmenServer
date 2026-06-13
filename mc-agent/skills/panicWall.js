'use strict';
// panicWall — encaisse le bot dans une boîte de blocs pour se protéger des mobs.
//
// Hole C (corrigé ici) : l'ancien panic-wall (inline dans index.js onPanic) posait un bloc en
// référençant le bloc SOUS chaque voisin et exigeait qu'il soit solide. En GROTTE OUVERTE les
// voisins sont de l'air SANS bloc solide dessous → chaque placeBlock échouait en silence → aucun
// mur ne se formait, exactement là où les mobs grouillent.
//
// Fix : un BRIDGE STEP qui, quand le sol d'un voisin manque, pose un bloc de remblai en s'ancrant
// sur le bloc-sol DU BOT (toujours solide : le bot se tient dessus). Ce remblai devient le support
// du mur. Sur sol plein le bridge est sauté et on a un mur 4 côtés classique (jusqu'à 8 blocs).
const { Vec3 } = require('vec3');

// Candidats de bloc-mur (1er match dans l'inventaire), + tout *_planks.
const WALL_CANDIDATES = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'stone', 'deepslate'];

function _pickWall(bot) {
  const items = bot.inventory.items();
  for (const name of WALL_CANDIDATES) {
    const it = items.find((i) => i.name === name);
    if (it) return it;
  }
  return items.find((i) => typeof i.name === 'string' && i.name.endsWith('_planks')) || null;
}

const _AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);
function solid(b) { return !!(b && b.boundingBox === 'block'); }
function air(b) { return !b || b.boundingBox === 'empty' || _AIR_NAMES.has(b.name); }

/**
 * Boxe le bot avec des blocs-murs, robuste aux grottes ouvertes.
 * @returns {Promise<{ok:boolean, placed:number, reason?:string}>}
 */
async function panicWall(bot, opts = {}) {
  const wall = _pickWall(bot);
  if (!wall) return { ok: false, reason: 'no_block', placed: 0 };
  if (typeof bot.placeBlock !== 'function') return { ok: false, reason: 'no_place', placed: 0 };

  const fp = bot.entity.position.floored();

  // equip avec cache : ne ré-équipe que si l'item en main n'est pas le bloc-mur.
  async function equip() {
    try {
      if (!bot.heldItem || bot.heldItem.name !== wall.name) {
        await bot.equip(wall, 'hand');
      }
    } catch (e) { /* on tente quand même la pose */ }
  }

  let placed = 0;
  const cardinals = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  for (const [dx, dz] of cardinals) {
    // ── (a) BRIDGE STEP (fix grotte ouverte) ────────────────────────────────
    // Si le sol du voisin manque, on le comble en s'ancrant sur le sol DU BOT.
    const belowN = bot.blockAt(new Vec3(fp.x + dx, fp.y - 1, fp.z + dz));
    if (!solid(belowN)) {
      const floor = bot.blockAt(new Vec3(fp.x, fp.y - 1, fp.z)); // le bloc sous les pieds du bot
      if (solid(floor)) {
        await equip();
        try { await bot.placeBlock(floor, new Vec3(dx, 0, dz)); } catch (e) { /* skip */ }
      }
    }

    // ── (b) WALL STEP : 2 blocs de haut sur le côté ─────────────────────────
    for (const dy of [0, 1]) {
      const target = new Vec3(fp.x + dx, fp.y + dy, fp.z + dz);
      if (!air(bot.blockAt(target))) continue;
      const ref = bot.blockAt(new Vec3(fp.x + dx, fp.y + dy - 1, fp.z + dz));
      if (!solid(ref)) continue;
      await equip();
      try { await bot.placeBlock(ref, new Vec3(0, 1, 0)); placed++; } catch (e) { /* skip */ }
    }
  }

  return { ok: placed > 0, placed };
}

module.exports = { panicWall };
