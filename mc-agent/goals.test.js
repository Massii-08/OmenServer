'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { invCount, buildCtxInv, MVP_CHAIN, IRON_CHAIN, DIAMOND_CHAIN, chainFor, firstUnmet } = require('./goals');

// Faux bot : inventaire = liste d'items {name, count}
function fakeBot(items) {
  return { inventory: { items: () => items.map((i) => ({ name: i[0], count: i[1] })) } };
}

test('invCount somme les piles du meme item', () => {
  const bot = fakeBot([['oak_planks', 4], ['oak_planks', 3], ['stick', 2]]);
  const inv = buildCtxInv(bot);
  assert.strictEqual(invCount(inv, 'oak_planks'), 7);
  assert.strictEqual(invCount(inv, 'stick'), 2);
  assert.strictEqual(invCount(inv, 'cobblestone'), 0);
});

test('firstUnmet renvoie le 1er but non satisfait dans l\'ordre', () => {
  // inventaire vide -> 1er but = recolter du bois
  let ctx = { inv: {}, hasTable: false };
  assert.strictEqual(firstUnmet(MVP_CHAIN, ctx).name, 'logs');

  // a deja 3 logs -> but suivant = planks
  ctx = { inv: { oak_log: 3 }, hasTable: false };
  assert.strictEqual(firstUnmet(MVP_CHAIN, ctx).name, 'planks');

  // objectif atteint (a une pioche pierre) -> firstUnmet = null
  ctx = { inv: { stone_pickaxe: 1 }, hasTable: true };
  assert.strictEqual(firstUnmet(MVP_CHAIN, ctx), null);
});

test('la chaine MVP ne contient plus de but place_table', () => {
  assert.ok(!MVP_CHAIN.some((g) => g.name === 'place_table'));
});

test('ordre exact de la chaine MVP (7 buts)', () => {
  assert.deepStrictEqual(
    MVP_CHAIN.map((g) => g.name),
    ['logs', 'planks', 'crafting_table', 'sticks', 'wooden_pickaxe', 'cobblestone', 'stone_pickaxe'],
  );
});

test('a une table en inventaire (pas posee) -> but suivant = sticks', () => {
  // crafting_table dans l\'inv suffit (portable) ; hasTable est ignore
  const ctx = { inv: { oak_planks: 12, crafting_table: 1 }, hasTable: false };
  assert.strictEqual(firstUnmet(MVP_CHAIN, ctx).name, 'sticks');
});

test('a table + planks + sticks -> but suivant = wooden_pickaxe', () => {
  const ctx = { inv: { crafting_table: 1, oak_planks: 6, stick: 4 }, hasTable: false };
  assert.strictEqual(firstUnmet(MVP_CHAIN, ctx).name, 'wooden_pickaxe');
});

// --- Chaîne FER ---

test('chainFor selectionne MVP (pierre) ou IRON selon l\'objectif', () => {
  assert.strictEqual(chainFor('iron_pickaxe'), IRON_CHAIN);
  assert.strictEqual(chainFor('stone_pickaxe'), MVP_CHAIN);
  assert.strictEqual(chainFor(undefined), MVP_CHAIN);  // défaut
});

test('ordre exact de la chaine FER (12 buts, cobble scindé pick/four)', () => {
  assert.deepStrictEqual(
    IRON_CHAIN.map((g) => g.name),
    ['logs', 'planks', 'crafting_table', 'sticks', 'wooden_pickaxe',
     'cobble_pick', 'stone_pickaxe', 'cobble_furnace', 'furnace',
     'iron_ore', 'iron_ingot', 'iron_pickaxe'],
  );
});

test('IRON firstUnmet : vide -> logs ; pioche fer -> null (tout fait)', () => {
  assert.strictEqual(firstUnmet(IRON_CHAIN, { inv: {} }).name, 'logs');
  assert.strictEqual(firstUnmet(IRON_CHAIN, { inv: { iron_pickaxe: 1 } }), null);
});

