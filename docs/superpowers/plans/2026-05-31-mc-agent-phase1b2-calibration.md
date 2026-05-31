# MC Agent — Phase 1b.2 (calibration sur captures réelles) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Brancher la sortie `style.json` de la distillation (jalon 1b.1) sur les **profils de comportement existants** : quand on lance le bot avec une calibration, les `derivedParams` mesurés sur un vrai joueur (latence de chat, variance, taux de faute, jitter) **remplacent** les constantes devinées du profil — **sans toucher aux `tells`** (invariant §2 préservé).

**Architecture :** Un nouveau module Node `mc-agent/calibrate.js` fusionne `style.derivedParams` par-dessus `profile.params` (override sélectif, `tells` intacts). `index.js` lit un argument `--style <chemin>`, charge le fichier, et applique la calibration au profil chargé. Côté Python, `mc_agent_manager.start_session` accepte un paramètre `style_player` → résout `data/mc-captures/<joueur>/style.json` et passe `--style` au subprocess. Le router `/run` accepte un champ optionnel `style_player`. Le frontend ajoute un sélecteur « Calibrer sur <joueur> » alimenté par la liste des captures distillées.

**Tech Stack :** Node 22 (`node:test`), Python 3.9 (FastAPI, pytest), Vanilla JS. Aucune nouvelle dépendance.

**Référence spec :** `docs/superpowers/specs/2026-05-29-mc-agent-phase1b-behavioral-capture-design.md` §8 (calibration). Plan amont : `docs/superpowers/plans/2026-05-30-mc-agent-phase1b1-capture-pipeline.md` (produit `style.json`).

