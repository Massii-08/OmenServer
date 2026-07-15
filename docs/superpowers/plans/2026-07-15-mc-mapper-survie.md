# Survie du mappeur (bouffe + abri auto-suffisant + armure via /kit) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendre le mappeur survivable sur Hard : abri qui se ferme tout seul (sans dépendre de l'inventaire), déclenché sur l'obscurité ; bouffe ; et armure via la commande serveur `/kit` (configurable) lancée au démarrage + au respawn. Aucun minage fer obligatoire.

**Architecture:** Décisions PURES testables (`maybeRunKit`, `needDirtBuffer`, `roofPlan`, `shouldShelter`) + actions best-effort câblées dans `index.js`. Réutilise `huntCookGoal`/`armorUp`/`eat` existants. Nouveau champ profil `kit_command` (backend `resolve_policy` → `--policy` → bot). Spec : `docs/superpowers/specs/2026-07-15-mc-mapper-survie-design.md`.

**Tech Stack:** Node.js (mineflayer) + tests `node:test` ; backend FastAPI + pytest ; frontend vanilla JS. Aucune nouvelle dépendance.

**Worktree :** `feat/mc-mapper-survival` (créé, base `origin/main` `32c4c45`). node_modules symlinké. ⚠️ Ne jamais `git add -A` (symlink node_modules) — add fichiers nommés only. Tests Node : `cd mc-agent && node --test <file>`. Tests backend : depuis la racine repo, `venv` si besoin — le repo a déjà pytest configuré.

