'use strict';
// Boucle de cartographie (1b) : MARCHE ALÉATOIRE PERSISTANTE (#4 final — ni cercles, ni ligne
// parfaite, ni allées-retours), anti-océan (#5), cluster anti-stuck (#1/#8/#9), secteurs,
// biome_seen / cave_found.
const { test } = require('node:test');
const assert = require('node:assert');
const vec3 = require('vec3');
const { drawHeading, driftHeading, legTarget, isOceanCell, waterAhead, cellKey, runMapper,
        createExpiringSet } = require('./mapper');
const { headingOf, sectorRange, inSector } = require('./sectors');

// rng déterministe cyclant sur une séquence
function seqRng(seq) { let i = 0; return () => seq[i++ % seq.length]; }

// --- cellKey / isOceanCell (purs) ---

test('cellKey : quantifie sur la grille 128 (même cellule → même clé)', () => {
  assert.strictEqual(cellKey(10, 20), cellKey(100, 120));
  assert.notStrictEqual(cellKey(10, 20), cellKey(200, 20));
  assert.strictEqual(cellKey(-5, 0), cellKey(-120, 100)); // floor (pas trunc) côté négatif
});

test('isOceanCell : cellule avec biome océan connu → true ; terre/inconnu → false', () => {
  const memory = { worlds: { overworld: { biomes: [
    { name: 'deep_ocean', x: 300, z: 40 },
    { name: 'forest', x: 30, z: 40 },
  ], caves: [] } } };
  assert.ok(isOceanCell(memory, 'overworld', 310, 50));      // même cellule 128 que deep_ocean
  assert.ok(!isOceanCell(memory, 'overworld', 30, 40));      // forêt
  assert.ok(!isOceanCell(memory, 'overworld', -500, -500));  // inconnu
  assert.ok(!isOceanCell(null, 'overworld', 310, 50));
});

// --- drawHeading / driftHeading / legTarget (purs, #4 final) ---

test('drawHeading : sans secteur → uniforme 0..2π ; avec secteur → DANS le wedge', () => {
  assert.ok(Math.abs(drawHeading(seqRng([0.5]), null) - Math.PI) < 1e-9);
  const range = sectorRange(1, 2);
  for (const r of [0.05, 0.3, 0.6, 0.95]) {
    const h = drawHeading(seqRng([r]), { index: 1, count: 2 });
    assert.ok(inSector(h, range), `cap ${h} hors wedge (r=${r})`);
  }
});

test('driftHeading : dérive DOUCE bornée ±~25° (forte autocorrélation, pas de saut de cap)', () => {
  // rng: 0.5 (pas de bifurcation, 0.5 ≥ 0.08), puis delta — extrêmes 0 et 1
  const hMin = driftHeading(1.0, seqRng([0.5, 0]));   // delta = -driftRad
  const hMax = driftHeading(1.0, seqRng([0.5, 1]));   // delta = +driftRad
  assert.ok(Math.abs(hMin - (1.0 - Math.PI / 7)) < 1e-9);
  assert.ok(Math.abs(hMax - (1.0 + Math.PI / 7)) < 1e-9);
  // delta médian → cap inchangé (pas de biais systématique)
  assert.ok(Math.abs(driftHeading(1.0, seqRng([0.5, 0.5])) - 1.0) < 1e-9);
});

test('driftHeading : bifurcation franche OCCASIONNELLE (proba 8%) bornée ±90°', () => {
  // rng: 0.01 (< 0.08 → bifurcation), 1 (delta max = +90°)
  const h = driftHeading(1.0, seqRng([0.01, 1]));
  assert.ok(Math.abs(h - (1.0 + Math.PI / 2)) < 1e-9);
});

test('legTarget : jambe de 24-64 blocs le long du cap', () => {
  const t = legTarget({ x: 0, y: 64, z: 0 }, 0, seqRng([0.5])); // est, dist médiane 44
  assert.ok(Math.abs(t.x - 44) < 1e-9 && Math.abs(t.z) < 1e-9);
  const tMin = legTarget({ x: 0, y: 64, z: 0 }, 0, seqRng([0]));
  const tMax = legTarget({ x: 0, y: 64, z: 0 }, 0, seqRng([1]));
  assert.ok(Math.abs(tMin.x - 24) < 1e-9 && Math.abs(tMax.x - 64) < 1e-9);
});

// --- waterAhead (fake bot Vec3) ---

test('waterAhead : surface d\'eau droit devant → true ; terre → false ; non chargé → false', () => {
  const mkBot = (surface) => ({
    blockAt(p) {
      if (surface === null) return null;                                  // non chargé
      if (p.y > 63) return { name: 'air', boundingBox: 'empty' };
      return surface === 'water'
        ? { name: 'water', boundingBox: 'empty' }
        : { name: 'grass_block', boundingBox: 'block' };
    },
  });
  const from = { x: 0, y: 64, z: 0 };
  assert.ok(waterAhead(mkBot('water'), from, { x: 100, z: 0 }));
  assert.ok(!waterAhead(mkBot('land'), from, { x: 100, z: 0 }));
  assert.ok(!waterAhead(mkBot(null), from, { x: 100, z: 0 }));
});

// --- runMapper (boucle, fake bot Vec3) ---

function fakeMapperBot({ caveBeyond = null } = {}) {
  // sol = pierre pleine ; biome dépend de x ; option : colonnes d'air (grottes) au-delà d'un rayon
  const bot = {
    entity: { position: vec3(0, 64, 0), isInWater: false, onGround: true },
    entities: {},
    health: 20, food: 20,
    inventory: { items: () => [] },
    nearestEntity: () => null,
    findBlocks: () => [],
    setControlState: () => {},
    clearControlStates: () => {},
    dig: async () => {},
    blockAt(p) {
      if (caveBeyond != null && p.y < 64 && p.y > 64 - 10) {
        const d = Math.sqrt(p.x * p.x + p.z * p.z);
        if (d > caveBeyond) return { name: 'air', boundingBox: 'empty', biome: { name: 'plains', id: 1 } };
      }
      if (p.y > 63) return { name: 'air', boundingBox: 'empty', biome: { name: 'plains', id: 1 } };
      const biome = p.x >= 200 ? { name: 'desert', id: 5 } : { name: 'plains', id: 1 };
      return { name: 'stone', boundingBox: 'block', biome };
    },
    pvp: { attack: () => {}, stop: () => {} },
    pathfinder: { setGoal: () => {}, goto: async () => {} },
    registry: { itemsByName: {} },
    equip: async () => {}, consume: async () => {},
  };
  return bot;
}

test('runMapper : émet biome_seen en marchant, dédup par cellule, NE s\'arrête PAS après une trouvaille', async () => {
  const bot = fakeMapperBot();
  const events = [];
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld',
    emit: (e) => {
      events.push(e);
      if (events.filter((x) => x.type === 'biome_seen').length >= 6 || events.length > 800) token.cancelled = true;
    },
    goto: async (wp) => { bot.entity.position = vec3(wp.x, 64, wp.z); },
    sleep: async () => {},
  }, token);
  const biomes = events.filter((e) => e.type === 'biome_seen');
  assert.ok(biomes.length >= 6, `seulement ${biomes.length} biome_seen — la boucle s'est arrêtée trop tôt`);
  const cells = biomes.map((e) => cellKey(e.x, e.z));
  assert.strictEqual(new Set(cells).size, cells.length, 'biome_seen dupliqué dans une même cellule');
  assert.ok(biomes.every((e) => e.world === 'overworld'));
});

