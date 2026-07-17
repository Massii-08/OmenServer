<!-- Généré par le workflow mc-agent-steal-research (2026-07-17). 8 lentilles recon → 77 techniques → 50 candidats gap-mappés → vérif adversariale (30 gardés / 15 rejetés) → synthèse. Recherche brute + verdicts complets : scratchpad mc_findings.md / mc_verdicts_all.md. -->

# 🗺️ Rapport « choses à voler » pour débloquer le MC-Agent

> Synthèse après vérif adversariale des candidats (AltoClef / Baritone / Odyssey / mindcraft / LiquidBounce / nxg-org). **Aucun candidat n'est un débloqueur miracle** : la revue confirme que nos vraies stagnations (T1 fer, plateau diamant, churn bois) sont **mortalité + logistique**, pas des algorithmes manquants. Les leviers ci-dessous sont classés par **ratio réel impact/effort**, pas par le pitch d'origine.

---

## 1. TL;DR — les 5 leviers au meilleur ratio

| # | Levier | Impact→Effort | Douleur visée | Pourquoi ça bouge |
|---|--------|---------------|---------------|-------------------|
| 1 | **Pré-check du DÉFICIT de combustible + charge groupée** (`SmeltInFurnaceTask.fuelNeeded`) | medium / **low** | #4 fonte, #1 (facette smelt) | Aujourd'hui `smelt.js` démarre puis recharge 1-par-1 → fonte PARTIELLE = le motif exact « 20 raw_iron / 0 lingot ». Source unique `fuelUnitsAvailable()` + pré-check = on ne lance plus une fonte vouée. **Fonction pure, testable, 0 dép.** |
| 2 | **Formule `canDealWith` fight-vs-flee QUANTIFIÉE** (armure réelle + arme vs nombre) | medium / **low** | #5 death-loops, #1/#2 | Notre `combatDecision` est BINAIRE (4 constantes magiques, `isArmored` booléen → une botte en cuir rend « courageux »). La formule auto-calibre le cap de mobs selon les points d'armure + dégâts d'arme. **Pure, 0-LLM.** |
| 3 | **Liste FLEE-ONLY + portier d'engagement** (temps de proximité+LoS avant d'attaquer) | medium / medium | #3 roaming, #5/#1 morts Nether | On RIPOSTE `wither_skeleton`/`hoglin`/`piglin` qu'on ne peut pas repousser, et on quitte le minage pour un zombie de passage. Set flee-only + gate « resté proche N sec » supprime les deux. |
| 4 | **Creeper fuse-aware : casser la ligne de vue en posant 1 bloc** | medium / medium | #5 (creeper = tueur en deep, vécu R3 22/06) | Fuir en ligne dans un tunnel 1-large → cul-de-sac → l'explosion touche quand même. Poser 1 bloc casse la LOS et ANNULE l'explosion dans la fenêtre de ~1,5 s. Réutilise `panicWall`/`placeBlockNear`. |
| 5 | **Coffre-relais d'outils au puits de mine** (se ré-armer sans remonter) | medium / medium | #3 churn bois↔profondeur (**frein #1**) | Quand les 3 pioches de rechange cassent en profondeur → remontée surface déboisée = roaming mortel. Coffre au sommet du puits + `withdraw` (qu'on n'a NULLE PART) = re-armement local. |

**Note stratégique** : les leviers 1-2 sont des **quick wins purs** à faire cette semaine. 3-4-5 sont des chantiers moyens mais chacun tue un mode de mort documenté. Les « gros chantiers » (task-tree, arbitre) sont de la dette d'architecture — utiles, mais ils **ne débloqueront pas la complétion nocturne à eux seuls** car les blocages sont survie/exécution.

---

## 2. Quick wins (priorité absolue — impact med/low, effort low)