test('IRON firstUnmet : a four + 3 raw_iron (pioches+sticks) -> iron_ingot (smelt)', () => {
  // état réaliste mi-chaîne : pioches bois+pierre, four en poche, sticks restants, minerai miné
  const ctx = { inv: { wooden_pickaxe: 1, stone_pickaxe: 1, furnace: 1, stick: 4, raw_iron: 3, crafting_table: 1 } };
  assert.strictEqual(firstUnmet(IRON_CHAIN, ctx).name, 'iron_ingot');
});

test('IRON firstUnmet : lingots fondus -> iron_pickaxe (dernier but)', () => {
  const ctx = { inv: { wooden_pickaxe: 1, stone_pickaxe: 1, furnace: 1, stick: 4, iron_ingot: 3, crafting_table: 1 } };
  assert.strictEqual(firstUnmet(IRON_CHAIN, ctx).name, 'iron_pickaxe');
});

test('phase3 : table PERDUE + planks épuisées (pioche bois en poche) → la chaîne ré-ouvre le BOIS', () => {
  // vécu V3Res4 : kick avant reclaim → table envolée, 0 planks → le craft 3×3 suivant échouait
  // en boucle (no_table:unknown_item) car logs/planks restaient « met » via la pioche bois.
  const ctx = { inv: { wooden_pickaxe: 1, stick: 4, cobblestone: 3 } };
  assert.strictEqual(firstUnmet(IRON_CHAIN, ctx).name, 'logs');
  const ctx2 = { inv: { wooden_pickaxe: 1, stick: 4, cobblestone: 3 } };
  assert.strictEqual(firstUnmet(MVP_CHAIN, ctx2).name, 'logs');
  // table en poche + sticks → le raccourci pioche redevient valable (pas de re-récolte)
  const ctx3 = { inv: { wooden_pickaxe: 1, stick: 4, cobblestone: 3, crafting_table: 1 } };
  assert.notStrictEqual(firstUnmet(IRON_CHAIN, ctx3).name, 'logs');
});

test('IRON cobble scindé : 3 cobble + pioche pierre -> cobble_furnace (pas re-pick)', () => {
  // après la pioche pierre (S), cobble_pick est gaté par S ; il reste à gather les 8 du four
  const ctx = { inv: { wooden_pickaxe: 1, stone_pickaxe: 1, stick: 4, crafting_table: 1 } };
  assert.strictEqual(firstUnmet(IRON_CHAIN, ctx).name, 'cobble_furnace');
});

// --- Chaîne DIAMANT ---

test('chainFor("diamond") selectionne DIAMOND_CHAIN', () => {
  assert.strictEqual(chainFor('diamond'), DIAMOND_CHAIN);
});

test('DIAMOND_CHAIN contient les 12 buts IRON + 3 buts diamant en queue', () => {
  const names = DIAMOND_CHAIN.map((g) => g.name);
  assert.deepStrictEqual(
    names,
    ['logs', 'planks', 'crafting_table', 'sticks', 'wooden_pickaxe',
     'cobble_pick', 'stone_pickaxe', 'cobble_furnace', 'furnace',
     'iron_ore', 'iron_ingot', 'iron_pickaxe',
     'cobble_buffer', 'descend_y54', 'branch_mine'],
  );
});

test('DIAMOND firstUnmet : inventaire vide -> logs (1er but)', () => {
  assert.strictEqual(firstUnmet(DIAMOND_CHAIN, { inv: {} }).name, 'logs');
});

test('DIAMOND firstUnmet : pioche fer obtenue -> cobble_buffer (16 cobble pour murage)', () => {
  const ctx = { inv: { iron_pickaxe: 1, stick: 4 }, y: 64 };
  assert.strictEqual(firstUnmet(DIAMOND_CHAIN, ctx).name, 'cobble_buffer');
});

test('DIAMOND firstUnmet : pioche fer + 16 cobble + Y=64 -> descend_y54', () => {
  const ctx = { inv: { iron_pickaxe: 1, cobblestone: 16, stick: 4 }, y: 64 };
  assert.strictEqual(firstUnmet(DIAMOND_CHAIN, ctx).name, 'descend_y54');
});

test('DIAMOND firstUnmet : Y atteint -54, pioche fer, cobble -> branch_mine', () => {
  const ctx = { inv: { iron_pickaxe: 1, cobblestone: 16, stick: 4 }, y: -54 };
  assert.strictEqual(firstUnmet(DIAMOND_CHAIN, ctx).name, 'branch_mine');
});

