# MC Agent — Phase 1b : capture comportementale consentie (behavioral cloning cadré)

> Spec de design — 2026-05-29
> Statut : à valider par Massii avant plan d'implémentation.
> Rattachement : extension de [`2026-05-29-mc-agent-training-design.md`](2026-05-29-mc-agent-training-design.md) (la « spec mère »).
> Cette phase **scope-in**, sous cadre consentement strict, ce que la spec mère renvoyait hors-scope (§14 « Behavioral cloning »).

---

## 1. Contexte & rattachement

La **Phase 1** (profils calibrés) atteint son réalisme par des **modèles paramétrés devinés** (constantes
`latencyMeanMs: 2200`, `typoRate: 0.07`, etc. dans `mc-agent/profiles/expert.js`). C'est volontaire et
suffisant pour former la modération.

La **Phase 1b** va plus loin : elle remplace les constantes devinées par des **statistiques de style mesurées
sur un vrai joueur consentant** (toi ou un staff volontaire), puis ajoute un **profil « clone »** dérivé de ce
style. Le réalisme devient *empirique* au lieu d'*estimé*.

**Pourquoi une phase séparée** : c'est le sous-système le plus lourd du projet (il introduit un **mod client
Java/Fabric**, stack absente du reste d'OmenServer) **et** il porte une dimension **consentement** que la spec
mère a explicitement choisi d'isoler proprement plutôt que de bâcler dans le cœur (spec mère §14 + plan Phase 1).

**3 jalons** (ordre de construction **forcé** : calibration et clone ont besoin de données déjà capturées) :

| Jalon | Contenu | « Installable & utilisable » |
|---|---|---|
| **1b.1** | Mod Fabric (REC/REC-off) + ingestion OmenServer + stockage consenti + distillation + vue des stats | ✅ tu enregistres dès ce jalon |
| **1b.2** | Le `style.json` distillé règle les params de réalisme (§7.1) des profils existants | profils crédibilisés sur du vrai humain |
| **1b.3** | Profil dédié `clone-<joueur>` dérivé du style capturé (tells cognitifs déclarés) | nouvel adversaire d'entraînement |

Une **seule spec** (ce document) couvre tout l'arc — c'est un pipeline cohérent autour d'un même dataset —
mais l'implémentation se fait **jalon par jalon**.

## 2. Cadre consentement & invariants (LE garde-fou non négociable)

C'est la section qui garde la Phase 1b du bon côté de la frontière « outil d'entraînement » vs « outil
d'évasion ». Tous ces points sont des **exigences de design**, pas des recommandations.

- **Joueur-modèle désigné et consentant uniquement** (toi ou un staff volontaire). **JAMAIS** de capture
  passive de la population du serveur.
- **Consentement actif et visible (REC / REC-off)** : le mod **ne capture pas** au lancement (état `REC-off`).
  Le joueur **démarre explicitement** chaque session (keybind) → le HUD affiche **`● REC`**. Il sait *en
  permanence* s'il est enregistré. **Notice de consentement au 1er lancement** (quoi est enregistré + finalité
  entraînement). Le « si problème = REC-off » est codé : toute erreur d'I/O coupe la capture et repasse `REC-off`.
- **Transport = upload manuel** : le joueur **relit/contrôle** son fichier avant de l'envoyer. **Rien ne quitte
  sa machine sans son action.** Le mod n'a aucune capacité réseau vers l'API.
- **Minimisation des données de tiers** : le chat des **autres** joueurs est capturé en **timing + longueur
  seulement, jamais le contenu** (eux n'ont pas consenti). Seuls les messages **du joueur-modèle** sont capturés
  en **contenu + timing**.
- **Invariant tells préservé (spec mère §2)** : le profil clone **DÉCLARE des tells non vides** (les tells
  cognitifs Expert + un tell « signature figée », cf. §9). On extrait un *style* (moteur/timing), on **n'efface
  jamais** les tells cognitifs. Un clone sans tells est **rejeté par `validateProfile`** — invariant garanti *par
  construction*.
- **Pas d'objectif d'indétectabilité absolue** : la finalité reste **purple-team** (entraîner la modération). On
  ne construit pas un outil dont le but serait de battre un anti-cheat tiers en production.
- **Accès admin-only** (RBAC existant, `_require_admin`). Données **stockées localement sur l'Omen**, gitignored,
  **supprimables** par l'admin (droit à l'effacement).
