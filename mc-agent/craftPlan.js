'use strict';
// CRAFTS SANS INTERMÉDIAIRES — décision PURE (20/10, run sessions ≥ 310).
//
// ─── LE MÉCANISME MESURÉ ──────────────────────────────────────────────────────────────────────────
// `craft_fail_ctx` sur 2 h : 107× `stone_pickaxe no_table:unknown_item`, plus `torch`/`iron_helmet`/
// `stick`/`wooden_pickaxe` avec la même raison. Lecture de la chaîne (index.js) :
//   craftItem(stone_pickaxe) → pas de table à ≤ 6 → recette 3×3 introuvable → `no_recipe`
//   → withCraftingTable → aucune table en poche, < 4 planches, aucune bûche → craft de la table raté
//     (en silence, best-effort) → placeBlockNear('crafting_table') ne trouve pas l'objet en poche
//     → 'unknown_item' → `no_table:unknown_item`.
// `unknown_item` ne veut donc PAS dire « objet inconnu » : il veut dire « je n'ai pas de table à poser
// et pas assez de bois pour en faire une ». Cas type MapBot2 (session 318, 89 occurrences en 30 min) :
// cobblestone 930, birch_planks 3, stick 8 — il manquait UNE planche pour la table, aucune bûche, et
// le filet « watchdog pioche » (index.js, toutes les 20 s) relançait stone_pickaxe PUIS wooden_pickaxe,
// deux `table_place_failed` par passe, indéfiniment. Autre cas : bûches en poche mais aucune planche ni
// bâton (`birch_log:15, acacia_planks:1`) — rien ne faisait planches → bâtons avant la recette.
//
// ─── LA RÈGLE ─────────────────────────────────────────────────────────────────────────────────────
// Avant un craft connu, on calcule les intermédiaires (bûches → planches de la MÊME essence, planches →
// bâtons, planches → table) ; s'il manque une matière première (bois, pierre, fer, charbon), on le dit
// TOUT DE SUITE avec une raison claire au lieu d'aller marcher vers une table / d'en poser une.
// ⚠️ 1.21.4 + mineflayer : une recette « planches » veut des planches d'UNE SEULE essence (minecraft-data
// n'a que des recettes concrètes, une par essence — cf. planks.js). Chaque besoin en planches (le
// produit, chaque fournée de bâtons, la table) est donc servi par UNE essence.
// ⚠️ Rejet = SEULEMENT quand c'est sûr. Pierre : la SOMME des pierres de taille suffit à ne pas rejeter
// (on ne bloque jamais un craft que le jeu permettrait). Objet absent de la table → `known:false`, et
// l'appelant fait exactement comme avant.

const PLANKS_PER_LOG = 4;
const STICKS_PER_CRAFT = 4;           // 2 planches → 4 bâtons
const TABLE_PLANKS = 4;
const STONE = ['cobblestone', 'cobbled_deepslate', 'blackstone'];
const COALS = ['coal', 'charcoal'];

// Besoin PAR craft (bot.craft(recipe, count) applique la recette `count` fois).
// planks = planches d'une même essence ; sticks ; stone ; iron = lingots ; coal ; table = 3×3.
const RECIPES = {
  stick: { planks: 2 },
  crafting_table: { planks: 4 },
  torch: { sticks: 1, coal: 1 },
  wooden_pickaxe: { planks: 3, sticks: 2, table: true },
  wooden_axe: { planks: 3, sticks: 2, table: true },
  wooden_sword: { planks: 2, sticks: 1, table: true },
  wooden_shovel: { planks: 1, sticks: 2, table: true },
  stone_pickaxe: { stone: 3, sticks: 2, table: true },
  stone_axe: { stone: 3, sticks: 2, table: true },
  stone_sword: { stone: 1, sticks: 1, table: true },
  stone_shovel: { stone: 1, sticks: 2, table: true },
  iron_pickaxe: { iron: 3, sticks: 2, table: true },
  iron_axe: { iron: 3, sticks: 2, table: true },
  iron_sword: { iron: 2, sticks: 1, table: true },
  iron_shovel: { iron: 1, sticks: 2, table: true },
  iron_helmet: { iron: 5, table: true },
  iron_chestplate: { iron: 8, table: true },
  iron_leggings: { iron: 7, table: true },
  iron_boots: { iron: 4, table: true },
  shield: { planks: 6, iron: 1, table: true },
  furnace: { stone: 8, table: true },
  chest: { planks: 8, table: true },
};

