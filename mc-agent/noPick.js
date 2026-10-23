'use strict';
// PIOCHE ABSENTE ET IRREMPLAÇABLE (23/10, NethBot1 session 408 : 55 min de `descend_y16` en boucle).
// Quand la pioche manque et que sa reconstruction échoue, le but de descente n'a aucune chance : on le
// DIT (event `no_pick_stuck {why}`) au lieu de relancer la même descente. PUR.

/** Pourquoi la pioche ne peut pas être refaite ? → 'no_cobble' | 'no_sticks' | 'inventory_full' | <raison du craft> | 'unknown'. */
function noPickWhy({ cobble = 0, sticks = 0, planks = 0, logs = 0, emptySlots = null, rebuildReason = null } = {}) {
  if (Number(cobble) < 3) return 'no_cobble';
  if (Number(sticks) < 2 && Number(planks) < 2 && Number(logs) < 1) return 'no_sticks';
  if (emptySlots === 0) return 'inventory_full';
  if (rebuildReason) return String(rebuildReason);
  return 'unknown';
}

module.exports = { noPickWhy };
