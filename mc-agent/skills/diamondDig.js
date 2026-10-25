'use strict';
// CASSER UN DIAMANT VISIBLE (25/10, monde neuf, 3 mineurs en armure).
//
// Mesure live : sur 30 min, `diamond_cave_result` = 16 mined / 30 empty (`nothing_mined`) / 32 interrupted.
// Vérifié par RCON APRÈS coup : aux coordonnées de deux `empty` (24,6 s puis 41,5 s), le
// deepslate_diamond_ore était TOUJOURS LÀ. Le bot arrivait (diamondCaveGoto dit « arrivé » à ≤ 6 blocs),
// puis confiait tout à `floodFillVein` → `collectBlock.collect(b)` : un SECOND trajet (GoalLookAtBlock
// avec les Movements du plugin), un `equipForBlock`, et un `bot.dig`, le tout sous un `try { … } catch
// { continue; }` muet borné à 30 s. Chaque étape pouvait échouer (NoPath vers une case d'où la face est
// en ligne de vue, but volé, échéance qui laisse le collect tourner en fond, `safeToBreak` refusé…) et
// le seul verdict qui remontait était « 0 diamant en poche » → `empty nothing_mined`. Personne ne savait
// POURQUOI, et la cible était mise de côté 20 min.
//
// Ici, ce que fait un joueur, étape par étape, chacune avec sa raison d'échec :
//   1. le bloc est-il toujours un diamant ?            non → 'gone' (la carte doit l'oublier)
//   2. à portée (≤ 4,5 de l'œil) ET en ligne de vue ?  non → se placer (GoalLookAtBlock, borné)
//   3. lave contre le bloc ?                           murer ; impossible → blocked 'lava'
//   4. pioche qui le RÉCOLTE en main ?                 non → blocked 'no_tool' (jamais de collect sans)
//   5. casser (bot.dig), vérifier que le bloc est parti, ramasser le drop, puis le reste du filon.
//
// L'orchestration est ici, les effets (bot) sont INJECTÉS : testable sans serveur.

const { canHarvestWith } = require('../tools');

/** Portée de minage d'un joueur (survie) depuis l'œil, en blocs. */
const REACH = 4.5;

const DIAMOND_ORES = new Set(['diamond_ore', 'deepslate_diamond_ore']);

/** État d'une case : 'ore' (diamant), 'gone' (chargée, autre chose), 'unknown' (chunk non chargé). PUR. */
function oreStateOf(block, names = DIAMOND_ORES) {
  if (!block || !block.name) return 'unknown';
  return names.has(block.name) ? 'ore' : 'gone';
}

/** Distance œil → centre du bloc. PUR. */
function eyeDist(eye, t) {
  if (!eye || !t) return Infinity;
  return Math.hypot(eye.x - (t.x + 0.5), eye.y - (t.y + 0.5), eye.z - (t.z + 0.5));
}

/**
 * Verdict AVANT le coup de pioche. PUR.
 * @returns {null|string} null = on peut casser ; sinon la raison du refus.
 */
function digRefusal({ state, dist, visible, lavaLeft, blockName, held } = {}) {
  if (state === 'gone') return 'gone';
  if (state !== 'ore') return 'unloaded';
  if (lavaLeft) return 'lava';
  if (!canHarvestWith(blockName, held)) return 'no_tool';
  if (!(dist <= REACH)) return 'out_of_reach';
  if (!visible) return 'not_visible';
  return null;
}

function _msg(e) { return String((e && (e.name || e.message)) || e || 'error').slice(0, 60); }

/**
 * Casse le diamant `t` (déjà approché) puis le reste du filon.
 *
 * deps (tous injectés, tous best-effort) :
 *   blockAt(t)        → bloc ({name}) ou null
 *   eye()             → position de l'œil {x,y,z}
 *   canSee(t)         → booléen (ligne de vue sur le bloc)
 *   approachLook(t)   → se placer à portée + en vue (borné) ; résultat ignoré, on relit l'état
 *   clearLava(t)      → true si plus aucune lave contre le bloc (mure au besoin)
 *   equipPick(block)  → nom de l'objet en main après équipement
 *   dig(block)        → casse (rejette en cas d'échec)
 *   pickup(t)         → ramasse le drop (borné)
 *   vein(t)           → mine le reste du filon (voisins), best-effort
 *   count()           → diamants en poche
 *   cancelled()       → jeton
 *
 * → { outcome: 'mined'|'gone'|'blocked'|'cancelled', why, mined, broken }
 *   `broken` : le bloc visé a bien été cassé (la carte doit l'oublier même si le drop est perdu).
 */
