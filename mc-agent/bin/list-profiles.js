'use strict';
// Imprime les métadonnées + fiches de tells de tous les profils (JSON) sur stdout.
// Consommé par backend/bots/mc_agent_manager.py (source unique = profiles/*.js).
const { listProfiles } = require('../profiles');
process.stdout.write(JSON.stringify(listProfiles()));
