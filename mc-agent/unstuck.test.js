'use strict';
// Anti-stuck eau (#1 retours live) : détection + évasion vers la terre ferme.
const { test } = require('node:test');
const assert = require('node:assert');
const vec3 = require('vec3');
const { isInWater, findLandTarget, escapeWater, WATER } = require('./unstuck');

function waterBot({ inWater = true, landAt = null, pos = { x: 0, y: 62, z: 0 } } = {}) {
  const bot = {
    entity: { position: vec3(pos.x, pos.y, pos.z), isInWater: inWater },
    controls: {},
    setControlState(c, v) { this.controls[c] = v; },
    pathfinder: { setGoal: () => {}, goto: async () => {} },
    findBlocks({ count }) {
      if (!landAt) return [];
      return [vec3(landAt.x, landAt.y, landAt.z)];
    },
    blockAt(p) {
      if (landAt && p.x === landAt.x && p.z === landAt.z) {
        if (p.y === landAt.y) return { name: 'grass_block', boundingBox: 'block' };
        return { name: 'air', boundingBox: 'empty' };                 // l'air au-dessus de la terre
      }
      return { name: 'water', boundingBox: 'empty' };
    },
  };
  return bot;
}

test('isInWater : flag mineflayer prioritaire, fallback bloc aux pieds', () => {
  assert.ok(isInWater(waterBot({ inWater: true })));
  assert.ok(!isInWater(waterBot({ inWater: false })));
  // fallback : pas de flag → bloc aux pieds
  const b = waterBot({}); delete b.entity.isInWater;
  assert.ok(isInWater(b)); // blockAt → water
});

test('findLandTarget : trouve le bloc solide avec 2 airs au-dessus, rejette le fond marin', () => {
  const bot = waterBot({ landAt: { x: 10, y: 63, z: 4 } });
  const land = findLandTarget(bot);
  assert.ok(land && land.x === 10 && land.z === 4);
  // fond marin (y trop bas sous le bot) → rejeté
  const deep = waterBot({ landAt: { x: 10, y: 40, z: 4 } });
  assert.strictEqual(findLandTarget(deep), null);
});

test('escapeWater : nage (jump) + goto vers la terre → ok quand sorti de l\'eau', async () => {
  const bot = waterBot({ landAt: { x: 10, y: 63, z: 4 } });
  const gotos = [];
  const events = [];
  const r = await escapeWater(bot, {
    emit: (e) => events.push(e),
    sleep: async () => {},
    goto: async (p) => { gotos.push(p); bot.entity.isInWater = false; bot.entity.position = vec3(p.x + 0.5, p.y + 1, p.z + 0.5); }, // atteindre la terre = sorti
  });
  assert.ok(r.ok);
  assert.strictEqual(gotos.length, 1);
  assert.strictEqual(gotos[0].x, 10);
  assert.strictEqual(bot.controls.jump, false);               // contrôles relâchés à la fin
  assert.ok(events.some((e) => e.type === 'unstuck' && e.cause === 'water'));
});

test('escapeWater : borné dans le temps — rend ok:false si toujours dans l\'eau (pas de boucle infinie)', async () => {
  const bot = waterBot({ landAt: null });                     // aucune terre en vue
  const r = await escapeWater(bot, { sleep: async () => {}, timeoutMs: 1, goto: async () => {} });
  assert.strictEqual(r.ok, false);
});

test('WATER couvre les blocs aquatiques courants', () => {
  for (const n of ['water', 'flowing_water', 'kelp', 'seagrass']) assert.ok(WATER.has(n));
});

// --- #9 lianes / #8 flottant ---
const { clearSnares, isFloatingStuck, recoverFloating, SNARES } = require('./unstuck');

test('clearSnares : casse les lianes adjacentes (pieds/tête/voisins), no-op sinon', async () => {
  const dug = [];
  const bot = {
    entity: { position: vec3(0.5, 64, 0.5) },
    blockAt(p) {
      if (p.x === 0 && p.y === 65 && p.z === 0) return { name: 'vine', boundingBox: 'empty', position: p };
      if (p.x === 1 && p.y === 64 && p.z === 0) return { name: 'cobweb', boundingBox: 'empty', position: p };
      return { name: 'air', boundingBox: 'empty', position: p };
    },
    dig: async (b) => { dug.push(b.name); },
  };
  const n = await clearSnares(bot);
  assert.strictEqual(n, 2);
  assert.ok(dug.includes('vine') && dug.includes('cobweb'));
  // monde propre → 0
  bot.blockAt = (p) => ({ name: 'air', boundingBox: 'empty', position: p });
  assert.strictEqual(await clearSnares(bot), 0);
});

test('isFloatingStuck : flottant immobile ≥1.5s → true ; au sol / dans l\'eau / en mouvement → false', () => {
  const prev = { x: 0, z: 0, t: 0 };
  assert.ok(isFloatingStuck(prev, { x: 0.1, z: 0, t: 2000 }, { onGround: false, inWater: false }));
  assert.ok(!isFloatingStuck(prev, { x: 0.1, z: 0, t: 2000 }, { onGround: true, inWater: false }));
  assert.ok(!isFloatingStuck(prev, { x: 0.1, z: 0, t: 2000 }, { onGround: false, inWater: true }));
  assert.ok(!isFloatingStuck(prev, { x: 5, z: 5, t: 2000 }, { onGround: false, inWater: false }));   // bouge
  assert.ok(!isFloatingStuck(prev, { x: 0.1, z: 0, t: 800 }, { onGround: false, inWater: false }));  // trop tôt
});

test('isFloatingStuck : en CHUTE/SAUT (vy fort) → false (pas coincé) ; vy≈0 → true', () => {
  const prev = { x: 0, z: 0, t: 0 };
  const cur = { x: 0.1, z: 0, t: 2000 };                                  // immobile horizontalement
  assert.ok(!isFloatingStuck(prev, cur, { onGround: false, inWater: false, vy: -1.2 })); // chute
  assert.ok(!isFloatingStuck(prev, cur, { onGround: false, inWater: false, vy: 0.42 }));  // saut (montée)
  assert.ok(isFloatingStuck(prev, cur, { onGround: false, inWater: false, vy: 0.02 }));   // vraiment coincé
  assert.ok(isFloatingStuck(prev, cur, { onGround: false, inWater: false }));             // vy absent = rétro-compat
});

