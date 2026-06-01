# MC Agent — Profils serveur + commandes disponibles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter un onglet « Serveurs » au MC Agent : des profils de serveur réutilisables (connexion + intelligence + commandes cochées) qui donnent au bot la **capacité** d'utiliser les commandes disponibles et le **bloquent** sur les autres.

**Architecture:** Catalogue de commandes prédéfini (JSON livré dans `mc-agent/`) + custom, stockés dans des profils serveur (`data/mc_agent_servers.json`, backend stdlib). Au lancement, le backend résout la whitelist effective et la passe au subprocess Node via `--commands <file>`. Le bot l'injecte dans le system prompt du LLM (`brain.js`) + un module pur `commands.js` filtre toute commande non whitelistée en sortie (double sécurité). UI : mini 2-onglets dans la carte MC Agent.

**Tech Stack:** Python FastAPI (backend, stdlib JSON), Node.js (mineflayer bot, `node:test`), Vanilla JS/CSS (frontend), i18n FR/EN/IT.

**Spec:** `docs/superpowers/specs/2026-06-01-mc-agent-server-commands-config-design.md`

---

## File Structure

**Créés :**
- `mc-agent/commands-catalog.json` — catalogue prédéfini (source unique, lu par le backend).
- `mc-agent/commands.js` — logique pure : charger whitelist, garde-fou `isAllowed`, doc prompt.
- `mc-agent/test/commands.test.js` — tests Node de `commands.js`.
- `mc-agent/test/brain_command.test.js` — tests du champ `command` + injection commandes.
- `backend/bots/mc_agent_servers.py` — store des profils serveur + lecture catalogue + résolution.
- `backend/bots/tests/test_mc_agent_servers.py` — tests Python du store.

**Modifiés :**
- `mc-agent/brain.js` — `parseDecision` champ `command` ; `buildSystemPrompt(profile, commandDocs)` ; `think` passe `commandDocs`.
- `mc-agent/test/brain_parse.test.js` — 1 test à mettre à jour (objet attendu gagne `command:null`).
- `mc-agent/index.js` — lit `--commands`, branche la whitelist (garde-fou + exécution `command`).
- `backend/bots/mc_agent_manager.py` — `start_session(..., commands=None)` écrit le fichier temp + `--commands` ; `stop_session` nettoie.
- `backend/bots/mc_agent_router.py` — endpoints catalogue + CRUD profils + `/run` étendu (`server_id`).
- `backend/bots/tests/test_mc_agent_router.py` — nouveaux tests + maj du fake `start_session`.
- `backend/bots/tests/test_mc_agent_manager.py` — test écriture fichier commandes.
- `frontend/js/bots_module.js` — 2-onglets, CRUD profils serveur, sélecteur au lancement.
- `frontend/js/lang.js` — clés `mcagent.cfg.*` (FR/EN/IT).
- `frontend/index.html` — bump `?v=` de `lang.js` + `bots_module.js`.
- `frontend/sw.js` — bump `CACHE_NAME`.

**Commande de test Node :** `cd mc-agent && node --test`
**Commande de test Python :** depuis la racine projet, `python -m pytest backend/bots/tests/ -q` (venv activé).

---

## Task 1: Catalogue de commandes + module pur `commands.js` (bot)

**Files:**
- Create: `mc-agent/commands-catalog.json`
- Create: `mc-agent/commands.js`
- Test: `mc-agent/test/commands.test.js`

- [ ] **Step 1: Créer le catalogue de commandes**

Create `mc-agent/commands-catalog.json` :

```json
[
  { "id": "msg", "cmd": "/msg", "syntax": "/msg <joueur> <message>", "desc": "Envoie un message privé", "category": "communication" },
  { "id": "r", "cmd": "/r", "syntax": "/r <message>", "desc": "Répond au dernier message privé", "category": "communication" },
  { "id": "me", "cmd": "/me", "syntax": "/me <action>", "desc": "Décrit une action à la 3e personne", "category": "communication" },
  { "id": "mail", "cmd": "/mail", "syntax": "/mail send <joueur> <message>", "desc": "Envoie un courrier hors-ligne", "category": "communication" },
  { "id": "tpa", "cmd": "/tpa", "syntax": "/tpa <joueur>", "desc": "Demande à se téléporter vers un joueur", "category": "teleport" },
  { "id": "tpahere", "cmd": "/tpahere", "syntax": "/tpahere <joueur>", "desc": "Demande à un joueur de venir à toi", "category": "teleport" },
  { "id": "tpaccept", "cmd": "/tpaccept", "syntax": "/tpaccept", "desc": "Accepte une demande de téléportation", "category": "teleport" },
  { "id": "tpdeny", "cmd": "/tpdeny", "syntax": "/tpdeny", "desc": "Refuse une demande de téléportation", "category": "teleport" },
  { "id": "home", "cmd": "/home", "syntax": "/home [nom]", "desc": "Téléporte à un point d'attache", "category": "teleport" },
  { "id": "sethome", "cmd": "/sethome", "syntax": "/sethome [nom]", "desc": "Définit un point d'attache", "category": "teleport" },
  { "id": "spawn", "cmd": "/spawn", "syntax": "/spawn", "desc": "Téléporte au spawn", "category": "teleport" },
  { "id": "warp", "cmd": "/warp", "syntax": "/warp <nom>", "desc": "Téléporte à un warp public", "category": "teleport" },
  { "id": "back", "cmd": "/back", "syntax": "/back", "desc": "Retourne à la position précédente", "category": "teleport" },
  { "id": "rtp", "cmd": "/rtp", "syntax": "/rtp", "desc": "Téléportation aléatoire", "category": "teleport" },
  { "id": "pay", "cmd": "/pay", "syntax": "/pay <joueur> <montant>", "desc": "Donne de l'argent à un joueur", "category": "economy" },
  { "id": "balance", "cmd": "/balance", "syntax": "/balance", "desc": "Affiche ton solde", "category": "economy" },
  { "id": "afk", "cmd": "/afk", "syntax": "/afk", "desc": "Passe en absent", "category": "status" },
  { "id": "list", "cmd": "/list", "syntax": "/list", "desc": "Liste les joueurs connectés", "category": "status" },
  { "id": "seen", "cmd": "/seen", "syntax": "/seen <joueur>", "desc": "Dernière connexion d'un joueur", "category": "status" }
]
```

- [ ] **Step 2: Écrire les tests de `commands.js` (échouent)**

Create `mc-agent/test/commands.test.js` :

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadCommands, commandName, isAllowed, buildCommandDocs } = require('../commands');

const WL = [
  { cmd: '/msg', syntax: '/msg <j> <m>', desc: 'mp' },
  { cmd: '/home', syntax: '/home [nom]', desc: 'maison' },
];

test('isAllowed: chat normal (sans /) toujours autorisé', () => {
  assert.strictEqual(isAllowed('salut ça va', WL), true);
  assert.strictEqual(isAllowed('', WL), true);
});

test('isAllowed: commande whitelistée autorisée (insensible casse/espaces)', () => {
  assert.strictEqual(isAllowed('/home', WL), true);
  assert.strictEqual(isAllowed('/HOME nom', WL), true);
  assert.strictEqual(isAllowed('  /msg Bob hello', WL), true);
});

test('isAllowed: commande absente bloquée', () => {
  assert.strictEqual(isAllowed('/tpa Bob', WL), false);
  assert.strictEqual(isAllowed('/op Bob', WL), false);
});

test('isAllowed: whitelist vide bloque toute commande mais laisse le chat', () => {
  assert.strictEqual(isAllowed('/home', []), false);
  assert.strictEqual(isAllowed('bonjour', []), true);
});

test('commandName extrait le nom normalisé', () => {
  assert.strictEqual(commandName('/TPA Bob'), 'tpa');
  assert.strictEqual(commandName('pas une commande'), '');
});

test('buildCommandDocs liste cmd + syntaxe + mentionne le champ command, vide si []', () => {
  const doc = buildCommandDocs(WL);
  assert.match(doc, /\/msg <j> <m>/);
  assert.match(doc, /\/home \[nom\]/);
  assert.match(doc, /command/);
  assert.strictEqual(buildCommandDocs([]), '');
});

test('loadCommands: fichier absent ou chemin vide → []', () => {
  assert.deepStrictEqual(loadCommands('/no/such/file.json'), []);
  assert.deepStrictEqual(loadCommands(''), []);
});

test('loadCommands: lit un fichier JSON valide', () => {
  const f = path.join(os.tmpdir(), 'mca-cmds-test-' + process.pid + '.json');
  fs.writeFileSync(f, JSON.stringify(WL));
  try {
    const got = loadCommands(f);
    assert.strictEqual(got.length, 2);
    assert.strictEqual(got[0].cmd, '/msg');
  } finally { fs.unlinkSync(f); }
});
```

- [ ] **Step 3: Lancer les tests → échec attendu**

Run: `cd mc-agent && node --test test/commands.test.js`
Expected: FAIL (`Cannot find module '../commands'`).

- [ ] **Step 4: Écrire `commands.js`**

Create `mc-agent/commands.js` :

```js
'use strict';
// Garde-fou des commandes serveur (logique pure, testable sans client MC, cf. piège #35).
// La whitelist = liste d'objets {cmd, syntax, desc} écrite par le backend au lancement
// (fichier passé via --commands). Le bot ne tape une commande que si elle y figure.
const fs = require('fs');

