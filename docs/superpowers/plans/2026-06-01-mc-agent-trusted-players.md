# MC Agent — Gens de confiance (gating ordres + TP/trade) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Une liste de gens de confiance par profil serveur qui n'autorise les ORDRES (actions/commandes) qu'à ces joueurs, auto-accepte leurs /tpa (et trades), et laisse le bot répondre aux questions de tout le monde.

**Architecture:** Module pur `mc-agent/trust.js` (liste de confiance + gating + parsing des demandes TP/trade Essentials). Gating double : prompt LLM (refus in-character) + suppression dure de `action`/`command` dans `index.js` si l'émetteur n'est pas listé. La policy `{trusted, trade}` est résolue côté backend depuis le profil et passée au subprocess via `--policy`. Auto-accept TP via un handler `bot.on('messagestr')`, gated par la whitelist commandes (`/tpaccept` doit être coché).

**Tech Stack:** Node.js (`node:test`), Python FastAPI (stdlib), Vanilla JS, i18n FR/EN/IT.

**Spec:** `docs/superpowers/specs/2026-06-01-mc-agent-trusted-players-design.md`

---

## File Structure

**Créés :**
- `mc-agent/trust.js` — pur : `loadPolicy`, `isTrusted`, `parseTpRequest`, `parseTradeRequest`, `gateDecision`, `buildTrustDocs`.
- `mc-agent/test/trust.test.js` — tests Node.
- `mc-agent/test/brain_trust.test.js` — tests injection prompt + sender.

**Modifiés :**
- `mc-agent/brain.js` — `buildSystemPrompt(profile, commandDocs, trustDocs)` ; `think` passe `trustDocs` + `sender`.
- `mc-agent/index.js` — charge la policy (`--policy`), gate les ordres, handler `messagestr` (TP/trade auto-accept).
- `backend/bots/mc_agent_servers.py` — `_clean_server` (trusted+trade), `resolve_policy`.
- `backend/bots/mc_agent_manager.py` — `start_session(..., policy=None)` écrit `policy-<sid>.json` + `--policy` ; cleanup au stop.
- `backend/bots/mc_agent_router.py` — `ServerPayload` (trusted+trade), `run` résout+passe la policy.
- `backend/bots/tests/test_mc_agent_servers.py` · `test_mc_agent_manager.py` · `test_mc_agent_router.py`.
- `frontend/js/bots_module.js` — éditeur : section « Gens de confiance » + « Trade (optionnel) » + note « clé commune ».
- `frontend/js/lang.js` — clés `mcagent.cfg.trusted_*` / `trade_*` / `key_shared_note`.
- `frontend/index.html` — bump `?v=201`→`202` (lang + bots_module). `frontend/sw.js` — `CACHE_NAME` v86→v87.

**Tests Node :** `cd mc-agent && node --test`
**Tests Python :** racine projet, `"<venv>/bin/python" -m pytest backend/bots/tests/ -q` (venv = `./venv`).

⚠️ `frontend/js/bots_module.js` utilise une **indentation à 1 espace** (pas 4). Repérer les points d'insertion par contenu, et matcher ce style.

---

## Task 1: Module `trust.js` (pur) + tests

**Files:**
- Create: `mc-agent/trust.js`
- Test: `mc-agent/test/trust.test.js`

- [ ] **Step 1: Écrire le test (échoue)**

Create `mc-agent/test/trust.test.js` :

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadPolicy, isTrusted, parseTpRequest, parseTradeRequest, gateDecision, buildTrustDocs } = require('../trust');

const TRUSTED = ['Massii_08', 'Pote2'];

test('isTrusted: match insensible à la casse + trim, vide → false', () => {
  assert.strictEqual(isTrusted('massii_08', TRUSTED), true);
  assert.strictEqual(isTrusted('  Pote2 ', TRUSTED), true);
  assert.strictEqual(isTrusted('Intrus', TRUSTED), false);
  assert.strictEqual(isTrusted('Massii_08', []), false);
  assert.strictEqual(isTrusted('', TRUSTED), false);
});

test('parseTpRequest: formats Essentials EN → demandeur, sinon null', () => {
  assert.strictEqual(parseTpRequest('Bob has requested to teleport to you.'), 'Bob');
  assert.strictEqual(parseTpRequest('Bob has requested that you teleport to them.'), 'Bob');
  assert.strictEqual(parseTpRequest('<Bob> salut tout le monde'), null); // chat joueur ignoré
  assert.strictEqual(parseTpRequest('random server message'), null);
});

test('parseTpRequest: format Essentials FR', () => {
  assert.strictEqual(parseTpRequest('Bob vous a demandé de se téléporter à vous.'), 'Bob');
});

test('parseTradeRequest: pattern configuré → demandeur ; pattern invalide → null', () => {
  const cfg = { acceptCmd: '/trade accept', requestPattern: '^(\\w+) veut échanger' };
  assert.strictEqual(parseTradeRequest('Bob veut échanger avec toi', cfg), 'Bob');
  assert.strictEqual(parseTradeRequest('rien', cfg), null);
  assert.strictEqual(parseTradeRequest('x', { acceptCmd: '/t', requestPattern: '(' }), null); // regex invalide
  assert.strictEqual(parseTradeRequest('x', null), null);
});

test('gateDecision: liste vide → passe tout (gating off)', () => {
  const d = { reply: 'ok', action: 'mineBlock', args: {}, command: null };
  assert.strictEqual(gateDecision(d, 'NImporteQui', []), d); // même référence
});

