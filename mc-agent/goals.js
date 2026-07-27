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
// BOUCLIER — il NÉGLIGE le coup (≠ armure qui le réduit) pour 1 lingot + 6 planches. ⚠️ un
// bouclier ÉQUIPÉ vit en main secondaire (slot 45), absente de `inventory.items()` tout comme
// l'armure (slots 5-8) : sans `ctx.offhand` le bot en re-crafterait un à l'infini après l'avoir
// équipé (même piège que `worn` pour armorNeed).
// Blocs POSABLES en poche (source unique : dirt.POSABLE + toutes les planches). C'est la MATIÈRE
// des deux protections livrées le 25/07 : se mettre à couvert d'un tireur, et se murer quand
// creuser échoue. Mesure live : sans elle, 12 abris avortés + 12 couverts en `placed:0`. La fonte
// d'amorçage brûlant les planches, la poche se vide pile quand la survie en a besoin.
const { POSABLE } = require('./dirt');
function posableCount(inv) {
  const o = inv || {};
  return Object.keys(o).reduce(
    (s, n) => s + ((POSABLE.has(n) || n.endsWith('_planks')) ? (o[n] || 0) : 0), 0);
}

// Une arme de mêlée correcte en poche (pierre ou mieux). Le bois est ignoré : 4 dégâts pour une
// durabilité de 59, ça ne vaut pas un détour — mais s'il en a une, on ne le force pas à re-crafter.
const AXES = ['stone_axe', 'iron_axe', 'golden_axe', 'diamond_axe', 'netherite_axe'];
function hasAxe(inv) {
  const i = inv || {};
  return AXES.some((n) => (i[n] || 0) > 0);
}

const SWORDS = ['stone_sword', 'iron_sword', 'golden_sword', 'diamond_sword', 'netherite_sword'];
function hasSword(inv) {
  const i = inv || {};
  return SWORDS.some((n) => (i[n] || 0) > 0);
}

