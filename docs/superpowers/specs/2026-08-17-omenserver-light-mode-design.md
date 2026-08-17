# OmenServer — Mode clair « Givre » (Ion light)

**Date** : 2026-08-17
**Statut** : validé sur mockup (direction A choisie par Massii parmi 3)
**Mockup de référence** : `docs/superpowers/mockups/2026-08-08-light-directions.html` (direction A ; l'Artifact publié fait foi pour le rendu attendu)

---

## 1. But

Ajouter une **version blanche (« illuminée »)** du site omenserver.org, basculable par l'utilisateur via un **toggle noir ↔ blanc**. Le mode clair est la déclinaison « Givre » du design system Ion v6 : même ADN bleu-froid, papier givré, hairlines sans ombres, et la **console qui reste bleu-nuit** (îlot terminal dans l'UI claire).

Le dark actuel (Ion v6) ne change **pas d'un pixel** : ce chantier n'ajoute que des tokens et un mécanisme de bascule.

## 2. Décisions actées

| Décision | Choix | Pourquoi |
|---|---|---|
| Direction visuelle | **A — Givre** (vs B Illuminé, C Blanc sec) | Choix Massii sur mockup interactif |
| Défaut au chargement | **Dark, pour tout le monde** | Identité Ion ; le clair est un opt-in explicite. Pas de `prefers-color-scheme` : zéro surprise, zéro régression |
| Emplacement du toggle | **◐ dans la topbar**, entre les pastilles d'accent et le user-pill ; idem sur login | Validé sur mockup |
| Console en mode clair | **Reste bleu-nuit** (`.console`, `.events-feed`, blocs terminal-like) | Signature Givre ; le néon y reste lisible |
| Sémantiques | Règle amendée : « fixes **par mode** » | `#FBBF24` sur blanc est illisible ; versions foncées en light |
| Accents en light | **Déclinaisons foncées** des 5 néons | Les néons purs sont illisibles sur blanc (contraste < 1.5:1) |

## 3. Mécanisme de bascule

### 3.1 Attribut & persistance

- `data-mode="light"` posé sur `<html>` — symétrique de `data-accent`. **Absence d'attribut = dark** (aucun `data-mode="dark"` n'existe : l'état par défaut est l'absence, comme `data-accent` absent = green).
- Persistance : localStorage **`omen-mode`**, valeurs `'light'` | absente (= dark). Clé neuve — ne pas toucher `omen-theme` (encore lue par la migration legacy de `_loadAccent`).

### 3.2 Anti-flash (obligatoire)

Sans lui, chaque reload en mode clair paint d'abord le dark → flash noir→blanc. Un script inline dans le `<head>` de `index.html` **et** `login.html`, placé **avant** le `<link>` style.css :

```html
<script>try{if(localStorage.getItem('omen-mode')==='light')document.documentElement.setAttribute('data-mode','light')}catch(e){}</script>
```

⚠️ Vérifier à l'implémentation que la CSP du backend autorise ce script inline (des scripts/styles inline existent déjà dans index.html — si la CSP les tolère, celui-ci passe ; sinon, nonce ou déplacement en tête de app.js + `visibility` gate, à trancher au plan).

### 3.3 API JS (app.js)

- `App._loadMode()` au boot (à côté de `_loadAccent`) : lit `omen-mode`, pose l'attribut (redondant avec l'anti-flash mais idempotent — source de vérité unique), synchronise l'état du bouton.
- `App.setMode(mode)` : pose/retire `data-mode`, écrit/supprime `omen-mode`, met à jour `<meta name="theme-color">` (`#050810` dark ↔ `#EBF0FA` light), met à jour l'aria/état du bouton ◐.
- Comportement au switch : identique à `setAccent` (pas de re-render forcé de la vue). Conséquence acceptée v1 : un graphe Chart.js déjà peint garde ses couleurs jusqu'à la prochaine navigation (cf. §6.4).
- `login.html` : logique standalone (petit script local, pas de dépendance app.js) — même clé localStorage.

### 3.4 Le bouton ◐