test('gateDecision: trusted → passe ; non-trusted avec ordre → action+command retirées, reply gardé', () => {
  const d = { reply: 'jarrive', action: 'follow', args: { player: 'x' }, command: '/home' };
  assert.strictEqual(gateDecision(d, 'Massii_08', TRUSTED), d); // trusted → inchangé
  const g = gateDecision(d, 'Intrus', TRUSTED);
  assert.notStrictEqual(g, d);
  assert.strictEqual(g.action, null);
  assert.strictEqual(g.command, null);
  assert.strictEqual(g.reply, 'jarrive');
});

test('gateDecision: non-trusted mais juste une question (pas d ordre) → passe (même ref)', () => {
  const d = { reply: 'oui je suis un bot', action: null, args: {}, command: null };
  assert.strictEqual(gateDecision(d, 'Intrus', TRUSTED), d);
});

test('buildTrustDocs: liste → mentionne les noms ; vide → ""', () => {
  const doc = buildTrustDocs(TRUSTED);
  assert.match(doc, /Massii_08/);
  assert.match(doc, /Pote2/);
  assert.match(doc, /ORDRES/);
  assert.strictEqual(buildTrustDocs([]), '');
});

test('loadPolicy: absent → {trusted:[],trade:null} ; fichier valide → parsé', () => {
  assert.deepStrictEqual(loadPolicy(''), { trusted: [], trade: null });
  assert.deepStrictEqual(loadPolicy('/no/such.json'), { trusted: [], trade: null });
  const f = path.join(os.tmpdir(), 'mca-policy-' + process.pid + '.json');
  fs.writeFileSync(f, JSON.stringify({ trusted: ['A'], trade: { acceptCmd: '/t accept', requestPattern: 'x' } }));
  try {
    const p = loadPolicy(f);
    assert.deepStrictEqual(p.trusted, ['A']);
    assert.strictEqual(p.trade.acceptCmd, '/t accept');
  } finally { fs.unlinkSync(f); }
});
```

- [ ] **Step 2: Lancer → échec**

Run: `cd "<worktree>/mc-agent" && node --test test/trust.test.js`
Expected: FAIL (`Cannot find module '../trust'`).

- [ ] **Step 3: Écrire `mc-agent/trust.js`**

```js
'use strict';
// Liste de gens de confiance + gating des ordres + détection des demandes TP/trade (Essentials).
// Logique pure, testable sans client MC (cf. piège #38). Policy = {trusted:[], trade:null}.
const fs = require('fs');

/** Charge la policy depuis un fichier JSON. Absent/illisible → {trusted:[], trade:null}. */
function loadPolicy(filePath) {
  if (!filePath) return { trusted: [], trade: null };
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const trusted = Array.isArray(data.trusted) ? data.trusted.filter((u) => typeof u === 'string') : [];
    const trade = (data.trade && typeof data.trade === 'object' && typeof data.trade.acceptCmd === 'string')
      ? { acceptCmd: data.trade.acceptCmd, requestPattern: String(data.trade.requestPattern || '') }
      : null;
    return { trusted, trade };
  } catch (e) {
    return { trusted: [], trade: null };
  }
}

/** L'émetteur est-il de confiance ? Match exact, insensible à la casse + trim. */
function isTrusted(user, trusted) {
  if (!user || !Array.isArray(trusted) || !trusted.length) return false;
  const u = String(user).trim().toLowerCase();
  return trusted.some((t) => String(t).trim().toLowerCase() === u);
}

// Patterns de demande TP Essentials (EN + FR). 1er groupe = le demandeur.
// Ancrés sur ^\w → le chat joueur "<Bob> ..." (commence par '<') ne matche jamais.
const TP_PATTERNS = [
  /^(\w+) has requested to teleport to you\b/i,
  /^(\w+) has requested that you teleport to (?:them|you)\b/i,
  /^(\w+)\b.{0,30}\bdemand.{0,40}t[ée]l[ée]port/i,
];

/** Extrait le demandeur d'une ligne de demande TP Essentials, ou null. */
function parseTpRequest(msgStr) {
  const s = String(msgStr || '');
  for (const re of TP_PATTERNS) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return null;
}

/** Extrait le demandeur d'une demande trade selon le pattern configuré, ou null. */
function parseTradeRequest(msgStr, tradeCfg) {
  if (!tradeCfg || !tradeCfg.requestPattern) return null;
  let re;
  try { re = new RegExp(tradeCfg.requestPattern, 'i'); } catch (e) { return null; }
  const m = String(msgStr || '').match(re);
  return m ? (m[1] || null) : null;
}

/**
 * Gate les ORDRES : si l'émetteur n'est pas de confiance, retire action + command
 * (le bot ne garde que reply). Liste vide → gating OFF (tout passe). Question seule → inchangé.
 * Retourne la MÊME référence si rien à gater (permet de détecter le refus côté appelant).
 */
function gateDecision(decision, username, trusted) {
  if (!decision) return decision;
  if (!Array.isArray(trusted) || trusted.length === 0) return decision;
  if (isTrusted(username, trusted)) return decision;
  if (!decision.action && !decision.command) return decision;
  return Object.assign({}, decision, { action: null, command: null });
}

/** Bloc texte pour le system prompt. '' si pas de liste (gating off). */
function buildTrustDocs(trusted) {
  if (!Array.isArray(trusted) || !trusted.length) return '';
  return "Tu n'obeis aux ORDRES (deplacement, minage, attaque, commandes serveur) QUE de ces joueurs de confiance : "
    + trusted.join(', ')
    + ". Si un AUTRE joueur te donne un ordre, refuse gentiment en restant dans ton personnage (ne fais pas l'action). "
    + "Mais tu reponds normalement aux QUESTIONS de tout le monde.";
}

