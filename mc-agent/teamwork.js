'use strict';
// ENTRAIDE D'ÉQUIPE (demande Massii 25/07) : « il faut qu'ils s'aident entre eux, et quand ils
// ont l'armure fer ils se séparent ».
//
// Le cas qui l'a motivé, mesuré en direct sur world_ax4 : NethBot2 portait 3 pièces d'armure et
// gardait **6 lingots d'avance** pendant que NethBot3, à 50 blocs de là, n'avait RIEN et
// rebouclait sur le bootstrap bois. Le fer dormait dans la mauvaise poche.
//
// Deux décisions PURES ici ; l'exécution (marcher jusqu'au coéquipier, `tossStack`) vit dans
// index.js — même séparation que mapperTp/regroup.

const PIECES = ['helmet', 'chestplate', 'leggings', 'boots'];
const INGOTS_PER_PIECE = { helmet: 5, chestplate: 8, leggings: 7, boots: 4 };

/**
 * PUR — mon état d'équipe, publié dans le heartbeat de présence pour que les autres décident.
 * @param {Object} inv  {nom: nombre} (poche)
 * @param {Array<string>} worn  noms des pièces portées (slots 5-8)
 * @returns {{armor:number, ingots:number, need:number}} armor = pièces fer acquises (0-4)
 */
function teamStatus(inv, worn) {
  const i = inv || {};
  const w = new Set(worn || []);
  let armor = 0;
  for (const p of PIECES) {
    const name = `iron_${p}`;
    if (w.has(name) || (i[name] || 0) > 0) armor += 1;
  }
  const ingots = i.iron_ingot || 0;
  // Lingots encore nécessaires pour compléter MON armure (les pièces manquantes uniquement).
  let need = 0;
  for (const p of PIECES) {
    const name = `iron_${p}`;
    if (!w.has(name) && !(i[name] || 0)) need += INGOTS_PER_PIECE[p];
  }
  return { armor, ingots, need };
}

const MIN_GIFT = 3;        // en dessous, le déplacement ne vaut pas le don
const AID_RANGE = 64;      // blocs — au-delà, on ne traverse pas la carte pour donner
const FRESH_MS = 180000;   // présence périmée = coéquipier mort/déco

function _d(ax, az, bx, bz) { return Math.hypot(ax - bx, az - bz); }

/**
 * PUR — dois-je donner des lingots, et à qui ? null si rien à faire.
 *
 * Règle : je ne donne que mon SURPLUS (ce dont je n'ai pas besoin pour finir ma propre armure —
 * on ne se sabote pas pour aider), au coéquipier PROCHE le moins équipé qui en a besoin.
 * À égalité d'armure, le plus proche gagne.
 *
 * @returns {{to:string, amount:number}|null}
 */
function pickDonation({ self, selfName, selfStatus, mates, now, opts = {} } = {}) {
  if (!self || !selfStatus) return null;
  const t = now || Date.now();
  const range = opts.range || AID_RANGE;
  const minGift = opts.minGift || MIN_GIFT;
  // reserve : lingots EARMARKÉS que le don ne doit pas toucher. Sert au worker qui assemble un set
  // d'armure de cartographe (GIFT_SET_INGOTS) : sans lui, un done-worker (need=0) voit TOUT son fer
  // compté en surplus, et le team_gift périodique le vide vers les stragglers avant qu'il n'ait pu
  // réunir les 24 lingots → mappeurs jamais armés (world_mn12, 28/07 : 21 lingots drainés depuis
  // mapper_armor, 0 set livré). Le straggler wood-softlock ne peut de toute façon PAS forger l'armure
  // qu'on lui donne (pas de table sans bois), donc earmarker pour le mappeur est strictement mieux.
  const reserve = Math.max(0, opts.reserve || 0);
  const surplus = (selfStatus.ingots || 0) - (selfStatus.need || 0) - reserve;
  if (surplus < minGift) return null;                       // rien à donner sans se pénaliser

  const cands = (mates || []).filter((m) => m
    && m.name && m.name !== selfName
    && m.role !== 'mapper'                                   // les cartographes ne montent pas d'armure
    && typeof m.x === 'number' && typeof m.z === 'number'
    && (t - (m.at || 0)) <= (opts.freshMs || FRESH_MS)
    && (m.armor === undefined || m.armor < 4)                // déjà équipé → il n'a besoin de rien
    && _d(m.x, m.z, self.x, self.z) <= range);
  if (!cands.length) return null;

  let best = null, bestKey = null;
  for (const m of cands) {
    const armor = m.armor === undefined ? 0 : m.armor;
    const d = _d(m.x, m.z, self.x, self.z);
    const key = [armor, d];                                  // moins équipé d'abord, puis plus proche
    if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
      best = m; bestKey = key;
    }
  }
  if (!best) return null;
  // On ne donne pas plus que ce dont il a besoin (le reste servira à quelqu'un d'autre).
  const wants = best.need === undefined ? surplus : Math.max(0, best.need);
  const amount = Math.min(surplus, wants);
  if (amount < minGift) return null;
  return { to: best.name, amount };
}