const NOT_WOOD = new Set(['mushroom_stem']);
function _logBase(name) {
  if (name.startsWith('stripped_') || NOT_WOOD.has(name)) return null;
  if (name.endsWith('_log')) return name.slice(0, -4);
  if (name.endsWith('_stem')) return name.slice(0, -5);
  return null;
}

/** Inventaire → { nom: total } (accepte un tableau d'items mineflayer OU déjà un objet de comptes). */
function toCounts(inv) {
  if (Array.isArray(inv)) {
    const out = {};
    for (const it of inv) if (it && it.name && Number(it.count) > 0) out[it.name] = (out[it.name] || 0) + Number(it.count);
    return out;
  }
  return Object.assign({}, inv || {});
}

/**
 * PUR — étapes intermédiaires pour crafter `item` × `count`.
 * @param {string} item
 * @param {Object|Array} inventory  comptes par nom, ou items mineflayer
 * @param {{count?:number, tableAvailable?:boolean}} [opts]  tableAvailable = table en poche OU utilisable en vue
 * @returns {{known:false}
 *          |{known:true, ok:true, steps:Array<{name:string,count:number}>}
 *          |{known:true, ok:false, reason:string, need?:number, have?:number}}
 *   steps : à exécuter DANS L'ORDRE (tous des crafts 2×2 : planches, bâtons, table). Vide = prêt.
 *   reason : 'no_wood:<pour quoi>' (planks|sticks|table) · 'no_stone' · 'no_iron' · 'no_coal'.
 */
function planIntermediates(item, inventory, opts) {
  const r = RECIPES[String(item || '').toLowerCase()];
  if (!r) return { known: false };
  const o = opts || {};
  const times = Number(o.count) > 0 ? Math.floor(Number(o.count)) : 1;
  const inv = toCounts(inventory);

  // 1. Matières premières non-bois : rien à fabriquer, on vérifie seulement.
  if (r.stone) {
    const have = STONE.reduce((a, n) => a + (inv[n] || 0), 0);
    if (have < r.stone * times) return { known: true, ok: false, reason: 'no_stone', need: r.stone * times, have };
  }
  if (r.iron) {
    const have = inv.iron_ingot || 0;
    if (have < r.iron * times) return { known: true, ok: false, reason: 'no_iron', need: r.iron * times, have };
  }
  if (r.coal) {
    const have = COALS.reduce((a, n) => a + (inv[n] || 0), 0);
    if (have < r.coal * times) return { known: true, ok: false, reason: 'no_coal', need: r.coal * times, have };
  }

  // 2. Bois : demandes servies chacune par UNE essence.
  const demands = [];
  if (r.planks) demands.push({ what: 'planks', n: r.planks * times });
  const stickNeed = (r.sticks || 0) * times - (inv.stick || 0);
  const stickCrafts = stickNeed > 0 ? Math.ceil(stickNeed / STICKS_PER_CRAFT) : 0;
  for (let i = 0; i < stickCrafts; i++) demands.push({ what: 'sticks', n: 2 });
  if (r.table && !o.tableAvailable) demands.push({ what: 'table', n: TABLE_PLANKS });
  if (!demands.length) return { known: true, ok: true, steps: [] };

  const planks = {};   // essence → planches
  const logs = {};     // essence → bûches
  for (const name of Object.keys(inv)) {
    const c = inv[name] || 0;
    if (!(c > 0)) continue;
    if (name.endsWith('_planks')) { const b = name.slice(0, -7); planks[b] = (planks[b] || 0) + c; continue; }
    const lb = _logBase(name);
    if (lb) logs[lb] = (logs[lb] || 0) + c;
  }
  const convert = {};  // essence → bûches à convertir
  // Les grosses demandes d'abord : elles sont les plus difficiles à servir d'une seule essence.
  const order = demands.slice().sort((a, b) => b.n - a.n);
  for (const d of order) {
    const bases = Array.from(new Set(Object.keys(planks).concat(Object.keys(logs))));
    // a) une essence qui a déjà les planches (la plus fournie : on garde les petits restes intacts)
    let pick = null;
    for (const b of bases) if ((planks[b] || 0) >= d.n && (!pick || planks[b] > planks[pick])) pick = b;
    if (pick) { planks[pick] -= d.n; continue; }
    // b) sinon, celle qui demande le moins de bûches à convertir
    let best = null;
    for (const b of bases) {
      const missing = d.n - (planks[b] || 0);
      const k = Math.ceil(missing / PLANKS_PER_LOG);
      if ((logs[b] || 0) >= k && (!best || k < best.k)) best = { b, k };
    }
    if (!best) {
      let wood = 0;
      for (const b of bases) wood += (planks[b] || 0) + (logs[b] || 0) * PLANKS_PER_LOG;
      return { known: true, ok: false, reason: 'no_wood:' + d.what, need: d.n, have: wood };
    }
    logs[best.b] -= best.k;
    planks[best.b] = (planks[best.b] || 0) + best.k * PLANKS_PER_LOG - d.n;
    convert[best.b] = (convert[best.b] || 0) + best.k;
  }
  const steps = [];
  for (const b of Object.keys(convert).sort()) steps.push({ name: b + '_planks', count: convert[b] });
  for (let i = 0; i < stickCrafts; i++) steps.push({ name: 'stick', count: 1 });
  if (r.table && !o.tableAvailable) steps.push({ name: 'crafting_table', count: 1 });
  return { known: true, ok: true, steps };
}

