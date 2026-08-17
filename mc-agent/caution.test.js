'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  mapperCaution, CAUTION_MIN_WORN,
  equipRetryPlan, EQUIP_RETRY_WAIT_MS, EQUIP_MAX_ATTEMPTS, EQUIP_RETRY_COOLDOWN_MS,
  isEquipPickup, PICKUP_EQUIP_DELAY_MS,
  normalizeSmeltResult,
} = require('./caution');

// ─── PRUDENCE DU CARTOGRAPHE TANT QU'IL EST NU ──────────────────────────────────────────────────
// Mesure live world_mn14 : les 3 cartographes concentrent la moitié des morts de la flotte.
// MapBot1 = 92 morts (squelette ×25, zombie ×15, creeper ×8) — il churne si vite qu'il respawne
// `kit_equipped worn:0` en boucle. Un cartographe SANS armure qui voyage de nuit est un cadavre :
// il se terre, il attend l'aube, il repart le matin (ou dès qu'il porte 2 pièces).

test('nuit + aucune piece portee -> abri', () => {
  assert.strictEqual(mapperCaution({ worn: 0, isNight: true, hostilesNear: false }), 'shelter');
});

test('nuit + 1 seule piece -> abri (une botte ne protege de rien en hard)', () => {
  assert.strictEqual(mapperCaution({ worn: 1, isNight: true, hostilesNear: false }), 'shelter');
});

test('nuit + 2 pieces -> il cartographie (seuil CAUTION_MIN_WORN)', () => {
  assert.strictEqual(CAUTION_MIN_WORN, 2);
  assert.strictEqual(mapperCaution({ worn: 2, isNight: true, hostilesNear: true }), 'map');
});

test('nuit + set complet -> il cartographie', () => {
  assert.strictEqual(mapperCaution({ worn: 4, isNight: true, hostilesNear: true }), 'map');
});

test('JOUR + nu -> il cartographie quand meme (se terrer de jour = ne jamais rien cartographier)', () => {
  assert.strictEqual(mapperCaution({ worn: 0, isNight: false, hostilesNear: false }), 'map');
});

test('JOUR + nu + hostiles proches -> il cartographie (fuir est le role de survivalTick, pas se terrer)', () => {
  assert.strictEqual(mapperCaution({ worn: 0, isNight: false, hostilesNear: true }), 'map');
});

// Robustesse au signal INCONNU — même patron que shouldShelter (skills/shelter.js) qui retombe sur
// les hostiles quand mineflayer ne livre pas le niveau de lumière : `bot.time` peut manquer juste
// après un spawn/reconnexion, et c'est exactement le moment où le bot est nu.
test('nuit INCONNUE (null) + nu + hostiles proches -> abri (les hostiles sont le proxy honnete)', () => {
  assert.strictEqual(mapperCaution({ worn: 0, isNight: null, hostilesNear: true }), 'shelter');
});

test('nuit INCONNUE (null) + nu SANS hostile -> il cartographie (pas de paranoia)', () => {
  assert.strictEqual(mapperCaution({ worn: 0, isNight: null, hostilesNear: false }), 'map');
});

test('nuit inconnue + hostiles mais 2 pieces portees -> il cartographie', () => {
  assert.strictEqual(mapperCaution({ worn: 2, isNight: null, hostilesNear: true }), 'map');
});

test('worn absent / non numerique = 0 piece portee', () => {
  assert.strictEqual(mapperCaution({ isNight: true }), 'shelter');
  assert.strictEqual(mapperCaution({ worn: 'deux', isNight: true }), 'shelter');
});

test('signature vide -> map (aucune raison de se terrer)', () => {
  assert.strictEqual(mapperCaution(), 'map');
  assert.strictEqual(mapperCaution({}), 'map');
});

// ─── POLITIQUE DE RÉ-ESSAI D'ÉQUIPEMENT ─────────────────────────────────────────────────────────
// `bot.equip` échoue surtout EN MOUVEMENT (le serveur refuse le changement de slot pendant un
// déplacement / un dig). L'échec était AVALÉ par un `catch (e) {}` muet : MapBot1 avait
// `picked_up: iron_chestplate 1` dans ses stats vanilla et `armor:0` à la présence — il ne portait
// pas ce qu'il avait en poche, et rien ne re-tentait. Un seul ré-essai, à l'arrêt, suffit.

test('aucun echec -> pas de re-essai', () => {
  const p = equipRetryPlan([], { attempt: 1 });
  assert.strictEqual(p.retry, false);
  assert.deepStrictEqual(p.pieces, []);
  assert.strictEqual(p.waitMs, 0);
  assert.strictEqual(p.stopFirst, false);
});

