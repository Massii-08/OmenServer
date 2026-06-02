'use strict';
// Chaîne de buts MVP « zéro → pioche pierre ». Données + prédicats purs (testables sans serveur).

/** Map {itemName: countTotal} depuis bot.inventory.items(). */
function buildCtxInv(bot) {
  const inv = {};
  const items = (bot.inventory && bot.inventory.items()) || [];
  for (const it of items) { inv[it.name] = (inv[it.name] || 0) + it.count; }
  return inv;
}
function invCount(inv, name) { return inv[name] || 0; }

// "log"/"planks" génériques : on accepte n'importe quelle essence (oak par défaut côté skill).
function anyLog(inv) {
  return Object.keys(inv).filter((n) => n.endsWith('_log')).reduce((s, n) => s + inv[n], 0);
}
function anyPlanks(inv) {
  return Object.keys(inv).filter((n) => n.endsWith('_planks')).reduce((s, n) => s + inv[n], 0);
}

// Chaîne ordonnée. `met(ctx)` = ce but est-il déjà accompli ? `skill`+`args` = comment l'accomplir.
// Quantités : table 4 + pioche bois 3 + sticks (2 planks→4 sticks) ⇒ ≥9 planks ; 4 sticks ; 3 cobble.
// `met` MONOTONE : on OR avec les artefacts AVAL (table posée, pioche bois/pierre) pour qu'une
// étape déjà franchie ne redevienne pas "non satisfaite" quand une ressource est consommée plus loin.
const W = (c) => invCount(c.inv, 'wooden_pickaxe') >= 1; // pioche bois obtenue → tout l'amont est fait
const S = (c) => invCount(c.inv, 'stone_pickaxe') >= 1;  // objectif final
const MVP_CHAIN = [
  { name: 'logs',          met: (c) => anyLog(c.inv) >= 3 || anyPlanks(c.inv) >= 9 || c.hasTable || W(c) || S(c),
    skill: 'gatherLog',    args: { count: 3 } },
  { name: 'planks',        met: (c) => anyPlanks(c.inv) >= 9 || c.hasTable || W(c) || S(c),
    skill: 'craftPlanks',  args: { count: 3 } }, // 3×4 = 12 planks (couvre table 4 + sticks 2 + pioche bois 3)
  { name: 'crafting_table',met: (c) => invCount(c.inv, 'crafting_table') >= 1 || c.hasTable || W(c) || S(c),
    skill: 'craft',        args: { name: 'crafting_table', count: 1 } },
  { name: 'place_table',   met: (c) => c.hasTable || W(c) || S(c),
    skill: 'placeTable',   args: {} },
  { name: 'sticks',        met: (c) => invCount(c.inv, 'stick') >= 2 || S(c),
    skill: 'craft',        args: { name: 'stick', count: 1 } }, // 1×4 = 4 sticks (2 pioche bois + 2 pioche pierre)
  { name: 'wooden_pickaxe',met: (c) => W(c) || S(c),
    skill: 'craft',        args: { name: 'wooden_pickaxe', count: 1 } },
  { name: 'cobblestone',   met: (c) => invCount(c.inv, 'cobblestone') >= 3 || S(c),
    skill: 'gather',       args: { name: 'stone', count: 3 } },
  { name: 'stone_pickaxe', met: (c) => S(c),
    skill: 'craft',        args: { name: 'stone_pickaxe', count: 1 } },
];

/** Premier but non satisfait dans l'ordre, ou null si tout est fait. */
function firstUnmet(chain, ctx) {
  for (const g of chain) { if (!g.met(ctx)) return g; }
  return null;
}

module.exports = { buildCtxInv, invCount, anyLog, anyPlanks, MVP_CHAIN, firstUnmet };
