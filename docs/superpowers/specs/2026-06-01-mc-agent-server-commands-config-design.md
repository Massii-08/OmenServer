# MC Agent — Onglet Config : profils serveur + commandes disponibles

> **Statut** : design validé (Massii, 2026-06-01) — prêt pour le plan d'implémentation.
> **Périmètre** : MC Agent (`mc-agent/` + `backend/bots/mc_agent_*` + `frontend/js/bots_module.js`).

---

## 1. Problème / contexte

Le MC Agent est un bot d'entraînement de modération (mineflayer, lancé en subprocess par le
backend). **Aujourd'hui il ne tape aucune commande serveur** : son cerveau LLM (`brain.js`) ne
produit qu'un `reply` (envoyé via `bot.chat`) + une `action` parmi des skills internes
(`follow`, `goto`, `mineBlock`, `attackNearest`, `fleeFrom`).

Massii joue sur **plusieurs types de serveurs** dont les commandes diffèrent (un Paper+Essentials
expose `/msg /tpa /home /warp…`, un Vanilla quasi rien). Il veut :

- **Donner au bot la capacité** d'utiliser les commandes **disponibles** sur le serveur courant
  (ex. `/home`, `/tpa <joueur>`, `/msg <joueur> <texte>`) quand c'est pertinent ;
- **L'empêcher** d'utiliser une commande **absente** (sinon erreur visible dans le chat = le bot
  se grille). → **capacité + garde-fou**.

La config doit être un **profil serveur réutilisable** (pas une re-saisie à chaque lancement),
regroupant connexion + niveau d'« intelligence » + commandes cochées.

## 2. Objectifs / non-objectifs

**Objectifs**
- Catalogue de commandes courantes (Essentials/SMP) pré-décrites, cochables.
- Ajout de commandes **custom** (serveurs avec commandes maison).
- **Profils serveur** nommés, persistés, réutilisables : nom + host/port + compte/auth +
  intelligence + commandes cochées + customs.
- Le bot **connaît** les commandes dispo (prompt) et **ne peut envoyer que celles-là** (filtre).
- UI intégrée à la carte MC Agent, tout **admin-only**.

**Non-objectifs (YAGNI / plus tard)**
- Auto-détection des commandes du serveur (tab-complete `/…`) → future amélioration, peu fiable.
- Nouveaux paliers d'« intelligence » → on réutilise les 3 profils existants.
- Nouvelles skills mineflayer (pathfinding maison de téléportation, etc.) : inutile, le serveur
  exécute la commande, le bot ne fait que la **taper**.

## 3. Modèle de données

### 3.1 Catalogue de commandes (prédéfini, source unique)

Fichier livré dans le repo : `mc-agent/commands-catalog.json`. Tableau d'objets :

```json
{ "id": "tpa", "cmd": "/tpa", "syntax": "/tpa <joueur>",
  "desc": "Demande à se téléporter vers un joueur", "category": "teleport" }
```

