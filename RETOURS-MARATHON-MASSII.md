# 🔴 Retours live de Massii — session MARATHON (append-only, PRIORITÉ)

> Massii regarde le bot marathon tourner EN DIRECT. Applique les retours non encore traités SANS
> t'arrêter (intègre-les dans la boucle test→améliore). Relis ce fichier à CHAQUE itération.
> Le + récent en bas. Marque `[traité]` une fois intégré + testé + commité.

## 2026-06-04 ~12:15 — Réserves AVANT descente : viser GROS, pas « pas vide » `[traité — gate READY (bois 64u/food 16/torches 48/3 pioches) + action iron + recraft souterrain via table/four portables ; foodCompromise si monde sans animaux ; 383 tests verts]`

**Constat de Massii (en observant le bot en jeu)** : avant de descendre en cave/mine, le bot doit
emporter **BEAUCOUP** de nourriture ET de ressources de surface (bois surtout) — assez pour
(a) tenir une **LONGUE** session sous terre sans remonter, et (b) **se refabriquer plusieurs outils
en bas** depuis sa réserve. Le bois n'est PAS en cave : une fois en profondeur sans bois → plus de
bâtons → plus de pioche de rechange → bloqué / remontées incessantes.

**Ce qui existe déjà (NE PAS refaire)** : P8 gate déjà la descente sur un restock food+bois. Le
problème n'est PAS l'absence de gate — c'est que les **SEUILS sont trop bas** (« pas vide » au lieu
de « beaucoup »), et qu'il n'y a pas de **réparation/recraft d'outil sous terre**.

**À faire (refinement, pas de refonte)** :
1. **Monter FORTEMENT les seuils « prêt à descendre »** (le gate de descente exige tout ça AVANT de
   creuser) :
   - **Nourriture cuite** : grosse réserve (≥ ~16, viser vers un stack) → ne PAS remonter pour la
     faim pendant une longue session de minage.
   - **Bois** : ≥ ~1 stack de bûches (ou planches équivalentes) → de quoi : table de craft + beaucoup
     de bâtons + **plusieurs reconstructions de pioche** + torches.
   - **Torches** : bonne réserve (≥ ~1 stack) pour éclairer un long branch-mine en sécurité.
   - **Pioches de secours** : pré-crafter ≥2-3 (fer/diamant) AVANT de descendre.
2. **Recraft SOUS TERRE** : le bot garde **table + bois + cobble** en poche → quand une pioche casse
   en bas, il **recrafte sur place** depuis sa réserve (zéro remontée). C'est tout l'intérêt
   d'emporter beaucoup de bois.
3. **Gate strict** : si UNE de ces réserves est sous le seuil → **supply run de surface D'ABORD**
   (récolte bois en masse, chasse+cuit la nourriture, crafte spares+torches), puis descente seulement
   une fois **PLEINEMENT** chargé.
