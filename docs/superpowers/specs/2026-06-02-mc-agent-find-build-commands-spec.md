# MC Agent — Commandes `find` & `build` (+ shulker box) — design

> **Contexte** : extension de la **couche de commandes directes (#40)** — `orders.js`, parsées en `/msg` privé, *gated* par les gens de confiance (#39), exécutées comme **tâche longue annulable** (`tasks.js`), **0 token LLM**, acks en whisper privé. On passe de **16 → 18 commandes**.
> **S'appuie sur** les specs de recherche du 02/06 : `…-diamond-netherite-deep-research.md` (§F navigation/structures), `…-resources-crafting-spec.md` (résolveur craft-anything + table ressources), `…-realism-combat-spec.md` (§F structures, §G fermes faisables-bot, humanisation anti-tell).
> **Statut** : DESIGN. Pas implémenté. À faire en Phase 3 (nouveau code : `skills/find.js`, `skills/build.js`, schématiques, résolveur de BOM, I/O coffres/shulkers).

---

## 1. Les 2 nouvelles commandes (même moule que #40)

| Commande | Forme `/msg` | Exécution | LLM ? |
|---|---|---|---|
| **`find <structure>`** | `find village` / `find stronghold` … | tâche longue annulable : localise → **whisper les coords** au demandeur | non (0-token) |
| **`build <farm>`** | `build mob_farm` / `build gold_farm` … | tâche longue annulable : BOM → coffres/shulkers → manque → récolte+dépose → build | non (0-token) |

Les deux : insensibles à la casse, **gated `isTrusted`** (liste vide = tous, cf. #39), annulées par `stop`/`afk`/nouvelle commande (`taskCtl`), retours **toujours en whisper privé** (`ackPrivate`).

---

## 2. `find <structure>` — localiser + avertir

### Structures supportées (table de génération, source : specs recherche §F)

| Nom commande | Y / biome | Méthode de localisation |
|---|---|---|
| `village`, `outpost`, `monument`, `mansion` | surface / biome dédié | **exploration** du bon biome (mansion = très loin, >1000 blocs) |
| `fortress`, `bastion` | Nether Y 30-90 | exploration Nether (région ~27 chunks) |
| `ancient_city` | sol **Y=−51**, Deep Dark | ⚠️ danger Warden (cf. spec netherite) — localiser mais **ne pas entrer** |
| `trial_chamber` | Y −52→30 | exploration souterraine |
| `stronghold` | souterrain | **triangulation Eyes of Ender** (2 lancers ≥200 blocs d'écart → intersection des rayons) |

### Stratégie d'exécution (déterministe, annulable)

1. Résoudre la structure → sa règle de génération (table ci-dessus).
2. **Voie rapide (si le serveur l'autorise — op/cheat)** : `/locate structure <id>` → coords exactes. ⚠️ **C'est un TELL** (aucun humain ne tape `/locate` puis fonce en ligne droite). Acceptable seulement en mode test/no-stealth ; sinon **désactivé**.
3. **Voie réaliste** : pathfind en **hops ≤64-128 blocs** (limite `mineflayer-pathfinder`, cf. spec §F) vers le bon biome + `findBlock` sur les blocs-signature ; stronghold = triangulation eye-of-ender (`bot.entity.yaw` + intersection de 2 droites).
4. **Avertir** : à la découverte → `ackPrivate` whisper → *« village trouvé en X Y Z, à N blocs »*. C'est le « m'avertir ».
5. Échecs/timeout → whisper la raison (pas trouvé dans le rayon, bloc incassable sur le chemin…).

### Garde-fous
- Tâche **annulable** (`stop`).
- Respecter les **bornes physiques** (#realism) pendant le déplacement (pas de fly).
- ⚠️ `find ancient_city` : localiser mais **stopper à distance** (règle Warden : interdiction de miner Y≤−40 sans scan sculk).

---

## 3. `build <farm>` — chercher les blocs, compléter, puis construire

> C'est **la commande la plus ambitieuse**, MAIS l'écosystème mineflayer fait déjà l'essentiel : **`prismarine-schematic`** lit les fichiers `.schem`, et **`mineflayer-schem`** (fork de `mineflayer-builder`) construit la schématique **+ récupère automatiquement les items dans le coffre le plus proche** (= le flux décrit par Massii, en partie pré-codé). Voir §3bis.

### Le flux exact (celui décrit par Massii)

```
build <name>   (émis en /msg par un gens-de-confiance)
  0. TPA      = le bot fait /tpa <demandeur> → atterrit à SA position = ANCRE (cf. Ancrage & orientation)
  1. PLAN     = charge le .schem → bounding box (emprise) + BOM (AUTO-dérivé de la palette, §3bis)
  2. CLEAR    = DÉGAGER l'emprise : détruire arbres / blocs / obstacles dans le volume        ← NEW
               + niveler l'assise ; COLLECTER les drops (ils alimentent le STOCK)
  3. STOCK    = inventaire bot + drops du clear + coffres proches (~16) + shulker box (§5)
  4. MANQUE   = BOM − STOCK
  5. si MANQUE ≠ ∅ :
        pour chaque item manquant : acquire(item)  [gather / minage / craft-anything spec 3]
                                    → deposit au coffre (checkpoint)
        répéter jusqu'à MANQUE = ∅   ← « jusqu'à ce qu'il ait tout »
  6. BUILD    = poser la schématique ; ANCRE = coin FOND-DROITE ; s'étend AVANT + GAUCHE ;
               orientation = regard du demandeur ; humanisé (§4ter)
  7. whisper  "build <name> terminé" (+ progression intermédiaire)
```

### Ancrage & orientation (convention Massii)

- **Étape 0 — `/tpa <demandeur>`** : à réception de `build` en `/msg`, le bot se **téléporte au demandeur** (`/tpa` doit être dans la whitelist #38 ; le demandeur **accepte** la requête — il vient de taper `build`, il s'y attend). Sa position d'atterrissage = **l'ancre**.
- **Ancre = coin FOND-DROITE du schéma** (« le bloc au fond à droite », demande Massii). Depuis l'ancre, le build **s'étend vers l'avant** (le « fond » du schéma est AU niveau du bot → la structure pousse devant lui) **et vers la gauche** (le bot est au coin droit → la largeur va vers sa gauche).
- **Orientation = le regard du demandeur** au moment du `/msg`, **snappé au cardinal** (N/S/E/O) — ✅ **décision verrouillée par Massii (02/06)**. Donc : *le joueur regarde dans le sens où il veut le build, tape `build x`, le bot le rejoint et construit devant-gauche.* → la rotation de la schématique (`prismarine-schematic` permet de tourner) est calée sur ce cardinal.
- **Math de pose** : `world_pos(bloc) = ancre + rotate( local_pos(bloc) − coin_fond_droite, cardinal )`. Le coin fond-droite = un coin de la bounding box du `.schem` (déterministe).
- ⚠️ **Garde-fous** : (a) si le `/tpa` n'est pas accepté/timeout → whisper « accepte le tp pour que je build » ; (b) **vérifier que l'emprise au sol est dégagée/plane** avant de poser (joueur dans un mur, en l'air, sur une pente → build malformé) → sinon whisper l'avertissement plutôt que bâtir n'importe comment ; (c) le bot **bouge** ensuite pour poser (il ne reste pas figé sur l'ancre).

- **Étapes 1-4 = réutilisation pure** : le résolveur craft-anything (spec 3, `delta`/récursion) sait déjà décomposer un item en ressources de base → `acquire()` branche sur les skills existants (`gather`, minage, craft). Le « dépôt dans le coffre au fur et à mesure » = **checkpoint** (si le bot meurt/est annulé, le progrès survit dans le coffre).
- **Étape 5 = pose via schématique** (cf. §3bis) : on **ne hand-code PAS** les coords — on charge un fichier `.schem` avec `prismarine-schematic` et on laisse `mineflayer-schem` poser bloc par bloc (gère blocs directionnels/escaliers/dalles, ordre de pose, progression).
- **Anti-tell (spec 5 §G/§I)** : la pose programmatique = comportement **scaffold/printer** → DOIT être **humanisée** : cadence variable (150-600 ms + pauses, pas pixel-perfect), **regarder la face de pose**, erreurs/reprises. ⚠️ La cadence par défaut du plugin est elle-même un tell → la wrapper/ralentir.

### Annulation / reprise
- `stop`/`afk` annule (`taskCtl`). Le matériel déjà déposé reste dans le coffre → un `build` relancé **reprend** (re-check STOCK).

---

### Dégagement du terrain (clear) — étape 2 (demande Massii)

Avant de poser, le bot **libère l'emprise** : arbres, herbe, blocs, petites structures dans le volume du build sont **détruits** pour faire de la place.

- **Quoi dégager** : tout bloc non-air dans la **bounding box** de la schématique (emprise + hauteur) qui n'est pas déjà le bloc cible. Arbres = `bestToolFor` (hache pour le bois ; les feuilles cassent/décaient). Herbe/fleurs = instantané.
- **Nivellement de l'assise** : si le sol est en pente/bosselé → **couper le haut** + (optionnel) **combler les trous** pour une assise plane. (La plupart des schémas de ferme incluent leur propre plancher, mais l'assise doit être régulière sinon le build est de travers/troué.)
- **🔗 Synergie collecte → STOCK** : les drops du dégagement (bois, terre, pierre…) **alimentent le STOCK** (étape 3) → réduisent la liste de courses. Dégager des arbres peut même **fournir le bois** du build.
- **Humanisé (§4ter)** : le dégagement = du minage → mêmes règles (regarder le bloc, cadence variable 150-600 ms, bon outil). **Raser 20×20 instantanément = tell** scaffold/nuker.
- **Inventaire** : gros dégagement = beaucoup de drops → ranger dans coffre/shulker si saturation (§5).
- ⚠️ **GARDE-FOUS (anti-grief — important)** :
  - rester **STRICTEMENT dans l'emprise** du build (ne jamais déborder).
  - **NE PAS détruire** : coffres/conteneurs **avec contenu**, blocs de valeur (beacon, spawner, têtes…), bedrock/incassables → **whisper un avertissement** plutôt que casser (« coffre dans l'emprise, je ne casse pas — déplace-le ou re-place-moi »).
  - **lave/eau dans l'emprise** → traiter avec les règles lave (spec netherite §B.2) avant de creuser.
  - le demandeur a **choisi l'emplacement** (via le `/tpa`) → la responsabilité du site lui revient, mais le bot reste **conservateur** (emprise only, valeurs préservées).

## 3bis. Schématiques (Schematica/Litematica → `prismarine-schematic`)

> Idée Massii : récupérer les infos de ferme depuis l'écosystème **Schematica/Litematica** plutôt que de les hand-coder. ✅ Validé, c'est le bon chemin.

- **Le bot ne fait PAS tourner le mod** (Schematica/Litematica sont des mods *client* Forge/Fabric). Il **lit le fichier** de schématique.
- **`prismarine-schematic`** (PrismarineJS) : `Schematic.read(buffer, version)` → parse un fichier `.schem` (Sponge/WorldEdit 1.13+) ou `.schematic` (MCEdit) en blocs+positions, autodétecte la version.
- **`mineflayer-schem`** (fork de `mineflayer-builder`) : plugin qui **construit** la schématique ET **récupère automatiquement les items dans le coffre le plus proche** + gère blocs directionnels/escaliers/dalles + events de progression + mono/multi-bot. → **c'est le flux `build` §3, déjà à 70 % codé.**
- **Format** : les schématiques de fermes du net sont souvent `.litematic` (Litematica, le standard moderne 1.21). **Conversion `.litematic` → `.schem`** triviale (SchemConvert, Lite2Edit, Bloxelizer, ou Litematica lui-même). On stocke des **`.schem` convertis** dans le repo.
- **BOM = AUTO-DÉRIVÉ** 🎯 : la palette de blocs de la schématique donne **exactement** quels blocs et combien → **plus besoin de hand-coder le BOM** (§3 étape 1 devient automatique : `bom = compter(schematic.palette)`).
- **Sourcing** : récupérer des schématiques de fermes libres (communauté Litematica, créateurs type ilmango/gnembon, minecraft-schematics.com) → convertir → committer en `.schem` dans `mc-agent/builds/`. (Vérifier licence/crédit ; la plupart sont partagées librement.)
- ⚠️ **NOUVELLE DÉPENDANCE NODE** (`prismarine-schematic` + `mineflayer-schem`) → **casse la propriété « auto-deploy propre » du reste de #40** : il faudra `cd mc-agent && npm install` **à la main sur l'Omen** au déploiement (cf. #33 — l'auto-deploy ne réinstalle pas les deps). À assumer pour `build`.

## 4. Catalogue `build <name>` (la liste à taper en `/msg`)

> Le bot construit depuis un `.schem` (§3bis) → **n'importe quel build avec un fichier `.schem` est possible**. Voici le **catalogue de départ** (ce qu'on livre). **Extensible** : déposer un `.schem` dans `mc-agent/builds/` + 1 ligne de catalogue → nouveau `build <name>`, **0 code**. BOM auto-dérivé de la palette.

**A — Fermes sans redstone (les + sûres)**

| Commande `/msg` | Construit |
|---|---|
| `build mob_farm` *(alias `xp_farm`)* | salle sombre XP + drops (eau + chute 23-24, plateforme de kill) |
| `build gold_farm` | ferme d'or portail Nether (piglins zombifiés poussés en Overworld) |
| `build crop_farm` | champ blé/carotte/patate (terre labourée + eau) |
| `build iron_farm` | ferme de fer à villageois ⚠️ **complexe** (transport/cage de villageois) |

**B — Redstone STATIQUE (faisable via schém, à tester ferme par ferme — cf. §4bis)**

| Commande `/msg` | Construit |
|---|---|
| `build sugarcane_farm` | ferme canne à sucre observer/piston (→ papier → livres/enchant) |
| `build item_sorter` | trieur d'items (hoppers + comparateurs) |
| `build auto_smelter` | batterie de fours automatique (hoppers, redstone minimale) |

**C — Builds utilitaires (débloquent d'autres commandes)**

| Commande `/msg` | Construit | Débloque |
|---|---|---|
| `build enchanting_room` | table d'enchantement + **15 bibliothèques** (placement correct) | la prod de **N livres enchantés** (spec XP/enchant) |
| `build nether_portal` | cadre obsidienne + allumage (ou cast eau/lave) | le **run netherite** (spec netherite) |
| `build storage_room` | rangée de coffres | logistique (couplé aux shulkers §5) |
| `build shelter` | abri/mur de nuit | survie (anti-mobs la nuit) |

**D — Exclus (non fiables) — le bot les RECONNAÎT (vocabulaire modo) mais REFUSE de les build**
- redstone **timing-critique / 0-tick** (flying machines avancées, contraptions order-dependent — cf. §4bis pt 4).

⚙️ **Format catalogue** : `{ name, aliases?, schematic: "x.schem", postBuild?: [...] }` dans `builds-catalog.json`. Le **BOM est auto-dérivé** de la palette du `.schem` (§3bis). `postBuild` = actions spéciales au-delà de la pose pure (allumer un portail au briquet, configurer les repeaters/comparateurs §4bis pt 1).

---

## 4bis. Redstone via schématique — jusqu'où ? (raffine spec 5 §G)

Le `.schem` contient **tous** les blocs **avec leurs block states** (orientation, **délai de repeater**, **mode de comparateur**, facing piston/observer/hopper). Donc en théorie le bot peut reproduire l'**état final** d'un build redstone. **Ça déplace la ligne** : la conclusion spec 5 §G (« éviter toute ferme redstone ») valait pour une pose **hand-codée** ; avec une schématique, la redstone **statique devient faisable**.

**✅ Faisable (statique / simple→modéré)** : horloges, portes basiques, **trieurs d'items** (hoppers+comparateurs), lampes, **fermes observer/piston « simples »**. Le fichier porte les délais/modes → le builder peut les répliquer.

**⚠️ Les vraies difficultés (sinon contraption morte)** :
1. **Configuration post-pose** : le délai de repeater (4 crans) et le mode de comparateur se règlent par **clic-droit APRÈS la pose** (`bot.activateBlock` ×N), PAS à la pose. Un builder qui pose sans configurer → repeaters à 1 tick, comparateurs en mode « compare » → **machine morte**. ⚠️ **À VÉRIFIER : est-ce que `mineflayer-schem` lit le block state cible et fait les clics ?** Sinon helper à écrire : `lire schematic.getBlockState(pos) → activateBlock le bon nombre de fois`.
2. **Orientation** : le sens d'un composant dépend de la **face/du côté depuis lequel on pose** → le bot doit approcher du bon côté (le builder gère « directional blocks » avec un succès variable ; la redstone est le cas le plus dur).
3. **Auto-activation pendant le build** : poser une source (torche redstone, levier, bloc alimenté) **active immédiatement** → peut déclencher pistons/dispensers et **déplacer des blocs pas encore posés** → casse le build. Règle : **poser les sources de courant EN DERNIER**.
4. **Ordre / timing-critique & 0-tick** : le schématique = l'**état final**, pas le **processus**. Certaines contraptions dépendent de l'ordre de pose/d'update → la pose statique ne les reproduit pas → **risqué/non fiable**.

**Verdict** : redstone **statique = OUI** (item sorters, fermes observer/piston simples, horloges) à condition de gérer la config post-pose + poser les sources en dernier. Redstone **timing-critique / 0-tick = NON fiable** (l'état final ne suffit pas). → Le catalogue de fermes peut **s'étendre au-delà des 4 « sans redstone »**, mais **prudemment, ferme par ferme, en testant chaque `.schem` sur le serveur de test**.

## 4ter. INVARIANT — build humanisé (rappel Massii : « il regarde quand il place »)

> Non négociable, sur **toute** pose (blocs ET clics redstone). C'est exactement le tell « scaffold/printer » de la spec 5.

- **Regarder la face de pose AVANT de poser** : `bot.placeBlock` exige déjà de viser la face de référence — mais la rotation doit être **interpolée** (`bot.look` lissé, **JAMAIS `force=true`** = snap = détectable), tête tournée vers le bloc, pas vers ailleurs (= scaffold tête-figée).
- **Cadence humaine** : intervalle entre poses **variable 150-600 ms + micro-pauses + bursts**, jamais constant. La cadence par défaut de `mineflayer-schem` est trop régulière/rapide → **wrapper de ralentissement** obligatoire.
- **Clics redstone** (config repeater/comparateur) = aussi du clic → même traitement (look + délai variable).
- **Imperfection** : déplacements pour atteindre la zone, regards alentour occasionnels, erreurs/reprises rares. « Trop propre du premier coup » = signature.
- Réutilise directement la couche humanisation de la spec 5 §I (`@nxg-org/mineflayer-smooth-look`, délais ex-gaussiens, RNG injectable comme le `RateLimiter` #40).

## 5. Shulker box (storage portable)

> Le bot doit **utiliser les shulker box de son inventaire** comme stockage d'appoint.

- **Lecture/écriture** : une shulker box ne s'ouvre pas depuis l'inventaire en Java → il faut la **poser** (`bot.placeBlock`) → l'**ouvrir** (`bot.openContainer(block)`, même API que les coffres) → transférer (`withdraw`/`deposit`) → la **casser** (`bot.dig`) pour la reprendre **avec son contenu** (les shulkers conservent leur contenu cassés, sauf shulker rouge spécifique = OK en Java).
- **Utilisée par** :
  - `build` étape 2 (STOCK) → **inventorier aussi les shulkers** (posés à portée OU dans l'inventaire du bot : poser temporairement, lire, reprendre).
  - `deposit` (#40) → peut déposer dans une shulker si pas de coffre.
  - gestion d'overflow d'inventaire (un bot qui mine beaucoup) → ranger dans une shulker.
- **Anti-tell** : poser/casser une shulker = animation visible → cadence humaine, pas instantané.

---

## 6. Récap : liste des commandes (18) + budget

**Commandes directes (`/msg`, 0-token, gated trust)** :
`take` · `follow me` · `stop` · `craft` · `give` · `give all` · `pvp` · `tpa` · `mine down` · `come` · `deposit` · `guard` · `equip` · `eat` · `goto` · `afk` · **`find <structure>`** 🆕 · **`build <farm>`** 🆕

**Tout reste 0-token** : `find` = locate/pathfind déterministe ; `build` = BOM + craft-anything + schématique, tous déterministes. Le LLM n'intervient **que** si le bot est bloqué et qu'on veut un arbitrage (où explorer si perdu) — option, pas le défaut.

---

## 7. Ce que ça demande à coder (Phase 3)

| Brique | Réutilise | Nouveau |
|---|---|---|
| Parse `find`/`build` | `orders.js` (ajouter 2 verbes) | 2 entrées |
| `find` exécution | pathfinder, `findBlock`, triangulation | `skills/find.js` + table structures |
| `build` exécution | **`prismarine-schematic` + `mineflayer-schem`** (pose + chest-retrieval), **craft-anything (spec 3)** pour ce qui manque, `/tpa` (#38), `dig`/`bestToolFor` (clear) | `skills/build.js` = surtout du **glue** : `/tpa` demandeur → **ancrage fond-droite + orientation cardinale** (rotate la schém) → **CLEAR emprise** (miner obstacles + niveler + collecter drops→STOCK, garde-fous anti-grief) → charger `.schem`, BOM auto, wrapper humanisation |
| Catalogue builds | — | `builds-catalog.json` (`name`→`.schem`) + fichiers `.schem` dans `mc-agent/builds/` |
| Shulker I/O | `bot.openContainer`/`placeBlock`/`dig` | helper `useShulker()` |
| Humanisation pose | spec 5 §I (cadence/look) | wrapper de ralentissement autour de `mineflayer-schem` |

⚠️ **DÉPENDANCES** : `find` = 0 nouvelle dép (mineflayer+pathfinder). **`build` = 2 NOUVELLES déps Node** (`prismarine-schematic`, `mineflayer-schem`) → **`npm install` à la main sur l'Omen** (l'auto-deploy ne réinstalle pas, cf. #33). C'est le prix de ne pas hand-coder les schématiques — bon compromis, mais à NE PAS oublier au déploiement.
