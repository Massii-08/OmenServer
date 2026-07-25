'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { fleeFrom } = require('../skills/fleeFrom');

function fakeBot({ threat = null } = {}) {
  const calls = { goals: [] };
  return {
    calls,
    entity: { position: { x: 0, y: 64, z: 0 } },
    nearestEntity(pred) { return (threat && pred(threat)) ? threat : null; },
    pathfinder: { setGoal(g, dyn) { calls.goals.push({ g, dyn }); } },
  };
}

test('fleeFrom pose un goal de fuite et retourne true si menace présente', () => {
  const creeper = { type: 'mob', name: 'creeper', position: { x: 2, y: 64, z: 0 } };
  const bot = fakeBot({ threat: creeper });
  assert.strictEqual(fleeFrom(bot), true);
  assert.strictEqual(bot.calls.goals.length, 1);
  // dynamic=false depuis le 25/07 : la destination de fuite est FIGÉE. En dynamique, le but se
  // recalculait sur une menace qui poursuit → course sans fin (et re-path permanent).
  assert.strictEqual(bot.calls.goals[0].dyn, false);
});

test('fleeFrom retourne false si aucune menace', () => {
  assert.strictEqual(fleeFrom(fakeBot({ threat: null })), false);
});

// --- paquet 2 : fuir les HOSTILES, jamais les passifs ---
test('fleeFrom IGNORE un passif (vache) → false, aucun goal posé', () => {
  const cow = { type: 'mob', name: 'cow', position: { x: 2, y: 64, z: 0 } };
  const bot = fakeBot({ threat: cow });
  assert.strictEqual(fleeFrom(bot), false);
  assert.strictEqual(bot.calls.goals.length, 0);
});
test('fleeFrom fuit un zombie (hostile mêlée connu)', () => {
  const zombie = { type: 'mob', name: 'zombie', position: { x: 2, y: 64, z: 0 } };
  assert.strictEqual(fleeFrom(fakeBot({ threat: zombie })), true);
});
test('fleeFrom fuit via kind=Hostile mobs (nom moddé inconnu)', () => {
  const mob = { type: 'mob', name: 'some_modded_mob', kind: 'Hostile mobs', position: { x: 2, y: 64, z: 0 } };
  assert.strictEqual(fleeFrom(fakeBot({ threat: mob })), true);
});

// ─── Destination de fuite CONCRÈTE (2e OOM live, world_ax4 25/07) ─────────────
// L'ancien `GoalInvert(GoalNear(menace,16))` faisait exploser l'A* jusqu'à l'OOM quand la fuite
// était impossible. Et le bornage `searchRadius` NE PEUT PAS le corriger : l'élagage d'astar.js
// est `g + h > maxCost`, or avec un but inversé h = -distance → s'éloigner d'un bloc ajoute 1 à g
// et retire 1 à h, la somme reste CONSTANTE, donc rien n'est jamais élagué. Le seul vrai fix est
// de viser une destination réelle : h devient positif et décroît, l'A* termine et se borne.
const { fleeTarget, FLEE_DIST } = require('../skills/fleeFrom');

test('fleeTarget : fuit à l\'OPPOSÉ de la menace, à FLEE_DIST blocs', () => {
  const t = fleeTarget({ x: 0, y: 64, z: 0 }, { x: 10, y: 64, z: 0 });   // menace à l'est
  assert.strictEqual(t.x, -FLEE_DIST);                                    // → on part à l'ouest
  assert.strictEqual(t.z, 0);
  assert.strictEqual(t.y, 64);
});

test('fleeTarget : direction diagonale normalisée (distance constante)', () => {
  const t = fleeTarget({ x: 0, y: 70, z: 0 }, { x: 3, y: 70, z: 4 });     // menace à 5 blocs
  assert.ok(Math.abs(Math.hypot(t.x, t.z) - FLEE_DIST) < 0.01, 'doit être à FLEE_DIST');
  assert.ok(t.x < 0 && t.z < 0, 'à l\'opposé sur les deux axes');
});

test('fleeTarget : menace sur la MÊME colonne → direction par défaut, jamais NaN', () => {
  const t = fleeTarget({ x: 5, y: 64, z: 5 }, { x: 5, y: 70, z: 5 });
  assert.ok(Number.isFinite(t.x) && Number.isFinite(t.z), 'pas de division par zéro');
  assert.ok(Math.abs(Math.hypot(t.x - 5, t.z - 5) - FLEE_DIST) < 0.01);
});

test('fleeTarget : entrées manquantes → null, jamais de crash', () => {
  assert.strictEqual(fleeTarget(null, { x: 1, y: 1, z: 1 }), null);
  assert.strictEqual(fleeTarget({ x: 1, y: 1, z: 1 }, null), null);
});

test('fleeFrom pose un but à DESTINATION (plus aucun GoalInvert)', () => {
  const skeleton = { type: 'mob', name: 'skeleton', position: { x: 10, y: 64, z: 0 } };
  const bot = fakeBot({ threat: skeleton });
  assert.strictEqual(fleeFrom(bot), true);
  const g = bot.calls.goals[0].g;
  assert.ok(!/Invert/i.test(g.constructor.name),
    `but inversé encore posé (${g.constructor.name}) — c'est le crash OOM`);
});
