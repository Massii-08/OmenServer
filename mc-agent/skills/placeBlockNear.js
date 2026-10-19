'use strict';
// Pose `itemName` (ex. crafting_table) sur un bloc solide adjacent au sol du bot.
// Pass 1  : case vide/replaceable adjacente → pose directe.
// Pass 1b : case occupée par un ENCOMBREMENT cassable (fleur, pousse, champignon…) → on le casse, puis pose.
// Pass 2  : toutes les cases sont solides → creuse une case puis pose (cas underground/enclosed).
// Pass 3  : piédestal (voisins ET sols voisins absents) → remblai, puis pose dessus.
// Pass 4  : pose CONTRE UNE PAROI quand le sol de la case voisine manque.
// Échec total : { ok:false, reason:'no_space', around, under } — voir `_surroundings`.
const { Vec3 } = require('vec3');
const { bestToolFor } = require('../tools');

// Noms de blocs qu'on peut REMPLACER sans creuser (case traitée comme "libre")
// ⚠️ L'EAU EN FAIT PARTIE (mesure live world_mn11, 28/07 : `no_table:no_space` ×8 sur `furnace`
// et `spare_picks`, dès que le correctif combustible a enfin amené le planner jusqu'au craft).
// Dans un tunnel INONDÉ, les 4 voisins sont de l'eau : elle n'était ni « replaceable » (donc
// pass 1 et 4 la sautaient) ni creusable (NON_DIGGABLE, donc pass 2 aussi) → toutes les passes
// échouaient et le bot abandonnait son four. Or en Minecraft poser un bloc dans une source d'eau
// CHASSE le fluide : c'est légal, et c'est exactement ce que fait un joueur dans un tunnel noyé.
const REPLACEABLE = new Set([
  'air', 'cave_air', 'void_air',
  'water', 'flowing_water', 'bubble_column',
  'short_grass', 'grass', 'tall_grass',
  'fern', 'large_fern',
  'snow', 'seagrass', 'kelp', 'kelp_plant',
]);

// Blocs qu'on ne peut PAS creuser même si boundingBox === 'block'
const NON_DIGGABLE = new Set([
  'bedrock', 'water', 'lava', 'flowing_water', 'flowing_lava',
]);

// ── ENCOMBREMENT CASSABLE (fleurs, pousses, champignons, lichen…) ─────────────────────────────────
// Mesure live (216 sessions) : `no_table:no_space` sur spare_picks ×391, furnace, stone_pickaxe,
// stone_sword, wooden_pickaxe — et un bot EN SURFACE (y≈117, prairie d'altitude) a échoué 4/4
// `furnace` en 2 minutes. REPLACEABLE ne connaît que air/eau/herbes/neige : une FLEUR
// (boundingBox 'empty') n'y figure pas → la Pass 1 la saute, la Pass 2 ne creuse que les blocs
// PLEINS, la Pass 4 exige REPLACEABLE. Dans une prairie ou une forêt dense les 4 voisins sont donc
// « encombrés » → `no_space`, alors qu'un joueur casserait la fleur d'un coup de poing et poserait
// sa table. Règle GÉNÉRIQUE sur le boundingBox (chaque version de MC ajoute des fleurs : pas de
// liste à maintenir) + une COURTE liste de ce qu'on ne casse JAMAIS.
const NEVER_BREAK = new Set([
  // fluides, feu, portails : « casser » ne dégage rien, et ce n'est pas du décor
  'water', 'flowing_water', 'lava', 'flowing_lava', 'fire', 'soul_fire',
  'nether_portal', 'end_portal', 'end_gateway', 'bubble_column',
  // torches : ce sont souvent NOS torches de tunnel (branchMine.torchEvery) — on ne s'éteint pas soi-même
  'torch', 'wall_torch', 'soul_torch', 'soul_wall_torch', 'redstone_torch', 'redstone_wall_torch',
  // rails / redstone : des mécanismes (mine, piège, ferme) qu'un joueur ne démonte pas pour poser une table
  'rail', 'powered_rail', 'detector_rail', 'activator_rail', 'redstone_wire', 'tripwire', 'tripwire_hook', 'lever',
  // toile d'araignée : ~20 s à la main (il faut épée/cisailles) → le bot s'y enliserait
  'cobweb',
]);
const NEVER_BREAK_SUFFIX = /_(button|pressure_plate)$/;     // boutons et plaques de pression = redstone aussi

