'use strict';
// NUIT AU TRAVAIL (Massii 21/10 : « ils mettent trop de temps pour faire l'armure : analyse ce que font
// les joueurs normaux et fais qu'ils fassent la même chose »).
//
// Mesure (run de zéro du 21/10, NethBot3 : zéro → 4 pièces de fer en 53 min) : `logs` 17,4 min dont
// l'essentiel en abri de nuit (38 events `shelter`, night_hold, dawn_hold). Le bot nu creusait un trou
// de 3, posait un toit et ATTENDAIT l'aube. Un joueur ne fait pas ça : la nuit il descend en escalier,
// rebouche derrière lui, pose une torche et mine — la nuit ne change rien sous terre, il y fait noir de
// toute façon. Le planner savait déjà travailler sous y < 45 (caution.nightPlannerStep) ; il manquait
// la DESCENTE et le SCEAU. Ici, les décisions PURES ; le câblage vit dans index.js (holdForNight).

const { NIGHT_UNDERGROUND_Y, NIGHT_SURFACE_SKILLS } = require('./caution');

// Profondeur visée sous la surface : 12 blocs de roche au-dessus de la tête = aucun mob de surface ne
// vous entend, et c'est ~12 paliers d'escalier (≈ 30 s). Atteindre y < 45 suffit aussi (même frontière
// que tout le code de nuit) : on s'arrête au PREMIER des deux.
const NIGHT_WORK_DEPTH = 12;
// Une fois descendu, le bot reste « sous terre » tant qu'il ne remonte pas à moins de 8 blocs de la
// surface relevée (le minage le fait bouger de quelques blocs en hauteur).
const NIGHT_WORK_SLACK = 8;
// Garde-fou : un état de nuit plus vieux que ça ne compte plus (une nuit MC ≈ 8,7 min + aube).
const NIGHT_WORK_TTL_MS = 15 * 60 * 1000;
// Un hostile plus près que ça au moment de descendre → on fuit d'abord (fleeBeforeHide).
const NIGHT_WORK_FLEE_DIST = 8;
// Buts DIFFÉRÉS jusqu'à l'aube quand le bot travaille sous terre de nuit : ceux qui le ramènent à la
// surface (bois, chasse, pioche par expédition, livraison) + le lit (il faut un mouton et sa base).
const NIGHT_DEFER_SKILLS = new Set([...NIGHT_SURFACE_SKILLS, 'ensureBed']);

/** PUR — altitude visée par la descente de nuit, depuis la surface relevée. */
function nightWorkTargetY(surfaceY) {
  const s = Math.floor(Number(surfaceY));
  return Math.max(NIGHT_UNDERGROUND_Y - 1, s - NIGHT_WORK_DEPTH);
}

/**
 * PUR — que faire, à la tombée de la nuit, d'un bot nu en surface ?
 * sig = { y, hasPick, inWater, hostileDist (null = aucun), isMapper, isLumberjack, triedThisNight }
 * → { action: 'descend', targetY, surfaceY } : descendre en escalier, sceller, reprendre la chaîne ;
 *   { action: 'flee' }                       : un hostile tout près — fuir d'abord, puis re-décider ;
 *   { action: 'shelter', why }               : le comportement historique (trou couvert + attente).
 */
function nightWorkPlan(sig = {}) {
  const s = sig || {};
  if (s.isMapper) return { action: 'shelter', why: 'mapper' };            // il ne mine pas
  if (s.isLumberjack) return { action: 'shelter', why: 'lumberjack' };    // tout son travail est en surface
  if (!s.hasPick) return { action: 'shelter', why: 'no_pick' };           // tout début : trou + attente
  if (s.triedThisNight) return { action: 'shelter', why: 'tried' };       // une descente ratée par nuit, pas plus
  if (s.inWater) return { action: 'shelter', why: 'water' };
  // DEPUIS L'ABRI (22/10, `fromShelter`) : le bot est au fond de son puits, toit posé. Seul un PUITS
  // creusé ('pit') se quitte par le bas sans rien ouvrir ; une cellule MURÉE au sol (l'escalier
  // percerait la paroi posée, en pleine nuit) garde l'abri. Les hostiles de surface ne comptent plus :
  // ils sont au-dessus du toit, l'escalier s'en ÉLOIGNE (fuir = ressortir dehors, le contraire du but).
  if (s.fromShelter && s.cellMode !== 'pit') return { action: 'shelter', why: 'walled' };
  const y = s.y;
  if (!(typeof y === 'number' && Number.isFinite(y))) return { action: 'shelter', why: 'no_y' };
  const d = Number(s.hostileDist);
  if (!s.fromShelter && s.hostileDist != null && Number.isFinite(d) && d <= NIGHT_WORK_FLEE_DIST) return { action: 'flee' };
  // La SURFACE de référence : relevée au-dessus du puits (`surfaceY`) quand on part du fond de l'abri,
  // sinon l'altitude du bot (il est en surface).
  const sy = Number(s.surfaceY);
  const surface = (s.surfaceY != null && Number.isFinite(sy)) ? sy : y;
  const targetY = nightWorkTargetY(surface);
  if (y < NIGHT_UNDERGROUND_Y || !(targetY < y - 1)) return { action: 'shelter', why: 'already_low' };
  return { action: 'descend', targetY, surfaceY: Math.floor(surface) };
}

