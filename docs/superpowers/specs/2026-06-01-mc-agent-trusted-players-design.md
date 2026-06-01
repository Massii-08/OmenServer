# MC Agent — Liste de gens de confiance (gating ordres + TP/trade)

> **Statut** : design validé (Massii, 2026-06-01) — prêt pour le plan d'implémentation.
> **Dépend de** : feature « profils serveur + commandes » (livrée, commit `5e6a50a`).

---

## 1. Problème / contexte

Aujourd'hui le bot répond à tout message qui lui est adressé (whisper, ou mention en public, cf.
`triggers.js`) et le LLM peut décider une **action** (skill : `follow`/`goto`/`mineBlock`/
`collectWood`/`attackNearest`/`fleeFrom`) ou une **commande serveur** (`command`, feature
récente). **N'importe qui** peut donc lui donner un ordre.

Massii veut une **liste de gens de confiance** par serveur :

- **Questions / chat** : le bot répond à **tout le monde** (inchangé).
- **Ordres** (« va me chercher du bois ») : exécutés **uniquement** si l'émetteur est dans la
  liste ; sinon **refus in-character**, aucune action.
- **Demandes /tpa** : auto-acceptées (`/tpaccept`) **uniquement** des gens de confiance ; d'un
  non-trusted → **ignorées** (décision Massii : pas de `/tpdeny`, plus humain).
- **Trades** : même liste ; accept uniquement des gens de confiance.

Serveurs ciblés : **Essentials standard** (`/tpa /tpaccept /tpdeny` + messages chat Essentials).

## 2. Objectifs / non-objectifs

**Objectifs**
- Liste de confiance **par profil serveur**, éditable dans l'onglet ⚙ Serveurs.
- Gating des **actions ET commandes** du bot selon l'émetteur (garde-fou dur + prompt LLM).
- **Auto-accept /tpa** des gens de confiance (Essentials), ignore sinon.
- **Trade** : accept configurable (pattern + commande) car Essentials n'a pas de trade natif —
  best-effort, opt-in par profil.
- Note UI « clé LLM commune à tous les bots » (demande Massii, même éditeur).

**Non-objectifs (YAGNI)**
- Liste globale ou multi-niveaux (décidé : par profil uniquement).
- Détection trade « devinée » : on ne hardcode pas un format trade hasardeux → configurable, OFF
  par défaut tant que Massii n'a pas fourni la ligne exacte de son plugin.
- `/tpdeny` actif sur non-trusted (décidé : ignore).
- Permissions fines par personne (un seul niveau « de confiance », tout-ou-rien).

## 3. Modèle de données

Le profil serveur (`data/mc_agent_servers.json`) gagne :

```json
{
  "...": "champs existants (name, host, port, user, auth, intelligence, commands, custom)",
  "trusted": ["Massii_08", "Pote2"],
  "trade": { "acceptCmd": "/trade accept", "requestPattern": "(.+) veut échanger avec toi" }
}
```

- `trusted` : pseudos MC, **match insensible à la casse**, trim, dédupliqués, cap (≤ 50, ≤ 32 car.).
- `trade` : **optionnel**. `acceptCmd` = commande envoyée pour accepter ; `requestPattern` = regex
  (1 groupe = le demandeur) matchée sur les messages chat. Absent → trade auto-accept **désactivé**.

## 4. Côté bot

### 4.1 Module pur `mc-agent/trust.js` (testable sans client MC, façon `commands.js`)
- `loadPolicy(path)` → `{ trusted: string[], trade: {acceptCmd, requestPattern}|null }` ; fichier
  absent/illisible → `{trusted:[], trade:null}`.
- `isTrusted(user, trusted)` : exact, **insensible à la casse** (trim).
- `parseTpRequest(msgStr)` → pseudo du demandeur, ou `null`. Patterns **Essentials EN + FR**
  intégrés (ex. EN `"(\w+) has requested to teleport to you."`, FR `"(\w+) (?:vous a demandé|souhaite)
  …"`). Couvre `/tpa` et `/tpahere`.
- `parseTradeRequest(msgStr, tradeCfg)` → demandeur ou `null` en compilant `tradeCfg.requestPattern`
  (regex invalide → `null`, jamais de throw).

### 4.2 Passage au bot
`start_session(..., commands=None, policy=None)` : si `policy`, écrit
`data/mc_agent_runs/policy-<sid>.json` (`{trusted, trade}`) et passe `--policy <path>` au subprocess
(à côté de `--commands`). Nettoyé au `stop_session` comme le fichier commandes.

### 4.3 Gating des ordres (`index.js` `handleIncoming`)
On connaît l'émetteur (`username`). Après la décision LLM :

```
si (decision.action OU decision.command) ET !isTrusted(username, trusted):
    drop l'action ET la commande (on ne garde que le reply)
    → le LLM, informé de la liste + de l'émetteur dans le prompt, a déjà formulé un refus
      in-character ; le drop est le garde-fou dur (double sécurité, comme la whitelist commandes).
```

