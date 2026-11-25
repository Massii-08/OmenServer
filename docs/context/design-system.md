# Design System v6 « Ion »

Extrait du CLAUDE.md racine le 2026-11-25. Pièges : aucun.

## 🎨 Design System v6 « Ion » (sur base Bento Tech v5)

> **Depuis le 12 juillet 2026, le frontend est en Ion v6** : mêmes NOMS de tokens et mêmes
> composants que v5 (tout ce qui suit reste valable), mais nouvelles VALEURS (bleu-nuit +
> néon) + couche motion. Spec : `docs/superpowers/specs/2026-07-12-omenserver-ion-redesign-design.md`.
> Mockup validé : `docs/superpowers/mockups/2026-07-12-ion-directions.html` (direction B).
>
> **2 règles Ion** : (1) le **néon = information vivante** (online/LIVE/données temps réel),
> jamais décoratif ; (2) le **mouvement = physique** (ressorts, transform/opacity only).
>
> **Tokens Ion** (remplacent les valeurs v5 listées plus bas — le reste de la section v5 fait foi
> pour les composants) : `--bg #050810` · `--bg-elev-1 #0A101E` · `--bg-elev-2 #0E1526` ·
> `--bg-elev-3 #131C33` · `--border #1C2947` · `--border-strong #2C4066` · `--text #EDF2FA` ·
> `--text-muted #8FA3C4` · `--text-dim #5A6C90` · `--accent #00FFB0` (vert électrique) +
> **nouveaux** `--accent-glow` (halo du vivant) et `--top-light` (lumière haute des cartes).
> Fond body = micro-grille pointillée bleue. **Typo : Geist** (Inter retiré) + Geist Mono.
> Les vars legacy (`--bg-primary`…) sont des **alias** des tokens Bento → re-thème atomique.
>
> **5 accents** via `data-accent` : `green` (défaut) / `cyan #00D2FF` / `violet #8B5CFF` /
> `magenta #FF3DA6` / `amber #FFB020` — migration auto localStorage (blue→cyan, red→magenta,
> yellow→amber) dans `App._loadAccent()` (étape « 1bis », APRÈS la migration omen-theme). 5 dots topbar.
>
> **Couche motion** (fin de style.css, bloc « ION v6 » + `anim.js` v2) : cascade d'entrée 70 ms
> (rejouée par navigation, jamais par les polls), count-up, **nav morphing** (pill `.nav-ind`
> créé par `Anim.navInit()`, le pill EST le fond de l'onglet actif via `:has()`), hover ressort
> + glow accent (pas sur `.offline`), sweep radar, **orbite conique** sur `.stat-card.main`
> (Dashboard uniquement, `@property --omen-ang`), glow vivant (`.badge.online`,
> `.status-badge.online` en `!important`), logo shine one-shot, reduced-motion complet.
>
> **⚠️ Pièges Ion appris à la review/vérif** : (a) le nullifieur PR7
> `.bento-overview .stat-card::before { content:none !important }` (L~2185) doit rester en
> `:not(.main)` sinon il tue l'orbite ; (b) le `::before` legacy L~635 pose `height:3px` →
> l'orbite DOIT déclarer `height:auto` (sinon anneau écrasé en lamelle) ; (c) la topbar porte
> `nav-tab` ET `nav-item` → les règles sidebar legacy (`.nav-item.active`) s'y appliquent ;
> (d) le grid inline du Dashboard bat les breakpoints → overrides `[style]` + `!important`
> en media query ; (e) `getComputedStyle` via le pane Claude peut mentir (monde isolé) —
> trancher au screenshot.

### 🌗 Mode clair « Givre » (2026-08-17)

> **Toggle noir ↔ blanc** : bouton ◐ (SVG inline — JAMAIS le caractère ◐, les sweeps emoji
> strippent les formes géométriques, cf. #17) dans la topbar + login. Mécanisme :
> `data-mode="light"` sur `<html>` (absence = dark, défaut pour tous), localStorage
> **`omen-mode`** (`'light'` | absente — on ne stocke jamais 'dark'), script inline
> **anti-flash** dans le `<head>` des 2 pages AVANT les `<link>`, `App._loadMode()/toggleMode()/
> _applyMode()` (miroir de `_loadAccent`/`setAccent`), meta theme-color dynamique
> `#050810 ↔ #EBF0FA`. Spec : `docs/superpowers/specs/2026-08-17-omenserver-light-mode-design.md`.
>
> **Principes Givre** : un bloc `html[data-mode="light"]` redéfinit les tokens (surfaces
> `#EBF0FA/#F7FAFF/#FFF/#E3EAF6` — l'élévation ÉCLAIRCIT, inverse du dark) ; accents =
> **déclinaisons foncées** (`green #00885C · cyan #0077A8 · violet #6A3FE0 · magenta #D01C7C ·
> amber #A96A00`, les néons purs font <1.5:1 sur blanc) ; glows conservés à ~22 % ;
> **sémantiques « fixes PAR MODE »** (`--danger #B91C1C · --warning #92400E (amber-800, le 700
> mesurait 4.3:1 = sous AA) · --info #1D4ED8 · --violet #7C3AED · --orange #C2570A`), les FONDS
> pastel rgba restent ; les **alias legacy chromatiques** (`--accent-green/-blue/-cyan/-red/
> -purple/-yellow`) ont leurs pendants foncés dans le bloc light ; pastilles d'accent = tokens
> pairés `--dot-*` (néon en dark, foncé WYSIWYG en light) ; voiles/ombres = `--surface-hint(-strong)`
> / `--shadow-drop` (blanc alpha en dark, encre bleu-nuit en light) ; les scrims de modale restent
> sombres dans les 2 modes.
>
> **Console = INVARIANTE au mode** (signature Givre) : `.console`, `.events-feed`,
> `.yield-terminal`, `.log-output` etc. sur tokens `--console-*` (bg `#0A101E` bleu-nuit) ;
> dedans, l'accent redevient **néon** via `--console-accent: var(--accent-neon)` et warn/err
> gardent les teintes claires (`--console-warn/-err`).
>
> **⚠️ Pièges Givre** : (a) le **fallback `<style>` inline** d'index/login DOIT rester AVANT les
> `<link>` — placé après, il gagnait la cascade à spécificité égale et écrasait `body` (la
> micro-grille Ion n'avait JAMAIS été rendue à cause de ça, invisible car #050810==#050810) ;
> (b) son **miroir light** dans style.css utilise `html:where([data-mode="light"]) …` = spécificité
> (0,0,2) calibrée : bat les type-selectors du fallback (0,0,1), perd contre toute classe (0,1,0) ;
> (c) `color-scheme: light` dans le bloc light (form controls/scrollbars natifs — la propriété CSS
> bat la meta) ; (d) **vérif via le Browser pane : l'onglet en arrière-plan GÈLE les transitions
> CSS** (`getAnimations()` → `running` à `currentTime: 0` pour toujours) → l'écran ET les computed
> montrent la valeur de DÉPART ; trancher avec un élément sonde sans transition ou
> `el.getAnimations().forEach(a => a.finish())` — extension du piège #46 throttling ;
> (e) `.btn-danger` (override PR7) utilise `color: var(--bg)` comme encre — lisible dans les 2
> modes mais sémantiquement tordu, à savoir avant de « corriger » ; (f) Chart.js lit ses couleurs
> au draw → un graphe déjà peint se rethème à la navigation suivante (même sémantique que
> `setAccent`, assumé).

### Tokens canoniques v5 (HISTORIQUE — valeurs remplacées par Ion, noms inchangés)

```css
--bg          #0E0E10    /* page background */
--bg-elev-1   #161618    /* default surface (cards) */
--bg-elev-2   #18181B    /* hover state, big cards */
--bg-elev-3   #1F1F23    /* inputs, avatars, code blocks */
--border      #27272A    /* hairline */
--border-strong #3F3F46  /* emphasized */
--text        #F4F4F5    /* primary */
--text-muted  #A1A1AA    /* secondary */
--text-dim    #71717A    /* tertiary, timestamps */
--accent      #4ADE80    /* CHANGEABLE via data-accent */
--accent-dim  rgba(74,222,128,.14)
--danger      #F87171    /* FIXED — semantic only */
--warning     #FBBF24
--info        #60A5FA
--violet      #C084FC    /* developer role */
--orange      #FB923C    /* money role */
--font-ui     'Inter'
--font-mono   'Geist Mono'  /* ALL numbers via font-feature-settings:"tnum" */
--r-sm/md/lg  8 / 10 / 14 px
--s-1 .. --s-12  4 .. 48 px (scale 4px base)
```

### Accent variants (changent uniquement `--accent`)

```css
[data-accent="blue"]   { --accent: #60A5FA; ... }
[data-accent="red"]    { --accent: #FB7185; ... }
[data-accent="yellow"] { --accent: #FACC15; ... }
/* default green stays in :root */
```

L'accent est persisté en localStorage (`omen-accent`). Migration auto depuis les anciens
thèmes (midnight→blue, crimson→red, emerald/default→green) au boot via `App._loadAccent()`.

### Composants Bento (à utiliser en priorité)

| Class | Usage |
|---|---|
| `.bento-overview` + `.stat-card` | Grille de stats Dashboard / Network / Tasks |
| `.bento-overview .stat-card.big` | Card 2× plus grosse (span 2 rows) |
| `.bot-card-bento` (+ `.b-head/.b-name/.b-actions/.b-desc`) | Bot cards module |
| `.diag-strip` + `.diag-grid` + `.diag-item` (`.warn`/`.err`) | System health checks |
| `.badge` (+ `.online`/`.warn`/`.danger`) | Status pills universel |
| `.role-pill` (`.admin`/`.developer`/`.moderator`/`.money`/`.player`/`.spectator`) | Rôles RBAC |
| `.access-pill` (`.owner`/`.manage`/`.start`/`.view`) | Per-resource sharing level |
| `.mod-chip` | `User.allowed_modules` indicator |
| `.row` + `.row-list` | Compact list items (servers, bots, etc.) |
| `.events-feed` + `.ev` (+ `.typ.ok/.warn/.err`) | Activity log mono |
| `.sparkline` | Aréa chart subtil sous big stat |
| `.machines-grid` + `.machine-card` (+ `.brain`/`.arm`/`.offline`) | Network of machines (omen + agents) |
| `.users-table` (+ `.u-head/.u-row/.u-name`) | Tableau utilisateurs |
| `.tasks-table` | Scheduler global |
| `.mod-grid` + `.mod-card` | Plugin/Mod/Workshop browser |
| `.dropzone` | Upload zone |
| `.accent-switcher-mini` + `.accent-dot` | Switcher 4 couleurs (topbar right) |
| `.sv-layout` + `.sv-sidebar` + `.sv-tab` (+ `.active/.share/.danger`) | Server view sidebar |
| `.topbar` + `.brand .logo` + `.nav-tabs` + `.nav-tab` | Top bar navigation (PR26) |
| `.lang-switcher` + `.lang` (`.active`) | Pill segmenté FR/EN/IT (PR26) |
| `.user-pill` + `.user-avatar` + `.user-meta` + `.user-caret` | Avatar + nom + rôle (topbar right) — cliquable depuis PR37, ouvre `.user-menu` |
| `.user-menu-wrap` + `.user-menu` + `.user-menu-item` (+ `.danger`) + `.user-menu-sep` | Dropdown sous le profil avec actions account-scope (Utilisateurs admin-only, Paramètres, Logout) — PR37/PR38 |
| `.tab-badge` | Badge count sur nav-tab (PR32 — background jobs) |
| `.b-ticker` | Mono text ticker chip (replace emoji avatars, PR27) |
| `.game-ico` | Idem pour game server cards (`MC`/`ARK`/`CS2`, PR24) |
| `.login-brand` + `.login-logo` + `.login-brand-text` | Login page brand (matches topbar, PR33) |

### Règles d'usage

- **Tous les chiffres** : `font-family: var(--font-mono); font-feature-settings: "tnum"`
- **Couleurs sémantiques** (`--danger`/`--warning`/`--info`) : **FIXES**, ne suivent JAMAIS l'accent
- **`--accent`** uniquement pour : status "online", deltas positifs, primary CTA active,
  nav item actif, role-pill `.admin` (signature owner)
- **Surfaces** : 3 niveaux (`--bg-elev-1/2/3`), JAMAIS d'ombre, hairline border 1px
- **Border-radius** : échelle `--r-sm` (8) / `--r-md` (10) / `--r-lg` (14) / `--r-pill` (999) uniquement
- **Anti-patterns** : pas de gradients (sauf sparkline), pas de glassmorphism, pas d'emoji UI,
  pas de `box-shadow` flou, pas de hex hardcodé dans les composants

### Coexistence avec le legacy

PR 1-6 ont ajouté les nouveaux tokens **sans supprimer** les anciens (`--bg-primary`, `--accent-green`, etc.).
PR 7 a appliqué des **overrides `!important`** sur les classes legacy (`.sidebar`, `.module-card`,
`.btn-primary`, `.status-badge`, etc.) pour les rendre Bento Tech sans toucher au HTML.

**Évolution session 26 mai PM** :
- PR12 : purge complète du système de thèmes legacy (`_themes`, `cycleTheme`, `toggleLightMode`, `_loadTheme`)
- PR17/18 : sweep JS automatique de TOUS les `var(--legacy)` et hex hardcodés (~490 substitutions)
- PR24 : `modules-grid` (6 module-cards emoji) **supprimé du Hub** — la nav passe par la topbar
- PR26 : sidebar verticale **remplacée** par topbar horizontale
- PR27-29-34 : sweep nucléaire emojis (lang.js + tous JS modules) — UI 100% text/iconography mono
- PR31 (backend) : CSP `img-src` étendu pour autoriser `forgecdn.net` + `cdn.modrinth.com` + Steam Workshop + Spigot CDN (modpack thumbnails)
- PR33 : login.html aligné sur topbar Bento (brand `O OMENSERVER` + pill FR/EN/IT)

**Évolution session 27 mai (aftermath sweep nucléaire)** :
- PR35 : 4 boutons devenus vides après PR34 (boutons emoji-only → emoji strippé → contenu vide). Fix : labels texte i18n via `Lang.t()` partout, créer les clés manquantes (`sharing.share_btn`, `sv.files.rename`). Aussi : supprimé `.sharing-search-wrap::before { content: '🔍' }` + migré vars CSS legacy (`--bg-primary`, `--accent-blue`) vers tokens Bento.
- PR35-bis : oubli cache-bust JS individuels — bumper seulement `style.css?v=` + `sw CACHE_NAME` ne propage pas les fixes JS car le disk cache browser sert encore `lang.js?v=N` (URL inchangée). Toujours bumper le `?v=` de chaque JS modifié dans `index.html`.
- PR36 : 2 nouveaux symptômes post-PR35 (Massii spotted) — boutons serveur "Arrêter/Redémarrer/Partager" superposés (`.btn-icon` force 38×38px, texte déborde) + boutons Clé API Agents vides (👁/📋 strippés + code `cond ? '' : ''` smell). Fix : retirer `.btn-icon` quand on met du texte + labels i18n sur toggle/copy + placeholder masqué = 40 bullets `•`.

**Évolution session 28 mai (topbar → dropdown profil)** :
- PR37 : tab "Paramètres" inaccessible (caché derrière `.topbar-right` par overflow-x: auto). Solution > déplacer Paramètres + Déconnexion dans un dropdown sous le `.user-pill` (avatar+nom+rôle+caret ▾). Nouveau composant `.user-menu` : position absolute top:100%+8px right:0, animation `user-menu-in` 140ms (fade+translate), shadow `rgba(0,0,0,0.35)`. JS : `App._toggleUserMenu()` + click-outside (capture phase, armé/désarmé à l'ouverture) + Esc handler + restore focus. `Lang.set()` appelle maintenant `App.updateUserInfo()` pour rafraîchir les labels du dropdown au switch FR/EN/IT (les éléments statiques de la topbar n'étaient pas re-traduits avant). Aussi : `min-width: 0` sur `.nav-tabs` (flex children scrollables nécessitent ça pour shrink correctement).
- PR38 : extension de PR37 — "Utilisateurs" (auparavant tab admin-only `display:none`) rejoint le même dropdown au-dessus de Paramètres. Visibility via `item.hidden = !user.is_admin` (toggle propre, pas `style.display` inline). Ordre menu : **admin > self > danger** (séparateur hairline avant le danger). Pattern à généraliser : *toute action account-scope future* (changer mdp, switch user, sessions actives, etc.) doit atterrir dans ce même dropdown.

**Pour migrer un composant non-encore-refactoré** :
1. Identifie son HTML render dans `frontend/js/*_module.js` ou `app.js`
2. Remplace ses classes legacy par les classes Bento ci-dessus
3. Supprime les inline `style="..."` (les classes font le boulot)
4. Supprime les overrides `!important` correspondants en bas de `style.css`
5. Bump `style.css?v=X` dans `index.html` + `CACHE_NAME` dans `sw.js`

### Référence design

- **Mockups interactifs** : `frontend/design-explorations/proposals.html` (5 directions comparison)
  et `frontend/design-explorations/proposals-v2.html` (Bento Tech 10-page mockup complet)
- **MASTER.md** : design system formel avec tokens, composants, plan migration
  (dans la branche `design/bento-tech-mockup`, pas sur `main`)
- **Backend RBAC** (source de vérité pour rôles, quotas, permissions) :
  [backend/auth/permissions.py:29](backend/auth/permissions.py:29)
- **Server view tabs logic** (conditionnels Plugins/Mods/Workshop par type) :
  [frontend/js/server_view.js:71](frontend/js/server_view.js:71)
