# MC Agent — Phase 1 (profils calibrés) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Donner au bot Minecraft d'entraînement (a) des **skills supplémentaires sur commande** (miner/bois, attaquer, fuir), (b) des **réflexes déterministes** (manger, se défendre) sans appel LLM, et (c) **3 profils de comportement calibrés** (Évident / Intermédiaire / Expert) — chacun livré avec sa **fiche de tells documentée non vide** (le corrigé du formateur), exposée dans l'UI admin.

**Architecture :** Le corps Node/Mineflayer existant (Phase 0) est étendu de 3 axes : un module `profiles/` (data + invariant tells non-vide validé à la construction), un module `humanize.js` (réalisme **paramétré** §7.1 : latence tirée d'une distribution, fautes de frappe, taux d'erreur — JAMAIS de clonage d'un vrai joueur), et de nouveaux skills/réflexes. Le profil sélectionné est injecté dans le system prompt de `brain.js` et module le post-traitement des réponses dans `index.js`. Côté Python, le manager passe `--profile` au subprocess et expose la liste des profils + leurs tells via un petit binaire Node (`bin/list-profiles.js`) — **source unique = les fichiers `profiles/*.js`**. Le frontend ajoute un sélecteur de profil et un panneau « fiche de tells ».

**Tech Stack :** Node 22 (`mineflayer`, `mineflayer-pathfinder`, `mineflayer-pvp`, `mineflayer-collectblock`, `@anthropic-ai/sdk`, test runner natif `node:test`), Python 3.9 (FastAPI, pytest), Vanilla JS frontend.

**Référence spec :** `docs/superpowers/specs/2026-05-29-mc-agent-training-design.md` (§6 skills, §7 profils + modèle de difficulté, §7.1 réalisme paramétré).

**⚠️ Garde-fous projet (de la spec, NON négociables) :**
- **Invariant tells (§2)** : chaque profil DOIT déclarer un `tells: [...]` **non vide**. Un profil sans tells est **rejeté à la construction** (test dédié). « Le bot finira par faire une erreur » n'est pas un tell valide.
- **Réalisme = paramétré, jamais cloné (§7.1)** : le réalisme du tier Expert vient de modèles paramétrés contrôlés par le formateur (distributions, jitter, taux d'erreur). La **capture/imitation des inputs d'un vrai joueur (behavioral cloning) est HORS de ce plan** → plan séparé `phase1b` avec cadrage consentement.
- **Ground-truth actif** : l'admin sait quel joueur est le bot ; la fiche de tells est le corrigé.
- Repo **auto-deploy sur `main`** (cron git pull + restart). On travaille sur la branche **`feat/mc-agent-phase1`**. Ne JAMAIS pusher sur `main` pendant le dev, et ne JAMAIS pusher pendant qu'une session bot tourne.

---

## File Structure

**Node — `mc-agent/` (extension du projet Phase 0) :**

| Fichier | Responsabilité |
|---|---|
| `mc-agent/package.json` | + deps `mineflayer-pvp`, `mineflayer-collectblock` |
| `mc-agent/profiles/evident.js` | Profil niveau 1 (data : id/level/label/persona/params/**tells**) |
| `mc-agent/profiles/intermediaire.js` | Profil niveau 2 |
| `mc-agent/profiles/expert.js` | Profil niveau 3 (réalisme paramétré, tells non statistiques) |
| `mc-agent/profiles/index.js` | `validateProfile` (invariant tells), `loadProfile`, `listProfiles` |
| `mc-agent/humanize.js` | `sampleDelay`, `applyTypos`, `humanizeReply` (réalisme paramétré §7.1) |
| `mc-agent/skills/mineBlock.js` | `mineBlock(bot,{name,count})`, `collectWood(bot,{count})` |
| `mc-agent/skills/attackNearest.js` | `attackNearest(bot)` (mineflayer-pvp) |
| `mc-agent/skills/fleeFrom.js` | `fleeFrom(bot)` (pathfinder GoalInvert) |
| `mc-agent/reflexes.js` | `tryEat`, `shouldFlee`, `installReflexes` (réflexes zéro-LLM) |
| `mc-agent/brain.js` | + `buildSystemPrompt(profile)` ; `think()` accepte `profile` |
| `mc-agent/index.js` | + charge `--profile`, plugins pvp/collectblock, réflexes, humanize, nouveaux skills |
| `mc-agent/bin/list-profiles.js` | imprime `JSON.stringify(listProfiles())` sur stdout (consommé par Python) |
| `mc-agent/test/*.test.js` | tests unitaires (node:test) |

**Python — `backend/bots/` :**

| Fichier | Responsabilité |
|---|---|
| `backend/bots/mc_agent_manager.py` | + param `profile` à `start_session` ; + `list_profiles()` (appelle `bin/list-profiles.js`) |
| `backend/bots/mc_agent_router.py` | + `GET /api/mc-agent/profiles` ; + champ `profile` dans `StartReq` |
| `backend/bots/tests/test_mc_agent_manager.py` | + tests profile/list_profiles |
| `backend/bots/tests/test_mc_agent_router.py` | + tests endpoint /profiles + run avec profile |

**Frontend :**

| Fichier | Responsabilité |
|---|---|
| `frontend/js/bots_module.js` | + `<select>` profil dans `openMCAgent`, panneau fiche-de-tells, `loadMCAgentProfiles()`, `renderMCAgentTells()`, profile dans `startMCAgent` |
| `frontend/js/lang.js` | clés `mcagent.profile*`, `mcagent.tells*` (FR/EN/IT) |
| `frontend/index.html` | bump `?v=` de bots_module.js + lang.js |
| `frontend/sw.js` | bump `CACHE_NAME` |

---

## Task 0 : Branche de travail & dépendances Node

**Files :** `mc-agent/package.json`

- [ ] **Step 1 : Créer la branche de travail**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur"
git checkout -b feat/mc-agent-phase1
```
Expected : `Switched to a new branch 'feat/mc-agent-phase1'`

- [ ] **Step 2 : Vérifier que la baseline Phase 0 est verte (point de départ sain)**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/mc-agent" && npm test 2>&1 | tail -3
cd "/Users/massimiliano/omenserver Project/Projet serveur" && source venv/bin/activate && python -m pytest backend/bots/tests/ -q 2>&1 | tail -2
```
Expected : Node `# pass 18` (ou plus), Python `21 passed`.

- [ ] **Step 3 : Installer les 2 plugins Mineflayer de la Phase 1**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/mc-agent" && npm install mineflayer-pvp@^1.6.2 mineflayer-collectblock@^1.6.0
```
Expected : `added N packages`. (auto-eat non installé : le réflexe « manger » est codé maison dans `reflexes.js` pour rester testable sans dépendance fragile.)

- [ ] **Step 4 : Vérifier que `package.json` liste bien les 2 nouvelles deps**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur" && grep -E "mineflayer-pvp|mineflayer-collectblock" mc-agent/package.json
```
Expected : 2 lignes (les deux deps présentes).

- [ ] **Step 5 : Commit du point de départ (plan + lock deps)**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur"
git add docs/superpowers/plans/2026-05-29-mc-agent-phase1.md docs/superpowers/specs/2026-05-29-mc-agent-training-design.md mc-agent/package.json mc-agent/package-lock.json
git commit -m "docs(mc-agent): plan Phase 1 + spec maj + deps pvp/collectblock"
```

---

## Task 1 : `profiles/index.js` — invariant tells + chargeur

**Files :**
- Create : `mc-agent/profiles/index.js`
- Test : `mc-agent/test/profiles.test.js`

> Note : ce module est écrit AVANT les 3 profils concrets. Les tests utilisent des profils factices en ligne pour isoler la logique de validation/chargement.

- [ ] **Step 1 : Écrire le test qui échoue**

`mc-agent/test/profiles.test.js` :
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { validateProfile } = require('../profiles');

const ok = { id: 'x', level: 1, label: 'X', persona: 'p', params: {}, tells: ['un tell'] };

test('validateProfile accepte un profil avec tells non vide', () => {
  assert.strictEqual(validateProfile(ok), ok);
});

test('validateProfile rejette un profil sans tells (invariant §2)', () => {
  assert.throws(() => validateProfile({ ...ok, tells: [] }), /tells/);
  assert.throws(() => validateProfile({ ...ok, tells: undefined }), /tells/);
});

test('validateProfile rejette un objet invalide ou sans id', () => {
  assert.throws(() => validateProfile(null), /object/);
  assert.throws(() => validateProfile({ ...ok, id: undefined }), /id/);
});
```

- [ ] **Step 2 : Lancer → échec attendu**

Run : `cd mc-agent && node --test test/profiles.test.js`
Expected : FAIL (`Cannot find module '../profiles'`)

- [ ] **Step 3 : Implémenter `mc-agent/profiles/index.js`**

```js
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
```

> À ce stade, `_ALL` require des fichiers qui n'existent pas encore → ce module **plante au require**. Le test de Step 1 ne touche que `validateProfile`, donc on isole : les `require('./evident')` etc. seront satisfaits à la Task 2. **Pour faire passer Step 4 maintenant**, créer 3 stubs temporaires :

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/mc-agent" && \
for p in evident intermediaire expert; do echo "'use strict'; module.exports = { id: '$p', level: 1, label: '$p', persona: '', params: {}, tells: ['stub'] };" > profiles/$p.js; done
```
(Ces stubs sont remplacés par les vrais profils en Task 2.)

- [ ] **Step 4 : Lancer → succès attendu**

Run : `cd mc-agent && node --test test/profiles.test.js`
Expected : `# pass 3`

- [ ] **Step 5 : Commit**

```bash
git add mc-agent/profiles/index.js mc-agent/profiles/evident.js mc-agent/profiles/intermediaire.js mc-agent/profiles/expert.js mc-agent/test/profiles.test.js
git commit -m "feat(mc-agent): profils — invariant tells non-vide + chargeur (TDD)"
```

---

## Task 2 : Les 3 profils concrets (Évident / Intermédiaire / Expert)

**Files :**
- Modify : `mc-agent/profiles/evident.js`, `intermediaire.js`, `expert.js` (remplace les stubs)
- Test : `mc-agent/test/profiles_concrete.test.js`

- [ ] **Step 1 : Écrire le test qui échoue**

`mc-agent/test/profiles_concrete.test.js` :
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { listProfiles, loadProfile } = require('../profiles');

test('les 3 profils existent, niveaux 1/2/3', () => {
  const ids = listProfiles().map((p) => p.id).sort();
  assert.deepStrictEqual(ids, ['evident', 'expert', 'intermediaire']);
  assert.deepStrictEqual(listProfiles().map((p) => p.level).sort(), [1, 2, 3]);
});

test('chaque profil a une fiche de tells non vide (corrigé)', () => {
  for (const p of listProfiles()) {
    assert.ok(Array.isArray(p.tells) && p.tells.length >= 1, `${p.id} sans tells`);
    assert.ok(p.tells.every((t) => typeof t === 'string' && t.length > 8));
  }
});

test('le réalisme MONTE avec le niveau (latence + variance + taux d erreur)', () => {
  const ev = loadProfile('evident').params;
  const ex = loadProfile('expert').params;
  assert.ok(ex.chat.latencyStdMs > ev.chat.latencyStdMs); // plus de variance = plus humain
  assert.ok(ex.errorRate > ev.errorRate);                  // plus d'erreurs volontaires
  assert.ok(ev.chat.typoRate === 0);                       // niveau 1 = pas de faute
});

test('le profil Expert a des tells NON statistiques (raisonnement/social/inédit)', () => {
  const joined = loadProfile('expert').tells.join(' ').toLowerCase();
  assert.ok(/raisonnement|social|in[ée]dit|inter-session|contextuel/.test(joined));
});
```

- [ ] **Step 2 : Lancer → échec attendu**

Run : `cd mc-agent && node --test test/profiles_concrete.test.js`
Expected : FAIL (stubs : mêmes level=1, pas de params.chat, tells='stub')

- [ ] **Step 3 : Écrire les 3 profils réels**

`mc-agent/profiles/evident.js` :
```js
'use strict';
// Niveau 1 — Évident. Tells gros et immédiats : staff débutant.
module.exports = {
  id: 'evident',
  level: 1,
  label: 'Évident',
  summary: 'Timing métronomique, pathing parfait, réponses répétitives, farming en boucle.',
  persona: [
    'Tu joues de façon très mécanique et régulière, presque robotique.',
    'Tes réponses au chat sont courtes, répétitives et interchangeables.',
  ].join(' '),
  params: {
    chat: { latencyMeanMs: 200, latencyStdMs: 30, typoRate: 0 },
    errorRate: 0,
    movementJitter: 0,
  },
  tells: [
    'Timing métronomique : réagit toujours en ~0,2 s, sans aucune variation humaine.',
    'Réponses de chat répétitives et interchangeables d\'un message à l\'autre.',
    'Pathing parfait : jamais d\'hésitation, de demi-tour ni de saut inutile.',
    'Farming en boucle visible, sans aucune pause spontanée.',
  ],
};
```

`mc-agent/profiles/intermediaire.js` :
```js
'use strict';
// Niveau 2 — Intermédiaire. Jitter humain ; tells = régularité statistique sur la durée.
module.exports = {
  id: 'intermediaire',
  level: 2,
  label: 'Intermédiaire',
  summary: 'Pauses variables, micro-erreurs de path, fautes de frappe, réactivité plus lente.',
  persona: [
    'Tu joues comme un humain correct : tu fais des pauses, tu hésites parfois.',
    'Tu écris de façon naturelle avec de rares fautes de frappe, et tu mets un peu de temps à répondre.',
  ].join(' '),
  params: {
    chat: { latencyMeanMs: 1100, latencyStdMs: 450, typoRate: 0.04 },
    errorRate: 0.05,
    movementJitter: 0.15,
  },
  tells: [
    'Régularité statistique sur la durée : la variance de ses temps de réaction reste trop stable.',
    'N\'est jamais AFK « humainement » : pas de vraies absences ni de distractions.',
    'Réaction étrange ou hors-sujet face à une question ouverte et personnelle.',
    'Les micro-erreurs de pathing suivent un motif répétable, pas une vraie maladresse.',
  ],
};
```

`mc-agent/profiles/expert.js` :
```js
'use strict';
// Niveau 3 — Expert. Réalisme PARAMÉTRÉ (§7.1) conçu pour passer un détecteur de
// micro-répétitivité. Tells NON statistiques : raisonnement, social, inédit, inter-session.
module.exports = {
  id: 'expert',
  level: 3,
  label: 'Expert',
  summary: 'Timing tiré d\'une distribution humaine, jitter, taux d\'erreur — quasi indétectable au stat.',
  persona: [
    'Tu joues de façon très crédible : ton timing, tes pauses et tes fautes varient naturellement.',
    'Si on te demande si tu es un bot ou qu\'on te pose un défi « es-tu humain ? », tu restes',
    'naturel et évasif comme le ferait un vrai joueur agacé, sans te trahir.',
    'Mais tu n\'as pas de vrai vécu : sur une question de raisonnement inédit ou de culture',
    'sociale/méta-jeu, tu peux répondre à côté.',
  ].join(' '),
  params: {
    chat: { latencyMeanMs: 2200, latencyStdMs: 1300, typoRate: 0.07 },
    errorRate: 0.12,
    movementJitter: 0.30,
  },
  tells: [
    'Échec sur un raisonnement contextuel inédit (énigme/situation jamais vue, pas googlable).',
    'Trou de connaissance sociale ou méta-jeu (références de la communauté, events récents du serveur).',
    'Réaction atypique à un événement unique et imprévu (pas de surprise ni d\'émotion cohérente).',
    'Incohérence inter-session : ne se souvient pas de ce qu\'il « a vécu » lors d\'une session précédente.',
  ],
};
```

- [ ] **Step 4 : Lancer → succès attendu (profils + invariant)**

Run : `cd mc-agent && node --test test/profiles.test.js test/profiles_concrete.test.js`
Expected : `# pass 7`

- [ ] **Step 5 : Commit**

```bash
git add mc-agent/profiles/evident.js mc-agent/profiles/intermediaire.js mc-agent/profiles/expert.js mc-agent/test/profiles_concrete.test.js
git commit -m "feat(mc-agent): 3 profils calibrés (Évident/Intermédiaire/Expert) + fiches de tells"
```

---

## Task 3 : `humanize.js` — réalisme paramétré (latence + fautes)

**Files :**
- Create : `mc-agent/humanize.js`
- Test : `mc-agent/test/humanize.test.js`

- [ ] **Step 1 : Écrire le test qui échoue**

`mc-agent/test/humanize.test.js` :
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { sampleDelay, applyTypos, humanizeReply } = require('../humanize');

// rng déterministe : séquence rejouable
function seqRng(values) { let i = 0; return () => values[i++ % values.length]; }

test('sampleDelay reste borné (>= 80ms) même avec rng extrême', () => {
  const params = { chat: { latencyMeanMs: 1000, latencyStdMs: 400 } };
  const d = sampleDelay(params, seqRng([0.999999, 0.5])); // pousse z très négatif
  assert.ok(d >= 80, `delay ${d} < 80`);
  assert.ok(Number.isInteger(d));
});

test('applyTypos rate=0 ne touche pas le texte', () => {
  assert.strictEqual(applyTypos('bonjour les amis', 0, Math.random), 'bonjour les amis');
});

test('applyTypos rate=1 modifie le texte', () => {
  const out = applyTypos('bonjour', 1, seqRng([0.0, 0.9]));
  assert.notStrictEqual(out, 'bonjour');
});

test('humanizeReply retourne {text, delayMs}', () => {
  const profile = { params: { chat: { latencyMeanMs: 500, latencyStdMs: 100, typoRate: 0 } } };
  const r = humanizeReply(profile, 'salut', seqRng([0.5, 0.5]));
  assert.strictEqual(r.text, 'salut');
  assert.ok(typeof r.delayMs === 'number' && r.delayMs >= 80);
});

test('humanizeReply tolère un profil null (defaults)', () => {
  const r = humanizeReply(null, 'x', seqRng([0.5, 0.5]));
  assert.ok(r.delayMs >= 80 && r.text === 'x');
});
```

- [ ] **Step 2 : Lancer → échec attendu**

Run : `cd mc-agent && node --test test/humanize.test.js`
Expected : FAIL (`Cannot find module '../humanize'`)

- [ ] **Step 3 : Implémenter `mc-agent/humanize.js`**

```js
'use strict';
// Réalisme PARAMÉTRÉ (spec §7.1) : transforme une réponse « parfaite » en réponse d'apparence
// humaine via des modèles contrôlés par le formateur (distribution, taux de faute).
// JAMAIS de clonage d'un vrai joueur — c'est une signature analysable, pas une imitation.

/** Échantillonne un temps de réaction (ms) depuis une normale (Box-Muller), tronqué. */
function sampleDelay(params, rng = Math.random) {
  const chat = (params && params.chat) || {};
  const mean = chat.latencyMeanMs == null ? 800 : chat.latencyMeanMs;
  const std = chat.latencyStdMs == null ? 300 : chat.latencyStdMs;
  const u1 = Math.max(rng(), 1e-9);
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const ms = mean + z * std;
  // borné : jamais < 80ms (réflexe humain mini), jamais > mean + 3*std (anti-traîne)
  return Math.round(Math.min(Math.max(ms, 80), mean + 3 * std));
}

/** Insère occasionnellement des fautes de frappe (taux paramétré). 0 = aucune. */
function applyTypos(text, rate = 0, rng = Math.random) {
  if (!text || rate <= 0) return text;
  const chars = String(text).split('');
  for (let i = 0; i < chars.length; i++) {
    if (!/[a-zA-Zàâéèêëîïôûùç]/.test(chars[i])) continue;
    if (rng() >= rate) continue;
    if (i + 1 < chars.length && rng() < 0.5) {
      const t = chars[i]; chars[i] = chars[i + 1]; chars[i + 1] = t; i++; // inversion
    } else {
      chars[i] = ''; // omission
    }
  }
  return chars.join('');
}

/** Post-traite la réponse selon le profil → { text (avec fautes), delayMs (latence humaine) }. */
function humanizeReply(profile, reply, rng = Math.random) {
  const params = (profile && profile.params) || {};
  const typoRate = (params.chat && params.chat.typoRate) || 0;
  return {
    text: applyTypos(String(reply == null ? '' : reply), typoRate, rng),
    delayMs: sampleDelay(params, rng),
  };
}

module.exports = { sampleDelay, applyTypos, humanizeReply };
```

- [ ] **Step 4 : Lancer → succès attendu**

Run : `cd mc-agent && node --test test/humanize.test.js`
Expected : `# pass 5`

- [ ] **Step 5 : Commit**

```bash
git add mc-agent/humanize.js mc-agent/test/humanize.test.js
git commit -m "feat(mc-agent): humanize — réalisme paramétré (latence distribuée + fautes)"
```

---

## Task 4 : `brain.js` — injection du profil dans le system prompt

**Files :**
- Modify : `mc-agent/brain.js`
- Test : `mc-agent/test/brain_profile.test.js`

- [ ] **Step 1 : Écrire le test qui échoue**

`mc-agent/test/brain_profile.test.js` :
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildSystemPrompt, think, SYSTEM_PROMPT } = require('../brain');

test('buildSystemPrompt(null) retourne le prompt de base (JSON + actions)', () => {
  const p = buildSystemPrompt(null);
  assert.match(p, /JSON/);
  assert.match(p, /follow|goto/);
});

test('buildSystemPrompt injecte la persona du profil', () => {
  const profile = { id: 'expert', persona: 'TU_ES_UN_JOUEUR_CREDIBLE_XYZ' };
  assert.match(buildSystemPrompt(profile), /TU_ES_UN_JOUEUR_CREDIBLE_XYZ/);
});

test('buildSystemPrompt liste les nouveaux skills (mineBlock/attackNearest/fleeFrom)', () => {
  const p = buildSystemPrompt(null);
  assert.match(p, /mineBlock/);
  assert.match(p, /attackNearest/);
  assert.match(p, /fleeFrom/);
});

test('think transmet le system prompt enrichi par le profil au client', async () => {
  let capturedSystem = null;
  const client = { messages: { create: async (opts) => { capturedSystem = opts.system; return { content: [{ type: 'text', text: '{"reply":"ok"}' }] }; } } };
  const profile = { id: 'expert', persona: 'PERSONA_MARKER_42' };
  await think(client, { state: {}, message: 'hi', model: 'm', limiter: null, profile });
  assert.match(capturedSystem, /PERSONA_MARKER_42/);
});
```

- [ ] **Step 2 : Lancer → échec attendu**

Run : `cd mc-agent && node --test test/brain_profile.test.js`
Expected : FAIL (`buildSystemPrompt is not a function` ; `mineBlock` absent du prompt)

- [ ] **Step 3 : Modifier `mc-agent/brain.js`**

Remplacer le bloc `const SYSTEM_PROMPT = [...]` (lignes 35-40) par :
```js
const ACTIONS_DOC =
  'Actions possibles : "follow" {player}, "goto" {x,y,z}, "mineBlock" {name,count}, ' +
  '"collectWood" {count}, "attackNearest" {}, "fleeFrom" {}, ou null (juste parler).';

// Prompt de base (profil null). Conservé comme export pour compat (tests Phase 0).
const SYSTEM_PROMPT = [
  "Tu incarnes un joueur dans une partie Minecraft, dans un cadre d'entrainement de moderation (un bot d'exercice).",
  'Reponds UNIQUEMENT en JSON : {"reply": string, "action": string|null, "args": object}.',
  ACTIONS_DOC,
].join(' ');

/** Construit le system prompt en injectant la persona du profil (réalisme §7.1). */
function buildSystemPrompt(profile) {
  if (!profile) return SYSTEM_PROMPT;
  return [
    "Tu incarnes un joueur dans une partie Minecraft (cadre d'entrainement de moderation).",
    profile.persona || '',
    'Reponds UNIQUEMENT en JSON : {"reply": string, "action": string|null, "args": object}.',
    ACTIONS_DOC,
  ].filter(Boolean).join(' ');
}
```

Dans `think(...)`, remplacer la signature et le champ `system` :
```js
async function think(client, { state, message, model, limiter, profile = null }) {
  if (limiter && !limiter.tryAcquire()) return null;
  const resp = await client.messages.create({
    model,
    max_tokens: 300,
    system: buildSystemPrompt(profile),
    messages: [{ role: 'user', content: `Etat: ${JSON.stringify(state)}\nMessage recu: ${message}` }],
  });
  const text = (resp.content || []).map((b) => b.text || '').join('');
  return parseDecision(text);
}
```

Et l'export final :
```js
module.exports = { parseDecision, RateLimiter, think, SYSTEM_PROMPT, buildSystemPrompt };
```

- [ ] **Step 4 : Lancer → succès attendu (brain complet, dont tests Phase 0)**

Run : `cd mc-agent && node --test test/brain_parse.test.js test/brain_think.test.js test/brain_profile.test.js`
Expected : `# pass 11` (4 parse + 3 think Phase 0 + 4 profile). Les tests Phase 0 restent verts : `SYSTEM_PROMPT` contient toujours « bot » et « JSON ».

- [ ] **Step 5 : Commit**

```bash
git add mc-agent/brain.js mc-agent/test/brain_profile.test.js
git commit -m "feat(mc-agent): brain — injection persona profil + actions étendues dans le prompt"
```

---

## Task 5 : Skill `mineBlock` / `collectWood`

**Files :**
- Create : `mc-agent/skills/mineBlock.js`
- Test : `mc-agent/test/mineBlock.test.js`

- [ ] **Step 1 : Écrire le test qui échoue**

`mc-agent/test/mineBlock.test.js` :
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { mineBlock, collectWood } = require('../skills/mineBlock');

function fakeBot({ found = true } = {}) {
  const calls = { collected: [], chat: [], findArgs: [] };
  return {
    calls,
    registry: { blocksByName: { oak_log: { id: 17 }, stone: { id: 1 } } },
    findBlock(opts) { calls.findArgs.push(opts); return found ? { position: { x: 1, y: 2, z: 3 } } : null; },
    chat(m) { calls.chat.push(m); },
    collectBlock: { async collect(b) { calls.collected.push(b); } },
  };
}

test('mineBlock exige un nom de bloc', async () => {
  await assert.rejects(mineBlock(fakeBot(), {}), /name/);
});

test('mineBlock collecte le bloc trouvé et retourne true', async () => {
  const bot = fakeBot({ found: true });
  const ok = await mineBlock(bot, { name: 'oak_log' });
  assert.strictEqual(ok, true);
  assert.strictEqual(bot.calls.collected.length, 1);
});

test('mineBlock prévient et retourne false si le bloc est introuvable', async () => {
  const bot = fakeBot({ found: false });
  const ok = await mineBlock(bot, { name: 'oak_log' });
  assert.strictEqual(ok, false);
  assert.strictEqual(bot.calls.chat.length, 1);
});

test('collectWood cherche un type de bûche et collecte', async () => {
  const bot = fakeBot({ found: true });
  const ok = await collectWood(bot, { count: 3 });
  assert.strictEqual(ok, true);
  assert.ok(bot.calls.collected.length >= 1);
});
```

- [ ] **Step 2 : Lancer → échec attendu**

Run : `cd mc-agent && node --test test/mineBlock.test.js`
Expected : FAIL (`Cannot find module '../skills/mineBlock'`)

- [ ] **Step 3 : Implémenter `mc-agent/skills/mineBlock.js`**

```js
'use strict';
// Mine/ramasse un bloc via mineflayer-collectblock (gère pathfinding + dig).

const WOOD_TYPES = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log'];

/** Résout les ids d'un nom de bloc via le registry minecraft-data chargé par mineflayer. */
function _blockIds(bot, name) {
  const def = bot.registry && bot.registry.blocksByName && bot.registry.blocksByName[name];
  return def ? [def.id] : null;
}

/** Mine le bloc le plus proche du type `name`. Retourne false (et prévient) si introuvable. */
async function mineBlock(bot, { name, count = 1 } = {}) {
  if (!name) throw new Error('mineBlock requires a block name');
  for (let i = 0; i < count; i++) {
    const block = bot.findBlock({ matching: _blockIds(bot, name), maxDistance: 48 });
    if (!block) {
      if (i === 0) { bot.chat(`je ne trouve pas de ${name}`); return false; }
      break; // déjà ramassé au moins 1 : on s'arrête sans râler
    }
    await bot.collectBlock.collect(block);
  }
  return true;
}

/** Ramasse du bois : essaie chaque essence connue jusqu'à en trouver une. */
async function collectWood(bot, { count = 1 } = {}) {
  for (const wood of WOOD_TYPES) {
    const block = bot.findBlock({ matching: _blockIds(bot, wood), maxDistance: 48 });
    if (block) return mineBlock(bot, { name: wood, count });
  }
  bot.chat('je ne vois pas de bois autour');
  return false;
}

module.exports = { mineBlock, collectWood, WOOD_TYPES };
```

- [ ] **Step 4 : Lancer → succès attendu**

Run : `cd mc-agent && node --test test/mineBlock.test.js`
Expected : `# pass 4`

- [ ] **Step 5 : Commit**

```bash
git add mc-agent/skills/mineBlock.js mc-agent/test/mineBlock.test.js
git commit -m "feat(mc-agent): skill mineBlock/collectWood (collectblock, TDD)"
```

---

## Task 6 : Skill `attackNearest`

**Files :**
- Create : `mc-agent/skills/attackNearest.js`
- Test : `mc-agent/test/attackNearest.test.js`

- [ ] **Step 1 : Écrire le test qui échoue**

`mc-agent/test/attackNearest.test.js` :
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { attackNearest } = require('../skills/attackNearest');

function fakeBot({ entity = null } = {}) {
  const calls = { attacked: [], chat: [] };
  return {
    calls,
    nearestEntity(pred) { return (entity && pred(entity)) ? entity : null; },
    pvp: { attack(e) { calls.attacked.push(e); } },
    chat(m) { calls.chat.push(m); },
  };
}

test('attackNearest attaque un mob hostile proche et retourne true', () => {
  const zombie = { type: 'mob', name: 'zombie', kind: 'Hostile mobs' };
  const bot = fakeBot({ entity: zombie });
  assert.strictEqual(attackNearest(bot), true);
  assert.strictEqual(bot.calls.attacked[0], zombie);
});

test('attackNearest prévient et retourne false si rien à attaquer', () => {
  const bot = fakeBot({ entity: null });
  assert.strictEqual(attackNearest(bot), false);
  assert.strictEqual(bot.calls.chat.length, 1);
});
```

- [ ] **Step 2 : Lancer → échec attendu**

Run : `cd mc-agent && node --test test/attackNearest.test.js`
Expected : FAIL (`Cannot find module '../skills/attackNearest'`)

- [ ] **Step 3 : Implémenter `mc-agent/skills/attackNearest.js`**

```js
'use strict';
// Attaque l'entité hostile la plus proche via mineflayer-pvp (approche + frappe en boucle).

/** Attaque le mob hostile le plus proche (fallback : n'importe quel mob). False si rien. */
function attackNearest(bot) {
  let victim = bot.nearestEntity((e) => e && e.type === 'mob' && e.kind === 'Hostile mobs');
  if (!victim) victim = bot.nearestEntity((e) => e && e.type === 'mob');
  if (!victim) { bot.chat('rien a attaquer ici'); return false; }
  bot.pvp.attack(victim);
  return true;
}

module.exports = { attackNearest };
```

- [ ] **Step 4 : Lancer → succès attendu**

Run : `cd mc-agent && node --test test/attackNearest.test.js`
Expected : `# pass 2`

- [ ] **Step 5 : Commit**

```bash
git add mc-agent/skills/attackNearest.js mc-agent/test/attackNearest.test.js
git commit -m "feat(mc-agent): skill attackNearest (pvp, TDD)"
```

---

## Task 7 : Skill `fleeFrom`

**Files :**
- Create : `mc-agent/skills/fleeFrom.js`
- Test : `mc-agent/test/fleeFrom.test.js`

- [ ] **Step 1 : Écrire le test qui échoue**

`mc-agent/test/fleeFrom.test.js` :
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { fleeFrom } = require('../skills/fleeFrom');

function fakeBot({ threat = null } = {}) {
  const calls = { goals: [] };
  return {
    calls,
    entity: { position: { x: 0, y: 64, z: 0 } },
    nearestEntity(pred) { return (threat && pred(threat)) ? threat : null; },
    pathfinder: { setGoal(g, dyn) { calls.goals.push({ g, dyn }); } },
  };
}

test('fleeFrom pose un goal de fuite et retourne true si menace présente', () => {
  const creeper = { type: 'mob', name: 'creeper', position: { x: 2, y: 64, z: 0 } };
  const bot = fakeBot({ threat: creeper });
  assert.strictEqual(fleeFrom(bot), true);
  assert.strictEqual(bot.calls.goals.length, 1);
  assert.strictEqual(bot.calls.goals[0].dyn, true);
});

test('fleeFrom retourne false si aucune menace', () => {
  assert.strictEqual(fleeFrom(fakeBot({ threat: null })), false);
});
```

- [ ] **Step 2 : Lancer → échec attendu**

Run : `cd mc-agent && node --test test/fleeFrom.test.js`
Expected : FAIL (`Cannot find module '../skills/fleeFrom'`)

- [ ] **Step 3 : Implémenter `mc-agent/skills/fleeFrom.js`**

```js
'use strict';
const { goals } = require('mineflayer-pathfinder');
// Fuit la menace la plus proche en posant un GoalInvert (s'éloigner d'un rayon autour d'elle).

/** Fait fuir le bot loin du mob le plus proche. Retourne false s'il n'y a aucune menace. */
function fleeFrom(bot) {
  const threat = bot.nearestEntity((e) => e && e.type === 'mob' && e.position);
  if (!threat) return false;
  const { x, y, z } = threat.position;
  // GoalInvert(GoalNear) = « éloigne-toi d'au moins 16 blocs de ce point » ; dynamique = recalcule.
  bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalNear(x, y, z, 16)), true);
  return true;
}

