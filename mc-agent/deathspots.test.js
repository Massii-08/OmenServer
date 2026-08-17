'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  createDeathSpots, RADIUS, WINDOW_MS, TTL_MS, THRESHOLD, MAX_DEATHS, MAX_BANS,
} = require('./deathspots');

// Lieux de mort RÉPÉTÉE (chutes dans un ravin, morts ENVIRONNEMENTALES) — run réel : un bot mort
// 7 fois en 12 min AU MÊME ENDROIT. `_escapeOnSpawn` (index.js) éloigne au respawn, mais le
// planner re-cible ensuite la même zone (le chantier y est) → re-mort. Ces tests verrouillent la
// mémoire de session qui doit permettre aux électeurs de cible d'éviter le spot.

test('1 mort = pas de ban', () => {
  const ds = createDeathSpots({ now: () => 1000 });
  const r = ds.noteDeath(100, 64, -50);
  assert.equal(r.banned, false);
  assert.equal(r.newlyBanned, false);
  assert.equal(ds.isBanned(100, -50), false);
  assert.deepEqual(ds.spots(), []);
});

test('2 morts proches dans la fenêtre → ban (le run réel : 7 morts au même endroit)', () => {
  let t = 1000;
  const ds = createDeathSpots({ now: () => t });
  ds.noteDeath(100, 64, -50);
  t += 5 * 60 * 1000; // 5 min après, dans la fenêtre de 15 min
  const r = ds.noteDeath(108, 63, -46); // à 8,9 blocs — dans le rayon 16
  assert.equal(r.banned, true);
  assert.equal(r.newlyBanned, true);
  assert.equal(ds.isBanned(100, -50), true);
  assert.equal(ds.isBanned(108, -46), true);
  assert.equal(ds.spots().length, 1);
});

test('2 morts proches mais HORS fenêtre (>15 min) → pas de ban', () => {
  let t = 1000;
  const ds = createDeathSpots({ now: () => t });
  ds.noteDeath(100, 64, -50);
  t += WINDOW_MS + 1000; // juste après la fenêtre
  const r = ds.noteDeath(100, 64, -50);
  assert.equal(r.banned, false);
  assert.equal(r.newlyBanned, false);
  assert.equal(ds.isBanned(100, -50), false);
});

test('2 morts ÉLOIGNÉES (hors rayon) dans la fenêtre → pas de ban', () => {
  let t = 1000;
  const ds = createDeathSpots({ now: () => t });
  ds.noteDeath(0, 64, 0);
  t += 1000;
  const r = ds.noteDeath(0 + RADIUS + 1, 64, 0); // juste hors du rayon
  assert.equal(r.banned, false);
  assert.equal(ds.isBanned(0, 0), false);
  assert.equal(ds.isBanned(RADIUS + 1, 0), false);
});

test('bord exact du rayon → banni ; juste au-delà → pas banni', () => {
  let t = 1000;
  const ds = createDeathSpots({ now: () => t });
  ds.noteDeath(0, 64, 0);
  t += 1000;
  const rIn = ds.noteDeath(RADIUS, 64, 0); // exactement à RADIUS → <=RADIUS, doit bannir
  assert.equal(rIn.newlyBanned, true);

  t += 1000;
  const ds2 = createDeathSpots({ now: () => t });
  ds2.noteDeath(0, 64, 0);
  t += 1000;
  const rOut = ds2.noteDeath(RADIUS + 1, 64, 0); // juste hors rayon
  assert.equal(rOut.newlyBanned, false);
});

test('un ban expire après TTL (30 min) SANS nouvelle mort dedans', () => {
  let t = 1000;
  const ds = createDeathSpots({ now: () => t });
  ds.noteDeath(100, 64, -50);
  t += 1000;
  ds.noteDeath(105, 64, -50); // ban formé
  assert.equal(ds.isBanned(100, -50), true);

  t += TTL_MS + 1; // > 30 min sans nouvelle mort depuis la dernière (t+1000)
  assert.equal(ds.isBanned(100, -50), false);
  assert.deepEqual(ds.spots(), []);
});

