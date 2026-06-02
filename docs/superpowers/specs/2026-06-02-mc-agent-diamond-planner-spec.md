# MC Agent — Spec de planner « zéro → diamant » (Chemin A)

> **But du document** : transformer la stratégie diamant humaine en **connaissance exploitable par le cerveau LLM** du bot (planner), mappée sur les skills mineflayer existants. C'est l'axe **capacité** (le bot sait *quoi* faire), distinct de l'axe **réalisme/motricité** (Chemin B = captures 1b, le bot le fait *comme un humain*).
>
> **Cible** : Minecraft Java Edition **1.21.x** (génération post-1.18 Caves & Cliffs II). Les mécaniques ci-dessous sont **inchangées depuis 1.18** — 1.21 (Tricky Trials) n'a touché ni la distribution du minerai ni le tech-tree.
>
> **Statut** : connaissance vérifiée (sources en bas). Pas encore implémenté. Précède la Phase 3 (planner autonome) de [[🎮 MC Agent]].
>
> **📚 Companions approfondis** (recherche multi-agents 02/06) :
> - `2026-06-02-mc-agent-diamond-netherite-deep-research.md` — version PROFONDE (12 angles) : géométrie branch mining chiffrée, **Deep Dark/Warden**, règles lave déterministes, **chaîne Netherite complète** (obsidienne→portail→ancient debris→bed mining→upgrade), limites mineflayer multi-dimension (portail cassé #709).
> - `2026-06-02-mc-agent-resources-crafting-spec.md` — **TOUTES les ressources** (métaux/gemmes/bois/pierres/Nether/End : où/Y/outil/usages), stations de transformation, l'**architecture « craft anything »** (résolveur récursif sur `minecraft-data`, 0-token, avec pseudo-code), nourriture/faim, brewing.
> - `2026-06-02-mc-agent-xp-enchanting-spec.md` — **farm XP au spawner → N livres enchantés** : mécanique spawner (kill par le bot obligatoire), maths XP/niveaux (~62 kills/livre), table d'enchantement (15 biblio, 3 niveaux+3 lapis), ⚠️ enchant **aléatoire** → **villageois bibliothécaire = seule voie déterministe** pour un enchant précis, API mineflayer (`bot.experience`, `openEnchantmentTable`, `openAnvil`, pvp), boucle autonome 0-token.
> - `2026-06-02-mc-agent-realism-combat-spec.md` — **réalisme/anti-détection + combat avancé (purple-team)** : seuils anti-cheat exacts (Grim reach 3.0 / timer 1.005× / GCD rotation / CPS), signatures des cheats (killaura/Baritone/scaffold/X-ray/autototem), **imitation humaine** (réaction ex-gaussienne, jitter, CPS → clone 1b), **combat** (épée/hache/Mace/arc, crits, bouclier+axe-disable, totem, strafe), navigation/structures, fermes auto, villages/commerce, **API mineflayer + humanisation** (`bot.look` interpolé pas `force=true`). Les **2 fronts** : passer Grim (déterministe) + battre l'œil humain (réinjecter l'imperfection).
>
> Ce document-ci = le socle (graphe de buts + archi planner) ; les companions = chiffres diamant/netherite, craft générique, farm XP/enchant, et **réalisme/combat purple-team**.

---

## 0. Cadrage : ce que « réussir » veut dire