test('DIAMOND firstUnmet : diamant obtenu -> null (objectif atteint)', () => {
  // ⚠️ monotonie : tout l'amont doit redevenir "satisfait" via le gating |D
  const ctx = { inv: { diamond: 1 }, y: -54 };
  assert.strictEqual(firstUnmet(DIAMOND_CHAIN, ctx), null);
});

test('DIAMOND monotonie : diamond:1 satisfait TOUS les buts amont (même si ressources consommées)', () => {
  // Cas réaliste : on a miné un diamant, les cobble/iron/sticks/planks/logs ont été consommés.
  // Aucun but ne doit redevenir "non satisfait" → firstUnmet = null.
  const ctx = { inv: { diamond: 1 }, y: -54 };
  for (const goal of DIAMOND_CHAIN) {
    assert.ok(goal.met(ctx), `but "${goal.name}" devrait etre satisfait quand diamond:1`);
  }
});

test('DIAMOND descend_y54 : met=false si y=64, true si y<=-52, true si diamond:1', () => {
  const goal = DIAMOND_CHAIN.find((g) => g.name === 'descend_y54');
  assert.strictEqual(goal.met({ inv: {}, y: 64 }), false);
  assert.strictEqual(goal.met({ inv: {}, y: -52 }), true);
  assert.strictEqual(goal.met({ inv: {}, y: -54 }), true);
  assert.strictEqual(goal.met({ inv: { diamond: 1 }, y: 64 }), true);
});

test('DIAMOND cobble_buffer : met=true si cobble>=16 OU diamond:1', () => {
  const goal = DIAMOND_CHAIN.find((g) => g.name === 'cobble_buffer');
  assert.strictEqual(goal.met({ inv: { cobblestone: 15 } }), false);
  assert.strictEqual(goal.met({ inv: { cobblestone: 16 } }), true);
  assert.strictEqual(goal.met({ inv: { diamond: 1 } }), true);
});

test('DIAMOND : le but iron_pickaxe N\'est PLUS le dernier (le diamant l\'est)', () => {
  const names = DIAMOND_CHAIN.map((g) => g.name);
  assert.notStrictEqual(names[names.length - 1], 'iron_pickaxe');
  assert.strictEqual(names[names.length - 1], 'branch_mine');
});

// --- Chaîne MAPPER_KIT (kit de survie du cartographe : outils pierre + four + torches + nourriture) ---

const { MAPPER_KIT } = require('./goals');

test('chainFor(mapper) renvoie MAPPER_KIT', () => {
  assert.strictEqual(chainFor('mapper'), MAPPER_KIT);
});

test('MAPPER_KIT : inventaire vide -> 1er but = logs', () => {
  assert.strictEqual(firstUnmet(MAPPER_KIT, { inv: {} }).name, 'logs');
});

test('MAPPER_KIT régression deadlock MapT2 : court en sticks ET en planches -> re-dérive vers logs (pas de stall)', () => {
  // état live exact du stall : pioche bois + 2 sticks + 1 planche + 1 bûche + table
  const ctx = { inv: { wooden_pickaxe: 1, stick: 2, jungle_planks: 1, jungle_log: 1, crafting_table: 1 } };
  const first = firstUnmet(MAPPER_KIT, ctx);
  assert.strictEqual(first.name, 'logs', 'le kit doit pouvoir RE-récolter du bois quand il en manque');
});

// --- Extension SURVIE du kit mapper (hache + four + nourriture cuite + torches) ---

test('MAPPER_KIT étendu : ordre complet — NOURRITURE avant torches (vécu Surv8 : le stall charbon bloquait la cuisson)', () => {
  assert.deepStrictEqual(
    MAPPER_KIT.map((g) => g.name),
    ['logs', 'planks', 'crafting_table', 'sticks', 'wooden_pickaxe',
     'cobble_pick', 'stone_pickaxe', 'cobble_sword', 'stone_sword',
     'cobble_axe', 'stone_axe', 'cobble_furnace', 'furnace',
     'food_stock', 'charcoal', 'torches'],
  );
});

