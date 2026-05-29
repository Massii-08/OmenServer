# MC Agent — Phase 0 (socle) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un bot Minecraft qui se connecte à un serveur offline-mode, reste en vie, parle naturellement via Claude et suit un joueur — piloté depuis le module Bot d'OmenServer (carte dédiée, admin-only).

**Architecture:** Corps déterministe en **Node.js + Mineflayer** (process séparé, 1 par session), cerveau **événementiel** en **Claude** (appelé uniquement sur message reçu, jamais à chaque tick). Le backend Python spawn le process Node en subprocess détaché (pattern Yield/Scanner), capture son stdout JSON ligne-par-ligne pour le statut/transcript, et lui envoie des commandes via stdin.

**Tech Stack:** Node 22 (`mineflayer`, `mineflayer-pathfinder`, `@anthropic-ai/sdk`, test runner natif `node:test`), Python 3.9 (FastAPI, pytest, httpx pour TestClient), Vanilla JS frontend.

**Référence spec :** `docs/superpowers/specs/2026-05-29-mc-agent-training-design.md`

**⚠️ Garde-fous projet (de la spec, à respecter) :**
- Phase 0 ne contient AUCUNE brique de furtivité/évasion. Le bot est honnête sur sa nature (system prompt).
- Auth Minecraft : **offline-mode uniquement** en Phase 0.
- Le repo **auto-deploy sur `main`** (cron git pull + restart). On travaille sur une **branche** `feat/mc-agent-training`. Ne JAMAIS pusher sur `main` pendant le dev.

---

## File Structure

**Node — nouveau projet `mc-agent/` (dans le repo OmenServer) :**

| Fichier | Responsabilité |
|---|---|
| `mc-agent/package.json` | deps + script `test` (`node --test`) |
| `mc-agent/io.js` | `emit(event)` (JSON→stdout) ; `onCommand(cb, stream)` (stdin→cb) |
| `mc-agent/state.js` | `snapshot(bot)` → objet sérialisable de l'état de jeu |
| `mc-agent/brain.js` | `parseDecision(text)`, `RateLimiter`, `think(client, opts)`, `SYSTEM_PROMPT` |
| `mc-agent/skills/say.js` | `say(bot, message)` |
| `mc-agent/skills/follow.js` | `follow(bot, {player})` |
| `mc-agent/skills/goto.js` | `goto(bot, {x,y,z})` |
| `mc-agent/index.js` | wiring : connexion mineflayer + plugins + handler chat→brain→skill |
| `mc-agent/test/*.test.js` | tests unitaires (node:test) |

**Python — `backend/bots/` :**

| Fichier | Responsabilité |
|---|---|
| `backend/bots/mc_agent_manager.py` | registre sessions en mémoire, spawn subprocess Node, `_pump` stdout, start/stop/say/status/transcript/active |
| `backend/bots/mc_agent_router.py` | endpoints `/api/mc-agent/*` (admin-only) |
| `backend/bots/tests/test_mc_agent_manager.py` | tests manager |
| `backend/bots/tests/test_mc_agent_router.py` | tests router (TestClient) |
| `backend/main.py` | +2 lignes (import + include_router) |

**Frontend :**

| Fichier | Responsabilité |
|---|---|
| `frontend/js/bots_module.js` | carte "MC Agent" + vue `openMCAgent()` (form start + panneau live) |
| `frontend/js/lang.js` | clés `mcagent.*` (FR/EN/IT) |
| `frontend/index.html` | bump `?v=` de bots_module.js + lang.js |
| `frontend/sw.js` | bump `CACHE_NAME` |

---

## Task 0: Branche de travail & prérequis

**Files:** aucun (setup)

- [ ] **Step 1: Créer la branche de travail**

Run:
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur"
git checkout -b feat/mc-agent-training
```
Expected: `Switched to a new branch 'feat/mc-agent-training'`

- [ ] **Step 2: Vérifier Node 22 et venv Python**

Run:
```bash
node --version && source venv/bin/activate && python --version
```
Expected: `v22.x` puis `Python 3.9.x`

- [ ] **Step 3: Installer pytest + httpx dans le venv (si absents)**

Run:
```bash
source venv/bin/activate && pip install pytest httpx
```
Expected: `Successfully installed` (ou `Requirement already satisfied`)

- [ ] **Step 4: Commit du point de départ (spec + plan)**

```bash
git add docs/superpowers/specs/2026-05-29-mc-agent-training-design.md docs/superpowers/plans/2026-05-29-mc-agent-phase0.md
git commit -m "docs(mc-agent): spec + plan Phase 0"
```

---

## Task 1: Scaffold du projet Node `mc-agent/`

**Files:**
- Create: `mc-agent/package.json`
- Create: `mc-agent/test/smoke.test.js`

- [ ] **Step 1: Créer `mc-agent/package.json`**

```json
{
  "name": "omen-mc-agent",
  "version": "0.1.0",
  "private": true,
  "description": "Bot Minecraft d'entrainement staff (OmenServer module Bot)",
  "main": "index.js",
  "scripts": {
    "test": "node --test"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.40.0",
    "mineflayer": "^4.20.0",
    "mineflayer-pathfinder": "^2.4.5"
  }
}
```

- [ ] **Step 2: Créer un test smoke `mc-agent/test/smoke.test.js`**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

test('le test runner fonctionne', () => {
  assert.strictEqual(1 + 1, 2);
});
```

- [ ] **Step 3: Installer les deps**

Run:
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/mc-agent" && npm install
```
Expected: `added N packages` ; un dossier `node_modules/` apparaît.

- [ ] **Step 4: Lancer les tests**

Run:
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/mc-agent" && npm test
```
Expected: `# pass 1`

- [ ] **Step 5: Ignorer node_modules + commit**

Ajouter à `mc-agent/.gitignore` :
```
node_modules/
```
Puis :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur"
git add mc-agent/package.json mc-agent/package-lock.json mc-agent/.gitignore mc-agent/test/smoke.test.js
git commit -m "feat(mc-agent): scaffold projet Node + test runner"
```

---

## Task 2: `io.js` — communication stdout/stdin

**Files:**
- Create: `mc-agent/io.js`
- Test: `mc-agent/test/io.test.js`

- [ ] **Step 1: Écrire le test qui échoue**

`mc-agent/test/io.test.js` :
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('node:stream');
const { emit, onCommand } = require('../io');

test('emit écrit une ligne JSON sur stdout', () => {
  const lines = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { lines.push(s); return true; };
  try { emit({ type: 'status', state: 'ok' }); }
  finally { process.stdout.write = orig; }
  assert.strictEqual(lines.length, 1);
  assert.deepStrictEqual(JSON.parse(lines[0]), { type: 'status', state: 'ok' });
  assert.ok(lines[0].endsWith('\n'));
});

test('onCommand parse les lignes JSON et ignore le bruit', () => {
  const stream = new PassThrough();
  const got = [];
  onCommand((cmd) => got.push(cmd), stream);
  stream.write('{"type":"say","message":"hi"}\n');
  stream.write('pas du json\n');
  stream.write('{"type":"quit"}\n');
  return new Promise((resolve) => setImmediate(() => {
    assert.deepStrictEqual(got, [{ type: 'say', message: 'hi' }, { type: 'quit' }]);
    resolve();
  }));
});
```