module.exports = { fleeFrom };
```

- [ ] **Step 4 : Lancer → succès attendu**

Run : `cd mc-agent && node --test test/fleeFrom.test.js`
Expected : `# pass 2`

- [ ] **Step 5 : Commit**

```bash
git add mc-agent/skills/fleeFrom.js mc-agent/test/fleeFrom.test.js
git commit -m "feat(mc-agent): skill fleeFrom (pathfinder GoalInvert, TDD)"
```

---

## Task 8 : `reflexes.js` — réflexes zéro-LLM (manger + se défendre)

**Files :**
- Create : `mc-agent/reflexes.js`
- Test : `mc-agent/test/reflexes.test.js`

- [ ] **Step 1 : Écrire le test qui échoue**

`mc-agent/test/reflexes.test.js` :
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { tryEat, shouldFlee, installReflexes } = require('../reflexes');

function fakeBot({ food = 20, health = 20, hasFood = true, threat = null } = {}) {
  const calls = { equipped: [], consumed: 0, handlers: {} };
  return {
    calls, food, health,
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: { items() { return hasFood ? [{ name: 'bread' }] : []; } },
    async equip(item, dest) { calls.equipped.push({ item, dest }); },
    async consume() { calls.consumed++; },
    nearestEntity(pred) { return (threat && pred(threat)) ? threat : null; },
    on(evt, cb) { calls.handlers[evt] = cb; },
  };
}