test('runMapper #4 : PROGRESSION GLOBALE — pas d\'oscillation ni de cercles (s\'éloigne du départ)', async () => {
  const bot = fakeMapperBot();
  const hops = [];
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld',
    emit: () => {},
    goto: async (wp) => { hops.push({ x: wp.x, z: wp.z }); bot.entity.position = vec3(wp.x, 64, wp.z); if (hops.length >= 12) token.cancelled = true; },
    sleep: async () => {},
  }, token);
  assert.ok(hops.length >= 12);
  // progression globale : la position finale est LOIN du départ (pas de boucle sur place)
  const last = hops[hops.length - 1];
  const distFinal = Math.sqrt(last.x * last.x + last.z * last.z);
  assert.ok(distFinal > 100, `dist finale ${distFinal.toFixed(0)} — le bot tourne en rond`);
  // pas d'allées-retours SYSTÉMATIQUES : une cellule peut être re-visitée UNE fois (backtrack
  // ponctuel humain, jambes consécutives dans la même cellule = une seule visite), pas en boucle.
  const visits = {};
  let prevCell = null;
  for (const h of hops) {
    const k = cellKey(h.x, h.z);
    if (k !== prevCell) { visits[k] = (visits[k] || 0) + 1; prevCell = k; }
  }
  assert.ok(Math.max(...Object.values(visits)) <= 2, 'oscillation détectée (cellule re-visitée 3+ fois)');
});

test('runMapper #4 : caps AUTOCORRÉLÉS — virages doux entre jambes consécutives (pas erratique)', async () => {
  const bot = fakeMapperBot();
  const hops = [{ x: 0, z: 0 }];
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld',
    // bigTurnP 0 → uniquement la dérive douce (le test vérifie la borne ±45° incluant le biais cellule)
    bigTurnP: 0,
    emit: () => {},
    goto: async (wp) => { hops.push({ x: wp.x, z: wp.z }); bot.entity.position = vec3(wp.x, 64, wp.z); if (hops.length >= 10) token.cancelled = true; },
    sleep: async () => {},
  }, token);
  let soft = 0, total = 0;
  for (let i = 2; i < hops.length; i++) {
    const h1 = Math.atan2(hops[i - 1].z - hops[i - 2].z, hops[i - 1].x - hops[i - 2].x);
    const h2 = Math.atan2(hops[i].z - hops[i - 1].z, hops[i].x - hops[i - 1].x);
    let d = Math.abs(h2 - h1) % (2 * Math.PI);
    if (d > Math.PI) d = 2 * Math.PI - d;
    total++;
    if (d <= Math.PI / 2 + 1e-9) soft++; // virage ≤90° (dérive 25° + biais cellule 45°)
  }
  assert.ok(soft / total >= 0.8, `${soft}/${total} virages doux — locomotion erratique`);
});

test('runMapper : détecte les entrées de grotte en route → cave_found (coords seulement)', async () => {
  // colonnes d'air (grottes) partout au-delà de 30 blocs du spawn → la marche en croise vite une
  const bot = fakeMapperBot({ caveBeyond: 30 });
  const events = [];
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld',
    emit: (e) => { events.push(e); if (e.type === 'cave_found' || events.length > 100) token.cancelled = true; },
    goto: async (wp) => { bot.entity.position = vec3(wp.x, 64, wp.z); },
    sleep: async () => {},
  }, token);
  const caves = events.filter((e) => e.type === 'cave_found');
  assert.ok(caves.length >= 1, 'aucune cave_found émise');
  assert.strictEqual(caves[0].world, 'overworld');
  assert.ok(typeof caves[0].x === 'number' && typeof caves[0].y === 'number' && typeof caves[0].z === 'number');
});

test('runMapper : secteur live (getSector) — la marche reste dans le wedge (cibles vues du départ)', async () => {
  const bot = fakeMapperBot();
  const gotos = [];
  const token = { cancelled: false };
  const home = { x: 0, y: 64, z: 0 };
  await runMapper(bot, {
    worldKey: 'overworld',
    emit: () => { if (gotos.length >= 8) token.cancelled = true; },
    goto: async (wp) => { gotos.push({ x: wp.x, z: wp.z }); bot.entity.position = vec3(wp.x, 64, wp.z); },
    getSector: () => ({ index: 1, count: 2 }),
    sleep: async () => {},
  }, token);
  assert.ok(gotos.length > 0);
  // le CAP de chaque jambe reste dans le wedge → la trajectoire globale aussi (tolérance overlap)
  const range = sectorRange(1, 2, 35); // wedge élargi de la marge de dérive par jambe
  for (let i = 1; i < gotos.length; i++) {
    const h = headingOf(gotos[i - 1], gotos[i]);
    assert.ok(inSector(h, range), `jambe ${i} hors wedge (cap ${h.toFixed(2)})`);
  }
});

test('runMapper : token déjà annulé → retour immédiat sans goto', async () => {
  const bot = fakeMapperBot();
  let moved = 0;
  await runMapper(bot, {
    worldKey: 'overworld', emit: () => {},
    goto: async () => { moved++; }, sleep: async () => {},
  }, { cancelled: true });
  assert.strictEqual(moved, 0);
});

test('runMapper #5 : océan partout devant → tourne (mapper_turn/mapper_blocked), PAS de goto vers l\'eau', async () => {
  const bot = fakeMapperBot();
  // toute la surface est de l'eau sauf la cellule de départ → toutes les jambes bloquées
  bot.blockAt = (p) => {
    if (p.y > 63) return { name: 'air', boundingBox: 'empty', biome: { name: 'plains', id: 1 } };
    const d = Math.sqrt(p.x * p.x + p.z * p.z);
    if (d > 10) return { name: 'water', boundingBox: 'empty', biome: { name: 'ocean', id: 0 } };
    return { name: 'stone', boundingBox: 'block', biome: { name: 'plains', id: 1 } };
  };
  const events = [];
  let moved = 0;
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld',
    emit: (e) => { events.push(e); if (e.type === 'mapper_blocked') token.cancelled = true; },
    goto: async () => { moved++; },
    sleep: async () => {},
  }, token);
  assert.strictEqual(moved, 0, 'le bot a marché vers l\'océan');
  assert.ok(events.some((e) => e.type === 'mapper_blocked'));
});

test('runMapper : mappeur PIÉGÉ (goto rejette toujours) → ÉCHAPPEMENT relocate + streak borné + throttle (anti hot-loop #43a)', async () => {
  // terre partout, pas d'eau → on prend le chemin « inatteignable » (pas le blocage océan).
  // Vécu world_mn9 : un mappeur muré en terrain montagneux martelait doGoto ~39×/s
  // (109 851 rejets, 16 arrivées, streak >12 000) → event-loop saturée. Sans issue ni throttle.
  const bot = fakeMapperBot();
  const events = [];
  let sleeps = 0;
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld',
    emit: (e) => {
      events.push(e);
      if (events.some((x) => x.type === 'mapper_relocate') ||
          events.filter((x) => x.type === 'mapper_turn' && x.reason === 'unreachable').length >= 40) {
        token.cancelled = true;
      }
    },
    goto: async () => { throw new Error('no path'); },  // bot muré : chaque jambe rejetée
    sleep: async () => { sleeps++; },                   // le throttle DOIT être appelé
  }, token);

  // 1) un échappement de relocalisation a été déclenché (sinon spin infini)
  assert.ok(events.some((e) => e.type === 'mapper_relocate'),
    'aucun mapper_relocate : le mappeur piégé spinne sans issue');
  // 2) le streak inatteignable reste BORNÉ (réinitialisé à l'échappement)
  const maxStreak = Math.max(0, ...events
    .filter((e) => e.type === 'mapper_turn' && e.reason === 'unreachable')
    .map((e) => e.streak));
  assert.ok(maxStreak <= 6, `streak non borné (${maxStreak}) : pas de réinitialisation`);
  // 3) le hot-loop est throttlé (sleep appelé entre les échecs)
  assert.ok(sleeps >= 1, 'aucun throttle sleep dans la boucle d\'échec → CPU hot-loop');
});

