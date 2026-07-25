'use strict';
// takeCover — pose 1-2 blocs ENTRE le bot et un tireur pour lui couper la ligne de vue.
//
// Preuve live (world_ax4, 25/07) : les squelettes sont le tueur n°1 des bots nus en sans-give
// (NethBot2 mort 8× en 4 min, « was shot by Skeleton »). Charger à découvert ou fuir en ligne
// droite laisse le bot dans la ligne de tir. Un squelette qui ne voit plus sa cible cesse de tirer.
//
// Version économe de panicWall : 2 blocs d'UN seul côté (celui du tireur) au lieu d'une boîte
// 4 côtés — assez pour casser la visée, et ça n'emmure pas le bot (il garde 3 côtés pour partir).
const { Vec3 } = require('vec3');
const { coverPlan } = require('../cover');

const WALL_CANDIDATES = ['cobblestone', 'cobbled_deepslate', 'dirt', 'coarse_dirt', 'netherrack',
  'stone', 'deepslate', 'tuff', 'gravel', 'andesite', 'diorite', 'granite'];

const _AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);
function solid(b) { return !!(b && b.boundingBox === 'block'); }
function air(b) { return !b || b.boundingBox === 'empty' || _AIR_NAMES.has(b.name); }

/** Bloc sacrifiable en poche pour bâtir le couvert (jamais un item précieux). */
function pickCoverBlock(bot) {
  const items = (bot.inventory && bot.inventory.items()) || [];
  for (const name of WALL_CANDIDATES) {
    const it = items.find((i) => i.name === name);
    if (it) return it;
  }
  return items.find((i) => typeof i.name === 'string' && i.name.endsWith('_planks')) || null;
}

/**
 * Coupe la ligne de vue d'un tireur en posant un muret de 2 de haut de son côté.
 * Best-effort intégral : toute erreur de pose est avalée, le bot n'est jamais bloqué dessus.
 * @returns {Promise<{ok:boolean, placed:number, reason?:string}>}
 */
async function takeCover(bot, shooter) {
  const block = pickCoverBlock(bot);
  if (!block) return { ok: false, placed: 0, reason: 'no_block' };
  if (typeof bot.placeBlock !== 'function') return { ok: false, placed: 0, reason: 'no_place' };
  const from = bot.entity && bot.entity.position;
  const to = shooter && shooter.position;
  const plan = coverPlan(from, to);
  if (!plan) return { ok: false, placed: 0, reason: 'no_direction' };

  async function equip() {
    try {
      if (!bot.heldItem || bot.heldItem.name !== block.name) await bot.equip(block, 'hand');
    } catch (e) { /* on tente la pose quand même */ }
  }

  let placed = 0;
  for (const p of plan) {
    const target = new Vec3(p.x, p.y, p.z);
    if (!air(bot.blockAt(target))) { placed++; continue; }   // déjà masqué de ce côté : ça compte
    // On bâtit sur le bloc du dessous (le plus fiable) ; sinon on tente les 4 côtés.
    let ref = bot.blockAt(new Vec3(p.x, p.y - 1, p.z));
    let face = new Vec3(0, 1, 0);
    if (!solid(ref)) {
      const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      let found = null;
      for (const [dx, dz] of sides) {
        const cand = bot.blockAt(new Vec3(p.x + dx, p.y, p.z + dz));
        if (solid(cand)) { found = { cand, face: new Vec3(-dx, 0, -dz) }; break; }
      }
      if (!found) continue;                                   // rien où s'accrocher de ce côté
      ref = found.cand; face = found.face;
    }
    await equip();
    try { await bot.placeBlock(ref, face); placed++; } catch (e) { /* skip, best-effort */ }
  }
  return { ok: placed > 0, placed };
}

module.exports = { takeCover, pickCoverBlock };
