'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  HOME_SAFE, HOME_WORK, HOME_DEATH, HOMES, LEGACY_HOMES,
  canBookmarkDeath, openDebt, debtAction, DEBT_TTL_MS, DEBT_MIN_WORN,
  isSurfaceSpot, SAFE_HOME_MIN_Y, isSilentSafeFailure,
} = require('./homes');
const { CAUTION_MIN_WORN } = require('./caution');

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

// ─── Le home `safe` doit etre EN SURFACE (bugfix world_mn10, 27/07) ─────────────────────────────
// `safe` = LA BASE : c'est la qu'on remonte chercher le bois (arbres + table de craft) et le point
// de respawn (/spawnpoint). La migration de zone le re-posait a la position COURANTE du bot en ne
// gardant QUE la garde `!isInWater` : un mineur a y=-7 qui « migrait » de 11 blocs re-ancrait sa
// base SOUS TERRE -> /home safe teleportait dans l'eau souterraine -> noyade en boucle -> jamais de
// bois -> `logs not_found` 98.9%, done fige a 0. Le lieu du `safe` doit passer ce predicat.

test('surface : un spot a y>=58 au sec est valide pour le home safe', () => {
  assert.strictEqual(isSurfaceSpot({ y: 64, inWater: false }), true);
  assert.strictEqual(isSurfaceSpot({ y: SAFE_HOME_MIN_Y, inWater: false }), true);
});

test('surface : un spot SOUS TERRE (y<58) est refuse meme au sec', () => {
  assert.strictEqual(isSurfaceSpot({ y: -7, inWater: false }), false);
  assert.strictEqual(isSurfaceSpot({ y: 57, inWater: false }), false);
  assert.strictEqual(isSurfaceSpot({ y: 15, inWater: false }), false);
});

test('surface : un spot dans l eau est refuse meme en surface (home mouille = /home mort)', () => {
  assert.strictEqual(isSurfaceSpot({ y: 64, inWater: true }), false);
});

test('surface : y absent ou non fini => refuse (on ne pose pas un safe sur une lecture ratee)', () => {
  assert.strictEqual(isSurfaceSpot({ inWater: false }), false);
  assert.strictEqual(isSurfaceSpot({ y: NaN, inWater: false }), false);
  assert.strictEqual(isSurfaceSpot({}), false);
});

// ─── /home safe silencieux depuis sous terre (piege world_mn11 NethBot3) ─────────────────────────

test('safe muet : warped:false, non annule, SOUS TERRE => signet casse (arme le self-heal)', () => {
  assert.strictEqual(isSilentSafeFailure({ name: HOME_SAFE, warped: false, cancelled: false, y: 17 }), true);
  assert.strictEqual(isSilentSafeFailure({ name: HOME_SAFE, warped: false, cancelled: false, y: 57 }), true);
});

test('safe muet : un warp qui a MARCHE (warped:true) ne signale rien', () => {
  assert.strictEqual(isSilentSafeFailure({ name: HOME_SAFE, warped: true, cancelled: false, y: 17 }), false);
});

test('safe muet : un warp ANNULE (coup/mouvement) est un simple retry, pas un signet casse', () => {
  assert.strictEqual(isSilentSafeFailure({ name: HOME_SAFE, warped: false, cancelled: true, y: 17 }), false);
});

test('safe muet : en SURFACE (y>=58) un no-op = deja chez soi, rien a signaler', () => {
  assert.strictEqual(isSilentSafeFailure({ name: HOME_SAFE, warped: false, cancelled: false, y: 64 }), false);
  assert.strictEqual(isSilentSafeFailure({ name: HOME_SAFE, warped: false, cancelled: false, y: 58 }), false);
});

test('safe muet : ne concerne QUE le home safe (pas work/death)', () => {
  assert.strictEqual(isSilentSafeFailure({ name: HOME_WORK, warped: false, cancelled: false, y: 17 }), false);
  assert.strictEqual(isSilentSafeFailure({ name: HOME_DEATH, warped: false, cancelled: false, y: 17 }), false);
});

