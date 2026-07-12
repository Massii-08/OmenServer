# OmenServer v6 « Ion » — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rethèmer tout le frontend en direction « Ion » (bleu-nuit + néon-information) avec la couche motion complète, sans toucher structure/layout ni backend.

**Architecture:** Les tokens Bento v5 gardent leurs NOMS et changent de VALEURS (`:root` de style.css) → tout le site suit, y compris les overrides legacy de PR7, car les vars legacy deviennent des alias des tokens Bento. La couche motion s'étend en FIN de style.css (gagne la cascade) + `anim.js` v2 (nav morphing). Les 5 accents réutilisent le mécanisme `data-accent` existant.

**Tech Stack:** Vanilla CSS/JS, zéro dépendance, zéro build. Spec : `docs/superpowers/specs/2026-07-12-omenserver-ion-redesign-design.md`. Mockup de référence : `docs/superpowers/mockups/2026-07-12-ion-directions.html` (direction B = cible exacte : couleurs, timings, easings).

**Vérité terrain (lue le 2026-07-12)** — repères dans le code actuel :
- `frontend/css/style.css` (4291 lignes) : `@import` fonts L9 · vars legacy L12-55 (`--bg-primary:#0f0f1a`…) · tokens Bento L69-121 · accents 4 couleurs L126-128 · `body` L142-149 · couche micro-anim existante L4200-4290 (`.view-enter`, `omen-rise/fade/breathe/skel`, bloc reduced-motion L4279+)
- `frontend/js/app.js` : `_accents` L149 · `_loadAccent()` L152 · `setAccent()` L179 · `_refreshAccentSwitcher()` L193 · hook `Anim.pageEnter()` L361
- `frontend/js/anim.js` : 77 lignes, `Anim.reduced`, `pageEnter`, `countUp`
- `frontend/index.html` : css `?v=111` L15 · fallback inline dark L19-29 · topbar L34-78 (nav-tabs L39-47, accent dots L54-59) · scripts versionnés L90-111 (`anim.js?v=1`, `app.js?v=219`, `lang.js?v=237`)
- `frontend/login.html` : css `?v=108` L9 · fallback inline L13-22
- `frontend/sw.js` : `CACHE_NAME = 'omenserver-v124'` L10
- `frontend/js/lang.js` : clés accents FR L255-259, EN L1516-1520, IT L2777-2781

⚠️ Les numéros de ligne dérivent après chaque édition — utiliser les ANCRES texte (old_string) données dans chaque étape, jamais les numéros seuls.

---

### Task 0 : Branche isolée + commit spec/mockup

**Files:**
- Create: worktree `feat/frontend-ion` (via skill superpowers:using-git-worktrees)
- Commit: `docs/superpowers/specs/2026-07-12-omenserver-ion-redesign-design.md`, `docs/superpowers/plans/2026-07-12-omenserver-ion-redesign.md`, `docs/superpowers/mockups/2026-07-12-ion-directions.html`

- [ ] **Step 0.1 : Créer le worktree depuis origin/main à jour**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur"
git fetch origin
git worktree add ../omen-worktrees/frontend-ion -b feat/frontend-ion origin/main
```
Expected: worktree créé sur `feat/frontend-ion` basé sur origin/main (PAS sur le main local, souvent stale).

- [ ] **Step 0.2 : Copier spec + plan + mockup dans le worktree** (ils sont untracked dans le checkout principal)

```bash
W="/Users/massimiliano/omenserver Project/omen-worktrees/frontend-ion"
S="/Users/massimiliano/omenserver Project/Projet serveur"
mkdir -p "$W/docs/superpowers/specs" "$W/docs/superpowers/plans" "$W/docs/superpowers/mockups"
cp "$S/docs/superpowers/specs/2026-07-12-omenserver-ion-redesign-design.md" "$W/docs/superpowers/specs/"
cp "$S/docs/superpowers/plans/2026-07-12-omenserver-ion-redesign.md" "$W/docs/superpowers/plans/"
cp "$S/docs/superpowers/mockups/2026-07-12-ion-directions.html" "$W/docs/superpowers/mockups/"
```

- [ ] **Step 0.3 : Commit**

```bash
cd "$W"
git add docs/superpowers
git commit -m "docs(frontend): spec + plan + mockup refonte Ion v6"
```

Toutes les étapes suivantes s'exécutent DANS le worktree.

---

### Task 1 : Tokens Ion — style.css (`:root`, accents, body, fonts)

**Files:**
- Modify: `frontend/css/style.css` (L9, L12-55, L69-121, L126-128, L142-149)

- [ ] **Step 1.1 : Remplacer l'import fonts (Inter → Geist)**

Ancre L9 :
```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=Geist+Mono:wght@400;500;600&display=swap');
```
Remplacer par :
```css
@import url('https://fonts.googleapis.com/css2?family=Geist:wght@100..900&family=Geist+Mono:wght@400;500;600&display=swap');
```

- [ ] **Step 1.2 : Aliaser les vars legacy vers les tokens Bento** (sinon `body{background:var(--bg-primary)}` et tous les composants non migrés restent sur l'ancienne palette)

Dans le bloc `:root` legacy (L12-37), remplacer :
```css
    /* Couleurs principales */
    --bg-primary: #0f0f1a;
    --bg-secondary: #1a1a2e;
    --bg-card: #1e1e36;
    --bg-input: #252540;
    --bg-sidebar: #12121f;

    /* Texte */
    --text-primary: #e8e8f0;
    --text-secondary: #9ca3af;
    --text-muted: #6b7280;
