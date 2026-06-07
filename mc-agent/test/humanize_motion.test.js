'use strict';
// Paquet 1 anti-tell : motricité/visée humaine + délai de réaction + munging de registre chat.
// Cibles calibrées sur les VRAIES captures (3 joueurs, 1,5M ticks) :
//   Δyaw/tick médian ≈ 0°, p90 ≈ 4.5°, p99 ≈ 27° (distribution à queue lourde) ;
//   latence chat médiane ≈ 3 s (étalée 0.4→47 s) ; figé ~50% du temps.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  sampleReactionDelay, nextLook, mungeChat, applyTypos, humanizeReply, sampleDelay,
} = require('../humanize');

function seqRng(values) { let i = 0; return () => values[i++ % values.length]; }
const DEG = Math.PI / 180;

// ── sampleReactionDelay : latence de réaction humaine (anti « 0 ms = aimbot ») ──────────────
test('sampleReactionDelay : entier, plancher humain (>=120ms), jamais instantané', () => {
  const d = sampleReactionDelay({}, seqRng([0.999999, 0.5])); // z très négatif → pousse vers le plancher
  assert.ok(Number.isInteger(d), 'entier');
  assert.ok(d >= 120, `delay ${d} < plancher 120ms (réflexe humain mini)`);
});

test('sampleReactionDelay : suit reaction.meanMs/stdMs des captures si fourni', () => {
  // mean élevé + rng médian → autour de la moyenne fournie (pas le défaut)
  const d = sampleReactionDelay({ reaction: { meanMs: 800, stdMs: 50 } }, seqRng([0.5, 0.5]));
  assert.ok(d > 400, `delay ${d} devrait refléter meanMs=800`);
});

test('sampleReactionDelay : borné en haut (mean + 3*std)', () => {
  const d = sampleReactionDelay({ reaction: { meanMs: 300, stdMs: 100 } }, seqRng([1e-9, 0])); // z très positif
  assert.ok(d <= 300 + 3 * 100, `delay ${d} dépasse la borne haute`);
});

// ── nextLook : visée en marche aléatoire bornée (anti snap-aim / tête figée) ─────────────────
test('nextLook : retourne {yaw,pitch} numériques, pitch clampé [-90°,90°]', () => {
  const r = nextLook({ yaw: 0, pitch: 0 }, { lookJitter: 0.3 }, seqRng([0.99, 0.99, 0.99, 0.99]));
  assert.ok(typeof r.yaw === 'number' && typeof r.pitch === 'number');
  assert.ok(r.pitch >= -Math.PI / 2 - 1e-9 && r.pitch <= Math.PI / 2 + 1e-9, `pitch ${r.pitch} hors bornes`);
});

test('nextLook : branche HOLD (rng bas) = micro-dérive (<2° de yaw)', () => {
  // p50 réel = 0° : la majorité des ticks la vue bouge à peine.
  const cur = { yaw: 1.0, pitch: 0.1 };
  const r = nextLook(cur, { lookJitter: 0.3 }, seqRng([0.1, 0.5, 0.5, 0.5]));
  const dyawDeg = Math.abs(r.yaw - cur.yaw) / DEG;
  assert.ok(dyawDeg < 2, `HOLD devrait être <2°, vu ${dyawDeg.toFixed(2)}°`);
});

test('nextLook : branche TURN (rng haut) = grand tour (>=10° de yaw) en mode actif', () => {
  const cur = { yaw: 0, pitch: 0 };
  const r = nextLook(cur, { lookJitter: 0.5 }, seqRng([0.97, 0.9, 0.8, 0.5]), { mode: 'active' });
  const dyawDeg = Math.abs(((r.yaw - cur.yaw + Math.PI) % (2 * Math.PI)) - Math.PI) / DEG;
  assert.ok(dyawDeg >= 10, `TURN devrait être >=10°, vu ${dyawDeg.toFixed(2)}°`);
});

test('nextLook : mode idle ne produit JAMAIS de grand tour (head-drift subtil only)', () => {
  // Massii déteste les « gestes bizarres » : idle = dérive de tête douce, pas de demi-tours.
  const cur = { yaw: 0, pitch: 0 };
  let maxDeg = 0;
  const rng = seqRng([0.99, 0.98, 0.97, 0.6, 0.3, 0.1, 0.95, 0.5, 0.85, 0.42]);
  for (let i = 0; i < 200; i++) {
    const r = nextLook(cur, { lookJitter: 0.3 }, rng, { mode: 'idle' });
    const dyawDeg = Math.abs(((r.yaw - cur.yaw + Math.PI) % (2 * Math.PI)) - Math.PI) / DEG;
    maxDeg = Math.max(maxDeg, dyawDeg);
    cur.yaw = r.yaw; cur.pitch = r.pitch;
  }
  assert.ok(maxDeg < 12, `idle ne doit pas tourner brusquement (<12°), vu ${maxDeg.toFixed(1)}°`);
});

test('nextLook : intensité 0 → quasi immobile (échelle minimale)', () => {
  const cur = { yaw: 0.5, pitch: 0 };
  const r = nextLook(cur, { lookJitter: 0 }, seqRng([0.1, 0.5, 0.5, 0.5]));
  const dyawDeg = Math.abs(r.yaw - cur.yaw) / DEG;
  assert.ok(dyawDeg < 1.5, `intensité 0 devrait être minimal, vu ${dyawDeg.toFixed(2)}°`);
});

// ── mungeChat : registre Minecraft réel (minuscules, pas de ponctuation finale) ──────────────
test('mungeChat : casual=0 ne touche à rien', () => {
  assert.strictEqual(mungeChat('Salut les amis.', { chat: { casual: 0 } }, seqRng([0.1])), 'Salut les amis.');
});

test('mungeChat : casual fort minuscule + retire le point final', () => {
  const out = mungeChat('Salut les amis.', { chat: { casual: 1 } }, seqRng([0.0, 0.0, 0.0]));
  assert.strictEqual(out, 'salut les amis');
});

test('mungeChat : ne détruit pas le contenu (mêmes mots, casse/ponctuation près)', () => {
  const out = mungeChat('ok je viens', { chat: { casual: 1 } }, seqRng([0.0, 0.0, 0.0]));
  assert.ok(/ok je viens/i.test(out));
});

// ── applyTypos : substitution clavier (en plus de l'omission/transposition existantes) ──────
test('applyTypos rate=0 inchangé (régression)', () => {
  assert.strictEqual(applyTypos('bonjour les amis', 0, Math.random), 'bonjour les amis');
});

test('applyTypos rate=1 modifie le texte (régression)', () => {
  assert.notStrictEqual(applyTypos('bonjour', 1, seqRng([0.0, 0.9])), 'bonjour');
});

// ── humanizeReply : latence dépendante de la longueur (temps de frappe) ─────────────────────
test('humanizeReply : un long message prend plus de temps qu\'un court (temps de frappe)', () => {
  const profile = { params: { chat: { latencyMeanMs: 500, latencyStdMs: 10, typoRate: 0, casual: 0 } } };
  const rng = () => 0.5; // déterministe identique pour les deux
  const short = humanizeReply(profile, 'ok', rng).delayMs;
  const long = humanizeReply(profile, 'ok je finis ce que je fais et j arrive vers toi', rng).delayMs;
  assert.ok(long > short, `long (${long}) devrait > court (${short}) — temps de frappe`);
});

test('humanizeReply : back-compat {text,delayMs}, plancher 80ms, profil null OK', () => {
  const r = humanizeReply(null, 'x', seqRng([0.5, 0.5, 0.5]));
  assert.ok(r.delayMs >= 80 && typeof r.text === 'string');
});
