# MC Agent — Architecture du planner autonome (Phase 3) — design

> **Brainstorm validé par Massii le 02/06/2026.** Ce document conçoit le **moteur autonome** qui consomme les 5 specs de recherche/design du 02/06 (diamant/netherite, ressources/craft-anything, XP/enchant, réalisme-combat, find/build). Objectif : un bot mineflayer qui **poursuit des objectifs en autonomie** (à commencer par « zéro → pioche en pierre »), **~0 token**, **sans réécrire** le bot réactif existant.

---

## 0. Contexte & contraintes

- **Existant** : Phase 1 (réactif : profils, `reflexes.js`, `humanize.js`) + **couche commandes directes #40** (`orders.js`, `tasks.js`/`taskCtl`, 16 commandes, `trust.js`, `commands.js`, `memory.js`) + `brain.js` (LLM social + `RateLimiter`) + `skills/` (gather, mineDown, craft, equip, eat, goto, deposit, guard, give, follow, loiter, attackNearest, fleeFrom).
- **Serveur de test** : dédié **10 Go auto-hébergé** (Paper + Essentials), **jetable**, **sans anti-cheat** au début (Grim à la phase réalisme). **AuthMe** (login par mot de passe). Runtime sur l'Omen (`node` confirmé installé ; `npm install` mineflayer à faire).
- **Contrainte #40** : ne pas griller la clé LLM → la boucle autonome tourne **~0 token**.
- **Contrainte infra** : **reboot nocturne de l'Omen** + **redeploy auto/min** tuent le subprocess du bot → **tout état utile doit être persisté** (sinon oubli total à chaque cycle).

## 1. Philosophie d'intégration — pas de réécriture

`taskCtl` (#40) gère déjà « **une seule tâche longue annulable** ». On s'appuie dessus :
- Le **but autonome = la tâche par défaut** (priorité basse) : elle se (re)lance dès qu'aucune commande n'est active.
- Une **commande directe préempte** : annule la tâche autonome → exécute la commande → le planner **se relance et re-dérive** depuis l'état courant (pas de « resume » compliqué — il regarde l'inventaire/le monde et choisit le prochain but).
- Les **réflexes de survie** restent au-dessus de tout (déjà le cas).
- Le **chat social** tourne en parallèle (parler ≠ occuper le corps).

→ On ajoute une **couche**, on ne réécrit pas le réactif.

## 2. Couches du bot (du bas/connexion vers le haut)

| Couche | Rôle | LLM ? |
|---|---|---|
| **0. Auth bootstrap** | passer le login AuthMe avant tout (cf. §4) | non |
| **1. Réflexes survie** | manger / fuir / se défendre (existant) | non |
| **2. Arbitrage (`taskCtl`)** | réflexes > commande directe (préempte) > but autonome (défaut) | non |
| **3. Planner autonome** | boucle de buts vers l'objectif (cf. §3) | escalade rare |
| **4. Chat social** | répondre quand nommé/adressé (existant) | oui (séparé) |

## 3. Les 4 pièces d'architecture (décisions verrouillées)

### 3.1 Arbitrage de modes — pile de priorités + préemption
Voir §1/§2. Réflexes > commande directe > but autonome ; chat en //. Démarrage du but autonome via une commande (ex. `mine diamonds` / `start <objectif>`) ou le dashboard ; arrêt = `stop`/`afk` (déjà câblés). La préemption réutilise l'annulation de `taskCtl` ; la reprise = re-dérivation.

