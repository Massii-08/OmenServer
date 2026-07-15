# MC Agent mappeur — survie sur Hard (bouffe + abri auto-suffisant + armure via /kit)

**Date** : 2026-07-15
**Statut** : validé par Massii (v2 allégée : bouffe + abri auto-suffisant + mini-kit pierre ; armure via `/kit` si dispo ; PAS de minage fer obligatoire ; `/kit` configurable au profil, lancé au démarrage ET à chaque respawn)
**Branche** : `feat/mc-mapper-survival` (base `origin/main` `32c4c45`, inclut la feature bateau)

## 1. Contexte & problème

La feature « mappeur terre-only + bateau » (`32c4c45`) est déployée mais **invalidable en live** :
les mappeurs **meurent en boucle** sur le serveur de test (Hard). Diagnostic live 2026-07-15 via
`/api/mc-agent/events/{sid}` : `status:dead` + `autonomous_stalled:death_loop`, **13 morts/20 min**
(« slain by Zombie » ×6, creeper), **0 `mapper_boat_cross`** (les bots crèvent avant d'atteindre
une côte). keepInventory=true, cycle jour/nuit actif.

**Causes racines :**
1. `skills/shelter.js` `shelterUntilDawn` **exige un bloc `SCAFFOLD` en inventaire** pour se poser
   un toit → un mappeur NU (inventaire vide) creuse un trou **sans toit** → les zombies entrent → mort.
2. Le déclencheur d'abri suppose « y<45 = déjà à l'abri » → un spawn en **grotte sombre** (MapBot1
   à y=32) ne se met jamais à l'abri alors que la grotte grouille de mobs.
3. Aucune **armure** ni **bouffe** → chaque coup fait mal (Hard), pas de régén PV.

**Décision produit (Massii) :** rendre le mappeur survivable par (a) **abri auto-suffisant**,
(b) **bouffe**, (c) **mini-kit pierre auto** (déjà là), et (d) **armure via la commande serveur
`/kit`** si le serveur l'offre — **abandonner le minage fer obligatoire** (trop dur/mortel).

## 2. Périmètre

- **`mc-agent`** (Node) : abri auto-suffisant + trigger obscurité + gather terre d'urgence + hook
  `/kit`+équipement au démarrage/respawn + base bouffe.
- **backend** : champ `kit_command` du profil serveur, résolu dans la policy passée au bot.
- **frontend** : champ « Commande de kit » dans le formulaire de profil serveur (onglet Serveurs).

**Réutilise** (aucune réécriture) : `huntCookGoal`, `armorUp`, `eat`, `IRON_ARMOR_CHAIN` reste
dispo mais N'EST PAS ajoutée au kit obligatoire du mappeur. Aucune nouvelle dépendance.

## 3. Composants & fichiers

| Fichier | Nature |
|---|---|
| `mc-agent/skills/shelter.js` (+`.test.js`) | Abri **auto-suffisant** : mine son propre bloc-toit ; trigger obscurité |
| `mc-agent/survival.js` ou nouveau `mc-agent/dirt.js` (+`.test.js`) | Décision « buffer de terre d'urgence » (pur) |
| `mc-agent/index.js` | `startMapper` : base bouffe + hook `/kit`+équipement (démarrage + respawn) ; `maybeNightShelter` trigger obscurité |
| `mc-agent/kit.js` (+`.test.js`) | **Nouveau** : décision pure « faut-il (re)lancer le kit ? » (config + cooldown local) |
| `backend/bots/mc_agent_servers.py` | `resolve_policy` : ajoute `kit_command` |
| `backend/bots/mc_agent_servers.py` tests | `kit_command` résolu / défaut vide |
| `frontend/js/bots_module.js` + `lang.js` | Champ « Commande de kit » profil serveur + i18n |

## 4. Détail par composant

### 4.1 Abri auto-suffisant (`skills/shelter.js`)

