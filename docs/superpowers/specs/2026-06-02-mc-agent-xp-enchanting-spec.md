# MC Agent — Spec XP & enchantement (farm spawner → N livres enchantés)

> **Provenance** : recherche multi-agents (7 angles + synthèse), 02/06/2026, MC Java 1.21.x. Chiffres vérifiés Wiki.
> **4e document de la série planner MC Agent**, companion de :
> - `2026-06-02-mc-agent-diamond-planner-spec.md` (graphe de buts + archi planner)
> - `2026-06-02-mc-agent-diamond-netherite-deep-research.md` (diamant → netherite)
> - `2026-06-02-mc-agent-resources-crafting-spec.md` (ressources + craft-anything)
>
> Scénario : le bot reste près d'un spawner, farme l'XP, puis enchante pour atteindre **N livres enchantés**. ⚠️ **Point clé** : à la table l'enchant est **ALÉATOIRE** ; pour un enchant **précis**, la seule voie déterministe = le **villageois bibliothécaire** (§D). La boucle entière est **0-token / 100 % déterministe** (§F).

---

> Périmètre : ce rapport couvre la chaîne XP → enchant → "N livres". Les specs diamant/netherite/ressources-craft sont supposées déjà connues du planner. **Convention déterministe/aléatoire signalée à chaque chiffre** — c'est ce qui décide si une étape exige un LLM ou non.

---

## A. Farm XP au spawner

### Mécanique du spawner (Java — tout déterministe sauf la position de spawn)

| Paramètre | Valeur exacte | Nature |
|---|---|---|
| Rayon d'activation joueur | **16 blocs sphériques** depuis le centre du bloc (≈15.5 du spawner) | déterministe (gate on/off) |
| Délai entre cycles | **200–799 ticks = 10–39.95 s**, uniforme | **aléatoire** |
| Tentatives de spawn / cycle | **4 mobs**, à des points choisis au hasard | nb fixe, **positions aléatoires** |
| Volume de spawn (Java) | **9×3×9** (±4 horiz, ±1 vert) centré sur le spawner | déterministe |
| Cap de proximité | si **≥6 mobs du type** ont leur hitbox dans un cube **9×9×9** centré → cycle "poof" (rien ne spawn) | déterministe |
| Reset du timer | nouveau délai tiré **seulement après ≥1 spawn réussi** | déterministe |

**Obscurité requise** : le spawner retire la contrainte de bloc solide en dessous mais **garde les conditions propres au mob, dont le light level**. Zombie / squelette / araignée exigent **block light 0** (≤ 0 pour hostile naturel en 1.18+). → Le donjon doit rester **sombre** dans le 9×3×9, sinon **0 spawn**. Le bot ne doit **jamais poser de torche** dans le volume ; éclairer uniquement une plateforme de kill *hors* volume si besoin.

### Le coup fatal du joueur est OBLIGATOIRE (règle déterministe critique)

Un mob **ne lâche AUCUN orbe d'XP** s'il ne meurt pas **dans les 5 s (100 ticks) d'un coup attribué à un joueur** (ou loup apprivoisé, ou dégât indirect chute/feu *initié* par le joueur dans la fenêtre). Conséquence directe : un farm "mort par chute/lave seule" donne le **loot d'objets mais 0 XP**.

→ **Le bot DOIT porter le coup fatal lui-même** (`bot.pvp.attack` / `bot.attack`). Le design "chute pour ramollir + finition épée du bot" est valide tant que le coup du bot tombe dans les 100 ticks.

### Cadence et boucle de kill safe