**⚠️ Garde-fous projet (NON négociables) :**
- **Invariant tells (§2)** : la calibration **ne modifie JAMAIS** `profile.tells`. Test dédié qui le prouve.
- **Non-régression Phase 1** : sans `--style`, le comportement du bot est **identique** à aujourd'hui (profils Phase 1 inchangés). Test dédié.
- **Forme `derivedParams` figée** : `{chat:{latencyMeanMs,latencyStdMs,typoRate}, errorRate, movementJitter}` — 1:1 avec ce que lit `mc-agent/humanize.js` (`profile.params.chat.*`).
- Branche **`feat/mc-agent-phase1b`** (worktree isolé). Jamais `main`. Commits par **pathspec explicite** (jamais `git add -A` — checkout partagé avec la session Phase 1).
- **Python 3.9** : pas de `str | None` (piège #1) → `Optional[str]`.

---

## File Structure

**Node — `mc-agent/` :**

| Fichier | Responsabilité |
|---|---|
| `mc-agent/calibrate.js` | `applyStyle(profile, style)` → nouveau profil avec `params` mergés, `tells` intacts ; `loadStyleFile(path)` (lecture + parse défensifs) |
| `mc-agent/index.js` | + lire `--style`, charger via `loadStyleFile`, `profile = applyStyle(profile, style)` après `loadProfile` |
| `mc-agent/test/calibrate.test.js` | merge déterministe, tells intacts, style absent/corrompu = profil inchangé |

**Python — `backend/bots/` :**

| Fichier | Responsabilité |
|---|---|
| `backend/bots/mc_agent_manager.py` | `start_session(..., style_player=None)` → résout `style.json`, ajoute `--style` |
| `backend/bots/mc_agent_router.py` | `StartReq` + champ `style_player: Optional[str]` ; passé à `start_session` |
| `backend/bots/tests/test_mc_agent_manager.py` | test : `style_player` connu → `--style <path>` dans la commande ; inconnu → pas de `--style` |
| `backend/bots/tests/test_mc_agent_router.py` | test : `/run` avec `style_player` accepté (admin-only déjà couvert) |

**Frontend :**

| Fichier | Responsabilité |
|---|---|
| `frontend/js/bots_module.js` | `<select id="mca-calib">` « Calibrer sur… » peuplé depuis `/api/mc-agent/captures` ; `style_player` envoyé dans `startMCAgent` |
| `frontend/js/lang.js` | clés `mcagent.calibrate*` (FR/EN/IT) |
| `frontend/index.html` | bump `?v=` bots_module.js + lang.js |
| `frontend/sw.js` | bump `CACHE_NAME` |

---

## Task 0 : Baseline verte

- [ ] **Step 1 : Brancher au bon endroit + tree propre**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl"
git branch --show-current
git status --porcelain | grep -vE "build/|\.gradle/" || echo "clean"
```
Expected : branche `feat/mc-agent-phase1b-impl` (ou `feat/mc-agent-phase1b`), pas de fichier `mc-agent/` étranger non commité.

- [ ] **Step 2 : Node + Python verts**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl/mc-agent" && node --test 2>&1 | tail -3
cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl" && source "/Users/massimiliano/omenserver Project/Projet serveur/venv/bin/activate" && python -m pytest backend/bots/tests/ -q 2>&1 | tail -2
```
Expected : Node tout vert, Python `53 passed` (ou plus).

---

## Task 1 : `calibrate.js` — merge style → profil (tells intacts)

**Files :**
- Create : `mc-agent/calibrate.js`
- Test : `mc-agent/test/calibrate.test.js`

- [ ] **Step 1 : Écrire le test qui échoue**

`mc-agent/test/calibrate.test.js` :
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { applyStyle, loadStyleFile } = require('../calibrate');

const baseProfile = {
  id: 'expert', level: 3, label: 'Expert',
  persona: 'p',
  params: { chat: { latencyMeanMs: 2200, latencyStdMs: 1300, typoRate: 0.07 }, errorRate: 0.12, movementJitter: 0.30 },
  tells: ['tell un raisonnement', 'tell deux social'],
};
const style = {
  player: 'Massii_08',
  derivedParams: { chat: { latencyMeanMs: 2600, latencyStdMs: 1400, typoRate: 0.06 }, errorRate: 0.09, movementJitter: 0.34 },
};

test('applyStyle remplace les params chat par ceux du style mesuré', () => {
  const out = applyStyle(baseProfile, style);
  assert.strictEqual(out.params.chat.latencyMeanMs, 2600);
  assert.strictEqual(out.params.chat.typoRate, 0.06);
  assert.strictEqual(out.params.errorRate, 0.09);
  assert.strictEqual(out.params.movementJitter, 0.34);
});

test('applyStyle ne touche JAMAIS les tells (invariant §2)', () => {
  const out = applyStyle(baseProfile, style);
  assert.deepStrictEqual(out.tells, baseProfile.tells);
});

test('applyStyle ne mute pas le profil d origine (pure)', () => {
  applyStyle(baseProfile, style);
  assert.strictEqual(baseProfile.params.chat.latencyMeanMs, 2200);
});

test('applyStyle marque le profil comme calibré (id + label)', () => {
  const out = applyStyle(baseProfile, style);
  assert.match(out.id, /calibrated|Massii_08/);
  assert.match(out.label, /Massii_08/);
});

test('applyStyle sans style (null) retourne le profil inchangé', () => {
  assert.strictEqual(applyStyle(baseProfile, null), baseProfile);
});

test('applyStyle avec style sans derivedParams retourne le profil inchangé', () => {
  assert.strictEqual(applyStyle(baseProfile, { player: 'x' }), baseProfile);
});

test('loadStyleFile retourne null si fichier absent (jamais throw)', () => {
  assert.strictEqual(loadStyleFile('/nope/does/not/exist.json'), null);
});
```

- [ ] **Step 2 : Lancer → échec attendu**

Run : `cd mc-agent && node --test test/calibrate.test.js`
Expected : FAIL (`Cannot find module '../calibrate'`).

- [ ] **Step 3 : Implémenter `mc-agent/calibrate.js`**

```js
'use strict';
// Calibration (spec §8) : applique les statistiques de style mesurées (style.json.derivedParams,
// jalon 1b.1) PAR-DESSUS les params d'un profil. INVARIANT (§2) : ne touche JAMAIS aux tells.
// Fonction pure : retourne un nouveau profil, ne mute pas l'entrée.

const fs = require('fs');

/** Lit un style.json. Retourne l'objet parsé, ou null si absent/illisible (jamais throw). */
function loadStyleFile(p) {
  if (!p) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

/** Fusionne style.derivedParams sur profile.params. tells inchangés. Profil non muté. */
function applyStyle(profile, style) {
  const dp = style && style.derivedParams;
  if (!profile || !dp) return profile;
  const player = style.player || 'capture';
  return {
    ...profile,
    id: `${profile.id}-calibrated-${player}`,
    label: `${profile.label} (calibré ${player})`,
    params: {
      ...profile.params,
      ...dp,
      chat: { ...(profile.params && profile.params.chat), ...(dp.chat || {}) },
    },
    tells: profile.tells, // ← INVARIANT §2 : jamais modifié
    calibratedFrom: player,
  };
}

module.exports = { applyStyle, loadStyleFile };
```

- [ ] **Step 4 : Lancer → succès attendu**

Run : `cd mc-agent && node --test test/calibrate.test.js`
Expected : `# pass 7`.

- [ ] **Step 5 : Commit**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl"
git add mc-agent/calibrate.js mc-agent/test/calibrate.test.js
git commit -m "feat(mc-agent): calibrate — merge style.json sur profil, tells intacts (TDD, spec §8)"
```

---

## Task 2 : `index.js` — appliquer `--style` au profil

**Files :**
- Modify : `mc-agent/index.js`

> `index.js` dépend d'une connexion serveur → pas de test unitaire ; validé par `node --check` + le smoke. La logique de merge est déjà testée en Task 1.

- [ ] **Step 1 : Ajouter l'import**

Dans `mc-agent/index.js`, après la ligne `const { loadProfile } = require('./profiles');` ajouter :
```js
const { applyStyle, loadStyleFile } = require('./calibrate');
```

- [ ] **Step 2 : Appliquer la calibration après le chargement du profil**

Repérer le bloc :
```js
let profile = null;
try {
  profile = loadProfile(args.profile || 'intermediaire');
} catch (e) {
  profile = null;
}
```
et ajouter juste après (hors du try, pour ne pas masquer une erreur de profil) :
```js
// Calibration optionnelle (jalon 1b.2) : --style <chemin style.json> → params réels mesurés.
if (profile && args.style) {
  const style = loadStyleFile(args.style);
  if (style) {
    profile = applyStyle(profile, style);
    emit({ type: 'info', message: `profil calibré sur ${style.player || 'capture'}` });
  }
}
```

- [ ] **Step 3 : Vérifier le parse + le smoke require**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl/mc-agent"
node --check index.js && echo "index.js parse OK"
node --test test/smoke.test.js 2>&1 | tail -3
```
Expected : `index.js parse OK` + smoke vert (le require de `../calibrate` ne throw pas).

- [ ] **Step 4 : Commit**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl"
git add mc-agent/index.js
git commit -m "feat(mc-agent): index — applique --style (calibration) au profil chargé"
```

---

## Task 3 : `mc_agent_manager.py` — résoudre style_player → --style

**Files :**
- Modify : `backend/bots/mc_agent_manager.py`
- Test : `backend/bots/tests/test_mc_agent_manager.py`

- [ ] **Step 1 : Écrire le test qui échoue**

Ajouter à `backend/bots/tests/test_mc_agent_manager.py` :
```python
def test_start_session_adds_style_when_player_has_style(tmp_path, monkeypatch):
    """style_player avec un style.json existant → --style <path> dans la commande Node."""
    from backend.bots import mc_agent_manager as mgr
    from backend.bots import mc_capture_store as store

    # capture dir avec un style.json pour 'Massii_08'
    monkeypatch.setattr(store, "CAPTURES_DIR", tmp_path / "mc-captures")
    player_dir = tmp_path / "mc-captures" / "Massii_08"
    player_dir.mkdir(parents=True)
    (player_dir / "style.json").write_text('{"player":"Massii_08","derivedParams":{}}', encoding="utf-8")

    captured = {}
    class _FakeProc:
        def __init__(self): self.stdout = iter(()); self.stdin = None; self.pid = 1234
        def poll(self): return None
    def _fake_popen(cmd, **kw):
        captured["cmd"] = cmd
        return _FakeProc()
    monkeypatch.setattr(mgr.subprocess, "Popen", _fake_popen)
    monkeypatch.setattr(mgr, "_read_api_key", lambda: "sk-ant-test")

    mgr.start_session("h", 25565, "Bot", None, "offline", "expert", style_player="Massii_08")
    assert "--style" in captured["cmd"]
    idx = captured["cmd"].index("--style")
    assert captured["cmd"][idx + 1].endswith("style.json")


def test_start_session_no_style_when_player_unknown(tmp_path, monkeypatch):
    from backend.bots import mc_agent_manager as mgr
    from backend.bots import mc_capture_store as store
    monkeypatch.setattr(store, "CAPTURES_DIR", tmp_path / "mc-captures")
    captured = {}
    class _FakeProc:
        def __init__(self): self.stdout = iter(()); self.stdin = None; self.pid = 1
        def poll(self): return None
    monkeypatch.setattr(mgr.subprocess, "Popen", lambda cmd, **kw: (captured.update(cmd=cmd) or _FakeProc()))
    monkeypatch.setattr(mgr, "_read_api_key", lambda: "sk-ant-test")
    mgr.start_session("h", 25565, "Bot", None, "offline", "expert", style_player="Ghost")
    assert "--style" not in captured["cmd"]
```

- [ ] **Step 2 : Lancer → échec attendu**

Run : `cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl" && source "/Users/massimiliano/omenserver Project/Projet serveur/venv/bin/activate" && python -m pytest backend/bots/tests/test_mc_agent_manager.py -q 2>&1 | tail -5`
Expected : FAIL (`start_session() got an unexpected keyword argument 'style_player'`).

- [ ] **Step 3 : Modifier `backend/bots/mc_agent_manager.py`**

Ajouter l'import en tête (avec les autres imports `from backend.bots`) :
```python
from backend.bots import mc_capture_store as _capture_store
```

Modifier la signature de `start_session` (ajouter `style_player=None` en dernier paramètre) :
```python
def start_session(host, port, user, model=None, auth="offline", profile=None, style_player=None):
```

Dans `start_session`, après le bloc qui ajoute `--profile` (`if profile: cmd += ["--profile", str(profile)]`), ajouter :
```python
    if style_player:
        # Calibration (1b.2) : si le joueur a un style.json distillé, on le passe au Node.
        style_path = _capture_store.CAPTURES_DIR / _capture_store._safe_player(style_player) / "style.json"
        if style_path.is_file():
            cmd += ["--style", str(style_path)]
```

- [ ] **Step 4 : Lancer → succès attendu**

Run : `cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl" && source "/Users/massimiliano/omenserver Project/Projet serveur/venv/bin/activate" && python -m pytest backend/bots/tests/test_mc_agent_manager.py -q 2>&1 | tail -5`
Expected : tous verts (les 2 nouveaux + les existants).

- [ ] **Step 5 : Commit**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl"
git add backend/bots/mc_agent_manager.py backend/bots/tests/test_mc_agent_manager.py
git commit -m "feat(mc-agent): manager — style_player résout style.json → --style (TDD)"
```

---

## Task 4 : `mc_agent_router.py` — champ style_player dans /run

**Files :**
- Modify : `backend/bots/mc_agent_router.py`
- Test : `backend/bots/tests/test_mc_agent_router.py`

- [ ] **Step 1 : Écrire le test qui échoue**

Ajouter à `backend/bots/tests/test_mc_agent_router.py` (adapter au style des tests existants du fichier — app FastAPI + override `get_current_user` admin) :
```python
def test_run_accepts_style_player(monkeypatch):
    """POST /run avec style_player est accepté et transmis au manager."""
    from backend.bots import mc_agent_router as r
    captured = {}
    monkeypatch.setattr(r.mgr, "has_api_key", lambda: True)
    monkeypatch.setattr(r.mgr, "start_session",
                        lambda *a, **kw: captured.update(args=a, kw=kw) or 7)
    # build app admin (réutiliser le helper du fichier si présent ; sinon inline)
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from backend.auth.utils import get_current_user
    class _U: is_admin = True; username = "a"
    app = FastAPI(); app.include_router(r.router)
    app.dependency_overrides[get_current_user] = lambda: _U()
    client = TestClient(app)
    resp = client.post("/api/mc-agent/run", json={"host": "h", "style_player": "Massii_08"})
    assert resp.status_code == 200
    assert captured["kw"].get("style_player") == "Massii_08" or "Massii_08" in captured["args"]
```

- [ ] **Step 2 : Lancer → échec attendu**

Run : `cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl" && source "/Users/massimiliano/omenserver Project/Projet serveur/venv/bin/activate" && python -m pytest backend/bots/tests/test_mc_agent_router.py -q 2>&1 | tail -5`
Expected : FAIL (`style_player` ignoré / non transmis).

- [ ] **Step 3 : Modifier `backend/bots/mc_agent_router.py`**

Dans la classe `StartReq`, ajouter le champ :
```python
    style_player: Optional[str] = None   # calibration 1b.2 : joueur dont on applique le style.json
```

Dans la fonction `run`, modifier l'appel à `start_session` pour passer `style_player` :
```python
        sid = mgr.start_session(req.host, req.port, req.user, req.model, auth, req.profile,
                                style_player=req.style_player)
```

- [ ] **Step 4 : Lancer → succès attendu + suite complète**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl" && source "/Users/massimiliano/omenserver Project/Projet serveur/venv/bin/activate"
python -m pytest backend/bots/tests/ -q 2>&1 | tail -3
python -c "import backend.main; print('import OK')"
```
Expected : tout vert + `import OK`.

- [ ] **Step 5 : Commit**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl"
git add backend/bots/mc_agent_router.py backend/bots/tests/test_mc_agent_router.py
git commit -m "feat(mc-agent): router — champ style_player dans /run (calibration, TDD)"
```

---

## Task 5 : Frontend — sélecteur « Calibrer sur… »

**Files :**
- Modify : `frontend/js/bots_module.js`, `frontend/js/lang.js`, `frontend/index.html`, `frontend/sw.js`

- [ ] **Step 1 : Clés i18n (3 langues)**

Dans chaque bloc `mcagent: { ... }` de `frontend/js/lang.js`, ajouter (traduire) :

FR : `calibrate_label: 'Calibrer sur (capture)',` · `calibrate_none: 'Aucune (profil standard)',`
EN : `calibrate_label: 'Calibrate on (capture)',` · `calibrate_none: 'None (standard profile)',`
IT : `calibrate_label: 'Calibra su (cattura)',` · `calibrate_none: 'Nessuna (profilo standard)',`

- [ ] **Step 2 : Ajouter le `<select>` dans `openMCAgent`**

Dans le template HTML de `openMCAgent`, juste après le `<div>` du sélecteur de profil (`id="mca-profile"`), ajouter :
```js
        <div><label class="form-label">${Lang.t('mcagent.calibrate_label')}</label>
          <select id="mca-calib" class="form-input"><option value="">${Lang.t('mcagent.calibrate_none')}</option></select>
        </div>
```

- [ ] **Step 3 : Peupler le sélecteur depuis les captures (réutilise l'endpoint 1b.1)**

Dans `loadCaptures()` (créé en 1b.1), à la fin (après avoir rendu la liste), peupler aussi le `<select>` calibration :
```js
    const calib = document.getElementById('mca-calib');
    if (calib) {
      const cur = calib.value;
      calib.innerHTML = `<option value="">${Lang.t('mcagent.calibrate_none')}</option>` +
        caps.map((c) => `<option value="${this._escapeHtml(c.player)}">${this._escapeHtml(c.player)}</option>`).join('');
      calib.value = cur;
    }
```
> Note : `caps` est déjà la liste chargée dans `loadCaptures`. Si la fonction `loadCaptures` retournait tôt sur liste vide, déplacer ce bloc avant le `return` ou recharger `caps` ici.

- [ ] **Step 4 : Envoyer `style_player` dans `startMCAgent`**

Dans `startMCAgent`, là où l'objet body est construit (avec `host`, `port`, `profile`…), ajouter :
```js
      const stylePlayer = (document.getElementById('mca-calib') || {}).value || undefined;
```
et inclure `style_player: stylePlayer` dans le body JSON envoyé à `/api/mc-agent/run`.

- [ ] **Step 5 : Parse JS + cache-bust**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl"
node -e "new Function(require('fs').readFileSync('frontend/js/bots_module.js','utf8'));new Function(require('fs').readFileSync('frontend/js/lang.js','utf8'));console.log('JS parse OK')"
```
Expected : `JS parse OK`. Puis bumper `?v=` de bots_module.js + lang.js dans `index.html`, et `CACHE_NAME` dans `sw.js`.

- [ ] **Step 6 : Commit**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl"
git add frontend/js/bots_module.js frontend/js/lang.js frontend/index.html frontend/sw.js
git commit -m "feat(mc-agent): UI sélecteur Calibrer sur <joueur> + i18n + cache-bust"
```

---

## Task 6 : Doc + vérification finale

**Files :**
- Modify : `CLAUDE.md`

- [ ] **Step 1 : Historique CLAUDE.md**

En tête du tableau `## 📝 Historique récent`, ajouter :
```markdown
| 2026-05-31 | 🎚️ **MC Agent Phase 1b.2 — calibration** : `style.json` distillé (1b.1) applique ses `derivedParams` (latence chat, variance, taux de faute, jitter) PAR-DESSUS les params d'un profil via `mc-agent/calibrate.js` (`applyStyle`, **tells intacts** — invariant §2). `--style` au Node (résolu par `start_session(style_player=…)` → `data/mc-captures/<j>/style.json`), champ `style_player` dans `/run`, sélecteur « Calibrer sur <joueur> » dans l'UI. Sans calibration = comportement Phase 1 inchangé (non-régression testée). Pièges #35/#36. Jalons restants : 1b.3 clone hybride, 1b.4 dream team. |
```

- [ ] **Step 2 : Vérification complète**

Run :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl/mc-agent" && node --test 2>&1 | tail -3
cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl" && source "/Users/massimiliano/omenserver Project/Projet serveur/venv/bin/activate" && python -m pytest backend/bots/tests/ -q 2>&1 | tail -2
```
Expected : Node tout vert (dont `calibrate.test.js` 7), Python tout vert (dont manager + router calibration).

- [ ] **Step 3 : Commit**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-phase1b-impl"
git add CLAUDE.md
git commit -m "docs(mc-agent): historique Phase 1b.2 (calibration)"
```

- [ ] **Step 4 : Smoke e2e manuel (Massii)**

Prérequis : ≥1 capture distillée (style.json) pour un joueur (via le flux 1b.1), backend lancé.
1. Dashboard → Bots → MC Agent → sélecteur **« Calibrer sur <joueur> »** → choisir le joueur.
2. Lancer le bot → l'event `info: profil calibré sur <joueur>` apparaît dans le transcript.
3. Parler au bot → la latence de réponse / les fautes reflètent le style mesuré (vs les constantes Phase 1).

> Définition de « 1b.2 terminé » : `applyStyle` mergé avec tells intacts (testé) · `--style` câblé bout-en-bout · UI sélecteur fonctionnel · sans calibration = Phase 1 inchangé (testé) · tous tests verts.

---

## Self-Review (auteur)

**1. Couverture spec §8 :**
- `derivedParams` merge sur `profile.params` → Task 1 (`applyStyle`). ✅
- `tells` jamais modifiés → Task 1 (test dédié) + code (`tells: profile.tells`). ✅
- `--style` passé au Node → Task 3 (manager) ; lu par Node → Task 2 (index). ✅
- Sans `--style` = Phase 1 inchangé → Task 1 (`applyStyle(p, null) === p`) + Task 2 (gardé derrière `if args.style`). ✅
- UI calibration → Task 5. ✅

**2. Placeholders :** aucun ; code complet à chaque step.

**3. Cohérence des signatures :**
- `applyStyle(profile, style)` / `loadStyleFile(path)` — définis Task 1, consommés Task 2. ✅
- `start_session(..., style_player=None)` — Task 3, appelé Task 4 (router). ✅
- `_capture_store.CAPTURES_DIR` + `_safe_player` — définis en 1b.1, réutilisés Task 3. ✅
- `style.json.derivedParams.{chat:{latencyMeanMs,latencyStdMs,typoRate},errorRate,movementJitter}` — produit en 1b.1, mergé Task 1, lu par `humanize.js` (`profile.params.chat.*`). Forme identique. ✅
- `/api/mc-agent/captures` (liste joueurs) réutilisé pour peupler le sélecteur Task 5. ✅

**4. Pièges projet :** #1 (Optional[str], pas `str|None`), #5 (FormData N/A ici, JSON), #9/#11 (cache-bust), #28 (parse JS). ✅
