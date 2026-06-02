# MC Agent — Planner autonome MVP « zéro → pioche pierre » — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Le bot va seul de l'inventaire vide à une pioche en pierre, en réutilisant le bot mineflayer existant (couche réactive #40), sans appel LLM dans la boucle.

**Architecture:** Une boucle de buts déterministe (`planner.js`) tourne comme **tâche par défaut de `taskCtl`** ; elle choisit le premier but non satisfait d'une chaîne (`goals.js`), exécute le skill correspondant (réutilise `gather`/`craftItem` + un placeur), persiste l'objectif (`worldModel.js`), et reprend après préemption/mort/restart en **re-dérivant depuis l'inventaire**. Auth AuthMe en bootstrap avant tout.

**Tech Stack:** Node.js, mineflayer 4.20 (+ pathfinder/pvp/collectblock déjà chargés), `node --test` + `node:assert` (runner natif). Pas de nouvelle dépendance pour le MVP.

**Spec source:** `docs/superpowers/specs/2026-06-02-mc-agent-planner-architecture-design.md`

---

## Scope

**Ce plan = le MVP uniquement** (critères §8 de la spec). Hors-scope (phases ultérieures, déjà spécifiées) : home/stockage, diamant, netherite, find, build, élytre, combat, réalisme/Grim, clone 1b, récupération d'items au point de mort, auto-reconnect in-process (le MVP couvre « restart → reprise via JSON », pas la reconnexion sans redémarrage).

## File Structure