test('recoverFloating : relâche TOUT + coupe le pathfinder + retombe au sol', async () => {
  let cleared = 0, goalCleared = 0, polls = 0;
  const bot = {
    entity: { position: vec3(0, 66, 0), onGround: false },
    clearControlStates() { cleared++; },
    pathfinder: { setGoal: (g) => { if (g === null) goalCleared++; } },
    blockAt: (p) => ({ name: 'air', boundingBox: 'empty', position: p }),
    dig: async () => {},
  };
  const r = await recoverFloating(bot, {
    sleep: async () => { polls++; if (polls >= 2) bot.entity.onGround = true; }, // retombe après 2 polls
  });
  assert.ok(r.ok);
  assert.strictEqual(cleared, 1);
  assert.ok(goalCleared >= 1);
});

test('SNARES couvre lianes jungle + cave vines + cobweb', () => {
  for (const n of ['vine', 'cave_vines', 'twisting_vines', 'weeping_vines', 'cobweb']) assert.ok(SNARES.has(n), n);
});

// ─── Watchdog DESYNC (piste n°5 rapport water-wall) : NethBot1 figé 15 min, position au dixième
// près identique pendant que les events tournent (client désynchronisé, invisible du self-healing
// et du jam-watchdog qui exige un goal pathfinder). Signature = N échantillons STRICTEMENT égaux.

const { isFrozenDesync } = require('./unstuck');

test('isFrozenDesync : 10 échantillons strictement identiques → true', () => {
  const s = Array.from({ length: 10 }, () => ({ x: -337.5, y: 104.0, z: -437.3 }));
  assert.strictEqual(isFrozenDesync(s), true);
});

test('isFrozenDesync : le moindre mouvement (>0.1) casse la détection', () => {
  const s = Array.from({ length: 10 }, () => ({ x: -337.5, y: 104.0, z: -437.3 }));
  s[7] = { x: -337.9, y: 104.0, z: -437.3 };    // 0.4 de dérive = vivant
  assert.strictEqual(isFrozenDesync(s), false);
});

test('isFrozenDesync : micro-jitter sous le dixième compte comme identique (arrondi)', () => {
  const s = Array.from({ length: 10 }, (_, i) => ({ x: -337.5 + i * 0.001, y: 104.0, z: -437.3 }));
  assert.strictEqual(isFrozenDesync(s), true);
});

test('isFrozenDesync : pas assez d\'échantillons → false (fenêtre incomplète)', () => {
  const s = Array.from({ length: 6 }, () => ({ x: 0, y: 64, z: 0 }));
  assert.strictEqual(isFrozenDesync(s), false);
  assert.strictEqual(isFrozenDesync([], {}), false);
  assert.strictEqual(isFrozenDesync(null), false);
});

test('isFrozenDesync : need injectable (fenêtre plus courte pour les tests live)', () => {
  const s = Array.from({ length: 4 }, () => ({ x: 1, y: 2, z: 3 }));
  assert.strictEqual(isFrozenDesync(s, { need: 4 }), true);
});

test('isFrozenDesync : digging → fenêtre ÉTENDUE (20) au lieu de reset — un dig gelé reste détectable', () => {
  // Vécu live world_ax2 : 3 bots gelés EN PLEIN DIG (targetDigBlock figé non-null) → l'ancien gate
  // resetait les échantillons → desync invisible. Un dig légitime ne dure jamais 10 min.
  const frozen10 = Array.from({ length: 10 }, () => ({ x: -433.5, y: 67.0, z: -296.5 }));
  const frozen20 = Array.from({ length: 20 }, () => ({ x: -433.5, y: 67.0, z: -296.5 }));
  assert.strictEqual(isFrozenDesync(frozen10, { digging: true }), false);   // 5 min en dig = encore légitime
  assert.strictEqual(isFrozenDesync(frozen20, { digging: true }), true);    // 10 min figé en dig = desync
  assert.strictEqual(isFrozenDesync(frozen10, { digging: false }), true);   // hors dig : 5 min suffisent (inchangé)
});

// ─── ANTI-CAMPING DU SPAWNPOINT (escapePlan / escapeReached / canReanchorSpawn) ──────────────────
// Flagrant délit world_mn15 (NethBot3, 02:50-02:51) : un squelette campe le point de réapparition,
// le bot respawne, se fait abattre, ré-ancre le /spawnpoint AU MÊME ENDROIT, recommence.
// 4 morts en 36 s. En sans-give le « warp » d'évasion (/spreadplayers) est bloqué par nogive :
// il ne restait donc QUE le ré-ancrage, qui CIMENTE le piège.
const { escapePlan, escapeReached, canReanchorSpawn,
  ESCAPE_MIN_DIST, ESCAPE_MAX_DIST, ESCAPE_SAFE_RADIUS, ESCAPE_REACHED_DIST } = require('./unstuck');

const _d2 = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);

test('escapePlan : sans-give → fuite À PIED (jamais le warp, qui est un no-op bloqué par nogive)', () => {
  const p = escapePlan({ noGive: true, pos: { x: 10, y: 64, z: -20 }, rand: () => 0.5 });
  assert.strictEqual(p.mode, 'walk');
});

test('escapePlan : mode admin (give autorisé) → warp, comportement historique INCHANGÉ', () => {
  const p = escapePlan({ noGive: false, pos: { x: 10, y: 64, z: -20 }, rand: () => 0.5 });
  assert.strictEqual(p.mode, 'warp');
});

