# MC Agent — Spec ressources & système de craft (« craft anything »)

> **Provenance** : recherche multi-agents (14 angles + synthèse), 02/06/2026, MC Java 1.21.x. Chiffres vérifiés Wiki.
> **3e document de la série planner MC Agent**, companion de :
> - `2026-06-02-mc-agent-diamond-planner-spec.md` (graphe de buts + archi planner §9)
> - `2026-06-02-mc-agent-diamond-netherite-deep-research.md` (diamant → netherite approfondi)
>
> Couvre : **toutes** les ressources (où/Y/outil/usages), les stations de transformation, l'**architecture craft-anything** (résolveur récursif sur `minecraft-data`, 0-token, §C), nourriture/faim, brewing (dont Fire Resistance), et déterministe vs observation.

---

> Compagnon de la spec diamant/netherite existante. Convention outil-gate : **un bloc miné sans le tier de pioche requis = 0 drop (perte sèche)** → encoder comme prérequis dur, vérifié AVANT l'action. Saturation alimentaire notée en points (1 hunger point = ½ jambon).

---

## A. Table maîtresse des ressources

| Ressource | Où / Y / biome | Outil minimal (drop) | Méthode d'acquisition | Usages craft clés |
|---|---|---|---|---|
| **Iron** (rappel spec) | strip-mine bas + grottes | pioche **pierre+** | mine → smelt raw iron | tout l'outillage, stations (anvil 31 fer, blast furnace, rails…) |
| **Copper ore** | Y −16→112, **pic Y=48** ; boost **Dripstone Caves** (blobs +gros) | pioche **pierre+** | mine → smelt → copper ingot (2–5 raw, Fortune III moy 7.7) | Lightning rod (3 ingots), Spyglass (2 ingots+1 amethyst shard), Brush (1+plume+stick), bloc (9) |
| **Gold ore (overworld)** | Y −64→32 (+batch −64→−48), **pic Y=−16** | pioche **fer+** (gold pickaxe = RIEN) | mine → smelt → gold ingot (1 raw) | Clock (4 ingots+1 redstone), Powered rail (6 ingots+1 stick+1 redstone→6), Golden apple (8 ingots+pomme), bloc (9) |
| **Gold ore (badlands)** | **Y 32→256 uniforme, 50×/chunk**, exposé surface | pioche **fer+** | collecte de surface (pas de strip-mine) | idem ; voie or la moins chère si biome accessible |
| **Nether gold ore** | Nether Y 10→117, ~Y15 | **toute pioche** (bois OK) | mine → **2–6 gold nuggets** (Fortune ↑) ; 9 nuggets=1 ingot | nuggets → golden carrot (8+carotte), glistering melon (8+tranche) ; bartering |
| **Redstone ore** | Y −64→15 (+batch −63→−32 dense bas), **pic Y≈−59** | pioche **fer+** | mine → 4–5 dust (F3 moy ~6) ; XP 1–5 ; matcher `deepslate_redstone_ore` | torch, repeater, comparator, piston (+1 rs), clock, compass, bloc (9), **modificateur durée potions** |
| **Lapis lazuli ore** | Y −32→32 (pic **Y=0**) + batch −64→64 | pioche **pierre+** | mine → 4–9 (F3 ×1..4 → max 36) ; XP 2–5 | **enchantement obligatoire** (1–3/op), bloc (9), teinture bleue |
| **Emerald ore** | Y −16→320, pic théorique Y=232 (pratique ~Y90) ; **biomes montagne UNIQUEMENT** | pioche **fer+** | **commerce villageois** (voie réelle) ; mine = opportuniste surface | troc villageois ; bloc (9) |
| **Amethyst cluster** | **géodes** (Y −58→30) ; stade 4/4 sur budding | **toute pioche** | casser cluster mûr → **4 shards** (pioche) / 2 (autre) ; F3 ≈8.8 | Spyglass, Tinted glass (1 glass+4 shards→2), bloc (4) |
| **Budding amethyst** | cœur de géode | — | **JAMAIS récupérable** (0 drop même Silk Touch, indéplaçable) | (source des clusters — ne jamais casser) |
| **Nether quartz ore** | Nether, toutes altitudes (Y10–15 & 104–118), très abondant | pioche **bois+** | mine → 1 quartz (F3 max 4, moy 2.2) | Comparator (1q), Observer (1q), Daylight detector (3q), bloc (4) |
| **Coal / Charcoal** | charbon: mine ; charbon de bois: smelt log | pioche bois+ (coal) | mine coal OU smelt n'importe quel log → charcoal | combustible (8 items/coal), torches |
| **Logs (12 familles)** | par biome (voir §détail bois) | **AUCUN** (casse main, drop garanti ; hache = vitesse) | abattre arbre | **1 log → 4 planks** ; planks → tout l'outillage bois |
| — Oak | Forest/Plains, partout (fallback universel) | aucun | abattre | planks fongibles |
| — Spruce/Birch/Jungle/Acacia | Taiga / Birch Forest / Jungle / Savanna | aucun | abattre (Spruce/Jungle giant = 2×2) | planks |
| — Dark Oak / Pale Oak | **Dark Forest / Pale Garden** (tronc **2×2**) | aucun | abattre colonne 2×2 | planks |
| — Mangrove / Cherry | **Mangrove Swamp / Cherry Grove** | aucun | abattre | planks |
| — Crimson / Warped (stems) | **Crimson/Warped Forest** (Nether) | aucun | abattre fungus | planks **ininflammables**, PAS de boat |
| **Bamboo** | Jungle/Bamboo Jungle, pêche | aucun | récolte ; 9 bamboo→1 bamboo_block | bamboo_block → **2 planks** (seul à 2), raft (pas boat) |
| **Stone** | Overworld solide Y>0 | pioche **bois+** | mine → **cobblestone** (re-smelt → stone) | stone tools, furnace, stations ; smooth stone (smelt) |
| **Deepslate** | remplace stone à **Y≤0** (transition Y8→0) | pioche bois+ | mine → cobbled deepslate (~2× plus lent, dureté 4.5) | substitut cobble (sauf redstone) |
| **Tuff** | blobs **Y −64→0**, tous biomes | pioche bois+ | mine → drop direct (pas de re-smelt) | déco (stonecutter) |
| **Granite/Diorite/Andesite** | blobs Y 0–60 (+batch Y 64–128) | pioche bois+ | mine → drop direct | déco/polished |
| **Calcite** | couche médiane géodes, Y −58→30 | pioche bois+ | mine | déco |
| **Blackstone** | Nether, blobs Y 5–31 + basalt deltas | pioche bois+ | mine → drop direct | **substitut cobble** pour stone tools/furnace/brewing (PAS redstone) |
| **Basalt / Smooth basalt** | Basalt Deltas / couche externe géodes | pioche bois+ | mine | déco |
| **End stone** | The End, toutes îles | **toute pioche** | mine → 1:1 | déco |
| **Sand** | plages, déserts, fonds | pelle (vitesse ; drop main) | mine ⚠️ **gravité** | smelt → **glass** ; sandstone (4), TNT (4+5 gunpowder), concrete powder (4 sand+4 gravel+1 dye→8) |
| **Red sand** | badlands | pelle | mine ⚠️ gravité | glass (CLAIR), sandstone, TNT ; **REFUSÉ pour concrete powder** |
| **Gravel** | sous eaux peu prof., fonds, Nether près lave | pelle | mine ⚠️ gravité | **10% flint** sinon gravel (F3=100% flint) ; concrete powder ; coarse dirt |
| **Clay (bloc)** | sous eau peu prof., **lush caves** (gros, tout Y) | pelle | mine → **4 clay balls** (Fortune INUTILE, cap 4) | smelt bloc→terracotta ; ball→brick ; bloc (4 balls) |
| **Mud** | Mangrove swamp, trail ruins, trial chambers | pelle | mine ; ou water_bottle sur dirt | packed mud (1 mud+1 wheat) → mud bricks (4) |
| **Glass** | — | n'importe quoi | **smelt sand** (récup IMPOSSIBLE sans Silk Touch) | panes (6→16), stained (8+dye→8), tinted (1+4 shards→2) |
| **Netherrack** | terrain Nether partout | **toute pioche** | mine (très mou) | base déco Nether |
| **Soul sand** | Soul Sand Valley ; rives lave Y<34 | pelle (drop main) | mine | Soul Torch, **base wither** (4 en T), bubble column ↑, **culture nether wart** |
| **Soul soil** | Soul Sand Valley floor | pelle | mine | interchangeable soul sand (soul-fire/wither) |
| **Nether wart** | jardins fortress (sur soul sand) / bastion | **main** (instantané) | récolte → 2–4/bloc mûr (F3=4) | **base Awkward Potion** (toutes potions) ; replantable→renouvelable |
| **Glowstone** | plafonds/surplombs Nether | **toute pioche / main** | casser → **2–4 dust (Fortune cap 4, jamais +)** | Redstone Lamp (1 bloc+4 rs), Spectral Arrow (4 dust+arrow→2), **upgrade potion lvl II** ; bloc (4 dust) |
| **Crying obsidian** | **piglin bartering** (~9%, 1–3) ; portails ruinés ; bastions | pioche **diamant+** | barter (pas de dust) | **Respawn Anchor** (3 crying + 3 glowstone blocks) |
| **Obsidian** (rappel) | eau+lave | pioche **diamant+** | mine | enchanting table, ender chest, end crystal, Nether portal |
| **Blaze rod** | **fortress blaze spawner UNIQUEMENT** | **kill joueur/loup** | tuer Blaze → **50%, +1/Looting (max 4)** | **Blaze powder (1→2)**, Brewing stand (1 rod+3 cobble), End rod |
| **Ghast tear** | Ghast (Nether wastes/SSV/deltas) | tuer (ranged OK) | tuer → 0–1 (50%), +1/Looting (max 4) | Potion Regeneration, End crystal (+7 obsidian+eye) |
| **Magma cream** | magma cube ≥medium (small=0) OU craft | — | **craft = 1 blaze powder + 1 slimeball** (préféré) | Potion **Fire Resistance**, magma block (4) |
| **Wither skeleton skull** | wither skeleton (fortress, sombre) | **kill joueur/loup** | tuer → **2.5%**, +1%/Looting (5.5% à L-III, ~18 kills/skull) | summon Wither (3 skulls) |
| **Ender pearl** | Enderman ; bartering 2–4 @ ~2.13% | **kill joueur/loup** | tuer → **0–1 (50%)**, L-III → 0–4 (91.67%) | **Eye of Ender** (1 pearl+1 blaze powder), Ender chest |
| **End stone / Chorus** | The End îles externes | aucun (chorus instantané) | casser chorus plant → **50%/bloc** (Fortune n'affecte pas) | popped (smelt) → Purpur (4→4), End rod |
| **Shulker shell** | shulkers (End city murs + ship) | toute arme | tuer → **50%** (L-III 68.75%) | **Shulker box** (2 shells+1 chest) = 27 slots, **garde contenu** |
| **Elytra** | **End ship, item frame** | — | récupérer | **1/ship garanti**, non renouvelable ; durabilité 432 |

### Détails mob-drops généralistes (drop à n'importe quel outil sauf note)

| Drop | Source | Count base (sans Looting) | Note kill |
|---|---|---|---|
| String | Spider/Cave Spider | 0–2 | any ; **cobweb→1 string mais épée/shears requis** |
| Gunpowder | Creeper (0–2) / Witch / Ghast | 0–2 | any |
| Bone | Skeleton/Stray | 0–2 | any |
| Leather | Cow/Mooshroom/équidés/Llama/Hoglin | 0–2 | any |
| Feather | Chicken | 0–2 | any |
| Slimeball | small slime (swamp Y≤40 nuit / slime chunks tout Y) | 0–2 (66.67%) | any |
| Ink sac | Squid | 1–3 | any |
| Spider eye | Spider/Cave Spider (0–1, 33%) / Witch | 0–1 | **kill joueur** |
| Looting III sur drops 0–2 | — | ~1.0/kill → ~2.0/kill | — |

---

## B. Stations de transformation

| Station | Recette pour la fabriquer | Ce qu'elle permet |
|---|---|---|
| **Crafting table** | 4 planks (2×2) | Débloque grille 3×3. **Prérequis de tout le reste.** |
| **Furnace** | 8 cobblestone (anneau, centre vide) | Smelting générique, **200 ticks (10 s)/item**, 6/min. Seul à accepter verre/charbon/divers. Fuel brûle en entier → ne charger qu'avec input. |
| **Blast furnace** | 1 furnace + **5 fer** + 3 smooth stone | **Métaux uniquement** (raw iron/gold/copper, minerais, ancient debris, outils métal). **100 ticks (5 s) = 2×**. |
| **Smoker** | 1 furnace + 4 logs | **Nourriture uniquement**, **100 ticks (5 s) = 2×**. |
| **Smithing table** | 2 fer + 4 planks | Slots `Template\|Base\|Addition`. **Upgrade netherite** + armor trims. Ne renomme/enchante PAS. |
| **Brewing stand** | 3 cobblestone + 1 blaze rod | Potions. Fuel = blaze powder (**20 batches/poudre**), base nether wart, **400 ticks (20 s)/brew**, 3 fioles en //. |
| **Stonecutter** | 1 fer + 3 stone | Coupe pierre/cuivre/quartz en variantes **sans perte** (1:1, dalles 1:2). |
| **Loom** | 2 string + 2 planks | Motifs bannières (consomme 1 dye, pas de patron crafté). |
| **Cartography table** | 2 paper + 2 planks | Zoom/copie/lock cartes. |
| **Grindstone** | 2 sticks + 1 stone slab + 2 planks | **Désenchante** (rend XP, garde curses), répare 2 items identiques (+5%), reset malus enclume. |
| **Anvil** | 3 blocs de fer + 4 fer (= **31 fer**) | Renommer, combiner enchants/livres, réparer avec matériau. Coûte XP + prior-work penalty. **Le plus cher.** |
| **Campfire** | 3 sticks + 3 logs + 1 charbon | Cuit 4 aliments **sans fuel** (lent, pas d'XP), signal fumée. |
| **Enchanting table** | 1 livre + 2 diamants + 4 obsidian | Enchante via XP+lapis ; +15 bookshelves (rayon 1, gap) → niveau 30. **Seule station gated pioche diamant.** |

**XP smelting (hardcoder)** : fer/or/cuivre **0.7** · quartz **0.2** · charbon/diamant/émeraude/lapis/redstone smeltés **1.0** · ancient debris→scrap **2.0** · food ~0.35 · sable/cactus 0.1.

**Arbre de dépendance des stations** : `crafting table → furnace → (blast furnace | smoker | stonecutter | smithing table | grindstone | brewing stand | anvil)`. Toutes les downstream consomment du **fer fondu** (lui-même via furnace/blast). Ordonner : bois → table → pioche bois → cobble → furnace → smelt fer → reste. **Substituts cobble** pour furnace/stone tools/brewing : `cobblestone`, `cobbled deepslate`, `blackstone` (mais redstone components = cobblestone STRICT).

---

## C. ARCHITECTURE "craft anything" (le cœur)

Résolveur de craft **récursif, déterministe, 0-token** sur `mineflayer` + `minecraft-data`. Le graphe complet des recettes est livré offline dans `minecraft-data` (un JSON par version de jeu) → **aucun appel LLM, aucune table de recettes hardcodée**. Le LLM ne sert qu'à choisir le *goal item* ; l'expansion jusqu'aux feuilles est de la pure recherche de graphe.

### C.1 API surface (PrismarineJS)

| Call | Signature | Comportement |
|---|---|---|
| `bot.recipesFor` | `(itemType, metadata, minResultCount, craftingTable)` | `Recipe[]` craftables **avec l'inventaire actuel**. `metadata=null`→any. `minResultCount=null`→1. **`craftingTable=null` → seulement recettes 2×2 inventaire**. |
| `bot.recipesAll` | `(itemType, metadata, craftingTable)` | Même liste **en ignorant l'inventaire** → utiliser pour **planifier l'arbre**. |
| `bot.craft` | `(recipe, count, craftingTable)` | `Promise<void>`. `count` = nombre d'exécutions (8 sticks via 4 planks → `count:2`). Passer le `Block` table ou `null`. |
| graphe offline | `mcData.recipes[itemId]` | Array de recettes par id numérique. Aussi `prismarine-recipe` `Recipe.find(itemType[,metadata])`. Pinné via `require('minecraft-data')(bot.version)`. |

### C.2 Forme de l'objet Recipe (`prismarine-recipe`)

- **`result`** : `{id, metadata, count}` — ce que ça produit.
- **`inShape`** : grille 2D de `recipeItem` (ou `null`) → recette **shaped** (la position compte).
- **`ingredients`** : array plat indépendant de la forme → recette **shapeless**.
- **`delta`** : array de `{id, metadata, count}` = changement net d'inventaire. **Entrées négatives = inputs consommés, positives = résultat.** C'est le canonique "ce qui entre / ce qui sort" sans parser la grille.
- **`requiresTable`** : booléen → `true` = besoin table 3×3 ; `false` = grille 2×2 inventaire suffit.

**Détection table-gate = donnée, pas heuristique** : filtrer `requiresTable`, OU tester `bot.recipesFor(id,null,1,null).length > 0` (inventaire) vs `recipesFor(id,null,1,tableBlock)`. Même modèle typé pour furnace (smelt) et smithing-table (netherite).

### C.3 Algorithme de résolution récursif (pseudo-code)

```
resolve(item, qty, have):
    if have[item] >= qty:                    # cas de base : déjà en inventaire
        return []
    if isBaseResource(item):                 # feuille : log/minerai/cobble/sand…
        return [acquire(item, qty)]          # → sous-but minage/smelt/collecte (§E)

    r       = mcData.recipes[item][0]         # choisir une recette (offline)
    perCraft = r.result.count
    runs    = ceil((qty - have[item]) / perCraft)

    steps = []
    for (ing, cnt) in negativeDeltas(r):     # ingrédients via delta (entrées<0)
        steps += resolve(ing, cnt * runs, have)   # ← RÉCURSION vers les feuilles

    steps.push({ craft: item, runs, table: r.requiresTable })
    return steps                              # post-ordre : feuilles avant parents
```

**Points clés de l'algo :**

1. **Arbre → ressources de base** : récursion sur `delta` (ou `ingredients`/`inShape`) jusqu'aux items bruts (logs, minerai, cobblestone, sand). **Mémoïser les items visités** pour tuer les cycles.
2. **Smelting = arête séparée** : `mcData.recipes` est grille-de-craft **uniquement**. Iron/gold/glass/charcoal/popped-chorus/terracotta/brick/smooth-stone sont des **sorties de furnace** (`bot.openFurnace()` / API furnace mineflayer) → les modéliser comme **un type de nœud distinct**, ordonné AVANT le craft qui les consomme. Le **fuel** (coal/planks) devient un autre sous-but.
3. **Ordonnancement** : **DFS post-ordre** — feuilles (planks→sticks) avant parents (sticks+iron→pickaxe). Placer/localiser un `crafting_table` **lazily**, seulement quand un nœud a `requiresTable:true` (cf. impl de réf mindcraft : `world.getNearestBlock(bot,'crafting_table',range)` → sinon `placeBlock(...,'crafting_table')`).
4. **Pénurie → sous-but d'acquisition** : quand `recipesFor` renvoie vide mais `recipesAll` est non-vide, le **diff besoin-vs-possédé** (via `delta`) donne exactement quels inputs bruts aller miner/smelt → c'est le **pont vers la spec diamant/netherite existante** (les feuilles alimentent les routines de minage/smelting déjà codées).
5. **Cap par stock** : `bot.craft(recipe, Math.min(craftLimit, num), table)` (pattern mindcraft).

### C.4 Pourquoi 0-token

Tout le graphe de recettes + les `delta` sont dans `minecraft-data` (offline, versionné). La traversée, l'ordonnancement, la détection table/furnace, et le calcul de la shopping-list sont de la **recherche de graphe pure** → dispatch d'actions déterministes craft/smelt/gather. **Le LLM n'intervient que pour choisir le goal et arbitrer les substitutions/priorités (§E).** Bonus gratuit : traverser `delta` *vers le haut* donne les usages partagés (iron_ingot → pickaxe/bucket/rails/anvil…) → le planner peut **batcher l'acquisition des intermédiaires partagés une seule fois**.

---

## D. Nourriture, faim & catégories spéciales

### D.1 Valeurs de restauration (hunger / saturation)

| Aliment | Hunger | Saturation | Cuisson ? | Note |
|---|---|---|---|---|
| **Golden carrot** | 6 | **14.4** | non (craft) | densité max ; 8 nuggets+1 carotte |
| Cooked beef / porkchop | **8** | 12.8 | oui | meilleur ratio effort/rendement (élevage+smoker) |
| Golden apple | 4 | 9.6 | non (craft) | +effets ; 8 ingots+pomme ; mangeable même à faim pleine |
| Cooked mutton / salmon | 6 | 9.6 | oui | |
| Cooked chicken | 6 | 7.2 | oui | |
| Bread | 5 | 6.0 | non (craft) | 3 wheat |
| Baked potato / Cooked cod | 5 | 6.0 | oui | |
| Sweet berries / Melon slice | 2 | 1.2 | non | |
| **Chorus fruit** | 4 | 2.4 | non | ⚠️ téléporte ±8 blocs |

**Mécanique** : `saturation = hunger × satModifier × 2`, plafonnée à la valeur de hunger courante. Le sprint vide la **saturation** (réserve invisible) avant la barre de faim. Régén PV passive dès **faim ≥ 18/20 ET saturation > 0**. Manger bloqué à faim=20 (sauf golden/enchanted apple).

**Heuristique consommation bot** : déclencher repas à **`hunger ≤ 17`** (préserve la régén) ; ne PAS gaspiller un golden carrot si faim ≥ 19 (overflow perdu → manger bread/baked potato à la place).

**Cultures** (récolte = aucun outil ; houe pour labourer) : Wheat (1 wheat + **1–4 seeds**, ~2.71) · Carrot/Potato (**2–5**, ~3.71 ; potato 2% poisonous) · Beetroot (1 + 0–3 seeds) · Melon (**3–7 slices**, houe ↑) · Pumpkin (×1). Conditions : **light ≥ 8 pour planter, ≥ 9 pour croître** ; farmland hydraté accélère ; bone meal force des stades (sauf melon/pumpkin = stem only).

**Élevage** (kill = arme quelconque ; feu = drop cuit direct ; breed 1 item/parent, cooldown 5 min) : Cow (wheat → beef 1–3, leather 0–2) · Pig (carrot/potato/beetroot → porkchop 1–3) · Chicken (seeds → chicken 1, feather 0–2, œuf/5–10min) · Sheep (wheat → mutton 1–2, wool). Looting III ↑ (beef 1–6).

**Cuisson** : smoker/furnace (1 raw→1 cooked, 0.35 XP) ; campfire (4 items, sans fuel, lent, pas d'XP) = fallback. Recettes : Bread = 3 wheat (rangée) · Golden carrot = 8 nuggets + carotte (centre) · Golden apple = 8 ingots + pomme · **Enchanted golden apple = non craftable (loot only)**.

### D.2 Catégories spéciales

**Mob drops → usages craft (quantités exactes)** :

| Drop | Crafts clés (sortie : inputs) |
|---|---|
| String | Wool (4→1) · Fishing rod (3 stick+2) · Bow (3 stick+3) · Crossbow, loom, scaffolding |
| Gunpowder | TNT (5+4 sand) · Fire charge (1 gp+1 blaze powder+1 coal→3) · Firework rocket (1 paper+1 gp→3) |
| Bone | Bone meal (1→3) · Bone block (9 meal) · tame wolf |
| Leather | Armor cuir · Book (3 paper+1) · Item frame (8 stick+1) |
| Feather | Arrow (1 flint+1 stick+1 feather→4) |
| Ender pearl | **Eye of ender (1+1 blaze powder)** · Ender chest (8 obsidian+1 eye) · activation portail (12 eyes) |
| Blaze rod | **Blaze powder (1→2)** · Brewing stand (1+3 cobble) · End rod |
| Slimeball | Sticky piston (1 piston+1) · **Magma cream (1+1 blaze powder)** · Slime block (9) |
| Ink sac | Black dye (1→1) · gray/light-gray mixes |
| Spider eye | **Fermented spider eye** (1+1 sugar+1 brown mushroom) → potions corruption |
| Ghast tear | Potion Regeneration · End crystal (7 glass+1 eye+1 tear) |
| Magma cream | **Potion Fire Resistance** · Magma block (4) |

⚠️ **Version flag** : **recette du Lead changée en 1.21.6** (ancien `4 string + 1 slimeball → 2 leads` retiré). Détecter `bot.version` ; sur 1.21.6+ ne PAS émettre la recette legacy. Magma cream + sticky piston stables sur tout 1.21.x.

**Dyes / laine → lit (pour bed-mining netherite)** :
- **Wool** : tonte (**cisailles = 2 fer**) → 1–3 wool/mouton (repousse, renouvelable) ; OU kill (1 wool, non renouvelable) ; OU 4 string → 1 white wool. Spawn mouton blanc 81.8%.
- **Lit** = **3 wool même couleur + 3 planks** → pose le spawn ; **hors Overworld (Nether/End) → explosion puissance 5** (>TNT=4) → **exploit bed-mining ancient debris** (1 lit consommé par blast).
- **16 teintures** : primaires = white (bone meal), black (ink sac), blue (lapis), brown (cocoa), green (smelt cactus), red (poppy/beetroot), yellow (dandelion), + lime (smelt sea pickle), cyan (pitcher). Secondaires par mélange (sortie **×2** : orange/purple/cyan/light blue/pink/magenta/lime/gray ; **×3** : light gray via black+white+white). **Recettes-batch très rentables** : 1 dye → 8 stained glass / 8 terracotta / 8 concrete powder.

**Brewing → potions clés** (apparatus : brewing stand ; fuel blaze powder = 20 op ; 1 brew = 20 s, 3 fioles en //). Chaîne : **Water bottle → +Nether wart → Awkward Potion** (base universelle).

| Potion | Ingrédient (sur Awkward) | Base | +Redstone | +Glowstone (lvl II) |
|---|---|---|---|---|
| **Fire Resistance** ⭐ | **Magma cream** | 3:00 | **8:00** | — |
| Water Breathing | Pufferfish | 3:00 | 8:00 | — |
| Swiftness | Sugar | 3:00 | 8:00 | 1:30 |
| Strength | Blaze powder | 3:00 | 8:00 | 1:30 |
| Night Vision | Golden carrot | 3:00 | 8:00 | — |
| Leaping | Rabbit's foot | 3:00 | 8:00 | 1:30 |
| Healing (instant) | Glistering melon slice | instant | — | instant II |
| Regeneration | Ghast tear | 0:45 | 1:30 | 0:22 |
| Poison | Spider eye | 0:45 | 1:30 | 0:22 |
| Slow Falling | Phantom membrane | 1:30 | 4:00 | — |
| Weakness | Fermented spider eye **(sur water bottle direct, pas d'Awkward)** | 1:30 | 4:00 | — |

**Modifiers terminaux** : Redstone = durée / Glowstone = lvl II (**mutuellement exclusifs**) · Gunpowder = Splash (~0.75× durée) · Dragon's breath = Lingering (~¼) · Fermented spider eye = corruption (Night Vision→Invisibility, Speed→Slowness, Healing→Harming, Strength→Weakness…). **Glowstone n'a AUCUN effet** sur Fire Res / Water Breathing / Night Vision / Slow Falling → gate ces potions hors de la branche lvl II.

⭐ **Fire Resistance = pipeline déterministe pour le netherite** : 1 trip Nether-fortress → blaze rods (stand + fuel + powder) + magma cream (blaze powder + slimeball) + nether wart. **Brew Fire Res AVANT de miner à Y≤−53** : 3:00 (ou 8:00 extended) suffit largement pour une session ancient debris. 1 magma cream → 3 potions.

---

## E. Décisions déterministes (0-token) vs observation/jugement (LLM)

> Objectif budget LLM : tout ce qui est **lookup de fait** sort du graphe `minecraft-data` + tables ci-dessus → **0 token**. Le LLM est réservé à l'arbitrage contextuel.

### E.1 Déterministe — 0 token (hardcoder / lire le graphe)

| Décision | Source déterministe |
|---|---|
| **Lookup de recette** (inputs, quantités, shaped/shapeless, table/furnace) | `mcData.recipes[id]`, `delta`, `requiresTable` (§C) |
| **Outil-gate par ressource** | table §A : cuivre/lapis/stone-family = pierre+ ; or-overworld/redstone/emerald = fer+ ; crying obsidian/obsidian = diamant+ ; quartz/nether-gold/glowstone/end-stone/chorus = toute pioche/main ; bois/cultures/mob-loot = aucun. **Vérifier `inventory.has(tier)` AVANT l'action, bloquer si insuffisant.** |
| **Y-targets de minage** | copper Y=48 (Dripstone), or Y=−16 (ou badlands surface), redstone+diamant Y=−59 (trajet combiné), lapis Y=0, emerald=biome montagne |
| **Matching variantes deepslate** | matcher `redstone_ore`+`deepslate_redstone_ore` etc. ; timeouts ×~1.5 sous Y0 (dureté 4.5) |
| **Valeurs de faim / seuil repas** | table §D.1 ; manger si hunger ≤ 17 |
| **Recettes potions / modifiers / corruptions** | table §D.2 (mapping fixe) |
| **Quantités de drop / espérance Fortune-Looting** | §A (ex. flint p=0.10 → ~10×N gravels ; ender pearl/blaze rod 0.5/kill → 2.0 avec Looting III) |
| **Flags kill-joueur** | ender pearl, blaze rod, spider eye, wither skull, ghast tear : le bot DOIT porter le coup fatal |
| **Substituts fongibles** | planks (toute famille, mixable) ; craftingStone = cobble/cobbled deepslate/blackstone (sauf redstone = cobble strict) ; red sand = sand SAUF concrete powder |
| **Version-gating** | `bot.version` → recette Lead 1.21.6+ |
| **Ordonnancement craft/smelt** | DFS post-ordre (§C.3) |

### E.2 Observation / jugement — appel LLM justifié

| Décision | Pourquoi le LLM |
|---|---|
| **Quelle ressource prioriser** | dépend du goal courant, de l'inventaire, du gear, de la phase de jeu (early/mid/end) |
| **Quand farmer vs continuer** | trade-off temps/risque selon faim, PV, menaces, distance — contextuel |
| **Substitutions ressources** | ex. or via badlands-surface vs strip-mine vs nether-bartering selon biome accessible ; magma cream craft vs hunt ; emerald trade vs mine |
| **Quand activer Looting III / Fortune III** | rentabilité selon la cible (Fortune utile sur ore/quartz/amethyst ; **inutile sur glowstone cap 4, clay cap 4, budding, chorus**) |
| **Choix du goal item** | seul vrai point d'entrée LLM ; l'expansion en feuilles est ensuite 0-token |
| **Décisions biome-gated / structure-gated** | localiser fortress (blaze), géode (amethyst, sans casser budding), End city (shulker), village (emerald), Dark Forest/Pale Garden (2×2 logs) — exploration = jugement |
| **Gestion ressources non-minables-sur-demande** | calcite/basalt/blackstone/budding = `biome-gated`, pas `Y-gated` → planifier un détour |

**Règle de partage de budget** : `goal (LLM) → resolve() (0-token, §C) → feuilles → acquire() (0-token gate + Y-target) → si exploration/structure requise OU substitution ambiguë → escalade LLM`. Le LLM ne touche jamais aux quantités de recette ni aux outil-gates.

---

## Sources

**Métaux / minerais / gemmes**
- [Copper Ore](https://minecraft.wiki/w/Copper_Ore) · [Copper](https://minecraft.wiki/w/Copper) · [Gold Ore](https://minecraft.wiki/w/Gold_Ore) · [Gold Ingot](https://minecraft.wiki/w/Gold_Ingot) · [Nether Gold Ore](https://minecraft.wiki/w/Nether_Gold_Ore)
- [Redstone Ore](https://minecraft.wiki/w/Redstone_Ore) · [Lapis Lazuli Ore](https://minecraft.wiki/w/Lapis_Lazuli_Ore)
- [Emerald Ore](https://minecraft.wiki/w/Emerald_Ore) · [Nether Quartz](https://minecraft.wiki/w/Nether_Quartz) · [Budding Amethyst](https://minecraft.wiki/w/Budding_Amethyst) · [Amethyst Cluster](https://minecraft.fandom.com/wiki/Amethyst_Cluster) · [Tutorial:Amethyst farming](https://minecraft.wiki/w/Tutorial:Amethyst_farming)
- [Minecraft 1.21 Ore Distribution — Pro Game Guides](https://progameguides.com/minecraft/minecraft-1-21-ore-distribution-best-level-for-all-ores-diamonds-gold-restone-and-more/)

**Bois / pierres / sols**
- [Planks](https://minecraft.wiki/w/Planks) · [Log](https://minecraft.wiki/w/Log) · [Tree](https://minecraft.fandom.com/wiki/Tree) · [Wood blocks ranked — GuruGamer](https://gurugamer.com/pc-console/list-of-all-wood-blocks-in-minecraft-1-21-6-ranked-22064)
- [Stonecutter](https://minecraft.wiki/w/Stonecutter) · [Deepslate](https://minecraft.wiki/w/Deepslate) · [Stone](https://minecraft.wiki/w/Stone) · [Blackstone](https://minecraft.wiki/w/Blackstone) · [Diorite](https://minecraft.wiki/w/Diorite) · [Andesite](https://minecraft.wiki/w/Andesite) · [Tuff](https://minecraft.wiki/w/Tuff) · [Amethyst Geode](https://minecraft.wiki/w/Amethyst_Geode) · [Dripstone Caves](https://minecraft.wiki/w/Dripstone_Caves)
- [Sand](https://minecraft.wiki/w/Sand) · [Red Sand](https://minecraft.wiki/w/Red_Sand) · [Gravel](https://minecraft.wiki/w/Gravel) · [Glass](https://minecraft.wiki/w/Glass) · [Clay](https://minecraft.wiki/w/Clay) · [Mud](https://minecraft.wiki/w/Mud)

**Nourriture / agriculture / laine / dyes**
- [Hunger](https://minecraft.wiki/w/Hunger) · [Food](https://minecraft.wiki/w/Food) · [Crops](https://minecraft.wiki/w/Crops) · [Wheat Seeds](https://minecraft.wiki/w/Wheat_Seeds) · [Carrot](https://minecraft.wiki/w/Carrot) · [Potato](https://minecraft.wiki/w/Potato) · [Cow](https://minecraft.wiki/w/Cow) · [Chicken](https://minecraft.wiki/w/Chicken) · [Sheep](https://minecraft.wiki/w/Sheep) · [Golden Apple](https://minecraft.wiki/w/Golden_Apple)
- [Wool](https://minecraft.wiki/w/Wool) · [Dye](https://minecraft.wiki/w/Dye) · [Bed](https://minecraft.wiki/w/Bed) · [Tutorial:Wool farming](https://minecraft.wiki/w/Tutorial:Wool_farming) · [Shears](https://minecraft.fandom.com/wiki/Shears)

**Mob drops / Nether / End**
- [Drops](https://minecraft.wiki/w/Drops) · [Enderman](https://minecraft.wiki/w/Enderman) · [Blaze](https://minecraft.wiki/w/Blaze) · [Witch](https://minecraft.wiki/w/Witch) · [Slimeball](https://minecraft.wiki/w/Slimeball) · [Ghast Tear](https://minecraft.wiki/w/Ghast_Tear)
- [Soul Sand](https://minecraft.wiki/w/Soul_Sand) · [Glowstone](https://minecraft.wiki/w/Glowstone) · [Respawn Anchor](https://minecraft.wiki/w/Respawn_Anchor) · [Blaze Rod](https://minecraft.wiki/w/Blaze_Rod) · [Blaze Powder](https://minecraft.fandom.com/wiki/Blaze_Powder) · [Wither Skeleton Skull](https://minecraft.wiki/w/Wither_Skeleton_Skull) · [Magma Cream](https://minecraft.wiki/w/Magma_Cream)
- [Eye of Ender](https://minecraft.wiki/w/Eye_of_Ender) · [Ender Pearl](https://minecraft.wiki/w/Ender_Pearl) · [Chorus Fruit](https://minecraft.wiki/w/Chorus_Fruit) · [Elytra](https://minecraft.wiki/w/Elytra) · [Shulker](https://minecraft.wiki/w/Shulker) · [Shulker Box](https://minecraft.wiki/w/Shulker_Box)

**Stations / brewing / craft-engine**
- [Furnace](https://minecraft.wiki/w/Furnace) · [Blast Furnace](https://minecraft.wiki/w/Blast_Furnace) · [Brewing Stand](https://minecraft.wiki/w/Brewing_Stand) · [Grindstone](https://minecraft.wiki/w/Grindstone) · [Smithing Template](https://minecraft.wiki/w/Smithing_Template) · [Recipe (Java Edition)](https://minecraft.wiki/w/Recipe_(Java_Edition))
- [Brewing](https://minecraft.wiki/w/Brewing) · [Minecraft Brewing Guide — Beebom](https://beebom.com/minecraft-potion-brewing-guide/) · [Minecraft potions 1.21 — allthings.how](https://allthings.how/minecraft-potions-in-1-21-complete-brewing-and-recipe-guide/) · [Brewing guide 1.21 — allthings.how](https://allthings.how/minecraft-brewing-guide-1-21-potions-modifiers-recipes/)
- [mineflayer API — crafting](https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md) · [prismarine-recipe](https://github.com/PrismarineJS/prismarine-recipe) · [mindcraft skills.js — craftRecipe](https://github.com/kolbytn/mindcraft/blob/main/src/agent/library/skills.js) · [mineflayer issue #2001](https://github.com/PrismarineJS/mineflayer/issues/2001) · [mineflayer issue #1726](https://github.com/PrismarineJS/mineflayer/issues/1726)
