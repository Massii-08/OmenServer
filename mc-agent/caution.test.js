'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  mapperCaution, CAUTION_MIN_WORN, regroupCaution,
  equipRetryPlan, EQUIP_RETRY_WAIT_MS, EQUIP_MAX_ATTEMPTS, EQUIP_RETRY_COOLDOWN_MS,
  isEquipPickup, PICKUP_EQUIP_DELAY_MS,
  normalizeSmeltResult,
  sprintAllowed, SPRINT_HUNGER_FLOOR, SPRINT_HUNGER_RESUME,
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

// ─── PRUDENCE NOCTURNE DU REGROUPEMENT (18/08, suite directe) ───────────────────────────────────
// Flagrant délit world_mn15 ~02:30 : 6 morts en 2 min AU MÊME POINT. Chaque mort → respawn →
// /tpa immédiat vers le groupe (--regroup) → bot téléporté NU, DE NUIT, dans le camp où les
// hostiles ont convergé → re-mort → re-tpa. Le regroupement (pensé pour la logistique de jour)
// court-circuitait l'abri-si-nu. `regroupCaution` délègue à `mapperCaution` (même seuil
// CAUTION_MIN_WORN, même traitement du signal isNight/hostilesNear inconnu) et traduit le verdict
// dans le vocabulaire du regroupement : 'map' → 'regroup', 'shelter' reste 'shelter'.

test('nuit + aucune piece portee -> abri (ne pas se regrouper)', () => {
  assert.strictEqual(regroupCaution({ worn: 0, isNight: true, hostilesNear: false }), 'shelter');
});

test('nuit + 1 seule piece -> abri', () => {
  assert.strictEqual(regroupCaution({ worn: 1, isNight: true, hostilesNear: false }), 'shelter');
});

test('nuit + 2 pieces (seuil CAUTION_MIN_WORN) -> il se regroupe', () => {
  assert.strictEqual(CAUTION_MIN_WORN, 2);
  assert.strictEqual(regroupCaution({ worn: 2, isNight: true, hostilesNear: true }), 'regroup');
});

test('nuit + set complet -> il se regroupe', () => {
  assert.strictEqual(regroupCaution({ worn: 4, isNight: true, hostilesNear: true }), 'regroup');
});

test('JOUR + nu -> il se regroupe quand meme (comportement actuel intact de jour)', () => {
  assert.strictEqual(regroupCaution({ worn: 0, isNight: false, hostilesNear: false }), 'regroup');
});

test('JOUR + nu + hostiles proches -> il se regroupe (fuir/riposter reste le role de survivalTick)', () => {
  assert.strictEqual(regroupCaution({ worn: 0, isNight: false, hostilesNear: true }), 'regroup');
});

test('nuit INCONNUE (null) + nu + hostiles proches -> abri (les hostiles sont le proxy honnete)', () => {
  assert.strictEqual(regroupCaution({ worn: 0, isNight: null, hostilesNear: true }), 'shelter');
});

test('nuit INCONNUE (null) + nu SANS hostile -> il se regroupe (pas de paranoia)', () => {
  assert.strictEqual(regroupCaution({ worn: 0, isNight: null, hostilesNear: false }), 'regroup');
});

test('nuit inconnue + hostiles mais 2 pieces portees -> il se regroupe', () => {
  assert.strictEqual(regroupCaution({ worn: 2, isNight: null, hostilesNear: true }), 'regroup');
});

test('worn absent / non numerique = 0 piece portee -> abri de nuit', () => {
  assert.strictEqual(regroupCaution({ isNight: true }), 'shelter');
  assert.strictEqual(regroupCaution({ worn: 'deux', isNight: true }), 'shelter');
});