test('escapePlan : distance de fuite dans [30, 60] blocs, quel que soit le tirage', () => {
  for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
    const p = escapePlan({ noGive: true, pos: { x: 0, y: 64, z: 0 }, rand: () => r });
    assert.ok(p.dist >= ESCAPE_MIN_DIST, `dist ${p.dist} >= ${ESCAPE_MIN_DIST}`);
    assert.ok(p.dist <= ESCAPE_MAX_DIST, `dist ${p.dist} <= ${ESCAPE_MAX_DIST}`);
    // et la cible est bien à cette distance du point campé
    assert.ok(Math.abs(_d2({ x: 0, z: 0 }, p) - p.dist) < 1.5);
  }
});

test('escapePlan : hostile en vue → on part À L OPPOSÉ (jamais vers le squelette)', () => {
  // squelette plein EST du bot → la cible doit être à l'OUEST (x < 0)
  const p = escapePlan({ noGive: true, pos: { x: 0, y: 64, z: 0 }, hostile: { x: 12, y: 64, z: 0 }, rand: () => 0.5 });
  assert.ok(p.x < 0, `cible x=${p.x} doit être à l'opposé (x<0)`);
  assert.ok(Math.abs(p.z) < 1, 'même axe → pas de dérive latérale');
  // et on s'éloigne bien de la menace
  assert.ok(_d2(p, { x: 12, z: 0 }) > _d2({ x: 0, z: 0 }, { x: 12, z: 0 }));
});

test('escapePlan : hostile PILE sur le bot (même colonne) → cap arbitraire, jamais NaN', () => {
  const p = escapePlan({ noGive: true, pos: { x: 5, y: 64, z: 5 }, hostile: { x: 5, y: 64, z: 5 }, rand: () => 0.5 });
  assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z));
  assert.ok(_d2({ x: 5, z: 5 }, p) >= ESCAPE_MIN_DIST - 1);
});

test('escapePlan : sans hostile en vue → direction aléatoire (rand injectable = déterministe)', () => {
  const a = escapePlan({ noGive: true, pos: { x: 0, y: 64, z: 0 }, rand: () => 0 });
  const b = escapePlan({ noGive: true, pos: { x: 0, y: 64, z: 0 }, rand: () => 0.5 });
  assert.ok(Number.isFinite(a.x) && Number.isFinite(b.x));
  assert.notDeepStrictEqual({ x: a.x, z: a.z }, { x: b.x, z: b.z });   // deux tirages ≠ même cap
});

test('escapePlan : sans position → null (pas de fuite fantôme, pas de ré-ancrage)', () => {
  assert.strictEqual(escapePlan({ noGive: true, pos: null }), null);
  assert.strictEqual(escapePlan({ noGive: true }), null);
});

test('escapePlan : la cible garde une altitude de référence (celle du bot)', () => {
  const p = escapePlan({ noGive: true, pos: { x: 0, y: 71, z: 0 }, rand: () => 0.5 });
  assert.strictEqual(p.y, 71);
});

test('escapeReached : il faut avoir VRAIMENT quitté le lieu du camping', () => {
  const from = { x: 0, y: 64, z: 0 };
  assert.strictEqual(escapeReached(from, { x: 40, y: 64, z: 0 }), true);
  assert.strictEqual(escapeReached(from, { x: 3, y: 64, z: 2 }), false);   // coincé sur place
  assert.strictEqual(escapeReached(from, from), false);
  assert.strictEqual(escapeReached(from, null), false);
  assert.strictEqual(escapeReached(null, { x: 99, y: 64, z: 99 }), false);
});

test('escapeReached : l ALTITUDE ne compte pas (fuir en descendant reste une fuite)', () => {
  assert.strictEqual(escapeReached({ x: 0, y: 64, z: 0 }, { x: 0, y: 12, z: 40 }), true);
});

test('escapeReached : seuil injectable', () => {
  assert.strictEqual(escapeReached({ x: 0, y: 64, z: 0 }, { x: 10, y: 64, z: 0 }, 8), true);
  assert.strictEqual(escapeReached({ x: 0, y: 64, z: 0 }, { x: 10, y: 64, z: 0 }, 12), false);
});

test('canReanchorSpawn : LE cœur du fix — jamais de /spawnpoint sur le lieu du camping', () => {
  // fuite échouée (bot coincé) → on ne ré-ancre PAS DU TOUT cette fois
  assert.strictEqual(canReanchorSpawn({ escaped: false, nearestHostileDist: null }), false);
  // fuite réussie mais un hostile campe encore la zone d'arrivée → pas d'ancrage non plus
  assert.strictEqual(canReanchorSpawn({ escaped: true, nearestHostileDist: 9 }), false);
  // fuite réussie + zone propre → ancrage
  assert.strictEqual(canReanchorSpawn({ escaped: true, nearestHostileDist: null }), true);
  assert.strictEqual(canReanchorSpawn({ escaped: true, nearestHostileDist: Infinity }), true);
  assert.strictEqual(canReanchorSpawn({ escaped: true, nearestHostileDist: ESCAPE_SAFE_RADIUS + 1 }), true);
});

test('canReanchorSpawn : la frontière des 16 blocs est INCLUSIVE côté danger', () => {
  assert.strictEqual(canReanchorSpawn({ escaped: true, nearestHostileDist: ESCAPE_SAFE_RADIUS }), false);
});

test('canReanchorSpawn : entrée vide/absurde → refus (par défaut on ne cimente rien)', () => {
  assert.strictEqual(canReanchorSpawn({}), false);
  assert.strictEqual(canReanchorSpawn(), false);
  assert.strictEqual(canReanchorSpawn({ escaped: true, nearestHostileDist: NaN }), false);
});

test('constantes : les seuils sont exportés et cohérents entre eux', () => {
  assert.ok(ESCAPE_MIN_DIST < ESCAPE_MAX_DIST);
  // on doit pouvoir « réussir » une fuite plus courte que le plan (terrain accidenté, NoPath partiel)
  assert.ok(ESCAPE_REACHED_DIST < ESCAPE_MIN_DIST);
  // sortir de la zone dangereuse doit être garanti par une fuite réussie
  assert.ok(ESCAPE_REACHED_DIST > ESCAPE_SAFE_RADIUS / 2);
});

