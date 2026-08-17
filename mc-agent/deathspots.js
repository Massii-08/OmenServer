'use strict';
// Lieux de MORT RÉPÉTÉE (chutes dans un ravin, morts ENVIRONNEMENTALES sans mob) — run réel :
// un bot est mort 7 fois en 12 min AU MÊME ENDROIT. `_escapeOnSpawn` (index.js, sur bursts de
// morts rapprochées) éloigne le bot AU RESPAWN, mais le planner re-cible ensuite la même zone
// (son chantier y est) et il y retourne mourir : l'anti-camping traite le SYMPTÔME (le point de
// spawn), pas la CAUSE (le choix de cible du tour suivant). Ce module donne aux ÉLECTEURS DE
// CIBLE (câblage hors périmètre de ce module — cf. rapport de livraison) une mémoire de session
// des lieux mortels à consulter AVANT de s'y diriger.
//
// DISTINCT de `deathzones.js` (bannit des CAMPS DE COMBAT sur des alertes « mort IMMINENTE »,
// avant que la mort n'arrive) : ici on compte des MORTS RÉELLES (`bot.on('death')`), toute cause
// confondue — le signal qui a motivé la demande est environnemental (chute), mais le module ne
// discrimine pas la cause : `noteDeath` s'appelle une fois par event 'death', point final. Les
// deux modules sont complémentaires, pas redondants.
//
// Modèle : `memory.js` pour la forme (factory à état fermé, horloge injectable `opts.now`,
// pattern déjà éprouvé pour une mémoire de session qui s'oublie au respawn — très bien, la carte
// des dangers se réapprend) ; `workDrown.js` pour le fond (rayon + fenêtre + TTL + rafraîchissement,
// même famille de problème que « chantier adjacent à un aquifère », ici généralisé à TOUTE mort
// répétée au même endroit, pas seulement la noyade).
//
// Module PUR : zéro I/O, zéro require de mineflayer, testable sans client Minecraft.

const RADIUS = 16;                  // « le même endroit » — XZ seulement (la mort tombe, la chute varie en Y)
const WINDOW_MS = 15 * 60 * 1000;   // 2 morts DANS cette fenêtre l'une de l'autre → spot prouvé mortel
const TTL_MS = 30 * 60 * 1000;      // un ban expire SANS nouvelle mort dedans (le terrain peut changer/être réparé)
const THRESHOLD = 2;                // 2 morts proches suffisent (la 1ère = accident isolé toléré, cf. workDrown)
const MAX_DEATHS = 50;              // cap du journal brut des morts récentes (évince la plus ancienne)
const MAX_BANS = 20;                // cap des spots bannis actifs (évince le plus ancien)

function _finite(n) { return typeof n === 'number' && Number.isFinite(n); }
function _dist(ax, az, bx, bz) { return Math.hypot(ax - bx, az - bz); }

/**
 * Mémoire de session des lieux de mort répétée (aucune persistance disque — se réapprend au
 * respawn/process suivant, comme `deathzones.js`).
 *
 * @param {object} [opts]
 * @param {function():number} [opts.now]      horloge injectable, défaut Date.now (tests déterministes)
 * @param {number} [opts.radius]     défaut RADIUS (16, blocs, XZ)
 * @param {number} [opts.windowMs]   défaut WINDOW_MS (15 min)
 * @param {number} [opts.ttlMs]      défaut TTL_MS (30 min)
 * @param {number} [opts.threshold]  défaut THRESHOLD (2)
 * @param {number} [opts.maxDeaths]  défaut MAX_DEATHS (50)
 * @param {number} [opts.maxBans]    défaut MAX_BANS (20)
 * @returns {{noteDeath, isBanned, nearestBanDist, spots}}
 */
