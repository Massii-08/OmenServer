# 🔴 RETOURS LIVE DE MASSII — bugs observés en jeu (PRIORITÉ ABSOLUE)

> Massii regarde le bot cartographe tourner EN DIRECT sur le serveur. Voici les bugs à corriger **en priorité** avant de continuer le reste. Corrige, ajoute un test quand c'est testable, commite chaque fix séparément, puis valide en live si possible.

## 1. 🌊 Le bot se BLOQUE dans un angle dans l'eau
- Symptôme : coincé dans un coin/angle quand il est dans l'eau, il ne s'en sort plus.
- À faire : détecter le "stuck" (position quasi inchangée pendant N secondes alors qu'il est dans l'eau / `bot.entity.isInWater`) → manœuvre d'évasion (remonter à la surface + viser la **terre ferme** la plus proche). Empêcher le pathfinder de viser un waypoint en eau/cul-de-sac.
- Zones probables : `mc-agent/skills/explore.js`, logique de survie/déplacement du mapper, garde-fou anti-stuck (cf. piège #41 `withTimeout`).

## 2. ⛏️ Difficulté à CASSER les blocs
- Symptôme : il galère à miner.
- À faire : s'assurer qu'il **équipe le meilleur outil** (`tools.js` `bestToolFor` selon le matériau) AVANT de creuser, qu'il est **à portée** (pathfinder.goto adjacent au bloc), et qu'il **attend la fin du dig** (await `bot.dig`) avec retry si échec. Vérifier qu'on n'essaie pas de casser hors de portée.

## 3. 🪵 Table de craft posée TROP VITE + CASSÉE pendant l'usage
- Symptôme : il pose la table de craft trop rapidement, et quand il l'utilise il la casse (table portable, cf. piège #41 `withCraftingTable`/`craftSmart`/`placeBlockNear`/`reclaimBlock`).
- À faire :
  - Après `placeBlock`, **attendre que le bloc EXISTE vraiment** (poll `bot.blockAt(pos)` jusqu'à voir un `crafting_table`) AVANT de l'ouvrir — ne pas l'utiliser instantanément.
  - Ne **récupérer** (reclaim/casser) la table **qu'APRÈS** que le craft soit 100% terminé (pas pendant).
  - Éviter la **double pose** : si une table est déjà posée et valide, l'utiliser, ne pas en re-poser une.
  - Ajouter de petits `await`/délais entre pose → ouverture → craft → reclaim.

## 4. 🧭 Le mapping doit être ALÉATOIRE, pas des cercles (trop suspect)
- Demande de Massii : « qu'il aille un peu au aléatoire, au pire il reviendra au spawn ; c'est trop suspect de faire des cercles ».
- À faire : **remplacer/compléter** le pattern d'anneaux expansifs (`nextWaypoints`) par une **errance organique randomisée** — cap (heading) tiré au hasard, distances variables, changements de direction irréguliers (garde le jitter `movementJitter` existant). Ça doit ressembler à un joueur humain qui explore, **pas** à un quadrillage/cercle robotique.
- **Fallback** : s'il s'éloigne trop / se perd / ne trouve plus de terrain valide → **revenir au spawn** (point de départ / `home`) puis repartir dans une autre direction aléatoire.
- Garder une **borne** (anti-boucle-infinie) et le **skip des cellules déjà mappées** (secteurs).

## 5. 🏝️ ÉVITER LES OCÉANS — rester sur la TERRE FERME
- Demande de Massii : « éviter qu'il passe par les océans, ce qui nous intéresse est sur la terre ferme, pas dans l'océan ».
- À faire : dans la sélection des waypoints (explore/mapper), **détecter et REJETER** les cibles en océan / plan d'eau (biome océan via `block.biome`, ou eau au point cible) → **biaiser vers la terre**. Si la direction tirée mène vers l'océan, en tirer une autre (vers la terre). Connecter à la mémoire de monde (biomes connus) pour préférer les biomes terrestres.
- Combiné avec #1 : si jamais il finit dans l'eau, il en sort et revient vers la terre.

---

### Méthode
- Priorise #1, #2, #3 (ils bloquent le bot tout de suite), puis #4 et #5 (qualité du mapping).
- Chaque fix : test Node quand testable + commit dédié.
- Valide en live sur le serveur Omen quand possible (avec timeout strict).
- Mets à jour la page concept Obsidian quand un point est validé.

---

## 6. 🧱 Il a posé un bloc EN L'AIR sans support (TRÈS suspect / illégal)
- Symptôme : Massii l'a vu poser un bloc flottant qui ne touche rien. En Minecraft légitime c'est IMPOSSIBLE — on pose TOUJOURS contre la face d'un bloc existant. Bloc flottant = pose illégale → **anti-cheat flag/kick** + signature évidente de bot. PRIORITÉ HAUTE.
- À faire : TOUTE pose de bloc DOIT se faire contre une **face d'un bloc solide adjacent réel** (`referenceBlock` + `faceVector` valides, via `bot.placeBlock(referenceBlock, faceVector)`). Ne JAMAIS poser sans support. Auditer `placeBlockNear` (cf. piège #41, en particulier la "pass 3 piédestal" qui pose peut-être un bloc sans bloc de référence correct) : si aucun bloc de référence valide n'existe à côté/sous la cible, NE PAS poser → soit choisir une autre case avec support, soit monter en pilier proprement (cf. #7). Ajouter un garde-fou qui REFUSE toute pose sans `referenceBlock` solide.

## 7. 🦘 Saut + pose du bloc sous les pieds (montée en pilier) — TIMING
- Demande de Massii : pour monter en pilier, le bot doit **sauter**, et **une fois à la hauteur MAX du saut (l'apex)**, poser le bloc **sous ses pieds**. Il galère sur le timing actuellement.
- À faire (technique humaine de pillaring) :
  1. Regarder vers le bas (`bot.look` pitch ≈ +90° / viser le sol).
  2. Sauter (`bot.setControlState('jump', true)` bref).
  3. Attendre l'**APEX** : détecter le moment où `bot.entity.velocity.y` passe de positif à ~0 (sommet du saut).
  4. À cet instant précis, poser le bloc contre la **face supérieure du bloc actuellement sous le bot** (`referenceBlock` = bloc sous les pieds, `faceVector` = (0,1,0)).
  5. Le bot retombe sur le nouveau bloc → +1 de hauteur.
  - Synchroniser la pose sur l'apex (pas avant : sinon collision ; pas après : il retombe). Retry si la pose rate. Réutiliser le garde-fou de #6 (jamais sans support).
- Note : ça sert quand il doit gagner de la hauteur (sortir d'un trou, franchir un mur) — combiner avec #1 (sortir de l'eau) et #2 (casser/poser proprement).

## 8. 🪂 Bloqué à MOITIÉ EN L'AIR devant un bloc (très suspect — fly/cling)
- Symptôme : Massii l'a vu coincé à mi-hauteur, flottant devant la face d'un bloc — ne tombe pas, n'avance pas. En jeu légit c'est impossible (on ne reste pas suspendu contre un mur) → signature anti-cheat (fly/glide) + bot évident. PRIORITÉ HAUTE.
- Cause probable : le pathfinder/contrôles l'ont laissé **pressé contre un mur** (`forward` + `jump` maintenus) en essayant de grimper une marche/un bloc → il reste collé en l'air sans progresser ; OU une pose/saut raté (#6/#7) l'a laissé flottant.
- À faire :
  - Détecter l'état "coincé contre un bloc en l'air" : `forward` actif mais position horizontale ~inchangée pendant N secondes ET bot PAS `onGround` (flottant).
  - Recovery : **`bot.clearControlStates()`** (relâcher TOUT) → laisser le bot RETOMBER au sol → recalculer le chemin. Si marche d'1 bloc à franchir → saut PROPRE et synchronisé (cf. #7) au lieu de pousser contre le mur.
  - **Garde-fou général anti-suspicion** : le bot ne doit JAMAIS rester en état "flottant/suspendu" en dehors d'un saut ou d'une chute normale. Dès que détecté → recovery immédiat.
  - Relié à #1 (anti-stuck eau), #6/#7 (pose/saut). Ces bugs (#1/#6/#7/#8) forment un cluster "réalisme du déplacement + anti-cheat" → envisager UN garde-fou commun "le bot reste-t-il dans un état physiquement plausible ?" appelé périodiquement.

---

## ⚠️ PRÉCISION / CORRECTION du #4 (mapping) — retour live Massii (CECI SUPERSEDE le #4)
Massii a vu le bot faire des **ALLÉES-RETOURS** (va à un point puis revient). **IL NE VEUT PAS ÇA.** Comportement voulu, précisé :
- Le bot **AVANCE TOUJOURS vers l'avant**, **JAMAIS de retour à un point déjà visité**, **AUCUNE allée-retour / oscillation**.
- La **randomité est UNIQUEMENT dans le CHOIX de la DIRECTION** (heading tiré au hasard au départ, éventuellement quelques changements de cap très espacés). ⚠️ « le but c'est de **PAS** faire des mouvements aléatoires » = la **locomotion** ne doit PAS trembloter/zigzaguer/errer sur place. Le bot marche **franchement en ligne ~droite** dans la direction choisie, comme un joueur qui part explorer.
- Concrètement : chaque bot **pick un heading aléatoire** → **explore en ligne quasi-droite** dans ce sens, en continu, **distance croissante**, sans revenir.
- ❌ **Abandonner** : les anneaux expansifs ET le pattern "retour au spawn puis reparti" comme MODE de balayage. (Le retour au spawn = seulement un ultime fallback si vraiment coincé, PAS un mode d'exploration.)
- ✅ **Couverture incomplète = OK** : « si j'envoie plusieurs bots, la map sera scannée en grande partie mais pas complètement, et c'est pas grave parce que l'important on l'aura trouvé. » → N bots × headings aléatoires DIFFÉRENTS (cf. secteurs #4/multi-cartographes) = bonne couverture globale sans quadrillage exhaustif.
- Toujours valable : éviter les océans (#5), skip des cellules déjà mappées (mémoire), garde-fous anti-stuck (#1/#8/#9).

## 9. 🌿 Bloqué dans les LIANES (vines)
- Symptôme : le bot se coince dans les lianes (vines de jungle, cave vines, etc.).
- Cause : les lianes sont des blocs grimpables/traversables qui piègent le pathfinder (il s'y accroche, les prend pour un mur/sol, ou tente de grimper et reste collé).
- À faire : traiter les lianes comme **traversables** — ne pas s'y accrocher ni les considérer comme obstacle solide. Soit les **casser** pour passer, soit les **contourner**. Détecter le stuck-dans-les-lianes (même garde-fou que #1/#8 : position bloquée) → recovery (`clearControlStates`, casser la liane devant/au-dessus, ou recalculer un chemin qui les évite). Fait partie du **cluster anti-stuck** (#1/#8/#9).

## ⚠️ RE-PRÉCISION du #4 (mapping) — « tout droit » ≠ ligne droite parfaite
Massii reclarifie : **« tout droit » NE veut PAS dire une ligne droite parfaite** (ce serait robotique aussi). Ça veut dire : **éviter les cercles et les allées-retours**, en bougeant comme un **VRAI JOUEUR** qui explore.
- Exemple concret donné par Massii : il part vers le **nord**, puis dévie **un peu en diagonale**, **revient un peu en arrière**, puis **bifurque à gauche**… = exploration **organique et humaine**, pas un pattern rigide.
- ✅ VOULU : une **direction générale** qui **dérive naturellement** (diagonales, virages doux, petit retour ponctuel), avec **progression globale** vers de nouveaux terrains.
- ❌ INTERDIT : (a) **cercles** robotiques · (b) **ligne parfaitement droite** robotique (aussi suspect) · (c) **allées-retours SYSTÉMATIQUES** (osciller en boucle entre 2 points, repasser sans cesse au même endroit).
- ⚠️ Nuance vs "jamais revenir en arrière" : un **micro-retour ponctuel est OK** (c'est humain) — ce qui est banni, c'est l'**oscillation systématique** et les cercles, PAS un petit backtrack occasionnel.
- Implémentation suggérée : **random walk biaisé vers l'avant à forte autocorrélation de cap** — le heading évolue **lentement et aléatoirement** (style marche aléatoire persistante), JAMAIS un cap fixe (= ligne droite) NI un cap qui saute brutalement à chaque tick (= erratique). Conserver : éviter océans (#5), éviter de re-couvrir massivement les cellules déjà mappées, garde-fous anti-stuck (#1/#8/#9).

---

## 📋 STATUT DES FIXES (Claude, nuit du 03→04/06 — tous committés sur `feat/mc-agent-world-memory`)

| # | Fix | Statut | Validation |
|---|---|---|---|
| 1 | Stuck dans l'eau → `unstuck.js` (évasion surface + terre ferme, bornée) | ✅ | Live : 3-4 `unstuck_done ok:true`/run |
| 2 | Casser les blocs → retry dig + meilleur outil ré-équipé + `resolveBiome` (biome.name=`''` en 1.21.4) | ✅ | Live : kit complet, `material_found` nommés |
| 3 | Table posée trop vite/cassée → `waitForBlock` après pose + délais pose→craft→reclaim + approche table existante | ✅ | Live : wooden/stone pickaxe + épée craftées |
| 4 | Mapping → **marche aléatoire persistante** (dérive de cap ±25°, bifurcation 8%, ni cercles ni allées-retours, jamais de retour-spawn) | ✅ | Live : T7A → Est +221 ; T8B → Ouest −374, progression continue |
| 5 | Éviter les océans → `isOceanCell` (mémoire) + `waterAhead` (échantillon terrain devant) | ✅ | Live : 0 goto vers l'eau, `mapper_turn` sur obstacle |
| 6 | Pose illégale → garde-fou référence PLEINE + confirmation anti-ghost (`placeBlockNear`) | ✅ offline | Tests dédiés ; à observer en jeu |
| 7 | Pillaring → skill `pillarUp` (pose à l'APEX du saut via `velocity.y`) | ✅ offline | 8 tests ; pas encore branché dans un flux auto |
| 8 | Flottant contre un mur → `isFloatingStuck` + `recoverFloating` (`clearControlStates` + retombée) | ✅ | Tests + branché dans la boucle mapper |
| 9 | Lianes → `clearSnares` (vines/cobweb/berry bush cassées, pieds+tête+voisins) | ✅ | Tests + branché (boucle mapper + échec de jambe) |

Bonus : remontée SURFACE avant de mapper (le kit laisse le bot au fond du trou à cobble) · jambes courtes après 2 échecs (jungle dense) · timeout de jambe 45s · re-tentative périodique du kit pendant le mapping. **Node 313 ✓ · Python 143 ✓.**