| Levier | Source | Quoi voler | Fichier cible | Effort |
|--------|--------|-----------|---------------|--------|
| **Pré-check déficit fuel** | AltoClef `SmeltInFurnaceTask.fuelNeeded` + `CollectFuelTask` | `fuelUnitsAvailable(items)` (coal=8, charcoal=8, planches/bûches=1.5, coal_block=80) en SOURCE UNIQUE ; `smelt.js` : abort `insufficient_fuel` + `putFuel` groupé ; `smeltPlan.go` exige `fuelUnits≥count`. **Nuance : fondre `min(want, floor(fuelUnits))` plutôt qu'abort dur** (la fonte partielle banke déjà `got=4`). | `skills/smelt.js`, `gear.js`, `goals.js` | **low** |
| **`canDealWith` fight/flee** | AltoClef `MobDefenseChain.canDealWithMobs`/`isVulnurable` | `canDealWith = ceil(armorPoints*3.6/20 + weaponDmg*0.8)+1` (dmg = `1+attack_matériau`, 0 sans épée) ; `isVulnerable = (armor≤15 && hp<3) ‖ (armor<10 && hp<10) ‖ (armor<5 && hp<18)`. **Garder notre plancher hp conservateur comme filet** (sinon bot armuré téméraire à 7 mobs). Comparaison stricte `count < canDealWith`. | `survival.js`, `tools.js` | **low** |
| **Auto-armure RÉACTIVE** | nxg-org `mineflayer-auto-armor` (déclencheurs seulement) | 2 listeners `onSpawn` : `bot.on('playerCollect', who=>{ if(who===bot.entity) armorUp(0) })` + debounce ~1 s. **NE PAS prendre la lib** (`gear.bestArmorToEquip` fait déjà le no-downgrade). Enfile une armure ramassée au sol en <1 s au lieu d'attendre le timer 90 s. | `index.js` | **low** |
| **Watchdog stuck DIG-AWARE** | mindcraft `modes.js` (unstuck) | Échantillonner `bot.targetDigBlock` en plus de la position : stuck = position figée ET **même bloc miné** que le tick précédent (bloc différent = progrès, pas de faux positif). Timeout ×2 pour l'obsidienne. Notre `isFrozenDesync` ne regarde QUE la position. | `index.js`, `jamEscalate.js` | **low** |
| **Blacklist FLOOD-FILL du cluster** | Baritone `GetToBlockProcess.blacklistClosest()` | Sur échec pathfind : remplacer notre boîte crue ±4 (`resource.js:589`) par un vrai BFS 6-voisins connexe (on a déjà `floodFillVein`) + blacklist persistant reset-sur-meilleure-pioche. | `ores.js`, `claims.js`, `worldModel.js` | **low** |
| **Shimmy anti-coincé** | AltoClef `SafeRandomShimmyTask` | `shimmy(bot,{ms:5000})` : `sneak+forward` + réorientation yaw aléatoire ~1 s, borné. Appelé après `clearSnares` dans `recoverFloating` + palier 2 de `jamEscalate`. Dégage clôtures/herbes hautes/portillons que `clearSnares` ne CASSE pas. **⚠️ NE PAS** prendre la partie « distance d'errance croissante » (conflit avec nos clamps `HOME_RANGE`). | `unstuck.js`, `jamEscalate.js` | **low** |
| **Garde-danger `tryEat`** | AltoClef `FoodChain.needsToEatCritical` | Gate dans `reflexes.js:132` : ne pas manger dans la bande PV 7-14 si `hurting` (le lock ~1,6 s de `bot.consume` = mort sous combo). **Ignorer** le volet « manger proactif food≤17 » → on l'a DÉJÀ (`needRegen`). | `reflexes.js` | **low** |
| **Câbler `sampleReactionDelay` sur les 4 call-sites combat non-réflexe** | madelinemiller / GrimAC | Router `attackNearest.js:16`, `survival.js:159`, `index.js:2923`, `onRanged` par le même délai réaction que le chemin réflexe utilise déjà. Anti-tell + anti-aimbot 0 ms. | `attackNearest.js`, `survival.js`, `index.js` | **low** |

---

## 3. Gros chantiers (impact medium, effort medium/high)