module.exports = { loadPolicy, isTrusted, parseTpRequest, parseTradeRequest, gateDecision, buildTrustDocs };
```

- [ ] **Step 4: Lancer → 9 tests PASS**

Run: `cd "<worktree>/mc-agent" && node --test test/trust.test.js`

- [ ] **Step 5: Commit**

```bash
git add mc-agent/trust.js mc-agent/test/trust.test.js
git commit -m "feat(mc-agent): trust.js — liste de confiance + gating + parsing TP/trade (pur)"
```

---

## Task 2: `brain.js` — trustDocs dans le prompt + sender

**Files:**
- Modify: `mc-agent/brain.js`
- Test: `mc-agent/test/brain_trust.test.js`

- [ ] **Step 1: Écrire le test (échoue)**

Create `mc-agent/test/brain_trust.test.js` :

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildSystemPrompt, think, SYSTEM_PROMPT } = require('../brain');

test('buildSystemPrompt(null) reste EXACTEMENT SYSTEM_PROMPT (sans docs)', () => {
  assert.strictEqual(buildSystemPrompt(null), SYSTEM_PROMPT);
  assert.strictEqual(buildSystemPrompt(null, '', ''), SYSTEM_PROMPT);
});

test('buildSystemPrompt injecte trustDocs quand fourni', () => {
  const td = 'Joueurs de confiance : Massii_08.';
  assert.match(buildSystemPrompt(null, '', td), /Massii_08/);
  assert.match(buildSystemPrompt({ persona: 'X' }, '', td), /Massii_08/);
});

test('think transmet trustDocs au system et le sender au message', async () => {
  let captured;
  const client = { messages: { create: async (a) => { captured = a; return { content: [{ type: 'text', text: '{"reply":"ok"}' }] }; } } };
  await think(client, { state: {}, message: 'va chercher du bois', model: 'm', limiter: null, trustDocs: 'MARK_TRUST', sender: 'Intrus' });
  assert.match(captured.system, /MARK_TRUST/);
  assert.match(captured.messages[0].content, /De: Intrus/);
  assert.match(captured.messages[0].content, /va chercher du bois/);
});
```

- [ ] **Step 2: Lancer → échec**

Run: `cd "<worktree>/mc-agent" && node --test test/brain_trust.test.js`
Expected: FAIL (`buildSystemPrompt` ignore le 3e arg ; pas de `De:`).

- [ ] **Step 3: Modifier `mc-agent/brain.js`**

Replace the WHOLE `buildSystemPrompt` function with :

```js
/** Construit le system prompt : persona + commandes serveur dispo + gens de confiance. */
function buildSystemPrompt(profile, commandDocs = '', trustDocs = '') {
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
  return base.filter(Boolean).join(' ');
}
```

Replace the WHOLE `think` function with :

```js
async function think(client, { state, message, model, limiter, profile = null, commandDocs = '', trustDocs = '', sender = '' }) {
  if (limiter && !limiter.tryAcquire()) return null;
  const fromLine = sender ? `De: ${sender}\n` : '';
  const resp = await client.messages.create({
    model,
    max_tokens: 300,
    system: buildSystemPrompt(profile, commandDocs, trustDocs),
    messages: [{ role: 'user', content: `Etat: ${JSON.stringify(state)}\n${fromLine}Message recu: ${message}` }],
  });
  const text = (resp.content || []).map((b) => b.text || '').join('');
  return parseDecision(text);
}
```

Do NOT change `SYSTEM_PROMPT`, `ACTIONS_DOC`, `parseDecision`, `RateLimiter`, `module.exports`.

- [ ] **Step 4: Lancer la suite Node complète → PASS**

Run: `cd "<worktree>/mc-agent" && node --test`
Expected: PASS (brain_trust + brain_think/brain_profile/brain_command/commands toujours verts).

- [ ] **Step 5: Commit**

```bash
git add mc-agent/brain.js mc-agent/test/brain_trust.test.js
git commit -m "feat(mc-agent): system prompt gagne les gens de confiance + sender dans le message"
```

---

## Task 3: `index.js` — charge la policy, gate, auto-accept TP/trade

**Files:**
- Modify: `mc-agent/index.js`

> Pas de test unitaire (`index.js` connecte un vrai bot). Validation : `node --check` + suite Node.

- [ ] **Step 1: Importer `trust.js`**

In `mc-agent/index.js`, after the line `const { loadCommands, isAllowed, buildCommandDocs } = require('./commands');` add :

```js
const { loadPolicy, isTrusted, parseTpRequest, parseTradeRequest, gateDecision, buildTrustDocs } = require('./trust');
```

- [ ] **Step 2: Charger la policy**

After the block :
```js
const whitelist = loadCommands(args.commands);
const commandDocs = buildCommandDocs(whitelist); // bloc injecté dans le system prompt LLM
```
add :

```js
// Politique de confiance : gens autorisés à donner des ordres + auto-accept TP/trade.
const policy = loadPolicy(args.policy);
const trustDocs = buildTrustDocs(policy.trusted);
```

- [ ] **Step 3: Passer sender+trustDocs à think et gater la décision**

In `handleIncoming`, replace this block :
```js
    const decision = await think(client, { state: snapshot(bot), message, model, limiter, profile, commandDocs });
    if (!decision) { emit({ type: 'info', message: 'rate-limited' }); return; }
```
with :
```js
    const decision0 = await think(client, { state: snapshot(bot), message, model, limiter, profile, commandDocs, trustDocs, sender: username });
    if (!decision0) { emit({ type: 'info', message: 'rate-limited' }); return; }
    const decision = gateDecision(decision0, username, policy.trusted);
    if (decision !== decision0) { emit({ type: 'order_refused', from: username }); } // ordre d'un non-trusted retiré
```

(The rest of the `try` block keeps using `decision` for `reply`/`runAction`/`runCommand` — unchanged.)

- [ ] **Step 4: Handler auto-accept TP/trade**

