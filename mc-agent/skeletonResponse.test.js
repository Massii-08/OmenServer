'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  decideSkeletonResponse, rushMinHp, findCoverCell, zigzagSide,
  RUSH_DIST, CONTACT_DIST,
} = require('./skeletonResponse');

// Situation de base calquée sur les morts live du 22/10 (NethBot1/3) : mineur nu ou presque, épée de
// pierre, cobble en poche, squelette en ligne de vue, aucun zombie collé.
const base = (o = {}) => Object.assign({
  dist: 7, los: true, health: 12, armorPoints: 0, attackDamage: 5, hasShield: false,
  hasBlock: true, meleeOthers: 0, shooters: 1, inWater: false, coverCell: false,
}, o);

test('squelette au CONTACT (aura_hit 2,8 blocs), 9 PV, épée → RUSH (fuir = flèches dans le dos)', () => {
  const r = decideSkeletonResponse(base({ dist: 2.8, health: 9 }));
  assert.equal(r.action, 'rush');
});

test('squelette proche (7 blocs) PV corrects, épée → RUSH', () => {
  assert.equal(decideSkeletonResponse(base({ dist: 7, health: 14 })).action, 'rush');
});

test('squelette proche mais PV trop bas pour courir dessus → couvert si une case cachée existe', () => {
  const r = decideSkeletonResponse(base({ dist: 7, health: 7, coverCell: true }));
  assert.equal(r.action, 'cover');
});

test('pas de case cachée, des blocs en poche → BLOCK (muret), jamais une fuite à découvert', () => {
  const r = decideSkeletonResponse(base({ dist: 12, health: 8, coverCell: false, hasBlock: true }));
  assert.equal(r.action, 'block');
});

test('loin (12 blocs) → on ne traverse pas le champ de tir : cover avant tout', () => {
  const r = decideSkeletonResponse(base({ dist: 12, health: 20, coverCell: true }));
  assert.equal(r.action, 'cover');
});

test('sans ligne de vue → cover (rester caché : ne pas sortir dans son champ)', () => {
  const r = decideSkeletonResponse(base({ los: false, dist: 10, health: 5 }));
  assert.equal(r.action, 'cover');
  assert.equal(r.reason, 'no_los');
});

test('sans arme → pas de rush au-delà du contact (20 coups de poing = mort)', () => {
  const r = decideSkeletonResponse(base({ dist: 6, health: 18, attackDamage: 0, coverCell: true }));
  assert.equal(r.action, 'cover');
});

test('dans l\'eau → flee (on ne pose rien en nageant)', () => {
  assert.equal(decideSkeletonResponse(base({ inWater: true })).action, 'flee');
});

test('zombie collé en plus → flee (mêlée mixte : la logique historique garde la main)', () => {
  const r = decideSkeletonResponse(base({ meleeOthers: 1 }));
  assert.equal(r.action, 'flee');
  assert.equal(r.reason, 'melee_mix');
});

test('deux tireurs → pas de rush (on court sous le feu du second) : cover/block', () => {
  const r = decideSkeletonResponse(base({ dist: 5, health: 18, shooters: 2 }));
  assert.equal(r.action, 'block');
});

test('rien à poser, aucune case cachée, proche et 5 PV avec épée → rush de désespoir plutôt que fuite', () => {
  const r = decideSkeletonResponse(base({ dist: 6, health: 5, hasBlock: false, coverCell: false }));
  assert.equal(r.action, 'rush');
  assert.equal(r.reason, 'no_cover');
});

test('rien à poser, aucune case, loin → flee (dernier recours)', () => {
  const r = decideSkeletonResponse(base({ dist: 14, health: 5, hasBlock: false, coverCell: false }));
  assert.equal(r.action, 'flee');
});

test('rushMinHp : bouclier et armure abaissent le seuil, plancher 4', () => {
  assert.ok(rushMinHp({ dist: 7 }) > rushMinHp({ dist: 7, hasShield: true }));
  assert.ok(rushMinHp({ dist: 7 }) > rushMinHp({ dist: 7, armorPoints: 10 }));
  assert.ok(rushMinHp({ dist: CONTACT_DIST }) < rushMinHp({ dist: RUSH_DIST }));
  assert.ok(rushMinHp({ dist: 2, hasShield: true, armorPoints: 15 }) >= 4);
});