```
par :
```css
    /* Couleurs principales — ALIAS des tokens Bento/Ion v6 (le bloc Bento plus bas est la source de vérité) */
    --bg-primary: var(--bg);
    --bg-secondary: var(--bg-elev-1);
    --bg-card: var(--bg-elev-1);
    --bg-input: var(--bg-elev-3);
    --bg-sidebar: var(--bg);

    /* Texte — alias idem */
    --text-primary: var(--text);
    --text-secondary: var(--text-muted);
    --text-muted: #8FA3C4; /* redéfini par le bloc Bento ; gardé ici par sécurité de cascade */
```
Et remplacer :
```css
    /* Bordures */
    --border-color: rgba(255, 255, 255, 0.06);
    --border-active: rgba(16, 185, 129, 0.3);
```
par :
```css
    /* Bordures — alias */
    --border-color: var(--border);
    --border-active: var(--accent-dim);
```
Ne PAS toucher `--accent-green/red/...` legacy ni les shadows (composants legacy divers ; hors périmètre).

- [ ] **Step 1.3 : Nouvelles valeurs des tokens Bento (bloc L69-121)**

Remplacer les valeurs (mêmes noms) :
```css
    /* Surfaces (3-level depth — replaces --bg-primary/secondary/tertiary etc.) */
    --bg:        #050810;  /* fond bleu-nuit Ion */
    --bg-elev-1: #0A101E;  /* base cards, default surface */
    --bg-elev-2: #0E1526;  /* big/featured cards, hover state */
    --bg-elev-3: #131C33;  /* inputs, avatars, code blocks */

    /* Borders */
    --border:        #1C2947;  /* hairline bleutée */
    --border-strong: #2C4066;  /* emphasized */

    /* Text */
    --text:       #EDF2FA;  /* primary */
    --text-muted: #8FA3C4;  /* secondary */
    --text-dim:   #5A6C90;  /* tertiary, timestamps */

    /* Accent (changeable via data-accent attribute on <html>) */
    --accent:      #00FFB0;              /* vert électrique — défaut Ion */
    --accent-dim:  rgba(0, 255, 176, 0.14);
    --accent-glow: rgba(0, 255, 176, 0.65);  /* NOUVEAU — halo du vivant */
    --accent-text: #041007;              /* contrast on accent bg */

    /* Lumière haute des cartes (NOUVEAU) */
    --top-light: rgba(140, 180, 255, 0.07);
```
Le reste du bloc (semantic, radii, spacing, motion) : inchangé SAUF
```css
    --font-ui:   'Geist', system-ui, sans-serif;
```

- [ ] **Step 1.4 : 5 accents (remplace le bloc 4 couleurs L126-128)**

```css
/* === Ion accent variants ===
   Défaut :root = green (#00FFB0). data-accent sur <html> pour les autres.
   Migration v5 : blue→cyan, red→magenta, yellow→amber (app.js _legacyAccentMap). */
