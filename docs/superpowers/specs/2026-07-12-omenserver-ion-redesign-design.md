# OmenServer v6 — Refonte visuelle « Ion » (design)

**Date** : 2026-07-12
**Statut** : validé par Massii (mockup interactif + décisions verrouillées)
**Références** :
- Mockup validé : `docs/superpowers/mockups/2026-07-12-ion-directions.html` (ouvrir dans un navigateur ; direction B « Ion » = la cible)
- Artifact live : https://claude.ai/code/artifact/ed2b3260-33ec-491e-b60b-7effa74977ea

---

## 1. Contexte & objectif

Le frontend est en Bento Tech v5 (mai 2026) : sobre, hairlines, zéro glow. Massii veut une
refonte visuelle avec **beaucoup plus d'animations** et un rendu « stylé ». Trois directions
ont été mockupées (Obsidienne = premium pur / Ion = premium + néon dosé / Arcade = synthwave) ;
**Ion est retenue, en style unique**.

**Philosophie Ion — 2 règles à respecter dans toute décision d'implémentation :**
1. **Le néon = information.** Le glow est réservé à ce qui est *vivant* (statut online, badge
   LIVE, données temps réel, orbite de la carte maîtresse). Jamais de glow décoratif sur des
   éléments statiques.
2. **Le mouvement = physique.** Ressorts discrets (léger dépassement puis retour), cascades
   courtes, morphing. Jamais de linéaire brut ni d'animation > 500 ms bloquante.

## 2. Décisions verrouillées

