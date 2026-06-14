'use strict';
// Capture-clone étape E (« LA COPIE », contextes ACTIFS) : anti snap-aim sur ACQUISITION de cible.
// Un bot tourne la caméra INSTANTANÉMENT vers sa cible (mob à frapper, bloc à miner) → tell n°1.
// Un humain SWING la caméra vers la cible sur ~quelques centaines de ms, avec overshoot/corrections
// (jitter), et atterrit dessus. aimSwingSteps génère cette séquence de pas (PUR, testable) ; on
// l'applique via bot.look. Le QUOI (la cible) reste déterministe ; seul le COMMENT (le trajet de la
// visée) devient humain. Borné (atterrit EXACT sur la cible → dig/attaque fonctionnent). stdlib only.
// Sans style/clips → non utilisé (rétro-compat : l'appelant garde bot.look instantané).

const DEG = Math.PI / 180;

// Ramène un angle (radians) dans [-π, π] — pour la distance de yaw la plus courte (wrap).
function wrapRad(a) {
  a = a % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * Séquence de pas de visée from→to d'allure humaine. Progresse vers la cible (interpolation),
 * ajoute du jitter humain sur les pas intermédiaires (overshoot/corrections : clip dyaw/dpitch réels
 * si fournis, sinon ±jitterDeg), et ATTERRIT EXACTEMENT sur `to` (dernier pas) → l'action garde sa
 * cible. n pas ∝ distance angulaire (gros virage = swing plus long). PUR (rng injectable).
 *
 * @param {{yaw:number,pitch:number}} from  radians
 * @param {{yaw:number,pitch:number}} to    radians
 * @param {{jitterDeg?:number, maxStepDeg?:number, clipFrames?:Array, rng?:Function}} opts
 * @returns {Array<{yaw:number,pitch:number}>}  pas (dernier === to)
 */
function aimSwingSteps(from, to, opts = {}) {
  const { jitterDeg = 3, maxStepDeg = 18, clipFrames = null, rng = Math.random } = opts;
  const dyaw = wrapRad(to.yaw - from.yaw);          // chemin le plus court
  const dpitch = to.pitch - from.pitch;
  const angDistDeg = Math.max(Math.abs(dyaw), Math.abs(dpitch)) / DEG;
  const n = Math.max(1, Math.ceil(angDistDeg / Math.max(1, maxStepDeg)));
  const haveClip = Array.isArray(clipFrames) && clipFrames.length > 0;
  const steps = [];
  for (let k = 1; k <= n; k++) {
    if (k === n) { steps.push({ yaw: to.yaw, pitch: to.pitch }); break; } // atterrit EXACT
    const frac = k / n;
    let yaw = from.yaw + dyaw * frac;
    let pitch = from.pitch + dpitch * frac;
    // jitter humain sur le trajet (pas le dernier pas) : motricité réelle du clip ou bruit borné
    if (haveClip) {
      const f = clipFrames[(k - 1) % clipFrames.length] || {};
      yaw += (Number(f.dyaw) || 0) * DEG;
      pitch += (Number(f.dpitch) || 0) * DEG;
    } else if (jitterDeg > 0) {
      yaw += (rng() * 2 - 1) * jitterDeg * DEG;
      pitch += (rng() * 2 - 1) * jitterDeg * DEG;
    }
    steps.push({ yaw, pitch });
  }
  return steps;
}

/**
 * Applique un swing de visée humain vers `to` (radians) via bot.look. Anti snap-aim. Borné (atterrit
 * sur la cible). À utiliser sur ACQUISITION (avant attaque/dig). Sans humanize → l'appelant ne passe
 * pas par ici (garde bot.look(force=true) instantané). sleepFn injectable (tests).
 */
async function humanAimSwing(bot, to, opts = {}) {
  const ent = bot && bot.entity;
  if (!ent) return;
  const from = { yaw: ent.yaw, pitch: ent.pitch };
  const steps = aimSwingSteps(from, to, opts);
  const stepMs = Math.max(10, opts.stepMs || 45);
  const sleep = opts.sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    try { await bot.look(s.yaw, s.pitch, false); } catch (e) { return; }
    if (i < steps.length - 1) await sleep(stepMs);
  }
}

module.exports = { aimSwingSteps, humanAimSwing, wrapRad, DEG };