test('runMapper : survie prioritaire — hostile×3 → fuit avant de bouger (survivalTick branché)', async () => {
  const bot = fakeMapperBot();
  for (let i = 0; i < 3; i++) {
    bot.entities[i] = { name: 'zombie', kind: 'Hostile mobs', type: 'mob', position: vec3(2 + i, 64, 0), isValid: true };
  }
  const events = [];
  let fled = 0;
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld',
    emit: (e) => { events.push(e); if (fled >= 1 && events.length > 2) token.cancelled = true; },
    goto: async (wp) => { bot.entity.position = vec3(wp.x, 64, wp.z); },
    fleeFrom: () => { fled++; bot.entities = {}; return true; },
    sleep: async () => {},
  }, token);
  assert.ok(fled >= 1, 'fleeFrom jamais appelé malgré 3 hostiles');
  assert.ok(events.some((e) => e.type === 'survival' && e.action === 'flee'));
});

test('runMapper #1 : dans l\'eau au départ → escapeWater AVANT de router', async () => {
  const bot = fakeMapperBot();
  bot.entity.isInWater = true;
  bot.findBlocks = () => [vec3(8, 64, 0)];           // une terre ferme à 8 blocs
  bot.blockAt = (p) => {
    if (p.x === 8 && p.z === 0) {
      if (p.y === 64) return { name: 'grass_block', boundingBox: 'block', biome: { name: 'plains', id: 1 } };
      return { name: 'air', boundingBox: 'empty', biome: { name: 'plains', id: 1 } };
    }
    if (p.y > 63) return { name: 'air', boundingBox: 'empty', biome: { name: 'plains', id: 1 } };
    return { name: 'water', boundingBox: 'empty', biome: { name: 'ocean', id: 0 } };
  };
  bot.pathfinder.goto = async () => { bot.entity.isInWater = false; };  // sortir = atteindre la terre
  const events = [];
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld',
    emit: (e) => { events.push(e); if (events.some((x) => x.type === 'unstuck_done')) token.cancelled = true; },
    goto: async (wp) => { bot.entity.position = vec3(wp.x, 64, wp.z); },
    sleep: async () => {},
  }, token);
  assert.ok(events.some((e) => e.type === 'unstuck' && e.cause === 'water'), 'escapeWater jamais déclenché');
});

test('runMapper #8 : flottant immobile → recoverFloating (relâche tout, retombe)', async () => {
  const bot = fakeMapperBot();
  bot.entity.onGround = false;                        // suspendu en l'air
  let released = 0;
  bot.clearControlStates = () => { released++; bot.entity.onGround = true; }; // retombe dès le release
  let t = 0;
  const events = [];
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld',
    now: () => { t += 1000; return t; },               // chaque échantillon espacé d'1s
    emit: (e) => { events.push(e); if (events.some((x) => x.type === 'unstuck_done' && x.cause === 'floating')) token.cancelled = true; },
    goto: async () => { /* n'avance pas : le bot est coincé */ },
    sleep: async () => {},
  }, token);
  assert.ok(released >= 1, 'clearControlStates jamais appelé');
  assert.ok(events.some((e) => e.type === 'unstuck' && e.cause === 'floating'));
});

test('runMapper : hook onPeriodic appelé tous les periodicEvery arrivées (re-tentative kit)', async () => {
  const bot = fakeMapperBot();
  let periodic = 0;
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld',
    emit: () => {},
    goto: async (wp) => { bot.entity.position = vec3(wp.x, 64, wp.z); },
    onPeriodic: async () => { periodic++; if (periodic >= 2) token.cancelled = true; },
    periodicEvery: 3,
    sleep: async () => {},
  }, token);
  assert.ok(periodic >= 2, `onPeriodic appelé ${periodic} fois (attendu ≥2)`);
});

test('runMapper : résout le nom de biome via bot.registry quand block.biome n\'a qu\'un id (vu live 1.21.4)', async () => {
  const bot = fakeMapperBot();
  bot.registry.biomes = { 28: { name: 'jungle' } };
  bot.blockAt = (p) => (p.y > 63
    ? { name: 'air', boundingBox: 'empty', biome: { id: 28, name: '' } }
    : { name: 'stone', boundingBox: 'block', biome: { id: 28, name: '' } });
  const events = [];
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld',
    emit: (e) => { events.push(e); if (events.filter((x) => x.type === 'biome_seen').length >= 2) token.cancelled = true; },
    goto: async (wp) => { bot.entity.position = vec3(wp.x, 64, wp.z); },
    sleep: async () => {},
  }, token);
  const biomes = events.filter((e) => e.type === 'biome_seen');
  assert.ok(biomes.length >= 1);
  assert.strictEqual(biomes[0].name, 'jungle'); // résolu via registry, pas null
  assert.strictEqual(biomes[0].id, 28);
});

test('runMapper : ENTERRÉ au démarrage (fin de kit au fond du trou) → remonte à la surface AVANT de mapper', async () => {
  const bot = fakeMapperBot();
  bot.entity.position = vec3(0, 40, 0);             // 24 blocs sous la surface (y=63 = stone top)
  const events = [];
  const gotos = [];
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld',
    emit: (e) => { events.push(e); },
    goto: async (wp) => {
      gotos.push(wp);
      bot.entity.position = vec3(wp.x, wp.y != null ? wp.y : 64, wp.z);
      if (gotos.length >= 3) token.cancelled = true;
    },
    sleep: async () => {},
  }, token);
  const surf = events.find((e) => e.type === 'mapper_surface');
  assert.ok(surf, 'mapper_surface jamais émis (le bot tunnellerait sous terre)');
  assert.ok(gotos[0].y > 60, `1er goto vers y=${gotos[0].y} — pas une remontée surface`);
});

test('surfaceYAt : trouve le 1er bloc plein en descendant ; null si non chargé', () => {
  const bot = fakeMapperBot();                       // stone ≤63, air au-dessus
  const { surfaceYAt } = require('./mapper');
  assert.strictEqual(surfaceYAt(bot, 0, 0, 100), 63);
  const unloaded = { blockAt: () => null };
  assert.strictEqual(surfaceYAt(unloaded, 0, 0, 100), null);
});

test('runMapper : 2 jambes ratées d\'affilée → 3e jambe COURTE (8-24 blocs) pour se dégager', async () => {
  const bot = fakeMapperBot();
  const attempts = [];
  let fails = 0;
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld',
    emit: () => {},
    goto: async (wp) => {
      const here = bot.entity.position;
      attempts.push(Math.sqrt((wp.x - here.x) ** 2 + (wp.z - here.z) ** 2));
      if (fails < 2) { fails++; throw new Error('no_path'); }      // 2 échecs
      bot.entity.position = vec3(wp.x, 64, wp.z);                  // puis ça passe
      if (attempts.length >= 3) token.cancelled = true;
    },
    sleep: async () => {},
  }, token);
  assert.ok(attempts.length >= 3);
  assert.ok(attempts[2] <= 24 + 1e-6, `3e jambe ${attempts[2].toFixed(0)} blocs — pas raccourcie`);
});

// ─── ALTITUDE DES JAMBES : un waypoint SANS y = « altitude libre » (terrain vallonné) ───────────
// Mesuré live sur world_ax5 (monde montagneux, spawn vers y=100) : les 2 cartographes restaient
// collés au spawn (< 40 blocs après 15 min) — `mapper_turn unreachable` en rafale (1 000-2 400/h),
// `mapper_relocate trapped`, puis `autonomous_stalled jam_loop`. Cause : chaque jambe visait un
// `GoalNear(x, y COURANT, z, 8)`, c'est-à-dire un but 3D à l'altitude où se tient le bot. Dès que la
// surface à 30-160 blocs est 10-40 blocs plus haut ou plus bas, aucun nœud standable n'entre dans le
// rayon 3D → NoPath INSTANTANÉ (le même bug que la migration de zone, déjà corrigé en `GoalNearXZ`).
// Contrat : waypoint SANS y → altitude libre (but XZ) ; AVEC y → altitude RÉELLE (la remontée en
// surface, dont le y sort de `surfaceYAt`) → but 3D.

