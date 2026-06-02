'use strict';
// État persistant du bot (survit aux reboots/redeploys). Secrets EXCLUS (cf. auth.js).
const fs = require('fs');

function defaultWorld() {
  return { home: null, chests: [], waypoints: [], objective: null };
}

/** Charge le world model ; retourne la forme par défaut si absent ou corrompu (jamais throw). */
function loadWorld(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw);
    return Object.assign(defaultWorld(), obj);
  } catch (e) {
    return defaultWorld();
  }
}

/** Écrit le world model en JSON (pretty). */
function saveWorld(file, world) {
  fs.writeFileSync(file, JSON.stringify(world, null, 2));
}

function setObjective(world, obj) { world.objective = obj; }
function clearObjective(world) { world.objective = null; }

module.exports = { loadWorld, saveWorld, setObjective, clearObjective, defaultWorld };