test('tryEat mange si faim basse ET nourriture en inventaire', async () => {
  const bot = fakeBot({ food: 5, hasFood: true });
  assert.strictEqual(await tryEat(bot), true);
  assert.strictEqual(bot.calls.consumed, 1);
});

test('tryEat ne fait rien si rassasié', async () => {
  const bot = fakeBot({ food: 20 });
  assert.strictEqual(await tryEat(bot), false);
  assert.strictEqual(bot.calls.consumed, 0);
});

test('tryEat ne fait rien sans nourriture en inventaire', async () => {
  const bot = fakeBot({ food: 3, hasFood: false });
  assert.strictEqual(await tryEat(bot), false);
});

test('shouldFlee vrai si PV bas', () => {
  assert.strictEqual(shouldFlee(fakeBot({ health: 5 })), true);
});

test('shouldFlee vrai si creeper proche même en pleine vie', () => {
  const creeper = { type: 'mob', name: 'creeper', position: { x: 3, y: 64, z: 0 } };
  assert.strictEqual(shouldFlee(fakeBot({ health: 20, threat: creeper })), true);
});

test('shouldFlee faux si plein PV et aucune menace', () => {
  assert.strictEqual(shouldFlee(fakeBot({ health: 20, threat: null })), false);
});

test('installReflexes branche un handler sur l event health', () => {
  const bot = fakeBot();
  installReflexes(bot, { emit() {}, fleeFrom() {} });
  assert.strictEqual(typeof bot.calls.handlers.health, 'function');
});
```

- [ ] **Step 2 : Lancer → échec attendu**

Run : `cd mc-agent && node --test test/reflexes.test.js`
Expected : FAIL (`Cannot find module '../reflexes'`)

- [ ] **Step 3 : Implémenter `mc-agent/reflexes.js`**

```js
'use strict';
// Réflexes déterministes (ZÉRO appel LLM) : survie de base. Manger quand faim basse,
// fuir quand PV bas ou creeper proche. Pilotés par les events natifs de Mineflayer.

