# MC Agent — Couche de commandes directes (déterministes, zéro-LLM)

> **Statut** : design validé (brainstorming 2026-06-01) — prêt pour le plan d'implémentation.
> **Branche** : `worktree-feat+mc-agent-direct-commands`
> **Phase MC Agent** : suite de #38 (commandes serveur) + #39 (gens de confiance).

---

## 1. Objectif

Donner au bot Minecraft un **jeu de commandes en anglais** que des joueurs de confiance lui
donnent **en message privé (`/msg`)** pour qu'il **agisse sans appeler le LLM** (économie de tokens
= objectif #1). Le LLM (clé API Claude) ne sert plus QUE à **discuter** — et il doit désormais
**se souvenir de la conversation**. On ajoute aussi : choix de la **langue** parlée par le bot au
profil, et **port** optionnel.

### Problème actuel
Aujourd'hui, **toute** action passe par `think()` (1 appel LLM par message adressé) : c'est le LLM
qui choisit `action`/`command`. Donner un ordre = brûler des tokens. Et `think()` est **sans
mémoire** (1 message → 1 réponse, rien retenu).

---

## 2. Décisions clés

### 2.1 Matrice de déclenchement du LLM (clé API)

| Canal | Message | Traitement | Appel LLM ? |
|---|---|---|---|
| `/msg` privé | **est** une commande connue (émetteur *trusted*) | exécution déterministe | **NON** |
| `/msg` privé | n'est **pas** une commande | réponse LLM **en `/msg`** | OUI |
| public | bot **nommé** (ex. « trainbot ») | réponse LLM **en public** | OUI |
| public | bot non nommé | ignoré | NON |
| `/msg` privé | commande mais émetteur **non-trusted** | ignoré en silence | NON |

→ La clé n'est consommée que dans 2 cas : *(/msg non-commande)* ou *(bot nommé)*.
→ Ceci **coïncide** avec le `decideReaction()` existant (`triggers.js`, `publicMode='mention'`),
auquel on ajoute simplement un **pré-filtre commande** sur le canal whisper.

### 2.2 Langue parlée
Champ `language` ∈ `{fr, en, it}` (défaut `fr`) au **profil serveur**. Injecté dans le system
prompt du LLM → le bot écrit ses `reply` dans cette langue. Les **acks** des commandes
(`done`/`fait`/`fatto`) suivent la même langue.

