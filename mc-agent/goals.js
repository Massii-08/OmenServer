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
  // ⚠️ logs/planks NE dépendent PAS de hasTable : une table qui traîne (run précédent) ne veut pas
  // dire qu'on a du bois. Seuil planches bas (≥2) + monotone via W/S → pas d'oscillation, pas de re-récolte.
  { name: 'logs',          met: (c) => anyLog(c.inv) >= 3 || anyPlanks(c.inv) >= 2 || W(c) || S(c),
    skill: 'gatherLog',    args: { count: 3 } },
  { name: 'planks',        met: (c) => anyPlanks(c.inv) >= 2 || W(c) || S(c),
    skill: 'craftPlanks',  args: { count: 3 } }, // 3×4 = 12 planks (couvre table 4 + sticks 2 + pioche bois 3)
  { name: 'crafting_table',met: (c) => invCount(c.inv, 'crafting_table') >= 1 || W(c) || S(c),
    skill: 'craft',        args: { name: 'crafting_table', count: 1 } },
  { name: 'sticks',        met: (c) => invCount(c.inv, 'stick') >= 2 || S(c),
    skill: 'craft',        args: { name: 'stick', count: 1 } }, // 1×4 = 4 sticks (2 pioche bois + 2 pioche pierre)
  { name: 'wooden_pickaxe',met: (c) => W(c) || S(c),
    skill: 'craft',        args: { name: 'wooden_pickaxe', count: 1 } },
  { name: 'cobblestone',   met: (c) => invCount(c.inv, 'cobblestone') >= 3 || S(c),
    skill: 'gather',       args: { name: 'stone', count: 3 } },
  { name: 'stone_pickaxe', met: (c) => S(c),
    skill: 'craft',        args: { name: 'stone_pickaxe', count: 1 } },
];

// --- Chaîne FER « zéro → pioche fer » (étend la chaîne pierre : on a besoin d'une pioche pierre pour
// miner le minerai de fer, puis four+smelt). MONOTONE via W/S/F/I + cobble SCINDÉ (pick vs four) car
// le cobble est consommé en 2 fois (3 pour la pioche pierre, 8 pour le four) → 2 buts gatés chacun par
// son artefact aval, sinon ré-oscillation. Combustible smelt = bois (planches/bûches), pas de charbon.
const F = (c) => invCount(c.inv, 'furnace') >= 1;       // four obtenu (gardé en poche, posé/repris)
const I = (c) => invCount(c.inv, 'iron_pickaxe') >= 1;  // objectif final fer → tout l'amont est fait
const IRON_CHAIN = [
  { name: 'logs',           met: (c) => anyLog(c.inv) >= 5 || anyPlanks(c.inv) >= 8 || W(c) || I(c),
    skill: 'gatherLog',     args: { count: 6 } },
  { name: 'planks',         met: (c) => anyPlanks(c.inv) >= 8 || W(c) || I(c),
    skill: 'craftPlanks',   args: { count: 6 } }, // ~24 planks : table 4 + sticks 4 + pioche bois 3 + combustible + marge
  { name: 'crafting_table', met: (c) => invCount(c.inv, 'crafting_table') >= 1 || W(c) || I(c),
    skill: 'craft',         args: { name: 'crafting_table', count: 1 } },
  { name: 'sticks',         met: (c) => invCount(c.inv, 'stick') >= 2 || I(c),
    skill: 'craft',         args: { name: 'stick', count: 2 } }, // 2×4 = 8 sticks (3 pioches × 2, reste ≥2)
  { name: 'wooden_pickaxe', met: (c) => W(c) || I(c),
    skill: 'craft',         args: { name: 'wooden_pickaxe', count: 1 } },
  { name: 'cobble_pick',    met: (c) => invCount(c.inv, 'cobblestone') >= 3 || S(c) || I(c),
    skill: 'gather',        args: { name: 'stone', count: 3 } },
  { name: 'stone_pickaxe',  met: (c) => S(c) || I(c),
    skill: 'craft',         args: { name: 'stone_pickaxe', count: 1 } },
  { name: 'cobble_furnace', met: (c) => invCount(c.inv, 'cobblestone') >= 8 || F(c) || I(c),
    skill: 'gather',        args: { name: 'stone', count: 8 } },
  { name: 'furnace',        met: (c) => F(c) || I(c),
    skill: 'craft',         args: { name: 'furnace', count: 1 } },
  { name: 'iron_ore',       met: (c) => invCount(c.inv, 'raw_iron') >= 3 || invCount(c.inv, 'iron_ingot') >= 3 || I(c),
    skill: 'gather',        args: { name: ['iron_ore', 'deepslate_iron_ore'], count: 3 } }, // pioche pierre → raw_iron
  { name: 'iron_ingot',     met: (c) => invCount(c.inv, 'iron_ingot') >= 3 || I(c),
    skill: 'smeltIron',     args: { count: 3 } }, // four portable + combustible bois
  { name: 'iron_pickaxe',   met: (c) => I(c),
    skill: 'craft',         args: { name: 'iron_pickaxe', count: 1 } },
];