/** PUR — signature de la matière de craft (change ⇔ un craft raté mérite d'être retenté). */
function craftSignature(inventory) {
  const inv = toCounts(inventory);
  const keep = Object.keys(inv).filter((n) => /_planks$|_log$|_stem$|^stick$|^crafting_table$|^iron_ingot$|^coal$|^charcoal$/.test(n)
    || STONE.includes(n)).sort();
  return keep.map((n) => n + ':' + inv[n]).join(',');
}

// ─── BACKOFF DU FILET « PIOCHE » ─────────────────────────────────────────────────────────────────
// Un craft raté se retente au bout de base, puis 2×, 4×… (plafond maxMs) TANT QUE la matière n'a pas
// changé et que la raison est la même. Une nouvelle matière (bûche ramassée, livraison du bûcheron)
// lève le backoff immédiatement : on ne rate jamais une occasion réelle.
const BACKOFF_BASE_MS = 40000;
const BACKOFF_MAX_MS = 10 * 60 * 1000;

function createCraftBackoff({ baseMs = BACKOFF_BASE_MS, maxMs = BACKOFF_MAX_MS } = {}) {
  const st = new Map();
  return {
    /** L'entrée bloquante si `item` est en attente (même matière), sinon null. */
    blocked(item, sig, now) {
      const s = st.get(item);
      if (!s) return null;
      if (s.sig !== sig) { st.delete(item); return null; }
      return now < s.until ? s : null;
    },
    /** Note un échec ; rend l'attente avant la prochaine tentative (ms). */
    fail(item, reason, sig, now) {
      const s = st.get(item);
      const same = !!(s && s.sig === sig && s.reason === reason);
      const fails = same ? s.fails + 1 : 1;
      const wait = Math.min(maxMs, baseMs * Math.pow(2, fails - 1));
      st.set(item, { reason, sig, fails, until: now + wait });
      return wait;
    },
    ok(item) { st.delete(item); },
    size() { return st.size; },
  };
}

module.exports = {
  planIntermediates, craftSignature, createCraftBackoff, toCounts,
  RECIPES, PLANKS_PER_LOG, STICKS_PER_CRAFT, TABLE_PLANKS, BACKOFF_BASE_MS, BACKOFF_MAX_MS,
};
