'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { rodPlan, pickFishingSpot, fishCatch, ROD_STICKS, ROD_STRING } = require('./fish');

// ─── rodPlan : de quoi ai-je besoin pour tenir une canne ? (PUR) ─────────────────────────────────

test('rodPlan : canne en poche → rien à faire', () => {
  assert.deepStrictEqual(rodPlan([{ name: 'fishing_rod', count: 1 }]), { have: true });
});

test('rodPlan : pile de cannes → have (une seule suffit)', () => {
  assert.deepStrictEqual(rodPlan([{ name: 'fishing_rod', count: 3 }, { name: 'dirt', count: 9 }]), { have: true });
});

test('rodPlan : 3 bâtons + 2 ficelles → on peut la fabriquer', () => {
  const inv = [{ name: 'stick', count: 3 }, { name: 'string', count: 2 }];
  assert.deepStrictEqual(rodPlan(inv), { craft: true });
});

test('rodPlan : du rab de matériaux → toujours craft', () => {
  const inv = [{ name: 'stick', count: 64 }, { name: 'string', count: 12 }, { name: 'cobblestone', count: 30 }];
  assert.deepStrictEqual(rodPlan(inv), { craft: true });
});

test('rodPlan : piles séparées de bâtons additionnées (l\'inventaire fragmente)', () => {
  const inv = [{ name: 'stick', count: 2 }, { name: 'stick', count: 1 }, { name: 'string', count: 2 }];
  assert.deepStrictEqual(rodPlan(inv), { craft: true });
});

test('rodPlan : il manque de la ficelle → le DÉFICIT exact (pas le total requis)', () => {
  const inv = [{ name: 'stick', count: 3 }, { name: 'string', count: 1 }];
  assert.deepStrictEqual(rodPlan(inv), { missing: { sticks: 0, string: 1 } });
});

test('rodPlan : il manque des bâtons → déficit exact', () => {
  const inv = [{ name: 'stick', count: 1 }, { name: 'string', count: 5 }];
  assert.deepStrictEqual(rodPlan(inv), { missing: { sticks: 2, string: 0 } });
});

test('rodPlan : inventaire vide / absent → il manque tout', () => {
  const all = { missing: { sticks: ROD_STICKS, string: ROD_STRING } };
  assert.deepStrictEqual(rodPlan([]), all);
  assert.deepStrictEqual(rodPlan(null), all);
  assert.deepStrictEqual(rodPlan(undefined), all);
});

test('rodPlan : une canne à count 0 ne compte pas (entrée fantôme)', () => {
  assert.deepStrictEqual(rodPlan([{ name: 'fishing_rod', count: 0 }]),
    { missing: { sticks: ROD_STICKS, string: ROD_STRING } });
});

// ─── pickFishingSpot : on pêche depuis la BERGE, jamais depuis l'eau (PUR) ───────────────────────

const ALL_OK = { isStandable: () => true };

test('pickFishingSpot : aucune eau candidate → null', () => {
  assert.strictEqual(pickFishingSpot([], { x: 0, y: 64, z: 0 }, ALL_OK), null);
  assert.strictEqual(pickFishingSpot(null, { x: 0, y: 64, z: 0 }, ALL_OK), null);
});

test('pickFishingSpot : position du bot inconnue → null (pas de choix au hasard)', () => {
  assert.strictEqual(pickFishingSpot([{ x: 5, y: 62, z: 0 }], null, ALL_OK), null);
});

test('pickFishingSpot : eau isolée → une berge ADJACENTE, jamais la case d\'eau', () => {
  const water = { x: 5, y: 62, z: 0 };
  const spot = pickFishingSpot([water], { x: 0, y: 63, z: 0 }, ALL_OK);
  assert.ok(spot, 'une berge doit être trouvée');
  const d = Math.abs(spot.x - water.x) + Math.abs(spot.z - water.z);
  assert.strictEqual(d, 1, 'la berge touche l\'eau');
  assert.ok(!(spot.x === water.x && spot.y === water.y && spot.z === water.z), 'jamais dans l\'eau');
  assert.deepStrictEqual(spot.water, water, 'la cible d\'eau visée est rendue');
});