async function digVisibleOre(t, deps) {
  const d = deps || {};
  const cancelled = () => { try { return !!(d.cancelled && d.cancelled()); } catch (e) { return false; } };
  const read = () => { try { return d.blockAt(t); } catch (e) { return null; } };
  const dist = () => { try { return eyeDist(d.eye(), t); } catch (e) { return Infinity; } };
  const sees = () => { try { return !!d.canSee(t); } catch (e) { return false; } };
  const before = (() => { try { return Number(d.count()) || 0; } catch (e) { return 0; } })();
  const gain = () => { try { return Math.max(0, (Number(d.count()) || 0) - before); } catch (e) { return 0; } };
  const out = (outcome, why, broken = false) => ({ outcome, why, mined: gain(), broken });

  let block = read();
  let state = oreStateOf(block);
  if (state === 'gone') return out('gone', 'gone');
  if (state !== 'ore') return out('blocked', 'unloaded');
  if (cancelled()) return out('cancelled', 'cancelled');

  // 2. se placer : portée ET ligne de vue (arrivé « à ≤ 6 blocs » ne suffit pas pour casser).
  if (!(dist() <= REACH) || !sees()) {
    try { await d.approachLook(t); } catch (e) { /* on relit l'état */ }
    if (cancelled()) return out('cancelled', 'cancelled');
    block = read();
    state = oreStateOf(block);
    if (state === 'gone') return out('gone', 'gone');
  }

  // 3. lave contre le bloc : murer, sinon on le laisse (lavaGuard).
  let lavaLeft = false;
  if (state === 'ore') { try { lavaLeft = !(await d.clearLava(t)); } catch (e) { lavaLeft = true; } }

  // 4. la pioche qui récolte — jamais de dig sans (mineflayer-tool bouclerait, et le bloc ne lâcherait rien).
  let held = null;
  if (state === 'ore' && !lavaLeft) { try { held = await d.equipPick(block); } catch (e) { held = null; } }

  const refusal = digRefusal({ state, dist: dist(), visible: sees(), lavaLeft, blockName: block && block.name, held });
  if (refusal) return out(refusal === 'gone' ? 'gone' : 'blocked', refusal);
  if (cancelled()) return out('cancelled', 'cancelled');

  // 5. casser, vérifier, ramasser, suivre le filon.
  try { await d.dig(block); } catch (e) { return out('blocked', 'dig_error:' + _msg(e)); }
  const after = oreStateOf(read());
  if (after === 'ore') return out('blocked', 'dig_no_effect');
  try { await d.pickup(t); } catch (e) { /* le compte tranche */ }
  if (!cancelled()) { try { await d.vein(t); } catch (e) { /* best-effort */ } }
  if (gain() > 0) return out('mined', null, true);
  return out('blocked', 'drop_lost', true);
}

/**
 * Échecs PAR BLOC (25/10) : un `blocked` peut être passager (but volé pendant la mise en place, mob
 * devant) — on retente une fois ; au 2e échec sur la MÊME case, elle est écartée `ttlMs` (10 min).
 * Clé EXACTE (pas la grappe : le voisin peut, lui, se casser). Niveau module dans caveHunt (partagé
 * entre reprises du but, comme sharedSkipStore).
 */
function createStrikeStore({ ttlMs = 10 * 60 * 1000, strikes = 2, now = Date.now } = {}) {
  const m = new Map();      // k → { n, at }
  const live = (k) => {
    const e = m.get(k);
    if (!e) return null;
    if (now() - e.at >= ttlMs) { m.delete(k); return null; }
    return e;
  };
  return {
    fail(k) { const e = live(k) || { n: 0, at: 0 }; e.n += 1; e.at = now(); m.set(k, e); return e.n; },
    count(k) { const e = live(k); return e ? e.n : 0; },
    banned(k) { const e = live(k); return !!(e && e.n >= strikes); },
    bannedKeys() { return [...m.keys()].filter((k) => { const e = live(k); return e && e.n >= strikes; }); },
    clear() { m.clear(); },
  };
}

module.exports = { REACH, DIAMOND_ORES, oreStateOf, eyeDist, digRefusal, digVisibleOre, createStrikeStore };