test('runMapper : jambe NORMALE → waypoint SANS y (l’altitude courante n’est qu’une supposition)', async () => {
  const bot = fakeMapperBot();
  const gotos = [];
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld',
    emit: () => {},
    goto: async (wp) => {
      gotos.push(wp);
      bot.entity.position = vec3(wp.x, 64, wp.z);
      if (gotos.length >= 5) token.cancelled = true;
    },
    sleep: async () => {},
  }, token);
  assert.ok(gotos.length >= 5, `seulement ${gotos.length} jambes`);
  for (const wp of gotos) {
    assert.ok(Number.isFinite(wp.x) && Number.isFinite(wp.z), 'x/z doivent rester des nombres finis');
    assert.ok(wp.y == null, `jambe avec y=${wp.y} : but 3D inatteignable dès que la surface cible est à +/-10 blocs`);
  }
});

test('runMapper frontier : jambe vers une cellule frontière → waypoint SANS y', async () => {
  const bot = fakeMapperBot();
  const gotos = [];
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld', memory: { worlds: { overworld: { biomes: [] } } }, frontier: true,
    emit: () => {},
    goto: async (wp) => {
      gotos.push(wp);
      bot.entity.position = vec3(wp.x, 64, wp.z);
      if (gotos.length >= 4) token.cancelled = true;
    },
    sleep: async () => {},
  }, token);
  assert.ok(gotos.length >= 4, `seulement ${gotos.length} jambes`);
  // sanity : on est bien dans la branche FRONTIÈRE (la cible est le CENTRE d'une cellule 128 → x,z ≡ 64)
  assert.strictEqual(((gotos[0].x % 128) + 128) % 128, 64, 'la 1re jambe n’est pas une cible frontière');
  for (const wp of gotos) {
    assert.ok(wp.y == null, `jambe frontière avec y=${wp.y}`);
  }
});

test('runMapper : traversée d’ÎLE → jambe longue SANS y (cap vers l’autre rive)', async () => {
  const bot = fakeMapperBot();
  bot.blockAt = (p) => {                       // île : eau partout au-delà de 10 blocs
    if (p.y > 63) return { name: 'air', boundingBox: 'empty', biome: { name: 'plains', id: 1 } };
    const d = Math.sqrt(p.x * p.x + p.z * p.z);
    if (d > 10) return { name: 'water', boundingBox: 'empty', biome: { name: 'ocean', id: 0 } };
    return { name: 'stone', boundingBox: 'block', biome: { name: 'plains', id: 1 } };
  };
  const gotos = [];
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld',
    emit: (e) => { if (e.type === 'mapper_crossing') token.cancelled = true; },
    goto: async (wp) => { gotos.push(wp); },
    sleep: async () => {},
  }, token);
  const cross = gotos[gotos.length - 1];
  assert.ok(cross, 'aucune jambe de traversée');
  assert.ok(Math.hypot(cross.x, cross.z) >= 100 - 1e-6, 'sanity : ce n’est pas la jambe de traversée (≥100)');
  assert.ok(cross.y == null, `traversée avec y=${cross.y}`);
});

test('runMapper : RELOCALISATION (N jambes inatteignables) → jambe longue SANS y', async () => {
  const bot = fakeMapperBot();
  const gotos = [];
  let relocating = false;                      // vrai dès que mapper_relocate a été émis (juste avant la jambe)
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld',
    emit: (e) => { if (e.type === 'mapper_relocate') relocating = true; },
    goto: async (wp) => {
      gotos.push({ wp, relocating });
      if (relocating) token.cancelled = true;
      throw new Error('no path');              // bot muré : toutes les jambes sont rejetées
    },
    sleep: async () => {},
  }, token);
  const reloc = gotos.find((g) => g.relocating);
  assert.ok(reloc, 'jamais de jambe de relocalisation');
  assert.ok(Math.hypot(reloc.wp.x, reloc.wp.z) >= 100 - 1e-6, 'sanity : ce n’est pas la jambe de relocalisation (≥100)');
  assert.ok(gotos.length >= 7, `${gotos.length} jambes seulement : les 6 jambes normales qui précèdent n’ont pas été vues`);
  for (const g of gotos) assert.ok(g.wp.y == null, `jambe (relocating=${g.relocating}) avec y=${g.wp.y}`);
});

test('runMapper : la remontée en SURFACE garde son y RÉEL — seules les jambes devinées perdent le leur', async () => {
  const bot = fakeMapperBot();
  bot.entity.position = vec3(0, 40, 0);        // enterré : le dessus de la pierre est à y=63 → surface visée = 64
  const gotos = [];
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld',
    emit: () => {},
    goto: async (wp) => {
      gotos.push(wp);
      bot.entity.position = vec3(wp.x, wp.y != null ? wp.y : 64, wp.z);
      if (gotos.length >= 3) token.cancelled = true;
    },
    sleep: async () => {},
  }, token);
  assert.ok(gotos.length >= 3);
  assert.strictEqual(gotos[0].y, 64, 'la remontée doit viser top+1 avec son vrai y (but 3D)');
  for (const wp of gotos.slice(1)) assert.ok(wp.y == null, `jambe suivante avec y=${wp.y}`);
});

test('runMapper (goto PAR DÉFAUT) : waypoint sans y → GoalNearXZ (rayon 8), jamais un GoalNear 3D', async () => {
  const { goals } = require('mineflayer-pathfinder');
  const bot = fakeMapperBot();
  const seen = [];
  const token = { cancelled: false };
  bot.pathfinder.goto = async (goal) => {      // stub : capture le BUT réellement construit
    seen.push(goal);
    bot.entity.position = vec3(goal.x, 64, goal.z);
    if (seen.length >= 3) token.cancelled = true;
  };
  await runMapper(bot, { worldKey: 'overworld', emit: () => {}, sleep: async () => {} }, token);
  assert.ok(seen.length >= 3, `seulement ${seen.length} buts`);
  for (const g of seen) {
    assert.ok(g instanceof goals.GoalNearXZ, `but ${g.constructor.name} : une jambe devinée doit viser GoalNearXZ`);
    assert.ok(!(g instanceof goals.GoalNear), 'GoalNear 3D interdit pour une jambe sans y');
    assert.strictEqual(g.rangeSq, 64, 'rayon 8 (rangeSq 64) conservé');
    assert.ok(Number.isFinite(g.x) && Number.isFinite(g.z), 'x/z du but doivent être finis (pas NaN)');
    assert.strictEqual(g.y, undefined, 'un but XZ ne porte aucun y');
  }
});

test('runMapper (goto PAR DÉFAUT) : la remontée en surface (y réel) reste un GoalNear 3D, les jambes suivantes passent en XZ', async () => {
  const { goals } = require('mineflayer-pathfinder');
  const bot = fakeMapperBot();
  bot.entity.position = vec3(0, 40, 0);        // enterré → 1re jambe = remontée
  const seen = [];
  const token = { cancelled: false };
  bot.pathfinder.goto = async (goal) => {
    seen.push(goal);
    bot.entity.position = vec3(goal.x, goal.y != null ? goal.y : 64, goal.z);
    if (seen.length >= 3) token.cancelled = true;
  };
  await runMapper(bot, { worldKey: 'overworld', emit: () => {}, sleep: async () => {} }, token);
  assert.ok(seen.length >= 3);
  assert.ok(seen[0] instanceof goals.GoalNear, `remontée : ${seen[0].constructor.name} au lieu de GoalNear 3D`);
  assert.strictEqual(seen[0].y, 64, 'la remontée garde son y réel (top+1)');
  assert.strictEqual(seen[0].rangeSq, 64);
  for (const g of seen.slice(1)) {
    assert.ok(g instanceof goals.GoalNearXZ, `jambe suivante : ${g.constructor.name}`);
  }
});

