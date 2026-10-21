'use strict';
// DIAGNOSTIC « qui interrompt mes goto ? » : instrumentation PURE, aucun changement de comportement.
//
// Symptôme (live) : les trajets du bot (explore, migration de zone) échouent en < 1 s avec l'erreur
// pathfinder « The goal was changed before it could be completed! » (GoalChanged). Le mécanisme est
// connu — lib/goto.js de mineflayer-pathfinder écoute 'goal_updated' et rejette dès qu'un AUTRE but
// est posé —, le COUPABLE ne l'est pas : 91 `stopMotion()` (→ setGoal(null)), réflexes, unstuck,
// fleeFrom, follow, mineflayer-pvp (qui pose ses propres buts)…
//
// On enveloppe donc `bot.pathfinder.setGoal` (installGoalTrace). À chaque appel on note QUI l'appelle
// (première frame « utile » de la pile V8, cf. callerFromStack) et si l'appel INTERROMPT quelque chose
// (un but est actif ET celui qu'on pose est différent). index.js vide les compteurs toutes les 60 s dans
// un event `goal_trace` :
//   { windowS, top: [{ by, calls, interrupted }, …] }     (top 8 : `interrupted` puis `calls` décroissants)
// → la ligne de tête avec un `interrupted` élevé EST l'appelant qui casse les trajets.
//
// Lecture de `by` :
//   fonction@fichier.js:ligne   appelant dans NOTRE code (`<anonymous>` si la fonction n'a pas de nom)
//   mineflayer-pvp              frame dans node_modules/<lib> : la lib elle-même pose le but
//   (inconnu)                   pile vide/illisible          (autres)   au-delà de MAX_KEYS appelants distincts
//
// Un `bot.pathfinder.goto()` passe lui-même par setGoal (lib/goto.js) : il apparaît sous le nom de la
// fonction qui l'a lancé, avec `interrupted` > 0 s'il remplace un but encore actif. L'appelant BLÂMÉ pour
// un GoalChanged est donc toujours celui qui a posé le NOUVEAU but (ou le null), jamais le goto interrompu.

const UNKNOWN = '(inconnu)';
const OVERFLOW = '(autres)';
// Fichiers 100% passe-plats : jamais « l'appelant ». goalTrace.js = notre propre wrapper ; goalHold.js
// (verrou de but, posé PAR-DESSUS goalTrace depuis le 20/10 — cf. index.js "VERROU DE BUT … posé
// PAR-DESSUS goalTrace") = son `held` relaie INCONDITIONNELLEMENT vers nous (`orig.apply`), donc SA
// frame était systématiquement la première rencontrée → tout s'attribuait à "Object.held@goalHold.js:40"
// quel que soit le vrai appelant (mesuré en prod 21/10, NethBot1/MapBot1 : 100% des lignes `goal_trace`
// pointaient sur goalHold.js). Le diagnostic « qui me vole mon but » (cf. en-tête du fichier) ne disait
// plus rien d'utile depuis cette date.
const PASSTHROUGH_FILES = new Set(['goalTrace.js', 'goalHold.js']);
// Passe-plats vers setGoal(null) : index.js ET skills/branchMine.js ont chacun leur `stopMotion`. Ce qu'on
// veut savoir, c'est QUI l'a appelé (il y en a ~90 sites), pas qu'il a lui-même appelé setGoal.
const SKIP_FUNCTIONS = new Set(['stopMotion']);
// Le pathfinder se déroule lui-même (goto → Promise → setGoal) : l'appelant utile est PLUS HAUT dans la pile.
const SKIP_LIBS = new Set(['mineflayer-pathfinder']);

const TOP_N = 8;                                       // lignes rendues par drain()
const MAX_KEYS = 256;                                  // appelants distincts retenus par fenêtre (borne mémoire)
const DEFAULT_WINDOW_MS = 60000;                       // cadence nominale du drain

const WRAPPED = Symbol.for('mca.goalTrace.wrapped');   // marque anti-double-enveloppe

