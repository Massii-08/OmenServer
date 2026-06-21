'use strict';
// Quotas par bot ressource (multi-quota). Module PUR (zéro I/O, zéro dépendance bot) :
// compte les items récoltés par TYPE logique (diamond/gold/redstone/lapis/iron) à partir
// de l'inventaire + d'un cumul `banked` (items déposés/perdus de l'inventaire mais déjà
// récoltés — le dépôt ne fait pas perdre le compte). Le bot s'arrête quand TOUT est atteint.

// Items comptés par type (ce que droppe le minerai, pioche non-silk-touch) :
//  - iron compte raw_iron ET iron_ingot, gold compte raw_gold ET gold_ingot : un lingot fondu reste
//    du métal récolté (exigence Massii : LIVRER des lingots fondus). Sans gold_ingot dans la liste,
//    fondre raw_gold → gold_ingot faisait CHUTER le compteur or à 0.
const ITEMS_FOR = {
  diamond: ['diamond'],
  gold: ['raw_gold', 'gold_ingot'],
  redstone: ['redstone'],
  lapis: ['lapis_lazuli'],
  iron: ['raw_iron', 'iron_ingot'],
};
const QUOTA_TYPES = Object.keys(ITEMS_FOR); // ['diamond','gold','redstone','lapis','iron']

// Quota par défaut de la mission « bots ressources » : 15💎 / 15 or / 64 redstone / 64 lapis / 64 fer.
const DEFAULT_QUOTA = { diamond: 15, gold: 15, redstone: 64, lapis: 64, iron: 64 };

// item name → type logique (lookup inverse, construit une fois).
const _TYPE_OF = {};
for (const [type, names] of Object.entries(ITEMS_FOR)) {
  for (const n of names) _TYPE_OF[n] = type;
}

/** Compte les items quota d'une liste d'items d'inventaire [{name, count}] → {type: n}. */
function countItems(items) {
  const out = {};
  for (const t of QUOTA_TYPES) out[t] = 0;
  for (const it of items || []) {
    const type = it && _TYPE_OF[it.name];
    if (type) out[type] += (Number(it.count) || 0);
  }
  return out;
}

/** Normalise un quota demandé : ne garde que les types connus, valeurs entières > 0. */
function normalizeQuota(quota) {
  const src = (quota && typeof quota === 'object') ? quota : DEFAULT_QUOTA;
  const out = {};
  for (const t of QUOTA_TYPES) {
    const v = Math.floor(Number(src[t]));
    if (Number.isFinite(v) && v > 0) out[t] = v;
  }
  return Object.keys(out).length ? out : Object.assign({}, DEFAULT_QUOTA);
}

/**
 * Tracker de quota : have = banked (cumul hors inventaire) + inventaire courant.
 * `noteBanked(before, after)` : à appeler autour d'un dépôt/perte volontaire — crédite la
 * DIFFÉRENCE positive par type (robuste quel que soit ce que le dépôt a réellement vidé).
 */
function createQuotaTracker(quota) {
  const target = normalizeQuota(quota);
  const banked = {};
  for (const t of Object.keys(target)) banked[t] = 0;

  function progress(items) {
    const inv = countItems(items);
    const out = {};
    for (const t of Object.keys(target)) {
      out[t] = { have: Math.min(banked[t] + inv[t], target[t]) + 0, target: target[t] };
      // have réel (non plafonné) utile aussi : on garde le min pour l'affichage, mais met()
      // compare le réel — recalcule sans plafonner :
      out[t].have = banked[t] + inv[t];
    }
    return out;
  }

  function remainingTypes(items) {
    const p = progress(items);
    return Object.keys(p).filter((t) => p[t].have < p[t].target);
  }

  function met(items) { return remainingTypes(items).length === 0; }

  function noteBanked(before, after) {
    const b = countItems(before), a = countItems(after);
    for (const t of Object.keys(target)) {
      const d = b[t] - a[t];
      if (d > 0) banked[t] += d;
    }
  }

  return { target, progress, remainingTypes, met, noteBanked };
}

// ─── Tri de l'inventaire (mode quota, sous terre : pas de coffre → on JETTE le junk) ───

// Ce qu'on ne jette JAMAIS : items quota, outils/armes, bouffe, blocs utilitaires (table,
// torches, remblai minimal géré par ailleurs). Tout le reste (cobble/deepslate/dirt/gravel…)
// est du junk de creusage qui sature l'inventaire.
const _KEEP_EXACT = new Set([
  ...Object.values(ITEMS_FOR).flat(),
  'crafting_table', 'torch', 'furnace', 'chest',
  // Consommables d'autonomie sous terre (phase 3 — leur toss créait des impasses, type V2Res1) :
  'stick',            // re-craft des pioches (pas de bois en sous-sol → sticks jetés = impasse)
  'coal', 'charcoal', // torches (phase B) + combustible four
]);
// Blocs gardés à 1 STACK chacun (le surplus est du junk de creusage) :
const _KEEP_ONE_STACK = new Set(['cobblestone', 'cobbled_deepslate']); // remblai + murage anti-lave
const _KEEP_SUFFIX = ['_pickaxe', '_axe', '_shovel', '_sword', '_helmet', '_chestplate', '_leggings', '_boots',
  '_planks']; // planks : re-craft table/sticks en sous-sol
const _KEEP_FOOD = new Set(['bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
  'baked_potato', 'carrot', 'apple', 'golden_apple', 'cooked_cod', 'cooked_salmon']);

/** Items à JETER d'une liste d'inventaire (mode quota). Pur. */
function junkItems(items) {
  const out = [];
  const stackKept = {};                     // name → 1 si un stack a déjà été gardé
  for (const it of items || []) {
    if (!it || !it.name) continue;
    if (_KEEP_ONE_STACK.has(it.name)) {
      // garde 1 stack (remblai/murage), jette le surplus
      if (!stackKept[it.name]) { stackKept[it.name] = 1; continue; }
      out.push(it); continue;
    }
    if (_KEEP_EXACT.has(it.name) || _KEEP_FOOD.has(it.name)) continue;
    if (_KEEP_SUFFIX.some((s) => it.name.endsWith(s))) continue;
    out.push(it);
  }
  return out;
}

module.exports = {
  ITEMS_FOR, QUOTA_TYPES, DEFAULT_QUOTA,
  countItems, normalizeQuota, createQuotaTracker, junkItems,
};
