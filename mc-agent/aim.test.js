'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { aimSwingSteps, jitterLook, wrapRad, DEG } = require('./aim');

test('aimSwingSteps : atterrit EXACTEMENT sur la cible (dernier pas === to)', () => {
  const to = { yaw: 1.2, pitch: -0.3 };
  const steps = aimSwingSteps({ yaw: 0, pitch: 0 }, to, { rng: () => 0.5 });
  const last = steps[steps.length - 1];
  assert.strictEqual(last.yaw, to.yaw);
  assert.strictEqual(last.pitch, to.pitch);
});

test('aimSwingSteps : petit virage → 1 pas (pas de swing inutile)', () => {
  // 5° de virage, maxStepDeg 18 → 1 pas
  const to = { yaw: 5 * DEG, pitch: 0 };
  const steps = aimSwingSteps({ yaw: 0, pitch: 0 }, to, { maxStepDeg: 18 });
  assert.strictEqual(steps.length, 1);
  assert.strictEqual(steps[0].yaw, to.yaw);
});

test('aimSwingSteps : gros virage → plusieurs pas ∝ distance (swing humain)', () => {
  // 160° → ceil(160/18) = 9 pas
  const to = { yaw: 160 * DEG, pitch: 0 };
  const steps = aimSwingSteps({ yaw: 0, pitch: 0 }, to, { maxStepDeg: 18, jitterDeg: 0 });
  assert.strictEqual(steps.length, 9);
  // progression globale vers la cible
  assert.ok(steps[0].yaw < steps[4].yaw && steps[4].yaw < steps[8].yaw);
  assert.strictEqual(steps[8].yaw, to.yaw);
});

test('aimSwingSteps : jitter présent sur les pas intermédiaires (≠ interpolation lisse)', () => {
  const to = { yaw: 90 * DEG, pitch: 0 };
  const smooth = aimSwingSteps({ yaw: 0, pitch: 0 }, to, { jitterDeg: 0 });
  const jit = aimSwingSteps({ yaw: 0, pitch: 0 }, to, { jitterDeg: 5, rng: () => 0.9 });
  // au moins un pas intermédiaire diffère de l'interpolation lisse
  let diff = false;
  for (let i = 0; i < smooth.length - 1; i++) if (Math.abs(smooth[i].yaw - jit[i].yaw) > 1e-9) diff = true;
  assert.ok(diff, 'le jitter doit perturber le trajet');
  // mais l'atterrissage reste exact
  assert.strictEqual(jit[jit.length - 1].yaw, to.yaw);
});

test('aimSwingSteps : clipFrames réels utilisés pour le jitter (motricité humaine)', () => {
  const to = { yaw: 90 * DEG, pitch: 0 };
  const clipFrames = [{ dyaw: 10, dpitch: 2 }, { dyaw: -8, dpitch: 1 }];
  const steps = aimSwingSteps({ yaw: 0, pitch: 0 }, to, { clipFrames, maxStepDeg: 18 });
  // pas 0 = interpolation + dyaw clip (10°) ; interpolation 0→90 sur 5 pas → frac=1/5 → 18°, +10° = 28°
  const interp0 = 90 / 5; // deg
  assert.ok(Math.abs(steps[0].yaw / DEG - (interp0 + 10)) < 1e-6, 'clip dyaw appliqué au pas 0');
  assert.strictEqual(steps[steps.length - 1].yaw, to.yaw);
});

test('aimSwingSteps : wrap yaw → chemin le plus court (pas le tour complet)', () => {
  // de 170° à -170° : le chemin court = +20° (via 180), pas -340°
  const from = { yaw: 170 * DEG, pitch: 0 };
  const to = { yaw: -170 * DEG, pitch: 0 };
  const steps = aimSwingSteps(from, to, { jitterDeg: 0, maxStepDeg: 18 });
  // 20° → ceil(20/18)=2 pas ; court chemin → faible nombre de pas
  assert.ok(steps.length <= 2, 'wrap = chemin court (peu de pas)');
});

test('jitterLook : wobble borné par jitterDeg (cible dans la tolérance)', () => {
  const j = 2;
  for (let k = 0; k < 50; k++) {
    const r = jitterLook(1.0, 0.2, { jitterDeg: j, rng: Math.random });
    assert.ok(Math.abs(r.yaw - 1.0) <= j * DEG + 1e-9, 'yaw wobble ≤ jitterDeg');
    assert.ok(Math.abs(r.pitch - 0.2) <= j * DEG + 1e-9, 'pitch wobble ≤ jitterDeg');
  }
});

test('jitterLook : déplacement (moving) → wobble réduit (anti-misstep pathfinder)', () => {
  // rng=1 → décalage max +j ; moving doit donner 0.4× du still
  const still = jitterLook(0, 0, { jitterDeg: 10, moving: false, rng: () => 1 });
  const moving = jitterLook(0, 0, { jitterDeg: 10, moving: true, rng: () => 1 });
  assert.ok(Math.abs(moving.yaw) < Math.abs(still.yaw), 'moving wobble < still');
  assert.ok(Math.abs(Math.abs(moving.yaw) - 0.4 * Math.abs(still.yaw)) < 1e-9);
});

test('jitterLook : pitch clampé ±π/2', () => {
  const r = jitterLook(0, Math.PI / 2 - 0.001, { jitterDeg: 30, rng: () => 1 });
  assert.ok(r.pitch <= Math.PI / 2 + 1e-9);
});

test('jitterLook : jitterDeg=0 → identité (rétro-compat)', () => {
  const r = jitterLook(1.23, -0.45, { jitterDeg: 0 });
  assert.strictEqual(r.yaw, 1.23);
  assert.strictEqual(r.pitch, -0.45);
});

test('wrapRad : ramène dans [-π, π]', () => {
  assert.ok(Math.abs(wrapRad(3 * Math.PI) - Math.PI) < 1e-9 || Math.abs(wrapRad(3 * Math.PI) + Math.PI) < 1e-9);
  assert.ok(Math.abs(wrapRad(1.0) - 1.0) < 1e-9);
});
