'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  bookmark, goHome, goSpawn, sanitizeName, RESERVED, classifyImminent, dropsWithin,
  isTpRefusal, refusedHome, effectiveVerdict,
} = require('./homewarp');
const { isForbiddenCheat } = require('./nogive');

function fakeBot() {
  const sent = [];
  return { sent, chat: (m) => sent.push(m) };
}

test('sanitizeName : minuscule + [a-z0-9_] uniquement, défaut wsite', () => {
  assert.strictEqual(sanitizeName('WSite'), 'wsite');
  assert.strictEqual(sanitizeName('  death  '), 'death');
  assert.strictEqual(sanitizeName('bad name!;/'), 'badname');   // strip espaces + ponctuation
  assert.strictEqual(sanitizeName(''), 'wsite');
  assert.strictEqual(sanitizeName(null), 'wsite');
  assert.strictEqual(sanitizeName('a b'), 'ab');
});

test('bookmark : /sethome <name>, retourne le nom nettoyé', () => {
  const bot = fakeBot();
  assert.strictEqual(bookmark(bot, 'wsite'), 'wsite');
  assert.deepStrictEqual(bot.sent, ['/sethome wsite']);
});

test('bookmark : re-sethome du MÊME nom (Essentials écrase → replace)', () => {
  const bot = fakeBot();
  bookmark(bot, 'death');
  bookmark(bot, 'death');
  assert.deepStrictEqual(bot.sent, ['/sethome death', '/sethome death']);
});

test('goHome : /home <name>', () => {
  const bot = fakeBot();
  assert.strictEqual(goHome(bot, 'wsite'), 'wsite');
  assert.deepStrictEqual(bot.sent, ['/home wsite']);
});

test('goSpawn : repli sur le home safe (/spawn absent de ce serveur)', () => {
  const bot = fakeBot();
  goSpawn(bot);
  assert.deepStrictEqual(bot.sent, ['/home safe']);
});

test('toutes les commandes émises passent isForbiddenCheat (jamais bloquées par nogive)', () => {
  const bot = fakeBot();
  bookmark(bot, 'wsite');
  bookmark(bot, 'death');
  bookmark(bot, 'safe');
  goHome(bot, 'wsite');
  goHome(bot, 'death');
  goSpawn(bot);
  for (const cmd of bot.sent) {
    assert.strictEqual(isForbiddenCheat(cmd), false, `nogive ne doit PAS bloquer: ${cmd}`);
  }
});

test('injection : un nom malveillant ne peut pas fabriquer une autre commande', () => {
  const bot = fakeBot();
  bookmark(bot, 'x /give @s diamond');   // espaces + slash strippés
  assert.deepStrictEqual(bot.sent, ['/sethome xgivesdiamond']);
  assert.strictEqual(isForbiddenCheat(bot.sent[0]), false);
});

test('RESERVED contient wsite, death, safe', () => {
  assert.ok(RESERVED.includes('wsite'));
  assert.ok(RESERVED.includes('death'));
  assert.ok(RESERVED.includes('safe'));
});

test('classifyImminent : PV > seuil → null (pas imminent)', () => {
  assert.strictEqual(classifyImminent({ health: 12 }), null);
  assert.strictEqual(classifyImminent({ health: 7, inWater: true }), null);
  assert.strictEqual(classifyImminent({}), null);          // pas de health → null
});

test('classifyImminent : noyade/lave/essaim → escape (goSpawn, les 3 morts bêtes)', () => {
  assert.strictEqual(classifyImminent({ health: 5, inWater: true }), 'escape');
  assert.strictEqual(classifyImminent({ health: 6, lavaNear: true }), 'escape');
  assert.strictEqual(classifyImminent({ health: 4, nearbyHostiles: 2 }), 'escape');
  assert.strictEqual(classifyImminent({ health: 4, nearbyHostiles: 5 }), 'escape');
});

test('classifyImminent : chute/générique (1 seul mob, à sec) → bookmark death', () => {
  assert.strictEqual(classifyImminent({ health: 3 }), 'bookmark');
  assert.strictEqual(classifyImminent({ health: 3, nearbyHostiles: 1 }), 'bookmark');
});