/**
 * Vrai si `block` est du décor non solide qu'on peut CASSER pour libérer la case : bloc présent,
 * boundingBox !== 'block', pas déjà posable tel quel (REPLACEABLE → Pass 1), pas dans NEVER_BREAK.
 * Pur (aucun accès au bot) : testable sur un panel de noms.
 */
function isBreakableClutter(block) {
  if (!block || !block.name) return false;                  // chunk non chargé / bloc absent
  if (block.boundingBox === 'block') return false;          // un bloc PLEIN n'est pas du décor (Pass 2 le creuse)
  if (REPLACEABLE.has(block.name)) return false;            // déjà posable sans rien casser
  if (NEVER_BREAK.has(block.name) || NEVER_BREAK_SUFFIX.test(block.name)) return false;
  return true;
}

// Blocs "remblai" sacrifiables pour créer un sol manquant (Pass 3). On EXCLUT cobblestone
// (réservé au craft de la pioche pierre) et la table elle-même.
const SUPPORT_BLOCKS = new Set([
  'dirt', 'coarse_dirt', 'rooted_dirt', 'grass_block', 'gravel', 'sand', 'red_sand',
  'stone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'cobbled_deepslate',
  'netherrack', 'dripstone_block', 'calcite', 'mud', 'clay',
]);

// #6 retours live : TOUTE pose se fait contre la face d'un bloc PLEIN réel (sinon pose illégale →
// bloc flottant, flag anti-cheat, signature de bot). Référence re-validée juste avant la pose.
const MAX_PLACE_REACH = 5; // ~4.5 depuis les yeux + coussin (les refs ici sont adjacentes de toute façon)
function _refOk(bot, ref) {
  if (!ref || ref.boundingBox !== 'block') return false;
  const p = ref.position;
  if (p && p.distanceTo && bot.entity && bot.entity.position) {
    if (p.distanceTo(bot.entity.position) > MAX_PLACE_REACH) return false;
  }
  return true;
}

