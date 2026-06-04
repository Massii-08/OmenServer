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
// Planches NÉCESSAIRES pour la suite : table (4 si manquante) + pioche bois (3 si manquante)
// + sticks manquants (1 lot de 4 sticks = 2 planches). ⚠️ vécu Surv3 : un seuil fixe « ≥2 » laissait
// le craft de table boucler à 3 planches (recette = 4) → comptabilité RÉELLE, pas de seuil arbitraire.
function planksNeed(c) {
  const stickShort = Math.max(0, sticksNeed(c) - invCount(c.inv, 'stick'));
  return (invCount(c.inv, 'crafting_table') >= 1 ? 0 : 4)
       + ((W(c) || S(c)) ? 0 : 3)
       + Math.ceil(stickShort / 4) * 2;
}
const planksOK = (c) => { const n = planksNeed(c); return n === 0 || anyPlanks(c.inv) >= n; };
const MAPPER_KIT = [
  { name: 'logs',           met: (c) => anyLog(c.inv) >= 3 || planksOK(c),
    skill: 'gatherLog',     args: { count: 6 } }, // 6 : planches + 2 bûches charbon + fuel (vécu Surv6 : re-gather long en plein kit)
  { name: 'planks',         met: (c) => planksOK(c),
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
  // stock de nourriture CUITE AVANT les torches (vécu Surv8 : le stall charbon bloquait la cuisson
  // — la viande restait crue en poche). Consommable : redevient unmet quand mangé → re-chasse.
  { name: 'food_stock',     met: (c) => cookedCount(c.inv) >= 4,
    skill: 'huntCook',      args: { target: 4 } },
  // charbon : MINE du coal_ore si visible (commun), sinon charbon de BOIS (bûches fondues au four)
  { name: 'charcoal',       met: (c) => (invCount(c.inv, 'charcoal') + invCount(c.inv, 'coal')) >= 2 || TORCH(c),
    skill: 'smeltCharcoal', args: { count: 2 } },
  { name: 'torches',        met: (c) => TORCH(c),
    skill: 'craft',         args: { name: 'torch', count: 2 } }, // 2×4 = 8 torches
];

// --- Chaîne MARATHON_KIT = kit du mineur LONGUE DURÉE (06/04) : tout le MAPPER_KIT (outils pierre
// + four + food + torches) + PIOCHE FER (mine diamant/redstone/or) + COFFRE (base de dépôt) +
// buffer scaffold (murage lave). La phase de collecte (boucle marathon, index.js) prend le relais
// après le kit ; le kit RE-SERT après une mort non récupérée (monotone → ne refait que le manquant).
const IP = (c) => invCount(c.inv, 'iron_pickaxe') >= 1;
// Le coffre quitte l'inventaire quand la base est posée → on OR avec hasBase (sinon re-craft en boucle).
const CHEST = (c) => invCount(c.inv, 'chest') >= 1 || !!c.hasBase;
// Scaffold = cobble + deepslate cobble (à Y<0 le minage donne du cobbled_deepslate, cf. P1).
function scaffoldInv(inv) { return invCount(inv, 'cobblestone') + invCount(inv, 'cobbled_deepslate'); }
// Planches : besoin mapper + 8 pour le coffre s'il manque encore.
function planksNeedM(c) { return planksNeed(c) + (CHEST(c) ? 0 : 8); }
const planksOKM = (c) => { const n2 = planksNeedM(c); return n2 === 0 || anyPlanks(c.inv) >= n2; };
const MARATHON_KIT = [
  { name: 'logs',           met: (c) => anyLog(c.inv) >= 3 || planksOKM(c),
    skill: 'gatherLog',     args: { count: 8 } }, // 8 : planches (kit+coffre) + charbon + fuel
  { name: 'planks',         met: (c) => planksOKM(c),
    skill: 'craftPlanks',   args: { count: 6 } }, // 6×4 = 24 (table 4 + sticks + pioche 3 + coffre 8)
  { name: 'crafting_table', met: (c) => invCount(c.inv, 'crafting_table') >= 1 || K(c),
    skill: 'craft',         args: { name: 'crafting_table', count: 1 } },
  { name: 'sticks',         met: (c) => sticksOK(c),
    skill: 'craft',         args: { name: 'stick', count: 3 } },
  { name: 'wooden_pickaxe', met: (c) => W(c) || S(c) || K(c) || IP(c),
    skill: 'craft',         args: { name: 'wooden_pickaxe', count: 1 } },
  { name: 'cobble_pick',    met: (c) => invCount(c.inv, 'cobblestone') >= 3 || S(c) || IP(c),
    skill: 'gather',        args: { name: 'stone', count: 3 } },
  { name: 'stone_pickaxe',  met: (c) => S(c) || IP(c),
    skill: 'craft',         args: { name: 'stone_pickaxe', count: 1 } },
  { name: 'cobble_sword',   met: (c) => invCount(c.inv, 'cobblestone') >= 2 || SS(c),
    skill: 'gather',        args: { name: 'stone', count: 2 } },
  { name: 'stone_sword',    met: (c) => SS(c),
    skill: 'craft',         args: { name: 'stone_sword', count: 1 } },
  { name: 'cobble_axe',     met: (c) => invCount(c.inv, 'cobblestone') >= 3 || A(c),
    skill: 'gather',        args: { name: 'stone', count: 3 } },
  { name: 'stone_axe',      met: (c) => A(c),
    skill: 'craft',         args: { name: 'stone_axe', count: 1 } },
  { name: 'cobble_furnace', met: (c) => invCount(c.inv, 'cobblestone') >= 8 || FN(c),
    skill: 'gather',        args: { name: 'stone', count: 8 } },
  { name: 'furnace',        met: (c) => FN(c),
    skill: 'craft',         args: { name: 'furnace', count: 1 } },
  // pioche FER (clé du marathon : diamant/redstone/or inminables sans elle).
  // gatherIron ≠ gather : le fer n'est PRESQUE JAMAIS exposé en surface (vécu Marathon run#2 :
  // ×20 timeouts de 90s en roaming) → si pas visible ≤32, on CREUSE à Y=16 (pic du fer) + branch mine.
  { name: 'iron_ore',       met: (c) => invCount(c.inv, 'raw_iron') >= 3 || invCount(c.inv, 'iron_ingot') >= 3 || IP(c),
    skill: 'gatherIron',    args: { count: 3 } },
  { name: 'iron_ingot',     met: (c) => invCount(c.inv, 'iron_ingot') >= 3 || IP(c),
    skill: 'smeltIron',     args: { count: 3 } },
  { name: 'iron_pickaxe',   met: (c) => IP(c),
    skill: 'craft',         args: { name: 'iron_pickaxe', count: 1 } },
  // consommables (re-deviennent unmet quand consommés → reconstitués au re-run du kit)
  { name: 'food_stock',     met: (c) => cookedCount(c.inv) >= 4,
    skill: 'huntCook',      args: { target: 4 } },
  { name: 'charcoal',       met: (c) => (invCount(c.inv, 'charcoal') + invCount(c.inv, 'coal')) >= 2 || TORCH(c),
    skill: 'smeltCharcoal', args: { count: 2 } },
  { name: 'torches',        met: (c) => TORCH(c),
    skill: 'craft',         args: { name: 'torch', count: 2 } },
  // coffre de base (8 planches) — part en poche, posé en profondeur par la boucle marathon
  { name: 'chest',          met: (c) => CHEST(c),
    skill: 'craft',         args: { name: 'chest', count: 1 } },
  // buffer de murage lave pour la descente + le branch mining
  { name: 'scaffold_buffer', met: (c) => scaffoldInv(c.inv) >= 16,
    skill: 'gather',        args: { name: 'stone', count: 16 } },
];

/** Sélectionne la chaîne de buts selon le type d'objectif (défaut : pioche pierre). */
function chainFor(objective) {
  if (objective === 'diamond') return DIAMOND_CHAIN;
  if (objective === 'iron_pickaxe') return IRON_CHAIN;
  if (objective === 'mapper') return MAPPER_KIT;
  if (objective === 'marathon') return MARATHON_KIT;
  return MVP_CHAIN;
}

/** Premier but non satisfait dans l'ordre, ou null si tout est fait. */
function firstUnmet(chain, ctx) {
  for (const g of chain) { if (!g.met(ctx)) return g; }
  return null;
}

module.exports = { buildCtxInv, invCount, anyLog, anyPlanks, cookedCount, COOKED_FOODS, MVP_CHAIN, IRON_CHAIN, DIAMOND_CHAIN, MAPPER_KIT, MARATHON_KIT, scaffoldInv, chainFor, firstUnmet };
