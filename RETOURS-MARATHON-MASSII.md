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

## 2026-06-04 — E. X-RAY TROP BRIDÉ → stealth (réussir à prendre les ores, mais pas obvious) `[traité — MAX_ORE_APPROACH 5 (enterré proche prenable, longue percée interdite), throttle 25% communs jamais les 4 cibles, biais mine_bias vers zone riche ; commit 4c89752]`

**Constat de Massii (en jeu)** : depuis le retour A, le bot **ne fonce plus** sur les ores (bien !) **MAIS
il est devenu trop con → il n'arrive plus à prendre les diamants/lapis/redstone/or**. Or l'objectif
marathon EXIGE 64 de chaque. Massii : « il faut qu'il réussisse **quand même** à prendre les diamants,
lapis… il faut **juste** que le x-ray ne soit pas obvious. »

→ **A est allé trop loin** (isExposed strict + branch-mine aveugle = inefficace). Le bon équilibre =
**STEALTH X-RAY** : le bot **SAIT** où sont les ores et s'en sert pour être **EFFICACE**, mais
l'**EXÉCUTION** ressemble à un joueur qui branch-mine dans une bonne zone et a « de la chance ».
Ni beeline évident, ni aveugle inutile.

**À faire (ré-équilibrage de A — ne PAS revenir au beeline)** :
1. **Le ciblage d'ore via findBlock REVIENT, mais BORNÉ.** Il sert à deux choses :
   - **(a) Biais directionnel** : orienter les tunnels de branch-mine **VERS** la zone la plus riche en
     ore connue au bon Y (au lieu d'un cap fixe aveugle) → le bot creuse « par hasard » là où il y a du
     diamant.
   - **(b) Approche COURTE** : quand un ore connu est **proche** du tunnel courant (≤ ~**4-5 blocs**),
     faire un petit embranchement/détour pour l'exposer et le prendre.
2. **L'interdit reste l'approche LONGUE** : **JAMAIS** un forage droit de >5-6 blocs à travers la roche
   pleine pile vers un ore unique (= le tell évident). La distance max de « dig droit vers un ore » est le
   **paramètre clé** : court = humain, long = x-ray obvious. (Garder un knob `MAX_ORE_APPROACH` ~5.)
3. **Throttle / humanisation** (anti-plugin « luck ») : parfois **ignorer** un ore connu, varier le
   rythme, miner du déchet, ne pas afficher un ratio diamant/pierre surhumain.
4. **Anti-xray serveur reste ON** (acquis de A) : densité d'ore aberrante (faux ores engine-mode 2) →
   branch-mine pur (efficacité sacrifiée, c'est forcé sur ces serveurs).
5. `isExposed` reste pour les grabs **immédiats** ; l'approche courte (b) peut creuser ≤ qq blocs vers un
   ore non encore exposé (c'est ça, « tomber dessus » de façon plausible).

**Critère (live)** : le bot **récupère effectivement** diamants/lapis/redstone/or et **progresse vers
64×4** ; ET on ne le voit **JAMAIS** percer un long tunnel droit pile vers un filon caché — ça ressemble
à du branch-mining humain chanceux dans une bonne zone. + test offline : un ore à 4 blocs = approche
autorisée ; un ore à 20 blocs en roche pleine = refusé (pas de beeline).

## 2026-06-04 — F. Coffre : casser le bloc AU-DESSUS à la pose (sinon inouvrable) `[traité — pré-dégagement systématique avant CHAQUE deposit + retry (P17 universalisé) ; commit 13648fd]`


**Constat de Massii (en jeu)** : quand le bot pose un coffre, il doit **se rappeler de casser le bloc
au-dessus** — un coffre sous un bloc **opaque/solide** est **INOUVRABLE** en vanilla → pas de dépôt.

**Déjà fait** : **P17** (`acf298c`) dégage le dessus à `establishBase` + retry après dig au deposit.
Si Massii le voit ENCORE → soit le run observé est d'avant P17, soit P17 n'est **pas universel**.

**À faire (rendre universel + robuste)** :
1. **TOUTE pose de coffre** (pas juste `establishBase`) dégage le bloc directement au-dessus
   (`chestPos.offset(0,1,0)` ; si solide → dig + ramasser le drop) **à la pose**.
2. **Vérifier l'ouvrabilité** avant de compter le coffre comme utilisable (et avant chaque deposit) ;
   si `open` échoue → re-dégager le dessus + retry (déjà l'esprit de P17).
3. Idéal : le bloc au-dessus **et** la case devant (accès) sont dégagés.

**Critère (live)** : le bot pose un coffre en sous-sol et **l'ouvre / dépose du premier coup**, sans
boucle « re-base ».

## 2026-06-04 — G. Pillaring TOUJOURS cassé malgré D → tout passer par le PATHFINDER + diagnostics `[traité — ascensions 100% pathfinder (GoalY+scaffold garanti+diagnostics ascend_attempt), shelter pathfinder-first ; commit 13648fd]`

**Constat de Massii (en jeu)** : malgré D (scafoldingBlocks posés + pillarUp durci), le bot **galère
TOUJOURS** à monter en sautant+plaçant. → Signe qu'il fait encore du **pillaring MANUEL** (jump+place)
quelque part, et c'est **fondamentalement instable** en mineflayer.

**À faire** :
1. **Router TOUTE ascension par le pathfinder** (et PAS le jump+place manuel) : pour sortir d'un trou /
   monter une marche / regagner la surface → donner un **goal pathfinder** à destination (GoalY / GoalBlock /
   GoalNear) avec `scafoldingBlocks` (1 f) + `allow1by1towers=true`. **allow1by1towers fait justement
   sortir d'un trou 1×1.** **Auditer chaque appel de `pillarUp` / jump+place manuel et le convertir en
   goal pathfinder.** Le manuel ne reste qu'en ultime fallback.
2. **Toujours avoir du bloc de scaffolding** (cobble/dirt) en inventaire quand il doit grimper (sinon
   pathfinder ne peut PAS scaffolder → échec). Vérifier ça dans le gate.
3. **DIAGNOSTICS obligatoires** : logguer CHAQUE tentative de montée + la **raison** d'échec (pas de
   matériau / `placeBlock` threw / tombé / pathfinder a abandonné / no_path) → le prochain run nous **DIT**
   pourquoi au lieu de deviner. (On tourne en rond sur ce bug, il faut la cause réelle.)
4. Failure modes manuels connus si on doit garder un fallback : reference block = le bloc qu'on a
   **quitté** (offset 0,-1,0 quand on est en l'air), pas l'air sous les pieds en plein saut ; pose **à
   l'apex** ; `placeBlock` async + échoue (#296) → verify+retry ; jamais dans l'eau (#54).

**Critère (live)** : le bot **sort d'un trou de 3-4 blocs / monte une marche du premier coup** (retry
invisible) ; et **les logs montrent la cause** de tout échec de montée restant.

## 2026-06-04 — H. Minage : tunnels trop précis + économie d'outils + NE PAS rater les ores `[traité — H1 zig-zag ±2, H2 branches peek 1-haut ≤3, H3 détour précieux ≤5 jamais raté + world-memory bias ; commit 4019f3f]`

**Constats de Massii (en jeu)** :
1. La technique de tunnel est **TROP PRÉCISE / régulière** → tell robot. Un humain mine imprécis.
2. Casser **les 2 blocs** (pied+tête = tunnel 1×2) **use trop la durabilité** des outils. Idée Massii :
   plus malin de ne creuser **que les blocs à hauteur de tête**.
3. **Le bot PEUT utiliser les données carto / world-memory** (Massii le **confirme**) — et il **rate les
   ores** : vu **passer devant des diamants 2 fois** sans les prendre (= trop con depuis A, cf. E).

**À faire** :
1. **IMPRÉCISION organique des tunnels** (anti-tell) : pas de ligne parfaitement droite ni de gabarit
   pixel-perfect. Micro-variations : léger zig-zag ±1 bloc, hauteur/alignement pas parfaitement
   constants, déviations occasionnelles — comme un humain. (Pendant du « random walk persistant » du
   cartographe, version minage : direction générale tenue, **exécution imparfaite**.)
2. **ÉCONOMIE D'OUTILS** : réduire les blocs cassés par distance. Idée Massii = creuser à hauteur de
   tête seulement. ⚠️ **Contrainte MC** : un joueur a besoin de **2 blocs de haut** pour marcher → un
   tunnel **1-haut n'est PAS traversable** debout. À valider en jeu, options :
   - tunnel **principal 2-haut** (pour circuler) MAIS **branches 1-haut** (juste exposer l'ore, on n'y
     marche pas) ;
   - **espacer** davantage les branches (ex. tous les 3 blocs — on voit l'ore à ≤2 → moins de blocs par
     ore exposé) ;
   - ne miner que là où ça **expose réellement** de l'ore ; pas de salles/strip inutiles.
   But = **minimiser blocs-cassés/distance** (les pioches durent plus) tout en restant traversable.
3. **UTILISER les données carto + NE PAS rater les ores (renforce E)** : OUI, exploite la world-memory
   pour savoir où sont les ores ; et surtout **prends les ores que tu longes** — s'il passe à portée
   d'un diamant (exposé OU ≤ `MAX_ORE_APPROACH` ~5) il **DOIT** faire le petit détour pour le prendre,
   **jamais passer devant** comme un idiot. (Massii l'a vu rater 2 diamants → c'est exactement le
   stealth x-ray de E : efficace **mais** discret.)

**Critère (live)** : tunnels d'allure **imparfaite/humaine** (pas un gabarit régulier) ; **moins de
blocs cassés** par distance (outils durent plus) ; le bot **ne passe JAMAIS à côté d'un diamant proche**
sans le prendre, et il **progresse vers 64×4**.

## 2026-06-04 — I. PRIORISER LES CAVERNES (données cartographe) > branch-mining `[HAUTE PRIORITÉ — stratégie]`

**Demande de Massii** : le bot doit **prioriser les cavernes** plutôt que toujours branch-miner.
Workflow voulu :
1. Aller à une **caverne localisée par le bot cartographe** (données `cave_found` de la world-memory).
2. Y **chercher/récolter les minéraux** (les ores y sont naturellement **EXPOSÉS** = récolte facile
   ET **100 % légit**, zéro x-ray) ; + **stealth x-ray (E)** pour les ores proches juste cachés.
3. **En même temps / ensuite**, se diriger vers une **AUTRE caverne** connue (données cartographe).
> ⚠️ Massii lance **le cartographe maintenant** → la world-memory va se remplir de `cave_found`.

**Pourquoi c'est la bonne stratégie** : les ores **exposés dans une grotte = la façon la plus LÉGIT de
miner** (aucun tell x-ray, ils sont visibles) — ça sert l'anti-détection ET l'efficacité (objectif 64×4
plus vite que le branch-mining aveugle).

**À faire** :
1. **Stratégie CAVE-FIRST** : si des cavernes connues (`caves[]` de la world-memory) sont à portée
   raisonnable → le bot **va à la plus proche/riche AU LIEU** de branch-miner. Le **branch-mining devient
   le FALLBACK** (aucune caverne connue à portée).
2. **Dans la caverne** : récolter les ores **exposés** (diamant/lapis/redstone/or/fer/charbon) ; explorer
   les ramifications de la grotte pour en exposer plus ; **stealth x-ray (E, ≤ MAX_ORE_APPROACH)** pour
   les ores proches juste cachés ; **éclairer** (torches = sûr + humain).
3. **CAVE-HOPPING** : une fois une caverne dépouillée (ou en perdant en richesse), **router vers la
   prochaine caverne connue** (pipeline : récolte ici → trajet vers la suivante → récolte ; pas
   littéralement les deux en même temps). Réutiliser le ciblage `directedTarget` cave-aware du récolteur
   s'il existe, sinon l'ajouter (lire `caves[]`, choisir la + proche non encore visitée).
4. ⚙️ **WIRING (VÉRIFIÉ 23h — CASSÉ en l'état, corriger en PRIORITÉ)** :
   - ❌ Le bot marathon tourne actuellement **SANS `--world-memory`** (juste `--world worldB.json` = son
     état perso) → il ne lit **AUCUN** store cave. **AJOUTE `--world-memory <path>` au lancement** du bot
     (harness `~/mc-marathon-test/` + `supervise.sh`).
   - ❌ Les **2 worktrees ont des `data/mc_agent_world_memory/` SÉPARÉS** → aucun partage par défaut. Le
     cartographe écrit dans **SON** worktree :
     `/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/feat+mc-agent-world-memory/data/mc_agent_world_memory/c207db.json`
     (group `c207db`, même serveur de test `100.108.50.70:25566`).
   - ✅ **Solution** : le marathon pointe `--world-memory` sur **CE fichier absolu** (worktree cartographe)
     et le **RE-LIT périodiquement** (les caves s'ajoutent en continu ; le bootstrap au lancement n'est
     qu'un snapshot). ⚠️ **Vérifie le nom du fichier** après lancement du cartographe :
     `ls -t ".../feat+mc-agent-world-memory/data/mc_agent_world_memory/"` → le + récent = le store vivant.
   - ⚠️ **Dépendance externe** : le cartographe (autre session) a **0 cave** émise à ce jour (`cave_found`
     jamais déclenché en jeu). Tant que `caves[]` reste vide → **branch-mining fallback**, sans bloquer.
     La stratégie cave-first ne s'active que quand le cartographe produit vraiment des caves.
5. **Sécurité** : grottes = mobs/lave/chutes → garder le kit survie (armure/épée/torches déjà là),
   éclairer en avançant, pathfinder évite lave/vide.

**Critère (live)** : quand des caves sont connues, le bot **va en grotte** et récolte les ores **exposés**
(pas de branch-mine systématique) ; il **enchaîne les cavernes** via les données cartographe ; et il
**accumule plus vite** vers 64×4. Test offline : sélection de la cave la + proche non visitée depuis
`caves[]` ; fallback branch-mine si `caves[]` vide.
