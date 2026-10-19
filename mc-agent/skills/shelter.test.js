'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { roofPlan, shouldShelter } = require('./shelter');

test('roofPlan : bloc posable en poche → source inventory', () => {
  assert.strictEqual(roofPlan([{ name: 'dirt', count: 3 }], { hasPickaxe: false }).source, 'inventory');
});

test('roofPlan : rien en poche mais terrain minable → source mine', () => {
  assert.strictEqual(roofPlan([], { hasPickaxe: false, groundMineable: true }).source, 'mine');
});

test('roofPlan : rien en poche, pierre + pas de pioche → source none', () => {
  assert.strictEqual(roofPlan([{ name: 'stone_sword', count: 1 }], { hasPickaxe: false, groundMineable: false }).source, 'none');
});

test('shouldShelter : obscurité (light<=7) déclenche même y bas, sans dépendre de la nuit', () => {
  assert.strictEqual(shouldShelter({ night: false, lightLevel: 3, naked: true }).shelter, true);
});

test('shouldShelter : nuit + nu déclenche', () => {
  assert.strictEqual(shouldShelter({ night: true, lightLevel: null, naked: true }).shelter, true);
});

test('shouldShelter : jour + clair + équipé → non', () => {
  assert.strictEqual(shouldShelter({ night: false, lightLevel: 15, naked: false, lowHp: false, hostilesNear: false }).shelter, false);
});

test('shouldShelter : hostiles proches + nu (grotte) → déclenche même si light inconnu', () => {
  assert.strictEqual(shouldShelter({ night: false, lightLevel: null, naked: true, hostilesNear: true }).shelter, true);
});

// SOUS TERRE = jamais d'abri (Massii 16/07 : « du moment que les bots ressource sont sous terre
// pour miner, pas besoin de se cacher pour la nuit »). Piège vécu : sous terre il fait TOUJOURS
// sombre (lightLevel ≤7) et le mineur en chaîne armure est NU par définition → shouldShelter
// 'dark' le faisait s'enterrer 10-13 min en boucle DANS sa mine, où l'aube ne change rien.
test('shouldShelter : underground → jamais d\'abri, quel que soit le danger', () => {
  assert.deepStrictEqual(shouldShelter({ underground: true, night: true, naked: true }),
    { shelter: false, reason: 'underground' });
  assert.deepStrictEqual(shouldShelter({ underground: true, lightLevel: 0, lowHp: true }),
    { shelter: false, reason: 'underground' });
  assert.deepStrictEqual(shouldShelter({ underground: true, hostilesNear: true, naked: true }),
    { shelter: false, reason: 'underground' });
  assert.deepStrictEqual(shouldShelter({ underground: true, night: true, proactive: true }),
    { shelter: false, reason: 'underground' });
});

test('shouldShelter : en surface (underground false/absent) → comportements historiques inchangés', () => {
  assert.strictEqual(shouldShelter({ night: true, naked: true }).shelter, true);
  assert.strictEqual(shouldShelter({ underground: false, night: true, naked: true }).shelter, true);
  assert.strictEqual(shouldShelter({ lightLevel: 3, lowHp: true }).shelter, true);
  assert.strictEqual(shouldShelter({ night: false, naked: true }).shelter, false);
});

// ─── L'AUBE N'EST PAS LA FIN DES MONSTRES (live 19/10, spawn sous la canopée d'une vieille forêt) ──
// Mesuré en live : 14 des 17 morts des 10 dernières minutes sont « shot by Skeleton », avec toujours la
// même séquence : shelter dig_in → shelter dawn → shelter out → goal logs → reflex fight_ranged →
// reflex flee → take_cover placed:0 ok:false → mort. L'abri sortait dès que `isNight` devenait faux,
// sans regarder si les monstres de la nuit attendaient dehors. À l'ombre d'une canopée, zombies et
// squelettes NE BRÛLENT PAS au lever du jour : ils sont toujours là.
const {
  dawnExitDecision, DAWN_WAIT_MAX_MS, DAWN_WAIT_CHECK_MS, DAWN_WAIT_MIN_WORN,
} = require('./shelter');

test('dawnExitDecision : nu + hostiles présents + peu attendu → WAIT (rester dans l abri)', () => {
  assert.strictEqual(dawnExitDecision({ hostilesNear: 3, waitedMs: 0, worn: 0 }), 'wait');
  assert.strictEqual(dawnExitDecision({ hostilesNear: 1, waitedMs: 45000, worn: 1 }), 'wait');
});