// #6 : confirme que le bloc EXISTE vraiment après la pose (1er check immédiat, puis poll court) —
// une pose fantôme (désync client/serveur) ne doit JAMAIS être traitée comme un succès.
async function _confirmPlaced(bot, pos, tries = 6, delayMs = 200) {
  for (let i = 0; i < tries; i++) {
    const b = bot.blockAt(pos);
    if (b && b.boundingBox === 'block') return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

// Casse un encombrement. Gratuit : aucun outil requis (`bestToolFor` ne rend quelque chose que pour
// la liane → cisailles, et reste null pour une fleur). L'échec du dig est PROPAGÉ : l'appelant décide
// (Pass 1b : direction suivante ; Pass 4 : abandonne la case, inutile de réessayer face après face).
async function _breakClutter(bot, block) {
  const tool = bestToolFor(bot, block);
  if (tool) await bot.equip(tool, 'hand');
  await bot.dig(block);
}

// Diagnostic d'échec : noms des 4 cases voisines au niveau des PIEDS (`around`) et des 4 sols voisins
// (`under`), dans l'ordre de `dirs` — Est, Ouest, Sud (+Z), Nord (−Z). 'unloaded' = chunk non chargé
// (blockAt → null). L'instantané est pris à l'ÉCHEC, donc APRÈS nos tentatives : une fleur cassée y
// apparaît en `air` — une case posable qui n'a rien donné = désync client/serveur, pas un manque de
// place. Sans ça, un `no_table:no_space` ne disait rien du terrain (cf. fleurs, ci-dessus).
function _surroundings(bot, base, dirs) {
  const nameAt = (pos) => { const b = bot.blockAt(pos); return (b && b.name) || 'unloaded'; };
  return {
    around: dirs.map((d) => nameAt(base.plus(d))),
    under: dirs.map((d) => nameAt(base.plus(d).offset(0, -1, 0))),
  };
}

/**
 * Pose itemName sur le sol adjacent au bot.
 * Retourne { ok:true, pos:Vec3 } ou { ok:false, reason:string } ; sur 'no_space', le retour porte aussi
 * `around` / `under` (noms des 4 voisins et des 4 sols voisins). `reason` ne change JAMAIS : des
 * appelants testent `reason === 'no_space'` et `'no_table:' + reason`.
 */
async function placeBlockNear(bot, itemName) {
  const item = bot.inventory.items().find((i) => i.name === itemName);
  if (!item) return { ok: false, reason: 'unknown_item' };

  const base = bot.entity.position.floored();
  const dirs = [
    new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(0, 0, -1),
  ];

  // ── Pass 1 : cherche une case libre/replaceable avec sol solide ──────────
  for (const d of dirs) {
    const groundPos = base.plus(d).offset(0, -1, 0);
    const targetPos = base.plus(d);
    const ground = bot.blockAt(groundPos);
    const target = bot.blockAt(targetPos);

    if (!ground || ground.boundingBox !== 'block') continue;
    if (!target) continue;                               // null/unloaded → skip
    if (!REPLACEABLE.has(target.name)) continue;         // not a free cell

    try {
      if (!_refOk(bot, ground)) continue;            // #6 : jamais de pose sans référence pleine
      await bot.equip(item, 'hand');
      await bot.placeBlock(ground, new Vec3(0, 1, 0));
      if (!(await _confirmPlaced(bot, targetPos))) continue;  // #6 : pose fantôme → autre direction
      return { ok: true, pos: base.plus(d) };
    } catch (e) { /* essaie la direction suivante */ }
  }

  // ── Pass 1b : la case est occupée par un ENCOMBREMENT cassable (fleur, pousse, champignon, lichen…) :
  // boundingBox 'empty' mais pas REPLACEABLE, donc les Pass 1 et 2 la sautaient. On la casse (gratuit,
  // sans outil), puis on pose comme en Pass 1. Placée AVANT la Pass 2 : casser une fleur ne coûte
  // rien, creuser un mur si. ──
  for (const d of dirs) {
    const groundPos = base.plus(d).offset(0, -1, 0);
    const targetPos = base.plus(d);
    const ground = bot.blockAt(groundPos);
    const target = bot.blockAt(targetPos);

    if (!ground || ground.boundingBox !== 'block') continue;   // sans sol plein, rien où poser (→ Pass 4)
    if (!isBreakableClutter(target)) continue;                 // torche, rail, fluide… : on n'y touche pas

    try {
      await _breakClutter(bot, target);
      const ref = bot.blockAt(groundPos);
      if (!_refOk(bot, ref)) continue;                         // #6 : re-vérifie la référence après le dig
      await bot.equip(item, 'hand');                           // re-equip after dig
      await bot.placeBlock(ref, new Vec3(0, 1, 0));
      if (!(await _confirmPlaced(bot, targetPos))) continue;   // #6 : pose fantôme → autre direction
      return { ok: true, pos: base.plus(d) };
    } catch (e) { /* essaie la direction suivante */ }
  }

  // ── Pass 2 : creuse une case solide adjacente puis pose ──────────────────
  for (const d of dirs) {
    const groundPos = base.plus(d).offset(0, -1, 0);
    const targetPos = base.plus(d);
    const ground = bot.blockAt(groundPos);
    const target = bot.blockAt(targetPos);

    if (!ground || ground.boundingBox !== 'block') continue;
    if (!target) continue;                               // unloaded → skip
    if (target.boundingBox !== 'block') continue;        // not a solid block to dig
    if (NON_DIGGABLE.has(target.name)) continue;         // can't dig this
    if (target.name === itemName) continue;              // don't dig what we're placing

    try {
      const tool = bestToolFor(bot, target);
      if (tool) await bot.equip(tool, 'hand');
      await bot.dig(target);
      if (!_refOk(bot, bot.blockAt(groundPos))) continue;  // #6 : re-vérifie après le dig
      await bot.equip(item, 'hand');                     // re-equip after dig
      await bot.placeBlock(ground, new Vec3(0, 1, 0));
      if (!(await _confirmPlaced(bot, targetPos))) continue;  // #6 : pose fantôme → autre direction
      return { ok: true, pos: base.plus(d) };
    } catch (e) { /* essaie la direction suivante */ }
  }

  // ── Pass 3 : "piédestal" — voisins ET sols-voisins en air (le bot a miné autour de lui en récoltant
  // le cobble). On comble le sol d'une case voisine avec un bloc de remblai (posé contre la face
  // LATÉRALE du bloc sous les pieds = seul solide adjacent garanti), puis on pose la table dessus. ──
  const floor = bot.blockAt(base.offset(0, -1, 0));        // bloc sous les pieds (solide : le bot est dessus)
  if (floor && floor.boundingBox === 'block') {
    const support = bot.inventory.items().find((i) => SUPPORT_BLOCKS.has(i.name));
    if (support) {
      for (const d of dirs) {
        const cellPos = base.plus(d);                      // case voisine (niveau pieds) → ira la table
        const underPos = base.plus(d).offset(0, -1, 0);    // sol manquant (== floor.position + d)
        const under = bot.blockAt(underPos);
        if (under && under.boundingBox === 'block') continue;   // sol déjà présent → Pass 1/2 gère

        const cell = bot.blockAt(cellPos);
        // la case voisine doit être (ou devenir) vide pour accueillir la table
        if (cell && cell.boundingBox === 'block') {
          if (NON_DIGGABLE.has(cell.name)) continue;
          try {
            const tool = bestToolFor(bot, cell);
            if (tool) await bot.equip(tool, 'hand');
            await bot.dig(cell);
          } catch (e) { continue; }
        } else if (cell && cell.name !== 'air' && !REPLACEABLE.has(cell.name)) {
          continue;
        }

        try {
          // 1) poser le remblai pour combler underPos (réf = floor, face = d → floor + d == underPos)
          if (!_refOk(bot, floor)) continue;             // #6 : le sol sous les pieds doit être plein
          await bot.equip(support, 'hand');
          await bot.placeBlock(floor, d);
          if (!(await _confirmPlaced(bot, underPos))) continue;   // #6 : remblai fantôme → stop
          // 2) poser la table sur le remblai fraîchement posé
          const sup = bot.blockAt(underPos);
          if (!_refOk(bot, sup)) continue;               // #6 : référence pleine obligatoire
          await bot.equip(item, 'hand');
          await bot.placeBlock(sup, new Vec3(0, 1, 0));
          if (!(await _confirmPlaced(bot, cellPos))) continue;    // #6 : pose fantôme → autre direction
          return { ok: true, pos: cellPos };
        } catch (e) { /* essaie la direction suivante */ }
      }
    }
  }

  // ── Pass 4 : poser CONTRE UNE PAROI (analyse run world_ax4, 26/07 : `no_table:no_space` ×71,
  // en tunnel de minage). Les passes 1-3 ne savent poser QUE sur un sol (`placeBlock(sol, +Y)`).
  // Or en jeu un bloc s'accroche à N'IMPORTE QUELLE face d'un voisin plein : dans un tunnel dont
  // le sol de la case voisine manque mais dont les murs sont pleins, un joueur pose contre le mur.
  // Pour remplir la case C, il suffit d'un voisin plein N et de la face (C − N).
  const SIDES = [
    new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1),
    new Vec3(0, 1, 0), new Vec3(0, -1, 0),
  ];
  for (const d of dirs) {
    const cellPos = base.plus(d);
    const cell = bot.blockAt(cellPos);
    if (!cell) continue;
    // la case doit être libre… ou occupée par un encombrement qu'on casse d'abord (cf. Pass 1b)
    const clutter = isBreakableClutter(cell);
    if (!clutter && !REPLACEABLE.has(cell.name)) continue;
    let cleared = !clutter;                                  // l'encombrement ne se casse QU'UNE fois
    for (const s of SIDES) {
      const refPos = cellPos.plus(s);
      const ref = bot.blockAt(refPos);
      if (!ref || ref.boundingBox !== 'block') continue;     // il faut une face pleine où s'accrocher
      if (!_refOk(bot, ref)) continue;
      if (!cleared) {                                        // on ne casse qu'une fois une PRISE trouvée
        try { await _breakClutter(bot, cell); cleared = true; } catch (e) { break; }   // cassage impossible → case suivante
      }
      try {
        await bot.equip(item, 'hand');
        await bot.placeBlock(ref, s.scaled(-1));             // ref + (−s) == cellPos
        if (!(await _confirmPlaced(bot, cellPos))) continue;
        return { ok: true, pos: cellPos };
      } catch (e) { /* face suivante */ }
    }
  }

  // reason INCHANGÉ ('no_space') ; `around`/`under` disent CE QUI bloque (diagnostic live).
  const diag = _surroundings(bot, base, dirs);
  return { ok: false, reason: 'no_space', around: diag.around, under: diag.under };
}

module.exports = { placeBlockNear, isBreakableClutter };
