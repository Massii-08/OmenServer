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

// Bornes (22/10) : le couvert entier tient dans le `withTimeout(…, 3000)` de index.js. Une pose que le
// serveur refuse SANS changer le bloc (entité dans la case, main sans bloc) laisse `bot.placeBlock`
// attendre 5 s un blockUpdate qui ne vient pas : la 1re pose mangeait tout le budget, l'extérieur
// coupait et l'event disait `placed:0` sans raison. Chaque pose a désormais sa propre borne.
const PLACE_TIMEOUT_MS = 1100;
const COVER_BUDGET_MS = 2500;

/**
 * Coupe la ligne de vue d'un tireur en posant un muret de 2 de haut de son côté.
 * Best-effort intégral : toute erreur de pose est avalée, le bot n'est jamais bloqué dessus.
 * UN SEUL couvert à la fois par bot : un 2e appel concurrent (réflexe `defensive` + `flee`, live
 * session 155) REJOINT le premier au lieu de croiser les `equip` et de poser en double.
 * @returns {Promise<{ok:boolean, placed:number, reason?:string, cells?:string[], error?:string, joined?:boolean}>}
 *   reason ∈ no_block | no_place | no_direction | equip_failed | no_support | place_rejected | place_timeout | budget
 */
async function takeCover(bot, shooter, opts = {}) {
  if (bot._mcaCoverInFlight) {
    try { const r = await bot._mcaCoverInFlight; return Object.assign({}, r, { joined: true }); }
    catch (e) { return { ok: false, placed: 0, reason: 'error', joined: true }; }
  }
  const run = _takeCover(bot, shooter, opts);
  bot._mcaCoverInFlight = run;
  try { return await run; } finally { if (bot._mcaCoverInFlight === run) bot._mcaCoverInFlight = null; }
}

async function _takeCover(bot, shooter, opts) {
  const placeTimeoutMs = Number.isFinite(opts.placeTimeoutMs) ? opts.placeTimeoutMs : PLACE_TIMEOUT_MS;
  const budgetMs = Number.isFinite(opts.budgetMs) ? opts.budgetMs : COVER_BUDGET_MS;
  const t0 = Date.now();
  const block = pickCoverBlock(bot);
  if (!block) return { ok: false, placed: 0, reason: 'no_block' };
  if (typeof bot.placeBlock !== 'function') return { ok: false, placed: 0, reason: 'no_place' };
  const from = bot.entity && bot.entity.position;
  const to = shooter && shooter.position;
  const plan = coverPlan(from, to);
  if (!plan) return { ok: false, placed: 0, reason: 'no_direction' };

  // En train de MANGER (réflexe `eat` concurrent, session 155) : la main tient la nourriture et l'equip
  // ne passe pas tant que la consommation court. Le couvert prime : on lâche, on mangera derrière.
  let equipped = false;
  async function equip() {
    if (equipped && bot.heldItem && bot.heldItem.name === block.name) return true;
    try { if (bot.usingHeldItem && typeof bot.deactivateItem === 'function') bot.deactivateItem(); } catch (e) {}
    try {
      if (!bot.heldItem || bot.heldItem.name !== block.name) await bot.equip(block, 'hand');
    } catch (e) { /* vérifié juste dessous */ }
    equipped = !!(bot.heldItem && bot.heldItem.name === block.name);
    return equipped;
  }

  const cells = [];
  let placed = 0;
  let error = null;
  for (const p of plan) {
    if (Date.now() - t0 > budgetMs) { cells.push('budget'); continue; }
    const target = new Vec3(p.x, p.y, p.z);
    if (!air(bot.blockAt(target))) { placed++; cells.push('already'); continue; }   // déjà masqué de ce côté : ça compte
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
      if (!found) { cells.push('no_support'); continue; }    // rien où s'accrocher de ce côté
      ref = found.cand; face = found.face;
    }
    if (!(await equip())) { cells.push('equip_failed'); break; }   // poser avec autre chose en main = rien
    let timer = null;
    const outcome = await Promise.race([
      Promise.resolve().then(() => bot.placeBlock(ref, face)).then(() => 'placed', (e) => { error = String((e && e.message) || e); return 'place_rejected'; }),
      new Promise((r) => { timer = setTimeout(() => r('place_timeout'), placeTimeoutMs); }),
    ]);
    if (timer) clearTimeout(timer);
    // confirmée en retard (le serveur a suivi après la borne) : le bloc est là, il compte
    const cell = outcome === 'placed' || solid(bot.blockAt(target)) ? 'placed' : outcome;
    if (cell === 'placed') placed++;
    cells.push(cell);
  }
  const out = { ok: placed > 0, placed, cells };
  if (!out.ok) out.reason = cells.find((c) => c !== 'already') || 'no_support';
  else if (cells.some((c) => c !== 'placed' && c !== 'already')) out.reason = cells.find((c) => c !== 'placed' && c !== 'already');
  if (error) out.error = error.slice(0, 120);
  return out;
}

module.exports = { takeCover, pickCoverBlock, PLACE_TIMEOUT_MS, COVER_BUDGET_MS };