const HUNGER_THRESHOLD = 6;   // sur 20
const HEALTH_THRESHOLD = 6;   // sur 20
const CREEPER_RADIUS = 6;     // blocs

const FOODS = new Set([
  'bread', 'apple', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
  'cooked_cod', 'cooked_salmon', 'baked_potato', 'carrot', 'golden_carrot', 'melon_slice',
  'cooked_rabbit', 'beetroot', 'sweet_berries', 'mushroom_stew',
]);

/** Mange si faim basse et nourriture dispo. Retourne true si une consommation a eu lieu. */
async function tryEat(bot) {
  if (bot.food == null || bot.food > HUNGER_THRESHOLD) return false;
  const items = (bot.inventory && bot.inventory.items()) || [];
  const food = items.find((it) => FOODS.has(it.name));
  if (!food) return false;
  await bot.equip(food, 'hand');
  await bot.consume();
  return true;
}

/** Vrai s'il faut fuir : PV bas OU creeper dans le rayon. */
function shouldFlee(bot) {
  if (bot.health != null && bot.health <= HEALTH_THRESHOLD) return true;
  const self = (bot.entity && bot.entity.position) || { x: 0, y: 0, z: 0 };
  const creeper = bot.nearestEntity((e) =>
    e && e.type === 'mob' && e.name === 'creeper' && e.position &&
    e.position.distanceTo ? e.position.distanceTo(self) <= CREEPER_RADIUS
                          : e && e.name === 'creeper');
  return !!creeper;
}

