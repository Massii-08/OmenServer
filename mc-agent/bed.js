'use strict';
// LIT — le point de réapparition qui n'est pas le spawn du monde (20/10).
//
// Mesure live : 17 morts sur 37 arrivent < 30 s après la réapparition, de NUIT, au point de
// réapparition — le spawn du monde, campé par les zombies. Les bots sont non-op (`/spawnpoint`
// refusé) : la seule façon « joueur » de déplacer la réapparition, c'est un LIT. Un vrai joueur
// (et AltoClef) en pose un dès la 1re nuit : on réapparaît dans SA base, et dormir fait passer
// la nuit (si tout le monde dort — playersSleepingPercentage vanilla = 100 %).
//
// Ce module est le CERVEAU PUR (aucun bot, aucune horloge en dur) ; le câblage vit dans index.js
// (ensureBedGoal, setSpawnAtBed, trySleepInBedTonight, onBedMessage).
//
// LAINE : on TUE des moutons (1 laine de sa couleur par mouton) plutôt que de les tondre. Les
// cisailles coûtent 2 lingots — or le lit est voulu AVANT la descente au fer (c'est la 1re nuit
// qui tue). La chasse existe déjà (skills/hunt.huntPassive), il suffit de la restreindre aux moutons.
// Recette (minecraft-data 1.21.4) : 3 laines de LA MÊME couleur + 3 planches de LA MÊME essence
// (13 recettes par couleur, une par essence — pas de « n'importe quelles planches » mélangées).

const WOOL_COLORS = Object.freeze([
  'white', 'light_gray', 'gray', 'black', 'brown', 'red', 'orange', 'yellow',
  'lime', 'green', 'cyan', 'light_blue', 'blue', 'purple', 'magenta', 'pink',
]);
const BED_WOOL = 3;
const BED_PLANKS = 3;
const BED_SLEEP_MAX_DIST = 16;            // au-delà on ne marche pas jusqu'au lit la nuit (on s'abrite sur place)
const BED_RETRY_MS = 10 * 60 * 1000;      // un lit raté (pas de mouton, craft/pose impossible) : on réessaie dans 10 min
const BED_SHEEP_SEEN_MS = 10 * 60 * 1000; // un mouton vu il y a < 10 min compte encore comme « connu »
const BED_SHEEP_KNOWN_DIST = 96;          // … s'il était à ≤ 96 blocs (la zone chargée, view-distance 6)
const BED_MEMO_KEY = 'bed';               // champ du mémo de base : { x, y, z, at }
const BED_RETRY_MEMO_KEY = 'bedRetryAt';  // champ du mémo de base : instant avant lequel on ne réessaie pas

const isBedName = (n) => typeof n === 'string' && n.endsWith('_bed');

/** Nom du premier lit en poche, ou null. */
function bedItemIn(inv) {
  const o = inv || {};
  return Object.keys(o).find((n) => isBedName(n) && (o[n] || 0) > 0) || null;
}

/** La couleur de laine la plus fournie : { color, count } (count 0 si aucune). */
function woolBest(inv) {
  const o = inv || {};
  let best = { color: null, count: 0 };
  for (const c of WOOL_COLORS) {
    const n = o[c + '_wool'] || 0;
    if (n > best.count) best = { color: c, count: n };
  }
  return best;
}

/** Le lit craftable avec la laine en poche (`white_bed`…), ou null s'il manque de la laine. */
function bedRecipeName(inv) {
  const w = woolBest(inv);
  return w.count >= BED_WOOL ? w.color + '_bed' : null;
}

/** Laines encore à récolter pour un lit (sur la meilleure couleur). */
function woolMissing(inv) {
  return Math.max(0, BED_WOOL - woolBest(inv).count);
}