- **Objectif** = `ObtainDiamond` : spawn inventaire vide → tenir ≥1 diamant en inventaire.
- **Pas un absolu** : même la SOTA (Voyager/GITM) n'y arrive pas 100% depuis n'importe quel spawn (lave, creeper, chute, faim). Viser un **taux de succès cible** (ex. 60-70%) et compter les morts comme normales.
- **Contrainte coût (#40)** : le planner LLM ne décide qu'aux **transitions de but**, jamais par tick. Tout ce qui est marqué « déterministe » ci-dessous tourne en **code pur, 0 token**.

---

## 1. Faits vérifiés (à ne PAS approximer dans le bot)

| Fait | Valeur | Conséquence pour le bot |
|---|---|---|
| **Hauteur du monde** | -64 (bedrock) à 319 | repère absolu de profondeur |
| **Diamant — plage de génération** | Y=16 jusqu'à Y=-63, distribution **triangulaire** | inutile de miner au-dessus de Y=16 |
| **Diamant — pic de densité** | **Y=-58 / Y=-59** | niveau de minage idéal en densité pure |
| **Deepslate** | sous Y=0, jusqu'à -64 | quand les murs passent gris→deepslate sombre = on a franchi Y=0, bonne direction |
| **Lave (lacs en grotte)** | remplace l'air entre **Y=-55 et Y=-63** | le niveau diamant EST en zone de lave → cause n°1 de mort |
| **Compromis sûr** | **Y=-53/-54** | juste au-dessus des pires lacs (Y=-54), un peu moins de densité mais bien plus sûr → **recommandé pour un bot** |
| **Pénalité d'exposition à l'air** | la plupart des blobs de diamant sont jetés s'ils touchent l'air | le **branch mining** (pierre pleine) trouve plus fiablement que l'exploration de grottes (parois déjà « vidées ») |
| **Palier pioche — fer** | pioche **pierre+** requise pour que le minerai de fer drop | bloc de progression dur |
| **Palier pioche — diamant** | pioche **fer+** requise pour que le diamant drop | bloc de progression dur — pas de raccourci |

**Décision de design** : viser **Y=-54** par défaut (sécurité > densité ; cohérent avec le tempérament prudent attendu d'un bot qu'on ne veut pas voir mourir en boucle dans la lave et cramer la clé en re-runs).

---

## 2. Le tech-tree comme graphe de buts

Chaque but = `{ précondition, effet, skill, déterministe? }`. Le planner LLM choisit le **prochain but dont la précondition est satisfaite** ; l'exécution est déléguée au skill (code pur).

| # | But | Précondition (observable) | Effet (vérifiable en inventaire/état) | Skill / action | LLM requis ? |
|---|---|---|---|---|---|
| 1 | **Récolter du bois** | aucun (arbre à portée via `findBlock`) | ≥3-4 bûches | `gather {name:"*_log", count:4}` | non (déterministe) |
| 2 | **Planches** | ≥1 bûche | ≥? planches | craft `planks` (1 log→4) | non |
| 3 | **Table de craft** | ≥4 planches | table en inventaire/posée | craft `crafting_table` | non |
| 4 | **Bâtons** | ≥2 planches | ≥4 bâtons | craft `stick` (2 planches→4) | non |
| 5 | **Pioche bois** | ≥3 planches + ≥2 bâtons + table | wooden_pickaxe | craft `wooden_pickaxe` | non |
| 6 | **Cobblestone** | pioche (bois+) équipée + pierre à portée | ≥11 cobblestone (8 four + 3 pioche) | `gather {name:"stone"}` + `equip` | non |
| 7 | **Pioche pierre** | ≥3 cobble + ≥2 bâtons + table | stone_pickaxe | craft `stone_pickaxe` | non |
| 8 | **Four** | ≥8 cobblestone + table | furnace | craft `furnace` | non |
| 9 | **Charbon** (combustible/torches) | pioche pierre+ ; charbon trouvé OU bûches→charbon de bois | ≥qq charbon | `gather {name:"coal_ore"}` *ou* smelt logs | **observation** (charbon présent ?) |
| 10 | **Minerai de fer** | pioche **pierre+** + minerai fer repéré | ≥3 raw_iron | `gather {name:"iron_ore"/"deepslate_iron_ore"}` | **observation** (où est le fer ?) |
| 11 | **Lingots de fer** | four + raw_iron + combustible | ≥3 iron_ingot | smelt (action four) | non |
| 12 | **Pioche fer** | ≥3 lingots + ≥2 bâtons + table | iron_pickaxe | craft `iron_pickaxe` | non |
| 13 | **Torches** | charbon + bâtons | ≥16 torches | craft `torch` (1 charbon+1 bâton→4) | non |
| 14 | **Descendre au niveau diamant** | pioche fer + (idéalement torches + nourriture) | Y ≈ -54 atteint | `mineDown` (garde-fou lave/vide) puis tunnel | **observation continue** (lave/vide) |
| 15 | **Miner le diamant** | pioche fer équipée + Y≈-54 | ≥1 diamant | branch mining + `gather {name:"deepslate_diamond_ore"}` | **observation** (visu/lave) |

**Boucles transversales (interrompent n'importe quel but, 0 LLM — voir `reflexes.js`)** :
- faim basse → manger
- PV bas / hostile proche → fuir ou défendre
- outil cassé imminent → recraft si matériaux dispo

---

## 3. Phase de minage diamant (le cœur du risque)

### Descente
1. **Ne jamais creuser droit sous ses pieds** (chute dans grotte/lave). Creuser en **escalier 1×2 diagonal** (le skill `mineDown` doit faire ça, pas un trou vertical).
2. S'arrêter à **Y=-54** (lire `bot.entity.position.y`).
3. Poser une torche tous les ~8 blocs (anti-mob spawn, repère retour).

### Schéma de minage : **branch mining** (recommandé pour un bot)
- Tunnel principal 1×2 à Y=-54.
- Branches latérales 1×2 tous les **3 blocs** (espacement qui ne rate aucune veine ≥1, vu que les veines font plusieurs blocs).
- Avantage bot : **déterministe, couvre la pierre pleine** (où les diamants survivent à la pénalité d'air), pas de pathfinding de grotte hasardeux.
- Inconvénient : plus lent que tomber dans une grotte déjà ouverte.

### Règles anti-lave (NON négociables — encoder en dur, pas via LLM)
| Situation | Règle |
|---|---|
| Bloc devant = `lava` ou `flowing_lava` | **stop**, ne pas miner, contourner ou rebrousser |
| Bloc devant = `air` à Y≤-50 | **sonder** avant d'avancer (grotte = mobs + chute + lave possible) |
| Avant de miner un bloc adjacent à la lave | poser un bloc plein (cobble) pour bloquer le flux |
| Lac de lave repéré | **opportunité** : la pierre autour a une densité diamant supérieure (les veines près de la lave ont survécu au check d'exposition à l'air) → miner *vers* le lac avec prudence, jamais *dans* |
| Toujours garder | un **stack de cobblestone** pour murer la lave / faire un pont |
| Jamais | miner le bloc **sur lequel on se tient** ni celui **juste au-dessus de la tête** sans visu |

---

## 4. Survie transversale (sinon le run meurt avant le diamant)

- **Nourriture** : tuer une vache/cochon/poulet/mouton tôt (`attackNearest` sur passif) → viande crue → cuire au four. **Précondition floue** : ne pas descendre si `food < 14` sans réserve cuite. La faim à 0 = perte de PV (mort en difficile).
- **Combat** : zombies/squelettes/creepers la nuit et en profondeur. Règle : creeper à ≤3 blocs → **reculer**, pas attaquer (explosion). Squelette → s'approcher en zigzag. Réutiliser `bestWeapon` (`tools.js`).
- **Lumière** : la profondeur est noire → torches obligatoires (but #13 avant la descente). Sans lumière = mobs spawn dans les branches déjà creusées.
- **Outils de secours** : descendre avec **2 pioches fer** si possible (une casse à ~250 blocs).

---

## 5. Déterministe vs observation-du-monde (point 6 du brief)

C'est la clé du **budget LLM**. Découpage :

**Purement déterministe → 0 appel LLM (code/skills) :**
- toute la chaîne de craft (buts 2,3,4,5,7,8,11,12,13) : recettes fixes, préconditions = comptage d'inventaire.
- récolte d'un bloc nommé à portée (`gather`).
- règles anti-lave, manger, fuir/défendre (réflexes).
- lecture de Y, descente en escalier, schéma de branch mining (géométrie fixe).

**Nécessite observation/jugement → appel LLM ponctuel (planner) :**
- **Quoi faire ensuite** quand plusieurs buts sont débloqués (choix de priorité).
- **Exploration** : « où trouver du fer/charbon ? » quand aucun n'est à portée → décision de direction/profondeur.
- **Replanification sur échec** : `gather` a renvoyé `not_found` 3× → changer de zone ? creuser ailleurs ?
- **Situations ambiguës** : grotte ouverte rencontrée pendant le branch mining (l'explorer = risque/gain).

**Conséquence d'archi** : le planner LLM est un **superviseur épisodique** appelé aux transitions de but et aux échecs, PAS une boucle par tick. Estimation : **quelques dizaines d'appels par run** (vs milliers pour un Voyager naïf). C'est ce qui rend l'autonomie compatible avec #40.

---

## 6. Bloc de connaissance injectable (system prompt du planner)

> À injecter quand `mode === "autonome"` (nouveau, distinct du mode social actuel). Concis exprès — les détails déterministes vivent dans le code, pas dans le prompt.

```
OBJECTIF: obtenir au moins 1 diamant en partant de zéro.
ORDRE DES BUTS (ne saute pas une précondition):
  bois -> planches -> table -> batons -> pioche_bois -> cobblestone
  -> pioche_pierre -> four -> charbon -> minerai_fer -> lingots_fer
  -> pioche_fer -> torches -> descendre_Y-54 -> branch_mining -> diamant.
PALIERS DURS: minerai de fer exige pioche pierre+ ; diamant exige pioche fer+.
NIVEAU DIAMANT: vise Y=-54 (sûr). Densité max a Y=-59 mais lave entre Y=-55 et -63.
ANTI-LAVE: ne mine jamais un bloc de lave ; sonde l'air a Y<=-50 ; garde du cobble pour murer.
SURVIE: mange si faim<14 avant de descendre ; recule face a un creeper ; torches obligatoires en profondeur.
TU NE DECIDES QUE: le prochain but quand plusieurs sont possibles, la direction d'exploration
  quand une ressource manque, et la replanification quand un skill echoue. Le reste est automatique.
Reponds en JSON: {"goal": <nom du but>, "args": {...}, "reason": <court>}.
```

---

## 7. Mapping sur les skills existants + ce qui manque

**Déjà là** (`mc-agent/skills/`) : `gather` (récolte + auto-défense + meilleur outil par bloc ✅ très réutilisable), `craft`, `equip`, `mineDown` (garde-fou de base), `attackNearest`, `fleeFrom`, `goto`, `eat`, `deposit`. Plus `tools.js` (`bestToolFor`/`bestWeapon`), `tasks.js` (1 tâche longue annulable), `reflexes.js` (manger/fuir).

**À construire pour le run diamant** :
| Manque | Pourquoi | Effort |
|---|---|---|
| **Planner / boucle de buts** | aujourd'hui `brain.js` est réactif (event chat only). Il faut un superviseur épisodique qui poursuit `ObtainDiamond` sans qu'on lui parle. | gros — le cœur de la Phase 3 |
| **Inventaire→préconditions** | fonction pure `canCraft(goal, inv)` / `meetsPrecondition(goal, state)` | petit |
| **`mineDown` escalier + détection lave/vide** | l'actuel a un garde-fou basique, pas la règle « sonder l'air à Y≤-50 » ni l'escalier diagonal | moyen |
| **`branchMine(yTarget, length)`** | géométrie de branch mining déterministe | moyen |
| **`smelt(item, fuel)`** | gérer le four (pas de skill four actuellement) | moyen |
| **Mémoire spatiale minimale** | retrouver le four/coffre posé, marquer les branches faites | moyen |
| **Compteur d'échec→replanif** | `gather not_found ×3 → demander au LLM` | petit |

**Note** : pas de nouvelle dépendance Node nécessaire (mineflayer + pathfinder + collectblock suffisent) → auto-deploy propre (cohérent avec la philosophie #40/#33).

---

## 8. Lien avec le Chemin B (captures 1b)

- **A (ce doc) = le QUOI** : graphe de buts + connaissance, exécuté par le planner.
- **B (1b) = le COMMENT** : une fois qu'un but appelle un skill (ex. miner, marcher), la couche clone façonne le timing/jitter/imperfection pour que ça ressemble à un humain.
- Les deux se branchent au même endroit : le planner choisit le but → le skill s'exécute → la couche réalisme module les micro-actions. **A est prérequis à un run B utile** (inutile de cloner la motricité d'un bot qui ne sait pas où aller).

---

## 9. Architecture du planner — leçons Voyager / Mindcraft / GITM

> Recherche directe ciblée (02/06) sur *comment* les agents LLM autonomes sont construits sur **mineflayer** (= notre stack). Confirme et durcit les choix de §2/§5.

### Le patron Voyager (la référence, même stack mineflayer)

Voyager (NVIDIA) = 3 composants, **sans fine-tuning**, API blackbox :
1. **Curriculum automatique** — propose le prochain objectif pour maximiser l'exploration. *Pour nous : inutile au début — notre objectif est fixe (diamant), donc on remplace le curriculum par le **graphe de buts en dur** de §2.*
2. **Librairie de skills qui grandit** — les comportements réussis sont stockés comme **programmes JS (mineflayer)**, indexés par embedding de leur description, récupérés par similarité sémantique pour les tâches suivantes. *C'est l'item « gros » de notre gap (§7).*
3. **Prompting itératif + auto-vérification** — un **2e LLM joue le critique** : il juge, depuis l'état du bot + la description de tâche, si la tâche a réussi ; sinon il produit une critique réinjectée au tour suivant.

### Leçons de design (issues des papiers sur les échecs — directement actionnables)

| Leçon (vérifiée) | Conséquence pour MC Agent |
|---|---|
| **Les LLM hallucinent le graphe de dépendances** (items inventés dans le tech-tree) et **ne se corrigent PAS** à partir du feedback d'échec — ils répètent la même erreur | ✅ **On a déjà raison** : le tech-tree de §2 est **codé en dur**, le LLM ne le *dérive* jamais. Ne jamais demander au LLM « quelles sont les préconditions du diamant ». |
| **Plus on donne de liberté au LLM, plus il échoue** ; Voyager/GITM contraignent via un **DSL de skills** | ✅ **On a déjà raison** : le LLM ne choisit qu'un **but parmi une liste connue** + direction + replanif (§5). Jamais de génération d'action libre. |
| **Auto-correction par le LLM ≈ inefficace** ; mieux vaut une **correction algorithmique** (XENON) ou un **critique séparé** (Voyager) | À ajouter : (a) un **critique déterministe** (l'état d'inventaire prouve le succès, pas le LLM) ; (b) un compteur d'échec → si un skill rate N fois, **changer de stratégie par règle**, pas en redemandant au même LLM. |
| Taxonomie skills **primitifs vs compositionnels** (Odyssey : 40 primitifs / 183 composés) | Nos skills actuels = primitifs. Le planner compose des **séquences de buts** ; pas besoin de skill-library auto-écrite pour un objectif fixe — on peut **différer** le composant #2 de Voyager et garder une librairie **manuelle**. |

### Recommandation concrète (low-cost, anti-#40)

- **Étudier `mindcraft-bots/mindcraft`** (open-source, mineflayer + LLM, le bot « Andy » se fixe des buts et joue seul) → c'est le **plus proche de notre cas** et la meilleure base à cribler (patterns de boucle, gestion d'état, prompt). À lire AVANT de coder la Phase 3.
- **Ne PAS reprendre la skill-library auto-écrite de Voyager au départ** : pour un objectif unique (diamant), une **librairie de skills manuelle** (nos `skills/*.js`) + le graphe de buts en dur suffit, et coûte 0 token de génération de code. La skill-library auto-écrite ne se justifie que pour l'open-ended (Phase 4+).
- **Critique = déterministe d'abord** : 90% des « le but a-t-il réussi ? » se répondent en lisant l'inventaire/position (0 token). N'invoquer un critique LLM que pour les cas vraiment ambigus.

### Réfs

- [Voyager — site](https://voyager.minedojo.org/) · [arXiv 2305.16291](https://arxiv.org/abs/2305.16291) · [repo MineDojo/Voyager](https://github.com/MineDojo/Voyager) (3 composants, skill library JS mineflayer, critique LLM)
- [mindcraft-bots/mindcraft](https://github.com/mindcraft-bots/mindcraft) (mineflayer + LLM autonome, base à cribler)
- [zju-vipa/Odyssey](https://github.com/zju-vipa/Odyssey) (taxonomie skills primitifs/compositionnels)
- [GITM — Ghost in the Minecraft (OpenReview)](https://openreview.net/pdf?id=cTOL99p5HL) · [Where LLM agents fail (arXiv 2509.25370)](https://arxiv.org/pdf/2509.25370) · [Experience-based Knowledge Correction / XENON (arXiv 2505.24157)](https://arxiv.org/html/2505.24157v2) (modes d'échec + correction algorithmique vs auto-correction LLM)

---

## Sources

- [Diamond Ore — Minecraft Wiki](https://minecraft.wiki/w/Diamond_Ore) (distribution triangulaire Y=16→-63, pic Y=-58/-59, pioche fer+ requise)
- [Pickaxe / Tiers — Minecraft Wiki](https://minecraft.wiki/w/Pickaxe) (paliers : pierre→fer-ore, fer→diamant)
- [How to Find Diamonds (2026) — gamingpromax](https://gamingpromax.com/how-to-find-diamonds-in-minecraft/) (Y-53 à -59, Y-59 densité max)
- [Lava Generation Levels — GGServers](https://ggservers.com/knowledgebase/article/lava-generation-levels-in-the-overworld/) + [Lava — Minecraft Wiki](https://minecraft.wiki/w/Lava) (lave remplace l'air Y=-55→-63 ; veines diamant + denses près des lacs)
- [Minecraft Diamond Level 1.21 — Godlike](https://godlike.host/minecraft-diamond-level-1-21-guide-blog/) (confirmation 1.21, niveaux de minage)
