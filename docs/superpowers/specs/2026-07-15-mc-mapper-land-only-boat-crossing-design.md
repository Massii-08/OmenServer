# MC Agent mappeur — cartographie terre-only + traversée océan en bateau

**Date** : 2026-07-15
**Statut** : validé par Massii (boucle walk-land → boat-cross → repeat, bateau crafté, cap vers le large)
**Branche** : `feat/mc-mapper-boat-crossing` (base = `origin/main` `7d2a7f6`, inclut déjà le fix warp-spam)

## 1. Contexte & problème

Le mappeur reste confiné à une zone et ne s'étend plus (vécu live 2026-07-15 : 32 cellules
figées, 225 `/spreadplayers` en 11 min, 0 déplacement net). Cause racine diagnostiquée :

- La boucle frontière vise « la cellule non-couverte la plus proche » **sans savoir si c'est
  terre ou océan** (`nextFrontierCell` dans `frontier.js`). Sur une île, toute la frontière
  restante est de l'océan.
- Cellule lointaine (`fd > warpDist`) → **warp `/spreadplayers` à l'aveugle**. Les cibles océan
  échouent (« Could not spread… too many entities for space »), le bot ne bouge pas.
- Le fix warp-spam (`7d2a7f6`) empêche le re-warp infini sur UNE case, mais le bot *chure*
  alors à travers des centaines de cases océan (skip chacune), toujours sans avancer.
- Les rares warps réussis vers de la terre vierge ne mappent rien (worldgen lent au redémarrage
  serveur + le bot repart avant que les chunks chargent).

**Décision produit (Massii)** : le mappeur ne doit cartographier que la **terre**, traverser
les océans en **bateau** (juste traverser, pas mapper l'eau), et pousser **vers le large** en
continu jusqu'à l'arrêt manuel.

## 2. Principe de la nouvelle boucle

Le bot ne mappe que ce qu'il **perçoit** (chunks chargés → il SAIT si c'est terre) et ne
franchit l'eau que pour **atteindre** la prochaine terre. Fini le ciblage à l'aveugle de cases
inconnues lointaines.

```
┌─ (1) MAPPER LA TERRE LOCALE À PIED ──────────────────────────┐
│   marche vers la case non-mappée la + proche DANS le rayon    │
│   de perception, qui est de la TERRE et atteignable (pas      │
│   d'eau sur le chemin). Mappe en marchant. Répète.            │
└───────────────┬──────────────────────────────────────────────┘
                │ plus de terre locale atteignable (côte)
                ▼
┌─ (2) TRAVERSÉE BATEAU VERS LE LARGE ─────────────────────────┐
│   cap = vers l'extérieur (à l'opposé de la zone mappée /      │
│   secteur du bot). Crafte un bateau si besoin, le pose au     │
│   bord de l'eau, embarque, navigue au cap.                    │
└───────────────┬──────────────────────────────────────────────┘
                │ terre détectée devant (sol solide au cap)
                ▼
        (3) débarque sur la nouvelle côte → retour (1)
```

**On SUPPRIME la branche warp `/spreadplayers` à l'aveugle** de la boucle frontière (cause du
churn). Le `warp` self-service reste dispo pour les autres usages (secours survie), mais le
mapping ne l'utilise plus pour se déplacer.

## 3. Composants & fichiers