- `.mode-btn` dans `.topbar-right`, entre `.accent-switcher-mini` et `.user-menu-wrap`. Sur login : même bouton, positionné en haut à droite de la carte de connexion (`position:absolute` dans la carte).
- **Icône = SVG inline** (cercle demi-rempli, `currentColor`), PAS le caractère ◐ ni un emoji : les sweeps emoji du projet (pièges #15/#17) strippent des ranges Unicode qui incluent les formes géométriques — un glyphe texte finirait en bouton vide au prochain sweep.
- Accessibilité : `aria-label` + `title` via `Lang.t('common.theme_toggle')` (nouvelle clé ×3 langues : « Basculer clair/sombre » / “Toggle light/dark” / « Tema chiaro/scuro »), `aria-pressed` reflétant le mode clair.

## 4. Tokens light (style.css)

Un bloc unique `html[data-mode="light"]` après les variants d'accent. Les vars legacy étant aliasées sur les tokens Bento, **tout le site suit sans toucher au HTML**.

### 4.1 Surfaces, bordures, texte

```css
html[data-mode="light"] {
    --bg:        #EBF0FA;
    --bg-elev-1: #F7FAFF;
    --bg-elev-2: #FFFFFF;   /* en light, l'élévation ÉCLAIRCIT (inverse du dark) */
    --bg-elev-3: #E3EAF6;   /* inputs : légèrement enfoncés */
    --border:        #CBD7EB;
    --border-strong: #A9BCDA;
    --text:       #0C1526;
    --text-muted: #46597E;
    --text-dim:   #7C8FB0;
    --top-light:  rgba(255, 255, 255, 0.85);
    --accent-text: #FFFFFF;  /* texte sur fond accent (accents foncés en light) */
}
```

### 4.2 Micro-grille body

La valeur `rgba(91,140,255,0.08)` est aujourd'hui **hardcodée** dans `body { background: … }` → la tokeniser en `--grid-dot` (dark : valeur actuelle ; light : `rgba(43, 84, 160, 0.10)`), consommée par la même déclaration `body`.

### 4.3 Les 5 accents (déclinaisons foncées)

Le défaut light (green) vit dans le bloc `[data-mode="light"]` ; les 4 autres en règles combinées, valeurs pré-calculées en dur (pattern existant — pas de `color-mix`, cohérence avec le reste du fichier) :

```css
html[data-mode="light"] { /* green par défaut */
    --accent: #00885C; --accent-dim: rgba(0,136,92,.11); --accent-glow: rgba(0,136,92,.22);
}
html[data-mode="light"][data-accent="cyan"]    { --accent:#0077A8; --accent-dim:rgba(0,119,168,.11);  --accent-glow:rgba(0,119,168,.22); }
html[data-mode="light"][data-accent="violet"]  { --accent:#6A3FE0; --accent-dim:rgba(106,63,224,.12); --accent-glow:rgba(106,63,224,.24); }
html[data-mode="light"][data-accent="magenta"] { --accent:#D01C7C; --accent-dim:rgba(208,28,124,.11); --accent-glow:rgba(208,28,124,.22); }
html[data-mode="light"][data-accent="amber"]   { --accent:#A96A00; --accent-dim:rgba(169,106,0,.12);  --accent-glow:rgba(169,106,0,.22); }
```

Le glow à ~22 % (vs 65 % dark) suffit à faire vivre orbite, badge LIVE, dots online — en « lumière du jour ». La couche motion Ion (orbite conique, sweep, nav morphing, cascade) n'est **pas modifiée** : elle consomme les tokens.

### 4.4 Sémantiques par mode

```css
html[data-mode="light"] {
    --danger:  #B91C1C;
    --warning: #92400E;   /* amber-800 — le 700 (#B45309) mesurait 4.3:1 sur pastel, sous AA */
    --info:    #1D4ED8;
    --violet:  #7C3AED;
    --orange:  #C2570A;
}
```

Les **fonds** pastel construits en rgba hardcodées sur les teintes claires (ex. `.badge.warn` `rgba(251,191,36,0.12)`) **restent tels quels** : fond jaune pâle + texte `#92400E` = paire lisible classique. Seuls les tokens texte changent. S'y ajoutent (décision d'audit) les pendants light des **alias legacy chromatiques** `--accent-green/-blue/-cyan/-red/-purple/-yellow`, alignés sur les mêmes déclinaisons foncées.

### 4.5 Console (nouveaux tokens, invariants au mode)

```css
:root {
    --console-bg:     #0A101E;
    --console-border: #1C2947;
    --console-text:   #C7D4EC;
    --console-dim:    #5A6C90;
    --console-accent: var(--accent);        /* dark : l'accent EST néon */
    --accent-neon:    #00FFB0;              /* + une valeur par variant d'accent */
}
html[data-mode="light"] { --console-accent: var(--accent-neon); }
```