test('runMapper (goto PAR DÉFAUT) : terrain VALLONNÉ → le mapper PROGRESSE au lieu de s’enliser en `unreachable`', async () => {
  // MODÈLE MINIMAL du pathfinder (ce n'est PAS le vrai) : un but est atteignable ssi une case de
  // SURFACE — le seul endroit où l'on se tient — satisfait `goal.isEnd`. Les vraies classes de buts
  // servent telles quelles : 3D contre XZ se joue donc exactement comme dans mineflayer-pathfinder
  // (cf. le diagnostic de `migrationLegTo` : « aucun nœud standable n'entre dans le rayon 3D »).
  // Relief : bandes de 32 blocs alternant plaine (surface y=64) et plateau (y=94, +30).
  const surfaceAt = (x) => 64 + (((Math.floor(x / 32) % 2) + 2) % 2) * 30;
  const mulberry32 = (a) => () => {            // rng déterministe : le test ne dépend pas du hasard
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const bot = fakeMapperBot();
  bot.entity.position = vec3(0.5, surfaceAt(0) + 1, 0.5);
  bot.blockAt = (p) => (p.y > surfaceAt(p.x)
    ? { name: 'air', boundingBox: 'empty', biome: { name: 'plains', id: 1 } }
    : { name: 'stone', boundingBox: 'block', biome: { name: 'plains', id: 1 } });
  bot.pathfinder.goto = async (goal) => {
    let best = null;
    for (let dx = -8; dx <= 8; dx++) {
      for (let dz = -8; dz <= 8; dz++) {
        const node = { x: goal.x + dx, y: surfaceAt(goal.x + dx) + 1, z: goal.z + dz };
        const d = dx * dx + dz * dz;
        if (goal.isEnd(node) && (!best || d < best.d)) best = { node, d };
      }
    }
    if (!best) throw new Error('NoPath');
    bot.entity.position = vec3(best.node.x + 0.5, best.node.y, best.node.z + 0.5);
  };
  const events = [];
  let arrivals = 0;
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld',
    rng: mulberry32(7),
    emit: (e) => { events.push(e); if (events.length > 600) token.cancelled = true; },
    onArrive: async () => { if (++arrivals >= 12) token.cancelled = true; },
    sleep: async () => {},
  }, token);
  const unreachable = events.filter((e) => e.type === 'mapper_turn' && e.reason === 'unreachable').length;
  assert.strictEqual(unreachable, 0, `${unreachable} jambes « unreachable » : le but dépend encore de l’altitude courante`);
  assert.ok(arrivals >= 12, `seulement ${arrivals} arrivées sur terrain vallonné`);
  const p = bot.entity.position;
  assert.ok(Math.hypot(p.x, p.z) > 100, `le mapper n’a progressé que de ${Math.hypot(p.x, p.z).toFixed(0)} blocs`);
});

test('index.js : le goto branché sur runMapper applique la MÊME règle (y absent → GoalNearXZ)', () => {
  // Garde-fou de CÂBLAGE (classe #61/#64). index.js est trop gros pour être exécuté ici, et un `goto`
  // qui construirait encore `GoalNear(wp.x, wp.y, …)` avec un y absent ferait `Math.floor(undefined)` =
  // NaN : la correction de mapper.js serait MORTE en prod (ou pire, régressive) sans qu'aucun autre
  // test ne rougisse. On relit donc le source du lambda passé à `runMapper` dans startMapper.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const call = src.indexOf('await runMapper(bot, {');
  assert.ok(call > 0, 'appel `await runMapper(bot, {` introuvable dans index.js');
  const from = src.indexOf('goto: async (wp) =>', call);
  assert.ok(from > call, 'lambda `goto: async (wp) =>` introuvable dans l’appel runMapper');
  const end = src.indexOf('}, mapperToken);', from);
  assert.ok(end > from, 'fin de l’appel runMapper introuvable');
  const lambda = src.slice(from, end);
  // UNE seule expression (et pas trois `match` indépendants) : elle fige aussi l'ORDRE des branches,
  // donc une inversion du ternaire — qui garderait chaque morceau présent — fait rougir le test.
  assert.match(lambda,
    /wp\.y == null\s*\?\s*new pfGoals\.GoalNearXZ\(\s*wp\.x,\s*wp\.z,\s*8\s*\)\s*:\s*new pfGoals\.GoalNear\(\s*wp\.x,\s*wp\.y,\s*wp\.z,\s*8\s*\)/,
    'le goto d’index.js doit valoir `wp.y == null ? new pfGoals.GoalNearXZ(wp.x, wp.z, 8) : new pfGoals.GoalNear(wp.x, wp.y, wp.z, 8)` '
    + '(même règle que le goto par défaut de mapper.js) — si tu l’as reformulé, adapte ce garde-fou, ne le supprime pas');
});

test('runMapper : hook onArrive appelé à CHAQUE arrivée (chasse opportuniste du kit)', async () => {
  const bot = fakeMapperBot();
  let arrivals = 0;
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld',
    emit: () => {},
    goto: async (wp) => { bot.entity.position = vec3(wp.x, 64, wp.z); },
    onArrive: async () => { arrivals++; if (arrivals >= 4) token.cancelled = true; },
    sleep: async () => {},
  }, token);
  assert.ok(arrivals >= 4, `onArrive appelé ${arrivals} fois`);
});

test('runMapper : ÎLE (3 cycles bloqués) → TRAVERSÉE à la nage (mapper_crossing, jambe sans veto eau)', async () => {
  const bot = fakeMapperBot();
  // île : eau partout au-delà de 10 blocs
  bot.blockAt = (p) => {
    if (p.y > 63) return { name: 'air', boundingBox: 'empty', biome: { name: 'plains', id: 1 } };
    const d = Math.sqrt(p.x * p.x + p.z * p.z);
    if (d > 10) return { name: 'water', boundingBox: 'empty', biome: { name: 'ocean', id: 0 } };
    return { name: 'stone', boundingBox: 'block', biome: { name: 'plains', id: 1 } };
  };
  const events = [];
  const gotos = [];
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld',
    emit: (e) => { events.push(e); if (e.type === 'mapper_crossing') token.cancelled = true; },
    goto: async (wp) => { gotos.push(wp); },
    sleep: async () => {},
  }, token);
  assert.ok(events.some((e) => e.type === 'mapper_crossing'), 'jamais de traversée malgré le blocage');
  // la jambe de traversée est LONGUE (≥100) — c'est un cap assumé vers l'autre rive
  const cross = gotos[gotos.length - 1];
  const d = Math.sqrt(cross.x * cross.x + cross.z * cross.z);
  assert.ok(d >= 100 - 1e-6, `traversée trop courte (${d.toFixed(0)})`);
});