- **Débit** : 4 mobs / [10–39.95 s] ≈ **~0.1–0.4 mob/s** par spawner, soit ~1 mob / 6 s au mieux — modeste sur **un seul** spawner.
- **Vider le cap en continu** : si les mobs s'accumulent (≥6 dans le 9×9×9), les cycles "poof" → production gelée. Le bot doit **tuer en flux** pour relancer les spawns.
- **Positionnement** : rester à **<16 blocs** (spawner actif), viser ~4–8 blocs du point de chute → orbes ramassés gratuitement (cf. §E rayon 7.25).
- **Survie** : garde-fou `bot.health` bas → fuir, re-engager quand PV remontent (les mobs ripostent). Nourriture + armure en hard-code (réflexes).

---

## B. Maths XP & niveaux

### Formules exactes (DÉTERMINISTE)

**XP pour passer du niveau `L` → `L+1`** :

| Plage de L | XP du niveau suivant |
|---|---|
| 0–15 | `2L + 7` |
| 16–30 | `5L − 38` |
| 31+ | `9L − 158` |

**XP cumulée pour atteindre le niveau `L`** (depuis 0) :

| Plage de L | Total cumulé |
|---|---|
| ≤ 16 | `L² + 6L` |
| 17–31 | `2.5L² − 40.5L + 360` |
| ≥ 32 | `4.5L² − 162.5L + 2220` |

**Repères** : niv 1 = 7 XP · niv 15 = 315 · **niv 30 = 1395 XP** · niv 31 = 1507.

### Coût d'un enchant niveau-30 et re-grind entre deux livres

Le slot du bas **requiert** niveau 30 mais ne **prélève que 3 niveaux** (cf. §C). Donc après chaque enchant on retombe à **~niveau 27**, et il ne faut re-grinder que **27 → 30**, pas 0 → 30 :

| Transition | Coût (XP), via `5L−38` |
|---|---|
| 27 → 28 | 97 |
| 28 → 29 | 102 |
| 29 → 30 | 107 |
| **27 → 30 (somme)** | **306** |

> ⚠️ Correction d'une erreur courante : la suite n'est **pas** 92/97/102. Recalcul direct `5L−38` à L=27/28/29 → **97/102/107**, vérifié par cumul `1395 − 1089 = 306`. ✓

### XP par mob → combien de mobs par livre

**Drop par mob tué par le joueur** (PARTIELLEMENT ALÉATOIRE) : zombie / squelette / araignée / cave spider = **`5 + (1–3 par pièce d'équipement portée)`**. Le **5 est fixe/déterministe** ; le bonus équipement est aléatoire et **rare** sur mobs de spawner. **Planifier prudemment à 5 XP/mob.**
(Pour mémoire, autres mobs : Blaze/Guardian/Evoker = 10 ; Piglin Brute/Ravager = 20 (+1–3) ; spawner cassé one-shot = 15–43.)

**Conversion mobs → livre** (5 XP/mob) :

| Étape | XP | Mobs @ 5 XP | Borne basse (mobs équipés ~8 XP) |
|---|---|---|---|
| **1er livre** (0 → 30) | 1395 | **279 kills** | ~175 |
| **Chaque livre suivant** (27 → 30) | 306 | **~62 kills** | ~38–40 |

En pratique le **cap d'orbes + délai de spawn** dominent le temps, pas l'arithmétique des kills.

---

## C. Table d'enchantement (15 bibliothèques)

### Placement et coûts exacts (DÉTERMINISTE)

| Paramètre | Valeur | Nature |
|---|---|---|
| Bibliothèques pour débloquer niv 30 | **15** (au-delà = aucun effet) | déterministe |
| Placement | exactement **2 blocs latéralement**, **même hauteur OU +1**, avec **1 bloc d'air** entre table et étagère | déterministe |
| Géométrie pratique | anneau **5×5** de bibliothèques autour de la table centrale, 1 bloc d'air → 15 étagères en portée | déterministe |
| Coût **lapis** par slot (haut/milieu/bas) | **1 / 2 / 3** | déterministe |
| Niveaux **réellement prélevés** (haut/milieu/bas) | **1 / 2 / 3** | déterministe |
| Niveau **requis** affiché (slot bas, 15 étagères) | **≥ 30** | déterministe |
| Enchant obtenu | **aléatoire** (seed + table de poids) | **ALÉATOIRE** |

