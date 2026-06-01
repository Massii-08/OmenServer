'use strict';
// `stop` → loiter humain : look G/D, petits pas autour du point d'arrêt, sneak aléatoire, pauses.
// Intensité ∝ profil (movementJitter). rng injectable pour tests. ANTI-TELL #1 (pas de freeze).

function _rand(rng, a, b) { return a + (b - a) * rng(); }

/** Choisit la prochaine micro-action. Pur (testable). */
function nextLoiterAction(rng = Math.random) {
  const r = rng();
  if (r < 0.45) return { kind: 'look' };
  if (r < 0.70) return { kind: 'step' };
  if (r < 0.85) return { kind: 'sneak' };
  return { kind: 'idle' };
}

const DIRS = ['forward', 'back', 'left', 'right'];

/** Démarre le loiter. Retourne stop() (cleanup). center = position de départ. */
function loiter(bot, profile = null, opts = {}) {
  const rng = opts.rng || Math.random;
  const jitter = (profile && profile.params && profile.params.movementJitter) || 0.1;
  const baseMs = opts.baseMs || 2500;
  const center = bot.entity && bot.entity.position && bot.entity.position.clone ? bot.entity.position.clone() : null;
  let stopped = false;
  let timer = null;

  const tooFar = () => center && bot.entity && center.distanceTo(bot.entity.position) > 2.5;

  const doAction = () => {
    if (stopped) return;
    const act = nextLoiterAction(rng);
    if (act.kind === 'look') {
      try { bot.look(_rand(rng, -Math.PI, Math.PI), _rand(rng, -0.3, 0.3), false); } catch (e) {}
    } else if (act.kind === 'step') {
      if (tooFar()) { try { bot.pathfinder && bot.pathfinder.setGoal(null); } catch (e) {} }
      else {
        const dir = DIRS[Math.floor(_rand(rng, 0, DIRS.length))];
        try {
          bot.setControlState(dir, true);
          setTimeout(() => { try { bot.setControlState(dir, false); } catch (e) {} }, 250 + 250 * rng());
        } catch (e) {}
      }
    } else if (act.kind === 'sneak') {
      try { bot.setControlState('sneak', rng() < 0.5); } catch (e) {}
    }
    // plus de jitter (Expert) = intervalle plus court = plus actif
    const wait = baseMs * (0.6 + (1 - jitter)) * (0.7 + 0.6 * rng());
    timer = setTimeout(doAction, wait);
  };

  doAction();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    try { bot.setControlState('sneak', false); } catch (e) {}
    DIRS.forEach((d) => { try { bot.setControlState(d, false); } catch (e) {} });
  };
}

module.exports = { loiter, nextLoiterAction };