// --- Chaîne DIAMANT « zéro → ≥1 diamant ». Étend IRON_CHAIN (pioche fer requise pour drop diamant)
// puis ajoute 3 buts diamant : buffer cobble (anti-lave murage) → descente Y≤-52 (escalier 1×2
// diagonal) → branch mining à Y=-54. MONOTONIE via D : tous les buts amont héritent d'un `|| D(c)`
// pour ne pas redevenir "non satisfaits" quand le cobble/iron est consommé après obtention du diamant.
const D = (c) => invCount(c.inv, 'diamond') >= 1;          // objectif final
function withFinal(goal, final) {
  return Object.assign({}, goal, { met: (c) => goal.met(c) || final(c) });
}
const DIAMOND_CHAIN = [
  ...IRON_CHAIN.map((g) => withFinal(g, D)),
  // 16 cobble = ~stack/2 : assez pour murer 2-3 nappes de lave + bridging. Monotone via D.
  { name: 'cobble_buffer', met: (c) => invCount(c.inv, 'cobblestone') >= 16 || D(c),
    skill: 'gather',       args: { name: 'stone', count: 16 } },
  // Y cible -54 : juste au-dessus de la nappe de lave (Y=-55→-63, cf. spec). On accepte y<=-52
  // (marge de tolérance — l'escalier descend par paliers, on s'arrête dès qu'on franchit le seuil).
  { name: 'descend_y54',   met: (c) => (c.y !== undefined && c.y <= -52) || D(c),
    skill: 'descendDiagonal', args: { targetY: -54 } },
  // mainLength 48 = 16 branches latérales × espacement 3 (cf. spec §3 branch mining).
  { name: 'branch_mine',   met: (c) => D(c),
    skill: 'branchMine',   args: { targetY: -54, mainLength: 48, branchSpacing: 3, branchLength: 8 } },
];

// --- Chaîne MAPPER_KIT = KIT DE SURVIE du cartographe (phase « bot parfait », 04/06) :
// outils pierre (pioche + épée + HACHE) + table & four portables + STOCK de nourriture cuite (≥4)
// + torches (≥8, charbon de bois via le four). L'upgrade fer reste best-effort côté index.js.
// MAINTENANCE : food/torches sont des CONSOMMABLES sans garde-artefact → quand le stock baisse,
// le but redevient unmet et la re-tentative périodique du kit (onPeriodic) RECONSTITUE le stock.
// ⚠️ DEADLOCK vécu live (MapT2) : jamais de garde W/S « dure » sur logs/planks — le bois reste
// requis tant que sticksNeed > 0 (woodOK recalculé sur le besoin RESTANT réel).
const SS = (c) => invCount(c.inv, 'stone_sword') >= 1;   // épée pierre obtenue
const A = (c) => invCount(c.inv, 'stone_axe') >= 1;      // hache pierre obtenue
const FN = (c) => invCount(c.inv, 'furnace') >= 1;       // four en poche
const TORCH = (c) => invCount(c.inv, 'torch') >= 8;      // stock de torches
const K = (c) => S(c) && SS(c);                          // outils de défense de base (héritage)

// Nourriture CUITE comptant dans le stock de survie (le cru ne compte pas — il se cuit).
const COOKED_FOODS = ['cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
  'cooked_rabbit', 'cooked_cod', 'cooked_salmon', 'bread', 'baked_potato'];
function cookedCount(inv) { return COOKED_FOODS.reduce((s, n) => s + invCount(inv, n), 0); }