| Fichier | Nature |
|---|---|
| `mc-agent/boat.js` | **Nouveau** — logique de traversée (décisions PURES testables + hooks bot pour l'action) |
| `mc-agent/boat.test.js` | **Nouveau** — tests unitaires des décisions pures |
| `mc-agent/frontier.js` | Ajout `nextLandLeg()` — frontière **terre perçue** bornée (ne renvoie jamais une case océan/eau-bloquée comme cible de mapping) |
| `mc-agent/frontier.test.js` | Tests `nextLandLeg` (skip océan, null → déclenche bateau) |
| `mc-agent/mapper.js` | Remplace la branche warp par : leg terre locale → sinon traversée bateau ; skip biome océan |
| `mc-agent/mapper.test.js` | Tests d'intégration boucle (terre → coast → boat → land) |
| `mc-agent/index.js` | Câble `boat` (crafte via skills existants) + heading outward dans le `startMapper` |

**Aucune nouvelle dépendance** : mineflayer gère déjà `mount`/`dismount`/`setControlState`/
`activateItem`. Auto-deploy propre.

## 4. Détail par composant

### 4.1 `frontier.js` — `nextLandLeg(memory, worldKey, localSeen, from, opts)`

- Variante bornée de `nextFrontierCell` : cherche la case non-couverte la plus proche **dans un
  petit rayon** (`opts.maxRing` défaut **4** ≈ 512 blocs — au-delà on ne cible pas à l'aveugle).
- **Filtre terre** : rejette une case candidate si `isOceanCell(memory, worldKey, cx, cz)` est
  vrai (case connue océan). Les cases inconnues restent candidates (le bot ira voir à pied ;
  si l'approche rencontre de l'eau, le garde-fou `waterAhead` du mapper la skippe).
- Retour `{ key, center, ring } | null`. **null = frontière terre locale épuisée** → le mapper
  déclenche la traversée bateau.
- Pur/testable (mêmes signatures que `nextFrontierCell`).

### 4.2 `boat.js` — traversée

**Décisions pures (testables sans client MC) :**
- `outwardHeading(fromPos, mappedCentroid, sector, rng)` → yaw (radians) vers l'extérieur.
  Référence = vecteur `fromPos - mappedCentroid` (à défaut : opposé du spawn). Contraint au
  wedge du secteur si multi-bot (`sectorRange`, réutilise `sectors.js`) → les N mappeurs
  s'éventaillent au lieu de tous partir dans la même direction.
- `landAhead(sampleBlock, fromPos, headingYaw, opts)` → `{found, pos} | {found:false}` :
  échantillonne le sol le long du cap (pas de `step` sur `reach` ≈ 24-48 blocs) via un
  `sampleBlock(x,y,z)` injecté ; `found` quand une colonne présente un bloc **solide non-eau**
  au niveau de la mer (côte). Pur (sampler injecté = testable).
- `boatStuck(prevPos, curPos, dtMs, opts)` → true si déplacement horizontal ≈ 0 pendant
  `stuckMs` (défaut 12 s) alors qu'on est censé naviguer (détection de coincement).

**Actions bot (best-effort, bornées, hooks) :**
- `ensureBoat(bot, {craft})` : si aucun `*_boat` en inventaire → `craft('oak_boat'|essence dispo)`
  via le skill de craft existant (`craftSmart`/`withCraftingTable`, 5 planches + table
  portable). Retour `{ok}`. Pas de bois/craft impossible → `{ok:false}` (→ secours nage).
- `boardBoat(bot, waterEdge)` : équipe le bateau, `bot.lookAt(waterEdge)`, `bot.activateItem()`
  pour poser l'entité bateau sur l'eau, puis `bot.mount(nearestBoatEntity)`. Retour `{ok}`.
- `sailToLand(bot, headingYaw, {sampleBlock, timeoutMs})` : boucle — `bot.look(headingYaw,0)` +
  `setControlState('forward', true)` ; ré-assert le cap périodiquement ; s'arrête sur
  `landAhead().found` OU `boatStuck` OU timeout. `dismount` + `clearControlStates` en sortie.
  Retour `{ok, landed, reason}`.
- **Sécurité** : `sailToLand` échoué/coincé → `escapeWater`/nage au cap (logique existante
  `unstuck.js`/crossing) pour ne jamais rester figé. La nage NE sert qu'à se dégager, pas à
  mapper l'eau.

### 4.3 `mapper.js` — intégration

Dans la boucle frontière (`opts.frontier`), remplacer le bloc actuel (goto local + branche
warp) par :

1. `cell = nextLandLeg(...)`.
2. `cell` trouvé + atteignable (`!isOceanCell` && `!waterAhead`) → `doGoto(center)` + `record()`
   + `continue` (comme aujourd'hui, sans la branche warp).
3. `cell` trouvé mais approche eau/échec goto → `frontierSkip.add` (comme aujourd'hui) →
   fallthrough marche.
4. `cell === null` (terre locale épuisée) → **traversée bateau** :
   `heading = outwardHeading(...)` ; `ensureBoat` ; `boardBoat(coastWater)` ;
   `sailToLand(heading)` ; au débarquement `record()` + `continue`. Émet
   `mapper_boat_cross` / `mapper_boat_landed` / `mapper_boat_failed`.
5. **Skip biome océan** : dans `record()`, ne pas émettre `biome_seen` si le biome résolu est
   océan/eau (`/ocean|river|water/` sur le nom résolu) — la carte reste terre-only. La case est
   quand même ajoutée à `localSeen` (anti-re-ciblage).

Le reste (survie, abri nocturne, anti-stuck, surface, kit, secteurs) est **inchangé**.

### 4.4 `index.js` — câblage

- `startMapper` passe à `runMapper` : `boat: { craft: craftSmart, ... }`, `sampleBlock`,
  `mappedCentroid` (calculé depuis `bot._worldMemory`), et le secteur (déjà passé).
- Le `warp` (`/spreadplayers`) n'est plus passé comme moyen de mapping (retiré des `opts` du
  mapper) — il reste utilisé par les secours survie hors mapper.

## 5. Ne pas cartographier l'océan

- `record()` : biome océan → pas d'émission (cf. 4.3.5). La carte n'accumule plus de cases
  d'eau. Les cases océan déjà présentes (ère précédente) restent (inoffensif ; un reset mémoire
  optionnel n'est PAS dans le périmètre).
- Le bot ne s'attarde jamais sur l'eau : il ne fait que la traverser en bateau.

## 6. Tests

**Purs (Node `node:test`, fake bot + samplers injectés — modèle = `mapper.test.js` existant) :**
- `frontier.test.js` : `nextLandLeg` renvoie la terre proche ; skip une case `isOceanCell` ;
  renvoie `null` quand tout le local est océan/couvert.
- `boat.test.js` : `outwardHeading` pointe à l'opposé du centroïde mappé et reste dans le wedge
  du secteur ; `landAhead` détecte la côte via sampler injecté (eau → eau → sol solide) ;
  `boatStuck` déclenche après `stuckMs` sans mouvement.
- `mapper.test.js` : boucle — terre locale mappée à pied ; frontière épuisée → appelle
  `boat.sailToLand` (hook mocké) → au « débarquement » simulé, `record()` mappe la nouvelle
  cellule ; biome océan → PAS d'émission.

**Live (serveur de test `omen-minecraft-trusted-test`, monde à île) :**
- Le bot mappe le continent local à pied (étendue croît), atteint la côte, crafte+embarque,
  navigue au large, débarque sur une nouvelle terre, reprend le mapping → **étendue de la carte
  croît franchement sur ≥ 2 landmasses** en quelques minutes (le critère d'échec actuel).
- Aucune case océan ajoutée à la carte pendant la traversée.

## 7. Risques & garde-fous

- **⚠️ Pilotage bateau headless = le point dur** : mineflayer n'a pas de pathfinder bateau →
  contrôle manuel au cap. Risque que le débarquement/orientation soit imparfait. **Dé-risque** :
  développer `boardBoat`/`sailToLand` incrémentalement + valider LIVE (pas seulement en pur) ;
  la **nage de secours** garantit qu'un échec bateau ne fige jamais le bot (dégradé, pas bloqué).
  Si le bateau se révèle fondamentalement impilotable headless, repli assumé = nage-crossing
  (Massii n'a pas choisi ce repli comme primaire, mais il reste le filet anti-blocage).
- **Bois pour le craft à la côte** : le kit mappeur récolte déjà du bois ; prévoir un petit
  buffer (2 logs) avant la traversée, sinon `ensureBoat` échoue → nage de secours.
- **Multi-bots** : les secteurs (`getSector`) orientent les caps outward pour éviter que tous
  aillent au même endroit.
- **Ne pas pusher pendant un grind** (piège #47e) : recycler les mappeurs après deploy.

## 8. Critères d'acceptation

1. Sur un monde à île, la carte **croît sur plusieurs landmasses** (le bot traverse ≥ 1 océan
   en bateau et reprend le mapping de l'autre côté), jusqu'à l'arrêt manuel.
2. **Aucune case océan** n'est ajoutée à la carte (mapping terre-only).
3. Le bot ne reste jamais figé : côte sans bateau possible → nage de secours, pas de freeze.
4. Multi-mappeurs : caps outward distincts (fan-out par secteur).
5. Tests Node verts (frontier + boat + mapper) ; parse-check OK ; validé LIVE sur le serveur de
   test (étendue croît sur ≥ 2 landmasses, 0 case océan ajoutée).
6. Aucune nouvelle dépendance ; auto-deploy propre ; mappeurs recyclés post-deploy.