// LE point non négociable : un bot qui entre dans l'eau se noie (118 sauvetages `water_rescue`
// mesurés sur un seul run). Sur un étang, aucune case d'eau — ni le dessus d'une case d'eau —
// ne peut servir de berge.
test('pickFishingSpot : étang 3×3 → la berge est HORS de l\'eau et hors de son dessus', () => {
  const pond = [];
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) pond.push({ x, y: 62, z });
  const spot = pickFishingSpot(pond, { x: 0, y: 70, z: 0 }, ALL_OK);
  assert.ok(spot, 'un étang a forcément des bords');
  const onWaterColumn = pond.some((w) => w.x === spot.x && w.z === spot.z);
  assert.strictEqual(onWaterColumn, false, 'ni dans l\'eau, ni debout sur l\'eau');
});

test('pickFishingSpot : aucun sol praticable → null (on ne se jette pas à l\'eau faute de mieux)', () => {
  const spot = pickFishingSpot([{ x: 5, y: 62, z: 0 }], { x: 0, y: 63, z: 0 }, { isStandable: () => false });
  assert.strictEqual(spot, null);
});

test('pickFishingSpot : plusieurs mares → la berge la plus proche du bot', () => {
  const loin = { x: 20, y: 62, z: 0 };
  const pres = { x: 3, y: 62, z: 0 };
  const spot = pickFishingSpot([loin, pres], { x: 0, y: 63, z: 0 }, ALL_OK);
  assert.strictEqual(spot.x, 2, 'la berge côté bot de la mare proche');
  assert.deepStrictEqual(spot.water, pres);
});

test('pickFishingSpot : plage en surplomb → la berge un cran au-dessus du niveau d\'eau est acceptée', () => {
  const water = { x: 5, y: 62, z: 0 };
  // seul le niveau 63 est praticable (le 62 est de la roche pleine)
  const spot = pickFishingSpot([water], { x: 0, y: 63, z: 0 }, { isStandable: (p) => p.y === 63 });
  assert.ok(spot);
  assert.strictEqual(spot.y, 63);
});

test('pickFishingSpot : sans prédicat, ne plante pas et rend une berge', () => {
  const spot = pickFishingSpot([{ x: 5, y: 62, z: 0 }], { x: 0, y: 63, z: 0 });
  assert.ok(spot && typeof spot.x === 'number');
});

// ─── fishCatch : orchestration (faux bot) ───────────────────────────────────────────────────────

const AIR = { name: 'air', boundingBox: 'empty' };
const GROUND = { name: 'grass_block', boundingBox: 'block' };
const WATER = { name: 'water', boundingBox: 'empty' };

/**
 * Monde minimal : un lac plat en `waterAt` (liste de {x,z}) au niveau `sea`, de la terre partout
 * ailleurs jusqu'à `sea`, de l'air au-dessus. Suffisant pour berge + surface.
 */
function fakeBot(opts = {}) {
  const sea = opts.sea != null ? opts.sea : 62;
  const waters = opts.waters || [{ x: 5, z: 0 }];
  const isWaterCol = (x, z) => waters.some((w) => w.x === x && w.z === z);
  const calls = { equip: [], lookAt: [], fish: 0, activateItem: 0, craft: [], goto: [], emit: [] };
  let items = (opts.items || []).map(([name, count]) => ({ name, count }));
  const bot = {
    calls,
    _setItems(next) { items = next.map(([name, count]) => ({ name, count })); },
    entity: { position: { x: 0, y: sea + 1, z: 0 } },
    registry: { blocksByName: { water: { id: 9 } } },
    inventory: { items: () => items },
    blockAt(p) {
      if (!p) return null;
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
      if (isWaterCol(x, z)) return y === sea ? WATER : (y > sea ? AIR : GROUND);
      return y > sea ? AIR : GROUND;               // sol jusqu'au niveau de la mer inclus
    },
    findBlocks: opts.findBlocks || (() => waters.map((w) => ({ x: w.x, y: sea, z: w.z }))),
    async equip(item, dest) { calls.equip.push({ name: item && item.name, dest }); },
    async lookAt(p) { calls.lookAt.push({ x: p.x, y: p.y, z: p.z }); },
    activateItem() { calls.activateItem++; },
    fish: opts.fish || (async () => { calls.fish++; }),
  };
  if (opts.fish) {
    const raw = opts.fish;
    bot.fish = async () => { calls.fish++; return raw(calls.fish); };
  }
  return bot;
}

const baseDeps = (bot, extra = {}) => Object.assign({
  sleep: async () => {},
  emit: (e) => bot.calls.emit.push(e),
  goto: async (p) => { bot.calls.goto.push({ x: p.x, y: p.y, z: p.z }); },
}, extra);

const FAST = { perCatchMs: 200, totalMs: 3000, recastMs: 0 };

