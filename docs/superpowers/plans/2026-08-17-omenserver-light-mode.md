# Mode clair « Givre » (Ion light) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter un mode clair « Givre » basculable (toggle ◐ topbar + login, localStorage `omen-mode`, dark par défaut) au frontend OmenServer, sans changer un pixel du dark actuel.

**Architecture:** Un attribut `data-mode="light"` sur `<html>` (symétrique de `data-accent`) active un bloc de tokens light dans style.css ; les vars legacy étant aliasées sur les tokens Bento, tout le site suit. La console reste bleu-nuit via des tokens `--console-*` invariants au mode. Un script inline anti-flash pose l'attribut avant le premier paint.

**Tech Stack:** Vanilla CSS (tokens/custom properties), vanilla JS (app.js pattern `_loadAccent`/`setAccent`), HTML statique (index.html, login.html), Service Worker cache-bust. Zéro dépendance nouvelle, zéro changement backend.

**Spec:** `docs/superpowers/specs/2026-08-17-omenserver-light-mode-design.md`

**Repères code (état au 2026-08-17, RECALÉS sur origin/main `2941310` — style.css fait 4709 l., un 2e `color:#0A0A0A` existe L1170, lang.js `en:` L1533 / `it:` L3034)** :
- `frontend/css/style.css` (4671 l.) : tokens `:root` L69-125, variants accent L130-133, `body` L147-156 (grille hardcodée `rgba(91,140,255,0.08)`), `.brand .logo` L186-197 (`color:#0A0A0A` hardcodé), `.topbar .accent-switcher-mini` L412-424, `.console` legacy L1077, groupe terminal `!important` L3192-3199, `.events-feed` L2266-2293, bloc ION v6 L4302+
- `frontend/index.html` : `<meta theme-color>` L11, `<link style.css?v=121>` L15, fallback `<style>` inline L17-29 (APRÈS le link → gagne à spécificité égale), topbar-right L48-79 (lang-switcher → accent-switcher L54 → user-menu-wrap L61), scripts L91-113 (`lang.js?v=249`, `app.js?v=221`)
- `frontend/login.html` : `<link style.css?v=114>` L9, fallback inline L13-22, `login-card` L26
- `frontend/js/app.js` : `init()` appelle `_loadAccent()` L51 ; `_loadAccent` L157-187, `setAccent` L189-201, `_refreshAccentSwitcher` L203-207
- `frontend/js/lang.js` : blocs `fr:` L32, `en:` L1369, `it:` L2706
- `frontend/sw.js` : `CACHE_NAME = 'omenserver-v142'` L10

---

## Task 0 : Branche isolée

**Files:** aucun (git)

- [ ] **Step 0.1 :** Créer le worktree/branche via la skill `superpowers:using-git-worktrees` : branche `feat/frontend-light-mode` basée sur **`origin/main` fraîchement fetché** (PAS sur la branche courante `feat/mc-agent-water-wall`, PAS sur le main local qui est souvent stale/worktree-locked).

Run: `git fetch origin && git worktree add ../omen-light-mode -b feat/frontend-light-mode origin/main`
Expected: worktree créé, `git -C ../omen-light-mode log --oneline -1` = tête d'origin/main.

- [ ] **Step 0.2 :** Copier dans le worktree les 3 artefacts de design non committés depuis l'arbre principal :

```bash
cp "docs/superpowers/specs/2026-08-17-omenserver-light-mode-design.md" ../omen-light-mode/docs/superpowers/specs/
cp "docs/superpowers/plans/2026-08-17-omenserver-light-mode.md" ../omen-light-mode/docs/superpowers/plans/
cp "docs/superpowers/mockups/2026-08-08-light-directions.html" ../omen-light-mode/docs/superpowers/mockups/
```

- [ ] **Step 0.3 : Commit** — `git add docs/superpowers && git commit -m "docs: spec + plan + mockup du mode clair Givre"`

---