test('signature vide -> regroup (jamais throw, jamais le mot "map")', () => {
  assert.strictEqual(regroupCaution(), 'regroup');
  assert.strictEqual(regroupCaution({}), 'regroup');
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

// ─── RÉSERVE DE FAIM POUR LE SPRINT (18/08, suite directe) ──────────────────────────────────────
// Mesure live world_mn15 (stats vanilla) : sprint_one_cm = 2,2 a 2,5 MILLIONS de cm (22-25 km) par
// bot en quelques heures, walk_one_cm ~10x moindre — un bot sprinte quasi en permanence, affame ou
// pas. Le sprint epuise la faim ~4x plus vite ; le plancher DUR du serveur (6/7, movement.js) coupe
// trop tard : la reserve necessaire a la regeneration de PV (hard, faim>=18) est deja vide avant
// meme d'atteindre ce plancher. Morts "starved to death" en serie (3 dans les 25 dernieres minutes
// du run). `sprintAllowed` pose un plancher PROACTIF (12) nettement au-dessus du plancher vanilla,
// avec hysteresis +2 (reprise a 14 seulement) pour eviter le clignotement.

test('plancher : faim au-dessus de 12 -> sprint autorise (pas encore coupe)', () => {
  assert.strictEqual(sprintAllowed({ food: 20 }), true);
  assert.strictEqual(sprintAllowed({ food: 13 }), true);
});

test('plancher : faim a 12 pile ou en dessous -> sprint refuse (garder la reserve pour la regen)', () => {
  assert.strictEqual(SPRINT_HUNGER_FLOOR, 12);
  assert.strictEqual(sprintAllowed({ food: 12 }), false);
  assert.strictEqual(sprintAllowed({ food: 6 }), false);
  assert.strictEqual(sprintAllowed({ food: 0 }), false);
});

test('hysteresis : deja coupe -> ne reprend qu au seuil de reprise (14), pas des le plancher (12)', () => {
  assert.strictEqual(SPRINT_HUNGER_RESUME, 14);
  assert.strictEqual(sprintAllowed({ food: 12, curbed: true }), false);
  assert.strictEqual(sprintAllowed({ food: 13, curbed: true }), false);
  assert.strictEqual(sprintAllowed({ food: 14, curbed: true }), true);
  assert.strictEqual(sprintAllowed({ food: 20, curbed: true }), true);
});

test('hysteresis : PAS encore coupe -> le plancher simple suffit (13 rouvre sans attendre 14)', () => {
  assert.strictEqual(sprintAllowed({ food: 13, curbed: false }), true);
  assert.strictEqual(sprintAllowed({ food: 13 }), true);   // curbed absent = comme false
});

test('food inconnu -> autorise (retro-compat, jamais de blocage sur donnee absente)', () => {
  assert.strictEqual(sprintAllowed({}), true);
  assert.strictEqual(sprintAllowed(), true);
  assert.strictEqual(sprintAllowed({ food: undefined }), true);
  assert.strictEqual(sprintAllowed({ food: null }), true);
  assert.strictEqual(sprintAllowed({ food: NaN }), true);
  assert.strictEqual(sprintAllowed({ food: 'plein' }), true);
});

test('food inconnu + deja coupe -> autorise quand meme (retro-compat prime sur l hysteresis)', () => {
  assert.strictEqual(sprintAllowed({ curbed: true }), true);
  assert.strictEqual(sprintAllowed({ food: undefined, curbed: true }), true);
});

test('le plancher est nettement au-dessus du plancher dur vanilla (6/7, movement.js) — proactif', () => {
  // Sinon aucun gain vs shouldSprint qui coupe deja a 6/7 : la reserve serait vide avant de couper.
  assert.ok(SPRINT_HUNGER_FLOOR > 7, 'doit couper AVANT le plancher dur vanilla, pas au meme endroit');
});

// ─── 1ter) MARCHE DE MIGRATION DE NUIT (18/08) ──────────────────────────────────────────────────
// Le verdict ne LANCE plus de migration la nuit, mais un trek de 600-1200 blocs commencé au
// crépuscule finit en pleine nuit : un bot à < 2 pièces qui continue de marcher en hard meurt, et
// sa mort fait échouer la migration. Même seuil que l'abri du cartographe (une seule source).
const { migrationCaution } = require('./caution');

test('migration de nuit, bot NU => on s arrete', () => {
  assert.strictEqual(migrationCaution({ worn: 0, isNight: true }), 'stop');
  assert.strictEqual(migrationCaution({ worn: CAUTION_MIN_WORN - 1, isNight: true }), 'stop');
});

test('migration de nuit, bot a 2 pieces ou plus => il continue (il encaisse le temps de fuir)', () => {
  assert.strictEqual(migrationCaution({ worn: CAUTION_MIN_WORN, isNight: true }), 'walk');
  assert.strictEqual(migrationCaution({ worn: 4, isNight: true }), 'walk');
});

test('migration de JOUR => on marche, nu ou pas', () => {
  assert.strictEqual(migrationCaution({ worn: 0, isNight: false }), 'walk');
});

test('migration, heure INCONNUE => on ne coupe pas un trek sur une supposition', () => {
  assert.strictEqual(migrationCaution({ worn: 0, isNight: null }), 'walk');
  assert.strictEqual(migrationCaution({ worn: 0 }), 'walk');
  assert.strictEqual(migrationCaution(), 'walk');
});

test('migration : nombre de pieces illisible => compte comme nu (prudent)', () => {
  assert.strictEqual(migrationCaution({ worn: 'x', isNight: true }), 'stop');
});

// ─── 1quater) DISCIPLINE DE NUIT (19/10 soir, run « de zéro » world_oct9) ───────────────────────
// 33 morts en 35 min, l'essentiel LA NUIT (13 squelettes, 11 zombies, 6 creepers, 3 araignées), flotte
// partie de zéro : personne n'a d'armure. L'abri existait, mais plusieurs routines tiraient le bot nu
// HORS de son trou la nuit (planner, entraide de combat, quête de nourriture, trajet bois…). Un seul
// prédicat les gouverne toutes : `nightLockdown`. Puis deux décisions du planner : quoi faire avant un
// skill (`nightPlannerStep`), et la comptabilité des ré-abris (`lockdownShelterNote`).
const {
  nightLockdown, nightPlannerStep, lockdownShelterNote,
  NIGHT_SHELTER_GAP_MS, NIGHT_UNDERGROUND_Y, NIGHT_SURFACE_SKILLS, SHELTER_REENTER_EVENT_MS,
} = require('./caution');

test('lockdown : nuit CONNUE + nu (0 ou 1 piece) -> vrai', () => {
  assert.strictEqual(nightLockdown({ isNight: true, worn: 0 }), true);
  assert.strictEqual(nightLockdown({ isNight: true, worn: 1 }), true);
});

test('lockdown : 2 pieces (CAUTION_MIN_WORN, seuil UNIQUE) ou plus -> faux, comportement inchange', () => {
  assert.strictEqual(nightLockdown({ isNight: true, worn: CAUTION_MIN_WORN }), false);
  assert.strictEqual(nightLockdown({ isNight: true, worn: 4 }), false);
  assert.strictEqual(nightLockdown({ isNight: true, worn: CAUTION_MIN_WORN - 1 }), true);
});

test('lockdown : de JOUR -> faux, nu ou pas', () => {
  assert.strictEqual(nightLockdown({ isNight: false, worn: 0 }), false);
});

test('lockdown : heure INCONNUE -> faux, meme nu et entoure (convention migrationCaution : on ne fige pas sur une supposition)', () => {
  assert.strictEqual(nightLockdown({ isNight: null, worn: 0, hostilesNear: true }), false);
  assert.strictEqual(nightLockdown({ worn: 0 }), false);
  assert.strictEqual(nightLockdown({}), false);
  assert.strictEqual(nightLockdown(), false);
  assert.strictEqual(nightLockdown(null), false);
});

test('lockdown : seul `true` vaut « nuit » (un 1 ou une chaine ne declenche rien)', () => {
  assert.strictEqual(nightLockdown({ isNight: 1, worn: 0 }), false);
  assert.strictEqual(nightLockdown({ isNight: 'oui', worn: 0 }), false);
});

test('lockdown : pieces lues quelle que soit la forme (nombre, Set, tableau) ; illisible = nu (prudent)', () => {
  assert.strictEqual(nightLockdown({ isNight: true, worn: new Set(['iron_helmet', 'iron_boots']) }), false);
  assert.strictEqual(nightLockdown({ isNight: true, worn: new Set(['iron_helmet']) }), true);
  assert.strictEqual(nightLockdown({ isNight: true, worn: ['a', 'b', 'c'] }), false);
  assert.strictEqual(nightLockdown({ isNight: true, worn: 'deux' }), true);
  assert.strictEqual(nightLockdown({ isNight: true, worn: NaN }), true);
  assert.strictEqual(nightLockdown({ isNight: true }), true);
});

test('INVARIANT : tout lockdown est un abri pour regroupCaution ET mapperCaution (pas deux lectures de « nu de nuit »)', () => {
  for (const isNight of [true, false, null, undefined]) {
    for (const worn of [0, 1, 2, 3, 4, undefined]) {
      for (const hostilesNear of [true, false]) {
        const sig = { isNight, worn, hostilesNear };
        if (!nightLockdown(sig)) continue;
        assert.strictEqual(regroupCaution(sig), 'shelter', JSON.stringify(sig));
        assert.strictEqual(mapperCaution(sig), 'shelter', JSON.stringify(sig));
      }
    }
  }
});

test('planner : hors lockdown -> run, quel que soit le reste (armes, jour, heure inconnue : rien ne change)', () => {
  assert.strictEqual(nightPlannerStep({ lockdown: false, y: 70, skill: 'gatherLog', shelterBusy: true, inWater: true }), 'run');
  assert.strictEqual(nightPlannerStep({}), 'run');
  assert.strictEqual(nightPlannerStep(), 'run');
  assert.strictEqual(nightPlannerStep(null), 'run');
});

test('planner : lockdown en SURFACE -> l abri AU LIEU du skill (quel que soit le skill)', () => {
  for (const skill of ['gatherLog', 'craft', 'gather', 'descendDiagonal', 'branchMine', 'smeltIron', undefined]) {
    assert.strictEqual(nightPlannerStep({ lockdown: true, y: 70, skill, sinceShelterMs: 5 * 60000 }), 'shelter', String(skill));
  }
});

test('planner : un abri DEJA en cours (lance par un timer) -> on l attend, on ne creuse pas un 2e trou', () => {
  assert.strictEqual(nightPlannerStep({ lockdown: true, y: 70, shelterBusy: true, sinceShelterMs: 5 * 60000 }), 'wait');
});

test('planner : dans l EAU -> on attend (pas de trou creuse dans l eau, le sauvetage garde la main)', () => {
  assert.strictEqual(nightPlannerStep({ lockdown: true, y: 70, inWater: true, sinceShelterMs: 5 * 60000 }), 'wait');
});

test('planner : mini-ecart anti-boucle de 20 s entre deux abris — et PAS les 10 min historiques', () => {
  assert.strictEqual(NIGHT_SHELTER_GAP_MS, 20000);
  assert.ok(NIGHT_SHELTER_GAP_MS < 10 * 60 * 1000);
  assert.strictEqual(nightPlannerStep({ lockdown: true, y: 70, sinceShelterMs: 0 }), 'wait');
  assert.strictEqual(nightPlannerStep({ lockdown: true, y: 70, sinceShelterMs: NIGHT_SHELTER_GAP_MS - 1 }), 'wait');
  assert.strictEqual(nightPlannerStep({ lockdown: true, y: 70, sinceShelterMs: NIGHT_SHELTER_GAP_MS }), 'shelter');
  assert.strictEqual(nightPlannerStep({ lockdown: true, y: 70, sinceShelterMs: 30000 }), 'shelter', '30 s apres un abri interrompu : on y retourne');
});

test('planner : ecart injectable ; dernier abri inconnu -> on peut s abriter', () => {
  assert.strictEqual(nightPlannerStep({ lockdown: true, y: 70, sinceShelterMs: 5000, gapMs: 1000 }), 'shelter');
  assert.strictEqual(nightPlannerStep({ lockdown: true, y: 70, sinceShelterMs: 5000, gapMs: 9000 }), 'wait');
  assert.strictEqual(nightPlannerStep({ lockdown: true, y: 70 }), 'shelter');
  assert.strictEqual(nightPlannerStep({ lockdown: true, y: 70, sinceShelterMs: NaN }), 'shelter');
});

test('planner : SOUS TERRE la nuit ne change rien — le minage continue (shouldShelter y refuse l abri, Massii 16/07)', () => {
  assert.strictEqual(NIGHT_UNDERGROUND_Y, 45, 'le meme seuil que maybeNightShelter');
  for (const skill of ['branchMine', 'descendDiagonal', 'gather', 'craft', 'smeltIron', 'caveHunt']) {
    assert.strictEqual(nightPlannerStep({ lockdown: true, y: 20, skill, sinceShelterMs: 5 * 60000 }), 'run', skill);
  }
});

test('planner : sous terre, les buts qui RAMENENT a la surface (bois, chasse, pioche, livraison /tpa) attendent l aube', () => {
  for (const skill of ['gatherLog', 'huntCook', 'ensurePick', 'deliverMapperArmor']) {
    assert.ok(NIGHT_SURFACE_SKILLS.has(skill), skill);
    assert.strictEqual(nightPlannerStep({ lockdown: true, y: 20, skill }), 'wait', skill);
  }
});

test('planner : frontiere y=45 = SURFACE (sous terre = y < 45, comme shouldShelter) ; altitude inconnue -> attendre', () => {
  assert.strictEqual(nightPlannerStep({ lockdown: true, y: NIGHT_UNDERGROUND_Y, skill: 'branchMine', sinceShelterMs: 5 * 60000 }), 'shelter');
  assert.strictEqual(nightPlannerStep({ lockdown: true, y: NIGHT_UNDERGROUND_Y - 0.5, skill: 'branchMine' }), 'run');
  assert.strictEqual(nightPlannerStep({ lockdown: true, y: null, skill: 'branchMine' }), 'wait');
  assert.strictEqual(nightPlannerStep({ lockdown: true, skill: 'branchMine' }), 'wait');
});

test('re-abri : le 1er abri d une nuit n en est pas un, le 2e oui (trace), le 3e dans la minute est compte mais pas re-trace', () => {
  const T = 1_700_000_000_000;
  const a = lockdownShelterNote(null, { night: 7, now: T });
  assert.deepStrictEqual([a.reenter, a.count, a.emit], [false, 0, false]);
  const b = lockdownShelterNote(a.state, { night: 7, now: T + 30000 });
  assert.deepStrictEqual([b.reenter, b.count, b.emit], [true, 1, true]);
  const c = lockdownShelterNote(b.state, { night: 7, now: T + 50000 });
  assert.deepStrictEqual([c.reenter, c.count, c.emit], [true, 2, false], '1x/min max');
  const d = lockdownShelterNote(c.state, { night: 7, now: T + 30000 + SHELTER_REENTER_EVENT_MS });
  assert.deepStrictEqual([d.reenter, d.count, d.emit], [true, 3, true], 'une minute apres le dernier event : on re-trace, avec le cumul');
  assert.strictEqual(SHELTER_REENTER_EVENT_MS, 60000);
});

test('re-abri : une NOUVELLE nuit repart de zero ; l etat d entree n est jamais mute', () => {
  const T = 1_700_000_000_000;
  const s = Object.freeze({ night: 7, shelters: 4, lastEmitAt: T });
  const n = lockdownShelterNote(s, { night: 8, now: T + 1000 });
  assert.deepStrictEqual([n.reenter, n.count, n.emit], [false, 0, false]);
  assert.deepStrictEqual(n.state, { night: 8, shelters: 1, lastEmitAt: 0 });
  assert.deepStrictEqual(s, { night: 7, shelters: 4, lastEmitAt: T });
  const z = lockdownShelterNote(undefined, {});
  assert.strictEqual(z.reenter, false);
});

test('planner : NUIT AU TRAVAIL — underground:true au-dessus de y 45 = sous-sol (mine, diffère la surface)', () => {
  assert.strictEqual(nightPlannerStep({ lockdown: true, y: 58, underground: true, skill: 'branchMine', sinceShelterMs: 5 * 60000 }), 'run');
  assert.strictEqual(nightPlannerStep({ lockdown: true, y: 58, underground: true, skill: 'gatherLog' }), 'wait');
  assert.strictEqual(nightPlannerStep({ lockdown: true, y: 58, underground: false, skill: 'branchMine', sinceShelterMs: 5 * 60000 }), 'shelter',
    'sans le relevé, y 58 reste la surface');
  assert.strictEqual(nightPlannerStep({ lockdown: false, y: 70, underground: true, skill: 'gatherLog' }), 'run', 'hors lockdown rien ne change');
});