- [ ] **Step 2: Lancer → échec attendu**

Run: `cd mc-agent && node --test test/io.test.js`
Expected: FAIL (`Cannot find module '../io'`)

- [ ] **Step 3: Implémenter `mc-agent/io.js`**

```js
'use strict';
// Communication structurée avec le backend Python : events JSON sur stdout, commandes sur stdin.

/** Émet un événement structuré (1 ligne JSON) sur stdout. */
function emit(event) {
  process.stdout.write(JSON.stringify(event) + '\n');
}

/**
 * Écoute les commandes du backend (1 ligne JSON par commande) sur `input` (stdin par défaut).
 * Appelle cb(commande) pour chaque ligne JSON valide ; ignore les lignes vides ou non-JSON.
 */
function onCommand(cb, input = process.stdin) {
  let buffer = '';
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try { cb(JSON.parse(line)); } catch { /* ligne non-JSON ignorée */ }
    }
  });
}

module.exports = { emit, onCommand };
```

- [ ] **Step 4: Lancer → succès attendu**

Run: `cd mc-agent && node --test test/io.test.js`
Expected: `# pass 2`

- [ ] **Step 5: Commit**

```bash
git add mc-agent/io.js mc-agent/test/io.test.js
git commit -m "feat(mc-agent): io.js (events stdout / commandes stdin)"
```

---

## Task 3: `state.js` — snapshot d'état pour le LLM

**Files:**
- Create: `mc-agent/state.js`
- Test: `mc-agent/test/state.test.js`

- [ ] **Step 1: Écrire le test qui échoue**

`mc-agent/test/state.test.js` :
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { snapshot } = require('../state');

function fakePos(x, y, z) {
  return { x, y, z, distanceTo(o) { return Math.hypot(x - o.x, y - o.y, z - o.z); } };
}

test('snapshot retourne vie, faim, position, joueurs et mobs proches triés', () => {
  const selfPos = fakePos(0, 64, 0);
  const bot = {
    username: 'Bot',
    health: 18,
    food: 15,
    entity: { position: selfPos },
    players: { Bot: {}, Massii: {}, Alice: {} },
    entities: {
      1: { type: 'mob', name: 'zombie', position: fakePos(10, 64, 0) },
      2: { type: 'mob', name: 'creeper', position: fakePos(3, 64, 0) },
      3: { type: 'player', name: 'Massii', position: fakePos(1, 64, 0) },
    },
  };
  const s = snapshot(bot);
  assert.strictEqual(s.username, 'Bot');
  assert.strictEqual(s.health, 18);
  assert.strictEqual(s.food, 15);
  assert.deepStrictEqual(s.position, { x: 0, y: 64, z: 0 });
  assert.deepStrictEqual(s.players.sort(), ['Alice', 'Massii']); // pas le bot lui-même
  assert.strictEqual(s.nearbyMobs[0].name, 'creeper'); // le plus proche d'abord
  assert.strictEqual(s.nearbyMobs.length, 2); // les players exclus des mobs
});
```

- [ ] **Step 2: Lancer → échec attendu**

Run: `cd mc-agent && node --test test/state.test.js`
Expected: FAIL (`Cannot find module '../state'`)

- [ ] **Step 3: Implémenter `mc-agent/state.js`**

```js
'use strict';
// Construit un snapshot sérialisable de l'état de jeu, donné au cerveau LLM.

function round(n) { return Math.round(n * 10) / 10; }