// ─── Refus TP Essentials (RC3 water-wall) : « The teleport destination is unsafe… » ─────────────
// Un /home refusé par la teleport-safety NE téléporte PAS → le filet de secours croyait avoir
// sauvé le bot (fire-and-forget) → zombie à 1.8 PV (vécu NethBot2 world_ax1, monde noyé).

test('isTpRefusal : message Essentials « destination unsafe » détecté, chat joueur ignoré', () => {
  assert.strictEqual(isTpRefusal('Error: The teleport destination is unsafe and teleport-safety is disabled.'), true);
  assert.strictEqual(isTpRefusal('The teleport destination is unsafe and teleport-safety is disabled.'), true);
  assert.strictEqual(isTpRefusal('<Bob> my teleport is weird today'), false);
  assert.strictEqual(isTpRefusal('You have been teleported'), false);
  assert.strictEqual(isTpRefusal(''), false);
  assert.strictEqual(isTpRefusal(null), false);
});

test('refusedHome : refus dans la fenêtre après goHome → nom du home, et consommé', () => {
  const bot = fakeBot();
  goHome(bot, 'safe');
  const refusal = 'Error: The teleport destination is unsafe and teleport-safety is disabled.';
  assert.strictEqual(refusedHome(bot, refusal), 'safe');
  // consommé : le même message re-reçu ne re-matche pas (anti double-comptage)
  assert.strictEqual(refusedHome(bot, refusal), null);
});

test('refusedHome : goSpawn est tracké comme home safe', () => {
  const bot = fakeBot();
  goSpawn(bot);
  assert.strictEqual(refusedHome(bot, 'The teleport destination is unsafe and teleport-safety is disabled.'), 'safe');
});

test('refusedHome : hors fenêtre → null (message tardif non attribuable)', () => {
  const bot = fakeBot();
  goHome(bot, 'wsite');
  bot._mcaLastHome.at = Date.now() - 9000;   // > fenêtre 8 s
  assert.strictEqual(refusedHome(bot, 'The teleport destination is unsafe and teleport-safety is disabled.'), null);
});

test('refusedHome : message non-refus ou aucun /home récent → null', () => {
  const bot = fakeBot();
  assert.strictEqual(refusedHome(bot, 'The teleport destination is unsafe and teleport-safety is disabled.'), null);
  goHome(bot, 'wsite');
  assert.strictEqual(refusedHome(bot, '<Bob> hello'), null);
});

test('refusedHome : bookmark (/sethome) ne pose PAS de tracking (ne téléporte pas)', () => {
  const bot = fakeBot();
  bookmark(bot, 'death');
  assert.strictEqual(refusedHome(bot, 'The teleport destination is unsafe and teleport-safety is disabled.'), null);
});

test('effectiveVerdict : escape dégradé en escape_no_warp si le safe a été refusé récemment', () => {
  const now = 1000000;
  assert.strictEqual(effectiveVerdict('escape', now - 30000, now), 'escape_no_warp');   // refus 30 s avant
  assert.strictEqual(effectiveVerdict('escape', now - 300000, now), 'escape');          // refus vieux (>120 s)
  assert.strictEqual(effectiveVerdict('escape', null, now), 'escape');                  // jamais refusé
  assert.strictEqual(effectiveVerdict('bookmark', now - 30000, now), 'bookmark');       // non-escape inchangé
  assert.strictEqual(effectiveVerdict(null, now - 30000, now), null);
});

test('dropsWithin : filtre les items dans le rayon, triés par distance ; keepInv (0 item) → []', () => {
  const center = { x: 0, y: 0, z: 0 };
  const ents = [
    { type: 'item', position: { x: 10, y: 0, z: 0 } },   // dist 10, dans rayon 16
    { type: 'item', position: { x: 3, y: 0, z: 0 } },     // dist 3
    { type: 'player', position: { x: 1, y: 0, z: 0 } },   // pas un item
    { type: 'item', position: { x: 30, y: 0, z: 0 } },    // hors rayon
  ];
  const got = dropsWithin(ents, center, 16);
  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[0].dist, 3);      // plus proche d'abord
  assert.strictEqual(got[1].dist, 10);
  assert.deepStrictEqual(dropsWithin([], center, 16), []);   // keepInv ON → no-op
});