test('fishCatch : ni canne ni matériaux → no_rod, et on ne lance JAMAIS la ligne', async () => {
  const bot = fakeBot({ items: [['dirt', 4]] });
  const r = await fishCatch(bot, baseDeps(bot), Object.assign({ target: 2 }, FAST));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.caught, 0);
  assert.strictEqual(r.reason, 'no_rod');
  assert.strictEqual(bot.calls.fish, 0);
  assert.deepStrictEqual(r.missing, { sticks: 3, string: 2 });
});

test('fishCatch : matériaux en poche → la canne est fabriquée via deps.craft puis on pêche', async () => {
  const bot = fakeBot({ items: [['stick', 3], ['string', 2]] });
  const deps = baseDeps(bot, {
    craft: async (args) => {
      bot.calls.craft.push(args);
      bot._setItems([['fishing_rod', 1]]);
      return { ok: true };
    },
  });
  const r = await fishCatch(bot, deps, Object.assign({ target: 2 }, FAST));
  assert.deepStrictEqual(bot.calls.craft, [{ name: 'fishing_rod', count: 1 }]);
  assert.deepStrictEqual({ ok: r.ok, caught: r.caught }, { ok: true, caught: 2 });
});

test('fishCatch : matériaux mais craft impossible (aucun deps.craft) → no_rod propre', async () => {
  const bot = fakeBot({ items: [['stick', 3], ['string', 2]] });
  const r = await fishCatch(bot, baseDeps(bot), Object.assign({ target: 1 }, FAST));
  assert.strictEqual(r.reason, 'no_rod');
  assert.strictEqual(bot.calls.fish, 0);
});

test('fishCatch : craft raté (matériaux volés par un autre craft) → no_rod, sans exception', async () => {
  const bot = fakeBot({ items: [['stick', 3], ['string', 2]] });
  const deps = baseDeps(bot, { craft: async () => ({ ok: false, reason: 'craft_failed' }) });
  const r = await fishCatch(bot, deps, Object.assign({ target: 1 }, FAST));
  assert.strictEqual(r.reason, 'no_rod');
  assert.strictEqual(r.caught, 0);
});

test('fishCatch : canne en poche → équipée en main, et `target` prises rendues', async () => {
  const bot = fakeBot({ items: [['fishing_rod', 1]] });
  const r = await fishCatch(bot, baseDeps(bot), Object.assign({ target: 3 }, FAST));
  assert.deepStrictEqual({ ok: r.ok, caught: r.caught, reason: r.reason }, { ok: true, caught: 3, reason: 'target' });
  assert.ok(bot.calls.equip.some((e) => e.name === 'fishing_rod' && e.dest === 'hand'), 'canne équipée en main');
  assert.strictEqual(bot.calls.fish, 3);
});

test('fishCatch : aucune eau à portée → no_water (et rien n\'est lancé)', async () => {
  const bot = fakeBot({ items: [['fishing_rod', 1]], findBlocks: () => [] });
  const r = await fishCatch(bot, baseDeps(bot), Object.assign({ target: 2 }, FAST));
  assert.deepStrictEqual({ ok: r.ok, caught: r.caught, reason: r.reason }, { ok: false, caught: 0, reason: 'no_water' });
  assert.strictEqual(bot.calls.fish, 0);
});

// L'eau sous un plafond de roche (aquifère de tunnel) n'est PAS de l'eau de surface : le bouchon
// n'a nulle part où flotter. On ne veut surtout pas y envoyer un bot qui creuse (noyade).
test('fishCatch : eau enterrée (pas d\'air au-dessus) → no_water', async () => {
  const bot = fakeBot({ items: [['fishing_rod', 1]] });
  const plain = bot.blockAt;
  bot.blockAt = (p) => {
    const b = plain(p);
    if (b === AIR && Math.floor(p.y) === 63) return GROUND;   // plafond de roche sur toute la nappe
    return b;
  };
  const r = await fishCatch(bot, baseDeps(bot), Object.assign({ target: 1 }, FAST));
  assert.strictEqual(r.reason, 'no_water');
});

test('fishCatch : eau sans berge praticable → no_spot (on n\'entre pas dans l\'eau)', async () => {
  const bot = fakeBot({ items: [['fishing_rod', 1]] });
  const deps = baseDeps(bot, { pickSpot: () => null });
  const r = await fishCatch(bot, deps, Object.assign({ target: 1 }, FAST));
  assert.deepStrictEqual({ ok: r.ok, caught: r.caught, reason: r.reason }, { ok: false, caught: 0, reason: 'no_spot' });
  assert.strictEqual(bot.calls.fish, 0);
});