[data-accent="cyan"]    { --accent: #00D2FF; --accent-dim: rgba(  0, 210, 255, .14); --accent-glow: rgba(  0, 210, 255, .65); }
[data-accent="violet"]  { --accent: #8B5CFF; --accent-dim: rgba(139,  92, 255, .15); --accent-glow: rgba(139,  92, 255, .70); }
[data-accent="magenta"] { --accent: #FF3DA6; --accent-dim: rgba(255,  61, 166, .14); --accent-glow: rgba(255,  61, 166, .65); }
[data-accent="amber"]   { --accent: #FFB020; --accent-dim: rgba(255, 176,  32, .14); --accent-glow: rgba(255, 176,  32, .60); }
```

- [ ] **Step 1.5 : body — Geist + micro-grille pointillée**

Ancre (L142-149) :
```css
body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    background: var(--bg-primary);
```
Remplacer par :
```css
body {
    font-family: var(--font-ui);
    background:
        radial-gradient(rgba(91, 140, 255, 0.08) 1px, transparent 1.5px) 0 0 / 26px 26px,
        var(--bg);
```
(le reste du bloc body inchangé)

- [ ] **Step 1.6 : Vérifier qu'aucun 'Inter' ne survit + sanité CSS**

```bash
grep -n "Inter" frontend/css/style.css
```
Expected: 0 résultat (sinon corriger).
```bash
grep -c "accent-glow" frontend/css/style.css
```
Expected: ≥ 5 (1 :root + 4 variants).

- [ ] **Step 1.7 : Contrôle visuel rapide des tokens** — servir le CSS seul et inspecter

```bash
python3 - << 'EOF'
import re
css = open('frontend/css/style.css').read()
assert '#00FFB0' in css and '#050810' in css
assert css.count('[data-accent=') == 4
assert 'var(--bg-primary)' not in css[css.find('body {'):css.find('body {')+400]
print('tokens OK')
EOF
```
Expected: `tokens OK`

- [ ] **Step 1.8 : Commit**

```bash
git add frontend/css/style.css
git commit -m "feat(ion): tokens v6 — palette bleu-nuit, vert électrique, 5 accents, Geist, micro-grille"
```

---

### Task 2 : app.js — 5 accents + migration des anciens noms

**Files:**
- Modify: `frontend/js/app.js` (L149-150, L152-177)

- [ ] **Step 2.1 : Étendre la liste + table de migration**

Ancre :
```js
 _accents: ['green', 'blue', 'red', 'yellow'],
 _legacyThemeToAccent: { default: 'green', emerald: 'green', midnight: 'blue', crimson: 'red' },
```
Remplacer par :
```js
 _accents: ['green', 'cyan', 'violet', 'magenta', 'amber'],
 _legacyThemeToAccent: { default: 'green', emerald: 'green', midnight: 'blue', crimson: 'red' },
 // Migration v5 → v6 : anciens noms d'accent vers les néons Ion
 _legacyAccentMap: { blue: 'cyan', red: 'magenta', yellow: 'amber' },
```

- [ ] **Step 2.2 : Migrer la valeur localStorage dans `_loadAccent()`**

Ancre (début de `_loadAccent`, après la migration legacy theme) :
```js
 // 2. Apply accent to <html>
 const accent = localStorage.getItem('omen-accent') || 'green';
```
Remplacer par :
```js
 // 1bis. Migration v5 → v6 des noms d'accent (blue/red/yellow n'existent plus)
 const stored = localStorage.getItem('omen-accent');
 if (stored && this._legacyAccentMap[stored]) {
 localStorage.setItem('omen-accent', this._legacyAccentMap[stored]);
 }
 // 2. Apply accent to <html>
 const accent = localStorage.getItem('omen-accent') || 'green';
```
NB : `_legacyThemeToAccent` peut encore produire `blue`/`red` (vieux `omen-theme`) — la migration 1bis passe APRÈS et rattrape ces valeurs. Garder cet ordre.

- [ ] **Step 2.3 : Parse check (réflexe piège #28)**

```bash
node -e "new Function(require('fs').readFileSync('frontend/js/app.js','utf8')); console.log('app.js parse OK')"
```
Expected: `app.js parse OK`

- [ ] **Step 2.4 : Test de migration en Node (logique pure, sans DOM)**

```bash
node -e "
const map = { blue: 'cyan', red: 'magenta', yellow: 'amber' };
const cases = { blue:'cyan', red:'magenta', yellow:'amber', green:undefined, cyan:undefined };
for (const [oldv, expected] of Object.entries(cases)) {
  const got = map[oldv];
  if (got !== expected) { console.error('FAIL', oldv, got); process.exit(1); }
}
console.log('migration map OK');
"
```
Expected: `migration map OK`

- [ ] **Step 2.5 : Commit**

```bash
git add frontend/js/app.js
git commit -m "feat(ion): 5 accents néon + migration localStorage blue/red/yellow → cyan/magenta/amber"
```

---

### Task 3 : index.html dots + lang.js + CSS des dots

**Files:**
- Modify: `frontend/index.html` (L54-59), `frontend/js/lang.js` (3 blocs), `frontend/css/style.css` (règles `.accent-dot`)

- [ ] **Step 3.1 : 5 dots dans la topbar**

Ancre (index.html L54-59) :
```html
                <div class="accent-switcher-mini" id="accent-switcher" title="Couleur d'accent">
                    <span class="accent-dot" data-acc="green" title="Vert"></span>
                    <span class="accent-dot" data-acc="blue" title="Bleu"></span>
                    <span class="accent-dot" data-acc="red" title="Rouge"></span>
                    <span class="accent-dot" data-acc="yellow" title="Jaune"></span>
                </div>
```
Remplacer par :
```html
                <div class="accent-switcher-mini" id="accent-switcher" title="Couleur d'accent">
                    <span class="accent-dot" data-acc="green" title="Vert"></span>
                    <span class="accent-dot" data-acc="cyan" title="Cyan"></span>
                    <span class="accent-dot" data-acc="violet" title="Violet"></span>
                    <span class="accent-dot" data-acc="magenta" title="Magenta"></span>
                    <span class="accent-dot" data-acc="amber" title="Ambre"></span>
                </div>
```

- [ ] **Step 3.2 : Couleurs des dots dans style.css**

Localiser les règles existantes :
```bash
grep -n 'accent-dot\[data-acc' frontend/css/style.css
```
Remplacer le bloc trouvé (4 couleurs green/blue/red/yellow) par :
```css
.accent-dot[data-acc="green"]   { background: #00FFB0; }
.accent-dot[data-acc="cyan"]    { background: #00D2FF; }
.accent-dot[data-acc="violet"]  { background: #8B5CFF; }
.accent-dot[data-acc="magenta"] { background: #FF3DA6; }
.accent-dot[data-acc="amber"]   { background: #FFB020; }
.accent-dot.active { box-shadow: 0 0 0 2px var(--bg), 0 0 0 3.5px currentColor, 0 0 10px var(--accent-glow); }
```
⚠️ Adapter la règle `.active` au style existant trouvé par le grep (garder le pattern actuel si différent, juste ajouter le glow).

- [ ] **Step 3.3 : Clés lang (FR L255-259, EN L1516-1520, IT L2777-2781)**

FR — ancre :
```js
            'accent.green': 'Vert',
            'accent.blue': 'Bleu',
            'accent.red': 'Rouge',
            'accent.yellow': 'Jaune',
```
Remplacer par :
```js
            'accent.green': 'Vert',
            'accent.cyan': 'Cyan',
            'accent.violet': 'Violet',
            'accent.magenta': 'Magenta',
            'accent.amber': 'Ambre',
```
EN — même opération : `'Green'/'Cyan'/'Violet'/'Magenta'/'Amber'`.
IT — même opération : `'Verde'/'Ciano'/'Viola'/'Magenta'/'Ambra'`.

- [ ] **Step 3.4 : Parse check lang.js + vérif croisée**

```bash
node -e "new Function(require('fs').readFileSync('frontend/js/lang.js','utf8')); console.log('lang.js parse OK')"
grep -c "accent.cyan\|accent.violet\|accent.magenta\|accent.amber" frontend/js/lang.js
```
Expected: parse OK, count = 12 (4 clés × 3 langues).

- [ ] **Step 3.5 : Commit**

```bash
git add frontend/index.html frontend/js/lang.js frontend/css/style.css
git commit -m "feat(ion): switcher 5 dots néon + i18n FR/EN/IT"
```

---

### Task 4 : Couche motion CSS (fin de style.css)

**Files:**
- Modify: `frontend/css/style.css` — bloc micro-anim existant (~L4200) + APPEND en fin de fichier

Rappel des 2 règles Ion : glow = vivant uniquement ; mouvement = transform/opacity uniquement.

- [ ] **Step 4.1 : Upgrade de la cascade d'entrée existante**

Ancre (~L4209) :
```css
    animation: omen-rise .55s cubic-bezier(.2, .7, .2, 1) backwards;
```
Remplacer par :
```css
    animation: omen-rise .65s cubic-bezier(.26, 1.2, .4, 1) backwards;
```
Ancre :
```css
@keyframes omen-rise { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: none; } }
```
Remplacer par :
```css
@keyframes omen-rise { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: none; } }
```
Puis remplacer les 6 lignes de délais `nth-child` (L4212-4217) : `.045s/.09s/.135s/.18s/.225s/.27s` → `.07s/.14s/.21s/.28s/.35s/.42s`.

- [ ] **Step 4.2 : Append du bloc Ion en FIN de style.css** (après tout, pour gagner la cascade sans !important)

```css
/* ============================================================================
   ION v6 — Couche motion & néon (2026-07-12)
   Règles : glow = information vivante uniquement ; transform/opacity only.
   Easings signature : entrée .26,1.2,.4,1 · morphing .3,1.25,.45,1 · hover .34,1.35,.5,1
   ============================================================================ */

/* --- Lumière haute + hover ressort sur les surfaces --- */
.stat-card, .machine-card, .bot-card-bento, .mod-card, .card {
    box-shadow: inset 0 1px 0 var(--top-light);
    transition: transform .3s cubic-bezier(.34, 1.35, .5, 1), border-color .25s, box-shadow .3s;
}
.stat-card:hover, .machine-card:hover, .bot-card-bento:hover, .mod-card:hover {
    transform: translateY(-2px);
    border-color: color-mix(in srgb, var(--accent) 30%, var(--border-strong));
    box-shadow: inset 0 1px 0 var(--top-light), 0 0 26px -8px var(--accent-glow);
}

/* --- Sweep radar one-shot au survol des stat-cards --- */
.stat-card { position: relative; overflow: hidden; }
.stat-card::after {
    content: ''; position: absolute; inset: 0; pointer-events: none; opacity: 0;
    background: linear-gradient(105deg, transparent 40%, color-mix(in srgb, var(--accent) 8%, transparent) 50%, transparent 60%);
    transform: translateX(-120%);
}
.stat-card:hover::after { opacity: 1; animation: omen-sweep .8s ease-out 1; }
@keyframes omen-sweep { to { transform: translateX(120%); } }

/* --- Orbite conique — carte maîtresse du Dashboard uniquement --- */
@property --omen-ang { syntax: '<angle>'; initial-value: 0deg; inherits: false; }
.bento-overview .stat-card.big { position: relative; }
.bento-overview .stat-card.big::before {
    content: ''; position: absolute; inset: -1px; border-radius: inherit; padding: 1.5px; pointer-events: none;
    background: conic-gradient(from var(--omen-ang), transparent 0 70%, var(--accent) 88%, transparent 100%);
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    -webkit-mask-composite: xor; mask-composite: exclude;
    animation: omen-orbit 4s linear infinite;
    filter: drop-shadow(0 0 4px var(--accent-glow));
}
@keyframes omen-orbit { to { --omen-ang: 360deg; } }
/* Sans @property (vieux Safari) : arc statique — dégradation acceptée (spec §6). */

/* --- Glow du vivant : statuts online/running, dots, badges LIVE --- */
.badge.online, .status-badge.running, .status-badge.online, .spill.on {
    box-shadow: 0 0 10px -3px var(--accent-glow);
}
.pulse-dot, .machine-card .m-dot.online {
    box-shadow: 0 0 7px var(--accent-glow);
}

/* --- Logo shine one-shot (topbar + login) --- */
.topbar .logo, .login-logo { position: relative; overflow: hidden; }
.topbar .logo::after, .login-logo::after {
    content: ''; position: absolute; inset: 0; pointer-events: none;
    background: linear-gradient(115deg, transparent 30%, rgba(255, 255, 255, .35) 50%, transparent 70%);
    transform: translateX(-110%);
    animation: omen-shine 1.4s .8s ease-out 1;
}
@keyframes omen-shine { to { transform: translateX(110%); } }

/* --- Nav morphing (indicateur créé par anim.js navInit) --- */
.nav-tabs { position: relative; }
.nav-ind {
    position: absolute; top: 6px; bottom: 6px; left: 0; width: 0; z-index: 0;
    border-radius: 8px; opacity: 0; pointer-events: none;
    background: var(--bg-elev-3);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border-strong));
    box-shadow: 0 0 16px -5px var(--accent-glow);
    transition: left .35s cubic-bezier(.3, 1.25, .45, 1), width .35s cubic-bezier(.3, 1.25, .45, 1), opacity .2s;
}
.nav-ind.on { opacity: 1; }
.nav-tab { position: relative; z-index: 1; }

/* --- Utilitaire : arrivée d'une ligne de feed (append incrémental UNIQUEMENT,
       jamais sur un re-render complet de liste — règle anti-noise du poll) --- */
.ev-in { animation: omen-ev-in .45s cubic-bezier(.3, 1.2, .4, 1) both; }
@keyframes omen-ev-in { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }

/* --- Reduced motion : neutralise la couche Ion --- */
@media (prefers-reduced-motion: reduce) {
    .stat-card, .machine-card, .bot-card-bento, .mod-card, .card,
    .nav-ind { transition: none; }
    .stat-card:hover, .machine-card:hover, .bot-card-bento:hover, .mod-card:hover { transform: none; }
    .stat-card:hover::after,
    .bento-overview .stat-card.big::before,
    .topbar .logo::after, .login-logo::after,
    .ev-in { animation: none; }
}
```

- [ ] **Step 4.3 : Vérifier les classes réelles ciblées par le bloc glow**

```bash
grep -n "class=\"badge\|status-badge\|pulse-dot" frontend/js/*.js | head -20
```
Ajuster les sélecteurs du bloc « Glow du vivant » aux classes RÉELLEMENT rendues par les modules (garder uniquement celles qui existent, ajouter celles trouvées avec statut online/running). Ne pas glow-er un statut stopped/offline.

- [ ] **Step 4.4 : Sanité CSS**

```bash
python3 - << 'EOF'
css = open('frontend/css/style.css').read()
assert css.count('@keyframes omen-sweep') == 1
assert css.count('@keyframes omen-orbit') == 1
assert css.count('@keyframes omen-shine') == 1
assert '@property --omen-ang' in css
assert css.count('{') == css.count('}'), 'accolades déséquilibrées'
print('motion CSS OK')
EOF
```
Expected: `motion CSS OK`

- [ ] **Step 4.5 : Commit**

```bash
git add frontend/css/style.css
git commit -m "feat(ion): couche motion — cascade ressort, sweep radar, orbite conique, glow vivant, logo shine, nav-ind"
```

---

### Task 5 : anim.js v2 — nav morphing

**Files:**
- Modify: `frontend/js/anim.js` (ajout `navInit` + hook dans `pageEnter`)

- [ ] **Step 5.1 : Ajouter `navInit()` à l'objet Anim** (après `countUp`, avant la fermeture de l'objet)

```js
    /**
     * Indicateur morphing de la topbar : un pill .nav-ind glisse sous l'onglet
     * actif (et suit le survol). Créé une seule fois, idempotent.
     * Reduced-motion : le CSS neutralise la transition (saut instantané, OK).
     */
    _navMove: null,

    navInit() {
        const tabs = document.getElementById('nav-tabs');
        if (!tabs || tabs.querySelector('.nav-ind')) return;
        const ind = document.createElement('span');
        ind.className = 'nav-ind';
        ind.setAttribute('aria-hidden', 'true');
        tabs.prepend(ind);
        const move = (el) => {
            if (!el) { ind.classList.remove('on'); return; }
            ind.style.left = el.offsetLeft + 'px';
            ind.style.width = el.offsetWidth + 'px';
            ind.classList.add('on');
        };
        const active = () => tabs.querySelector('.nav-tab.active');
        tabs.addEventListener('mouseover', (e) => {
            const t = e.target.closest('.nav-tab');
            if (t) move(t);
        });
        tabs.addEventListener('mouseleave', () => move(active()));
        this._navMove = () => move(active());
        window.addEventListener('resize', this._navMove);
        this._navMove();
    },
```

- [ ] **Step 5.2 : Repositionner l'indicateur à chaque navigation**

Dans `pageEnter()`, ajouter juste avant la fin de la méthode (après le `setTimeout` existant) :
```js
        if (this._navMove) requestAnimationFrame(this._navMove);
```
⚠️ Vérifier dans app.js (autour de L361) que la classe `.active` des nav-tabs est mise à jour AVANT l'appel `Anim.pageEnter()` — sinon déplacer le rAF en conséquence :
```bash
grep -n -B5 "Anim.pageEnter" frontend/js/app.js
```

- [ ] **Step 5.3 : Appeler `navInit` au boot**

Dans app.js, ancre (L51) :
```js
 this._loadAccent();
```
Remplacer par :
```js
 this._loadAccent();
 if (typeof Anim !== 'undefined') Anim.navInit();
```

- [ ] **Step 5.4 : Parse checks**

```bash
node -e "new Function(require('fs').readFileSync('frontend/js/anim.js','utf8')); console.log('anim.js parse OK')"
node -e "new Function(require('fs').readFileSync('frontend/js/app.js','utf8')); console.log('app.js parse OK')"
```
Expected: 2 × parse OK.

- [ ] **Step 5.5 : Commit**

```bash
git add frontend/js/anim.js frontend/js/app.js
git commit -m "feat(ion): nav morphing — indicateur pill glissant sous l'onglet actif/survolé"
```

---

### Task 6 : index.html + login.html — fallback styles, theme-color, moment login

**Files:**
- Modify: `frontend/index.html` (L11, L19-29), `frontend/login.html` (L13-22)

- [ ] **Step 6.1 : index.html — theme-color + fallback Ion**

Ancre L11 : `<meta name="theme-color" content="#0f0f1a">` → `<meta name="theme-color" content="#050810">`.

Dans le bloc fallback `<style>` (L19-29), substitutions :
- `#0E0E10` → `#050810`
- `#F4F4F5` → `#EDF2FA` (2 occurrences : html/body + sélecteur h1…)
- `#1F1F23` → `#131C33`
- `#27272A` → `#1C2947` (2 occurrences : border inputs + th,td)
- `#A1A1AA` → `#8FA3C4`
- `'Inter'` → `'Geist'`

- [ ] **Step 6.2 : login.html — mêmes substitutions dans son bloc fallback (L13-22)**

Identiques à 6.1 (mêmes hex, `'Inter'` → `'Geist'`).

- [ ] **Step 6.3 : Vérif : aucun ancien hex de fond ne survit dans les 2 html**

```bash
grep -n "#0E0E10\|#0f0f1a\|Inter" frontend/index.html frontend/login.html
```
Expected: 0 résultat.

- [ ] **Step 6.4 : Moment signature login** — le shine du logo est déjà couvert par Task 4 (`.login-logo::after`). Vérifier que la cascade d'entrée du formulaire existe : la `.login-card` a la classe `fade-in`. Si `fade-in` est un simple fade (grep style.css), le laisser — le shine + tokens suffisent (YAGNI).

```bash
grep -n "\.fade-in" frontend/css/style.css | head -3
```

- [ ] **Step 6.5 : Commit**

```bash
git add frontend/index.html frontend/login.html
git commit -m "feat(ion): fallback styles + theme-color alignés sur la palette bleu-nuit"
```

---

### Task 7 : Cache-bust + Service Worker

**Files:**
- Modify: `frontend/index.html` (L15, L90-111), `frontend/login.html` (L9), `frontend/sw.js` (L10)

- [ ] **Step 7.1 : Bumps** (valeurs de départ — RE-VÉRIFIER contre origin/main au moment du push, cf. Task 9)

- `index.html` L15 : `style.css?v=111` → `style.css?v=112`
- `index.html` : `anim.js?v=1` → `anim.js?v=2` · `app.js?v=219` → `app.js?v=220` · `lang.js?v=237` → `lang.js?v=238`
- `login.html` L9 : `style.css?v=108` → `style.css?v=112` (aligné sur index)
- `sw.js` L10 : `omenserver-v124` → `omenserver-v125`

⚠️ Piège #35-bis : seuls les JS MODIFIÉS se bump (anim, app, lang). Ne pas toucher les autres `?v=`.

- [ ] **Step 7.2 : Vérif**

```bash
grep -n "style.css?v=\|anim.js?v=\|app.js?v=\|lang.js?v=" frontend/index.html frontend/login.html && grep -n "CACHE_NAME" frontend/sw.js
```
Expected: v112 ×2, anim v2, app v220, lang v238, omenserver-v125.

- [ ] **Step 7.3 : Commit**

```bash
git add frontend/index.html frontend/login.html frontend/sw.js
git commit -m "chore(ion): cache-bust css v112 + anim v2 + app v220 + lang v238 + sw v125"
```

---

### Task 8 : Vérification visuelle locale (Browser pane — AVANT push)

**Files:** aucun (vérification). Serveur dev : TOUJOURS via `preview_start` (jamais Bash).

- [ ] **Step 8.1 : Créer `.claude/launch.json` dans le worktree s'il n'existe pas**

```json
{
  "version": "0.0.1",
  "configurations": [
    { "name": "omenserver-dev", "runtimeExecutable": "./venv/bin/uvicorn", "runtimeArgs": ["backend.main:app", "--port", "8010"], "port": 8010 }
  ]
}
```
⚠️ Le venv vit dans le checkout principal — si absent du worktree, pointer `runtimeExecutable` vers `"/Users/massimiliano/omenserver Project/Projet serveur/venv/bin/uvicorn"` et lancer avec cwd du worktree. Si le backend refuse de démarrer (DB, .env), fallback : `python3 -m http.server` sur `frontend/` pour vérifier login.html + CSS statiquement.

- [ ] **Step 8.2 : Page login (sans auth)** — preview_start + screenshot :
fond `#050810` + micro-grille, Geist rendu (empattements ≠ Inter sur le « g »), logo shine one-shot, console sans erreur.

- [ ] **Step 8.3 : App connectée** — se loguer si des credentials dev existent en local ; SINON reporter cette partie à la vérif prod (Task 9) où la session Chrome de Massii est déjà loguée. À vérifier (local ou prod) :
1. Entrée en cascade au chargement et à CHAQUE navigation entre modules
2. Nav morphing : le pill suit hover et actif, revient sur l'actif au mouseleave
3. Hover ressort + sweep radar sur les stat-cards ; PAS de re-animation d'entrée quand le poll monitoring réécrit les grilles (garde `pageEnter` existante)
4. Orbite conique sur la carte `.big` du Dashboard
5. Les 5 dots d'accent : chaque clic rethème TOUT (glows compris) ; recharger → persiste ; vieux localStorage `omen-accent=blue` → migre vers cyan
6. `prefers-reduced-motion` (DevTools → Rendering → emulate) : aucune animation, contenu visible
7. 375 px (resize_window mobile) : pas de scroll horizontal, topbar scrollable OK
8. Console : zéro erreur sur toutes les pages visitées

- [ ] **Step 8.4 : Corriger tout écart trouvé, re-vérifier, commit des fixes**

```bash
git add -A && git commit -m "fix(ion): ajustements post-vérification navigateur"
```
(uniquement s'il y a des fixes)

---

### Task 9 : Rebase, push, vérification prod

- [ ] **Step 9.1 : Rebase sur origin/main + re-check des versions cache-bust**

```bash
git fetch origin
git rebase origin/main
# Si origin/main a bougé les ?v= entre-temps : re-bumper AU-DESSUS des valeurs d'origin
git show origin/main:frontend/index.html | grep -o "style.css?v=[0-9]*"
git show origin/main:frontend/sw.js | grep CACHE_NAME
```
Règle (memory deploy workflow) : nos valeurs doivent être STRICTEMENT supérieures à celles d'origin/main.

- [ ] **Step 9.2 : Merge dans main + push** (⚠️ vérifier qu'aucun scan/bot badge « Bots N » ne tourne — piège #30f — demander à Massii si doute)

```bash
git checkout -B main origin/main
git merge --no-ff feat/frontend-ion -m "feat(frontend): refonte visuelle Ion v6 — palette bleu-nuit néon + couche motion"
git push origin main
```

- [ ] **Step 9.3 : Vérif prod (2 min après le cron auto-deploy)** — via Chrome MCP sur https://omenserver.org :
- `style.css?v=112` servi (Network), SW `omenserver-v125` actif
- Rendu Ion complet (fond, Geist, glows, orbite), test des 5 accents, migration accent OK sur la session de Massii
- Console propre sur Dashboard + 2 modules + login
- Hard-reload si le disk cache sert l'ancien CSS (piège #11 : au besoin re-bump franc)

- [ ] **Step 9.4 : Post-deploy** — MAJ CLAUDE.md (section Design System : v5 → v6 Ion, nouveaux tokens, 5 accents, historique) + Daily note vault. Commit docs séparé sur main.

---

## Self-review (fait à l'écriture)

- **Couverture spec** : §3 tokens→T1 · accents+migration→T2/T3 · typo→T1/T6 · §4 motion (cascade/count-up existant/morphing/hover/sweep/orbite/glow/shine/feed util/jauges via cascade)→T4/T5 · §5 login→T6 · §7 deploy→T7/T8/T9. Les « jauges grow » spécifiques sont couvertes par la cascade omen-rise (les barres sont des enfants de grilles) — pas de tâche dédiée (YAGNI).
- **Sparkline draw-in** : le Dashboard actuel n'a pas de SVG sparkline runtime garanti — l'orbite + count-up + cascade portent la carte maîtresse ; si `.sparkline` existe (grep au moment de T4), ajouter le draw-in en T4 selon le pattern du mockup (stroke-dasharray 600 → 0, .5s de délai). Décision laissée à l'exécution avec critère explicite.
- **Placeholders** : aucun TBD ; les deux points « adapter aux classes réelles » (T4.3, T3.2) sont des vérifications outillées avec commande grep et règle de décision, pas des trous.
- **Cohérence types/noms** : `--accent-glow`/`--top-light` définis T1, consommés T4 ; `navInit`/`_navMove` définis T5.1, appelés T5.2/5.3 ; noms d'accents identiques partout (`green/cyan/violet/magenta/amber`).