In `mc-agent/index.js`, after the line `bot.on('whisper', (username, message) => handleIncoming(username, message, true));` add :

```js
// Auto-accept des demandes TP (et trade) UNIQUEMENT des gens de confiance, et seulement si
// la commande d'acceptation est cochée dans la whitelist (synergie avec la config commandes).
bot.on('messagestr', (msg) => {
  const tpWho = parseTpRequest(msg);
  if (tpWho && isTrusted(tpWho, policy.trusted) && isAllowed('/tpaccept', whitelist)) {
    bot.chat('/tpaccept'); emit({ type: 'command', command: '/tpaccept', reason: 'tp:' + tpWho });
    return;
  }
  if (policy.trade) {
    const trWho = parseTradeRequest(msg, policy.trade);
    if (trWho && isTrusted(trWho, policy.trusted) && isAllowed(policy.trade.acceptCmd, whitelist)) {
      bot.chat(policy.trade.acceptCmd); emit({ type: 'command', command: policy.trade.acceptCmd, reason: 'trade:' + trWho });
    }
  }
});
```

- [ ] **Step 5: Valider**

Run: `cd "<worktree>/mc-agent" && node --check index.js && node --test`
Expected: `node --check` sans erreur ; suite verte.

- [ ] **Step 6: Commit**

```bash
git add mc-agent/index.js
git commit -m "feat(mc-agent): index gate les ordres (non-trusted) + auto-accept TP/trade des gens de confiance"
```

---

## Task 4: Backend store — trusted + trade + resolve_policy

**Files:**
- Modify: `backend/bots/mc_agent_servers.py`
- Modify: `backend/bots/tests/test_mc_agent_servers.py`

- [ ] **Step 1: Écrire les tests (échouent)**

Append to `backend/bots/tests/test_mc_agent_servers.py` :

```python
def test_create_sanitises_trusted(tmp_store):
    s = ss.create_server({"name": "X", "trusted": ["Massii_08", " massii_08 ", "Pote2", 42, ""]})
    # dédup insensible à la casse + trim + drop non-string/vide
    assert s["trusted"] == ["Massii_08", "Pote2"]


def test_create_trade_valid_and_invalid(tmp_store):
    ok = ss.create_server({"name": "X", "trade": {"acceptCmd": "/trade accept", "requestPattern": "x"}})
    assert ok["trade"]["acceptCmd"] == "/trade accept"
    no = ss.create_server({"name": "Y", "trade": {"requestPattern": "x"}})  # pas d'acceptCmd
    assert no["trade"] is None
    no2 = ss.create_server({"name": "Z"})  # trade absent
    assert no2["trade"] is None


def test_resolve_policy(tmp_store):
    s = ss.create_server({"name": "X", "trusted": ["Bob"], "trade": {"acceptCmd": "/t accept"}})
    pol = ss.resolve_policy(s)
    assert pol["trusted"] == ["Bob"]
    assert pol["trade"]["acceptCmd"] == "/t accept"


def test_resolve_policy_empty(tmp_store):
    s = ss.create_server({"name": "X"})
    pol = ss.resolve_policy(s)
    assert pol == {"trusted": [], "trade": None}
```

- [ ] **Step 2: Lancer → échec**

Run: `cd "<worktree>" && "<venv>/bin/python" -m pytest backend/bots/tests/test_mc_agent_servers.py -q`
Expected: FAIL (`trusted`/`trade` absents, pas de `resolve_policy`).

- [ ] **Step 3: Modifier `backend/bots/mc_agent_servers.py`**

After the `_clean_custom` function, add :

```python
def _clean_trusted(raw):
    """Liste de pseudos de confiance : strings trim, dédup insensible casse, cap 50/32 car."""
    out, seen = [], set()
    for u in raw or []:
        if not isinstance(u, str):
            continue
        name = u.strip()[:32]
        key = name.lower()
        if name and key not in seen:
            seen.add(key)
            out.append(name)
        if len(out) >= 50:
            break
    return out


def _clean_trade(raw):
    """Config trade optionnelle : {acceptCmd, requestPattern} ; None si pas d'acceptCmd."""
    if not isinstance(raw, dict):
        return None
    accept = raw.get("acceptCmd")
    if not isinstance(accept, str) or not accept.strip():
        return None
    return {"acceptCmd": accept.strip()[:60], "requestPattern": str(raw.get("requestPattern") or "")[:200]}
```

In `_clean_server`, change the returned dict to add `trusted` and `trade` (after the `"custom"` line) :

```python
    return {
        "id": sid,
        "name": str(payload.get("name") or "Sans nom")[:60],
        "host": str(payload.get("host") or "")[:120],
        "port": port,
        "user": str(payload.get("user") or "TrainBot")[:48],
        "auth": auth,
        "intelligence": intelligence,
        "commands": commands,
        "custom": _clean_custom(payload.get("custom")),
        "trusted": _clean_trusted(payload.get("trusted")),
        "trade": _clean_trade(payload.get("trade")),
    }
```

At the end of the file, add :

```python
def resolve_policy(server):
    """Profil → policy {trusted, trade} pour le bot (gating ordres + auto-accept TP/trade)."""
    return {"trusted": server.get("trusted", []), "trade": server.get("trade")}
```

- [ ] **Step 4: Lancer → PASS**

Run: `cd "<worktree>" && "<venv>/bin/python" -m pytest backend/bots/tests/test_mc_agent_servers.py -q`

- [ ] **Step 5: Commit**

```bash
git add backend/bots/mc_agent_servers.py backend/bots/tests/test_mc_agent_servers.py
git commit -m "feat(mc-agent): profil serveur — liste trusted + config trade + resolve_policy"
```

---

## Task 5: `start_session` passe la policy au bot