| Chantier | Source | Quoi voler / porter | Cible | Effort | Verdict revu |
|----------|--------|---------------------|-------|--------|--------------|
| **Coffre-relais d'outils** | `mineflayer-tool` (`equipForBlock{getFromChest,chestLocations}`) | À la descente : poser un coffre au puits, y déposer N pioches + combustible + bouffe, mémoriser la pos. Sur bail `no_pickaxe` en profondeur → `goto` coffre + `withdraw` (**primitive qu'on n'a NULLE PART** : `bot.openContainer().withdraw()`). `tryEstablishCamp` pose déjà un four+coffre à l'ancre. | `branchMine.js`, `index.js`, `anchors.js` | medium | Recoupe le buffer-en-poche `plank_buffer 24` déjà déployé ; gain unique = cache anti-mort en Hard keepInv=false. |
| **Liste FLEE-ONLY + portier d'engagement** | AltoClef `getUniversallyDangerousMob` + `_closeAnnoyingEntities` | (A) Set flee-only `{wither_skeleton, hoglin/zoglin@hp<10, piglin_brute}` testé AVANT le fight. (B) `Map<id,{firstSeen}>` : n'engager que si resté proche (5 blocs, 18 pour squelette/witch) + visible N sec. **⚠️ `bot.canSeeEntity` N'EXISTE PAS en 4.37.1** → écrire un helper raycast (~10 lignes). Garder la riposte immédiate-si-blessé. | `survival.js`, `reflexes.js` | medium | **Split : Partie A = quick win** (Set flee-only, haute confiance). Partie B = le gros. |
| **Creeper fuse-aware** | AltoClef `getCreeperSafety` | Lire `creeper.metadata` (swell/ignited, synced) ; si amorcé ET ≤3 blocs → `placeBlockNear` 1 bloc côté creeper (casse LOS = annule) ; sinon sprint perpendiculaire >7. Le compteur exact `getClientFuseTime` NE transite PAS → utiliser le booléen `ignited` + distance. | `survival.js`, `panicWall.js` | medium | **KEEP** — tue un mode de mort documenté (R3 22/06). Metadata index un peu version-fragile. |
| **Events pathfinder (`path_reset`)** | mineflayer-pathfinder 2.4.5 (émis nativement) | S'abonner à `path_reset` reasons `stuck`(3,5 s)/`no_scaffolding_blocks`/`dig_error`/`place_error` → coupe les boucles invisibles où `resetPath()` re-path en interne sans jamais rejeter `goto()`. **JETER la moitié `path_update`** (redondante : notre `goto.js` rejette déjà noPath en ~1 s). `no_scaffolding_blocks` = signal exact du piège #45a pilier. **1 seul listener au boot** (fuite au respawn sinon). | `index.js`, `jamEscalate.js`, `ores.js` | medium | Ne touche PAS #1/#2/#3. Utile pour #6/#9. |
| **Résolveur de prérequis RÉCURSIF (DAG en données)** | Odyssey `obtainItem.js` + `json/{func,pre_tool,pre_smelt,pre_item}` + AltoClef subsomption de tier | 4 JSON factuels dans `data/recipes/` + `need(item,n)` pur : craft→résout ingrédients AVANT, smelt→intrant+combustible+four, mine→palier pioche. Produit un ARBRE de sous-buts = **fixe structurellement `iron_armor→smelt→mine+fuel+four`**. Subsomption AltoClef : diamant satisfait fer/pierre → jamais re-craft. Garder `chainFor` en façade. | `planner.js`, `goals.js`, `data/recipes/` | **high** | **Refactor de fond / maintenabilité** (tue le prochain bug de monotonie imprévu). **⚠️ Risque régression** : le `while(!res)` d'Odyssey n'a NI timeout NI feuille d'échec, et son résolveur just-in-time PERD notre buffering prospectif (`picksOK 3`, `plank_buffer 24`) qui EST notre mitigation churn #3. À ré-emballer dans notre machinerie annulation/stall. |
| **Arbitre de comportements à PRIORITÉ** | mindcraft `modes.js` (`ModeController` + `break`-on-active) ; AltoClef `TaskRunner` | Liste ORDONNÉE de modes `{name,on,active,update}`, un tick parcourt en ordre, `break` dès qu'un mode devient actif (UN SEUL comportement). Ordre : `self_preservation > unstuck > survie-combat > planner > idle`. Remplace nos ~9 `setInterval` watchdogs qui s'excluent par booléens ad-hoc (`if(_smeltOppBusy‖_armorBusy‖…)return`). | `arbiter.js`, `index.js`, survival/reflexes/planner | **high** | Livre la préemption propre (#5/#6) mais PAS la reprise d'état type task-tree (le planner re-dérive `firstUnmet` et REDÉMARRE le skill). **Migration mode-par-mode** risque de ré-introduire les races qu'il doit tuer — `index.js` = 3451 lignes de cicatrices. |
| **Esquive de flèches (balistique)** | AltoClef `ProjectileHelper.calculateArrowClosestApproach` | Pour chaque flèche active : projection scalaire `t=(velX·dX+velZ·dZ)/(velX²+velZ²)` + hauteur balistique → menace si approche < seuils → pas latéral perpendiculaire. **⚠️ `entity.velocity` des flèches en vol N'EST PAS fiable** en mineflayer → dériver la vélocité des deltas position/tick + filtrer les flèches au sol. Rendre volontairement imparfait (anti-tell #8). | `dodge.js`, `reflexes.js` | medium | Complément d'attrition, pas un débloqueur. Squelette-snipe = tueur confirmé (`mapper.js:295`). |

---

## 4. Par douleur (1→10) — quelles techniques l'adressent

| Douleur | Techniques (par ordre de valeur) |
|---------|----------------------------------|
| **#1 T1 iron_armor Nether jamais bouclé** | ⚠️ Root cause DÉJÀ patchée (freeze/respawn-cap/TP-refusal `4b096e0`). Résiduel : **pré-check fuel (§2)** ferme la facette « 0 lingot » ; **résolveur récursif** dérive `iron_armor→smelt` proprement ; **auto-armure réactive** enfile la pièce fondue. **Aucun** ne clôt T1 seul (mort avant). |
| **#2 Plateau ~60 diamants** | Peu de leviers directs (c'était en partie un artefact de lecture stale + monde noyé). `canDealWith` = oser rester en deep équipé. Le vrai frein = throughput minage + survie, pas un algo. |
| **#3 Churn bois↔profondeur (frein #1)** | **Coffre-relais d'outils** (le plus direct) ; **flee-only + gatekeeper** (arrête de quitter le minage pour un mob) ; buffer-en-poche déjà déployé (`plank_buffer 24`). |
| **#4 Fonte peu fiable** | **Pré-check déficit fuel (§2) = le fix ciblé.** Résolveur récursif (smelt comme sous-but explicite). |
| **#5 Death-loops Hard** | **`canDealWith`** (calibre fuite/combat), **flee-only list**, **creeper LOS-break**, **garde-danger `tryEat`**, esquive flèches, flee multi-entités pondéré, arbitre de priorité. C'est le cluster le plus dense. |
| **#6 Blocages pilier/flottant/unreachable** | **Events `path_reset`**, **watchdog dig-aware**, **blacklist flood-fill**, **shimmy**, arbitre. |
| **#7 Traversée d'eau/bateau** | Peu de neuf portable (déjà durci live 15/07 : `waterCrossMode`, physicsTick sur `move`). Events `path_reset` marginal. |
| **#8 Détectable comme bot** | Câbler `sampleReactionDelay` combat ; suspendre le wobble pendant `placeBlock` (`_mcaPlacing`) ; clamp vitesse angulaire (combat only) ; WindMouse (fallback rare) ; combat window (reach≤3 + LoS + drop-sprint). **Tous secondaires** — off par défaut, aucun ban observé sur serveurs test. |
| **#9 findBlocks SYNC / unreachable** | **Events `path_reset`** (labellise le stuck en 3,5 s), **blacklist flood-fill**. Le time-slicing de `scanAllOres` = **effort high / gain low** (le seul scan live est déjà throttlé 1/cellule-128 + palette-skip actif). |
| **#10 Task-tree récupérable** | **Résolveur récursif Odyssey** (le fond) + **arbitre de priorité** (préemption). Refactors, pas débloqueurs immédiats. |

---

## 5. Plugins mineflayer directement installables

**Recommandation dominante : PORTER les patterns, PAS installer** (préférence 0-dép + version 1.21.x + `auto-deploy` ne réinstalle pas, piège #33). Détail :

| Plugin | Douleur | Verdict |
|--------|---------|---------|
| `mineflayer-tool` | #3 (relay chest `getFromChest`) | **Utile mais porter le pattern** : le `withdraw` déterministe = ~1 fichier miroir de `deposit.js`, évite une nouvelle dép. |
| `@nxg-org/mineflayer-custom-pvp` | #5/#8 (w-tap knockback, hop-crit, reach AABB) | **Cherry-pick le subset LÉGITIME uniquement** (JAMAIS packet/shield-blatant = ban). Notre `mineflayer-pvp@1.3.2` gère DÉJÀ cooldown 1.9 + reach 3.5 → seul le knockback-tap est neuf. Effort high, gain incertain. |
| `mineflayer-movement` (firejoust) | #8 (steering raycast, tête non figée) | **Déconseillé** : dormant ~3 ans (MC 1.19), non testé 1.21.x, gain cosmétique, nouvelle dép + reinstall Omen. |
| `@nxg-org/mineflayer-auto-armor` | #1/#5 | **Voler les déclencheurs, pas la lib** (§2). |
| `@miner-org/mineflayer-baritone` | #6/#7 | **REJETÉ** : conflit de version (`^4.35` vs notre `^4.20`) + remplace `mineflayer-pathfinder` (intégration profonde) + ses propres bugs eau/parkour admis dans son README. |

---

## 6. Rejetés (et pourquoi — court)

| Candidat | Raison du rejet |
|----------|-----------------|
| **Seau de lave = 100 fontes / `collectLava`** | Remplir un seau = **bug mineflayer OUVERT** (#3731) + `activateItem` CASSÉ sur MC 1.21.x (#3742). Trade net-négatif (seau = 3 fer). Conflit avec le réflexe anti-lave. |
| **`GoalCompositeAny` sur top-N ores** | En mode quota/anti-xray on ne `goto` JAMAIS un ore mappé (tell x-ray, exigence Massii §1.6). Le plateau = deepslate encapsulée (canDig=true tire vers l'encapsulé). |
| **Voyager `summarize_chatlog`** | Porte un workaround qui n'existe pas chez nous : ces messages sont AUTO-générés par les primitives Voyager, PAS émis par le serveur. On lit déjà le return direct de nos skills. |
| **BeatMinecraft2 items protégés / buffers keep-N** | ~Intégralement DÉJÀ présent (`quota.js _KEEP_*`, `plank_buffer`, `spare_picks`, `armor_fuel` gate). Les flags de session périmés RÉGRESSERAIENT (bug `no_table:unknown_item`). |
| **findBlocks palette fast-path (matcher→ids)** | Mécanisme FAUX (réfuté sur la source 4.37.1) : la palette skip s'exécute pour un matcher-fonction aussi. Le tableau serait même une pessimisation O(860). |
| **Fortune III comme sous-but** | Lecture d'enchantements CASSÉE depuis MC 1.20.5 (data-components, #3717). Plateau = artefact de mesure, pas de rendement/minerai. |
| **GCD rotation quantifiée** | mineflayer NATIF le fait déjà (`physics.js:335`, quantize du delta sur multiples de 0,15°) sur tous les `bot.look`, `force=true` compris. |
| **Critic déterministe post-skill** | On le fait DÉJÀ (`armor_no_progress`, `failStreak`, `met()` du planner). Voyager `critic.py` est 100% LLM (contraire du pitch). |
| **Coupe-circuit fréquence <20 ms** / **target-commit** / **détecteur de dérive** / **garde-distance place** | Tous redondants avec du code existant (planner `failStreak` timing-agnostique, `resource.js skip.add` commit, pathfinder `resetPath('stuck')` 3,5 s, `placeBlockNear._refOk`). |

---

## 7. Non exploré / prochaine passe

1. **Fonte opportuniste pilotée par mort** : la mémoire nether-nogive note « next = opportunistic smelt » — combiner le pré-check fuel (§2) avec un déclenchement de fonte dès qu'on repasse près d'un four connu, pas seulement au gate `armor_fuel`.
2. **Blast furnace** (fonte métaux ×2) — noté marginal, mais **2× moins de temps immobile la nuit** = moins de fenêtre de mort. À ré-évaluer une fois la fonte fiabilisée.
3. **Reprise d'état réelle du planner** après préemption (le vrai delta AltoClef) : ni l'arbitre ni le résolveur seuls ne la livrent. Chantier à part.
4. **Enrichir le mod OmenCapture** (events combat déjà ajoutés 08/06) → enfin CALIBRER les temps de réaction sur vraies données (aujourd'hui défaut ~300 ms) au lieu de porter des constantes LiquidBounce.
5. **Anti-noyade proactif** (pain #5/#7) : aucun candidat ne l'a couvert franchement alors que la noyade est un tueur récurrent cité — creuser un détecteur « eau au-dessus/devant à Y<0 » avant perçage.
6. **Instrumentation des runs** : avant de porter la moitié de ces techniques, ajouter un log structuré des CAUSES de mort/stall par run — la revue a montré que plusieurs pitchs « high impact » reposaient sur des douleurs mal diagnostiquées. **Mesurer d'abord.**