**Versions cache-bust (à relire d'origin/main au deploy)** : lire `git show origin/main:frontend/index.html | grep -o "bots_module.js?v=[0-9]*\|lang.js?v=[0-9]*"` + `sw.js CACHE_NAME` au moment du push (Task 7).

---

### Task 1: `kit.js` — décision pure « (re)lancer le kit ? »

**Files:** Create `mc-agent/kit.js` ; Create `mc-agent/kit.test.js`.

- [ ] **Step 1: Test qui échoue**

Créer `mc-agent/kit.test.js` :

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { maybeRunKit } = require('./kit');

test('maybeRunKit : pas de commande configurée → run:false', () => {
  assert.strictEqual(maybeRunKit({ kitCommand: '', lastRunAt: null, now: 1000 }).run, false);
  assert.strictEqual(maybeRunKit({ kitCommand: null, lastRunAt: null, now: 1000 }).run, false);
});

test('maybeRunKit : commande + jamais lancé → run:true', () => {
  const r = maybeRunKit({ kitCommand: '/kit', lastRunAt: null, now: 1000 });
  assert.strictEqual(r.run, true);
});

test('maybeRunKit : re-appel avant cooldown → run:false ; après cooldown → run:true', () => {
  assert.strictEqual(maybeRunKit({ kitCommand: '/kit', lastRunAt: 1000, now: 1000 + 60000, cooldownMs: 300000 }).run, false);
  assert.strictEqual(maybeRunKit({ kitCommand: '/kit', lastRunAt: 1000, now: 1000 + 300000, cooldownMs: 300000 }).run, true);
});
```

- [ ] **Step 2: Lancer → échec**

Run: `cd mc-agent && node --test kit.test.js`
Expected: FAIL — `Cannot find module './kit'`.

- [ ] **Step 3: Implémenter**

Créer `mc-agent/kit.js` :

```js
'use strict';
// Décision PURE : faut-il (re)lancer la commande de kit serveur (/kit) ? Configurée au profil,
// lancée au démarrage + à chaque respawn, avec un cooldown LOCAL anti-spam (le vrai cooldown
// serveur est géré best-effort côté action : la réponse d'erreur est ignorée).
function maybeRunKit({ kitCommand, lastRunAt, now, cooldownMs = 300000 } = {}) {
  if (!kitCommand || !String(kitCommand).trim()) return { run: false, reason: 'not_configured' };
  if (lastRunAt != null && (now - lastRunAt) < cooldownMs) return { run: false, reason: 'cooldown' };
  return { run: true, reason: lastRunAt == null ? 'first' : 'refresh' };
}

module.exports = { maybeRunKit };
```

- [ ] **Step 4: Lancer → passe**

Run: `cd mc-agent && node --test kit.test.js` → `# pass 3 # fail 0`.

- [ ] **Step 5: Commit**

```bash
git add mc-agent/kit.js mc-agent/kit.test.js
git commit -m "feat(mc-mapper): kit.js — décision pure (re)lancer /kit (config + cooldown local)"
```

---

### Task 2: `dirt.js` — décision pure « buffer de terre d'urgence »

**Files:** Create `mc-agent/dirt.js` ; Create `mc-agent/dirt.test.js`.

- [ ] **Step 1: Test qui échoue**

Créer `mc-agent/dirt.test.js` :

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { needDirtBuffer, POSABLE } = require('./dirt');

test('needDirtBuffer : sous le seuil → true, au-dessus → false', () => {
  // inv = liste d'items {name,count}
  assert.strictEqual(needDirtBuffer([], 4), true);
  assert.strictEqual(needDirtBuffer([{ name: 'dirt', count: 2 }], 4), true);
  assert.strictEqual(needDirtBuffer([{ name: 'dirt', count: 4 }], 4), false);
  assert.strictEqual(needDirtBuffer([{ name: 'cobblestone', count: 3 }, { name: 'gravel', count: 3 }], 4), false);
});

test('needDirtBuffer : ignore les items non posables (épée, torche)', () => {
  assert.strictEqual(needDirtBuffer([{ name: 'stone_sword', count: 1 }, { name: 'torch', count: 20 }], 4), true);
  assert.ok(POSABLE.has('dirt') && POSABLE.has('cobblestone'));
});
```

- [ ] **Step 2: Lancer → échec**

Run: `cd mc-agent && node --test dirt.test.js`
Expected: FAIL — `Cannot find module './dirt'`.

- [ ] **Step 3: Implémenter**

Créer `mc-agent/dirt.js` :

```js
'use strict';
// Buffer de blocs POSABLES d'urgence : de quoi se sceller un toit d'abri même sans rien miner.
// Blocs qui droppent SANS outil (terre/gravier/sable) ou déjà en poche (cobble) — pas les minerais.
const POSABLE = new Set(['dirt', 'coarse_dirt', 'grass_block', 'gravel', 'sand', 'red_sand',
  'cobblestone', 'cobbled_deepslate', 'netherrack', 'dirt_path']);

/** inv = [{name,count}] ; true si moins de `min` blocs posables en poche. PUR. */
function needDirtBuffer(inv, min = 4) {
  let n = 0;
  for (const it of inv || []) if (POSABLE.has(it.name)) n += (it.count || 0);
  return n < min;
}

module.exports = { needDirtBuffer, POSABLE };
```

- [ ] **Step 4: Lancer → passe**

Run: `cd mc-agent && node --test dirt.test.js` → `# pass 2 # fail 0`.

- [ ] **Step 5: Commit**

```bash
git add mc-agent/dirt.js mc-agent/dirt.test.js
git commit -m "feat(mc-mapper): dirt.js — décision pure buffer de terre d'urgence pour l'abri"
```

---

### Task 3: `shelter.js` — abri auto-suffisant (décisions pures + self-seal)

**Files:** Modify `mc-agent/skills/shelter.js` ; Create/append `mc-agent/skills/shelter.test.js`.

- [ ] **Step 1: Test qui échoue**

Créer `mc-agent/skills/shelter.test.js` :

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { roofPlan, shouldShelter } = require('./shelter');

test('roofPlan : bloc posable en poche → source inventory', () => {
  assert.strictEqual(roofPlan([{ name: 'dirt', count: 3 }], { hasPickaxe: false }).source, 'inventory');
});

test('roofPlan : rien en poche mais terrain minable → source mine', () => {
  // sol de terre minable sans outil
  assert.strictEqual(roofPlan([], { hasPickaxe: false, groundMineable: true }).source, 'mine');
});

test('roofPlan : rien en poche, pierre + pas de pioche → source none', () => {
  assert.strictEqual(roofPlan([{ name: 'stone_sword', count: 1 }], { hasPickaxe: false, groundMineable: false }).source, 'none');
});

test('shouldShelter : obscurité (light<=7) déclenche même y bas, sans dépendre de la nuit', () => {
  assert.strictEqual(shouldShelter({ night: false, lightLevel: 3, naked: true }).shelter, true);
});

test('shouldShelter : nuit + nu déclenche', () => {
  assert.strictEqual(shouldShelter({ night: true, lightLevel: null, naked: true }).shelter, true);
});

test('shouldShelter : jour + clair + équipé → non', () => {
  assert.strictEqual(shouldShelter({ night: false, lightLevel: 15, naked: false, lowHp: false, hostilesNear: false }).shelter, false);
});

test('shouldShelter : hostiles proches + nu (grotte) → déclenche même si light inconnu', () => {
  assert.strictEqual(shouldShelter({ night: false, lightLevel: null, naked: true, hostilesNear: true }).shelter, true);
});
```

- [ ] **Step 2: Lancer → échec**

Run: `cd mc-agent && node --test skills/shelter.test.js`
Expected: FAIL — `roofPlan is not a function`.

- [ ] **Step 3: Ajouter les décisions pures dans `skills/shelter.js`**

Dans `mc-agent/skills/shelter.js`, importer `POSABLE` en tête (après les requires existants) :

```js
const { POSABLE } = require('../dirt');
```

Puis, avant `module.exports`, ajouter :

```js
/**
 * Décision PURE : comment obtenir le bloc-toit pour sceller l'abri ?
 * inv = [{name,count}] ; ctx = { hasPickaxe, groundMineable }.
 * → { source: 'inventory' | 'mine' | 'none' }.
 */
function roofPlan(inv, ctx = {}) {
  for (const it of inv || []) if (POSABLE.has(it.name) && (it.count || 0) > 0) return { source: 'inventory' };
  // pas de bloc en poche : peut-on en MINER un tout de suite ? terre/gravier droppe sans outil ;
  // pierre exige une pioche.
  if (ctx.groundMineable || ctx.hasPickaxe) return { source: 'mine' };
  return { source: 'none' };
}

/**
 * Décision PURE : faut-il se mettre à l'abri MAINTENANT ? Robuste au niveau de lumière inconnu
 * (mineflayer ne le livre pas toujours) : retombe sur la présence d'hostiles.
 * sig = { night, lightLevel (0-15|null), naked, lowHp, hostilesNear, proactive }.
 * → { shelter: bool, reason }.
 */
function shouldShelter(sig = {}) {
  const dark = (sig.lightLevel != null && sig.lightLevel <= 7);
  if (sig.night && (sig.proactive || sig.naked || sig.lowHp)) return { shelter: true, reason: 'night' };
  if (dark && (sig.naked || sig.lowHp || sig.hostilesNear)) return { shelter: true, reason: 'dark' };
  if (sig.hostilesNear && (sig.naked || sig.lowHp)) return { shelter: true, reason: 'hostiles' };
  return { shelter: false, reason: 'safe' };
}
```

Mettre à jour l'export : `module.exports = { isNightTime, isNight, shelterUntilDawn, roofPlan, shouldShelter };`

- [ ] **Step 4: Câbler le self-seal dans `shelterUntilDawn` (action best-effort)**

Dans `shelterUntilDawn`, l'étape 2 « toit best-effort » : remplacer la logique qui ne pose un
bloc QUE si un `SCAFFOLD` est en poche par une version qui, à défaut, en MINE un. Remplacer le
bloc `try { … scaffold … } catch {}` (étape 2) par :

```js
  // 2) toit : bloc de l'inventaire, sinon on en MINE un (terre/gravier drop sans outil) — auto-suffisant.
  try {
    const head2 = bot.entity.position.floored().offset(0, 2, 0);
    let block = bot.inventory.items().find((i) => SCAFFOLD.includes(i.name));
    if (!block) {
      // miner un bloc de PAROI adjacent (au niveau des pieds) pour récupérer un drop posable
      const feet = bot.entity.position.floored();
      for (const d of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
        const wall = bot.blockAt(feet.plus(d));
        if (wall && wall.boundingBox === 'block' && wall.name !== 'bedrock') {
          try { await bot.dig(wall); await sleep(300); } catch (e) {}
          block = bot.inventory.items().find((i) => SCAFFOLD.includes(i.name));
          if (block) break;
        }
      }
    }
    if (block) {
      for (const d of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
        const wall = bot.blockAt(head2.plus(d));
        if (!wall || wall.boundingBox !== 'block') continue;
        try {
          await bot.equip(block, 'hand');
          await bot.placeBlock(wall, d.scaled(-1));
          const roof = bot.blockAt(head2);
          if (roof && roof.boundingBox === 'block') { emit({ type: 'shelter', action: 'roofed' }); break; }
        } catch (e) { /* paroi suivante */ }
      }
    } else {
      emit({ type: 'shelter', action: 'no_roof' });   // dégradé : le trou protège déjà des tirs
    }
  } catch (e) { /* best-effort */ }
```

(Le `SCAFFOLD` inclut cobble/dirt/… ; le drop de la terre minée y tombe → scellage.)

- [ ] **Step 5: Lancer les tests purs → passent + parse-check**

```bash
cd mc-agent && node --test skills/shelter.test.js
node -e "new Function(require('fs').readFileSync('skills/shelter.js','utf8')); console.log('parse OK')"
```
Expected: `# fail 0` puis `parse OK`.

- [ ] **Step 6: Commit**

```bash
git add mc-agent/skills/shelter.js mc-agent/skills/shelter.test.js
git commit -m "feat(mc-mapper): abri auto-suffisant — roofPlan/shouldShelter purs + self-seal (mine son toit)"
```

---

### Task 4: backend — `kit_command` dans `resolve_policy`

**Files:** Modify `backend/bots/mc_agent_servers.py` (`resolve_policy`) ; Test `backend/bots/tests` (là où vivent les tests mc_agent_servers — repérer avec `grep -rl resolve_policy backend`).

- [ ] **Step 1: Écrire le test qui échoue**

Repérer le fichier de tests : `grep -rln "resolve_policy" backend | grep test`. Y ajouter :

```python
def test_resolve_policy_includes_kit_command():
    from backend.bots.mc_agent_servers import resolve_policy
    assert resolve_policy({"kit_command": "/kit starter"})["kit_command"] == "/kit starter"
    # défaut : chaîne vide quand absent
    assert resolve_policy({})["kit_command"] == ""
```

- [ ] **Step 2: Lancer → échec**

Run: `python -m pytest backend/bots/tests -k kit_command -q` (adapter le chemin au fichier trouvé)
Expected: FAIL — `KeyError: 'kit_command'`.

- [ ] **Step 3: Implémenter**

Dans `backend/bots/mc_agent_servers.py`, `resolve_policy` devient :

```python
def resolve_policy(server):
    """Profil → policy {trusted, trade, kit_command} pour le bot (gating + auto-accept + survie)."""
    return {
        "trusted": server.get("trusted", []),
        "trade": server.get("trade"),
        "kit_command": server.get("kit_command", "") or "",
    }
```

- [ ] **Step 4: Lancer → passe + non-régression du module**

```bash
python -m pytest backend/bots/tests -k "policy or servers" -q
```
Expected: passe, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add backend/bots/mc_agent_servers.py backend/bots/tests
git commit -m "feat(mc-mapper): profil serveur kit_command résolu dans la policy"
```

---

### Task 5: `index.js` — câblage survie (kit au démarrage/respawn, dark-shelter, dirt buffer)

**Files:** Modify `mc-agent/index.js`.

- [ ] **Step 1: Imports + policy.kit_command**

En tête, après les requires existants du bot (près de `loadPolicy`), ajouter :

```js
const { maybeRunKit } = require('./kit');
const { needDirtBuffer } = require('./dirt');
const { shouldShelter } = require('./skills/shelter');
```

`policy` est déjà chargé (`const policy = loadPolicy(args.policy)`). `policy.kit_command` est
donc dispo (le backend le fournit ; défaut `""`).

- [ ] **Step 2: Helper `survivalKitUp()` (kit + équipement)**

Ajouter près des autres helpers de `startMapper` (ou au niveau module, après `armorUp`) :

```js
let _lastKitAt = null;
async function survivalKitUp() {
  const d = maybeRunKit({ kitCommand: policy.kit_command, lastRunAt: _lastKitAt, now: Date.now() });
  if (!d.run) return;
  _lastKitAt = Date.now();
  try { bot.chat(String(policy.kit_command)); emit({ type: 'kit_used', cmd: policy.kit_command }); } catch (e) {}
  await new Promise((r) => setTimeout(r, 1500));   // réception des items
  try { await armorUp(0); } catch (e) {}           // équipe l'armure reçue
  try { await eat(bot); } catch (e) {}             // mange si un aliment est fourni
}
```

(⚠️ `eat` est importé depuis `./skills/equip` — vérifier l'import existant en tête ; sinon
l'ajouter `const { eat } = require('./skills/equip');`.)

- [ ] **Step 3: Lancer le kit au démarrage + au respawn**

Dans `startMapper`, tout au début (avant `runKit()`), insérer :

```js
  await survivalKitUp();   // /kit + équipement (si configuré) — AVANT le mini-kit pierre
```

Dans le handler `bot.on('spawn', …)` (≈ l.2466, fire aussi au RESPAWN), ajouter l'appel
best-effort (le cooldown local évite le double-run au 1er spawn) :

```js
bot.on('spawn', () => {
  _floatSettleUntil = Date.now() + 15000;
  survivalKitUp().catch(() => {});   // re-kit + ré-équipement après un respawn (cooldown-gated)
  onSpawn().catch((e) => emit({ type: 'error', message: String((e && e.message) || e) }));
});
```

- [ ] **Step 4: Trigger d'abri sensible à l'obscurité (`maybeNightShelter`)**

Remplacer la condition de `maybeNightShelter` (≈ l.760) pour utiliser `shouldShelter`. Le corps
devient :

```js
async function maybeNightShelter(proactive = false) {
  const deathsRecent = deathTimes.filter((t) => Date.now() - t < 10 * 60 * 1000).length;
  const _pp = bot.entity && bot.entity.position;
  const naked = _wornArmor().size === 0;
  // niveau de lumière best-effort (mineflayer ne le livre pas toujours → null)
  let lightLevel = null;
  try { const b = _pp && bot.blockAt(_pp.floored()); if (b && typeof b.light === 'number') lightLevel = b.light; } catch (e) {}
  const hostilesNear = (() => { try { const e = bot.nearestEntity((x) => x && x.kind === 'Hostile mobs'); return !!(e && bot.entity && e.position.distanceTo(bot.entity.position) <= 8); } catch (e) { return false; } })();
  const sig = { night: isNight(bot), lightLevel, naked, lowHp: (bot.health != null && bot.health <= 10), hostilesNear, proactive };
  if (shouldShelter(sig).shelter && Date.now() - lastShelterT > 10 * 60 * 1000) {
    lastShelterT = Date.now();
    await withTimeout(shelterUntilDawn(bot, taskToken, { emit }), 13 * 60 * 1000, () => { try { stopMotion(); } catch (e) {} });
    return true;
  }
  return false;
}
```

(⚠️ `_wornArmor`, `lastShelterT`, `isNight`, `withTimeout`, `shelterUntilDawn`, `stopMotion`,
`taskToken`, `deathTimes` existent déjà dans le fichier — ne pas les redéfinir. Le faux « y<45
safe» disparaît, remplacé par le signal obscurité/hostiles.)

- [ ] **Step 5: Dirt buffer + bouffe au démarrage du mappeur**

Dans `startMapper`, après le mini-kit (`runKit`) et avant la boucle, ajouter :

```js
  // filet abri : garder de quoi se sceller un toit ; bouffe pour régén PV. Best-effort, bornés.
  try { if (needDirtBuffer(bot.inventory.items(), 8)) await gather(bot, { _ids: ['dirt', 'grass_block', 'gravel'], count: 8, maxDistance: 48 }, taskToken); } catch (e) {}
  try { await huntCookGoal('food'); } catch (e) {}
```

(⚠️ `gather` et `huntCookGoal` existent déjà — vérifier la signature de `gather` dans le fichier
avant : adapter `_ids`/`count`/`maxDistance` à l'appel réel utilisé ailleurs dans index.js. Si la
signature diffère, utiliser la même forme que les autres appels `gather(bot, …)` du fichier.)

Ajouter aussi le top-up dirt dans le hook `onPeriodic` existant (à côté de `armorUp(0)`) :

```js
      try { if (needDirtBuffer(bot.inventory.items(), 4)) await gather(bot, { _ids: ['dirt', 'grass_block', 'gravel'], count: 8, maxDistance: 48 }, taskToken); } catch (e) {}
```

- [ ] **Step 6: Parse-check + suite Node complète**

```bash
cd mc-agent && node -e "new Function(require('fs').readFileSync('index.js','utf8')); console.log('parse OK')"
node --test *.test.js 2>&1 | grep -E "^# (tests|pass|fail)"
```
Expected: `parse OK` + `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add mc-agent/index.js
git commit -m "feat(mc-mapper): câblage survie — /kit au démarrage/respawn, abri sensible à l'obscurité, buffer terre + bouffe"
```

---

### Task 6: frontend — champ « Commande de kit » au profil serveur

**Files:** Modify `frontend/js/bots_module.js` (formulaire de profil serveur, onglet Serveurs) ; `frontend/js/lang.js` (i18n) ; `frontend/index.html` (cache-bust) ; `frontend/sw.js` (CACHE_NAME).

- [ ] **Step 1: Repérer le formulaire de profil serveur**

`grep -nE "trusted|trade|acceptCmd|mca-srv|renderServers|saveServer|kit_command" frontend/js/bots_module.js | head`. Le formulaire de profil (où l'on saisit host/port/trusted/trade) est l'endroit ; ajouter un champ texte `kit_command`.

- [ ] **Step 2: Ajouter le champ dans le rendu du formulaire**

À côté des champs existants (ex. après le champ trade), ajouter un input :

```html
<label style="display:block;margin-top:8px;font-size:12px;color:var(--text-muted);">${Lang.t('mcagent.srv.kit_command')}</label>
<input id="mca-srv-kit" class="form-input" placeholder="/kit" value="${this._escapeHtml(srv.kit_command||'')}" />
```

(Adapter `srv.kit_command` au nom réel de l'objet profil dans le rendu ; `_escapeHtml` existe.)

- [ ] **Step 3: Inclure `kit_command` dans le payload de sauvegarde**

Dans la fonction qui construit le body du POST/PUT de sauvegarde du profil (là où `trusted`/`trade`
sont assemblés), ajouter :

```js
kit_command: (document.getElementById('mca-srv-kit')||{}).value || '',
```

- [ ] **Step 4: i18n (3 langues)**

Dans `frontend/js/lang.js`, ajouter à côté des autres clés `mcagent.srv.*` :
- FR : `'mcagent.srv.kit_command': 'Commande de kit (optionnel — ex. /kit)',`
- EN : `'mcagent.srv.kit_command': 'Kit command (optional — e.g. /kit)',`
- IT : `'mcagent.srv.kit_command': 'Comando kit (opzionale — es. /kit)',`

- [ ] **Step 5: Backend — persister `kit_command` sur le profil**

Vérifier que l'endpoint de création/màj de profil serveur (`mc_agent_router.py` / `mc_agent_servers.py` `add_server`/`update_server`) **accepte et stocke** `kit_command`. Si le modèle filtre les champs connus, ajouter `kit_command` à la liste des champs persistés (chercher où `trusted`/`trade` sont stockés). Ajouter un test pytest : sauver un profil avec `kit_command` → relire → présent.

- [ ] **Step 6: Cache-bust + parse-check**

Lire les versions d'origin, bumper `bots_module.js?v=` et `lang.js?v=` (+1 au-dessus d'origin) dans `frontend/index.html`, bumper `CACHE_NAME` dans `frontend/sw.js`. Puis :
```bash
node -e "new Function(require('fs').readFileSync('frontend/js/bots_module.js','utf8')); new Function(require('fs').readFileSync('frontend/js/lang.js','utf8')); console.log('parse OK')"
```

- [ ] **Step 7: Commit**

```bash
git add frontend/js/bots_module.js frontend/js/lang.js frontend/index.html frontend/sw.js backend/bots/mc_agent_servers.py backend/bots/mc_agent_router.py backend/bots/tests
git commit -m "feat(mc-mapper): champ profil « Commande de kit » (UI + persistance + i18n)"
```

---

### Task 7: Validation live + déploiement

- [ ] **Step 1: Aucun grind actif à tuer** (piège #47e) : `ssh omen 'pgrep -c -f mc-agent/index.js'` + rôles (`data/mc_agent_runs/world-*.json`). Grind iron_armor actif → demander à Massii.

- [ ] **Step 2: Rebase + push**
```bash
git fetch origin && git rebase origin/main
# revérifier bateau + fix warp toujours là ; bumper les ?v= au-dessus d'origin si bougé
git push origin feat/mc-mapper-survival:main
```

- [ ] **Step 3: Attendre l'auto-deploy** (`ssh omen 'grep -c maybeRunKit ~/"Projet serveur"/mc-agent/index.js'` → ≥1).

- [ ] **Step 4: Configurer `/kit` sur le profil test + relancer**
Via le dashboard (onglet Serveurs → profil neth-run → Commande de kit = `/kit`) OU via l'API/DB. Puis relancer 2 mappeurs (JWT minté côté Omen).
⚠️ Vérifier d'abord que le serveur de test `omen-minecraft-trusted-test` **a bien une commande `/kit`** (sinon la brancher est un no-op — dans ce cas valider l'abri auto-suffisant seul, sans armure).

- [ ] **Step 5: Vérifier survie + carte**
Via `/api/mc-agent/events/{sid}` : chute des `status:dead` (vs 13/20min), apparition de `kit_used`/`shelter{roofed}` ; via rcon `data get entity MapBot1 Inventory` : armure portée (slots 5-8) ; via le fichier mémoire : **la carte grandit** (le mappeur survit assez pour explorer/traverser).

- [ ] **Step 6: MAJ CLAUDE.md (historique + piège) + vault Obsidian.**

---

## Self-review (auteur)

- **Couverture spec** : §4.1 abri→T3 ; §4.2 dirt→T2+T5 ; §4.3 trigger obscurité→T3(shouldShelter)+T5(câblage) ; §4.4 bouffe+kit→T5 ; §4.5 config profil→T4+T6 ; §4.6 maybeRunKit→T1 ; tests §5→T1-4 + live T7. OK.
- **Placeholders** : les Task 5/6 comportent des ⚠️ « vérifier la signature réelle de `gather`/`eat`/le nom du champ profil » — ce sont des points d'intégration à confirmer sur le code réel (pas des TODO de logique) ; l'implémenteur lit le fichier et adapte. Assumé (wiring dans un gros fichier existant).
- **Cohérence types** : `maybeRunKit({kitCommand,lastRunAt,now,cooldownMs})→{run,reason}` (T1↔T5) ; `needDirtBuffer(inv,min)→bool` (T2↔T5) ; `roofPlan(inv,ctx)→{source}` / `shouldShelter(sig)→{shelter,reason}` (T3↔T5) ; `resolve_policy→{…,kit_command}` (T4↔T5 via policy). Cohérent.
- **Risque** : `bot.blockAt(...).light` peut être absent → `lightLevel=null` géré (shouldShelter retombe sur hostiles/nuit). `/kit` inexistant sur le serveur test → valider l'abri seul (noté T7 Step 4).
