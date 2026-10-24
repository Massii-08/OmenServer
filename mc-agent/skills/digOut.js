'use strict';
// SORTIR EN ESCALIER (20/10, NethBot1 sessions 309-313) — la relocation de repli SANS home.
//
// Vécu : NethBot1 emmuré dans une pochette de pierre à (-43,40,-340) (air sur 1-2 cases, eau à 2 blocs).
// Chaque session : jams ×12 → `unjam_relocate` → `relocate_home_safe` → « Player has not set a home. »
// → `autonomous_stalled jam_loop` → process quitte → respawn AU MÊME ENDROIT (keepInventory, position
// conservée) → recommence. Aucun secours ne marchait : pas de home, et le pathfinder ne voit aucune
// sortie. Un joueur réel, lui, creuse un escalier vers la surface.
//
// Escalier 1×2 montant : pour un pas vers (dx,dz) depuis les pieds (x,y,z) on dégage
//   H = (x, y+2, z)            la tête au-dessus de soi (pour pouvoir sauter),
//   A = (x+dx, y+1, z+dz)      la case des pieds du pas suivant,
//   B = (x+dx, y+2, z+dz)      la case de la tête du pas suivant,
// et on exige un SOL plein en F = (x+dx, y, z+dz). Un fluide DANS ou À CÔTÉ d'une case à ouvrir
// (eau/lave au-dessus, sur un flanc) → on change de direction : ouvrir la case lâcherait le fluide
// dans l'escalier. 4 directions essayées ; toutes bloquées → échec propre (l'appelant a son repli).
//
// Fini quand le bot voit le ciel : ciel ouvert sur 8 blocs (feuillage ignoré) ET y ≥ minY, ou lumière
// du ciel pleine sur la case de la tête. Borné en temps (90 s par défaut) et par le jeton d'annulation.
// Décision PURE (stairStep / isOutside) ; l'exécution (dig + saut) est injectable pour les tests.
const { bestToolFor } = require('../tools');

let vec3; try { vec3 = require('vec3'); } catch (e) { vec3 = null; }
const _v = (x, y, z) => (vec3 ? vec3(x, y, z) : { x, y, z });

const DIRS = [{ dx: 1, dz: 0 }, { dx: 0, dz: 1 }, { dx: -1, dz: 0 }, { dx: 0, dz: -1 }];
const FLUID_RE = /^(water|lava|flowing_water|flowing_lava|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/;
const UNBREAKABLE = new Set(['bedrock', 'barrier', 'end_portal_frame', 'reinforced_deepslate',
  'command_block', 'structure_block', 'light']);
const SKY_IGNORE_RE = /leaves$|^(vine|glow_lichen|snow)$/;
const DIG_OUT_MAX_MS = 90000;
const OPEN_SKY_HEIGHT = 8;

const isFluid = (b) => !!b && (FLUID_RE.test(String(b.name || '')) || b.waterlogged === true);
const isSolid = (b) => !!b && b.boundingBox === 'block';

/**
 * PUR — le bot est-il dehors ? read(x,y,z) → bloc | null. pos = pieds (entiers).
 * Dehors = ciel ouvert sur `height` blocs au-dessus de la tête (feuillage ignoré) ET y ≥ minY,
 * OU lumière du ciel pleine (15) sur la case de la tête (quand le serveur l'envoie).
 */
function isOutside(read, pos, { minY = 58, height = OPEN_SKY_HEIGHT } = {}) {
  const head = read(pos.x, pos.y + 1, pos.z);
  if (head && head.skyLight === 15) return true;
  if (!(pos.y >= minY)) return false;
  for (let dy = 2; dy < 2 + height; dy++) {
    const b = read(pos.x, pos.y + dy, pos.z);
    if (!b) return false;                                  // chunk inconnu : on ne conclut pas
    if (isSolid(b) && !SKY_IGNORE_RE.test(String(b.name || ''))) return false;
  }
  return true;
}

/**
 * PUR — prochain pas d'escalier dans la direction `dir`.
 * @returns {{act:'step', dig:Array<{x,y,z}>, to:{x,y,z}}
 *          | {act:'blocked', why:'fluid'|'unbreakable'|'no_floor'|'unknown'}}
 */
function stairStep(read, pos, dir) {
  const { x, y, z } = pos;
  const { dx, dz } = dir;
  const H = { x, y: y + 2, z };
  const A = { x: x + dx, y: y + 1, z: z + dz };
  const B = { x: x + dx, y: y + 2, z: z + dz };
  const F = { x: x + dx, y, z: z + dz };
  const cells = [H, A, B];
  for (const c of cells) {
    const b = read(c.x, c.y, c.z);
    if (!b) return { act: 'blocked', why: 'unknown' };
    if (isFluid(b)) return { act: 'blocked', why: 'fluid' };
    if (UNBREAKABLE.has(b.name) || (isSolid(b) && b.diggable === false)) return { act: 'blocked', why: 'unbreakable' };
  }
  // Voisins des cases qu'on ouvre : un fluide qui les touche entrerait dans l'escalier.
  const own = new Set([`${x},${y},${z}`, `${x},${y + 1},${z}`, ...cells.map((c) => `${c.x},${c.y},${c.z}`)]);
  const NB = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];
  for (const c of cells) {
    for (const [ox, oy, oz] of NB) {
      const k = `${c.x + ox},${c.y + oy},${c.z + oz}`;
      if (own.has(k)) continue;
      if (isFluid(read(c.x + ox, c.y + oy, c.z + oz))) return { act: 'blocked', why: 'fluid' };
    }
  }
  const f = read(F.x, F.y, F.z);
  if (!f) return { act: 'blocked', why: 'unknown' };
  if (isFluid(f)) return { act: 'blocked', why: 'fluid' };
  if (!isSolid(f)) return { act: 'blocked', why: 'no_floor' };
  const dig = cells.filter((c) => isSolid(read(c.x, c.y, c.z)));
  return { act: 'step', dig, to: A };
}