test('safe muet : y absent/non fini => on ne signale pas (lecture de position ratee)', () => {
  assert.strictEqual(isSilentSafeFailure({ name: HOME_SAFE, warped: false, cancelled: false }), false);
  assert.strictEqual(isSilentSafeFailure({ name: HOME_SAFE, warped: false, cancelled: false, y: NaN }), false);
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

// ─── Dette de mort × NUIT : un bot nu ne retourne pas dans le camp qui vient de le tuer ─────────
// Trace live (run de référence, NethBot3 — 9 morts en 4 min) :
//   16:50:22 shelter dig_in            ← le planner commence l'abri
//   16:50:23 death_recover_home        ← /home death : TÉLÉPORTÉ au lieu de sa mort
//   16:50:29 reflex fight zombie       ← re-tué par ce qui campe le loot
// La décision est PURE : nuit + moins de 2 pièces portées + pas encore sur place => 'defer'.
// Le TTL de despawn (5 min) reste la borne : une dette expirée se lève même de nuit.

test('nuit + bot nu (0 piece) + pas encore sur place => on DIFFERE, on ne se teleporte pas', () => {
  const d = openDebt({ x: 0, y: 64, z: 0 }, 0);
  const r = debtAction({ debt: d, now: 5000, night: true, worn: 0 });
  assert.strictEqual(r.act, 'defer');
  assert.strictEqual(r.reason, 'night_naked');
});

test('nuit + 1 seule piece => encore differe (seuil : moins de 2 pieces portees)', () => {
  const d = openDebt({ x: 0, y: 64, z: 0 }, 0);
  const r = debtAction({ debt: d, now: 5000, night: true, worn: 1 });
  assert.strictEqual(r.act, 'defer');
  assert.strictEqual(r.reason, 'night_naked');
});

// homes.js reste sans dépendance (module pur) : il porte donc son PROPRE seuil. Ce test l'empêche de
// dériver de celui de la prudence nocturne du cartographe/regroupement (caution.js) — « nu » doit
// vouloir dire la même chose partout.
test('le seuil « nu » de la dette est celui de la prudence nocturne (caution.js)', () => {
  assert.strictEqual(DEBT_MIN_WORN, CAUTION_MIN_WORN);
  assert.strictEqual(DEBT_MIN_WORN, 2);
});

test('nuit + 2 pieces => on recupere (arme : on peut retourner au lieu de mort)', () => {
  const d = openDebt({ x: 0, y: 64, z: 0 }, 0);
  assert.strictEqual(debtAction({ debt: d, now: 5000, night: true, worn: 2 }).act, 'recover');
});

test('nuit + set complet (4 pieces) => on recupere', () => {
  const d = openDebt({ x: 0, y: 64, z: 0 }, 0);
  assert.strictEqual(debtAction({ debt: d, now: 5000, night: true, worn: 4 }).act, 'recover');
});

test('jour + bot nu => on recupere (le garde-fou ne vaut que la nuit)', () => {
  const d = openDebt({ x: 0, y: 64, z: 0 }, 0);
  const r = debtAction({ debt: d, now: 5000, night: false, worn: 0 });
  assert.strictEqual(r.act, 'recover');
  assert.strictEqual(r.reason, undefined);
});

test('heure inconnue (night null) + bot nu => on recupere, PAS de garde-fou', () => {
  const d = openDebt({ x: 0, y: 64, z: 0 }, 0);
  assert.strictEqual(debtAction({ debt: d, now: 5000, night: null, worn: 0 }).act, 'recover');
});

test('appel historique sans night ni worn => comportement inchange (recover)', () => {
  const d = openDebt({ x: 0, y: 64, z: 0 }, 0);
  assert.strictEqual(debtAction({ debt: d, now: 5000 }).act, 'recover');
  assert.strictEqual(debtAction({ debt: d, now: 5000, night: undefined, worn: undefined }).act, 'recover');
});

test('nuit + worn absent => compte comme 0 piece (prudent) : on differe', () => {
  const d = openDebt({ x: 0, y: 64, z: 0 }, 0);
  assert.strictEqual(debtAction({ debt: d, now: 5000, night: true }).act, 'defer');
  assert.strictEqual(debtAction({ debt: d, now: 5000, night: true, worn: NaN }).act, 'defer');
});

test('le despawn prime sur le report nocturne : dette expiree la nuit => settle, pas defer', () => {
  const d = openDebt({ x: 0, y: 64, z: 0 }, 0);
  const r = debtAction({ debt: d, now: DEBT_TTL_MS + 1, night: true, worn: 0 });
  assert.strictEqual(r.act, 'settle');
  assert.strictEqual(r.reason, 'despawned');
});

test('juste avant le despawn, nuit + nu => on differe encore', () => {
  const d = openDebt({ x: 0, y: 64, z: 0 }, 0);
  assert.strictEqual(debtAction({ debt: d, now: DEBT_TTL_MS - 1, night: true, worn: 0 }).act, 'defer');
  assert.strictEqual(debtAction({ debt: d, now: DEBT_TTL_MS, night: true, worn: 0 }).act, 'defer');
});

test('dette corrompue la nuit => levee (invalid), jamais differee a vie', () => {
  const r = debtAction({ debt: { x: 0, y: 64, z: 0 }, now: 1000, night: true, worn: 0 });
  assert.strictEqual(r.act, 'settle');
  assert.strictEqual(r.reason, 'invalid');
});

test('pas de dette la nuit => rien a faire (et surtout rien a differer)', () => {
  assert.strictEqual(debtAction({ debt: null, now: 0, night: true, worn: 0 }).act, 'none');
});

// Le garde-fou ne vaut qu'AVANT le départ : une fois sur place (arrived), on est déjà là, le
// verdict reste celui de la mesure des drops — pas de re-report qui laisserait le bot planté là.
test('arrive sur place la nuit + nu + drops restants => recover (drops_left), pas de report', () => {
  const d = openDebt({ x: 0, y: 64, z: 0 }, 0);
  const r = debtAction({ debt: d, now: 60000, arrived: true, dropsLeft: 3, night: true, worn: 0 });
  assert.strictEqual(r.act, 'recover');
  assert.strictEqual(r.reason, 'drops_left');
});

test('arrive sur place la nuit + nu + plus aucun drop => dette levee (recovered)', () => {
  const d = openDebt({ x: 0, y: 64, z: 0 }, 0);
  const r = debtAction({ debt: d, now: 60000, arrived: true, dropsLeft: 0, night: true, worn: 0 });
  assert.strictEqual(r.act, 'settle');
  assert.strictEqual(r.reason, 'recovered');
});

// La boucle de relance (60 s) : à chaque tentative on RE-DÉCIDE depuis zéro. Trois issues bornées.
const RETRY_MS = 60000;

test('relances toutes les 60 s toute la nuit : defer ... defer puis settle au despawn, jamais recover', () => {
  const d = openDebt({ x: 0, y: 64, z: 0 }, 0);
  const acts = [];
  for (let t = 0; t <= DEBT_TTL_MS + RETRY_MS; t += RETRY_MS) {
    acts.push(debtAction({ debt: d, now: t, night: true, worn: 0 }).act);
  }
  assert.strictEqual(acts[acts.length - 1], 'settle');
  assert.ok(acts.slice(0, -1).length >= 5, 'plusieurs relances avant le despawn');
  assert.ok(acts.slice(0, -1).every((a) => a === 'defer'), 'jamais de recover tant que nuit + nu');
});

test('relances : l aube se leve avant le despawn => la tentative suivante RECUPERE', () => {
  const d = openDebt({ x: 0, y: 64, z: 0 }, 0);
  assert.strictEqual(debtAction({ debt: d, now: 60000, night: true, worn: 0 }).act, 'defer');
  assert.strictEqual(debtAction({ debt: d, now: 120000, night: true, worn: 0 }).act, 'defer');
  assert.strictEqual(debtAction({ debt: d, now: 180000, night: false, worn: 0 }).act, 'recover');
});

test('relances : une armure trouvee en route (2 pieces) => la tentative suivante RECUPERE', () => {
  const d = openDebt({ x: 0, y: 64, z: 0 }, 0);
  assert.strictEqual(debtAction({ debt: d, now: 60000, night: true, worn: 1 }).act, 'defer');
  assert.strictEqual(debtAction({ debt: d, now: 120000, night: true, worn: 2 }).act, 'recover');
});

test('debtAction : de nuit, nu, mais armure/diamants au sol → on récupère tout de suite (keepInventory OFF)', () => {
  const { debtAction } = require('./homes');
  const d = { at: 1000 };
  assert.strictEqual(debtAction({ debt: d, now: 5000, night: true, worn: 0 }).act, 'defer');
  assert.strictEqual(debtAction({ debt: d, now: 5000, night: true, worn: 0, valuable: true }).act, 'recover');
});