/** Charge la whitelist depuis un fichier JSON. Chemin vide / fichier illisible → []. */
function loadCommands(filePath) {
  if (!filePath) return [];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(data) ? data.filter((c) => c && typeof c.cmd === 'string') : [];
  } catch (e) {
    return [];
  }
}

/** Nom de commande normalisé : '/TPA Bob' → 'tpa'. '' si le texte n'est pas une commande. */
function commandName(text) {
  const s = String(text || '').trim();
  if (!s.startsWith('/')) return '';
  return (s.slice(1).split(/\s+/)[0] || '').toLowerCase();
}

/**
 * Texte sortant autorisé ?
 *  - chat normal (ne commence pas par '/') → toujours true.
 *  - commande '/x ...' → true ssi 'x' ∈ whitelist.
 */
function isAllowed(text, whitelist) {
  const name = commandName(text);
  if (!name) return true;
  const set = new Set((whitelist || []).map((c) => commandName(c.cmd)));
  return set.has(name);
}

/** Bloc texte pour le system prompt : commandes dispo + syntaxe. '' si whitelist vide. */
function buildCommandDocs(whitelist) {
  const list = (whitelist || []).filter((c) => c && c.cmd);
  if (!list.length) return '';
  const lines = list.map((c) => `${c.syntax || c.cmd}${c.desc ? ' — ' + c.desc : ''}`);
  return 'Commandes serveur disponibles (utilise UNIQUEMENT celles-ci, jamais d\'autre commande ; '
    + 'mets la commande choisie dans le champ "command") : ' + lines.join(' ; ') + '.';
}

module.exports = { loadCommands, commandName, isAllowed, buildCommandDocs };
```

- [ ] **Step 5: Lancer les tests → succès attendu**

Run: `cd mc-agent && node --test test/commands.test.js`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add mc-agent/commands-catalog.json mc-agent/commands.js mc-agent/test/commands.test.js
git commit -m "feat(mc-agent): catalogue de commandes serveur + garde-fou commands.js"
```

---

## Task 2: `brain.js` — champ `command` + injection des commandes

**Files:**
- Modify: `mc-agent/brain.js`
- Modify: `mc-agent/test/brain_parse.test.js` (1 test)
- Test: `mc-agent/test/brain_command.test.js`

- [ ] **Step 1: Écrire les tests du champ `command` (échouent)**

Create `mc-agent/test/brain_command.test.js` :

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseDecision, buildSystemPrompt, SYSTEM_PROMPT } = require('../brain');

test('parseDecision extrait le champ command (string) sinon null', () => {
  assert.strictEqual(parseDecision('{"reply":"ok","command":"/home"}').command, '/home');
  assert.strictEqual(parseDecision('{"reply":"ok"}').command, null);
  assert.strictEqual(parseDecision('{"reply":"ok","command":123}').command, null);
});

test('buildSystemPrompt(null) sans commandDocs reste EXACTEMENT SYSTEM_PROMPT', () => {
  assert.strictEqual(buildSystemPrompt(null), SYSTEM_PROMPT);
  assert.strictEqual(buildSystemPrompt(null, ''), SYSTEM_PROMPT);
});

test('buildSystemPrompt injecte le bloc commandes quand fourni (avec ou sans profil)', () => {
  const docs = 'Commandes serveur disponibles : /home [nom].';
  assert.match(buildSystemPrompt(null, docs), /\/home \[nom\]/);
  assert.match(buildSystemPrompt({ persona: 'X' }, docs), /\/home \[nom\]/);
});
```

- [ ] **Step 2: Mettre à jour le test `parseDecision` existant**

In `mc-agent/test/brain_parse.test.js`, replace the first test body so the expected object includes `command: null` :

```js
test('parseDecision lit du JSON simple', () => {
  const d = parseDecision('{"reply":"salut","action":"follow","args":{"player":"Massii"}}');
  assert.deepStrictEqual(d, { reply: 'salut', action: 'follow', args: { player: 'Massii' }, command: null });
});
```

- [ ] **Step 3: Lancer les tests → échec attendu**

Run: `cd mc-agent && node --test test/brain_command.test.js test/brain_parse.test.js`
Expected: FAIL (`command` undefined ; `buildSystemPrompt` n'accepte pas 2 args / pas d'injection).

- [ ] **Step 4: Modifier `brain.js`**

In `mc-agent/brain.js`, in `parseDecision`, add the `command` field to the returned object :

```js
  return {
    reply: typeof obj.reply === 'string' ? obj.reply : '',
    action: typeof obj.action === 'string' ? obj.action : null,
    args: (obj.args && typeof obj.args === 'object') ? obj.args : {},
    command: typeof obj.command === 'string' ? obj.command : null,
  };
```

Replace the whole `buildSystemPrompt` function with :

```js
/** Construit le system prompt : persona du profil (réalisme §7.1) + commandes serveur dispo. */
function buildSystemPrompt(profile, commandDocs = '') {
  const base = profile
    ? [
        "Tu incarnes un joueur dans une partie Minecraft (cadre d'entrainement de moderation).",
        profile.persona || '',
        'Reponds UNIQUEMENT en JSON : {"reply": string, "action": string|null, "args": object, "command": string|null}.',
        ACTIONS_DOC,
      ]
    : [SYSTEM_PROMPT];
  if (commandDocs) base.push(commandDocs);
  return base.filter(Boolean).join(' ');
}
```

Replace the `think` signature/body to thread `commandDocs` :

```js
async function think(client, { state, message, model, limiter, profile = null, commandDocs = '' }) {
  if (limiter && !limiter.tryAcquire()) return null;
  const resp = await client.messages.create({
    model,
    max_tokens: 300,
    system: buildSystemPrompt(profile, commandDocs),
    messages: [{ role: 'user', content: `Etat: ${JSON.stringify(state)}\nMessage recu: ${message}` }],
  });
  const text = (resp.content || []).map((b) => b.text || '').join('');
  return parseDecision(text);
}
```

- [ ] **Step 5: Lancer toute la suite Node → succès attendu**

Run: `cd mc-agent && node --test`
Expected: PASS (tous les tests, dont `brain_think`/`brain_profile`/`brain_parse`/`brain_command` toujours verts — `buildSystemPrompt(null)` reste `=== SYSTEM_PROMPT`).

- [ ] **Step 6: Commit**

```bash
git add mc-agent/brain.js mc-agent/test/brain_command.test.js mc-agent/test/brain_parse.test.js
git commit -m "feat(mc-agent): décision LLM gagne un champ command + commandes dans le system prompt"
```

---

## Task 3: `index.js` — brancher la whitelist (garde-fou + exécution)

**Files:**
- Modify: `mc-agent/index.js`

> Pas de test unitaire : `index.js` crée un bot mineflayer au require (connexion réseau). La logique est dans `commands.js` (testée Task 1). On valide ici par `node --check` (parse) + `node --test` (régression suite).

- [ ] **Step 1: Importer `commands.js`**

In `mc-agent/index.js`, after the line `const { decideReaction } = require('./triggers');`, add :

```js
const { loadCommands, isAllowed, buildCommandDocs } = require('./commands');
```

- [ ] **Step 2: Charger la whitelist au démarrage**

In `mc-agent/index.js`, just after the profile loading block (the `try { profile = loadProfile(...) } catch ...`), add :

```js
// Commandes serveur autorisées (fichier JSON écrit par le backend, passé via --commands).
const whitelist = loadCommands(args.commands);
const commandDocs = buildCommandDocs(whitelist); // bloc injecté dans le system prompt LLM
```

- [ ] **Step 3: Garde-fou sur les réponses + passage de `commandDocs`**

In `mc-agent/index.js`, replace `replyTo` with a guarded version :

```js
function replyTo(reaction, text) {
  if (!isAllowed(text, whitelist)) { emit({ type: 'blocked_command', command: text }); return; }
  if (reaction.private) bot.whisper(reaction.to, text); // réponse en privé (/tell)
  else say(bot, text);                                  // réponse en public
}
```

In `handleIncoming`, change the `think(...)` call to pass `commandDocs` :

```js
    const decision = await think(client, { state: snapshot(bot), message, model, limiter, profile, commandDocs });
