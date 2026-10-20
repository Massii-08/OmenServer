'use strict';
// Home INEXISTANT côté serveur (20/10, NethBot1 sessions 309-313 : « Player has not set a home. » à
// chaque /home safe, bot emmuré à y 40 en boucle d'une session à l'autre).
const { test } = require('node:test');
const assert = require('node:assert');
const { goHome, goSpawn, isNoHomeSet, missingHome, refusedHome } = require('./homewarp');

const fakeBot = () => { const sent = []; return { sent, chat: (m) => sent.push(m) }; };

test('isNoHomeSet : message Essentials réel (log session 311) et variantes', () => {
  assert.strictEqual(isNoHomeSet('Player has not set a home.'), true);
  assert.strictEqual(isNoHomeSet('Error: Player has not set a home.'), true);
  assert.strictEqual(isNoHomeSet("Home safe doesn't exist!"), true);
  assert.strictEqual(isNoHomeSet('Home work does not exist'), true);
  assert.strictEqual(isNoHomeSet("Le joueur n'a pas défini de home."), true);
  assert.strictEqual(isNoHomeSet('Il giocatore non ha impostato una home.'), true);
  assert.strictEqual(isNoHomeSet('<Bob> j\'ai un home près du lac'), false);
  assert.strictEqual(isNoHomeSet('Teleporting...'), false);
  assert.strictEqual(isNoHomeSet(''), false);
  assert.strictEqual(isNoHomeSet(null), false);
});

test('missingHome : attribué au dernier /home envoyé, puis consommé', () => {
  const bot = fakeBot();
  goSpawn(bot);
  assert.strictEqual(missingHome(bot, 'Player has not set a home.'), 'safe');
  assert.strictEqual(missingHome(bot, 'Player has not set a home.'), null);
});

test('missingHome : /home work → work', () => {
  const bot = fakeBot();
  goHome(bot, 'work');
  assert.strictEqual(missingHome(bot, 'Player has not set a home.'), 'work');
});

test('missingHome : aucun /home récent → null (message non attribuable)', () => {
  const bot = fakeBot();
  assert.strictEqual(missingHome(bot, 'Player has not set a home.'), null);
  goSpawn(bot);
  bot._mcaLastHome.at -= 60000;
  assert.strictEqual(missingHome(bot, 'Player has not set a home.'), null);
});

test('missingHome ne consomme pas un refus TP (et inversement)', () => {
  const bot = fakeBot();
  goSpawn(bot);
  assert.strictEqual(missingHome(bot, 'The teleport destination is unsafe and teleport-safety is disabled.'), null);
  assert.strictEqual(refusedHome(bot, 'Player has not set a home.'), null);
  assert.strictEqual(missingHome(bot, 'Player has not set a home.'), 'safe');
});