## Task 1 : Tokens light + tokens console + `.mode-btn` (style.css — inerte tant que `data-mode` absent)

**Files:**
- Modify: `frontend/css/style.css` (4 zones : L147 body, L125 fin :root, L133 fin variants accent, L424 fin accent-switcher)

- [ ] **Step 1.1 : Tokeniser la micro-grille.** Dans le `:root` (avant la fermeture L125), ajouter :

```css
    /* Micro-grille body (tokenisée pour le mode clair) */
    --grid-dot: rgba(91, 140, 255, 0.08);
```

et remplacer dans `body` (L149-151) :

```css
    background:
        radial-gradient(rgba(91, 140, 255, 0.08) 1px, transparent 1.5px) 0 0 / 26px 26px,
        var(--bg);
```

par :

```css
    background:
        radial-gradient(var(--grid-dot) 1px, transparent 1.5px) 0 0 / 26px 26px,
        var(--bg);
```

- [ ] **Step 1.2 : Tokens console + néon dans `:root`.** Toujours avant la fermeture du `:root` :

```css
    /* Console / terminal — INVARIANTS au mode (îlot bleu-nuit en light, signature Givre) */
    --console-bg:     #0A101E;
    --console-border: #1C2947;
    --console-text:   #C7D4EC;
    --console-dim:    #5A6C90;
    --console-warn:   #FBBF24;   /* teintes claires FIXES : lisibles sur bleu-nuit */
    --console-err:    #F87171;
    --console-accent: var(--accent);   /* dark : l'accent EST déjà néon */
    --accent-neon:    #00FFB0;         /* valeur néon de l'accent courant (cf. variants) */
```

- [ ] **Step 1.3 : `--accent-neon` par variant.** Compléter les 4 règles existantes L130-133 (ajout en fin de chaque bloc, une décl. par ligne existante) :

```css
[data-accent="cyan"]    { --accent: #00D2FF; --accent-dim: rgba(  0, 210, 255, .14); --accent-glow: rgba(  0, 210, 255, .65); --accent-neon: #00D2FF; }
[data-accent="violet"]  { --accent: #8B5CFF; --accent-dim: rgba(139,  92, 255, .15); --accent-glow: rgba(139,  92, 255, .70); --accent-neon: #8B5CFF; }
[data-accent="magenta"] { --accent: #FF3DA6; --accent-dim: rgba(255,  61, 166, .14); --accent-glow: rgba(255,  61, 166, .65); --accent-neon: #FF3DA6; }
[data-accent="amber"]   { --accent: #FFB020; --accent-dim: rgba(255, 176,  32, .14); --accent-glow: rgba(255, 176,  32, .60); --accent-neon: #FFB020; }
```

- [ ] **Step 1.4 : Bloc light complet.** Immédiatement APRÈS les variants d'accent (après L133), insérer :

