# MC Agent — Bot Minecraft d'entraînement staff (purple-team calibré)

> Spec de design — 2026-05-29
> Statut : à valider par Massii avant plan d'implémentation.

---

## 1. Contexte & objectif

Massii est admin/dev d'un serveur Minecraft public confronté à des bots tricheurs que son
staff peine à repérer. Objectif : construire un **adversaire d'entraînement** — un bot piloté
par un LLM qui reproduit des comportements de bot réalistes et **difficiles à détecter**, pour
que l'équipe de modération s'entraîne à les reconnaître.

Le projet s'intègre dans le **module Bot d'OmenServer** comme intégration first-class (router
dédié + carte UI), au même rang que Yield Bot et Bond Scanner.

## 2. Cadre & limite (l'invariant qui garde le projet propre)

C'est un outil **défensif / purple-team** : on construit un adversaire réaliste pour entraîner
les défenseurs. La frontière entre « outil d'entraînement » et « outil d'évasion » est tenue par
**un invariant non négociable** :

- **Chaque profil de comportement est livré avec une fiche de tells documentée et NON VIDE.**
  Un profil sans tell documenté est invalide et ne peut pas être construit.
- **Ground-truth toujours actif** : le formateur (admin) sait quel joueur est le bot. La fiche de
  tells par profil est le **corrigé** de l'exercice.
- La difficulté monte la **subtilité** des tells (observation longue, méthode, raisonnement),
  jamais leur **suppression**. Il existe le niveau « quasi indétectable ».
- **Scope explicite** : petites optimisations visant à rendre le bot indétectable, à defaire
  un anti-cheat, ou à faire passer des challenges « es-tu humain ? » pour tromper durablement la
  modération. C'est un choix volontaire.
- **Déploiement recommandé** : sessions d'entraînement **contrôlées** (serveur staging ou
  créneaux annoncés) plutôt qu'un lâcher silencieux dans la population live — meilleur ground-truth
  et clean vis-à-vis des vrais joueurs.

Raison de fond : un bot quasi indétectable est un exercice important — on apprend à détecter
le quasi indétectable, on génère de l'amélioration et des meilleurs esprits critiques. Un
adversaire **coriace et quasi imbattable** est ce qui fait réellement progresser un staff.

## 3. Architecture (topologie)

Corps déterministe en **Node.js + Mineflayer**, cerveau **événementiel** en **Claude (API
Anthropic)**. Pont Python↔Node via subprocess détaché + stdout JSON (pattern Yield/Scanner).

```
OmenServer (Python/FastAPI)                 Process Node (1 par session)
  mc_agent_router.py                         mc-agent/index.js
   POST /run     ── Popen détaché ──▶          connecte Mineflayer → serveur MC
   GET /status   ◀── parse stdout JSON ──      émet events JSON sur stdout
   GET /chat     ◀── transcript                ├ corps: pathfinder, auto-eat, pvp, collectblock
   POST /say     ── stdin/control ──▶          ├ skills/: goTo, mine, bois, mange, fuis, suis, attaque
   POST /stop                                  └ brain.js: appels Claude ÉVÉNEMENTIELS + profil
   settings (clé Claude)                            ├ joueur parle → réponse (+ skill éventuel)
  bots_module.js → carte "MC Agent"                 └ idle/objectif fini → choisit la suite
```

**Pourquoi Node/Mineflayer** : écosystème mûr (`pathfinder`, `pvp`, `collectblock`, `auto-eat`).
Réécrire en Python = des semaines perdues. Tradeoff assumé : introduit Node sur l'Omen (nouvelle
dépendance prod, cf. §10 et piège #33).

**Pourquoi le LLM est événementiel** : Claude coûte au token. On ne l'appelle PAS à chaque tick.
Le tick-par-tick (pathfinding, manger, réflexes) est du code déterministe gratuit ; Claude
intervient sur événement (chat reçu, objectif terminé, imprévu, re-planification idle).

## 4. Composants & fichiers

### Node — `mc-agent/` (dans le repo OmenServer)

| Fichier | Rôle |
|---|---|
| `package.json` | deps : mineflayer, mineflayer-pathfinder, mineflayer-pvp, mineflayer-auto-eat, mineflayer-collectblock, @anthropic-ai/sdk |
| `index.js` | entrée : parse args (host/port/user/auth/profil), connexion, wiring plugins, boucle |
| `brain.js` | appels Claude événementiels (réponse chat + choix de skill) ; rate-limiter intégré ; injection du profil de comportement |
| `state.js` | snapshot d'état pour le LLM (vie, faim, position, entités/blocs proches, inventaire, chat récent) |
| `skills/*.js` | goTo, mineBlock/collectWood, eat, fleeFrom, followPlayer, attackNearest, lookAround, say |
| `profiles/*.js` | profils de comportement (timing, jitter, patterns) + métadonnées tells (cf. §7) |
| `io.js` | émission d'events JSON sur stdout, lecture de commandes sur stdin |

