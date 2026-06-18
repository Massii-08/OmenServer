# AI Harvester — moissonneur continu + API privée + export client — design

- **Date** : 2026-06-18
- **Statut** : design approuvé (Massii : « GO, on fait ce qu'on a dit » + clé unblocker + bouton export client)
- **Repo** : OmenServer (`backend/bots/` + `frontend/js/`), branche `feat/ai-harvester`
- **Module** : nouvelle carte « AI Harvester » dans le module Bots (admin-only)

---

## 1. But

Un **bot dans le module Bots d'OmenServer** qui : on lui donne **une URL + ce qu'on veut** (langage naturel) → il **moissonne la cible en continu** (heure après heure, low-and-slow, sans se faire flag) → accumule la donnée → l'expose via une **API privée** (clé). En setup, **Claude Code (local Omen)** génère la recette d'extraction + le plan de crawl + calibre le débit. Le **runtime est déterministe** (zéro IA). Deux usages : (a) **R&D perso** de Massii (tester ce qu'un client veut), (b) **export** d'un système autonome livrable au client.

## 2. Pourquoi c'est faisable (et les limites assumées)

- **Low-and-slow** : étaler les requêtes à rythme humain → récupérer beaucoup **sur la durée** sans déclencher le flag de débit. On échange du **temps** contre de la discrétion (≠ massif-et-vite qui flague).
- **Limites honnêtes (dans la doc + UI)** : (a) c'est **lent** (« tout » d'un gros site = jours/semaines) ; (b) **plafond IP** même en lent → au-delà = **diversité d'IP payante** (unblocker, cf. §7) ; (c) reboot nocturne de l'Omen → **reprise sur état persistant** ; (d) **limite d'opération** : on construit l'outil + on **branche** les tiers payants ; opérer l'aspiration massive d'une cible **hostile** reste l'appel de l'utilisateur. Cible **propre/autorisée** = crawler poli, zéro souci.

## 3. Architecture (mirroir du Bond Scanner)

Le Bond Scanner (`scanner_router.py`) est l'analogue : scrape long **détaché** (`subprocess.Popen(start_new_session=True)` → survit à l'auto-deploy), job en mémoire + statut/progression + thread de capture de logs, **clé API chargée depuis un fichier config + passée en env au subprocess**. Le harvester reprend ce pattern.

```
SETUP (1×, Claude Code local)            RUNTIME (déterministe, détaché, heure après heure)
 URL + instructions NL                     boucle paced :
   → probe difficulté (headers CF, 429,       prochaine URL non-faite (frontier)
      robots Crawl-delay)                       → fetch (tier selon difficulté)
   → claude -p :                                → recette → no-PII gate → store
       recette {champs→sélecteurs}              → marque "fait" + pause (pacing)
       plan de crawl {sitemap|pagination|cat}   → back-off adaptatif si 429/challenge
       pacing calibré {intervalle, tier}      état persistant → reprise après reboot
   → run déterministe d'un échantillon              │
   ↳ preview {données, recette, difficulté}         ▼
                                            API PRIVÉE (clé) : GET /data → tout l'accumulé
                                                              GET /status → progression
                                                   │
                                                   ▼  bouton EXPORT
                                            package STANDALONE livrable client (zip)
```

## 4. Composants

### Backend — `backend/bots/harvester_router.py` (FastAPI, prefix `/api/bots/harvester`, admin-only)
- `POST /setup` — {url, instructions} → probe difficulté + `claude -p` (recette + plan + pacing) + run échantillon → `{recipe, plan, pacing, difficulty, sample}`. **Seule étape LLM.**
- `POST /run/{id}` — lance le moteur en **subprocess détaché** (`start_new_session=True`), recette/plan/config + **clé unblocker passée en env**. Job en mémoire + capture logs + progression.
- `GET /status/{id}` · `GET /active` · `POST /stop/{id}` — comme le scanner.
- `GET /data/{id}` — **API privée** sur le store accumulé, **protégée par une clé par-harvest** (header `X-Feed-Key`). `?format=json|csv`.
- `POST /export/{id}` — génère le **package client standalone** (zip) → download.
- `GET/POST /config` — gérer la **clé unblocker** (masquée, comme la clé rating du scanner).

