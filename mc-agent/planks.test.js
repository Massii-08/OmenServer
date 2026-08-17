'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { planksPlan, plankNeed, PLANKS_PER_LOG, LOG_RESERVE } = require('./planks');

// ─── planksPlan ───────────────────────────────────────────────────────────────────────────────
// L'inventaire de référence est celui mesuré sur world_mn14 : les 6 planches sont là, mais
// réparties sur 2 essences — aucune recette concrète du bouclier n'est satisfaite.

test('planksPlan : 3 oak + 3 birch pour 6 → convertit des bûches (les 6 planches ne suffisent PAS)', () => {
  const p = planksPlan({ oak_planks: 3, birch_planks: 3, oak_log: 30, iron_ingot: 1 }, 6);
  assert.equal(p.action, 'craft_planks');
  assert.equal(p.plankName, 'oak_planks');
  assert.equal(p.logName, 'oak_log');
  assert.equal(p.logs, 1, '3 planches + 1 bûche = 7 ≥ 6 : une seule bûche suffit');
});

test('planksPlan : une essence tient déjà le compte → rien à faire', () => {
  assert.deepEqual(planksPlan({ oak_planks: 6, birch_planks: 3, oak_log: 30 }, 6), { action: 'none' });
});

test('planksPlan : compte atteint par l\'essence la MOINS fournie en planches aussi', () => {
  assert.deepEqual(planksPlan({ birch_planks: 8, oak_log: 30 }, 6), { action: 'none' });
});

test('planksPlan : besoin nul → rien à faire', () => {
  assert.deepEqual(planksPlan({ oak_log: 30 }, 0), { action: 'none' });
});

test('planksPlan : zéro planche, que des bûches → 2 bûches pour 6 planches', () => {
  const p = planksPlan({ oak_log: 30 }, 6);
  assert.equal(p.action, 'craft_planks');
  assert.equal(p.logs, 2, 'ceil(6/4) = 2');
  assert.equal(p.perLog, PLANKS_PER_LOG);
});

// Le cas qui doit rester un ÉCHEC PROPRE : sans bûches, aucune conversion ne peut homogénéiser.
// C'est ce verdict que goals.js réutilise pour SAUTER le but au lieu de le retenter à l'infini.
test('planksPlan : planches mixtes SANS bûches → impossible/no_logs (pas de boucle)', () => {
  assert.deepEqual(planksPlan({ oak_planks: 3, birch_planks: 3, iron_ingot: 1 }, 6),
    { action: 'impossible', reason: 'no_logs' });
});

test('planksPlan : bûches insuffisantes pour combler l\'écart → impossible/no_logs', () => {
  // 1 oak + 1 bûche = 5 < 6, et la réserve interdirait de toute façon d'y toucher.
  assert.equal(planksPlan({ oak_planks: 1, oak_log: 1 }, 6).action, 'impossible');
});

// RÉSERVE — les bûches BRUTES sont l'input du charbon de bois (smeltCharcoalGoal veut count+1
// bûches). On ne descend jamais sous LOG_RESERVE pour homogénéiser des planches.
test('planksPlan : la réserve de bûches est respectée → impossible/reserve', () => {
  const p = planksPlan({ oak_planks: 3, birch_planks: 3, oak_log: 2 }, 6);
  assert.deepEqual(p, { action: 'impossible', reason: 'reserve' });
  assert.equal(LOG_RESERVE, 2);
});

test('planksPlan : réserve désactivable → le plan repasse', () => {
  const p = planksPlan({ oak_planks: 3, birch_planks: 3, oak_log: 2 }, 6, { logReserve: 0 });
  assert.equal(p.action, 'craft_planks');
  assert.equal(p.logs, 1);
});

test('planksPlan : la réserve compte TOUTES les bûches, pas seulement l\'essence convertie', () => {
  // 1 seule bûche d'oak, mais 10 de bouleau à côté : le stock global reste largement au-dessus.
  const p = planksPlan({ oak_planks: 3, oak_log: 1, birch_log: 10 }, 6);
  assert.equal(p.action, 'craft_planks');
  assert.equal(p.logName, 'oak_log', 'oak ne coûte qu\'1 bûche (3 déjà en poche), bouleau en coûterait 2');
});

test('planksPlan : choix DÉTERMINISTE (le moins de bûches, puis ordre alpha)', () => {
  // acacia part de 0 (2 bûches), oak part de 4 (1 bûche) → oak gagne.
  const p = planksPlan({ oak_planks: 4, acacia_log: 30, oak_log: 30 }, 6);
  assert.equal(p.plankName, 'oak_planks');
  // à coût égal (0 planche des deux côtés), l'ordre alphabétique tranche → même verdict
  // pour les 5 ouvriers qui calculent chacun de leur côté.
  const q = planksPlan({ acacia_log: 30, oak_log: 30 }, 6);
  assert.equal(q.plankName, 'acacia_planks');
});