test('fishCatch : le bot est envoyé sur la BERGE, jamais sur la case d\'eau', async () => {
  const bot = fakeBot({ items: [['fishing_rod', 1]] });
  const r = await fishCatch(bot, baseDeps(bot), Object.assign({ target: 1 }, FAST));
  assert.strictEqual(r.caught, 1);
  assert.strictEqual(bot.calls.goto.length, 1);
  const g = bot.calls.goto[0];
  assert.ok(!(g.x === 5 && g.z === 0), `goto ${JSON.stringify(g)} : c'est la case d'eau !`);
  assert.ok(bot.calls.lookAt.length >= 1, 'le bot regarde l\'eau avant de lancer');
});

test('fishCatch : berge inatteignable → unreachable, sans exception', async () => {
  const bot = fakeBot({ items: [['fishing_rod', 1]] });
  const deps = baseDeps(bot, { goto: async () => { throw new Error('no path'); } });
  const r = await fishCatch(bot, deps, Object.assign({ target: 1 }, FAST));
  assert.deepStrictEqual({ ok: r.ok, caught: r.caught, reason: r.reason }, { ok: false, caught: 0, reason: 'unreachable' });
  assert.strictEqual(bot.calls.fish, 0);
});

test('fishCatch : sans deps.goto on pêche sur place (best-effort, pas de plantage)', async () => {
  const bot = fakeBot({ items: [['fishing_rod', 1]] });
  const deps = { sleep: async () => {}, emit: () => {} };
  const r = await fishCatch(bot, deps, Object.assign({ target: 1 }, FAST));
  assert.strictEqual(r.caught, 1);
});

test('fishCatch : annulé AVANT de commencer → cancelled, zéro action', async () => {
  const bot = fakeBot({ items: [['fishing_rod', 1]] });
  const r = await fishCatch(bot, baseDeps(bot), Object.assign({ target: 4, token: { cancelled: true } }, FAST));
  assert.deepStrictEqual({ ok: r.ok, caught: r.caught, reason: r.reason }, { ok: false, caught: 0, reason: 'cancelled' });
  assert.strictEqual(bot.calls.fish, 0);
});

test('fishCatch : annulé entre deux prises → s\'arrête, et rend ce qui est réellement pêché', async () => {
  const token = { cancelled: false };
  const bot = fakeBot({ items: [['fishing_rod', 1]], fish: (n) => { if (n === 2) token.cancelled = true; } });
  const r = await fishCatch(bot, baseDeps(bot), Object.assign({ target: 8, token }, FAST));
  assert.strictEqual(r.reason, 'cancelled');
  assert.strictEqual(r.caught, 2, 'les 2 poissons déjà pris comptent');
  assert.strictEqual(r.ok, true, 'du poisson est du poisson');
  assert.strictEqual(bot.calls.fish, 2, 'plus aucun lancer après l\'annulation');
});

// Piège #41d : bot.fish() ne résout QUE sur les particules de touche. Bouchon sur la terre ferme,
// désync, poisson qui ne mord pas → la promesse ne se règle JAMAIS. Sans borne, le bot gèle à vie.
test('fishCatch : ça ne mord pas → borné, la ligne est rembobinée, et on abandonne', async () => {
  const bot = fakeBot({ items: [['fishing_rod', 1]], fish: () => new Promise(() => {}) });  // jamais résolue
  const t0 = Date.now();
  const r = await fishCatch(bot, baseDeps(bot), { target: 4, perCatchMs: 60, totalMs: 5000, recastMs: 0 });
  assert.deepStrictEqual({ ok: r.ok, caught: r.caught, reason: r.reason }, { ok: false, caught: 0, reason: 'no_bite' });
  assert.ok(Date.now() - t0 < 2000, 'jamais de blocage : quelques essais bornés puis abandon');
  assert.ok(bot.calls.activateItem >= 1, 'la ligne doit être rembobinée après un lancer mort');
});

test('fishCatch : budget total dépassé → arrêt propre, le poisson déjà pris est rendu', async () => {
  let n = 0;
  const bot = fakeBot({
    items: [['fishing_rod', 1]],
    fish: () => { n++; return n <= 2 ? Promise.resolve() : new Promise(() => {}); },
  });
  const r = await fishCatch(bot, baseDeps(bot), { target: 20, perCatchMs: 40, totalMs: 150, recastMs: 0 });
  assert.strictEqual(r.ok, true);
  assert.ok(r.caught >= 2, `caught=${r.caught}`);
  assert.ok(['timeout', 'no_bite'].includes(r.reason), `reason=${r.reason}`);
});