// ─── FUITE DÈS LE SPAWN + HISTORIQUE DE MORTS QUI SURVIT AU PROCESS (live 19/10, MapBot1) ────────
// Journal serveur MESURÉ (cartographe non-op, sans lit, spawn du monde sous la canopée d'une forêt
// de bouleaux — les zombies n'y brûlent pas en plein jour) :
//   17:47:20 login (-3, 70, -1) · 17:47:25 / :32 / :37 / :54 « was slain by Zombie »
//   → death_loop (5 morts / 10 min) → process.exit(2) → relance 25 s plus tard → MÊME spawn.
// Deux défauts, une seule classe (« une mémoire d'échec par process ne sert à rien quand les sessions
// redémarrent sans cesse ») :
//   1. l'évasion anti-camping ne s'armait QU'APRÈS des morts → 2-3 vies perdues par génération ;
//   2. `deathTimes` vivait dans la mémoire du process → la relance repartait de zéro et recommençait.
const {
  spawnDanger, SPAWN_DANGER_RADIUS, SPAWN_DANGER_MIN_WORN,
  deathTimesPrune, deathTimesLoad, deathMemoWith, escapeArmed, deathLoopTripped,
  DEATH_WINDOW_MS, DEATH_HISTORY_CAP, DEATH_LOOP_LIMIT,
} = require('./unstuck');

const _mob = (name, dx, dz, dy = 0, kind = 'Hostile mobs') => ({ name, kind, position: { x: dx, y: 70 + dy, z: dz } });
const _here = { x: 0, y: 70, z: 0 };

test('spawnDanger : nu + zombie à 8 blocs → FUIR (le cas MapBot1 : 0 mort encore, mais condamné)', () => {
  const d = spawnDanger({ worn: 0, pos: _here, entities: [_mob('zombie', 8, 0)] });
  assert.strictEqual(d.flee, true);
  assert.strictEqual(d.reason, 'naked_hostile_near');
  assert.strictEqual(d.mob, 'zombie');
  assert.strictEqual(d.dist, 8);
  assert.strictEqual(d.worn, 0);
});