test('runMapper : scan COMPLET des minerais en route → ores_found batché (exposed flag, dédup par bloc)', async () => {
  const bot = fakeMapperBot();
  bot.registry.blocksByName = { iron_ore: { id: 10 } };
  // findBlocks voit 2 iron_ore : (12,60,-7) EXPOSÉ (voisin air au-dessus), (13,60,-7) ENTERRÉ.
  bot.findBlocks = () => [vec3(12, 60, -7), vec3(13, 60, -7)];
  const base = bot.blockAt.bind(bot);
  bot.blockAt = (p) => {
    if (p.y === 60 && p.z === -7 && (p.x === 12 || p.x === 13)) {
      return { name: 'iron_ore', boundingBox: 'block', biome: { name: 'plains', id: 1 } };
    }
    if (p.x === 12 && p.y === 61 && p.z === -7) {
      return { name: 'air', boundingBox: 'empty', biome: { name: 'plains', id: 1 } }; // la face exposée
    }
    return base(p);
  };
  const events = [];
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld',
    emit: (e) => {
      events.push(e);
      // plusieurs arrivées (≥3 biomes) pour PROUVER la dédup : le même ore re-scanné n'est émis qu'1×
      if (events.filter((x) => x.type === 'biome_seen').length >= 3 || events.length > 800) token.cancelled = true;
    },
    goto: async (wp) => { bot.entity.position = vec3(wp.x, 64, wp.z); },
    sleep: async () => {},
  }, token);
  const batches = events.filter((e) => e.type === 'ores_found');
  assert.strictEqual(batches.length, 1, `attendu 1 batch ores_found (dédup), reçu ${batches.length}`);
  const ores = batches[0].ores;
  assert.strictEqual(batches[0].world, 'overworld');
  assert.strictEqual(ores.length, 2);
  assert.deepStrictEqual(ores.find((o) => o.x === 12), { material: 'iron_ore', x: 12, y: 60, z: -7, exposed: true, wet: false });
  assert.deepStrictEqual(ores.find((o) => o.x === 13), { material: 'iron_ore', x: 13, y: 60, z: -7, exposed: false, wet: false });
  // rien d'autre ne change : les biomes continuent d'être émis normalement
  assert.ok(events.filter((e) => e.type === 'biome_seen').length >= 3);
});

test('runMapper : émet structure_found (bell→village) avec dédup type+cellule', async () => {
  const bot = fakeMapperBot();
  bot.registry.blocksByName = { ...bot.registry.blocksByName, bell: { id: 50 } };
  bot.findBlock = ({ matching }) => matching.includes(50)
    ? { name: 'bell', position: vec3(40, 70, 12) } : null;
  const events = [];
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld',
    emit: (e) => {
      events.push(e);
      if (events.filter((x) => x.type === 'biome_seen').length >= 3 || events.length > 800) token.cancelled = true;
    },
    goto: async (wp) => { bot.entity.position = vec3(wp.x, 64, wp.z); },
    sleep: async () => {},
  }, token);
  const st = events.filter((e) => e.type === 'structure_found');
  assert.strictEqual(st.length, 1, `dédup : 1 seul structure_found attendu (${st.length})`);
  assert.deepStrictEqual(st[0], { type: 'structure_found', world: 'overworld', kind: 'village', x: 40, y: 70, z: 12 });
});

test('runMapper frontier terre-only : frontière terre épuisée → traversée bateau (hook), débarque et mappe', async () => {
  const bot = fakeMapperBot();
  const events = [];
  const token = { cancelled: false };
  // tout couvert autour du spawn → nextLandLeg renvoie null → boat cross
  const biomes = [];
  for (let x = -512; x <= 512; x += 128) for (let z = -512; z <= 512; z += 128) biomes.push({ name: 'plains', x, z });
  let crossed = 0;
  await runMapper(bot, {
    worldKey: 'overworld',
    memory: { worlds: { overworld: { biomes } } },
    frontier: true,
    boat: {
      cross: async () => { crossed++; bot.entity.position = vec3(900, 64, 0); return { ok: true, landed: true }; },
    },
    emit: (e) => { events.push(e); if (crossed >= 1 || events.length > 400) token.cancelled = true; },
    goto: async (wp) => { bot.entity.position = vec3(wp.x, 64, wp.z); },
    sleep: async () => {},
  }, token);
  assert.ok(crossed >= 1, 'doit lancer une traversée bateau quand la terre locale est épuisée');
  assert.ok(events.some((e) => e.type === 'mapper_boat_cross'));
});

test('runMapper : l’EAU est CARTOGRAPHIÉE (biome_seen océan) — « terre-only » borne le déplacement, pas la carte', async () => {
  // 25/07/2026 : le filtre /ocean|river|water/ laissait un TROU permanent sur la carte à chaque
  // rivière/lac traversé, ET n'était jamais persisté → au respawn le mapper re-ciblait ces cases.
  const bot = fakeMapperBot();
  bot.blockAt = (p) => (p.y > 63
    ? { name: 'air', boundingBox: 'empty', biome: { name: 'ocean', id: 0 } }
    : { name: 'water', boundingBox: 'empty', biome: { name: 'ocean', id: 0 } });
  const events = [];
  const token = { cancelled: false };
  let n = 0;
  await runMapper(bot, {
    worldKey: 'overworld', memory: { worlds: { overworld: { biomes: [] } } }, frontier: true,
    boat: { cross: async () => { token.cancelled = true; return { ok: false }; } },
    emit: (e) => { events.push(e); if (++n > 60) token.cancelled = true; },
    goto: async (wp) => { bot.entity.position = vec3(wp.x, 64, wp.z); }, sleep: async () => {},
  }, token);
  const water = events.filter((e) => e.type === 'biome_seen' && e.name === 'ocean');
  assert.ok(water.length > 0, 'l’eau doit être peinte sur la carte (sinon : trou permanent)');
});

// ─── Couverture par échantillonnage (25/07/2026) ─────────────────────────────────────────────
// Constat live world_ax4 : 68 cellules peintes pour une emprise de 378 (18 %). 73-78 % des
// cellules émises venaient déjà de l'échantillonnage des VOISINS (le cache client mineflayer
// retient bien au-delà de la view-distance) → on élargit l'anneau au lieu d'attendre la marche.

test('record : échantillonne PLUSIEURS anneaux autour du bot (pas seulement les 8 voisins)', async () => {
  const bot = fakeMapperBot();
  const events = [];
  // token déjà annulé → runMapper fait exactement UN record() puis sort (record est avant la boucle)
  await runMapper(bot, { worldKey: 'overworld', emit: (e) => events.push(e), sleep: async () => {} },
    { cancelled: true });
  const cells = new Set(events.filter((e) => e.type === 'biome_seen').map((e) => cellKey(e.x, e.z)));
  assert.ok(cells.has('384,0'), 'anneau 3 non échantillonné (cellule 384,0 absente)');
  assert.strictEqual(cells.size, 49, `attendu 7×7 cellules (anneaux 1-3 + la sienne), reçu ${cells.size}`);
});

test('record : vise le POINT LE PLUS PROCHE de la cellule voisine, pas son centre', async () => {
  // Mesuré live 25/07 (bot sonde sur world_ax4) : le cache client s'arrête NET à 96 blocs
  // (6/6 lisible à 96 b, 0/6 à 128 b) — donc viser le CENTRE d'une cellule voisine (jusqu'à 192 b)
  // échoue presque toujours. Une cellule ne porte qu'UN biome quantifié : n'importe quel point
  // dedans fait l'affaire → on lit le bord le plus proche.
  const bot = fakeMapperBot();
  bot.entity.position = vec3(40, 64, 40);                            // cellule 0,0, loin des bords
  bot.blockAt = (p) => {
    const d = Math.sqrt((p.x - 40) ** 2 + (p.z - 40) ** 2);
    if (d > 96) return null;                                         // portée réelle du cache client
    return { name: 'stone', boundingBox: 'block', biome: { name: 'plains', id: 1 } };
  };
  const events = [];
  await runMapper(bot, { worldKey: 'overworld', emit: (e) => events.push(e), sleep: async () => {} },
    { cancelled: true });
  const cells = new Set(events.filter((e) => e.type === 'biome_seen').map((e) => cellKey(e.x, e.z)));
  assert.ok(cells.has('128,0'), 'voisine +x non peinte (bord à 88 b, lisible) — on visait le centre');
  assert.ok(cells.has('0,128'), 'voisine +z non peinte');
});

