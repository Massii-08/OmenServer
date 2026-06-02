# MC Agent — Recherche approfondie « zéro → diamant → Netherite » (companion de la spec planner)

> **Provenance** : recherche multi-agents (12 angles parallèles + synthèse), 02/06/2026, MC Java 1.21.x.
> Chiffres vérifiés sur Minecraft Wiki + sources à jour (liste consolidée en bas).
> **Companion de** `2026-06-02-mc-agent-diamond-planner-spec.md` (le graphe de buts de base + l'archi du planner §9).
> Ce document = la version PROFONDE : raffinements minage, hazards à coder en dur, **chaîne Netherite complète**, notes d'ingénierie mineflayer, et découpage déterministe vs observation.

---

> Synthèse d'ingénierie destinée à un planner LLM pilotant un bot mineflayer. Tous les chiffres (niveaux Y, recettes, quantités, ranges) sont exacts pour Java Edition 1.21.x (post-Caves & Cliffs II).

---

## A. Raffinements minage diamant (géométrie chiffrée, cave vs mining, fer/charbon)

### A.1 — Distribution du diamant (4 batches indépendants, triangle pic Y=-59, range Y=16 → -64)

Le diamant (deepslate diamond ore sous Y=0) génère sur une **distribution triangulaire, range Y=16 → -64**. Densité **maximale Y=-59** (Y=-58 quasi équivalent), ~7-8× plus de minerai/chunk qu'à Y=0. Quatre passes, dont la **règle d'air-exposition** est l'élément décisif pour le planner :

| Batch | Fréquence | Veine | Skip si adjacent à l'air |
|---|---|---|---|
| 1 (small/buried) | 7 blobs/chunk | 1–5 | **50 %** |
| 2 (large) | 1 blob / 9 chunks | 1–23 | **70 %** |
| 3 | 4 blobs/chunk | 1–10 | **100 %** (jamais exposé) |
| 4 | 2 blobs/chunk (Y -4→-63) | 1–10 | **50 %** |

**Conséquence centrale : miner la roche pleine bat l'exploration de grottes.** Le batch 3 (~4 blobs/chunk, la sous-population la plus riche) ne génère **jamais** au contact de l'air ; les batches 1/2/4 sont supprimés 50-70 % du temps quand exposés. Une grotte échantillonne donc une population systématiquement appauvrie — les veines les plus denses ne sont atteignables qu'en cassant du bloc plein.

### A.2 — Arbitrage Y : densité brute vs sécurité lave

- **Y=-59** : densité maximale, mais **traverse la nappe de lave** (cf. §B.2 : toute cavité ouverte sous Y=-54 est de la lave).
- **Y=-54 / -53** : sur la pente montante du triangle (~80-85 % du pic) mais **juste au-dessus du plancher de lave (Y=-54)** → tunnels non interrompus.
- **Règle planner : Y=-53/-54 par défaut** (robustesse) ; **Y=-59 uniquement si Fire Resistance active** (cf. §B.2 règle 1).

### A.3 — Géométrie optimale du branch mining

- **Forme tunnel : 1 large × 2 haut (1×2)**, pas 2×1. Révèle 4 parois + sol + plafond (4 faces de roche par bloc avancé) pour le coût de 2 blocs cassés ; un 2×1 révèle moins de volume utile au même coût.
- **Espacement des branches (paramétrable) :**
  - `gap=2` (2 blocs pleins entre tunnels) → expose ~100 % de toute veine (yield-max, effort-max).
  - **`gap=3` = sweet spot** : ~98 % d'exhaustivité en **doublant** le rendement (les blobs ≥2×2×2 n'ont pas besoin que chaque bloc soit révélé). **Offset de 4 entre axes** de tunnels.
  - `gap=6` → efficacité-max (~1,7 % des blocs minés sont diamant, ~3-5 minerais/100 blocs) mais rate les petits blobs.
  - Heuristique de choix : `gap=2` si Fortune III + durabilité abondante ; `gap=6` si outil/temps contraints.
- **Longueur de branche : 30–50 blocs.** Corridor central à Y cible, branches 1×2 alternées des deux côtés.
- **Descente : escalier diagonal** (2 blocs/palier, descente sûre, remontée à pied, jamais de chute libre/lave) — **pas de trou vertical** (états de chute ingérables pour le bot).

### A.4 — Efficacité comparée & rendement attendu

| Méthode | Rendement |
|---|---|
| Branch mining (gap 2-3, 1×2, Y -54/-59) | **3-5 minerais / 100 blocs** ; ~60-80 diamants/h |
| Strip mining (corridors larges) | ~**3× plus de roche** pour le même yield |
| Tunnel gap=1 (exhaustif) | le plus lent, temps gaspillé sur veines déjà vues |
| Cave exploration | rapide early-game, **mais -50 à -70 % de veines** vs contenu réel du chunk |

