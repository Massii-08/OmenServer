'use strict';
// `mine down <n>` : creuse le bloc sous les pieds n fois, outil auto, garde-fou lave/vide.
const { bestToolFor } = require('../tools');
const DANGER = new Set(['lava', 'flowing_lava', 'water', 'flowing_water']);
const VOID = new Set(['air', 'cave_air', 'void_air']);

// ─── ATTERRISSAGE (opt-in `land`, abri nocturne 19/10 soir) ─────────────────────────────────────
// `bot.dig` rend la main dès que le bloc est cassé, AVANT que le bot soit retombé dans le trou : le tour
// suivant relisait donc le bloc sous des pieds encore en l'air — l'air qu'on vient de creuser — et
// s'arrêtait en `void_below`. « Creuser N blocs » n'en creusait jamais qu'UN (c'est ce qui rendait l'abri
// nocturne inutile : un trou d'un bloc, la tête au niveau du sol). Avec `land`, on attend d'avoir touché
// le fond (au sol ET descendu d'au moins 0,9 bloc) avant le coup suivant, et on refuse de percer au-dessus
// d'une GROTTE (vide deux blocs plus bas : le bot tomberait dedans). Sans `land` : contrat d'origine à
// l'identique (ordre « mine down », gather pierre).
const LAND_MAX_MS = 1500;      // une chute d'un bloc prend ~0,3 s ; au-delà le bot est resté sur un bord
const LAND_POLL_MS = 50;

/** Attend que le bot ait atterri sous `y0` (au sol, ≥ 0,9 bloc plus bas). Borné en NOMBRE de pas (un
 *  sleep instantané, en test, ne fait pas tourner la boucle sans fin). → true si atterri. */
async function waitLanding(bot, y0, opts = {}) {
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs || LAND_POLL_MS;
  const polls = Math.max(1, Math.ceil((opts.maxMs || LAND_MAX_MS) / pollMs));
  for (let i = 0; i <= polls; i++) {
    const e = bot.entity;
    const y = e && e.position ? e.position.y : NaN;
    if (e && e.onGround && Number.isFinite(y) && y <= y0 - 0.9) return true;
    if (i < polls) await sleep(pollMs);
  }
  return false;
}

async function mineDown(bot, { count = 1, land = null } = {}, token = null) {
  let dug = 0;
  for (let i = 0; i < count; i++) {
    if (token && token.cancelled) return { ok: true, dug, cancelled: true };
    const pos = bot.entity && bot.entity.position;
    if (!pos) return { ok: false, reason: 'no_pos' };
    const below = bot.blockAt(pos.offset(0, -1, 0));
    if (!below || VOID.has(below.name)) return dug > 0 ? { ok: false, dug, reason: 'void_below' } : { ok: false, reason: 'void_below' };
    if (DANGER.has(below.name)) return dug > 0 ? { ok: false, dug, reason: 'danger_below' } : { ok: false, reason: 'danger_below' };
    const below2 = bot.blockAt(pos.offset(0, -2, 0));
    if (below2 && DANGER.has(below2.name)) return dug > 0 ? { ok: false, dug, reason: 'danger_below' } : { ok: false, reason: 'danger_below' };
    // Avec `land` le bot va RÉELLEMENT tomber dans la case creusée : il faut un fond plein sous elle.
    if (land && (!below2 || VOID.has(below2.name))) return dug > 0 ? { ok: false, dug, reason: 'cave_below' } : { ok: false, reason: 'cave_below' };
    const tool = bestToolFor(bot, below);
    if (tool) { try { await bot.equip(tool, 'hand'); } catch (e) {} }
    const y0 = pos.y;                                  // un NOMBRE (copie) : la position est mutée en place
    try { await bot.dig(below); dug++; }
    catch (e) { return { ok: dug > 0, dug, reason: 'dig_failed' }; }
    if (land && !(await waitLanding(bot, y0, land))) return { ok: false, dug, reason: 'no_fall' };
  }
  return { ok: true, dug };
}

module.exports = { mineDown, waitLanding, DANGER, VOID, LAND_MAX_MS };