/** Direction de départ : celle du regard (yaw mineflayer : 0 = -z… on arrondit au cardinal). */
function dirIndexFromYaw(yaw) {
  const dx = Math.round(-Math.sin(yaw || 0)), dz = Math.round(Math.cos(yaw || 0));
  const i = DIRS.findIndex((d) => d.dx === dx && d.dz === dz);
  return i >= 0 ? i : 0;
}

const _floorPos = (p) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Saut vers la marche `to` (contrôles réels). true si le bot y est arrivé. */
async function defaultStepUp(bot, to, { sleep = _sleep, maxMs = 1500 } = {}) {
  try { await bot.lookAt(_v(to.x + 0.5, to.y + 1.6, to.z + 0.5), true); } catch (e) { /* best-effort */ }
  const arrived = () => {
    const p = bot.entity && bot.entity.position;
    return !!p && Math.floor(p.y) >= to.y && Math.abs(p.x - (to.x + 0.5)) < 0.75 && Math.abs(p.z - (to.z + 0.5)) < 0.75;
  };
  try { bot.setControlState('forward', true); bot.setControlState('jump', true); } catch (e) { /* best-effort */ }
  const t0 = Date.now();
  let ok = false;
  while (Date.now() - t0 < maxMs) {
    if (arrived()) { ok = true; break; }
    await sleep(50);
  }
  try { bot.setControlState('jump', false); bot.setControlState('forward', false); } catch (e) { /* best-effort */ }
  return ok || arrived();
}

/**
 * digOut(bot, opts, token) → {ok, reason?, steps, dir?, took_s}
 * opts : maxMs (90 s), minY (58), now/sleep (horloge), stepUp(bot,to) injectable, startDir (index 0-3).
 * reasons : cancelled | no_pos | timeout | all_blocked:<why>
 */
async function digOut(bot, opts = {}, token = null) {
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : _sleep;
  const maxMs = opts.maxMs || DIG_OUT_MAX_MS;
  const minY = opts.minY != null ? opts.minY : 58;
  const stepUp = typeof opts.stepUp === 'function' ? opts.stepUp : (b, to) => defaultStepUp(b, to, { sleep });
  const read = (x, y, z) => { try { return bot.blockAt(_v(x, y, z)); } catch (e) { return null; } };
  const t0 = now();
  const done = (r) => Object.assign({ took_s: Math.round((now() - t0) / 1000) }, r);
  let di = Number.isInteger(opts.startDir) ? ((opts.startDir % 4) + 4) % 4
    : dirIndexFromYaw(bot.entity && bot.entity.yaw);
  let steps = 0;
  let blocked = 0;       // directions consécutives refusées sans pas réussi
  let stuck = 0;         // sauts ratés dans la direction courante
  let lastWhy = 'unknown';
  while (now() - t0 < maxMs) {
    if (token && token.cancelled) return done({ ok: false, reason: 'cancelled', steps });
    const p = bot.entity && bot.entity.position;
    if (!p) return done({ ok: false, reason: 'no_pos', steps });
    const pos = _floorPos(p);
    if (isOutside(read, pos, { minY })) return done({ ok: true, steps, dir: DIRS[di] });
    const s = stairStep(read, pos, DIRS[di]);
    if (s.act === 'blocked') {
      lastWhy = s.why;
      blocked++;
      if (blocked >= DIRS.length) return done({ ok: false, reason: 'all_blocked:' + lastWhy, steps });
      di = (di + 1) % DIRS.length;
      stuck = 0;
      continue;
    }
    for (const c of s.dig) {
      if (token && token.cancelled) return done({ ok: false, reason: 'cancelled', steps });
      const b = read(c.x, c.y, c.z);
      if (!isSolid(b)) continue;
      try {
        const tool = bestToolFor(bot, b);
        if (tool) await bot.equip(tool, 'hand');
      } catch (e) { /* mains nues : plus lent, mais ça creuse */ }
      try { await bot.dig(b); } catch (e) { /* re-sondé au tour suivant */ }
    }
    if (token && token.cancelled) return done({ ok: false, reason: 'cancelled', steps });
    let moved = false;
    try { moved = !!(await stepUp(bot, s.to)); } catch (e) { moved = false; }
    if (moved) { steps++; blocked = 0; stuck = 0; continue; }
    stuck++;
    if (stuck >= 2) {             // la marche ne prend pas (gravier retombé, bord bizarre) : on tourne
      stuck = 0;
      blocked++;
      lastWhy = 'no_progress';
      if (blocked >= DIRS.length) return done({ ok: false, reason: 'all_blocked:no_progress', steps });
      di = (di + 1) % DIRS.length;
    }
    await sleep(50);
  }
  return done({ ok: false, reason: 'timeout', steps });
}

module.exports = { digOut, defaultStepUp, stairStep, isOutside, dirIndexFromYaw, DIRS, DIG_OUT_MAX_MS, isFluid };
