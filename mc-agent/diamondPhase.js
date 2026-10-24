'use strict';
// ─── PHASE DIAMANT : L'OBJECTIF D'UN MINEUR SOUS LE CLIQUET (24/10 soir) ─────────────────────────
// Vécu (world 943e2c, 1 h sans un diamant de plus — NethBot2 28, NethBot3 18, NethBot1 2) : le cliquet
// d'équipe était posé (`teamLatch` dans les 3 mémos base) mais AUCUN mineur n'était sur `diamond`.
//   - Le backend relance chaque mort avec l'objectif de LANCEMENT (`rs.objective` = iron_armor,
//     mc_agent_manager._do_respawn → start_for_bot) dans un world.json neuf : au respawn, le bot
//     repartait sur iron_armor (world-576/577.json), quoi que dise le cliquet.
//   - L'armure s'use vite en Hard et une pièce quasi cassée ne compte plus comme portée
//     (gear.isNearlyBroken / _wornArmor) : iron_armor ne « finissait » donc jamais → jamais de
//     chainAfterDone → jamais de retour au diamant.
// Règle (Massii) : sous le cliquet, un mineur mine du diamant. Il répare son armure EN MINANT (le
// branch-mine diamant ramasse le fer qu'il croise, les timers de fonte/forge tournent sur `diamond`).
// Seul un mineur VRAIMENT nu (≤ 1 pièce portée) fait un détour fer BORNÉ (chaîne iron_armor =
// branch-mine Y16, pas de récolte de surface), puis revient au diamant, détour fini ou non.
// PUR : aucune dépendance au bot, horloge injectée.

const NAKED_MAX_WORN = 1;                       // ≤ 1 pièce portée = vraiment nu
const IRON_DETOUR_MS = 20 * 60 * 1000;          // durée max d'un détour fer
const IRON_DETOUR_COOLDOWN_MS = 40 * 60 * 1000; // après un détour : 40 min au diamant avant le suivant
// Objectifs de la filière armure qu'un mineur ne garde pas sous le cliquet.
const LATCH_REWRITE = new Set(['iron_armor', 'iron_help']);
// mapper_armor : réécrit au RESPAWN seulement — en cours de process il vient d'un vrai détournement
// (teamPhaseTick → cartographe nu réservé, ou chainAfterDone avec cible réservée).
const LATCH_REWRITE_AT_SPAWN = new Set(['mapper_armor']);

/**
 * Objectif d'un MINEUR sous le cliquet diamant. null = pas concerné (pas de cliquet, cartographe,
 * objectif hors filière : lumberjack, resource…), l'appelant garde son chemin historique.
 * @param {object} o objective, latched, isMapper, worn (pièces fer+ PORTÉES, usées exclues),
 *   detourAt (début du dernier détour fer, ms|null), now, fromSpawn (démarrage au respawn).
 * @returns {null|{objective:string, detourAt:number|null, why:string}}
 */
function latchedMinerObjective({ objective, latched, isMapper, worn, detourAt, now, fromSpawn } = {}) {
  if (!latched || isMapper) return null;
  const t = Number.isFinite(now) ? now : Date.now();
  const concerned = objective === 'diamond' || LATCH_REWRITE.has(objective)
    || (!!fromSpawn && LATCH_REWRITE_AT_SPAWN.has(objective));
  if (!concerned) return null;
  // Date du FUTUR (mémo hérité d'une autre horloge) ou illisible = pas de détour connu.
  let at = (Number.isFinite(detourAt) && detourAt <= t) ? detourAt : null;
  if (at !== null && t - at >= IRON_DETOUR_MS + IRON_DETOUR_COOLDOWN_MS) at = null;   // cycle révolu
  const naked = !(Number(worn) > NAKED_MAX_WORN);
  const active = at !== null && t - at < IRON_DETOUR_MS;
  if (naked && (active || at === null)) {
    return { objective: 'iron_armor', detourAt: active ? at : t, why: 'naked_detour' };
  }
  return { objective: 'diamond', detourAt: at, why: naked ? 'detour_spent' : 'latched' };
}

// ─── RÉCOLTE DE FER INTROUVABLE → BRANCH-MINE ────────────────────────────────────────────────────
// Vécu NethBot3 (objectif diamond, 18 💎, pioche fer cassée, y = -53) : le but `iron_ore` de la chaîne
// (gather explore:true) rendait `not_found` ×21 en 10 min — explore vers une forêt de bouleaux en
// surface, 0 waypoint, retry 90 s, à vie. Avec l'anti-xray, le fer d'une galerie n'est pas « visible »
// avant d'être creusé : un joueur creuserait. ≥ 3 not_found en 10 min → branch-mine (descente à Y16
// d'abord si le bot est plus haut), jamais une 4e récolte de surface.
const IRON_GATHER_WINDOW_MS = 10 * 60 * 1000;
const IRON_GATHER_MAX_NOTFOUND = 3;
const IRON_ORE_NAMES = new Set(['iron_ore', 'deepslate_iron_ore']);
const IRON_BRANCH_Y = 16;

/** Le but est-il une récolte (gather) de minerai de fer ? */
function isIronOreGather(goal) {
  if (!goal || goal.skill !== 'gather' || !goal.args) return false;
  const n = goal.args.name;
  const names = Array.isArray(n) ? n : [n];
  return names.some((x) => IRON_ORE_NAMES.has(x));
}

/** Échecs `not_found` de la fenêtre (copie élaguée) + celui de `now` si `add`. */
function noteIronGatherFail(times, now, add = true) {
  const t = Number.isFinite(now) ? now : Date.now();
  const kept = (Array.isArray(times) ? times : [])
    .filter((x) => Number.isFinite(x) && x <= t && t - x < IRON_GATHER_WINDOW_MS);
  if (add) kept.push(t);
  return kept;
}

/**
 * Plan de récolte du fer. null = récolte normale (gather) ; sinon branch-mine, précédé d'une
 * descente si le bot est au-dessus de la strate.
 * @returns {null|{action:'branch'|'descend_then_branch', fails:number, descendArgs?:object, branchArgs:object}}
 */
function ironGatherPlan({ times, now, y } = {}) {
  const fails = noteIronGatherFail(times, now, false).length;
  if (fails < IRON_GATHER_MAX_NOTFOUND) return null;
  const branchArgs = { targetY: IRON_BRANCH_Y, mainLength: 48, branchSpacing: 3, branchLength: 8,
    serpentine: true, allowDeeper: true };
  const high = !Number.isFinite(y) || y > IRON_BRANCH_Y + 2;
  return high
    ? { action: 'descend_then_branch', fails, descendArgs: { targetY: IRON_BRANCH_Y }, branchArgs }
    : { action: 'branch', fails, branchArgs };
}

module.exports = {
  latchedMinerObjective, isIronOreGather, noteIronGatherFail, ironGatherPlan,
  NAKED_MAX_WORN, IRON_DETOUR_MS, IRON_DETOUR_COOLDOWN_MS, LATCH_REWRITE, LATCH_REWRITE_AT_SPAWN,
  IRON_GATHER_WINDOW_MS, IRON_GATHER_MAX_NOTFOUND, IRON_BRANCH_Y,
};