| Sujet | Décision |
|---|---|
| Ampleur | Refonte complète (ambiance + animations), **structure/layout des pages inchangés** |
| Direction | **Ion** uniquement (pas de multi-styles) |
| Accent par défaut | **Vert électrique `#00FFB0`** |
| Personnalisation couleur | Sélecteur **5 accents** (vert, cyan, violet, magenta, ambre) via `data-accent`, mécanisme actuel conservé |
| Typo | **Geist** (UI) + **Geist Mono** (données) — Inter retiré |
| Stack | Vanilla CSS/JS, zéro dépendance, zéro build step |
| Thème | Dark unique (comme aujourd'hui) |

## 3. Design system Ion — tokens

Remplacement des **valeurs** des tokens existants dans `:root` de `frontend/css/style.css`
(les noms ne changent pas → tout le site suit) :

```css
--bg            #050810   /* fond bleu-nuit (était #0E0E10) */
--bg-elev-1     #0A101E   /* surfaces cartes (était #161618) */
--bg-elev-2     #0E1526   /* hover, grandes cartes (était #18181B) */
--bg-elev-3     #131C33   /* inputs, avatars, code (était #1F1F23) */
--border        #1C2947   /* hairline bleutée (était #27272A) */
--border-strong #2C4066   /* (était #3F3F46) */
--text          #EDF2FA
--text-muted    #8FA3C4
--text-dim      #5A6C90
--accent        #00FFB0   /* vert électrique (défaut) */
--accent-dim    rgba(0,255,176,.14)
--accent-glow   rgba(0,255,176,.65)   /* NOUVEAU token */
--top-light     rgba(140,180,255,.07) /* NOUVEAU : lumière haute des cartes */
--danger/--warning/--info/--violet/--orange : INCHANGÉS (sémantique fixe)
```

**Fond de page** : micro-grille pointillée bleue sur le `body` —
`radial-gradient(rgba(91,140,255,.08) 1px, transparent 1.5px) 0 0/26px 26px` par-dessus `--bg`.

**Accents** (`data-accent` sur `<html>`, persisté localStorage `omen-accent`, comme aujourd'hui) :

| Nom | `--accent` | `--accent-dim` | `--accent-glow` |
|---|---|---|---|
| `green` (défaut) | `#00FFB0` | `rgba(0,255,176,.14)` | `rgba(0,255,176,.65)` |
| `cyan` | `#00D2FF` | `rgba(0,210,255,.14)` | `rgba(0,210,255,.65)` |
| `violet` | `#8B5CFF` | `rgba(139,92,255,.15)` | `rgba(139,92,255,.7)` |
| `magenta` | `#FF3DA6` | `rgba(255,61,166,.14)` | `rgba(255,61,166,.65)` |
| `amber` | `#FFB020` | `rgba(255,176,32,.14)` | `rgba(255,176,32,.6)` |

**Migration des anciens accents** (dans `App._loadAccent()`) : `blue→cyan`, `red→magenta`,
`yellow→amber`, `green→green`. Le switcher topbar passe de 4 à 5 dots.

**Typo** : import Google Fonts `Geist` (variable 100-900) en remplacement d'Inter ;
`--font-ui:'Geist'`. `Geist Mono` déjà présent, inchangé. Tous les chiffres restent en mono
`tnum` (règle v5 conservée).

## 4. Système motion

Toutes les animations : **transform/opacity uniquement** (jamais width/height/top/left),
respectent `prefers-reduced-motion` via le pattern `Anim.reduced` existant.
Easing signature : `cubic-bezier(.26,1.2,.4,1)` (ressort discret) pour les entrées/hovers ;
`cubic-bezier(.3,1.25,.45,1)` pour le morphing nav.

| Composant | Comportement | Où |
|---|---|---|
| **Entrée en cascade** | `.an` + `--i` : fade + translateY(16px), 650 ms, stagger 70 ms, rejouée à chaque `App.navigateTo` (extension de `Anim.pageEnter`) | Toutes les pages |
| **Count-up** | `Anim.countUp` existant, généralisé aux stats de toutes les pages | Stats |
| **Sparkline draw-in** | stroke-dasharray animé + area fade, endpoint dot | Dashboard (carte CPU) |
| **Nav morphing** | Pill `.nav-ind` qui glisse sous l'onglet actif/survolé (JS offsetLeft/Width) | Topbar |
| **Hover lift ressort** | translateY(-2px) + bordure teintée accent + glow doux | Cartes, panels, machine-cards |
| **Sweep radar** | Balayage lumineux diagonal one-shot au hover | Cartes stats |
| **Orbite conique** | Segment lumineux tournant sur la bordure (conic-gradient + `@property --ang` + mask), 4 s/tour | Carte maîtresse du Dashboard uniquement |
| **Glow vivant** | `box-shadow` accent sur dots/badges ONLINE/LIVE + `breathe` 2.4 s | Statuts partout |
| **Logo shine** | Balayage lumineux one-shot sur le logo à l'entrée | Topbar + login |
| **Feed slide-in** | Nouvelles lignes d'activité : translateY(-8px) + fade 450 ms | Historique/activité |
| **Jauges grow** | scaleX(0→valeur) à l'entrée, transform-origin left | Jauges partout |

**Interdits conservés de v5** : pas d'emoji UI, pas de gradients décoratifs (seuls
sparkline/area et l'orbite y ont droit), pas de box-shadow flou hors glow-vivant.

## 5. Par page

- **Dashboard** : vitrine complète — tout le tableau ci-dessus (cf. mockup direction B).
- **Modules (Serveurs, Bots, Fichiers, Média, Web, Réseau, Diagnostic)** : héritent
  automatiquement (tokens + composants partagés) + entrée en cascade + hovers. Pas de
  redesign spécifique.
- **Vue serveur** (sidebar + onglets) : tokens + morphing de l'onglet actif de la sidebar.
- **login.html** : alignement tokens/typo + moment signature (logo shine + entrée cascade
  du formulaire). Page la plus « wow » autorisée puisqu'on n'y travaille pas.
- **Users/Settings/modales** : tokens + entrance, rien de spécifique.

## 6. Implémentation technique

**Fichiers touchés** (aucun nouveau fichier runtime, aucune dépendance) :
- `frontend/css/style.css` — tokens retouchés, blocs accents, keyframes motion, composants
  (`.nav-ind`, sweep, orbite, glow vivant). Les overrides legacy `!important` de PR7 restent
  compatibles (ils pointent les mêmes tokens).
- `frontend/js/anim.js` — v2 : cascade auto (pose `--i` sur les enfants directs des grilles),
  nav morphing, sparkline helper. API existante (`pageEnter`, `countUp`) conservée.
- `frontend/js/app.js` — hook `Anim` dans `navigateTo`, switcher 5 dots, migration accents.
- `frontend/index.html` + `frontend/login.html` — import Geist, cache-bust.
- `frontend/sw.js` — bump `CACHE_NAME`.

**Compat navigateur** : `color-mix()` et `@property` requièrent Chrome 111+/Safari 16.4+
(usage perso → OK). Fallback : sans `@property`, l'orbite dégénère en bordure statique
accent — acceptable, prévoir `@supports` si besoin.

**Perf** : glows = box-shadow statiques (pas d'animation de filter) sauf `breathe`
(opacity/scale). Micro-grille = background-image fixe. Cible : aucune animation en layout,
poll monitoring (20-30 s) ne doit PAS rejouer l'entrance (garde existante de `pageEnter`).

## 7. Déploiement & vérification

1. Branche dédiée `feat/frontend-ion` (worktree), TDD/subagents comme d'habitude.
2. Vérification locale navigateur (Chrome MCP) page par page AVANT push : entrance, hovers,
   5 accents, reduced-motion, 375 px.
3. `git fetch` + rebase sur `origin/main`, bump cache-bust AU-DESSUS des valeurs d'origin
   (workflow deploy connu), push → auto-deploy.
4. Vérif prod omenserver.org via Chrome MCP (versions servies + rendu + console).
5. Rollback : revert du commit (les tokens sont le seul point de couplage).

## 8. Hors périmètre

- Refonte de contenu/layout des pages (structure Bento conservée)
- Thème clair, framework JS, build step
- Directions Obsidienne/Arcade (archivées dans le mockup pour mémoire)
- Backend (aucun fichier Python touché)

## 9. Definition of Done

- [ ] Tokens Ion + 5 accents en place, migration localStorage OK
- [ ] Geist chargé, Inter retiré
- [ ] Motion : cascade, morphing nav, count-up, hover ressort, sweep, orbite, glow vivant, logo shine
- [ ] `prefers-reduced-motion` neutralise tout
- [ ] Login aligné
- [ ] Vérifié en local + en prod (Chrome MCP, 3 langues, 375 px, console propre)
- [ ] Cache-bust + SW bump
