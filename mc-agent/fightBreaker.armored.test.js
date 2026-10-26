'use strict';
// ARMURÉ CONTRE UN ZOMBIE SEUL (26/10) — NethBot3 en fer complet : `survival fight zombie duel:true` →
// `fight_aborted hp:11.7 drop:6.1 hostiles:1 reason:drop duel:false` → fuite → mort 3 s plus tard.
const test = require('node:test');
const assert = require('node:assert/strict');
const { isArmoredLoneZombie, createFightBreaker, ARMORED_LONE_MIN_PIECES } = require('./fightBreaker');

test('armuré (4 pièces) + épée + un zombie seul → on tient le combat', () => {
  assert.equal(isArmoredLoneZombie({ names: ['zombie'], armorPieces: 4, attackDamage: 6 }), true);
});

test('3 pièces suffisent, 2 non', () => {
  assert.equal(ARMORED_LONE_MIN_PIECES, 3);
  assert.equal(isArmoredLoneZombie({ names: ['husk'], armorPieces: 3, attackDamage: 5 }), true);
  assert.equal(isArmoredLoneZombie({ names: ['zombie'], armorPieces: 2, attackDamage: 6 }), false);
});

test('sans arme (aux poings) → règles d\'origine', () => {
  assert.equal(isArmoredLoneZombie({ names: ['zombie'], armorPieces: 4, attackDamage: 0 }), false);
  assert.equal(isArmoredLoneZombie({ names: ['zombie'], armorPieces: 4 }), false);
});

test('deux hostiles, ou un squelette → règles d\'origine', () => {
  assert.equal(isArmoredLoneZombie({ names: ['zombie', 'zombie'], armorPieces: 4, attackDamage: 6 }), false);
  assert.equal(isArmoredLoneZombie({ names: ['skeleton'], armorPieces: 4, attackDamage: 6 }), false);
  assert.equal(isArmoredLoneZombie({ names: [], armorPieces: 4, attackDamage: 6 }), false);
});

test('creeper proche (ou de proximité inconnue) → priorité au creeper', () => {
  assert.equal(isArmoredLoneZombie({ names: ['zombie', 'creeper'], armorPieces: 4, attackDamage: 6 }), false);
  assert.equal(isArmoredLoneZombie({ names: ['zombie', 'creeper'], armorPieces: 4, attackDamage: 6, creeperNear: true }), false);
  // creeper loin et calme : ce n'est plus lui qui décide, le zombie seul compte
  assert.equal(isArmoredLoneZombie({ names: ['zombie', 'creeper'], armorPieces: 4, attackDamage: 6, creeperNear: false }), true);
});

test('le disjoncteur ne lâche pas sur la chute quand le dernier carré armuré tient', () => {
  const fb = createFightBreaker();
  fb.sample(17.8, 0); fb.sample(11.7, 2000);
  const r = fb.check({ inFight: true, health: 11.7, t: 2000, duel: false, lastStand: true });
  assert.equal(r.abort, false);
  assert.equal(r.reason, 'last_stand');
  // sans le dernier carré, même chute → abandon (comportement d'origine)
  const fb2 = createFightBreaker();
  fb2.sample(17.8, 0); fb2.sample(11.7, 2000);
  assert.equal(fb2.check({ inFight: true, health: 11.7, t: 2000, duel: false }).reason, 'drop');
});

// ─── survivalTick : armure portée (slots 5-8) ──────────────────────────────────────────────────────
const { survivalTick, attackDamage } = require('./survival');
function armoredBot(health, mobs, items, pieces = 4) {
  const P = (x) => ({ x, y: -6, z: 0, distanceTo(o) { return Math.hypot(o.x - this.x, o.y - this.y, o.z - this.z); } });
  const ents = {};
  mobs.forEach(([name, d], i) => { ents[i] = { name, kind: 'Hostile mobs', position: P(d) }; });
  const slots = [];
  ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'].slice(0, pieces).forEach((n, i) => { slots[5 + i] = { name: n }; });
  const calls = { flee: 0, canEngage: [] };
  return {
    calls, entity: { position: P(0) }, entities: ents, health, food: 12,
    time: { timeOfDay: 6000 }, inventory: { slots, items: () => items },
    pvp: { attack: () => {} }, equip: async () => {}, blockAt: () => null,
    pathfinder: { isMoving: () => false },
  };
}

test('survivalTick : fer complet + épée de fer, zombie à 6 blocs, 11,7 PV → fight, lastStand transmis', async () => {
  const bot = armoredBot(11.7, [['zombie', 6]], [{ name: 'iron_sword' }]);
  const r = await survivalTick(bot, { fleeFrom: () => { bot.calls.flee++; return true; }, lavaNear: () => false, now: () => 7e9,
    canEngage: (a) => { bot.calls.canEngage.push(a); return { ok: true }; } });
  assert.equal(r, 'fight');
  assert.equal(bot.calls.flee, 0);
  assert.equal(bot.calls.canEngage[0].lastStand, true);
});

test('survivalTick : même situation SANS armure → fuite (règle d\'origine inchangée)', async () => {
  const bot = armoredBot(4, [['zombie', 6]], [{ name: 'iron_sword' }], 0);
  const r = await survivalTick(bot, { fleeFrom: () => true, lavaNear: () => false, now: () => 8e9 });
  assert.equal(r, 'flee');
});

test('survivalTick : armuré mais SANS arme, zombie, 9 PV → fuite (pas de dernier carré aux poings)', async () => {
  const bot = armoredBot(9, [['zombie', 6]], [], 4);
  const r = await survivalTick(bot, { fleeFrom: () => true, lavaNear: () => false, now: () => 9e9 });
  assert.notEqual(r, 'fight');
});

// ─── DIVERGENCE `duel` (26/10) : l'épée sur le curseur pendant un equip ───────────────────────────
// bot.equip(nourriture) déplace l'épée de la main via des clics de fenêtre : un instant elle est sur le
// CURSEUR (inventory.selectedItem), hors de inventory.items(). Un event `health` à cet instant voyait
// attackDamage 0 → duel:false / lastStand:false → disjoncteur « drop » alors que la survie disait duel:true.
test('attackDamage compte l\'arme tenue sur le curseur et en main', () => {
  assert.equal(attackDamage({ inventory: { items: () => [], selectedItem: { name: 'iron_sword' } } }), 6);
  assert.equal(attackDamage({ heldItem: { name: 'stone_sword' }, inventory: { items: () => [] } }), 5);
  assert.equal(attackDamage({ inventory: { items: () => [{ name: 'wooden_sword' }], selectedItem: null } }), 4);
  assert.equal(attackDamage({ inventory: { items: () => [] } }), 0);
});
