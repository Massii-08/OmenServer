'use strict';
// CÂBLAGE de l'armure diamant des mineurs (24/10 soir). Logique pure dans diaArmor.js / goals.js ; ici on
// EXÉCUTE le vrai texte de craftDiamondArmorPiece / _diaPickState / craftDiamondPick dans un bac à sable
// `vm` strict (piège #56 : une variable lue hors niveau module → ReferenceError ici).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const G = require('./goals');
const DA = require('./diaArmor');
const { isNearlyBroken } = require('./gear');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(re, label) { const m = SRC.match(re); assert.ok(m, `${label} introuvable dans index.js`); return m[0]; }
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);
const constSrc = (name) => grab(new RegExp(`^const ${name} = [^;]+;`, 'm'), `const ${name}`);
const letSrc = (name) => grab(new RegExp(`^let ${name} = [^;]+;`, 'm'), `let ${name}`);
const run = (sb, code) => vm.runInContext("'use strict';\n" + code, sb);
const plain = (x) => JSON.parse(JSON.stringify(x));   // objets d'un autre royaume vm

const SLOT_IDX = { head: 5, torso: 6, legs: 7, feet: 8 };
const SUFFIX_IDX = { helmet: 5, chestplate: 6, leggings: 7, boots: 8 };

function sandbox(o = {}) {
  const slots = new Array(46).fill(null);
  for (const n of (o.worn || [])) slots[SUFFIX_IDX[n.split('_').pop()]] = { name: n, count: 1, maxDurability: 500, durabilityUsed: 0 };
  const sb = {
    events: [], base: o.base || {}, slots,
    items: (o.items || []).map((i) => Object.assign({ count: 1 }, i)),
    emit(e) { sb.events.push(e); },
    Object, Math, Number, Array, JSON, Promise, Set, Map, String, RegExp,
    loadBaseState: () => sb.base,
    saveBaseState: (st) => { sb.base = st; return true; },
    buildCtxInv: G.buildCtxInv, diamondArmorPlanOf: G.diamondArmorPlanOf, diaWornCount: DA.diaWornCount, isNearlyBroken,
    ctxExtra: () => ({ worn: [...sb._wornArmor()], pocketArmorGood: sb._pocketArmorGood(), hasTable: true }),
    _wornArmor: () => new Set(sb.slots.slice(5, 9).filter((s) => s && !isNearlyBroken(s)).map((s) => s.name)),
    craftSmart: async ({ name }) => {
      const units = DA.DIA_ARMOR_ORDER.find((p) => p.name === name).units;
      const d = sb.items.find((i) => i.name === 'diamond');
      if (!d || d.count < units) return { ok: false, reason: 'missing' };
      d.count -= units;
      sb.items.push({ name, count: 1, maxDurability: 500, durabilityUsed: 0 });
      return { ok: true };
    },
  };
  sb.bot = { inventory: { items: () => sb.items.filter((i) => i.count > 0), get slots() { return sb.slots; } },
    equip: async (it, dest) => {
      if (o.equipFails) throw new Error('moving');
      const idx = SLOT_IDX[dest];
      const old = sb.slots[idx];
      sb.items = sb.items.filter((i) => i !== it);
      sb.slots[idx] = it;
      if (old) sb.items.push(old);          // échange de slot : l'ancienne pièce va en poche
    } };
  vm.createContext(sb);
  run(sb, constSrc('ARMOR_SLOTS'));
  run(sb, letSrc('_diaPick'));
  for (const f of ['_diaPickState', '_saveDiaPick', '_pocketArmorGood', 'craftDiamondArmorPiece']) run(sb, fnSrc(f));
  run(sb, 'globalThis.__get = (n) => eval(n);');
  return sb;
}

test('craftDiamondArmorPiece : forge le plastron, l enfile, garde le fer en poche, compte les diamants', async () => {
  const sb = sandbox({ worn: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'],
    items: [{ name: 'diamond', count: 20 }, { name: 'iron_pickaxe' }, { name: 'crafting_table' }],
    base: { diamondPick: { spent: 3, upgraded: true }, keep: 'x' } });
  const r = await sb.craftDiamondArmorPiece();
  assert.deepStrictEqual(plain(r), { ok: true });
  assert.strictEqual(sb.slots[6].name, 'diamond_chestplate');
  assert.ok(sb.items.some((i) => i.name === 'iron_chestplate'), 'le fer remplacé reste en poche');
  assert.strictEqual(sb.items.find((i) => i.name === 'diamond').count, 12);
  const ev = sb.events.find((e) => e.type === 'diamond_armor_crafted');
  assert.deepStrictEqual({ item: ev.item, used: ev.used, worn: ev.worn, spent: ev.spent, armorDiamonds: ev.armorDiamonds },
    { item: 'diamond_chestplate', used: 8, worn: 1, spent: 11, armorDiamonds: 8 });
  assert.deepStrictEqual(plain(sb.base.diamondPick), { spent: 11, upgraded: true, armor: 8 });
  assert.strictEqual(sb.base.keep, 'x', 'mémo base fusionné');
  // 12 diamants : jambières (7) abordables avec la réserve de 3 → 2e appel
  await sb.craftDiamondArmorPiece();
  assert.strictEqual(sb.slots[7].name, 'diamond_leggings');
  assert.strictEqual(sb.base.diamondPick.spent, 18);
  // 5 diamants restants : casque (5) - réserve 3 → rien (on mine)
  assert.deepStrictEqual(plain(await sb.craftDiamondArmorPiece()), { ok: true });
  assert.strictEqual(sb.items.find((i) => i.name === 'diamond').count, 5, 'jamais sous la réserve pioche');
});

test('craftDiamondArmorPiece : pièce diamant usée → refaite en diamant', async () => {
  const sb = sandbox({ worn: ['diamond_chestplate'], items: [{ name: 'diamond', count: 11 }, { name: 'iron_pickaxe' }, { name: 'crafting_table' }] });
  sb.slots[6].durabilityUsed = 490;                       // usée : sort de _wornArmor
  await sb.craftDiamondArmorPiece();
  assert.strictEqual(sb.slots[6].name, 'diamond_chestplate');
  assert.strictEqual(sb.slots[6].durabilityUsed, 0, 'la neuve est portée');
  assert.ok(sb.items.some((i) => i.name === 'diamond_chestplate' && i.durabilityUsed === 490), 'l usée est en poche');
  // l'usée en poche ne compte pas comme « à enfiler »
  assert.strictEqual(sb.__get('_pocketArmorGood()').includes('diamond_chestplate'), false);
});

test('craftDiamondArmorPiece : equip refusé → échec émis, diamants comptés quand même', async () => {
  const sb = sandbox({ equipFails: true, items: [{ name: 'diamond', count: 11 }, { name: 'iron_pickaxe' }, { name: 'crafting_table' }] });
  const r = await sb.craftDiamondArmorPiece();
  assert.deepStrictEqual(plain(r), { ok: true });            // la pièce existe : l'enfiler devient le but suivant
  assert.ok(sb.events.some((e) => e.type === 'diamond_armor_equip_failed'));
  assert.strictEqual(sb.base.diamondPick.armor, 8);
  const r2 = await sb.craftDiamondArmorPiece();       // plan = equip de la pièce en poche
  assert.deepStrictEqual(plain(r2), { ok: false, reason: 'equip_failed' });
});

test('craftDiamondPick conserve la part armure de spent', () => {
  assert.match(fnSrc('craftDiamondPick'), /armor: st\.armor \|\| 0/);
});
