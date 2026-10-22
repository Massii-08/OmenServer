'use strict';
// Couche de WARP LÉGITIME — run « warps joueur » 2026-07-13 (demande Massii).
//
// En mode SANS-GIVE (nogive.js), les warps ADMIN historiques (/tp @s, /spreadplayers) sont
// BLOQUÉS par le filtre isForbiddenCheat → les bots mouraient sans issue (noyade/essaim sans
// échappatoire, retours au chantier impossibles). On les remplace par des commandes JOUEUR
// Essentials LÉGITIMES : /sethome + /home (elles n'équipent, ne soignent ni ne téléportent
// « par magie serveur » un item — ce sont de vraies commandes joueur).
//
// ⚠️ /spawn N'EXISTE PAS sur ce serveur (module EssentialsSpawn absent, testé live : « Unknown
//   command »). Donc « aller au spawn sûr » = /home safe, un home posé en SURFACE au boot du bot.
//   Le serveur doit donner à ces comptes la permission essentials.home/sethome (op ou perms
//   plugin) — nogive.js reste la vraie frontière de sécurité (il bloque /give //tp //effect même
//   si le bot est op).
//
// Primitives « signet » :
//   bookmark(bot, name) → /sethome <name>   (Essentials écrase l'home du même nom → re-sethome = replacer)
//   goHome(bot, name)   → /home <name>
//   goSpawn(bot)        → /home safe         (repli sur LA base, cf. /spawn absent)
//   goWork(bot)         → /home work         (retour au chantier après une excursion)
//   delhome(bot, name)  → /delhome <name>    (libère un slot — la limite serveur est de 3)
//   ⚠️ Un /home safe consulte d'abord le veto du home CAMPÉ (bot._mcaSafeVeto, cf. goHome) : seul ce
//   module envoie des /home, c'est le point d'entrée unique (test de câblage dans index.homesafety.test.js).
//
// ⚠️ SEULEMENT 3 NOMS (safe/work/death, cf. homes.js) : le serveur limite à 3 homes et le 4ᵉ
// `/sethome` échoue EN SILENCE. C'est le bug prouvé sur world_mn5 (un bot sans home `safe` = filet
// anti-noyade mort). `canchor`/`wsite` sont retirés : `safe` EST l'ancre, `work` EST le chantier.

const { isForbiddenCheat } = require('./nogive');
const { HOMES, HOME_SAFE, HOME_WORK, HOME_DEATH } = require('./homes');
const { groundCheck } = require('./voidGuard');

const RESERVED = HOMES.slice();

/** Nettoie un nom de home : minuscules, [a-z0-9_] uniquement (anti-injection de commande). */
function sanitizeName(name) {
  const n = String(name == null ? '' : name).trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
  return n || HOME_WORK;
}

/** Émet une commande de warp après double-garde nogive (ne devrait jamais bloquer /sethome//home). */
function _send(bot, cmd) {
  if (isForbiddenCheat(cmd)) return false;   // défense en profondeur : impossible par construction
  try { bot.chat(cmd); } catch (e) { return false; }
  return true;
}

/**
 * Pose (ou écrase) le signet <name> à la position courante. Retourne le nom nettoyé, ou false.
 * GARDE ANTI-VIDE (live 22/10, NethBot3) : jamais un home (hors `death`, qui marque juste le lieu où
 * ramasser) au-dessus d'une colonne qui n'a pas 2 blocs pleins sous les pieds — un /home vers ce point
 * tue d'une chute (vécu : `safe` posé EN PLEIN VOL à y59 dans un puits, puis « destination unsafe »).
 * Refus → false, `bot._mcaBookmarkRefused` renseigné et `bot._mcaOnBookmarkRefused(info)` appelé
 * (index.js l'émet). Sol illisible (chunk/fake-bot sans blockAt) → comportement d'avant (on pose).
 */