test('spawnDanger : tous les hostiles de mêlée de la liste de la mission déclenchent la fuite', () => {
  for (const n of ['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'spider', 'cave_spider', 'creeper']) {
    const d = spawnDanger({ worn: 0, pos: _here, entities: [_mob(n, 6, 3)] });
    assert.strictEqual(d.flee, true, n);
    assert.strictEqual(d.mob, n);
  }
});

test('spawnDanger : ARMURÉ (≥2 pièces) → pas de fuite, même avec un zombie collé', () => {
  for (const worn of [2, 3, 4]) {
    const d = spawnDanger({ worn, pos: _here, entities: [_mob('zombie', 1, 0)] });
    assert.strictEqual(d.flee, false, `worn=${worn}`);
    assert.strictEqual(d.reason, 'armored');
  }
});

test('spawnDanger : hostile à 20 blocs → pas de fuite (trop loin pour justifier de courir)', () => {
  const d = spawnDanger({ worn: 0, pos: _here, entities: [_mob('zombie', 20, 0)] });
  assert.strictEqual(d.flee, false);
  assert.strictEqual(d.reason, 'too_far');
  assert.strictEqual(d.dist, 20);          // on garde la mesure : elle sert à tracer pourquoi on est resté
  assert.strictEqual(d.mob, 'zombie');
});

test('spawnDanger : AUCUN hostile → pas de fuite (liste vide, absente, ou seulement des passifs)', () => {
  assert.strictEqual(spawnDanger({ worn: 0, pos: _here, entities: [] }).flee, false);
  assert.strictEqual(spawnDanger({ worn: 0, pos: _here }).flee, false);
  assert.strictEqual(spawnDanger({ worn: 0, pos: _here, entities: [_mob('cow', 2, 0, 0, 'Passive mobs')] }).flee, false);
  assert.strictEqual(spawnDanger({ worn: 0, pos: _here, entities: [] }).reason, 'no_hostile');
});

test('spawnDanger : la frontière des 12 blocs est INCLUSIVE', () => {
  assert.strictEqual(SPAWN_DANGER_RADIUS, 12);
  assert.strictEqual(spawnDanger({ worn: 0, pos: _here, entities: [_mob('zombie', 12, 0)] }).flee, true);
  assert.strictEqual(spawnDanger({ worn: 0, pos: _here, entities: [_mob('zombie', 12.01, 0)] }).flee, false);
});

test('spawnDanger : 1 pièce = ENCORE nu, 2 pièces = armuré (même « nu » que caution/homes)', () => {
  assert.strictEqual(SPAWN_DANGER_MIN_WORN, 2);
  assert.strictEqual(spawnDanger({ worn: 1, pos: _here, entities: [_mob('zombie', 5, 0)] }).flee, true);
  assert.strictEqual(spawnDanger({ worn: 2, pos: _here, entities: [_mob('zombie', 5, 0)] }).flee, false);
});

test('« nu » : UNE seule définition du mot pour trois gardes (caution, homes, spawn)', () => {
  assert.strictEqual(SPAWN_DANGER_MIN_WORN, require('./caution').CAUTION_MIN_WORN);
  assert.strictEqual(SPAWN_DANGER_MIN_WORN, require('./homes').DEBT_MIN_WORN);
});

test('spawnDanger : la distance est 3D (un zombie 11 blocs plus bas, dans une grotte, n est pas « à 5 blocs »)', () => {
  // 5 à plat mais 11 de dénivelé → 12,08 : hors rayon. À 10 de dénivelé → 11,18 : dedans.
  assert.strictEqual(spawnDanger({ worn: 0, pos: _here, entities: [_mob('zombie', 5, 0, -11)] }).flee, false);
  assert.strictEqual(spawnDanger({ worn: 0, pos: _here, entities: [_mob('zombie', 5, 0, -10)] }).flee, true);
});

test('spawnDanger : plusieurs hostiles → le PLUS PROCHE est retenu et nommé', () => {
  const d = spawnDanger({
    worn: 0, pos: _here,
    entities: [_mob('skeleton', 11, 0), _mob('zombie', 4, 3), _mob('creeper', 9, 0)],
  });
  assert.strictEqual(d.flee, true);
  assert.strictEqual(d.mob, 'zombie');
  assert.strictEqual(d.dist, 5);
});

test('spawnDanger : par DÉFAUT seuls les « Hostile mobs » comptent (vache, joueur, item : non)', () => {
  const d = spawnDanger({
    worn: 0, pos: _here,
    entities: [
      _mob('cow', 2, 0, 0, 'Passive mobs'),
      { name: 'Massii_08', type: 'player', position: { x: 1, y: 70, z: 0 } },
      { name: 'item', kind: 'Drops', position: { x: 1, y: 70, z: 1 } },
    ],
  });
  assert.strictEqual(d.flee, false);
});

test('spawnDanger : prédicat injectable (l appelant exclut l enderman neutre, ajoute les nommés)', () => {
  const ents = [_mob('enderman', 3, 0), _mob('zombie', 10, 0)];
  // exclusion de l'enderman → c'est le zombie (10) qui est retenu
  const isHostile = (e) => e.kind === 'Hostile mobs' && e.name !== 'enderman';
  const d = spawnDanger({ worn: 0, pos: _here, entities: ents, isHostile });
  assert.strictEqual(d.mob, 'zombie');
  // un mob SANS kind mais listé par nom (entité pas encore résolue) passe si le prédicat le dit
  const named = spawnDanger({
    worn: 0, pos: _here, entities: [{ name: 'zombie', position: { x: 3, y: 70, z: 0 } }],
    isHostile: (e) => e.name === 'zombie',
  });
  assert.strictEqual(named.flee, true);
});

test('spawnDanger : worn INCONNU (inventaire pas encore livré) = nu — « 0 = prudent », comme les autres gardes', () => {
  for (const worn of [undefined, null, NaN, -3, 'x']) {
    assert.strictEqual(spawnDanger({ worn, pos: _here, entities: [_mob('zombie', 5, 0)] }).flee, true, String(worn));
  }
});

test('spawnDanger : entrées absurdes → JAMAIS de throw, jamais de fuite', () => {
  assert.strictEqual(spawnDanger().flee, false);
  assert.strictEqual(spawnDanger({}).flee, false);
  assert.strictEqual(spawnDanger({ worn: 0 }).flee, false);                          // pas de position
  assert.strictEqual(spawnDanger({ worn: 0 }).reason, 'no_position');
  assert.strictEqual(spawnDanger({ worn: 0, pos: { x: NaN, y: 70, z: 0 }, entities: [_mob('zombie', 1, 0)] }).flee, false);
  const junk = [null, undefined, 42, {}, { position: null }, { kind: 'Hostile mobs' },
    { kind: 'Hostile mobs', position: { x: NaN, y: 0, z: 0 } }];
  assert.strictEqual(spawnDanger({ worn: 0, pos: _here, entities: junk }).flee, false);
  // un prédicat qui explose sur une entité ne doit pas tuer la décision (ni masquer les autres)
  const boom = spawnDanger({
    worn: 0, pos: _here, entities: [_mob('weird', 1, 0), _mob('zombie', 7, 0)],
    isHostile: (e) => { if (e.name === 'weird') throw new Error('boom'); return true; },
  });
  assert.strictEqual(boom.flee, true);
  assert.strictEqual(boom.mob, 'zombie');
});

test('spawnDanger : rayon et seuil injectables', () => {
  const ents = [_mob('zombie', 20, 0)];
  assert.strictEqual(spawnDanger({ worn: 0, pos: _here, entities: ents, radius: 24 }).flee, true);
  assert.strictEqual(spawnDanger({ worn: 3, pos: _here, entities: [_mob('zombie', 5, 0)], minWorn: 4 }).flee, true);
});

// ── Compter les hostiles autour (partagé : fuite au spawn ET attente de l'aube dans l'abri) ──────
// Le MÊME balayage pour les deux décisions : si « hostile » ou « 3D » change d'un côté, l'autre suit.
const { scanHostiles, hostilesWithin } = require('./unstuck');

test('scanHostiles : les hostiles du plus proche au plus loin, avec leur nom et leur distance 3D', () => {
  const list = scanHostiles({
    pos: _here,
    entities: [_mob('skeleton', 11, 0), _mob('zombie', 4, 3), _mob('creeper', 9, 0), _mob('cow', 1, 0, 0, 'Passive mobs')],
  });
  assert.deepStrictEqual(list.map((h) => h.mob), ['zombie', 'creeper', 'skeleton']);
  assert.deepStrictEqual(list.map((h) => h.dist), [5, 9, 11]);
});

test('scanHostiles : prédicat injectable, prédicat qui lève sur UNE entité, entrées absurdes', () => {
  const ents = [_mob('weird', 1, 0), _mob('zombie', 7, 0), null, {}, { position: null }];
  const list = scanHostiles({
    pos: _here, entities: ents,
    isHostile: (e) => { if (e.name === 'weird') throw new Error('boom'); return true; },
  });
  assert.deepStrictEqual(list.map((h) => h.mob), ['zombie']);
  assert.deepStrictEqual(scanHostiles({ pos: null, entities: ents }), []);
  assert.deepStrictEqual(scanHostiles({ pos: { x: NaN, y: 0, z: 0 }, entities: ents }), []);
  assert.deepStrictEqual(scanHostiles({ pos: _here }), []);
  assert.deepStrictEqual(scanHostiles(), []);
  assert.deepStrictEqual(scanHostiles(null), []);
});

test('scanHostiles : ne mute pas les entités', () => {
  const ents = [_mob('zombie', 3, 0), _mob('skeleton', 2, 0)];
  const frozen = JSON.stringify(ents);
  scanHostiles({ pos: _here, entities: ents });
  assert.strictEqual(JSON.stringify(ents), frozen);
});

test('hostilesWithin : ne garde que ceux à ≤ 12 blocs (frontière INCLUSIVE, 3D) — le rayon de l abri et du spawn', () => {
  const ents = [_mob('zombie', 3, 0), _mob('skeleton', 12, 0), _mob('creeper', 12.01, 0), _mob('spider', 5, 0, -11)];
  const near = hostilesWithin({ pos: _here, entities: ents });
  assert.deepStrictEqual(near.map((h) => h.mob), ['zombie', 'skeleton']);
  // 5 à plat mais 11 de dénivelé → 12,08 : hors rayon (une grotte sous le bot n est pas « à côté »)
  assert.strictEqual(near.some((h) => h.mob === 'spider'), false);
  assert.strictEqual(hostilesWithin({ pos: _here, entities: ents }).length, 2);
});

test('hostilesWithin : le rayon par défaut EST celui du spawn (une seule définition de « près »)', () => {
  const ents = [_mob('zombie', SPAWN_DANGER_RADIUS, 0), _mob('skeleton', SPAWN_DANGER_RADIUS + 1, 0)];
  assert.strictEqual(hostilesWithin({ pos: _here, entities: ents }).length, 1);
  assert.strictEqual(hostilesWithin({ pos: _here, entities: ents, radius: 20 }).length, 2);
  assert.strictEqual(hostilesWithin({ pos: _here, entities: ents, radius: 0 }).length, 0);
});

test('hostilesWithin : entrées absurdes → [] (jamais de throw)', () => {
  assert.deepStrictEqual(hostilesWithin(), []);
  assert.deepStrictEqual(hostilesWithin({}), []);
  assert.deepStrictEqual(hostilesWithin({ pos: _here, entities: 'x' }), []);
});

test('spawnDanger et hostilesWithin lisent le MÊME monde : le plus proche du balayage = celui de la décision', () => {
  const ents = [_mob('skeleton', 11, 0), _mob('zombie', 4, 3), _mob('enderman', 6, 0)];
  const isHostile = (e) => e.kind === 'Hostile mobs' && e.name !== 'enderman';
  const d = spawnDanger({ worn: 0, pos: _here, entities: ents, isHostile });
  const scan = scanHostiles({ pos: _here, entities: ents, isHostile });
  assert.strictEqual(d.mob, scan[0].mob);
  assert.strictEqual(d.dist, scan[0].dist);
  assert.strictEqual(hostilesWithin({ pos: _here, entities: ents, isHostile }).length, 2);
});

// ── Historique de morts : élagage, chargement, rétro-compat ──────────────────────────────────────
const T0 = 1_700_000_000_000;
const MIN = 60 * 1000;

test('deathTimesPrune : ne garde que les morts de moins de 10 min (frontière EXCLUSIVE, comme l ancien filtre)', () => {
  assert.strictEqual(DEATH_WINDOW_MS, 10 * MIN);
  const now = T0 + 20 * MIN;
  const kept = deathTimesPrune([now - 11 * MIN, now - 10 * MIN, now - 10 * MIN + 1, now - MIN, now], now);
  assert.deepStrictEqual(kept, [now - 10 * MIN + 1, now - MIN, now]);
});

test('deathTimesPrune : une mort datée du FUTUR est jetée (horloge reculée / mémo hérité) — elle compterait « récente » à vie', () => {
  const now = T0;
  assert.deepStrictEqual(deathTimesPrune([now + 5 * MIN, now - MIN], now), [now - MIN]);
});

test('deathTimesPrune : triées du plus ancien au plus récent, plafonnées aux 10 plus récentes', () => {
  assert.strictEqual(DEATH_HISTORY_CAP, 10);
  const now = T0;
  const shuffled = [3, 1, 5, 2, 4, 9, 8, 7, 6, 12, 11, 10, 13].map((k) => now - k * 1000);
  const kept = deathTimesPrune(shuffled, now);
  assert.strictEqual(kept.length, 10);
  assert.deepStrictEqual(kept, [...kept].sort((a, b) => a - b));
  assert.strictEqual(kept[kept.length - 1], now - 1000);          // la plus récente est gardée
  assert.strictEqual(kept[0], now - 10 * 1000);                    // les 3 plus anciennes (11,12,13 s) sont tombées
});

test('deathTimesPrune : entrée absurde → [] (jamais de throw)', () => {
  const now = T0;
  for (const bad of [undefined, null, 'x', 7, {}, true]) assert.deepStrictEqual(deathTimesPrune(bad, now), []);
  assert.deepStrictEqual(deathTimesPrune([NaN, Infinity, 'a', null, undefined, {}, now - 1000], now), [now - 1000]);
  assert.deepStrictEqual(deathTimesPrune([now - 1000], NaN), []);
});

test('deathTimesPrune : ne mute pas son entrée', () => {
  const now = T0;
  const input = [now - 2000, now - 30 * MIN, now - 1000];
  const copy = [...input];
  deathTimesPrune(input, now);
  assert.deepStrictEqual(input, copy);
});

test('deathTimesLoad : un mémo d ANCIEN format (sans `deaths`) charge [] — rétro-compat', () => {
  const now = T0;
  assert.deepStrictEqual(deathTimesLoad({ base: { x: 1, y: 70, z: 2 }, personal: true }, now), []);
  assert.deepStrictEqual(deathTimesLoad(null, now), []);
  assert.deepStrictEqual(deathTimesLoad(undefined, now), []);
  assert.deepStrictEqual(deathTimesLoad({ deaths: 'pas un tableau' }, now), []);
});

test('deathTimesLoad : élague AU CHARGEMENT — les morts d il y a une heure ne ressuscitent pas', () => {
  const now = T0;
  assert.deepStrictEqual(
    deathTimesLoad({ deaths: [now - 60 * MIN, now - 9 * MIN, now - 2 * MIN] }, now),
    [now - 9 * MIN, now - 2 * MIN],
  );
});

test('deathMemoWith : remplace `deaths` en PRÉSERVANT les autres champs du mémo (base, dette, zone) — sans muter l entrée', () => {
  const memo = {
    base: { x: 10, y: 70, z: -4 }, worldSpawn: { x: 0, z: 0 }, personal: true,
    deathDebt: { x: 1, y: 2, z: 3, at: T0 }, zone: { anchoredAt: T0 - 5000, waterFails: 2 },
    deaths: [T0 - 9 * MIN],
  };
  const frozen = JSON.stringify(memo);
  const next = deathMemoWith(memo, [T0 - 5000, T0 - 1000], T0);
  assert.deepStrictEqual(next.deaths, [T0 - 5000, T0 - 1000]);
  for (const k of ['base', 'worldSpawn', 'personal', 'deathDebt', 'zone']) assert.deepStrictEqual(next[k], memo[k], k);
  assert.strictEqual(JSON.stringify(memo), frozen, 'l entrée n est pas mutée');
  assert.notStrictEqual(next, memo);
  // mémo absent (premier lancement) → un mémo qui ne contient que l'historique
  assert.deepStrictEqual(deathMemoWith(null, [T0 - 1000], T0), { deaths: [T0 - 1000] });
});

test('deathMemoWith : élague à l écriture aussi (le fichier ne grossit pas)', () => {
  const next = deathMemoWith({}, [T0 - 30 * MIN, T0 - MIN], T0);
  assert.deepStrictEqual(next.deaths, [T0 - MIN]);
});

// ── Décisions dérivées de l'historique ───────────────────────────────────────────────────────────
test('escapeArmed : 2 morts en moins de 60 s → armé (rafale — comportement d avant, inchangé)', () => {
  const now = T0;
  assert.strictEqual(escapeArmed([now - 40 * 1000, now], now), true);
  assert.strictEqual(escapeArmed([now - 61 * 1000, now], now), false);
});

test('escapeArmed : 3 morts en 10 min même espacées → armé (camping LENT, « fix fable1 ter »)', () => {
  const now = T0;
  assert.strictEqual(escapeArmed([now - 8 * MIN, now - 4 * MIN, now], now), true);
  assert.strictEqual(escapeArmed([now - 8 * MIN, now], now), false);
});

test('escapeArmed : les morts de plus de 10 min ne comptent plus', () => {
  const now = T0;
  assert.strictEqual(escapeArmed([now - 30 * MIN, now - 20 * MIN, now - 15 * MIN], now), false);
});

test('escapeArmed : historique vide ou absurde → pas armé (jamais de fuite sur du vent)', () => {
  assert.strictEqual(escapeArmed([], T0), false);
  assert.strictEqual(escapeArmed(null, T0), false);
  assert.strictEqual(escapeArmed(undefined, T0), false);
  assert.strictEqual(escapeArmed('x', T0), false);
});

test('deathLoopTripped : 5 morts de CE process en 10 min → sortie (comportement d avant)', () => {
  assert.strictEqual(DEATH_LOOP_LIMIT, 5);
  const boot = T0;
  const now = T0 + 40 * 1000;
  const five = [5, 12, 17, 34, 40].map((s) => boot + s * 1000);
  assert.strictEqual(deathLoopTripped(five, { bootAt: boot, now }), true);
  assert.strictEqual(deathLoopTripped(five.slice(1), { bootAt: boot, now }), false);   // 4 : pas encore
});

test('deathLoopTripped : les morts HÉRITÉES d un process précédent ne comptent PAS', () => {
  // Sinon : history persistée (5 morts) + 1 → sortie à la 1ʳᵉ mort de CHAQUE relance, vies < 15 s,
  // et le backend (3 vies < 15 s d'affilée = crash_on_spawn) ABANDONNE le bot. Le garde-fou doit
  // continuer à mesurer « ce process est-il pris dans une boucle ? », pas « le monde est-il mortel ? ».
  const bootB = T0;
  const inherited = [-60, -50, -45, -30, -25].map((s) => bootB + s * 1000);
  const now = bootB + 6 * 1000;
  const mine = [...inherited, now];
  assert.strictEqual(deathLoopTripped(mine, { bootAt: bootB, now }), false);
  // …mais 5 morts PROPRES, elles, sortent bien, quel que soit l'héritage
  const own5 = [1, 2, 3, 4, 5].map((s) => bootB + s * 1000);
  assert.strictEqual(deathLoopTripped([...inherited, ...own5], { bootAt: bootB, now: bootB + 5000 }), true);
});

test('deathLoopTripped : sans bootAt tout compte (comportement historique du garde-fou)', () => {
  const now = T0;
  const five = [5, 4, 3, 2, 1].map((s) => now - s * 1000);
  assert.strictEqual(deathLoopTripped(five, { now }), true);
});

test('deathLoopTripped : 5 morts étalées sur plus de 10 min → pas de sortie (fenêtre glissante)', () => {
  const boot = T0;
  const now = T0 + 30 * MIN;
  const spread = [0, 6, 12, 18, 24].map((m) => boot + m * MIN + 1000);
  assert.strictEqual(deathLoopTripped(spread, { bootAt: boot, now }), false);
});

test('deathLoopTripped : entrée absurde → false', () => {
  assert.strictEqual(deathLoopTripped(null, { now: T0 }), false);
  assert.strictEqual(deathLoopTripped(undefined, { now: T0 }), false);
  assert.strictEqual(deathLoopTripped([], { now: T0 }), false);
  assert.strictEqual(deathLoopTripped([T0], {}), false);
});

// ── LE scénario du bug, de bout en bout (sans réseau ni fichier) ─────────────────────────────────
test('SCÉNARIO MapBot1 : la rafale du process A survit au death_loop et arme la fuite du process B DÈS son démarrage', () => {
  // Process A démarre à T0 ; 5 morts en 36 s (journal serveur du 19/10) → death_loop → exit(2).
  const bootA = T0;
  let timesA = [];
  let onDisk = { base: { x: 10, y: 70, z: -4 }, deathDebt: { x: 1, y: 2, z: 3, at: T0 }, zone: { anchoredAt: T0 - 1000 } };
  let tripped = false;
  for (const s of [5, 12, 17, 34, 36]) {
    const now = bootA + s * 1000;
    timesA = deathTimesPrune(timesA.concat([now]), now);
    onDisk = JSON.parse(JSON.stringify(deathMemoWith(onDisk, timesA, now)));    // ce qui part VRAIMENT sur disque
    tripped = deathLoopTripped(timesA, { bootAt: bootA, now });
  }
  assert.strictEqual(tripped, true, 'la 5ᵉ mort déclenche la sortie');
  assert.strictEqual(onDisk.deaths.length, 5, 'et l historique COMPLET (5ᵉ mort comprise) est sur disque avant la sortie');

  // Process B : relancé 25 s plus tard. Mémoire VIDE — seul le fichier a survécu.
  const bootB = bootA + 36 * 1000 + 25 * 1000;
  const inherited = deathTimesLoad(onDisk, bootB);
  assert.strictEqual(inherited.length, 5);
  assert.strictEqual(escapeArmed(inherited, bootB), true, 'B sait déjà que ce spawn est campé : il fuit AVANT de mourir');

  // La 1ʳᵉ mort de B ne doit PAS le renvoyer au death_loop (sinon vies < 15 s → give_up backend)
  const nowB = bootB + 6 * 1000;
  const timesB = deathTimesPrune(inherited.concat([nowB]), nowB);
  assert.strictEqual(deathLoopTripped(timesB, { bootAt: bootB, now: nowB }), false);
  assert.strictEqual(escapeArmed(timesB, nowB), true);

  // Et les autres champs du mémo ont traversé tout le cycle intacts
  assert.deepStrictEqual(onDisk.base, { x: 10, y: 70, z: -4 });
  assert.deepStrictEqual(onDisk.deathDebt, { x: 1, y: 2, z: 3, at: T0 });
  assert.deepStrictEqual(onDisk.zone, { anchoredAt: T0 - 1000 });
});

// --- Run 12 : tête sous l'eau, corps « au sec » (NethBot2, `unstuck ok:true` en 0 ms en boucle) ---
const { waterEscapeMode, eyeInWater } = require('./unstuck');

test('waterEscapeMode : corps → swim ; yeux seuls ou O2 bas → head ; sinon dry', () => {
  assert.strictEqual(waterEscapeMode({ inWater: true, eyeWet: false, o2: 20 }), 'swim');
  assert.strictEqual(waterEscapeMode({ inWater: false, eyeWet: true, o2: 20 }), 'head');
  assert.strictEqual(waterEscapeMode({ inWater: false, eyeWet: false, o2: 3 }), 'head');
  assert.strictEqual(waterEscapeMode({ inWater: false, eyeWet: false, o2: 18 }), 'dry');
  assert.strictEqual(waterEscapeMode({ inWater: false, eyeWet: false }), 'dry');
});

// Cellule où SEUL le bloc des yeux est de l'eau (isInWater mineflayer = false). Rive à (3,63,0).
function headBot({ landAt = { x: 3, y: 63, z: 0 }, o2 = 4 } = {}) {
  const bot = {
    entity: { position: vec3(0.5, 64, 0.5), isInWater: false, yaw: 0 },
    oxygenLevel: o2,
    controls: {},
    setControlState(c, v) { this.controls[c] = v; },
    pathfinder: { setGoal: () => {} },
    findBlocks() { return landAt ? [vec3(0, 63, 0), vec3(landAt.x, landAt.y, landAt.z)] : [vec3(0, 63, 0)]; },
    blockAt(p) {
      const k = Math.floor(p.x) + ',' + Math.floor(p.y) + ',' + Math.floor(p.z);
      if (k === '0,65,0') return { name: 'water', boundingBox: 'empty' };       // les YEUX
      if (k === '0,63,0') return { name: 'dirt', boundingBox: 'block' };
      if (landAt && k === `${landAt.x},${landAt.y},${landAt.z}`) return { name: 'grass_block', boundingBox: 'block' };
      return { name: 'air', boundingBox: 'empty' };
    },
  };
  return bot;
}

test('eyeInWater : vrai quand le bloc des yeux est de l eau, même si isInWater est faux', () => {
  assert.strictEqual(eyeInWater(headBot()), true);
  const b = headBot(); b.entity.position = vec3(3.5, 64, 0.5);
  assert.strictEqual(eyeInWater(b), false);
});

test('escapeWater : tête sous l eau → NE rend PAS ok tout de suite, va à la rive à ≥ 2 blocs (pas sa propre colonne)', async () => {
  const bot = headBot();
  const gotos = [];
  const events = [];
  const r = await escapeWater(bot, {
    emit: (e) => events.push(e), sleep: async () => {},
    goto: async (p) => { gotos.push(p); bot.entity.position = vec3(p.x + 0.5, p.y + 1, p.z + 0.5); bot.oxygenLevel = 20; },
  });
  assert.ok(r.ok);
  assert.strictEqual(gotos.length, 1);
  assert.strictEqual(gotos[0].x, 3, 'la colonne du bot (0,63,0) est exclue');
  assert.ok(events.some((e) => e.type === 'unstuck' && e.mode === 'head'));
});

test('escapeWater : tête sous l eau sans rive → monte en pilier (casse le plafond), sort en un tour', async () => {
  const bot = headBot({ landAt: null });
  const climbs = [];
  const r = await escapeWater(bot, {
    sleep: async () => {}, goto: async () => {},
    pillarUp: async (b, { height }) => { climbs.push(height); b.entity.position = vec3(0.5, 66, 0.5); b.oxygenLevel = 20; return { ok: true, placed: 2 }; },
  });
  assert.ok(r.ok);
  assert.deepStrictEqual(climbs, [2]);
});

test('escapeWater : rive inatteignable (goto ne fait pas bouger, bord trop haut) → pilier après 2 essais', async () => {
  const bot = waterBot({ landAt: { x: 1, y: 63, z: 0 } });
  let gotos = 0; const climbs = [];
  const r = await escapeWater(bot, {
    sleep: async () => {}, goto: async () => { gotos++; },
    pillarUp: async (b) => { climbs.push(1); b.entity.isInWater = false; b.entity.position = vec3(1.5, 64, 0.5); return { ok: true, placed: 3 }; },
  });
  assert.ok(r.ok);
  assert.strictEqual(gotos, 2);
  assert.strictEqual(climbs.length, 1);
});