/** Nom de fichier seul, séparateurs POSIX ou Windows (path.basename dépend de la plateforme). */
function baseOf(file) {
  const s = String(file);
  return s.split(/[\\/]/).filter(Boolean).pop() || s;
}

/**
 * Lib d'un chemin sous node_modules, ou null. La DERNIÈRE occurrence gagne (node_modules imbriqués :
 * `a/node_modules/b/x.js` → b) ; un paquet scopé garde son scope (`@scope/pkg`).
 */
function libOf(file) {
  const norm = String(file).replace(/\\/g, '/');
  const re = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/g;
  let lib = null;
  let m;
  while ((m = re.exec(norm)) !== null) lib = m[1];
  return lib;
}

const LOC_RE = /^(.*?):(\d+)(?::\d+)?$/;               // « fichier:ligne[:colonne] », fichier pouvant contenir « : » (node:events, C:\…)

/**
 * Décompose UNE ligne de pile V8 (`    at fn (fichier:l:c)` ou `    at fichier:l:c` pour une fonction
 * anonyme). Retourne null si ce n'est pas une frame (en-tête « Error: … »). `file` est null pour la
 * plomberie sans emplacement (`new Promise (<anonymous>)`, `Array.forEach (<anonymous>)`, `native`).
 */
function parseFrame(raw) {
  const m = /^\s*at\s+(.+?)\s*$/.exec(raw);
  if (!m) return null;
  let name = '';
  let loc = m[1];
  // « fn (emplacement) » : le nom s'arrête au PREMIER « ( » (un chemin peut contenir des espaces ET des
  // parenthèses, un nom V8 jamais). Sans parenthèses = fonction anonyme, tout le reste est l'emplacement.
  const named = /^(.*?)\s+\((.*)\)$/.exec(loc);
  if (named) { name = named[1]; loc = named[2]; }
  name = name.replace(/\s+\[as [^\]]+\]$/, '').replace(/^async\s+/, '').trim();
  const pos = /^eval at /.test(loc) ? null : LOC_RE.exec(loc);
  return {
    name,
    bare: name.slice(name.lastIndexOf('.') + 1),       // « Object.stopMotion » / « bot.stopMotion » → « stopMotion »
    file: pos ? pos[1] : null,
    line: pos ? Number(pos[2]) : null,
  };
}

/**
 * Extrait de `new Error().stack` QUI a appelé setGoal : la première frame qui n'est ni notre wrapper
 * (goalTrace.js), ni la plomberie V8 sans fichier, ni un passe-plats `stopMotion` (on veut SON appelant),
 * ni le pathfinder lui-même (mineflayer-pathfinder). PURE : ne lit que la chaîne reçue.
 * @param {string} stack
 * @returns {string} `fonction@fichier.js:ligne`, `<lib>` (frame node_modules/<lib>/… : la lib EST
 *   l'appelant, ex. `mineflayer-pvp`), ou `(inconnu)` si rien d'exploitable (jamais d'exception).
 */
function callerFromStack(stack) {
  if (typeof stack !== 'string') return UNKNOWN;
  for (const raw of stack.split(/\r?\n/)) {
    const f = parseFrame(raw);
    if (!f || !f.file) continue;                       // en-tête d'erreur, ou plomberie V8 (new Promise…)
    if (PASSTHROUGH_FILES.has(baseOf(f.file))) continue; // notre wrapper, ou le verrou goalHold posé par-dessus
    if (SKIP_FUNCTIONS.has(f.bare)) continue;          // passe-plats : on veut l'appelant de stopMotion
    const lib = libOf(f.file);
    if (lib) {
      if (SKIP_LIBS.has(lib)) continue;                // le pathfinder se déroule : l'appelant utile est plus haut
      return lib;                                      // autre lib (mineflayer-pvp…) : c'est ELLE qui pose le but
    }
    return `${f.name || '<anonymous>'}@${baseOf(f.file)}:${f.line}`;
  }
  return UNKNOWN;
}