function bookmark(bot, name) {
  const n = sanitizeName(name);
  if (n !== HOME_DEATH) {
    let g = { ok: null };
    try {
      const p = bot && bot.entity && bot.entity.position;
      if (p && typeof bot.blockAt === 'function') g = groundCheck((q) => bot.blockAt(_vec(p, q)), p);
    } catch (e) { g = { ok: null }; }
    if (g.ok === false) {
      const p = bot.entity.position;
      const info = { name: n, reason: g.reason, solid: g.solid, x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z), at: Date.now() };
      try { bot._mcaBookmarkRefused = info; } catch (e) {}
      try { if (typeof bot._mcaOnBookmarkRefused === 'function') bot._mcaOnBookmarkRefused(info); } catch (e) {}
      return false;
    }
  }
  return _send(bot, '/sethome ' + n) ? n : false;
}

/** {x,y,z} → objet passable à bot.blockAt (Vec3 si la position du bot en est un : `offset`). */
function _vec(p, q) {
  if (p && typeof p.offset === 'function') return p.offset(q.x - p.x, q.y - p.y, q.z - p.z).floored();
  return q;
}

/** Téléporte le bot vers le signet <name>. Retourne le nom nettoyé, ou false.
 * Trace le dernier /home envoyé sur le bot (bot._mcaLastHome) : Essentials répond de façon
 * asynchrone dans le chat, et un refus (« destination unsafe ») ne cite PAS le nom du home —
 * seul ce tracking permet d'attribuer le refus (cf. refusedHome).
 *
 * HOME `safe` CAMPÉ (live 19/10, MapBot2 : 8 morts en 3 min, chaque secours le ramenait dans le camp
 * du spawn) : un /home safe consulte d'abord `bot._mcaSafeVeto(ctx)`, posé par index.js (décision pure
 * homeSafety.rescueWarpVeto). Vrai = home campé ET (nuit OU hostile signalé près du home) → la commande
 * N'EST PAS envoyée et on rend false, l'échec habituel : chaque appelant a déjà son repli (nager, creuser
 * sur place, s'abriter là où il est). C'est le point d'entrée UNIQUE : goSpawn, safeWarpHome et les
 * appels directs passent tous par ici. `opts.voluntary` (retour demandé, de jour) court-circuite le
 * veto ; un veto qui LÈVE ne bloque jamais un secours ; sans veto installé, comportement d'avant.
 * @param {{ctx?: string, voluntary?: boolean}} [opts] */
function goHome(bot, name, opts) {
  const n = sanitizeName(name);
  if (n === HOME_SAFE && !(opts && opts.voluntary) && bot && typeof bot._mcaSafeVeto === 'function') {
    let veto = false;
    try { veto = !!bot._mcaSafeVeto(opts && opts.ctx); } catch (e) { veto = false; }
    if (veto) return false;
  }
  if (!_send(bot, '/home ' + n)) return false;
  try { bot._mcaLastHome = { name: n, at: Date.now() }; } catch (e) {}
  return n;
}

/** Sort d'un piège mortel vers LA BASE (repli sur le home 'safe' — /spawn absent). Même veto que goHome. */
function goSpawn(bot, opts) {
  return goHome(bot, HOME_SAFE, opts);
}

/** Retour au chantier courant après une excursion volontaire (bois, dépôt, livraison, entraide). */
function goWork(bot) {
  return goHome(bot, HOME_WORK);
}

/** Supprime le signet <name> (libère un slot : la limite serveur est de 3 homes).
 *  Best-effort — Essentials répond « home not found » si le nom n'existe pas, sans erreur bloquante. */
function delhome(bot, name) {
  const n = sanitizeName(name);
  return _send(bot, '/delhome ' + n) ? n : false;
}