// Besoin RESTANT en sticks selon les artefacts manquants (2 pioche bois, 2 pioche pierre, 1 épée,
// 2 hache, 2 torches). Cap à 8 (un craft de 2 lots en produit 8 — évite la double-itération inutile).
function sticksNeed(c) {
  const need = ((W(c) || S(c)) ? 0 : 2) + (S(c) ? 0 : 2) + (SS(c) ? 0 : 1) + (A(c) ? 0 : 2) + (TORCH(c) ? 0 : 2);
  return Math.min(need, 8);
}
const sticksOK = (c) => { const n = sticksNeed(c); return n === 0 || invCount(c.inv, 'stick') >= n; };
// bois plus nécessaire : pioche (bois ou pierre) + table en poche + sticks suffisants pour la suite
const woodOK = (c) => (W(c) || S(c)) && invCount(c.inv, 'crafting_table') >= 1 && sticksOK(c);
const MAPPER_KIT = [
  { name: 'logs',           met: (c) => anyLog(c.inv) >= 3 || anyPlanks(c.inv) >= 2 || woodOK(c),
    skill: 'gatherLog',     args: { count: 4 } },
  { name: 'planks',         met: (c) => anyPlanks(c.inv) >= 2 || woodOK(c),
    skill: 'craftPlanks',   args: { count: 4 } }, // 4×4 = 16 planks (table 4 + sticks 6 + pioche bois 3 + marge)
  { name: 'crafting_table', met: (c) => invCount(c.inv, 'crafting_table') >= 1 || K(c),
    skill: 'craft',         args: { name: 'crafting_table', count: 1 } },
  { name: 'sticks',         met: (c) => sticksOK(c),
    skill: 'craft',         args: { name: 'stick', count: 3 } }, // 3×4 = 12 sticks (besoin max 9, marge)
  { name: 'wooden_pickaxe', met: (c) => W(c) || S(c) || K(c),
    skill: 'craft',         args: { name: 'wooden_pickaxe', count: 1 } },
  { name: 'cobble_pick',    met: (c) => invCount(c.inv, 'cobblestone') >= 3 || S(c) || K(c),
    skill: 'gather',        args: { name: 'stone', count: 3 } },
  { name: 'stone_pickaxe',  met: (c) => S(c) || K(c),
    skill: 'craft',         args: { name: 'stone_pickaxe', count: 1 } },
  { name: 'cobble_sword',   met: (c) => invCount(c.inv, 'cobblestone') >= 2 || SS(c) || K(c),
    skill: 'gather',        args: { name: 'stone', count: 2 } },
  { name: 'stone_sword',    met: (c) => SS(c) || K(c),
    skill: 'craft',         args: { name: 'stone_sword', count: 1 } },
  // --- extension survie (hache, four, torches, nourriture) ---
  { name: 'cobble_axe',     met: (c) => invCount(c.inv, 'cobblestone') >= 3 || A(c),
    skill: 'gather',        args: { name: 'stone', count: 3 } },
  { name: 'stone_axe',      met: (c) => A(c),
    skill: 'craft',         args: { name: 'stone_axe', count: 1 } },
  { name: 'cobble_furnace', met: (c) => invCount(c.inv, 'cobblestone') >= 8 || FN(c),
    skill: 'gather',        args: { name: 'stone', count: 8 } },
  { name: 'furnace',        met: (c) => FN(c),
    skill: 'craft',         args: { name: 'furnace', count: 1 } },
  // charbon de BOIS (2 bûches fondues au four ; le skill auto-récolte les bûches s'il en manque)
  { name: 'charcoal',       met: (c) => (invCount(c.inv, 'charcoal') + invCount(c.inv, 'coal')) >= 2 || TORCH(c),
    skill: 'smeltCharcoal', args: { count: 2 } },
  { name: 'torches',        met: (c) => TORCH(c),
    skill: 'craft',         args: { name: 'torch', count: 2 } }, // 2×4 = 8 torches
  // stock de nourriture CUITE — consommable : redevient unmet quand mangé → re-chasse (maintenance)
  { name: 'food_stock',     met: (c) => cookedCount(c.inv) >= 4,
    skill: 'huntCook',      args: { target: 4 } },
];

/** Sélectionne la chaîne de buts selon le type d'objectif (défaut : pioche pierre). */
function chainFor(objective) {
  if (objective === 'diamond') return DIAMOND_CHAIN;
  if (objective === 'iron_pickaxe') return IRON_CHAIN;
  if (objective === 'mapper') return MAPPER_KIT;
  return MVP_CHAIN;
}

/** Premier but non satisfait dans l'ordre, ou null si tout est fait. */
function firstUnmet(chain, ctx) {
  for (const g of chain) { if (!g.met(ctx)) return g; }
  return null;
}

module.exports = { buildCtxInv, invCount, anyLog, anyPlanks, cookedCount, COOKED_FOODS, MVP_CHAIN, IRON_CHAIN, DIAMOND_CHAIN, MAPPER_KIT, chainFor, firstUnmet };
