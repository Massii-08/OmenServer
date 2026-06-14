'use strict';
// Boucle de cartographie (1b) : MARCHE ALÉATOIRE PERSISTANTE (#4 final — ni cercles, ni ligne
// parfaite, ni allées-retours), anti-océan (#5), cluster anti-stuck (#1/#8/#9), secteurs,
// biome_seen / cave_found.
const { test } = require('node:test');
const assert = require('node:assert');
const vec3 = require('vec3');
const { drawHeading, driftHeading, legTarget, isOceanCell, waterAhead, cellKey, runMapper } = require('./mapper');
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

test('runMapper frontier : vise la cellule non couverte la plus proche, warp si lointaine', async () => {
  const bot = fakeMapperBot();
  const gotos = [];
  const warps = [];
  const events = [];
  const token = { cancelled: false };
  // mémoire : tout couvert autour du spawn SAUF une cellule adjacente — puis tout couvert → warp
  const biomes = [];
  for (let x = -512; x <= 512; x += 128) for (let z = -512; z <= 512; z += 128) {
    if (!(x === 128 && z === 0)) biomes.push({ name: 'plains', x, z });
  }
  await runMapper(bot, {
    worldKey: 'overworld',
    memory: { worlds: { overworld: { biomes } } },
    frontier: true,
    warp: async (x, z) => { warps.push({ x, z }); bot.entity.position = vec3(x, 64, z); },
    warpDist: 220,
    warpSettleMs: 0,
    emit: (e) => { events.push(e); if (warps.length >= 1 || events.length > 600) token.cancelled = true; },
    goto: async (wp) => { gotos.push({ x: wp.x, z: wp.z }); bot.entity.position = vec3(wp.x, 64, wp.z); },
    sleep: async () => {},
  }, token);
  // 1re cible frontière = centre de la cellule (128,0) → (192, 64)
  assert.ok(gotos.length >= 1);
  assert.strictEqual(Math.round(gotos[0].x), 192);
  assert.strictEqual(Math.round(gotos[0].z), 64);
  // ensuite tout est couvert près du bot → warp vers une cellule lointaine
  assert.ok(warps.length >= 1, 'warp attendu quand la frontière est lointaine');
  assert.ok(events.some((e) => e.type === 'mapper_warp'));
});