test('record : arrête d’élargir dès qu’un anneau entier est hors des chunks chargés', async () => {
  const bot = fakeMapperBot();
  const probes = [];
  bot.blockAt = (p) => {
    probes.push({ x: p.x, z: p.z });
    // portée réelle mesurée sur le serveur (view-distance 6) : 96 blocs, puis plus rien
    if (Math.sqrt(p.x * p.x + p.z * p.z) > 96) return null;
    return { name: 'stone', boundingBox: 'block', biome: { name: 'plains', id: 1 } };
  };
  await runMapper(bot, { worldKey: 'overworld', emit: () => {}, sleep: async () => {} }, { cancelled: true });
  const ring = (p) => Math.max(Math.abs(Math.floor(p.x / 128)), Math.abs(Math.floor(p.z / 128)));
  assert.ok(probes.some((p) => ring(p) === 2), 'l’anneau 2 n’a même pas été sondé');
  // anneau 2 = 100 % null → on s'arrête là : aucune sonde sur l'anneau 3
  const far = probes.filter((p) => ring(p) >= 3);
  assert.strictEqual(far.length, 0, `${far.length} sondes inutiles au-delà de l’anneau 2`);
});

test('record : cellule non lue (chunk absent) → RETENTÉE plus tard, pas blackboulée à vie', async () => {
  // bug : biomeCells.add(ck) AVANT la lecture → un blockAt null (spawn/TP/reconnexion) condamnait
  // la cellule pour toute la vie du process.
  const bot = fakeMapperBot();
  let calls = 0;
  bot.blockAt = (p) => {
    calls++;
    if (calls <= 60) return null;                                    // 1er record() : rien de chargé
    return { name: 'stone', boundingBox: 'block', biome: { name: 'plains', id: 1 } };
  };
  const events = [];
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld',
    emit: (e) => { events.push(e); if (e.type === 'biome_seen') token.cancelled = true; },
    goto: async () => { bot.entity.position = vec3(10, 64, 10); },   // reste dans la cellule 0,0
    sleep: async () => {},
  }, token);
  const own = events.filter((e) => e.type === 'biome_seen' && cellKey(e.x, e.z) === '0,0');
  assert.ok(own.length > 0, 'la cellule du bot n’a jamais été re-lue après l’échec initial');
});

// ─── frontierSkip : oubli après TTL (une cellule ratée n'est plus perdue pour la session) ─────

test('createExpiringSet : oublie une clé après le TTL', () => {
  let t = 1000;
  const s = createExpiringSet({ now: () => t, ttlMs: 5000 });
  s.add('a');
  assert.ok(s.has('a'));
  t += 4999;
  assert.ok(s.has('a'), 'ne doit pas expirer avant le TTL');
  t += 2;
  assert.ok(!s.has('a'), 'doit expirer après le TTL');
});

test('runMapper frontier : une cellule skippée redevient ciblable après le TTL', async () => {
  const bot = fakeMapperBot();
  const events = [];
  const token = { cancelled: false };
  let t = 0;
  await runMapper(bot, {
    worldKey: 'overworld', memory: { worlds: { overworld: { biomes: [] } } }, frontier: true,
    skipTtlMs: 1000,
    now: () => (t += 5000),                                          // chaque tick dépasse le TTL
    goto: async () => { throw new Error('unreachable'); },           // toute cible échoue → skip
    emit: (e) => {
      events.push(e);
      if (events.filter((x) => x.type === 'mapper_frontier_skip').length >= 6 || events.length > 300) {
        token.cancelled = true;
      }
    },
    sleep: async () => {},
  }, token);
  const skipped = events.filter((e) => e.type === 'mapper_frontier_skip').map((e) => e.cell);
  assert.ok(skipped.length >= 2, 'pas assez de skips pour conclure');
  assert.ok(skipped.length > new Set(skipped).size,
    'aucune cellule re-tentée : le skip est encore définitif');
});

test('runMapper frontier : boat cross SANS progrès (bot ne bouge pas) → ne reboucle pas sur le bateau, marche aléatoire', async () => {
  const bot = fakeMapperBot();
  const events = [];
  const gotos = [];
  const token = { cancelled: false };
  // tout couvert autour du spawn → nextLandLeg renvoie null → boat ; mais le boat NE BOUGE PAS le bot
  const biomes = [];
  for (let x = -512; x <= 512; x += 128) for (let z = -512; z <= 512; z += 128) biomes.push({ name: 'plains', x, z });
  let crosses = 0;
  await runMapper(bot, {
    worldKey: 'overworld', memory: { worlds: { overworld: { biomes } } }, frontier: true,
    boat: { cross: async () => { crosses++; return { ok: true, landed: true }; } }, // ne déplace pas le bot
    emit: (e) => { events.push(e); if (gotos.length >= 2 || crosses >= 8 || events.length > 500) token.cancelled = true; },
    goto: async (wp) => { gotos.push(wp); bot.entity.position = vec3(wp.x, 64, wp.z); },
    sleep: async () => {},
  }, token);
  assert.ok(gotos.length >= 1, 'après un boat cross sans progrès, le bot doit MARCHER (random walk), pas reboucler sur le bateau');
});

test('runMapper frontier : la mémoire RE-LUE (--wm-live) est PRISE EN COMPTE — une cellule couverte entre-temps n\'est plus ciblée', async () => {
  // Bug vécu : `memory` était déclarée `const` → l'assignation de reloadMemory() levait TypeError,
  // avalée par le catch best-effort → chaque mappeur restait sur le snapshot du boot (classe #61 :
  // rien ne plante, la fonctionnalité est juste morte). Ici : le bot est ÉPINGLÉ sur place (goto
  // ne le déplace pas) → il re-cible la même cellule frontière à chaque jambe ; à la jambe 3, la
  // mémoire rechargée couvre cette cellule → nextLandLeg DOIT basculer sur une autre cible.
  const bot = fakeMapperBot();
  const gotos = [];
  const token = { cancelled: false };
  // la mémoire « fraîche » : couvre la cellule du 1er goto (comme si un coéquipier / la persistance
  // l'avait peinte pendant la marche)
  const reloaded = { worlds: { overworld: { biomes: [] } } };
  await runMapper(bot, {
    worldKey: 'overworld',
    memory: { worlds: { overworld: { biomes: [] } } },   // bootstrap : rien de couvert
    frontier: true,
    reloadMemory: () => reloaded,
    emit: () => {},
    goto: async (wp) => {
      if (gotos.length === 0) {
        // 1re cible observée → la mémoire fraîche la marque couverte (quantifiée grille 128)
        reloaded.worlds.overworld.biomes.push({ name: 'plains', x: Math.floor(wp.x / 128) * 128, z: Math.floor(wp.z / 128) * 128 });
      }
      gotos.push({ x: wp.x, z: wp.z });
      if (gotos.length >= 6) token.cancelled = true;
      // NE PAS déplacer le bot : sans reload effectif, la cible resterait identique à chaque jambe
    },
    sleep: async () => {},
  }, token);
  assert.ok(gotos.length >= 5, `pas assez de jambes pour conclure (${gotos.length})`);
  const t1 = cellKey(gotos[0].x, gotos[0].z);
  assert.strictEqual(cellKey(gotos[1].x, gotos[1].z), t1, 'sanity : avant le reload (jambe 2), la cible doit être identique');
  // dès la jambe 3 (legs % 3 === 0 → reload AVANT nextLandLeg), la cellule couverte ne doit PLUS être ciblée
  for (let i = 2; i < gotos.length; i++) {
    assert.notStrictEqual(cellKey(gotos[i].x, gotos[i].z), t1,
      `jambe ${i + 1} re-cible la cellule pourtant couverte par la mémoire re-lue (reload muet)`);
  }
});