/** Snapshot sérialisable de l'état courant à partir de l'objet bot Mineflayer. */
function snapshot(bot) {
  const pos = (bot.entity && bot.entity.position) || { x: 0, y: 0, z: 0 };
  const players = Object.keys(bot.players || {}).filter((n) => n !== bot.username);
  const nearbyMobs = Object.values(bot.entities || {})
    .filter((e) => e && e.type === 'mob' && e.position)
    .map((e) => ({ name: e.name, distance: round(e.position.distanceTo(pos)) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 5);
  return {
    username: bot.username,
    health: bot.health == null ? null : bot.health,
    food: bot.food == null ? null : bot.food,
    position: { x: round(pos.x), y: round(pos.y), z: round(pos.z) },
    players,
    nearbyMobs,
  };
}

module.exports = { snapshot };
```

- [ ] **Step 4: Lancer → succès attendu**

Run: `cd mc-agent && node --test test/state.test.js`
Expected: `# pass 1`

- [ ] **Step 5: Commit**

```bash
git add mc-agent/state.js mc-agent/test/state.test.js
git commit -m "feat(mc-agent): state.js (snapshot d'etat)"
```

---

## Task 4: `brain.js` — parseDecision + RateLimiter

**Files:**
- Create: `mc-agent/brain.js`
- Test: `mc-agent/test/brain_parse.test.js`

- [ ] **Step 1: Écrire le test qui échoue**

`mc-agent/test/brain_parse.test.js` :
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseDecision, RateLimiter } = require('../brain');

test('parseDecision lit du JSON simple', () => {
  const d = parseDecision('{"reply":"salut","action":"follow","args":{"player":"Massii"}}');
  assert.deepStrictEqual(d, { reply: 'salut', action: 'follow', args: { player: 'Massii' } });
});

test('parseDecision tolère les fences ```json', () => {
  const d = parseDecision('```json\n{"reply":"ok","action":null,"args":{}}\n```');
  assert.strictEqual(d.reply, 'ok');
  assert.strictEqual(d.action, null);
});

test('parseDecision applique des défauts pour les champs manquants', () => {
  const d = parseDecision('{"reply":"hello"}');
  assert.strictEqual(d.action, null);
  assert.deepStrictEqual(d.args, {});
});

test('RateLimiter autorise jusqu’à maxCalls puis bloque, et libère après la fenêtre', () => {
  let now = 1000;
  const rl = new RateLimiter(2, 1000, () => now);
  assert.strictEqual(rl.tryAcquire(), true);
  assert.strictEqual(rl.tryAcquire(), true);
  assert.strictEqual(rl.tryAcquire(), false); // 3e dans la fenêtre → bloqué
  now += 1001;
  assert.strictEqual(rl.tryAcquire(), true);  // fenêtre écoulée → ok
});
```

- [ ] **Step 2: Lancer → échec attendu**

Run: `cd mc-agent && node --test test/brain_parse.test.js`
Expected: FAIL (`Cannot find module '../brain'`)

- [ ] **Step 3: Implémenter `mc-agent/brain.js` (partie 1)**

```js
'use strict';
// Cerveau LLM événementiel (Claude) : dialogue + choix de skill.

/** Parse la réponse texte de Claude en décision structurée. Tolère les fences ```json. */
function parseDecision(text) {
  if (typeof text !== 'string') throw new Error('decision text must be a string');
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const obj = JSON.parse(t);
  return {
    reply: typeof obj.reply === 'string' ? obj.reply : '',
    action: typeof obj.action === 'string' ? obj.action : null,
    args: (obj.args && typeof obj.args === 'object') ? obj.args : {},
  };
}

/** Limiteur d'appels : au plus maxCalls dans une fenêtre glissante de windowMs (garde-fou coût). */
class RateLimiter {
  constructor(maxCalls, windowMs, now = () => Date.now()) {
    this.maxCalls = maxCalls;
    this.windowMs = windowMs;
    this._now = now;
    this._hits = [];
  }
  tryAcquire() {
    const t = this._now();
    this._hits = this._hits.filter((h) => t - h < this.windowMs);
    if (this._hits.length >= this.maxCalls) return false;
    this._hits.push(t);
    return true;
  }
}

module.exports = { parseDecision, RateLimiter };
```

- [ ] **Step 4: Lancer → succès attendu**

Run: `cd mc-agent && node --test test/brain_parse.test.js`
Expected: `# pass 4`

- [ ] **Step 5: Commit**

```bash
git add mc-agent/brain.js mc-agent/test/brain_parse.test.js
git commit -m "feat(mc-agent): brain parseDecision + RateLimiter"
```

---

## Task 5: `brain.js` — think() avec client Claude injecté

**Files:**
- Modify: `mc-agent/brain.js`
- Test: `mc-agent/test/brain_think.test.js`

- [ ] **Step 1: Écrire le test qui échoue**

`mc-agent/test/brain_think.test.js` :
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { think, RateLimiter, SYSTEM_PROMPT } = require('../brain');

function fakeClient(text) {
  return { messages: { create: async () => ({ content: [{ type: 'text', text }] }) } };
}

test('think appelle le client et retourne la décision parsée', async () => {
  const client = fakeClient('{"reply":"j arrive","action":"follow","args":{"player":"Massii"}}');
  const d = await think(client, { state: { username: 'Bot' }, message: 'suis moi', model: 'm', limiter: null });
  assert.strictEqual(d.reply, 'j arrive');
  assert.strictEqual(d.action, 'follow');
});

test('think retourne null si le rate-limiter bloque', async () => {
  let now = 0;
  const limiter = new RateLimiter(0, 1000, () => now); // 0 appel autorisé
  const client = fakeClient('{"reply":"x"}');
  const d = await think(client, { state: {}, message: 'hi', model: 'm', limiter });
  assert.strictEqual(d, null);
});

test('SYSTEM_PROMPT exige une réponse JSON et l’honnêteté', () => {
  assert.match(SYSTEM_PROMPT, /JSON/);
  assert.match(SYSTEM_PROMPT, /honn[êe]te|bot/i);
});
```

- [ ] **Step 2: Lancer → échec attendu**

Run: `cd mc-agent && node --test test/brain_think.test.js`
Expected: FAIL (`think is not a function` / `SYSTEM_PROMPT` undefined)

- [ ] **Step 3: Compléter `mc-agent/brain.js`**

Ajouter avant la ligne `module.exports` :
```js
const SYSTEM_PROMPT = [
  "Tu incarnes un joueur dans une partie Minecraft, dans un cadre d'entrainement de moderation.",
  "Tu es honnete : si on te demande si tu es un bot, tu peux le confirmer.",
  'Reponds UNIQUEMENT en JSON : {"reply": string, "action": string|null, "args": object}.',
  'Actions possibles : "follow" (args {player}), "goto" (args {x,y,z}), ou null (juste parler).',
].join(' ');

/**
 * Appelle Claude avec l'état + le message reçu. `client` = SDK Anthropic (injectable pour tests).
 * Retourne une décision parsée, ou null si le rate-limiter bloque l'appel.
 */
async function think(client, { state, message, model, limiter }) {
  if (limiter && !limiter.tryAcquire()) return null;
  const resp = await client.messages.create({
    model,
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Etat: ${JSON.stringify(state)}\nMessage recu: ${message}` }],
  });
  const text = (resp.content || []).map((b) => b.text || '').join('');
  return parseDecision(text);
}
```

Et remplacer la ligne d'export par :
```js
module.exports = { parseDecision, RateLimiter, think, SYSTEM_PROMPT };
```

- [ ] **Step 4: Lancer → succès attendu (tout brain)**

Run: `cd mc-agent && node --test test/brain_parse.test.js test/brain_think.test.js`
Expected: `# pass 7`

- [ ] **Step 5: Commit**

```bash
git add mc-agent/brain.js mc-agent/test/brain_think.test.js
git commit -m "feat(mc-agent): brain think() avec client Claude injectable"
```

---

## Task 6: Skills `say`, `follow`, `goto`

**Files:**
- Create: `mc-agent/skills/say.js`, `mc-agent/skills/follow.js`, `mc-agent/skills/goto.js`
- Test: `mc-agent/test/skills.test.js`

- [ ] **Step 1: Écrire le test qui échoue**

`mc-agent/test/skills.test.js` :
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { say } = require('../skills/say');
const { follow } = require('../skills/follow');
const { goto } = require('../skills/goto');

function fakeBot() {
  const calls = { chat: [], setGoal: [] };
  return {
    calls,
    chat(m) { calls.chat.push(m); },
    players: {},
    pathfinder: { setGoal(g, d) { calls.setGoal.push({ g, d }); }, async goto() { calls.gotoCalled = true; } },
  };
}

test('say envoie le message dans le chat', async () => {
  const bot = fakeBot();
  await say(bot, 'coucou');
  assert.deepStrictEqual(bot.calls.chat, ['coucou']);
});

test('say ignore un message vide', async () => {
  const bot = fakeBot();
  await say(bot, '');
  assert.strictEqual(bot.calls.chat.length, 0);
});

test('follow lève une erreur sans nom de joueur', () => {
  assert.throws(() => follow(fakeBot(), {}), /player/);
});

test('follow prévient et retourne false si le joueur n’est pas visible', () => {
  const bot = fakeBot();
  const ok = follow(bot, { player: 'Massii' });
  assert.strictEqual(ok, false);
  assert.strictEqual(bot.calls.chat.length, 1);
});

test('follow pose un goal et retourne true si le joueur est visible', () => {
  const bot = fakeBot();
  bot.players.Massii = { entity: { id: 42 } };
  const ok = follow(bot, { player: 'Massii' });
  assert.strictEqual(ok, true);
  assert.strictEqual(bot.calls.setGoal.length, 1);
});

test('goto lève une erreur si les coordonnées ne sont pas numériques', async () => {
  await assert.rejects(goto(fakeBot(), { x: 'a', y: 1, z: 2 }), /numeric/);
});
```

- [ ] **Step 2: Lancer → échec attendu**

Run: `cd mc-agent && node --test test/skills.test.js`
Expected: FAIL (`Cannot find module '../skills/say'`)

- [ ] **Step 3: Implémenter les 3 skills**

`mc-agent/skills/say.js` :
```js
'use strict';
/** Fait parler le bot dans le chat. No-op si message vide. */
async function say(bot, message) {
  if (!message) return;
  bot.chat(String(message));
}
module.exports = { say };
```

`mc-agent/skills/follow.js` :
```js
'use strict';
const { goals } = require('mineflayer-pathfinder');
/** Fait suivre un joueur (GoalFollow dynamique). Retourne false si le joueur n'est pas visible. */
function follow(bot, { player } = {}) {
  if (!player) throw new Error('follow requires a player name');
  const target = bot.players[player] && bot.players[player].entity;
  if (!target) { bot.chat(`je ne te vois pas, ${player}`); return false; }
  bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
  return true;
}
module.exports = { follow };
```

`mc-agent/skills/goto.js` :
```js
'use strict';
const { goals } = require('mineflayer-pathfinder');
/** Déplace le bot vers une coordonnée (GoalBlock) via pathfinder. */
async function goto(bot, { x, y, z } = {}) {
  if ([x, y, z].some((v) => typeof v !== 'number')) throw new Error('goto requires numeric x,y,z');
  await bot.pathfinder.goto(new goals.GoalBlock(x, y, z));
}
module.exports = { goto };
```

- [ ] **Step 4: Lancer → succès attendu**

Run: `cd mc-agent && node --test test/skills.test.js`
Expected: `# pass 6`

- [ ] **Step 5: Commit**

```bash
git add mc-agent/skills/ mc-agent/test/skills.test.js
git commit -m "feat(mc-agent): skills say/follow/goto"
```

---

## Task 7: `index.js` — wiring de l'agent (smoke, pas de test unitaire)

**Files:**
- Create: `mc-agent/index.js`

> Le wiring dépend d'une vraie connexion serveur ⇒ pas de test unitaire ; il est validé au smoke end-to-end (Task 13). On vérifie juste que le module parse sans erreur.

- [ ] **Step 1: Écrire `mc-agent/index.js`**

```js
'use strict';
// Point d'entrée de l'agent Minecraft. Lancé par le backend Python en subprocess.
const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const Anthropic = require('@anthropic-ai/sdk');
const { emit, onCommand } = require('./io');
const { snapshot } = require('./state');
const { think, RateLimiter } = require('./brain');
const { say } = require('./skills/say');
const { follow } = require('./skills/follow');
const { goto } = require('./skills/goto');

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { o[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
const model = args.model || 'claude-haiku-4-5-20251001';
const limiter = new RateLimiter(Number(args.maxCalls || 20), 60000);
const client = new Anthropic(); // lit ANTHROPIC_API_KEY depuis l'environnement

const bot = mineflayer.createBot({
  host: args.host,
  port: Number(args.port || 25565),
  username: args.user || 'TrainBot',
  auth: 'offline',
});
bot.loadPlugin(pathfinder);

bot.once('spawn', () => {
  bot.pathfinder.setMovements(new Movements(bot));
  emit({ type: 'status', state: 'spawned', username: bot.username });
});

async function runAction(decision) {
  if (decision.action === 'follow') {
    follow(bot, decision.args);
    emit({ type: 'action', skill: 'follow', args: decision.args });
  } else if (decision.action === 'goto') {
    await goto(bot, decision.args);
    emit({ type: 'action', skill: 'goto', args: decision.args });
  }
}

bot.on('chat', async (username, message) => {
  if (username === bot.username) return;
  emit({ type: 'chat', from: username, message });
  try {
    const decision = await think(client, { state: snapshot(bot), message, model, limiter });
    if (!decision) { emit({ type: 'info', message: 'rate-limited' }); return; }
    if (decision.reply) { await say(bot, decision.reply); emit({ type: 'say', message: decision.reply }); }
    await runAction(decision);
  } catch (e) {
    emit({ type: 'error', message: String((e && e.message) || e) });
  }
});

bot.on('death', () => emit({ type: 'status', state: 'dead' }));
bot.on('kicked', (reason) => emit({ type: 'error', message: 'kicked: ' + reason }));
bot.on('error', (e) => emit({ type: 'error', message: String((e && e.message) || e) }));
bot.on('end', () => { emit({ type: 'status', state: 'disconnected' }); process.exit(0); });

// Commandes envoyées par le backend (stdin)
onCommand((cmd) => {
  if (cmd.type === 'say') say(bot, cmd.message);
  else if (cmd.type === 'quit') bot.quit();
});
```

- [ ] **Step 2: Vérifier que le module parse (pas d'exécution réseau)**

Run:
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/mc-agent" && node --check index.js
```
Expected: aucune sortie (exit 0 = syntaxe OK)

- [ ] **Step 3: Commit**

```bash
git add mc-agent/index.js
git commit -m "feat(mc-agent): index.js wiring (connexion + handler chat)"
```

---

## Task 8: Manager Python — parsing d'events (`parse_event_line`, `_apply_event`, `_pump`)

**Files:**
- Create: `backend/bots/mc_agent_manager.py` (partie 1 : parsing pur)
- Create: `backend/bots/tests/__init__.py` (vide)
- Test: `backend/bots/tests/test_mc_agent_manager.py`

- [ ] **Step 1: Écrire le test qui échoue**

`backend/bots/tests/test_mc_agent_manager.py` :
```python
import io
from backend.bots import mc_agent_manager as mgr


def test_parse_event_line_valide():
    ev = mgr.parse_event_line('{"type":"status","state":"spawned"}')
    assert ev == {"type": "status", "state": "spawned"}


def test_parse_event_line_rejette_le_bruit():
    assert mgr.parse_event_line("pas du json") is None
    assert mgr.parse_event_line("") is None
    assert mgr.parse_event_line('{"sans":"type"}') is None


def test_apply_event_met_a_jour_statut_et_transcript():
    s = {"status": "starting", "transcript": [], "events": [], "last_error": None}
    mgr._apply_event(s, {"type": "status", "state": "spawned"})
    mgr._apply_event(s, {"type": "chat", "from": "Massii", "message": "salut"})
    mgr._apply_event(s, {"type": "error", "message": "boom"})
    assert s["status"] == "spawned"
    assert s["transcript"] == [{"type": "chat", "from": "Massii", "message": "salut"}]
    assert s["last_error"] == "boom"
    assert len(s["events"]) == 3


def test_pump_lit_un_flux_et_finit_en_stopped():
    s = {"status": "starting", "transcript": [], "events": [], "last_error": None}
    stream = io.StringIO(
        '{"type":"status","state":"spawned"}\n'
        'bruit\n'
        '{"type":"say","message":"coucou"}\n'
    )
    mgr._pump(s, stream)
    assert s["status"] == "stopped"  # flux terminé
    assert len(s["transcript"]) == 1
    assert len(s["events"]) == 2
```

- [ ] **Step 2: Lancer → échec attendu**

Run:
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur" && source venv/bin/activate && python -m pytest backend/bots/tests/test_mc_agent_manager.py -v
```
Expected: FAIL (`ModuleNotFoundError: backend.bots.mc_agent_manager`)

- [ ] **Step 3: Créer `backend/bots/tests/__init__.py` (vide) puis `backend/bots/mc_agent_manager.py` (partie 1)**

`backend/bots/mc_agent_manager.py` :
```python
"""
Gestionnaire de sessions MC Agent.

Spawn le process Node (mc-agent/index.js) en subprocess détaché, lit son stdout
ligne-par-ligne (events JSON), maintient un registre de sessions en mémoire, et
permet de piloter chaque session (stop, say). Pattern miroir de Yield/Scanner.
"""
import json
import os
import signal
import subprocess
import threading
from pathlib import Path

# backend/bots/mc_agent_manager.py → racine projet = parents[2], puis mc-agent/
MC_AGENT_DIR = Path(__file__).resolve().parents[2] / "mc-agent"

_sessions = {}        # session_id (int) -> dict
_lock = threading.Lock()
_counter = 0


def parse_event_line(line):
    """Parse une ligne stdout du process Node. Retourne un dict event valide, sinon None."""
    line = (line or "").strip()
    if not line:
        return None
    try:
        obj = json.loads(line)
    except (ValueError, TypeError):
        return None
    if not isinstance(obj, dict) or "type" not in obj:
        return None
    return obj


def _apply_event(session, event):
    """Met à jour l'état d'une session selon l'event reçu."""
    etype = event.get("type")
    if etype == "status":
        session["status"] = event.get("state", session["status"])
    elif etype in ("chat", "say"):
        session["transcript"].append(event)
        session["transcript"] = session["transcript"][-200:]
    elif etype == "error":
        session["last_error"] = event.get("message")
    session["events"].append(event)
    session["events"] = session["events"][-500:]


def _pump(session, stream):
    """Boucle de lecture du stdout du process : applique chaque event jusqu'à la fin du flux."""
    for line in stream:
        event = parse_event_line(line)
        if event:
            _apply_event(session, event)
    session["status"] = "stopped"
```

- [ ] **Step 4: Lancer → succès attendu**

Run:
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur" && source venv/bin/activate && python -m pytest backend/bots/tests/test_mc_agent_manager.py -v
```
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add backend/bots/mc_agent_manager.py backend/bots/tests/__init__.py backend/bots/tests/test_mc_agent_manager.py
git commit -m "feat(mc-agent): manager parsing d'events (TDD)"
```

---

## Task 9: Manager Python — registre de sessions (start/stop/say/status/active)

**Files:**
- Modify: `backend/bots/mc_agent_manager.py`
- Test: `backend/bots/tests/test_mc_agent_manager.py` (ajout)

- [ ] **Step 1: Ajouter les tests qui échouent**

Ajouter à la fin de `backend/bots/tests/test_mc_agent_manager.py` :
```python
class FakeProc:
    """Faux subprocess : stdout = flux fini, stdin capturé, pas de vrai process."""
    def __init__(self, stdout_text):
        self.stdout = io.StringIO(stdout_text)
        self.stdin = io.StringIO()
        self.pid = 4242
        self._alive = True
    def poll(self):
        return None if self._alive else 0


def test_has_api_key(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    assert mgr.has_api_key() is True
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert mgr.has_api_key() is False


def test_start_session_enregistre_et_pompe(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    created = {}
    def fake_popen(cmd, **kw):
        created["cmd"] = cmd
        created["env_has_key"] = kw.get("env", {}).get("ANTHROPIC_API_KEY") == "sk-test"
        return FakeProc('{"type":"status","state":"spawned"}\n')
    monkeypatch.setattr(mgr.subprocess, "Popen", fake_popen)
    sid = mgr.start_session("play.exemple.net", 25565, "TrainBot", "claude-haiku-4-5-20251001")
    mgr._sessions[sid]["thread"].join(timeout=2)
    assert created["env_has_key"] is True
    assert "--host" in created["cmd"] and "play.exemple.net" in created["cmd"]
    st = mgr.get_status(sid)
    assert st["status"] in ("spawned", "stopped")
    assert any(s["id"] == sid for s in mgr.list_active())


def test_send_command_ecrit_sur_stdin(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setattr(mgr.subprocess, "Popen", lambda cmd, **kw: FakeProc(""))
    sid = mgr.start_session("h", 25565, "B", None)
    mgr._sessions[sid]["thread"].join(timeout=2)
    assert mgr.send_command(sid, {"type": "say", "message": "hi"}) is True
    assert mgr.send_command(99999, {"type": "say", "message": "x"}) is False


def test_get_status_inconnu_retourne_none():
    assert mgr.get_status(123456) is None
```

- [ ] **Step 2: Lancer → échec attendu**

Run:
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur" && source venv/bin/activate && python -m pytest backend/bots/tests/test_mc_agent_manager.py -v
```
Expected: FAIL (`has_api_key` / `start_session` / `send_command` not defined)

- [ ] **Step 3: Compléter `backend/bots/mc_agent_manager.py`**

Ajouter à la fin du fichier :
```python
def _node_bin():
    """Binaire node : surchargeable via MC_AGENT_NODE_BIN (PATH systemd ≠ PATH shell)."""
    return os.environ.get("MC_AGENT_NODE_BIN", "node")


def has_api_key():
    """True si ANTHROPIC_API_KEY est présente dans l'environnement (chargée via .env)."""
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def start_session(host, port, user, model=None):
    """Spawn le process Node détaché et enregistre la session. Retourne son id."""
    global _counter
    cmd = [_node_bin(), str(MC_AGENT_DIR / "index.js"),
           "--host", str(host), "--port", str(port), "--user", str(user)]
    if model:
        cmd += ["--model", str(model)]
    env = dict(os.environ)  # hérite ANTHROPIC_API_KEY (chargée par backend.config/.env)
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        stdin=subprocess.PIPE,
        text=True,
        bufsize=1,
        cwd=str(MC_AGENT_DIR),
        env=env,
        start_new_session=True,  # détaché : survit à un reload uvicorn (cf. piège #30f)
    )
    with _lock:
        _counter += 1
        sid = _counter
    session = {
        "id": sid, "proc": proc, "status": "starting",
        "transcript": [], "events": [], "last_error": None,
        "host": host, "user": user,
    }
    _sessions[sid] = session
    t = threading.Thread(target=_pump, args=(session, proc.stdout), daemon=True)
    t.start()
    session["thread"] = t
    return sid


def _public(session):
    """Vue sérialisable d'une session (sans proc/thread)."""
    return {
        "id": session["id"], "status": session["status"], "host": session["host"],
        "user": session["user"], "last_error": session["last_error"],
    }


def get_status(sid):
    s = _sessions.get(sid)
    return _public(s) if s else None


def get_transcript(sid):
    s = _sessions.get(sid)
    return list(s["transcript"]) if s else None


def list_active():
    return [_public(s) for s in _sessions.values()
            if s.get("proc") is None or s["proc"].poll() is None]


def send_command(sid, command):
    """Envoie une commande JSON sur le stdin du process Node. False si session inconnue."""
    s = _sessions.get(sid)
    if not s or not s.get("proc") or not s["proc"].stdin:
        return False
    try:
        s["proc"].stdin.write(json.dumps(command) + "\n")
        s["proc"].stdin.flush()
    except (ValueError, OSError):
        return False
    return True


def stop_session(sid):
    """Arrête une session (SIGTERM au groupe de process). False si session inconnue."""
    s = _sessions.get(sid)
    if not s:
        return False
    proc = s.get("proc")
    if proc and proc.poll() is None:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            proc.terminate()
    s["status"] = "stopped"
    return True
```

> Note : `FakeProc.flush` n'existe pas sur `io.StringIO`? Si — `StringIO` a bien `.flush()`. Pour `send_command`, `proc.stdin` est un `StringIO` dans le test → `.write`/`.flush` OK.

- [ ] **Step 4: Lancer → succès attendu**

Run:
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur" && source venv/bin/activate && python -m pytest backend/bots/tests/test_mc_agent_manager.py -v
```
Expected: 8 passed

- [ ] **Step 5: Commit**

```bash
git add backend/bots/mc_agent_manager.py backend/bots/tests/test_mc_agent_manager.py
git commit -m "feat(mc-agent): manager registre de sessions (start/stop/say/status)"
```

---

## Task 10: Router `mc_agent_router.py` (admin-only)

**Files:**
- Create: `backend/bots/mc_agent_router.py`
- Test: `backend/bots/tests/test_mc_agent_router.py`

- [ ] **Step 1: Écrire le test qui échoue**

`backend/bots/tests/test_mc_agent_router.py` :
```python
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.bots import mc_agent_router as r
from backend.bots import mc_agent_manager as mgr
from backend.auth.utils import get_current_user


class FakeUser:
    def __init__(self, is_admin):
        self.is_admin = is_admin
        self.role = "admin" if is_admin else "player"


def make_client(is_admin=True):
    app = FastAPI()
    app.include_router(r.router)
    app.dependency_overrides[get_current_user] = lambda: FakeUser(is_admin)
    return TestClient(app)


def test_run_refuse_les_non_admins():
    c = make_client(is_admin=False)
    resp = c.post("/api/mc-agent/run", json={"host": "h"})
    assert resp.status_code == 403


def test_run_400_si_pas_de_cle(monkeypatch):
    monkeypatch.setattr(mgr, "has_api_key", lambda: False)
    c = make_client()
    resp = c.post("/api/mc-agent/run", json={"host": "h"})
    assert resp.status_code == 400


def test_run_demarre_une_session(monkeypatch):
    monkeypatch.setattr(mgr, "has_api_key", lambda: True)
    monkeypatch.setattr(mgr, "start_session", lambda host, port, user, model=None: 7)
    c = make_client()
    resp = c.post("/api/mc-agent/run", json={"host": "play.x.net", "user": "TrainBot"})
    assert resp.status_code == 200
    assert resp.json()["session_id"] == 7


def test_status_404_si_inconnu(monkeypatch):
    monkeypatch.setattr(mgr, "get_status", lambda sid: None)
    c = make_client()
    assert c.get("/api/mc-agent/status/999").status_code == 404


def test_stop_ok(monkeypatch):
    monkeypatch.setattr(mgr, "stop_session", lambda sid: True)
    c = make_client()
    resp = c.post("/api/mc-agent/stop/3")
    assert resp.status_code == 200 and resp.json()["ok"] is True
```

- [ ] **Step 2: Lancer → échec attendu**

Run:
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur" && source venv/bin/activate && python -m pytest backend/bots/tests/test_mc_agent_router.py -v
```
Expected: FAIL (`ModuleNotFoundError: backend.bots.mc_agent_router`)

- [ ] **Step 3: Implémenter `backend/bots/mc_agent_router.py`**

```python
"""Router MC Agent — pilotage du bot Minecraft d'entrainement (admin-only)."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from backend.auth.utils import get_current_user
from backend.auth.models import User
from backend.bots import mc_agent_manager as mgr

router = APIRouter(prefix="/api/mc-agent", tags=["mc-agent"])


def _require_admin(user):
    if not getattr(user, "is_admin", False):
        raise HTTPException(status_code=403, detail="Admin uniquement")


class StartReq(BaseModel):
    host: str
    port: int = 25565
    user: str = "TrainBot"
    model: Optional[str] = None  # Python 3.9 : pas de `str | None` (piège #1)


class SayReq(BaseModel):
    message: str


@router.post("/run")
def run(req: StartReq, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    if not mgr.has_api_key():
        raise HTTPException(status_code=400, detail="ANTHROPIC_API_KEY absente de l'environnement")
    sid = mgr.start_session(req.host, req.port, req.user, req.model)
    return {"session_id": sid}


@router.get("/active")
def active(current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    return {"sessions": mgr.list_active()}


@router.get("/status/{sid}")
def status(sid: int, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    s = mgr.get_status(sid)
    if not s:
        raise HTTPException(status_code=404, detail="Session introuvable")
    return s


@router.get("/chat/{sid}")
def chat(sid: int, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    t = mgr.get_transcript(sid)
    if t is None:
        raise HTTPException(status_code=404, detail="Session introuvable")
    return {"transcript": t}


@router.post("/say/{sid}")
def say(sid: int, req: SayReq, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    if not mgr.send_command(sid, {"type": "say", "message": req.message}):
        raise HTTPException(status_code=404, detail="Session introuvable")
    return {"ok": True}


@router.post("/stop/{sid}")
def stop(sid: int, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    if not mgr.stop_session(sid):
        raise HTTPException(status_code=404, detail="Session introuvable")
    return {"ok": True}
```

- [ ] **Step 4: Lancer → succès attendu**

Run:
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur" && source venv/bin/activate && python -m pytest backend/bots/tests/test_mc_agent_router.py -v
```
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add backend/bots/mc_agent_router.py backend/bots/tests/test_mc_agent_router.py
git commit -m "feat(mc-agent): router /api/mc-agent (admin-only, TDD)"
```

---

## Task 11: Enregistrer le router dans `main.py` + smoke API

**Files:**
- Modify: `backend/main.py` (zone des imports de routers ~ligne 155, et zone `include_router` ~ligne 156+)

- [ ] **Step 1: Ajouter l'import du router**

Dans `backend/main.py`, juste après la ligne `from backend.bots.scanner_router import router as scanner_router` (ligne 147) :
```python
from backend.bots.mc_agent_router import router as mc_agent_router
```

- [ ] **Step 2: Ajouter l'include_router**

Repérer le bloc des `app.include_router(...)` (vers la ligne 167+). Après la ligne qui inclut le scanner router (`app.include_router(scanner_router)`), ajouter :
```python
app.include_router(mc_agent_router)
```

> Vérifier le nom exact : `grep -n "scanner_router" backend/main.py` doit montrer un import ET un include ; on ajoute nos 2 lignes juste après chacun.

- [ ] **Step 3: Vérifier que l'app démarre et expose les routes**

Run:
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur" && source venv/bin/activate && python -c "from backend.main import app; routes=[r.path for r in app.routes]; print([p for p in routes if 'mc-agent' in p])"
```
Expected: une liste contenant `/api/mc-agent/run`, `/api/mc-agent/status/{sid}`, etc.

- [ ] **Step 4: Commit**

```bash
git add backend/main.py
git commit -m "feat(mc-agent): enregistre le router dans main.py"
```

---

## Task 12: Frontend — carte "MC Agent" + vue de pilotage

**Files:**
- Modify: `frontend/js/bots_module.js` (ajout de la carte spéciale + méthodes `openMCAgent`/`startMCAgent`/`refreshMCAgent`/`sayMCAgent`/`stopMCAgent`)
- Modify: `frontend/js/lang.js` (clés `mcagent.*`)
- Modify: `frontend/index.html` (cache-bust)
- Modify: `frontend/sw.js` (CACHE_NAME)

> Vue smoke/manuelle (pas de test unitaire frontend dans ce projet vanilla).

- [ ] **Step 1: Repérer la carte Bond Scanner pour mirrorer**

Run:
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur" && grep -n "openBondScanner\|onClick: 'BotsModule.openBondScanner" frontend/js/bots_module.js | head
```
Ce sont les emplacements à mirrorer (carte spéciale dans `_renderGrid`, méthode `open*`).

- [ ] **Step 2a: Définir la carte virtuelle `mcAgentCard` (admin-only)**

Dans `frontend/js/bots_module.js`, méthode `_renderGrid()`, juste **après** le bloc `const scannerBotCard = canSeeScanner ? buildBotCard({...}) : '';` (se termine vers la ligne 101), ajouter :
```js
    // MC Agent virtual card (admin-only — feature d'entrainement staff)
    const canSeeMCAgent = u && u.is_admin;
    const mcAgentCard = canSeeMCAgent ? buildBotCard({
      icon: 'MCA',
      name: 'MC Agent',
      type: 'gaming',
      desc: Lang.t('mcagent.desc'),
      status: '',
      statusLabel: Lang.t('mcagent.training'),
      onClick: 'BotsModule.openMCAgent()',
      actions: `<button class="btn btn-ghost btn-sm">${Lang.t('mcagent.open')}</button>`,
      selected: false,
      sharedWithYou: false,
    }) : '';
```

- [ ] **Step 2b: Interpoler la carte aux DEUX points de grille**

Il y a deux blocs `<div class="bots-grid-bento">` (état vide ~L106, état peuplé ~L151). Dans **chacun**, juste après la ligne `${scannerBotCard}`, ajouter une ligne :
```js
        ${mcAgentCard}
```
> Vérifier les 2 occurrences : `grep -n "scannerBotCard" frontend/js/bots_module.js` doit montrer la définition + 2 interpolations ; on ajoute `${mcAgentCard}` après les 2 interpolations.

- [ ] **Step 3: Ajouter les méthodes de pilotage à l'objet `BotsModule`**

Ajouter ces méthodes dans l'objet `BotsModule` (par ex. juste après `openBondScanner`) :
```js
  async openMCAgent() {
    // Stoppe le poll scanner (évite le bleed) ET un éventuel poll MC Agent résiduel
    if (this._refreshInterval) { clearInterval(this._refreshInterval); this._refreshInterval = null; }
    if (this._mcAgentTimer) { clearInterval(this._mcAgentTimer); this._mcAgentTimer = null; }
    this._mcAgentSession = this._mcAgentSession || null;
    // Conteneur canonique du module (cf. openBondScanner/_renderYield* : this._container set dans render())
    const el = this._container || document.getElementById('bots-module-container')?.parentElement;
    if (!el) return;
    el.innerHTML = `
      <div class="card">
        <h3 style="margin:0 0 12px;">MC Agent — ${Lang.t('mcagent.training')}</h3>
        <div style="display:grid;grid-template-columns:1fr 120px 1fr;gap:10px;margin-bottom:10px;">
          <div><label class="form-label">${Lang.t('mcagent.host')}</label><input id="mca-host" class="form-input" placeholder="play.exemple.net" /></div>
          <div><label class="form-label">${Lang.t('mcagent.port')}</label><input id="mca-port" class="form-input" value="25565" /></div>
          <div><label class="form-label">${Lang.t('mcagent.pseudo')}</label><input id="mca-user" class="form-input" value="TrainBot" /></div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;">
          <button class="btn btn-primary" onclick="BotsModule.startMCAgent()">${Lang.t('mcagent.start')}</button>
          <button class="btn btn-secondary btn-sm" onclick="BotsModule.stopMCAgent()">${Lang.t('mcagent.stop')}</button>
          <span id="mca-msg" style="font-size:13px;color:var(--text-muted);"></span>
        </div>
        <div id="mca-transcript" style="background:#0d1117;border-radius:8px;padding:12px;max-height:300px;overflow-y:auto;font-family:'Fira Code',monospace;font-size:12px;line-height:1.6;color:#c9d1d9;"></div>
        <div style="display:flex;gap:8px;margin-top:10px;">
          <input id="mca-say" class="form-input" placeholder="${Lang.t('mcagent.say_placeholder')}" style="flex:1;" />
          <button class="btn btn-secondary" onclick="BotsModule.sayMCAgent()">${Lang.t('mcagent.send')}</button>
        </div>
      </div>`;
  },

  async startMCAgent() {
    const host = document.getElementById('mca-host').value.trim();
    const port = parseInt(document.getElementById('mca-port').value, 10) || 25565;
    const user = document.getElementById('mca-user').value.trim() || 'TrainBot';
    const msg = document.getElementById('mca-msg');
    if (!host) { msg.textContent = Lang.t('mcagent.need_host'); return; }
    const r = await Auth.apiCall('/api/mc-agent/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, port, user }),
    });
    const data = await r.json();
    if (!r.ok) { msg.textContent = data.detail || 'Erreur'; return; }
    this._mcAgentSession = data.session_id;
    msg.textContent = `session #${data.session_id}`;
    this._mcAgentTimer = setInterval(() => BotsModule.refreshMCAgent(), 3000);
  },

  async refreshMCAgent() {
    if (!this._mcAgentSession) return;
    const r = await Auth.apiCall(`/api/mc-agent/chat/${this._mcAgentSession}`);
    if (!r.ok) return;
    const data = await r.json();
    const box = document.getElementById('mca-transcript');
    if (!box) { clearInterval(this._mcAgentTimer); return; }
    box.innerHTML = (data.transcript || []).map((e) =>
      e.type === 'say'
        ? `<div style="color:#4ade80;">[bot] ${e.message}</div>`
        : `<div>&lt;${e.from || '?'}&gt; ${e.message || ''}</div>`
    ).join('');
    box.scrollTop = box.scrollHeight;
  },

  async sayMCAgent() {
    if (!this._mcAgentSession) return;
    const input = document.getElementById('mca-say');
    const message = input.value.trim();
    if (!message) return;
    await Auth.apiCall(`/api/mc-agent/say/${this._mcAgentSession}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    input.value = '';
  },

  async stopMCAgent() {
    if (!this._mcAgentSession) return;
    await Auth.apiCall(`/api/mc-agent/stop/${this._mcAgentSession}`, { method: 'POST' });
    clearInterval(this._mcAgentTimer);
    const msg = document.getElementById('mca-msg');
    if (msg) msg.textContent = Lang.t('mcagent.stopped');
    this._mcAgentSession = null;
  },
```
> `refreshMCAgent`/`sayMCAgent`/`stopMCAgent` lisent leurs éléments par `id` dans le HTML rendu ci-dessus — pas besoin d'autre conteneur. Le poll du transcript utilise `this._mcAgentTimer` (créé dans `startMCAgent`, nettoyé dans `stopMCAgent`/`openMCAgent`) — distinct de `this._refreshInterval` (poll scanner).

- [ ] **Step 4: Ajouter les clés i18n dans `frontend/js/lang.js`**

Dans chaque bloc de langue (`fr`, `en`, `it`), ajouter une section `mcagent` (exemple FR ; traduire pour EN/IT) :
```js
    mcagent: {
      training: 'Entrainement', open: 'Ouvrir',
      desc: 'Agent Minecraft d entrainement staff (pilote par Claude).',
      host: 'Serveur', port: 'Port', pseudo: 'Pseudo',
      start: 'Demarrer', stop: 'Arreter', stopped: 'Arrete',
      send: 'Envoyer', say_placeholder: 'Parler au bot...',
      need_host: 'Renseigne l adresse du serveur',
    },
```
EN (valeurs) : `training:'Training', open:'Open', desc:'Staff-training Minecraft agent (Claude-driven).', host:'Server', port:'Port', pseudo:'Username', start:'Start', stop:'Stop', stopped:'Stopped', send:'Send', say_placeholder:'Talk to the bot...', need_host:'Enter the server address'`
IT (valeurs) : `training:'Addestramento', open:'Apri', desc:'Agente Minecraft per addestrare lo staff (guidato da Claude).', host:'Server', port:'Porta', pseudo:'Nome', start:'Avvia', stop:'Ferma', stopped:'Fermato', send:'Invia', say_placeholder:'Parla al bot...', need_host:'Inserisci l indirizzo del server'`

- [ ] **Step 5: Cache-bust (piège #9/#11/#35-bis)**

Dans `frontend/index.html`, bumper le `?v=` de `bots_module.js` ET `lang.js` à la prochaine valeur franche (ex. `?v=110`). Dans `frontend/sw.js`, bumper `CACHE_NAME` (ex. `omenserver-v79`).

Run pour repérer les valeurs courantes :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur" && grep -nE "bots_module.js\?v=|lang.js\?v=" frontend/index.html && grep -n "CACHE_NAME" frontend/sw.js
```

- [ ] **Step 6: Commit**

```bash
git add frontend/js/bots_module.js frontend/js/lang.js frontend/index.html frontend/sw.js
git commit -m "feat(mc-agent): carte + vue de pilotage frontend (i18n FR/EN/IT)"
```

---

## Task 13: Smoke end-to-end + note de déploiement CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (note de déploiement Node)

- [ ] **Step 1: Lancer un serveur Minecraft de test offline-mode**

Utiliser le module game_server d'OmenServer (ou un serveur local Paper/Vanilla en `online-mode=false`). Noter son IP locale + port (25565 par défaut).

- [ ] **Step 2: Exporter la clé Claude + lancer le backend dev**

Ajouter `ANTHROPIC_API_KEY=sk-ant-...` au `.env`, puis (commande à lancer par Massii dans son terminal — uvicorn --reload, cf. CLAUDE.md global) :
```bash
source venv/bin/activate && uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

- [ ] **Step 3: Démarrer l'agent depuis l'UI**

Ouvrir le dashboard (loggé admin) → module Bots → carte **MC Agent** → renseigner host/port → **Démarrer**. Vérifier dans le panneau live le passage `starting → spawned`.

- [ ] **Step 4: Vérifier in-game**

Sur le serveur MC, voir le bot apparaître. Lui écrire dans le chat « tu peux me suivre ? » → le bot répond (transcript) ET commence à suivre. Tester `goto`/un message libre via l'input "Parler au bot".

- [ ] **Step 5: Arrêter et documenter**

Cliquer **Arrêter** → statut `stopped`, le bot se déconnecte.

Ajouter dans `CLAUDE.md` (section « ⚠️ Pièges connus ») une entrée :
```
34. **MC Agent = process Node, pas Python** : le bot d'entrainement (`mc-agent/`) tourne en
    Node/Mineflayer, spawné par `mc_agent_manager.py` en subprocess détaché. (a) **Node requis
    sur l'Omen** : `apt install nodejs npm` + `npm install` dans `mc-agent/` — l'auto-deploy NE
    réinstalle PAS les deps Node (analogie `curl_cffi` piège #33). (b) **PATH systemd** : le `node`
    de nvm n'est pas dans le PATH systemd → définir `MC_AGENT_NODE_BIN=/chemin/absolu/node` dans
    l'env du service si `node` introuvable. (c) **Offline-mode only** en Phase 0. (d) Clé Claude
    via `ANTHROPIC_API_KEY` dans `.env` (héritée par le subprocess). (e) Garde-fous projet : pas de
    furtivité/évasion, tells documentés — cf. spec `docs/superpowers/specs/2026-05-29-mc-agent-training-design.md`.
```

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(mc-agent): note de deploiement Node (piege #34)"
```

---

## Définition de "Phase 0 terminée"

- `cd mc-agent && npm test` → tous verts (smoke, io, state, brain×2, skills)
- `python -m pytest backend/bots/tests/ -v` → tous verts (manager + router)
- Smoke end-to-end : le bot se connecte, répond dans le chat via Claude, suit un joueur, s'arrête proprement depuis l'UI.
- Aucune brique de furtivité/évasion. Bot honnête sur sa nature.

**Phase 1 (plan séparé à venir)** : profils de comportement calibrés + fiches de tells (tier Expert orienté raisonnement/observation), skills supplémentaires (mine/collectWood/attack/flee), réflexes auto-eat, auth Microsoft.