test('un echec en 1re passe -> re-essai a l arret apres ~1,5 s', () => {
  const p = equipRetryPlan([{ piece: 'iron_chestplate', dest: 'torso', reason: 'moving' }], { attempt: 1 });
  assert.strictEqual(p.retry, true);
  assert.strictEqual(p.stopFirst, true);
  assert.strictEqual(p.waitMs, EQUIP_RETRY_WAIT_MS);
  assert.ok(EQUIP_RETRY_WAIT_MS >= 1000 && EQUIP_RETRY_WAIT_MS <= 3000);
  assert.deepStrictEqual(p.pieces, [{ piece: 'iron_chestplate', dest: 'torso', reason: 'moving' }]);
});

test('UNE seule fois : la 2e passe ne re-essaie plus (pas de boucle chaude)', () => {
  assert.strictEqual(EQUIP_MAX_ATTEMPTS, 2);
  const p = equipRetryPlan([{ piece: 'iron_helmet', dest: 'head' }], { attempt: 2 });
  assert.strictEqual(p.retry, false);
  assert.deepStrictEqual(p.pieces, []);
});

test('plusieurs pieces ratees -> toutes re-tentees, dedupliquees', () => {
  const p = equipRetryPlan([
    { piece: 'iron_helmet', dest: 'head' },
    { piece: 'iron_boots', dest: 'feet' },
    { piece: 'iron_helmet', dest: 'head' },
  ], { attempt: 1 });
  assert.strictEqual(p.retry, true);
  assert.deepStrictEqual(p.pieces.map((x) => x.piece), ['iron_helmet', 'iron_boots']);
});

test('entrees texte acceptees (nom seul) et entrees vides filtrees', () => {
  const p = equipRetryPlan(['shield', null, undefined, '', { reason: 'x' }], { attempt: 1 });
  assert.strictEqual(p.retry, true);
  assert.deepStrictEqual(p.pieces, [{ piece: 'shield', dest: null, reason: null }]);
});

test('attente surchargeable (tests / reglage)', () => {
  const p = equipRetryPlan([{ piece: 'shield', dest: 'off-hand' }], { attempt: 1, waitMs: 10 });
  assert.strictEqual(p.waitMs, 10);
});

test('liste absente -> pas de re-essai (jamais de throw)', () => {
  assert.strictEqual(equipRetryPlan().retry, false);
  assert.strictEqual(equipRetryPlan(null, {}).retry, false);
});

// `ensureArmor` tourne en boucle (planner, timers, onPeriodic) : un équipement qui échoue
// DURABLEMENT — et pas juste parce que le bot marchait — ferait payer 1,5 s d'arrêt à CHAQUE appel.
// L'échec reste tracé à chaque fois ; seule l'immobilisation est rationnée.
test('deux re-essais forces ne sont jamais colles (cooldown)', () => {
  const p = equipRetryPlan([{ piece: 'iron_helmet', dest: 'head' }],
    { attempt: 1, now: 100000, lastRetryAt: 100000 - (EQUIP_RETRY_COOLDOWN_MS - 1) });
  assert.strictEqual(p.retry, false);
  assert.strictEqual(p.reason, 'cooldown');
});

test('cooldown ecoule -> le re-essai reprend', () => {
  const p = equipRetryPlan([{ piece: 'iron_helmet', dest: 'head' }],
    { attempt: 1, now: 100000, lastRetryAt: 100000 - (EQUIP_RETRY_COOLDOWN_MS + 1) });
  assert.strictEqual(p.retry, true);
});

test('sans horloge fournie -> aucun rationnement (retro-compat)', () => {
  assert.strictEqual(equipRetryPlan([{ piece: 'iron_helmet', dest: 'head' }], { attempt: 1 }).retry, true);
  assert.strictEqual(equipRetryPlan([{ piece: 'iron_helmet', dest: 'head' }],
    { attempt: 1, now: 100000 }).retry, true);
});

test('les refus portent une raison lisible (diagnostic)', () => {
  assert.strictEqual(equipRetryPlan([], { attempt: 1 }).reason, 'nothing_failed');
  assert.strictEqual(equipRetryPlan([{ piece: 'x' }], { attempt: 2 }).reason, 'max_attempts');
});

// ─── DÉCLENCHEUR « JE VIENS DE RAMASSER DE QUOI M'HABILLER » ─────────────────────────────────────
// Un don de coéquipier (worker qui lance une pièce au cartographe) arrive N'IMPORTE QUAND. Le bot
// ne re-tentait l'équipement qu'au kit (spawn + 2,5 s) et à l'onPeriodic (1 arrivée sur 10) —
// MapBot1 mourait souvent AVANT. Le ramassage devient le déclencheur.