- **State `dig_diamond` / flood-fill** : à la détection d'un `diamond_ore`/`deepslate_diamond_ore`, **flood-fill le blob adjacent** (0–23 voisins) avant de reprendre le pattern.
- **Heuristique d'arrêt** : ~1000 blocs/cycle → statistiquement ~30-50 minerais → **~70-110 diamants** avec Fortune III (≈2,2/minerai). Deepslate hardness rend Efficiency décisif (Eff IV : ~1,65s → 0,3s/bloc).
- **Mode `cave` = fallback** (grand volume d'air détecté, ou pas de Fortune) : `findBlock('diamond_ore', radius)` sur parois exposées, mais **ne jamais traiter une paroi vide comme « chunk épuisé »** (50-70 % manquants) ; **ne jamais récompenser la proximité de grotte** comme signal de richesse.

### A.5 — Fer & Charbon (prérequis : la pioche diamant exige fer d'abord)

**Fer — 3 batches, deux pics de densité (Y=16 souterrain, Y=232 montagnes exposées) :**

| Batch | Range Y | Forme | Tries/chunk | Blob |
|---|---|---|---|---|
| 1 (mountain) | 80→384 | triangle **pic Y=232** | 90 | 0–13 |
| 2 (mid) | −24→56 | triangle **pic Y=16** | 10 | 0–13 |
| 3 (deep) | −64→72 | uniforme | 10 | 0–5 |

- Creux de densité Y 40–80. Grosses **ore veins** (fer + raw iron blocks + tuff) en deepslate = waypoints haute valeur.
- Minage sans Silk Touch → **raw_iron** (Fortune : none=1, F-I 1–2, F-II 1–3, F-III 1–4), à **fondre → 1 lingot/unité**. 9 raw iron → raw iron block.

**Charbon — 2 batches, meilleur Y≈96 :**

| Batch | Range Y | Forme | Tries/chunk | Blob |
|---|---|---|---|---|
| 1 | 136→320 | uniforme | 30 | 0–37 |
| 2 | 0→192 | triangle **pic Y=96** | 20 | 0–37 (batch bas : 50 % skip air-exposition) |

Charbon = 1/minerai (Fortune 1–4), **fuel direct** (pas de fonte).

**Économie de fuel (1 item = 200 ticks = 10 s, donc 8 items fondus) :**

| Fuel | Items fondus | Note |
|---|---|---|
| Lava bucket | **100** | nécessite seau (fer) |
| Coal block | **80** | 9 charbon compressés (vs 72 en vrac → +11 %) |
| Dried kelp block | 20 | renouvelable, pas de minage |
| Blaze rod | 12 | Nether-only (+50 % vs charbon) |
| Charbon / Charcoal | **8** | charcoal == charbon ; 1 log→1 charcoal (×8 vs log brut) |
| Oak log (direct) | 1,5 | gaspillage |

- **Budget fer surface→diamant : viser 8–12 raw iron** = 1 pioche fer (3 lingots, mine diamant/obsidienne) + 1 seau (3 lingots) + buffer (shield 2, flint&steel 1, spare). Un seul affleurement de montagne ou une veine suffit.
- **Heuristique planner fer (two-target Y) :** biome ∈ {peaks, windswept, jagged, snowy_slopes, badlands} → **scan surface** (fer exposé, batch Y=232, zéro minage) ; sinon **branch-mine Y=15→16**.
- **Fuel solver** : pour fondre *N* items → lava bucket si seau+lave déjà possédés (gratuit, 100), sinon `ceil(N/8)` charbon/charcoal ; compacter en coal block seulement si N≥80 et inventaire saturé. **Jamais brûler de logs bruts → convertir en charcoal d'abord (×8).**
- **Stop fer** : miner jusqu'à ≥10 raw iron, fondre 3 → pioche, réserver le reste.

---

## B. Hazards à encoder en dur

### B.1 — Deep Dark / Warden : règles d'évitement (non combattable, fuite obligatoire)

**Génération (Y exacts) :** le Deep Dark génère dans la couche deepslate (Y=0 → -64), sous zones à faible érosion (sous Jagged/Stony/Frozen Peaks, Snowy Slopes, Grove) ; **jamais** sous Ocean/River/Swamp/Desert. **Ancient City : sol TOUJOURS à Y=-51** (constante dure), empreinte ~220×220. Le biome est **anormalement vide** (pas de spawn de mobs régulier) → le vide est un signal.

**Le couloir critique de minage diamant Y=-52/-54 est en plein Deep Dark potentiel.**

**Warden — non tuable par un bot :** 500 HP (250 cœurs), knockback resist 100 %, **mêlée Normal 30 / Hard 45 HP → one-shot** sur full-netherite non-Resistance ; **sonic boom** (Normal 10 / Hard 15 HP) **traverse les blocs, ignore armure/bouclier/enchantements** (portée 14 horiz./20 vert.). **Invulnérable jusqu'à émersion complète.** Réduction possible uniquement par wolf armor / witch magic resistance / effet Resistance. **Unique stratégie viable : NE JAMAIS le spawn / fuir.**

**Mécanique de spawn :** warning level **par joueur** ; spawn quand il atteint **4** (= 4 activations de sculk shriekers **naturels** ; player-placed ne comptent pas). Décroissance −1 / **10 min**. Spawn ~4,5 s après le seuil. Détection Warden actif : `Darkness` (13 s, réémis toutes les 6 s, rayon 20) + vibrations (rayon 15, cd 2 s) + odorat (cylindre 6 horiz./20 vert.). Despawn après 60 s sans stimulus.

**Règles à coder en dur :**
1. **Hard floor : interdire toute mine à Y ≤ -40 sans détection sculk active.**
2. **Scan voisinage bloc-based (gratuit, prioritaire)** : `sculk`, `sculk_vein`, `sculk_sensor`, `sculk_shrieker`, `sculk_catalyst`. **N'importe lequel = Deep Dark confirmé → STOP + retraite immédiate** sur l'axe d'arrivée.
3. **Sneak permanent dès qu'un sculk est vu** (supprime les vibrations de déplacement). **Ne JAMAIS casser/marcher sur un `sculk_shrieker`** ni faire vibrer un `sculk_sensor`.
4. **Garde-fou warning level** : compter les shriekers activés ; **à ≥2 → abandon de zone** (marge avant le seuil de 4).
5. **Effet `Darkness` reçu** → shrieker déclenché/Warden actif <40 blocs → **fuite d'urgence** vers safe-point >40 blocs, remonter en Y.
6. **Entité `minecraft:warden` détectée** → abandon total : fuir >60 s hors de portée (>20 blocs + casser ligne d'odeur verticale), rester sneak, zéro action générant des vibrations. **Jamais de combat.**

### B.2 — Lave : règles déterministes « ne jamais mourir » (Overworld deepslate, Y -50 à -59)

**Chiffres :** contact = **4 HP/tick** plafonné à toutes les 0,5 s (≈8 HP/s) ; entrer fixe `remainingFireTicks=300` → **brûle 15 s** après sortie. **Survie nue : 2,5 s ; armure diamant complète : 10,5 s** → sans Fire Res, mort en <3 s, **aucune marge** : prioriser le pré-check, pas la récupération.

**Génération :** depuis 1.18.2, **toute l'air sous Y=-54 est convertie en lave** (« lava sea »). Donc **à Y=-55 et en dessous, toute cavité ouverte = lave.** Aquifères sous Y=0 parfois en lave → poches isolées possibles dès Y=-50. **Traiter tout espace vide rencontré sous Y=-54 comme lave jusqu'à preuve du contraire.**

**Eau ↔ lave :** eau sur **source de lave → obsidienne** ; eau sur **lave courante → cobblestone** (distinction critique) ; lave coule 3 blocs horiz. à 1 bloc/30 ticks (1,5 s) → un seau d'eau a le temps d'agir.

**Fire Resistance (id 12) :** immunité **totale** (lave, feu, magma block, blaze fireball, fire charge, Flame/Fire Aspect). **Java : ne prévient PAS la mise en feu visuelle mais annule tous les dégâts.** **Ne protège NI noyade NI suffocation.** Potion : **3:00 (180 s)** / étendue **8:00 (480 s)**.

**Règles à coder en dur :**
1. **Y de creusage par défaut = -53** sans Fire Res ; **-59 uniquement si potion active**.
2. **Ne JAMAIS miner un bloc dont une face touche un voisin `lava`** (source ou flowing) sans avoir posé un bloc plein dessus. **Scanner les 6 voisins du bloc cible + les 6 du bloc d'arrivée du pas suivant.**
3. **Interdire le minage du bloc directement sous les pieds** (anti-chute) sauf si N-2 est solide et non-lave.
4. **Invariant seau d'eau** : garder ≥1 seau d'eau ; **refuser de descendre sous Y=-50 sinon**. Si lave courante ≤3 blocs ou `inLava` → poser eau (source → obsidienne) puis sortir par le haut.
5. **Bridging** (pose de bloc) sur toute lave avant traversée (moins fiable que l'eau, consomme du stock).
6. **`inLava` = état d'urgence absolu** : annuler la tâche, jump + nager vers le solide le plus proche en remontant. (Sans Fire Res → probablement déjà mort.)
7. **Fire Res ≠ blanc-seing** : ne pas s'enfoncer profond (risque suffocation sous plafond) ; **tracker le timer 180/480 s, re-boire avant échéance**.
8. **Après sortie de lave** : brûle 15 s → s'éloigner ; si eau dispo, se tremper (éteint le feu instantanément).

### B.3 — Nether : hazards & règles (voir §C/§D pour le voyage)

Lave = tueur dominant (nappe culmine ~Y31). Mobs et règles d'aggro piglin → traités en §C.5 (équipement) et §D ; règles déterministes de minage Nether en §C.4. **Synthèse hazard pure :** appliquer les mêmes règles lave que §B.2 (probe 6 voisins, jamais straight-down, Fire Res active) + **aucune eau** (s'évapore en Nether → bridging avec blocs **non-flammables** uniquement : cobblestone/blackstone/netherrack, jamais bois/laine).

---

## C. Extension du graphe de buts vers la Netherite

> Chaîne complète avec préconditions, quantités exactes et palier de pioche à chaque étape.

### C.0 — Palier de pioche par étape (gate dur)

| Étape | Pioche minimale | Raison |
|---|---|---|
| Miner diamant | **fer** | diamond ore exige fer+ |
| Miner obsidienne | **diamant ou netherite** | tout palier inférieur mine mais **drop 0** |
| Miner ancient debris | **diamant ou netherite** | hardness 30 ; palier inférieur → **drop 0** |

`assert pickaxe.tier ∈ {diamond, netherite}` avant tout `mine` sur obsidienne **ou** ancient debris — sinon 0 item = **échec planner, pas retry**.

### C.1 — Diamant → équipement & enchantement (gate avant Nether)

**Coûts diamant (sticks gratuits) :** pioche **3** (obligatoire, seul outil pour obsidienne/debris/or/redstone), épée **2**, casque **5**, plastron **8** (meilleur ratio protection/diamant), jambières **7**, bottes **4**, **armure complète 24**. **Bouclier = 0 diamant** (6 planches + 1 fer) → énorme valeur Nether. **Table d'enchantement = 4 obsidienne + 2 diamant + 1 livre** (brûle 2 diamants).

**Enchantement (table) :** **15 bibliothèques** (chacune 6 planches + 3 livres), placées **exactement à 2 blocs latéraux** de la table, même niveau ou +1, bloc d'air entre → débloque le slot niveau 30 (moins = cap sous 30). Slots 1/2/3 chargent 1/2/3 niveaux + 1/2/3 lapis (toujours enchanter depuis le slot bas niveau-30). Un roll lvl-30 **ne garantit pas le tier max** (Eff III / Fortune II possibles). **Max levels :** Efficiency **V**, Fortune **III**, Unbreaking **III**, Protection **IV**, Mending **I**. Fortune III ≈ **2,2× diamants/minerai** (mais **ne s'applique PAS à l'ancient debris** — toujours 1 — et conflit Silk Touch). **Mending = treasure-only** (trades libraire / loot / pêche), jamais à la table.

**Priorité avant Nether :** (1) **pioche** Efficiency + Unbreaking (accélère le dig debris) ; (2) Fortune III sur une pioche **séparée** si on veut multiplier le diamant avant d'engager les outils ; (3) **armure (plastron) Protection** + **Fire Protection IV** (meilleur enchant Nether) ; (4) épée = priorité basse (pierre/fer + bouclier suffit early Nether).

**Préconditions / budget :**
- **Budget viable minimal : ~10-12 diamants** (pioche 3 + table 2 + plastron 8). **Planifier ~15-20** pour enchanter confortablement (lapis + itérations) + pioche de secours.
- **XP loop :** lvl-30 ≈ 1,5k XP → scheduler une session mob-grind/minage avant les rolls. Mending = objectif **trade/loot**, brancher le planner séparément.
- **Gate Nether dur :** ne pas entrer tant que **(a) ≥1 pioche enchantée** ET **(b) ≥1 pièce plastron Protection**. Fire Protection / bouclier = soft-required.
- **Enchanter AVANT d'upgrader** : les enchants se conservent gratuitement diamant→netherite (cf. C.7).

### C.2 — Diamant → obsidienne (2 chemins, brancher sur inventaire)

- **Si pioche diamant/netherite** → miner l'obsidienne naturelle (bords de lacs de lave, Y profond). Temps : **9,4 s/bloc** (diamant) / 8,35 s (netherite) ; Eff V diamant ≈4,7 s. Budget **≥10 blocs**.
- **Si PAS de pioche diamant (chemin cast, canonique)** → **obsidienne sans pioche** : poser **lave SOURCE** dans les cellules du cadre, puis verser de l'eau dessus. **Lave source + eau = obsidienne** ; **lave courante + eau = cobblestone** (toute la subtilité). Inputs : ≥10 lava buckets (consommable contraignant) + ≥1 water bucket (réutilisable). **Build/wash une couche à la fois**, lave contenue pour rester source.
- **Hazard suffocation** : l'obsidienne fraîchement formée peut suffoquer → garder le bot ≥1 bloc dégagé de la cellule en cours.

### C.3 — Portail Nether (cadre + allumage)

- Ouverture intérieure : **min 4 large × 5 haut** (max 23×23). « 4×5 » = le trou, pas le compte d'obsidienne.
- **Compte obsidienne : 10 minimum** (4 coins omis — non requis pour activer) ; **14 avec coins** (ce que font les portails générés). Émettre le **ring 10 cellules** par défaut.
- **Allumage : flint and steel** (1 flint + 1 fer → ~64 usages) sur la **face intérieure du bas**. Le cadre doit être **complet AVANT** le feu. Aussi valide : fire charge / fireball / foudre / propagation.

### C.4 — Nether → ancient debris (Y de pic, minage)

**Génération (2 clusters/chunk) :**
- **Cluster 1 (triangle) :** 0–3 debris, **Y 8 → 24** (pic ~Y16).
- **Cluster 2 (uniforme) :** 0–2 debris, **Y 8 → 119** (fond plat).
- Densité **max ~Y=16** ; **Y de minage optimal = 15** (un cran sous le pic, au-dessus de la nappe de lave Y≈31 et des lacs). Certains font Y=11-12 pour plus de marge.
- **Densité : ~1,65 debris/chunk** ; max normal 5/chunk (11 théorique sur bordures partagées) ; **~0,004 %** des blocs. **Substantiellement plus rare que le diamant.** Veine ≤3 blocs.
- **Règles génération :** remplace uniquement netherrack/basalt/blackstone ; **jamais exposé à l'air** (exception : visible **sous la lave**). Hardness 30, blast resistance **1 200**. Break : 5,65 s (diamant) / 5,0 s (netherite).

**Conséquence : `findBlock('ancient_debris')` ne renverra quasi rien (jamais exposé) → le bot DOIT creuser pour révéler.**

**Règles à coder en dur :**
1. **Y-lock = 15** (jamais sous Y=8) ; **abort-down si lave ≤2 blocs sous** le sol de tunnel.
2. **Strip mining** : tunnels 1×2 parallèles, **gap 2-3** (veines ≤3). ~12 blocs/s avec Efficiency II+ (netherrack instant-mine en sprintant).
3. **Anti-lava** (cf. §B.2/B.3) : probe 6 voisins, jamais frontal sans sonder, **jamais straight-down** (pose un bloc sous les pieds par pas), **Fire Resistance active**.
4. **Cas spécial pickup** : debris visible sous lave → l'item **flotte sur la lave et est fire/lava-immune** → ramassable sans perte.

### C.5 — Bed mining (méthode efficace, blast-revealing)

**Pourquoi :** explosion (power 5, = creeper ; TNT=4) détruit netherrack/basalt/blackstone/nether gold ore mais **laisse l'ancient debris intact** (blast res 1200). Expose une sphère ~9×9×9 par détonation → beaucoup plus de m³ inspectés/action que le pic (qui ne voit que ce qu'il touche). **Beds > TNT** : explosent en Nether/End, moins chers (**3 laine + 3 planches** vs gunpowder mob-gated). Trade-off = consommables + létalité, pas vitesse de dig.

**Procédure canonique :**
1. Tunnel principal 1×2 à **Y=15**.
2. Tous les **16 blocs**, branche perpendiculaire **1×1×5** (hauteur des yeux).
3. Bed **au bout** de la branche de 5.
4. Reculer **≥6 blocs** **avec un bloc plein entre soi et le bed** (dégâts occlusion-checked → le mur absorbe). Le tunnel de 5 + 1 bloc de recul = la distance sûre de 6.
5. Clic-droit → explosion → ramasser debris (+ pépites d'or des nether gold ore).

**Yield/blast : jusqu'à 3 debris, souvent 0-1.**

**Règles à coder en dur :**
- **State machine :** `dig_main → branch(5) → place_bed → retreat(≥6, place_block) → detonate → scan_exposed → collect → stride(16)`.
- **Invariant anti-suicide :** **JAMAIS clic-droit bed en dimension ∈ {nether, end}** sans `dist(bot, bed) ≥ 6` **ET** bloc occlusif en ligne de vue → traiter comme action destructive gated. Auto-détonation <6 blocs ou en ligne de vue = létal **même en netherite**.
- **Lava pockets derrière le mur** : l'explosion peut les ouvrir → chain-kill. Porter Fire Res + Blast Protection + **Totem of Undying** (recommandé wiki).
- Re-scan la sphère ouverte pour `minecraft:ancient_debris` avant de reprendre le stride.

**Équipement Nether (contrat inventaire planner) :**
- Armure diamant/netherite **Protection IV** + **≥1 pièce d'or équipée** (piglins adultes neutres).
- **Potions Fire Resistance** multiples (~8 min) — **obligatoire**.
- Pioche diamant/netherite Eff II+ / Unbreaking III / Mending.
- ≥2 stacks blocs **non-flammables** (bridging/walling), food haute-saturation (cooked meat / golden carrots), **pas d'eau** (s'évapore).
- Optionnel : Totem, soul torches (repoussent piglins).

**Aggro piglin (critique) :** **1 seule pièce d'or → piglins adultes neutres** (item le plus à effet de levier). Même neutres, aggro sur : miner nether gold ore / gilded blackstone / gold block (**16 blocs, sans ligne de vue**), ouvrir/casser conteneur (~15 blocs avec LoS), être attaqué (16 blocs). Piglin 16 HP (mêlée Hard 13,5) ; **piglin brute toujours hostile** (Hard 19) ; magma cube (Hard 19, se divise) ; hoglins (repoussés par warped fungus) ; ghasts (fireball déviable). **Maintenir ≥1 pièce d'or équipée en permanence** ; **scanner piglins ≤16 blocs avant** de miner de l'or / ouvrir un conteneur.

### C.6 — Ancient debris → netherite scrap → lingot

- **1 ancient debris → 1 netherite scrap** (four ou blast furnace 2× plus rapide, même yield ; +2 XP au ramassage).
- **Recette lingot (shapeless, placement libre) : 4 netherite scrap + 4 gold ingots → 1 netherite ingot.**
- Donc **1 lingot = 4 ancient debris + 4 gold ingots**.

### C.7 — Upgrade diamant → netherite (smithing table, 3 slots)

- **Précondition dure : Netherite Upgrade Template** (requis depuis 1.20, sinon la table refuse). **Source : Bastion Remnant — treasure chest 100 % (×1, garanti)** ; bridge/hoglin-stable/generic chests 10 %. **Modéliser le template comme ressource renouvelable non-consommable** : il est **consommé à chaque upgrade**, mais **duplicable** : **1 template + 7 diamants + 1 netherrack → 2 templates** (net +1) → dupliquer, ne pas hoarder.
- **Recette : 1 template + 1 objet diamant + 1 netherite ingot → objet netherite.** Marche sur les 9 types. **Conserve enchantements, durabilité actuelle et prior-work penalty.**

**Gains stat (diamant → netherite) :**

| Item | Diamant | Netherite |
|---|---|---|
| Durabilité pioche | 1561 | **2031 (+30 %)** |
| Tier de minage | 8 | **9** |
| Attaque outil/arme | +0 | **+1** (épée 7→8, pioche 5→6) |
| Toughness armure | +2/pièce (8) | **+3/pièce (12)** |
| Knockback resist | 0 | **+1/pièce** (attr 0,1 ; **set complet 0,4 = 40 %**) |
| Défense (pts) | 20 (full) | 20 (inchangé) |

Objets netherite (portés ou droppés) = **fire/lava-immune, flottent sur la lave**.

**Arithmétique de coût :**
- **Par objet upgradé : 4 debris + 4 gold + 1 template-use.**
- **Kit complet (9 objets) : 9 lingots = 36 ancient debris + 36 gold + 9 template-applications** → scanner **~22 chunks** à 1,65 debris/chunk.
- **Ordering planner :** enchanter le diamant d'abord → upgrader ensuite (préserve les enchants, économise l'XP). Prioriser le **bastion treasure chest** comme nœud d'acquisition du template, puis frapper des copies à l'infini.