test('une mort DANS un ban le RAFRAÎCHIT (repousse l\'expiration)', () => {
  let t = 1000;
  const ds = createDeathSpots({ now: () => t });
  ds.noteDeath(100, 64, -50);
  t += 1000;
  ds.noteDeath(105, 64, -50); // ban formé, lastDeathAt = 2000 ; sans rafraîchissement, expire à 2000+TTL_MS

  const refreshAt = 2000 + TTL_MS - 1000; // juste avant l'expiration du ban initial
  t = refreshAt;
  const refresh = ds.noteDeath(102, 64, -48); // nouvelle mort DANS le ban → rafraîchit
  assert.equal(refresh.banned, true);
  assert.equal(refresh.newlyBanned, false); // déjà banni, pas un nouvel événement

  // Juste APRÈS ce que l'expiration ORIGINALE (2000+TTL_MS) aurait été, mais toujours dans le
  // TTL du rafraîchissement (refreshAt+TTL_MS) : ne prouve le rafraîchissement que si le ban
  // est encore vivant ICI.
  t = 2000 + TTL_MS + 500;
  assert.equal(ds.isBanned(100, -50), true, 'le rafraîchissement a bien repoussé le TTL');

  // Et bien au-delà du TTL depuis le rafraîchissement (pas depuis la formation), il expire pour de bon.
  t = refreshAt + TTL_MS + 1;
  assert.equal(ds.isBanned(100, -50), false);
});

test('re-mort dans un ban déjà formé → banned=true mais newlyBanned=false (pas de double event)', () => {
  let t = 1000;
  const ds = createDeathSpots({ now: () => t });
  ds.noteDeath(0, 64, 0);
  t += 1000;
  const first = ds.noteDeath(5, 64, 0);
  assert.equal(first.newlyBanned, true);
  t += 1000;
  const second = ds.noteDeath(6, 64, 1);
  assert.equal(second.banned, true);
  assert.equal(second.newlyBanned, false);
  assert.equal(ds.spots().length, 1); // toujours UN seul spot, pas un doublon
});

test('coordonnées arrondies à l\'entier', () => {
  let t = 1000;
  const ds = createDeathSpots({ now: () => t });
  ds.noteDeath(100.6, 64.2, -50.4);
  const spots0 = ds.spots();
  assert.deepEqual(spots0, []); // 1 seule mort, rien à voir encore
  t += 1000;
  ds.noteDeath(100.4, 64.9, -49.6);
  const s = ds.spots();
  assert.equal(s.length, 1);
  assert.ok(Number.isInteger(s[0].x));
  assert.ok(Number.isInteger(s[0].z));
});

test('positions non finies ignorées (NaN/undefined/null) — jamais de pollution', () => {
  const ds = createDeathSpots({ now: () => 1000 });
  const r1 = ds.noteDeath(NaN, 64, 0);
  assert.equal(r1.ok, false);
  const r2 = ds.noteDeath(0, 64, undefined);
  assert.equal(r2.ok, false);
  const r3 = ds.noteDeath(null, 64, null);
  assert.equal(r3.ok, false);
  assert.deepEqual(ds.spots(), []);
  assert.equal(ds.isBanned(NaN, 0), false);
  assert.equal(ds.isBanned(0, undefined), false);
  assert.equal(ds.nearestBanDist(NaN, 0), Infinity);
});

test('Y est stocké/arrondi mais n\'entre PAS dans le clustering (XZ only)', () => {
  let t = 1000;
  const ds = createDeathSpots({ now: () => t });
  ds.noteDeath(100, 4, -50);   // chute au fond d'un ravin, y bas
  t += 1000;
  const r = ds.noteDeath(102, 70, -49); // même xz-ish, y TRÈS différent (remonté puis re-tombé)
  assert.equal(r.newlyBanned, true);
  assert.equal(ds.isBanned(100, -50), true);
});

test('nearestBanDist : Infinity sans ban ; distance réelle sinon, PAS gated par RADIUS', () => {
  let t = 1000;
  const ds = createDeathSpots({ now: () => t });
  assert.equal(ds.nearestBanDist(0, 0), Infinity);
  ds.noteDeath(0, 64, 0);
  t += 1000;
  ds.noteDeath(5, 64, 0); // ban formé, ancré à (5,0) [mort la plus récente]
  assert.equal(ds.nearestBanDist(5, 0), 0);
  // Un point loin du ban (bien au-delà de RADIUS) doit quand même rendre une distance FINIE —
  // c'est le point : les électeurs de cible veulent COMPARER des distances, pas juste un booléen.
  const far = ds.nearestBanDist(5 + RADIUS * 10, 0);
  assert.equal(far, RADIUS * 10);
  assert.ok(Number.isFinite(far));
});