// ─── Politique du watchdog PV « à une seconde de mourir » ──────────────────────────────────────
// Décision PURE (testable) : à PV bas, faut-il FUIR vivant (/home safe) ou marquer le lieu de mort
// (/sethome death) pour revenir ramasser après respawn ?
//   'escape'   → les 3 morts « bêtes » que Massii veut éviter : noyade/suffocation eau, lave,
//                essaim de mobs → goSpawn IMMÉDIAT (téléporté vivant, PAS de mort).
//   'bookmark' → autre cause imminente (chute, dégât générique, faim) : on ne peut pas l'esquiver
//                utilement par /home → on marque 'death' AVANT de mourir pour revenir ramasser.
//   null       → pas imminent (PV au-dessus du seuil).
// ─── Refus TP Essentials (RC3 water-wall) ───────────────────────────────────────────────────────
// teleport-safety:true + destination innatérissable (monde noyé : safe/wsite en pleine eau) →
// Essentials REFUSE le /home avec « The teleport destination is unsafe and teleport-safety is
// disabled. » et le bot RESTE SUR PLACE. Sans détection, le filet de secours est un no-op
// silencieux (vécu NethBot2 : zombie 1.8 PV qui « croyait » avoir warpé).

const _TP_REFUSAL_RE = /teleport destination is unsafe/i;
const REFUSAL_WINDOW_MS = 8000;      // réponse Essentials = quasi immédiate ; 8 s de marge réseau
const REFUSAL_DEGRADE_MS = 120000;   // un safe refusé reste suspect 2 min (le temps de le re-poser)

/** Le message chat est-il un refus de téléportation Essentials ? (pur) */
function isTpRefusal(msg) {
  return typeof msg === 'string' && _TP_REFUSAL_RE.test(msg);
}

/** Attribue un refus TP au dernier /home envoyé (fenêtre courte). Retourne le nom du home
 * refusé (et CONSOMME le tracking — anti double-comptage), sinon null. */
function refusedHome(bot, msg, windowMs = REFUSAL_WINDOW_MS) {
  if (!isTpRefusal(msg)) return null;
  const last = bot && bot._mcaLastHome;
  if (!last || (Date.now() - last.at) > windowMs) return null;
  bot._mcaLastHome = null;
  return last.name;
}

/** Dégrade un verdict 'escape' en 'escape_no_warp' si le /home safe vient d'être refusé :
 * inutile de re-spammer un TP qui ne part pas — le caller doit se sauver À PIED (escapeWater)
 * ou accepter la mort (bookmark). Pur, horloge injectée. */
function effectiveVerdict(verdict, refusedSafeAt, now, windowMs = REFUSAL_DEGRADE_MS) {
  if (verdict !== 'escape') return verdict;
  if (typeof refusedSafeAt === 'number' && (now - refusedSafeAt) <= windowMs) return 'escape_no_warp';
  return 'escape';
}