test('MAPPER_KIT : kit pierre fait -> but suivant = cobble_axe (la hache vient après l\'épée)', () => {
  const ctx = { inv: { stone_pickaxe: 1, stone_sword: 1, crafting_table: 1, stick: 4 } };
  assert.strictEqual(firstUnmet(MAPPER_KIT, ctx).name, 'cobble_axe');
});

test('MAPPER_KIT : kit COMPLET (outils+four+torches+nourriture) -> firstUnmet null', () => {
  const ctx = { inv: {
    stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, crafting_table: 1, furnace: 1,
    torch: 8, cooked_beef: 4, stick: 2,
  } };
  assert.strictEqual(firstUnmet(MAPPER_KIT, ctx), null);
});

test('MAPPER_KIT MAINTENANCE : nourriture mangée -> food_stock redevient le but (re-chasse)', () => {
  const full = { inv: { stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, crafting_table: 1, furnace: 1, torch: 8, cooked_beef: 4, stick: 2 } };
  assert.strictEqual(firstUnmet(MAPPER_KIT, full), null);
  const hungry = { inv: { ...full.inv, cooked_beef: 1 } };       // stock tombé à 1
  assert.strictEqual(firstUnmet(MAPPER_KIT, hungry).name, 'food_stock');
});

test('MAPPER_KIT : food_stock accepte toute nourriture CUITE (somme), pas le cru', () => {
  const g = MAPPER_KIT.find((x) => x.name === 'food_stock');
  const base = { stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, crafting_table: 1, furnace: 1, torch: 8, stick: 2 };
  assert.ok(g.met({ inv: { ...base, cooked_porkchop: 2, cooked_chicken: 2 } }));
  assert.ok(g.met({ inv: { ...base, bread: 4 } }));
  assert.ok(!g.met({ inv: { ...base, beef: 6 } }));              // cru ≠ stock
});

test('MAPPER_KIT : torches via charbon de bois — charcoal met si coal OU charcoal >= 2, torches >= 8', () => {
  const gc = MAPPER_KIT.find((x) => x.name === 'charcoal');
  assert.ok(gc.met({ inv: { charcoal: 2 } }));
  assert.ok(gc.met({ inv: { coal: 2 } }));
  assert.ok(gc.met({ inv: { torch: 8 } }));                      // torches déjà faites → étape passée
  assert.ok(!gc.met({ inv: { charcoal: 1 } }));
  const gt = MAPPER_KIT.find((x) => x.name === 'torches');
  assert.ok(gt.met({ inv: { torch: 8 } }));
  assert.ok(!gt.met({ inv: { torch: 7 } }));
});

test('MAPPER_KIT : sticks adaptatifs — la hache/torches comptent dans le besoin restant', () => {
  const g = MAPPER_KIT.find((x) => x.name === 'sticks');
  // pioche+épée faites, hache PAS faite, torches PAS faites → besoin 2 (hache) + 2 (torches) = 4
  assert.ok(!g.met({ inv: { stone_pickaxe: 1, stone_sword: 1, stick: 3 } }));
  assert.ok(g.met({ inv: { stone_pickaxe: 1, stone_sword: 1, stick: 4 } }));
  // tout fait sauf torches → besoin 2
  assert.ok(g.met({ inv: { stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, stick: 2 } }));
  // TOUT fait → 0 stick requis
  assert.ok(g.met({ inv: { stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, torch: 8, cooked_beef: 4, furnace: 1, crafting_table: 1 } }));
});

test('MAPPER_KIT régression Surv3 : 3 planches SANS table -> re-dérive vers le bois (pas crafting_table qui boucle)', () => {
  // vécu live : table = 4 planches ; avec 3 le craft échouait en boucle (no_recipe → no_table ×9).
  // attendu : le planner repart chercher du bois (logs car 0 bûche) au lieu de marteler le craft.
  const ctx = { inv: { wooden_pickaxe: 1, stick: 8, oak_planks: 3 } };
  assert.strictEqual(firstUnmet(MAPPER_KIT, ctx).name, 'logs');
  // avec des bûches en poche : logs met → c'est planks qui re-craft
  const ctx2 = { inv: { wooden_pickaxe: 1, stick: 8, oak_planks: 3, oak_log: 3 } };
  assert.strictEqual(firstUnmet(MAPPER_KIT, ctx2).name, 'planks');
});

