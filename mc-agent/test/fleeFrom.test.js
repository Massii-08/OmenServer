'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { fleeFrom } = require('../skills/fleeFrom');

function fakeBot({ threat = null, pos = { x: 0, y: 64, z: 0 } } = {}) {
  const calls = { goals: [] };
  return {
    calls,
    entity: { position: pos },
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

// ─── But de fuite XZ : l'altitude à 20 blocs est INCONNUE (terrain vallonné) ─────────────────────
// `GoalNear(dest.x, from.y, dest.z, 2)` est une sphère 3D à l'altitude de DÉPART : sur une pente la
// surface à 20 blocs est 5-10 blocs plus haut/bas → but en l'air ou dans la roche → NoPath, et comme
// `fleeFrom` ne fait que `setGoal` (pas de goto à attendre) l'échec est SILENCIEUX : le bot reste
// planté sous les coups (mortalité hard). Même cause que les waypoints d'explore et la jambe de
// migration, même remède : GoalNearXZ (x,z seulement). Concret → heuristique positive et décroissante
// (A* fini, borné par applyPathfinderBounds), donc toujours aucun GoalInvert.
const { goals } = require('mineflayer-pathfinder');
const fs = require('node:fs');
const path = require('node:path');

// Relief jouet : surface = heightmap, marche à 4 voisins, dénivelé ≤ 1 par pas. BFS borné : vrai si un nœud
// satisfaisant `goal.isEnd` est ATTEIGNABLE depuis `start` (= « la fuite aboutit »). N'utilise que l'API
// publique des buts (isEnd), pas les internes de la lib.
function reachable(goal, height, start, maxNodes = 60000) {
  const seen = new Set([`${start.x},${start.z}`]);
  const q = [{ x: start.x, y: height(start.x, start.z), z: start.z }];
  for (let i = 0; i < q.length && i < maxNodes; i++) {
    const n = q[i];
    if (goal.isEnd(n)) return true;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = n.x + dx, z = n.z + dz, k = `${x},${z}`;
      if (seen.has(k)) continue;
      const y = height(x, z);
      if (Math.abs(y - n.y) > 1) continue;     // marche : pas plus d'un bloc de dénivelé
      seen.add(k);
      q.push({ x, y, z });
    }
  }
  return false;
}

test('fleeFrom : le but de fuite est XZ — aucune altitude inventée (rayon 2-3, dynamic=false, heuristique positive)', () => {
  const skeleton = { type: 'mob', name: 'skeleton', position: { x: 10, y: 64, z: 0 } };
  const bot = fakeBot({ threat: skeleton });                       // bot (0,64,0), menace à l'est → fuite à l'ouest
  assert.strictEqual(fleeFrom(bot), true);
  const { g, dyn } = bot.calls.goals[0];
  assert.strictEqual(dyn, false, 'destination figée (inchangé)');
  assert.ok(g instanceof goals.GoalNearXZ, `GoalNearXZ attendu, posé : ${g.constructor.name}`);
  assert.strictEqual(g.y, undefined, 'aucun y dans le but de fuite');
  assert.strictEqual(g.x, -FLEE_DIST);
  assert.strictEqual(g.z, 0);
  const r = Math.sqrt(g.rangeSq);
  assert.ok(r >= 2 && r <= 3, `rayon 2-3 (posé : ${r})`);
  // but CONCRET : heuristique positive et qui décroît en se rapprochant de la destination (A* fini)
  const hStart = g.heuristic({ x: 0, y: 64, z: 0 });
  const hHalf = g.heuristic({ x: -10, y: 64, z: 0 });
  assert.ok(hStart > hHalf && hHalf > 0, `h décroissante et > 0 (${hStart} > ${hHalf} > 0)`);
});

for (const [label, slope, threatX] of [
  ['colline : la fuite MONTE', 0.5, -10],          // menace à l'ouest → fuite à l'est, surface +10 blocs à x=+20
  ['vallée : la fuite DESCEND', 0.5, 10],          // menace à l'est → fuite à l'ouest, surface -10 blocs à x=-20
]) {
  test(`fleeFrom sur relief jouet (${label}) → la destination est ATTEIGNABLE ; l'ancien GoalNear 3D ne l'était pas`, () => {
    const height = (x) => Math.round(70 + slope * x);
    const start = { x: 0, z: 0 };
    const threat = { type: 'mob', name: 'zombie', position: { x: threatX, y: 70, z: 0 } };
    const bot = fakeBot({ threat, pos: { x: 0, y: 70, z: 0 } });
    assert.strictEqual(fleeFrom(bot), true);
    const g = bot.calls.goals[0].g;
    assert.strictEqual(reachable(g, height, start), true, 'le but posé par fleeFrom est atteignable sur la pente');
    // TÉMOIN : le relief est discriminant — l'ancien but (sphère 3D r=2 à l'altitude de départ) est
    // inatteignable ici, sinon ce test passerait aussi sur le code d'avant le fix.
    const dest = fleeTarget({ x: 0, y: 70, z: 0 }, threat.position);
    const old = new goals.GoalNear(dest.x, dest.y, dest.z, 2);
    assert.strictEqual(reachable(old, height, start), false, 'témoin : le but 3D d\'avant est inatteignable sur cette pente');
  });
}

test('fleeFrom sur terrain plat : toujours atteignable (pas de régression de la fuite de base)', () => {
  const threat = { type: 'mob', name: 'zombie', position: { x: -5, y: 70, z: 3 } };
  const bot = fakeBot({ threat, pos: { x: 0, y: 70, z: 0 } });
  assert.strictEqual(fleeFrom(bot), true);
  assert.strictEqual(reachable(bot.calls.goals[0].g, () => 70, { x: 0, z: 0 }), true);
});

// ─── Garde de câblage : fleeDeathCamp (index.js, fuite à PIED de 90 blocs) ────────────────────────
// index.js n'est pas importable (il démarre le bot) : comme test/movement_tempmoves.test.js, on lit la
// source. Même bug que fleeFrom : `GoalNear(tx, Math.round(fromPos.y), tz, 4)` = sphère 3D à l'altitude
// du camp de mort, inatteignable à 90 blocs sur relief → `withTimeout` avale le rejet, le bot reste dans
// le camp qu'il était censé fuir. (Précédent : la fuite « walk » de death_camp_escape vise déjà
// GoalNearXZ.)
test('index.js : fleeDeathCamp fuit en but XZ — plus aucun GoalNear 3D à l\'altitude du camp', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const m = src.match(/async function fleeDeathCamp\([\s\S]*?\n\}\n/);
  assert.ok(m, 'fleeDeathCamp introuvable dans index.js (renommée ? adapter ce garde)');
  const body = m[0];
  assert.ok(/new pfGoals\.GoalNearXZ\(\s*tx\s*,\s*tz\s*,/.test(body), 'la fuite à pied doit viser GoalNearXZ(tx, tz, r)');
  assert.ok(!/new pfGoals\.GoalNear\(/.test(body), 'aucun GoalNear 3D (y deviné) dans fleeDeathCamp');
});