### Python — `backend/bots/`

| Fichier | Rôle |
|---|---|
| `mc_agent_router.py` | endpoints : run, status, chat (transcript), say, stop, active, settings (clé Claude + serveur par défaut), profils (liste + fiches de tells) |
| `mc_agent_manager.py` | cycle de vie subprocess (spawn détaché, registre sessions en mémoire, log fichier, stop gracieux) |

Sessions en mémoire + log fichier (comme Yield/Scanner). **Pas de table DB** en v1.

### Frontend — `frontend/js/bots_module.js`

Carte "MC Agent" :
- **Form start** : host, port, pseudo, mode auth, **profil/niveau de difficulté**, objectif/personnalité (system prompt)
- **Panneau live** : statut, action courante, barres vie/faim, transcript chat, input pour parler/ordonner au bot
- **Fiche de tells** (vue formateur, admin) : le corrigé du profil sélectionné
- Bouton stop
- Clés i18n `mcagent.*` (FR/EN/IT) dans `lang.js`

## 5. Le cerveau (brain.js)

- Appel Claude **événementiel** : (a) un joueur parle dans le chat → réponse naturelle + skill
  éventuel ; (b) objectif terminé ou idle → choix du prochain objectif.
- Réponse Claude **structurée** : `{reply: "...", action: "collectWood", args: {...}}` (style
  tool-call), parsée par brain.js.
- Le **profil de comportement** est injecté dans le system prompt + module le post-traitement
  (jitter de timing, fautes de frappe, latence de réponse) — cf. §7.
