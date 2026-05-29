# MC Agent — Phase 1b : Behavioral Cloning (capture consentie d'un joueur-modèle)

> Spec de design — 2026-05-29
> Statut : **à valider par Massii** avant plan d'implémentation.
> Branche de travail : worktree isolé `worktree-feat+mc-agent-phase1b` (basé sur `origin/main`, indépendant de la Phase 1 qui tourne en parallèle).
> Spec parente : `docs/superpowers/specs/2026-05-29-mc-agent-training-design.md` (§7.1 réalisme paramétré, §14 scope). La présente spec **réintègre** le behavioral cloning que la spec parente avait écarté du cœur, sous un cadre de consentement strict.

---

## 1. Contexte & position dans le projet

Le **MC Agent** est un adversaire d'entraînement purple-team : un bot qui imite un tricheur pour entraîner la modération à le repérer. La **Phase 1** (autre discussion) livre 3 profils de comportement **paramétrés** (Évident / Intermédiaire / Expert), chacun avec sa **fiche de tells** (le corrigé du formateur).

La spec parente classait le **behavioral cloning** (capture des inputs d'un vrai joueur) **hors du cœur** (§7.1, §14) pour deux raisons : (a) c'est une technique d'indétectabilité qui vise à *effacer les tells*, en conflit avec l'invariant du projet ; (b) problème de consentement.

La **Phase 1b** le réintègre **proprement**, en levant les deux objections :
- **(a)** on n'efface PAS les tells : on capture un **style moteur/timing**, les **tells cognitifs** (raisonnement, social, inédit, inter-session) restent intacts → le profil dérivé reste détectable.
- **(b)** capture **uniquement d'un joueur-modèle désigné et consentant**, consentement **actif et visible** (cf. §2).

**Objectif** : capturer le style d'un joueur consentant pour
- **1b.1** — le visualiser (stats distillées),
- **1b.2** — calibrer les profils existants sur du vrai humain (au lieu de constantes devinées),
- **1b.3** — générer un profil « clone » qui reste un exercice (tells cognitifs déclarés).

---

## 2. Cadre éthique & invariants (NON négociables)

1. **Consentement actif & visible.** Capture **uniquement** d'un joueur-modèle **explicitement désigné et consentant** (Massii ou un staff volontaire). Le joueur **installe lui-même le mod** (acte de consentement) **et** voit en permanence un HUD **`REC` / `REC-off`**. Capture **opt-in par session**, **OFF au lancement**. **Jamais** de capture passive de la population, jamais d'auto-démarrage silencieux.
2. **Invariant tells préservé** (spec parente §2). On extrait un **style** (timing, jitter, cadence) ; les **tells cognitifs** ne sont jamais effacés. Le profil clone **DÉCLARE un `tells: [...]` non vide** → passe `validateProfile`. **On ne construit PAS** un clone « zéro tell / indétectable » : ce serait un outil de triche, pas un exercice.
3. **Minimisation & propriété des données.** Les données sont celles **du joueur consentant**, stockées **localement sur l'Omen** (`data/mc-captures/`, déjà gitignored), **admin-only**, jamais partagées ni exfiltrées. **Upload manuel** → le joueur relit avant d'envoyer.
4. **Déploiement training-only.** Sessions contrôlées, ground-truth actif (l'admin sait qui est le bot).
5. **Honnêteté de cadre.** C'est le sous-système **le plus sensible** du projet ; la frontière « entraînement » vs « évasion » est tenue par consentement (§2.1) + invariant tells (§2.2). Ces deux clauses sont testées (cf. §14).

---

## 3. Architecture (topologie)

```
Client du joueur-modèle (consentant)          OmenServer (Omen)                    mc-agent (Node)
  ┌─────────────────────────┐                  ┌──────────────────────┐             ┌───────────────┐
  │ Minecraft + mc-capture   │   .jsonl local   │ mc_capture (Python)  │  style.json │ profiles/      │
  │  (mod Fabric)            │ ───────────────▶ │  POST /captures      │ ──────────▶ │  + humanize    │
  │  HUD REC / REC-off       │  upload MANUEL   │  distillation        │   (1b.2/3)  │  calibration   │
  │  écrit inputs+état+chat  │  (dashboard)     │  data/mc-captures/   │             │  profil clone  │
  └─────────────────────────┘                  └──────────────────────┘             └───────────────┘
        joueur en REC                              stockage consenti                    le bot l'utilise
                                                   admin-only                            staff s'entraîne
```

Le mod tourne **côté client du joueur** (pas sur l'Omen). Le seul lien réseau est l'**upload manuel** d'un fichier via le dashboard (pattern `.xlsx` du Yield Bot) — aucun credential dans le mod, aucune connexion entrante à ouvrir.

---

## 4. Composants & fichiers

### Mod — `mc-capture-mod/` (NOUVEAU, Java/Fabric, dans le repo OmenServer)

| Fichier | Rôle |
|---|---|
| `build.gradle` / `gradle.properties` | build Fabric Loom ; multi-version (Stonecutter ou dual config) → jars 1.20.x + 1.21.x |
| `src/.../CaptureMod.java` | entrée mod : init, keybind toggle REC, état session |
| `src/.../CaptureRecorder.java` | hook client-tick : sérialise inputs + état + events en `.jsonl` |
| `src/.../RecHud.java` | rendu HUD `REC` (rouge) / `REC-off` (gris) |
| `src/.../SessionFile.java` | ouverture/rotation/fermeture du fichier de session + header |

### Backend — `backend/bots/`

| Fichier | Rôle |
|---|---|
| `mc_capture_router.py` | endpoints : upload, list, get-style, delete (admin-only) |
| `mc_capture_manager.py` | stockage `data/mc-captures/<joueur>/`, validation header, registre |
| `mc_capture_distill.py` | `.jsonl` → `style.json` (stats de style, stdlib `statistics`) |
| `tests/test_mc_capture_*.py` | ingestion, distillation (fixtures `.jsonl` connues → stats attendues), endpoints |

### mc-agent — `mc-agent/` (Node, jalons 1b.2 / 1b.3)

| Fichier | Rôle |
|---|---|
| `calibration.js` (1b.2) | applique `style.json.derived_params` sur les params §7.1 d'un profil |
| `profiles/clone.js` (1b.3) | profil dynamique « clone » construit depuis `style.json` ; **tells déclarés** |
| `test/*.test.js` | calibration (style → params), clone (`validateProfile`, tells non vides) |

### Frontend — `frontend/js/bots_module.js`

Panneau **« Captures »** dans la carte MC Agent : import (dropzone), liste des sessions, visualisation des stats distillées ; (1b.3) le profil clone apparaît dans le sélecteur de profil avec sa fiche de tells. **Admin-only**. Clés i18n `mcagent.capture.*` (FR/EN/IT) dans `lang.js`.

---

## 5. Le mod Fabric (`mc-capture-mod/`)

- **Consentement** : OFF au lancement. Une **keybind** (configurable, ex. `F8`) bascule REC on/off **par session**. Tant que REC est OFF, **rien n'est écrit**.
- **HUD** : `● REC` (rouge) quand capture active et fichier ouvert sans erreur ; `REC-off` (gris) sinon (arrêté OU erreur d'écriture). Le joueur voit donc toujours l'état réel.
- **Captures** (hook client-tick, downsampling configurable, défaut 1 record/tick = 20 Hz) :
  - **inputs** : états des touches (avancer/reculer/gauche/droite/saut/sneak/sprint/attaque/usage) + clics ;
  - **visée** : `yaw` / `pitch` (deltas → jitter de visée) ;
  - **état jeu** : position, vélocité, on-ground, santé, faim, item en main, nb d'entités hostiles proches ;
  - **events** (sparse) : message chat envoyé (+ durée de frappe si mesurable), attaque d'entité, casse de bloc, dégâts reçus.
- **Sortie** : fichier `.jsonl` local (1 ligne header + N lignes par tick + lignes d'events).
- **Build** : Gradle + Fabric Loom ; multi-version. **On valide la boucle complète sur UNE version d'abord** (celle du joueur-modèle), puis on estampille la 2ᵉ.

### 5.1 Schéma de capture (`.jsonl`, `schema:1`)

**Header (1ʳᵉ ligne) :**
```json
{"type":"header","schema":1,"player":"Massii_08","consent":true,"mc_version":"1.21.1","mod_version":"0.1.0","started_at_ms":1717000000000,"tick_hz":20}
```
**Record par tick :**
```json
{"t":1450,"ms":72500,"pos":[12.3,64.0,-8.1],"yaw":131.4,"pitch":-3.2,"vel":[0.21,0,0.02],"onGround":true,"keys":{"fwd":1,"back":0,"left":0,"right":0,"jump":0,"sneak":0,"sprint":1},"atk":0,"use":0,"hp":20,"food":18,"held":"minecraft:stone_sword","hostiles":2}
```
**Events (sparse) :**
```json
{"t":1452,"ms":72600,"ev":"attack_entity","target":"zombie","dist":2.3}
{"t":1600,"ms":80000,"ev":"chat_send","text":"slt ça va","typingMs":1840}
{"t":1605,"ms":80250,"ev":"damage_taken","amount":3,"source":"zombie"}
```
> `consent:true` dans le header est **obligatoire** : l'ingestion **rejette** tout fichier sans ce flag (garde-fou §2.1). Le `text` du chat n'est capturé **que** si le joueur a laissé l'option contenu activée (cf. §6, choix « contenu+timing » validé).

---

## 6. Transport & stockage (consenti)

- **Upload manuel** : dashboard → MC Agent → **« Importer une capture »** (dropzone) → `.jsonl` (ou `.zip` de plusieurs sessions). Le joueur **relit / choisit** ce qu'il envoie → consentement renforcé ; aucun credential planqué dans un mod distribué ; marche même si le volontaire est distant.
- **Validation à l'ingestion** : extension, taille max, parse du header, **`consent:true` requis**.
- **Stockage** : `data/mc-captures/<joueur>/<session-id>.jsonl` (`data/` est **déjà gitignored** → l'auto-deploy ne risque rien). **Admin-only**.
- **Pas de DB en v1** : fichiers + registre en mémoire (pattern Yield/Scanner).
- **Chat = contenu + timing** (choix Massii) : le contenu aide à modéliser persona/fautes ; il reste local, admin-only, relisable avant envoi. Le mod offre une option pour ne capturer que le timing si le joueur préfère.

---

## 7. Distillation → `style.json` (jalon 1b.1)

`mc_capture_distill.py` lit le(s) `.jsonl` d'un joueur et produit un `style.json` (Python 3.9, stdlib `statistics` — **aucune dépendance lourde**) :

```json
{
  "player":"Massii_08","sessions":3,"ticks":120000,
  "reaction":{"meanMs":312,"stdMs":98,"p95":520,"n":214},
  "aim":{"yawJitterStd":4.2,"pitchJitterStd":2.1,"flicksPerMin":18},
  "click":{"interClickMs":{"mean":420,"std":160},"cps":2.3},
  "movement":{"ctrlChangesPerMin":74,"jitter":0.27,"strafeRatio":0.18},
  "chat":{"typingCps":3.1,"typoRate":0.05,"msgLen":{"mean":14,"std":9}},
  "derived_params":{
    "chat":{"latencyMeanMs":312,"latencyStdMs":98,"typoRate":0.05},
    "movementJitter":0.27,
    "errorRate":0.08
  }
}
```

`reaction` se calcule sur les latences **event → action** (ex. `damage_taken` → première fuite/attaque). Le bloc **`derived_params` est le pont** : il a exactement la forme des params §7.1 d'un profil → consommé tel quel par la calibration (1b.2) et comme graine du clone (1b.3).

---

## 8. Calibration des profils (jalon 1b.2)

- `style.json.derived_params` **écrase** les params §7.1 (`latencyMeanMs/StdMs`, `typoRate`, `errorRate`, `movementJitter`) d'un profil existant à son chargement.
- Mécanisme : `loadProfile(id, { styleOverride })` côté Node, ou un drapeau `--style <path>` passé par le manager Python au subprocess (la forme exacte sera figée **à l'intégration avec l'API profils finalisée par la Phase 1**).
- **Invariant** : on ne touche **que les params** ; le `persona` et surtout les **`tells` restent inchangés**.

---

## 9. Profil clone (jalon 1b.3)

- `profiles/clone.js` construit un profil **dynamique** depuis un `style.json` : `params` = `derived_params`, `persona` = un texte « joueur crédible » (style Expert).
- **`tells` (déclarés, non vides)** = les tells cognitifs du tier Expert (échec sur raisonnement inédit, trou social/méta-jeu, réaction atypique à l'inédit, incohérence inter-session) **+ un tell propre au clone** :
  > « Style figé d'une seule capture : ne s'adapte pas au contexte, pas de progression d'apprentissage ni d'évolution de jeu entre sessions (rigidité statistique sur la durée). »
- Passe `validateProfile` (invariant §2.2). Sélectionnable dans l'UI avec sa fiche de tells (corrigé formateur).

---

## 10. UI (`frontend/js/bots_module.js`)

- Panneau **« Captures »** (admin-only) : dropzone d'import, liste des sessions (joueur, date, durée, nb ticks), bouton « Voir le style » → rend `style.json` lisible (réaction, jitter, cadences, chat).
- (1b.3) profil **`clone-<joueur>`** dans le sélecteur de profil + sa **fiche de tells**.
- i18n `mcagent.capture.*` (FR/EN/IT). Cache-bust `?v=` + `CACHE_NAME` (pièges #9/#11/#35-bis).

---

## 11. Endpoints backend (admin-only)

| Méthode | Route | Rôle |
|---|---|---|
| `POST` | `/api/mc-agent/captures` | upload d'un `.jsonl`/`.zip` (validation + `consent:true` requis) |
| `GET` | `/api/mc-agent/captures` | liste des sessions stockées |
| `GET` | `/api/mc-agent/captures/{id}/style` | `style.json` distillé |
| `DELETE` | `/api/mc-agent/captures/{id}` | suppression (droit au retrait des données) |

Tous protégés `Depends(get_current_user)` + check rôle admin (pattern module Réseau).

---

## 12. Phasage (jalons — implémentation séquentielle)

| Jalon | Contenu | Installable & utilisable |
|---|---|---|
| **1b.1** | Mod Fabric (REC/REC-off) + ingestion + stockage consenti + distillation + vue stats | ✅ Tu enregistres et tu vois ton style dès ce jalon |
| **1b.2** | `derived_params` calibrent les profils existants (réalisme calé sur du vrai humain) | Profils crédibilisés |
| **1b.3** | Profil dédié `clone-<joueur>` (tells cognitifs + tell « style figé ») | Nouvel adversaire d'entraînement |

L'ordre est **forcé** (1b.2/1b.3 ont besoin de données capturées). Une **seule spec** (ce document) ; **un plan par jalon**, livrés dans l'ordre.

---

## 13. Déploiement

- **Mod** : builds `…-mc1.20.x.jar` + `…-mc1.21.x.jar`. Le joueur dépose le `.jar` dans son dossier `mods/` + **Fabric Loader** de la bonne version. Distribution du `.jar` : via un lien de téléchargement dans le dashboard (à confirmer) ou fichier fourni à la main.
- **Backend** : nouveau module Python, **stdlib uniquement** (pas de `curl_cffi`/pandas) → l'auto-deploy suffit, pas d'install manuelle (contrairement au piège #33).
- **Multi-version** : valider toute la boucle sur **une** version d'abord.
- **Isolation** : développé dans le worktree `worktree-feat+mc-agent-phase1b` (base `origin/main`). **1b.2 / 1b.3 s'intègrent après le merge de la Phase 1** (ils consomment `profiles/` + `humanize`). Conflits de merge attendus sur les fichiers partagés (`bots_module.js`, `lang.js`, router) → résolus à l'intégration.

---

## 14. Tests

- **Mod (Java)** : tests unitaires légers — sérialisation d'un record, bascule REC (rien écrit si OFF), header avec `consent`.
- **Python** : ingestion (rejet si `consent` absent / mauvais format), distillation (fixture `.jsonl` connue → `style.json` aux valeurs attendues), endpoints admin-only.
- **Node** : calibration (`style.json` → params attendus, tells inchangés), clone (`validateProfile` OK, **tells non vides**, contient le tell « style figé »).
- **Garde-fous testés** (§2) : (a) ingestion **refuse** un fichier `consent:false`/absent ; (b) le profil clone **échoue** à se construire si ses `tells` sont vidés.
- **Smoke e2e** : courte capture réelle (REC) → upload → vue du style → (1b.2) profil calibré → (1b.3) clone jouable.

---

## 15. Scope & non-goals (explicite)

**Dans le scope :** capture consentie via mod, upload manuel, distillation, calibration, profil clone tells-bound, UI admin.

**Hors scope (volontaire) :**
- ❌ Capture **passive / sans consentement** de la population.
- ❌ Clone **« zéro tell / indétectable »** (casse l'invariant §2.2).
- ❌ **Auto-upload réseau** depuis le mod (v1 = upload manuel ; un POST direct serait un credential dans un mod distribué).
- ❌ Capture **OS-level hors-jeu** (keylogger système) : uniquement les inputs **in-game** via l'API du mod.
- ❌ Persistance **DB** des captures (fichiers en v1).
- ❌ Entraînement d'un **modèle ML** lourd : on distille en **statistiques paramétriques**, pas un réseau de neurones (YAGNI + reste analysable = cohérent invariant).

---

## 16. Risques & arbitrages

| Risque / arbitrage | Position |
|---|---|
| Nouveau stack **Java/Gradle** dans un projet Python/Node/JS | Assumé : c'est le prix de la haute fidélité (choix Massii) ; mod **minimal** pour limiter la surface |
| Maintenance **par version MC** | Multi-build (1.20.x/1.21.x) ; valider 1 version d'abord |
| Inputs bruts **non rejouables** tels quels dans Mineflayer | Résolu par la **distillation** en stats de style (ce que Mineflayer sait consommer via params) |
| Conflits de merge avec **Phase 1** (fichiers partagés) | Attendus ; résolus à l'intégration post-merge Phase 1 |
| Données chat = **contenu** (PII légère) | Consentement + local + admin-only + relecture avant envoi + option timing-only |

---

## Nom

Mod de travail : **`mc-capture`** (ticker `CAP`). À rebaptiser librement.