// ─── CRAFTER DANS LE TROU (22/10) ────────────────────────────────────────────────────────────────
// Chrono « zéro → armure de fer » (3 ouvriers) : la nuit tombe ~5 min après le départ, les bots ont des
// bûches mais pas encore de pioche → `night_hold` de la minute 5 à 14, puis les outils en 5 min. Un
// joueur, dans son trou fermé, FABRIQUE avec ce qu'il a : planches, bâtons, table (posée dans la paroi),
// pioche en bois — puis il creuse vers le bas. Ici : le prochain craft, une étape à la fois.
// Recettes 3×3 (table posée nécessaire) : seulement dans un PUITS creusé — la table s'y pose dans la
// paroi de terre (placeBlockNear pass 2) ; dans une cellule murée au sol, creuser la paroi l'ouvrirait.
const SHELTER_CRAFT_3X3 = new Set(['wooden_pickaxe', 'stone_pickaxe', 'stone_sword', 'furnace']);
const SHELTER_TORCH_TARGET = 16;

function _cnt(inv, re) {
  let n = 0;
  for (const i of inv || []) if (i && typeof i.name === 'string' && re.test(i.name)) n += Number(i.count) || 0;
  return n;
}

/**
 * PUR — le prochain craft à faire DANS l'abri, avec la seule poche. → { name, count } | null.
 * inv = [{name,count}] ; ctx = { cellMode: 'pit'|'walled', skip: Set|Array des noms ratés cet abri }.
 * Ordre : (sans pioche) planches → table → bâtons → pioche en bois ; (avec pioche) pioche pierre si la
 * meilleure est en bois, épée pierre, four, torches — chacun seulement si la matière est EN POCHE.
 * Rien qui demande de sortir : pas de bûche à couper, pas de cobble à miner.
 */
function shelterCraftNext(inv, ctx = {}) {
  const c = ctx || {};
  const skip = c.skip instanceof Set ? c.skip : new Set(Array.isArray(c.skip) ? c.skip : []);
  const big = c.cellMode === 'pit';
  const ok = (name) => !skip.has(name) && (big || !SHELTER_CRAFT_3X3.has(name));
  const planks = _cnt(inv, /_planks$/);
  const logs = _cnt(inv, /_log$/);
  const sticks = _cnt(inv, /^stick$/);
  const hasTable = _cnt(inv, /^crafting_table$/) > 0;
  const picks = (inv || []).filter((i) => i && /_pickaxe$/.test(i.name) && (Number(i.count) || 0) > 0);
  const cobble = _cnt(inv, /^(cobblestone|cobbled_deepslate|blackstone)$/);
  const logItem = () => {
    let best = null;
    for (const i of inv || []) if (i && /_log$/.test(i.name) && (!best || (i.count || 0) > (best.count || 0))) best = i;
    return best;
  };
  // Planches à fabriquer pour couvrir `need` (en crafts de 4), si des bûches sont en poche.
  const planksFor = (need) => {
    if (planks >= need || logs <= 0) return null;
    const lg = logItem();
    if (!lg) return null;
    const name = lg.name.replace(/_log$/, '_planks');
    if (!ok(name)) return null;
    return { name, count: Math.min(logs, Math.ceil((need - planks) / 4)) };
  };

  if (!picks.length) {
    if (!ok('wooden_pickaxe')) return null;
    const needTable = !hasTable;
    const needSticks = sticks < 2;
    const need = (needTable ? 4 : 0) + 3 + (needSticks ? 2 : 0);
    if (planks + 4 * logs < need) return null;                 // pas de quoi aller au bout : rien d'inutile
    if (planks < need) return planksFor(need);                 // planches d'abord (null : bûches ratées)
    if (needTable && ok('crafting_table')) return { name: 'crafting_table', count: 1 };
    if (needTable) return null;
    if (needSticks && ok('stick')) return { name: 'stick', count: 1 };
    if (needSticks) return null;
    return { name: 'wooden_pickaxe', count: 1 };
  }

  // Avec une pioche : ce que la poche permet encore, sans rien aller chercher.
  const onlyWood = picks.every((i) => i.name === 'wooden_pickaxe');
  const hasSword = (inv || []).some((i) => i && /_sword$/.test(i.name));
  const hasFurnace = _cnt(inv, /^furnace$/) > 0;
  const coal = _cnt(inv, /^(coal|charcoal)$/);
  const torches = _cnt(inv, /^torch$/);
  const wood = planks + 4 * logs;
  const tableOk = hasTable;
  const stickStep = (n) => {
    if (sticks >= n) return null;
    if (!ok('stick')) return 'stop';
    if (planks >= 2) return { name: 'stick', count: 1 };
    const pl = planksFor(2);
    return pl || 'stop';
  };
  const wants = [];
  if (onlyWood && cobble >= 3 && tableOk) wants.push({ name: 'stone_pickaxe', sticks: 2, wood: 2 });
  if (!hasSword && cobble >= (onlyWood && wants.length ? 5 : 2) && tableOk) wants.push({ name: 'stone_sword', sticks: 1, wood: 2 });
  if (!hasFurnace && cobble >= 8 && tableOk) wants.push({ name: 'furnace', sticks: 0, wood: 0 });
  if (coal >= 1 && torches < SHELTER_TORCH_TARGET) wants.push({ name: 'torch', sticks: 1, wood: 2 });
  for (const w of wants) {
    if (!ok(w.name)) continue;
    if (w.sticks > 0 && sticks < w.sticks && wood < w.wood) continue;   // pas de bois pour les bâtons
    const st = stickStep(w.sticks);
    if (st === 'stop') continue;
    if (st) return st;
    return { name: w.name, count: 1 };
  }
  return null;
}