function createDeathSpots(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const radius = _finite(opts.radius) ? opts.radius : RADIUS;
  const windowMs = _finite(opts.windowMs) ? opts.windowMs : WINDOW_MS;
  const ttlMs = _finite(opts.ttlMs) ? opts.ttlMs : TTL_MS;
  const threshold = _finite(opts.threshold) ? opts.threshold : THRESHOLD;
  const maxDeaths = _finite(opts.maxDeaths) ? opts.maxDeaths : MAX_DEATHS;
  const maxBans = _finite(opts.maxBans) ? opts.maxBans : MAX_BANS;

  let deaths = []; // journal brut, cap maxDeaths, ordre = ordre d'arrivée : [{x,y,z,at}]
  let bans = [];   // spots bannis actifs, cap maxBans : [{x,z,bannedAt,lastDeathAt}]

  function _liveBan(b, t) { return (t - b.lastDeathAt) <= ttlMs; }

  /** Purge les bans dont le TTL est dépassé, puis cape par nombre (évince les plus anciens créés). */
  function _pruneBans(t) {
    bans = bans.filter((b) => _liveBan(b, t));
    if (bans.length > maxBans) bans = bans.slice(bans.length - maxBans);
  }

  return {
    /**
     * Enregistre une mort à (x,y,z) — coords arrondies à l'entier. Si ≥`threshold` morts sont
     * tombées à ≤`radius` l'une de l'autre en ≤`windowMs`, le spot devient BANNI. Une mort dans
     * un ban déjà actif le RAFRAÎCHIT (repousse son expiration) sans émettre un nouveau ban.
     * @returns {{ok:boolean, banned?:boolean, newlyBanned?:boolean, x?:number, z?:number}}
     *          ok=false = entrée ignorée (coords non finies), rien n'a été enregistré.
     */
    noteDeath(x, y, z) {
      if (!_finite(x) || !_finite(z)) return { ok: false };
      const t = now();
      const rx = Math.round(x);
      const rz = Math.round(z);
      const ry = _finite(y) ? Math.round(y) : null;

      deaths.push({ x: rx, y: ry, z: rz, at: t });
      if (deaths.length > maxDeaths) deaths = deaths.slice(deaths.length - maxDeaths);

      _pruneBans(t);
      const existing = bans.find((b) => _dist(b.x, b.z, rx, rz) <= radius);
      if (existing) {
        existing.lastDeathAt = t; // rafraîchissement : le TTL repart de maintenant, l'ancre ne bouge pas
        return { ok: true, banned: true, newlyBanned: false, x: existing.x, z: existing.z };
      }

      // Pas de ban actif ici : cette mort forme-t-elle un NOUVEAU cluster avec des morts
      // récentes (le journal brut, pas seulement les bans) ? Ancré sur CETTE mort (la plus
      // récente du cluster) — simple et déterministe, pas de calcul de centroïde.
      const nearbyRecent = deaths.filter((d) => (t - d.at) <= windowMs && _dist(d.x, d.z, rx, rz) <= radius);
      if (nearbyRecent.length >= threshold) {
        bans.push({ x: rx, z: rz, bannedAt: t, lastDeathAt: t });
        if (bans.length > maxBans) bans = bans.slice(bans.length - maxBans);
        return { ok: true, banned: true, newlyBanned: true, x: rx, z: rz };
      }
      return { ok: true, banned: false, newlyBanned: false, x: rx, z: rz };
    },

    /** true si (x,z) est à ≤ `radius` d'un spot encore banni (TTL non expiré). */
    isBanned(x, z) {
      if (!_finite(x) || !_finite(z)) return false;
      const t = now();
      return bans.some((b) => _liveBan(b, t) && _dist(b.x, b.z, x, z) <= radius);
    },

    /**
     * Distance (blocs) au ban actif le plus proche — Infinity si aucun ban vivant.
     * PAS gated par `radius` : un électeur de cible veut souvent COMPARER des candidats
     * (préférer le plus loin d'un spot mortel), pas juste écarter ceux qui sont dedans.
     */
    nearestBanDist(x, z) {
      if (!_finite(x) || !_finite(z)) return Infinity;
      const t = now();
      let best = Infinity;
      for (const b of bans) {
        if (!_liveBan(b, t)) continue;
        const d = _dist(b.x, b.z, x, z);
        if (d < best) best = d;
      }
      return best;
    },

    /** Liste des bans actifs (TTL non expiré) — pour events/debug. Non mutant. */
    spots() {
      const t = now();
      return bans.filter((b) => _liveBan(b, t))
        .map((b) => ({ x: b.x, z: b.z, bannedAt: b.bannedAt, lastDeathAt: b.lastDeathAt }));
    },
  };
}

module.exports = {
  createDeathSpots,
  RADIUS, WINDOW_MS, TTL_MS, THRESHOLD, MAX_DEATHS, MAX_BANS,
};