| Slot | Niveau offert (affiché) | Coût RÉEL prélevé |
|---|---|---|
| Haut | 2–10 | 1 niveau + 1 lapis |
| Milieu | 6–21 | 2 niveaux + 2 lapis |
| Bas | **30** (requiert niv 30) | **3 niveaux + 3 lapis** |

### Piège central : coût ≠ exigence

Le nombre vert affiché (1–30) est une **exigence de niveau minimum**, **PAS** le coût. Wiki verbatim : *"if the third enchantment listed is a level 30 enchantment, the player must have at least 30 levels, but pay only 3 levels and 3 lapis lazuli."* → posséder ≥30, ne dépenser que 3+3. Tout bloc dans l'espace 2-haut entre table et étagère (même une torche, une dalle, un tapis) **annule** la contribution de cette étagère → le bot garde la zone dégagée.

### Pourquoi niveau 30

- Seul le slot bas à 15 étagères atteint la **plage de tirage maximale** → meilleur rendement enchants/livre, seul accès aux enchants haut-tier, et **chance de bonus multi-enchant** la plus élevée.
- Coût marginal identique (3 niveaux) qu'on enchante à 27 ou à 30 → autant viser le plafond.
- Nuance wiki : *"a higher experience cost for a specific slot does not necessarily mean that the enchantments from that slot are better"* — vrai au cas par cas, mais **en moyenne** le slot 30 maximise rendement et accès aux hauts niveaux.

### L'enchant est ALÉATOIRE

À la table, le slot n'affiche qu'**UN** enchant-indice (galactique, purement cosmétique) + l'exigence de niveau. L'enchant réellement appliqué est tiré **pseudo-aléatoirement**, pondéré par (a) le niveau d'enchant interne dérivé des étagères + bruit, (b) la table de poids des enchants applicables à l'item (un livre accepte presque tout), (c) une chance de **bonus enchants multiples**. On peut donc obtenir **plusieurs** enchants, ou un autre que l'indice montré. → **On ne CHOISIT PAS l'enchant à la table.**

---

## D. Obtenir l'enchant VOULU (le point clé)

**Table = ALÉATOIRE.** Pour cibler un enchant précis, 3 voies, dont **une seule est déterministe**.

### Voie 1 — Seed re-roll (table) : ALÉATOIRE/semi-prédictible, déconseillé pour le bot