/**
 * But `bed` de la chaîne : SATISFIABLE-OU-SAUTABLE (même patron que t1_sword / shield).
 * Satisfait si : un lit est déjà posé (mémo) ; un essai raté est en attente de nouvel essai ;
 * ou rien ne permet d'avancer — pas de lit en poche, pas assez de laine ET aucun mouton connu,
 * ou de la laine mais aucune essence ne peut fournir 3 planches.
 * c : { inv, bedPlaced, bedRetryLater, sheepNear, planksOk } — planksOk = plankable(inv, 3)
 * (injecté par l'appelant : la règle « une essence » vit dans planks.planksPlan).
 */
function bedGoalMet(c) {
  const o = c || {};
  if (o.bedPlaced) return true;
  if (o.bedRetryLater) return true;
  if (bedItemIn(o.inv)) return false;                 // un lit en poche : il reste à le poser
  if (bedRecipeName(o.inv)) return !o.planksOk;       // laine là : on craft si le bois suit
  return !o.sheepNear;                                // pas de laine : il faut un mouton en vue/connu
}

/** Mouton « connu » : vu maintenant, ou vu il y a < 10 min à ≤ 96 blocs de nous. */
function sheepKnown({ seenNow, last, pos, now } = {}) {
  if (seenNow) return true;
  if (!last || !pos || !Number.isFinite(last.at) || !Number.isFinite(now)) return false;
  if (now - last.at > BED_SHEEP_SEEN_MS || last.at > now) return false;
  return Math.hypot((last.x || 0) - pos.x, (last.z || 0) - pos.z) <= BED_SHEEP_KNOWN_DIST;
}

// ─── Mémo de base (survit aux morts et aux relances du self-healing) ────────────────────────────
// ⚠️ Toujours FUSIONNER (piège #73d : une écriture littérale effaçait dette de mort + zone).
function bedMemoWith(memo, pos, now) {
  const m = Object.assign({}, memo || {});
  m[BED_MEMO_KEY] = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), at: now };
  delete m[BED_RETRY_MEMO_KEY];
  return m;
}
function bedMemoCleared(memo) {
  const m = Object.assign({}, memo || {});
  delete m[BED_MEMO_KEY];
  return m;
}
function bedRetryMemo(memo, now, delayMs = BED_RETRY_MS) {
  return Object.assign({}, memo || {}, { [BED_RETRY_MEMO_KEY]: now + delayMs });
}
/** Lit mémorisé { x, y, z } ou null. */
function bedOf(memo) {
  const b = memo && memo[BED_MEMO_KEY];
  return (b && Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.z)) ? b : null;
}
/** Un nouvel essai est-il en attente ? Une date au-delà du délai max (mémo d'un autre monde) ne gèle rien. */
function bedRetryActive(memo, now) {
  const t = memo && memo[BED_RETRY_MEMO_KEY];
  return Number.isFinite(t) && t > now && t - now <= BED_RETRY_MS;
}

// ─── Pose ───────────────────────────────────────────────────────────────────────────────────────
// Un lit occupe DEUX cases : le pied (là où on clique) et la tête, dans la direction où regarde le
// joueur. On cherche donc, autour des pieds du bot, une direction cardinale d où la case à 1 bloc
// (pied) et celle à 2 blocs (tête) sont libres et posées sur du plein. Le bot regarde le pied pour
// cliquer → son cap pointe vers d → la tête tombe à 2 blocs, dans le prolongement.
const DIRS = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]]);
const FLUIDS = new Set(['water', 'flowing_water', 'lava', 'flowing_lava', 'bubble_column']);
const _free = (b) => !!b && b.boundingBox === 'empty' && !FLUIDS.has(b.name) && !isBedName(b.name);
const _solid = (b) => !!b && b.boundingBox === 'block';

/**
 * Places de lit possibles autour de `feet` (bloc des pieds, entier). blockAt(x,y,z) → bloc|null.
 * @returns {Array<{foot:{x,y,z}, head:{x,y,z}, ref:{x,y,z}, dir:[dx,dz]}>} ref = sol sous le pied (clic face haute)
 */
