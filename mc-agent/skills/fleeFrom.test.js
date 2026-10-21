'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Vec3 } = require('vec3');
const F = require('./fleeFrom');

const me = { x: 0, y: 70, z: 0 };
const sk = { x: 0, y: 70, z: -14 };   // squelette au nord
const away = (d) => Math.hypot(d.x - sk.x, d.z - sk.z);

test('rangedFleeTarget : sans couvert → cap en BIAIS (60°), jamais plein dos dans l\'axe du tir', () => {
  const d = F.rangedFleeTarget(me, sk, { losBlocked: () => false });
  assert.strictEqual(d.angle, 60);
  assert.strictEqual(d.covered, false);
  assert.ok(away(d) > away(me), 'on s\'éloigne quand même');
  assert.ok(Math.abs(d.x) > 5, 'décalé latéralement');
});

test('rangedFleeTarget : un cap dont l\'arrivée est HORS de vue est préféré', () => {
  // seul le cap -90° (vers -x) passe derrière un mur
  const d = F.rangedFleeTarget(me, sk, { losBlocked: (a, b) => b.x < -15 });
  assert.strictEqual(d.covered, true);
  assert.ok(d.x < -15);
});

test('rangedFleeTarget : écarte un cap qui finit dans les bras d\'un zombie', () => {
  const free = F.rangedFleeTarget(me, sk, { losBlocked: () => false });
  const d = F.rangedFleeTarget(me, sk, { losBlocked: () => false, melee: [{ x: free.x, z: free.z }] });
  assert.notStrictEqual(d.angle, free.angle);
});

test('losBlockedOnWorld : bloc plein sur le segment → vrai ; air → faux', () => {
  const wall = { blockAt: (p) => ({ boundingBox: p.x === 2 ? 'block' : 'empty' }) };
  assert.strictEqual(F.losBlockedOnWorld(wall, { x: 0.5, y: 71, z: 0.5 }, { x: 5.5, y: 71, z: 0.5 }), true);
  const open = { blockAt: () => ({ boundingBox: 'empty' }) };
  assert.strictEqual(F.losBlockedOnWorld(open, { x: 0.5, y: 71, z: 0.5 }, { x: 5.5, y: 71, z: 0.5 }), false);
});

test('fleeFrom : squelette à portée → but XZ en biais (pas dans l\'axe) ; zombie seul → fuite historique plein dos', () => {
  const mk = (ents) => {
    const goals = [];
    const pos = new Vec3(0, 70, 0);
    const bot = {
      entity: { position: pos },
      entities: Object.fromEntries(ents.map((e, i) => [i, e])),
      nearestEntity: (f) => ents.filter(f).sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))[0] || null,
      blockAt: () => ({ boundingBox: 'empty' }),
      pathfinder: { setGoal: (g) => goals.push(g) },
    };
    return { bot, goals };
  };
  const a = mk([{ name: 'skeleton', kind: 'Hostile mobs', position: new Vec3(0, 70, -14) }]);
  assert.strictEqual(F.fleeFrom(a.bot), true);
  assert.ok(Math.abs(a.goals[0].x) > 5, 'cap décalé latéralement');
  const b = mk([{ name: 'zombie', kind: 'Hostile mobs', position: new Vec3(0, 70, -5) }]);
  F.fleeFrom(b.bot);
  assert.ok(Math.abs(b.goals[0].x) < 1e-6 && b.goals[0].z > 10, 'plein dos face à la mêlée seule');
});
