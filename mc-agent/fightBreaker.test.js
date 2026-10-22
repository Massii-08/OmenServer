'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fb = require('./fightBreaker');

test('engageAllowedByHp : groupe exige 18 PV, solo refuse sous 12', () => {
  assert.strictEqual(fb.engageAllowedByHp({ health: 14.12, hostiles: 2 }), false);   // signature live
  assert.strictEqual(fb.engageAllowedByHp({ health: 17.9, hostiles: 3 }), false);
  assert.strictEqual(fb.engageAllowedByHp({ health: 18, hostiles: 2 }), true);
  assert.strictEqual(fb.engageAllowedByHp({ health: 20, hostiles: 2 }), true);
  assert.strictEqual(fb.engageAllowedByHp({ health: 12, hostiles: 1 }), true);
  assert.strictEqual(fb.engageAllowedByHp({ health: 11.9, hostiles: 1 }), false);
  assert.strictEqual(fb.engageAllowedByHp({}), true);                                 // inconnu → autorisé
  assert.strictEqual(fb.engageAllowedByHp({ health: 5, hostiles: 0 }), true);
});

test('hpDrop : pic de la fenêtre de 4 s moins les PV actuels', () => {
  const s = [{ t: 0, hp: 20 }, { t: 2000, hp: 16 }, { t: 3500, hp: 14 }];
  assert.strictEqual(fb.hpDrop(s, 3500, 14), 6);
  assert.strictEqual(fb.hpDrop(s, 5000, 14), 2);       // le 20 de t=0 sort de la fenêtre
  assert.strictEqual(fb.hpDrop([], 100, 14), 0);
  assert.strictEqual(fb.hpDrop(s, 3500, 20), 0);       // pas de chute négative
});

test('shouldAbortFight : sous 10 PV ou chute ≥ 6, seulement en combat', () => {
  assert.strictEqual(fb.shouldAbortFight({ inFight: true, health: 9.9, drop: 0 }), 'floor');
  assert.strictEqual(fb.shouldAbortFight({ inFight: true, health: 14, drop: 6 }), 'drop');
  assert.strictEqual(fb.shouldAbortFight({ inFight: true, health: 14, drop: 5.9 }), null);
  assert.strictEqual(fb.shouldAbortFight({ inFight: false, health: 3, drop: 10 }), null);
});

test('isCornered : fuite ≥ 2 s sans bouger avec un assaillant collé, ou fuite impossible', () => {
  const fleePos = { x: 0, y: 64, z: 0 };
  assert.strictEqual(fb.isCornered({ fleePos, pos: { x: 0.5, y: 64, z: 0 }, sinceFleeMs: 2500, nearestDist: 2 }), true);
  assert.strictEqual(fb.isCornered({ fleePos, pos: { x: 5, y: 64, z: 0 }, sinceFleeMs: 2500, nearestDist: 2 }), false);
  assert.strictEqual(fb.isCornered({ fleePos, pos: fleePos, sinceFleeMs: 1000, nearestDist: 2 }), false);
  assert.strictEqual(fb.isCornered({ fleePos, pos: fleePos, sinceFleeMs: 3000, nearestDist: 8 }), false);
  assert.strictEqual(fb.isCornered({ fleeFailed: true, nearestDist: 2 }), true);
});

test('reengageAllowed : 8 s après un abandon, sauf acculé', () => {
  assert.strictEqual(fb.reengageAllowed({ now: 5000, abortedAt: 0 }), false);
  assert.strictEqual(fb.reengageAllowed({ now: 8000, abortedAt: 0 }), true);
  assert.strictEqual(fb.reengageAllowed({ now: 5000, abortedAt: 0, cornered: true }), true);
  assert.strictEqual(fb.reengageAllowed({ now: 5000 }), true);
});