### 3.2 Modèle du monde — persistance JSON + verify-before-trust
Fichier **`data/mc_agent_world_<server>.json`** (même esprit que `power_schedule.json` / `mc_agent_servers.json`), contenant :
```
{
  "home":     { "pos": {x,y,z}, "dimension", "homeChest": {x,y,z} },
  "chests":   [ { "pos": {x,y,z} } , ... ],     // registre auto-scanné (cf. §5)
  "waypoints":[ { "name", "pos" } , ... ],      // structures trouvées (find), etc.
  "objective":{ "type", "args", "status" }      // objectif courant (survit au restart)
}
```
- **Persisté** → survit aux reboots nocturnes + redeploys (sinon en RAM = oubli).
- **verify-before-trust** : avant d'utiliser une position mémorisée (coffre, structure, home), le bot **re-vérifie qu'elle existe** ; sinon il la retire de la mémoire. Anti-données-périmées.
- Minimal (pas d'historique complet). **Les secrets (mot de passe AuthMe) ne sont PAS ici** (cf. §4).

### 3.3 Récupération mort / déconnexion — reprise simple + garde-fou
- **Déconnexion** (reboot/redeploy/réseau) → **auto-reconnect** + recharge le JSON → le planner reprend l'objectif.
- **Mort** → respawn ; le planner **re-dérive** (inventaire réduit → re-craft/re-récolte les préconditions manquantes). Pour le MVP (outils cheap), **items tombés abandonnés**.
- **Garde-fou anti-boucle de mort** : N morts en M min (défaut **3 / 10 min**) → **stop + notifie l'admin** (ne pas boucler en mourant/gaspillant).
- **Plus tard** (gear cher diamant/netherite) : récupération des items au point de mort (coords + fenêtre 5 min).

### 3.4 Budget LLM — déterministe + escalade rare plafonnée + fallback
- Boucle autonome **~0 token** en régime normal (tech-tree fixe + heuristiques en dur : fuir/combattre = seuils HP, choix d'arme = table spec réalisme).
- **Escalade LLM uniquement aux vraies impasses** (échec répété sans résolution déterministe), **rate-limitée** (limiteur dédié, ex. quelques appels/h), réutilise la classe `RateLimiter`.
- **Budget épuisé → fallback déterministe** : abandonne le sous-but / tente l'alternative codée / notifie — **le bot continue**, il ne s'arrête pas.
- Chat social = LLM séparé, limiteur existant inchangé.

## 4. Auth bootstrap (AuthMe)

Brique de **cycle de vie** dans `index.js`, exécutée **avant** réflexes/planner/commandes (le joueur est figé tant qu'il n'est pas loggé).
- À la connexion : tenter `/login <pw>` si un mot de passe est stocké ; sinon (1ʳᵉ fois) **générer un mot de passe aléatoire fort** → `/register <pw> <pw>` → le **persister**. (Détection possible via le prompt de chat AuthMe.)
- **Succès → seulement là** on active le reste du bot. **Échec** (mauvais pw / register refusé) → notifie l'admin, ne pas spammer.
- **Format** : viser AuthMe par défaut (`/register <pw> <pw>`, `/login <pw>`) ; **chaînes exactes à confirmer au runtime** (format localisé/custom = échec silencieux possible, cf. #39/#40) → paramétrable par profil serveur.
- **Stockage du credential (sécurité, décision pinée)** : le mot de passe est **celui du compte du bot lui-même**. Il est stocké dans le **profil serveur `data/mc_agent_servers.json`** (qui porte déjà l'auth du compte du bot → un seul endroit pour les creds serveur), champ dédié `authmePassword`. **gitignored** (`data/` l'est déjà) + **perms restreintes (chmod 600)** posées à l'écriture. **JAMAIS** dans le `worldModel` (secrets ≠ état de jeu), **ni** dans le vault, **ni** dans ma mémoire, **ni** dans les logs.

## 5. Home & stockage

- **Nouvelles commandes directes** : `sethome` (enregistre la position courante comme `home`), `home` (y retourner). Ajoutées à la couche #40 (gated trust, whisper acks).
- **Auto-scan au `sethome`** : le bot enregistre **tous les coffres dans un rayon** (défaut **16-32 blocs**) comme son **réseau de stockage** ; le `homeChest` = le plus proche. **Ajouter du stockage = poser un coffre près du home** (re-scan).
- **Deposit / overflow** : quand l'inventaire déborde (gros minage, dégagement de `build`), le bot range dans le `homeChest` puis les autres coffres connus (+ shulkers, cf. spec find/build §5). Réutilise le `deposit` existant.
- `find`/`build` consomment aussi le registre de coffres (build cherche ses matériaux dedans).

## 6. Élytre (phase navigation ultérieure — PAS MVP)

- Capacité de **déplacement longue distance** : si le bot a une **élytre + fusées**, il vole au lieu de marcher pour les longs trajets (`find`, `come`, `goto` lointains, retour `home`).
- ⚠️ **Engineering** : (a) le pathfinder est **au sol** → il faut un **plugin élytre mineflayer** (à vérifier/choisir, possible nouvelle dép) ; (b) **Grim surveille l'élytre** (checks de vol) → le vol doit **respecter la physique élytre** (réaliste). → Donc l'élytre arrive avec la **phase navigation/réalisme**, après que le moteur tourne.

## 7. Composants (modules bornés, testables isolément)

| Module | Fait quoi | Dépend de | Testable |
|---|---|---|---|
| `goals.js` | graphe de buts (MVP : chaîne bois→pioche pierre), chaque but = `{precondition(state), effect, skill, args}` | — (données + prédicats purs) | ✅ TDD pur |
| `planner.js` | boucle : choisit le prochain but dont la précondition est vraie → dispatch son skill → répète jusqu'à l'objectif ; gère l'escalade LLM rare + fallback | `goals`, état (mock bot) | ✅ TDD pur |
| `worldModel.js` | load/save JSON (home/coffres/waypoints/objectif) + helpers verify-before-trust + auto-scan coffres | fs, bot (lecture monde) | ✅ logique pure (I/O mockée) |
| `craftResolver.js` | version minimale du résolveur craft-anything (spec ressources) : item → sous-buts d'acquisition, pour la chaîne MVP | `minecraft-data` recipes | ✅ TDD pur |
| auth bootstrap | login AuthMe + cred store (dans `index.js` ou `auth.js` dédié) | bot, secrets store | partiel (parse prompt) |
| arbitrage + résilience | préemption + reconnect + garde-fou morts (dans `index.js`) | `taskCtl`, planner | live surtout |
| **réutilisés tels quels** | `gather`, `tools.js`, `tasks.js`, `reflexes.js`, `brain.js`/`RateLimiter`, `trust.js`, `commands.js` | — | déjà testés |

## 8. MVP — « zéro → pioche en pierre, en autonomie »

**Chaîne de buts** : bois → planches → établi → bâtons → pioche bois → cobblestone → pioche pierre.

**Critères de succès (la démo live)** :
1. ✅ Le bot enchaîne les buts seul, de l'inventaire vide à une pioche en pierre.
2. ✅ On tape `come` en plein milieu → il vient → puis **reprend** tout seul (préemption + reprise).
3. ✅ On **restart** le bot en plein run → il **recharge** le JSON et continue (persistance).
4. ✅ Il **meurt** → respawn → **re-dérive** (re-craft ce qui manque) (résilience).
5. ✅ Sur tout le run : **~0 token LLM** (budget).
6. ✅ Il a dû **passer le login AuthMe** pour se connecter (auth bootstrap).

## 9. Phasage

`auth + connexion` → **MVP (boucle planner)** → `home/stockage` → `diamant` → `netherite` → `find` → `build` (+ deps schématiques) → `nav élytre` → `combat/PvP` → `couche réalisme (Grim)` → `clone 1b`. Chaque phase consomme une spec déjà écrite.

## 10. Tests

- **TDD pur-logique** (mock bot, comme l'existant Node) : `goals.js`, `planner.js`, `worldModel.js`, `craftResolver.js`, parsing `sethome`/`home`.
- **Validation live** sur le serveur de test : `gather`, auth, préemption, persistance-au-restart, recovery-mort, et les 6 critères §8.

## 11. À confirmer au runtime (open items)

- **Chaînes exactes AuthMe** (`/register`/`/login` + prompt) — paramétrables par profil.
- **Formats Essentials** `/msg`, `/tpa` du serveur (pièges #39/#40) — pour la préemption par commande + le `home`.
- **`npm install`** sur l'Omen : `mineflayer`+plugins (Phase 1, déjà requis) ; plus tard `prismarine-schematic`+`mineflayer-schem` (build) + plugin élytre. L'auto-deploy ne réinstalle pas (#33).
- **Wipe + recréation du serveur 10 Go** (Paper + Essentials + AuthMe) — à l'étape runtime, avant le MVP.

## 12. Hors-scope (déjà spécifiés, branchés après le MVP)

diamant/netherite (lave/profondeur/Warden), `find`, `build` (+ schématiques/deps), combat/PvP, couche réalisme/anti-détection (Grim), récupération d'items au point de mort, navigation élytre, clone comportemental 1b. Tout est couvert par les 5 specs du 02/06 ; on les branche une fois le moteur validé.
