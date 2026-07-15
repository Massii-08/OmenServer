'use strict';
// Décision PURE : faut-il (re)lancer la commande de kit serveur (/kit) ? Configurée au profil,
// lancée au démarrage + à chaque respawn, avec un cooldown LOCAL anti-spam (le vrai cooldown
// serveur est géré best-effort côté action : la réponse d'erreur est ignorée).
function maybeRunKit({ kitCommand, lastRunAt, now, cooldownMs = 300000 } = {}) {
  if (!kitCommand || !String(kitCommand).trim()) return { run: false, reason: 'not_configured' };
  if (lastRunAt != null && (now - lastRunAt) < cooldownMs) return { run: false, reason: 'cooldown' };
  return { run: true, reason: lastRunAt == null ? 'first' : 'refresh' };
}

module.exports = { maybeRunKit };
