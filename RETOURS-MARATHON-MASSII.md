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

## 2026-06-04 — A. Comportement trop DIRECT avec les minerais → humaniser (anti-détection) `[traité — isExposed sur tout ciblage d'ore (gather/gatherIron/charcoal/kit), fallback naturel branch-mine, anti-xray serveur neutralisé ; 4 tests ; commit badaef0]`

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

## 2026-06-04 — B. Reste TROP SOUVENT bloqué dans l'eau → très suspect `[traité — tick isInWater→escapeWater à chaque itération marathon + entrée/sortie de gotoPos, liquidCost 25 global sur les Movements ; unstuck.js réutilisé (9 tests verts)]`

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

## 2026-06-04 — C. Table de craft posée ET cassée « en même temps » → suspect `[traité — reclaim différé 12s (burst=1 pose, 5 tests fake-timers) + dwell 800ms + table PERMANENTE à la base]`

**Constat de Massii (en jeu)** : le bot **pose la table de craft et la détruit quasi en même temps**
→ très suspect. Comportement voulu = **poser la table → crafter ce dont il a besoin → PUIS la casser**.
Le cycle place→craft→reclaim de `withCraftingTable`/`craftSmart` (piège #41) est trop serré / mal
séquencé → visuellement ça ressemble à pose+casse instantanées, répétées.

**Ce qui existe déjà** : retour #3 du cartographe (waitForBlock après pose + délais pose→craft→reclaim +
reclaim **seulement** après craft 100 % fini). À ré-appliquer / durcir côté marathon (qui crafte BEAUCOUP).

**À faire** :
1. **BATCH les crafts** : quand plusieurs crafts sont nécessaires (kit, réserves, recraft), poser
   **UNE** table, faire **TOUS** les crafts en attente à cette table, PUIS la reprendre. Jamais
   place+reclaim par craft individuel.
2. **Séquence + dwell minimum** : poser → `waitForBlock` (poll `bot.blockAt` jusqu'à voir
   `crafting_table`) → petit délai humain → craft(s) → petit délai → reclaim. **INTERDIT** de poser et
   casser dans le même tick / < ~1 s au même endroit (c'est le tell visuel).
3. **Encore plus humain (option)** : à la BASE, poser une table **PERMANENTE** (ne pas la reprendre) ;
   le place/reclaim portable seulement loin en minage. Un humain laisse sa table à sa base.

**Critère (live)** : on voit le bot poser la table, crafter plusieurs trucs, **puis** (éventuellement) la
reprendre — jamais pose+casse simultanées. + test offline : séquence place→(craft×N)→reclaim, dwell mini.

## 2026-06-04 — D. Difficulté à placer un bloc SOUS ses pieds (pillaring) `[traité — scafoldingBlocks (1 f, vérifié index.d.ts:243) cobble/dirt/deepslate sur les Movements + pillarUp : garde in_water (#54) + sneak + verify/retry (déjà présents)]`

**Constat de Massii (en jeu)** : le bot galère toujours à poser un bloc sous ses pieds (monter en
pilier / sortir d'un trou / bridger). Le skill `pillarUp` du cartographe existe (pose à l'apex via
`velocity.y`, 8 tests) mais « pas encore branché dans un flux auto » → le marathon ne l'utilise pas
fiablement.

**Techniques correctes (mineflayer — recherche 2026-06-04)** :
1. ✅ **PRÉFÉRER le scaffolding intégré du pathfinder** pour tout « atteindre une position plus haute /
   sortir d'un trou / franchir un gap » : sur l'objet `Movements` →
   `movements.scafoldingBlocks = [mcData.itemsByName.cobblestone.id, mcData.itemsByName.dirt.id]`
   ⚠️ **TYPO DE LA LIB : c'est `scafoldingBlocks` (UN seul 'f' au milieu) — `scaffoldingBlocks` ne marche
   PAS (échec silencieux).** + `movements.allow1by1towers = true` (défaut). Le pathfinder gère le timing
   apex/pose **en interne** → bien plus fiable que la pose manuelle. À câbler partout où le bot doit monter.
2. **Pose manuelle sous les pieds** (hors pathfinder) : `bot.placeBlock(referenceBlock, faceVector)` où
   `referenceBlock` = un bloc **SOLIDE adjacent** (ex. `bot.blockAt(pos.offset(0,-1,0))` = bloc sous le
   bot) et `faceVector = Vec3(0,1,0)` (face SUPÉRIEURE). On ne peut PAS poser contre de l'air → il FAUT
   un bloc de référence solide. Pour monter : `sneak` ON (anti-marcher-hors-bord) + look vers le bas +
   jump + poser sur la face sup du bloc sous soi **À L'APEX** (`velocity.y` passe de + à ~0).
3. ⚠️ **`placeBlock` échoue aléatoirement** (pathfinder issue #296) → TOUJOURS **vérifier après pose**
   (`bot.blockAt(target)` est bien le bloc) + **retry** N fois ; sinon le bot tombe.
4. ⚠️ **Eau** (pathfinder issue #54) : poser un bloc sous soi en nageant est foireux → **sortir de
   l'eau D'ABORD** (synergie retour B) avant de piller.

Refs : `github.com/PrismarineJS/mineflayer-pathfinder` (`Movements.scafoldingBlocks`/`allow1by1towers` ;
issues #54 eau, #296 fail aléatoire) ; `mineflayer` issue #2577 (placeBlock sous les pieds). Vérifier les
signatures exactes dans `node_modules/mineflayer-pathfinder/index.d.ts`.

**À faire** : (1) câbler le scaffolding pathfinder (`scafoldingBlocks` = cobble/dirt) sur les Movements
du marathon → laisser le pathfinder gérer les montées ; (2) pour les poses délibérées hors-path,
brancher + durcir `pillarUp` (sneak + apex + **vérif-après-pose + retry**) ; (3) jamais piller dans l'eau.

**Critère (live)** : le bot monte en pilier / sort d'un trou **du premier coup** la plupart du temps
(retry invisible si rate) ; plus de « galère à poser sous les pieds ».