```

- [ ] **Step 4: Exécuter la commande choisie par le LLM (whitelistée)**

In `mc-agent/index.js`, add a `runCommand` function right after `runAction` :

```js
// Exécute la commande serveur décidée par le LLM, UNIQUEMENT si elle est whitelistée.
function runCommand(decision) {
  const cmd = decision.command;
  if (!cmd) return;
  if (isAllowed(cmd, whitelist)) { bot.chat(String(cmd)); emit({ type: 'command', command: cmd }); }
  else { emit({ type: 'blocked_command', command: cmd }); }
}
```

In `handleIncoming`, after `await runAction(decision);`, add :

```js
    runCommand(decision);
```

- [ ] **Step 5: Valider le parse + la suite Node**

Run: `cd mc-agent && node --check index.js && node --test`
Expected: PASS (aucune SyntaxError ; suite verte).

- [ ] **Step 6: Commit**

```bash
git add mc-agent/index.js
git commit -m "feat(mc-agent): index branche la whitelist (garde-fou sortie + exécution command)"
```

---

## Task 4: Backend — store des profils serveur `mc_agent_servers.py`

**Files:**
- Create: `backend/bots/mc_agent_servers.py`
- Test: `backend/bots/tests/test_mc_agent_servers.py`

- [ ] **Step 1: Écrire les tests du store (échouent)**

Create `backend/bots/tests/test_mc_agent_servers.py` :

```python
"""Tests du store des profils serveur MC Agent."""
import json
import pytest

from backend.bots import mc_agent_servers as ss


@pytest.fixture
def tmp_store(tmp_path, monkeypatch):
    monkeypatch.setattr(ss, "SERVERS_PATH", tmp_path / "servers.json")
    catalog = [
        {"id": "msg", "cmd": "/msg", "syntax": "/msg <j> <m>", "desc": "mp", "category": "communication"},
        {"id": "home", "cmd": "/home", "syntax": "/home [n]", "desc": "h", "category": "teleport"},
    ]
    cat_path = tmp_path / "catalog.json"
    cat_path.write_text(json.dumps(catalog), encoding="utf-8")
    monkeypatch.setattr(ss, "CATALOG_PATH", cat_path)
    return tmp_path


def test_load_catalog(tmp_store):
    assert any(c["id"] == "msg" for c in ss.load_catalog())


def test_create_and_list(tmp_store):
    s = ss.create_server({"name": "Paper", "host": "h", "port": 25565, "commands": ["msg", "home"]})
    assert s["id"]
    servers = ss.load_servers()
    assert len(servers) == 1 and servers[0]["name"] == "Paper"


def test_create_filters_unknown_commands(tmp_store):
    s = ss.create_server({"name": "X", "commands": ["msg", "ghost", "home"]})
    assert s["commands"] == ["msg", "home"]


def test_create_defaults_invalid_intelligence_and_auth(tmp_store):
    s = ss.create_server({"name": "X", "intelligence": "genius", "auth": "hack"})
    assert s["intelligence"] == "intermediaire"
    assert s["auth"] == "offline"


def test_update_existing(tmp_store):
    s = ss.create_server({"name": "A"})
    out = ss.update_server(s["id"], {"name": "B", "commands": ["msg"]})
    assert out["name"] == "B" and out["commands"] == ["msg"]


def test_update_unknown_returns_none(tmp_store):
    assert ss.update_server("deadbeef", {"name": "X"}) is None


def test_update_rejects_bad_id(tmp_store):
    assert ss.update_server("../etc", {"name": "X"}) is None


def test_delete(tmp_store):
    s = ss.create_server({"name": "A"})
    assert ss.delete_server(s["id"]) is True
    assert ss.load_servers() == []


def test_delete_unknown(tmp_store):
    assert ss.delete_server("nope") is False


def test_custom_commands_sanitised(tmp_store):
    s = ss.create_server({"name": "X", "custom": [
        {"cmd": "/kit", "syntax": "/kit <n>", "desc": "kit"},
        {"cmd": "no-slash", "syntax": "x"},
        {"nope": 1},
    ]})
    assert len(s["custom"]) == 1 and s["custom"][0]["cmd"] == "/kit"


def test_resolve_commands(tmp_store):
    s = ss.create_server({"name": "X", "commands": ["home"],
                          "custom": [{"cmd": "/kit", "syntax": "/kit <n>", "desc": "k"}]})
    resolved = ss.resolve_commands(s)
    cmds = [c["cmd"] for c in resolved]
    assert "/home" in cmds and "/kit" in cmds
    assert all("syntax" in c for c in resolved)
```

- [ ] **Step 2: Lancer les tests → échec attendu**

Run: `python -m pytest backend/bots/tests/test_mc_agent_servers.py -q`
Expected: FAIL (`No module named 'backend.bots.mc_agent_servers'`).

- [ ] **Step 3: Écrire `mc_agent_servers.py`**

Create `backend/bots/mc_agent_servers.py` :

```python
"""
Profils serveur MC Agent : connexion + niveau d'intelligence + commandes disponibles.

Stdlib uniquement, persistance fichier JSON (pattern miroir de mc_agent_manager). Un profil
regroupe tout ce qu'il faut pour lancer le bot sur un serveur donné + la whitelist de commandes
que le serveur expose (le bot ne tapera que celles-là). Le catalogue prédéfini est livré dans
mc-agent/commands-catalog.json (source unique, lue aussi pour résoudre la whitelist effective).
"""
import json
import re
import secrets
from pathlib import Path

# backend/bots/mc_agent_servers.py → racine projet = parents[2]
_PROJECT_ROOT = Path(__file__).resolve().parents[2]
SERVERS_PATH = _PROJECT_ROOT / "data" / "mc_agent_servers.json"
CATALOG_PATH = _PROJECT_ROOT / "mc-agent" / "commands-catalog.json"

VALID_INTELLIGENCE = ("evident", "intermediaire", "expert")
VALID_AUTH = ("offline", "microsoft")
_SAFE_ID = re.compile(r"^[a-z0-9]+$")


def load_catalog():
    """Catalogue de commandes prédéfinies (source unique). [] si absent/illisible."""
    try:
        data = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return data if isinstance(data, list) else []


def _catalog_ids():
    return {c.get("id") for c in load_catalog() if isinstance(c, dict) and c.get("id")}


def load_servers():
    """Liste des profils serveur persistés. [] si fichier absent/illisible."""
    try:
        data = json.loads(SERVERS_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return data if isinstance(data, list) else []


def _save_servers(servers):
    SERVERS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SERVERS_PATH.write_text(json.dumps(servers, ensure_ascii=False, indent=2), encoding="utf-8")


def _gen_id(existing):
    """Id court [0-9a-f]{6}, unique dans `existing`."""
    for _ in range(50):
        cand = secrets.token_hex(3)
        if cand not in existing:
            return cand
    raise RuntimeError("id generation failed")


def _clean_custom(raw):
    """Garde les commandes custom valides (objet avec cmd commençant par /)."""
    out = []
    for c in raw or []:
        if isinstance(c, dict) and isinstance(c.get("cmd"), str) and c["cmd"].startswith("/"):
            out.append({
                "cmd": c["cmd"][:40],
                "syntax": str(c.get("syntax") or c["cmd"])[:80],
                "desc": str(c.get("desc") or "")[:160],
            })
    return out


def _clean_server(payload, sid):
    """Normalise/valide un payload de profil serveur (anti-injection, bornes, défauts sûrs)."""
    catalog_ids = _catalog_ids()
    commands = [c for c in (payload.get("commands") or []) if c in catalog_ids]
    intelligence = payload.get("intelligence")
    if intelligence not in VALID_INTELLIGENCE:
        intelligence = "intermediaire"
    auth = payload.get("auth")
    if auth not in VALID_AUTH:
        auth = "offline"
    try:
        port = int(payload.get("port") or 25565)
    except (TypeError, ValueError):
        port = 25565
    port = min(max(port, 1), 65535)
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
    }


def create_server(payload):
    servers = load_servers()
    sid = _gen_id({s.get("id") for s in servers})
    server = _clean_server(payload, sid)
    servers.append(server)
    _save_servers(servers)
    return server


def update_server(sid, payload):
    if not _SAFE_ID.match(str(sid or "")):
        return None
    servers = load_servers()
    for i, s in enumerate(servers):
        if s.get("id") == sid:
            servers[i] = _clean_server(payload, sid)
            _save_servers(servers)
            return servers[i]
    return None


def delete_server(sid):
    if not _SAFE_ID.match(str(sid or "")):
        return False
    servers = load_servers()
    kept = [s for s in servers if s.get("id") != sid]
    if len(kept) == len(servers):
        return False
    _save_servers(kept)
    return True


def get_server(sid):
    for s in load_servers():
        if s.get("id") == sid:
            return s
    return None


def resolve_commands(server):
    """Profil → liste d'objets {cmd,syntax,desc} pour le bot (catalogue coché + custom)."""
    by_id = {c["id"]: c for c in load_catalog() if isinstance(c, dict) and c.get("id")}
    out = []
    for cid in server.get("commands", []):
        c = by_id.get(cid)
        if c:
            out.append({"cmd": c["cmd"], "syntax": c.get("syntax", c["cmd"]), "desc": c.get("desc", "")})
    for c in server.get("custom", []):
        out.append({"cmd": c["cmd"], "syntax": c.get("syntax", c["cmd"]), "desc": c.get("desc", "")})
    return out