// ─── findCoverCell : tourner un coin ─────────────────────────────────────────────────────────────
// Monde jouet : sol plein à y=63, un pilier 1×2 (x=1, z=1, y=64-65) entre le squelette (x=1, z=10)
// et la case (1, 64, 0). Le bot est en (0, 64, 0) en pleine vue.
function world(extraSolid = []) {
  const solid = new Set(extraSolid.map((p) => p.join(',')));
  return (x, y, z) => y <= 63 || solid.has([x, y, z].join(','));
}

test('findCoverCell : rend la case cachée derrière le pilier la plus proche', () => {
  const isSolid = world([[1, 64, 1], [1, 65, 1]]);
  const c = findCoverCell({ from: { x: 0.5, y: 64, z: 0.5 }, shooter: { x: 1.5, y: 64, z: 10.5 }, isSolid, radius: 3 });
  assert.ok(c, 'une case cachée existe');
  assert.deepEqual([c.x, c.y, c.z], [1, 64, 0]);
});

test('findCoverCell : terrain plat sans obstacle → null', () => {
  const c = findCoverCell({ from: { x: 0.5, y: 64, z: 0.5 }, shooter: { x: 1.5, y: 64, z: 10.5 }, isSolid: world(), radius: 3 });
  assert.equal(c, null);
});

test('findCoverCell : ignore une case sans sol (jamais au-dessus du vide)', () => {
  // pilier présent mais sol creusé sous la case cachée
  const base = world([[1, 64, 1], [1, 65, 1]]);
  const isSolid = (x, y, z) => (x === 1 && y === 63 && z === 0) ? false : base(x, y, z);
  const c = findCoverCell({ from: { x: 0.5, y: 64, z: 0.5 }, shooter: { x: 1.5, y: 64, z: 10.5 }, isSolid, radius: 3 });
  assert.ok(!c || !(c.x === 1 && c.y === 64 && c.z === 0));
});

test('findCoverCell : déjà caché à sa place → la case du bot n\'est jamais rendue (pas de 0 bloc)', () => {
  const isSolid = world([[0, 64, 1], [0, 65, 1]]);
  const c = findCoverCell({ from: { x: 0.5, y: 64, z: 0.5 }, shooter: { x: 0.5, y: 64, z: 10.5 }, isSolid, radius: 3 });
  assert.ok(!c || !(c.x === 0 && c.y === 64 && c.z === 0));
});

test('zigzagSide : alterne gauche/droite à chaque demi-période', () => {
  assert.equal(zigzagSide(0, 400), 'left');
  assert.equal(zigzagSide(450, 400), 'right');
  assert.equal(zigzagSide(850, 400), 'left');
});

// ─── Retour live 23/10 : `cover no_los` à 2 blocs, puis mort ────────────────────────────────────────
const { shooterSees } = require('./skeletonResponse');

test('contact (≤ 3,5 blocs) : JAMAIS cover/no_los — rush armé, même à 2,5 PV', () => {
  const r = decideSkeletonResponse(base({ dist: 2, los: false, health: 2.5 }));
  assert.equal(r.action, 'rush');
  assert.equal(r.reason, 'contact');
});

test('contact sans arme : frapper (rush contact_unarmed) plutôt que rester immobile', () => {
  const r = decideSkeletonResponse(base({ dist: 2.7, los: false, health: 5, attackDamage: 0 }));
  assert.equal(r.action, 'rush');
  assert.equal(r.reason, 'contact_unarmed');
});

test('touché par une flèche pendant un « cover » → recalculé comme los:true (plus de no_los)', () => {
  const r = decideSkeletonResponse(base({ dist: 10, los: false, hurt: true, health: 8, coverCell: false }));
  assert.notEqual(r.reason, 'no_los');
  assert.equal(r.action, 'block');
});