test('pieces d armure -> declenche un equipement', () => {
  for (const n of ['iron_chestplate', 'diamond_boots', 'netherite_leggings', 'turtle_helmet',
    'leather_helmet', 'chainmail_chestplate', 'golden_leggings']) {
    assert.strictEqual(isEquipPickup(n), true, n);
  }
});

test('bouclier -> declenche aussi (un bouclier dans le sac n arrete aucune fleche)', () => {
  assert.strictEqual(isEquipPickup('shield'), true);
});

test('tout le reste -> ne declenche rien (un mineur ramasse des centaines d items)', () => {
  for (const n of ['cobblestone', 'iron_ingot', 'raw_iron', 'diamond', 'stick', 'iron_pickaxe',
    'helmet', 'boots_of_speed', 'shield_fragment']) {
    assert.strictEqual(isEquipPickup(n), false, n);
  }
});

test('nom absent ou non textuel -> false (jamais de throw)', () => {
  for (const n of [null, undefined, 42, {}, [], '']) assert.strictEqual(isEquipPickup(n), false);
});

test('le delai de debounce du ramassage est court mais non nul', () => {
  assert.ok(PICKUP_EQUIP_DELAY_MS > 0 && PICKUP_EQUIP_DELAY_MS <= 3000);
});

// ─── RAISON D'ÉCHEC DE FONTE TOUJOURS RENSEIGNÉE ────────────────────────────────────────────────
// Vu en session vivante : `armor_smelt ok:false reason:"?"` — un échec à la cause PERDUE, sur le
// chemin qui fabrique l'armure. Cause : `smelt` (skills/smelt.js) rend `{ok: got >= want, got}`,
// donc SANS `reason` dès qu'il fond moins que demandé. Sans raison, on ne sait pas s'il manque
// du combustible, de l'input, ou si le four a été volé.

test('succes -> rendu tel quel', () => {
  const r = { ok: true, got: 3 };
  assert.strictEqual(normalizeSmeltResult(r, 3), r);
});

test('echec SANS raison et sans sortie -> no_output', () => {
  const n = normalizeSmeltResult({ ok: false, got: 0 }, 3);
  assert.strictEqual(n.ok, false);
  assert.strictEqual(n.reason, 'no_output');
  assert.strictEqual(n.got, 0);
});

test('echec SANS raison mais fonte partielle -> partial (+ got preserve)', () => {
  const n = normalizeSmeltResult({ ok: false, got: 2 }, 3);
  assert.strictEqual(n.reason, 'partial');
  assert.strictEqual(n.got, 2);
});

test('la quantite DEMANDEE accompagne l echec (2/3 et 2/8 ne se lisent pas pareil)', () => {
  assert.strictEqual(normalizeSmeltResult({ ok: false, got: 2 }, 3).want, 3);
  assert.strictEqual(normalizeSmeltResult({ ok: false, got: 2 }, 8).want, 8);
  assert.strictEqual(normalizeSmeltResult(null, 5).want, 5);
  assert.strictEqual(normalizeSmeltResult({ ok: false, got: 0 }).want, 0);   // want inconnu
});

test('raison deja fournie -> jamais ecrasee (no_furnace, no_fuel, no_input...)', () => {
  for (const reason of ['no_furnace', 'no_fuel', 'no_input', 'open_failed', 'unknown_item']) {
    const n = normalizeSmeltResult({ ok: false, reason }, 3);
    assert.strictEqual(n.reason, reason);
  }
});

test('resultat absent (undefined/null) -> no_result', () => {
  assert.strictEqual(normalizeSmeltResult(undefined, 3).reason, 'no_result');
  assert.strictEqual(normalizeSmeltResult(null, 3).reason, 'no_result');
  assert.strictEqual(normalizeSmeltResult(null, 3).ok, false);
});

test('INVARIANT : tout echec sort avec une raison non vide (fini le "?")', () => {
  const shapes = [undefined, null, {}, { ok: false }, { ok: false, got: 0 }, { ok: false, got: 1 },
    { ok: 0 }, { ok: false, reason: '' }, { ok: false, reason: null }];
  for (const s of shapes) {
    const n = normalizeSmeltResult(s, 3);
    assert.strictEqual(n.ok, false, JSON.stringify(s));
    assert.ok(typeof n.reason === 'string' && n.reason.length > 0, JSON.stringify(s));
  }
});

test('le resultat d origine n est jamais mute (objet neuf a la normalisation)', () => {
  const src = { ok: false, got: 1 };
  const n = normalizeSmeltResult(src, 3);
  assert.notStrictEqual(n, src);
  assert.strictEqual(src.reason, undefined);
});