- Chaque règle `[data-accent="…"]` existante gagne son `--accent-neon` (la valeur néon de l'accent). En light, le OK/online **dans la console** reste néon sur bleu-nuit au lieu de l'accent foncé (terne sur fond sombre).
- Composants migrés vers ces tokens : `.console`, `.events-feed` (fond, bordure, `.ts`, `.typ.ok`), et tout bloc « terminal-like » identifié à l'audit (viewer de logs serveur, sortie RCON…). Warn/err dans la console gardent les teintes claires dark (`#FBBF24`/`#F87171`) — lisibles sur bleu-nuit — donc **valeurs console dédiées**, pas les tokens sémantiques du mode.

## 5. Audit des couleurs hardcodées

État mesuré : **~62 hex + 24 `rgba(0,0,0,…)`/`rgba(255,255,255,…)`** hors tokens dans style.css. Traitement par catégorie :

| Catégorie | Exemples | Traitement |
|---|---|---|
| Voiles clairs sur surfaces (hover, barres, rails) | `rgba(255,255,255,.03/.06/.07)` | Nouveaux tokens `--surface-hint` / `--surface-hint-strong` — dark : blanc alpha actuels ; light : `rgba(12,21,38,.04/.08)` |
| Ombres portées | `rgba(0,0,0,.35)` (user-menu) | Token `--shadow-drop` — light : `rgba(20,40,90,.15)` |
| Contraste sur accent | `.brand .logo { color:#0A0A0A }` | → `var(--accent-text)` |
| Fonds sémantiques pastel | `rgba(251,191,36,.12)` etc. | Inchangés (§4.4) |
| Couleurs console/terminal | — | → tokens `--console-*` (§4.5) |
| Reliquats legacy morts | à découvrir | Supprimer ou tokeniser au cas par cas |

L'audit exhaustif (grep + classement des 86 occurrences) est une tâche du plan d'implémentation, pas de la spec.

## 6. Points d'attention connus

1. **Fallback `<style>` inline d'index.html** (piège Ion d) : il pose des couleurs dark en dur avant le chargement de style.css. Vérifier qu'il est bien surchargé en light (spécificité) ; sinon le neutraliser par des règles `[data-mode="light"]` équivalentes dans style.css — ne pas gonfler le fallback.
2. **Nullifieurs PR7 / bloc ION** (pièges Ion a-c) : les overrides `!important` legacy s'appliquent aussi en light puisqu'ils consomment les tokens — mais tout `!important` portant une COULEUR en dur trouvé à l'audit doit être tokenisé.
3. **Chart.js** (`sv_monitoring`) : reçoit ses couleurs en JS. À l'implémentation : lire les tokens via `getComputedStyle` au moment du draw (pas de constantes), accepter qu'un chart déjà peint ne se rethème qu'à la prochaine navigation (même sémantique que `setAccent`).
4. **Sparkline Dashboard** : stylée en CSS (`stroke: var(--accent)`) → suit toute seule.
5. **Carte MC** : canvas parchemin, palette propre indépendante du thème → intacte, aucune modification.
6. **PWA** : la `<meta theme-color>` du document devient dynamique (§3.3) ; `manifest.json` (splash) **reste dark** — assumé.
7. **Service Worker / caches** (pièges #9-#11, #35-bis) : bump `style.css?v=`, `app.js?v=`, `lang.js?v=` (nouvelle clé i18n), `login.html` modifiée, `CACHE_NAME` sw.js. Après deploy : 2 reloads pour activer le nouveau SW.

## 7. Périmètre

**Inclus** : style.css (tokens light + audit hardcodés + tokens console), index.html + login.html (script anti-flash, bouton ◐, cache-bust), app.js (`_loadMode`/`setMode`), lang.js (1 clé ×3), sw.js (bump).

**Exclus** : directions B/C du mockup, `prefers-color-scheme` auto, splash PWA light, thèmes par-utilisateur côté backend (tout est localStorage, comme l'accent), carte MC, docs/mockups existants, emails/PDF.

## 8. Vérification (verify-ui, avant et après deploy)

1. **Bascule** : ◐ light↔dark sans reload, sur Dashboard / Serveurs / Bots / Réseau / Diagnostic / vue serveur (sidebar + onglets) / login.
2. **Persistance & anti-flash** : reload en light → aucun flash noir ; nouvel onglet → light conservé ; clear localStorage → dark.
3. **Matrice accents** : 5 accents × 2 modes sur le Dashboard (valeur néon carte main, orbite, badges, boutons) — spot-check contraste (texte muted sur --bg, blanc sur accent foncé).
4. **Console** : events-feed bleu-nuit en light, OK néon dedans, warn/err lisibles.
5. **Meta theme-color** suit le mode (inspection DOM).
6. **Prod** : versions servies (`?v=`), SW activé, switch live dans la session Chrome de Massii.

Pas de tests unitaires front (le repo n'en a pas pour l'UI) — la vérification navigateur ci-dessus fait foi. Aucun test backend impacté (zéro changement Python).