**Auto-scellage** — dans `shelterUntilDawn`, l'étape « toit » (actuellement : cherche un
`SCAFFOLD` en inventaire, sinon rien) devient :
1. Si un bloc `SCAFFOLD` (cobble/dirt/…) est en inventaire → comportement actuel (pose au plafond).
2. **Sinon → auto-produire un bloc** : miner un bloc de paroi/sol accessible du trou pour obtenir
   un drop posable (la **terre/gravier drop sans outil** ; la pierre nécessite une pioche → si le
   bot n'a ni bloc ni pioche, on retombe sur le **buffer de terre d'urgence**, §4.2). Puis poser
   ce bloc au plafond (`bot.placeBlock`).
3. Émettre `shelter{action:'roof_self'|'roofed'|'no_roof'}`.

**Pur & testable** : extraire une décision `roofPlan(inv, hasPickaxe) → {source:'inventory'|'mine'|'none'}`
testée sans client. L'action (mine+place) est best-effort, bornée, validée live.

### 4.2 Buffer de terre d'urgence (`dirt.js`, pur + hook)

- `needDirtBuffer(inv, min=4) → bool` (pur) : vrai si moins de `min` blocs posables (dirt/cobble/
  gravel/…) en poche.
- Hook `topUpDirt(bot, {target:8})` (best-effort) : si `needDirtBuffer`, `gather` ~8 blocs de
  **terre/gravier** (rapide, **sans outil**) — réutilise le skill `gather` existant. Appelé une
  fois au démarrage du mappeur (avant la 1ʳᵉ nuit) et opportunément dans `onPeriodic`.
- Garantit que l'abri auto-scellé a toujours de quoi se fermer.

### 4.3 Trigger obscurité (`index.js` `maybeNightShelter`)

- Aujourd'hui : `isNight(bot) && (proactive || mort récente || PV bas || nakedSurface(y≥45))`.
- **Ajout** : déclencher aussi si **lumière faible** là où est le bot (mobs peuvent spawn), quel
  que soit y — via le niveau de lumière du bloc (`bot.world.getBlock(pos).light` / API mineflayer ;
  seuil ≤ 7 = mobs spawnables). Décision pure `shouldShelter({night, lightLevel, naked, lowHp,
  recentDeath, proactive}) → bool` testée sans client. Retire le faux « y<45 = safe ».
- Effet : un spawn en grotte sombre → abri/scellage immédiat au lieu de mourir.

### 4.4 Base bouffe + `/kit` au démarrage/respawn (`startMapper`)

Séquence au démarrage du mappeur (après connexion, AVANT/autour du mini-kit) :
1. **`/kit`** si configuré (§4.5) : `maybeRunKit(bot, policy, clock)` (pur, §4.6) décide de lancer
   la commande → `bot.chat(policy.kit_command)` → attendre ~1,5 s (réception items) → `armorUp()`
   + `eat()` best-effort. Émet `kit_used{cmd}` / `kit_skipped{reason}`.
2. **Mini-kit pierre** existant (`runKit`) — inchangé (fournit pioche/épée pierre → sert aussi à
   miner le toit en pierre si besoin).
3. **Bouffe** : `huntCookGoal(target)` best-effort borné (quelques repas cuits → régén PV). Si pas
   de proie, on continue (l'abri protège en attendant).
4. Puis la **boucle de mapping continu** (terre-only + bateau, inchangée).

**À chaque respawn** (mort → respawn) : re-lancer la même séquence `/kit`+équipement (bornée par
le cooldown local §4.6) via le handler de respawn existant (`bot.on('respawn')` / event death).
Best-effort : si `/kit` est en cooldown serveur, la réponse d'erreur est ignorée (pas de crash).

**On N'AJOUTE PAS** `IRON_ARMOR_CHAIN` au kit obligatoire du mappeur (minage fer = trop
dur/mortel). L'armure vient de `/kit` ; sinon armure = bonus opportuniste des hooks existants.

### 4.5 Config profil serveur `kit_command` (backend + frontend)

- **Profil serveur** (`data/mc_agent_servers.json`) : nouveau champ optionnel `kit_command`
  (string, défaut `""` = pas de kit). `resolve_policy(server)` l'ajoute au dict policy → passé au
  bot via `--policy` (fichier temp existant, cf. piège #39).
- **Défaut / configurable** : placeholder `/kit` dans l'UI ; l'admin met `/kit`, `/kit starter`,
  `/kit armor`, etc. Vide = feature off.
- **Autorisation** : le `kit_command` configuré par l'admin est **explicitement autorisé** (comme
  `trade.acceptCmd`) — il n'a PAS besoin d'être aussi dans la whitelist générale de commandes ;
  le bot le lance directement. (Garde-fou : c'est une string admin-only du profil, jamais issue du
  chat/joueur.)
