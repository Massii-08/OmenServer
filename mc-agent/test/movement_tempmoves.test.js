'use strict';
// TEMP MOVEMENTS — le bug raconté court (RÉCIT CORRIGÉ le 18/08 après vérification DANS la lib :
// `mineflayer-pathfinder` v2.4.5 EXPOSE bien un getter `movements` — Object.defineProperties,
// node_modules/mineflayer-pathfinder/index.js:104-115 — la première version de ce commentaire
// affirmait le contraire sur la foi d'un rapport d'agent non vérifié). Le VRAI bug des deux
// sites d'index.js (`migrationLegTo`, `mineExposed`) était la DÉSYNCHRONISATION de
// `bot._mcaMoves` : pendant la fenêtre de Movements temporaire, cette référence — que le
// sprint-curb (tick 150 ms) mute en continu pour couper `allowSprinting` sous la faim —
// pointait l'objet INACTIF posé au spawn ; la coupe de sprint restait donc sans effet
// pendant chaque jambe de migration / cave-first (60-90 s).
//
// Ce fichier verrouille le contrat du helper de remplacement (`withTempMovements`, movement.js) :
// héritage de l'état COURANT (`bot._mcaMoves`, pas un instantané figé), tweaks qui écrasent
// l'hérité, restauration systématique (succès, échec, ou même si la restauration elle-même
// explose), et exécution de `fn` même quand poser la temp a échoué. Le dernier test verrouille
// qu'index.js ne réintroduit jamais le pattern cassé (`bot.pathfinder.movements`) et que les 2
// sites connus passent bien par le helper.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withTempMovements } = require('../movement');

// Faux constructeur Movements — PAS mineflayer : on ne teste QUE le contrat du helper (héritage,
// tweaks, restauration), pas le comportement réel de mineflayer-pathfinder.
function FakeMovements(bot) {
  this.builtFor = bot;
  this.canDig = true;
  this.placeCost = 1;
}

// Faux bot : `_mcaMoves` = la config nominale posée à la connexion, `pathfinder.setMovements`
// journalise chaque pose dans `calls` (dans l'ordre : [0] = temp posée, [dernier] = restauration).
function makeBot(mcaMoves) {
  const calls = [];
  return {
    _mcaMoves: mcaMoves,
    pathfinder: { setMovements: (m) => calls.push(m) },
    calls,
  };
}

// ─── Héritage de l'état courant + les tweaks écrasent ──────────────────────────────────────────

test('la temp herite de bot._mcaMoves (etat COURANT, pas un instantane fige) puis les tweaks ecrasent', async () => {
  // C'est LE test qui échouait avec l'ancien pattern inline : `Object.assign(surf, undefined)`
  // est un no-op → aucun des réglages maison (placeCost/liquidCost/allowSprinting) n'était hérité.
  const mcaMoves = { placeCost: 6, liquidCost: 20, allowSprinting: false, canDig: true };
  const bot = makeBot(mcaMoves);
  await withTempMovements(bot, FakeMovements, { canDig: false }, async () => {});
  assert.strictEqual(bot.calls.length >= 1, true);
  const temp = bot.calls[0];
  assert.strictEqual(temp.placeCost, 6);
  assert.strictEqual(temp.liquidCost, 20);
  assert.strictEqual(temp.allowSprinting, false);
  assert.strictEqual(temp.canDig, false);   // le tweak écrase l'hérité (mcaMoves avait canDig:true)
});

// ─── Restauration après succès ──────────────────────────────────────────────────────────────────

test('apres succes de fn, la DERNIERE Movements posee est bien _mcaMoves (restauration reelle)', async () => {
  const mcaMoves = { placeCost: 6 };
  const bot = makeBot(mcaMoves);
  await withTempMovements(bot, FakeMovements, {}, async () => {});
  assert.strictEqual(bot.calls.length, 2);   // [0] temp posée, [1] restauration
  assert.strictEqual(bot.calls[bot.calls.length - 1], bot._mcaMoves);   // identité (===), pas une copie
});