- La **seed d'enchantement** (`XpSeed`, **par joueur**, stockée en player-data NBT) fixe les 3 offres pour un `(item, nb étagères, niveau)` donné. Retirer/réinsérer l'item ou bouger la table **ne change rien**.
- `XpSeed` initialisé à **0** à la création du monde ; re-rollé au load **seulement s'il valait 0**. Cas canonique seed=0 : **épée diamant + 3 lapis + 15 étagères → toujours Unbreaking III + Looting II** — mais **un seul "first enchant" par monde**, la seed change dès le 1er enchant.
- **Chaque enchant appliqué fait avancer la seed** → nouvelles offres pour tous les items/niveaux. Re-roll pratique = enchanter un **objet jetable** (livre/épée bois : 1 lapis + 1 niveau) pour rafraîchir la liste. C'est un avancement **discret et déterministe** de l'état RNG.
- **Forçage par seed-cracking** (EnchantmentCracker / Clientcommands) : la seed **n'est PAS envoyée par le serveur**. Il faut la **cracker** en observant les niveaux affichés sur plusieurs comptes d'étagères, déduire `XpSeed` puis l'état du LCG, simuler à l'avance, et **jeter des items** pour aligner l'état RNG. **Lourd, fragile, souvent multi-comptes → à éviter côté mineflayer.**
- Côté bot, la **seule info fiable** est le **clue** (l'enchant affiché au survol) : c'est un **vrai** membre du set appliqué (pas un leurre), mais (a) son **niveau** n'est pas montré et (b) l'item reçoit souvent des **enchants secrets supplémentaires**. → 1 bit d'info pour un filtre keep/reroll partiel, jamais le résultat complet.

### Voie 2 — Villageois bibliothécaire : **DÉTERMINISTE** ✅ (voie recommandée)

C'est la **seule voie déterministe** pour obtenir un livre enchanté précis.

1. Villageois **sans métier** + **lutrin (lectern) non réclamé** à portée → devient bibliothécaire, offres **aléatoires** (dont ≥1 livre enchanté dès Novice).
2. **Tant qu'AUCUN trade n'est fait** : casser puis replacer le lutrin **re-roll entièrement** les offres. Boucler jusqu'à voir l'enchant **+ niveau** voulus.
3. **Le 1er trade VERROUILLE le métier ET les offres À VIE.** Le restock ne change jamais *quelles* offres existent, seulement leur dispo. → Le bot doit **valider l'offre AVANT** d'échanger (verrou irréversible).

Le joueur paie **`émeraudes + 1 livre vierge`** → reçoit le livre enchanté.

**Prix émeraudes par niveau d'enchant** (`min = 2 + 3·lvl`, `max = 6 + 13·lvl`, tiré **ALÉATOIREMENT** dans la plage, cap 64) :

| Niveau enchant | Plage normale | TRÉSOR (×2, cap 64) |
|---|---|---|
| I | 5–19 | 10–38 |
| II | 8–32 | 16–64 |
| III | 11–45 | 22–64 |
| IV | 14–58 | 28–64 |
| V | 17–71 → cap **64** | cap **64** |

**Logique bot** : `parse trades → if (enchant==cible && level>=cible) trade; else break+replace lectern; loop`. **Ne JAMAIS trade avant match.** Garder stock ≥64 émeraudes + livres vierges.

### Voie 3 — Enclume : combiner (DÉTERMINISTE, pour monter de niveau)

- **Livre+livre identiques** : Protection III + Protection III → **Protection IV** (déterministe).
- **Prior Work Penalty (PWP)** = `2^n − 1` niveaux (0, 1, 3, 7, 15…) ; combiner deux items de pénalité `p` → résultat `max(p)+1`.
- **Plafond survie : 39 niveaux** → au-delà = *"Too Expensive!"* (combiner deux livres déjà très pénalisés est vite bloqué).
- Note : **Book→Book** sert à monter le niveau d'un enchant ou recombiner ; pour appliquer à un outil c'est book→item.

### Enchants TRÉSOR (hors-table, à connaître)

**Jamais obtenables à la table** : **Mending, Soul Speed, Frost Walker, Swift Sneak, Wind Burst, malédictions (Curse of…)**. Disponibilité :
- **Mending, Frost Walker** : **proposables au lutrin** (voie 2 OK).
- **Soul Speed, Swift Sneak, Wind Burst** : **PAS** vendus par les bibliothécaires → loot/coffres uniquement (Swift Sneak 23.2 % Ancient City ; Wind Burst 5.5 % coffres ominous Trial Chamber).

→ Pour un bot visant un enchant trésor : **Mending/Frost Walker via lutrin (déterministe)** ; les autres **hors de portée d'une boucle farm** (nécessitent de l'exploration loot).

---

## E. Implémentation mineflayer

### API XP (vérifiée doc PrismarineJS master)

```js
bot.experience.level     // niveau entier courant
bot.experience.progress  // fraction 0.0–1.0 vers le niveau suivant (fiable)
bot.experience.points    // ⚠️ PIÈGE (voir ci-dessous)
bot.on('experience', () => { /* recalcul d'état à chaque changement */ })
```