- **Déploiement = sessions d'entraînement contrôlées** (spec mère §2).

## 3. Architecture (topologie)

```
Client du joueur-modèle (Java)            OmenServer (Python/FastAPI)              Node (mc-agent, déjà là)
  mc-capture-mod (Fabric)                   mc_capture_router.py                     index.js + profiles/ + humanize.js
   ├ HUD REC / REC-off                       POST /captures   ◀── upload manuel ──   (Phase 0/1)
   ├ capte inputs+état+chat (REC on)         GET  /captures   (liste)
   └ écrit session-<ts>.jsonl  ───────┐      POST /captures/{p}/distill ─┐
        (fichier LOCAL)               │      GET  /captures/{p}/style     │
                                      │       data/mc-captures/<joueur>/  │
   (le joueur relit puis upload   ────┘        ├ session-*.jsonl          │
    via le dashboard)                          └ style.json  ◀── distill ─┘
                                                     │
                                       1b.2 calibration : start_session(--style style.json)
                                                     │   → index.js merge derivedParams sur le profil
                                       1b.3 clone     : profiles/clone.js buildCloneProfile(style)
                                                     └─────────────▶ session bot → le staff s'entraîne
```

> **Point clé déploiement** : **l'Omen ne gagne AUCUNE dépendance runtime.** Le mod tourne sur le *client* du
> joueur ; OmenServer ne fait qu'**ingérer un fichier + distiller** (Python **stdlib**). Le toolchain
> **Java/Gradle n'est requis qu'au BUILD** du `.jar` (machine de dev). Contraste assumé avec Node/Mineflayer
> (lui, doit tourner en runtime sur l'Omen — cf. spec mère §13).

## 4. Composants & fichiers

### Java / Fabric — `mc-capture-mod/` (nouveau, dans le repo OmenServer)

| Fichier | Rôle |
|---|---|
| `build.gradle`, `settings.gradle`, `gradle.properties` | Fabric Loom + multi-version (Stonecutter ou 2 configs) |
| `src/main/.../CaptureMod.java` | entrypoint Fabric : enregistre les hooks (tick, chat, HUD, keybind) |
| `src/main/.../Recorder.java` | machine d'état REC/off : ouvre/écrit/ferme le fichier session, gère l'erreur→off |
| `src/main/.../TickSampler.java` | lit inputs + état joueur par tick et produit un record |
| `src/main/.../ChatHook.java` | sortant = contenu+timing ; entrant = timing+longueur (PAS de contenu) |
| `src/main/.../RecHud.java` | overlay `● REC` (rouge) / `REC-off` (gris) |
| `src/main/.../SessionWriter.java` | **sérialisation JSONL + header — logique PURE, testable hors client** |
| `src/main/resources/fabric.mod.json` | métadonnées mod + dépendances Fabric API |
| builds | `mc-capture-<modver>-mc1.20.x.jar` **et** `…-mc1.21.x.jar` |

### Python — `backend/bots/`

| Fichier | Rôle |
|---|---|
| `mc_capture_router.py` | `POST /api/mc-agent/captures` (upload), `GET /captures` (liste), `POST /captures/{player}/distill`, `GET /captures/{player}/style`, `DELETE /captures/{player}[/{session}]` — **admin-only** |
| `mc_capture_store.py` | stockage `data/mc-captures/<joueur>/`, validation header/.jsonl, listage, suppression |
| `mc_capture_distill.py` | `.jsonl` → `style.json` (stdlib `statistics`) |
| `mc_agent_manager.py` *(modif)* | `start_session(..., style=None)` → passe `--style` au Node ; helpers métadonnées clone |
| `tests/test_mc_capture_*.py` | upload/store/distill/admin-only (fixtures `.jsonl` réelles) |

### Node — `mc-agent/` (extension Phase 0/1)

| Fichier | Rôle |
|---|---|
| `profiles/clone.js` | `buildCloneProfile(style, player)` → profil **tells-bound** (passe `validateProfile`) |
| `index.js` *(modif)* | `--style <path>` : **merge** `derivedParams` par-dessus les `params` du profil (tells inchangés) |
| `bin/clone-profile.js` | `style.json` → métadonnées clone sérialisables (consommé par Python pour l'UI) |
| `test/clone.test.js`, `test/calibration.test.js` | merge déterministe + clone tells non vide |

### Frontend — `frontend/js/bots_module.js`

Panneau **« Captures »** dans la carte MC Agent (admin) : dropzone upload, liste des sessions (date, durée,
ticks), bouton **voir stats** (rend `style.json` lisible), bouton **supprimer**. Le profil **`Clone de <joueur>`**
apparaît dans le sélecteur de profil avec sa **fiche de tells** (corrigé), comme les autres. Clés i18n
`mcagent.capture.*` (FR/EN/IT). Cache-bust (`?v=` + `CACHE_NAME`, pièges #9/#11/#35-bis).

## 5. Le mod Fabric (1b.1)

### 5.1 Cycle de consentement (machine d'état REC)

1. **Lancement** → état `OFF`, HUD `REC-off` (gris). **1er lancement** → notice de consentement (écran/chat) :
   *« Ce mod enregistre TES inputs, déplacements et messages pour l'entraînement de la modération de
   <serveur>. Rien n'est envoyé automatiquement — tu choisis d'uploader. Touche <key> pour démarrer/arrêter. »*
2. **Keybind** (défaut ex. `F8`) → `START` : ouvre `mc-capture/session-<epoch>.jsonl`, écrit le **header**, HUD →
   `● REC` (rouge).
3. **Keybind** → `STOP` : flush + close, HUD → `REC-off`.
4. **Erreur d'I/O** (disque plein, droits…) → `STOP` auto + HUD `REC-off` + message court. ⇐ ton « si problème = REC-off ».
5. Le fichier **n'est jamais transmis par le mod** (upload manuel uniquement).

### 5.2 Schéma de capture

**Header** (1re ligne du `.jsonl`) :
```json
{"schema":1,"player":"Massii_08","uuid":"…","mc":"1.21.4","mod":"0.1.0","consent":true,"startedAt":1748540000000,"sampleHz":20}
```

**Record `tick`** (échantillonné au client tick, 20 Hz ; décimable à 10 Hz pour alléger) :
```json
{"t":1234,"type":"tick","in":{"fwd":1,"back":0,"left":0,"right":0,"jump":0,"sneak":0,"sprint":1,"atk":0,"use":0},"yaw":-12.4,"pitch":3.1,"pos":[120.5,64,-30.2],"vel":[0.21,0,0.02],"og":1,"hp":20,"food":17,"held":"iron_sword"}
```

**Events** (intercalés, `type`-taggés) :
```json
{"t":1500,"type":"chat_out","text":"jarrive 2 sec","len":13}   // joueur-modèle : contenu + timing
{"t":1600,"type":"chat_in","len":18}                            // AUTRE joueur : timing + longueur, PAS de contenu
{"t":2100,"type":"mob_appear","kind":"zombie","dist":7.2}       // stimulus (→ latence de réaction)
{"t":2240,"type":"damage","amount":3.0}
{"t":3000,"type":"attack","target":"zombie","dist":2.1}
{"t":9000,"type":"death"}
```

> **Stretch (hors v1)** : cadence de frappe *par caractère* dans la box de chat. v1 = timing + contenu +
> longueur du message envoyé (suffisant pour latence de réponse, longueur, et taux de faute global).

### 5.3 Multi-version

Une **codebase**, des **builds par version** (Stonecutter, ou 2 configs Gradle si le delta 1.20↔1.21 reste
trivial). La surface version-spécifique est **minime** (mappings de noms + version Fabric API) car le mod est
volontairement petit. **On valide toute la boucle sur 1 version d'abord** (celle que le joueur-modèle lance),
puis on estampille la 2ᵉ.

## 6. Transport & stockage (1b.1)

- **Upload manuel** : dashboard → MC Agent → « Importer une capture » → `POST /api/mc-agent/captures`
  (multipart). Validations : header `schema` valide, taille bornée, extension `.jsonl`(`.gz`). Le **`player`
  provient du header** (pas d'un champ libre côté UI).
- **Stockage** : `data/mc-captures/<joueur>/session-<epoch>.jsonl` (+ `style.json` distillat). `data/` est déjà
  gitignored. **Admin-only**. Pas de DB en v1 (cohérent avec sessions/Yield/Scanner).
- **`DELETE`** pour retirer une session ou tout un joueur (droit à l'effacement / consentement).

## 7. Distillation (1b.1) → `style.json`

`mc_capture_distill.py` lit toutes les sessions d'un joueur et calcule (stdlib `statistics`) :

| Bloc | Contenu | Dérivé de |
|---|---|---|
| `reaction` | `{meanMs, stdMs, n}` | délai stimulus (`mob_appear`/`damage`) → 1er changement d'input significatif |
| `chat` | `{latencyMeanMs, latencyStdMs, typoRate, msgLenMean, msgs}` | latence = `chat_in` → `chat_out` suivant (proxy) ; `typoRate` heuristique sur `chat_out` |
| `movement` | `{jitter, turnRateMean, turnRateStd, idleRatio, jumpRatePerMin}` | jitter = écart-type des deltas yaw/pitch en locomotion droite |
| `clicks` | `{cpsMean, cpsStd, burstiness}` | sur `in.atk` / `in.use` |
| `errorRate` | proxy (reversals d'input rapides / attaques sans cible / backtracks) — **approximatif** | flux tick |
| `derivedParams` | **bloc 1:1 avec `profile.params` (§7.1)**, prêt à injecter | agrégat des blocs ci-dessus |

```json
{"schema":1,"player":"Massii_08","sessions":3,"ticks":42000,"durationS":2100,
 "reaction":{"meanMs":480,"stdMs":260,"n":54},
 "chat":{"latencyMeanMs":2600,"latencyStdMs":1400,"typoRate":0.06,"msgLenMean":22,"msgs":80},
 "movement":{"jitter":0.34,"turnRateMean":3.1,"turnRateStd":2.2,"idleRatio":0.12,"jumpRatePerMin":4},
 "clicks":{"cpsMean":5.4,"cpsStd":1.8,"burstiness":0.3},
 "errorRate":0.09,
 "derivedParams":{"chat":{"latencyMeanMs":2600,"latencyStdMs":1400,"typoRate":0.06},"errorRate":0.09,"movementJitter":0.34}}
```

> La spec fige la **forme** de `style.json`, pas les **coefficients** : les formules exactes (seuils, fenêtres,
> détection de « locomotion droite », heuristique typo) seront **finalisées et tunées sur tes vraies captures**
> à l'implémentation. `derivedParams` épouse exactement la forme attendue par `mc-agent/humanize.js`
> (`params.chat.{latencyMeanMs,latencyStdMs,typoRate}`, `params.errorRate`, `params.movementJitter`).

## 8. Calibration (1b.2)

- `mc_agent_manager.start_session(..., style=None)` → ajoute `--style <path style.json>` à la commande Node.
- `mc-agent/index.js` charge `style.json` et **merge `derivedParams` par-dessus** les `params` du profil choisi
  (override sélectif). **Les `tells` du profil restent inchangés.**
- Effet : le profil **Expert** (ou autre) joue avec la **latence/jitter/typo mesurés** au lieu des constantes
  Phase 1 → réalisme empirique, invariant intact.
- **Test** : merge déterministe (`style.derivedParams` > base), `tells` non touchés, profil sans `--style` =
  comportement Phase 1 inchangé (non-régression).

## 9. Profil clone (1b.3)

`mc-agent/profiles/clone.js` :
```js
buildCloneProfile(style, player) → {
  id: `clone-${player}`, level: 3, label: `Clone de ${player}`,
  summary: 'Style (timing/jitter/chat) dérivé d'une capture réelle consentie.',
  persona: <persona Expert>,
  params: style.derivedParams,                    // ← le style mesuré
  tells: [
    …3 tells cognitifs Expert (raisonnement inédit / connaissance sociale-méta / réaction à l'inédit)…,
    'Signature figée : le style provient d'UNE capture datée — il ne dérive pas avec la fatigue ou l'humeur ' +
    'sur une longue session et reste identique d'une session à l'autre, alors qu'un vrai joueur varie.',
  ],
}
```

- Passe `validateProfile` (tells non vide) → **invariant garanti par construction** ; un `style` sans
  `derivedParams` est rejeté.
- **Sélectionnable dans l'UI** : un clone par joueur ayant un `style.json`. Les métadonnées (label + fiche de
  tells) sont exposées via le backend (`bin/clone-profile.js` lit le `style.json`, ou scan
  `data/mc-captures/*/style.json`).
- **Test** : `buildCloneProfile` produit des tells non vides ; `params === style.derivedParams` ; rejet si
  `style` invalide.

## 10. UI (1b.1 + 1b.3)

- Panneau **« Captures »** (admin) dans la carte MC Agent : **dropzone** upload, **liste** des sessions par
  joueur (date, durée, ticks), bouton **voir stats** (rend `style.json` lisible : latence, jitter, cadences),
  bouton **supprimer**.
- (1b.3) le profil **`Clone de <joueur>`** rejoint le **sélecteur de profil** + affiche sa **fiche de tells**
  (corrigé formateur) comme les profils Phase 1.
- i18n `mcagent.capture.*` (FR/EN/IT). **Échappement HTML** à l'affichage (stats + chat) — anti-XSS (cf. piège
  transcript Phase 1). Cache-bust `?v=` + `CACHE_NAME`.

## 11. Tests

- **Java** : `SessionWriter` (record → JSONL + header bien formé), machine d'état `Recorder`
  (`start`/`stop`/`erreur→off`), `ChatHook` (entrant = timing-only, sortant = contenu). **Logique pure extraite
  des hooks MC** pour test JUnit **sans client lancé**. HUD + hooks réels validés en smoke manuel.
- **Python** : upload (store, validation header, rejet non-`.jsonl`), distillation (fixture `.jsonl` →
  `style.json` attendu), **admin-only** (403 non-admin), `DELETE`.
- **Node** : merge calibration (`style` → `params`, `tells` intacts, non-régression sans `--style`),
  `buildCloneProfile` (tells non vide, `params == derivedParams`, rejet `style` invalide).
- **Smoke e2e** : build `.jar` → install (Fabric Loader + `.jar` dans `mods/`) → `REC` une courte session →
  upload dashboard → voir stats → (1b.2) lancer un profil **calibré** → (1b.3) sélectionner le **clone** + voir
  ses tells.

## 12. Déploiement

- **Runtime Omen inchangé** : **aucune** nouvelle dépendance prod. Distillation = Python **stdlib**.
- **Build du mod (dev only)** : JDK 17 (1.20.x) / JDK 21 (1.21.x) + Gradle (Fabric Loom). Sur ta machine de dev
  (Mac) ou l'Omen — **pas requis en runtime prod**.
- **Distribution du `.jar`** : le joueur-modèle installe **Fabric Loader** (matching version MC) + dépose le
  `.jar` dans `mods/`. Guide court (analogie `docs/Guide_Installation_PC_OmenServer`). Téléchargeable depuis le
  dashboard (option) ou remis à la main.
- `data/mc-captures/` créé au 1er upload (gitignored via `data/`).
- **CLAUDE.md** : documenter le nouveau module Java/Fabric (build-time only) + pièges Fabric/mappings/multi-version.

## 13. Scope / non-goals (explicite)

- ❌ **Capture passive de la population** / sans consentement explicite.
- ❌ **Effacement des tells** / objectif d'indétectabilité absolue contre un anti-cheat tiers en prod.
- ❌ **Auto-POST** du mod vers l'API (v1 = upload manuel ; reconsidérable plus tard si besoin).
- ❌ **Contenu** du chat des autres joueurs (timing + longueur uniquement).
- ❌ Cadence de frappe **par caractère** (best-effort / stretch).
- ❌ **Bedrock** (Fabric = Java Edition uniquement).
- ❌ **DB** des captures (fichiers `.jsonl` + `style.json` en v1).
- ❌ **Modèle ML séquentiel appris** (réseau de neurones) : v1 = **statistiques distillées** injectées dans les
  params. Un vrai modèle génératif de trajectoires = extension lourde, future éventuelle Phase 1c.

## 14. Sécurité

- **Admin-only** (RBAC, `_require_admin`) sur tous les endpoints capture.
- **Upload validé** (header `schema`, taille bornée, extension ; aucun contenu exécuté).
- **Données perso minimisées** (tiers = timing-only), **stockées localement** gitignored, **supprimables**.
- **Aucun credential** dans le mod distribué (upload manuel → rien à exfiltrer).
- **Échappement** à l'affichage des stats/chat (anti-XSS).

## 15. Nom

- Mod : travail **« OmenCapture »** (ticker `CAP`) — à rebaptiser librement.
- Profil généré : **« Clone de <joueur> »** (id `clone-<joueur>`).

---

## Open questions (à trancher au plan, pas bloquantes)

1. **Version MC validée en premier** : 1.21.x ou 1.20.x ? (détermine le 1er build ; l'autre suit).
2. **Keybind par défaut** du toggle REC (`F8` proposé) — éviter une collision avec un bind courant.
3. **`errorRate`** : la formule proxy exacte se fige sur tes vraies captures (la spec ne fige que sa présence).
