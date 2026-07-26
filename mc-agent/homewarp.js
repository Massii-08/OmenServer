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
// Primitive « signet de chantier » :
//   bookmark(bot, name) → /sethome <name>   (Essentials écrase l'home du même nom → re-sethome = replacer)
//   goHome(bot, name)   → /home <name>
//   goSpawn(bot)        → /home safe         (repli surface, cf. /spawn absent)
// Noms réservés : wsite (chantier courant), death (dernier lieu de mort), safe (surface sûre au boot).

const { isForbiddenCheat } = require('./nogive');

const RESERVED = ['wsite', 'death', 'safe', 'canchor'];

/** Nettoie un nom de home : minuscules, [a-z0-9_] uniquement (anti-injection de commande). */
function sanitizeName(name) {
  const n = String(name == null ? '' : name).trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
  return n || 'wsite';
}

/** Émet une commande de warp après double-garde nogive (ne devrait jamais bloquer /sethome//home). */
function _send(bot, cmd) {
  if (isForbiddenCheat(cmd)) return false;   // défense en profondeur : impossible par construction
  try { bot.chat(cmd); } catch (e) { return false; }
  return true;
}

/** Pose (ou écrase) le signet <name> à la position courante. Retourne le nom nettoyé, ou false. */
function bookmark(bot, name) {
  const n = sanitizeName(name);
  return _send(bot, '/sethome ' + n) ? n : false;
}

/** Téléporte le bot vers le signet <name>. Retourne le nom nettoyé, ou false.
 * Trace le dernier /home envoyé sur le bot (bot._mcaLastHome) : Essentials répond de façon
 * asynchrone dans le chat, et un refus (« destination unsafe ») ne cite PAS le nom du home —
 * seul ce tracking permet d'attribuer le refus (cf. refusedHome). */
function goHome(bot, name) {
  const n = sanitizeName(name);
  if (!_send(bot, '/home ' + n)) return false;
  try { bot._mcaLastHome = { name: n, at: Date.now() }; } catch (e) {}
  return n;
}

/** Sort d'un piège mortel vers la surface sûre (repli sur le home 'safe' — /spawn absent). */
function goSpawn(bot) {
  return goHome(bot, 'safe');
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
function classifyImminent(s) {
  const h = s && s.health;
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
    const isItem = t === 'item' || t === 'object' || e.objectType === 'Item' || e.name === 'item';
    if (!isItem) continue;
    const dx = e.position.x - center.x, dy = e.position.y - center.y, dz = e.position.z - center.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 <= r2) out.push({ entity: e, dist: Math.sqrt(d2) });
  }
  out.sort((a, b) => a.dist - b.dist);
  return out;
}

module.exports = {
  bookmark, goHome, goSpawn, goSafe: goSpawn, sanitizeName, RESERVED, classifyImminent, dropsWithin,
  IMMINENT_HP, isTpRefusal, refusedHome, effectiveVerdict, REFUSAL_DEGRADE_MS,
  isTpWarmup, isTpCancelled, secureTactic,
};