// ─── Home INEXISTANT côté serveur (20/10, NethBot1 sessions 309-313) ─────────────────────────────
// Le mémo de base disait « base installée » (base_adopted → _safeHomeSet = true) alors que le serveur
// n'avait AUCUN home : chaque `/home safe` répondait « Player has not set a home. » et le bot restait
// emmuré à y 40, session après session. Le message ne cite pas toujours le nom du home : on l'attribue
// au dernier /home envoyé (même fenêtre que refusedHome). Variantes Essentials EN/FR/IT.
const _NO_HOME_RE = /has not set a home|home \S+ (does not|doesn't) exist|no home (is )?set|n'a (pas|aucun) (encore )?(défini |de )?(de )?home|home \S+ n'existe pas|non ha (ancora )?impostato|non esiste/i;

/** Le message chat dit-il que le home demandé n'existe pas ? (pur) */
function isNoHomeSet(msg) {
  return typeof msg === 'string' && _NO_HOME_RE.test(msg);
}

/** Attribue un « home inexistant » au dernier /home envoyé (fenêtre courte). Nom, ou null.
 *  CONSOMME le tracking (anti double-comptage), comme refusedHome. */
function missingHome(bot, msg, windowMs = REFUSAL_WINDOW_MS) {
  if (!isNoHomeSet(msg)) return null;
  const last = bot && bot._mcaLastHome;
  if (!last || (Date.now() - last.at) > windowMs) return null;
  bot._mcaLastHome = null;
  return last.name;
}

// ─── Secure-then-warp (Massii 15/07) ────────────────────────────────────────────────────────────
// Certains serveurs ont un teleport-delay Essentials (warmup ~5 s) : le /home est ANNULÉ si le
// joueur bouge ou prend un coup pendant l'attente. Or nos /home de secours partent PRÉCISÉMENT
// quand le bot est frappé/se noie → sans mise en sécurité préalable, le sauvetage serait toujours
// annulé sur ces serveurs. Décision PURE de la tactique ; l'exécution vit dans skills/secureSpot.

// « Don't move » seul est trop générique (chat joueur) — le message Essentials porte toujours
// « Teleportation will commence… » / « Teleportation commencing… », on ancre là-dessus.
const _TP_WARMUP_RE = /teleportation (will commence|commencing)/i;
const _TP_CANCEL_RE = /teleportation (request )?cancelled|pending teleportation/i;

/** Le message chat annonce-t-il un warmup de téléportation Essentials ? (pur) */
function isTpWarmup(msg) {
  return typeof msg === 'string' && _TP_WARMUP_RE.test(msg);
}

/** Le message chat annonce-t-il l'ANNULATION d'une téléportation en attente ? (pur) */
function isTpCancelled(msg) {
  return typeof msg === 'string' && _TP_CANCEL_RE.test(msg);
}

// « You have already sent <joueur> a teleport request. » — Essentials REFUSE le /tpa tant que le
// précédent est en attente (sa fenêtre est plus longue que notre cooldown de squad). Mesuré sur le
// run world_mn3 : 384 refus en 20 min. Sans détection, chacun coûtait les 15 s pleines d'awaitWarp
// PENDANT lesquelles le bot est immobile (trySquad fait stopMotion avant d'envoyer le /tpa) — soit
// ~1 h 30 de temps-bot planté, et une dispersion aggravée (le suiveur attend, le chef s'éloigne).
// Détecté, le refus vaut annulation immédiate : awaitWarp rend la main en ~300 ms.
const _TP_PENDING_RE = /already sent .* a teleport request/i;

/** Le /tpa vient-il d'être refusé parce qu'une demande est DÉJÀ en attente ? (pur) */
function isTpAlreadyPending(msg) {
  return typeof msg === 'string' && _TP_PENDING_RE.test(msg);
}

/**
 * Tactique de mise en sécurité AVANT un /home de secours (pure).
 *   'float'  → dans l'eau : remonter/flotter immobile (aucune pose fiable sous l'eau) ;
 *   'seal'   → hostiles + ≥4 blocs : se murer sur place ;
 *   'none'   → pas de menace ou pas de matériaux : simple stopMotion+immobilité.
 *
 * ⚠️ 'pillar' RETIRÉ (Massii 2026-07-26 : « ils ont toujours trop de difficulté à placer des blocs
 * sous leurs pieds → en surface ils ne construisent pas de pilier »). La colonne 1×1 sous les
 * pieds est précisément la manœuvre qu'ils rataient ; se murer protège autant sans aucune pose
 * sous les pieds. `secureSpot` sait encore exécuter 'pillar' — plus personne ne le demande.
 */
function secureTactic(s = {}) {
  if (s.inWater) return 'float';
  const hostiles = s.hostiles || 0;
  const blocks = s.blocks || 0;
  if (hostiles >= 1 && blocks >= 4) return 'seal';
  return 'none';
}

const IMMINENT_HP = 6;

/** PV au/sous le seuil imminent ? (pur, même seuil que classifyImminent). Health absent/NaN → false
 *  (ne jamais bloquer sans donnée fiable). Sert de garde pour différer les actions qui désarment
 *  le bot (ex. craftSmart coupe l'aura pendant la fenêtre de craft, cf. index.js:10059). */
function isCriticalHealth(health, threshold = IMMINENT_HP) {
  return typeof health === 'number' && !Number.isNaN(health) && health <= threshold;
}

// ESSAIM, PEU ARMÉ : PARTIR AVANT LE SEUIL CRITIQUE (chrono 22/10 12:10-14:36, NethBot1-3). Sur 15
// `imminent_escape` déclenchés à ≥ 2 hostiles, 11 ont été suivis de la mort en 0 à 3 s — presque toujours
// AVANT le /home, parce que la mise en sécurité (mur + toit) prend elle-même jusqu'à 6 s sous les coups.
// En hard, deux zombies ou un zombie + un squelette retirent 6 PV en une seconde à un bot nu. Un joueur
// prudent à 5 cœurs contre deux mobs décroche tout de suite ; on fait pareil quand l'armure est
// incomplète (< 4 pièces). Fer complet : rien ne change (il tient la bande 6-10 PV).
const SWARM_ESCAPE_HP = 10;
const SWARM_ESCAPE_MIN_HOSTILES = 2;
const SWARM_ESCAPE_FULL_ARMOR = 4;

/** Bande (IMMINENT_HP, SWARM_ESCAPE_HP] : essaim collé, armure incomplète, à sec → partir (pur).
 *  `armorPieces` absent → false (rétro-compat : sans donnée, la règle historique seule décide). */
function swarmEscapeEarly(s) {
  if (!s) return false;
  const h = s.health;
  if (typeof h !== 'number' || Number.isNaN(h)) return false;
  if (h <= IMMINENT_HP || h > SWARM_ESCAPE_HP) return false;
  if (s.inWater) return false;
  if (!(Number.isFinite(s.armorPieces) && s.armorPieces < SWARM_ESCAPE_FULL_ARMOR)) return false;
  return (s.nearbyHostiles || 0) >= SWARM_ESCAPE_MIN_HOSTILES;
}

function classifyImminent(s) {
  const h = s && s.health;
  if (typeof h === 'number' && h > IMMINENT_HP) return swarmEscapeEarly(s) ? 'escape' : null;
  if (typeof h !== 'number' || h > IMMINENT_HP) return null;
  if (s.inWater) return 'escape';                       // noyade / suffocation dans l'eau
  if (s.lavaNear) return 'escape';                      // lave à ≤2 blocs
  if ((s.nearbyHostiles || 0) >= 2) return 'escape';    // essaim (≥2 hostiles collés)
  return 'bookmark';                                    // chute / générique → marquer et revenir
}

/**
 * Entités-items à ramasser autour d'un point (post-mort, keepInventory OFF cible).
 * PURE : filtre les entités 'item'/'object' dans `radius`, triées par distance croissante.
 * center = {x,y,z}. Retourne [{entity, dist}]. keepInv ON → 0 drop → [] (no-op propre).
 */
function dropsWithin(entities, center, radius) {
  if (!entities || !center) return [];
  const r2 = (radius || 16) * (radius || 16);
  const out = [];
  const list = Array.isArray(entities) ? entities : Object.values(entities);
  for (const e of list) {
    if (!e || !e.position) continue;
    const t = e.type || (e.name === 'item' ? 'item' : null);
    // NB : `e.displayName` (pas `e.objectType`) — objectType est un getter déprécié de
    // prismarine-entity qui appelle console.trace() à chaque lecture (flood event-loop). Le
    // getter renvoyait justement displayName → substitution fidèle, zéro trace.
    const isItem = t === 'item' || t === 'object' || e.displayName === 'Item' || e.name === 'item';
    if (!isItem) continue;
    const dx = e.position.x - center.x, dy = e.position.y - center.y, dz = e.position.z - center.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 <= r2) out.push({ entity: e, dist: Math.sqrt(d2) });
  }
  out.sort((a, b) => a.dist - b.dist);
  return out;
}

module.exports = {
  bookmark, goHome, goSpawn, goSafe: goSpawn, goWork, delhome,
  sanitizeName, RESERVED, classifyImminent, dropsWithin,
  IMMINENT_HP, SWARM_ESCAPE_HP, swarmEscapeEarly, isCriticalHealth, isTpRefusal, refusedHome, effectiveVerdict, REFUSAL_DEGRADE_MS,
  isNoHomeSet, missingHome,
  isTpWarmup, isTpCancelled, isTpAlreadyPending, secureTactic,
};