```css
/* ============================================================================
   ION LIGHT « Givre » (2026-08-17) — activé par data-mode="light" sur <html>.
   Absence d'attribut = dark (défaut). Réf: specs/2026-08-17-omenserver-light-mode-design.md
   Le dark ne change pas : ce bloc ne fait que REDÉFINIR les tokens.
   ============================================================================ */
html[data-mode="light"] {
    color-scheme: light;   /* form controls / scrollbars natifs (bat la meta color-scheme dark) */

    --bg:        #EBF0FA;
    --bg-elev-1: #F7FAFF;
    --bg-elev-2: #FFFFFF;   /* en light, l'élévation ÉCLAIRCIT (inverse du dark) */
    --bg-elev-3: #E3EAF6;   /* inputs : légèrement enfoncés */

    --border:        #CBD7EB;
    --border-strong: #A9BCDA;

    --text:       #0C1526;
    --text-muted: #46597E;
    --text-dim:   #7C8FB0;

    /* Accent green par défaut — déclinaison foncée (les néons sont illisibles sur blanc) */
    --accent:      #00885C;
    --accent-dim:  rgba(0, 136, 92, 0.11);
    --accent-glow: rgba(0, 136, 92, 0.22);
    --accent-text: #FFFFFF;

    --top-light: rgba(255, 255, 255, 0.85);
    --grid-dot:  rgba(43, 84, 160, 0.10);

    /* Sémantiques par mode : versions foncées lisibles sur clair.
       Les FONDS pastel rgba existants restent tels quels (paire classique). */
    --danger:  #B91C1C;
    --warning: #B45309;
    --info:    #1D4ED8;
    --violet:  #7C3AED;
    --orange:  #C2570A;

    /* Dans la console (qui reste bleu-nuit), l'accent redevient NÉON */
    --console-accent: var(--accent-neon);
}
html[data-mode="light"][data-accent="cyan"]    { --accent: #0077A8; --accent-dim: rgba(  0, 119, 168, .11); --accent-glow: rgba(  0, 119, 168, .22); }
html[data-mode="light"][data-accent="violet"]  { --accent: #6A3FE0; --accent-dim: rgba(106,  63, 224, .12); --accent-glow: rgba(106,  63, 224, .24); }
html[data-mode="light"][data-accent="magenta"] { --accent: #D01C7C; --accent-dim: rgba(208,  28, 124, .11); --accent-glow: rgba(208,  28, 124, .22); }
html[data-mode="light"][data-accent="amber"]   { --accent: #A96A00; --accent-dim: rgba(169, 106,   0, .12); --accent-glow: rgba(169, 106,   0, .22); }

/* Miroir du fallback <style> inline d'index.html/login.html (qui vient APRÈS le
   <link> et gagnerait à spécificité égale). :where() calibre la spécificité à
   (0,0,2) : bat les type-selectors du fallback (0,0,1), perd contre toute
   classe (0,1,0) — les .btn/.badge/etc. restent maîtres. */
html:where([data-mode="light"]) h1, html:where([data-mode="light"]) h2,
html:where([data-mode="light"]) h3, html:where([data-mode="light"]) h4,
html:where([data-mode="light"]) p,  html:where([data-mode="light"]) span,
html:where([data-mode="light"]) td, html:where([data-mode="light"]) th,
html:where([data-mode="light"]) li, html:where([data-mode="light"]) label,
html:where([data-mode="light"]) a {
    color: var(--text);
}
html:where([data-mode="light"]) button, html:where([data-mode="light"]) input,
html:where([data-mode="light"]) select, html:where([data-mode="light"]) textarea {
    background: var(--bg-elev-3);
    color: var(--text);
    border-color: var(--border);
}
html:where([data-mode="light"]) ::placeholder { color: var(--text-muted); }
```

- [ ] **Step 1.5 : Logo → token.** L186-197, remplacer `color: #0A0A0A;` de `.topbar .brand .logo` par `color: var(--accent-text);` (le `:root` définit déjà `--accent-text: #041007` — quasi identique en dark, blanc en light).

- [ ] **Step 1.6 : CSS du bouton ◐.** Après le bloc `.topbar .accent-switcher-mini .accent-dot` (L424), ajouter :

```css
/* Toggle clair/sombre (mode Givre) — topbar + login */
.mode-btn {
    width: 28px;
    height: 28px;
    padding: 0;
    display: grid;
    place-items: center;
    background: var(--bg-elev-2);
    color: var(--text-muted);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    cursor: pointer;
    transition: color var(--t-fast), border-color var(--t-fast);
}
.mode-btn:hover { color: var(--text); border-color: var(--border-strong); }
.mode-btn svg { display: block; }
.login-card .mode-btn { position: absolute; top: 16px; right: 16px; }
```

Vérifier que `.login-card` a `position: relative` (grep `.login-card {` dans style.css) ; si absent, l'ajouter à la règle `.login-card` existante.

- [ ] **Step 1.7 : Garde-fou dark inchangé.** Le seul chemin par lequel ce commit peut toucher le dark : la grille (Step 1.1) et le logo (Step 1.5).