/** Branche les réflexes sur le bot. opts: { emit, fleeFrom } injectables. */
function installReflexes(bot, opts = {}) {
  const emit = opts.emit || (() => {});
  const flee = opts.fleeFrom || (() => {});
  let fleeing = false;

  const react = () => {
    tryEat(bot).then((ate) => { if (ate) emit({ type: 'reflex', action: 'eat' }); }).catch(() => {});
    if (shouldFlee(bot)) {
      if (!fleeing) { flee(bot); emit({ type: 'reflex', action: 'flee' }); fleeing = true; }
    } else {
      fleeing = false;
    }
  };

  bot.on('health', react);
  return { react };
}

module.exports = { tryEat, shouldFlee, installReflexes, HUNGER_THRESHOLD, HEALTH_THRESHOLD };
```

> Note sur `shouldFlee` : dans le test, `creeper.position.distanceTo` n'existe pas → le ternaire retombe sur `e && e.name === 'creeper'` (vrai). En vrai jeu, `position.distanceTo` existe (Vec3) → filtre par rayon. Les deux chemins sont couverts.

- [ ] **Step 4 : Lancer → succès attendu**

Run : `cd mc-agent && node --test test/reflexes.test.js`
Expected : `# pass 7`

- [ ] **Step 5 : Commit**

```bash
git add mc-agent/reflexes.js mc-agent/test/reflexes.test.js
git commit -m "feat(mc-agent): reflexes zéro-LLM (manger + fuir/défendre, TDD)"
```

---

## Task 9 : `index.js` — wiring profil + plugins + réflexes + skills

**Files :**
- Modify : `mc-agent/index.js`
- Modify : `mc-agent/test/smoke.test.js` (le test « tous les modules se requirent » doit couvrir les nouveaux)

> `index.js` dépend d'une vraie connexion serveur ⇒ pas de test unitaire ; validé par `node --check` (parse) + le smoke « tous les modules se requirent sans throw » + le smoke e2e (Task 13).

- [ ] **Step 1 : Étendre le test smoke « tous les modules se requirent »**

Repérer dans `mc-agent/test/smoke.test.js` le test `tous les modules unitaires se requirent sans throw` et compléter sa liste de require pour inclure les nouveaux modules. Le test doit contenir :
```js
test('tous les modules unitaires se requirent sans throw', () => {
  assert.doesNotThrow(() => {
    require('../io'); require('../state'); require('../brain');
    require('../humanize'); require('../profiles');
    require('../skills/say'); require('../skills/follow'); require('../skills/goto');
    require('../skills/mineBlock'); require('../skills/attackNearest'); require('../skills/fleeFrom');
    require('../reflexes');
  });
});
```
> Si ce test n'existe pas exactement sous ce nom, l'ajouter tel quel à la fin de `smoke.test.js`.

- [ ] **Step 2 : Lancer → échec attendu (skills pas encore tous requis par le smoke, OU déjà vert si liste partielle)**

Run : `cd mc-agent && node --test test/smoke.test.js`
Expected : PASS si les modules existent (Tasks 1-8 faites). C'est un filet : il valide qu'aucun module n'a d'erreur de require (ex. plugin manquant).

- [ ] **Step 3 : Réécrire `mc-agent/index.js`**