/**
 * PUR — toute l'équipe est-elle équipée ? (⇒ fin de la phase groupée, chacun repart de son côté)
 * Un coéquipier dont le statut est inconnu est considéré NON équipé : on ne se sépare pas
 * sur une supposition.
 */
function allArmored(selfStatus, mates, opts = {}) {
  if (!selfStatus || (selfStatus.armor || 0) < 4) return false;
  const t = opts.now || Date.now();
  const workers = (mates || []).filter((m) => m && m.role !== 'mapper' && m.name
    && (t - (m.at || 0)) <= (opts.freshMs || FRESH_MS));
  return workers.every((m) => (m.armor || 0) >= 4);
}

// ── DÉFENSE MUTUELLE (Massii 25/07 : « il faut aussi qu'ils s'aident contre les mobs ») ──────
// Ici la présence partagée (heartbeat 60 s) est INUTILISABLE : un combat dure quelques secondes.
// On raisonne donc sur la PERCEPTION LOCALE — le bot voit les joueurs et les mobs autour de lui.

const ASSIST_RANGE = 20;      // blocs — au-delà, j'arrive après la bataille
const THREAT_RADIUS = 5;      // un mob à ≤5 blocs d'un coéquipier l'agresse vraiment
const ASSIST_MIN_HEALTH = 12; // en dessous, je me sauve MOI (on ne meurt pas à deux)

/**
 * PUR — quel mob attaquer pour secourir un coéquipier ? null si rien à faire.
 *
 * Priorités : (1) je ne pars pas au secours si je suis moi-même en danger — deux morts valent
 * moins qu'une ; (2) le mob doit MENACER quelqu'un (≤THREAT_RADIUS d'un coéquipier), pas juste
 * traîner ; (3) à égalité, le plus proche de MOI (j'arrive plus vite, j'encaisse moins).
 *
 * @param {{self:{x,z,health}, mates:Array<{name,x,z}>, hostiles:Array<{name,x,z,id}>,
 *          isFleeOnly?:function, opts?:object}} p
 * @returns {{mob:Object, mate:string, dist:number}|null}
 */
function pickMobAssist({ self, mates, hostiles, isFleeOnly, opts = {} } = {}) {
  if (!self || typeof self.x !== 'number') return null;
  const minHp = opts.minHealth === undefined ? ASSIST_MIN_HEALTH : opts.minHealth;
  if (typeof self.health === 'number' && self.health < minHp) return null;   // je me soigne d'abord
  const range = opts.range || ASSIST_RANGE;
  const threatR = opts.threatRadius || THREAT_RADIUS;
  const fleeOnly = isFleeOnly || (() => false);

  let best = null;
  for (const m of (hostiles || [])) {
    if (!m || typeof m.x !== 'number') continue;
    if (fleeOnly(m.name)) continue;                       // mob qu'on FUIT : on n'y envoie personne
    const dMe = Math.hypot(m.x - self.x, m.z - self.z);
    if (dMe > range) continue;                            // trop loin pour arriver à temps
    // Menace-t-il un coéquipier ? (et pas moi : mes propres réflexes s'en chargent déjà)
    let victim = null, dVictim = Infinity;
    for (const mate of (mates || [])) {
      if (!mate || typeof mate.x !== 'number') continue;
      const d = Math.hypot(m.x - mate.x, m.z - mate.z);
      if (d <= threatR && d < dVictim) { victim = mate.name; dVictim = d; }
    }
    if (!victim) continue;
    if (!best || dMe < best.dist) best = { mob: m, mate: victim, dist: Math.round(dMe) };
  }
  return best;
}

// ── ARMURER LES CARTOGRAPHES (Massii 26/07) ─────────────────────────────────────────────────────
// « il faut que les bots ressources se coordonnent pour préparer une armure pour chacun et après
// il se tp au mappeur pour lui donner, comme ça les mappeurs continuent sans jamais s'arrêter ».
//
// C'est l'INVERSE de la règle de pickDonation, qui écarte les mappeurs (« les cartographes ne
// montent pas d'armure ») : eux ne minent pas, donc ils meurent nus et n'osent pas s'éloigner.
// Un mappeur qui survit est un mappeur qui cartographie plus loin — d'où la priorité de Massii :
// habiller les mappeurs AVANT de passer au diamant.
//
// Trois différences de fond avec le don de lingots entre workers :
//  - AUCUNE limite de distance : le worker rejoint le mappeur en /tpa (c'est tout l'intérêt —
//    le mappeur ne se déplace pas et ne s'arrête donc jamais) ;
//  - on livre des PIÈCES déjà forgées, pas des lingots : un mappeur n'a ni four ni table ;
//  - la cible est RÉSERVÉE (claims) pour que 5 workers n'habillent pas le même mappeur.