Run: `grep -c "var(--grid-dot)" frontend/css/style.css` → `1` ; `grep -n "0A0A0A" frontend/css/style.css` → plus d'occurrence dans `.brand .logo`.

- [ ] **Step 1.8 : Commit** — `git add frontend/css/style.css && git commit -m "feat(light): tokens Givre + tokens console + .mode-btn (inertes sans data-mode)"`

---

## Task 2 : Console invariante au mode (style.css)

**Files:**
- Modify: `frontend/css/style.css` (L1077 `.console`, L2266 `.events-feed`, L3192 groupe terminal)

- [ ] **Step 2.1 :** Groupe terminal L3192-3199 — remplacer les valeurs en dur par les tokens console :

```css
.console, .console-output, .log-output, .terminal-output {
    background: var(--console-bg) !important;
    border: 1px solid var(--console-border) !important;
    border-radius: var(--r-lg) !important;
    font-family: var(--font-mono) !important;
    color: var(--console-text) !important;
    box-shadow: none !important;
}
```

- [ ] **Step 2.2 :** `.console` legacy L1077 — aligner (il est écrasé par le groupe ci-dessus, mais on ne laisse pas traîner du `#0d0d0d`/`#a0ffa0`) : `background: #0d0d0d;` → `background: var(--console-bg);` et `color: #a0ffa0;` → `color: var(--console-text);`.

- [ ] **Step 2.3 :** `.events-feed` L2266-2293 — migrer vers les tokens console :

```css
.events-feed {
    background: var(--console-bg);
    border: 1px solid var(--console-border);
    /* … padding/radius/font inchangés … */
}
.events-feed .ev .ts { color: var(--console-dim); }
.events-feed .ev .typ { color: var(--console-dim); /* … reste inchangé … */ }
.events-feed .ev .typ.ok   { color: var(--console-accent); }
.events-feed .ev .typ.warn { color: var(--console-warn); }
.events-feed .ev .typ.err  { color: var(--console-err); }
.events-feed .ev .msg { color: var(--console-text); }
```

(Seules les COULEURS changent ; ne pas toucher grid/padding/max-height. La règle ION `L4302+` `.events-feed .ev .msg b { color: var(--text) }` → passer aussi à `var(--console-text)`.)

- [ ] **Step 2.4 : Vérif équivalence dark.** En dark, `--console-bg #0A101E` ≈ ancien `#0A0A0B` (delta invisible, assumé spec §4.5) et `--console-text #C7D4EC` ≈ `#D4D4D8` (léger bleuté, assumé). `.events-feed` dark : `--console-bg #0A101E` = ancien `--bg-elev-1 #0A101E` → identique.

Run: `grep -n "console-bg\|console-text\|console-accent" frontend/css/style.css | wc -l` → ≥ 10.

- [ ] **Step 2.5 : Commit** — `git commit -am "feat(light): console et events-feed sur tokens --console-* (invariants au mode)"`

---

## Task 3 : Audit des couleurs hardcodées (style.css)

**Files:**
- Modify: `frontend/css/style.css` (occurrences listées par le grep ci-dessous)

- [ ] **Step 3.1 : Inventaire.**

Run:
```bash
grep -n "#[0-9A-Fa-f]\{3,8\}\b" frontend/css/style.css | grep -v -E "^(6[0-9]|7[0-9]|8[0-9]|9[0-9]|1[0-2][0-9]|13[0-3]):" 
grep -n "rgba(0, 0, 0\|rgba(0,0,0\|rgba(255, 255, 255\|rgba(255,255,255" frontend/css/style.css
```
(Le premier exclut les lignes 60-133 = tokens :root + variants. Adapter la plage si les insertions des Tasks 1-2 ont décalé les numéros.)

- [ ] **Step 3.2 : Déclarer les tokens d'audit.** Dans `:root` :