### 2.3 Mémoire de conversation
Le LLM garde un **historique par joueur** (fenêtre glissante bornée + TTL d'inactivité) pour
suivre un fil. Les commandes déterministes **n'entrent pas** dans cet historique et ne consomment
rien.

### 2.4 Port optionnel
Le champ port n'est plus obligatoire côté UI (placeholder au lieu de `value`). Vide → `25565`
(défaut déjà géré côté backend + `|| 25565` front).

### 2.5 Conversation = LLM peut toujours agir
Quand le LLM répond (cas 2.1 où il est appelé), il **conserve** le droit de renvoyer
`action`/`command` (comportement actuel, gaté par la confiance). Les commandes déterministes
sont une **voie rapide additionnelle**, pas un remplacement.

---

## 3. Catalogue des 16 commandes

Toutes en **anglais**, parsées **uniquement sur whisper (`/msg`)**, **muettes en chat** (retours
en `/msg` privé à l'émetteur — voir §7). Insensibles à la casse. Émetteur non-trusted (liste
non vide) → ignoré.

| # | Grammaire | Effet | Ack privé |
|---|---|---|---|
| 1 | `take <bloc> [n]` | Récolte n× (défaut 1) le bloc le + proche (rayon ~48). **Meilleur outil auto par bloc** + **auto-défense**. | `done` à la fin |
| 2 | `follow me` | Suit l'émetteur en continu. | — |
| 3 | `stop` | Annule la tâche active → **loiter vivant** (§5.6). | — |
| 4 | `craft <objet> [n]` | Fabrique n× l'objet (table proche si besoin). | échec si pas de recette/ingrédients |
| 5 | `give <objet>` | Jette **tout** de cet objet vers l'émetteur. | échec si rien |
| 6 | `pvp <joueur>` | Attaque ce joueur avec la **meilleure arme**. | échec si joueur invisible |
| 7 | `tpa <joueur\|me>` | Tape `/tpa <cible>` serveur (`me` = émetteur). Soumis à la whitelist serveur (#38). | — |
| 8 | `mine down <n>` | Creuse vers le bas n blocs (outil auto), garde-fou lave/vide. | `done` / échec |
| 9 | `come` (`come here`) | Va **une fois** à la position de l'émetteur (sans suivre). | — |
| 10 | `deposit` | Dépose tout l'inventaire dans le **coffre le + proche**. | `done` / échec si pas de coffre |
| 11 | `guard` | Boucle : tue les mobs hostiles autour jusqu'à `stop`. | — |
| 12 | `give all` | Jette **tout** l'inventaire vers l'émetteur. | `done` |
| 13 | `equip <objet>` | Équipe un objet précis (arme/outil/armure). | échec si absent |
| 14 | `eat` | Mange maintenant un aliment de l'inventaire. | échec si pas de nourriture |
| 15 | `goto <x> <y> <z>` | Va aux coordonnées. | `done` à l'arrivée |
| 16 | `afk` | Se **fige** (plus de mouvement volontaire ni loiter). Réflexes survie **ON**. Tape `/afk` serveur **si coché**. | — |

**`take`/`mine down`** : tout échec (bloc introuvable, etc.) → whisper privé, jamais public.
**Idées gardées pour plus tard** (hors-scope v1) : `sleep`, `drop <objet> <n>`, `look at me`.

---

## 4. Architecture

### 4.1 Nouveaux modules (petits, isolés, testables)

| Fichier | Rôle | Pur ? |
|---|---|---|
| `mc-agent/orders.js` | **Parseur** `parseOrder(text) → {verb,args}\|null` + table de dispatch `verb → handler`. Distinct de `commands.js` (whitelist serveur). | Oui (parseur) |
| `mc-agent/tools.js` | `bestToolFor(bot, block)` (pioche/pelle/hache/cisaille selon matériau, meilleur palier dispo) ; `bestWeapon(bot)` (arme melee + de dégâts). | Quasi (lit inventaire+registry) |
| `mc-agent/tasks.js` | **Contrôleur de tâche active** : 1 tâche longue à la fois, flag d'annulation + cleanup (clear goal/pvp/intervals). `stop`/`afk`/nouvelle commande l'annulent. | Oui (logique état) |
| `mc-agent/memory.js` | Historique conversation **par joueur**, fenêtre + TTL (horloge injectable comme `RateLimiter`). | Oui |
| `mc-agent/skills/gather.js` | Le `take` intelligent (§5.1). | Non (bot) |
| `mc-agent/skills/mineDown.js` | `mine down` (§5.4). | Non |
| `mc-agent/skills/guard.js` | `guard` (§5.5). | Non |
| `mc-agent/skills/give.js` | `give <objet>` / `give all` (toss). | Non |
| `mc-agent/skills/craft.js` | `craft`. | Non |
| `mc-agent/skills/deposit.js` | `deposit` coffre. | Non |
| `mc-agent/skills/equip.js` | `equip <objet>` + `eat`. | Non |
| `mc-agent/skills/loiter.js` | Mode loiter de `stop` (§5.6). | Non |

**Réutilisés** : `skills/follow.js` (follow me), `skills/goto.js` (come, goto), `skills/attackNearest.js`+`mineflayer-pvp` (pvp/guard), `reflexes.js` (survie, dont `tryEat` pour `eat`), `skills/say.js`.

### 4.2 Branchement dans `index.js`

`handleIncoming(username, message, isWhisper)` — **nouveau pré-filtre** placé AVANT
`decideReaction`/`think` :

```
si isWhisper:
    order = parseOrder(message)
    si order:
        si trusted(username) [ou liste vide]:
            emit {type:'order', verb, by:username}
            executeOrder(order, username)   # déterministe, 0 LLM
            (ack/échec → ackPrivate via bot.whisper(username, ...))
        sinon: emit {type:'order_ignored', by:username}   # silence
        return   # ne descend PAS vers le LLM
# sinon (pas une commande, ou message public) → flux LLM existant (avec mémoire)
```

`executeOrder` route via la table de dispatch d'`orders.js` ; les ordres longs passent par
`tasks.js` (annulables). Les ordres instantanés (`give`, `equip`, `eat`, `tpa`) s'exécutent direct.

### 4.3 Flux conversation (inchangé sauf mémoire + langue)
`decideReaction` → si réaction → `think(client, {..., history, lang})` → `gateDecision` →
`humanizeReply` → reply (public `say` ou privé `whisper` selon le canal) + `runAction`/`runCommand`.
Après la réponse : `memory.append(sender, 'user', message)` + `memory.append(sender, 'assistant', reply)`.

---

## 5. Comportements intelligents (détaillés)

### 5.1 `take <bloc> [n]` — récolte + outil auto + auto-défense
1. `findBlock` du type voulu (rayon ~48). Introuvable → ack échec.
2. Pour chaque bloc (jusqu'à n) : `bestToolFor(bot, block)` → `bot.equip(tool,'hand')` → `collectBlock.collect`.
   - L'outil est **ré-évalué par bloc** → terre=pelle, pierre/minerai=pioche, bois=hache automatiquement.
3. **Auto-défense** : avant/à chaque itération, si un mob hostile est dans ~4 blocs →
   `bestWeapon` + `pvp.attack` jusqu'à neutralisation/éloignement, puis **reprend** la récolte.
4. Réflexes existants (fuir PV bas / manger) restent actifs en parallèle.
5. Fin → `ackPrivate('done')` (langue du profil).

### 5.2 `bestToolFor(bot, block)` — heuristique (tools.js)
- **axe** : `*_log`, `*_wood`, `*_planks`, etc.
- **shovel** : `dirt`, `grass_block`, `sand`, `gravel`, `clay`, `soul_*`, `*_concrete_powder`, neige.
- **pickaxe** : pierre/minerais/`cobble*`/`deepslate*`/`*_ore`/`obsidian`/métal.
- **shears** : `*_leaves`, `cobweb`, laine (sinon épée/main).
- défaut → main.
- Palier choisi = le + haut **présent dans l'inventaire** : `netherite > diamond > iron > stone > golden > wooden`.
- Implémentation robuste : matcher par **nom de bloc** + (si dispo) `block.material`. Tests avec registry mocké.

### 5.3 `pvp` / `equip` / `bestWeapon`
- `bestWeapon(bot)` = item melee au + haut score (épée > hache, par palier). `pvp` équipe puis `pvp.attack(playerEntity)`.
- `equip <objet>` = match par nom (`bot.inventory.items()`), équipe au bon slot (`hand` / armure auto-détectée).

### 5.4 `mine down <n>`
Boucle n fois : équipe l'outil adapté au bloc **sous les pieds** → creuse. Garde-fous : stop si
bloc dangereux dessous (`lava`, `water`) ou vide (chute) → ack échec « danger sous moi ».

### 5.5 `guard`
Tâche longue (`tasks.js`) : cible le mob hostile le + proche → `bestWeapon` + `pvp.attack` ;
quand mort/parti, re-cible. S'arrête à `stop`/`afk`/nouvelle commande.

### 5.6 `stop` → loiter vivant (anti-tell #1)
Annule la tâche active, puis boucle idle (zéro LLM) qui alterne aléatoirement avec pauses variables :
- petit `bot.look` G/D (+un peu haut/bas) ;
- quelques pas dans une direction aléatoire **en restant dans ~2-3 blocs** du point d'arrêt (ne dérive pas) ;
- toggle **sneak** (accroupi/pas) de temps en temps ;
- parfois ne rien faire quelques secondes.
- **Intensité ∝ profil** (`params.movementJitter` + latence déjà présents dans les profils).
- Interrompu par toute nouvelle commande ou un réflexe (fuir/manger).

### 5.7 `afk`
- Annule tâche active **et** loiter → **aucun mouvement volontaire** (pas de pas, look, sneak).
- **Réflexes survie ON** (fuir PV bas/creeper, manger) → reste immobile mais ne meurt pas bêtement.
- Tape `/afk` serveur **si `/afk` est coché** dans la whitelist (#38) — sinon juste se figer.
- Sort de l'AFK dès qu'une autre commande arrive.

---

## 6. Mémoire de conversation (`memory.js`)

- Store en mémoire : `Map<usernameLower, {turns:[{role,content}], lastTs}>`.
- `getHistory(user)` → tableau de messages `{role,content}` (bornés aux N derniers).
- `append(user, role, content)` → ajoute + tronque à `maxTurns` (ex. **8 messages** = ~4 échanges).
- **TTL** : à chaque accès, si `now - lastTs > TTL` (ex. **10 min**) → on **réinitialise** le fil (oubli).
- Horloge injectable (`now = () => Date.now()`), comme `RateLimiter`, pour tests déterministes.
- `think()` gagne un param `history` → inséré dans `messages` **avant** le tour courant.
  Le `state`/`De:` restent attachés au dernier message user.

**Arbitrage coût (assumé)** : l'historique grossit le prompt → plus de tokens/appel. Borné par
fenêtre + TTL ; le `RateLimiter`/min protège toujours. C'est le prix explicite de « il n'oublie pas ».

---

## 7. Acks privés (retour des commandes)

- **Tout** retour part en **`/msg` privé à l'émetteur** via `ackPrivate(bot, sender, text)` =
  `bot.whisper(sender, text)`. **Jamais** de chat public. (Un whisper = **zéro token LLM** :
  l'interdit « ne me réponds pas » de l'utilisateur visait l'appel LLM, pas un ack local.)
- **Politique d'ack** (déterministe, non négociable) :
  - **Tâche qui se termine** (`take`, `mine down`, `deposit`, `goto`, `give all`) → whisper `done`.
  - **Commande continue ou instantanée** (`follow me`, `come`, `stop`, `afk`, `guard`, `pvp`,
    `equip`, `eat`, `give`, `craft`, `tpa`) → **silencieux** si succès.
  - **Tout échec** (bloc/objet/recette/coffre introuvable, joueur invisible, danger…) → whisper la raison.
- `done` localisé : `fr=fait`, `en=done`, `it=fatto`.
- Les skills renvoient un **résultat structuré** `{ok:boolean, reason?:string}` ; c'est `orders.js`
  qui décide du whisper. Les `bot.chat('je ne trouve pas…')` publics des skills existants sont
  **neutralisés** quand invoqués via la couche commandes (param `quiet`/résultat retourné).

---

## 8. Backend & profil serveur

### 8.1 `mc_agent_servers.py`
- `_clean_server` : ajoute `language` → valide ∈ `("fr","en","it")`, défaut `"fr"`.
- `resolve_policy` reste **inchangé** (`{trusted, trade}`). La langue est lue **directement**
  depuis `srv["language"]` dans `/run` (pas de resolver dédié) → simple.
- Le port reste borné `[1,65535]` défaut 25565 (déjà OK).

### 8.2 `mc_agent_router.py`
- `ServerPayload` : `language: str = "fr"`.
- `StartReq` : `language: str = "fr"` (lancement rapide). Le `/run` via `server_id` reprend
  `srv["language"]` (le profil serveur prime sur le défaut).

### 8.3 `mc_agent_manager.py`
- `start_session(..., language="fr")` → ajoute `--lang <language>` à la ligne de commande Node.

### 8.4 `mc-agent/index.js` & `brain.js`
- `index.js` lit `args.lang` (défaut `fr`) → passe `lang` à `think()`.
- `brain.js` : `buildSystemPrompt(profile, commandDocs, trustDocs, langDocs)` ajoute une phrase
  « Écris le champ "reply" en <langue>. » **uniquement si profil présent**.
  - **INVARIANT pinné** : `buildSystemPrompt(null) === SYSTEM_PROMPT` (pièges #38/#39) — inchangé.
- `think(client, {..., history=[], lang='fr'})`.

---

## 9. Frontend & i18n

- `frontend/js/bots_module.js` :
  - `mca-port` et `mca-e-port` : retirer `value="25565"` → `placeholder="25565"`.
  - Formulaire profil : `<select>` **Langue** (FR/EN/IT) lié à `e.language` ; inclus dans le payload.
  - **Panneau d'aide « Commandes »** : liste les 16 commandes (référence pour l'utilisateur), avec
    rappel « commandes en /msg, en anglais ».
- `frontend/js/lang.js` : clés i18n FR/EN/IT pour le label Langue + l'aide commandes.
- **Cache-bust** : bumper `?v=` de `bots_module.js`/`lang.js` dans `index.html` + `CACHE_NAME` dans `sw.js`.

---

## 10. Invariants & contraintes

1. `buildSystemPrompt(null) === SYSTEM_PROMPT` reste vrai (test pinné).
2. Gating gens-de-confiance : liste vide = tout le monde commande (rétro-compat #39).
3. Aucune **nouvelle dépendance Node** (réutilise mineflayer/pathfinder/pvp/collectblock).
4. Aucune **dépendance runtime** ajoutée côté Omen (backend = stdlib).
5. Les commandes longues sont **annulables** (1 seule active via `tasks.js`).
6. Les retours commandes ne polluent **jamais** le chat public.

---

## 11. Plan de tests (TDD)

### Node (`mc-agent/test/`)
- `orders.test.js` : `parseOrder` pour chaque verbe ; args (`take dirt 10`, `take dirt` n=1,
  `mine down 5`, `goto 10 64 -20`, `tpa me`, `follow me`, `give all` vs `give dirt`,
  `come here`) ; casse ; inconnu → `null` ; phrase conversationnelle → `null`.
- `tools.test.js` : `bestToolFor` (dirt→shovel, stone/ore→pickaxe, log→axe, leaves→shears,
  inconnu→hand) avec registry+inventaire mockés ; palier (diamant choisi vs fer présents) ;
  `bestWeapon` (palier + épée>hache).
- `tasks.test.js` : 1 tâche active à la fois ; `cancel()` exécute le cleanup ; nouvelle tâche
  annule la précédente.
- `memory.test.js` : fenêtre (tronque à maxTurns) ; TTL (reset après expiration, horloge mockée) ;
  isolation par joueur.
- `brain` : pin `buildSystemPrompt(null) === SYSTEM_PROMPT` ; `langDocs` ajouté si profil ;
  `think` insère `history`.
- `give`/`craft`/`equip`/`deposit` : parties décidables (matching item, slot d'équipement) avec bot mocké.

### Python (`backend/bots/tests/`)
- `_clean_server` : `language` validé/défaut ; resolve expose `language`.
- `router` : `ServerPayload.language` ; `/run` via `server_id` passe la langue.
- `manager` : `start_session(language=…)` ajoute `--lang`.

### Smoke / manuel
Les skills mineflayer-lourds (gather boucle réelle, guard, loiter, deposit chest) validés en
smoke (serveur de test) ; la logique pure est couverte par les tests unitaires.

---

## 12. Hors-scope (v1)

- Pas de strip-mining/exploration auto pour trouver un minerai enfoui (`take diamond` ne marche
  que si le minerai est à portée — le scénario diamant est servi par `mine down`).
- Pas de `sleep`/`drop <n>`/`look at me` (gardés pour une itération ultérieure).
- Pas de file d'attente de commandes (1 tâche active ; une nouvelle annule l'ancienne).

---

## 13. Risques & pièges (→ futur piège #40)

- **Backtick/`/msg` format serveur** : si le serveur route les messages privés autrement que
  l'event `whisper` mineflayer (formats Essentials localisés), le pré-filtre commande peut ne pas
  voir le /msg → échec silencieux. Fournir le format exact au besoin (cf. #39 pour les TP).
- **Mémoire = coût** : surveiller la taille de fenêtre si les tokens grimpent.
- **`sneak`/pathfinder** : le loiter ne doit pas combattre le pathfinder (clear goal avant de bouger à la main).
- **Auto-deploy ne réinstalle pas les deps** (#33) — ici pas de nouvelle dep, donc OK.