---

## D. Notes d'ingénierie agent (mineflayer / frameworks LLM)

### D.1 — Aucun framework n'a de skill natif « aller au Nether / revenir » (lacune documentée)

- **Voyager** (MineDojo) : skill-library de **code JS exécutable** indexé par embedding ; récupère top-5 skills/tâche, compose. Métriques : **3,3× items uniques, 2,3× distance, milestones tech-tree jusqu'à 15,3× plus vite** que le SOTA — mais plafonne en pratique **avant la maîtrise inter-dimension**. Le Nether n'apparaît que comme cible de construction creative.
- **Mindcraft** (`mindcraft-bots/mindcraft`) : commandes paramétrées (`!collectBlocks(...)`). Fonctions exportées dans `skills.js` : `placeBlock(bot, blockType, x, y, z, placeOn)`, `goToPosition`, `equip`, `activateNearestBlock`, `collectBlock` (**gère les liquides via seau**, mais pas d'utilitaire seau dédié), `attackNearest`, `defendSelf(bot, range=9)`, `useDoor`. **Gap explicite : aucune fonction portail/dimension.**

### D.2 — Capacités/limites mineflayer concrètes

| Tâche | API exacte | Limite |
|---|---|---|
| Détecter changement de dimension | event **`forcedMove`** + `bot.game.dimension` ∈ `overworld`\|`the_nether`\|`the_end` | **LE signal de transition à écouter.** Fiable. |
| Équiper seau/briquet | `bot.equip(item, dest)` (`hand`/`head`/`torso`/`legs`/`feet`/`off-hand`) | OK |
| Poser obsidienne | `bot.placeBlock(referenceBlock, faceVector)` (ex. `new Vec3(0,1,0)`) | OK, positionnement manuel bloc-par-bloc |
| Allumer portail | `bot.activateBlock(block)` ou `bot.activateItem(offHand)` | OK |
| Verser eau/lave (seau) | `bot.activateItem()` (clic-droit) | **DIY, pas de helper liquide** |
| Combat | `bot.attack(entity)` ; plugin **`mineflayer-pvp`** (`bot.pvp.attack`) | OK, marche en Nether |
| **Traverser le portail** | — | **CASSÉ** (issue #709 ouverte) : le pathfinder traite le bloc-portail comme **solide** → `goto` « no path » ; `setControlState('forward')` fonce dans le portail comme un mur. |
| Pathfinding longue distance | `mineflayer-pathfinder` | **Crash si destination en chunks non chargés** ; en Nether ajouter `netherrack` aux `Movements.scaffoldingBlocks`. |

### D.3 — Implications planner/bot

1. **Traversée de portail = routine déterministe hard-codée, PAS un skill LLM :** amener le bot au ras du portail via pathfinder, **bypasser le pathfinder** → `setControlState('forward', true)` + `lookAt` vers le centre du portail, **attendre l'event `forcedMove`** comme condition de succès (poll `bot.game.dimension`). Seul pattern qui marche vu #709.
2. **Objectif = machine à états multi-dim** `{overworld → build_portal → cross → nether_task → cross_back → overworld}` : le planner ne pathfind **jamais** entre dimensions — il enchaîne des sous-buts intra-dimension + 1 action de transition.
3. **Construire/allumer le portail = séquence scriptée** (10 obsidiennes, `placeBlock` × N puis `activateItem`) — ne pas laisser le LLM improviser le placement.
4. **Pathfinder Nether** : caper le rayon `goto` (terrain vertical, lave), autoriser `netherrack` en scaffolding (sinon crash chunks). Réutiliser `mineflayer-pvp` + `defendSelf` pour ghasts/piglins.
5. **Plugins réutilisables (pas de plugin « nether portal » publié → glue à écrire soi-même) :** composer depuis `mindcraft/skills.js` (place/equip/activate/collect/combat) + **`mineflayer-pvp`** + **`mineflayer-collectblock`**.

---

## E. Décisions déterministes (0-token) vs observation-du-monde (appel planner)

> Principe directeur : tout ce qui touche à **« ne jamais mourir »** et aux **constantes de jeu** est code pur 0-token (réflexes + tables). Le LLM n'est appelé que pour l'**arbitrage stratégique sur un état du monde ambigu**.

### E.1 — Code pur, 0-token (réflexes, gates, tables figées)

- **Réflexes de survie (priorité absolue, jamais de LLM) :** détection `inLava` → eau/remontée ; probe 6 voisins avant tout `mine` (lave) ; jamais straight-down ; `Darkness` reçu → fuite ; entité `warden` → fuite ; auto-défense si hostile ≤4 blocs (cf. §B).
- **Gates de précondition (échec dur, pas retry) :** `pickaxe.tier ∈ {diamond, netherite}` avant obsidienne/debris ; ≥1 seau d'eau avant Y<-50 ; ≥1 pièce d'or équipée en Nether ; bed-detonate gate (≥6 blocs + occlusion) ; gate Nether (pioche enchantée + plastron Protection).
- **Géométrie & patterns figés :** branch mining (corridor 1×2, gap paramétré, stride/offset) ; ring portail 10 cellules ; bed mining state machine (`dig_main→branch(5)→retreat→detonate→scan`) ; escalier de descente.
- **Tables de recettes/quantités/Y :** Y cibles (diamant -53/-54/-59, fer 15-16, charbon 96, debris 15) ; recettes (lingot 4+4, table 4+2+1, template dup 7+1) ; fuel solver ; budgets (10-12 raw iron, 36 debris/kit) ; coûts diamant par pièce.
- **Détection bloc-based gratuite :** scan sculk (Deep Dark), scan `lava` voisins, `findBlock` pour ore exposé.
- **Triggers de transition :** event `forcedMove`, séquence de traversée de portail (look + forward + wait).
- **Compteurs/timers :** warning level shriekers (abandon ≥2), timer Fire Res (re-boire avant échéance), flood-fill de blob à la détection d'ore.

### E.2 — Observation-du-monde, appel planner LLM (arbitrage stratégique)

- **Sélection de stratégie de minage diamant :** branch vs cave (selon volume d'air détecté, Fortune, durabilité) ; choix `gap=2` vs `gap=6` (yield-max vs efficiency).
- **Heuristique two-target fer :** lire le biome → décider scan-surface vs branch-mine Y=15.
- **Ordonnancement des sous-buts macro :** quand entrer dans la phase enchantement (XP suffisante ?), quand juger l'équipement « assez bon » pour le Nether, quand brancher sur l'objectif trade/loot (Mending, template bastion).
- **Re-planification sur événement inattendu :** Deep Dark rencontré sur le trajet (re-router), bastion non trouvé, inventaire insuffisant en cours de chaîne, blob de diamant exceptionnel (étendre le flood-fill ?).
- **Arbitrages mutuellement exclusifs :** Fortune vs Silk Touch sur la pioche ; quelle pièce d'armure upgrader/enchanter en priorité selon les diamants restants.
- **Cible de minage debris :** combien de chunks ratisser selon l'objectif (kit complet vs pioche seule) et le yield observé vs attendu (~1,65/chunk).

**Règle budget LLM :** un appel planner par **transition de phase macro** ou par **divergence observée vs attendue** ; **zéro appel** dans les boucles serrées (minage bloc-par-bloc, esquive, traversée) — celles-ci sont 100 % déterministes.

---

## Sources

**Minage diamant / fer / charbon / fonte :**
- [Tutorial:Mining — Minecraft Wiki](https://minecraft.wiki/w/Tutorial:Mining)
- [Diamond Ore — Minecraft Wiki](https://minecraft.wiki/w/Diamond_Ore)
- [Ore vein — Minecraft Wiki](https://minecraft.wiki/w/Ore_vein)
- [Iron ore — Minecraft Wiki](https://minecraft.wiki/w/Iron_ore)
- [Coal ore — Minecraft Wiki](https://minecraft.wiki/w/Coal_ore)
- [Smelting — Minecraft Wiki](https://minecraft.wiki/w/Smelting)
- [Ore/1.18 distribution — Minecraft Wiki (Fandom mirror)](https://minecraft.fandom.com/wiki/Ore/1.18_distribution)
- [Best Y Level for Diamonds 2026 — Minecraft X-Ray](https://minecraftxray.com/blog/best-y-level-diamonds-2026)
- [A 1.18 Ore Distribution Guide — PlanetMinecraft](https://www.planetminecraft.com/blog/a-1-18-ore-distribution-guide/)
- [Best Y Level for Diamonds (1.20 & 1.21) — Shockbyte](https://shockbyte.com/blog/the-best-y-level-for-diamonds-in-minecraft)
- [5 best tips to mine diamonds in 1.18 — Sportskeeda](https://www.sportskeeda.com/minecraft/5-best-tips-mine-diamonds-minecraft-1-18-update)
- [Minecraft 1.18: Best Places to Mine Diamonds — ScreenRant](https://screenrant.com/minecraft-update-best-places-mine-diamonds-guide/)

**Hazards (Deep Dark / Warden / lave) :**
- [Warden — Minecraft Wiki](https://minecraft.wiki/w/Warden)
- [Deep Dark — Minecraft Wiki](https://minecraft.wiki/w/Deep_Dark)
- [Ancient City — Minecraft Wiki](https://minecraft.wiki/w/Ancient_City)
- [Lava — Minecraft Wiki](https://minecraft.wiki/w/Lava)
- [Fire Resistance — Minecraft Wiki](https://minecraft.wiki/w/Fire_Resistance)
- [Lava Generation Levels in the Overworld — GGServers](https://ggservers.com/knowledgebase/article/lava-generation-levels-in-the-overworld/)
- [How to Find Diamonds — Y -53 to -59 (2026)](https://gamingpromax.com/how-to-find-diamonds-in-minecraft/)

**Enchantement / outillage :**
- [Enchanting mechanics — Minecraft Wiki](https://minecraft.wiki/w/Enchanting_mechanics)
- [Enchanting table — Minecraft Wiki](https://minecraft.wiki/w/Enchanting_table)
- [Enchanting table mechanics — Minecraft Wiki](https://minecraft.wiki/w/Enchanting_table_mechanics)
- [Mending — Minecraft Wiki](https://minecraft.wiki/w/Mending)
- [Enchantment — Minecraft Wiki](https://minecraft.wiki/w/Enchantment)
- [What Gear to Upgrade to Netherite First — GuruGamer](https://gurugamer.com/pc-console/what-gear-to-upgrade-to-netherite-first-in-minecraft-25978)
- [Best Enchant Order — TechTimes](https://www.techtimes.com/articles/313551/20251224/minecraft-enchanting-gear-progression-best-enchant-order-tools-weapons-armor.htm)

**Obsidienne / portail :**
- [Obsidian — Minecraft Wiki](https://minecraft.wiki/w/Obsidian)
- [Nether portal — Minecraft Wiki](https://minecraft.wiki/w/Nether_portal)
- [Tutorial:Obsidian farming — Minecraft Wiki](https://minecraft.wiki/w/Tutorial:Obsidian_farming)

**Ancient debris / bed mining / netherite / Nether :**
- [Ancient Debris — Minecraft Wiki](https://minecraft.wiki/w/Ancient_Debris)
- [Tutorial:Ancient debris — Minecraft Wiki](https://minecraft.wiki/w/Tutorial:Ancient_debris)
- [Netherite Ingot — Minecraft Wiki](https://minecraft.wiki/w/Netherite_Ingot)
- [Smithing Template — Minecraft Wiki](https://minecraft.wiki/w/Smithing_Template)
- [Netherite — Minecraft Wiki](https://minecraft.wiki/w/Netherite)
- [Pickaxe — Minecraft Wiki](https://minecraft.wiki/w/Pickaxe)
- [Armor — Minecraft Wiki](https://minecraft.wiki/w/Armor)
- [Piglin — Minecraft Wiki](https://minecraft.wiki/w/Piglin)
- [Best Y Level for Ancient Debris — Wabbanode](https://wabbanode.com/blog/minecraft/best-y-level-ancient-debris-nether)
- [How To Bed Mine In The Nether — drmodapk](https://drmodapk.com/how-to-bed-mine-in-the-nether/)

**Agents LLM / mineflayer :**
- [Issue #709 — Cannot move into portal blocks (PrismarineJS/mineflayer)](https://github.com/PrismarineJS/mineflayer/issues/709)
- [mineflayer API docs (api.md)](https://raw.githubusercontent.com/PrismarineJS/mineflayer/master/docs/api.md)
- [mindcraft skills.js (mindcraft-bots/mindcraft)](https://raw.githubusercontent.com/mindcraft-bots/mindcraft/main/src/agent/library/skills.js)
- [mineflayer-pathfinder (PrismarineJS)](https://github.com/PrismarineJS/mineflayer-pathfinder)
- [Long Distance Travel System — Issue #39 (mineflayer-pathfinder)](https://github.com/Karang/mineflayer-pathfinder/issues/39)
- [Voyager — An Open-Ended Embodied Agent with LLMs (MineDojo)](https://github.com/minedojo/voyager)
- [Voyager paper (arXiv 2305.16291)](https://arxiv.org/abs/2305.16291)
- [mindcraft (GitHub)](https://github.com/mindcraft-bots/mindcraft)