// ─── Restauration après throw ───────────────────────────────────────────────────────────────────

test('meme si fn rejette, la restauration a lieu ET l erreur se propage (le call site a son propre catch)', async () => {
  const mcaMoves = { placeCost: 6 };
  const bot = makeBot(mcaMoves);
  await assert.rejects(
    withTempMovements(bot, FakeMovements, {}, async () => { throw new Error('boom'); }),
    /boom/
  );
  assert.strictEqual(bot.calls[bot.calls.length - 1], bot._mcaMoves);
});

// ─── La valeur de retour de fn traverse le helper ──────────────────────────────────────────────

test('le retour de fn est retourne par le helper', async () => {
  const bot = makeBot({ placeCost: 6 });
  const result = await withTempMovements(bot, FakeMovements, {}, async () => 42);
  assert.strictEqual(result, 42);
});

// ─── _mcaMoves absent (bot pas encore configure a la connexion) ───────────────────────────────

test('_mcaMoves absent : fn tourne quand meme, une SEULE pose (aucune restauration fantome, pas de crash)', async () => {
  const bot = makeBot(undefined);
  let ran = false;
  await withTempMovements(bot, FakeMovements, { canDig: false }, async () => { ran = true; });
  assert.strictEqual(ran, true);
  assert.strictEqual(bot.calls.length, 1);   // la temp seulement — pas de 2e pose avec `undefined`
});

// ─── setMovements qui explose a la restauration ────────────────────────────────────────────────

test('setMovements qui throw a la restauration n empeche pas le retour de fn de survivre (pas de crash)', async () => {
  const mcaMoves = { placeCost: 6 };
  let n = 0;
  const bot = {
    _mcaMoves: mcaMoves,
    pathfinder: {
      setMovements: () => {
        n += 1;
        if (n === 2) throw new Error('setMovements explose a la restauration');
      },
    },
  };
  const result = await withTempMovements(bot, FakeMovements, {}, async () => 'ok');
  assert.strictEqual(result, 'ok');   // l'erreur de restauration est avalée, le retour de fn survit
});

// ─── Pin anti-régression sur index.js ──────────────────────────────────────────────────────────

test('index.js ne lit plus JAMAIS bot.pathfinder.movements (propriete qui n existe pas dans la lib -> undefined garanti)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.strictEqual(/\.pathfinder\.movements\b/.test(src), false);
});

test('les sites connus (migrationLegTo + mineExposed) passent bien par le helper restaurateur', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const matches = src.match(/withTempMovements\(bot/g) || [];
  assert.strictEqual(matches.length >= 2, true);
});

// ─── Synchro `_mcaMoves` (le VRAI bug, ajouté 18/08) : la référence suit l'ACTIVE, toujours ────

test('pendant fn, bot._mcaMoves EST la temporaire (le sprint-curb mute l objet actif)', async () => {
  const mcaMoves = { placeCost: 6, allowSprinting: true };
  const bot = makeBot(mcaMoves);
  let seenDuring = null;
  await withTempMovements(bot, FakeMovements, { canDig: false }, async () => { seenDuring = bot._mcaMoves; });
  assert.strictEqual(seenDuring, bot.calls[0]);        // identité avec la temp posée
  assert.notStrictEqual(seenDuring, mcaMoves);         // pas l'objet inactif du spawn
});

test('apres fn, bot._mcaMoves redevient la nominale (identite ===)', async () => {
  const mcaMoves = { placeCost: 6 };
  const bot = makeBot(mcaMoves);
  await withTempMovements(bot, FakeMovements, {}, async () => {});
  assert.strictEqual(bot._mcaMoves, mcaMoves);
});

test('sans _mcaMoves prealable (pas de prev), la temp posee reste refletee apres fn', async () => {
  const bot = makeBot(undefined);
  await withTempMovements(bot, FakeMovements, { canDig: false }, async () => {});
  // pas de restauration possible (prev absent) : la temp reste l'active, _mcaMoves la reflète
  assert.strictEqual(bot._mcaMoves, bot.calls[0]);
});
