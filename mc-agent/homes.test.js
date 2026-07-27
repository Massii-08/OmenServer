'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  HOME_SAFE, HOME_WORK, HOME_DEATH, HOMES, LEGACY_HOMES,
  canBookmarkDeath, openDebt, debtAction, DEBT_TTL_MS,
} = require('./homes');

// ─── Le contrat des 3 noms ──────────────────────────────────────────────────────────────────────

test('les 3 homes sont exactement safe/work/death', () => {
  assert.deepStrictEqual(HOMES, ['safe', 'work', 'death']);
  assert.strictEqual(HOME_SAFE, 'safe');
  assert.strictEqual(HOME_WORK, 'work');
  assert.strictEqual(HOME_DEATH, 'death');
});

test('le serveur limite a 3 homes : on ne depasse jamais la limite', () => {
  assert.ok(HOMES.length <= 3, 'sethome-multiple.default = 3 sur le serveur');
});

test('les anciens noms sont listes pour le menage au boot', () => {
  assert.deepStrictEqual(LEGACY_HOMES, ['canchor', 'wsite']);
});

test('aucun nom legacy ne survit dans les noms actifs', () => {
  for (const l of LEGACY_HOMES) assert.ok(!HOMES.includes(l), l + ' ne doit plus etre actif');
});

// ─── Garde lave sur la pose du home death ───────────────────────────────────────────────────────

test('death : pose refusee si le bloc aux pieds est de la lave', () => {
  assert.strictEqual(canBookmarkDeath({ feet: 'lava', below: 'stone' }), false);
});

test('death : pose refusee si le bloc dessous est de la lave', () => {
  assert.strictEqual(canBookmarkDeath({ feet: 'air', below: 'lava' }), false);
});

test('death : pose refusee sur la lave qui coule', () => {
  assert.strictEqual(canBookmarkDeath({ feet: 'flowing_lava', below: 'stone' }), false);
});

test('death : pose acceptee en terrain normal', () => {
  assert.strictEqual(canBookmarkDeath({ feet: 'air', below: 'stone' }), true);
});

test('death : pose acceptee dans l eau (on peut y revenir ramasser)', () => {
  assert.strictEqual(canBookmarkDeath({ feet: 'water', below: 'sand' }), true);
});

test('death : blocs inconnus (registry pas pret) => pose autorisee, on ne bloque pas', () => {
  assert.strictEqual(canBookmarkDeath({}), true);
  assert.strictEqual(canBookmarkDeath({ feet: null, below: undefined }), true);
});

// ─── Cycle de vie de la dette de mort ───────────────────────────────────────────────────────────

test('openDebt fige la position et l horodatage', () => {
  const d = openDebt({ x: 1.7, y: 63.2, z: -4.9 }, 1000);
  assert.strictEqual(d.x, 2);
  assert.strictEqual(d.y, 63);
  assert.strictEqual(d.z, -5);
  assert.strictEqual(d.at, 1000);
});

test('openDebt refuse une position absente', () => {
  assert.strictEqual(openDebt(null, 1000), null);
});

test('pas de dette => rien a faire', () => {
  assert.strictEqual(debtAction({ debt: null, now: 0 }).act, 'none');
});

test('dette fraiche, pas encore sur place => on y retourne', () => {
  const d = openDebt({ x: 0, y: 64, z: 0 }, 0);
  assert.strictEqual(debtAction({ debt: d, now: 5000 }).act, 'recover');
});

// Massii : « il ne supprime ce home qu une fois TOUT le loot recupere — sinon il revient encore
// et encore, meme s il meurt en continu. » => tant qu il reste un drop, on NE leve PAS la dette.
test('arrive sur place mais il reste des drops => on retourne encore (dette maintenue)', () => {
  const d = openDebt({ x: 0, y: 64, z: 0 }, 0);
  const r = debtAction({ debt: d, now: 60000, arrived: true, dropsLeft: 3 });
  assert.strictEqual(r.act, 'recover');
  assert.strictEqual(r.reason, 'drops_left');
});

test('arrive sur place et plus aucun drop => dette levee, delhome', () => {
  const d = openDebt({ x: 0, y: 64, z: 0 }, 0);
  const r = debtAction({ debt: d, now: 60000, arrived: true, dropsLeft: 0 });
  assert.strictEqual(r.act, 'settle');
  assert.strictEqual(r.reason, 'recovered');
});

// Borne naturelle : despawn vanilla 5 min => plus rien a recuperer, la boucle ne peut pas etre infinie.
test('au-dela du despawn vanilla, la dette est levee meme sans etre passe ramasser', () => {
  const d = openDebt({ x: 0, y: 64, z: 0 }, 0);
  const r = debtAction({ debt: d, now: DEBT_TTL_MS + 1 });
  assert.strictEqual(r.act, 'settle');
  assert.strictEqual(r.reason, 'despawned');
});

test('juste avant le despawn, on retourne encore', () => {
  const d = openDebt({ x: 0, y: 64, z: 0 }, 0);
  assert.strictEqual(debtAction({ debt: d, now: DEBT_TTL_MS - 1 }).act, 'recover');
});

test('le despawn prime sur les drops restants (ils ne sont plus la)', () => {
  const d = openDebt({ x: 0, y: 64, z: 0 }, 0);
  const r = debtAction({ debt: d, now: DEBT_TTL_MS + 1, arrived: true, dropsLeft: 5 });
  assert.strictEqual(r.act, 'settle');
  assert.strictEqual(r.reason, 'despawned');
});

test('une dette corrompue (sans horodatage) est levee au lieu de bloquer a vie', () => {
  const r = debtAction({ debt: { x: 0, y: 64, z: 0 }, now: 1000 });
  assert.strictEqual(r.act, 'settle');
  assert.strictEqual(r.reason, 'invalid');
});

// Massii : « meme s il meurt en continu » => une mort PENDANT la recuperation remplace la dette
// par la derniere mort ; pas d empilement, un seul home death.
test('une nouvelle mort remplace la dette precedente (le home suit la DERNIERE mort)', () => {
  const d1 = openDebt({ x: 0, y: 64, z: 0 }, 0);
  const d2 = openDebt({ x: 100, y: 30, z: 100 }, 5000);
  assert.notDeepStrictEqual(d1, d2);
  assert.strictEqual(d2.at, 5000);
  assert.strictEqual(d2.x, 100);
});
