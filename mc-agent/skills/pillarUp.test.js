'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { pillarUp, waitForApex } = require('./pillarUp');

test('waitForApex : critère HAUTEUR (dy≥0.9) accepté même si la vélocité ne redescend pas sous 0.05', async () => {
  let y = 64;
  const bot = { entity: { get position() { return { x: 0, y, z: 0 }; }, velocity: { y: 0.42 } } };
  const p = waitForApex(bot, { startY: 64, sleep: async () => { y += 0.3; }, timeoutMs: 1500, pollMs: 1 });
  assert.strictEqual(await p, true);
});

// Mesure live (21/10, NethBot3 session-64) : sous l'eau, `water_climb` échoue 8 fois sur 11 avec
// `placed:0, reason:place_failed` — deux cycles de 64s entiers gaspillés (piège dans l'esprit des
// #43/#48 : le modèle « saut parabolique » ne décrit pas la nage). En nageant, tenir jump ne donne
// PAS une impulsion puis une chute : c'est une ascension LENTE et CONTINUE (vy jamais > 0.1, donc le
// critère vélocité ne s'arme jamais) qui n'atteint le seuil HAUTEUR (0.9) qu'après plusieurs secondes.
test('waitForApex : ascension continue sous l\'eau (vy jamais >0.1) — un seuil hauteur réduit la détecte, 0.9 non', async () => {
  let y = 64;
  const bot = { entity: { get position() { return { x: 0, y, z: 0 }; }, velocity: { y: 0.04 } } };
  const risingSleep = (ms) => new Promise((r) => setTimeout(() => { y += 0.03; r(); }, ms));
  // 0.9 par défaut : hors de portée dans la fenêtre réaliste d'un pilier (~100ms de test, pollMs 10ms).
  const slow = await waitForApex(bot, { startY: 64, sleep: risingSleep, timeoutMs: 100, pollMs: 10 });
  assert.strictEqual(slow, false, 'le seuil 0.9 ne doit jamais être atteint à cette vitesse de nage');
  y = 64;
  const quick = await waitForApex(bot, { startY: 64, sleep: risingSleep, timeoutMs: 100, pollMs: 10, minDy: 0.2 });
  assert.strictEqual(quick, true, 'un seuil hauteur réduit (nage) doit détecter la montée');
});

test('pillarUp : sous l\'eau (isInWater), auto-détecte un seuil d\'apex réduit — sinon la pose n\'arrive jamais', async () => {
  const below = { boundingBox: 'block', position: { x: 0, y: 63, z: 0 }, name: 'stone' };
  // Chaque poll fait avancer la physique : montée lente et continue (0.03/poll), jamais de chute —
  // le profil mesuré en nage (contrairement au saut terrestre qui redescend après l'impulsion).
  function swimBot(isInWater) {
    let y = 64;
    const bot = {
      entity: {
        get position() {
          return { x: 0.5, y, z: 0.5, floored: () => ({ x: 0, y: Math.floor(y), z: 0, offset: (a, b, c) => ({ x: a, y: Math.floor(y) + b, z: c }) }) };
        },
        velocity: { y: 0.04 },   // ascension continue, jamais >0.1 : pas de pic de vélocité
        isInWater,
      },
      inventory: { items: () => [{ name: 'dirt', count: 5 }] },
      blockAt: (p) => (p.y === 63 ? below : { boundingBox: 'block', name: 'dirt', position: p }),
      equip: async () => {},
      lookAt: async () => {},
      setControlState: () => {},
      placeBlock: async () => { y += 1; },
    };
    const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
    bot._sleep = async (ms) => { await realSleep(ms); y += 0.03; };
    return bot;
  }
  const wet = swimBot(true);
  const underwater = await pillarUp(wet, { height: 1 }, null, { sleep: wet._sleep, pollMs: 10, apexTimeoutMs: 150 });
  assert.strictEqual(underwater.ok, true, 'sous l\'eau, la pose doit réussir avec le seuil réduit auto-détecté');
  const dry = swimBot(false);
  const onLandDefaults = await pillarUp(dry, { height: 1 }, null, { sleep: dry._sleep, pollMs: 10, apexTimeoutMs: 150 });
  assert.strictEqual(onLandDefaults.ok, false, 'hors de l\'eau, le même profil de vélocité lente reste sous le seuil normal (pas de régression)');
});

test('pillarUp : le JUMP reste TENU pendant la pose (coupé après) — sinon le bot retombe avant placeBlock', async () => {
  const ctl = { jump: false };
  let jumpAtPlace = null;
  let y = 64;
  const vys = [0.42, 0.3, 0.15, 0.04];
  let vyi = 0;
  const below = { boundingBox: 'block', position: { x: 0, y: 63, z: 0 }, name: 'stone' };
  const bot = {
    entity: {
      get position() {
        return { x: 0.5, y, z: 0.5, floored: () => ({ x: 0, y: Math.floor(y), z: 0, offset: (a, b, c) => ({ x: 0 + a, y: Math.floor(y) + b, z: 0 + c }) }) };
      },
      velocity: { get y() { return vys[Math.min(vyi++, vys.length - 1)]; } },
    },
    inventory: { items: () => [{ name: 'dirt', count: 5 }] },
    blockAt: (p) => (p.y === 63 ? below : { boundingBox: 'block', name: 'dirt', position: p }),
    equip: async () => {},
    lookAt: async () => {},
    setControlState: (k, v) => { ctl[k] = v; },
    placeBlock: async () => { jumpAtPlace = ctl.jump; y += 1; },
  };
  const r = await pillarUp(bot, { height: 1 }, null, { sleep: async () => {}, apexTimeoutMs: 200, pollMs: 1 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(jumpAtPlace, true, 'jump doit être TENU au moment du placeBlock');
  assert.strictEqual(ctl.jump, false, 'jump coupé après la pose');
});