```css
    /* Voiles & ombres (tokenisés pour le mode clair) */
    --surface-hint:        rgba(255, 255, 255, 0.04);  /* barres, rails, hover discrets */
    --surface-hint-strong: rgba(255, 255, 255, 0.08);
    --shadow-drop:         rgba(0, 0, 0, 0.38);        /* user-menu, toasts (seules ombres autorisées) */
```

et dans `html[data-mode="light"]` :

```css
    --surface-hint:        rgba(12, 21, 38, 0.04);
    --surface-hint-strong: rgba(12, 21, 38, 0.09);
    --shadow-drop:         rgba(20, 40, 90, 0.16);
```

- [ ] **Step 3.3 : Classer et traiter chaque occurrence** selon la table de la spec §5 :
  1. `rgba(255,255,255, .02-.05)` → `var(--surface-hint)` ; `.06-.10` → `var(--surface-hint-strong)`.
  2. `rgba(0,0,0, .3-.5)` dans un `box-shadow` → `var(--shadow-drop)`.
  3. Fonds sémantiques pastel (`rgba(248,113,113,…)`, `rgba(251,191,36,…)`, `rgba(96,165,250,…)`, `rgba(192,132,252,…)`, `rgba(251,146,60,…)`) → **inchangés**.
  4. Hex = valeur d'un token existant recopiée en dur (ex. `#1C2947`, `#8FA3C4`) → remplacer par le `var(--…)` correspondant.
  5. Hex sémantique clair utilisé comme TEXTE hors console (ex. `#FBBF24` en `color:`) → `var(--warning)` etc. (devient foncé en light — c'est le but).
  6. Couleurs décoratives uniques au dark sans équivalent token (à découvrir) → décision au cas par cas : si visible en light et illisible → tokeniser avec pendant light ; si invisible/inerte → laisser + commentaire `/* dark-only, OK en light : <raison> */`.

- [ ] **Step 3.4 : Contrôle post-audit.**

Run: le grep du Step 3.1 à nouveau.
Expected: ne restent QUE (a) les définitions de tokens (`:root`, variants, bloc light), (b) les fonds pastel sémantiques, (c) les cas commentés `dark-only`.

- [ ] **Step 3.5 : Commit** — `git commit -am "feat(light): audit hardcodés — voiles/ombres/encres tokenisés"`

---

## Task 4 : Pages HTML — anti-flash + bouton ◐ (index.html, login.html)

**Files:**
- Modify: `frontend/index.html` (head L11-15, topbar-right L60-61)
- Modify: `frontend/login.html` (head L8-9, login-card L26, script de page en bas)

- [ ] **Step 4.1 : Vérifier la CSP.**

Run: `grep -n "script-src\|Content-Security-Policy" backend/main.py | head -5`
Expected: `'unsafe-inline'` présent dans `script-src` (les `onclick=` inline du site en dépendent déjà). Si ABSENT → STOP, remonter au contrôleur (il faudra un nonce — hors plan).

- [ ] **Step 4.2 : Anti-flash index.html.** Juste APRÈS `<meta name="theme-color" content="#050810">` (L11) et AVANT le `<link rel="stylesheet">` :

```html
    <script>try{if(localStorage.getItem('omen-mode')==='light'){document.documentElement.setAttribute('data-mode','light');var _m=document.querySelector('meta[name="theme-color"]');if(_m)_m.setAttribute('content','#EBF0FA')}}catch(e){}</script>
```

- [ ] **Step 4.3 : Bouton ◐ index.html.** Entre la fermeture de `.accent-switcher-mini` (L60 `</div>`) et `.user-menu-wrap` (L61) :

```html
                <button class="mode-btn" id="mode-toggle" onclick="App.toggleMode()" aria-pressed="false" title="">
                    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.75 A6.25 6.25 0 0 1 8 14.25 Z" fill="currentColor"/></svg>
                </button>
```

(SVG inline, PAS le caractère ◐ : les sweeps emoji du projet — pièges #15/#17 — strippent des ranges Unicode incluant les formes géométriques ; un glyphe texte finirait en bouton vide.)

- [ ] **Step 4.4 : Anti-flash login.html.** Même script qu'au Step 4.2, APRÈS le `<meta name="description">` (L7) et AVANT le `<link>` (L8-9). (login.html n'a pas de meta theme-color → le script y gère seulement l'attribut ; le `querySelector` rend `null`, le guard `if(_m)` couvre.)

- [ ] **Step 4.5 : Bouton ◐ login.html.** Premier enfant de `.login-card` (L26) :

```html
            <button class="mode-btn" id="mode-toggle" aria-pressed="false" title="">
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.75 A6.25 6.25 0 0 1 8 14.25 Z" fill="currentColor"/></svg>
            </button>
```

et dans le `<script>` de page existant en bas de login.html (celui qui gère le formulaire), ajouter :

```js
// Toggle clair/sombre (standalone — pas d'app.js sur cette page)
(function () {
    var btn = document.getElementById('mode-toggle');
    if (!btn) return;
    function refresh() {
        var light = document.documentElement.getAttribute('data-mode') === 'light';
        btn.setAttribute('aria-pressed', String(light));
        btn.title = (typeof Lang !== 'undefined' && Lang.t) ? Lang.t('common.theme_toggle') : 'Clair / sombre';
    }
    btn.addEventListener('click', function () {
        var light = document.documentElement.getAttribute('data-mode') === 'light';
        if (light) {
            document.documentElement.removeAttribute('data-mode');
            localStorage.removeItem('omen-mode');
        } else {
            document.documentElement.setAttribute('data-mode', 'light');
            localStorage.setItem('omen-mode', 'light');
        }
        refresh();
    });
    refresh();
})();
```

- [ ] **Step 4.6 : Vérif parse.** Ouvrir les deux pages en local (Task 6 fera le rendu complet) ; ici au minimum :

Run: `python3 -c "import html.parser; p=html.parser.HTMLParser(); p.feed(open('frontend/index.html').read()); p.feed(open('frontend/login.html').read()); print('parse ok')"`
Expected: `parse ok`

- [ ] **Step 4.7 : Commit** — `git commit -am "feat(light): anti-flash + bouton mode sur index et login"`

---

## Task 5 : app.js `_loadMode`/`setMode`/`toggleMode` + clé i18n (lang.js)

**Files:**
- Modify: `frontend/js/app.js` (init L51-52, après `_refreshAccentSwitcher` L203-207)
- Modify: `frontend/js/lang.js` (blocs `fr:` L32, `en:` L1369, `it:` L2706)

- [ ] **Step 5.1 : app.js — appel au boot.** Après `this._loadAccent();` (L51), ajouter `this._loadMode();`.

- [ ] **Step 5.2 : app.js — implémentation.** Après `_refreshAccentSwitcher` (L207), ajouter :

```js
    // === MODE CLAIR « Givre » (2026-08-17) ===
    // data-mode="light" sur <html> ; absence = dark (défaut). Persisté omen-mode.
    // L'anti-flash inline d'index.html a déjà posé l'attribut avant le 1er paint —
    // ici on (re)synchronise bouton + meta, source de vérité unique.
    _loadMode() {
        const light = localStorage.getItem('omen-mode') === 'light';
        this._applyMode(light);
    },

    toggleMode() {
        const light = document.documentElement.getAttribute('data-mode') !== 'light';
        if (light) {
            localStorage.setItem('omen-mode', 'light');
        } else {
            localStorage.removeItem('omen-mode');
        }
        this._applyMode(light);
    },

    _applyMode(light) {
        if (light) {
            document.documentElement.setAttribute('data-mode', 'light');
        } else {
            document.documentElement.removeAttribute('data-mode');
        }
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', light ? '#EBF0FA' : '#050810');
        const btn = document.getElementById('mode-toggle');
        if (btn) {
            btn.setAttribute('aria-pressed', String(light));
            if (typeof Lang !== 'undefined') btn.title = Lang.t('common.theme_toggle');
        }
    },
```

- [ ] **Step 5.3 : lang.js — la clé ×3.**

Run d'abord: `grep -n "theme_toggle\|'common'" frontend/js/lang.js | head` puis repérer le FORMAT réel des clés voisines (ex. chercher `accent` : `grep -n "accent" frontend/js/lang.js | head -6`) — clés aplaties `'a.b'` ou objets imbriqués — et suivre EXACTEMENT ce format.

Ajouter dans chaque bloc, à côté des clés `common.*`/`accent.*` existantes :
- `fr` (L32+) : `Basculer clair/sombre`
- `en` (L1369+) : `Toggle light/dark`
- `it` (L2706+) : `Tema chiaro/scuro`
sous la clé `common.theme_toggle`.

- [ ] **Step 5.4 : Vérif parse + smoke (piège #28/#64).**

Run:
```bash
node -e "new Function(require('fs').readFileSync('frontend/js/app.js','utf8')); console.log('app parse ok')"
node -e "new Function(require('fs').readFileSync('frontend/js/lang.js','utf8')); console.log('lang parse ok')"
```
Expected: les deux `parse ok`.

- [ ] **Step 5.5 : Commit** — `git commit -am "feat(light): App.toggleMode/_loadMode + meta theme-color + i18n FR/EN/IT"`

---

## Task 6 : Vérification navigateur locale (dark intact + light complet)

**Files:** aucun à committer (harness en scratchpad si besoin)

- [ ] **Step 6.1 : Servir le frontend du worktree.**

Voie A (complète, si la DB de dev a un compte connu) : `uvicorn backend.main:app --port 8010` en background depuis le worktree, login réel, app complète.
Voie B (fallback sans backend) : `python3 -m http.server 8010 -d frontend` — `login.html` rend entièrement (le POST échouera, on ne teste pas l'API) ; pour le dashboard, harness scratchpad = copier le bloc `<body>` topbar+un échantillon de composants d'index.html dans une page qui charge `css/style.css` en relatif (pattern harness carte MC).

- [ ] **Step 6.2 : DARK INTACT (non-régression, AVANT de tester le light).** Sur chaque page/harness en dark : grille visible, cartes, console/events-feed (delta #0A0A0B→#0A101E invisible), logo, boutons. Comparer à la prod actuelle au screenshot.

- [ ] **Step 6.3 : Bascule.** Clic ◐ → tout passe en Givre sans reload ; re-clic → retour dark. `localStorage['omen-mode']` apparaît/disparaît.

- [ ] **Step 6.4 : Anti-flash.** En light, reload → aucun flash noir (l'attribut est posé avant le paint). Vérifier aussi `getComputedStyle(document.body).backgroundColor` ≈ `rgb(235, 240, 250)`.

- [ ] **Step 6.5 : Matrice accents.** 5 accents × light : valeur accent foncée lisible, badges online, dots. `document.documentElement.dataset` piloté en JS si plus rapide.

- [ ] **Step 6.6 : Console.** En light : events-feed bleu-nuit, `.typ.ok` NÉON (pas l'accent foncé), warn/err teintes claires.

- [ ] **Step 6.7 : Fallback miroir.** En light, vérifier un `<span>` nu et un `<td>` de tableau : texte FONCÉ (le miroir `:where` a battu le fallback inline) ; un `.btn-primary` : toujours accent (le miroir ne l'a pas écrasé).

⚠️ Piège de capture (vécu sur le mockup) : les screenshots du pane traînent ~2 s derrière le DOM et capturent les transitions à mi-course — attendre 2-3 s après chaque bascule, trancher au `getComputedStyle`.

- [ ] **Step 6.8 :** Toute anomalie → corriger dans la tâche concernée, re-commit, re-vérifier. Rien à committer si tout est vert.

---

## Task 7 : Cache-busts

**Files:**
- Modify: `frontend/index.html` (L15 style, L91 lang, L113 app)
- Modify: `frontend/login.html` (L9 style)
- Modify: `frontend/sw.js` (L10)

- [ ] **Step 7.1 :** `index.html` : `style.css?v=122` → `?v=123` ; `lang.js?v=262` → `?v=263` ; `app.js?v=221` → `?v=222`.
- [ ] **Step 7.2 :** `login.html` : `style.css?v=114` → `?v=123` (aligné sur index — même fichier, même version).
- [ ] **Step 7.3 :** `sw.js` : `CACHE_NAME = 'omenserver-v155'` → `'omenserver-v156'`.
- [ ] **Step 7.4 :** ⚠️ Ces valeurs sont celles d'origin/main au 2026-08-17 — le Step 8.2 les re-vérifie après rebase (piège mémoire : toujours bumper AU-DESSUS des valeurs d'origin au moment du push).
- [ ] **Step 7.5 : Commit** — `git commit -am "chore(light): cache-bust style/lang/app/login + sw v143"`

---

## Task 8 : Deploy + vérification prod

**Files:** aucun nouveau (git + navigateur)

- [ ] **Step 8.1 :** `git fetch origin && git rebase origin/main` dans le worktree.
- [ ] **Step 8.2 :** Re-grep les `?v=` et `CACHE_NAME` D'ORIGIN (`git show origin/main:frontend/index.html | grep -F '?v='` etc.) — si origin a bougé au-dessus de nos valeurs, re-bumper au-dessus et amender le commit Task 7.
- [ ] **Step 8.3 :** ⚠️ Pré-push : vérifier qu'aucun run MC/bot n'est en grind (le KillMode=process du piège #51 protège la flotte, mais la règle #56f « ne pas restart omenserver à la main » reste). Push : `git push origin feat/frontend-light-mode:main`. L'auto-deploy (cron 1 min) pull + restart uvicorn.
- [ ] **Step 8.4 : Vérif prod (Chrome MCP, session Massii)** : versions servies (`style.css?v=122`, `app.js?v=222`), SW `omenserver-v143` activé (2 reloads), puis la matrice de la Task 6 en condensé : dark intact → bascule ◐ → reload sans flash → login light → un accent non-vert → console néon.
- [ ] **Step 8.5 :** MAJ `CLAUDE.md` (section Design System) : sous-section « Mode clair Givre » — tokens `data-mode`, clé `omen-mode`, console invariante, miroir `:where` du fallback, sémantiques par mode. + entrée Historique récent.
- [ ] **Step 8.6 : Commit + push docs** — `git commit -am "docs: CLAUDE.md — mode clair Givre" && git push origin feat/frontend-light-mode:main` (ou inclure au push 8.3 si tout est prêt avant).

---

## Self-review du plan (fait à l'écriture)

- **Couverture spec** : §3 mécanisme → Tasks 4-5 ; §4.1-4.4 tokens → Task 1 ; §4.5 console → Tasks 1-2 ; §5 audit → Task 3 ; §6.1 fallback → Task 1 (miroir `:where`) + 6.7 ; §6.3 Chart.js → comportement setAccent assumé (aucun code à changer, vérifié en 8.4 par navigation) ; §6.6 meta → 4.2/5.2 ; §6.7 caches → Task 7 ; §8 vérif → Tasks 6 et 8.
- **Spécificité du miroir** : `html:where([data-mode="light"]) button` = (0,0,2) — bat le fallback (0,0,1), perd contre `.btn` (0,1,0). C'est LE point subtil du plan.
- **Cohérence noms** : `omen-mode` / `data-mode` / `mode-toggle` / `App.toggleMode` / `_applyMode` / `common.theme_toggle` — uniformes entre Tasks 4 et 5.
- **IDs dupliqués** : `mode-toggle` existe dans index.html ET login.html — jamais chargés ensemble, pas de collision.
