'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { invCount, buildCtxInv, MVP_CHAIN, IRON_CHAIN, DIAMOND_CHAIN, chainFor, firstUnmet, nextObjectiveAfter, DIAMOND_TARGET, wantsOpportunisticArmor } = require('./goals');

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
     'cobble_buffer', 'descend_y54', 'diamond_caves'],
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

// Cave-first (Massii 26/07) : le dernier but du diamant n'est plus un strip-mine mais la
// chasse aux minerais MAPPES, EXPOSES et SECS ; le tunnel n'est plus qu'un trajet.
test('DIAMOND firstUnmet : Y atteint -54, pioche fer, cobble -> diamond_caves', () => {
  const ctx = { inv: { iron_pickaxe: 1, cobblestone: 16, stick: 4 }, y: -54 };
  assert.strictEqual(firstUnmet(DIAMOND_CHAIN, ctx).name, 'diamond_caves');
});

test('DIAMOND firstUnmet : cible CONTINUE atteinte -> null (objectif fini)', () => {
  // Depuis le 26/07 la fin n'est plus « 1 diamant » mais DIAMOND_TARGET (demande « en continu »).
  // NB : la pioche fait partie de l'etat — un diamant en poche ne la remplace pas (elle casse).
  const ctx = { inv: { diamond: DIAMOND_TARGET, iron_pickaxe: 1 }, y: -54 };
  assert.strictEqual(firstUnmet(DIAMOND_CHAIN, ctx), null);
});

test('DIAMOND monotonie : diamond:1 satisfait tout l AMONT (outils/bois consommes)', () => {
  // Un diamant en poche PROUVE que bois, outils et four sont derriere nous : aucun but amont ne
  // doit se rouvrir. Seuls les 3 buts de queue (cobble/descente/chasse) restent ouverts, car la
  // cible est desormais CONTINUE — c'est precisement ce qui empeche le bot de s'arreter au 1er.
  // Les buts d'OUTIL sont exclus eux aussi : une pioche casse, un diamant ne la remplace pas.
  const ctx = { inv: { diamond: 1 }, y: -54 };
  const queue = ['cobble_buffer', 'descend_y54', 'diamond_caves',
                 'wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe'];
  for (const goal of DIAMOND_CHAIN) {
    if (queue.includes(goal.name)) continue;
    assert.ok(goal.met(ctx), `but "${goal.name}" devrait etre satisfait quand diamond:1`);
  }
});

test('DIAMOND descend_y54 : met=false en surface, true en profondeur, true si cible atteinte', () => {
  const goal = DIAMOND_CHAIN.find((g) => g.name === 'descend_y54');
  assert.strictEqual(goal.met({ inv: {}, y: 64 }), false);
  assert.strictEqual(goal.met({ inv: {}, y: -52 }), true);
  // ⚠️ un bot REMONTE (fuite, faim) avec quelques diamants doit REDESCENDRE : l'ancien gating
  // `|| diamond>=1` le laissait en surface pour toujours.
  assert.strictEqual(goal.met({ inv: { diamond: 3 }, y: 70 }), false);
  assert.strictEqual(goal.met({ inv: { diamond: DIAMOND_TARGET }, y: 70 }), true);
});

test('DIAMOND cobble_buffer : met=true si cobble>=16 OU cible continue atteinte', () => {
  const goal = DIAMOND_CHAIN.find((g) => g.name === 'cobble_buffer');
  assert.strictEqual(goal.met({ inv: { cobblestone: 16 } }), true);
  assert.strictEqual(goal.met({ inv: { diamond: 3 } }), false);
  assert.strictEqual(goal.met({ inv: { diamond: DIAMOND_TARGET } }), true);
});