test('planksPlan : bois du Nether (crimson_stem) reconnu comme source', () => {
  const p = planksPlan({ crimson_stem: 30 }, 6);
  assert.equal(p.action, 'craft_planks');
  assert.equal(p.plankName, 'crimson_planks');
  assert.equal(p.logName, 'crimson_stem');
});

// minecraft-data 1.21.4 ne porte AUCUNE recette depuis les variantes écorcées / `_wood` :
// les proposer ferait promettre au prédicat un craft que la skill ne sait pas exécuter.
test('planksPlan : `_wood` et `stripped_*` NE SONT PAS des sources (aucune recette en data)', () => {
  assert.deepEqual(planksPlan({ oak_planks: 3, oak_wood: 30 }, 6), { action: 'impossible', reason: 'no_logs' });
  assert.deepEqual(planksPlan({ oak_planks: 3, stripped_oak_log: 30 }, 6), { action: 'impossible', reason: 'no_logs' });
});

// Seul item du registre 1.21.4 en `_log`/`_stem` qui n'ouvre sur aucune essence. Le proposer
// ferait promettre au but un craft impossible → boucle. Balayage complet du registre en garde-fou.
test('planksPlan : `mushroom_stem` n\'est PAS du bois (aucun mushroom_planks)', () => {
  assert.deepEqual(planksPlan({ mushroom_stem: 64 }, 6), { action: 'impossible', reason: 'no_logs' });
});

test('planksPlan : toute source proposée mène à une essence RÉELLE (registre 1.21.4 entier)', () => {
  const registry = require('prismarine-registry')('1.21.4');
  const orphelines = Object.keys(registry.itemsByName)
    .map((n) => planksPlan({ [n]: 64 }, 6))
    .filter((p) => p.action === 'craft_planks' && !registry.itemsByName[p.plankName])
    .map((p) => p.plankName);
  assert.deepEqual(orphelines, [], 'essences proposées sans item de planches : ' + orphelines.join(' '));
});

test('planksPlan : inventaire absent/vide → impossible, jamais de crash', () => {
  assert.equal(planksPlan(undefined, 6).action, 'impossible');
  assert.equal(planksPlan({}, 6).action, 'impossible');
});

test('planksPlan : comptes nuls ou négatifs ignorés', () => {
  assert.deepEqual(planksPlan({ oak_planks: 0, oak_log: 0 }, 6), { action: 'impossible', reason: 'no_logs' });
});

// ─── plankNeed ────────────────────────────────────────────────────────────────────────────────

test('plankNeed : bouclier (6 planches + 1 lingot) avec le lingot en poche → 6', () => {
  const delta = [{ name: 'pale_oak_planks', count: -6 }, { name: 'iron_ingot', count: -1 }, { name: 'shield', count: 1 }];
  assert.equal(plankNeed(delta, { iron_ingot: 1, oak_planks: 3, birch_planks: 3 }), 6);
});

// Sans lingot, convertir du bois ne débloquerait RIEN : on ne brûle pas de bûches pour rien.
test('plankNeed : autre ingrédient manquant → 0 (l\'échec ne vient pas des planches)', () => {
  const delta = [{ name: 'pale_oak_planks', count: -6 }, { name: 'iron_ingot', count: -1 }, { name: 'shield', count: 1 }];
  assert.equal(plankNeed(delta, { oak_planks: 3, birch_planks: 3 }), 0);
});

test('plankNeed : table de craft (4 planches) et bâtons (2 planches)', () => {
  assert.equal(plankNeed([{ name: 'oak_planks', count: -4 }, { name: 'crafting_table', count: 1 }], {}), 4);
  assert.equal(plankNeed([{ name: 'oak_planks', count: -2 }, { name: 'stick', count: 4 }], {}), 2);
});

test('plankNeed : pioche bois → 3 planches quand les bâtons sont là, 0 sinon', () => {
  const delta = [{ name: 'oak_planks', count: -3 }, { name: 'stick', count: -2 }, { name: 'wooden_pickaxe', count: 1 }];
  assert.equal(plankNeed(delta, { stick: 4 }), 3);
  assert.equal(plankNeed(delta, { stick: 1 }), 0);
});

// Garde-fou anti-récursion : la recette des planches elle-même ne CONSOMME pas de planches
// (elle en produit) → plankNeed rend 0, donc l'homogénéisation ne peut pas s'auto-appeler.
test('plankNeed : la recette des planches elle-même → 0 (pas de récursion)', () => {
  assert.equal(plankNeed([{ name: 'oak_log', count: -1 }, { name: 'oak_planks', count: 4 }], { oak_log: 30 }), 0);
});

test('plankNeed : recette sans planches → 0', () => {
  assert.equal(plankNeed([{ name: 'cobblestone', count: -3 }, { name: 'stick', count: -2 }], { cobblestone: 9, stick: 4 }), 0);
});

test('plankNeed : delta absent → 0, jamais de crash', () => {
  assert.equal(plankNeed(undefined, {}), 0);
  assert.equal(plankNeed([], undefined), 0);
});
