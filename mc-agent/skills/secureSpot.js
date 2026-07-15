'use strict';
// Mise en sécurité RAPIDE avant un /home de secours (secure-then-warp, Massii 15/07).
// Sur les serveurs à teleport-delay Essentials (warmup ~5 s), le TP est ANNULÉ si le joueur bouge
// ou prend un coup pendant l'attente — or nos /home de secours partent précisément sous les coups.
// Tactiques (décision = homewarp.secureTactic, pure) :
//   'float'  → dans l'eau : jump maintenu (remonter/flotter), aucune pose fiable sous l'eau ;
//   'pillar' → pilier ×3 (délégué à pillarUp : apex-timing + garde-fou #6) → hors de portée mêlée ;
//   'seal'   → se murer : boucher les 4 côtés OUVERTS (pieds puis tête), plafond bas/tunnel ;
//   'none'   → rien à faire (le caller fait stopMotion + reste immobile).
// Best-effort, borné par le caller (withTimeout) ; un échec n'empêche JAMAIS le warp derrière.
const { Vec3 } = require('vec3');
const { pillarUp: realPillarUp, SCAFFOLD } = require('./pillarUp');

const SIDES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];

function _solid(b) { return !!(b && b.boundingBox === 'block'); }

/** Mure les côtés ouverts autour du bot : case pieds d'abord (référence = bloc dessous), puis la
 * case tête par-dessus (référence = le bloc pieds fraîchement posé). Best-effort par côté. */
async function _seal(bot, token) {
  const items = () => (bot.inventory && bot.inventory.items()) || [];
  let placed = 0;
  const feet = bot.entity.position.floored ? bot.entity.position.floored() : new Vec3(
    Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.y), Math.floor(bot.entity.position.z));
  for (const side of SIDES) {
    if (token && token.cancelled) break;
    const scaffold = items().find((it) => SCAFFOLD.includes(it.name));
    if (!scaffold) break;
    try { await bot.equip(scaffold, 'hand'); } catch (e) { break; }
    const footPos = feet.plus(side);
    const headPos = footPos.offset(0, 1, 0);
    // case pieds ouverte + support plein dessous → poser dessus
    if (!_solid(bot.blockAt(footPos))) {
      const support = bot.blockAt(footPos.offset(0, -1, 0));
      if (_solid(support)) {
        try { await bot.placeBlock(support, new Vec3(0, 1, 0)); placed++; } catch (e) { continue; }
      } else { continue; }        // pas de support → côté condamné (à-pic), on passe
    }
    // case tête ouverte + le bloc pieds (préexistant ou fraîchement posé) sert de référence
    if (!_solid(bot.blockAt(headPos))) {
      const ref = bot.blockAt(footPos);
      if (_solid(ref)) {
        try { await bot.placeBlock(ref, new Vec3(0, 1, 0)); placed++; } catch (e) { /* best-effort */ }
      }
    }
  }
  return placed;
}

/**
 * secureSpot(bot, tactic, {token, pillarUp, emit}) → {ok, tactic, placed}
 * ok=false ⇒ la mise en sécurité a échoué — le caller warpe QUAND MÊME (c'était déjà le plan B).
 */
async function secureSpot(bot, tactic, opts = {}) {
  const token = opts.token || null;
  const emit = opts.emit || null;
  const doPillar = opts.pillarUp || realPillarUp;
  if (token && token.cancelled) return { ok: false, tactic, placed: 0, cancelled: true };
  let ok = true, placed = 0;
  try {
    if (tactic === 'float') {
      try { bot.setControlState('jump', true); } catch (e) {}      // remonter/flotter — relâché par le caller post-warp
    } else if (tactic === 'pillar') {
      const r = await doPillar(bot, { height: 3 }, token, opts);
      placed = (r && r.placed) || 0;
      ok = placed >= 2;                                            // ≥2 blocs = hors de portée mêlée
    } else if (tactic === 'seal') {
      placed = await _seal(bot, token);
      ok = placed > 0 || SIDES.every((s) => {
        const feet = bot.entity.position.floored ? bot.entity.position.floored() : bot.entity.position;
        return _solid(bot.blockAt(feet.plus(s)));
      });
      if (token && token.cancelled) ok = false;
    }
    // 'none' → rien : le caller stopMotion + reste immobile
  } catch (e) { ok = false; }
  if (emit) { try { emit({ type: 'secure_spot', tactic, ok, placed }); } catch (e) {} }
  return { ok, tactic, placed };
}

module.exports = { secureSpot };