```

- [ ] **Step 4: Lancer les tests → succès attendu**

Run: `python -m pytest backend/bots/tests/test_mc_agent_servers.py -q`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/bots/mc_agent_servers.py backend/bots/tests/test_mc_agent_servers.py
git commit -m "feat(mc-agent): store des profils serveur + résolution des commandes (backend)"
```

---

## Task 5: Backend — `start_session` passe les commandes au subprocess

**Files:**
- Modify: `backend/bots/mc_agent_manager.py`
- Modify: `backend/bots/tests/test_mc_agent_manager.py`

- [ ] **Step 1: Écrire le test (échoue)**

Append to `backend/bots/tests/test_mc_agent_manager.py` :

```python
import io
import json as _json


def test_start_session_writes_commands_file(monkeypatch, tmp_path):
    from backend.bots import mc_agent_manager as mgr

    class FakeProc:
        def __init__(self):
            self.stdin = io.StringIO()
            self.stdout = iter(())
            self.pid = 4321

        def poll(self):
            return None

    captured = {}

    def fake_popen(cmd, **kw):
        captured["cmd"] = cmd
        return FakeProc()

    monkeypatch.setattr(mgr, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(mgr.subprocess, "Popen", fake_popen)
    sid = mgr.start_session("h", 25565, "U",
                            commands=[{"cmd": "/home", "syntax": "/home", "desc": "h"}])
    assert isinstance(sid, int)
    assert "--commands" in captured["cmd"]
    path = captured["cmd"][captured["cmd"].index("--commands") + 1]
    data = _json.loads(open(path).read())
    assert data[0]["cmd"] == "/home"
```

- [ ] **Step 2: Lancer le test → échec attendu**