test('breaker : la signature live (2 hostiles, 20→13 PV en 3 s) disjoncte', () => {
  const b = fb.createFightBreaker();
  b.sample(20, 0); b.sample(17, 1500); b.sample(13, 3000);
  const r = b.check({ inFight: true, health: 13, t: 3000 });
  assert.strictEqual(r.abort, true);
  assert.strictEqual(r.reason, 'drop');
  assert.strictEqual(r.drop, 7);
  // hors combat : rien
  assert.strictEqual(b.check({ inFight: false, health: 13, t: 3000 }).abort, false);
});

test('breaker : après abandon, refus 8 s puis permis ; anti-rafale 1 s', () => {
  const b = fb.createFightBreaker();
  const pos = { x: 0, y: 64, z: 0 };
  b.sample(9, 0);
  assert.strictEqual(b.check({ inFight: true, health: 9, t: 0 }).abort, true);
  b.noteAbort({ t: 0, pos, fleeOk: true });
  assert.strictEqual(b.check({ inFight: true, health: 9, t: 500 }).abort, false);   // anti-rafale
  // le bot a fui (bougé de 10 blocs) : refus pendant le délai
  const far = { x: 10, y: 64, z: 0 };
  assert.deepStrictEqual(b.canEngage({ t: 4000, pos: far, health: 20, hostiles: 1, nearestDist: 2 }).ok, false);
  assert.strictEqual(b.canEngage({ t: 4000, pos: far, health: 20, hostiles: 1, nearestDist: 2 }).reason, 'cooldown');
  assert.strictEqual(b.canEngage({ t: 8000, pos: far, health: 20, hostiles: 1, nearestDist: 2 }).ok, true);
});