const SET_INGOTS = 24;   // 5 + 8 + 7 + 4 — coût d'un set fer complet

/**
 * PUR — à quel cartographe dois-je porter une armure ? null si rien à faire.
 *
 * Garde-fou : je ne pars équiper personne tant que MA propre armure est incomplète (même règle
 * que pickDonation — on ne se sabote pas pour aider). Choix : le moins équipé d'abord, puis, à
 * égalité, le nom le plus petit — critère DÉTERMINISTE (comme squadLeader) pour que deux workers
 * qui décident au même instant ne convergent pas sur la même cible avant même de la réserver.
 *
 * @param {{selfName:string, selfStatus:{armor:number}, mates:Array, claimed?:Set<string>|Array,
 *          now?:number, opts?:object}} p
 * @returns {{to:string, armor:number}|null}
 */
function pickMapperToEquip({ selfName, selfStatus, mates, claimed, now, opts = {} } = {}) {
  if (!selfStatus || (selfStatus.armor || 0) < 4) return null;   // je m'équipe MOI d'abord
  const t = now || Date.now();
  const freshMs = opts.freshMs || FRESH_MS;
  const taken = claimed instanceof Set ? claimed : new Set(claimed || []);
  const cands = (mates || []).filter((m) => m
    && m.name && m.name !== selfName
    && m.role === 'mapper'
    && (t - (m.at || 0)) <= freshMs                    // présence périmée = mort/déconnecté
    && (m.armor === undefined ? 0 : m.armor) < 4       // statut inconnu = considéré NU (on n'abandonne pas sur une supposition)
    && !taken.has(m.name));
  if (!cands.length) return null;
  let best = null;
  for (const m of cands) {
    const armor = m.armor === undefined ? 0 : m.armor;
    if (!best || armor < best.armor || (armor === best.armor && m.name < best.to)) {
      best = { to: m.name, armor };
    }
  }
  return best;
}

/**
 * PUR — que me manque-t-il pour offrir un set fer COMPLET ?
 *
 * `items` = la POCHE uniquement (bot.inventory.items() n'inclut pas les slots d'armure portés,
 * cf. #47) : une pièce en poche est donc bien du surplus livrable, jamais celle que je porte.
 *
 * @param {Array<{name:string,count:number}>} items
 * @returns {{ready:boolean, have:string[], missing:string[], ingots:number, ingotsShort:number}}
 */
function giftSetPlan(items) {
  const cnt = (n) => (items || []).filter((i) => i && i.name === n)
    .reduce((a, i) => a + (i.count || 0), 0);
  const have = [], missing = [];
  let ingotsShort = 0;
  for (const p of PIECES) {
    const name = `iron_${p}`;
    if (cnt(name) > 0) have.push(name);
    else { missing.push(name); ingotsShort += INGOTS_PER_PIECE[p]; }
  }
  const ingots = cnt('iron_ingot');
  return {
    ready: missing.length === 0,
    have, missing, ingots,
    ingotsShort: Math.max(0, ingotsShort - ingots),   // lingots encore À MINER
  };
}

/**
 * PUR — tous les cartographes FRAIS sont-ils équipés ? (⇒ feu vert pour la phase diamant)
 * Un mappeur au statut inconnu compte comme NON équipé : on ne passe pas au diamant sur une
 * supposition. Aucun mappeur connu ⇒ true (rien à attendre).
 */
function allMappersArmored(mates, opts = {}) {
  const t = opts.now || Date.now();
  const mappers = (mates || []).filter((m) => m && m.name && m.role === 'mapper'
    && (t - (m.at || 0)) <= (opts.freshMs || FRESH_MS));
  return mappers.every((m) => (m.armor || 0) >= 4);
}

module.exports = {
  teamStatus, pickDonation, allArmored, pickMobAssist,
  pickMapperToEquip, giftSetPlan, allMappersArmored,
  PIECES, INGOTS_PER_PIECE, MIN_GIFT, AID_RANGE, ASSIST_RANGE, THREAT_RADIUS, ASSIST_MIN_HEALTH,
  SET_INGOTS,
};
