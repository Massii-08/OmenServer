# MC Agent — Mémoire de monde partagée + cartographe (design)

> Date : 2026-06-03 · Auteur : Massii + Claude · Statut : **à valider**
> Branche de base : `feat/mc-agent-autonomous-explore` (@ 792a414) — construit sur le skill `explore`.

## 1. Objectif

Donner aux bots MC Agent une **mémoire du monde partagée par serveur** pour qu'ils aillent chercher
leurs ressources **seuls** (sans qu'on prépare d'arène). Un bot **cartographe** dédié explore et
remplit cette mémoire (biomes + entrées de grotte, puis structures) ; les bots **récolteurs**
bootstrappent cette mémoire → filent au bon endroit au lieu de chercher à l'aveugle.

Révélé par : le run autonome stallait sur `goal:logs` faute de bois à 64 blocs (le bot ne savait
qu'attendre). `explore` (déjà fait) lui apprend à voyager ; la mémoire lui apprend **où** voyager.

## 2. Modèle « groupe »

- **Groupe = un serveur** (1 groupe par config de connexion host/port/compte). C'est l'onglet
  « Serveurs » existant (`data/mc_agent_servers.json`, cf. piège #38), **étendu** pour POSSÉDER :
  la liste de bots **et** la mémoire de monde.
- **Cycle de vie (règle Massii)** :
  - **Ajouter / retirer un bot** dans un groupe → la mémoire **ne change pas**.
  - **Supprimer le groupe** → stop + suppression de **tous ses bots** ET de **sa mémoire** → disque libéré.
- Un serveur peut avoir **plusieurs mondes** (overworld / monde de minage / nether) avec des
  systèmes de coordonnées différents → la mémoire est **partitionnée par monde** (cf. §3).

## 3. Mémoire de monde (store partagé)

Fichier : `data/mc_agent_world_memory/<group_id>.json`

```json
{
  "group_id": "...",
  "updated_at": "...",
  "worlds": {
    "minecraft:overworld": {
      "biomes": [ { "name": "forest", "x": -640, "z": 128, "at": "..." } ],
      "caves":  [ { "x": 312, "y": 63, "z": -88, "at": "..." } ]
    },
    "mining":               { "biomes": [], "caves": [] },
    "minecraft:the_nether": { "biomes": [], "caves": [] }
  }
}
```

- **Clé de monde** = `label || bot.game.dimension`.
  - `bot.game.dimension` distingue **automatiquement** overworld / nether / end.
  - Un **monde de minage** (overworld-type séparé) n'est pas auto-distinguable côté client →
    **label optionnel** passé au lancement (`--world-label mining`). Sans label → la dimension.
- **Quantification** : x,z snappés sur grille **128** ; **dédup** par (cellule, type, nom) → 1 entrée
  par région de 128². **Cap dur par monde** (ex. 500 biomes + 500 caves ; au-delà on jette les plus
  vieilles) → disque borné.
- **Écriture backend-médiée (un seul écrivain)** : les bots **émettent des events stdout**
  (`{type:'biome_seen', world, name, x, z}`, `{type:'cave_found', world, x, y, z}`) — canal existant
  (`emit()`). Le **manager** (`mc_agent_manager.py`) les capte et écrit le store **sous verrou**
  (`threading.Lock` par groupe) → pas de write concurrent même avec N bots.
- **Persistance au fil de l'eau** : chaque trouvaille est écrite immédiatement → si un bot meurt, la
  carte déjà tracée n'est **pas** perdue.

## 4. Bootstrap (un bot frais « sait où chercher »)

- Au lancement, le manager écrit la mémoire courante du groupe dans un fichier temp passé via
  **`--world-memory <file>`** (même pattern que `--world` / `--commands` / `--policy`,
  cf. pièges #38/#39/#40).
- Les **récolteurs** : `explore` consulte la partition du monde courant via une table
  **matériau→biome** (`*_log → forest/taiga/jungle`, `sand → desert/beach`, `cactus → desert`, …) :
  si un biome correspondant est connu à coords C (à portée raisonnable, cap ex. 1500 blocs) →
  **voyage dirigé vers C d'abord**, puis re-scan en anneaux ; sinon → recherche en anneaux actuelle.
- Les **caves connues** sont aussi exploitables par les récolteurs (Phase 2) pour trouver des minerais
  exposés.

## 5. Rôle « cartographe » (objectif `mapper`)

Nouvel objectif sélectionnable dans le dropdown (à côté de stone_pickaxe / iron_pickaxe / diamond).

### 5.1 Mini-kit d'abord
Avant de cartographier, le bot se fait un **kit minimal pierre/fer** (réutilise la logique des chaînes
existantes, version réduite) :
- bois → planches → établi → bâtons → pioche bois → **pioche pierre** + **épée pierre** ;
- optionnel rapide : four + 2-3 fer → **épée fer** (+ 1 pièce d'armure si trivial).
- But : pouvoir **se défendre un minimum** et **creuser** (abri / accès cave), pas une chaîne complète.
Puis bascule en **mode cartographie**.

### 5.2 Survie (« basique + »)
- Réflexes max (`reflexes.js`) : **mange** dès faim (réutilise `FOODS`).
- **Se nourrir** : si faim et pas de nourriture → tue opportunément un mob passif (vache/cochon/poule)
  proche et mange. Sinon, n'engage pas.
- **Se défendre un minimum** (pas fuite pure) : avec l'épée, **combat 1-2 hostiles** proches ;
  **fuit** si submergé (≥3 hostiles) ou **PV bas** (retraite jusqu'à régénération).
- Pathfinder évite lave/vide ; pas de plongée en grotte profonde (il **note** l'entrée, n'y descend pas).

### 5.3 Boucle cartographie (0 LLM)
- Exploration **continue** en spirale/anneaux (réutilise la géométrie d'`explore`, sans « trouvé → stop » :
  il balaie vers l'extérieur en permanence, en sautant les cellules déjà en mémoire).
- À chaque waypoint + sur changement de biome → lit `block.biome.name` → émet `biome_seen`.
- **Détection d'entrée de grotte** (best-effort, heuristique) : en se déplaçant, repère une
  **ouverture descendante** — colonne d'air de profondeur ≥4 sous une lèvre solide près de la
  surface, ou ouverture à flanc de colline → émet `cave_found` aux coords de l'ouverture.
  (Pas de descente : juste noter l'entrée.) Quantifié/dédup comme les biomes.

## 6. Plusieurs cartographes (scan rapide, anti-chevauchement)

- On peut lancer **N cartographes** dans un groupe.
- **Partition en secteurs** : au lancement, le manager assigne au mapper i (sur N actifs du groupe)
  un **cap/secteur** (heading ≈ 360°·i/N, avec une largeur de secteur) → ils s'éventent dans des
  directions différentes. Passé via un arg (`--sector <deg> <width>` ou dérivé du `--world-label`).
- **Skip des cellules déjà couvertes** : chaque mapper lit la mémoire bootstrap et **évite les
  cellules déjà mappées** (par lui ou les autres) → moins de chevauchement.
- Phase 1c (simple) : assignation **au lancement** + skip bootstrap. Re-balancing dynamique
  (un mapper meurt → réassigner) et de-confliction **temps réel** (deux mappers qui se croisent en
  cours) = raffinement ultérieur (la mémoire backend pourrait être re-poussée périodiquement aux bots).

## 7. UI (onglet « Serveurs » = groupes, admin)

- Par **groupe** : gestion des bots (ajouter/retirer un bot, choisir l'objectif dont `mapper`,
  label de monde + secteur pour les mappers) + bouton **Supprimer le groupe** (cascade).
- Vue **mémoire** par groupe → par **monde** : liste **Biomes connus** (nom + coords + vu il y a X)
  et liste **Entrées de grotte** (coords). Phase 2 ajoutera **Structures** au même endroit.
- Tout **admin-only** (cohérent RBAC existant).

## 8. Suppression cascade

- L'endpoint de suppression de groupe (= profil serveur) :
  1. **stop** tous les bots en cours du groupe (sessions actives) ;
  2. supprime la config du groupe (`mc_agent_servers.json`) ;
  3. `rm data/mc_agent_world_memory/<group_id>.json` (+ fichiers temp éventuels).
- → disque de l'Omen libéré (souci explicite Massii).

## 9. Découpage d'implémentation

| Sous-phase | Contenu | LAN requis ? |
|---|---|---|
| **1a — Infra mémoire** | store multi-monde + events bot→manager (verrou) + `--world-memory` bootstrap + cascade delete + UI mémoire (biomes/caves). | Code+tests **offline** ; smoke live ensuite. |
| **1b — Cartographe (1 bot)** | objectif `mapper` : mini-kit pierre/fer → survie (défense min + nourriture) → boucle cartographie → `biome_seen` + `cave_found`. | offline (unit) + smoke live. |
| **1c — Multi-cartographes** | N mappers : secteurs au lancement + skip cellules mappées. | offline (unit) + smoke live. |
| **1d — Récolteurs consomment** | `explore` biais dirigé via table matériau→biome + caves connues. | offline (unit) + smoke live. |
| **Phase 2 — Structures** | `/locate` (si op) + cluster d'entités → registre → liste structures admin. | LAN pour valider `/locate`. |

## 10. Tests

- **Offline (unitaire)** : store quant/dédup/cap multi-monde (Py) · parse events→store sous verrou (Py)
  · cascade delete (Py) · `MAPPER_KIT` + boucle cartographie pure (Node, fake bot Vec3) · détection
  cave heuristique (Node) · secteurs + skip cellules (Node) · `explore` biais dirigé (Node).
- **Live (quand LAN)** : 1 mapper sur le serveur test → voit `biome_seen`/`cave_found` arriver dans le
  store ; survit (défense/nourriture) ; un récolteur frais bootstrappe et va droit au biome connu ;
  N mappers ne se chevauchent pas ; suppression de groupe nettoie tout.
- ⚠️ **Leçon dcd874d** : fake-bots avec vrai `Vec3` (`floored`/`distanceTo`) ; un POJO masque les bugs.
  La validation live reste obligatoire.

## 11. Dépendances & risques

- **0 nouvelle dépendance** (réutilise mineflayer/pathfinder/collectblock/pvp + `explore`).
- **Isolation** : worktree dédié basé sur `feat/mc-agent-autonomous-explore` ; **ne touche pas** la
  session diamant qui tourne. Intégration coordonnée (merge quand validé).
- Risques : (a) **détection cave** heuristique → best-effort, faux positifs/négatifs tolérés ;
  (b) **de-confliction temps réel** des mappers limitée en Phase 1c (assignation au lancement) ;
  (c) **`/locate`** (Phase 2) nécessite op bot → à vérifier sur le serveur (fallback = clusters
  d'entités) ; (d) `explore` lui-même **pas encore validé live** (bloqué réseau) → 1a/1b en dépendent
  pour le smoke final.

## 12. Questions ouvertes

- Mini-kit : s'arrêter à la **pierre** (épée+pioche) suffit, ou pousser jusqu'au **fer** (épée+armure) ?
  (proposé : pierre obligatoire, fer « si trivial/rapide ».)
- Secteurs : largeur fixe (360/N) ou recouvrement léger pour ne pas laisser de trous aux frontières ?
- Caches caves : faut-il aussi noter la **profondeur/►direction** de l'entrée, ou juste les coords ?