/**
 * Compteurs par appelant sur une fenêtre glissante vidée par drain().
 * @param {object} [opts]
 * @param {()=>number} [opts.now]      horloge injectable (ms) — `windowS` rendu est le temps RÉEL écoulé
 *                                     depuis le dernier drain (ou la création), pas le nominal
 * @param {number} [opts.windowMs]     cadence NOMINALE du drain, exposée en `.windowMs` pour que
 *                                     l'appelant cale son timer dessus (source unique)
 * @returns {{ note: (callerKey: string, interrupted?: boolean) => void,
 *             drain: () => { windowS: number, top: Array<{by: string, calls: number, interrupted: number}> },
 *             windowMs: number }}
 */
function createGoalTrace({ now = Date.now, windowMs = DEFAULT_WINDOW_MS } = {}) {
  let counts = new Map();                              // callerKey → { calls, interrupted }
  let since = now();

  function note(callerKey, interrupted) {
    try {
      let key = (typeof callerKey === 'string' && callerKey) ? callerKey : UNKNOWN;
      // Borne mémoire : au-delà de MAX_KEYS appelants distincts, le surplus se cumule dans « (autres) ».
      if (counts.size >= MAX_KEYS && !counts.has(key)) key = OVERFLOW;
      let e = counts.get(key);
      if (!e) { e = { calls: 0, interrupted: 0 }; counts.set(key, e); }
      e.calls += 1;
      if (interrupted) e.interrupted += 1;
    } catch (e) { /* diagnostic : ne lève jamais */ }
  }

  function drain() {
    const t = now();
    const elapsed = Math.round((t - since) / 1000);
    const rows = [];
    for (const [by, e] of counts) rows.push({ by, calls: e.calls, interrupted: e.interrupted });
    // Tri total et déterministe : interrompus d'abord, puis volume, puis ordre alphabétique.
    rows.sort((a, b) => (b.interrupted - a.interrupted) || (b.calls - a.calls) || (a.by < b.by ? -1 : a.by > b.by ? 1 : 0));
    counts = new Map();
    since = t;
    return { windowS: Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0, top: rows.slice(0, TOP_N) };
  }

  return { note, drain, windowMs };
}

/**
 * Enveloppe `pathfinder.setGoal` : avant l'appel original on note l'appelant et si le nouveau but
 * INTERROMPT un but actif (`pathfinder.goal` posé ET différent de celui qu'on pose — `setGoal(null)` sur
 * un but actif en est donc une). Puis on appelle l'original avec les mêmes arguments, le même `this`, et
 * on rend sa valeur de retour telle quelle. Toute l'instrumentation est sous try/catch : elle ne peut
 * JAMAIS casser setGoal. Idempotent (marque Symbol sur le wrapper).
 * @param {{setGoal: Function, goal?: *}} pathfinder — `bot.pathfinder`
 * @param {{note: Function}} trace
 * @returns {boolean} true si le wrapper vient d'être posé (false : déjà posé, ou rien à envelopper)
 */
function installGoalTrace(pathfinder, trace) {
  try {
    if (!pathfinder || !trace || typeof trace.note !== 'function') return false;
    const original = pathfinder.setGoal;
    if (typeof original !== 'function' || original[WRAPPED]) return false;
    // Le wrapper vit dans CE fichier : sa frame est écartée par la règle OWN_FILE de callerFromStack,
    // sans dépendre du nom que V8 lui donnerait.
    const traced = function setGoalTraced(...args) {
      try {
        const prev = pathfinder.goal;
        trace.note(callerFromStack(new Error().stack), !!prev && args[0] !== prev);
      } catch (e) { /* l'instrumentation ne casse JAMAIS setGoal */ }
      return original.apply(this, args);
    };
    traced[WRAPPED] = true;
    pathfinder.setGoal = traced;
    return true;
  } catch (e) {
    return false;                                      // propriété non inscriptible, objet gelé… : pas de trace, pas de dégât
  }
}

module.exports = {
  createGoalTrace, installGoalTrace, callerFromStack,
  TOP_N, MAX_KEYS, DEFAULT_WINDOW_MS, UNKNOWN, OVERFLOW,
};