test('dawnExitDecision : AUCUN hostile → GO (on sort tout de suite, comme avant)', () => {
  assert.strictEqual(dawnExitDecision({ hostilesNear: 0, waitedMs: 0, worn: 0 }), 'go');
  assert.strictEqual(dawnExitDecision({ hostilesNear: false, waitedMs: 0, worn: 0 }), 'go');
  assert.strictEqual(dawnExitDecision({ hostilesNear: undefined, waitedMs: 0, worn: 0 }), 'go');
  assert.strictEqual(dawnExitDecision({ hostilesNear: NaN, waitedMs: 0, worn: 0 }), 'go');
});

test('dawnExitDecision : ARMÉ (≥2 pièces) → GO même avec des hostiles dehors (un bot armé sort tout de suite)', () => {
  for (const worn of [2, 3, 4]) {
    assert.strictEqual(dawnExitDecision({ hostilesNear: 5, waitedMs: 0, worn }), 'go', `worn=${worn}`);
  }
});

test('dawnExitDecision : 1 pièce = encore nu (WAIT), 2 pièces = armé (GO) — le « nu » de caution/homes/spawn', () => {
  assert.strictEqual(DAWN_WAIT_MIN_WORN, 2);
  assert.strictEqual(dawnExitDecision({ hostilesNear: 2, waitedMs: 0, worn: 1 }), 'wait');
  assert.strictEqual(dawnExitDecision({ hostilesNear: 2, waitedMs: 0, worn: 2 }), 'go');
  // une seule définition du mot « nu » pour quatre gardes : si l une bouge, ce test le dit
  assert.strictEqual(DAWN_WAIT_MIN_WORN, require('../caution').CAUTION_MIN_WORN);
  assert.strictEqual(DAWN_WAIT_MIN_WORN, require('../homes').DEBT_MIN_WORN);
  assert.strictEqual(DAWN_WAIT_MIN_WORN, require('../unstuck').SPAWN_DANGER_MIN_WORN);
});

test('dawnExitDecision : borne DURE de 120 s — au-delà on sort quand même (vitesse : rien ne traîne)', () => {
  assert.strictEqual(DAWN_WAIT_MAX_MS, 120000);
  assert.strictEqual(dawnExitDecision({ hostilesNear: 4, waitedMs: 119999, worn: 0 }), 'wait');
  assert.strictEqual(dawnExitDecision({ hostilesNear: 4, waitedMs: 120000, worn: 0 }), 'go');
  assert.strictEqual(dawnExitDecision({ hostilesNear: 4, waitedMs: 600000, worn: 0 }), 'go');
});

test('dawnExitDecision : worn INCONNU (inventaire illisible) = nu — « 0 = prudent » (on attend, borné)', () => {
  for (const worn of [undefined, null, NaN, -2, 'x']) {
    assert.strictEqual(dawnExitDecision({ hostilesNear: 2, waitedMs: 0, worn }), 'wait', String(worn));
  }
});

test('dawnExitDecision : hostilesNear booléen accepté (true = au moins un)', () => {
  assert.strictEqual(dawnExitDecision({ hostilesNear: true, waitedMs: 0, worn: 0 }), 'wait');
});

test('dawnExitDecision : waitedMs absent/absurde = 0 ; borne et seuil injectables', () => {
  assert.strictEqual(dawnExitDecision({ hostilesNear: 2, worn: 0 }), 'wait');
  assert.strictEqual(dawnExitDecision({ hostilesNear: 2, waitedMs: NaN, worn: 0 }), 'wait');
  assert.strictEqual(dawnExitDecision({ hostilesNear: 2, waitedMs: 30000, worn: 0, maxMs: 30000 }), 'go');
  assert.strictEqual(dawnExitDecision({ hostilesNear: 2, waitedMs: 29999, worn: 0, maxMs: 30000 }), 'wait');
  assert.strictEqual(dawnExitDecision({ hostilesNear: 2, waitedMs: 0, worn: 3, minWorn: 4 }), 'wait');
});

test('dawnExitDecision : entrée absurde → GO (jamais de throw, jamais de blocage dans le trou)', () => {
  assert.strictEqual(dawnExitDecision(), 'go');
  assert.strictEqual(dawnExitDecision(null), 'go');
  assert.strictEqual(dawnExitDecision({}), 'go');
  assert.strictEqual(dawnExitDecision('x'), 'go');
});

test('DAWN_WAIT_CHECK_MS : on re-vérifie toutes les 3 s, et la borne est un multiple entier du pas', () => {
  assert.strictEqual(DAWN_WAIT_CHECK_MS, 3000);
  assert.strictEqual(DAWN_WAIT_MAX_MS % DAWN_WAIT_CHECK_MS, 0);
});