function hasShield(c) {
  const o = c || {};
  return invCount(o.inv || {}, 'shield') >= 1 || o.offhand === 'shield';
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
// Phase 3 (vécu V3Res4 en boucle no_table:unknown_item) : le raccourci « j'ai une pioche bois donc
// le bois est fait » est FAUX si la table est PERDUE (kick avant reclaim) et les planks épuisées —
// le craft 3×3 suivant exige une table → re-craft = 4 planks = 0 → échec éternel, le planner re-dérive
// toujours le même but car l'amont reste « met ». Le raccourci pioche n'est valable que si le bois
// aval est SÉCURISÉ : table en poche + sticks prêts.
const woodSafe = (c) => invCount(c.inv, 'crafting_table') >= 1 && invCount(c.inv, 'stick') >= 2;
// Pioche PIERRE craftable DIRECT (3 cobble + 2 sticks + table en poche) → PAS besoin de repasser par
// la pioche bois ni le bois de SURFACE. Casse le churn `no_pickaxe` → remontée surface (vécu run
// homedeath : pioche casse à Y16 → planner re-dérive wooden_pickaxe → bois → forêt → re-descente).
// Une pioche pierre ne requiert JAMAIS de bois → si les matériaux sont en poche, on va droit au craft.
const canStonePick = (c) => invCount(c.inv, 'cobblestone') >= 3 && invCount(c.inv, 'stick') >= 2 && invCount(c.inv, 'crafting_table') >= 1;
const MVP_CHAIN = [
  // ⚠️ logs/planks NE dépendent PAS de hasTable seul : une table qui traîne (run précédent) ne veut
  // pas dire qu'on a du bois. Seuil planches bas (≥2) + monotone via S final / (W ∧ woodSafe).
  { name: 'logs',          met: (c) => anyLog(c.inv) >= 3 || anyPlanks(c.inv) >= 2 || S(c) || (W(c) && woodSafe(c)),
    skill: 'gatherLog',    args: { count: 3 } },
  { name: 'planks',        met: (c) => anyPlanks(c.inv) >= 2 || S(c) || (W(c) && woodSafe(c)),
    skill: 'craftPlanks',  args: { count: 3 } }, // 3×4 = 12 planks (couvre table 4 + sticks 2 + pioche bois 3)
  { name: 'crafting_table',met: (c) => invCount(c.inv, 'crafting_table') >= 1 || S(c),
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
  // Raccourci pioche conditionné à woodSafe (table+sticks en poche) — cf. commentaire MVP_CHAIN
  // (boucle no_table:unknown_item quand la table est perdue ET les planks épuisées).
  { name: 'logs',           met: (c) => anyLog(c.inv) >= 5 || anyPlanks(c.inv) >= 8 || I(c) || (W(c) && woodSafe(c)) || canStonePick(c),
    skill: 'gatherLog',     args: { count: 6 } },
  { name: 'planks',         met: (c) => anyPlanks(c.inv) >= 8 || I(c) || (W(c) && woodSafe(c)) || canStonePick(c),
    skill: 'craftPlanks',   args: { count: 6 } }, // ~24 planks : table 4 + sticks 4 + pioche bois 3 + combustible + marge
  { name: 'crafting_table', met: (c) => invCount(c.inv, 'crafting_table') >= 1 || I(c),
    skill: 'craft',         args: { name: 'crafting_table', count: 1 } },
  { name: 'sticks',         met: (c) => invCount(c.inv, 'stick') >= 2 || I(c),
    skill: 'craft',         args: { name: 'stick', count: 2 } }, // 2×4 = 8 sticks (3 pioches × 2, reste ≥2)
  // no_pickaxe churn-breaker : si cobble+sticks+table en poche → pioche pierre craftable direct, on
  // saute la pioche bois (et donc le bois de surface). Sinon comportement inchangé.
  { name: 'wooden_pickaxe', met: (c) => W(c) || I(c) || canStonePick(c),
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
// CIBLE CONTINUE (Massii, live 26/07 : « il ne doivent pas s'arreter a seulement quelque diamant,
// ils doivent continuer a en prendre en continu »). Le predicat final valait `diamond >= 1` : le
// bot s'arretait au PREMIER diamant, objectif accompli.
const DIAMOND_TARGET = 64;                                  // une pile : « en continu » en pratique
const D = (c) => invCount(c.inv, 'diamond') >= 1;           // gating AMONT : un diamant prouve que
                                                            // bois/outils/four sont derriere nous
const DT = (c) => invCount(c.inv, 'diamond') >= DIAMOND_TARGET;   // vraie fin de l'objectif
function withFinal(goal, final) {
  return Object.assign({}, goal, { met: (c) => goal.met(c) || final(c) });
}
// ⚠️ `withFinal(g, D)` NE S'APPLIQUE PAS aux buts d'OUTIL. Un diamant en poche prouve qu'on a su
// fabriquer une pioche — pas qu'on en a encore une : ça CASSE. Vécu live 26/07 (Massii : « 4 et 5
// il creuse sans pioche ») : le bot croyait son outillage complet, descendait, ne pouvait plus
// rien miner, et `caveHunt` sortait sur `no_pick` sans rien émettre — panne invisible.
const _TOOL_GOALS = new Set(['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe']);
const DIAMOND_CHAIN = [
  ...IRON_CHAIN.map((g) => (_TOOL_GOALS.has(g.name) ? g : withFinal(g, D))),
  // 16 cobble = ~stack/2 : assez pour murer 2-3 nappes de lave + bridging. Monotone via D.
  { name: 'cobble_buffer', met: (c) => invCount(c.inv, 'cobblestone') >= 16 || DT(c),
    skill: 'gather',       args: { name: 'stone', count: 16 } },
  // Y cible -54 : juste au-dessus de la nappe de lave (Y=-55→-63, cf. spec). On accepte y<=-52
  // (marge de tolérance — l'escalier descend par paliers, on s'arrête dès qu'on franchit le seuil).
  { name: 'descend_y54',   met: (c) => (c.y !== undefined && c.y <= -52) || DT(c),
    skill: 'descendDiagonal', args: { targetY: -54 } },
  // CAVE-FIRST (Massii, live 26/07 : « les diamants il les allait chercher dans les cave = pas de
  // tunnel où ils creusent en continu, l'unique moment où ils creusent c'est quand ils passent
  // d'une cave a l'autre » + « cave first mais jamais celle inondée c'est important »).
  // Remplace un branch-mine de 48 blocs × 16 galeries — un tunnel continu, la stratégie inverse.
  // `caveHunt` ne cible que des minerais MAPPÉS, EXPOSÉS et SECS ; quand il n'en reste plus, le
  // dispatch enchaîne un tunnel COURT (le trajet vers la grotte suivante), jamais un strip.
  { name: 'diamond_caves', met: (c) => DT(c),
    skill: 'caveHunt',     args: { material: 'diamond', count: 8, targetY: -54 } },
];

// --- Chaînes ARMURE (run nether 2026-07-13) : T1 = armure FER complète auto-craftée (24 lingots),
// T2 = armure DIAMANT complète (24💎). RÈGLE ABSOLUE du run : ZÉRO /give — tout est miné/fondu/crafté.
// c.worn = pièces PORTÉES (slots 5-8, hors bot.inventory.items()) injecté par ctxExtra (index.js).
const ARMOR_SLOT_SUFFIXES = ['helmet', 'chestplate', 'leggings', 'boots'];
const ARMOR_UNITS = { helmet: 5, chestplate: 8, leggings: 7, boots: 4 }; // lingots OU diamants
const ARMOR_MAT_RANK = { leather: 1, golden: 2, chainmail: 2, iron: 3, diamond: 4, netherite: 5 };
const _matRank = (name) => ARMOR_MAT_RANK[String(name).split('_')[0]] || 0;

/** Unités (lingots/diamants) encore à crafter pour couvrir les 4 slots au rang minRank —
 *  une pièce en POCHE ou PORTÉE de rang ≥ minRank couvre son slot (monotone : jamais négatif). */
function armorNeed(c, minRank) {
  const have = Object.keys(c.inv || {}).filter((n) => (c.inv[n] || 0) > 0)
    .concat(Array.from(c.worn || []));
  let need = 0;
  for (const slot of ARMOR_SLOT_SUFFIXES) {
    const covered = have.some((n) => String(n).endsWith('_' + slot) && _matRank(n) >= minRank);
    if (!covered) need += ARMOR_UNITS[slot];
  }
  return need;
}

/** Les 4 slots sont-ils PORTÉS au rang ≥ minRank ? (l'équipement final — la poche ne suffit pas) */
function armorWornOk(c, minRank) {
  const worn = Array.from(c.worn || []);
  return ARMOR_SLOT_SUFFIXES.every((slot) =>
    worn.some((n) => String(n).endsWith('_' + slot) && _matRank(n) >= minRank));
}

// T1 — armure FER : chaîne fer complète (pioche fer = pouvoir miner vite + survie), puis fer
// d'armure au besoin RESTANT réel (armorNeed recalcule sur les pièces manquantes), puis craft
// pièce-par-pièce (skill ensureArmor : fond le brut + craft la moins chère + équipe — 1 pièce/appel,
// le planner re-boucle), puis ÉQUIPEMENT vérifié (porter ≠ avoir en poche).
const IA = (c) => armorNeed(c, 3) === 0;          // 4 slots couverts fer-ou-mieux (poche ou porté)
const IA_WORN = (c) => armorWornOk(c, 3);         // 4 slots PORTÉS fer-ou-mieux (DoD T1)
// Fer TOTAL encore requis : 3 lingots pioche (si manquante) + besoin d'armure RESTANT.
const ironTotal = (c) => invCount(c.inv, 'iron_ingot') + invCount(c.inv, 'raw_iron');
const ironNeedTotal = (c) => (invCount(c.inv, 'iron_pickaxe') >= 1 ? 0 : 3) + armorNeed(c, 3);
const ironOK = (c) => ironTotal(c) >= ironNeedTotal(c);
// Préfixe bois/pierre/four d'IRON_CHAIN — SANS ses buts fer (gather de surface). Vécu run nether
// (24 sessions mortes en death_loop) : le fer de SURFACE est introuvable (anneaux explore 240
// stériles) → roaming → noyades + mobs → morts en boucle. Le fer vient du BRANCH-MINING à Y16
// (strate fer classique, sous terre = à l'abri des mobs de nuit), comme le mode resource (#42).
// Buffer bâtons ×4 lots (16 sticks ≈ 8 pioches pierre de rechange) : le churn bois↔profondeur
// (vécu live : chaque casse d'outil → remontée → zone déforestée → roaming mortel) est le frein #1.
const _IRON_PREFIX = IRON_CHAIN.slice(0, IRON_CHAIN.findIndex((g) => g.name === 'iron_ore'))
  .map((g) => (g.name === 'sticks' ? Object.assign({}, g, { args: { name: 'stick', count: 4 } }) : g));
// Pré-stock pioches (fix n°3 mur de l'eau) : 3 pioches pierre AVANT de descendre — une casse ne
// force plus l'arrêt du minage (vécu homedeath cycle 6 : la pioche cassait pendant la descente PUIS
// re-cassait en minant, avant les ~27 fer d'iron_deep → smelt:0). Exigé EN SURFACE seulement
// (y>30) : sous terre, 1 pioche suffit (exiger 3 avec 0 stick forcerait une remontée bois avec 2
// pioches valides en poche = le churn qu'on tue). Les remontées bois re-stockent au passage (y>30).
const stonePicks = (c) => invCount(c.inv, 'stone_pickaxe');
const picksOK = (c) => stonePicks(c) >= 3 || invCount(c.inv, 'iron_pickaxe') >= 1 ||
  (c.y !== undefined && c.y <= 30 && stonePicks(c) >= 1);
// Combustible de fonte disponible, en « items fondables » (coal/charcoal = 8, planches/bûches = 1.5),
// vs lingots ENCORE à fondre pour l'armure (besoin restant - lingots déjà prêts). Fix n°4 water-wall.
const fuelUnits = (c) => (invCount(c.inv, 'coal') + invCount(c.inv, 'charcoal')) * 8 +
  (anyPlanks(c.inv) + anyLog(c.inv)) * 1.5;
const smeltNeed = (c) => Math.max(0, armorNeed(c, 3) - invCount(c.inv, 'iron_ingot'));
const IRON_ARMOR_CHAIN = [
  ..._IRON_PREFIX.map((g) => withFinal(g, IA)),
  { name: 'cobble_spare', met: (c) => invCount(c.inv, 'cobblestone') >= 6 || picksOK(c) || ironOK(c) || IA(c),
    skill: 'gather',      args: { name: 'stone', count: 6 } },
  { name: 'spare_picks',  met: (c) => picksOK(c) || ironOK(c) || IA(c),
    skill: 'craft',       args: { name: 'stone_pickaxe', count: 1 } },
  // NB : PAS de but food_stock BLOQUANT (vécu live : zone vidée de ses proies par les runs
  // précédents → no_prey ×16 → stall à vie en surface). La chasse est un HOOK best-effort borné
  // avant descendDiagonal (index.js) ; sous terre, une famine coûte une mort keepInventory
  // (respawn faim pleine, inventaire intact) — un stall coûte TOUT le run.
  // Réserve cobble pour murer la lave en branch-mine (le four a consommé les 8 du kit).
  { name: 'cobble_lava',  met: (c) => invCount(c.inv, 'cobblestone') >= 12 || ironOK(c) || IA(c),
    skill: 'gather',      args: { name: 'stone', count: 12 } },
  // Cycle 2 water-wall — BUFFER PLANCHES pré-descente (churn bois↔profondeur, frein #1) : table
  // perdue SOUS TERRE avec 0 planche/0 bûche → no_table:unknown_item ×∞ → but logs sous terre →
  // not_found → roaming mortel (vécu live NethBot1). Le but `planks` du préfixe est court-circuité
  // par I(c)/canStonePick dès qu'une pioche existe → on exige un buffer EN SURFACE (y>30) seulement.
  // STOCK GÉNÉREUX (pattern AltoClef, 16/07) : 8 équiv = un aller-retour bois PAR descente = LE
  // churn n°1 (2 jours de stagnation). 24 équiv (6 bûches, 1 expédition woodExpeditionCount) ≈ 3
  // descentes sans remontée. ironOK : le fer est déjà là → on ne bloque pas la fonte.
  { name: 'plank_buffer', met: (c) => (c.y !== undefined && c.y <= 30) ||
      (anyPlanks(c.inv) + anyLog(c.inv) * 4 >= 24) || ironOK(c) || IA(c),
    skill: 'gatherLog',   args: { count: 6 } },
  // ARME (analyse jeu humain 26/07) : la chaîne T1 n'en contenait AUCUNE — le bot menait ses
  // combats au POING (1 dégât, contre 5 pour une épée pierre) en difficulté hard. 2 cobble +
  // 1 bâton, c'est le meilleur rapport survie/coût du début de partie. `met` est
  // SATISFIABLE-OU-SAUTABLE (matière absente ⇒ considéré atteint) : jamais bloquant, et il se
  // déclenche seul dès que le cobble et les bâtons sont là.
  { name: 't1_sword',     met: (c) => hasSword(c.inv) || invCount(c.inv, 'cobblestone') < 2
                                       || invCount(c.inv, 'stick') < 1 || IA(c),
    skill: 'craft',       args: { name: 'stone_sword', count: 1 } },
  // HACHE (analyse jeu humain 26/07) : `logs` est le but le plus sollicité du run (2001 tentatives).
  // À la main une bûche prend ~3 s, à la hache pierre ~0,75 s — ×4 sur le poste n°1 du bot, pour
  // 3 cobble + 2 bâtons. Même patron non bloquant que l'épée.
  { name: 't1_axe',       met: (c) => hasAxe(c.inv) || invCount(c.inv, 'cobblestone') < 3
                                       || invCount(c.inv, 'stick') < 2 || IA(c),
    skill: 'craft',       args: { name: 'stone_axe', count: 1 } },
  // On ne descend pas les mains vides : sous terre, 8 blocs posables = un abri ou un couvert.
  // Cobble/stone d'abord (omniprésents en profondeur ET en surface rocheuse), terre ensuite
  // (drop sans outil). Re-vérifié à chaque tour du planner → le stock se recomplète tout seul
  // quand la fonte a brûlé les planches.
  { name: 'block_buffer', met: (c) => posableCount(c.inv) >= 8 || IA(c),
    skill: 'gather',      args: { name: ['cobblestone', 'stone', 'dirt', 'grass_block', 'gravel'], count: 8 } },
  { name: 'descend_y16',  met: (c) => (c.y !== undefined && c.y <= 18) || ironOK(c) || IA(c),
    skill: 'descendDiagonal', args: { targetY: 16 } },
  // serpentine:true (fix n°2 water-wall) : le mode serpentin TOURNE au contact de l'eau (+ scelle
  // le front) au lieu du couloir droit qui longeait la nappe → c'est le profil anti-eau prouvé du
  // pipeline diamant (resource). Rétro-compat : IRON_CHAIN (objectif pioche) reste en couloir.
  // allowDeeper (cycle 2) : un bot ramené SOUS la fenêtre [10,18] (water_rescue → /home safe à y=4)
  // bouclait wrong_depth à vie — le serpentin mine au niveau courant, on l'admet jusqu'à y=-59.
  { name: 'iron_deep',    met: (c) => ironOK(c) || IA(c),
    skill: 'branchMine',  args: { targetY: 16, mainLength: 48, branchSpacing: 3, branchLength: 8, serpentine: true, allowDeeper: true } },
  // 4 lingots, pas 3 : la pioche en consomme exactement 3 → il ne restait JAMAIS de quoi forger
  // un bouclier. Le 4e lingot est l'investissement de survie le moins cher du jeu (preuve live
  // 25/07 : les squelettes sont le tueur n°1 des bots nus).
  { name: 'iron_ingot',   met: (c) => invCount(c.inv, 'iron_ingot') >= 4 || invCount(c.inv, 'iron_pickaxe') >= 1 || IA(c),
    skill: 'smeltIron',   args: { count: 4 } },
  { name: 'iron_pickaxe', met: (c) => invCount(c.inv, 'iron_pickaxe') >= 1 || IA(c),
    skill: 'craft',       args: { name: 'iron_pickaxe', count: 1 } },
  // BOUCLIER — juste après la pioche, très loin AVANT l'armure (1 lingot contre 24). `met` est
  // volontairement SATISFIABLE-OU-SAUTABLE : sans lingot libre ou sans 6 planches le but est
  // considéré atteint → il ne peut jamais bloquer la chaîne, et il se déclenchera tout seul dès
  // que la matière sera là (le planner ré-évalue firstUnmet à chaque tour).
  { name: 'shield',       met: (c) => hasShield(c) || invCount(c.inv, 'iron_ingot') < 1 || anyPlanks(c.inv) < 6,
    skill: 'craft',       args: { name: 'shield', count: 1 } },
  // Fix n°4 water-wall — le DERNIER MÈTRE de T1 (vécu live NethBot3 : 85× armor_no_progress).
  // Un bot qui REPREND avec pioche fer + fer brut banké a tous les buts amont « met » via I(c) →
  // jamais de bois/four cette session → le smelt d'ensureArmor échoue en silence (0 combustible,
  // 0 four) → boucle à vie. On exige de quoi FONDRE le besoin restant avant iron_armor :
  // combustible (coal 8 items, planches/bûches 1.5) ≥ lingots à fondre, puis four (8 cobble + craft).
  // CHARBON SOUS TERRE (capture réelle Massitom2008 × alexdon1837, 26/07) : dans la vraie partie,
  // 65 charbons minés dans les 10 premières minutes — AVANT le fer — et 131/97 torches posées en
  // 33 min. Le charbon est à la fois le combustible (8 fontes contre 1,5 pour une bûche) et la
  // lumière. Or `armor_fuel` envoyait le bot couper du BOIS même à Y16 : il remontait à la surface
  // pour fondre, alors qu'il avait du charbon tout autour. C'était le churn bois↔profondeur à
  // l'état pur. En surface le but est sauté : là-haut, le bois EST le combustible naturel.
  { name: 't1_coal',       met: (c) => invCount(c.inv, 'coal') + invCount(c.inv, 'charcoal') >= 3
                                        || (c.y === undefined || c.y > 40)
                                        || fuelUnits(c) >= smeltNeed(c) || IA(c),
    skill: 'gather',       args: { name: ['coal_ore', 'deepslate_coal_ore'], count: 5 } },
  { name: 'armor_fuel',    met: (c) => fuelUnits(c) >= smeltNeed(c) || IA(c),
    skill: 'gatherLog',    args: { count: 4 } },
  { name: 'armor_cobble',  met: (c) => invCount(c.inv, 'cobblestone') >= 8 || F(c) || IA(c),
    skill: 'gather',       args: { name: 'stone', count: 8 } },
  { name: 'armor_furnace', met: (c) => F(c) || IA(c),
    skill: 'craft',        args: { name: 'furnace', count: 1 } },
  { name: 'iron_armor', met: IA, skill: 'ensureArmor', args: {} },
  { name: 'iron_armor_worn', met: IA_WORN, skill: 'ensureArmor', args: {} },
];

// T2 — armure DIAMANT : T1 d'abord (survie), puis descente/branch-mine jusqu'à avoir les 💎 du
// besoin RESTANT (les pièces déjà upgradées baissent le besoin), puis craft+équipe (jamais downgrade).
const diamondsOK = (c) => invCount(c.inv, 'diamond') >= armorNeed(c, 4);
const DA_WORN = (c) => armorWornOk(c, 4);
const DIAMOND_ARMOR_CHAIN = [
  ...IRON_ARMOR_CHAIN.map((g) => withFinal(g, DA_WORN)),
  { name: 'cobble_buffer',  met: (c) => invCount(c.inv, 'cobblestone') >= 16 || diamondsOK(c) || DA_WORN(c),
    skill: 'gather',        args: { name: 'stone', count: 16 } },
  { name: 'descend_y54',    met: (c) => (c.y !== undefined && c.y <= -52) || diamondsOK(c) || DA_WORN(c),
    skill: 'descendDiagonal', args: { targetY: -54 } },
  { name: 'diamonds_armor', met: (c) => diamondsOK(c) || DA_WORN(c),
    skill: 'branchMine',    args: { targetY: -54, mainLength: 48, branchSpacing: 3, branchLength: 8, serpentine: true } },
  { name: 'diamond_armor',  met: DA_WORN, skill: 'craftDiamondArmor', args: {} },
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

/** Sélectionne la chaîne de buts selon le type d'objectif (défaut : pioche pierre). */
// ─── ENTRAIDE (Massii, live 26/07) ──────────────────────────────────────────────────────────────
// « si ils ont finis il aident en priorité les autres bot et après il vont chercher les diamant ».
// Un bot qui a bouclé son armure faisait `clearObjective()` et restait INERTE (3 sur 5 à l'arrêt).
// Chaîne courte : descendre, miner, fondre jusqu'à un stock cédable. Quand il DONNE ses lingots,
// `iron_surplus` redevient non satisfait → il repart miner : la boucle produire-donner s'entretient
// toute seule, sans état supplémentaire à maintenir.
const HELP_STOCK = 8;   // 8 lingots ≈ une pièce d'armure entière pour le coéquipier

// Une pioche capable de MINER LE FER (stone+). Les chaînes d'entraide minent du fer : une pioche
// BOIS (tier 1) ne casse pas le minerai de fer → elle ne compte pas ici.
const canMineIron = (c) => invCount(c.inv, 'stone_pickaxe') >= 1 || invCount(c.inv, 'iron_pickaxe') >= 1
  || invCount(c.inv, 'diamond_pickaxe') >= 1 || invCount(c.inv, 'netherite_pickaxe') >= 1;

// ⚠️ PIÈGE (world_mn8, 27/07) — IRON_HELP_CHAIN et MAPPER_ARMOR_CHAIN démarraient sur
// descend_y16 → iron_deep (branchMine) SANS AUCUN but pioche (contrairement à IRON_ARMOR_CHAIN qui
// a spare_picks). Un bot 4/4 dont la pioche casse (ou qui respawn sans) n'avait donc AUCUN moyen,
// côté planner, de la reconstruire : il bouclait iron_deep → no_pickaxe à l'infini (mesuré : une
// session NethBot3 en iron_help = 96 no_pickaxe / 106 pickaxe_missing / 0 recraft) → 0 livraison
// d'entraide → armure de la flotte figée des heures. On préfixe donc une reconstitution ROBUSTE
// (skill `ensurePick` → recoverPickaxe : expédition bois + bootstrap bois→pierre, déjà éprouvée par
// mineForType). Le but est SATISFIABLE-OU-SAUTABLE : franchi dès qu'une pioche fer-capable est là
// OU que le fer déjà en poche suffit (plus rien à miner) → le chemin nominal reste inchangé.
const IRON_HELP_CHAIN = [
  { name: 'help_pick',     met: (c) => canMineIron(c)
      || (invCount(c.inv, 'raw_iron') + invCount(c.inv, 'iron_ingot')) >= HELP_STOCK,
    skill: 'ensurePick' },
  { name: 'descend_y16',   met: (c) => (c.y !== undefined && c.y <= 18) || invCount(c.inv, 'iron_ingot') >= HELP_STOCK,
    skill: 'descendDiagonal', args: { targetY: 16 } },
  { name: 'iron_deep',     met: (c) => invCount(c.inv, 'raw_iron') + invCount(c.inv, 'iron_ingot') >= HELP_STOCK,
    skill: 'branchMine',   args: { targetY: 16, mainLength: 48, branchSpacing: 3, branchLength: 8, serpentine: true, allowDeeper: true } },
  // COMBUSTIBLE avant la fonte (fix veille 27/07) : la chaine d'entraide n'avait AUCUN but
  // combustible avant smeltIron → un bot 4/4 qui descend miner du surplus bouclait
  // `smeltIron → no_fuel` A L'INFINI (32 no_fuel/session mesures, 88 sur la flotte). Mirror
  // exact du main chain t1_coal/armor_fuel : charbon sous terre (le fer est a Y16, le charbon
  // aussi), repli buches. Satisfiable-ou-sautable : jamais bloquant, se declenche seul.
  { name: 'help_coal',     met: (c) => fuelUnits(c) >= HELP_STOCK || invCount(c.inv, 'iron_ingot') >= HELP_STOCK
                                       || (c.y === undefined || c.y > 40),
    skill: 'gather',       args: { name: ['coal_ore', 'deepslate_coal_ore'], count: 4 } },
  { name: 'help_fuel',     met: (c) => fuelUnits(c) >= HELP_STOCK || invCount(c.inv, 'iron_ingot') >= HELP_STOCK,
    skill: 'gatherLog',    args: { count: 3 } },
  { name: 'iron_surplus',  met: (c) => invCount(c.inv, 'iron_ingot') >= HELP_STOCK,
    skill: 'smeltIron',    args: { count: HELP_STOCK } },
];

// ─── ARMURER LES CARTOGRAPHES (Massii, 26/07) ───────────────────────────────────────────────────
// « il faut que les bots ressources se coordonnent pour préparer une armure pour chacun et après
// il se tp au mappeur pour lui donner, comme ça les mappeurs continuent sans jamais s'arrêter ».
//
// Un mappeur ne mine pas : il meurt nu, donc il n'ose pas s'éloigner, donc il cartographie peu.
// L'habiller est le levier le plus rentable sur la portée de la carte — d'où sa place AVANT le
// diamant dans l'enchaînement.
//
// La chaîne est entièrement gouvernée par `c.mapperTarget` (le cartographe qu'on a RÉSERVÉ) :
// s'il n'y en a aucun à équiper, TOUS les buts sont satisfaits d'office et la chaîne se termine
// immédiatement — nextObjectiveAfter enchaîne alors sur le diamant. Pas d'état à maintenir.
// On livre des PIÈCES FORGÉES, pas des lingots : un mappeur n'a ni four ni table de craft.
const GIFT_SET_INGOTS = 24;   // 5 (casque) + 8 (plastron) + 7 (jambières) + 4 (bottes)

const MAPPER_ARMOR_CHAIN = [
  // Même garde pioche que IRON_HELP_CHAIN (piège world_mn8 27/07) : sans lui, un worker chargé
  // d'armer un cartographe bouclait iron_deep → no_pickaxe. Sautable si pas de cible, si une pioche
  // fer-capable est là, ou si le fer en poche suffit déjà pour le set (plus rien à miner).
  { name: 'gift_pick',    met: (c) => !c.mapperTarget || canMineIron(c)
      || (invCount(c.inv, 'raw_iron') + invCount(c.inv, 'iron_ingot')) >= GIFT_SET_INGOTS,
    skill: 'ensurePick' },
  { name: 'gift_descend', met: (c) => !c.mapperTarget
      || (c.y !== undefined && c.y <= 18) || invCount(c.inv, 'iron_ingot') >= GIFT_SET_INGOTS,
    skill: 'descendDiagonal', args: { targetY: 16 } },
  { name: 'gift_iron',    met: (c) => !c.mapperTarget
      || invCount(c.inv, 'raw_iron') + invCount(c.inv, 'iron_ingot') >= GIFT_SET_INGOTS,
    skill: 'branchMine',   args: { targetY: 16, mainLength: 48, branchSpacing: 3, branchLength: 8, serpentine: true, allowDeeper: true } },
  // COMBUSTIBLE avant la fonte (fix veille 27/07, meme cause que iron_surplus) : sans but
  // combustible, gift_smelt bouclait no_fuel sous terre. On mine le charbon de la strate fer.
  { name: 'gift_coal',    met: (c) => !c.mapperTarget || fuelUnits(c) >= GIFT_SET_INGOTS
                                       || invCount(c.inv, 'iron_ingot') >= GIFT_SET_INGOTS
                                       || (c.y === undefined || c.y > 40),
    skill: 'gather',       args: { name: ['coal_ore', 'deepslate_coal_ore'], count: 4 } },
  { name: 'gift_fuel',    met: (c) => !c.mapperTarget || fuelUnits(c) >= GIFT_SET_INGOTS
                                       || invCount(c.inv, 'iron_ingot') >= GIFT_SET_INGOTS,
    skill: 'gatherLog',    args: { count: 4 } },
  { name: 'gift_smelt',   met: (c) => !c.mapperTarget || invCount(c.inv, 'iron_ingot') >= GIFT_SET_INGOTS,
    skill: 'smeltIron',    args: { count: GIFT_SET_INGOTS } },
  // Forge les 4 pièces EN POCHE (le worker porte déjà les siennes : les slots d'armure ne sont
  // pas dans inventory.items(), une pièce en poche est donc bien du surplus livrable).
  { name: 'gift_craft',   met: (c) => !c.mapperTarget || !!c.giftReady,
    skill: 'craftGiftSet' },
  // /tpa VERS le mappeur (jamais l'inverse : il ne doit pas s'arrêter), puis remise en main propre.
  // Satisfait quand plus aucun mappeur n'attend — c'est la livraison elle-même qui l'obtient.
  { name: 'gift_deliver', met: (c) => !c.mapperTarget,
    skill: 'deliverMapperArmor' },
];

/**
 * Objectif à enchaîner quand `objective` vient d'être atteint. (pur)
 * Ne renvoie JAMAIS l'inertie tant qu'il reste quelque chose d'utile à faire.
 * `mates` = presence.list() — on lit `status.need` (lingots manquants) de chaque coéquipier.
 */
function nextObjectiveAfter(objective, mates) {
  // ⚠️ presence.beat() APLATIT le statut dans l'entrée ({x,z,role,at,armor,ingots,need}) : il n'y
  // a pas de sous-objet `status`. On lisait `m.status.need`, donc TOUJOURS undefined — la branche
  // `iron_help` ne s'est jamais déclenchée depuis son ajout. On lit le champ plat, en tolérant
  // l'ancienne forme au cas où un bot d'une version antérieure alimente encore le fichier.
  const needOf = (m) => Number((m && (m.need !== undefined ? m.need : (m.status && m.status.need))) || 0);
  const needy = (mates || []).some((m) => m && m.role !== 'mapper' && needOf(m) > 0);
  // Cartographes encore nus : ils ne minent pas, donc ils ne s'équipent jamais seuls. Un mappeur
  // qui survit cartographie plus loin — d'où la priorité de Massii (26/07) : les habiller AVANT
  // de partir au diamant. Statut inconnu = considéré nu (on n'abandonne pas sur une supposition).
  const mappersNaked = (mates || []).some((m) => m && m.role === 'mapper' && (m.armor || 0) < 4);
  if (objective === 'iron_armor' || objective === 'iron_help') {
    if (needy) return 'iron_help';
    return mappersNaked ? 'mapper_armor' : 'diamond';
  }
  // Un set livré ne couvre qu'UN mappeur : tant qu'il en reste un nu, on en reforge un autre.
  if (objective === 'mapper_armor') return mappersNaked ? 'mapper_armor' : 'diamond';
  // Le diamant ne se « termine » plus : atteindre la cible relance la chasse (demande explicite
  // « en continu »). Un bot qui a fini son armure n'a de toute facon rien de mieux a faire.
  if (objective === 'diamond') return 'diamond';
  return null;
}

// PIÈGE #61 — un Set d'objectifs incomplet tue une fonctionnalité en silence. Le TIMER ARMURE
// opportuniste (index.js, `_ARMOR_TIMER_OBJ`) forge/équipe une pièce manquante toutes les 90 s dès
// que le fer dépasse le buffer, INDÉPENDAMMENT du planner (le but `iron_armor` de la chaîne est
// gaté derrière ~27 fer via `ironOK` → un worker qui n'y arrive jamais ne forgeait sinon RIEN).
// Or ce Set ne listait que resource/diamond/mapper : l'objectif `iron_armor` (mode par défaut de la
// flotte) et `diamond_armor` en étaient ABSENTS → un worker accumulant 6-10 lingots sans jamais
// atteindre le but de chaîne ne forgeait JAMAIS la pièce qu'il pouvait pourtant s'offrir → armure
// figée des heures. Le timer de FONTE juste en dessous, lui, incluait bien iron_armor/diamond_armor
// (d'où des lingots qui s'accumulaient… et dormaient). Source unique, testée, importée par index.js.
const ARMOR_FORGE_OBJECTIVES = new Set(['resource', 'diamond', 'mapper', 'iron_armor', 'diamond_armor']);
function wantsOpportunisticArmor(objType) {
  return ARMOR_FORGE_OBJECTIVES.has(objType);
}

function chainFor(objective) {
  if (objective === 'diamond') return DIAMOND_CHAIN;
  if (objective === 'iron_help') return IRON_HELP_CHAIN;
  if (objective === 'mapper_armor') return MAPPER_ARMOR_CHAIN;
  if (objective === 'iron_pickaxe') return IRON_CHAIN;
  if (objective === 'iron_armor') return IRON_ARMOR_CHAIN;
  if (objective === 'diamond_armor') return DIAMOND_ARMOR_CHAIN;
  if (objective === 'mapper') return MAPPER_KIT;
  return MVP_CHAIN;
}

/** Premier but non satisfait dans l'ordre, ou null si tout est fait. */
function firstUnmet(chain, ctx) {
  for (const g of chain) { if (!g.met(ctx)) return g; }
  return null;
}

module.exports = {
  nextObjectiveAfter, IRON_HELP_CHAIN, HELP_STOCK, MAPPER_ARMOR_CHAIN, GIFT_SET_INGOTS, DIAMOND_TARGET, hasShield, posableCount, hasSword, hasAxe, buildCtxInv, invCount, anyLog, anyPlanks, cookedCount, COOKED_FOODS, MVP_CHAIN, IRON_CHAIN, DIAMOND_CHAIN, IRON_ARMOR_CHAIN, DIAMOND_ARMOR_CHAIN, MAPPER_KIT, chainFor, firstUnmet, armorNeed, armorWornOk, wantsOpportunisticArmor, ARMOR_FORGE_OBJECTIVES };