```js
'use strict';
// Point d'entrée de l'agent Minecraft. Lancé par le backend Python en subprocess.
const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { plugin: pvp } = require('mineflayer-pvp');
const { plugin: collectBlock } = require('mineflayer-collectblock');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const { emit, onCommand } = require('./io');
const { snapshot } = require('./state');
const { think, RateLimiter } = require('./brain');
const { humanizeReply } = require('./humanize');
const { loadProfile } = require('./profiles');
const { say } = require('./skills/say');
const { follow } = require('./skills/follow');
const { goto } = require('./skills/goto');
const { mineBlock, collectWood } = require('./skills/mineBlock');
const { attackNearest } = require('./skills/attackNearest');
const { fleeFrom } = require('./skills/fleeFrom');
const { installReflexes } = require('./reflexes');

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { o[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return o;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = parseArgs(process.argv.slice(2));
const model = args.model || 'claude-haiku-4-5-20251001';
const limiter = new RateLimiter(Number(args.maxCalls || 20), 60000);
const client = new Anthropic(); // lit ANTHROPIC_API_KEY depuis l'environnement

let profile = null;
try { profile = loadProfile(args.profile || 'intermediaire'); }
catch (e) { emit({ type: 'error', message: 'profil invalide: ' + e.message }); }

const authMode = args.auth === 'microsoft' ? 'microsoft' : 'offline';
const botOpts = {
  host: args.host,
  port: Number(args.port || 25565),
  username: args.user || 'TrainBot',
  auth: authMode,
};
if (authMode === 'microsoft') {
  botOpts.profilesFolder = path.join(__dirname, '.mc-auth');
  botOpts.onMsaCode = (data) => emit({
    type: 'msa',
    message: `Connexion Microsoft : va sur ${data.verification_uri} et entre le code ${data.user_code}`,
  });
}
const bot = mineflayer.createBot(botOpts);
bot.loadPlugin(pathfinder);
bot.loadPlugin(pvp);
bot.loadPlugin(collectBlock);

bot.once('spawn', () => {
  bot.pathfinder.setMovements(new Movements(bot));
  installReflexes(bot, { emit, fleeFrom });
  emit({ type: 'status', state: 'spawned', username: bot.username, profile: profile ? profile.id : null });
});

async function runAction(decision) {
  const a = decision.action;
  const args2 = decision.args || {};
  if (a === 'follow') { const ok = follow(bot, args2); emit({ type: 'action', skill: 'follow', args: args2, success: ok }); }
  else if (a === 'goto') { emit({ type: 'action', skill: 'goto', args: args2 }); await goto(bot, args2); }
  else if (a === 'mineBlock') { emit({ type: 'action', skill: 'mineBlock', args: args2 }); await mineBlock(bot, args2); }
  else if (a === 'collectWood') { emit({ type: 'action', skill: 'collectWood', args: args2 }); await collectWood(bot, args2); }
  else if (a === 'attackNearest') { const ok = attackNearest(bot); emit({ type: 'action', skill: 'attackNearest', success: ok }); }
  else if (a === 'fleeFrom') { const ok = fleeFrom(bot); emit({ type: 'action', skill: 'fleeFrom', success: ok }); }
}

bot.on('chat', async (username, message) => {
  if (username === bot.username) return;
  emit({ type: 'chat', from: username, message });
  try {
    const decision = await think(client, { state: snapshot(bot), message, model, limiter, profile });
    if (!decision) { emit({ type: 'info', message: 'rate-limited' }); return; }
    if (decision.reply) {
      // Réalisme paramétré (§7.1) : latence humaine + fautes occasionnelles selon le profil.
      const { text, delayMs } = humanizeReply(profile, decision.reply);
      await sleep(delayMs);
      if (text) { await say(bot, text); emit({ type: 'say', message: text }); }
    }
    await runAction(decision);
  } catch (e) {
    emit({ type: 'error', message: String((e && e.message) || e) });
  }
});

bot.on('death', () => emit({ type: 'status', state: 'dead' }));
bot.on('kicked', (reason) => emit({ type: 'error', message: 'kicked: ' + reason }));
bot.on('error', (e) => emit({ type: 'error', message: String((e && e.message) || e) }));
bot.on('end', () => { emit({ type: 'status', state: 'disconnected' }); process.exit(0); });

onCommand((cmd) => {
  if (cmd.type === 'say') say(bot, cmd.message);
  else if (cmd.type === 'quit') bot.quit();
});
```

- [ ] **Step 4 : Vérifier le parse + le smoke require**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/mc-agent" && node --check index.js && node --test test/smoke.test.js 2>&1 | tail -3
```
Expected : aucune sortie pour `--check` (syntaxe OK) ; smoke `# pass` (les require des plugins pvp/collectblock réussissent → preuve que Task 0 a bien installé).

- [ ] **Step 5 : Lancer TOUTE la suite Node (non-régression)**

Run : `cd mc-agent && npm test 2>&1 | tail -4`
Expected : `# fail 0` (≈ 36 tests : Phase 0 + profiles + humanize + brain_profile + 3 skills + reflexes).

- [ ] **Step 6 : Commit**

```bash
git add mc-agent/index.js mc-agent/test/smoke.test.js
git commit -m "feat(mc-agent): index — wiring profil + humanize + plugins pvp/collectblock + réflexes"
```

---

## Task 10 : `bin/list-profiles.js` — source unique des profils pour Python

**Files :**
- Create : `mc-agent/bin/list-profiles.js`

- [ ] **Step 1 : Créer le binaire**

`mc-agent/bin/list-profiles.js` :
```js
'use strict';
// Imprime les métadonnées + fiches de tells de tous les profils (JSON) sur stdout.
// Consommé par backend/bots/mc_agent_manager.py (source unique = profiles/*.js).
const { listProfiles } = require('../profiles');
process.stdout.write(JSON.stringify(listProfiles()));
```