/**
 * PUR — le bot travaille-t-il « sous terre » cette nuit ? y < 45 (règle historique), OU descendu par la
 * nuit au travail (même nuit, état frais) et encore à NIGHT_WORK_SLACK blocs ou plus sous la surface.
 * state = { surfaceY, night, at } | null ; sig = { y, night, now }.
 */
function nightUnderground(state, sig = {}) {
  const y = sig && sig.y;
  if (!(typeof y === 'number' && Number.isFinite(y))) return false;
  if (y < NIGHT_UNDERGROUND_Y) return true;
  if (!state || state.surfaceY == null) return false;
  if (state.night !== (sig.night != null ? sig.night : null)) return false;
  const now = Number(sig.now) || 0;
  if (now - (Number(state.at) || 0) > NIGHT_WORK_TTL_MS) return false;
  return y <= Number(state.surfaceY) - NIGHT_WORK_SLACK;
}

/** PUR — ce but est-il différé à l'aube (nuit au travail, sous terre, but de surface) ? */
function nightDeferGoal({ lockdown, underground, skill } = {}) {
  return !!(lockdown && underground && NIGHT_DEFER_SKILLS.has(skill));
}

/**
 * PUR — cases à BOUCHER autour du bot une fois en bas : toute case vide à hauteur des pieds et de la
 * tête dans les 4 directions, plus celle au-dessus de la tête. Après un escalier, c'est la marche
 * d'où l'on vient (et sa tête) ; dans une grotte, c'est un mur de fortune. `isOpen(cell)` → bool.
 * Les cases sous les pieds ne sont jamais bouchées (on y est debout).
 */
function nightSealCells(feet, isOpen) {
  if (!feet || typeof isOpen !== 'function') return [];
  const fx = Math.floor(feet.x), fy = Math.floor(feet.y), fz = Math.floor(feet.z);
  const out = [];
  const add = (x, y, z) => { try { if (isOpen({ x, y, z })) out.push({ x, y, z }); } catch (e) { /* illisible → laissé */ } };
  for (const dy of [1, 0]) {                       // la tête d'abord : c'est par là qu'on est arrivé
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) add(fx + dx, fy + dy, fz + dz);
  }
  add(fx, fy + 2, fz);
  return out;
}

module.exports = {
  NIGHT_WORK_DEPTH, NIGHT_WORK_SLACK, NIGHT_WORK_TTL_MS, NIGHT_WORK_FLEE_DIST, NIGHT_DEFER_SKILLS,
  nightWorkTargetY, nightWorkPlan, nightUnderground, nightDeferGoal, nightSealCells,
  shelterCraftNext, SHELTER_CRAFT_3X3, SHELTER_TORCH_TARGET,
};
