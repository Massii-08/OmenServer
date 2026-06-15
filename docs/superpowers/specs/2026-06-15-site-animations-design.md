# Spec — « Un peu de vie » : micro-animations OmenServer

> 2026-06-15 · branche `feat/site-animations` (base = `main`) · frontend vanilla, design system Bento Tech v5.

## Objectif

Donner « un peu de vie » à chaque page sans casser le minimalisme Bento. Intensité validée par Massii : **subtil partout + 1-2 moments signature**. Assets : **pur CSS/JS, pas de Canva** (cohérence, poids, PWA-offline, anti « tells slop »).

## Principes (garde-fous = conformité MASTER)

- Durées courtes (entrées ≤ 0.5 s, hovers 0.15–0.2 s), easing doux `cubic-bezier(.2,.7,.2,1)`.
- **Aucun** blur / gradient / glow / box-shadow flou. Accent vert uniquement, couleurs sémantiques inchangées.
- **`prefers-reduced-motion: reduce`** : un bloc global coupe TOUT (entrées, stagger, breathing, count-up → set direct). Accessibilité.
- Zéro nouvelle dépendance (auto-deploy propre). Pas de backend. Pas de refonte.

## Composants

### Couche subtile (toutes les pages)
1. **Entrée de page** — `#module-content` fond en douceur (`omen-fade .34s`) à chaque `navigateTo()`. Hook : `Anim.pageEnter()`.
2. **Stagger des cartes** — entrée décalée (`omen-rise`), **gatée par `.view-enter`** sur le conteneur (retirée après 1 s) → ne se rejoue PAS aux refresh internes (poll monitoring qui réécrit `nodes-grid`). Cibles : enfants directs de `.bento-overview / .machines-grid / .row-list / .mod-grid / .diag-grid / .bots-grid`.
3. **Compteurs animés** — `Anim.countUp()` sur les valeurs stats du dashboard. **1er affichage seulement** : `monitoring.updateStat` compte si la valeur courante est `--`/non-numérique, sinon set direct (pas de « comptage » à chaque refresh).
4. **Micro-interaction hover** — lift `-2px` + bord renforcé sur `.stat-card` (aucun hover existant) et `.machine-card.arm` (extension de sa transition existante `opacity,border-color`). On NE touche pas aux hovers déjà définis (`.row`, `.mod-card`, `.bot-card-bento`, `.server-item`).
5. **Skeletons shimmer** — helper `Anim.skeleton(kind,count)` + CSS `.skel`. Câblé sur le placeholder initial de `nodes-grid` (dashboard). Réutilisable ailleurs ensuite.

### Moments signature
6. **Dashboard cerveau « vivant »** — `.machine-card.brain::after` = accent vert qui « respire » (opacité 0.12↔0.42, `omen-breathe 3.4s`, **sans blur**, `::before` déjà pris par le label BRAIN). + heartbeat : `.machine-card:not(.offline) .m-head .dot` pulse doux (`omen-dot-pulse 2.4s`).
7. **Login** — entrée premium de la marque au chargement : `.login-logo` scale-in (`omen-logo-in`), `.login-brand-text` settle (`omen-wordmark-in`, letter-spacing .2em→.08em). Pur CSS sur classes existantes, **aucune modif HTML**.

## Architecture (isolée)

- **NOUVEAU** `frontend/js/anim.js` → global `Anim` : `reduced` (matchMedia), `pageEnter()`, `countUp(el,to,dur)`, `skeleton(kind,count)`. Une seule responsabilité.
- `style.css` → **nouvelle section** en fin de fichier : keyframes `omen-*` (noms uniques, pas de collision avec `fadeIn/slideIn/spin/pulse-dot`) + règles + **bloc reduced-motion final**.
- Hooks chirurgicaux :
  - `app.js navigateTo` : `if (typeof Anim!=='undefined') Anim.pageEnter();` (1 ligne).
  - `app.js renderHub` : placeholder `nodes-grid` → `Anim.skeleton('card',3)`.
  - `monitoring.js updateStat` : count-up au 1er paint.
  - `login.html` : aucun changement de markup (CSS seul) ; bump `style.css?v=`.
- **Cache-bust** : `index.html` → +`anim.js?v=1`, `style.css 107→108`, `app.js 215→216`, `monitoring.js 92→93` ; `login.html style.css 99→108` ; `sw.js CACHE_NAME v106→v107`.

## Vérification (moi-même, Chrome MCP)

- Serveur statique local sur `frontend/` → ouvrir `login.html` (vraie `style.css`) → voir l'entrée marque.
- Harnais temporaire `_anim_check.html` (vraies `style.css` + `anim.js` + markup Bento représentatif) → entrée/stagger/count-up/breathing cerveau/hover + **émulation reduced-motion** (tout coupé). Screenshots before/after. Harnais supprimé après (non commité).

## Hors scope / décisions

- `.stat-bar` non animée (cachée sur le dashboard : `display:none !important`).
- Toasts inchangés (glissent déjà).
- **Déploiement** : merge `feat/site-animations` → `main` = auto-deploy prod ⇒ **attendre l'OK visuel de Massii** avant de merger/pousser (action outward-facing).