- `id` : identifiant stable (slug, sert de clé dans les profils).
- `category` ∈ { `communication`, `teleport`, `economy`, `status` } (pour grouper l'UI).
- ~20 commandes de départ :
  - **communication** : `/msg`, `/r`, `/me`, `/mail`
  - **teleport** : `/tpa`, `/tpahere`, `/tpaccept`, `/tpdeny`, `/home`, `/sethome`, `/spawn`,
    `/warp`, `/back`, `/rtp`
  - **economy** : `/pay`, `/balance`
  - **status** : `/afk`, `/list`, `/seen`

Le **backend** lit ce fichier et le sert à l'UI ; au lancement il résout les ids cochés d'un
profil → objets complets (cmd+syntax+desc) écrits pour le bot.

### 3.2 Profils serveur (créés par l'utilisateur, persistés)

Fichier : `data/mc_agent_servers.json` (gitignored via `data/`, pattern existant clé API /
power_schedule.json). Liste d'objets :

```json
{
  "id": "a1b2c3",
  "name": "Paper Essentials",
  "host": "play.exemple.net",
  "port": 25565,
  "user": "TrainBot",
  "auth": "offline",
  "intelligence": "expert",
  "commands": ["msg", "r", "tpa", "tpaccept", "home", "spawn"],
  "custom": [
    { "cmd": "/kit", "syntax": "/kit <nom>", "desc": "Récupère un kit de départ" }
  ]
}
```

- `id` : slug généré côté backend (alphanum, anti path-traversal — validé strict).
- `intelligence` ∈ { `evident`, `intermediaire`, `expert` } = **profils de comportement
  existants** (`mc-agent/profiles/`, labels Évident/Intermédiaire/Expert). Aucun nouveau système.
- `commands` : ids du catalogue cochés.
- `custom` : commandes maison (objet complet, car absentes du catalogue).
- `auth` ∈ { `offline`, `microsoft` } (comme aujourd'hui).

## 4. Côté bot — capacité + garde-fou

### 4.1 Passage des commandes au subprocess
`mc_agent_manager.start_session(...)` :
1. Résout la whitelist effective = objets catalogue des `commands` cochés **+** `custom`.
2. Écrit cette liste dans un fichier temp dédié (ex. `data/mc_agent_runs/cmds-<sid>.json` —
   dossier propre au bot, à ne PAS confondre avec `data/servers/` des serveurs de jeux).
3. Ajoute `--commands <path>` à la ligne de commande Node (à côté de `--profile`).
4. Nettoie le fichier à `stop_session` (best-effort).

### 4.2 Injection dans le cerveau (`brain.js`)
- `buildSystemPrompt(profile, commands)` ajoute un bloc :
  > « Commandes serveur disponibles (utilise-les UNIQUEMENT quand c'est pertinent, et **jamais**
  > d'autre commande) : `/tpa <joueur>` — demande tp ; `/home [nom]` — … . Pour exécuter une
  > commande serveur, mets-la dans le champ `command`. »
- Le schéma de décision LLM gagne un champ **optionnel** `command` (string, ex. `"/tpa Bob"`).
  `parseDecision` l'extrait (string sinon `null`).
- `runAction`/boucle d'`index.js` : si `decision.command` présent **et autorisé**, l'envoyer via
  `bot.chat(command)`.

### 4.3 Garde-fou (`mc-agent/commands.js`, logique pure, testable sans client MC)
- `loadCommands(path)` → liste normalisée (ou `[]`).
- `isAllowed(text, whitelist)` : extrait le 1er token `/<cmd>` ; renvoie `true` ssi `cmd` ∈ whitelist.
  Un texte qui ne commence pas par `/` est du chat normal → toujours autorisé.
- `buildCommandDocs(whitelist)` : génère le bloc texte pour le prompt.
- **Double sécurité** : le prompt borne le LLM **et** tout `/…` sortant non whitelisté est **bloqué
  + loggé** (event `{type:'blocked_command', cmd}`) au lieu d'être envoyé. Couvre `command` ET un
  éventuel `/…` qui se glisserait dans `reply`.

Module pur (pas d'`import` mineflayer) → testable en `node:test` sans serveur MC, façon piège #35.

## 5. UI — carte MC Agent (`bots_module.js`)

Mini sélecteur **2 onglets** en haut de la carte (admin) : **▶ Lancer** | **⚙ Serveurs**.

- **▶ Lancer** (vue actuelle + 1 ajout) : un `<select>` **« Profil serveur »** en tête ; le choisir
  pré-remplit host/port/compte/auth/intelligence. « — Manuel — » garde la saisie libre actuelle.
  Le `/run` envoie alors `server_id` (ou les champs manuels).
- **⚙ Serveurs** : liste des profils (carte par profil : nom, host:port, intelligence, n commandes)
  + actions **Éditer / Supprimer / Nouveau**. L'éditeur :
  - champs nom / host / port / compte / auth / dropdown intelligence (3 profils) ;
  - **checklist de commandes groupée par catégorie** (cases à cocher, label = `cmd` + `syntax`) ;
  - zone **« + commande custom »** (cmd, syntax, desc) ;
  - Enregistrer / Annuler.

i18n FR/EN/IT (clés `mcagent.cfg.*`). Cache-bust `?v=` + `sw CACHE_NAME` (piège #9/#11).
Le `rectester` ne voit **pas** cet onglet (vue réduite inchangée, cohérent #37).

## 6. Endpoints (backend `mc_agent_router.py`, tous admin-only)

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/mc-agent/commands-catalog` | Catalogue prédéfini (pour la checklist) |
| GET | `/api/mc-agent/servers` | Liste des profils serveur |
| POST | `/api/mc-agent/servers` | Crée un profil (retourne l'id) |
| PUT | `/api/mc-agent/servers/{id}` | Met à jour un profil |
| DELETE | `/api/mc-agent/servers/{id}` | Supprime un profil |
| POST | `/api/mc-agent/run` *(étendu)* | Accepte `server_id` (résout host/port/user/auth/intelligence/commandes) **ou** les champs manuels actuels |

Validation : `id` regex `^[a-z0-9]+$` ; `intelligence` ∈ ids profils ; `auth` ∈ {offline,microsoft} ;
`commands` filtrés sur les ids du catalogue ; `port` int borné. Store dans un nouveau module
`backend/bots/mc_agent_servers.py` (load/save JSON atomique, façon `mc_agent_manager`).

## 7. Tests

**Python**
- `mc_agent_servers` : create/update/delete, persistance, rejet id invalide (path-traversal),
  filtrage des commands inconnues.
- `commands-catalog` : chargement, structure.
- `/run` avec `server_id` : résout bien la whitelist + la passe à `start_session` (mock).
- RBAC : 403 pour non-admin sur catalog / servers CRUD / run.

**Node (`node:test`)**
- `commands.js` : `isAllowed` (autorisée → true, interdite → false, chat normal → true,
  casse/espaces), `buildCommandDocs` (contient chaque cmd+syntax), `loadCommands` (fichier absent → []).
- `brain.js` : `buildSystemPrompt` inclut le bloc commandes ; `parseDecision` extrait `command`
  (présent → string, absent → null, type invalide → null).

## 8. Décisions / hypothèses

- **Intelligence = 3 profils existants** (`evident`/`intermediaire`/`expert`), réutilisés tels quels.
- **Les commandes serveur sont du texte chat** → aucune nouvelle skill mineflayer ; le serveur
  exécute. C'est ce qui rend la feature peu coûteuse côté bot.
- **Garde-fou double** (prompt + filtre sortant) plutôt que prompt seul (un LLM peut déraper).
- Persistance fichier JSON (pas de table SQLite) : cohérent avec le reste du MC Agent (clé API),
  faible volume, pas de relation.
- Tout **admin-only** (la config serveur est une capacité sensible ; `rectester` = capture-only, #37).

## 9. Risques / points d'attention

- **Throttle connexion same-IP** au test e2e (plusieurs bots) — connu (vault).
- **Cache browser** : bumper tous les `?v=` JS modifiés (piège #11), pas que `style.css`.
- **Python 3.9** : pas de `str | None` (piège #1).
- Le LLM peut inventer une syntaxe d'argument fausse même pour une commande autorisée → acceptable
  (le serveur renverra une erreur d'usage), le garde-fou ne valide que le **nom** de commande.
