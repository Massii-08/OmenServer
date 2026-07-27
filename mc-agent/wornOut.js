'use strict';
// Dédup des rapports `gear_worn_out`. `_wornArmor()` (et le constructeur de statut pour la main
// secondaire) est appelé ~18×/tick du planner (armorNeed, teamStatus, publication d'état…).
// Émettre `gear_worn_out` à CHAQUE appel pour une même pièce déjà usée noyait le journal
// (vécu NethBot1 world_mn9 : 101/309 = 32 % des events d'UNE session, une seule pièce) et
// polluait le digest (2ᵉ « emballement » fleet-wide à 21 %, faux signal qui masque les vrais
// goulots). L'event n'a AUCUN consommateur (pure télémétrie) → on ne perd rien à ne le tirer
// qu'à la TRANSITION : une pièce qui devient usée est signalée une fois ; remplacée/réparée
// (plus dans la liste des pièces usées), elle sort du registre → une future usure ré-émet.
// Helper PUR (aucune dépendance mineflayer) → testable isolément (cf. wornOut.test.js).
function pickWornOutToReport(nearlyBrokenNames, reported) {
  const cur = new Set(nearlyBrokenNames);
  const toEmit = [];
  for (const name of cur) {
    if (!reported.has(name)) toEmit.push(name);
  }
  // Le nouveau registre = uniquement les pièces ENCORE usées (celles remplacées/réparées sortent
  // → ré-émission autorisée si elles se réusent plus tard).
  return { toEmit, reported: cur };
}

module.exports = { pickWornOutToReport };
