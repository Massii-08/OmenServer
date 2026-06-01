# MC Agent — Couche de commandes directes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Donner au bot Minecraft 16 commandes en anglais, données en `/msg` privé, exécutées localement **sans appel LLM**, avec langue (FR/EN/IT) au profil, port optionnel, mémoire de conversation et acks privés.

**Architecture:** Un parseur pur (`orders.js`) intercepte les ordres sur le canal whisper **avant** `think()` ; un dispatcher route chaque verbe vers un skill mineflayer ; un contrôleur de tâche (`tasks.js`) garde une seule action longue annulable ; la conversation continue via le LLM avec un historique borné (`memory.js`) et une langue injectée dans le system prompt.

**Tech Stack:** Node.js (mineflayer + pathfinder + pvp + collectblock, `node --test`), Python (FastAPI, pytest), Vanilla JS frontend.

---

## Préambule — environnement de travail

- **Worktree** : `/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-direct-commands` (déjà créé, branche `worktree-feat+mc-agent-direct-commands`).
- **Tests Node** : `cd mc-agent && node --test test/<fichier>.test.js` (cwd = `mc-agent`). Suite complète : `node --test`.
- **Tests Python** : depuis la racine worktree, `"/Users/massimiliano/omenserver Project/Projet serveur/venv/bin/python" -m pytest backend/bots/tests/<fichier> -q`.
- **⚠️ Git** : `mc-agent/node_modules` est un **symlink non tracké** (gitignore ne l'attrape pas car symlink ≠ dossier). **TOUJOURS `git add <chemins explicites>`, JAMAIS `git add -A`/`git add .`** depuis la racine du worktree.
- Baseline de départ : **Node 89 + Python 58** verts.
- **Invariant à ne jamais casser** : `buildSystemPrompt(null) === SYSTEM_PROMPT` (`mc-agent/test/brain_think.test.js`).

---

## File Structure

| Fichier | Responsabilité | Tâche |
|---|---|---|
| `mc-agent/orders.js` | Parseur `parseOrder(text)→{verb,args}\|null` (16 verbes) | 1 |
| `mc-agent/tools.js` | `toolCategoryFor`, `bestToolFor`, `bestWeapon`, `tierRank` | 2 |
| `mc-agent/tasks.js` | `createTaskController` (1 tâche active annulable) | 3 |
| `mc-agent/memory.js` | `createMemory` (historique/joueur, fenêtre + TTL) | 4 |
| `mc-agent/brain.js` | +`buildLangDocs`, `buildSystemPrompt` 4e arg, `think` +history/+lang | 5 |
| `mc-agent/skills/gather.js` | `take` (outil auto + auto-défense) | 6 |
| `mc-agent/skills/mineDown.js` | `mine down` | 7 |
| `mc-agent/skills/guard.js` | `guard` | 8 |
| `mc-agent/skills/give.js` | `give <objet>` / `give all` | 9 |
| `mc-agent/skills/craft.js` | `craft` | 10 |
| `mc-agent/skills/deposit.js` | `deposit` | 11 |
| `mc-agent/skills/equip.js` | `equip` + `eat` | 12 |
| `mc-agent/reflexes.js` | export `FOODS` (pour equip.js) | 12 |
| `mc-agent/skills/loiter.js` | `stop` loiter vivant | 13 |
| `mc-agent/index.js` | Câblage : pré-filtre whisper, dispatcher, ack, afk, mémoire, lang | 14 |
| `backend/bots/mc_agent_servers.py` | champ `language` | 15 |
| `backend/bots/mc_agent_router.py` | `language` dans payloads + `/run` | 16 |
| `backend/bots/mc_agent_manager.py` | `--lang` au subprocess | 17 |
| `frontend/js/bots_module.js` + `lang.js` + `index.html` + `sw.js` | port placeholder, select langue, aide commandes, i18n, cache-bust | 18 |

---

## Task 1: `orders.js` — parseur de commandes

**Files:**
- Create: `mc-agent/orders.js`
- Test: `mc-agent/test/orders.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseOrder } = require('../orders');

test('parseOrder: take avec/sans count', () => {
  assert.deepStrictEqual(parseOrder('take dirt 10'), { verb: 'take', args: { name: 'dirt', count: 10 } });
  assert.deepStrictEqual(parseOrder('take diamond_ore'), { verb: 'take', args: { name: 'diamond_ore', count: 1 } });
});

test('parseOrder: follow me uniquement', () => {
  assert.deepStrictEqual(parseOrder('follow me'), { verb: 'follow', args: { who: 'me' } });
  assert.strictEqual(parseOrder('follow Bob'), null); // seul "follow me" est géré
});

test('parseOrder: stop / afk / eat / deposit / guard / give all', () => {
  assert.deepStrictEqual(parseOrder('stop'), { verb: 'stop', args: {} });
  assert.deepStrictEqual(parseOrder('afk'), { verb: 'afk', args: {} });
  assert.deepStrictEqual(parseOrder('eat'), { verb: 'eat', args: {} });
  assert.deepStrictEqual(parseOrder('deposit'), { verb: 'deposit', args: {} });
  assert.deepStrictEqual(parseOrder('guard'), { verb: 'guard', args: {} });
  assert.deepStrictEqual(parseOrder('give all'), { verb: 'giveAll', args: {} });
});

test('parseOrder: give/craft/equip/pvp/tpa/come/goto/mine down', () => {
  assert.deepStrictEqual(parseOrder('give dirt'), { verb: 'give', args: { name: 'dirt' } });
  assert.deepStrictEqual(parseOrder('craft chest 2'), { verb: 'craft', args: { name: 'chest', count: 2 } });
  assert.deepStrictEqual(parseOrder('equip diamond_sword'), { verb: 'equip', args: { name: 'diamond_sword' } });
  assert.deepStrictEqual(parseOrder('pvp Steve'), { verb: 'pvp', args: { player: 'Steve' } });
  assert.deepStrictEqual(parseOrder('tpa me'), { verb: 'tpa', args: { target: 'me' } });
  assert.deepStrictEqual(parseOrder('tpa Alice'), { verb: 'tpa', args: { target: 'Alice' } });
  assert.deepStrictEqual(parseOrder('come'), { verb: 'come', args: {} });
  assert.deepStrictEqual(parseOrder('come here'), { verb: 'come', args: {} });
  assert.deepStrictEqual(parseOrder('goto 10 64 -20'), { verb: 'goto', args: { x: 10, y: 64, z: -20 } });
  assert.deepStrictEqual(parseOrder('mine down 5'), { verb: 'mineDown', args: { count: 5 } });
});

test('parseOrder: casse insensible + inconnu/conversation → null', () => {
  assert.deepStrictEqual(parseOrder('TAKE Dirt 3'), { verb: 'take', args: { name: 'dirt', count: 3 } });
  assert.strictEqual(parseOrder('salut ça va ?'), null);
  assert.strictEqual(parseOrder('can you take a look'), null);
  assert.strictEqual(parseOrder(''), null);
  assert.strictEqual(parseOrder('mine down'), null); // n manquant
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mc-agent && node --test test/orders.test.js`
Expected: FAIL — `Cannot find module '../orders'`.

- [ ] **Step 3: Write minimal implementation**

```js
'use strict';
// Parseur des commandes directes (mot-clé anglais). Pur, testable sans client MC.
// parseOrder(texte) -> {verb, args} | null (null = pas une commande -> flux LLM).

function _int(tok, def) {
  const n = parseInt(tok, 10);
  return Number.isFinite(n) ? n : def;
}

function parseOrder(text) {
  const s = String(text == null ? '' : text).trim().toLowerCase();
  if (!s) return null;
  const p = s.split(/\s+/);

  // multi-mots d'abord
  if (s === 'follow me') return { verb: 'follow', args: { who: 'me' } };
  if (s === 'give all') return { verb: 'giveAll', args: {} };
  if (p[0] === 'come' && (p.length === 1 || (p.length === 2 && p[1] === 'here'))) return { verb: 'come', args: {} };
  if (p[0] === 'mine' && p[1] === 'down') {
    if (p[2] == null) return null;
    return { verb: 'mineDown', args: { count: Math.max(1, _int(p[2], 1)) } };
  }

  switch (p[0]) {
    case 'stop': return { verb: 'stop', args: {} };
    case 'afk': return { verb: 'afk', args: {} };
    case 'eat': return { verb: 'eat', args: {} };
    case 'deposit': return { verb: 'deposit', args: {} };
    case 'guard': return { verb: 'guard', args: {} };
    case 'take':
      if (!p[1]) return null;
      return { verb: 'take', args: { name: p[1], count: Math.max(1, _int(p[2], 1)) } };
    case 'craft':
      if (!p[1]) return null;
      return { verb: 'craft', args: { name: p[1], count: Math.max(1, _int(p[2], 1)) } };
    case 'give':
      if (!p[1]) return null;
      return { verb: 'give', args: { name: p[1] } };
    case 'equip':
      if (!p[1]) return null;
      return { verb: 'equip', args: { name: p[1] } };
    case 'pvp':
      if (!p[1]) return null;
      return { verb: 'pvp', args: { player: text.trim().split(/\s+/)[1] } }; // garde la casse du pseudo
    case 'tpa':
      if (!p[1]) return null;
      return { verb: 'tpa', args: { target: p[1] === 'me' ? 'me' : text.trim().split(/\s+/)[1] } };
    case 'goto':
      if (p[1] == null || p[2] == null || p[3] == null) return null;
      return { verb: 'goto', args: { x: _int(p[1], 0), y: _int(p[2], 0), z: _int(p[3], 0) } };
    default:
      return null;
  }
}

module.exports = { parseOrder };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mc-agent && node --test test/orders.test.js`
Expected: PASS (all subtests). Note: `pvp`/`tpa` gardent la casse du pseudo (le test utilise `Steve`/`Alice`).

- [ ] **Step 5: Commit**

```bash
git add mc-agent/orders.js mc-agent/test/orders.test.js
git commit -m "feat(mc-agent): parseur de commandes directes (orders.js)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `tools.js` — sélection d'outil et d'arme

**Files:**
- Create: `mc-agent/tools.js`
- Test: `mc-agent/test/tools.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { toolCategoryFor, tierRank, bestToolFor, bestWeapon } = require('../tools');

function botWith(names) {
  return { inventory: { items: () => names.map((n) => ({ name: n, type: 1 })) } };
}

test('toolCategoryFor: matériaux', () => {
  assert.strictEqual(toolCategoryFor('dirt'), 'shovel');
  assert.strictEqual(toolCategoryFor('grass_block'), 'shovel');
  assert.strictEqual(toolCategoryFor('stone'), 'pickaxe');
  assert.strictEqual(toolCategoryFor('diamond_ore'), 'pickaxe');
  assert.strictEqual(toolCategoryFor('deepslate_diamond_ore'), 'pickaxe');
  assert.strictEqual(toolCategoryFor('oak_log'), 'axe');
  assert.strictEqual(toolCategoryFor('oak_leaves'), 'shears');
  assert.strictEqual(toolCategoryFor('air'), null);
});

test('tierRank: palier', () => {
  assert.strictEqual(tierRank('wooden_pickaxe'), 0);
  assert.strictEqual(tierRank('diamond_pickaxe'), 4);
  assert.strictEqual(tierRank('netherite_axe'), 5);
  assert.strictEqual(tierRank('apple'), -1);
});

test('bestToolFor: palier le + haut de la bonne catégorie', () => {
  const bot = botWith(['iron_pickaxe', 'diamond_pickaxe', 'stone_shovel']);
  assert.strictEqual(bestToolFor(bot, { name: 'stone' }).name, 'diamond_pickaxe');
  assert.strictEqual(bestToolFor(bot, { name: 'dirt' }).name, 'stone_shovel');
  assert.strictEqual(bestToolFor(bot, { name: 'oak_log' }), null); // pas de hache
  assert.strictEqual(bestToolFor(botWith(['shears']), { name: 'oak_leaves' }).name, 'shears');
});

test('bestWeapon: épée > hache, palier', () => {
  assert.strictEqual(bestWeapon(botWith(['stone_axe', 'wooden_sword'])).name, 'wooden_sword');
  assert.strictEqual(bestWeapon(botWith(['diamond_axe', 'iron_sword'])).name, 'iron_sword');
  assert.strictEqual(bestWeapon(botWith(['netherite_axe'])).name, 'netherite_axe');
  assert.strictEqual(bestWeapon(botWith(['apple'])), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mc-agent && node --test test/tools.test.js`
Expected: FAIL — `Cannot find module '../tools'`.

- [ ] **Step 3: Write minimal implementation**

```js
'use strict';
// Sélection d'outil/arme : quel outil de l'inventaire pour casser un bloc, quelle arme pour frapper.
// Quasi-pur (lit bot.inventory + nom du bloc). Testable avec un bot mocké.

const TIERS = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'];

/** Score de palier ('diamond_pickaxe' → 4). -1 si pas un item à palier. */
function tierRank(name) {
  const s = String(name || '');
  for (let i = 0; i < TIERS.length; i++) if (s.startsWith(TIERS[i] + '_')) return i;
  return -1;
}

/** Catégorie d'outil idéale pour un nom de bloc, ou null (main). Pur. */
function toolCategoryFor(blockName) {
  const n = String(blockName || '');
  if (/(_log|_wood|_planks|_stem|_hyphae)$|^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|crimson|warped)_(log|wood|planks)|crafting_table|bookshelf|barrel|^chest$/.test(n)) return 'axe';
  if (/(^dirt$|grass_block|^sand$|gravel|^clay$|soul_sand|soul_soil|podzol|mycelium|^snow$|snow_block|farmland|^mud$|_concrete_powder)$/.test(n)) return 'shovel';
  if (/(stone|cobble|deepslate|granite|diorite|andesite|_ore$|obsidian|netherrack|basalt|blackstone|end_stone|terracotta|_concrete$|bricks?$|^furnace$|tuff|calcite|amethyst)/.test(n)) return 'pickaxe';
  if (/(_leaves$|^cobweb$|_wool$|^vine$)/.test(n)) return 'shears';
  return null;
}

/** Meilleur outil de l'inventaire pour ce bloc (palier le + haut de la bonne catégorie), ou null. */
function bestToolFor(bot, block) {
  const cat = toolCategoryFor(block && block.name);
  if (!cat) return null;
  const items = (bot.inventory && bot.inventory.items()) || [];
  let best = null, bestRank = -2;
  for (const it of items) {
    if (!it || !it.name) continue;
    if (cat === 'shears') { if (it.name === 'shears') return it; continue; }
    if (!it.name.endsWith('_' + cat)) continue;
    const r = tierRank(it.name);
    if (r > bestRank) { bestRank = r; best = it; }
  }
  return best;
}

/** Meilleure arme melee (épée > hache, par palier), ou null (poing). */
function bestWeapon(bot) {
  const items = (bot.inventory && bot.inventory.items()) || [];
  let best = null, bestScore = -1;
  for (const it of items) {
    if (!it || !it.name) continue;
    let base = -1;
    if (it.name.endsWith('_sword')) base = 100;
    else if (it.name.endsWith('_axe')) base = 50;
    else continue;
    const score = base + tierRank(it.name);
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return best;
}

module.exports = { TIERS, tierRank, toolCategoryFor, bestToolFor, bestWeapon };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mc-agent && node --test test/tools.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mc-agent/tools.js mc-agent/test/tools.test.js
git commit -m "feat(mc-agent): sélection outil/arme (tools.js)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `tasks.js` — contrôleur de tâche active

**Files:**
- Create: `mc-agent/tasks.js`
- Test: `mc-agent/test/tasks.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createTaskController } = require('../tasks');

test('begin retourne un token non annulé + active', () => {
  const c = createTaskController();
  const t = c.begin('take', () => {});
  assert.strictEqual(t.cancelled, false);
  assert.strictEqual(c.active, 'take');
});

test('une nouvelle tâche annule la précédente (cleanup + token.cancelled)', () => {
  const c = createTaskController();
  let cleaned = 0;
  const t1 = c.begin('guard', () => { cleaned++; });
  const t2 = c.begin('take', () => {});
  assert.strictEqual(cleaned, 1);
  assert.strictEqual(t1.cancelled, true);
  assert.strictEqual(t2.cancelled, false);
  assert.strictEqual(c.active, 'take');
});

test('cancel exécute le cleanup et vide active', () => {
  const c = createTaskController();
  let cleaned = 0;
  const t = c.begin('loiter', () => { cleaned++; });
  c.cancel();
  assert.strictEqual(cleaned, 1);
  assert.strictEqual(t.cancelled, true);
  assert.strictEqual(c.active, null);
});

test('setCleanup met à jour le cleanup courant', () => {
  const c = createTaskController();
  let a = 0, b = 0;
  c.begin('guard', () => { a++; });
  c.setCleanup(() => { b++; });
  c.cancel();
  assert.strictEqual(a, 0);
  assert.strictEqual(b, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mc-agent && node --test test/tasks.test.js`
Expected: FAIL — `Cannot find module '../tasks'`.

- [ ] **Step 3: Write minimal implementation**

```js
'use strict';
// Contrôleur de tâche longue : une seule active. Démarrer une nouvelle annule la précédente
// (exécute son cleanup + arme token.cancelled). Les boucles vérifient token.cancelled.

function createTaskController() {
  let current = null; // { name, cleanup, token }

  function cancel() {
    if (!current) return;
    const c = current;
    current = null;
    c.token.cancelled = true;
    if (typeof c.cleanup === 'function') { try { c.cleanup(); } catch (e) {} }
  }

  function begin(name, cleanup) {
    cancel();
    const token = { cancelled: false };
    current = { name, cleanup: cleanup || (() => {}), token };
    return token;
  }

  function setCleanup(fn) { if (current) current.cleanup = fn || (() => {}); }

  return { begin, cancel, setCleanup, get active() { return current ? current.name : null; } };
}

module.exports = { createTaskController };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mc-agent && node --test test/tasks.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mc-agent/tasks.js mc-agent/test/tasks.test.js
git commit -m "feat(mc-agent): contrôleur de tâche active annulable (tasks.js)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `memory.js` — mémoire de conversation

**Files:**
- Create: `mc-agent/memory.js`
- Test: `mc-agent/test/memory.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createMemory } = require('../memory');

test('append + history par joueur (insensible casse)', () => {
  const m = createMemory();
  m.append('Bob', 'user', 'salut');
  m.append('bob', 'assistant', 'hello');
  assert.deepStrictEqual(m.history('BOB'), [
    { role: 'user', content: 'salut' },
    { role: 'assistant', content: 'hello' },
  ]);
  assert.deepStrictEqual(m.history('Alice'), []);
});

test('fenêtre tronquée à maxTurns', () => {
  const m = createMemory({ maxTurns: 3 });
  for (let i = 0; i < 5; i++) m.append('Bob', 'user', 'm' + i);
  assert.deepStrictEqual(m.history('Bob').map((t) => t.content), ['m2', 'm3', 'm4']);
});

test('TTL : reset après inactivité (horloge mockée)', () => {
  let now = 1000;
  const m = createMemory({ ttlMs: 500, now: () => now });
  m.append('Bob', 'user', 'a');
  now = 1400; // < ttl
  assert.strictEqual(m.history('Bob').length, 1);
  now = 2000; // > ttl depuis le dernier accès
  assert.deepStrictEqual(m.history('Bob'), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mc-agent && node --test test/memory.test.js`
Expected: FAIL — `Cannot find module '../memory'`.

- [ ] **Step 3: Write minimal implementation**

```js
'use strict';
// Mémoire de conversation par joueur : fenêtre glissante + TTL d'inactivité (oubli).
// Horloge injectable (tests déterministes), comme RateLimiter.

function createMemory({ maxTurns = 8, ttlMs = 600000, now = () => Date.now() } = {}) {
  const store = new Map(); // userLower -> { turns:[{role,content}], lastTs }
  const key = (u) => String(u == null ? '' : u).trim().toLowerCase();

  function entry(user) {
    const k = key(user);
    let e = store.get(k);
    const t = now();
    if (e && t - e.lastTs > ttlMs) { store.delete(k); e = null; } // expiré → oubli
    if (!e) { e = { turns: [], lastTs: t }; store.set(k, e); }
    return e;
  }

  return {
    history(user) { return entry(user).turns.slice(); },
    append(user, role, content) {
      const e = entry(user);
      e.turns.push({ role: role === 'assistant' ? 'assistant' : 'user', content: String(content == null ? '' : content) });
      if (e.turns.length > maxTurns) e.turns = e.turns.slice(-maxTurns);
      e.lastTs = now();
    },
    reset(user) { store.delete(key(user)); },
  };
}

module.exports = { createMemory };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mc-agent && node --test test/memory.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mc-agent/memory.js mc-agent/test/memory.test.js
git commit -m "feat(mc-agent): mémoire de conversation par joueur (memory.js)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: `brain.js` — langue + historique

**Files:**
- Modify: `mc-agent/brain.js`
- Test: `mc-agent/test/brain_lang.test.js` (nouveau) + `mc-agent/test/brain_think.test.js` (inchangé, doit rester vert)

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildLangDocs, buildSystemPrompt, SYSTEM_PROMPT, think } = require('../brain');

test('buildLangDocs: fr/en/it sinon vide', () => {
  assert.match(buildLangDocs('fr'), /francais/i);
  assert.match(buildLangDocs('en'), /anglais/i);
  assert.match(buildLangDocs('it'), /italien/i);
  assert.strictEqual(buildLangDocs(''), '');
  assert.strictEqual(buildLangDocs('xx'), '');
});

test('buildSystemPrompt(null) reste === SYSTEM_PROMPT (invariant pinné)', () => {
  assert.strictEqual(buildSystemPrompt(null), SYSTEM_PROMPT);
});

test('buildSystemPrompt(profil,…,langDocs) inclut la langue', () => {
  const profile = { id: 'x', persona: 'P', tells: ['t'] };
  const out = buildSystemPrompt(profile, '', '', buildLangDocs('it'));
  assert.match(out, /italien/i);
});

test('think: insère l’historique avant le message courant', async () => {
  let captured = null;
  const client = { messages: { create: async (req) => { captured = req; return { content: [{ text: '{"reply":"ok","action":null,"args":{}}' }] }; } } };
  await think(client, {
    state: {}, message: 'et après ?', model: 'm', limiter: null,
    history: [{ role: 'user', content: 'salut' }, { role: 'assistant', content: 'hello' }], lang: 'fr',
  });
  assert.strictEqual(captured.messages.length, 3);
  assert.strictEqual(captured.messages[0].content, 'salut');
  assert.match(captured.messages[2].content, /et après \?/);
  assert.match(captured.system, /francais/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mc-agent && node --test test/brain_lang.test.js`
Expected: FAIL — `buildLangDocs is not a function`.

- [ ] **Step 3: Write minimal implementation**

Edit `mc-agent/brain.js`. Add `buildLangDocs` and thread `langDocs`/`history` through. Replace `buildSystemPrompt`, `think`, and `module.exports`:

```js
const LANG_NAMES = { fr: 'francais', en: 'anglais', it: 'italien' };

/** Bloc langue pour le system prompt. '' si langue inconnue/absente. */
function buildLangDocs(lang) {
  const name = LANG_NAMES[String(lang || '').toLowerCase()];
  return name ? `Ecris TOUJOURS le champ "reply" en ${name}.` : '';
}

/** Construit le system prompt : persona + commandes serveur + gens de confiance + langue. */
function buildSystemPrompt(profile, commandDocs = '', trustDocs = '', langDocs = '') {
  const base = profile
    ? [
        "Tu incarnes un joueur dans une partie Minecraft (cadre d'entrainement de moderation).",
        profile.persona || '',
        'Reponds UNIQUEMENT en JSON : {"reply": string, "action": string|null, "args": object, "command": string|null}.',
        ACTIONS_DOC,
      ]
    : [SYSTEM_PROMPT];
  if (commandDocs) base.push(commandDocs);
  if (trustDocs) base.push(trustDocs);
  if (langDocs) base.push(langDocs);
  return base.filter(Boolean).join(' ');
}

async function think(client, { state, message, model, limiter, profile = null, commandDocs = '', trustDocs = '', sender = '', history = [], lang = '' }) {
  if (limiter && !limiter.tryAcquire()) return null;
  const fromLine = sender ? `De: ${sender}\n` : '';
  const prior = (Array.isArray(history) ? history : []).map((h) => ({
    role: h && h.role === 'assistant' ? 'assistant' : 'user',
    content: String((h && h.content) || ''),
  }));
  const resp = await client.messages.create({
    model,
    max_tokens: 300,
    system: buildSystemPrompt(profile, commandDocs, trustDocs, buildLangDocs(lang)),
    messages: [...prior, { role: 'user', content: `Etat: ${JSON.stringify(state)}\n${fromLine}Message recu: ${message}` }],
  });
  const text = (resp.content || []).map((b) => b.text || '').join('');
  return parseDecision(text);
}

module.exports = { parseDecision, RateLimiter, think, SYSTEM_PROMPT, buildSystemPrompt, buildLangDocs };
```

- [ ] **Step 4: Run tests to verify they pass (new + pinned)**

Run: `cd mc-agent && node --test test/brain_lang.test.js test/brain_think.test.js test/brain_profile.test.js test/brain_command.test.js test/brain_trust.test.js`
Expected: PASS, dont l'invariant `buildSystemPrompt(null) === SYSTEM_PROMPT`.

- [ ] **Step 5: Commit**

```bash
git add mc-agent/brain.js mc-agent/test/brain_lang.test.js
git commit -m "feat(mc-agent): langue + historique dans think (brain.js)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: `skills/gather.js` — `take` (outil auto + auto-défense)

**Files:**
- Create: `mc-agent/skills/gather.js`
- Test: `mc-agent/test/gather.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { gather } = require('../skills/gather');

function makeBot({ found = true, hostile = null } = {}) {
  const calls = { equip: [], collect: 0, attack: 0 };
  return {
    calls,
    registry: { blocksByName: { dirt: { id: 3 }, diamond_ore: { id: 56 } } },
    inventory: { items: () => [{ name: 'diamond_shovel' }, { name: 'iron_pickaxe' }] },
    entity: { position: { distanceTo: () => 2 } },
    findBlock: () => (found ? { name: 'dirt', position: {} } : null),
    nearestEntity: () => hostile,
    equip: async (it) => { calls.equip.push(it.name); },
    collectBlock: { collect: async () => { calls.collect++; } },
    pvp: { attack: () => { calls.attack++; } },
  };
}

test('gather: bloc introuvable → {ok:false, not_found}', async () => {
  const r = await gather(makeBot({ found: false }), { name: 'dirt', count: 1 });
  assert.deepStrictEqual(r, { ok: false, reason: 'not_found' });
});

test('gather: équipe le meilleur outil (pelle pour dirt) et ramasse n fois', async () => {
  const bot = makeBot();
  const r = await gather(bot, { name: 'dirt', count: 2 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(bot.calls.collect, 2);
  assert.ok(bot.calls.equip.includes('diamond_shovel'));
});

test('gather: se défend si un hostile est proche', async () => {
  const hostile = { type: 'mob', kind: 'Hostile mobs', position: { distanceTo: () => 3 } };
  const bot = makeBot({ hostile });
  await gather(bot, { name: 'dirt', count: 1 });
  assert.ok(bot.calls.attack >= 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mc-agent && node --test test/gather.test.js`
Expected: FAIL — `Cannot find module '../skills/gather'`.

- [ ] **Step 3: Write minimal implementation**

```js
'use strict';
// `take <bloc> [n]` : récolte n× le bloc le + proche avec le meilleur outil, en se défendant.
const { bestToolFor, bestWeapon } = require('../tools');

function _ids(bot, name) {
  const def = bot.registry && bot.registry.blocksByName && bot.registry.blocksByName[name];
  return def ? [def.id] : null;
}

/** Mob hostile à portée (≤ radius) du bot, ou null. */
function nearbyHostile(bot, radius = 4) {
  const self = bot.entity && bot.entity.position;
  if (!self) return null;
  return bot.nearestEntity((e) => {
    if (!e || e.type !== 'mob' || e.kind !== 'Hostile mobs' || !e.position) return false;
    const d = e.position.distanceTo ? e.position.distanceTo(self) : 999;
    return d <= radius;
  });
}

/** Si un hostile est proche : équipe la meilleure arme et l'attaque. true si défense engagée. */
async function defendIfNeeded(bot) {
  const foe = nearbyHostile(bot);
  if (!foe) return false;
  const w = bestWeapon(bot);
  if (w) { try { await bot.equip(w, 'hand'); } catch (e) {} }
  try { bot.pvp.attack(foe); } catch (e) {}
  return true;
}

/** Récolte `count`× le bloc `name` le + proche. {ok, reason?/got}. `token` = annulation. */
async function gather(bot, { name, count = 1 } = {}, token = null) {
  if (!name) return { ok: false, reason: 'no_block' };
  let got = 0;
  for (let i = 0; i < count; i++) {
    if (token && token.cancelled) return { ok: true, got, cancelled: true };
    await defendIfNeeded(bot);
    const block = bot.findBlock({ matching: _ids(bot, name), maxDistance: 48 });
    if (!block) {
      if (got === 0) return { ok: false, reason: 'not_found' };
      break;
    }
    const tool = bestToolFor(bot, block);
    if (tool) { try { await bot.equip(tool, 'hand'); } catch (e) {} }
    try { await bot.collectBlock.collect(block); got++; }
    catch (e) { if (got === 0) return { ok: false, reason: 'collect_failed' }; break; }
  }
  return { ok: true, got };
}

module.exports = { gather, nearbyHostile, defendIfNeeded };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mc-agent && node --test test/gather.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mc-agent/skills/gather.js mc-agent/test/gather.test.js
git commit -m "feat(mc-agent): skill take (gather.js) — outil auto + auto-défense

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: `skills/mineDown.js` — `mine down`

**Files:**
- Create: `mc-agent/skills/mineDown.js`
- Test: `mc-agent/test/mineDown.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { mineDown } = require('../skills/mineDown');

function makeBot(belowNames) {
  let i = 0;
  const calls = { dig: 0 };
  return {
    calls,
    inventory: { items: () => [{ name: 'diamond_pickaxe' }] },
    entity: { position: { offset: (dx, dy) => ({ k: dy }) } },
    blockAt: (p) => {
      // p.k = -1 (sous les pieds) ou -2
      if (p.k === -1) { const n = belowNames[i] || 'air'; return { name: n }; }
      return { name: belowNames[i + 1] || 'stone' };
    },
    equip: async () => {},
    dig: async () => { calls.dig++; i++; },
  };
}

test('mineDown: vide en dessous → void_below', async () => {
  const r = await mineDown(makeBot(['air']), { count: 3 });
  assert.deepStrictEqual(r, { ok: false, reason: 'void_below' });
});

test('mineDown: lave en dessous → danger_below', async () => {
  const r = await mineDown(makeBot(['lava']), { count: 3 });
  assert.deepStrictEqual(r, { ok: false, reason: 'danger_below' });
});

test('mineDown: creuse n blocs de pierre', async () => {
  const bot = makeBot(['stone', 'stone', 'stone', 'stone']);
  const r = await mineDown(bot, { count: 3 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(bot.calls.dig, 3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mc-agent && node --test test/mineDown.test.js`
Expected: FAIL — `Cannot find module '../skills/mineDown'`.

- [ ] **Step 3: Write minimal implementation**

```js
'use strict';
// `mine down <n>` : creuse le bloc sous les pieds n fois, outil auto, garde-fou lave/vide.
const { bestToolFor } = require('../tools');
const DANGER = new Set(['lava', 'flowing_lava', 'water', 'flowing_water']);
const VOID = new Set(['air', 'cave_air', 'void_air']);

async function mineDown(bot, { count = 1 } = {}, token = null) {
  let dug = 0;
  for (let i = 0; i < count; i++) {
    if (token && token.cancelled) return { ok: true, dug, cancelled: true };
    const pos = bot.entity && bot.entity.position;
    if (!pos) return { ok: false, reason: 'no_pos' };
    const below = bot.blockAt(pos.offset(0, -1, 0));
    if (!below || VOID.has(below.name)) return { ok: dug > 0, dug, reason: 'void_below' };
    if (DANGER.has(below.name)) return { ok: dug > 0, dug, reason: 'danger_below' };
    const below2 = bot.blockAt(pos.offset(0, -2, 0));
    if (below2 && DANGER.has(below2.name)) return { ok: dug > 0, dug, reason: 'danger_below' };
    const tool = bestToolFor(bot, below);
    if (tool) { try { await bot.equip(tool, 'hand'); } catch (e) {} }
    try { await bot.dig(below); dug++; }
    catch (e) { return { ok: dug > 0, dug, reason: 'dig_failed' }; }
  }
  return { ok: true, dug };
}

module.exports = { mineDown, DANGER, VOID };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mc-agent && node --test test/mineDown.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mc-agent/skills/mineDown.js mc-agent/test/mineDown.test.js
git commit -m "feat(mc-agent): skill mine down (mineDown.js)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: `skills/guard.js` — `guard`

**Files:**
- Create: `mc-agent/skills/guard.js`
- Test: `mc-agent/test/guard.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { guardTick, guard } = require('../skills/guard');

function makeBot(foe) {
  const calls = { attack: 0, equip: [] };
  return {
    calls,
    inventory: { items: () => [{ name: 'iron_sword' }] },
    nearestEntity: () => foe,
    equip: async (it) => { calls.equip.push(it.name); },
    pvp: { attack: () => { calls.attack++; }, stop: () => {} },
  };
}

test('guardTick: attaque le mob hostile présent avec la meilleure arme', async () => {
  const bot = makeBot({ type: 'mob', kind: 'Hostile mobs', position: {} });
  await guardTick(bot);
  assert.strictEqual(bot.calls.attack, 1);
  assert.ok(bot.calls.equip.includes('iron_sword'));
});

test('guardTick: aucun hostile → ne fait rien', async () => {
  const bot = makeBot(null);
  await guardTick(bot);
  assert.strictEqual(bot.calls.attack, 0);
});

test('guard: retourne une fonction stop()', () => {
  const bot = makeBot(null);
  const stop = guard(bot, { cancelled: false }, { intervalMs: 100000 });
  assert.strictEqual(typeof stop, 'function');
  stop();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mc-agent && node --test test/guard.test.js`
Expected: FAIL — `Cannot find module '../skills/guard'`.

- [ ] **Step 3: Write minimal implementation**

```js
'use strict';
// `guard` : tue les mobs hostiles autour jusqu'à annulation (token). Boucle setInterval.
const { bestWeapon } = require('../tools');

function nearestHostile(bot) {
  return bot.nearestEntity((e) => e && e.type === 'mob' && e.kind === 'Hostile mobs' && e.position);
}

/** Un cycle de garde : si hostile, équipe l'arme + attaque. Testable sans timer. */
async function guardTick(bot) {
  const foe = nearestHostile(bot);
  if (!foe) return false;
  const w = bestWeapon(bot);
  if (w) { try { await bot.equip(w, 'hand'); } catch (e) {} }
  try { bot.pvp.attack(foe); } catch (e) {}
  return true;
}

/** Démarre la boucle de garde. Retourne stop() (cleanup). */
function guard(bot, token, { intervalMs = 1000 } = {}) {
  const run = () => { if (!token || !token.cancelled) guardTick(bot).catch(() => {}); };
  const id = setInterval(run, intervalMs);
  run();
  return () => { clearInterval(id); try { bot.pvp.stop(); } catch (e) {} };
}

module.exports = { guard, guardTick, nearestHostile };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mc-agent && node --test test/guard.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mc-agent/skills/guard.js mc-agent/test/guard.test.js
git commit -m "feat(mc-agent): skill guard (guard.js)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: `skills/give.js` — `give <objet>` / `give all`

**Files:**
- Create: `mc-agent/skills/give.js`
- Test: `mc-agent/test/give.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { giveItem, giveAll } = require('../skills/give');

function makeBot(names) {
  const calls = { tossed: [] };
  return {
    calls,
    players: {},
    inventory: { items: () => names.map((n) => ({ name: n, type: 1 })) },
    lookAt: async () => {},
    tossStack: async (it) => { calls.tossed.push(it.name); },
  };
}

test('giveItem: rien à donner → {ok:false,no_item}', async () => {
  const r = await giveItem(makeBot(['stone']), { name: 'dirt' }, 'Bob');
  assert.deepStrictEqual(r, { ok: false, reason: 'no_item' });
});

test('giveItem: jette tous les stacks correspondants', async () => {
  const bot = makeBot(['dirt', 'dirt', 'stone']);
  const r = await giveItem(bot, { name: 'dirt' }, 'Bob');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(bot.calls.tossed, ['dirt', 'dirt']);
});

test('giveAll: vide tout l’inventaire', async () => {
  const bot = makeBot(['dirt', 'stone']);
  const r = await giveAll(bot, {}, 'Bob');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(bot.calls.tossed.length, 2);
  assert.deepStrictEqual(await giveAll(makeBot([]), {}, 'Bob'), { ok: false, reason: 'empty' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mc-agent && node --test test/give.test.js`
Expected: FAIL — `Cannot find module '../skills/give'`.

- [ ] **Step 3: Write minimal implementation**

```js
'use strict';
// `give <objet>` (tout d'un type) / `give all` (tout l'inventaire) : jette vers le joueur.

function _match(bot, name) {
  const n = String(name || '').toLowerCase();
  return ((bot.inventory && bot.inventory.items()) || []).filter((it) => it && it.name && (it.name === n || it.name.includes(n)));
}

async function _faceAndToss(bot, sender, item) {
  try {
    const ent = sender && bot.players[sender] && bot.players[sender].entity;
    if (ent && ent.position && bot.lookAt) await bot.lookAt(ent.position);
  } catch (e) {}
  await bot.tossStack(item);
}

async function giveItem(bot, { name } = {}, sender = null) {
  const items = _match(bot, name);
  if (!items.length) return { ok: false, reason: 'no_item' };
  for (const it of items) { try { await _faceAndToss(bot, sender, it); } catch (e) {} }
  return { ok: true, count: items.length };
}

async function giveAll(bot, _args = {}, sender = null) {
  const items = (bot.inventory && bot.inventory.items()) || [];
  if (!items.length) return { ok: false, reason: 'empty' };
  for (const it of items) { try { await _faceAndToss(bot, sender, it); } catch (e) {} }
  return { ok: true, count: items.length };
}

module.exports = { giveItem, giveAll, _match };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mc-agent && node --test test/give.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mc-agent/skills/give.js mc-agent/test/give.test.js
git commit -m "feat(mc-agent): skill give / give all (give.js)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: `skills/craft.js` — `craft`

**Files:**
- Create: `mc-agent/skills/craft.js`
- Test: `mc-agent/test/craft.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { craftItem } = require('../skills/craft');

function makeBot({ hasRecipe = true } = {}) {
  const calls = { craft: 0 };
  return {
    calls,
    registry: { itemsByName: { chest: { id: 54 } }, blocksByName: { crafting_table: { id: 58 } } },
    findBlock: () => null,
    recipesFor: () => (hasRecipe ? [{ id: 1 }] : []),
    craft: async () => { calls.craft++; },
  };
}

test('craft: objet inconnu → unknown_item', async () => {
  const r = await craftItem(makeBot(), { name: 'zzz', count: 1 });
  assert.deepStrictEqual(r, { ok: false, reason: 'unknown_item' });
});

test('craft: pas de recette → no_recipe', async () => {
  const r = await craftItem(makeBot({ hasRecipe: false }), { name: 'chest', count: 1 });
  assert.deepStrictEqual(r, { ok: false, reason: 'no_recipe' });
});

test('craft: succès', async () => {
  const bot = makeBot();
  const r = await craftItem(bot, { name: 'chest', count: 1 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(bot.calls.craft, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mc-agent && node --test test/craft.test.js`
Expected: FAIL — `Cannot find module '../skills/craft'`.

- [ ] **Step 3: Write minimal implementation**

```js
'use strict';
// `craft <objet> [n]` : fabrique via une recette dispo (table proche si nécessaire).

function _itemId(bot, name) {
  const def = bot.registry && bot.registry.itemsByName && bot.registry.itemsByName[String(name || '').toLowerCase()];
  return def ? def.id : null;
}

function _nearestTable(bot) {
  const def = bot.registry && bot.registry.blocksByName && bot.registry.blocksByName.crafting_table;
  if (!def) return null;
  return bot.findBlock({ matching: [def.id], maxDistance: 6 }) || null;
}

async function craftItem(bot, { name, count = 1 } = {}) {
  const id = _itemId(bot, name);
  if (id == null) return { ok: false, reason: 'unknown_item' };
  const table = _nearestTable(bot);
  let recipes = bot.recipesFor(id, null, 1, table) || [];
  if (!recipes.length && !table) recipes = bot.recipesFor(id, null, 1, null) || []; // recette 2x2 sans table
  if (!recipes.length) return { ok: false, reason: 'no_recipe' };
  try { await bot.craft(recipes[0], count, table || undefined); }
  catch (e) { return { ok: false, reason: 'craft_failed' }; }
  return { ok: true };
}

module.exports = { craftItem, _nearestTable };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mc-agent && node --test test/craft.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mc-agent/skills/craft.js mc-agent/test/craft.test.js
git commit -m "feat(mc-agent): skill craft (craft.js)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: `skills/deposit.js` — `deposit`

**Files:**
- Create: `mc-agent/skills/deposit.js`
- Test: `mc-agent/test/deposit.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { deposit } = require('../skills/deposit');

function makeBot({ chest = true, items = ['dirt', 'stone'] } = {}) {
  const calls = { deposit: 0, closed: 0 };
  return {
    calls,
    registry: { blocksByName: { chest: { id: 54 }, barrel: { id: 55 }, trapped_chest: { id: 56 } } },
    inventory: { items: () => items.map((n) => ({ name: n, type: 1, count: 1 })) },
    findBlock: () => (chest ? { position: {} } : null),
    openContainer: async () => ({ deposit: async () => { calls.deposit++; }, close: () => { calls.closed++; } }),
  };
}

test('deposit: pas de coffre → no_chest', async () => {
  assert.deepStrictEqual(await deposit(makeBot({ chest: false })), { ok: false, reason: 'no_chest' });
});

test('deposit: dépose chaque item et ferme', async () => {
  const bot = makeBot();
  const r = await deposit(bot);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(bot.calls.deposit, 2);
  assert.strictEqual(bot.calls.closed, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mc-agent && node --test test/deposit.test.js`
Expected: FAIL — `Cannot find module '../skills/deposit'`.

- [ ] **Step 3: Write minimal implementation**

```js
'use strict';
// `deposit` : dépose tout l'inventaire dans le coffre/baril le + proche.

function _nearestChest(bot) {
  const reg = bot.registry && bot.registry.blocksByName;
  const ids = ['chest', 'trapped_chest', 'barrel'].map((n) => reg && reg[n] && reg[n].id).filter((x) => x != null);
  if (!ids.length) return null;
  return bot.findBlock({ matching: ids, maxDistance: 12 }) || null;
}

async function deposit(bot) {
  const block = _nearestChest(bot);
  if (!block) return { ok: false, reason: 'no_chest' };
  let chest;
  try { chest = await bot.openContainer(block); }
  catch (e) { return { ok: false, reason: 'open_failed' }; }
  const items = (bot.inventory && bot.inventory.items()) || [];
  let n = 0;
  for (const it of items) { try { await chest.deposit(it.type, null, it.count); n++; } catch (e) {} }
  try { chest.close(); } catch (e) {}
  return { ok: true, count: n };
}

module.exports = { deposit, _nearestChest };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mc-agent && node --test test/deposit.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mc-agent/skills/deposit.js mc-agent/test/deposit.test.js
git commit -m "feat(mc-agent): skill deposit (deposit.js)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 12: `skills/equip.js` — `equip` + `eat` (et export `FOODS`)

**Files:**
- Modify: `mc-agent/reflexes.js` (exporter `FOODS`)
- Create: `mc-agent/skills/equip.js`
- Test: `mc-agent/test/equip.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { equipItem, eat, _destFor } = require('../skills/equip');

function makeBot({ items = [], food = 10 } = {}) {
  const calls = { equip: [], consume: 0 };
  return {
    calls, food,
    inventory: { items: () => items.map((n) => ({ name: n, type: 1 })) },
    equip: async (it, dest) => { calls.equip.push([it.name, dest]); },
    consume: async () => { calls.consume++; },
  };
}

test('_destFor: slot selon le type', () => {
  assert.strictEqual(_destFor('diamond_helmet'), 'head');
  assert.strictEqual(_destFor('iron_chestplate'), 'torso');
  assert.strictEqual(_destFor('shield'), 'off-hand');
  assert.strictEqual(_destFor('diamond_sword'), 'hand');
});

test('equipItem: objet absent → no_item ; présent → équipé au bon slot', async () => {
  assert.deepStrictEqual(await equipItem(makeBot({ items: ['dirt'] }), { name: 'sword' }), { ok: false, reason: 'no_item' });
  const bot = makeBot({ items: ['diamond_helmet'] });
  const r = await equipItem(bot, { name: 'diamond_helmet' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(bot.calls.equip[0], ['diamond_helmet', 'head']);
});

test('eat: pas de nourriture → no_food ; nourriture → consume', async () => {
  assert.deepStrictEqual(await eat(makeBot({ items: ['dirt'] })), { ok: false, reason: 'no_food' });
  const bot = makeBot({ items: ['bread'] });
  const r = await eat(bot);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(bot.calls.consume, 1);
});

test('eat: déjà plein → full', async () => {
  assert.deepStrictEqual(await eat(makeBot({ items: ['bread'], food: 20 })), { ok: false, reason: 'full' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mc-agent && node --test test/equip.test.js`
Expected: FAIL — `Cannot find module '../skills/equip'`.

- [ ] **Step 3a: Export FOODS from `reflexes.js`**

Edit `mc-agent/reflexes.js` — last line:

```js
module.exports = { tryEat, shouldFlee, installReflexes, HUNGER_THRESHOLD, HEALTH_THRESHOLD, FOODS };
```

- [ ] **Step 3b: Write `skills/equip.js`**

```js
'use strict';
// `equip <objet>` : équipe un item précis (slot auto). `eat` : mange maintenant (même rassasié pas plein).
const { FOODS } = require('../reflexes');

const ARMOR = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' };

function _destFor(name) {
  const n = String(name || '');
  for (const k of Object.keys(ARMOR)) if (n.endsWith('_' + k) || n === k) return ARMOR[k];
  if (n === 'shield') return 'off-hand';
  return 'hand';
}

function _find(bot, name) {
  const n = String(name || '').toLowerCase();
  return ((bot.inventory && bot.inventory.items()) || []).find((it) => it && it.name && (it.name === n || it.name.includes(n)));
}

async function equipItem(bot, { name } = {}) {
  const it = _find(bot, name);
  if (!it) return { ok: false, reason: 'no_item' };
  try { await bot.equip(it, _destFor(it.name)); } catch (e) { return { ok: false, reason: 'equip_failed' }; }
  return { ok: true };
}

async function eat(bot) {
  if (bot.food != null && bot.food >= 20) return { ok: false, reason: 'full' };
  const food = ((bot.inventory && bot.inventory.items()) || []).find((it) => it && FOODS.has(it.name));
  if (!food) return { ok: false, reason: 'no_food' };
  try { await bot.equip(food, 'hand'); await bot.consume(); }
  catch (e) { return { ok: false, reason: 'eat_failed' }; }
  return { ok: true };
}

module.exports = { equipItem, eat, _destFor };
```

- [ ] **Step 4: Run tests to verify pass (new + reflexes unchanged)**

Run: `cd mc-agent && node --test test/equip.test.js test/reflexes.test.js`
Expected: PASS (les tests reflexes existants restent verts).

- [ ] **Step 5: Commit**

```bash
git add mc-agent/skills/equip.js mc-agent/reflexes.js mc-agent/test/equip.test.js
git commit -m "feat(mc-agent): skills equip + eat (equip.js), export FOODS

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 13: `skills/loiter.js` — `stop` loiter vivant

**Files:**
- Create: `mc-agent/skills/loiter.js`
- Test: `mc-agent/test/loiter.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { nextLoiterAction, loiter } = require('../skills/loiter');

test('nextLoiterAction: mappe la valeur rng vers une catégorie', () => {
  assert.strictEqual(nextLoiterAction(() => 0.0).kind, 'look');
  assert.strictEqual(nextLoiterAction(() => 0.5).kind, 'step');
  assert.strictEqual(nextLoiterAction(() => 0.8).kind, 'sneak');
  assert.strictEqual(nextLoiterAction(() => 0.99).kind, 'idle');
});

test('loiter: retourne stop() qui réinitialise les contrôles', () => {
  const cleared = [];
  const bot = {
    entity: { position: { clone: () => ({ distanceTo: () => 0 }) } },
    look: () => {}, setControlState: (c, v) => { if (v === false) cleared.push(c); },
    pathfinder: { setGoal: () => {} },
  };
  const stop = loiter(bot, null, { rng: () => 0.99 }); // 'idle' → pas de timer cascade immédiate
  assert.strictEqual(typeof stop, 'function');
  stop();
  assert.ok(cleared.includes('sneak'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mc-agent && node --test test/loiter.test.js`
Expected: FAIL — `Cannot find module '../skills/loiter'`.

- [ ] **Step 3: Write minimal implementation**

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mc-agent && node --test test/loiter.test.js`
Expected: PASS. (Note : `stop()` est appelé immédiatement donc le `setTimeout` de cascade est annulé — pas de boucle pendante.)

- [ ] **Step 5: Commit**

```bash
git add mc-agent/skills/loiter.js mc-agent/test/loiter.test.js
git commit -m "feat(mc-agent): skill loiter (stop vivant, loiter.js)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 14: `index.js` — câblage (pré-filtre whisper, dispatcher, ack, afk, mémoire, lang)

**Files:**
- Modify: `mc-agent/index.js`

> Pas de test unitaire (index.js crée un vrai bot au require). Validation : `node --check`, suite Node complète verte, smoke en §Smoke.

- [ ] **Step 1: Ajouter les imports + état runtime**

Après la ligne `const { loadPolicy, ... } = require('./trust');` ajouter :

```js
const { parseOrder } = require('./orders');
const { createTaskController } = require('./tasks');
const { createMemory } = require('./memory');
const { bestWeapon } = require('./tools');
const { gather } = require('./skills/gather');
const { mineDown } = require('./skills/mineDown');
const { guard } = require('./skills/guard');
const { giveItem, giveAll } = require('./skills/give');
const { craftItem } = require('./skills/craft');
const { deposit } = require('./skills/deposit');
const { equipItem, eat } = require('./skills/equip');
const { loiter } = require('./skills/loiter');
```

- [ ] **Step 2: Langue + instances**

Après la ligne `const trustDocs = buildTrustDocs(policy.trusted);` (pour que `whitelist`/`policy`/`profile` soient déjà déclarés) ajouter :

```js
// Langue parlée par le LLM (champ reply) : fr|en|it. Défaut fr.
const lang = String(args.lang || 'fr').toLowerCase();
const taskCtl = createTaskController();
const memory = createMemory();

const DONE = { fr: 'fait', en: 'done', it: 'fatto' };
const FAILS = {
  not_found: { fr: 'introuvable', en: 'not found', it: 'non trovato' },
  no_block: { fr: 'quel bloc ?', en: 'which block?', it: 'quale blocco?' },
  no_item: { fr: 'rien à donner', en: 'nothing to give', it: 'niente da dare' },
  empty: { fr: 'inventaire vide', en: 'inventory empty', it: 'inventario vuoto' },
  no_food: { fr: 'pas de nourriture', en: 'no food', it: 'niente cibo' },
  full: { fr: 'pas faim', en: 'not hungry', it: 'non ho fame' },
  no_recipe: { fr: 'pas de recette', en: 'no recipe', it: 'nessuna ricetta' },
  unknown_item: { fr: 'objet inconnu', en: 'unknown item', it: 'oggetto sconosciuto' },
  no_chest: { fr: 'pas de coffre', en: 'no chest', it: 'nessuna cassa' },
  not_visible: { fr: 'je ne te vois pas', en: "can't see you", it: 'non ti vedo' },
  void_below: { fr: 'le vide en dessous', en: 'void below', it: 'vuoto sotto' },
  danger_below: { fr: 'danger en dessous', en: 'danger below', it: 'pericolo sotto' },
};
function doneWord() { return DONE[lang] || DONE.en; }
function failMsg(reason) { const m = FAILS[reason]; return m ? (m[lang] || m.en) : (reason || 'erreur'); }
function ackPrivate(sender, text) { if (sender && text) { try { bot.whisper(sender, text); } catch (e) {} } }

function stopMotion() {
  try { bot.pathfinder && bot.pathfinder.setGoal(null); } catch (e) {}
  try { bot.pvp && bot.pvp.stop(); } catch (e) {}
  ['forward', 'back', 'left', 'right', 'sneak', 'jump'].forEach((c) => { try { bot.setControlState(c, false); } catch (e) {} });
}
```

- [ ] **Step 3: Le dispatcher `executeOrder`**

Ajouter cette fonction (après `runCommand`) :

```js
// Exécute une commande directe (déterministe, ZÉRO LLM). Retours en /msg privé à l'émetteur.
async function executeOrder(order, sender) {
  const a = order.args || {};
  emit({ type: 'order', verb: order.verb, by: sender });
  switch (order.verb) {
    case 'take': {
      const token = taskCtl.begin('take', stopMotion);
      const r = await gather(bot, a, token);
      if (token.cancelled) break;
      ackPrivate(sender, r.ok ? doneWord() : failMsg(r.reason));
      break;
    }
    case 'mineDown': {
      const token = taskCtl.begin('mineDown', stopMotion);
      const r = await mineDown(bot, a, token);
      if (token.cancelled) break;
      ackPrivate(sender, r.ok ? doneWord() : failMsg(r.reason));
      break;
    }
    case 'follow': {
      taskCtl.begin('follow', stopMotion);
      if (!follow(bot, { player: sender })) ackPrivate(sender, failMsg('not_visible'));
      break;
    }
    case 'come': {
      taskCtl.begin('come', stopMotion);
      const ent = bot.players[sender] && bot.players[sender].entity;
      if (!ent || !ent.position) { ackPrivate(sender, failMsg('not_visible')); break; }
      await goto(bot, { x: ent.position.x, y: ent.position.y, z: ent.position.z });
      ackPrivate(sender, doneWord());
      break;
    }
    case 'goto': {
      taskCtl.begin('goto', stopMotion);
      await goto(bot, a);
      ackPrivate(sender, doneWord());
      break;
    }
    case 'guard': {
      const token = taskCtl.begin('guard', () => {});
      taskCtl.setCleanup(guard(bot, token));
      break;
    }
    case 'stop': {
      taskCtl.begin('loiter', () => {});
      taskCtl.setCleanup(loiter(bot, profile));
      break;
    }
    case 'afk': {
      taskCtl.cancel();
      stopMotion();
      if (isAllowed('/afk', whitelist)) { bot.chat('/afk'); emit({ type: 'command', command: '/afk' }); }
      break;
    }
    case 'pvp': {
      taskCtl.begin('pvp', () => { try { bot.pvp.stop(); } catch (e) {} });
      const ent = bot.players[a.player] && bot.players[a.player].entity;
      if (!ent) { ackPrivate(sender, failMsg('not_visible')); break; }
      const w = bestWeapon(bot);
      if (w) { try { await bot.equip(w, 'hand'); } catch (e) {} }
      try { bot.pvp.attack(ent); } catch (e) {}
      break;
    }
    case 'tpa': {
      const target = a.target === 'me' ? sender : a.target;
      const cmd = '/tpa ' + target;
      if (isAllowed(cmd, whitelist)) { bot.chat(cmd); emit({ type: 'command', command: cmd }); }
      else { emit({ type: 'blocked_command', command: cmd }); }
      break;
    }
    case 'give': { const r = await giveItem(bot, a, sender); if (!r.ok) ackPrivate(sender, failMsg(r.reason)); break; }
    case 'giveAll': { const r = await giveAll(bot, a, sender); ackPrivate(sender, r.ok ? doneWord() : failMsg(r.reason)); break; }
    case 'craft': { const r = await craftItem(bot, a); if (!r.ok) ackPrivate(sender, failMsg(r.reason)); break; }
    case 'deposit': { const r = await deposit(bot); ackPrivate(sender, r.ok ? doneWord() : failMsg(r.reason)); break; }
    case 'equip': { const r = await equipItem(bot, a); if (!r.ok) ackPrivate(sender, failMsg(r.reason)); break; }
    case 'eat': { const r = await eat(bot); if (!r.ok) ackPrivate(sender, failMsg(r.reason)); break; }
    default: break;
  }
  emit({ type: 'order_done', verb: order.verb });
}
```

- [ ] **Step 4: Pré-filtre whisper + mémoire/lang dans `handleIncoming`**

Remplacer le corps de `handleIncoming` par :

```js
async function handleIncoming(username, message, isWhisper) {
  if (username === bot.username) return;

  // Pré-filtre commandes directes : UNIQUEMENT en /msg privé, ZÉRO appel LLM.
  if (isWhisper) {
    const order = parseOrder(message);
    if (order) {
      const allowed = isTrusted(username, policy.trusted) || (policy.trusted || []).length === 0;
      emit({ type: 'chat', from: username, message, private: true, handled: allowed });
      if (allowed) {
        try { await executeOrder(order, username); }
        catch (e) { emit({ type: 'error', message: String((e && e.message) || e) }); }
      } else {
        emit({ type: 'order_ignored', by: username });
      }
      return; // ne descend jamais vers le LLM
    }
  }

  const reaction = decideReaction({ username, message, isWhisper, botUsername: bot.username, publicMode: PUBLIC_MODE });
  emit({ type: 'chat', from: username, message, private: !!isWhisper, handled: !!reaction });
  if (!reaction) return;
  try {
    const history = memory.history(username);
    const decision0 = await think(client, { state: snapshot(bot), message, model, limiter, profile, commandDocs, trustDocs, sender: username, history, lang });
    if (!decision0) { emit({ type: 'info', message: 'rate-limited' }); return; }
    const decision = gateDecision(decision0, username, policy.trusted);
    if (decision !== decision0) { emit({ type: 'order_refused', from: username }); }
    if (decision.reply) {
      const { text, delayMs } = humanizeReply(profile, decision.reply);
      await sleep(delayMs);
      if (text) { replyTo(reaction, text); emit({ type: 'say', message: text, private: reaction.private, to: reaction.to }); }
    }
    memory.append(username, 'user', message);
    if (decision.reply) memory.append(username, 'assistant', decision.reply);
    await runAction(decision);
    runCommand(decision);
  } catch (e) {
    emit({ type: 'error', message: String((e && e.message) || e) });
  }
}
```

- [ ] **Step 5: Vérifier le parse + la suite complète**

Run: `cd mc-agent && node --check index.js && node --test`
Expected: `node --check` silencieux (0 erreur de parse) ; suite Node **toujours verte** (89 d'origine + nouveaux tests des tâches 1-13).

- [ ] **Step 6: Commit**

```bash
git add mc-agent/index.js
git commit -m "feat(mc-agent): câblage commandes directes + mémoire + langue (index.js)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 15: `mc_agent_servers.py` — champ `language`

**Files:**
- Modify: `backend/bots/mc_agent_servers.py`
- Test: `backend/bots/tests/test_mc_agent_servers.py`

- [ ] **Step 1: Write the failing test** (ajouter au fichier de test existant)

```python
def test_clean_server_language_default_and_valid(tmp_path, monkeypatch):
    import backend.bots.mc_agent_servers as s
    monkeypatch.setattr(s, "SERVERS_PATH", tmp_path / "srv.json")
    srv = s.create_server({"name": "X", "host": "h"})
    assert srv["language"] == "fr"  # défaut
    srv2 = s.create_server({"name": "Y", "host": "h", "language": "it"})
    assert srv2["language"] == "it"
    srv3 = s.create_server({"name": "Z", "host": "h", "language": "xx"})
    assert srv3["language"] == "fr"  # invalide → défaut
```

- [ ] **Step 2: Run test to verify it fails**

Run: `"/Users/massimiliano/omenserver Project/Projet serveur/venv/bin/python" -m pytest backend/bots/tests/test_mc_agent_servers.py::test_clean_server_language_default_and_valid -q`
Expected: FAIL — `KeyError: 'language'`.

- [ ] **Step 3: Write minimal implementation**

In `backend/bots/mc_agent_servers.py`, after `VALID_AUTH = (...)` add:

```python
VALID_LANGUAGE = ("fr", "en", "it")
```

In `_clean_server`, before the `return {`, add:

```python
    language = payload.get("language")
    if language not in VALID_LANGUAGE:
        language = "fr"
```

And add `"language": language,` to the returned dict (e.g. after `"intelligence": intelligence,`).

- [ ] **Step 4: Run test to verify it passes**

Run: `"/Users/massimiliano/omenserver Project/Projet serveur/venv/bin/python" -m pytest backend/bots/tests/test_mc_agent_servers.py -q`
Expected: PASS (nouveau test + existants).

- [ ] **Step 5: Commit**

```bash
git add backend/bots/mc_agent_servers.py backend/bots/tests/test_mc_agent_servers.py
git commit -m "feat(mc-agent): champ language au profil serveur (mc_agent_servers.py)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 16: `mc_agent_router.py` — `language` dans les payloads + `/run`

**Files:**
- Modify: `backend/bots/mc_agent_router.py`
- Test: `backend/bots/tests/test_mc_agent_router.py`

- [ ] **Step 1: Write the failing test** (ajouter à la fin de `test_mc_agent_router.py` ; le module a déjà `make_client()`, `mgr`, `r` importés en tête)

```python
def test_run_passes_language_from_server_profile(monkeypatch):
    monkeypatch.setattr(mgr, "has_api_key", lambda: True)
    captured = {}

    def fake_start(host, port, user, model=None, auth="offline", profile=None,
                   commands=None, policy=None, server_id=None, language="fr"):
        captured["language"] = language
        return 7

    monkeypatch.setattr(mgr, "start_session", fake_start)
    monkeypatch.setattr(r.servers_store, "get_server", lambda sid: {
        "id": sid, "host": "h", "port": 25565, "user": "Bot", "auth": "offline",
        "intelligence": "intermediaire", "language": "it", "commands": [], "custom": [],
        "trusted": [], "trade": None})
    monkeypatch.setattr(r.servers_store, "resolve_commands", lambda srv: [])
    monkeypatch.setattr(r.servers_store, "resolve_policy", lambda srv: {"trusted": [], "trade": None})
    c = make_client()
    resp = c.post("/api/mc-agent/run", json={"server_id": "abc"})
    assert resp.status_code == 200
    assert captured["language"] == "it"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `"/Users/massimiliano/omenserver Project/Projet serveur/venv/bin/python" -m pytest backend/bots/tests/test_mc_agent_router.py::test_run_passes_language_from_server_profile -q`
Expected: FAIL — `assert captured["language"] == "it"` (KeyError : `language` jamais passé).

- [ ] **Step 3a: ⚠️ Mettre à jour les 5 mocks `fake_start` existants**

Le router va passer `language=` à `start_session` → les `fake_start` existants (qui n'acceptent
pas ce kwarg) lèveraient `TypeError`. Dans `test_mc_agent_router.py`, ajouter `, language="fr"`
juste avant la parenthèse fermante de **chacune** des 5 signatures `def fake_start(...)` :
`test_run_demarre_une_session`, `test_run_transmet_le_profil`,
`test_run_with_server_id_resolves_commands`, `test_run_with_server_id_passes_policy`,
`test_run_with_server_id_passes_server_id`. Exemple :

```python
def fake_start(host, port, user, model=None, auth="offline", profile=None, commands=None, policy=None, server_id=None, language="fr"):
```

- [ ] **Step 3b: Write minimal implementation**

In `mc_agent_router.py`:

a) `ServerPayload` : add `language: str = "fr"`.
b) `StartReq` : add `language: str = "fr"`.
c) In `run()`, initialise then override from profile and pass through:

```python
    host, port, user = req.host, req.port, req.user
    auth, profile, commands, policy = req.auth, req.profile, None, None
    language = req.language
    if req.server_id:
        srv = servers_store.get_server(req.server_id)
        if not srv:
            raise HTTPException(status_code=404, detail="Profil serveur introuvable")
        host, port, user = srv["host"], srv["port"], srv["user"]
        auth, profile = srv["auth"], srv["intelligence"]
        language = srv.get("language", "fr")
        commands = servers_store.resolve_commands(srv)
        policy = servers_store.resolve_policy(srv)
```

and the start call:

```python
        sid = mgr.start_session(host, port, user, req.model, auth, profile, commands, policy, server_id=req.server_id, language=language)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `"/Users/massimiliano/omenserver Project/Projet serveur/venv/bin/python" -m pytest backend/bots/tests/test_mc_agent_router.py -q`
Expected: PASS (nouveau + existants).

- [ ] **Step 5: Commit**

```bash
git add backend/bots/mc_agent_router.py backend/bots/tests/test_mc_agent_router.py
git commit -m "feat(mc-agent): language dans payloads + /run (mc_agent_router.py)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 17: `mc_agent_manager.py` — `--lang` au subprocess

**Files:**
- Modify: `backend/bots/mc_agent_manager.py`
- Test: `backend/bots/tests/test_mc_agent_manager.py`

- [ ] **Step 1: Write the failing test** (ajouter à la fin de `test_mc_agent_manager.py` ; `mgr` est importé en tête, style `FakeProc` identique aux tests existants)

```python
def test_start_session_adds_lang_flag(monkeypatch):
    import io
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    captured = {}

    class FakeProc:
        def __init__(self):
            self.stdin = io.StringIO()
            self.stdout = iter(())
            self.pid = 4324
        def poll(self):
            return None

    def fake_popen(cmd, **kw):
        captured["cmd"] = cmd
        return FakeProc()

    monkeypatch.setattr(mgr.subprocess, "Popen", fake_popen)
    sid = mgr.start_session("h", 25565, "TrainBot", None, "offline", None, None, None, language="it")
    assert "--lang" in captured["cmd"]
    assert captured["cmd"][captured["cmd"].index("--lang") + 1] == "it"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `"/Users/massimiliano/omenserver Project/Projet serveur/venv/bin/python" -m pytest backend/bots/tests/test_mc_agent_manager.py::test_start_session_adds_lang_flag -q`
Expected: FAIL — `start_session() got an unexpected keyword argument 'language'`.

- [ ] **Step 3: Write minimal implementation**

In `mc_agent_manager.py`, change the signature:

```python
def start_session(host, port, user, model=None, auth="offline", profile=None, commands=None, policy=None, server_id=None, language="fr"):
```

After the `if profile:` block (which appends `--profile`), add:

```python
    if language:
        cmd += ["--lang", str(language)]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `"/Users/massimiliano/omenserver Project/Projet serveur/venv/bin/python" -m pytest backend/bots/tests/test_mc_agent_manager.py -q`
Expected: PASS (nouveau + existants).

- [ ] **Step 5: Commit**

```bash
git add backend/bots/mc_agent_manager.py backend/bots/tests/test_mc_agent_manager.py
git commit -m "feat(mc-agent): passe --lang au subprocess Node (mc_agent_manager.py)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 18: Frontend — port optionnel, select langue, aide commandes, i18n, cache-bust

**Files:**
- Modify: `frontend/js/bots_module.js`
- Modify: `frontend/js/lang.js`
- Modify: `frontend/index.html` (cache-bust `?v=`)
- Modify: `frontend/sw.js` (`CACHE_NAME`)

> Validation : pas de test unitaire JS → **verify-ui (Chrome MCP)** après coup (cf. §Verify-UI).

- [ ] **Step 1: Port optionnel (placeholder au lieu de value)**

Dans `frontend/js/bots_module.js` :
- Ligne du champ lancement rapide : remplacer `<input id="mca-port" class="form-input" value="25565" />`
  par `<input id="mca-port" class="form-input" placeholder="25565" />`.
- Dans le formulaire profil (`renderServerForm`/équivalent), remplacer
  `<input id="mca-e-port" class="form-input" value="${e.port}" />`
  par `<input id="mca-e-port" class="form-input" placeholder="25565" value="${e.port || ''}" />`.
- La lecture `parseInt(... ) || 25565` est déjà en place (laisser tel quel) → vide = 25565.

- [ ] **Step 2: Select Langue dans le formulaire profil**

Dans le bloc qui rend `mca-e-intel` (`<select>` intelligence), ajouter juste après un nouveau champ :

```js
<div><label class="form-label">${Lang.t('mcagent.cfg.srv_language')}</label>
  <select id="mca-e-lang" class="form-input">
    <option value="fr" ${(e.language||'fr') === 'fr' ? 'selected' : ''}>Français</option>
    <option value="en" ${e.language === 'en' ? 'selected' : ''}>English</option>
    <option value="it" ${e.language === 'it' ? 'selected' : ''}>Italiano</option>
  </select>
</div>
```

Dans la fonction qui collecte le formulaire (là où `e.intelligence = g('mca-e-intel')`), ajouter :

```js
if (g('mca-e-lang') !== undefined) e.language = g('mca-e-lang');
```

Dans le payload `saveServer` (l'objet `payload = { ... }`), ajouter `language: e.language || 'fr',`.

Initialiser le défaut dans `_mcaEditing` (l'objet par défaut) : ajouter `language: 'fr',`.

- [ ] **Step 3: Panneau d'aide « Commandes »**

Ajouter une carte d'aide dépliable dans la vue MC Agent (près du formulaire Lancer). Le contenu
liste les 16 commandes via une clé i18n `mcagent.commands_help` (texte multi-lignes), p.ex. :

```js
<details class="card" style="margin-top:12px;">
  <summary style="cursor:pointer;font-weight:600;">${Lang.t('mcagent.commands_title')}</summary>
  <div style="font-family:var(--font-mono);font-size:12px;line-height:1.7;margin-top:8px;white-space:pre-wrap;">${Lang.t('mcagent.commands_help')}</div>
</details>
```

- [ ] **Step 4: Clés i18n FR/EN/IT**

Dans `frontend/js/lang.js`, ajouter sous la section `mcagent.*` (les 3 langues) :

```js
// FR
'mcagent.cfg.srv_language': 'Langue parlée',
'mcagent.commands_title': 'Commandes (en /msg privé, en anglais)',
'mcagent.commands_help': 'take <bloc> [n] — récolte (meilleur outil auto, se défend) → "fait"\nfollow me — te suit\nstop — s’arrête mais reste vivant (regarde, bouge un peu)\nafk — se fige (réflexes survie gardés)\ncraft <objet> [n] — fabrique\ngive <objet> — te donne tout de cet objet\ngive all — te donne tout l’inventaire\npvp <joueur> — attaque avec la meilleure arme\ntpa <joueur|me> — demande de TP\nmine down <n> — creuse vers le bas\ncome — vient à toi\ndeposit — dépose dans le coffre le plus proche\nguard — tue les mobs autour\nequip <objet> — équipe un objet\neat — mange\ngoto <x> <y> <z> — va aux coordonnées',
```

```js
// EN
'mcagent.cfg.srv_language': 'Spoken language',
'mcagent.commands_title': 'Commands (private /msg, in English)',
'mcagent.commands_help': 'take <block> [n] — gather (auto best tool, defends) → "done"\nfollow me\nstop — stops but stays alive (looks, shuffles)\nafk — freezes (survival reflexes kept)\ncraft <item> [n]\ngive <item> — drops all of that item to you\ngive all — drops the whole inventory to you\npvp <player> — attacks with best weapon\ntpa <player|me>\nmine down <n>\ncome\ndeposit — into nearest chest\nguard — kills nearby mobs\nequip <item>\neat\ngoto <x> <y> <z>',
```

```js
// IT
'mcagent.cfg.srv_language': 'Lingua parlata',
'mcagent.commands_title': 'Comandi (in /msg privato, in inglese)',
'mcagent.commands_help': 'take <blocco> [n] — raccoglie (miglior attrezzo auto, si difende) → "fatto"\nfollow me — ti segue\nstop — si ferma ma resta vivo (guarda, si muove)\nafk — si blocca (riflessi di sopravvivenza attivi)\ncraft <oggetto> [n]\ngive <oggetto> — ti dà tutto di quell’oggetto\ngive all — ti dà tutto l’inventario\npvp <giocatore> — attacca con l’arma migliore\ntpa <giocatore|me>\nmine down <n>\ncome — viene da te\ndeposit — nella cassa più vicina\nguard — uccide i mob vicini\nequip <oggetto>\neat\ngoto <x> <y> <z>',
```

- [ ] **Step 5: Cache-bust**

- `frontend/index.html` : bumper `?v=` sur `js/bots_module.js` et `js/lang.js` (vers un N franc jamais utilisé, cf. piège #11).
- `frontend/sw.js` : bumper `CACHE_NAME`.

- [ ] **Step 6: Commit**

```bash
git add frontend/js/bots_module.js frontend/js/lang.js frontend/index.html frontend/sw.js
git commit -m "feat(mc-agent): UI port optionnel + select langue + aide commandes + i18n + cache-bust

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Vérification finale

- [ ] **Suite Node complète** : `cd mc-agent && node --test` → tout vert (89 + nouveaux).
- [ ] **Suite Python mc_agent** : `"…/venv/bin/python" -m pytest backend/bots/tests/test_mc_agent_servers.py backend/bots/tests/test_mc_agent_router.py backend/bots/tests/test_mc_agent_manager.py -q` → tout vert.
- [ ] **Parse index.js** : `cd mc-agent && node --check index.js` → 0 erreur.
- [ ] **Verify-UI** (skill `verify-ui` / Chrome MCP) : ouvrir le dashboard, onglet Bots → MC Agent, vérifier : port vide accepté, select Langue présent (FR/EN/IT), panneau d'aide Commandes lisible dans les 3 langues.

## Smoke (manuel, serveur de test — hors CI)

Sur un serveur Minecraft de test (offline), lancer un bot via un profil avec `/afk`,`/tpa` cochés,
soi-même dans `trusted`, langue FR. En `/msg` au bot :
- `take dirt 5` → récolte 5 dirt (pelle), reçoit `fait` en privé.
- `follow me`, puis `stop` (le bot loiter : regarde/bouge un peu), puis `afk` (figé).
- `give all` → jette l'inventaire ; `guard` près d'un mob → l'attaque ; `tpa me` → /tpa.
- Parler en public en nommant le bot → réponse LLM en français ; continuer la discussion → il se souvient.
- Un non-trusted qui `/msg take dirt` → ignoré ; qui parle en public en le nommant → réponse LLM.