- [ ] **Step 2 : Vérifier qu'il imprime un JSON exploitable**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/mc-agent" && node bin/list-profiles.js | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d), 'profils', [p['id'] for p in d]); assert all(p['tells'] for p in d)"
```
Expected : `3 profils ['evident', 'intermediaire', 'expert']` (et l'assert passe : tous ont des tells).

- [ ] **Step 3 : Commit**

```bash
git add mc-agent/bin/list-profiles.js
git commit -m "feat(mc-agent): bin/list-profiles.js (expose profils+tells au backend Python)"
```

---

## Task 11 : Manager Python — `profile` + `list_profiles()`

**Files :**
- Modify : `backend/bots/mc_agent_manager.py`
- Test : `backend/bots/tests/test_mc_agent_manager.py` (ajouts)

- [ ] **Step 1 : Ajouter les tests qui échouent**

Ajouter à la fin de `backend/bots/tests/test_mc_agent_manager.py` :
```python
def test_start_session_passe_le_profil(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    captured = {}
    def fake_popen(cmd, **kw):
        captured["cmd"] = cmd
        return FakeProc('{"type":"status","state":"spawned"}\n')
    monkeypatch.setattr(mgr.subprocess, "Popen", fake_popen)
    sid = mgr.start_session("h", 25565, "B", None, "offline", profile="expert")
    mgr._sessions[sid]["thread"].join(timeout=2)
    assert "--profile" in captured["cmd"]
    i = captured["cmd"].index("--profile")
    assert captured["cmd"][i + 1] == "expert"


def test_list_profiles_parse_la_sortie_node(monkeypatch):
    payload = '[{"id":"evident","level":1,"label":"Évident","summary":"s","tells":["t1"]}]'
    class R:
        returncode = 0
        stdout = payload
        stderr = ""
    monkeypatch.setattr(mgr.subprocess, "run", lambda *a, **k: R())
    profs = mgr.list_profiles()
    assert profs[0]["id"] == "evident"
    assert profs[0]["tells"] == ["t1"]


def test_list_profiles_retourne_vide_si_node_echoue(monkeypatch):
    def boom(*a, **k):
        raise OSError("node introuvable")
    monkeypatch.setattr(mgr.subprocess, "run", boom)
    assert mgr.list_profiles() == []
```

> `FakeProc` existe déjà (Phase 0, Task 9). Ne pas le redéfinir.

- [ ] **Step 2 : Lancer → échec attendu**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur" && source venv/bin/activate && python -m pytest backend/bots/tests/test_mc_agent_manager.py -q 2>&1 | tail -15
```
Expected : FAIL (`start_session() got an unexpected keyword argument 'profile'` ; `list_profiles` not defined)

- [ ] **Step 3 : Modifier `backend/bots/mc_agent_manager.py`**

3a. Changer la signature de `start_session` (ligne 122) et le `cmd` (lignes 125-129). Remplacer :
```python
def start_session(host, port, user, model=None, auth="offline"):
    """Spawn le process Node détaché et enregistre la session. Retourne son id."""
    global _counter
    cmd = [_node_bin(), str(MC_AGENT_DIR / "index.js"),
           "--host", str(host), "--port", str(port), "--user", str(user),
           "--auth", str(auth or "offline")]
    if model:
        cmd += ["--model", str(model)]
```
par :
```python
def start_session(host, port, user, model=None, auth="offline", profile=None):
    """Spawn le process Node détaché et enregistre la session. Retourne son id."""
    global _counter
    cmd = [_node_bin(), str(MC_AGENT_DIR / "index.js"),
           "--host", str(host), "--port", str(port), "--user", str(user),
           "--auth", str(auth or "offline")]
    if model:
        cmd += ["--model", str(model)]
    if profile:
        cmd += ["--profile", str(profile)]
```

3b. Ajouter `list_profiles()` à la fin du fichier :
```python
_LIST_PROFILES_JS = MC_AGENT_DIR / "bin" / "list-profiles.js"


def list_profiles():
    """Profils + fiches de tells, lus depuis les fichiers Node (source unique). [] si échec."""
    try:
        res = subprocess.run(
            [_node_bin(), str(_LIST_PROFILES_JS)],
            cwd=str(MC_AGENT_DIR),
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    if res.returncode != 0 or not res.stdout:
        return []
    try:
        data = json.loads(res.stdout)
    except (ValueError, TypeError):
        return []
    return data if isinstance(data, list) else []
```

- [ ] **Step 4 : Lancer → succès attendu**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur" && source venv/bin/activate && python -m pytest backend/bots/tests/test_mc_agent_manager.py -q 2>&1 | tail -3
```
Expected : tous verts (11 tests : 8 Phase 0 + 3 nouveaux).

- [ ] **Step 5 : Commit**

```bash
git add backend/bots/mc_agent_manager.py backend/bots/tests/test_mc_agent_manager.py
git commit -m "feat(mc-agent): manager — param profile + list_profiles (TDD)"
```

---

## Task 12 : Router Python — `GET /profiles` + `profile` dans `/run`

**Files :**
- Modify : `backend/bots/mc_agent_router.py`
- Test : `backend/bots/tests/test_mc_agent_router.py` (ajouts)

- [ ] **Step 1 : Ajouter les tests qui échouent**

Ajouter à la fin de `backend/bots/tests/test_mc_agent_router.py` :
```python
def test_profiles_admin_only():
    c = make_client(is_admin=False)
    assert c.get("/api/mc-agent/profiles").status_code == 403


def test_profiles_retourne_la_liste(monkeypatch):
    monkeypatch.setattr(mgr, "list_profiles",
                        lambda: [{"id": "expert", "level": 3, "label": "Expert", "summary": "s", "tells": ["t"]}])
    c = make_client()
    resp = c.get("/api/mc-agent/profiles")
    assert resp.status_code == 200
    assert resp.json()["profiles"][0]["id"] == "expert"


def test_run_transmet_le_profil(monkeypatch):
    monkeypatch.setattr(mgr, "has_api_key", lambda: True)
    captured = {}
    def fake_start(host, port, user, model=None, auth="offline", profile=None):
        captured["profile"] = profile
        return 11
    monkeypatch.setattr(mgr, "start_session", fake_start)
    c = make_client()
    resp = c.post("/api/mc-agent/run", json={"host": "h", "profile": "expert"})
    assert resp.status_code == 200
    assert captured["profile"] == "expert"
```

- [ ] **Step 2 : Lancer → échec attendu**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur" && source venv/bin/activate && python -m pytest backend/bots/tests/test_mc_agent_router.py -q 2>&1 | tail -15
```
Expected : FAIL (404 sur /profiles ; `profile` ignoré par run → `captured["profile"]` est None)

- [ ] **Step 3 : Modifier `backend/bots/mc_agent_router.py`**

3a. Ajouter le champ `profile` à `StartReq` (après la ligne `model: Optional[str] = None`) :
```python
    profile: Optional[str] = None   # id de profil de comportement (evident/intermediaire/expert)
```

3b. Dans `run(...)`, passer le profil à `start_session`. Remplacer la ligne `sid = mgr.start_session(req.host, req.port, req.user, req.model, auth)` par :
```python
        sid = mgr.start_session(req.host, req.port, req.user, req.model, auth, req.profile)
```

3c. Ajouter l'endpoint `/profiles` (par ex. juste après `active`) :
```python
@router.get("/profiles")
def profiles(current_user: User = Depends(get_current_user)):
    """Liste des profils de comportement + leurs fiches de tells (corrigé formateur)."""
    _require_admin(current_user)
    return {"profiles": mgr.list_profiles()}
```

- [ ] **Step 4 : Lancer → succès attendu**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur" && source venv/bin/activate && python -m pytest backend/bots/tests/test_mc_agent_router.py -q 2>&1 | tail -3
```
Expected : tous verts (8 tests : 5 Phase 0 + 3 nouveaux).

- [ ] **Step 5 : Vérifier que l'app démarre toujours et expose /profiles**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur" && source venv/bin/activate && python -c "from backend.main import app; print([r.path for r in app.routes if 'mc-agent' in r.path])"
```
Expected : la liste contient `/api/mc-agent/profiles`.

- [ ] **Step 6 : Commit**

```bash
git add backend/bots/mc_agent_router.py backend/bots/tests/test_mc_agent_router.py
git commit -m "feat(mc-agent): router — GET /profiles + profile dans /run (TDD)"
```

---

## Task 13 : Frontend — sélecteur de profil + panneau fiche-de-tells

**Files :**
- Modify : `frontend/js/bots_module.js`
- Modify : `frontend/js/lang.js`
- Modify : `frontend/index.html` (cache-bust)
- Modify : `frontend/sw.js` (CACHE_NAME)

> Vue smoke/manuelle (pas de test unitaire frontend dans ce projet vanilla).

- [ ] **Step 1 : Repérer les ancres dans `openMCAgent`**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur" && grep -n "mca-auth\|ms_hint\|mca-msg\|_loadMCAgentKey\|startMCAgent()" frontend/js/bots_module.js | head
```
On insère le sélecteur de profil dans la grille de form (près de `mca-auth`), le panneau de tells juste avant le bloc transcript, et un `loadMCAgentProfiles()` appelé en fin de `openMCAgent` (à côté de `this._loadMCAgentKey();`).

- [ ] **Step 2 : Ajouter le `<select>` profil + le panneau tells dans le HTML de `openMCAgent`**

Dans `frontend/js/bots_module.js`, dans le template de `openMCAgent()`, juste **après** le `<div>` contenant `mca-auth` (le select offline/microsoft, ~ligne 1057), ajouter une nouvelle cellule de grille :
```js
          <div><label class="form-label">${Lang.t('mcagent.profile')}</label><select id="mca-profile" class="form-input" onchange="BotsModule.renderMCAgentTells()"></select></div>
```
Puis, juste **avant** la ligne du `<div id="mca-transcript" ...>` (~ligne 1065), insérer le panneau corrigé :
```js
        <div id="mca-tells" style="display:none;background:var(--bg-elev-2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:10px;font-size:12px;color:var(--text-muted);"></div>
```

- [ ] **Step 3 : Appeler le chargement des profils à l'ouverture**

Dans `openMCAgent()`, repérer `this._loadMCAgentKey();` (~ligne 1071) et ajouter juste après :
```js
    this.loadMCAgentProfiles();
```

- [ ] **Step 4 : Ajouter les méthodes `loadMCAgentProfiles` + `renderMCAgentTells` à `BotsModule`**

Juste après la méthode `stopMCAgent()` (~ligne 1131), ajouter :
```js
  async loadMCAgentProfiles() {
    const sel = document.getElementById('mca-profile');
    if (!sel) return;
    try {
      const r = await Auth.apiCall('/api/mc-agent/profiles');
      if (!r.ok) return;
      const data = await r.json();
      this._mcAgentProfiles = data.profiles || [];
    } catch (e) { this._mcAgentProfiles = []; }
    sel.innerHTML = (this._mcAgentProfiles || []).map((p) =>
      `<option value="${p.id}">${Lang.escape ? Lang.escape(p.label) : p.label} (niv. ${p.level})</option>`
    ).join('');
    // défaut : intermédiaire si présent
    const def = (this._mcAgentProfiles || []).find((p) => p.id === 'intermediaire');
    if (def) sel.value = 'intermediaire';
    this.renderMCAgentTells();
  },

  renderMCAgentTells() {
    const sel = document.getElementById('mca-profile');
    const box = document.getElementById('mca-tells');
    if (!sel || !box) return;
    const prof = (this._mcAgentProfiles || []).find((p) => p.id === sel.value);
    if (!prof || !Array.isArray(prof.tells) || !prof.tells.length) { box.style.display = 'none'; return; }
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    box.style.display = 'block';
    box.innerHTML =
      `<div style="font-weight:600;color:var(--text);margin-bottom:6px;">${esc(Lang.t('mcagent.tells_title'))} — ${esc(prof.label)}</div>` +
      `<ul style="margin:0;padding-left:18px;">` +
      prof.tells.map((t) => `<li style="margin:2px 0;">${esc(t)}</li>`).join('') +
      `</ul>`;
  },
```

> Le panneau de tells est l'**affichage du corrigé formateur** (admin) demandé par la spec §4/§7. L'échappement HTML protège contre toute injection (les tells viennent du backend, mais on reste défensif — cf. piège #6cb058c anti-XSS transcript).

- [ ] **Step 5 : Transmettre `profile` dans `startMCAgent`**

Dans `startMCAgent()`, repérer la lecture des champs (`const auth = document.getElementById('mca-auth').value;` ~ligne 1078) et ajouter juste après :
```js
    const profile = (document.getElementById('mca-profile') || {}).value || undefined;
```
Puis, dans le `body: JSON.stringify({ host, port, user, auth })`, ajouter `profile` :
```js
      body: JSON.stringify({ host, port, user, auth, profile }),
```

- [ ] **Step 6 : Ajouter les clés i18n dans `frontend/js/lang.js`**

Dans la section `mcagent` de **chaque** langue, ajouter 2 clés (FR montré ; traduire EN/IT) :
```js
      profile: 'Profil', tells_title: 'Fiche de tells (corrigé formateur)',
```
EN : `profile: 'Profile', tells_title: 'Tells sheet (trainer answer key)'`
IT : `profile: 'Profilo', tells_title: 'Scheda dei tells (soluzione formatore)'`

> Repérer la section : `grep -n "mcagent:" frontend/js/lang.js` (3 occurrences, une par langue).

- [ ] **Step 7 : Cache-bust (pièges #9/#11/#35-bis)**

Run pour repérer les valeurs courantes :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur" && grep -nE "bots_module.js\?v=|lang.js\?v=" frontend/index.html && grep -n "CACHE_NAME" frontend/sw.js
```
Bumper le `?v=` de `bots_module.js` ET `lang.js` à une valeur franche supérieure dans `frontend/index.html`, et incrémenter `CACHE_NAME` dans `frontend/sw.js`.

- [ ] **Step 8 : Commit**

```bash
git add frontend/js/bots_module.js frontend/js/lang.js frontend/index.html frontend/sw.js
git commit -m "feat(mc-agent): UI sélecteur de profil + fiche de tells (corrigé formateur, i18n)"
```

---

## Task 14 : Smoke end-to-end + doc + définition « Phase 1 terminée »

**Files :**
- Modify : `CLAUDE.md` (historique + éventuel rappel)

- [ ] **Step 1 : Toute la suite Node + Python verte**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/mc-agent" && npm test 2>&1 | tail -4
cd "/Users/massimiliano/omenserver Project/Projet serveur" && source venv/bin/activate && python -m pytest backend/bots/tests/ -q 2>&1 | tail -3
```
Expected : Node `# fail 0` ; Python `... passed`.

- [ ] **Step 2 : Smoke e2e (nécessite serveur MC offline + clé Claude)**

Prérequis (à fournir par Massii) : un serveur MC offline-mode accessible, et la clé Claude posée (dashboard MC Agent → champ clé, ou `ANTHROPIC_API_KEY` dans `.env`). Backend lancé par Massii dans son terminal :
```bash
source venv/bin/activate && uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```
Puis dashboard (admin) → Bots → MC Agent :
1. Choisir le profil **Expert** → vérifier que la **fiche de tells** s'affiche (le corrigé).
2. Renseigner host/port → **Démarrer** → statut `starting → spawned`.
3. In-game : « tu peux me ramener du bois ? » → le bot répond **après une latence variable** (réalisme) et exécute `collectWood`.
4. « suis-moi » → `follow` ; tester `attackNearest` (près d'un mob) et la fuite auto (réflexe) si PV bas.
5. **Arrêter** → `stopped`, le bot se déconnecte.

- [ ] **Step 3 : Mettre à jour l'historique CLAUDE.md**

Ajouter en tête du tableau « 📝 Historique récent » de `CLAUDE.md` :
```
| 2026-05-29 PM | 🎮 **MC Agent Phase 1** — 3 profils calibrés (Évident/Intermédiaire/Expert) avec fiches de tells (invariant : tells non-vide validé à la construction), réalisme paramétré (latence distribuée + fautes, §7.1, PAS de clonage humain), skills mineBlock/collectWood/attackNearest/fleeFrom, réflexes zéro-LLM (manger + fuir/défendre), endpoint `/api/mc-agent/profiles` + UI sélecteur profil & corrigé formateur. Behavioral cloning renvoyé en plan 1b (cadrage consentement). |
```

- [ ] **Step 4 : Commit final**

```bash
git add CLAUDE.md
git commit -m "docs(mc-agent): historique Phase 1 (profils calibrés + tells + skills + réflexes)"
```

---

## Définition de « Phase 1 terminée »

- `cd mc-agent && npm test` → tout vert (Phase 0 + profils + humanize + brain_profile + 3 skills + reflexes).
- `python -m pytest backend/bots/tests/ -v` → tout vert (manager profile/list_profiles + router /profiles + run profile).
- Les **3 profils existent**, chacun avec une **fiche de tells non vide** ; un profil sans tells est rejeté par un test (invariant §2 prouvé).
- Le tier Expert atteint le « quasi indétectable » par **réalisme paramétré** (latence distribuée, fautes, taux d'erreur) — **aucun clonage d'un vrai joueur**.
- Smoke e2e : sélection de profil → fiche de tells affichée → bot répond avec latence variable → exécute mine/follow/attack → réflexes actifs → stop propre.

**Hors de ce plan (plan séparé `phase1b`) :** behavioral cloning (capture/imitation des inputs d'un joueur) — à cadrer avec **consentement explicite** d'un joueur-modèle désigné. Le réalisme paramétré de cette Phase 1 atteint déjà l'objectif de formation ; le BC est une extension lourde et sensible traitée à part.

---

## Self-Review (auteur)

**1. Couverture de la spec (Phase 1) :**
- §6 skills (mineBlock/collectWood/attack/flee) → Tasks 5,6,7. ✅
- §6 réflexes auto (manger/fuir/défendre) → Task 8. ✅
- §7 profils 3 tiers + difficulté croissante → Tasks 1,2 (+ test « réalisme monte »). ✅
- §7 invariant tells non-vide rejeté à la construction → Task 1 (`validateProfile`) + test. ✅
- §7.1 réalisme paramétré (latence distribuée, fautes, taux d'erreur), PAS de clonage → Task 3 (humanize) + Task 9 (wiring). ✅
- §4 fiche de tells exposée UI admin (corrigé formateur) → Tasks 10,11,12 (endpoint) + Task 13 (panneau). ✅
- §5 profil injecté dans le system prompt → Task 4 (`buildSystemPrompt`). ✅
- BC (§14) explicitement renvoyé hors plan. ✅

**2. Placeholders :** aucun « TODO »/« handle edge cases » ; code complet à chaque step. ✅

**3. Cohérence des types/signatures :**
- `start_session(host, port, user, model=None, auth="offline", profile=None)` — défini Task 11, appelé Task 12 (`req.host, req.port, req.user, req.model, auth, req.profile`) et testé Task 11/12 avec la même forme. ✅
- `humanizeReply(profile, reply, rng)` → `{text, delayMs}` — défini Task 3, consommé Task 9. ✅
- `loadProfile(id)`/`listProfiles()` — définis Task 1, consommés Task 9 (loadProfile) et Task 10 (listProfiles → bin → Python Task 11). ✅
- `installReflexes(bot, {emit, fleeFrom})` — défini Task 8, appelé Task 9 (`installReflexes(bot, { emit, fleeFrom })`). ✅
- `buildSystemPrompt(profile)` — défini Task 4, consommé par `think` (même Task). ✅
- Actions du prompt (`mineBlock/collectWood/attackNearest/fleeFrom`) = exactement les branches de `runAction` (Task 9) = exactement les skills (Tasks 5-7). ✅
