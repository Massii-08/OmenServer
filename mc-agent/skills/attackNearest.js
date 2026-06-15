'use strict';
// Attaque l'entité hostile la plus proche via mineflayer-pvp (approche + frappe en boucle).
const { bestWeapon } = require('../tools');
const { NEUTRAL_NO_PROVOKE } = require('../survival');   // bug #3 (Massii) : jamais l'enderman (neutre)

/** Attaque le mob hostile le plus proche (JAMAIS un neutre). Équipe l'épée AVANT de frapper. False si rien. */
function attackNearest(bot) {
  let victim = bot.nearestEntity((e) => e && (e.type === 'mob' || e.type === 'hostile')
    && e.kind === 'Hostile mobs' && !NEUTRAL_NO_PROVOKE.has(e.name));
  if (!victim) victim = bot.nearestEntity((e) => e && (e.type === 'mob' || e.type === 'hostile')
    && !NEUTRAL_NO_PROVOKE.has(e.name));
  if (!victim) { bot.chat('rien a attaquer ici'); return false; }
  // bug #2 (Massii) : équiper la MEILLEURE ARME (épée > hache, meilleur palier) AVANT de frapper —
  // sinon le bot frappe avec l'item de minage qu'il a en main (pioche). Attaque APRÈS l'equip.
  const w = bestWeapon(bot);
  const go = () => { try { bot.pvp.attack(victim); } catch (e) {} };
  if (w) { try { bot.equip(w, 'hand').then(go, go); } catch (e) { go(); } } else { go(); }
  return true;
}

module.exports = { attackNearest };