// La canne s'use (64 utilisations) : elle CASSE en pleine session.
test('fishCatch : canne cassée en cours → on re-vérifie, plus rien en poche → rod_lost propre', async () => {
  const bot = fakeBot({
    items: [['fishing_rod', 1]],
    fish: (n) => {
      if (n === 2) { bot._setItems([]); return Promise.reject(new Error('no rod')); }
      return Promise.resolve();
    },
  });
  const r = await fishCatch(bot, baseDeps(bot), Object.assign({ target: 5 }, FAST));
  assert.strictEqual(r.reason, 'rod_lost');
  assert.strictEqual(r.caught, 1);
  assert.strictEqual(r.ok, true, 'la prise faite avant la casse compte');
});

test('fishCatch : canne cassée mais une seconde en poche → ré-équipée, la pêche continue', async () => {
  const bot = fakeBot({
    items: [['fishing_rod', 2]],
    fish: (n) => (n === 2 ? Promise.reject(new Error('broken')) : Promise.resolve()),
  });
  const r = await fishCatch(bot, baseDeps(bot), Object.assign({ target: 3 }, FAST));
  assert.strictEqual(r.caught, 3, 'la 2e canne prend le relais');
  assert.ok(bot.calls.equip.filter((e) => e.name === 'fishing_rod').length >= 2, 'ré-équipement après la casse');
});

test('fishCatch : deuxième casse d\'affilée → on abandonne (pas de boucle de récupération)', async () => {
  const bot = fakeBot({
    items: [['fishing_rod', 5]],
    fish: () => Promise.reject(new Error('broken')),
  });
  const r = await fishCatch(bot, baseDeps(bot), Object.assign({ target: 5 }, FAST));
  assert.strictEqual(r.reason, 'rod_lost');
  assert.ok(bot.calls.fish <= 2, `le rattrapage est unique (fish=${bot.calls.fish})`);
});

test('fishCatch : lookAt/equip qui explosent → aucune exception ne remonte', async () => {
  const bot = fakeBot({ items: [['fishing_rod', 1]] });
  bot.lookAt = async () => { throw new Error('boom'); };
  bot.equip = async () => { throw new Error('boom'); };
  const r = await fishCatch(bot, baseDeps(bot), Object.assign({ target: 1 }, FAST));
  assert.strictEqual(typeof r.ok, 'boolean');
  assert.strictEqual(r.caught, 1, 'un equip raté ne doit pas empêcher de pêcher');
});

test('fishCatch : bot sans API fish (version/stub) → no_fish_api, jamais un crash', async () => {
  const bot = fakeBot({ items: [['fishing_rod', 1]] });
  delete bot.fish;
  const r = await fishCatch(bot, baseDeps(bot), Object.assign({ target: 1 }, FAST));
  assert.deepStrictEqual({ ok: r.ok, caught: r.caught, reason: r.reason }, { ok: false, caught: 0, reason: 'no_fish_api' });
});

test('fishCatch : registre sans bloc water → no_water, sans exception', async () => {
  const bot = fakeBot({ items: [['fishing_rod', 1]] });
  bot.registry = { blocksByName: {} };
  const r = await fishCatch(bot, baseDeps(bot), Object.assign({ target: 1 }, FAST));
  assert.strictEqual(r.reason, 'no_water');
});

test('fishCatch : findBlocks qui throw → no_water, sans exception', async () => {
  const bot = fakeBot({ items: [['fishing_rod', 1]], findBlocks: () => { throw new Error('boom'); } });
  const r = await fishCatch(bot, baseDeps(bot), Object.assign({ target: 1 }, FAST));
  assert.strictEqual(r.reason, 'no_water');
});

test('fishCatch : les prises sont tracées (observabilité — un échec silencieux est un bug, #55a)', async () => {
  const bot = fakeBot({ items: [['fishing_rod', 1]] });
  await fishCatch(bot, baseDeps(bot), Object.assign({ target: 2 }, FAST));
  const kinds = bot.calls.emit.filter((e) => e.type === 'fish').map((e) => e.action);
  assert.ok(kinds.includes('caught'), `events: ${JSON.stringify(kinds)}`);
  assert.ok(kinds.includes('done'), 'la fin de session est tracée');
});
