# Carte du mappeur MC Agent — restyle « item carte » Minecraft

**Date** : 2026-07-14
**Statut** : validé par Massii (direction A du mockup, option labels A)
**Mockup de référence** : `docs/superpowers/mockups/2026-07-14-mc-map-directions.html`
(direction A retenue parmi 3 ; artifact : https://claude.ai/code/artifact/3fdd8289-f347-44bc-be47-9cdbbe412e8f)

## 1. Objectif

Rendre la carte du groupe de mappeurs (onglet Mapping → « Ouvrir la carte ») lisible et
« façon Minecraft » : le rendu doit évoquer l'item carte tenu en main dans le jeu.
Trois axes validés :

1. **Style item carte** — fond parchemin, couleurs de map officielles MC, curseur de
   spawn du jeu, bord déchiré.
2. **Icônes de structures compréhensibles** — pixel-art 16×16 dédié par type, + nom
   affiché à côté dès que le zoom le permet, + nom dans le bandeau de survol.
3. **Nettoyage** — les « trouvailles » (mémoire interne du bot) disparaissent de la carte.

**Périmètre : 100 % frontend.** Aucun changement backend, aucun changement de format de
données, aucune nouvelle dépendance réseau (la police est self-hostée).

## 2. Fichiers touchés

| Fichier | Nature |
|---|---|
| `frontend/js/bots_module.js` | L'essentiel : constantes sprites/couleurs + refonte des fonctions `_mcaMap*` de dessin/légende |
| `frontend/js/lang.js` | 13 clés `mcagent.map.struct.*` × 3 langues (§4.4) |
| `frontend/fonts/press-start-2p-latin.woff2` | **Nouveau** — police pixel (subset latin, ~4,7 Ko, licence OFL) |
| `frontend/css/style.css` | `@font-face 'PSP'` (police utilisée uniquement par le canvas) |
| `frontend/index.html` | cache-bust `bots_module.js?v=`, `lang.js?v=`, `style.css?v=` |
| `frontend/sw.js` | bump `CACHE_NAME` (+ le woff2 suit le fetch runtime, pas besoin de précache) |

Rien d'autre. Les endpoints (`/api/mc-agent/world-memory…`), le format `worlds[].biomes/
caves/structures/finds` et la mémoire du bot ne bougent pas.

## 3. Rendu de la carte (`_mcaMapDraw`)

### 3.1 Fond parchemin + cadre

- Zone carte (l'« exploré » potentiel) : parchemin `#d4bb8d`. Pourtour du canvas :
  parchemin sombre `#a8895c`, avec **bord déchiré** = crans pixel (~6 px) déterministes
  (hash positionnel, stable au redraw) sur le pourtour intérieur + double liseré brun
  `rgba(74,50,22,0.55)`.
- Le conteneur `.frame` du canvas (style inline dans `_renderGroupMap`) passe de
  `background:#0B0B0D` à un fond parchemin extérieur pour des coins arrondis propres.
- Les cellules non couvertes par un biome connu restent parchemin nu = zone pas encore
  cartographiée (sémantique « la map se remplit », comme en jeu).
- L'empty-state (`mca-map-empty`) et son overlay restent, mais le texte doit rester
  lisible sur parchemin (couleur encre brune, pas `--text-muted`).

### 3.2 Couleurs de biomes = map colors MC

`_mcaBiomeColor(name)` est réécrite : le **matching regex existant est conservé tel
quel** (l'ordre des règles `_MCA_BIOME_RULES` aussi — crimson/warped avant forest, etc.),
mais chaque règle sort désormais une **couleur de map officielle MC** (hex fixe) au lieu
d'un HSL thématique. Correspondances (base, léger jitter hashé conservé en luminosité
uniquement, ±4 %, pour distinguer les variantes d'une même famille) :

| Famille (regex existante) | Couleur base | Réf. map color |
|---|---|---|
| ocean/river/water/aquifer | `#4040F0` | WATER |
| plain/meadow/field/pasture | `#8AB84F` | GRASS |
| forest/wood/birch/cherry | `#4C8A2E` | PLANT foncé |
| jungle/bamboo | `#2C9E1A` | PLANT vif |
| desert/beach/badland/sand/dune | `#F7E9A3` | SAND (badland : `#D87F33` TERRACOTTA si le nom contient badland) |
| savanna | `#B8A94E` | herbe savane |
| swamp/mangrove/bog | `#62703A` | herbe swamp |
| taiga | `#5C8A5A` | épicéa |
| frozen/snow/ice/grove | `#D8E2D8` | SNOW |
| peak/mountain/hill/slope/stony/windswept/gravel | `#7A7A7A` | STONE |
| mushroom | `#8F7748` + jitter violet | MYCELIUM |
| dripstone | `#976D4D` | DIRT |
| lush | `#4C9E4C` | verdure claire |
| deep_dark/sculk | `#10344A` | sculk sombre |
| cave/deep | `#5A4D3A` | brun caverne |
| nether/basalt/soul/magma/delta | `#7A3327` | NETHERRACK |
| crimson | `#943F3F` | crimson |
| warped | `#2E7A73` | warped |
| \bend\b/void/barren | `#D8D0A8` | END_STONE |
| **fallback custom datapack** | hash → une couleur parmi une petite palette terre/verdure (plus de HSL arbitraire criard) |

### 3.3 Grain dithéré

Chaque cellule biome reçoit un tramage de sous-tuiles (3 nuances : ×0.92 / ×1 / ×1.07,
seuils 22 % / 82 %) au **hash déterministe** (fonction du couple cellule + sous-position,
PAS de `Math.random`) → aucun scintillement entre redraws.

**Garde-fou perf** : taille de sous-tuile adaptative `g = max(6, cell/16)` → ≤ ~256
fillRect par cellule ; grain désactivé quand `cell < 12 px` (dézoom fort). Si le drag
rame malgré ça sur la machine de Massii, plan B connu (offscreen canvas par monde,
re-rendu au zoom seulement) — hors scope initial.

### 3.4 Habillage

- **Spawn (0,0)** : curseur de map MC = carré blanc tourné 45°, contour noir 2 px
  (remplace la croix).
- **Grille 128** : conservée mais encre brune très faible `rgba(90,60,20,0.07)` (seuil
  d'apparition zoom inchangé).
- **Barre d'échelle** : conservée, restylée encre brune, texte en police pixel.
- **Bandeau coords** (`mca-map-coords`) : inchangé fonctionnellement, + nom de structure
  survolée (cf. §4.3).

## 4. Structures & grottes

### 4.1 Sprites pixel-art 16×16

Les 13 sprites validés dans le mockup sont repris **tels quels** (constante `SPR` :
grilles de 16 chaînes + palette par sprite, `'.'` = transparent ; fonction `drawSpr`
avec passe d'ombre portée dure décalée +1 px) :

`village` (maison), `dungeon` (spawner), `monument` (prismarine), `ancient_city`
(warden), `stronghold` (œil de l'Ender), `mineshaft` (galerie + rail), `ruined_portal`
(obsidienne + or), `desert_pyramid`, `jungle_pyramid`, `pillager_outpost` (tour),
`shipwreck` (navire), `fortress` (nether), `cave` (entrée de grotte).

- Échelle sur carte : 2 px/pixel (icône 32 px), constante.
- Les **grottes** utilisent le sprite `cave` (le triangle disparaît).
- **Type inconnu** (nouveau kind backend jamais stylé) : fallback = pastille + initiale
  actuelle (on garde `_structColor`/`_structInitial` comme filet), pour ne jamais rendre
  un point invisible.

### 4.2 Labels à côté des icônes (option A validée)

- Dès que `128 × scale ≥ 45 px` (≈ scale 0.35), chaque structure affiche son **nom sur
  étiquette parchemin** à droite de l'icône : fond `rgba(240,225,185,0.92)`, liseré brun,
  texte encre `#4A3216`, **police pixel 8 px** (pas plus petit : illisible).
- Les grottes n'ont **pas** de label (trop nombreuses, elles ont le tooltip).
- Pas d'anti-chevauchement au premier jet (structures éparses par nature) ; si un monde
  réel s'avère dense, dédup simple ultérieure.

### 4.3 Info-bulle au survol

`_mcaMapCoords` (déjà branché sur pointermove) : si une structure ou une grotte est à
< 14 px écran du curseur, le bandeau affiche `x · z · biome · <Nom structure>`
(+ `y` de la grotte si présent dans la donnée).

### 4.4 Noms i18n

13 clés nouvelles `mcagent.map.struct.<kind>` en FR/EN/IT dans `lang.js`
(Village, Donjon, Monument, Cité ancienne, Stronghold, Mine abandonnée, Portail en
ruine, Pyramide, Temple jungle, Avant-poste, Épave, Forteresse, Grotte). Fallback pour
kind inconnu : `kind.replace(/_/g,' ')` (comportement légende actuel).
⚠️ cache-bust `lang.js?v=` aussi, du coup.

### 4.5 Légende

- Chips **biomes** : swatch carré recoloré map colors (mécanique toggle inchangée).
- Chips **structures** : mini-icône sprite (mini-canvas 16×16 par chip, ou le sprite
  rendu à 1 px/pixel) + nom i18n + compte. Toggle inchangé.
- Chip **grottes** : mini-icône `cave` + compte. Toggle inchangé.
- Section **finds : supprimée** (cf. §5).

## 5. Suppression des « trouvailles »

- `_mcaMapDraw` : bloc `world.finds` retiré.
- `_mcaMapLegend` : section finds + `_mcaMatColor`/`_MCA_MAT_COLORS` retirés s'ils ne
  servent plus qu'à ça (vérifier les autres usages : `_oreColor` sert les barres quota —
  ne pas y toucher).
- `_mcaMapFit` : les finds sortent du calcul d'étendue.
- `_mcaMapSync` : les finds sortent du test `has` (empty state).
- **Aucun changement backend** : la donnée `finds` continue d'exister et d'être servie ;
  seul l'affichage carte l'ignore.

## 6. Police pixel

- `frontend/fonts/press-start-2p-latin.woff2` (Google Fonts, subset latin U+0000-00FF —
  couvre É/é/ô des noms FR/IT ; licence SIL OFL, redistribuable).
- `@font-face { font-family:'PSP'; src:url('/fonts/press-start-2p-latin.woff2') …
  font-display:swap; }` dans `style.css`.
- Usage **canvas uniquement** (étiquettes, échelle) : `ctx.font = '8px PSP, monospace'`
  (littéral — `ctx.font` ne résout pas les vars CSS, piège déjà connu).
- **Chargement** : une @font-face n'est fetchée que si utilisée → au montage de la carte,
  `document.fonts.load("8px PSP").then(redraw)` (fallback monospace en attendant, aucun
  blocage si le fetch échoue).

## 7. Ce qui ne change pas

Pan/drag, zoom molette centré curseur, fit 90 %, sélecteur de monde (overworld/nether/
end — les couleurs nether/end sont couvertes par §3.2), auto-refresh 5 s carte ouverte,
bouton Ouvrir/Fermer la carte, roster cartographes sous la carte, RBAC admin-only.

## 8. Compatibilité & pièges connus à respecter

- `ctx.roundRect` (étiquettes) : Chrome 99+. Fallback `fillRect` simple si absent
  (une ligne de garde).
- **CSP backend** : vérifier que la directive `font-src` (ou le fallback `default-src`)
  de `backend/main.py` autorise `'self'` — sinon le woff2 self-hosté est bloqué en
  silence et le canvas retombe sur monospace (échec silencieux type piège #16).
- Parse-check avant push : `node -e "new Function(require('fs').readFileSync('frontend/js/bots_module.js','utf8'))"`
  (piège #28).
- Cache-bust : `bots_module.js?v=`, `lang.js?v=`, `style.css?v=` dans `index.html` +
  `CACHE_NAME` dans `sw.js` (pièges #9/#10/PR35-bis). Après deploy, 2 reloads pour que
  le nouveau SW serve l'index.
- Ne **pas** pusher pendant qu'un scan/grind tourne (piège #30f) — vérifier le badge
  Bots avant deploy.
- Branche dédiée `feat/mc-map-minecraft-style` (la branche courante `feat/oracle-dashboard`
  est un autre chantier) ; deploy = push `feature:main` après rebase sur `origin/main`
  + bump des `?v=` au-dessus des valeurs d'origin (workflow deploy habituel).

## 9. Critères d'acceptation

1. Carte ouverte sur un groupe avec données : fond parchemin + bord déchiré, biomes en
   couleurs map MC, grain stable (pas de scintillement au drag), spawn = curseur MC.
2. Les 3 mondes (overworld/nether/end) ont des palettes cohérentes.
3. Chaque structure connue affiche son icône pixel-art ; zoom ≥ seuil → nom sur étiquette
   parchemin ; survol → nom dans le bandeau coords ; kind inconnu → fallback pastille.
4. Les grottes = sprite cave, plus de triangles.
5. Plus aucun losange de trouvailles (dessin, légende, fit, empty-state).
6. Légende : mini-icônes structures + swatches biomes recolorés ; toggles fonctionnels.
7. Pan/zoom/fit/monde/auto-refresh sans régression.
8. Parse-check OK ; vérifié en local (verify-ui) puis en prod après deploy (versions
   servies + rendu réel au Chrome MCP).