- **Frontend** : champ texte « Commande de kit (optionnel) » dans le formulaire de profil serveur
  (onglet ⚙ Serveurs), placeholder `/kit`. i18n FR/EN/IT. Cache-bust.

### 4.6 Décision kit pure (`kit.js`)

- `maybeRunKit({kitCommand, lastRunAt, now, cooldownMs=300000}) → {run:bool, reason}` (pur) :
  lance si `kitCommand` non vide ET (`lastRunAt` null OU `now - lastRunAt ≥ cooldownMs` local
  anti-spam, défaut 5 min). Le vrai cooldown serveur est géré best-effort (échec ignoré) ; le
  cooldown local évite juste de spammer la commande à chaque micro-respawn.
- Testé pur (config vide → run:false ; premier appel → run:true ; re-appel avant cooldown → false).

## 5. Tests

**Purs (`node:test`, fake bot / horloge injectée — modèle `mapper.test.js`) :**
- `shelter.test.js` : `roofPlan` choisit `inventory` si bloc dispo, `mine` sinon (avec pioche ou
  terrain-terre), `none` si rien ; `shouldShelter` déclenche sur obscurité (light≤7) même y<45.
- `dirt.test.js` : `needDirtBuffer` vrai sous le seuil, faux au-dessus.
- `kit.test.js` : `maybeRunKit` — off si vide, run au 1er appel, skip en cooldown.
- `mc_agent_servers` (pytest) : `resolve_policy` inclut `kit_command` (défaut `""`).

**Live (serveur test Hard `omen-minecraft-trusted-test`) :**
- Configurer `kit_command="/kit"` sur le profil ; relancer 2 mappeurs.
- **Morts/heure chutent drastiquement** (vs 13/20 min) ; les bots survivent aux nuits (abri
  auto-scellé) ; s'équipent via `/kit` (armure portée visible) ; **la carte grandit** (et à terme
  un `mapper_boat_cross` peut enfin se produire — validation de la feature bateau débloquée).

## 6. Risques & garde-fous

- **`/kit` cooldown serveur** : re-lancer à chaque respawn peut renvoyer « cooldown » → réponse
  ignorée (best-effort). Le cooldown LOCAL (§4.6) évite le spam.
- **Auto-scellage sans pioche sur terrain pierre** : la terre/gravier drop sans outil, mais la
  pierre non → le **buffer de terre** (§4.2) est le filet ; si vraiment rien, `no_roof` (le trou
  protège déjà des projectiles, réflexes ON) — dégradé, pas bloqué.
- **API lumière mineflayer** : vérifier `bot.world.getBlock(pos).light` (ou équivalent) au plan ;
  si indispo, fallback sur `isNight` + y-agnostic (retirer juste le « y<45 safe »).
- **Ne pas pusher pendant un grind** (#47e) ; recycler les mappeurs post-deploy.
- **`buildSystemPrompt(null)===SYSTEM_PROMPT`** doit rester vrai (invariant pinné #38-40) — ce
  chantier ne touche pas au schéma du prompt.

## 7. Critères d'acceptation

1. Un mappeur nu qui spawne de nuit / en grotte sombre **se met à l'abri auto-scellé** (mine son
   toit ou buffer de terre) et **survit** à la nuit — plus de death-loop immédiat.
2. Si `kit_command` configuré : le bot **lance `/kit` au démarrage et au respawn** puis **porte
   l'armure** reçue (`armorUp`).
3. Bouffe : le bot **mange** et régén ses PV (huntCookGoal best-effort).
4. **Aucun minage fer obligatoire** ajouté au mappeur.
5. Live : morts/heure fortement réduites, la carte grandit, la feature bateau redevient
   validable.
6. Tests Node + pytest verts ; parse-check ; invariant prompt intact ; aucune nouvelle dép ;
   auto-deploy propre ; cache-bust frontend.