**Files:**
- Modify: `backend/bots/mc_agent_manager.py`
- Modify: `backend/bots/tests/test_mc_agent_manager.py`

- [ ] **Step 1: Écrire le test (échoue)**

Append to `backend/bots/tests/test_mc_agent_manager.py` :

```python
def test_start_session_writes_policy_file(monkeypatch, tmp_path):
    from backend.bots import mc_agent_manager as mgr

    class FakeProc:
        def __init__(self):
            self.stdin = io.StringIO()
            self.stdout = iter(())
            self.pid = 4322

        def poll(self):
            return None

    captured = {}

    def fake_popen(cmd, **kw):
        captured["cmd"] = cmd
        return FakeProc()

    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(mgr.subprocess, "Popen", fake_popen)
    sid = mgr.start_session("h", 25565, "U",
                            policy={"trusted": ["Bob"], "trade": None})
    assert "--policy" in captured["cmd"]
    path = captured["cmd"][captured["cmd"].index("--policy") + 1]
    data = _json.loads(open(path).read())
    assert data["trusted"] == ["Bob"]
```

(`io` and `_json` are already imported by the file's earlier commands test.)

- [ ] **Step 2: Lancer → échec**

Run: `cd "<worktree>" && "<venv>/bin/python" -m pytest backend/bots/tests/test_mc_agent_manager.py::test_start_session_writes_policy_file -q`
Expected: FAIL (`start_session` n'a pas de `policy`).

- [ ] **Step 3: Modifier `backend/bots/mc_agent_manager.py`**

Change the `start_session` signature line to add `policy=None` :

```python
def start_session(host, port, user, model=None, auth="offline", profile=None, commands=None, policy=None):
```

Right after the existing `commands` block (the `if commands:` … `cmd += ["--commands", str(cmds_path)]`), add :

```python
    policy_path = None
    if policy:
        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        policy_path = RUNS_DIR / f"policy-{sid}.json"
        policy_path.write_text(json.dumps(policy), encoding="utf-8")
        cmd += ["--policy", str(policy_path)]
```

In the `session = { ... }` dict, add `policy_path` next to `cmds_path` :

```python
        "host": host, "user": user,
        "cmds_path": str(cmds_path) if cmds_path else None,
        "policy_path": str(policy_path) if policy_path else None,
```

In `stop_session`, where the `cmds_path` cleanup is, extend it to also remove the policy file. Replace the existing cleanup block :

```python
    cmds_path = s.get("cmds_path")
    if cmds_path:
        try:
            os.unlink(cmds_path)
        except OSError:
            pass
```
with :

```python
    for key in ("cmds_path", "policy_path"):
        p = s.get(key)
        if p:
            try:
                os.unlink(p)
            except OSError:
                pass
```

- [ ] **Step 4: Lancer le fichier complet → PASS**

Run: `cd "<worktree>" && "<venv>/bin/python" -m pytest backend/bots/tests/test_mc_agent_manager.py -q`

- [ ] **Step 5: Commit**

```bash
git add backend/bots/mc_agent_manager.py backend/bots/tests/test_mc_agent_manager.py
git commit -m "feat(mc-agent): start_session écrit la policy (--policy), nettoyée au stop"
```

---

## Task 6: Router — ServerPayload (trusted/trade) + /run passe la policy

**Files:**
- Modify: `backend/bots/mc_agent_router.py`
- Modify: `backend/bots/tests/test_mc_agent_router.py`

- [ ] **Step 1: Mettre à jour les fakes + ajouter les tests (échouent)**

In `backend/bots/tests/test_mc_agent_router.py`, the real `start_session` now takes a trailing `policy` arg. Update EVERY inner `fake_start` to accept it. Find each definition like :
```python
    def fake_start(host, port, user, model=None, auth="offline", profile=None, commands=None):
```
and change its signature to :
```python
    def fake_start(host, port, user, model=None, auth="offline", profile=None, commands=None, policy=None):
```
(there are 3 : in `test_run_demarre_une_session`, `test_run_transmet_le_profil`, `test_run_with_server_id_resolves_commands`).

Then append :

```python
def test_create_server_accepts_trusted_and_trade(monkeypatch):
    captured = {}
    monkeypatch.setattr(r.servers_store, "create_server", lambda payload: (captured.update(payload) or {"id": "ab12cd", **payload}))
    c = make_client()
    resp = c.post("/api/mc-agent/servers", json={"name": "X", "trusted": ["Bob"], "trade": {"acceptCmd": "/t accept"}})
    assert resp.status_code == 200
    assert captured["trusted"] == ["Bob"]
    assert captured["trade"]["acceptCmd"] == "/t accept"


def test_run_with_server_id_passes_policy(monkeypatch):
    monkeypatch.setattr(mgr, "has_api_key", lambda: True)
    monkeypatch.setattr(r.servers_store, "get_server", lambda sid: {
        "id": sid, "host": "play.x", "port": 25565, "user": "Bot",
        "auth": "offline", "intelligence": "expert", "commands": [], "custom": [],
        "trusted": ["Bob"], "trade": None})
    monkeypatch.setattr(r.servers_store, "resolve_commands", lambda srv: [])
    monkeypatch.setattr(r.servers_store, "resolve_policy", lambda srv: {"trusted": ["Bob"], "trade": None})
    captured = {}

    def fake_start(host, port, user, model=None, auth="offline", profile=None, commands=None, policy=None):
        captured["policy"] = policy
        return 11

    monkeypatch.setattr(mgr, "start_session", fake_start)
    c = make_client()
    resp = c.post("/api/mc-agent/run", json={"server_id": "abc"})
    assert resp.status_code == 200
    assert captured["policy"]["trusted"] == ["Bob"]
```

- [ ] **Step 2: Lancer → échec**

Run: `cd "<worktree>" && "<venv>/bin/python" -m pytest backend/bots/tests/test_mc_agent_router.py -q`
Expected: FAIL (ServerPayload ignore trusted/trade ; run ne passe pas policy).

- [ ] **Step 3: Modifier `backend/bots/mc_agent_router.py`**

First ensure `Optional` is imported (it already is: `from typing import Optional`).

Replace the WHOLE `ServerPayload` class with :

```python
class ServerPayload(BaseModel):
    name: str = "Sans nom"
    host: str = ""
    port: int = 25565
    user: str = "TrainBot"
    auth: str = "offline"
    intelligence: str = "intermediaire"
    commands: list = []
    custom: list = []
    trusted: list = []
    trade: Optional[dict] = None
```

In the `run` endpoint, inside the `if req.server_id:` block, after the `commands = servers_store.resolve_commands(srv)` line add :

```python
        policy = servers_store.resolve_policy(srv)
```

And initialize `policy` in the line that sets defaults. Replace :
```python
    auth, profile, commands = req.auth, req.profile, None
```
with :
```python
    auth, profile, commands, policy = req.auth, req.profile, None, None
```

Finally, change the `start_session` call to pass `policy` :
```python
        sid = mgr.start_session(host, port, user, req.model, auth, profile, commands, policy)
```

- [ ] **Step 4: Lancer toute la suite backend → PASS**

Run: `cd "<worktree>" && "<venv>/bin/python" -m pytest backend/bots/tests/ -q`
Expected: PASS (tous).

- [ ] **Step 5: Commit**

```bash
git add backend/bots/mc_agent_router.py backend/bots/tests/test_mc_agent_router.py
git commit -m "feat(mc-agent): ServerPayload trusted/trade + /run résout et passe la policy"
```

---

## Task 7: Frontend — éditeur (gens de confiance + trade + note clé) + i18n + cache

**Files:**
- Modify: `frontend/js/lang.js`, `frontend/js/bots_module.js`, `frontend/index.html`, `frontend/sw.js`

> Pas de TDD (pas de harness JS). Validation : parse-check + Chrome (Task 8). ⚠️ `bots_module.js` = indentation 1-espace.

- [ ] **Step 1: i18n — ajouter les clés dans `frontend/js/lang.js`**

Dans CHAQUE bloc langue, après la ligne `'mcagent.cfg.cat_status': …,` de cette langue, insérer le set correspondant.

**FR** (après `'mcagent.cfg.cat_status': 'Statut',`) :
```js
            'mcagent.cfg.trusted_title': 'Gens de confiance',
            'mcagent.cfg.trusted_hint': 'Seuls ces joueurs peuvent donner des ordres au bot (déplacement, minage, commandes) et voir leurs /tpa acceptés. Vide = tout le monde peut donner des ordres.',
            'mcagent.cfg.trusted_add': '+ Ajouter',
            'mcagent.cfg.trusted_ph': 'Pseudo Minecraft',
            'mcagent.cfg.trusted_empty': 'Personne — tout le monde peut donner des ordres.',
            'mcagent.cfg.trade_title': 'Trade (optionnel)',
            'mcagent.cfg.trade_hint': 'Si ton serveur a un plugin de trade : commande d\'acceptation + texte de la demande (regex, 1er groupe = le demandeur).',
            'mcagent.cfg.trade_cmd_ph': 'Commande d\'accept (ex: /trade accept)',
            'mcagent.cfg.trade_pattern_ph': 'Pattern de demande (ex: (\\w+) veut échanger)',
            'mcagent.cfg.key_shared_note': 'La clé LLM (Claude/Groq) est commune à tous les bots — réglée dans l\'onglet ▶ Lancer.',
```

**EN** (après `'mcagent.cfg.cat_status': 'Status',`) :
```js
            'mcagent.cfg.trusted_title': 'Trusted players',
            'mcagent.cfg.trusted_hint': 'Only these players can give the bot orders (move, mine, commands) and have their /tpa accepted. Empty = anyone can give orders.',
            'mcagent.cfg.trusted_add': '+ Add',
            'mcagent.cfg.trusted_ph': 'Minecraft username',
            'mcagent.cfg.trusted_empty': 'Nobody — anyone can give orders.',
            'mcagent.cfg.trade_title': 'Trade (optional)',
            'mcagent.cfg.trade_hint': 'If your server has a trade plugin: accept command + request text (regex, 1st group = requester).',
            'mcagent.cfg.trade_cmd_ph': 'Accept command (e.g. /trade accept)',
            'mcagent.cfg.trade_pattern_ph': 'Request pattern (e.g. (\\w+) wants to trade)',
            'mcagent.cfg.key_shared_note': 'The LLM key (Claude/Groq) is shared by all bots — set in the ▶ Launch tab.',
```

**IT** (après `'mcagent.cfg.cat_status': 'Stato',`) :
```js
            'mcagent.cfg.trusted_title': 'Persone di fiducia',
            'mcagent.cfg.trusted_hint': 'Solo questi giocatori possono dare ordini al bot (muoversi, minare, comandi) e farsi accettare i /tpa. Vuoto = chiunque può dare ordini.',
            'mcagent.cfg.trusted_add': '+ Aggiungi',
            'mcagent.cfg.trusted_ph': 'Username Minecraft',
            'mcagent.cfg.trusted_empty': 'Nessuno — chiunque può dare ordini.',
            'mcagent.cfg.trade_title': 'Trade (opzionale)',
            'mcagent.cfg.trade_hint': 'Se il tuo server ha un plugin di trade: comando di accettazione + testo della richiesta (regex, 1° gruppo = richiedente).',
            'mcagent.cfg.trade_cmd_ph': 'Comando accept (es. /trade accept)',
            'mcagent.cfg.trade_pattern_ph': 'Pattern richiesta (es. (\\w+) vuole scambiare)',
            'mcagent.cfg.key_shared_note': 'La chiave LLM (Claude/Groq) è comune a tutti i bot — impostata nella scheda ▶ Avvia.',
```

- [ ] **Step 2: `bots_module.js` — init trusted/trade dans newServerProfile + editServerProfile**

Replace `newServerProfile()` (single-space indent, ~line 1290) with :

```js
 newServerProfile() {
 this._mcaEditing = { id: null, name: '', host: '', port: 25565, user: 'TrainBot', auth: 'offline', intelligence: 'intermediaire', commands: [], custom: [], trusted: [], trade: { acceptCmd: '', requestPattern: '' } };
 this._renderServerEditor();
 },
```

Replace `editServerProfile(id)` with :

```js
 editServerProfile(id) {
 const s = (this._mcaServers || []).find((x) => x.id === id);
 if (!s) return;
 this._mcaEditing = JSON.parse(JSON.stringify(s));
 if (!Array.isArray(this._mcaEditing.custom)) this._mcaEditing.custom = [];
 if (!Array.isArray(this._mcaEditing.trusted)) this._mcaEditing.trusted = [];
 if (!this._mcaEditing.trade || typeof this._mcaEditing.trade !== 'object') this._mcaEditing.trade = { acceptCmd: '', requestPattern: '' };
 this._renderServerEditor();
 },
```

- [ ] **Step 3: `bots_module.js` — sections « Gens de confiance » + « Trade » + note clé dans `_renderServerEditor`**

In `_renderServerEditor`, build a trusted-chips fragment. Right after the `const customs = (e.custom || []).map(...)` block (before `box.innerHTML = ...`), add :

```js
 const trusted = (e.trusted || []).map((name, i) => `
 <span style="display:inline-flex;align-items:center;gap:4px;background:var(--bg-elev-3);border:1px solid var(--border);border-radius:999px;padding:2px 8px;margin:2px 6px 2px 0;font-size:12px;">
 <span style="font-family:var(--font-mono);">${this._escapeHtml(name)}</span>
 <button class="btn btn-ghost btn-sm" style="padding:0 4px;" onclick="BotsModule.removeTrustedPlayer(${i})">×</button>
 </span>`).join('');
 const trade = e.trade || { acceptCmd: '', requestPattern: '' };
```

Then in the `box.innerHTML = \`...\`` template, insert these three blocks **between** the custom-commands block (the `<div id="mca-e-customs">…</div>` + its add row) and the final save/cancel buttons row (`<div style="display:flex;gap:8px;margin-top:14px;">`). Insert :

```js
 <div style="font-weight:600;font-size:13px;margin:14px 0 4px;">${Lang.t('mcagent.cfg.trusted_title')}</div>
 <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">${Lang.t('mcagent.cfg.trusted_hint')}</div>
 <div id="mca-e-trusted">${trusted || `<span style="font-size:12px;color:var(--text-dim);">${Lang.t('mcagent.cfg.trusted_empty')}</span>`}</div>
 <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;">
 <input id="mca-e-trusted-add" class="form-input" placeholder="${Lang.t('mcagent.cfg.trusted_ph')}" style="flex:1;min-width:140px;" onkeydown="if(event.key==='Enter'){event.preventDefault();BotsModule.addTrustedPlayer();}" />
 <button class="btn btn-secondary btn-sm" onclick="BotsModule.addTrustedPlayer()">${Lang.t('mcagent.cfg.trusted_add')}</button>
 </div>
 <div style="font-weight:600;font-size:13px;margin:14px 0 4px;">${Lang.t('mcagent.cfg.trade_title')}</div>
 <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">${Lang.t('mcagent.cfg.trade_hint')}</div>
 <div style="display:flex;gap:6px;flex-wrap:wrap;">
 <input id="mca-e-trade-cmd" class="form-input" value="${this._escapeHtml(trade.acceptCmd || '')}" placeholder="${Lang.t('mcagent.cfg.trade_cmd_ph')}" style="max-width:200px;" />
 <input id="mca-e-trade-pat" class="form-input" value="${this._escapeHtml(trade.requestPattern || '')}" placeholder="${Lang.t('mcagent.cfg.trade_pattern_ph')}" style="flex:1;min-width:160px;" />
 </div>
 <div style="font-size:11px;color:var(--text-dim);margin-top:14px;padding-top:10px;border-top:1px solid var(--border);">${Lang.t('mcagent.cfg.key_shared_note')}</div>
```

- [ ] **Step 4: `bots_module.js` — capture trade + méthodes add/remove trusted**

In `_captureEditorState`, add (before the closing `}` of the method, after the `e.commands = …` line) :

```js
 const tc = document.getElementById('mca-e-trade-cmd');
 const tp = document.getElementById('mca-e-trade-pat');
 if (tc || tp) e.trade = { acceptCmd: tc ? tc.value.trim() : '', requestPattern: tp ? tp.value.trim() : '' };
```

After `removeCustomCommand(i)`, add two methods :

```js
 addTrustedPlayer() {
 const inp = document.getElementById('mca-e-trusted-add');
 const name = (inp && inp.value || '').trim();
 if (!name) return;
 this._captureEditorState();
 this._mcaEditing.trusted = this._mcaEditing.trusted || [];
 if (!this._mcaEditing.trusted.some((t) => t.toLowerCase() === name.toLowerCase())) this._mcaEditing.trusted.push(name);
 this._renderServerEditor();
 },

 removeTrustedPlayer(i) {
 this._captureEditorState();
 this._mcaEditing.trusted.splice(i, 1);
 this._renderServerEditor();
 },
```

- [ ] **Step 5: `bots_module.js` — inclure trusted/trade dans saveServerProfile**

Replace the `payload` line in `saveServerProfile` :
```js
 const payload = { name: e.name || 'Sans nom', host: e.host || '', port: e.port || 25565, user: e.user || 'TrainBot', auth: e.auth || 'offline', intelligence: e.intelligence || 'intermediaire', commands: e.commands || [], custom: e.custom || [] };
```
with :
```js
 const trade = (e.trade && (e.trade.acceptCmd || '').trim()) ? { acceptCmd: e.trade.acceptCmd.trim(), requestPattern: (e.trade.requestPattern || '').trim() } : null;
 const payload = { name: e.name || 'Sans nom', host: e.host || '', port: e.port || 25565, user: e.user || 'TrainBot', auth: e.auth || 'offline', intelligence: e.intelligence || 'intermediaire', commands: e.commands || [], custom: e.custom || [], trusted: e.trusted || [], trade };
```

- [ ] **Step 6: Parse-check (piège #28)**

Run: `cd "<worktree>" && node -e "new Function(require('fs').readFileSync('frontend/js/bots_module.js','utf8'))" && echo BOTS_OK && node -e "new Function(require('fs').readFileSync('frontend/js/lang.js','utf8'))" && echo LANG_OK`
Expected: `BOTS_OK` + `LANG_OK`.

- [ ] **Step 7: Cache-bust**

In `frontend/index.html` : `/js/lang.js?v=201` → `?v=202` ET `/js/bots_module.js?v=201` → `?v=202`.
In `frontend/sw.js` : `const CACHE_NAME = 'omenserver-v86';` → `'omenserver-v87';`.

- [ ] **Step 8: Commit**

```bash
git add frontend/js/lang.js frontend/js/bots_module.js frontend/index.html frontend/sw.js
git commit -m "feat(mc-agent): UI gens de confiance + trade (optionnel) + note clé commune + i18n + cache-bust"
```

---

## Task 8: Vérif finale + CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Suite Python complète**

Run: `cd "<worktree>" && "<venv>/bin/python" -m pytest backend/bots/tests/ -q`
Expected: PASS.

- [ ] **Step 2: Suite Node complète**

Run: `cd "<worktree>/mc-agent" && node --test`
Expected: PASS (trust + brain_trust + tout le reste).

- [ ] **Step 3: Vérif UI réelle (Chrome, après déploiement)** — via Chrome MCP, en admin, sur la prod après merge/auto-deploy :
1. ⚙ Serveurs → éditer/créer un profil → section **« Gens de confiance »** : ajouter un pseudo (chip + ×), état vide visible.
2. Section **« Trade (optionnel) »** : 2 champs ; **note « clé commune »** affichée en bas.
3. Enregistrer → recharger l'éditeur → trusted + trade persistés.
4. Switch FR/EN/IT : libellés traduits.
5. Console sans erreur.

- [ ] **Step 4: `CLAUDE.md`** — ajouter une ligne en tête du tableau `## 📝 Historique récent` :

```markdown
| 2026-06-01 | 🤝 **MC Agent — gens de confiance** : liste par profil serveur qui gate les ORDRES (action/command du LLM retirés si l'émetteur n'est pas listé ; questions répondues à tous) + **auto-accept /tpa** des gens de confiance (Essentials, gated par `/tpaccept` coché) + **trade** opt-in (pattern+commande configurables). Liste vide = gating off. Garde-fou double (prompt `buildTrustDocs` + `gateDecision` dur dans `index.js`). Module pur `mc-agent/trust.js`. Policy `{trusted,trade}` résolue backend → `--policy`. Note UI « clé LLM commune à tous les bots ». Tests Node + Python verts. |
```

Add a new entry at the end of `## ⚠️ Pièges connus` :

```markdown
39. **MC Agent gens de confiance — gating ordres + auto-accept TP** : la liste `trusted` (par profil serveur) gate UNIQUEMENT les ordres = `decision.action` OU `decision.command` du LLM (`gateDecision` dans `index.js` les met à `null` si l'émetteur n'est pas trusted) ; le `reply` (réponse à une question) passe toujours → tout le monde peut DISCUTER, seuls les gens de confiance commandent. **Liste vide ⇒ gating OFF** (rétro-compat : tout le monde commande). Double garde-fou : prompt (`buildTrustDocs` injecté + `De: <sender>` dans le message) ET suppression dure. **Auto-accept /tpa** via `bot.on('messagestr')` + `parseTpRequest` (patterns Essentials EN/FR ancrés `^\w` → le chat joueur `<X> …` ne matche jamais) ; n'envoie `/tpaccept` que si (a) demandeur trusted ET (b) `/tpaccept` **coché** dans la whitelist commandes (synergie #38). Non-trusted /tpa = **ignoré** (pas de /tpdeny). **Trade** = opt-in (Essentials n'a pas de trade natif) : `{acceptCmd, requestPattern}` par profil. Policy passée au bot via `--policy <file>` (`data/mc_agent_runs/policy-<sid>.json`, nettoyé au stop). ⚠️ formats Essentials localisés : si la traduction FR du serveur diffère, le TP auto ne se déclenche pas (échec silencieux, jamais de crash) → fournir la ligne exacte.
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(mc-agent): historique + piège #39 (gens de confiance, gating ordres + TP)"
```

---

## Notes d'implémentation
- **Worktree isolé** (pattern MC Agent). Inclure spec + plan.
- **Aucune nouvelle dépendance** (Node stdlib + Python stdlib) → auto-deploy suffit.
- **Python 3.9** (piège #1) ; cache (#11) ; `buildSystemPrompt(null) === SYSTEM_PROMPT` (#38).
- Remplacer `<worktree>` par le chemin réel et `<venv>` par `<racine projet>/venv`.