### Backend — `backend/bots/harvester/` (le moteur ; réutilisé tel quel par l'export)
| Fichier | Rôle | Testable |
|---|---|---|
| `engine.py` | boucle moisson : frontier → fetch → extract → gate → store → pace → reprise | pur (clock/fetch/sleep injectés) |
| `fetch.py` | fetcher à tiers : httpx → curl_cffi → patchright stealth → **unblocker** (switch par config/difficulté) | offline (session injectée) |
| `recipe.py` | modèle recette {champs→sélecteurs} + **extracteur déterministe** (HTML→records, zéro LLM) | pur (fixtures HTML) |
| `crawl.py` | exécuteur de plan : énumère les URL (sitemap / pagination / catégories) | pur (fixtures) |
| `pacing.py` | **probe difficulté + calibration** + **back-off adaptatif** (429/challenge → ralentit+cooldown) | pur (réponses simulées) |
| `policy.py` | **no-PII gate** (porté de Feedsmith `FieldPolicy`) | pur |
| `store.py` | records accumulés + **frontier (fait/à-faire)** persistés (JSON/SQLite), resumable | pur |
| `llm.py` | helper `_claude` (porté du Sniper : `claude -p --output-format json`, stdin) — **setup only** | mock subprocess |
| `exporter.py` | recette/config → **package client standalone** | pur (génère + vérifie l'arbo) |
| `__main__.py` | entrypoint du subprocess détaché (charge config → boucle) | smoke |

### Frontend — `frontend/js/`
- Carte virtuelle **« AI Harvester »** dans `bots_module.js` (admin-only, `openHarvester()`), comme Yield/Scanner/MC-Agent.
- `harvester_module.js` (nouveau) — vue dédiée : **formulaire setup** (URL + instructions) → **Tester/preview** (données + recette éditable + tier de difficulté) → **Lancer/Arrêter** + **progression live** → **clé API privée** affichée → **config clé unblocker** (masquée) → **bouton Exporter pour le client**.
- i18n FR/EN/IT + cache-bust (`?v=` dans index.html + `CACHE_NAME` sw.js).

## 5. Pacing calibré + adaptatif (le cœur anti-flag)

1. **Setup — calibration** : probe (headers `cf-ray`/challenge, `429`/`Retry-After`, `robots.txt Crawl-delay`, rate-limit headers) → **tier** : `facile` (1–2s, httpx, concurrence OK) · `moyen` (3–8s jitter, curl_cffi, séquentiel) · `dur` (15–30s+, stealth ; si infaisable sans IP → suggère unblocker). Respecte le `Crawl-delay` du robots.
2. **Runtime — back-off adaptatif (le vrai filet)** : si `429`/challenge en cours → **augmente l'intervalle** puis **cooldown** ; ne martèle jamais. La calibration = bon départ ; l'adaptation = la sécurité.

## 6. Clé unblocker (méthode de branchement)

- Stockée comme la clé rating du scanner : **fichier config `data/harvester_config.json`** (chmod 600) **OU** `.env` (`UNBLOCKER_API_KEY`, `UNBLOCKER_PROVIDER`), **masquée** dans l'UI (toggle show/hide, comme les autres clés du dashboard).
- `harvester_router._load_unblocker_key()` → passée au subprocess **via env** (`subprocess_env["UNBLOCKER_API_KEY"]`), comme le scanner passe `BRAVE_SEARCH_API_KEY`.
- `fetch.py` : si la clé est présente ET (difficulté `dur` OU tier `unblocker` choisi) → route la requête vers l'API unblocker (un simple GET HTTP, **pas de nouvelle dép**) au lieu de httpx/stealth. Provider par défaut = générique (URL + clé), pré-réglages Zyte/Bright Data.
- **Massii met la clé lui-même** dans le panel ; je ne la manipule pas (règle secrets).

## 7. Export pour le client (bouton)

`POST /export/{id}` → `exporter.py` génère un **dossier autonome zippé** :
- le moteur **déterministe** (engine/fetch/recipe/crawl/pacing/policy/store/__main__) + un **mini FastAPI** pour l'API privée ;
- la **recette + plan + pacing + config** de CETTE cible, figés ;
- `requirements.txt` (minimal) + `README` (run : `pip install -r requirements.txt && python -m harvester`) + `.env.example` (slot clé unblocker du client) ;
- **zéro Claude/LLM** (déterministe) → le client lance chez lui → son feed privé continu.
- C'est « la version du bot qui fait QUE ce scrape » de la demande initiale.

## 8. Réutilisation (ne pas réinventer)

- **scanner_router** : pattern subprocess détaché + statut/active/stop + clé-via-env + capture logs.
- **Feedsmith** (`~/feedsmith/managed-data-feed-starter`) : porter `stealth.py` (tiers fetch + `is_challenge`/`jitter`) + `FieldPolicy` (no-PII) — code déjà testé.
- **Upwork Sniper** (`~/upwork-sniper/sniper/llm.py`) : helper `_claude` (CLI, stdin, json).

## 9. Dépendances / déploiement

- **P1 (httpx only)** : aucune nouvelle dép → auto-deploy propre.
- **Stealth tier** : `patchright` doit être pip-installé dans le **venv backend de l'Omen** (l'auto-deploy ne réinstalle pas — cf. pièges #29/#33) ; import paresseux → erreur claire si absent (comme Feedsmith). ⚠️ RAM (Chrome) partagée avec MC-agent → stealth = petit volume, opt-in.
- **Unblocker tier** : juste httpx → pas de dép.
- **Claude CLI** : `~/.local/bin/claude` (env `CLAUDE_BIN`), déjà présent (v2.1.162).

## 10. Découpage (phases, chacune livrable + testée)

- **P1 — cœur** : `store` (frontier resumable) + `crawl` (sitemap/pagination) + `recipe` (extracteur déterministe) + `engine` (boucle paced httpx) + `harvester_router` (/run /status /active /stop /data) + carte UI + run détaché. **Cible facile, httpx, no-PII gate.** Pas de Claude, pas de stealth. → un harvester qui moissonne une cible propre + API privée. **Le MVP qui marche.**
- **P2 — setup intelligent** : `llm._claude` (recette + plan + calibration depuis un échantillon) + `/setup` + preview UI + recette éditable.
- **P3 — anti-flag avancé** : `pacing` adaptatif (back-off/cooldown) + tier stealth (patchright) + tier **unblocker** + config clé unblocker.
- **P4 — export client** : `exporter` + bouton + zip téléchargeable.

## 11. Tests (offline d'abord, principe OmenServer)

- **Purs** : `recipe` (HTML fixture → records), `crawl` (sitemap/pagination fixtures), `pacing` (réponses simulées → tier + back-off), `policy` (no-PII), `store` (frontier resume), `exporter` (génère l'arbo attendue).
- **Engine** : boucle avec fetch/clock/sleep **injectés** → assert l'ordre fetch→extract→store→pace + reprise + back-off, **zéro réseau**.
- **Router** : FastAPI TestClient (setup mocké, /data clé-protégée, 404, admin-only 403).
- **`llm._claude`** : mock subprocess (pas d'appel CLI réel en CI).
- **Live/manuel** : un smoke réel sur une cible facile (books.toscrape) ; le stealth/unblocker validés au déploiement (jamais de vrai CF depuis l'IP en CI).

## 12. Garde-fous

admin-only (gate backend, pas juste UI) · no-PII gate ON par défaut · stealth = petit volume 1 IP (limites connues) · clé unblocker posée par l'utilisateur (jamais manipulée par l'agent) · Claude seulement au setup · cible hostile à grande échelle = appel de l'utilisateur + coût proxy refacturé client.