// ─── EMBALLEMENT « BATEAU » : le gate doit vivre sur le BOT, pas dans la boucle (run 17/08) ─────
// Mesuré dans les session-*.jsonl : `mapper_boat_cross` par dizaines de milliers, ~100 % en échec
// `no_crossable_water`. Le garde-fou `shouldRetryBoat` (26/07) EXISTAIT et ne mordait pas, pour
// deux raisons cumulées :
//  (a) son état (`let lastBoatFail`) vivait dans la CLOSURE de `runMapper` — or un même process
//      ouvre jusqu'à 23 boucles `runMapper` (`mapper_started` = 23/15/9 sur les 3 mappeurs du run :
//      une par respawn, onSpawn → startAutonomous → startMapper) et chaque instance NEUVE repart
//      avec le gate grand ouvert ;
//  (b) sa condition « bougé ≥ 32 b » est offerte par les ÉCHAPPEMENTS DU MAPPEUR LUI-MÊME
//      (`mapper_crossing` / `mapper_relocate` = bonds de 100-160 b) → échec, bond, « j'ai bougé »,
//      re-tentative… en boucle sur la même côte, sans jamais conclure que ce secteur est mort.
function coveredBiomes(span = 1024) {
  const biomes = [];
  for (let x = -span; x <= span; x += 128) for (let z = -span; z <= span; z += 128) biomes.push({ name: 'plains', x, z });
  return biomes;
}

test('runMapper : gate de traversée PARTAGÉ par bot — une 2e boucle (respawn) n’hérite pas d’un gate neuf', async () => {
  const bot = fakeMapperBot();
  const biomes = coveredBiomes();          // rien à cartographier à pied → branche bateau
  const runOnce = async () => {
    const token = { cancelled: false };
    let crosses = 0, turns = 0;
    await runMapper(bot, {
      worldKey: 'overworld', memory: { worlds: { overworld: { biomes } } }, frontier: true,
      boat: { cross: async () => { crosses++; return { ok: false, reason: 'no_crossable_water' }; } },
      emit: (e) => { if (e.type === 'mapper_turn') turns++; if (turns >= 8) token.cancelled = true; },
      goto: async () => { throw new Error('unreachable'); },   // le bot ne bouge JAMAIS
      sleep: async () => {},
    }, token);
    return crosses;
  };
  const first = await runOnce();
  const second = await runOnce();
  assert.strictEqual(first, 1, `la 1re boucle tente UNE fois puis se throttle (reçu ${first})`);
  assert.strictEqual(second, 0,
    'la 2e boucle (instance neuve sur le MÊME bot) doit hériter du throttle, pas repartir gate ouvert');
});

test('runMapper : le throttle n’émet qu’UN event par épisode (pas de boucle chaude déguisée)', async () => {
  const bot = fakeMapperBot();
  const biomes = coveredBiomes();
  const events = [];
  const token = { cancelled: false };
  let turns = 0;
  await runMapper(bot, {
    worldKey: 'overworld', memory: { worlds: { overworld: { biomes } } }, frontier: true,
    boat: { cross: async () => ({ ok: false, reason: 'no_crossable_water' }) },
    emit: (e) => { events.push(e); if (e.type === 'mapper_turn') turns++; if (turns >= 10) token.cancelled = true; },
    goto: async () => { throw new Error('unreachable'); },
    sleep: async () => {},
  }, token);
  assert.ok(turns >= 8, 'pas assez d’itérations pour conclure');
  assert.strictEqual(events.filter((e) => e.type === 'mapper_boat_throttled').length, 1,
    'un event par épisode de throttle, pas un par itération');
  assert.strictEqual(events.filter((e) => e.type === 'mapper_boat_cross').length, 1);
});

test('runMapper : N échecs no_crossable_water → zone BANNIE, même quand le bot bouge entre deux essais', async () => {
  const bot = fakeMapperBot();
  const biomes = coveredBiomes(2048);
  const events = [];
  const token = { cancelled: false };
  let crosses = 0;
  await runMapper(bot, {
    worldKey: 'overworld', memory: { worlds: { overworld: { biomes } } }, frontier: true,
    boat: { cross: async () => { crosses++; return { ok: false, reason: 'no_crossable_water' }; } },
    // chaque jambe DÉPLACE le bot de 40 b (> minMove) : le seuil de re-tentative est satisfait à
    // chaque tour — exactement la situation live où le garde-fou ne mordait pas.
    goto: async () => { bot.entity.position = vec3(bot.entity.position.x + 40, 64, bot.entity.position.z); },
    emit: (e) => {
      events.push(e);
      if (e.type === 'mapper_boat_zone_banned' || events.length > 4000) token.cancelled = true;
    },
    sleep: async () => {},
  }, token);
  const banned = events.filter((e) => e.type === 'mapper_boat_zone_banned');
  assert.strictEqual(banned.length, 1, 'la zone doit finir bannie (sinon : tentatives à l’infini)');
  assert.strictEqual(crosses, 5, `escalade attendue à la 5e tentative (reçu ${crosses})`);
  assert.ok(banned[0].streak === 5 && Number.isFinite(banned[0].x) && Number.isFinite(banned[0].z));
});

// ─── Jeton de GÉNÉRATION : une seule boucle vivante par bot (fix `startMapper`, index.js) ───────
// Mesuré le 17/08 : `mapper_started` = 23 / 15 / 9 dans UN SEUL process (une entrée par respawn).
// `startMapper` passe désormais un token dont `cancelled` est un GETTER
// (`bot._mapperGen !== gen`) : la génération suivante périme instantanément toutes les
// précédentes. Ce contrat ne tient QUE si `runMapper` RELIT la propriété à chaque tour — s'il en
// capturait la valeur une fois (`const cancelled = token.cancelled`), le fix serait muet.
test('runMapper : `token.cancelled` est RELU à chaque tour (contrat du jeton de génération)', async () => {
  const bot = fakeMapperBot();
  let liveGen = 1;
  const myGen = 1;
  const token = { get cancelled() { return liveGen !== myGen; } };   // exactement la forme d'index.js
  let legs = 0;
  await runMapper(bot, {
    worldKey: 'overworld',
    emit: () => {},
    goto: async (wp) => {
      bot.entity.position = vec3(wp.x, 64, wp.z);
      if (++legs >= 3) liveGen = 2;        // « une nouvelle boucle démarre » → l'ancienne doit sortir
      if (legs > 50) liveGen = 2;          // filet : échoue proprement au lieu de boucler à l'infini
    },
    sleep: async () => {},
  }, token);
  assert.strictEqual(legs, 3, `la boucle doit sortir dès le changement de génération (reçu ${legs})`);
});

test('runMapper : throttlé DANS L’EAU → le bot regagne la berge (il n’attend pas en barbotant)', async () => {
  const bot = fakeMapperBot();
  bot.entity.isInWater = true;                       // le mappeur patiente… dans l'eau (7-8 noyades)
  const biomes = coveredBiomes();
  const events = [];
  const token = { cancelled: false };
  let escapes = 0, turns = 0;
  await runMapper(bot, {
    worldKey: 'overworld', memory: { worlds: { overworld: { biomes } } }, frontier: true,
    boat: { cross: async () => ({ ok: false, reason: 'no_crossable_water' }) },
    escapeWater: async () => { escapes++; return { ok: true }; },   // injecté : pas de vraie nage en test
    emit: (e) => { events.push(e); if (e.type === 'mapper_turn') turns++; if (turns >= 6) token.cancelled = true; },
    goto: async () => { throw new Error('unreachable'); },
    sleep: async () => {},
  }, token);
  const th = events.filter((e) => e.type === 'mapper_boat_throttled');
  assert.strictEqual(th.length, 1);
  assert.strictEqual(th[0].water, true, 'le throttle doit signaler qu’il a fallu sortir de l’eau');
  assert.ok(escapes >= 1, 'escapeWater doit être déclenché pendant l’attente');
});