test('MAPPER_KIT planksNeed : couvre table(4) + pioche bois(3) + sticks manquants (arrondi par lot de 4)', () => {
  const g = MAPPER_KIT.find((x) => x.name === 'planks');
  // rien : table 4 + pioche 3 + sticks 8 manquants → 2 lots × 2 planches = 4 → besoin 11 (>8 cap? non capé)
  assert.ok(!g.met({ inv: { oak_planks: 8 } }), '8 planches ne couvrent pas tout le départ');
  // table + pioche bois faites, sticks pleins → besoin 0 → met même sans planche
  assert.ok(g.met({ inv: { wooden_pickaxe: 1, crafting_table: 1, stick: 8 } }));
  // table faite, pioche faite, 0 stick (besoin 7 sticks → 2 lots → 4 planches)
  assert.ok(!g.met({ inv: { wooden_pickaxe: 1, crafting_table: 1, oak_planks: 3 } }));
  assert.ok(g.met({ inv: { wooden_pickaxe: 1, crafting_table: 1, oak_planks: 4 } }));
});

// ─── BOUCLIER (preuve live world_ax4 25/07) ───────────────────────────────────
// « NethBot2 was shot by Skeleton » ×8 en 4 min. Le bouclier NÉGLIGE le coup (≠ armure qui le
// réduit) pour 1 lingot + 6 planches — contre 24 lingots pour un set complet. Le code savait
// déjà l'équiper/le lever (onDefensive/onRanged) ; RIEN ne le craftait.

const { hasShield } = require('./goals');

function armorChain() { return chainFor('iron_armor'); }
function goalNamed(name) { return armorChain().find((g) => g.name === name); }

test('bouclier : la chaîne armure contient un but shield AVANT l\'armure', () => {
  const names = armorChain().map((g) => g.name);
  assert.ok(names.includes('shield'), 'but shield absent de la chaîne');
  assert.ok(names.indexOf('shield') < names.indexOf('iron_armor'),
    'le bouclier doit précéder l\'armure (1 lingot vs 24)');
});

test('bouclier : la fonte vise 4 lingots (3 pour la pioche + 1 pour le bouclier)', () => {
  const g = goalNamed('iron_ingot');
  assert.equal(g.args.count, 4, 'avec 3 la pioche consommait tout, jamais de lingot libre');
});

test('hasShield voit le bouclier EN POCHE', () => {
  assert.equal(hasShield({ inv: { shield: 1 } }), true);
});

test('hasShield voit le bouclier ÉQUIPÉ en main secondaire (piège slot 45)', () => {
  // inventory.items() n'expose NI l'armure (5-8) NI la main secondaire (45) → sans ce champ le
  // bot re-crafterait un bouclier à l'infini juste après l'avoir équipé.
  assert.equal(hasShield({ inv: {}, offhand: 'shield' }), true);
});

test('hasShield : rien en poche ni en main → false', () => {
  assert.equal(hasShield({ inv: { iron_ingot: 4 } }), false);
  assert.equal(hasShield({ inv: {}, offhand: 'torch' }), false);
  assert.equal(hasShield({}), false);
});

test('but shield : SATISFAIT quand on l\'a déjà (pas de re-craft)', () => {
  assert.equal(goalNamed('shield').met({ inv: { iron_ingot: 4, oak_planks: 20 }, offhand: 'shield' }), true);
});

test('but shield : SATISFAIT (= sauté) si aucun lingot libre — jamais de blocage', () => {
  assert.equal(goalNamed('shield').met({ inv: { oak_planks: 20 } }), true);
});

test('but shield : SATISFAIT (= sauté) si moins de 6 planches — jamais de blocage', () => {
  assert.equal(goalNamed('shield').met({ inv: { iron_ingot: 4, oak_planks: 5 } }), true);
});

test('but shield : NON satisfait quand lingot + planches sont là → on le craft', () => {
  assert.equal(goalNamed('shield').met({ inv: { iron_ingot: 1, oak_planks: 6 } }), false);
});