test('DIAMOND : le but iron_pickaxe N\'est PLUS le dernier (le diamant l\'est)', () => {
  const names = DIAMOND_CHAIN.map((g) => g.name);
  assert.notStrictEqual(names[names.length - 1], 'iron_pickaxe');
  assert.strictEqual(names[names.length - 1], 'diamond_caves');
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

// ─── HACHE (analyse jeu humain 26/07) ────────────────────────────────────────
// `logs` = 2001 tentatives sur le run, de loin le but le plus sollicité. À la main une bûche
// prend ~3 s, à la hache pierre ~0,75 s : ×4 sur le poste de travail n°1 du bot. 3 cobble +
// 2 bâtons, la même matière que l'épée.
test('chaîne armure : une hache est prévue (bois = le poste n°1 du run)', () => {
  const names = chainFor('iron_armor').map((g) => g.name);
  assert.ok(names.includes('t1_axe'), 'aucune hache dans la chaîne T1');
});

test('but hache : satisfait si on en a une, sauté si la matière manque', () => {
  const g = chainFor('iron_armor').find((x) => x.name === 't1_axe');
  assert.strictEqual(g.met({ inv: { stone_axe: 1 } }), true);
  assert.strictEqual(g.met({ inv: { iron_axe: 1 } }), true, 'mieux que pierre → satisfait');
  assert.strictEqual(g.met({ inv: { cobblestone: 2, stick: 2 } }), true, 'pas assez de cobble → sauté');
  assert.strictEqual(g.met({ inv: { cobblestone: 3, stick: 1 } }), true, 'pas assez de bâtons → sauté');
  assert.strictEqual(g.met({ inv: { cobblestone: 3, stick: 2 } }), false, 'matière là → on forge');
});

// ─── CHARBON sous terre (capture réelle Massitom2008 × alexdon1837, 26/07) ───
// Dans la vraie partie : alexdon a miné 65 charbons dans les 10 PREMIÈRES minutes, avant le fer,
// et les deux joueurs ont posé 131 et 97 torches en 33 min. Le charbon est à la fois le
// combustible (8 fontes, contre 1,5 pour une bûche) ET la lumière.
// Le bot, lui, exécutait `armor_fuel → gatherLog` MÊME à Y16 : il remontait couper du bois pour
// fondre, alors qu'il avait du charbon tout autour. C'est le churn bois↔profondeur à l'état pur.
test('chaîne armure : un but charbon existe AVANT le combustible-bois', () => {
  const names = chainFor('iron_armor').map((g) => g.name);
  assert.ok(names.includes('t1_coal'), 'aucun but charbon');
  assert.ok(names.indexOf('t1_coal') < names.indexOf('armor_fuel'),
    'le charbon doit être tenté avant de remonter couper du bois');
});

test('but charbon : SOUS TERRE et sans combustible → on mine du charbon', () => {
  const g = chainFor('iron_armor').find((x) => x.name === 't1_coal');
  assert.strictEqual(g.met({ inv: { raw_iron: 8 }, y: 16 }), false);
});

test('but charbon : EN SURFACE → sauté (le bois y est le combustible naturel)', () => {
  const g = chainFor('iron_armor').find((x) => x.name === 't1_coal');
  assert.strictEqual(g.met({ inv: { raw_iron: 8 }, y: 64 }), true);
});

// 28/07 : le seuil est passé de 3 à une VRAIE RÉSERVE (demande Massii — « jamais se limiter à
// quelques morceaux »). 5 charbons ne suffisent plus ; 16 oui. Le charbon de bois compte toujours.
test('but charbon : une VRAIE réserve en poche → satisfait', () => {
  const g = chainFor('iron_armor').find((x) => x.name === 't1_coal');
  assert.strictEqual(g.met({ inv: { coal: 5 }, y: 16 }), false, '5 charbons = « quelques morceaux »');
  assert.strictEqual(g.met({ inv: { coal: 16 }, y: 16 }), true);
  assert.strictEqual(g.met({ inv: { charcoal: 16 }, y: 16 }), true, 'le charbon de bois compte');
});

test('but charbon : le bois en poche suffit aussi (on ne détourne pas pour rien)', () => {
  const g = chainFor('iron_armor').find((x) => x.name === 't1_coal');
  // Le bois compte comme combustible (1,5 unité la planche) — mais il en faut une VRAIE réserve :
  // couvrir la fonte de l'armure (24) PLUS le tampon (48) = 72 unités, soit ~48 planches.
  assert.strictEqual(g.met({ inv: { oak_planks: 80 }, y: 16 }), true);
  assert.strictEqual(g.met({ inv: { oak_planks: 4 }, y: 16 }), false, '4 planches = pas une réserve');
});

// ─── nextObjectiveAfter : ne JAMAIS rester inerte une fois l'objectif atteint ───────────────────
// Massii, live 26/07 : « Neth1, neth4 et neth5 ne bougent plus, si ils ont finis il aident en
// priorité les autres bot et après il vont chercher les diamant. » Le code faisait
// `clearObjective()` sans rien mettre derrière → 3 bots sur 5 à l'arrêt.
test('nextObjectiveAfter : iron_armor fini + un coéquipier en manque → on AIDE', () => {
  const mates = [{ name: 'B', status: { need: 15 } }, { name: 'C', status: { need: 0 } }];
  assert.strictEqual(nextObjectiveAfter('iron_armor', mates), 'iron_help');
});

test('nextObjectiveAfter : iron_armor fini + personne en manque → diamant', () => {
  const mates = [{ name: 'B', status: { need: 0 } }, { name: 'C', status: {} }];
  assert.strictEqual(nextObjectiveAfter('iron_armor', mates), 'diamond');
});

test('nextObjectiveAfter : aucun coéquipier connu → diamant (jamais inerte)', () => {
  assert.strictEqual(nextObjectiveAfter('iron_armor', []), 'diamond');
  assert.strictEqual(nextObjectiveAfter('iron_armor', null), 'diamond');
});

test('nextObjectiveAfter : diamant "fini" → on repart en chasser (demande « en continu »)', () => {
  assert.strictEqual(nextObjectiveAfter('diamond', [{ name: 'B', status: { need: 9 } }]), 'diamond');
});

test('nextObjectiveAfter : iron_help fini mais il reste des besoins → on continue d aider', () => {
  assert.strictEqual(nextObjectiveAfter('iron_help', [{ name: 'B', status: { need: 4 } }]), 'iron_help');
  assert.strictEqual(nextObjectiveAfter('iron_help', [{ name: 'B', status: { need: 0 } }]), 'diamond');
});

// ─── Diamant CONTINU (Massii, live 26/07) ──────────────────────────────────────────────────────
// « il ne doivent pas s'arreter a seulement quelque diamant, ils doivent continuer a en prendre
// en continu ». Le predicat final valait `diamond >= 1` : le bot s'arretait au PREMIER.
test('DIAMOND : un seul diamant NE termine PLUS l objectif', () => {
  const ctx = { inv: { diamond: 1, iron_pickaxe: 1, cobblestone: 16, stick: 4 }, y: -54 };
  assert.strictEqual(firstUnmet(DIAMOND_CHAIN, ctx).name, 'diamond_caves');
});

test('DIAMOND : la cible continue est atteinte -> objectif fini', () => {
  const ctx = { inv: { diamond: DIAMOND_TARGET, iron_pickaxe: 1, cobblestone: 16, stick: 4 }, y: -54 };
  assert.strictEqual(firstUnmet(DIAMOND_CHAIN, ctx), null);
});

// Effet de bord a ne pas rater : avec l ancien gating `|| D(c)`, un bot REMONTE (fuite, faim)
// voyait `descend_y54` deja satisfait des le 1er diamant et ne redescendait jamais.
test('DIAMOND : remonte en surface avec des diamants -> il REDESCEND', () => {
  const ctx = { inv: { diamond: 3, iron_pickaxe: 1, cobblestone: 16, stick: 4 }, y: 70 };
  assert.strictEqual(firstUnmet(DIAMOND_CHAIN, ctx).name, 'descend_y54');
});

test('nextObjectiveAfter : diamant "fini" -> on repart au diamant (jamais inerte)', () => {
  assert.strictEqual(nextObjectiveAfter('diamond', []), 'diamond');
});

// ─── OUTILS : un diamant en poche ne remplace pas une pioche ───────────────────────────────────
// Massii, live 26/07 : « 4 et 5 il creuse sans pioche ». `withFinal(g, D)` gatait TOUS les buts de
// la chaine fer sur « j'ai >= 1 diamant » — y compris « avoir une pioche en fer ». Or une pioche
// CASSE : le bot croyait son outillage complet, descendait, et ne pouvait plus rien miner.
// `caveHunt` sortait alors sur `no_pick` sans rien emettre, ce qui rendait la panne invisible.
test('DIAMOND : pioche CASSEE avec un diamant en poche -> la chaine REFORGE (pierre d abord)', () => {
  // Elle repart au prerequis le MOINS CHER (pioche pierre), puis remonte vers la pioche fer :
  // c'est le comportement voulu. Le point du test est qu'elle ne considere PLUS l'outillage
  // comme acquis sous pretexte qu'un diamant traine en poche.
  const ctx = { inv: { diamond: 1, cobblestone: 16, stick: 4, crafting_table: 1, iron_ingot: 3 }, y: -54 };
  assert.strictEqual(firstUnmet(DIAMOND_CHAIN, ctx).name, 'stone_pickaxe');
});

test('DIAMOND : pioche en poche -> on passe bien a la suite', () => {
  const ctx = { inv: { diamond: 1, iron_pickaxe: 1, cobblestone: 16, stick: 4 }, y: -54 };
  assert.strictEqual(firstUnmet(DIAMOND_CHAIN, ctx).name, 'diamond_caves');
});

// ── ENCHAINEMENT vers l'armure des cartographes (Massii 26/07) ──────────────────────────────────
const { MAPPER_ARMOR_CHAIN, GIFT_SET_INGOTS } = require('./goals');

const _mapper = (name, armor) => ({ name, role: 'mapper', armor, at: Date.now() });
const _worker = (name, need) => ({ name, role: 'worker', armor: 4, need, at: Date.now() });

test('nextObjectiveAfter: les workers en manque passent AVANT les cartographes', () => {
  const mates = [_worker('W2', 12), _mapper('M1', 0)];
  assert.strictEqual(nextObjectiveAfter('iron_armor', mates), 'iron_help');
});

test('nextObjectiveAfter: plus personne en manque + un mappeur nu → mapper_armor', () => {
  const mates = [_worker('W2', 0), _mapper('M1', 0)];
  assert.strictEqual(nextObjectiveAfter('iron_armor', mates), 'mapper_armor');
  assert.strictEqual(nextObjectiveAfter('iron_help', mates), 'mapper_armor');
});

test('nextObjectiveAfter: tous les mappeurs equipes → diamant', () => {
  const mates = [_worker('W2', 0), _mapper('M1', 4), _mapper('M2', 4)];
  assert.strictEqual(nextObjectiveAfter('iron_armor', mates), 'diamond');
  assert.strictEqual(nextObjectiveAfter('mapper_armor', mates), 'diamond');
});

test('nextObjectiveAfter: un set ne couvre qu_UN mappeur → on reboucle tant qu_il en reste', () => {
  const mates = [_mapper('M1', 4), _mapper('M2', 0)];
  assert.strictEqual(nextObjectiveAfter('mapper_armor', mates), 'mapper_armor');
});

test('nextObjectiveAfter: `need` est lu a PLAT (presence.beat aplatit le statut)', () => {
  // Le champ etait lu en `m.status.need` : toujours undefined, donc iron_help ne se declenchait
  // jamais. On accepte encore l'ancienne forme par tolerance.
  assert.strictEqual(nextObjectiveAfter('iron_armor', [_worker('W2', 8)]), 'iron_help');
  assert.strictEqual(
    nextObjectiveAfter('iron_armor', [{ name: 'W2', role: 'worker', armor: 4, status: { need: 8 }, at: Date.now() }]),
    'iron_help');
});

test('MAPPER_ARMOR_CHAIN: sans cible, TOUS les buts sont satisfaits (chaine inerte)', () => {
  const ctx = { inv: {}, y: 70, mapperTarget: null, giftReady: false };
  assert.strictEqual(firstUnmet(MAPPER_ARMOR_CHAIN, ctx), null);
});

test('MAPPER_ARMOR_CHAIN: cible + rien en poche (PAS de pioche) → refaire une pioche d_abord', () => {
  // Miner les 24 fer du set exige une pioche fer-capable ; descendDiagonal aussi (no_pickaxe).
  // Sans ce garde, un bot 4/4 dont la pioche a cassé bouclait iron_deep → no_pickaxe (mesure
  // world_mn8 : 96 no_pickaxe / 0 recraft par session, entraide jamais livrée).
  const ctx = { inv: {}, y: 70, mapperTarget: 'MapBot1', giftReady: false };
  assert.strictEqual(firstUnmet(MAPPER_ARMOR_CHAIN, ctx).name, 'gift_pick');
});

test('MAPPER_ARMOR_CHAIN: cible + pioche mais AUCUN bois EN SURFACE → sécuriser un buffer de bois AVANT de descendre (mirror T1 plank_buffer, fix churn bois↔profondeur)', () => {
  // La chaîne descendait AVANT de sécuriser du bois (contrairement à IRON_ARMOR_CHAIN.plank_buffer) →
  // sous terre gift_furnace/gift_craft échouaient no_table:unknown_item (aucun bois pour re-crafter la
  // table du set d'armure). Mesure world_mn11 28/07 : gift_furnace 100% échec (no_table:unknown_item 53).
  const ctx = { inv: { stone_pickaxe: 1 }, y: 70, mapperTarget: 'MapBot1', giftReady: false };
  assert.strictEqual(firstUnmet(MAPPER_ARMOR_CHAIN, ctx).name, 'gift_planks');
});

test('MAPPER_ARMOR_CHAIN: cible + pioche + buffer de bois EN SURFACE → on descend (le buffer est constitué)', () => {
  const ctx = { inv: { stone_pickaxe: 1, oak_log: 6 }, y: 70, mapperTarget: 'MapBot1', giftReady: false };
  assert.strictEqual(firstUnmet(MAPPER_ARMOR_CHAIN, ctx).name, 'gift_descend');
});

test('MAPPER_ARMOR_CHAIN: cible + pioche SOUS TERRE sans bois → le buffer est SAUTÉ (déjà engagé, pas de churn) → on mine le fer', () => {
  // Comme T1 : le buffer ne force le bois qu'EN SURFACE (y>30). Sous terre (y<=30) il est sauté pour
  // ne pas déclencher un aller-retour bois — le churn qu'on cherche justement à éviter.
  const ctx = { inv: { stone_pickaxe: 1 }, y: 16, mapperTarget: 'MapBot1', giftReady: false };
  assert.strictEqual(firstUnmet(MAPPER_ARMOR_CHAIN, ctx).name, 'gift_iron');
});

test('MAPPER_ARMOR_CHAIN: en profondeur avec fer brut, combustible ET four → il faut fondre', () => {
  // Avec du charbon en poche (assez pour fondre le set) ET un four en poche, la fonte est le but.
  const ctx = { inv: { raw_iron: GIFT_SET_INGOTS, coal: 4, furnace: 1 }, y: 16, mapperTarget: 'MapBot1', giftReady: false };
  assert.strictEqual(firstUnmet(MAPPER_ARMOR_CHAIN, ctx).name, 'gift_smelt');
});

test('MAPPER_ARMOR_CHAIN: fer brut mais AUCUN combustible en profondeur → but combustible, PAS gift_smelt (fix boucle no_fuel)', () => {
  const ctx = { inv: { raw_iron: GIFT_SET_INGOTS }, y: 16, mapperTarget: 'MapBot1', giftReady: false };
  const g = firstUnmet(MAPPER_ARMOR_CHAIN, ctx);
  assert.notStrictEqual(g, null);
  assert.notStrictEqual(g.skill, 'smeltIron'); // ne DOIT PAS boucler sur la fonte sans combustible
});

test('MAPPER_ARMOR_CHAIN: fer + combustible mais AUCUN four → but four, PAS gift_smelt (fix boucle no_furnace)', () => {
  // Un worker qui a laissé son four derrière (reclaim_failed) bouclait gift_smelt → no_furnace à
  // l'infini (mesuré world_mn9 27/07 : NethBot2 respawn-loop, 64 iron_surplus/no_furnace). La
  // chaîne d'entraide n'avait AUCUN but four avant la fonte (contrairement à IRON_ARMOR_CHAIN).
  const ctx = { inv: { raw_iron: GIFT_SET_INGOTS, coal: 4 }, y: 16, mapperTarget: 'MapBot1', giftReady: false };
  const g = firstUnmet(MAPPER_ARMOR_CHAIN, ctx);
  assert.notStrictEqual(g, null);
  assert.notStrictEqual(g.skill, 'smeltIron'); // ne DOIT PAS boucler sur la fonte sans four
});

test('MAPPER_ARMOR_CHAIN: lingots fondus → forger le set', () => {
  const ctx = { inv: { iron_ingot: GIFT_SET_INGOTS }, y: 16, mapperTarget: 'MapBot1', giftReady: false };
  assert.strictEqual(firstUnmet(MAPPER_ARMOR_CHAIN, ctx).name, 'gift_craft');
});

test('MAPPER_ARMOR_CHAIN: set pret → livrer', () => {
  const ctx = { inv: { iron_ingot: GIFT_SET_INGOTS }, y: 16, mapperTarget: 'MapBot1', giftReady: true };
  assert.strictEqual(firstUnmet(MAPPER_ARMOR_CHAIN, ctx).name, 'gift_deliver');
});

// ── ENTRAIDE : la chaine iron_help ne doit pas boucler sur la fonte sans combustible ────────────
const { IRON_HELP_CHAIN, HELP_STOCK } = require('./goals');

test('IRON_HELP_CHAIN: fer minoré mais AUCUN combustible → but combustible, PAS iron_surplus (fix boucle no_fuel)', () => {
  // Bot 4/4 descendu miner du surplus, 8 fer brut, 0 charbon/bois : le smelt echouerait no_fuel
  // a l'infini (32 no_fuel/session mesurés le 27/07). On exige du combustible d'abord.
  const ctx = { y: 16, inv: { raw_iron: HELP_STOCK } };
  const g = firstUnmet(IRON_HELP_CHAIN, ctx);
  assert.notStrictEqual(g, null);
  assert.notStrictEqual(g.skill, 'smeltIron');
});

test('IRON_HELP_CHAIN: fer + charbon + four suffisant → iron_surplus (la fonte peut avoir lieu)', () => {
  const ctx = { y: 16, inv: { raw_iron: HELP_STOCK, coal: 2, furnace: 1 } };
  assert.strictEqual(firstUnmet(IRON_HELP_CHAIN, ctx).name, 'iron_surplus');
});

test('IRON_HELP_CHAIN: fer + planches + four suffisants → iron_surplus (le bois est un combustible)', () => {
  // Le combustible n'est pas que le charbon : des planches en rab suffisent a debloquer la fonte.
  const ctx = { y: 16, inv: { raw_iron: HELP_STOCK, oak_planks: 24, furnace: 1 } };
  assert.strictEqual(firstUnmet(IRON_HELP_CHAIN, ctx).name, 'iron_surplus');
});

test('IRON_HELP_CHAIN: fer + combustible mais AUCUN four → but four, PAS iron_surplus (fix boucle no_furnace)', () => {
  // Bot 4/4 qui a laissé son four derrière : smeltIron → no_furnace à l'infini (mesuré world_mn9
  // 27/07, NethBot2 : 64 iron_surplus/no_furnace + respawn-loop desync). On exige un four d'abord.
  const ctx = { y: 16, inv: { raw_iron: HELP_STOCK, coal: 2 } };
  const g = firstUnmet(IRON_HELP_CHAIN, ctx);
  assert.notStrictEqual(g, null);
  assert.notStrictEqual(g.skill, 'smeltIron');
});

test('IRON_HELP_CHAIN: fer + combustible + four en poche → iron_surplus (le four débloque la fonte)', () => {
  const ctx = { y: 16, inv: { raw_iron: HELP_STOCK, coal: 2, furnace: 1 } };
  assert.strictEqual(firstUnmet(IRON_HELP_CHAIN, ctx).name, 'iron_surplus');
});

// PIÈGE (world_mn8, 27/07) — les chaînes d'entraide partaient sur descend→branchMine SANS aucun
// but pioche (contrairement à IRON_ARMOR_CHAIN qui a spare_picks). Un bot 4/4 dont la pioche casse
// bouclait iron_deep → no_pickaxe à l'infini → 0 livraison d'entraide, armure figée. On préfixe la
// reconstitution robuste (recoverPickaxe : expédition bois + bootstrap bois→pierre).
test('IRON_HELP_CHAIN: pas de pioche + fer insuffisant → refaire une pioche AVANT de miner', () => {
  const ctx = { y: 16, inv: {} };
  assert.strictEqual(firstUnmet(IRON_HELP_CHAIN, ctx).name, 'help_pick');
});

test('IRON_HELP_CHAIN: pioche pierre en poche → le garde pioche est franchi (on descend)', () => {
  const ctx = { y: 70, inv: { stone_pickaxe: 1 } };
  assert.strictEqual(firstUnmet(IRON_HELP_CHAIN, ctx).name, 'descend_y16');
});

test('IRON_HELP_CHAIN: pas de pioche MAIS fer brut déjà suffisant (+ four + combustible) → garde pioche sauté (on fond, pas de re-mine)', () => {
  // Le bot a déjà de quoi livrer : inutile de refaire une pioche → help_pick est franchi et le
  // planner passe directement à la fonte du surplus (four + combustible en poche).
  const ctx = { y: 16, inv: { raw_iron: HELP_STOCK, coal: 2, furnace: 1 } };
  assert.strictEqual(firstUnmet(IRON_HELP_CHAIN, ctx).name, 'iron_surplus');
});

// PIÈGE #61 — le timer armure opportuniste (index.js) doit couvrir l'objectif `iron_armor` (et
// `diamond_armor`), sinon un worker qui accumule des lingots sans jamais atteindre le but de chaîne
// (gaté ~27 fer) ne forge JAMAIS une pièce abordable → armure figée (mesuré : 2 h 20 le 27/07).
// Les objectifs de minage historiques doivent rester couverts (non-régression).
test('wantsOpportunisticArmor : couvre iron_armor ET diamond_armor (piège #61)', () => {
  assert.strictEqual(wantsOpportunisticArmor('iron_armor'), true);
  assert.strictEqual(wantsOpportunisticArmor('diamond_armor'), true);
});

test('wantsOpportunisticArmor : couvre toujours resource/diamond/mapper (non-régression)', () => {
  for (const o of ['resource', 'diamond', 'mapper']) assert.strictEqual(wantsOpportunisticArmor(o), true);
  assert.strictEqual(wantsOpportunisticArmor('mvp'), false);
});
