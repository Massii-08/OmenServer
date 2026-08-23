'use strict';
// GARDE-FOU CONTRE LA CLASSE DE BUG QUI A TUÉ LA PROD DEUX FOIS.
//
// `node -e "new Function(src)"` ne fait qu'un PARSE : il ne voit ni un require cassé, ni une
// référence de niveau module qui n'existe pas. Les deux se sont produits en production :
//   - 27/07 : index.js requérait ./wsiteDrown, jamais git-add → MODULE_NOT_FOUND, chaque spawn
//     frais crashait AVANT onSpawn (flotte en décroissance, aucune erreur applicative loggée) ;
//   - 26/07 (piège #56) : `panicInFlight` déclaré dans onSpawn mais lu au niveau module →
//     ReferenceError au 1er tick, 3 workers morts en boucle. 1153 tests étaient verts.
//
// Ce test CHARGE réellement index.js dans un process enfant, avec mineflayer stubbé pour que
// createBot lève tout de suite. Si le module s'évalue jusque-là, toutes les références de niveau
// module résolvent et tous les require existent. Process enfant = les intervals du bot ne
// polluent pas le runner.

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const LOADER = `
const Module = require('module');
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'mineflayer') {
    return { createBot: () => { const e = new Error('SMOKE_STOP'); e.smoke = true; throw e; } };
  }
  return orig.apply(this, arguments);
};
process.argv = [process.argv[0], 'index.js',
  '--host', '127.0.0.1', '--user', 'SmokeBot', '--no-give', '1', '--confine', '0 0 64'];
let verdict = 'FAIL: charge sans atteindre createBot';
try { require(${JSON.stringify(path.join(__dirname, 'index.js'))}); }
catch (e) { verdict = (e && e.smoke) ? 'OK' : 'FAIL: ' + (e && e.message); }
process.stdout.write(verdict);
process.exit(0);
`;

test('index.js se charge entierement : aucun require casse, aucune ReferenceError de module', () => {
  const out = execFileSync(process.execPath, ['-e', LOADER], {
    cwd: __dirname, encoding: 'utf8', timeout: 60000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  assert.strictEqual(out, 'OK', 'index.js n\'a pas pu etre charge : ' + out);
});

// --mc-version : la version protocole DOIT arriver jusqu'a mineflayer.createBot. Sans elle, la
// lib auto-detecte par un status-ping — que certains proxys (Aternos) coupent : le bot ne se
// connecte JAMAIS (ECONNRESET au boot). Meme machinerie que le smoke ci-dessus : on stubbe
// createBot, mais pour CAPTURER les options au lieu de lever tout de suite.
const OPTS_LOADER = (extraArgv) => `
const Module = require('module');
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'mineflayer') {
    return { createBot: (opts) => { const e = new Error('SMOKE_STOP'); e.smoke = true; e.opts = opts; throw e; } };
  }
  return orig.apply(this, arguments);
};
process.argv = [process.argv[0], 'index.js',
  '--host', '127.0.0.1', '--user', 'SmokeBot'${extraArgv}];
let out = 'FAIL: createBot jamais atteint';
try { require(${JSON.stringify(path.join(__dirname, 'index.js'))}); }
catch (e) { out = (e && e.smoke) ? JSON.stringify({ version: e.opts && e.opts.version, host: e.opts && e.opts.host }) : 'FAIL: ' + (e && e.message); }
process.stdout.write(out);
process.exit(0);
`;

const createBotOpts = (extraArgv) => JSON.parse(execFileSync(process.execPath, ['-e', OPTS_LOADER(extraArgv)], {
  cwd: __dirname, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
}).trim());

test('--mc-version force la version protocole passee a createBot', () => {
  const opts = createBotOpts(", '--mc-version', '1.21.11'");
  assert.strictEqual(opts.version, '1.21.11');
});

test('sans --mc-version : aucune version imposee (auto-detection, comportement historique)', () => {
  const opts = createBotOpts('');
  assert.strictEqual(opts.version, undefined);
  assert.strictEqual(opts.host, '127.0.0.1');   // le stub a bien vu de vraies options
});