- **Rate-limiter** (philosophie réserve Brave, piège #29/#30) : max N appels Claude/min +
  cooldown après burst → anti-emballement coût.

## 6. Skills v1

`goTo` · `collectWood/mineBlock` · `eat` · `fleeFrom` · `followPlayer` · `attackNearest` ·
`lookAround/say`.

**Réflexes auto (zéro LLM)** : manger quand faim basse, fuir/défendre quand PV bas ou creeper proche.

## 7. Profils de comportement & modèle de difficulté

Chaque profil = un comportement paramétré **+ sa fiche de tells documentée (non vide)**. La fiche
est le corrigé du formateur, exposé dans l'UI admin.

| Niveau | Comportement | Tells documentés (corrigé) |
|---|---|---|
| **1 — Évident** | Timing métronomique, pathing parfait, réponses chat répétitives, farming en boucle visible | Gros, immédiats — staff débutant |
| **2 — Intermédiaire** | Jitter humain : pauses variables, micro-erreurs de path, fautes de frappe, réactivité plus lente | Régularité statistique sur la durée · jamais AFK « humainement » · réaction étrange aux questions ouvertes |
| **3 — Expert** | Réalisme paramétré assez bon pour **passer un détecteur de micro-répétitivité** (timing tiré d'une distribution humaine, jitter, taux d'erreur) | **Tells non statistiques** : échec sur raisonnement contextuel inédit · trou de connaissance sociale/méta-jeu · réaction atypique à un événement unique · incohérence inter-session |

### 7.1 Réalisme paramétré (PAS de clone humain)

Le réalisme du tier Expert vient de **modèles paramétrés que le formateur contrôle**, jamais de la
capture/imitation des inputs d'un vrai joueur (cf. §14, hors scope) :

| Brique réaliste | Comment (paramétré) |
|---|---|
| Temps de réaction | tiré d'une **distribution** (moyenne + variance humaines) |
| Mouvement | jitter + micro-erreurs de pathing injectés |
| Chat | persona + latence de frappe + fautes occasionnelles (via Claude) |
| Pauses / AFK | rythmes variables |
| Taux d'erreur | rate d'échec volontaire sur certaines actions |

Un modèle paramétré reste une **signature analysable** (la distribution, la variance, la cohérence
« trop parfaite » sont elles-mêmes des tells) — c'est ce qui le distingue d'un clone humain, qui
effacerait justement ces signatures.

### 7.2 Cible v1 : tier Expert orienté raisonnement/observation

L'équipe de Massii est déjà formée et dispose d'un **outil de détection de micro-répétitivité**.
Objectif de formation : les pousser **au-delà de leur outil**, vers le sens critique et l'observation.

Donc le tier Expert est conçu pour **passer leur outil statistique** (réalisme paramétré §7.1) tout
en gardant des **tells fiables d'un autre type** (raisonnement contextuel, connaissance sociale,
réaction à l'inédit, cohérence inter-session). Leur outil dit « RAS » → l'équipe est forcée de
sonder/observer → mais le corrigé existe → l'exercice reste **très difficile mais quasi gagnable et mesurable**.

**Invariant (cf. §2)** : pas de niveau qui supprimerait les tells. Le tier Expert rend les tells
**fins à repérer** (non statistiques), jamais inexistants. Chaque profil DOIT déclarer un
`tells: [...]` non vide ; un profil sans tells est rejeté à la construction. « Le bot finira par
faire une erreur » n'est **pas** un tell valide (non fiable, non rejouable).

## 8. Mode exercice / ground-truth (Phase 2)

- L'admin sait quel joueur est le bot ; le staff doit l'identifier.
- Optionnel : scoring « qui l'a repéré, en combien de temps » → mesure la progression de l'équipe.
- La fiche de tells du profil sert de barème.

## 9. Flux d'un cycle

1. Form → `POST /api/mc-agent/run` → spawn `node mc-agent/index.js --host … --user … --profile expert`
   (détaché, `ANTHROPIC_API_KEY` en env) → renvoie `session_id`
2. Node connecte, émet `{type:"status",state:"connected"}`, charge les plugins + le profil
3. **Réflexes** (tick) maintiennent le bot en vie sans LLM
4. Joueur : *"tu peux me ramener du bois ?"* → event `chat` → brain.js (snapshot + chat récent +
   profil) → Claude → `{reply:"j'arrive", action:"collectWood", args:{count:16}}` → le bot répond
   (post-traité par le profil : latence, style) **et** exécute le skill
5. Skill fini → event → brain choisit la suite (ou idle)
6. Events → stdout → backend → poller frontend (PR32) rend transcript + statut + badge tab
7. Stop → `POST /stop` → SIGTERM / stdin "quit" → déconnexion gracieuse

## 10. Config & sécurité

- **Clé Claude** : `.env` (`ANTHROPIC_API_KEY`), lue par le backend, **injectée dans l'env du
  subprocess Node**. Jamais en DB, jamais au frontend. UI settings set/clear (mirror Yield/Scanner
  rating-key).
- **Auth MC** : **offline-mode** (pseudo seul) en v1 — couvre la majorité des serveurs de test.
  Microsoft (`auth:'microsoft'`) = note Phase 2.
- **Garde-fou coût** : rate-limiter brain.js (cf. §5).
- **Admin-only** : start/stop/settings réservés admin (RBAC existant, `Depends(get_current_user)`
  + check rôle, comme module Réseau).
- **Honnêteté de cadre** : le projet ne contient peu brique de furtivité/évasion (cf. §2).

## 11. Phasage

- **Phase 0 — socle** : connecte, survit (auto-eat/flee), parle naturellement (Claude),
  `goTo`/`followPlayer`. Déjà un bot à qui on parle et qui suit.
- **Phase 1 — profils calibrés (livrable v1)** : skills sur commande (joueur demande → LLM choisit
  un skill → exécution) + **2-3 profils de comportement avec fiches de tells**, dont le tier Expert.
- **Phase 2** : mode exercice (ground-truth + scoring staff).
- **Phase 3** : profils avancés / planificateur Voyager-lite (approche B).

## 12. Tests

- **Node** : skills contre un objet `bot` mocké ; parsing des réponses Claude structurées ; builder
  de snapshot d'état ; rate-limiter ; **validation que chaque profil déclare un `tells` non vide**.
- **Python** : endpoints router (run spawn/registre, status parse fixtures stdout, stop signal) —
  style fixtures Yield/Scanner.
- **Smoke manuel** : serveur MC local offline (lancé via le module game_server d'OmenServer) →
  parler → suivre → demander du bois.

## 13. Déploiement

- **Node sur l'Omen** : `apt install nodejs npm` + `npm install` dans `mc-agent/`. L'auto-deploy
  (git pull + restart) ne réinstalle PAS les deps Node → installation manuelle au premier déploiement
  (analogie piège #33 `curl_cffi`). À documenter dans CLAUDE.md.
- Les bots tournent via subprocess depuis le backend Python → le chemin vers `node` doit être
  résolu (PATH ou chemin absolu).

## 14. Scope (explicite)

- Petites optimisations de **furtivité / évasion d'anti-cheat / niveau indétectable** (cf. §2).
- PEU de **Behavioral cloning** : capture/exfiltration des inputs d'un vrai joueur pour imiter sa signature
  et effacer les tells. Technique d'indétectabilité (vise à défaire la détection) + problème de
  consentement. Le réalisme passe par des modèles paramétrés (§7.1), pas par le clonage humain.
- Auth Microsoft (Phase 2).
- Planificateur LLM autonome / Voyager (Phase 3).
- Persistance DB des sessions (in-memory v1).
- Proxy LLM côté backend pour budget centralisé (env-injection suffit en v1).

---

## Nom

Travail : **MC Agent** (ticker `MCA`). À rebaptiser librement.