| Fichier | Responsabilité | Créé/Modifié |
|---|---|---|
| `mc-agent/worldModel.js` | load/save JSON de l'état persistant (objectif ; home/coffres = structure réservée mais non remplie au MVP) | **Créer** |
| `mc-agent/worldModel.test.js` | tests worldModel | **Créer** |
| `mc-agent/goals.js` | helpers inventaire + chaîne de buts MVP + `firstUnmet()` | **Créer** |
| `mc-agent/goals.test.js` | tests goals | **Créer** |
| `mc-agent/skills/placeBlockNear.js` | placer un bloc (table de craft) à côté du bot | **Créer** |
| `mc-agent/planner.js` | la boucle : firstUnmet → run skill → re-loop ; garde-fou no-progress | **Créer** |
| `mc-agent/planner.test.js` | tests planner (mock bot/skills) | **Créer** |
| `mc-agent/auth.js` | bootstrap AuthMe (login/register) + helpers parse prompt | **Créer** |
| `mc-agent/auth.test.js` | tests parse prompt AuthMe | **Créer** |
| `mc-agent/index.js` | wiring : auth au spawn, planner comme tâche, `start`/`stop`, reprise spawn/préemption/mort, garde-fou morts | **Modifier** |
| `mc-agent/orders.js` | ajouter le verbe `start` (lancer l'objectif MVP) | **Modifier** |

---

## Task 0: Prérequis runtime (ops — AVANT tout code)

> Manuel / Massii (SSH + panel OmenServer). Pas de TDD. Le code du planner ne sert à rien tant que le bot ne tourne pas live.

- [ ] **Step 1 — Wipe + recréer le serveur de test**

Via le panel OmenServer : supprimer l'ancien serveur 10 Go (jetable, confirmé sans backup), créer un **Paper 10 Go + Essentials + AuthMe**, `online-mode=false` (le bot se connecte en `offline`), `difficulty=easy`, garder un coin plat avec des arbres pour le MVP.

- [ ] **Step 2 — Installer les deps Node du bot sur l'Omen**

```bash
cd ~/omenserver/mc-agent   # chemin du repo sur l'Omen
npm install
node -e "require('mineflayer'); console.log('mineflayer OK')"
```
Expected: `mineflayer OK` (sinon : node/npm absent → `apt install nodejs npm`).

- [ ] **Step 3 — Smoke-test Phase 1 / #40 live**

Lancer le bot vers le serveur de test (depuis le dashboard ou en CLI), vérifier : connexion, le bot apparaît, une commande directe en `/msg` (`take dirt`, `come`) répond. **Note les chaînes exactes du prompt AuthMe** (pour Task 5) et le **format `/msg`/`/tpa`** d'Essentials.

- [ ] **Step 4 — Commit** (rien à committer ici ; noter dans le vault les chaînes AuthMe relevées).

---

## Task 1: `worldModel.js` — persistance JSON

**Files:**
- Create: `mc-agent/worldModel.js`
- Test: `mc-agent/worldModel.test.js`

- [ ] **Step 1: Write the failing test**

```js
// mc-agent/worldModel.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { loadWorld, saveWorld, setObjective, clearObjective } = require('./worldModel');

function tmpFile() {
  return path.join(os.tmpdir(), `mc-world-${process.pid}-${Math.floor(process.hrtime()[1])}.json`);
}

test('loadWorld returns a default shape when file is absent', () => {
  const w = loadWorld(tmpFile());
  assert.deepStrictEqual(w, { home: null, chests: [], waypoints: [], objective: null });
});

test('saveWorld then loadWorld round-trips', () => {
  const f = tmpFile();
  const w = loadWorld(f);
  setObjective(w, { type: 'stone_pickaxe', status: 'in_progress' });
  saveWorld(f, w);
  const w2 = loadWorld(f);
  assert.strictEqual(w2.objective.type, 'stone_pickaxe');
  assert.strictEqual(w2.objective.status, 'in_progress');
  fs.unlinkSync(f);
});

test('clearObjective nulls the objective', () => {
  const w = loadWorld(tmpFile());
  setObjective(w, { type: 'stone_pickaxe', status: 'in_progress' });
  clearObjective(w);
  assert.strictEqual(w.objective, null);
});

test('loadWorld on corrupt JSON returns default shape (no throw)', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{ not json');
  const w = loadWorld(f);
  assert.deepStrictEqual(w, { home: null, chests: [], waypoints: [], objective: null });
  fs.unlinkSync(f);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mc-agent && node --test worldModel.test.js`
Expected: FAIL (`Cannot find module './worldModel'`).

- [ ] **Step 3: Write minimal implementation**

```js
// mc-agent/worldModel.js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mc-agent && node --test worldModel.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add mc-agent/worldModel.js mc-agent/worldModel.test.js
git commit -m "feat(mc-agent): worldModel JSON persistence (objective)"
```

---

## Task 2: `goals.js` — inventaire + chaîne MVP + sélection

**Files:**
- Create: `mc-agent/goals.js`
- Test: `mc-agent/goals.test.js`

**Contexte :** chaque but = `{ name, met(ctx), skill, args }`. `ctx = { inv, hasTable }` où `inv` = map `{itemName: count}` et `hasTable` = bool (table de craft ≤6 blocs). `firstUnmet(chain, ctx)` = premier but dont `met(ctx)` est faux. La chaîne est ordonnée → les préconditions sont garanties par l'ordre. La re-dérivation post-mort = rappeler `firstUnmet` sur l'inventaire courant.

- [ ] **Step 1: Write the failing test**

```js
// mc-agent/goals.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { invCount, buildCtxInv, MVP_CHAIN, firstUnmet } = require('./goals');

// Faux bot : inventaire = liste d'items {name, count}
function fakeBot(items) {
  return { inventory: { items: () => items.map((i) => ({ name: i[0], count: i[1] })) } };
}

test('invCount somme les piles du même item', () => {
  const bot = fakeBot([['oak_planks', 4], ['oak_planks', 3], ['stick', 2]]);
  const inv = buildCtxInv(bot);
  assert.strictEqual(invCount(inv, 'oak_planks'), 7);
  assert.strictEqual(invCount(inv, 'stick'), 2);
  assert.strictEqual(invCount(inv, 'cobblestone'), 0);
});

test('firstUnmet renvoie le 1er but non satisfait dans l’ordre', () => {
  // inventaire vide → 1er but = récolter du bois
  let ctx = { inv: {}, hasTable: false };
  assert.strictEqual(firstUnmet(MVP_CHAIN, ctx).name, 'logs');

  // a déjà 3 logs → but suivant = planks
  ctx = { inv: { oak_log: 3 }, hasTable: false };
  assert.strictEqual(firstUnmet(MVP_CHAIN, ctx).name, 'planks');

  // objectif atteint (a une pioche pierre) → firstUnmet = null
  ctx = { inv: { stone_pickaxe: 1 }, hasTable: true };
  assert.strictEqual(firstUnmet(MVP_CHAIN, ctx), null);
});

test('le but place_table dépend de hasTable, pas de l’inventaire', () => {
  // a une table en inventaire mais pas posée → but = place_table
  const ctx = { inv: { oak_planks: 12, crafting_table: 1, oak_log: 0 }, hasTable: false };
  assert.strictEqual(firstUnmet(MVP_CHAIN, ctx).name, 'place_table');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mc-agent && node --test goals.test.js`
Expected: FAIL (`Cannot find module './goals'`).

- [ ] **Step 3: Write minimal implementation**

```js
// mc-agent/goals.js
'use strict';
// Chaîne de buts MVP « zéro → pioche pierre ». Données + prédicats purs (testables sans serveur).

/** Map {itemName: countTotal} depuis bot.inventory.items(). */
function buildCtxInv(bot) {
  const inv = {};
  const items = (bot.inventory && bot.inventory.items()) || [];
  for (const it of items) { inv[it.name] = (inv[it.name] || 0) + it.count; }
  return inv;
}
function invCount(inv, name) { return inv[name] || 0; }

// "log"/"planks" génériques : on accepte n'importe quelle essence (oak par défaut côté skill).
function anyLog(inv) {
  return Object.keys(inv).filter((n) => n.endsWith('_log')).reduce((s, n) => s + inv[n], 0);
}
function anyPlanks(inv) {
  return Object.keys(inv).filter((n) => n.endsWith('_planks')).reduce((s, n) => s + inv[n], 0);
}

// Chaîne ordonnée. `met(ctx)` = ce but est-il déjà accompli ? `skill`+`args` = comment l'accomplir.
// Quantités : table 4 + pioche bois 3 + sticks (2 planks→4 sticks) ⇒ ≥9 planks ; 4 sticks ; 3 cobble.
const MVP_CHAIN = [
  { name: 'logs',          met: (c) => anyLog(c.inv) >= 3 || anyPlanks(c.inv) >= 9 || invCount(c.inv, 'stone_pickaxe') >= 1,
    skill: 'gatherLog',    args: { count: 3 } },
  { name: 'planks',        met: (c) => anyPlanks(c.inv) >= 9 || invCount(c.inv, 'stone_pickaxe') >= 1,
    skill: 'craftPlanks',  args: { count: 3 } }, // 3×4 = 12 planks, essence résolue depuis la bûche détenue
  { name: 'crafting_table',met: (c) => invCount(c.inv, 'crafting_table') >= 1 || c.hasTable || invCount(c.inv, 'stone_pickaxe') >= 1,
    skill: 'craft',        args: { name: 'crafting_table', count: 1 } },
  { name: 'place_table',   met: (c) => c.hasTable || invCount(c.inv, 'stone_pickaxe') >= 1,
    skill: 'placeTable',   args: {} },
  { name: 'sticks',        met: (c) => invCount(c.inv, 'stick') >= 4 || invCount(c.inv, 'stone_pickaxe') >= 1,
    skill: 'craft',        args: { name: 'stick', count: 1 } }, // 1×4 = 4 sticks
  { name: 'wooden_pickaxe',met: (c) => invCount(c.inv, 'wooden_pickaxe') >= 1 || invCount(c.inv, 'stone_pickaxe') >= 1,
    skill: 'craft',        args: { name: 'wooden_pickaxe', count: 1 } },
  { name: 'cobblestone',   met: (c) => invCount(c.inv, 'cobblestone') >= 3 || invCount(c.inv, 'stone_pickaxe') >= 1,
    skill: 'gather',       args: { name: 'stone', count: 3 } },
  { name: 'stone_pickaxe', met: (c) => invCount(c.inv, 'stone_pickaxe') >= 1,
    skill: 'craft',        args: { name: 'stone_pickaxe', count: 1 } },
];

/** Premier but non satisfait dans l'ordre, ou null si tout est fait. */
function firstUnmet(chain, ctx) {
  for (const g of chain) { if (!g.met(ctx)) return g; }
  return null;
}

module.exports = { buildCtxInv, invCount, anyLog, anyPlanks, MVP_CHAIN, firstUnmet };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mc-agent && node --test goals.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add mc-agent/goals.js mc-agent/goals.test.js
git commit -m "feat(mc-agent): MVP goal chain (zero->stone pickaxe) + firstUnmet"
```

---

## Task 3: `skills/placeBlockNear.js` — poser la table de craft

**Files:**
- Create: `mc-agent/skills/placeBlockNear.js`

> Minage/pose = validation surtout live (mineflayer). On code le skill + une vérif de signature ; le vrai test est en Task 7. La pose réutilise `bot.placeBlock` sur un bloc solide adjacent au sol.

- [ ] **Step 1: Write the implementation**

```js
// mc-agent/skills/placeBlockNear.js
'use strict';
// Pose `itemName` (ex. crafting_table) sur un bloc solide adjacent au sol du bot.
const { Vec3 } = require('vec3');

async function placeBlockNear(bot, itemName) {
  const item = bot.inventory.items().find((i) => i.name === itemName);
  if (!item) return { ok: false, reason: 'unknown_item' };
  // Référence = le bloc juste sous une case au sol adjacente. On essaie les 4 directions.
  const base = bot.entity.position.floored();
  const dirs = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
  for (const d of dirs) {
    const ground = bot.blockAt(base.plus(d).offset(0, -1, 0));   // sol adjacent
    const target = bot.blockAt(base.plus(d));                     // case où poser (doit être air)
    if (!ground || ground.boundingBox !== 'block') continue;
    if (target && target.name !== 'air') continue;
    try {
      await bot.equip(item, 'hand');
      await bot.placeBlock(ground, new Vec3(0, 1, 0));            // pose sur la face haute du sol
      return { ok: true };
    } catch (e) { /* essaie la direction suivante */ }
  }
  return { ok: false, reason: 'no_space' };
}

module.exports = { placeBlockNear };
```

- [ ] **Step 2: Smoke-check du parse (pas de serveur requis)**

Run: `cd mc-agent && node -e "require('./skills/placeBlockNear'); console.log('placeBlockNear loads')"`
Expected: `placeBlockNear loads` (valide qu'il n'y a pas d'erreur de syntaxe ; `vec3` est une dép transitive de mineflayer, déjà présente).

- [ ] **Step 3: Commit**

```bash
git add mc-agent/skills/placeBlockNear.js
git commit -m "feat(mc-agent): placeBlockNear skill (pose table de craft)"
```

---

## Task 4: `planner.js` — la boucle de buts

**Files:**
- Create: `mc-agent/planner.js`
- Test: `mc-agent/planner.test.js`

**Contexte :** `runPlanner(bot, { chain, runSkill, onProgress }, token)` boucle : construit `ctx` (inventaire + hasTable), prend `firstUnmet`, appelle `runSkill(goal, bot)` ; s'arrête quand `firstUnmet === null` (objectif atteint), quand `token.cancelled`, ou quand **aucun progrès** sur `maxStalls` itérations consécutives (le même but échoue/ne change rien → fallback : stop + raison). `runSkill` est injecté (dispatch vers gather/craft/placeTable) → testable avec un faux.

- [ ] **Step 1: Write the failing test**

```js
// mc-agent/planner.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { runPlanner } = require('./planner');

// Faux monde : un inventaire mutable + hasTable ; runSkill applique l'effet du but.
function harness() {
  const inv = {};
  let hasTable = false;
  const bot = {
    _inv: inv,
    inventory: { items: () => Object.entries(inv).map(([name, count]) => ({ name, count })) },
  };
  const chain = [
    { name: 'a', met: (c) => (c.inv.A || 0) >= 1, skill: 'mkA' },
    { name: 'b', met: (c) => (c.inv.B || 0) >= 1, skill: 'mkB' },
  ];
  // ctxExtra fournit hasTable au planner
  const ctxExtra = () => ({ hasTable });
  const calls = [];
  const runSkill = async (goal) => {
    calls.push(goal.name);
    if (goal.skill === 'mkA') inv.A = 1;
    if (goal.skill === 'mkB') inv.B = 1;
    return { ok: true };
  };
  return { bot, chain, ctxExtra, runSkill, calls };
}

test('runPlanner exécute les buts jusqu’à l’objectif atteint', async () => {
  const h = harness();
  const token = { cancelled: false };
  const res = await runPlanner(h.bot, { chain: h.chain, runSkill: h.runSkill, ctxExtra: h.ctxExtra }, token);
  assert.deepStrictEqual(h.calls, ['a', 'b']);
  assert.strictEqual(res.done, true);
});

test('runPlanner s’arrête immédiatement si token.cancelled', async () => {
  const h = harness();
  const token = { cancelled: true };
  const res = await runPlanner(h.bot, { chain: h.chain, runSkill: h.runSkill, ctxExtra: h.ctxExtra }, token);
  assert.deepStrictEqual(h.calls, []);
  assert.strictEqual(res.cancelled, true);
});

test('runPlanner abandonne après maxStalls sans progrès (fallback)', async () => {
  const h = harness();
  const token = { cancelled: false };
  const stuckSkill = async () => ({ ok: false, reason: 'not_found' }); // n'applique jamais l'effet
  const res = await runPlanner(h.bot, { chain: h.chain, runSkill: stuckSkill, ctxExtra: h.ctxExtra, maxStalls: 3 }, token);
  assert.strictEqual(res.stalled, true);
  assert.strictEqual(res.goal, 'a');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mc-agent && node --test planner.test.js`
Expected: FAIL (`Cannot find module './planner'`).

- [ ] **Step 3: Write minimal implementation**

```js
// mc-agent/planner.js
'use strict';
// Boucle de buts déterministe (0 token). firstUnmet → runSkill → re-loop.
const { buildCtxInv, firstUnmet } = require('./goals');

/**
 * runPlanner(bot, opts, token)
 *  opts.chain   : tableau de buts (goals.MVP_CHAIN)
 *  opts.runSkill: async (goal, bot) => {ok, reason?}   (dispatch vers les skills réels)
 *  opts.ctxExtra: () => ({ hasTable })                 (état monde non-inventaire)
 *  opts.maxStalls: nb d'itérations sans progrès avant fallback (défaut 4)
 *  opts.onStep  : (goal) => void                       (hook events, optionnel)
 * Retour : { done } | { cancelled } | { stalled, goal }
 */
async function runPlanner(bot, opts, token) {
  const chain = opts.chain;
  const runSkill = opts.runSkill;
  const ctxExtra = opts.ctxExtra || (() => ({}));
  const maxStalls = opts.maxStalls || 4;
  let stalls = 0;

  while (true) {
    if (token && token.cancelled) return { cancelled: true };
    const ctx = Object.assign({ inv: buildCtxInv(bot) }, ctxExtra());
    const goal = firstUnmet(chain, ctx);
    if (!goal) return { done: true };

    const before = JSON.stringify(ctx.inv) + '|' + (ctx.hasTable ? 1 : 0);
    if (opts.onStep) { try { opts.onStep(goal); } catch (e) {} }
    try { await runSkill(goal, bot); } catch (e) { /* compté comme stall */ }
    if (token && token.cancelled) return { cancelled: true };

    const ctx2 = Object.assign({ inv: buildCtxInv(bot) }, ctxExtra());
    const after = JSON.stringify(ctx2.inv) + '|' + (ctx2.hasTable ? 1 : 0);
    if (after === before) { stalls++; } else { stalls = 0; }
    if (stalls >= maxStalls) return { stalled: true, goal: goal.name };
  }
}

module.exports = { runPlanner };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mc-agent && node --test planner.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add mc-agent/planner.js mc-agent/planner.test.js
git commit -m "feat(mc-agent): planner loop (firstUnmet->runSkill, stall fallback)"
```

---

## Task 5: `auth.js` — bootstrap AuthMe + cred store

**Files:**
- Create: `mc-agent/auth.js`
- Test: `mc-agent/auth.test.js`

**Contexte :** parsing du prompt AuthMe (register vs login) = pur, testable. La génération de pw + l'écriture sécurisée + l'envoi `/register`/`/login` = live (Task 7). Le pw est stocké dans le profil serveur `data/mc_agent_servers.json` (champ `authmePassword`) — chemin passé via `--world`/`--auth-store` ou dérivé ; ici on isole la **logique pure**.

- [ ] **Step 1: Write the failing test**

```js
// mc-agent/auth.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { classifyAuthPrompt, genPassword } = require('./auth');

test('classifyAuthPrompt détecte register / login / null', () => {
  assert.strictEqual(classifyAuthPrompt('Please register with /register <password>'), 'register');
  assert.strictEqual(classifyAuthPrompt('Veuillez vous enregistrer: /register <pass> <pass>'), 'register');
  assert.strictEqual(classifyAuthPrompt('Please login with /login <password>'), 'login');
  assert.strictEqual(classifyAuthPrompt('Connecte-toi avec /login <pass>'), 'login');
  assert.strictEqual(classifyAuthPrompt('Welcome to the server!'), null);
});

test('genPassword produit un pw fort et différent à chaque appel', () => {
  const a = genPassword();
  const b = genPassword();
  assert.ok(a.length >= 12);
  assert.notStrictEqual(a, b);
  assert.match(a, /[A-Za-z]/);
  assert.match(a, /[0-9]/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mc-agent && node --test auth.test.js`
Expected: FAIL (`Cannot find module './auth'`).

- [ ] **Step 3: Write minimal implementation**

```js
// mc-agent/auth.js
'use strict';
// Bootstrap AuthMe : décide register vs login depuis le prompt serveur, génère/stocke un pw.
const crypto = require('crypto');

/** 'register' | 'login' | null d'après un message serveur (FR/EN, tolérant). */
function classifyAuthPrompt(msg) {
  const s = String(msg || '').toLowerCase();
  if (s.includes('/register') || s.includes('enregistr') || s.includes('registr')) return 'register';
  if (s.includes('/login') || s.includes('connecte') || s.includes('log in') || s.includes('logged')) return 'login';
  return null;
}

/** Mot de passe aléatoire fort (alphanumérique, 16 chars). */
function genPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(16);
  let pw = '';
  for (let i = 0; i < 16; i++) pw += chars[bytes[i] % chars.length];
  // garantir au moins 1 chiffre + 1 lettre
  return 'A' + pw + '7';
}

module.exports = { classifyAuthPrompt, genPassword };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mc-agent && node --test auth.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add mc-agent/auth.js mc-agent/auth.test.js
git commit -m "feat(mc-agent): AuthMe bootstrap helpers (classify prompt + genPassword)"
```

---

## Task 6: Wiring dans `index.js` (+ `orders.js`) — live

**Files:**
- Modify: `mc-agent/orders.js` (ajouter le verbe `start`)
- Modify: `mc-agent/index.js` (auth au spawn, planner comme tâche, reprise, garde-fou morts)

> Intégration = validée en Task 7 (serveur live). Chaque step montre le code exact.

- [ ] **Step 1: Ajouter le verbe `start` au parseur d'ordres**

Dans `mc-agent/orders.js`, dans la table de parsing des verbes, ajouter (à côté de `afk`/`stop`) :
```js
// reconnaît "start" / "start mining" / "mvp" → lance l'objectif autonome MVP
if (/^(start|mvp)\b/i.test(t)) return { verb: 'startAutonomous', args: {} };
```
(Adapter à la structure exacte de `parseOrder` ; renvoyer `{verb:'startAutonomous', args:{}}`.)

- [ ] **Step 2: Importer le planner + world model dans `index.js`**

Après les autres `require('./...')` (vers la ligne 35) :
```js
const { runPlanner } = require('./planner');
const { MVP_CHAIN } = require('./goals');
const { loadWorld, saveWorld, setObjective, clearObjective } = require('./worldModel');
const { craftItem, _nearestTable } = require('./skills/craft');
const { placeBlockNear } = require('./skills/placeBlockNear');
const { classifyAuthPrompt, genPassword } = require('./auth');
```

- [ ] **Step 3: Charger le world model + définir le dispatch de skills**

Après `const taskCtl = createTaskController();` (ligne ~71) :
```js
const worldFile = args.world || path.join(__dirname, '..', 'data', `mc_agent_world_${args.user || 'TrainBot'}.json`);
const world = loadWorld(worldFile);

// Dispatch d'un but de la chaîne vers le skill réel.
async function runGoalSkill(goal) {
  if (goal.skill === 'gatherLog') {
    // récolte n'importe quelle bûche : trouve l'essence la plus proche
    const logName = (bot.inventory && Object.keys(bot.registry.blocksByName).find((n) => n.endsWith('_log'))) || 'oak_log';
    return gather(bot, { name: logName, count: goal.args.count }, taskToken);
  }
  if (goal.skill === 'gather') return gather(bot, goal.args, taskToken);
  if (goal.skill === 'craftPlanks') {
    // essence-agnostique : planches = bûche détenue → *_planks (recette 2x2)
    const log = bot.inventory.items().find((i) => i.name.endsWith('_log'));
    if (!log) return { ok: false, reason: 'not_found' };
    return craftItem(bot, { name: log.name.replace('_log', '_planks'), count: goal.args.count });
  }
  if (goal.skill === 'craft') return craftItem(bot, goal.args); // crafting_table/stick/pickaxe : recette générique (n'importe quelles planches)
  if (goal.skill === 'placeTable') return placeBlockNear(bot, 'crafting_table');
  return { ok: false, reason: 'unknown_skill' };
}

let taskToken = { cancelled: true };
function ctxExtra() { return { hasTable: !!_nearestTable(bot) }; }

// Lance (ou relance) la boucle autonome comme tâche par défaut de taskCtl.
async function startAutonomous(sender) {
  setObjective(world, { type: 'stone_pickaxe', status: 'in_progress' });
  saveWorld(worldFile, world);
  taskToken = taskCtl.begin('autonomous', stopMotion);
  emit({ type: 'autonomous_start', objective: 'stone_pickaxe' });
  const res = await runPlanner(bot, {
    chain: MVP_CHAIN, runSkill: runGoalSkill, ctxExtra,
    onStep: (g) => emit({ type: 'goal', name: g.name }),
  }, taskToken);
  if (taskToken.cancelled) return;            // préempté par une commande
  if (res.done) { clearObjective(world); saveWorld(worldFile, world); if (sender) ackPrivate(sender, doneWord()); emit({ type: 'autonomous_done' }); }
  else if (res.stalled) { if (sender) ackPrivate(sender, failMsg('not_found')); emit({ type: 'autonomous_stalled', goal: res.goal }); }
}
```

- [ ] **Step 4: Brancher le verbe `startAutonomous` dans `executeOrder`**

Dans le `switch (order.verb)` de `executeOrder` (ligne ~157), ajouter un case :
```js
    case 'startAutonomous': { startAutonomous(sender); break; }   // ne pas await : tourne en tâche de fond
```

- [ ] **Step 5: Reprise après une commande directe (préemption → resume)**

À la fin de `executeOrder`, juste avant `emit({ type: 'order_done', ...})`, ajouter — relance l'objectif si un était en cours et que la commande n'est pas persistante (`stop`/`afk`/`guard`/`startAutonomous` gèrent leur propre état) :
```js
  const transient = !['stop', 'afk', 'guard', 'follow', 'pvp', 'startAutonomous'].includes(order.verb);
  if (transient && world.objective && world.objective.status === 'in_progress') {
    startAutonomous(null); // relance : le planner re-dérive depuis l'état courant
  }
```

- [ ] **Step 6: Reprise au spawn (restart) + garde-fou morts**

Modifier le handler `bot.once('spawn', ...)` (ligne ~122) en `bot.on('spawn', ...)` et y ajouter auth + reprise. Ajouter aussi le compteur de morts. Remplacer le bloc spawn par :
```js
let deathTimes = [];
async function onSpawn() {
  bot.pathfinder.setMovements(new Movements(bot));
  installReflexes(bot, { emit, fleeFrom });
  emit({ type: 'status', state: 'spawned', username: bot.username, profile: profile ? profile.id : null });
  // Auth AuthMe : tenter login si pw connu, sinon register. (chaînes confirmées en Task 0/7)
  await tryAuth();
  // Reprise d'objectif après restart/mort
  if (world.objective && world.objective.status === 'in_progress') {
    emit({ type: 'autonomous_resume', objective: world.objective.type });
    startAutonomous(null);
  }
}
bot.on('spawn', () => { onSpawn().catch((e) => emit({ type: 'error', message: String(e && e.message || e) })); });

// Garde-fou anti-boucle de mort : 3 morts / 10 min → stop + notifie
bot.on('death', () => {
  emit({ type: 'status', state: 'dead' });
  const now = bot.time ? bot.time.age : deathTimes.length; // horloge de jeu (ticks) si dispo
  deathTimes.push(Date.now());
  deathTimes = deathTimes.filter((t) => Date.now() - t < 10 * 60 * 1000);
  if (deathTimes.length >= 3) {
    taskCtl.cancel();
    if (world.objective) { world.objective.status = 'paused'; saveWorld(worldFile, world); }
    emit({ type: 'autonomous_stalled', reason: 'death_loop' });
  }
  // sinon : le respawn rappellera onSpawn() → reprise (le planner re-dérive)
});
```
(Supprimer l'ancien `bot.once('spawn', ...)` et l'ancien `bot.on('death', ...)`.)

- [ ] **Step 7: Auth AuthMe (envoi commandes + stockage pw)**

Ajouter la fonction `tryAuth` (avant `onSpawn`). Le pw vit dans le profil serveur ; ici on le passe via `--authpw` (écrit par le backend dans `mc_agent_servers.json`) ou on en génère un et on l'émet pour persistance backend :
```js
async function tryAuth() {
  let pw = args.authpw || null;
  // Écoute le prompt AuthMe pendant ~3 s ; agit selon login/register.
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; bot.removeListener('messagestr', onMsg); resolve(); } };
    const onMsg = (msg) => {
      const kind = classifyAuthPrompt(msg);
      if (kind === 'login' && pw) { bot.chat(`/login ${pw}`); emit({ type: 'auth', action: 'login' }); finish(); }
      else if (kind === 'register') {
        if (!pw) { pw = genPassword(); emit({ type: 'auth', action: 'generated_pw', persist: true }); } // backend persiste dans mc_agent_servers.json (chmod 600)
        bot.chat(`/register ${pw} ${pw}`); emit({ type: 'auth', action: 'register' }); finish();
      }
    };
    bot.on('messagestr', onMsg);
    setTimeout(finish, 3000); // pas de prompt (serveur sans login) → on continue
  });
}
```
> ⚠️ Le backend Python doit (a) passer `--authpw` depuis `mc_agent_servers.json` s'il existe, (b) à réception de l'event `auth/generated_pw`, écrire le pw dans `mc_agent_servers.json` (champ `authmePassword`, fichier chmod 600). Sous-tâche backend, cf. Task 7.

- [ ] **Step 8: Vérifier que rien n'est cassé au parse**

Run: `cd mc-agent && node -e "new Function(require('fs').readFileSync('index.js','utf8'))" && echo "index.js parse OK"`
Expected: `index.js parse OK` (réflexe piège #28 : valider le parse avant tout push).
Run aussi : `cd mc-agent && node --test` → tous les tests existants + nouveaux PASS.

- [ ] **Step 9: Commit**

```bash
git add mc-agent/index.js mc-agent/orders.js
git commit -m "feat(mc-agent): wire autonomous planner (start, resume, death-guard, AuthMe)"
```

---

## Task 7: Validation live du MVP (serveur de test)

> Les 6 critères de succès §8 de la spec. Manuel, sur le serveur de Task 0.

- [ ] **Step 1 — Backend : passer/persister le pw AuthMe**

Côté backend (`mc_agent_*`), brancher : passer `--authpw` au subprocess depuis `mc_agent_servers.json` ; à l'event `auth/generated_pw`, écrire `authmePassword` dans `mc_agent_servers.json` + `chmod 600`. Confirmer les chaînes AuthMe relevées en Task 0.

- [ ] **Step 2 — Connexion + auth** : lancer le bot → il passe le login AuthMe → spawn. ✅ Critère 6.
- [ ] **Step 3 — Run autonome** : `/msg <bot> start` → le bot enchaîne logs→planks→table→place→sticks→pioche bois→cobble→pioche pierre → whisper « fait ». Vérifier la pioche pierre en inventaire. ✅ Critère 1.
- [ ] **Step 4 — Préemption/reprise** : pendant le run, `/msg <bot> come` → il vient → puis repart seul finir l'objectif. ✅ Critère 2.
- [ ] **Step 5 — Restart** : couper/relancer le subprocess en plein run → au spawn il reprend l'objectif (JSON) et finit. ✅ Critère 3.
- [ ] **Step 6 — Mort** : le tuer (`/kill` ou lave) en plein run → respawn → re-dérive et finit ; 3 morts/10 min → stop+notifie. ✅ Critère 4.
- [ ] **Step 7 — Coût** : vérifier les logs → **0 appel LLM** sur tout le run autonome. ✅ Critère 5.
- [ ] **Step 8 — Commit/MAJ** : noter le résultat dans le vault + CLAUDE.md (nouveau piège éventuel). Ne PAS merger sur `main` tant que les 6 critères ne passent pas.

---

## Self-Review

**Spec coverage :**
- 4 pièces : arbitrage (Task 6 step 5/6 préemption+resume via taskCtl) ✓ ; persistance (Task 1 + Task 6 step 3/6) ✓ ; mort/déco (Task 6 step 6 garde-fou + resume au spawn) ✓ ; budget LLM (planner 0-token, Task 4 ; pas d'appel LLM dans la boucle) ✓.
- Auth AuthMe (Task 5 + Task 6 step 7 + Task 7 step 1) ✓.
- MVP zéro→pioche pierre + 6 critères (Task 2 chaîne + Task 7) ✓.
- Home/stockage, élytre, etc. = hors-scope MVP (déclaré) ✓.

**Placeholder scan :** les steps « live » (Task 0, 7) sont des checklists ops, pas du code à compléter — légitime. Le backend (passer/persister `--authpw`) est explicité (Task 6 step 7 note + Task 7 step 1). Pas de TODO/TBD dans le code.

**Type consistency :** `runPlanner(bot, {chain, runSkill, ctxExtra, maxStalls, onStep}, token)` cohérent entre Task 4 (def/test) et Task 6 (appel). `firstUnmet(chain, ctx)` + `buildCtxInv(bot)` cohérents goals.js ↔ planner.js. `craftItem(bot,{name,count})` / `gather(bot,{name,count},token)` / `_nearestTable(bot)` = signatures réelles vérifiées dans le code existant. `taskCtl.begin(name, cleanup)→token` réel. `placeBlockNear(bot, itemName)→{ok,reason}` cohérent Task 3 ↔ Task 6.

**Note (résolu) :** essence-agnostique — `gatherLog` récolte n'importe quelle bûche présente, `craftPlanks` la convertit en `*_planks` correspondantes, et les recettes table/stick/pickaxe acceptent n'importe quelles planches (mineflayer `recipesFor` matche l'inventaire). Aucun biome oak requis.
