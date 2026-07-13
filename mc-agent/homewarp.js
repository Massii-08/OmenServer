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

const RESERVED = ['wsite', 'death', 'safe'];

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

/** Téléporte le bot vers le signet <name>. Retourne le nom nettoyé, ou false. */
function goHome(bot, name) {
  const n = sanitizeName(name);
  return _send(bot, '/home ' + n) ? n : false;
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

module.exports = { bookmark, goHome, goSpawn, goSafe: goSpawn, sanitizeName, RESERVED, classifyImminent, dropsWithin, IMMINENT_HP };
