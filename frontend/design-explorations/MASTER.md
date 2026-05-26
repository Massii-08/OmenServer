# Bento Tech — OmenServer Design System v5

> **Status:** Draft · derived from `proposals-v2.html`
> **Branche:** `design/bento-tech-mockup`
> **Cible:** refonte complète de `frontend/css/style.css` (~2000 lignes actuelles)
> **Stack respectée:** Vanilla CSS + JS · pas de build · pas de framework

---

## 📑 Table des matières

1. [Philosophie](#1-philosophie)
2. [Tokens](#2-tokens)
3. [Typographie](#3-typographie)
4. [Composants atomiques](#4-composants-atomiques)
5. [Composants composés](#5-composants-composés)
6. [Layouts](#6-layouts)
7. [Règles d'usage](#7-règles-dusage)
8. [Anti-patterns](#8-anti-patterns)
9. [Mapping ancien → nouveau](#9-mapping-ancien--nouveau)
10. [Plan de migration](#10-plan-de-migration)
11. [Checklist par PR](#11-checklist-par-pr)

---

## 1. Philosophie

### North star
> Un panel sysadmin **vraiment utilisé** par son owner — pas une démo SaaS. Densité d'info, navigation rapide, pas de friction visuelle.

### Inspirations assumées
- **Apple bento boxes** — grille modulaire à tailles variées
- **Raycast** — densité tech sans austérité
- **Linear** — typo Inter + tabular nums + hairline borders
- **Vercel Dashboard** — radius doux + 3-level surfaces

### Le test "anti IA-slop"
Avant de merger un composant, vérifier qu'il **ne contient AUCUN** de ces signaux :

| ❌ Signal IA-slop | ✅ Antidote Bento Tech |
|---|---|
| Dégradé violet/bleu de fond | Surface unie depuis tokens |
| Glassmorphism / `backdrop-filter` | Hairline border + surface tokenisée |
| Drop shadow flou (`box-shadow: 0 4px 12px ...`) | Bordure 1px ou rien |
| Emoji UI (`🎮`, `⚙️`, `🔌`) | Texte court · ou SVG icon set |
| `border-radius: 20px` partout | Échelle 8/10/14 disciplinée |
| Plusieurs accents dans une vue | UN seul `--accent` à la fois |
| Numbers en proportional font | `font-feature-settings: "tnum"` |
| Hex hardcodé dans un composant | Token CSS uniquement |

---

## 2. Tokens

> Tous les tokens vivent dans `:root`. Les variantes (`[data-accent="X"]`) overrident uniquement `--accent` et ses dérivés.

```css
:root {
  /* ===== Surfaces (3-level depth) ===== */
  --bg:         #0E0E10;  /* page background */
  --bg-elev-1:  #161618;  /* base cards, default surface */
  --bg-elev-2:  #18181B;  /* big/featured cards, hover state */
  --bg-elev-3:  #1F1F23;  /* inputs, avatars, code blocks */

  /* ===== Borders ===== */
  --border:        #27272A;  /* hairline default */
  --border-strong: #3F3F46;  /* emphasized, dashed dropzones */

  /* ===== Text ===== */
  --text:        #F4F4F5;  /* primary headings, values */
  --text-muted:  #A1A1AA;  /* secondary, labels */
  --text-dim:    #71717A;  /* tertiary, timestamps, metadata */

  /* ===== Accent (CHANGEABLE via data-accent) ===== */
  --accent:      #4ADE80;              /* lime — default */
  --accent-dim:  rgba(74,222,128,.14); /* tinted bg for accent areas */
  --accent-text: #0A0A0A;              /* foreground when bg = --accent */

  /* ===== Semantic (FIXED — never theme-driven) ===== */
  --danger:   #F87171;
  --warning:  #FBBF24;
  --info:     #60A5FA;
  --violet:   #C084FC;  /* developer role */
  --orange:   #FB923C;  /* money role */

  /* ===== Radii ===== */
  --r-sm:   8px;   /* badges, inputs, small chips */
  --r-md:   10px;  /* small cards, rows */
  --r-lg:   14px;  /* main cards, modals */
  --r-pill: 999px; /* pill switchers, status pills */

  /* ===== Spacing (4px base) ===== */
  --s-1:  4px;
  --s-2:  8px;
  --s-3:  12px;
  --s-4:  16px;
  --s-5:  20px;
  --s-6:  24px;
  --s-8:  32px;
  --s-10: 40px;
  --s-12: 48px;

  /* ===== Type (set in §3) ===== */
  --font-ui:   'Inter', system-ui, sans-serif;
  --font-mono: 'Geist Mono', ui-monospace, monospace;

  /* ===== Motion ===== */
  --t-fast: 120ms ease;  /* hover/focus, sub-perceptual */
  --t-base: 200ms ease;  /* state transitions */
  /* Pas de --t-slow — si tu veux > 300ms, repense ton interaction */
}

/* ===== Accent variants ===== */
[data-accent="blue"]   { --accent: #60A5FA; --accent-dim: rgba(96,165,250,.14); }
[data-accent="red"]    { --accent: #FB7185; --accent-dim: rgba(251,113,133,.14); }
[data-accent="yellow"] { --accent: #FACC15; --accent-dim: rgba(250,204,21,.14); }
/* --accent-text reste #0A0A0A pour les 4 variantes (contraste OK sur toutes) */
```

### Pourquoi 3 niveaux de surface
La différenciation visuelle entre cards **n'utilise pas d'ombre** mais 3 fonds très proches (`#0E`/`#16`/`#18`). Ça donne de la profondeur sans flou et reste lisible en éclairage faible.

### Pourquoi danger/warning/info ne suivent PAS l'accent
Si tu mets l'accent en rouge, tu dois quand même pouvoir distinguer une "alerte rouge" d'un "indicateur primaire rouge". Les couleurs sémantiques sont **fixées** pour rester univoques.

---

## 3. Typographie

```css
/* Imports — à mettre en tête de style.css */
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap');

body {
  font-family: var(--font-ui);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  font-feature-settings: "cv11", "ss01"; /* Inter alternates */
}

.mono {
  font-family: var(--font-mono);
  font-feature-settings: "tnum"; /* TABULAR NUMS — critical */
}
```

### Échelle typographique

| Usage | Size | Weight | Family | Notes |
|---|---|---|---|---|
| Display (page title) | 22px | 600 | Inter | `letter-spacing: -0.015em` |
| Section title | 12px | 600 | Inter | uppercase · `letter-spacing: 0.08em` · text-dim |
| Card label | 12px | 400 | Inter | text-muted |
| Body | 14px | 400 | Inter | line-height 1.5 |
| Small body / row meta | 13px | 400 | Inter | |
| **Stat value (big)** | **48px** | **500** | **Geist Mono** | **tnum** · letter-spacing -0.02em |
| Stat value (small) | 30px | 500 | Geist Mono | tnum · letter-spacing -0.02em |
| Stat unit (suffix) | 16-22px | 400 | Geist Mono | text-dim (e.g. "/16GB") |
| Delta | 12px | 400 | Geist Mono | tnum (colored by sign) |
| Code / IP / MAC / timestamp | 11-13px | 400-500 | Geist Mono | tnum |
| Mini label (uppercase) | 10-11px | 600 | Geist Mono | `letter-spacing: 0.08em` · uppercase |

### Règle d'or des chiffres
**Tous** les chiffres affichés dans l'UI utilisent `Geist Mono` + `font-feature-settings: "tnum"`. Sans exception. Ça évite le layout shift et donne le côté "dashboard tech" du style.

---

## 4. Composants atomiques

### 4.1 Card

```css
.card {
  background: var(--bg-elev-1);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  padding: var(--s-5);
}
.card-elev { background: var(--bg-elev-2); }  /* featured/highlight */
```

```html
<div class="card">…</div>
<div class="card card-elev">featured…</div>
```

### 4.2 Button

```css
.btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 7px 14px;
  background: var(--text);  /* white-ish on dark */
  color: var(--bg);
  border-radius: var(--r-sm);
  font: 500 13px/1 var(--font-ui);
  border: 0;
  cursor: pointer;
  transition: var(--t-fast);
}
.btn:hover { background: #fff; }

.btn-ghost {
  background: transparent;
  color: var(--text);
  border: 1px solid var(--border-strong);
}
.btn-ghost:hover { background: var(--bg-elev-2); }

.btn-danger {
  background: var(--danger);
  color: var(--bg);
}

.btn-sm { padding: 4px 10px; font-size: 12px; }
.btn-icon { padding: 6px; }
```

Variants: **primary** (default, white on dark) · **ghost** (border only) · **danger** (semantic red) · **sm/icon** (size modifiers).

### 4.3 Badge

```css
.badge {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 500;
  border-radius: var(--r-pill);
  background: var(--bg-elev-3);
  color: var(--text-muted);
  border: 1px solid var(--border);
}
.badge.online {
  background: var(--accent-dim);
  color: var(--accent);
  border-color: transparent;
}
.badge.online::before {
  content: ""; width: 6px; height: 6px;
  border-radius: 50%; background: var(--accent);
}
.badge.warn   { background: rgba(251,191,36,.12); color: var(--warning); }
.badge.danger { background: rgba(248,113,113,.12); color: var(--danger); }
```

### 4.4 Role pill

```css
.role-pill {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  border-radius: var(--r-sm);
  border: 1px solid;
}
.role-pill.admin     { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.role-pill.developer { color: var(--violet); border-color: rgba(192,132,252,.4); background: rgba(192,132,252,.10); }
.role-pill.moderator { color: var(--info); border-color: rgba(96,165,250,.4); background: rgba(96,165,250,.10); }
.role-pill.money     { color: var(--orange); border-color: rgba(251,146,60,.4); background: rgba(251,146,60,.10); }
.role-pill.player    { color: var(--text); border-color: var(--border-strong); background: var(--bg-elev-3); }
.role-pill.spectator { color: var(--text-dim); border-color: var(--border); background: var(--bg-elev-2); }
```

**Règle:** seul `.admin` suit `--accent`. Les 5 autres rôles sont fixés (sinon on perd la lisibilité quand l'accent change).

### 4.5 Access pill (per-resource)

```css
.access-pill {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 8px;
  font: 600 10px/1 var(--font-mono);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  border-radius: var(--r-sm);
  border: 1px solid var(--border-strong);
  color: var(--text-muted);
  background: var(--bg-elev-3);
}
.access-pill.owner  { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.access-pill.manage { color: var(--info); border-color: rgba(96,165,250,.4); background: rgba(96,165,250,.10); }
.access-pill.start  { color: var(--text); }
.access-pill.view   { color: var(--text-dim); background: var(--bg-elev-2); }
```

### 4.6 Module chip (allowed_modules)

```css
.mod-chip {
  display: inline-block;
  padding: 1px 7px;
  font: 500 10px/1.5 var(--font-mono);
  letter-spacing: 0.02em;
  color: var(--info);
  background: rgba(96,165,250,.10);
  border: 1px solid rgba(96,165,250,.30);
  border-radius: var(--r-sm);
}
```

### 4.7 Input

```css
input[type="text"], input[type="number"], input[type="time"], select {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 7px 12px;
  color: var(--text);
  font: 13px/1.5 var(--font-ui);
  outline: none;
  transition: border var(--t-fast);
}
input:focus, select:focus { border-color: var(--accent); }

/* Mono input variant for codes/IPs */
input.mono { font-family: var(--font-mono); }
```

---

## 5. Composants composés

### 5.1 Stat card (Bento atom)

```css
.stat-card {
  /* hérite .card */
  display: flex; flex-direction: column; gap: 6px;
}
.stat-card.big {
  grid-row: span 2;        /* dans une grille bento 2 lignes */
  background: var(--bg-elev-2);
}
.stat-card .label { color: var(--text-muted); font-size: 12px; }
.stat-card .value {
  font-family: var(--font-mono);
  font-size: 30px;
  font-weight: 500;
  letter-spacing: -0.02em;
  font-feature-settings: "tnum";
  line-height: 1.1;
}
.stat-card.big .value { font-size: 48px; margin-top: var(--s-2); }
.stat-card .value .unit { color: var(--text-dim); font-size: 16px; margin-left: 2px; }
.stat-card.big .value .unit { font-size: 22px; }
.stat-card .footer { color: var(--text-dim); font-size: 12px; margin-top: auto; }
```

### 5.2 Bento overview grid

Pattern de référence (Dashboard / Server view / Tasks) :

```css
.bento-overview {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  gap: var(--s-3);
}
/* La grosse stat (CPU principal) = .stat-card.big → grid-row: span 2 */
```

### 5.3 Sparkline (visual delta)

```css
.sparkline {
  margin-top: var(--s-3);
  height: 36px;
  background: linear-gradient(180deg, var(--accent-dim), transparent);
  clip-path: polygon(/* path en dur, généré côté JS pour vraies données */);
  transition: background var(--t-base);
}
```

**Note migration:** côté prod, on génère le clip-path en JS à partir des vraies stats. Le SVG line chart reste optionnel (Chart.js déjà chargé).

### 5.4 Row (compact list item)

```css
.row-list { display: flex; flex-direction: column; gap: var(--s-2); }
.row {
  background: var(--bg-elev-1);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  padding: var(--s-3) var(--s-4);
  display: grid;
  grid-template-columns: auto 1fr auto auto;
  gap: var(--s-4);
  align-items: center;
  transition: var(--t-fast);
}
.row:hover { background: var(--bg-elev-2); border-color: var(--border-strong); }
```

Variants thématiques (server-row, bot-row, plugin-row) → mêmes tokens, contenu différent.

### 5.5 Console (terminal-like log)

```css
.console {
  background: #0A0A0B;             /* plus sombre que --bg */
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  padding: var(--s-4);
  font: 12.5px/1.65 var(--font-mono);
  color: #D4D4D8;
  max-height: 280px;
  overflow: auto;
}
.console .ts   { color: var(--text-dim); }
.console .ok   { color: var(--accent); }
.console .warn { color: var(--warning); }
.console .err  { color: var(--danger); }
```

### 5.6 Events feed (activity log)

```css
.events-feed {
  background: var(--bg-elev-1);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  padding: var(--s-4);
  font: 12.5px/1.7 var(--font-mono);
}
.events-feed .ev {
  display: grid;
  grid-template-columns: 90px 80px 1fr;
  gap: var(--s-3);
}
.events-feed .typ      { color: var(--text-muted); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; }
.events-feed .typ.ok   { color: var(--accent); }
.events-feed .typ.warn { color: var(--warning); }
.events-feed .typ.err  { color: var(--danger); }
```

### 5.7 Diagnostic strip

```css
.diag-grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: var(--s-3);
}
.diag-item {
  padding: var(--s-2) var(--s-3);
  border-radius: var(--r-sm);
  border-left: 3px solid var(--accent);
  background: var(--bg-elev-2);
}
.diag-item.warn { border-left-color: var(--warning); }
.diag-item.err  { border-left-color: var(--danger); }
```

---

## 6. Layouts

### 6.1 Top bar (sticky)

```
[ Brand · OMENSERVER ]  [ nav-tabs flex:1 ]  [ lang-switcher ]  [ accent-switcher ]  [ user-chip ]
```

```css
.topbar {
  display: flex; align-items: center; gap: var(--s-6);
  padding: var(--s-3) var(--s-6);
  background: var(--bg-elev-1);
  border-bottom: 1px solid var(--border);
  position: sticky; top: 0; z-index: 10;
}
.nav-tabs { display: flex; gap: var(--s-1); flex: 1; }
.nav-tab {
  padding: 6px 10px;
  white-space: nowrap;
  color: var(--text-muted);
  font: 500 13px/1 var(--font-ui);
  border-radius: var(--r-sm);
  transition: var(--t-fast);
}
.nav-tab.active { background: var(--bg-elev-2); color: var(--text); }
.nav-tab.active::before {
  content: ""; display: inline-block;
  width: 5px; height: 5px; border-radius: 50%;
  background: var(--accent);
  margin-right: 6px; vertical-align: middle;
}
```

### 6.2 Page container

```css
main { max-width: 1280px; margin: 0 auto; padding: var(--s-8) var(--s-6); }
.page { display: none; }
.page.active { display: block; }
.page-header {
  display: flex; align-items: flex-end; justify-content: space-between;
  gap: var(--s-4); margin-bottom: var(--s-8);
}
.section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin: var(--s-8) 0 var(--s-3);
}
```

### 6.3 Server view (sidebar layout)

```css
.sv-layout {
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: var(--s-5);
  align-items: start;
}
.sv-sidebar {
  /* hérite .card */
  position: sticky; top: 80px;
}
.sv-nav-item.active::before {
  content: ""; position: absolute;
  left: -4px; top: 50%; transform: translateY(-50%);
  width: 3px; height: 14px;
  background: var(--accent);
  border-radius: 2px;
}
```

**Pattern crucial:** `.sv-panel { display:none } .sv-panel.active { display:block }` permet de swap le contenu sans reload (JS dans `app.js` à porter).

---

## 7. Règles d'usage

### 7.1 Quand utiliser `--accent`
- ✅ Status "online", deltas positifs, primary CTA active
- ✅ Indicateur de l'item actif dans la nav (dot + barre verticale sidebar)
- ✅ Role pill `admin` (la "signature" de l'owner)
- ✅ Sparkline gradient, hover state du focus input
- ❌ Couleur de danger ou warning (utilise les tokens sémantiques)
- ❌ Couleur de role pour moderator/developer/etc. (couleurs fixées)

### 7.2 Quand utiliser une couleur sémantique fixe
- ✅ `--danger` pour delete/revoke/error/offline
- ✅ `--warning` pour quota plein, plugin update available, flaky network
- ✅ `--info` pour role moderator (bleu = "info/secondary command")
- ✅ `--violet` developer · `--orange` money

### 7.3 Hiérarchie des fonds
```
--bg        →  fond de page, input bg, console bg-ish
--bg-elev-1 →  cards de base, sidebar
--bg-elev-2 →  hover state · cards "big" (featured) · headers de table
--bg-elev-3 →  inputs disabled · avatars · code inline · game-ico
```

Différenciation = **3 step de luminance proches**, pas d'ombre. Si tu mets une ombre, tu casses la cohérence visuelle.

### 7.4 Numbers
**Toujours** :
- `font-family: var(--font-mono)`
- `font-feature-settings: "tnum"`
- `letter-spacing: -0.02em` sur les gros chiffres (look condensé)
- Unit suffix (`%`, `GB`, `/20`) en `--text-dim` plus petit

### 7.5 Padding interne des cards
- Card normale : `var(--s-5)` (20px)
- Card dense (row, badge) : `var(--s-3) var(--s-4)` (12px/16px)
- Card hero (Settings profile) : `var(--s-5)` ou plus
- Jamais < 12px ni > 24px (au-delà, c'est de la déco)

---

## 8. Anti-patterns

```css
/* ❌ NE FAIS PAS ÇA */
.bad-card {
  background: linear-gradient(135deg, #6366f1, #8b5cf6);  /* generic SaaS gradient */
  box-shadow: 0 10px 30px rgba(99,102,241,.3);             /* glowy purple shadow */
  backdrop-filter: blur(20px);                              /* glassmorphism */
  border-radius: 24px;                                      /* huge radius */
}
.bad-card .icon { content: "🚀"; }                         /* emoji UI */
.bad-card .number { font-family: system-ui; }              /* proportional digits */
```

```css
/* ✅ FAIS ÇA */
.good-card {
  background: var(--bg-elev-1);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  /* no shadow, no gradient, no blur */
}
.good-card .number {
  font-family: var(--font-mono);
  font-feature-settings: "tnum";
}
```

### Tests rapides avant merge
1. Inspecter le composant en dark : aucun glow, aucune ombre floue
2. Compter les couleurs uniques dans la vue : devrait être ≤ 6 (incl. text + accent)
3. Changer l'accent via le switcher : tout ce qui devrait changer change, le reste reste lisible
4. Mode mono : tous les chiffres alignent verticalement en colonne (test layout shift)

---

## 9. Mapping ancien → nouveau

### 9.1 Variables CSS (extraits de l'actuel `style.css`)

| Ancien | Nouveau | Notes |
|---|---|---|
| `--bg-primary`, `--bg-secondary` | `--bg`, `--bg-elev-1`, `--bg-elev-2` | passage 2-level → 3-level |
| `--accent-violet` (default theme) | `--accent` (variable) | choix par défaut = vert lime |
| `--accent-emerald`, `--accent-crimson` | accent variants (yellow, red) | via `[data-accent]` |
| `--border-color` | `--border` + `--border-strong` | 2 niveaux maintenant |
| `--text-primary`, `--text-secondary` | `--text`, `--text-muted`, `--text-dim` | 3 niveaux |
| `--radius-sm`, `--radius` | `--r-sm`, `--r-md`, `--r-lg`, `--r-pill` | échelle explicite |
| `--transition-fast` | `--t-fast`, `--t-base` | renommé + 2 niveaux |

### 9.2 Composants (classes)

| Ancien | Nouveau | Refactor |
|---|---|---|
| `.card` | `.card` (+ `.card-elev`) | tokens + radius 14 |
| `.btn-primary` | `.btn` (default) | inversé : primary = défaut |
| `.btn-secondary` | `.btn-ghost` | renommé pour clarté |
| `.stat-card` | `.stat-card` (+ `.big`) | mono nums obligatoire |
| `.status-badge` | `.badge` (+ `.online/warn/danger`) | renommé |
| `.module-card` | `.card` + classe sémantique | unifié |
| `.console` | `.console` | garde, juste tokens |
| `.stat-machines-list`, `.stat-machine-item` | `.machines-grid`, `.machine-card` | renommé |

### 9.3 5 thèmes actuels → 1 thème + 4 accents

| Thème actuel | Devient |
|---|---|
| `default` (violet sombre) | dark + `data-accent="red"` (le plus proche vibe) |
| `midnight` | dark + `data-accent="blue"` |
| `emerald` | dark + `data-accent="green"` ← défaut |
| `crimson` | dark + `data-accent="red"` |
| `light` | **supprimé** (validé : dark only) |

**Note migration:** garder la rétrocompat pendant 1 release — mapper l'ancien `theme` value au nouvel `accent` au boot dans `app.js`.

---

## 10. Plan de migration

### Vue d'ensemble (6 PRs)

```
PR 1 — Tokens & fonts          [petit]   ~2h    risque: faible
PR 2 — Composants atomiques     [moyen]   ~4h    risque: faible
PR 3 — Layout & top bar         [petit]   ~2h    risque: moyen (touche tous les écrans)
PR 4 — Dashboard + Diagnostic   [moyen]   ~3h    risque: faible (page contained)
PR 5 — Server view (sidebar)    [GROS]    ~6h    risque: élevé (16 panels)
PR 6 — Autres pages + cleanup   [moyen]   ~4h    risque: faible
```

### PR 1 — Tokens & fonts
**Fichiers:** `frontend/css/style.css` (top of file)
1. Importer Inter + Geist Mono (remplace Inter actuel si différent)
2. Remplacer `:root` par les nouveaux tokens
3. Ajouter `[data-accent]` variants
4. Ne **pas** supprimer les anciens vars encore — coexister 1 PR pour debug visuel

**Test:** au reload, l'UI doit globalement marcher en utilisant encore les anciennes classes. Quelques décalages de couleur acceptables.

### PR 2 — Composants atomiques
**Fichiers:** `frontend/css/style.css`
1. Réécrire `.card`, `.btn`, `.btn-ghost`, `.btn-danger`, `.badge`
2. Ajouter `.role-pill`, `.access-pill`, `.mod-chip`
3. Réécrire `.console`, `.events-feed`
4. Garder les anciennes classes en fin de fichier (legacy) si encore utilisées

**Test:** vérifier qu'aucune card n'a plus d'ombre · cliquer chaque bouton de chaque écran.

### PR 3 — Layout & top bar
**Fichiers:** `index.html`, `style.css`, `app.js`
1. Refactor du `.topbar` avec nouvelles classes
2. Ajout du `lang-switcher` + `accent-switcher`
3. JS : binding du `data-accent` sur `<html>` + persist localStorage
4. Mapping legacy theme → accent à l'init

**Test:** changer l'accent en live, vérifier rétrocompat anciens thèmes.

### PR 4 — Dashboard + Diagnostic
**Fichiers:** `monitoring.js`, `style.css`
1. Refactor du HTML render du dashboard pour matcher `.bento-overview`
2. Ajout du Diagnostic strip (8 health checks)
3. Refactor de la grille machines (cerveau visible)

**Test:** comparer aux mockups (`proposals-v2.html`) section Dashboard · vérifier les sparklines.

### PR 5 — Server view (le gros)
**Fichiers:** `server_view.js`, `sv_*.js`, `style.css`
1. **Refactor structurel:** abandon tab bar horizontal → sidebar 240px
2. Conversion de chaque `_xxxTab()` en panel autonome
3. Garder la logique conditionnelle existante (`isPlugin` / `isMod` / `isSteam`)
4. Vérifier que `canManage` filtre toujours bien les tabs admin

**Test:** sur paper / forge / vanilla / ARK → vérifier que les onglets conditionnels s'affichent correctement comme dans le mockup.

⚠️ **Le plus gros PR.** Considérer split en 2: structure sidebar + 1 onglet, puis tous les autres onglets.

### PR 6 — Autres pages + cleanup
**Fichiers:** `bots_module.js`, `files_module.js`, `media_module.js`, `web_module.js`, `network_module.js`, `app.js`, `style.css`
1. Refactor Bots (cards bot + screens Yield Bot)
2. Refactor Files (file browser)
3. Refactor Media (library grid)
4. Refactor Web (sites list)
5. Refactor Network (WoL + ping monitor + events)
6. **Nouveau:** créer Users page (existait éclatée dans Settings)
7. **Nouveau:** créer Tasks page (scheduler)
8. **Nouveau:** créer Settings page consolidée
9. Supprimer les anciennes vars CSS et classes legacy

**Test:** parcours utilisateur complet · vérifier les 6 rôles avec quotas.

### Après les 6 PRs : cleanup
- Bumper `CACHE_NAME` dans `sw.js`
- Bumper `?v=XX` dans `index.html` pour TOUS les fichiers CSS/JS
- Tester en 3 langues (FR/EN/IT)
- Tester les 4 variants d'accent
- Smoke test complet (login, create server, run bot, share, invite)
- Merger `design/bento-tech-mockup` → main avec PR finale
- Supprimer la branche

---

## 11. Checklist par PR

Coller en tête de chaque PR :

```markdown
## Bento Tech migration · PR N
**Référence:** MASTER.md §X
**Mockup:** proposals-v2.html · section [Dashboard/Server view/etc.]

### Checks Bento Tech (obligatoires)
- [ ] Aucun gradient, sauf sparkline subtil (`--accent-dim` → transparent)
- [ ] Aucune ombre floue (`box-shadow` autorisé uniquement pour focus ring)
- [ ] Aucun emoji utilisé comme icône UI
- [ ] Tous les chiffres en Geist Mono + `font-feature-settings: "tnum"`
- [ ] Aucun hex hardcodé (tout passe par tokens CSS)
- [ ] `border-radius` ∈ {8, 10, 14, pill} uniquement
- [ ] Accent suit `--accent` uniquement pour : online/positive-delta/active/admin-role
- [ ] Couleurs sémantiques (danger/warning/info/violet/orange) fixées, JAMAIS theme-dependent

### Tests fonctionnels
- [ ] Changer accent via le switcher → tout ce qui doit changer change, lisibilité préservée
- [ ] Changer langue FR/EN/IT → aucune string hardcodée, tout via `Lang.t()`
- [ ] Test en `data-accent="red"` ET `data-accent="yellow"` (les plus contrastants)
- [ ] Test sur mobile (375px) et desktop (1280px) — pas de débordement horizontal

### Cache busting
- [ ] `CACHE_NAME` bumpé dans `sw.js`
- [ ] `?v=XX` bumpé dans `index.html` pour les fichiers modifiés

### Anti-régression
- [ ] Tous les rôles testés : admin / developer / moderator / money / player / spectator
- [ ] Permissions `allowed_modules` toujours fonctionnelles
- [ ] Création de ressource respecte les quotas
- [ ] Invitations globales + sharing per-resource toujours opérationnels
```

---

## 📚 Annexes

### A. Liens utiles
- **Mockup interactif:** `frontend/design-explorations/proposals-v2.html`
- **Comparaison des 5 directions initiales:** `frontend/design-explorations/proposals.html`
- **Backend RBAC:** `backend/auth/permissions.py:29` (source de vérité pour rôles & quotas)
- **Server view tabs logic:** `frontend/js/server_view.js:71-126`
- **Cycle power management:** `backend/scheduler/power_manager.py`

### B. Composants pas encore dans le MASTER (à ajouter si besoin)
- Charts Chart.js (Monitoring tab Server view) — palette + axes tokens
- Modal/Sheet (création de tâche, sharing dialog) — taille, backdrop, dismiss
- Toast (existant dans `toast.js`) — alignement avec nouveau design system
- File browser (Files page + Server view Files tab) — pattern breadcrumb + list

### C. Décisions ouvertes à valider
- Mode light : on a validé **dark only**, mais on garde la possibilité d'ajouter `[data-theme="light"]` plus tard si demandé
- Notifications email/push : pas mocké en détail, à voir avec le router `notifications`
- Mobile responsive : le mockup vise desktop 1280px ; faut-il prioriser mobile pour cette refonte ou attendre v6 ?

---

**Dernière mise à jour:** 2026-05-26 · branche `design/bento-tech-mockup`
**Maintainer:** Massii_08 + Claude (sessions itératives)