test('breaker : acculé (fuite immobile 2 s, mob collé) → ré-engagement permis et pas re-disjoncté', () => {
  const b = fb.createFightBreaker();
  const pos = { x: 0, y: -6, z: 0 };
  b.noteAbort({ t: 0, pos, fleeOk: true });
  const r = b.canEngage({ t: 2500, pos: { x: 0.3, y: -6, z: 0 }, health: 8, hostiles: 2, nearestDist: 1.5 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.cornered, true);
  b.sample(8, 2500);
  assert.strictEqual(b.check({ inFight: true, health: 6, t: 3000 }).abort, false);      // combat acculé tenu
  assert.strictEqual(b.check({ inFight: true, health: 6, t: 11000 }).abort, true);      // délai écoulé
});

test('breaker : la position copiée ne suit pas un Vec3 muté en place', () => {
  const b = fb.createFightBreaker();
  const live = { x: 0, y: 64, z: 0 };
  b.noteAbort({ t: 0, pos: live, fleeOk: true });
  live.x = 12;   // le paquet serveur mute la position
  const r = b.canEngage({ t: 3000, pos: live, health: 20, hostiles: 1, nearestDist: 2 });
  assert.strictEqual(r.cornered, false);   // il a bien bougé de 12 blocs
});

test('breaker : refus HP répétés ne redémarrent pas la fuite (acculé détectable)', () => {
  const b = fb.createFightBreaker();
  const pos = { x: 0, y: 64, z: 0 };
  b.noteFlee({ t: 0, pos, fleeOk: true });
  b.noteFlee({ t: 1500, pos, fleeOk: true });
  const r = b.canEngage({ t: 2200, pos, health: 14, hostiles: 2, nearestDist: 2 });
  assert.strictEqual(r.cornered, true);
  assert.strictEqual(r.ok, true);
});

test('breaker : refus HP sans abandon préalable', () => {
  const b = fb.createFightBreaker();
  const r = b.canEngage({ t: 0, pos: { x: 0, y: 0, z: 0 }, health: 14.12, hostiles: 2, nearestDist: 4 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'low_hp');
});

test('breaker : fuite impossible (fleeOk false) → acculé tout de suite si collé', () => {
  const b = fb.createFightBreaker();
  b.noteAbort({ t: 0, pos: { x: 0, y: 0, z: 0 }, fleeOk: false });
  const b2 = fb.createFightBreaker();
  b2.noteAbort({ t: 0, pos: { x: 0, y: 0, z: 0 }, fleeOk: false });
  // assaillant pas au contact : pas acculé, le délai tient
  assert.strictEqual(b2.canEngage({ t: 100, pos: { x: 0, y: 0, z: 0 }, health: 9, hostiles: 2, nearestDist: 6 }).ok, false);
  assert.strictEqual(b.canEngage({ t: 100, pos: { x: 0, y: 0, z: 0 }, health: 9, hostiles: 2, nearestDist: 2 }).ok, true);
});

// ─── FUITE PERDUE (live 22/10) : un seul zombie, la fuite coûte 13,6 → 9,2 → 4,8 PV ──────────────
test('fleeLosing : un seul hostile au contact, ≥ 2 PV perdus en fuyant depuis ≥ 1 s → perdue', () => {
  const { fleeLosing } = require('./fightBreaker');
  assert.strictEqual(fleeLosing({ fleeHp: 13.6, health: 9.2, sinceFleeMs: 1500, nearestDist: 1.8, hostiles: 1 }), true);
  assert.strictEqual(fleeLosing({ fleeHp: 13.6, health: 13, sinceFleeMs: 3000, nearestDist: 1.8, hostiles: 1 }), false, 'la fuite tient');
  assert.strictEqual(fleeLosing({ fleeHp: 13.6, health: 9.2, sinceFleeMs: 1500, nearestDist: 6, hostiles: 1 }), false, 'décroché');
  assert.strictEqual(fleeLosing({ fleeHp: 13.6, health: 9.2, sinceFleeMs: 1500, nearestDist: 1.8, hostiles: 2 }), false, 'groupe : jamais');
  assert.strictEqual(fleeLosing({ fleeHp: 13.6, health: 9.2, sinceFleeMs: 400, nearestDist: 1.8, hostiles: 1 }), false, 'trop tôt');
  assert.strictEqual(fleeLosing({ fleeHp: null, health: 9.2, sinceFleeMs: 1500, nearestDist: 1.8, hostiles: 1 }), false, 'PV de départ inconnus');
});

test('canEngage : refus low_hp, fuite qui BOUGE mais se fait frapper → combat autorisé (outrun_failed)', () => {
  const { createFightBreaker } = require('./fightBreaker');
  const fb = createFightBreaker();
  const t0 = 100000;
  let g = fb.canEngage({ t: t0, pos: { x: 0, y: 64, z: 0 }, health: 9.2, hostiles: 1, nearestDist: 2 });
  assert.strictEqual(g.reason, 'low_hp');
  fb.noteFlee({ t: t0, pos: { x: 0, y: 64, z: 0 }, fleeOk: true, health: 9.2 });
  // 1,5 s plus tard : 5 blocs parcourus (pas « acculé » au sens du surplace), zombie toujours collé, PV 4,8
  g = fb.canEngage({ t: t0 + 1500, pos: { x: 5, y: 64, z: 0 }, health: 4.8, hostiles: 1, nearestDist: 1.6 });
  assert.deepStrictEqual(g, { ok: true, cornered: true, reason: 'outrun_failed' });
  // et le disjoncteur ne relâche pas aussitôt ce combat de dernier recours
  assert.strictEqual(fb.check({ inFight: true, health: 4.8, t: t0 + 1600 }).abort, false);
});

test('canEngage : la fuite DÉCROCHE (PV stables) → toujours refusé low_hp', () => {
  const { createFightBreaker } = require('./fightBreaker');
  const fb = createFightBreaker();
  const t0 = 100000;
  fb.canEngage({ t: t0, pos: { x: 0, y: 64, z: 0 }, health: 9.2, hostiles: 1, nearestDist: 2 });
  fb.noteFlee({ t: t0, pos: { x: 0, y: 64, z: 0 }, fleeOk: true, health: 9.2 });
  const g = fb.canEngage({ t: t0 + 1500, pos: { x: 5, y: 64, z: 0 }, health: 9.2, hostiles: 1, nearestDist: 3 });
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.reason, 'low_hp');
});