function bedSpotPlan(blockAt, feet) {
  const out = [];
  if (!feet || typeof blockAt !== 'function') return out;
  const fx = Math.floor(feet.x); const fy = Math.floor(feet.y); const fz = Math.floor(feet.z);
  for (const [dx, dz] of DIRS) {
    const foot = { x: fx + dx, y: fy, z: fz + dz };
    const head = { x: fx + 2 * dx, y: fy, z: fz + 2 * dz };
    const ok = _free(blockAt(foot.x, foot.y, foot.z)) && _free(blockAt(head.x, head.y, head.z))
      && _solid(blockAt(foot.x, fy - 1, foot.z)) && _solid(blockAt(head.x, fy - 1, head.z));
    if (ok) out.push({ foot, head, ref: { x: foot.x, y: fy - 1, z: foot.z }, dir: [dx, dz] });
  }
  return out;
}

// ─── Messages du serveur (Paper 1.21.4, client mineflayer en en_US) ─────────────────────────────
// Clés vanilla : block.minecraft.set_spawn, block.minecraft.spawn.not_valid,
// block.minecraft.bed.{not_safe,no_sleep,too_far_away,occupied,obstructed}. Le texte exact arrive
// par `messagestr` (chat système OU barre d'action) — ⚠️ à confirmer en live sur ce serveur.
const BED_MESSAGES = Object.freeze([
  ['spawn_set', /respawn point set/i],
  ['spawn_missing', /no home bed or charged respawn anchor|respawn anchor, or it was obstructed/i],
  ['monsters', /monsters nearby|not safe|may not rest now; there are monsters/i],
  ['too_far', /bed is too far away/i],
  ['occupied', /bed is occupied/i],
  ['obstructed', /bed is obstructed/i],
  ['day', /sleep only at night|can only sleep at night|sleep only during thunderstorms/i],
]);

/** Classe un message serveur lié au lit : 'spawn_set' | 'spawn_missing' | 'monsters' | 'too_far' |
 *  'occupied' | 'obstructed' | 'day' | null. Les messages de joueurs (`<X> …`) ne comptent jamais. */
function parseBedMessage(text) {
  const s = String(text || '').trim();
  if (!s || /^<[^>]+>/.test(s)) return null;
  for (const [kind, re] of BED_MESSAGES) if (re.test(s)) return kind;
  return null;
}

/** Erreur de `bot.sleep` → raison courte (mineflayer : « there are monsters nearby », « it's not night… »). */
function sleepErrorReason(err) {
  const s = String((err && err.message) || err || '');
  if (/monster/i.test(s)) return 'monsters';
  if (/not night|thunderstorm|day/i.test(s)) return 'day';
  if (/too far/i.test(s)) return 'too_far';
  if (/occupied/i.test(s)) return 'occupied';
  if (/not a bed|wrong block|bed/i.test(s)) return 'not_bed';
  return 'error';
}

/** La nuit, aller dormir plutôt que creuser un trou ? Lit connu, nuit CONNUE, à ≤ 16 blocs (3D). */
function sleepDecision({ bed, pos, night } = {}) {
  if (!bed) return { sleep: false, why: 'no_bed' };
  if (night !== true) return { sleep: false, why: 'not_night' };
  if (!pos) return { sleep: false, why: 'no_pos' };
  const d = Math.hypot(bed.x + 0.5 - pos.x, bed.y - pos.y, bed.z + 0.5 - pos.z);
  if (d > BED_SLEEP_MAX_DIST) return { sleep: false, why: 'too_far', dist: Math.round(d) };
  return { sleep: true, why: 'near', dist: Math.round(d) };
}

module.exports = {
  WOOL_COLORS, BED_WOOL, BED_PLANKS, BED_SLEEP_MAX_DIST, BED_RETRY_MS, BED_SHEEP_SEEN_MS, BED_SHEEP_KNOWN_DIST,
  BED_MEMO_KEY, BED_RETRY_MEMO_KEY,
  isBedName, bedItemIn, woolBest, bedRecipeName, woolMissing, bedGoalMet, sheepKnown,
  bedMemoWith, bedMemoCleared, bedRetryMemo, bedOf, bedRetryActive,
  bedSpotPlan, parseBedMessage, sleepErrorReason, sleepDecision,
};