4. **Philosophie** (l'intention de Massii) : **un gros chargement initial > beaucoup d'allers-retours**.
   Chaque remontée est longue et dangereuse → on minimise en partant lourd.

**Critère de validation (live)** : un run où le bot descend AVEC une grosse réserve, mine longtemps,
**casse une pioche en bas et en recrafte une SANS remonter**, et ne remonte que rarement (réserve
réellement épuisée). + test offline des seuils (gate) et du recraft souterrain.

## 2026-06-04 — A. Comportement trop DIRECT avec les minerais → humaniser (anti-détection) `[HAUTE PRIORITÉ]`

**Constat de Massii (en jeu)** : le bot **fonce en ligne droite à travers la roche, pile vers les
filons** → c'est le tell n°1 d'un bot (x-ray visible), et sur les serveurs sérieux un plugin de
détection statistique (« luck » / XrayInformer / Spartan XRay / Vulcan) **flag** un ratio
valuables/pierre ou un taux de découverte anormaux.

**Ce qui existe déjà** : `branchMine` est **LÉGIT** (creuse des tunnels en aveugle + ne ramasse que
l'exposé à ≤1 bloc via `oresInNeighborhood`). Le problème = `gather`/`gatherIron`/coal qui ciblent
via `bot.findBlock({matching: ore, maxDistance: 32-64})` → `findBlock` voit les filons ENTERRÉS
(aucun filtre d'exposition) → le bot perce droit dessus.

**À faire (réalisme = priorité)** :
1. **JAMAIS de beeline vers un ore caché.** Tout ciblage d'ore via findBlock passe un filtre
   **`isExposed`** : ne garder QUE les minerais ayant ≥1 face adjacente à de l'air/non-solide
   (qu'un joueur pourrait voir). Un ore 100 % enterré (0 face air) n'est JAMAIS une cible directe.
2. **Base = branch-mine légit PARTOUT**, kit fer/charbon inclus : descendre + tunnels systématiques
   au lieu de foncer vers un filon vu à 32. (Réutiliser `branchMine` / `gatherIron` fallback mineDown.)
3. **Si on garde une « intelligence » ore** : seulement un **biais directionnel subtil** du
   branch-mining (creuser plutôt VERS une zone riche), jamais un dig droit ; + **throttle humain**
   (rythme/ratio plausibles, parfois **ignorer** une veine, détours, miner du déchet).
4. **Détection anti-xray → fallback** : si findBlock renvoie une **densité d'ores aberrante** dans la
   roche pleine (Paper anti-xray engine-mode 2 = faux ores) OU **zéro ore caché** (mode 1) → couper
   tout usage de findBlock sur ore caché → **branch-mine pur**. (Sur ces serveurs le x-ray est de
   toute façon faussé.)
5. **findBlock longue distance reste OK pour la SURFACE** (bois, animaux, eau) — un joueur les voit
   vraiment, zéro triche là.

**Critère de validation (live)** : en observant le bot, il ne perce **JAMAIS** droit à travers la
pierre vers un filon caché ; il branch-mine et **tombe** sur les ores en les exposant ; rythme et
ratio valuables/pierre plausibles. + tests offline : `isExposed` (ore enterré rejeté / ore à flanc
de paroi accepté), fallback anti-xray sur densité aberrante.

## 2026-06-04 — B. Reste TROP SOUVENT bloqué dans l'eau → très suspect `[HAUTE PRIORITÉ]`

**Constat de Massii (en jeu)** : le bot **reste très souvent coincé dans l'eau** → ultra suspect
(un vrai joueur sort de l'eau en 1-2 s ; un bot qui patauge/flotte sur place = signature évidente).

**Ce qui existe déjà** : `unstuck.js` (évasion eau → terre ferme, validé pour le cartographe) +
`liquidCost` (P5, anti-noyade). Donc le code d'évasion EXISTE — il n'est probablement **pas appelé
dans tous les contextes du marathon** (supply runs surface, descentes, voyages), contrairement à la
boucle mapper où il était câblé.

**À faire** :
1. **Tick anti-stuck eau PÉRIODIQUE dans TOUTE la boucle marathon** (pas juste un type d'action) :
   détecter `bot.entity.isInWater` (ou jambes dans l'eau) **+ progrès horizontal ~nul pendant N s**
   → évasion : remonter à la surface, viser la **terre ferme solide la plus proche**, en sortir.
   Réutiliser/étendre `unstuck.js` (ne pas réinventer).
2. **Pathfinder évite l'eau** : monter le `liquidCost` sur **TOUS** les `goto` du marathon (pas juste
   le minage) → il ne route dans l'eau que s'il n'y a **aucune** alternative terrestre.
3. **Sortie d'eau robuste** quand coincé contre un rebord (il nage mais ne monte pas) : `jump`+
   `forward` synchronisés / petit pilier d'1 bloc / casser le rebord — **jamais** rester à flotter
   immobile (cluster réalisme #1/#8 du cartographe).
4. Idéal : **éviter l'eau en amont** lors des supply runs (biaiser les trajets de surface vers la
   terre, comme l'anti-océan #5 du cartographe).

**Critère de validation (live)** : le bot **traverse ou longe l'eau sans rester bloqué** ; s'il tombe
dedans, il en **sort en quelques secondes** vers la terre ; aucun épisode « flotte/patauge sur place ».
+ test offline : détection in-water+no-progress → évasion déclenchée.
