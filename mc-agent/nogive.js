'use strict';
// Mode SANS-GIVE (run nether 2026-07-13, règle Massii : le bot gagne TOUT lui-même).
// Filtre PUR des commandes de triche sortantes : appliqué comme wrapper sur bot.chat quand
// --no-give est actif (défense en profondeur — les guards provisionStartKit/ensureFood coupent
// déjà les émetteurs connus, ce filtre attrape tout résidu/futur oubli).
//
// Bloqués : tout ce qui ÉQUIPE, SOIGNE ou TÉLÉPORTE par magie serveur (/give /effect /enchant
// /xp /tp /teleport /spreadplayers /gamemode /summon /kill /setblock /fill).
// Passent : les commandes JOUEUR légitimes (Essentials /tpa*, /home, /msg…), /spawnpoint (ancre
// de respawn : ne donne ni item ni soin), /locate (lecture seule), et le chat normal.
// ⚠️ /tpa, /tpaccept, /tpdeny commencent par "/tp" mais SANS espace après → le motif /tp\s ne
// les matche pas (testé).

const FORBIDDEN = [
  /^\/give\b/i,
  /^\/effect\b/i,
  /^\/enchant\b/i,
  /^\/xp\b/i,
  /^\/experience\b/i,
  /^\/tp\s/i,            // "/tp @s x y z" — PAS /tpa|/tpaccept|/tpdeny (pas d'espace après "tp")
  /^\/teleport\b/i,
  /^\/spreadplayers\b/i,
  /^\/gamemode\b/i,
  /^\/summon\b/i,
  /^\/kill\b/i,
  /^\/setblock\b/i,
  /^\/fill\b/i,
];

/** true si le message chat est une commande de triche interdite en mode sans-give. */
function isForbiddenCheat(msg) {
  const m = String(msg == null ? '' : msg).trimStart();
  return FORBIDDEN.some((re) => re.test(m));
}

module.exports = { isForbiddenCheat };