> ⚠️ **Piège `bot.experience.points`** : malgré la doc « total cumulé », beaucoup de versions peuplent `points` avec l'XP **de la barre courante** (≈ `progress × coût_niveau`), **pas** le lifetime. **Ne pas s'y fier pour le cumul.** Recalculer soi-même via les formules §B :
> `XP_restante = totalForLevel(target) − totalForLevel(level) − progress × costForNextLevel(level)`.
> Exprimer la cible en **niveaux** (`level >= 30`), pas en points.

### Ramassage des orbes (rien à coder)

- **Rayon de ramassage = 7.25 blocs** (centre pieds → centre orbe) ; **absorption 10 orbes/s** ; **despawn 5 min**.
- Le **serveur attire et crédite** automatiquement → rester ≤7 blocs suffit, pas d'`autoCollect` à écrire. Event observable : `playerCollect (collector, collected)`.

### Fenêtre enchantement / enclume (API propre, pas de window-click brut)

```js
const table = await bot.openEnchantmentTable(block)
table.on('ready', async () => {
  await table.putLapis(lapisItem)            // Promise<void>
  const item = await table.enchant(choice)   // choice 0|1|2 → Promise<item>
})
table.enchantments       // array des 3 propositions
table.xpseed             // 16 bits (NE permet PAS de prédire l'enchant sans réimplémenter l'algo serveur)
await table.takeTargetItem(); await table.putTargetItem(item)

const anvil = await bot.openAnvil(block)
await anvil.combine(itemOne, itemTwo /*, name */)  // combiner / renommer
```

### Boucle de kill (mineflayer-pvp)

```js
bot.loadPlugin(require('mineflayer-pvp').plugin)        // plugin SÉPARÉ, non documenté dans api.md
const mob = bot.nearestEntity(e => e.kind === 'Hostile Mobs')
bot.pvp.attack(mob)        // bot.pvp.stop() pour arrêter
// bas-niveau : bot.attack(entity, swing=true)
```

### Exemples open-source & limites connues

- **Open-source** : `mineflayer-pvp` (PrismarineJS) pour le combat ; **EnchantmentCracker / Clientcommands** (Earthcomputer) comme référence d'algo de seed (à ne PAS porter en prod bot).
- **Limites** :
  - `openEnchantmentTable` peut **timeout** si l'event `ready` n'arrive jamais (mob bloque la table, ou mismatch `minecraft-data` ↔ version serveur) → **wrapper un timeout**.
  - `table.xpseed` **ne suffit pas** à prédire l'enchant côté bot.
  - `mineflayer-pvp` **lag sur cibles rapides** ; **conflit pathfinder ↔ pvp** (les deux pilotent le mouvement) → arbitrer (désactiver pathfinder pendant le combat de spawner, position fixe).
  - `bot.attack` doit tomber dans la **fenêtre 100 ticks** pour créditer l'XP (§A).

---

## F. Boucle autonome "N livres" (0-token, 100 % déterministe)

### Machine à états

```
        ┌──────────────────────────────────────────────┐
        ▼                                                │
[FARM_XP] ──(level >= 30)──> [ENCHANT] ──(ok)──> [COUNT++] ─(count < N)─┘
   ▲   │                         │                   │
   │   └─(health bas)─>[FLEE]     │                   └─(count == N)──> [DONE]
   │        │                     │
   └────────┘ (PV remontent)      └─ slot bas: putLapis + enchant(2)
```

État par état (tout = seuil/condition, **aucun jugement** → **aucun LLM**) :

1. **FARM_XP** : positionnement <16 blocs, `pvp.attack` sur le mob le plus proche, coup fatal du bot (§A), orbes auto-crédités. Surveiller le **cap 6-mobs** (tuer en flux). Garde-fou `health` → **FLEE** → re-engage quand PV remontent.
2. **ENCHANT** : à `level >= 30`, `openEnchantmentTable` → `putLapis` → `enchant(2)` (slot bas). Retombe ~niv 27.
3. **COUNT** : incrémenter le compteur de livres. Re-grind **seulement 27 → 30** (306 XP ≈ 62 kills) entre deux livres, pas 0 → 30.
4. **Boucle** jusqu'à `count == N` → **DONE**.

