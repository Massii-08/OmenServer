# MC Agent — Phase 1b : capture comportementale consentie + rejeu hybride (behavioral cloning cadré)

> Spec de design — 2026-05-29 (révisée 2026-05-30 : pivot **exécution hybride**, chat complet).
> Statut : à valider par Massii avant plan d'implémentation.
> Rattachement : extension de [`2026-05-29-mc-agent-training-design.md`](2026-05-29-mc-agent-training-design.md) (la « spec mère »).
> Cette phase **scope-in**, sous cadre consentement strict, ce que la spec mère renvoyait hors-scope (§14 « Behavioral cloning »).

---

## 1. Contexte & rattachement

La **Phase 1** (profils calibrés) atteint son réalisme par des **modèles paramétrés devinés** (constantes
`latencyMeanMs: 2200`, `typoRate: 0.07`, etc. dans `mc-agent/profiles/expert.js`). Suffisant pour former, mais
c'est une *approximation*.

La **Phase 1b** capture le jeu d'un **joueur-modèle consentant** (toi ou un staff volontaire) et fait jouer au
bot **ta vraie motricité**, pas une approximation. Décision design 2026-05-30 (Massii) : **modèle d'exécution
hybride** —

> **Le cerveau décide QUOI faire** (aller là, miner, suivre, répondre au chat) ; **l'exécution rejoue TES vrais
> gestes capturés pour le COMMENT** (gigue de visée, courbes de demi-tour, cadence de clic, micro-mouvements
> d'attente, démarche). Ce que les autres joueurs / l'anti-cheat observent (tes paquets position + visée) est
> littéralement le tien, **mais le bot reste réactif** (ne fonce pas dans un mur, s'adapte au terrain).

C'est le point central : **pas un macro aveugle** (un rejeu verbatim refait le même chemin même si le terrain a
changé → facile à griller, ironiquement) ; **pas une IA qui synthétise du mouvement** (l'approximation que Massii
ne veut pas) → **tes clips réels recombinés selon le contexte**.

**Pourquoi une phase séparée** : sous-système le plus lourd (mod client **Java/Fabric**, stack absente du reste
d'OmenServer) **et** dimension **consentement** → isolé proprement (spec mère §14 + plan Phase 1).

**Jalons** (ordre forcé : calibration et rejeu ont besoin de données déjà capturées) — 1b.1→1b.3 = l'arc cœur, 1b.4 = extension multi-joueurs planifiée :

| Jalon | Contenu | « Installable & utilisable » |
|---|---|---|
| **1b.1** | Mod Fabric (REC/REC-off) + ingestion + stockage consenti + distillation (**stats `style.json` + bibliothèque de clips de motricité**) + vue des stats | ✅ tu enregistres dès ce jalon |
| **1b.2** | Les **stats** distillées règlent les params chat/réaction/faute (§7.1) des profils existants | profils crédibilisés sur du vrai humain (chat, latence) |
| **1b.3** | **Profil `clone-<joueur>` à exécution hybride** : le bot rejoue tes **clips de motricité réelle** pilotés par le cerveau (la partie « mes vrais mouvements ») | nouvel adversaire d'entraînement, motricité = la tienne |
| **1b.4** | **Profil composite « dream team »** : un joueur par compétence (combat ← le PVPer, parkour/loco ← le mover, mine ← un autre…) — assemblage des clips de **plusieurs** contributeurs consentants | adversaire all-star ; nouveau tell « incohérence de signature inter-compétences » |

Une **seule spec** (ce document) couvre l'arc ; implémentation **jalon par jalon**.

**Mode de travail réel (Massii, 2026-05-30)** : un **groupe de volontaires consentants** joue ~5 h chacun, puis
remet ses captures ; **aucune contrainte de délai** côté traitement (mode **batch**, pas de temps réel) ; le flux
est **continu** (de nouvelles captures peuvent arriver plus tard pour affiner). Division du travail : la
**distillation auto** *digère le volume* (25 h+ → impossible à la main), **l'humain (moi) façonne le profil**
(choix des clips, calibration, rédaction des tells) par-dessus ; le bot tourne ensuite **en autonomie**.

## 2. Cadre consentement & invariants (LE garde-fou non négociable)

Exigences de design, pas des recommandations.

- **Joueur(s)-modèle désigné(s) et consentant(s) uniquement** (toi + une **équipe de volontaires**). Chacun
  consent **pour lui-même** et installe le mod sur **son** client. **JAMAIS** de capture passive visant un joueur
  lambda comme cible de clonage. Le composite 1b.4 = assemblage de **plusieurs** contributeurs **tous** consentants.
- **Consentement actif et visible (REC / REC-off)** : le mod **ne capture pas** au lancement (`REC-off`). Le
  joueur **démarre explicitement** chaque session (**touche F8**) → HUD **`● REC`**. Il sait *en permanence*
  s'il est enregistré. **Notice de consentement au 1er lancement**. Toute erreur d'I/O coupe la capture → `REC-off`.
- **Transport = upload manuel** : le joueur **relit/contrôle** son fichier avant l'envoi. **Rien ne quitte sa
  machine sans son action.** Le mod n'a aucune capacité réseau vers l'API.
- **Chat = capture complète (in + out, contenu inclus)** — décision Massii 2026-05-30 : le chat du serveur est
  **déjà public** (miroir Discord), donc le logger localement pour l'entraînement n'expose rien de neuf. Reste
  **admin-only**, **stocké localement**, **jamais re-publié**. (Le contenu entrant sert aussi à mesurer ta
  latence de réponse réelle.)
- **Invariant tells préservé (spec mère §2)** : le profil clone **DÉCLARE des tells non vides**. Le rejeu hybride
  **tue les tells moteurs** (c'est ta vraie motricité) mais **garde les tells cognitifs** (raisonnement inédit,
  social/méta-jeu, réaction à l'imprévu, incohérence inter-session) + un tell « signature figée » (cf. §9). Un
  clone sans tells est **rejeté par `validateProfile`** — invariant garanti *par construction*.
- **Pas d'objectif d'indétectabilité absolue** : finalité **purple-team** (entraîner la modération). On ne
  construit pas un outil dont le but serait de battre un anti-cheat tiers en production.
- **Accès admin-only** (RBAC, `_require_admin`). Données **locales** sur l'Omen, gitignored, **supprimables**.
- **Déploiement = sessions d'entraînement contrôlées** (spec mère §2).

## 3. Architecture (topologie)

```
Client du joueur-modèle (Java)            OmenServer (Python/FastAPI)              Node (mc-agent, déjà là)
  mc-capture-mod (Fabric)                   mc_capture_router.py                     index.js + profiles/ + humanize.js
   ├ HUD REC / REC-off (F8)                  POST /captures   ◀── upload manuel ──   (Phase 0/1)
   ├ capte inputs+état+chat (REC on)         GET  /captures
   └ écrit session-<ts>.jsonl  ───────┐      POST /captures/{p}/distill ─┐
        (fichier LOCAL)               │      GET  /captures/{p}/style     │  distillation →
   (le joueur relit puis upload   ────┘       data/mc-captures/<joueur>/  │   ① style.json  (stats chat/réaction/faute)
    via le dashboard)                          ├ session-*.jsonl          │   ② clips/*.json (motricité réelle segmentée)
                                               ├ style.json    ◀──────────┘
                                               └ clips/                    1b.2 : start_session(--style …) → params chat
                                                     │                     1b.3 : profil clone → moteur de rejeu hybride
                                                     │                            (cerveau décide QUOI ; clips = COMMENT)
                                                     └──────────────────────▶ session bot → le staff s'entraîne
```

> **Point clé déploiement** : **l'Omen ne gagne AUCUNE dépendance runtime.** Le mod tourne sur le *client* du
> joueur ; OmenServer **ingère + distille** (Python **stdlib**). Le toolchain **Java/Gradle n'est requis qu'au
> BUILD** du `.jar` (machine de dev). Contraste assumé avec Node/Mineflayer (runtime sur l'Omen, spec mère §13).
>
> **Ce que voit un observateur** : Mineflayer envoie des paquets position+visée. Rejouer tes séquences réelles à
> travers lui reproduit **ce que les autres joueurs / l'anti-cheat observent** (le rendu/animation client est
> hors-sujet pour la détection). La fidélité « observable » est donc atteignable ; le vrai défi est le **mélange
> rejeu ↔ navigation vers un but** (cf. §9, R&D).

## 4. Composants & fichiers

### Java / Fabric — `mc-capture-mod/` (nouveau, dans le repo OmenServer)

| Fichier | Rôle |
|---|---|
| `build.gradle`, `settings.gradle`, `gradle.properties` | Fabric Loom + multi-version (Stonecutter ou 2 configs) |
| `src/main/.../CaptureMod.java` | entrypoint Fabric : enregistre les hooks (tick, chat, HUD, keybind F8) |
| `src/main/.../Recorder.java` | machine d'état REC/off : ouvre/écrit/ferme la session, erreur→off |
| `src/main/.../TickSampler.java` | lit inputs + état joueur par tick → record |
| `src/main/.../ChatHook.java` | capture chat sortant **et** entrant (contenu + timing) |
| `src/main/.../RecHud.java` | overlay `● REC` (rouge) / `REC-off` (gris) |
| `src/main/.../SessionWriter.java` | **sérialisation JSONL + header — logique PURE, testable hors client** |
| `src/main/resources/fabric.mod.json` | métadonnées + dépendances Fabric API |
| builds | `mc-capture-<modver>-mc1.21.x.jar` **puis** `…-mc1.20.x.jar` |

### Python — `backend/bots/`

| Fichier | Rôle |
|---|---|
| `mc_capture_router.py` | `POST /api/mc-agent/captures` (upload), `GET /captures`, `POST /captures/{player}/distill`, `GET /captures/{player}/style`, `DELETE …` — **admin-only** |
| `mc_capture_store.py` | stockage `data/mc-captures/<joueur>/`, validation header/.jsonl, listage, suppression |
| `mc_capture_distill.py` | `.jsonl` → ① `style.json` (stats, stdlib `statistics`) + ② `clips/` (segmentation motricité) |
| `mc_agent_manager.py` *(modif)* | `start_session(..., style=None, clips=None)` → passe `--style`/`--clips` au Node ; métadonnées clone |
| `tests/test_mc_capture_*.py` | upload/store/distill/segmentation/admin-only (fixtures `.jsonl` réelles) |

### Node — `mc-agent/` (extension Phase 0/1)

| Fichier | Rôle |
|---|---|
| `profiles/clone.js` | `buildCloneProfile(style, player)` → profil **tells-bound** (passe `validateProfile`) |
| `motion/clipLibrary.js` | charge `clips/`, indexe par contexte (locomotion/turn/idle/mine/combat) |
| `motion/replayer.js` | **moteur de rejeu hybride** : joue un clip réel (controlState + look + timing) pour réaliser l'action décidée par le cerveau ; re-synchronise sur le but |
| `index.js` *(modif)* | `--style` (params chat) + `--clips` (active le rejeu hybride pour le clone) |
| `bin/clone-profile.js` | métadonnées clone sérialisables (pour l'UI) |
| `test/clone.test.js`, `test/replayer.test.js`, `test/calibration.test.js` | tells non vide + sélection/lecture de clip déterministe + merge stats |

### Frontend — `frontend/js/bots_module.js`

Panneau **« Captures »** (admin) : dropzone upload, liste des sessions (date, durée, ticks), **voir stats**
(`style.json` lisible), **supprimer**. Le profil **`Clone de <joueur>`** dans le sélecteur + sa **fiche de tells**.
i18n `mcagent.capture.*`. Échappement HTML (anti-XSS). Cache-bust `?v=` + `CACHE_NAME`.

## 5. Le mod Fabric (1b.1)

### 5.1 Cycle de consentement (machine d'état REC)

1. **Lancement** → `OFF`, HUD `REC-off`. **1er lancement** → notice de consentement (écran/chat) : *« Ce mod
   enregistre tes inputs, déplacements et le chat pour l'entraînement de la modération de <serveur>. Rien n'est
   envoyé automatiquement — tu choisis d'uploader. F8 pour démarrer/arrêter. »*
2. **F8** → `START` : ouvre `mc-capture/session-<epoch>.jsonl`, écrit le **header**, HUD → `● REC` (rouge).
3. **F8** → `STOP` : flush + close, HUD → `REC-off`.
4. **Erreur d'I/O** → `STOP` auto + HUD `REC-off` + message. ⇐ « si problème = REC-off ».
5. Le fichier **n'est jamais transmis par le mod** (upload manuel only).

### 5.2 Schéma de capture

**Header** (1re ligne) :
```json
{"schema":1,"player":"Massii_08","uuid":"…","mc":"1.21.4","mod":"0.1.0","consent":true,"startedAt":1748540000000,"sampleHz":20}
```
**Record `tick`** (client tick, 20 Hz ; décimable 10 Hz) :
```json
{"t":1234,"type":"tick","in":{"fwd":1,"back":0,"left":0,"right":0,"jump":0,"sneak":0,"sprint":1,"atk":0,"use":0},"yaw":-12.4,"pitch":3.1,"pos":[120.5,64,-30.2],"vel":[0.21,0,0.02],"og":1,"hp":20,"food":17,"held":"iron_sword"}
```
**Events** (intercalés) :
```json
{"t":1500,"type":"chat_out","text":"jarrive 2 sec","len":13}
{"t":1600,"type":"chat_in","from":"Steve","text":"tu peux ramener du bois ?","len":24}
{"t":2100,"type":"mob_appear","kind":"zombie","dist":7.2}
{"t":2240,"type":"damage","amount":3.0}
{"t":3000,"type":"attack","target":"zombie","dist":2.1}
{"t":9000,"type":"death"}
```
> Le flux `tick` **est** la matière première des clips de motricité (§7.2). Stretch hors v1 : cadence de frappe
> par caractère dans la box de chat.

### 5.3 Multi-version

Une **codebase**, builds par version (Stonecutter ou 2 configs). Surface version-spécifique minime (mappings +
Fabric API). **Cible validée en premier : 1.21.x**, puis estampillage **1.20.x**.

## 6. Transport & stockage (1b.1)

- **Upload manuel** : dashboard → MC Agent → « Importer une capture » → `POST /api/mc-agent/captures`
  (multipart). Validations : header `schema` valide, taille bornée, extension `.jsonl`(`.gz`). Le **`player`
  vient du header**.
- **Stockage** : `data/mc-captures/<joueur>/session-<epoch>.jsonl` (+ `style.json` + `clips/`). `data/`
  gitignored. **Admin-only**. Pas de DB en v1.
- **`DELETE`** pour retirer une session / un joueur (droit à l'effacement).
- **Attribution automatique** : le `player` venant du **header**, c'est sans souci si **un seul admin (toi)
  uploade les fichiers de toute l'équipe** (les volontaires non-admin te remettent leurs `.jsonl` hors-bande,
  Discord/USB) — chaque capture atterrit dans le bon dossier joueur toute seule.
- **Volume (équipe × ~5 h)** : décimation **10 Hz** par défaut + **compression `.gz`** acceptée à l'upload
  (~10-15 Mo/personne compressé — négligeable sur l'Omen). Limite de taille multipart **généreuse**.
- **Batch & ré-exécutable** : la distillation se **relance** sur le dossier (enrichi) d'un joueur quand de
  nouvelles captures arrivent → `style.json` + `clips/` régénérés/cumulés. Aucune contrainte de délai.

## 7. Distillation (1b.1) → deux sorties

`mc_capture_distill.py` lit les sessions d'un joueur et produit **deux** artefacts :

### 7.1 `style.json` — statistiques (alimente la calibration 1b.2)

| Bloc | Contenu | Dérivé de |
|---|---|---|
| `reaction` | `{meanMs, stdMs, n}` | stimulus (`mob_appear`/`damage`) → 1er changement d'input |
| `chat` | `{latencyMeanMs, latencyStdMs, typoRate, msgLenMean, msgs}` | `chat_in` → `chat_out` suivant ; typo heuristique |
| `errorRate` | proxy : gestes ratés / corrections (misclic, reversals rapides, demi-tours de correction) — **approximatif** | flux tick |
| `derivedParams` | **1:1 avec `profile.params` (§7.1)** : `{chat:{latencyMeanMs,latencyStdMs,typoRate}, errorRate, movementJitter}` | agrégat |

```json
{"schema":1,"player":"Massii_08","sessions":3,"ticks":42000,"durationS":2100,
 "reaction":{"meanMs":480,"stdMs":260,"n":54},
 "chat":{"latencyMeanMs":2600,"latencyStdMs":1400,"typoRate":0.06,"msgLenMean":22,"msgs":80},
 "errorRate":0.09,
 "derivedParams":{"chat":{"latencyMeanMs":2600,"latencyStdMs":1400,"typoRate":0.06},"errorRate":0.09,"movementJitter":0.34}}
```

### 7.2 `clips/` — bibliothèque de motricité réelle (alimente le rejeu 1b.3)

Le flux `tick` est **segmenté** en clips courts taggés par contexte, chacun = une séquence de
`{in (controlState), yaw, pitch}` par tick (la matière à rejouer) :

| Contexte | Ce qu'on extrait |
|---|---|
| `locomotion` | marche/strafe en ligne (gigue de visée + micro-corrections réelles) |
| `turn` | courbes de demi-tour / rotation de caméra réelles |
| `idle` | micro-mouvements d'attente (regard qui balaie, petits pas) |
| `mine` | cadence et rythme de minage |
| `combat` | rythme de clic + tracking de cible |

Format clip (`clips/locomotion/0007.json`) :
```json
{"ctx":"locomotion","player":"Massii_08","durTicks":48,"frames":[{"in":{"fwd":1,"sprint":1},"dyaw":-0.6,"dpitch":0.1}, …]}
```
> Les **frontières de segmentation** et le tagging exacts se finalisent sur tes vraies captures ; la spec fige la
> **forme** (clips = séquences de controlState + deltas de visée réels, indexées par contexte).

## 8. Calibration (1b.2) — stats chat/réaction

- `start_session(..., style=<path>)` → `--style` au Node ; `index.js` **merge `derivedParams`** par-dessus les
  `params` du profil choisi (override sélectif). **`tells` inchangés.**
- Couvre ce que les stats modélisent bien : **latence de chat, temps de réaction, taux de faute**. Le **mouvement
  reste celui de la Phase 1** à ce jalon (le mouvement « réel » arrive en 1b.3 via les clips).
- **Test** : merge déterministe, `tells` intacts, sans `--style` = comportement Phase 1 inchangé (non-régression).

## 9. Profil clone à exécution hybride (1b.3) — « mes vrais mouvements »

C'est le cœur de la demande Massii. Le profil clone **n'utilise pas des params synthétiques pour le mouvement** :
il **rejoue tes clips de motricité réelle**, pilotés par le cerveau.

**Mécanique :**
1. Le **cerveau** (Claude + skills, déjà là) décide l'action (`goto`/`follow`/`mine`/`attack`/`idle`) + le chat.
2. Le **`motion/replayer.js`** sélectionne le **clip réel** correspondant au contexte et le **rejoue** (séquence
   `controlState` + `look` réelle, au timing réel), en le **réorientant** vers la cible courante, puis re-synchronise
   sur le but (pathfinder) entre les clips.
3. Le chat/timing utilise les **stats** (`derivedParams`) — latence, fautes.

**Profil** (`mc-agent/profiles/clone.js`) :
```js
buildCloneProfile(style, player) → {
  id: `clone-${player}`, level: 4, label: `Clone de ${player}`,
  summary: 'Motricité = clips réels du joueur (rejeu hybride) ; chat = stats mesurées.',
  persona: <persona Expert>,
  params: style.derivedParams,        // pour le chat/timing
  motion: 'clips',                    // ← le mouvement passe par le replayer, pas par les params
  tells: [
    …3 tells cognitifs Expert (raisonnement inédit / connaissance sociale-méta / réaction à l'inédit)…,
    'Signature figée : la motricité vient de clips datés — elle ne dérive pas avec la fatigue/l'humeur sur une ' +
    'longue session et se répète d'une session à l'autre, alors qu'un vrai joueur varie.',
  ],
}
```
- Passe `validateProfile` (tells non vide) → **invariant par construction**. Tier 4 (sommet de difficulté :
  tells moteurs tués, seuls restent les cognitifs).

**⚠️ Caveat R&D (arbitrage honnête)** : c'est la partie la plus ambitieuse. Mineflayer bouge via contrôles
haut-niveau ; **mélanger rejeu de clips réels et navigation vers un but** est du vrai R&D (le clip te fait
avancer « à ta façon », mais il faut atteindre une cible mouvante). **On prototype 1b.3 d'abord** pour valider la
faisabilité. **Repli prévu** si le tout-clip est trop cassant : **clips réels en *overlay* de texture** (gigue de
visée + idle + cadence réels superposés à la nav du pathfinder) plutôt que clips 100 % pilotes — déjà bien plus
« toi » que les params synthétiques, et robuste.

## 9.1 Profil composite « dream team » (1b.4)

Extension naturelle de 1b.3 quand **plusieurs** volontaires ont capturé : un profil dont **chaque contexte est
fourni par le meilleur joueur dans ce domaine**.

```js
// mc-agent/profiles/composite.js
buildCompositeProfile({ combat: 'AcePVP', locomotion: 'Runner', mine: 'Digger' }, chat: 'AcePVP') → {
  id: 'composite-dreamteam', level: 4, label: 'Dream Team',
  motion: 'clips',                 // clips piochés par contexte chez la source mappée
  sources: { combat:'AcePVP', locomotion:'Runner', mine:'Digger' },
  params: <style du contributeur chat choisi>,
  tells: [ …tells cognitifs Expert…,
    'Incohérence de signature inter-compétences : le style de visée en COMBAT ne correspond pas à celui ' +
    'du DÉPLACEMENT (mains différentes assemblées) — un vrai joueur garde la même main partout.' ],
}
```

- **Le composite ne dilue pas l'invariant, il le renforce** : il tue encore mieux les tells moteurs *par geste*,
  mais **crée un tell documentable** → l'**incohérence de signature entre compétences** (sensibilité/visée qui
  changent selon l'activité). On déplace le tell vers plus subtil **et on l'écrit dans le corrigé**. Passe
  `validateProfile`.
- **Mapping = un joueur par compétence** (lisible, chaque tell traçable à sa source). Variante « pool mélangé par
  contexte » = non-goal v1 (signature plus floue, corrigé plus dur à documenter).
- ⚠️ **Normalisation** : sensibilités souris différentes → échelles de deltas yaw/pitch différentes entre
  contributeurs. On capture les deltas **réels en jeu** (ce que le serveur voit) donc c'est cohérent, mais un
  calage léger sera validé sur vraies captures.
- **Placement** : après 1b.3 (le rejeu mono-joueur doit d'abord être prouvé). Aucune refonte requise — c'est un
  *mapping contexte→source* par-dessus le `clipLibrary`/`replayer` de 1b.3.

## 10. UI (1b.1 + 1b.3)

Panneau **« Captures »** (admin) : dropzone, liste sessions (date/durée/ticks), **voir stats**, **supprimer**.
(1b.3) profil **`Clone de <joueur>`** dans le sélecteur + **fiche de tells** (corrigé). i18n `mcagent.capture.*`,
échappement HTML, cache-bust.

## 11. Tests

- **Java** : `SessionWriter` (record→JSONL + header), `Recorder` (start/stop/erreur→off), `ChatHook`
  (in+out capturés). Logique pure testable **sans client**. HUD/hooks réels = smoke manuel.
- **Python** : upload (store, validation), distillation **stats** (fixture → `style.json` attendu) **et
  segmentation clips** (fixture → clips bien formés/taggés), admin-only (403), `DELETE`.
- **Node** : merge calibration (stats→params, tells intacts) ; `clipLibrary` (indexation/sélection
  déterministe) ; `replayer` (joue les frames d'un clip dans l'ordre sur un `bot` mocké) ; `buildCloneProfile`
  (tells non vide, `motion:'clips'`).
- **Smoke e2e** : build `.jar` (1.21.x) → install (Fabric Loader + `.jar`) → F8 `REC` → upload → voir stats →
  (1b.2) profil **calibré** (chat réaliste) → (1b.3) **clone** : le bot se déplace avec **ta** motricité + tells affichés.

## 12. Déploiement

- **Runtime Omen inchangé** : aucune nouvelle dépendance prod. Distillation = Python **stdlib**.
- **Build du mod (dev only)** : JDK 21 (1.21.x) / JDK 17 (1.20.x) + Gradle (Fabric Loom). Machine de dev (Mac)
  ou l'Omen — **pas requis en runtime prod**.
- **Distribution du `.jar`** : le joueur installe **Fabric Loader** (matching version) + dépose le `.jar` dans
  `mods/`. Guide court. Téléchargeable depuis le dashboard (option) ou remis à la main.
- `data/mc-captures/` créé au 1er upload (gitignored).
- **CLAUDE.md** : documenter le module Java/Fabric (build-time) + pièges Fabric/mappings/multi-version + le moteur
  de rejeu (Mineflayer controlState).

## 13. Scope / non-goals (explicite)

- ❌ **Capture passive** d'un joueur lambda comme cible de clonage (sans consentement explicite).
- ❌ **Rejeu verbatim de session (macro/ghost)** : aveugle au contexte (fonce dans un mur, ignore le chat,
  répète) → mauvais adversaire **et** facile à griller. Rejeté au profit de l'hybride (§9).
- ❌ **Effacement des tells** / indétectabilité absolue contre un anti-cheat tiers en prod.
- ❌ **Auto-POST** du mod vers l'API (v1 = upload manuel).
- ❌ Cadence de frappe **par caractère** (stretch).
- ❌ **Bedrock** (Fabric = Java only).
- ❌ **DB** des captures (fichiers en v1).
- ❌ **Modèle ML génératif** de trajectoires (réseau de neurones) : v1 = **rejeu de clips réels** + stats, pas
  d'apprentissage de modèle. Extension lourde future éventuelle (Phase 1c).

## 14. Sécurité

- **Admin-only** (RBAC) sur tous les endpoints capture.
- **Upload validé** (header `schema`, taille bornée, extension ; rien d'exécuté).
- Données **locales** gitignored, **supprimables** ; chat capturé reste **interne** (jamais re-publié) bien que
  déjà public sur Discord.
- **Aucun credential** dans le mod (upload manuel → rien à exfiltrer).
- **Échappement** à l'affichage des stats/chat (anti-XSS).

## 15. Nom

- Mod : travail **« OmenCapture »** (ticker `CAP`) — à rebaptiser.
- Profil généré : **« Clone de <joueur> »** (id `clone-<joueur>`, Tier 4).

---

## Décisions tranchées (2026-05-30)

1. **Modèle d'exécution = hybride** (clips de motricité réelle pilotés par le cerveau) — pas macro verbatim, pas
   synthèse IA. Repli overlay prévu (§9).
2. **Chat = capture complète** (in+out, contenu) — déjà public sur Discord ; admin-only, non re-publié.
3. **Version validée en premier = 1.21.x** (1.20.x ensuite).
4. **Keybind REC = F8**.
5. **`errorRate`** conservé (taux de gestes ratés/corrections, calé sur les vraies captures).
6. **Mode batch multi-contributeurs** : équipe de volontaires (~5 h chacun) → remise des `.jsonl` → upload par
   l'admin (attribution auto par header) ; **aucune contrainte de délai** ; flux **continu** (re-distillation).
7. **Composite « dream team » = jalon planifié 1b.4** (un joueur par compétence), après 1b.3.
8. **Division du travail** : distillation auto *digère le volume* ; l'humain *façonne le profil* (clips,
   calibration, tells) ; le bot tourne ensuite en autonomie.
