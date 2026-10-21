'use strict';
// NUIT DU CARTOGRAPHE — où se terrer à la tombée de la nuit (live 21/10).
//
// Le cartographe nu se terre bien la nuit (mapperNightGuard → maybeNightShelter, trou 3 + toit,
// sortie sûre dawnExitPlan). Mais le chemin historique (Massii 15/07) RENTRE d'abord au home `safe`
// par /home — et sur world_oct9 le home de MapBot2 (-115, 63, -8) est une berge noyée :
//   13:31-13:36 : 3 morts (drowned ×2, zombie) au home, abri « cancelled » à chaque fois ;
//   14:13-14:16 : 3 morts « shot by Skeleton », abris `roof_failed` / `void_below` / `dig_failed`
//                 au home, `shelter_reenter` ×3 — chaque ré-abri le RENVOYAIT au même trou raté.
// Le veto « home campé » (homeSafety) n'arme qu'à 2 morts : la 1re était gratuite, et un abri RATÉ au
// home n'y comptait pas du tout. Un vrai explorateur, lui, se terre là où la nuit le surprend dès que
// sa base est douteuse. Décision PURE ici ; index.js câble.

const HOME_SHELTER_FAIL_TTL_MS = 20 * 60 * 1000;   // un abri raté au home le disqualifie pour la nuit (≈ 1 cycle)

/**
 * PUR — le cartographe rentre-t-il au home `safe` pour se terrer, ou se terre-t-il ICI ?
 * @param {{homeSet:boolean, deathsNearHome:number, hostileNearHome:boolean,
 *          homeShelterFailedAt:number, now:number}} o
 * @returns {{go:boolean, why:'home'|'no_home'|'deaths_near_home'|'hostile_near_home'|'home_shelter_failed'}}
 */
function mapperNightPlan(o = {}) {
  if (!o.homeSet) return { go: false, why: 'no_home' };
  if (Number.isFinite(o.deathsNearHome) && o.deathsNearHome >= 1) return { go: false, why: 'deaths_near_home' };
  if (o.hostileNearHome === true) return { go: false, why: 'hostile_near_home' };
  const at = o.homeShelterFailedAt;
  if (Number.isFinite(at) && at > 0 && Number.isFinite(o.now) && o.now >= at && o.now - at < HOME_SHELTER_FAIL_TTL_MS) {
    return { go: false, why: 'home_shelter_failed' };
  }
  return { go: true, why: 'home' };
}

module.exports = { mapperNightPlan, HOME_SHELTER_FAIL_TTL_MS };