// Monde à blocs : un bloc partiel (dalle du bas) ne masque que sa moitié basse, comme le collider vanilla.
function blocks(map) {
  return (p) => {
    const k = [p.x, p.y, p.z].join(',');
    return map[k] || { boundingBox: 'empty' };
  };
}
const FULL = { boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
const SLAB = { boundingBox: 'block', shapes: [[0, 0, 0, 1, 0.5, 1]] };

test('shooterSees : terrain dégagé → vu', () => {
  assert.equal(shooterSees({ shooter: { x: 3.5, y: 64, z: 0.5 }, target: { x: 0.5, y: 64, z: 0.5 }, blockAt: blocks({}) }), true);
});

test('shooterSees : mur plein de 2 de haut entre les deux → caché', () => {
  const m = { '2,64,0': FULL, '2,65,0': FULL };
  assert.equal(shooterSees({ shooter: { x: 4.5, y: 64, z: 0.5 }, target: { x: 0.5, y: 64, z: 0.5 }, blockAt: blocks(m) }), false);
});

test('shooterSees : une dalle à hauteur de tête NE masque PAS (avant : cellule entière opaque → faux no_los)', () => {
  // dalle du bas posée en y=65 entre eux : sa moitié haute (65,5-66) est vide, l'œil (≈ 65,6-65,7) passe
  const m = { '2,65,0': SLAB };
  assert.equal(shooterSees({ shooter: { x: 4.5, y: 64, z: 0.5 }, target: { x: 0.5, y: 64, z: 0.5 }, blockAt: blocks(m) }), true);
});

test('shooterSees : masqué aux yeux mais jambes visibles → vu (le squelette vise le tiers bas du corps)', () => {
  // bloc à hauteur de tête seulement, collé au bot (x=1, y=65), rien en dessous
  const m = { '1,65,0': FULL };
  assert.equal(shooterSees({ shooter: { x: 4.5, y: 64, z: 0.5 }, target: { x: 0.5, y: 64, z: 0.5 }, blockAt: blocks(m) }), true);
});

test('shooterSees : blockAt qui lève → vu (on ne se croit JAMAIS caché sur une erreur de lecture)', () => {
  assert.equal(shooterSees({ shooter: { x: 4.5, y: 64, z: 0.5 }, target: { x: 0.5, y: 64, z: 0.5 }, blockAt: () => { throw new Error('x'); } }), true);
  assert.equal(shooterSees({ shooter: null, target: { x: 0, y: 64, z: 0 }, blockAt: blocks({}) }), true);
});

test('cause : l\'ancien test (threatgate, case pleine) voit un mur là où il n\'y a qu\'une dalle', () => {
  const { hasLineOfSight } = require('./threatgate');
  const m = { '2,65,0': SLAB };
  // ancien câblage : œil du BOT (+1,62) → 80 % de la hauteur du squelette (+1,59)
  const old = hasLineOfSight({ x: 0.5, y: 65.62, z: 0.5 }, { x: 4.5, y: 65.59, z: 0.5 }, blocks(m));
  assert.equal(old, false, 'case partielle traitée comme opaque → faux no_los');
  assert.equal(shooterSees({ shooter: { x: 4.5, y: 64, z: 0.5 }, target: { x: 0.5, y: 64, z: 0.5 }, blockAt: blocks(m) }), true);
});

// ─── Charge protégée (23/10 : rush `killed:false` après 3,5 s — planner relancé, repas en pleine charge) ──
const { rushStopReason, eatDuringRush, callerFromStack, RUSH_ABORT_HP } = require('./skeletonResponse');

test('rushStopReason : ordre killed > preempted > target_lost > timeout > hp_floor', () => {
  const ok = { elapsedMs: 1000, maxMs: 6000, alive: true, targetOurs: true, cancelled: false, hp: 10, dist: 5 };
  assert.equal(rushStopReason(ok), null);
  assert.equal(rushStopReason({ ...ok, alive: false, cancelled: true }), 'killed');
  assert.equal(rushStopReason({ ...ok, cancelled: true, targetOurs: false }), 'preempted');
  assert.equal(rushStopReason({ ...ok, targetOurs: false }), 'target_lost');
  assert.equal(rushStopReason({ ...ok, elapsedMs: 6000 }), 'timeout');
  assert.equal(rushStopReason({ ...ok, hp: RUSH_ABORT_HP, dist: 6 }), 'hp_floor');
  assert.equal(rushStopReason({ ...ok, hp: RUSH_ABORT_HP, dist: 2 }), null, 'au contact on finit le travail');
});

test('eatDuringRush : hors charge toujours ; en charge seulement faim ≤ 6 ET PV stables', () => {
  assert.equal(eatDuringRush({ rushing: false, food: 15, hpFalling: true }), true);
  assert.equal(eatDuringRush({ rushing: true, food: 14, hpFalling: false }), false);
  assert.equal(eatDuringRush({ rushing: true, food: 6, hpFalling: false }), true);
  assert.equal(eatDuringRush({ rushing: true, food: 4, hpFalling: true }), false, 'on encaisse : l\'épée reste en main');
});

test('callerFromStack : nom de la 1re fonction hors des cadres ignorés', () => {
  const st = 'Error\n    at guardedStop (/x/index.js:10:5)\n    at PVP.stop (/x/node_modules/mineflayer-pvp/lib/PVP.js:3:1)\n    at stopMotion (/x/index.js:99:9)\n    at runSkill (/x/index.js:500:2)';
  assert.equal(callerFromStack(st, ['guardedStop', 'PVP.']), 'stopMotion');
  assert.equal(callerFromStack('', []), null);
});

// ─── Réarmement pendant la charge (24/10, NethBot3 : `rearmed: 13` en 6 s, aucun coup porté) ──────────
const { rushRearmWanted, rushEquipBlocked, REARM_MIN_GAP_MS } = require('./skeletonResponse');

// Mini-inventaire au comportement de mineflayer `simple_inventory.equip` : l'item porte son `slot`, la
// main est le slot 36 + quickBarSlot, un item hors barre rapide est DÉPLACÉ (échange) vers un slot de la
// barre choisi en LRU. Les objets Item d'avant le déplacement gardent leur ancien `slot` (périmé).
function fakeInventory() {
  const slots = {};
  const put = (slot, name) => { slots[slot] = name ? { name, slot } : null; };
  put(36, 'iron_pickaxe'); put(37, 'torch'); put(38, 'cobblestone'); put(39, 'bread');
  put(40, 'cobbled_deepslate'); put(41, 'raw_iron'); put(42, 'coal'); put(43, 'stick'); put(44, 'dirt');
  put(20, 'diamond_sword');
  const inv = { quickBarSlot: 0, lru: 0, equips: 0,
    held() { return slots[36 + this.quickBarSlot]; },
    find(name) { return Object.values(slots).find((it) => it && it.name === name) || null; },
    equip(item) {                                    // copie de la logique mineflayer
      this.equips++;
      const src = item.slot;
      const dest = 36 + this.quickBarSlot;
      if (src === dest) return;
      if (src >= 36 && src < 45) { this.quickBarSlot = src - 36; return; }
      const d = 36 + this.lru; this.lru = (this.lru + 1) % 9;
      this.quickBarSlot = d - 36;
      const a = slots[src], b = slots[d];
      put(d, a ? a.name : null); put(src, b ? b.name : null);   // nouveaux objets : l'ancien garde son slot
    },
  };
  return inv;
}

test('PREUVE : rééquiper avec l\'Item capturé au départ (slot périmé) fait du ping-pong dans la main', () => {
  const inv = fakeInventory();
  const w = inv.find('diamond_sword');                 // capturé UNE fois, comme `const w = _skelWeapon()`
  inv.equip(w);                                       // equip initial : l'épée part en barre rapide
  assert.strictEqual(inv.held().name, 'diamond_sword');
  inv.quickBarSlot = 1;                               // UN equip étranger (torche, outil) une seule fois
  let rearmed = 0;
  for (let t = 0; t < 24; t++) {                     // 6 s de boucle à 250 ms (ancien code : sans délai)
    if (inv.held() && inv.held().name !== w.name) { inv.equip(w); rearmed++; }
  }
  assert.ok(rearmed >= 10, `ping-pong : ${rearmed} rééquipements (vécu : 13)`);
});

test('CORRECTIF : arme relue à chaque fois + au plus 1×/s → un seul rééquipement, épée en main', () => {
  const inv = fakeInventory();
  inv.equip(inv.find('diamond_sword'));
  inv.quickBarSlot = 1;                               // le même equip étranger
  let rearmed = 0, last = -Infinity;
  for (let t = 0; t < 24; t++) {
    const now = t * 250;
    if (rushRearmWanted({ heldName: inv.held() && inv.held().name, weaponName: 'diamond_sword', now, lastRearmAt: last })) {
      inv.equip(inv.find('diamond_sword')); rearmed++; last = now;
    }
  }
  assert.strictEqual(rearmed, 1);
  assert.strictEqual(inv.held().name, 'diamond_sword');
});

test('rushRearmWanted : déjà en main / usage en cours / moins d\'1 s depuis le dernier → non', () => {
  assert.strictEqual(rushRearmWanted({ heldName: 'diamond_sword', weaponName: 'diamond_sword', now: 5000 }), false);
  assert.strictEqual(rushRearmWanted({ heldName: 'bread', weaponName: 'diamond_sword', usingHeldItem: true, now: 5000 }), false);
  assert.strictEqual(rushRearmWanted({ heldName: 'torch', weaponName: 'diamond_sword', now: 5000, lastRearmAt: 4500 }), false);
  assert.strictEqual(rushRearmWanted({ heldName: 'torch', weaponName: 'diamond_sword', now: 5000, lastRearmAt: 5000 - REARM_MIN_GAP_MS }), true);
  assert.strictEqual(rushRearmWanted({ heldName: null, weaponName: null, now: 1 }), false, 'pas d\'arme : rien');
});

test('rushEquipBlocked : pendant la charge, pas d\'outil ni de torche en main ; arme, blocs et hors charge permis', () => {
  const R = { rushing: true, weaponName: 'diamond_sword' };
  assert.strictEqual(rushEquipBlocked({ ...R, itemName: 'iron_pickaxe' }), true);
  assert.strictEqual(rushEquipBlocked({ ...R, itemName: 'torch' }), true);
  assert.strictEqual(rushEquipBlocked({ ...R, itemName: 'diamond_sword' }), false);
  assert.strictEqual(rushEquipBlocked({ ...R, itemName: 'cobblestone' }), false, 'mur de panique / lave = survie');
  assert.strictEqual(rushEquipBlocked({ ...R, itemName: 'shield', dest: 'off-hand' }), false);
  assert.strictEqual(rushEquipBlocked({ rushing: true, weaponName: 'iron_axe', itemName: 'iron_axe' }), false);
  assert.strictEqual(rushEquipBlocked({ rushing: false, weaponName: 'diamond_sword', itemName: 'iron_pickaxe' }), false);
});

// ─── Retour live 25/10 (22 morts « shot by Skeleton ») : 7 morts juste après une charge à PV bas ou
// sans arme (13:01 contact_unarmed 2 PV, 15:40 contact 1,9 PV, 18:09 contact 1,5 PV, 18:26
// contact_unarmed…), aucune avec bouclier. Joueur : on ne charge jamais à PV bas sans bouclier ; on casse
// la ligne de vue. Avec un bouclier, on approche couvert et on frappe à portée.
test('contact VU, PV bas, sans bouclier, coin disponible → cover (plus de charge à 2 PV)', () => {
  const r = decideSkeletonResponse(base({ dist: 2.4, los: true, health: 2, coverCell: true }));
  assert.equal(r.action, 'cover');
  assert.equal(r.reason, 'contact_low');
});

test('contact VU, sans arme ni bouclier, coin à 1 pas → cover (20 coups de poing = mort)', () => {
  const r = decideSkeletonResponse(base({ dist: 2.8, los: true, health: 13, attackDamage: 1, coverCell: true }));
  assert.equal(r.action, 'cover');
  assert.equal(r.reason, 'contact_low');
});

test('contact VU, PV bas, pas de coin mais des blocs → rush, PAS de muret (il le contourne d\'un pas, 23/10)', () => {
  const r = decideSkeletonResponse(base({ dist: 2.5, los: true, health: 2.5, coverCell: false, hasBlock: true }));
  assert.equal(r.action, 'rush');
});

test('contact VU, PV bas, rien pour se couvrir → on frappe quand même (dernier recours)', () => {
  const r = decideSkeletonResponse(base({ dist: 2, los: true, health: 2, coverCell: false, hasBlock: false }));
  assert.equal(r.action, 'rush');
});

test('contact VU, PV bas AVEC bouclier → rush (bouclier levé à l\'approche, baissé pour frapper)', () => {
  const r = decideSkeletonResponse(base({ dist: 2.4, los: true, health: 3, hasShield: true, coverCell: true }));
  assert.equal(r.action, 'rush');
});

test('contact VU, PV corrects, armé → rush inchangé (bots rapides)', () => {
  const r = decideSkeletonResponse(base({ dist: 2.4, los: true, health: 12, coverCell: true }));
  assert.equal(r.action, 'rush');
  assert.equal(r.reason, 'contact');
});

test('bouclier + armé + seul à 12 blocs → rush « shielded » (on approche couvert au lieu de reculer)', () => {
  const r = decideSkeletonResponse(base({ dist: 12, health: 14, hasShield: true, coverCell: true }));
  assert.equal(r.action, 'rush');
  assert.equal(r.reason, 'shielded');
});

test('bouclier mais DEUX tireurs à 12 blocs → à couvert, pas de charge', () => {
  const r = decideSkeletonResponse(base({ dist: 12, health: 14, hasShield: true, shooters: 2, coverCell: true }));
  assert.equal(r.action, 'cover');
});

test('sans bouclier à 12 blocs → jamais de charge longue (inchangé)', () => {
  const r = decideSkeletonResponse(base({ dist: 12, health: 20, hasShield: false, coverCell: true }));
  assert.equal(r.action, 'cover');
});