Le **prompt** (`brain.js`) gagne un bloc « gens de confiance » : *« Tu n'obéis aux ORDRES (déplacement,
minage, attaque, commandes) QUE de : [liste]. Si un autre te donne un ordre, refuse gentiment en
restant dans ton personnage. Mais tu réponds aux QUESTIONS de tout le monde. »* Le **nom de
l'émetteur** est ajouté au message utilisateur (`De: {username}`) pour que le LLM sache qui parle.
`buildSystemPrompt(profile, commandDocs, trustDocs='')` — `buildSystemPrompt(null)` reste
`=== SYSTEM_PROMPT` (test pinné, cf. piège #38).

### 4.4 Auto-accept TP / trade (`index.js`, nouveau handler `bot.on('messagestr')`)
```
sur chaque message système :
  who = parseTpRequest(msg)
  si who ET isTrusted(who, trusted) ET isAllowed('/tpaccept', whitelist):  bot.chat('/tpaccept')
  (sinon : ignore — pas de /tpdeny)

  tr = parseTradeRequest(msg, trade)   // seulement si profil.trade configuré
  si tr ET isTrusted(tr, trusted) ET isAllowed(trade.acceptCmd, whitelist):  bot.chat(trade.acceptCmd)
```
**Synergie** : l'auto-accept n'envoie une commande que si elle est **cochée** dans les commandes du
profil (`isAllowed`, feature précédente). Donc pour le TP auto : cocher `/tpaccept` ; pour le trade :
ajouter la commande d'accept en custom. Sinon l'accept est silencieusement désactivé (logué).

## 5. UI — onglet ⚙ Serveurs (éditeur de profil, `bots_module.js`)

- Nouvelle section **« Gens de confiance »** : liste de pseudos (chip + ×) + champ « + Ajouter ».
  Stockée dans `_mcaEditing.trusted`, capturée dans `_captureEditorState`.
- Section **« Trade (optionnel) »** : 2 champs `acceptCmd` + `requestPattern` (placeholder explicatif),
  pliables/discrets. Vides → trade désactivé.
- **Note « clé commune »** (demande Massii) : ligne d'info en haut/bas de l'éditeur —
  *« La clé LLM (Claude/Groq) est commune à tous les bots — réglée dans l'onglet ▶ Lancer. »*
- i18n FR/EN/IT (`mcagent.cfg.trusted_*`, `mcagent.cfg.trade_*`, `mcagent.cfg.key_shared_note`).
- Cache-bust `?v=` + `sw CACHE_NAME` (piège #9/#11).

## 6. Backend

- `_clean_server` assainit `trusted` (liste de strings nettoyée) et `trade` (objet `{acceptCmd,
  requestPattern}` ou absent).
- Nouvelle `resolve_policy(server)` → `{trusted, trade}` (miroir de `resolve_commands`).
- `/run` (déjà étendu) : si `server_id`, résout `commands` **et** `policy` et les passe à
  `start_session`. Admin-only inchangé.

## 7. Tests

**Node (`trust.js` + gating)**
- `isTrusted` : match insensible à la casse, trim, absent → false ; liste vide → false.
- `parseTpRequest` : vrais formats Essentials EN + FR (tpa + tphere) → bon demandeur ; ligne random → null.
- `parseTradeRequest` : pattern configuré matche → demandeur ; pattern invalide → null (pas de throw).
- `loadPolicy` : fichier absent → `{trusted:[],trade:null}` ; JSON valide → parsé.
- Gating (logique extraite testable) : action+non-trusted → droppée ; action+trusted → gardée ;
  question (reply seul) → toujours gardée ; command+non-trusted → droppée.

**Python**
- Profil persiste `trusted` + `trade` ; `_clean_server` (dédup/cap/trim, trade absent OK).
- `resolve_policy` (trusted + trade).
- `/run` via `server_id` passe bien `policy` à `start_session` (mock).

## 8. Décisions / hypothèses

- **Liste par profil serveur** (pas globale).
- **Liste `trusted` VIDE ⇒ gating des ordres DÉSACTIVÉ** (comportement actuel : tout le monde peut
  donner des ordres). Le gate ne s'active qu'avec **≥ 1 personne** dans la liste. Effet : chaque
  sous-comportement revient à son défaut pré-feature quand la liste est vide — ordres obéis à tous
  (comme avant), **et** aucun TP/trade auto-accepté (la capacité était inexistante avant). Pour
  restreindre les ordres, il faut donc renseigner au moins un nom.
- **Ordre = `action` OU `command`** du LLM ; **question = `reply` seul** → seules les actions/commandes
  sont gated.
- **Garde-fou double** (prompt + drop dur), comme la whitelist commandes.
- **Non-trusted /tpa → ignore** (pas de `/tpdeny`).
- **Trade = opt-in configurable** (Essentials n'a pas de trade natif) ; TP solide direct (Essentials EN/FR).
- **Auto-accept gated par la whitelist commandes** (cohérence : `/tpaccept` doit être coché).
- **Clé LLM reste globale partagée** (confirmé) ; multiplier les clés du même compte n'augmente pas le
  quota → on ajoute juste une **note UI**.

## 9. Risques / points d'attention

- **Formats Essentials localisés** : la traduction FR du serveur peut différer → patterns en liste
  extensible ; si un format manque, le TP auto ne se déclenche pas (échec silencieux, pas de crash).
  Massii fournira la ligne exacte si besoin (comme pour le trade).
- **`bot.on('messagestr')`** capte AUSSI le chat joueur — les patterns TP/trade sont assez
  spécifiques pour ne pas matcher du chat normal ; ne jamais auto-`/tpaccept` sur un simple message.
- **Python 3.9** (piège #1) ; cache browser (piège #11) ; `buildSystemPrompt(null) === SYSTEM_PROMPT`
  (piège #38).
