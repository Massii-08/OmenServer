'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  bookmark, goHome, goSpawn, sanitizeName, RESERVED, classifyImminent, dropsWithin,
  isTpRefusal, refusedHome, effectiveVerdict, isTpWarmup, isTpCancelled, secureTactic,
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

// Anti-flood console.trace : `entity.objectType` est un GETTER DÉPRÉCIÉ de prismarine-entity
// qui appelle `console.trace(...)` À CHAQUE LECTURE (67 k lignes/session mesurées, event-loop
// noyée → watchdog physicsTick → churn de reconnexions). dropsWithin est appelé toutes les ~800 ms
// sur TOUTES les entités → il ne DOIT JAMAIS lire `.objectType`. On classe via `displayName` (ce
// que renvoie le getter déprécié) ou `name`/`type` — jamais le getter.
test('dropsWithin : ne lit JAMAIS le getter déprécié entity.objectType (anti-flood trace)', () => {
  const center = { x: 0, y: 0, z: 0 };
  let touched = 0;
  const legacyItem = {
    name: 'item', displayName: 'Item', position: { x: 2, y: 0, z: 0 },
    get objectType () { touched++; throw new Error('getter déprécié touché'); },
  };
  const displayNameItem = {
    name: 'thing', type: null, displayName: 'Item', position: { x: 4, y: 0, z: 0 },
    get objectType () { touched++; throw new Error('getter déprécié touché'); },
  };
  const got = dropsWithin([legacyItem, displayNameItem], center, 16);
  assert.strictEqual(touched, 0, 'le getter objectType ne doit jamais être lu');
  assert.strictEqual(got.length, 2, 'les deux items sont détectés (name=item ET displayName=Item)');
});

// ─── Secure-then-warp (demande Massii 15/07) : sur les serveurs à teleport-delay (warmup ~5 s),
// le /home est ANNULÉ si le bot bouge ou prend un coup pendant l'attente → se mettre en sécurité
// AVANT de warper (pilier / se murer / flotter immobile), puis détecter warmup et annulation.

test('isTpWarmup : messages Essentials de warmup détectés, chat joueur ignoré', () => {
  assert.strictEqual(isTpWarmup('Teleportation will commence in 5 seconds. Don\'t move.'), true);
  assert.strictEqual(isTpWarmup('Teleportation commencing...'), true);
  assert.strictEqual(isTpWarmup('<Bob> dont move lol'), false);
  assert.strictEqual(isTpWarmup('You have been teleported'), false);
  assert.strictEqual(isTpWarmup(null), false);
});

test('isTpCancelled : annulation Essentials détectée', () => {
  assert.strictEqual(isTpCancelled('Pending teleportation request cancelled.'), true);
  assert.strictEqual(isTpCancelled('Teleportation cancelled.'), true);
  assert.strictEqual(isTpCancelled('<Bob> cancelled my order'), false);
  assert.strictEqual(isTpCancelled(''), false);
});

test('secureTactic : dans l\'eau → float (pas de pose fiable sous l\'eau)', () => {
  assert.strictEqual(secureTactic({ inWater: true, hostiles: 3, blocks: 10, headroom: true }), 'float');
});

test('secureTactic : PLUS JAMAIS de pilier, même avec du ciel au-dessus (Massii 2026-07-26)', () => {
  // « Ils ont toujours trop de difficulté à placer des blocs sous leurs pieds → en surface ils ne
  // construisent pas de pilier. » Se murer est la manœuvre humaine équivalente et elle ne
  // demande aucune pose sous les pieds.
  assert.strictEqual(secureTactic({ inWater: false, hostiles: 4, blocks: 12, headroom: true }), 'seal');
  assert.strictEqual(secureTactic({ inWater: false, hostiles: 1, blocks: 6, headroom: true }), 'seal');
});

test('secureTactic : pas assez de blocs pour se murer → none (jamais de repli en pilier)', () => {
  assert.strictEqual(secureTactic({ inWater: false, hostiles: 1, blocks: 3, headroom: true }), 'none');
});

test('secureTactic : hostiles sans headroom (plafond bas) → seal si assez de blocs', () => {
  assert.strictEqual(secureTactic({ inWater: false, hostiles: 2, blocks: 6, headroom: false }), 'seal');
});

test('secureTactic : pas de menace, ou pas de blocs → none (freeze simple)', () => {
  assert.strictEqual(secureTactic({ inWater: false, hostiles: 0, blocks: 20, headroom: true }), 'none');
  assert.strictEqual(secureTactic({ inWater: false, hostiles: 2, blocks: 2, headroom: true }), 'none');
  assert.strictEqual(secureTactic({}), 'none');
});

test('RESERVED contient canchor (ancre de confinement no-give)', () => {
  assert.ok(RESERVED.includes('canchor'));
});

const homewarp = require('./homewarp');   // acces nomme (le haut du fichier destructure)

// --- refus « demande de TP deja en attente » (mesure world_mn3 : 384 refus en 20 min) ----------
test('isTpAlreadyPending: le refus Essentials est reconnu', () => {
  assert.strictEqual(homewarp.isTpAlreadyPending('You have already sent NethBot1 a teleport request.'), true);
  assert.strictEqual(homewarp.isTpAlreadyPending('You have already sent Massitom2008 a teleport request'), true);
});

test('isTpAlreadyPending: ne confond pas avec les autres messages TP', () => {
  assert.strictEqual(homewarp.isTpAlreadyPending('Teleportation will commence in 3 seconds.'), false);
  assert.strictEqual(homewarp.isTpAlreadyPending('The teleport destination is unsafe and teleport-safety is disabled.'), false);
  assert.strictEqual(homewarp.isTpAlreadyPending('Teleportation request cancelled.'), false);
  assert.strictEqual(homewarp.isTpAlreadyPending(''), false);
  assert.strictEqual(homewarp.isTpAlreadyPending(null), false);
});

test('isTpAlreadyPending: chemin DISTINCT du refus de destination et de l_annulation', () => {
  const m = 'You have already sent NethBot1 a teleport request.';
  assert.strictEqual(homewarp.isTpRefusal(m), false);
  assert.strictEqual(homewarp.isTpCancelled(m), false);
});