Run: `python -m pytest backend/bots/tests/test_mc_agent_manager.py::test_start_session_writes_commands_file -q`
Expected: FAIL (`start_session` n'accepte pas `commands` / pas de `RUNS_DIR`).

- [ ] **Step 3: Modifier `mc_agent_manager.py`**

In `backend/bots/mc_agent_manager.py`, after the line `MC_AGENT_DIR = _PROJECT_ROOT / "mc-agent"`, add :

```python
# Fichiers temp de whitelist de commandes par session (dossier propre au bot, PAS data/servers/).
RUNS_DIR = _PROJECT_ROOT / "data" / "mc_agent_runs"
```

Replace the whole `start_session` function with :

```python
def start_session(host, port, user, model=None, auth="offline", profile=None, commands=None):
    """Spawn le process Node détaché et enregistre la session. Retourne son id.

    `commands` : liste d'objets {cmd,syntax,desc} (whitelist serveur). Écrite dans un fichier
    temp passé au bot via --commands (le bot ne tapera que ces commandes).
    """
    global _counter
    with _lock:
        _counter += 1
        sid = _counter
    cmd = [_node_bin(), str(MC_AGENT_DIR / "index.js"),
           "--host", str(host), "--port", str(port), "--user", str(user),
           "--auth", str(auth or "offline")]
    if model:
        cmd += ["--model", str(model)]
    if profile:
        cmd += ["--profile", str(profile)]
    cmds_path = None
    if commands:
        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        cmds_path = RUNS_DIR / f"cmds-{sid}.json"
        cmds_path.write_text(json.dumps(commands), encoding="utf-8")
        cmd += ["--commands", str(cmds_path)]
    env = dict(os.environ)
    api_key = _read_api_key()  # injecte la clé (fichier ou env) dans l'env du subprocess Node
    if api_key:
        env["ANTHROPIC_API_KEY"] = api_key
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
    session = {
        "id": sid, "proc": proc, "status": "starting",
        "transcript": [], "events": [], "last_error": None,
        "host": host, "user": user, "cmds_path": str(cmds_path) if cmds_path else None,
    }
    _sessions[sid] = session
    t = threading.Thread(target=_pump, args=(session, proc.stdout), daemon=True)
    t.start()
    session["thread"] = t
    return sid
```

In `stop_session`, after `s["status"] = "stopped"` and before `return True`, add cleanup :

```python
    cmds_path = s.get("cmds_path")
    if cmds_path:
        try:
            os.unlink(cmds_path)
        except OSError:
            pass
```

- [ ] **Step 4: Lancer le test → succès attendu**

Run: `python -m pytest backend/bots/tests/test_mc_agent_manager.py -q`
Expected: PASS (tous les tests du fichier).

- [ ] **Step 5: Commit**

```bash
git add backend/bots/mc_agent_manager.py backend/bots/tests/test_mc_agent_manager.py
git commit -m "feat(mc-agent): start_session écrit la whitelist + --commands, nettoyée au stop"
```

---

## Task 6: Backend — endpoints catalogue + CRUD profils + `/run` étendu

**Files:**
- Modify: `backend/bots/mc_agent_router.py`
- Modify: `backend/bots/tests/test_mc_agent_router.py`

- [ ] **Step 1: Écrire les nouveaux tests + maj du fake `start_session` (échouent)**

In `backend/bots/tests/test_mc_agent_router.py`, update the existing `test_run_demarre_une_session` fake to accept `commands` :

```python
    def fake_start(host, port, user, model=None, auth="offline", profile=None, commands=None):
        captured["auth"] = auth
        return 7
```

Then append these tests :

```python
def test_commands_catalog(monkeypatch):
    monkeypatch.setattr(r.servers_store, "load_catalog", lambda: [{"id": "msg", "cmd": "/msg"}])
    c = make_client()
    resp = c.get("/api/mc-agent/commands-catalog")
    assert resp.status_code == 200 and resp.json()["catalog"][0]["id"] == "msg"


def test_servers_endpoints_admin_only():
    c = make_client(is_admin=False)
    assert c.get("/api/mc-agent/servers").status_code == 403
    assert c.post("/api/mc-agent/servers", json={"name": "X"}).status_code == 403
    assert c.get("/api/mc-agent/commands-catalog").status_code == 403


def test_create_server(monkeypatch):
    monkeypatch.setattr(r.servers_store, "create_server", lambda payload: {"id": "ab12cd", **payload})
    c = make_client()
    resp = c.post("/api/mc-agent/servers", json={"name": "Paper", "commands": ["msg"]})
    assert resp.status_code == 200 and resp.json()["id"] == "ab12cd"


def test_list_servers(monkeypatch):
    monkeypatch.setattr(r.servers_store, "load_servers", lambda: [{"id": "x", "name": "A"}])
    c = make_client()
    resp = c.get("/api/mc-agent/servers")
    assert resp.status_code == 200 and resp.json()["servers"][0]["name"] == "A"


def test_update_server_404(monkeypatch):
    monkeypatch.setattr(r.servers_store, "update_server", lambda sid, payload: None)
    c = make_client()
    assert c.put("/api/mc-agent/servers/x", json={"name": "Y"}).status_code == 404


def test_delete_server_ok(monkeypatch):
    monkeypatch.setattr(r.servers_store, "delete_server", lambda sid: True)
    c = make_client()
    assert c.delete("/api/mc-agent/servers/abc").status_code == 200


def test_run_with_server_id_resolves_commands(monkeypatch):
    monkeypatch.setattr(mgr, "has_api_key", lambda: True)
    monkeypatch.setattr(r.servers_store, "get_server", lambda sid: {
        "id": sid, "host": "play.x", "port": 25570, "user": "Bot",
        "auth": "offline", "intelligence": "expert", "commands": ["home"], "custom": []})
    monkeypatch.setattr(r.servers_store, "resolve_commands",
                        lambda srv: [{"cmd": "/home", "syntax": "/home", "desc": "h"}])
    captured = {}

    def fake_start(host, port, user, model=None, auth="offline", profile=None, commands=None):
        captured.update(host=host, profile=profile, commands=commands)
        return 9

    monkeypatch.setattr(mgr, "start_session", fake_start)
    c = make_client()
    resp = c.post("/api/mc-agent/run", json={"server_id": "abc"})
    assert resp.status_code == 200 and resp.json()["session_id"] == 9
    assert captured["host"] == "play.x" and captured["profile"] == "expert"
    assert captured["commands"][0]["cmd"] == "/home"


def test_run_400_sans_host_ni_server_id(monkeypatch):
    monkeypatch.setattr(mgr, "has_api_key", lambda: True)
    c = make_client()
    assert c.post("/api/mc-agent/run", json={}).status_code == 400
```

- [ ] **Step 2: Lancer les tests → échec attendu**

Run: `python -m pytest backend/bots/tests/test_mc_agent_router.py -q`
Expected: FAIL (`r.servers_store` inexistant ; endpoints manquants).

- [ ] **Step 3: Modifier `mc_agent_router.py`**

In `backend/bots/mc_agent_router.py`, add the import after `from backend.bots import mc_agent_manager as mgr` :

```python
from backend.bots import mc_agent_servers as servers_store
```

Make `host` optional and add `server_id` in `StartReq` :

```python
class StartReq(BaseModel):
    host: str = ""                  # vide si on lance via server_id
    port: int = 25565
    user: str = "TrainBot"          # pseudo (offline) OU email du compte (microsoft)
    auth: str = "offline"           # "offline" | "microsoft"
    model: Optional[str] = None     # Python 3.9 : pas de `str | None` (piège #1)
    profile: Optional[str] = None   # id de profil de comportement (evident/intermediaire/expert)
    server_id: Optional[str] = None # si fourni : charge un profil serveur (connexion + commandes)
```

Add a `ServerPayload` model after `ApiKeyPayload` :

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
```

Replace the whole `run` endpoint with the `server_id`-aware version :

```python
@router.post("/run")
def run(req: StartReq, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    if not mgr.has_api_key():
        raise HTTPException(status_code=400, detail="Aucune cle Claude configuree (renseigne-la dans le bot)")
    host, port, user = req.host, req.port, req.user
    auth, profile, commands = req.auth, req.profile, None
    if req.server_id:
        srv = servers_store.get_server(req.server_id)
        if not srv:
            raise HTTPException(status_code=404, detail="Profil serveur introuvable")
        host, port, user = srv["host"], srv["port"], srv["user"]
        auth, profile = srv["auth"], srv["intelligence"]
        commands = servers_store.resolve_commands(srv)
    if not host:
        raise HTTPException(status_code=400, detail="host requis (ou choisis un profil serveur)")
    auth = auth if auth in ("offline", "microsoft") else "offline"
    try:
        sid = mgr.start_session(host, port, user, req.model, auth, profile, commands)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Impossible de demarrer Node : {exc}")
    return {"session_id": sid}
```

Add the new endpoints at the end of the file (after `stop`) :

```python
@router.get("/commands-catalog")
def commands_catalog(current_user: User = Depends(get_current_user)):
    """Catalogue de commandes prédéfinies pour la checklist (admin-only)."""
    _require_admin(current_user)
    return {"catalog": servers_store.load_catalog()}


@router.get("/servers")
def list_servers(current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    return {"servers": servers_store.load_servers()}


@router.post("/servers")
def create_server(payload: ServerPayload, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    return servers_store.create_server(payload.model_dump())


@router.put("/servers/{sid}")
def update_server(sid: str, payload: ServerPayload, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    s = servers_store.update_server(sid, payload.model_dump())
    if not s:
        raise HTTPException(status_code=404, detail="Profil introuvable")
    return s


@router.delete("/servers/{sid}")
def delete_server(sid: str, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    if not servers_store.delete_server(sid):
        raise HTTPException(status_code=404, detail="Profil introuvable")
    return {"ok": True}
```

- [ ] **Step 4: Lancer les tests → succès attendu**

Run: `python -m pytest backend/bots/tests/test_mc_agent_router.py -q`
Expected: PASS (anciens + nouveaux tests).

- [ ] **Step 5: Commit**

```bash
git add backend/bots/mc_agent_router.py backend/bots/tests/test_mc_agent_router.py
git commit -m "feat(mc-agent): endpoints catalogue + CRUD profils serveur + /run via server_id"
```

---

## Task 7: Frontend — i18n + onglets + CRUD profils + sélecteur lancement

**Files:**
- Modify: `frontend/js/lang.js`
- Modify: `frontend/js/bots_module.js`
- Modify: `frontend/index.html`
- Modify: `frontend/sw.js`

> Pas de TDD (pas de harness JS frontend dans le projet). Implémentation + vérification Chrome MCP (skill `verify-ui`).

- [ ] **Step 1: Ajouter les clés i18n `mcagent.cfg.*`**

In `frontend/js/lang.js`, in **each** language block (repère : la ligne `'mcagent.training':` de chaque langue), add the matching keys right after that language's `'mcagent.training'` line.

**FR** (après `'mcagent.training': 'Entrainement',`) :

```js
            'mcagent.cfg.tab_launch': '▶ Lancer',
            'mcagent.cfg.tab_servers': 'Serveurs',
            'mcagent.cfg.profile_select': 'Profil serveur',
            'mcagent.cfg.profile_manual': '— Manuel —',
            'mcagent.cfg.srv_new': '+ Nouveau profil',
            'mcagent.cfg.srv_edit': 'Éditer',
            'mcagent.cfg.srv_delete': 'Supprimer',
            'mcagent.cfg.srv_save': 'Enregistrer',
            'mcagent.cfg.srv_cancel': 'Annuler',
            'mcagent.cfg.srv_name': 'Nom du profil',
            'mcagent.cfg.srv_intelligence': 'Intelligence',
            'mcagent.cfg.srv_commands': 'Commandes disponibles sur ce serveur',
            'mcagent.cfg.srv_custom': 'Commandes personnalisees',
            'mcagent.cfg.srv_custom_add': '+ Ajouter',
            'mcagent.cfg.srv_empty': 'Aucun profil serveur. Cree-en un pour memoriser IP + commandes.',
            'mcagent.cfg.srv_cmd_count': 'cmd',
            'mcagent.cfg.srv_confirm_delete': 'Supprimer ce profil serveur ?',
            'mcagent.cfg.srv_save_err': 'Echec de l enregistrement',
            'mcagent.cfg.srv_delete_err': 'Echec de la suppression',
            'mcagent.cfg.custom_desc': 'Description courte',
            'mcagent.cfg.custom_need_slash': 'Une commande commence par /',
            'mcagent.cfg.cat_communication': 'Communication',
            'mcagent.cfg.cat_teleport': 'Teleportation',
            'mcagent.cfg.cat_economy': 'Economie',
            'mcagent.cfg.cat_status': 'Statut',
```

**EN** (après `'mcagent.training': ...,` du bloc anglais) :

```js
            'mcagent.cfg.tab_launch': '▶ Launch',
            'mcagent.cfg.tab_servers': 'Servers',
            'mcagent.cfg.profile_select': 'Server profile',
            'mcagent.cfg.profile_manual': '— Manual —',
            'mcagent.cfg.srv_new': '+ New profile',
            'mcagent.cfg.srv_edit': 'Edit',
            'mcagent.cfg.srv_delete': 'Delete',
            'mcagent.cfg.srv_save': 'Save',
            'mcagent.cfg.srv_cancel': 'Cancel',
            'mcagent.cfg.srv_name': 'Profile name',
            'mcagent.cfg.srv_intelligence': 'Intelligence',
            'mcagent.cfg.srv_commands': 'Commands available on this server',
            'mcagent.cfg.srv_custom': 'Custom commands',
            'mcagent.cfg.srv_custom_add': '+ Add',
            'mcagent.cfg.srv_empty': 'No server profile yet. Create one to store IP + commands.',
            'mcagent.cfg.srv_cmd_count': 'cmd',
            'mcagent.cfg.srv_confirm_delete': 'Delete this server profile?',
            'mcagent.cfg.srv_save_err': 'Save failed',
            'mcagent.cfg.srv_delete_err': 'Delete failed',
            'mcagent.cfg.custom_desc': 'Short description',
            'mcagent.cfg.custom_need_slash': 'A command starts with /',
            'mcagent.cfg.cat_communication': 'Communication',
            'mcagent.cfg.cat_teleport': 'Teleport',
            'mcagent.cfg.cat_economy': 'Economy',
            'mcagent.cfg.cat_status': 'Status',
```

**IT** (après `'mcagent.training': ...,` du bloc italien) :

```js
            'mcagent.cfg.tab_launch': '▶ Avvia',
            'mcagent.cfg.tab_servers': 'Server',
            'mcagent.cfg.profile_select': 'Profilo server',
            'mcagent.cfg.profile_manual': '— Manuale —',
            'mcagent.cfg.srv_new': '+ Nuovo profilo',
            'mcagent.cfg.srv_edit': 'Modifica',
            'mcagent.cfg.srv_delete': 'Elimina',
            'mcagent.cfg.srv_save': 'Salva',
            'mcagent.cfg.srv_cancel': 'Annulla',
            'mcagent.cfg.srv_name': 'Nome profilo',
            'mcagent.cfg.srv_intelligence': 'Intelligenza',
            'mcagent.cfg.srv_commands': 'Comandi disponibili su questo server',
            'mcagent.cfg.srv_custom': 'Comandi personalizzati',
            'mcagent.cfg.srv_custom_add': '+ Aggiungi',
            'mcagent.cfg.srv_empty': 'Nessun profilo server. Creane uno per memorizzare IP + comandi.',
            'mcagent.cfg.srv_cmd_count': 'cmd',
            'mcagent.cfg.srv_confirm_delete': 'Eliminare questo profilo server?',
            'mcagent.cfg.srv_save_err': 'Salvataggio fallito',
            'mcagent.cfg.srv_delete_err': 'Eliminazione fallita',
            'mcagent.cfg.custom_desc': 'Breve descrizione',
            'mcagent.cfg.custom_need_slash': 'Un comando inizia con /',
            'mcagent.cfg.cat_communication': 'Comunicazione',
            'mcagent.cfg.cat_teleport': 'Teletrasporto',
            'mcagent.cfg.cat_economy': 'Economia',
            'mcagent.cfg.cat_status': 'Stato',
```

- [ ] **Step 2: Refactor `openMCAgent` en coquille à 2 onglets**

In `frontend/js/bots_module.js`, replace the body of `openMCAgent()` (the admin branch — keep the rectester early-return intact) so it renders a tab shell and delegates. Replace from `el.innerHTML = \`` … through the closing of the method's loaders, with :

```js
  async openMCAgent() {
    if (this._refreshInterval) { clearInterval(this._refreshInterval); this._refreshInterval = null; }
    if (this._mcAgentTimer) { clearInterval(this._mcAgentTimer); this._mcAgentTimer = null; }
    this._mcAgentSession = this._mcAgentSession || null;
    const el = this._container || document.getElementById('bots-module-container')?.parentElement;
    if (!el) return;
    const __mcaU = (typeof Auth !== 'undefined' && Auth.getUser) ? Auth.getUser() : null;
    this._mcaRecTester = !!(__mcaU && !__mcaU.is_admin && __mcaU.role === 'rectester');
    if (this._mcaRecTester) return this._renderMCAgentRecTester(el);
    this._mcaTab = this._mcaTab || 'launch';
    el.innerHTML = `<div class="card"><h3 style="margin:0 0 12px;">MC Agent — ${Lang.t('mcagent.training')}</h3><div id="mca-root"></div></div>`;
    this._renderMCARoot();
  },

  _renderMCARoot() {
    const root = document.getElementById('mca-root');
    if (!root) return;
    const t = this._mcaTab || 'launch';
    const tabBtn = (id, label) => `<button class="btn btn-ghost btn-sm" style="border-radius:0;border-bottom:2px solid ${t===id?'var(--accent)':'transparent'};" onclick="BotsModule.switchMCATab('${id}')">${label}</button>`;
    root.innerHTML = `
      <div style="display:flex;gap:6px;margin:0 0 14px;border-bottom:1px solid var(--border);">
        ${tabBtn('launch', Lang.t('mcagent.cfg.tab_launch'))}
        ${tabBtn('servers', Lang.t('mcagent.cfg.tab_servers'))}
      </div>
      <div id="mca-tabbody"></div>`;
    if (t === 'servers') this._renderMCAServers();
    else this._renderMCALaunch();
  },

  switchMCATab(tab) {
    this._mcaTab = tab;
    this._renderMCARoot();
  },
```

- [ ] **Step 3: Ajouter `_renderMCALaunch` (vue lancement + sélecteur de profil)**

In `frontend/js/bots_module.js`, add this method (it contains the previous launch markup + a server-profile `<select>` on top) :

```js
  _renderMCALaunch() {
    const body = document.getElementById('mca-tabbody');
    if (!body) return;
    body.innerHTML = `
      ${BotsModule._mcaModBlock()}
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px;padding:10px 12px;background:var(--bg-elev-3);border-radius:10px;border:1px solid var(--border);">
        <span style="font-size:13px;font-weight:600;">${Lang.t('mcagent.key_title')}</span>
        <span id="mca-key-status" style="font-size:12px;color:var(--text-muted);">…</span>
        <input id="mca-key" class="form-input" type="password" placeholder="${Lang.t('mcagent.key_placeholder')}" style="flex:1;min-width:160px;" />
        <button class="btn btn-secondary btn-sm" onclick="BotsModule.saveMCAgentKey()">${Lang.t('mcagent.key_save')}</button>
        <button class="btn btn-ghost btn-sm" onclick="BotsModule.clearMCAgentKey()">${Lang.t('mcagent.key_clear')}</button>
      </div>
      <div style="margin-bottom:10px;">
        <label class="form-label">${Lang.t('mcagent.cfg.profile_select')}</label>
        <select id="mca-server-profile" class="form-input" onchange="BotsModule.applyServerProfile()">
          <option value="">${Lang.t('mcagent.cfg.profile_manual')}</option>
        </select>
      </div>
      <div style="display:grid;grid-template-columns:1fr 100px;gap:10px;margin-bottom:10px;">
        <div><label class="form-label">${Lang.t('mcagent.ip')}</label><input id="mca-host" class="form-input" placeholder="192.168.1.x ou play.exemple.net" /></div>
        <div><label class="form-label">${Lang.t('mcagent.port')}</label><input id="mca-port" class="form-input" value="25565" /></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
        <div><label class="form-label">${Lang.t('mcagent.account')}</label><input id="mca-user" class="form-input" value="TrainBot" placeholder="pseudo ou email" /></div>
        <div><label class="form-label">${Lang.t('mcagent.auth_label')}</label><select id="mca-auth" class="form-input"><option value="offline">${Lang.t('mcagent.auth_offline')}</option><option value="microsoft">${Lang.t('mcagent.auth_microsoft')}</option></select></div>
        <div><label class="form-label">${Lang.t('mcagent.profile')}</label><select id="mca-profile" class="form-input" onchange="BotsModule.renderMCAgentTells()"></select></div>
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin:-4px 0 12px;">${Lang.t('mcagent.ms_hint')}</div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;">
        <button class="btn btn-primary" onclick="BotsModule.startMCAgent()">${Lang.t('mcagent.start')}</button>
        <button class="btn btn-secondary btn-sm" onclick="BotsModule.stopMCAgent()">${Lang.t('mcagent.stop')}</button>
        <span id="mca-msg" style="font-size:13px;color:var(--text-muted);"></span>
      </div>
      <div id="mca-tells" style="display:none;background:var(--bg-elev-2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:10px;font-size:12px;color:var(--text-muted);"></div>
      <div style="border-top:1px solid var(--border);margin:14px 0;padding-top:12px;">
        <div style="font-weight:600;margin-bottom:4px;">${Lang.t('mcagent.capture_title')}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">${Lang.t('mcagent.capture_hint')}</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;">
          <input id="mca-capfile" type="file" accept=".jsonl,.gz" class="form-input" style="flex:1;min-width:200px;" />
          <button class="btn btn-secondary btn-sm" onclick="BotsModule.uploadCapture()">${Lang.t('mcagent.capture_import')}</button>
        </div>
        <div id="mca-captures"></div>
      </div>
      <div id="mca-transcript" style="background:#0d1117;border-radius:8px;padding:12px;max-height:300px;overflow-y:auto;font-family:'Fira Code',monospace;font-size:12px;line-height:1.6;color:#c9d1d9;"></div>
      <div style="display:flex;gap:8px;margin-top:10px;">
        <input id="mca-say" class="form-input" placeholder="${Lang.t('mcagent.say_placeholder')}" style="flex:1;" />
        <button class="btn btn-secondary" onclick="BotsModule.sayMCAgent()">${Lang.t('mcagent.send')}</button>
      </div>`;
    this._loadMCAgentKey();
    this.loadMCAgentProfiles();
    this.loadModVersions();
    this.loadCaptures();
    this.loadLaunchServerProfiles();
  },
```

> Note : supprime l'ancien corps de `openMCAgent` qui rendait directement ce markup (il est désormais dans `_renderMCALaunch`). `_mcaModBlock`, `_renderMCAgentRecTester`, `loadModVersions`, `loadCaptures`, `loadMCAgentProfiles`, `_loadMCAgentKey` restent inchangés.

- [ ] **Step 4: Sélecteur de profil au lancement + envoi `server_id`**

In `frontend/js/bots_module.js`, add :

```js
  async loadLaunchServerProfiles() {
    const sel = document.getElementById('mca-server-profile');
    if (!sel) return;
    try {
      const r = await Auth.apiCall('/api/mc-agent/servers');
      const data = await r.json();
      this._mcaServers = data.servers || [];
      sel.innerHTML = `<option value="">${Lang.t('mcagent.cfg.profile_manual')}</option>`
        + this._mcaServers.map((s) => `<option value="${this._escapeHtml(s.id)}">${this._escapeHtml(s.name)} (${this._escapeHtml(s.host || '?')})</option>`).join('');
    } catch (e) { /* silencieux */ }
  },

  applyServerProfile() {
    const sel = document.getElementById('mca-server-profile');
    if (!sel || !sel.value) return;
    const s = (this._mcaServers || []).find((x) => x.id === sel.value);
    if (!s) return;
    const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
    set('mca-host', s.host); set('mca-port', s.port); set('mca-user', s.user);
    set('mca-auth', s.auth); set('mca-profile', s.intelligence);
  },
```

Replace `startMCAgent` so it sends `server_id` when a profile is selected :

```js
  async startMCAgent() {
    const serverId = (document.getElementById('mca-server-profile') || {}).value || '';
    const msg = document.getElementById('mca-msg');
    let bodyData;
    if (serverId) {
      bodyData = { server_id: serverId };
    } else {
      const host = document.getElementById('mca-host').value.trim();
      if (!host) { msg.textContent = Lang.t('mcagent.need_host'); return; }
      const port = parseInt(document.getElementById('mca-port').value, 10) || 25565;
      const user = document.getElementById('mca-user').value.trim() || 'TrainBot';
      const auth = document.getElementById('mca-auth').value;
      const profile = (document.getElementById('mca-profile') || {}).value || undefined;
      bodyData = { host, port, user, auth, profile };
    }
    const r = await Auth.apiCall('/api/mc-agent/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyData),
    });
    if (!r) return;
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { msg.textContent = data.detail || 'Erreur'; return; }
    this._mcAgentSession = data.session_id;
    msg.textContent = `session #${data.session_id}`;
    this._mcAgentTimer = setInterval(() => BotsModule.refreshMCAgent(), 3000);
  },
```

- [ ] **Step 5: Onglet « Serveurs » — liste + éditeur (CRUD + checklist)**

In `frontend/js/bots_module.js`, add these methods :

```js
  async _ensureCatalog() {
    if (this._mcaCatalog) return;
    try {
      const r = await Auth.apiCall('/api/mc-agent/commands-catalog');
      const data = await r.json();
      this._mcaCatalog = data.catalog || [];
    } catch (e) { this._mcaCatalog = []; }
  },

  _renderMCAServers() {
    const body = document.getElementById('mca-tabbody');
    if (!body) return;
    body.innerHTML = `
      <div style="display:flex;justify-content:flex-end;margin-bottom:10px;">
        <button class="btn btn-primary btn-sm" onclick="BotsModule.newServerProfile()">${Lang.t('mcagent.cfg.srv_new')}</button>
      </div>
      <div id="mca-srv-list"></div>
      <div id="mca-srv-editor"></div>`;
    this.loadServerProfiles();
  },

  async loadServerProfiles() {
    await this._ensureCatalog();
    try {
      const r = await Auth.apiCall('/api/mc-agent/servers');
      const data = await r.json();
      this._mcaServers = data.servers || [];
    } catch (e) { this._mcaServers = []; }
    this._renderServerList();
  },

  _renderServerList() {
    const list = document.getElementById('mca-srv-list');
    if (!list) return;
    const servers = this._mcaServers || [];
    if (!servers.length) { list.innerHTML = `<div style="font-size:12px;color:var(--text-dim);padding:8px 0;">${Lang.t('mcagent.cfg.srv_empty')}</div>`; return; }
    const intel = { evident: 'Évident', intermediaire: 'Intermédiaire', expert: 'Expert' };
    list.innerHTML = servers.map((s) => `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;background:var(--bg-elev-2);border:1px solid var(--border);border-radius:8px;margin-bottom:8px;">
        <div>
          <div style="font-weight:600;">${this._escapeHtml(s.name)}</div>
          <div style="font-size:12px;color:var(--text-muted);font-family:var(--font-mono);">${this._escapeHtml(s.host || '?')}:${s.port} · ${this._escapeHtml(intel[s.intelligence] || s.intelligence)} · ${(s.commands || []).length + (s.custom || []).length} ${Lang.t('mcagent.cfg.srv_cmd_count')}</div>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-secondary btn-sm" onclick="BotsModule.editServerProfile('${this._escapeHtml(s.id)}')">${Lang.t('mcagent.cfg.srv_edit')}</button>
          <button class="btn btn-ghost btn-sm" onclick="BotsModule.deleteServerProfile('${this._escapeHtml(s.id)}')">${Lang.t('mcagent.cfg.srv_delete')}</button>
        </div>
      </div>`).join('');
  },

  newServerProfile() {
    this._mcaEditing = { id: null, name: '', host: '', port: 25565, user: 'TrainBot', auth: 'offline', intelligence: 'intermediaire', commands: [], custom: [] };
    this._renderServerEditor();
  },

  editServerProfile(id) {
    const s = (this._mcaServers || []).find((x) => x.id === id);
    if (!s) return;
    this._mcaEditing = JSON.parse(JSON.stringify(s));
    if (!Array.isArray(this._mcaEditing.custom)) this._mcaEditing.custom = [];
    this._renderServerEditor();
  },

  _renderServerEditor() {
    const box = document.getElementById('mca-srv-editor');
    const e = this._mcaEditing;
    if (!box || !e) return;
    const listEl = document.getElementById('mca-srv-list');
    if (listEl) listEl.style.display = 'none';
    const checked = new Set(e.commands || []);
    const cats = { communication: [], teleport: [], economy: [], status: [] };
    (this._mcaCatalog || []).forEach((c) => { (cats[c.category] || (cats[c.category] = [])).push(c); });
    const checklist = Object.keys(cats).filter((k) => cats[k].length).map((k) => `
      <div style="margin-bottom:8px;">
        <div style="font-size:11px;text-transform:uppercase;color:var(--text-dim);margin-bottom:4px;">${this._escapeHtml(Lang.t('mcagent.cfg.cat_' + k))}</div>
        ${cats[k].map((c) => `
          <label style="display:inline-flex;align-items:center;gap:5px;margin:2px 10px 2px 0;font-size:12px;cursor:pointer;">
            <input type="checkbox" value="${this._escapeHtml(c.id)}" ${checked.has(c.id) ? 'checked' : ''} class="mca-cmd-cb" />
            <span style="font-family:var(--font-mono);">${this._escapeHtml(c.cmd)}</span>
            <span style="color:var(--text-dim);">${this._escapeHtml(c.syntax || '')}</span>
          </label>`).join('')}
      </div>`).join('');
    const customs = (e.custom || []).map((c, i) => `
      <div style="display:flex;align-items:center;gap:6px;font-size:12px;margin-bottom:4px;">
        <span style="font-family:var(--font-mono);">${this._escapeHtml(c.cmd)}</span>
        <span style="color:var(--text-dim);">${this._escapeHtml(c.syntax || '')}</span>
        <button class="btn btn-ghost btn-sm" onclick="BotsModule.removeCustomCommand(${i})">×</button>
      </div>`).join('');
    box.innerHTML = `
      <div style="background:var(--bg-elev-2);border:1px solid var(--border);border-radius:10px;padding:14px;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
          <div><label class="form-label">${Lang.t('mcagent.cfg.srv_name')}</label><input id="mca-e-name" class="form-input" value="${this._escapeHtml(e.name)}" /></div>
          <div><label class="form-label">${Lang.t('mcagent.cfg.srv_intelligence')}</label>
            <select id="mca-e-intel" class="form-input">
              <option value="evident" ${e.intelligence === 'evident' ? 'selected' : ''}>Évident</option>
              <option value="intermediaire" ${e.intelligence === 'intermediaire' ? 'selected' : ''}>Intermédiaire</option>
              <option value="expert" ${e.intelligence === 'expert' ? 'selected' : ''}>Expert</option>
            </select></div>
          <div><label class="form-label">${Lang.t('mcagent.ip')}</label><input id="mca-e-host" class="form-input" value="${this._escapeHtml(e.host)}" /></div>
          <div><label class="form-label">${Lang.t('mcagent.port')}</label><input id="mca-e-port" class="form-input" value="${e.port}" /></div>
          <div><label class="form-label">${Lang.t('mcagent.account')}</label><input id="mca-e-user" class="form-input" value="${this._escapeHtml(e.user)}" /></div>
          <div><label class="form-label">${Lang.t('mcagent.auth_label')}</label>
            <select id="mca-e-auth" class="form-input">
              <option value="offline" ${e.auth === 'offline' ? 'selected' : ''}>${Lang.t('mcagent.auth_offline')}</option>
              <option value="microsoft" ${e.auth === 'microsoft' ? 'selected' : ''}>${Lang.t('mcagent.auth_microsoft')}</option>
            </select></div>
        </div>
        <div style="font-weight:600;font-size:13px;margin:10px 0 6px;">${Lang.t('mcagent.cfg.srv_commands')}</div>
        <div>${checklist || '<span style="font-size:12px;color:var(--text-dim);">—</span>'}</div>
        <div style="font-weight:600;font-size:13px;margin:12px 0 6px;">${Lang.t('mcagent.cfg.srv_custom')}</div>
        <div id="mca-e-customs">${customs}</div>
        <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;">
          <input id="mca-e-ccmd" class="form-input" placeholder="/kit" style="max-width:120px;" />
          <input id="mca-e-csyn" class="form-input" placeholder="/kit <nom>" style="max-width:160px;" />
          <input id="mca-e-cdesc" class="form-input" placeholder="${Lang.t('mcagent.cfg.custom_desc')}" style="flex:1;min-width:140px;" />
          <button class="btn btn-secondary btn-sm" onclick="BotsModule.addCustomCommand()">${Lang.t('mcagent.cfg.srv_custom_add')}</button>
        </div>
        <div style="display:flex;gap:8px;margin-top:14px;">
          <button class="btn btn-primary" onclick="BotsModule.saveServerProfile()">${Lang.t('mcagent.cfg.srv_save')}</button>
          <button class="btn btn-ghost" onclick="BotsModule.cancelServerEdit()">${Lang.t('mcagent.cfg.srv_cancel')}</button>
        </div>
      </div>`;
  },

  _captureEditorState() {
    const e = this._mcaEditing;
    if (!e) return;
    const g = (id) => { const el = document.getElementById(id); return el ? el.value : undefined; };
    if (g('mca-e-name') !== undefined) e.name = g('mca-e-name');
    if (g('mca-e-host') !== undefined) e.host = g('mca-e-host');
    if (g('mca-e-port') !== undefined) e.port = parseInt(g('mca-e-port'), 10) || e.port;
    if (g('mca-e-user') !== undefined) e.user = g('mca-e-user');
    if (g('mca-e-auth') !== undefined) e.auth = g('mca-e-auth');
    if (g('mca-e-intel') !== undefined) e.intelligence = g('mca-e-intel');
    e.commands = Array.from(document.querySelectorAll('.mca-cmd-cb')).filter((cb) => cb.checked).map((cb) => cb.value);
  },

  addCustomCommand() {
    const cmd = (document.getElementById('mca-e-ccmd').value || '').trim();
    if (!cmd.startsWith('/')) { Toast.error(Lang.t('mcagent.cfg.custom_need_slash')); return; }
    const syntax = (document.getElementById('mca-e-csyn').value || '').trim() || cmd;
    const desc = (document.getElementById('mca-e-cdesc').value || '').trim();
    this._captureEditorState();
    this._mcaEditing.custom = this._mcaEditing.custom || [];
    this._mcaEditing.custom.push({ cmd, syntax, desc });
    this._renderServerEditor();
  },

  removeCustomCommand(i) {
    this._captureEditorState();
    this._mcaEditing.custom.splice(i, 1);
    this._renderServerEditor();
  },

  async saveServerProfile() {
    this._captureEditorState();
    const e = this._mcaEditing;
    const payload = { name: e.name || 'Sans nom', host: e.host || '', port: e.port || 25565, user: e.user || 'TrainBot', auth: e.auth || 'offline', intelligence: e.intelligence || 'intermediaire', commands: e.commands || [], custom: e.custom || [] };
    const url = e.id ? `/api/mc-agent/servers/${encodeURIComponent(e.id)}` : '/api/mc-agent/servers';
    const r = await Auth.apiCall(url, { method: e.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!r || !r.ok) { Toast.error(Lang.t('mcagent.cfg.srv_save_err')); return; }
    this._mcaEditing = null;
    const ed = document.getElementById('mca-srv-editor'); if (ed) ed.innerHTML = '';
    const list = document.getElementById('mca-srv-list'); if (list) list.style.display = '';
    this.loadServerProfiles();
  },

  cancelServerEdit() {
    this._mcaEditing = null;
    const ed = document.getElementById('mca-srv-editor'); if (ed) ed.innerHTML = '';
    const list = document.getElementById('mca-srv-list'); if (list) list.style.display = '';
  },

  async deleteServerProfile(id) {
    if (!confirm(Lang.t('mcagent.cfg.srv_confirm_delete'))) return;
    const r = await Auth.apiCall(`/api/mc-agent/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (r && r.ok) this.loadServerProfiles();
    else Toast.error(Lang.t('mcagent.cfg.srv_delete_err'));
  },
```

- [ ] **Step 6: Valider le parse JS du module (piège #28)**

Run: `node -e "new Function(require('fs').readFileSync('frontend/js/bots_module.js','utf8'))" && echo PARSE_OK`
Expected: `PARSE_OK` (aucune SyntaxError).

- [ ] **Step 7: Cache-bust (piège #9/#11)**

In `frontend/index.html`, bump both versions :
- `<script src="/js/lang.js?v=200">` → `?v=201`
- `<script src="/js/bots_module.js?v=200">` → `?v=201`

In `frontend/sw.js`, bump `const CACHE_NAME = 'omenserver-v85';` → `'omenserver-v86';`

- [ ] **Step 8: Commit**

```bash
git add frontend/js/lang.js frontend/js/bots_module.js frontend/index.html frontend/sw.js
git commit -m "feat(mc-agent): UI onglet Serveurs (profils + checklist commandes) + i18n + cache-bust"
```

---

## Task 8: Vérification finale (tests complets + UI réelle) + docs

**Files:**
- Modify: `CLAUDE.md` (historique + piège)

- [ ] **Step 1: Suite Python complète**

Run: `python -m pytest backend/bots/tests/ -q`
Expected: PASS (dont les nouveaux `test_mc_agent_servers`, `test_mc_agent_router`, `test_mc_agent_manager`).

- [ ] **Step 2: Suite Node complète**

Run: `cd mc-agent && node --test`
Expected: PASS (commands + brain + reste de la suite).

- [ ] **Step 3: Vérification UI réelle (skill `verify-ui` / Chrome MCP)**

Lancer le serveur dev si besoin (`uvicorn backend.main:app --reload` — c'est Massii qui le lance dans son terminal, cf. CLAUDE.md global), puis via Chrome MCP, logué en admin sur le module Bots → MC Agent :
1. Onglet **Serveurs** visible ; **+ Nouveau profil** ouvre l'éditeur.
2. Créer « Paper Essentials » : host `play.test.net`, intelligence Expert, cocher `/msg` `/home` `/tpa`, ajouter custom `/kit`. Enregistrer → apparait dans la liste avec le bon compte de commandes.
3. Onglet **Lancer** : le `<select>` « Profil serveur » liste « Paper Essentials » ; le choisir remplit host/port/compte/auth/intelligence.
4. Switch FR→EN→IT : les libellés des onglets + éditeur se traduisent.
5. Console sans erreur ; recharger (Cmd+Shift+R) → l'onglet Serveurs reste fonctionnel.

Corriger tout écart avant de continuer.

- [ ] **Step 4: Mettre à jour `CLAUDE.md`**

Add a row at the top of the `## 📝 Historique récent` table :

```markdown
| 2026-06-01 | ⚙️ **MC Agent — onglet Serveurs (profils + commandes)** : profils serveur réutilisables (IP/port/compte/auth + intelligence = profils existants + checklist de commandes dispo) persistés `data/mc_agent_servers.json`. Catalogue prédéfini `mc-agent/commands-catalog.json` + commandes custom. Le bot reçoit la whitelist via `--commands` → injectée dans le system prompt (`brain.js`, champ décision `command`) + garde-fou pur `mc-agent/commands.js` (bloque toute commande non cochée, double sécurité). UI 2-onglets ▶ Lancer / ⚙ Serveurs. Endpoints catalogue + CRUD `/servers` + `/run` via `server_id`, admin-only. Tests Python + Node verts. |
```

Add a new entry at the end of the `## ⚠️ Pièges connus` list :

```markdown
38. **MC Agent commandes serveur = texte chat, pas de skill** : le bot exécute une commande serveur (`/home`, `/tpa Bob`) en la tapant via `bot.chat` (le SERVEUR fait le boulot) — AUCUNE nouvelle skill mineflayer. Le LLM met la commande dans le champ décision `command` ; `mc-agent/commands.js` (`isAllowed`) la laisse passer SEULEMENT si elle est dans la whitelist du profil serveur (sinon event `blocked_command`). Double sécurité : prompt (`buildCommandDocs`) + filtre sortant. La whitelist effective est résolue côté backend (`mc_agent_servers.resolve_commands` : catalogue coché + custom) et passée au subprocess via `--commands <file>` (fichier temp `data/mc_agent_runs/`, nettoyé au stop). `buildSystemPrompt(null)` DOIT rester `=== SYSTEM_PROMPT` (test pinné) → ne pas toucher au schéma JSON du prompt sans profil ; le champ `command` est introduit par le bloc commandes injecté, pas par le schéma de base.
```

- [ ] **Step 5: Commit final**

```bash
git add CLAUDE.md
git commit -m "docs(mc-agent): historique + piège #38 (commandes serveur = chat, whitelist garde-fou)"
```

---

## Notes d'implémentation

- **Branche** : exécuter ce plan dans un worktree isolé (pattern MC Agent, cf. `feat/mc-agent-phase1b-impl`). Inclure le spec + ce plan dans la branche.
- **Déploiement** : aucune nouvelle dépendance (Python stdlib, pas de nouveau module Node) → l'auto-deploy suffit, pas de `pip install`/`npm install` sur l'Omen.
- **Python 3.9** : pas de `str | None` (piège #1) — respecté (`Optional[...]`).
- **Pas de push pendant un scan** (piège #30f) — non concerné ici, mais ne pas pusher si un bot/scan tourne.