> **Pour "N livres enchantés quelconques"** : boucle ci-dessus, on garde tous les livres. **Pour "N livres d'un enchant précis"** : soit voie lutrin déterministe (§D-2, pas de table), soit boucle table + tri post-hoc avec re-roll seed via item-poubelle (§D-1) — toujours du `if/else` pur, **pas de LLM**.

### Consommables à pré-stocker pour N livres (DÉTERMINISTE)

**Par livre** enchanté au slot bas : **1 livre vierge + 3 lapis**.

| Ressource | Quantité pour N livres | Détail craft |
|---|---|---|
| **Livres vierges** | **N** | 1 livre = 3 papier + 1 cuir ; 1 canne à sucre = 1 papier |
| **Lapis** | **3 × N** | filon donne 4–9 lapis/bloc (aléatoire), Y≈0 |
| **Bibliothèques** | **15** (one-shot, non consommées) | 15 × (6 planches + 3 livres) = **90 planches + 45 livres** |
| **Nourriture** | buffer survie | réflexes PV (hard-codé) |
| **Armure** | réduit dégâts | ne change pas la boucle |

### Pourquoi 0-token / 100 % déterministe

- **Tout est mesurable/seuil** : distance <16, kill-loop, `level >= 30`, `enchant(2)`, compteur, stop à N. Aucune décision sémantique.
- **L'aléatoire présent n'exige aucune décision** : timing de spawn (10–39.95 s), position des mobs, bonus XP équipement, **enchant reçu** (seed-based). Le bot **réagit** à ces aléas par des conditions, il ne les **juge** pas.
- Si enchant précis requis : `if (résultat != cible) reroll_via_item_poubelle()` — `if/else` pur. → **Aucun appel LLM sur toute la boucle.**
- **Garde-fous hard-codés** : fuir si `health` bas, re-engager quand PV remontent, surveiller le cap 6-mobs, re-grind seulement ~3 niveaux entre enchants, wrapper timeout sur `openEnchantmentTable`.

---

## Sources

- [Experience – Minecraft Wiki](https://minecraft.wiki/w/Experience)
- [Monster Spawner – Minecraft Wiki](https://minecraft.wiki/w/Monster_Spawner)
- [Mob spawning – Minecraft Wiki](https://minecraft.wiki/w/Mob_spawning)
- [Enchanting – Minecraft Wiki](https://minecraft.wiki/w/Enchanting)
- [Enchanting Table – Minecraft Wiki](https://minecraft.wiki/w/Enchanting_Table)
- [Enchanting table mechanics – Minecraft Wiki](https://minecraft.wiki/w/Enchanting_table_mechanics)
- [Enchanting mechanics – Minecraft Wiki (Fandom)](https://minecraft.fandom.com/wiki/Enchanting_mechanics)
- [Librarian – Minecraft Wiki](https://minecraft.wiki/w/Librarian)
- [Trading – Minecraft Wiki](https://minecraft.wiki/w/Trading)
- [Enchanted Book – Minecraft Wiki](https://minecraft.wiki/w/Enchanted_Book)
- [Anvil mechanics – Minecraft Wiki (Fandom)](https://minecraft.fandom.com/wiki/Anvil_mechanics)
- [mineflayer API docs (bot.experience, enchant, anvil) – PrismarineJS, master](https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md)
- [mineflayer-pvp – PrismarineJS](https://github.com/PrismarineJS/mineflayer-pvp)
- [EnchantmentCracker – GitHub (Earthcomputer)](https://github.com/Earthcomputer/EnchantmentCracker)
- [EnchantmentCracker Info wiki](https://github.com/Earthcomputer/EnchantmentCracker/wiki/Info)
