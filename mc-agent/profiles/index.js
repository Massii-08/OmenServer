'use strict';
// Registre des profils de comportement. INVARIANT (spec §2) : tout profil DOIT déclarer
// un tableau `tells` non vide (le corrigé du formateur). Un profil sans tells est invalide.

/** Valide la forme d'un profil. Throw si tells absent/vide — garde-fou anti « outil d'évasion ». */
function validateProfile(p) {
  if (!p || typeof p !== 'object') throw new Error('profile must be an object');
  if (!p.id || typeof p.id !== 'string') throw new Error('profile.id (string) is required');
  if (!Array.isArray(p.tells) || p.tells.length === 0) {
    throw new Error(`profile "${p.id}" must declare a non-empty tells[] (spec invariant §2)`);
  }
  return p;
}

// Chargement paresseux des profils concrets (require ici éviterait un cycle si un profil
// importait l'index ; ils ne le font pas, mais on garde l'ordre lisible).
const _ALL = {
  evident: require('./evident'),
  intermediaire: require('./intermediaire'),
  expert: require('./expert'),
};

/** Charge un profil par id et valide ses tells. Throw si l'id est inconnu. */
function loadProfile(id) {
  const p = _ALL[id];
  if (!p) throw new Error(`unknown profile: ${id}`);
  return validateProfile(p);
}

/** Métadonnées sérialisables de tous les profils (pour l'UI formateur + endpoint Python). */
function listProfiles() {
  return Object.values(_ALL).map((p) => ({
    id: p.id, level: p.level, label: p.label, summary: p.summary, tells: p.tells,
  }));
}

module.exports = { validateProfile, loadProfile, listProfiles, _ALL };