// ─── BUFFER DE BLOCS POSABLES (mesure live world_ax4, 25/07) ──────────────────
// Les deux protections livrées ce soir — se mettre à COUVERT d'un tireur et se MURER quand
// creuser échoue — posent des blocs. Sans blocs, elles sont inopérantes : 12 abris avortés et
// 12 couverts en `placed:0`. Et la fonte d'amorçage BRÛLE les planches (combustible), donc la
// poche se vide précisément quand la survie en a besoin. Le buffer existait (dirt.js) mais
// n'était câblé que pour les cartographes.
const { posableCount } = require('./goals');

test('posableCount compte les blocs POSABLES (terre, cobble, gravier…)', () => {
  assert.strictEqual(posableCount({ cobblestone: 5, dirt: 3, diamond: 9 }), 8);
  assert.strictEqual(posableCount({ oak_planks: 20 }), 20, 'les planches se posent aussi');
  assert.strictEqual(posableCount({ iron_ingot: 4 }), 0, 'un lingot ne se pose pas');
  assert.strictEqual(posableCount({}), 0);
  assert.strictEqual(posableCount(null), 0);
});

test('chaîne armure : un but block_buffer existe AVANT la descente', () => {
  const names = chainFor('iron_armor').map((g) => g.name);
  assert.ok(names.includes('block_buffer'), 'but block_buffer absent');
  assert.ok(names.indexOf('block_buffer') < names.indexOf('descend_y16'),
    'il faut descendre AVEC de quoi se murer');
});

test('block_buffer : satisfait dès 8 blocs posables', () => {
  const g = chainFor('iron_armor').find((x) => x.name === 'block_buffer');
  assert.strictEqual(g.met({ inv: { cobblestone: 8 } }), true);
  assert.strictEqual(g.met({ inv: { cobblestone: 7 } }), false);
  assert.strictEqual(g.met({ inv: { dirt: 4, oak_planks: 4 } }), true, 'toutes sources confondues');
});

// ─── ARME dans la chaîne T1 (analyse jeu humain, 26/07) ───────────────────────
// La chaîne armure ne contenait AUCUNE arme : le bot menait ses 235 combats au POING (1 dégât,
// contre 5 pour une épée pierre). L'épée existait… mais dans la chaîne du kit cartographe.
// 2 cobble + 1 bâton : c'est le meilleur rapport survie/coût de tout le début de partie.
test('chaîne armure : une épée pierre est prévue AVANT la descente', () => {
  const names = chainFor('iron_armor').map((g) => g.name);
  assert.ok(names.includes('t1_sword'), 'aucune arme dans la chaîne T1');
  assert.ok(names.indexOf('t1_sword') < names.indexOf('descend_y16'),
    'on ne descend pas se battre au poing');
});

test('but épée : satisfait si on en a déjà une (pierre ou mieux)', () => {
  const g = chainFor('iron_armor').find((x) => x.name === 't1_sword');
  assert.strictEqual(g.met({ inv: { stone_sword: 1 } }), true);
  assert.strictEqual(g.met({ inv: { iron_sword: 1 } }), true, 'mieux vaut que pierre → satisfait');
  // Inventaire vide = aucune matière = but SAUTÉ (design non-bloquant), pas "à faire".
  assert.strictEqual(g.met({ inv: {} }), true);
  assert.strictEqual(g.met({ inv: { wooden_sword: 1, cobblestone: 2, stick: 1 } }), false,
    'une épée en BOIS ne compte pas : 4 dégâts / 59 de durabilité, on forge la pierre');
});

test('but épée : SAUTÉ si la matière manque — jamais bloquant', () => {
  const g = chainFor('iron_armor').find((x) => x.name === 't1_sword');
  assert.strictEqual(g.met({ inv: { cobblestone: 1, stick: 1 } }), true, 'pas assez de cobble → on passe');
  assert.strictEqual(g.met({ inv: { cobblestone: 2 } }), true, 'pas de bâton → on passe');
  assert.strictEqual(g.met({ inv: { cobblestone: 2, stick: 1 } }), false, 'matière là → on forge');
});