test('spots() : deux morts éloignées forment DEUX bans séparés', () => {
  let t = 1000;
  const ds = createDeathSpots({ now: () => t });
  ds.noteDeath(0, 64, 0);
  t += 1000;
  ds.noteDeath(5, 64, 0); // ban A
  t += 1000;
  ds.noteDeath(1000, 64, 1000);
  t += 1000;
  ds.noteDeath(1005, 64, 1000); // ban B
  const spots = ds.spots();
  assert.equal(spots.length, 2);
});

test('spots() : forme de chaque entrée', () => {
  let t = 1000;
  const ds = createDeathSpots({ now: () => t });
  ds.noteDeath(0, 64, 0);
  t += 1000;
  ds.noteDeath(5, 64, 0);
  const [s] = ds.spots();
  assert.ok(Number.isFinite(s.x));
  assert.ok(Number.isFinite(s.z));
  assert.ok(Number.isFinite(s.bannedAt));
  assert.ok(Number.isFinite(s.lastDeathAt));
});

test('cap mémoire : 50 morts récentes max, la plus ancienne est évincée', () => {
  const ds = createDeathSpots({ now: () => 1000 }); // horloge figée : seul le CAP joue, jamais la fenêtre
  for (let i = 0; i < MAX_DEATHS; i++) {
    ds.noteDeath(i * 1000, 64, 0); // positions toutes éloignées : jamais dans le même rayon
  }
  ds.noteDeath(9999999, 64, 0); // 51e mort → pousse le cap, évince la mort n°0 (x=0)
  // Si x=0 a bien été évincée du journal, la revisiter est une mort ISOLÉE (aucune voisine
  // récente au même endroit) → pas de ban.
  const r = ds.noteDeath(0, 64, 0);
  assert.equal(r.newlyBanned, false);
  assert.equal(ds.isBanned(0, 0), false);
});

test('cap mémoire : 20 bans actifs max, le plus ancien est évincé', () => {
  const ds = createDeathSpots({ now: () => 1000 });
  for (let i = 0; i <= MAX_BANS; i++) { // MAX_BANS+1 = 21 clusters formés
    const bx = i * 1000; // clusters espacés, jamais dans le même rayon
    ds.noteDeath(bx, 64, 0);
    ds.noteDeath(bx + 5, 64, 0); // 2e mort proche → ban du cluster i, ANCRÉ ici (bx+5 = mort déclenchante)
  }
  const spots = ds.spots();
  assert.equal(spots.length, MAX_BANS);
  assert.ok(!spots.some((s) => s.x === 5), 'le tout premier ban (cluster 0, ancré à x=5) doit avoir été évincé');
  assert.ok(spots.some((s) => s.x === MAX_BANS * 1000 + 5), 'le ban le plus récent doit être conservé');
});

test('horloge par défaut = Date.now (fonctionne sans opts.now)', () => {
  const ds = createDeathSpots();
  const r = ds.noteDeath(1, 64, 1);
  assert.equal(r.ok, true);
  assert.equal(ds.isBanned(1, 1), false); // 1 seule mort
});

test('constantes exportées : RADIUS=16, WINDOW_MS=15 min, TTL_MS=30 min, THRESHOLD=2', () => {
  assert.equal(RADIUS, 16);
  assert.equal(WINDOW_MS, 15 * 60 * 1000);
  assert.equal(TTL_MS, 30 * 60 * 1000);
  assert.equal(THRESHOLD, 2);
});

test('deux instances createDeathSpots sont indépendantes (pas d\'état module partagé)', () => {
  let t = 1000;
  const a = createDeathSpots({ now: () => t });
  const b = createDeathSpots({ now: () => t });
  a.noteDeath(0, 64, 0);
  t += 1000;
  a.noteDeath(5, 64, 0);
  assert.equal(a.isBanned(0, 0), true);
  assert.equal(b.isBanned(0, 0), false);
  assert.deepEqual(b.spots(), []);
});
