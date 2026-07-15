'use strict';
// Buffer de blocs POSABLES d'urgence : de quoi se sceller un toit d'abri même sans rien miner.
// Blocs qui droppent SANS outil (terre/gravier/sable) ou déjà en poche (cobble) — pas les minerais.
const POSABLE = new Set(['dirt', 'coarse_dirt', 'grass_block', 'gravel', 'sand', 'red_sand',
  'cobblestone', 'cobbled_deepslate', 'netherrack', 'dirt_path']);

/** inv = [{name,count}] ; true si moins de `min` blocs posables en poche. PUR. */
function needDirtBuffer(inv, min = 4) {
  let n = 0;
  for (const it of inv || []) if (POSABLE.has(it.name)) n += (it.count || 0);
  return n < min;
}

module.exports = { needDirtBuffer, POSABLE };
