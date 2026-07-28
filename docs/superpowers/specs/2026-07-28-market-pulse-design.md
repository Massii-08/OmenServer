# Market Pulse — bot d'analyse des ouvertures de marché (design)

> Date : 2026-07-28 · Statut : validé par sonde réseau, base moteur livrée, suite déléguée (voir handoff)
> Troisième bot de la suite finance (Yield Bot, Bond Scanner) — utilisateur final : le grand-père de Massii.

## 1. Objectif

Un bot qui suit **les ouvertures des marchés boursiers de différents pays** et produit chaque matin
une photographie claire pour un investisseur particulier :

- **V1 — Horloge des marchés** : quels marchés sont ouverts/fermés maintenant, prochaine ouverture,
  fuseaux horaires (les jours fériés sont couverts par la source, voir §4).
- **V2 — Gaps d'ouverture** : comment chaque indice a ouvert par rapport à la clôture précédente
  (gap % haussier/baissier), enchaînement Asie → Europe → US.
- **V3 — Rapport pré-ouverture quotidien** : digest généré automatiquement le matin (avant
  l'ouverture de Milan) : clôtures US/Asie, futures, FX, matières premières, gaps attendus.
- **V4 — Statistiques historiques** : comportement des ouvertures sur l'historique (gap moyen par
  jour de semaine, fréquence des gaps haussiers, plus gros gaps) + export Excel.
- **V5 — Sentiment presse & Reddit** : tendances extraites des flux RSS de presse financière et de
  Reddit (posts chauds des subs finance), agrégées par thème. **Twitter/X exclu** (API payante,
  scraping fragile et risqué — décision assumée).

**Principe non négociable** : le bot présente des **faits** (cours, gaps, statistiques, titres de
presse). Il ne produit **aucune recommandation d'achat/vente** — même ligne que le Bond Scanner
(critères objectifs, l'humain décide).

## 2. Utilisateur & sorties

- Utilisateur : le grand-père (comme Yield Bot / Bond Scanner) → **contenu des rapports en italien
  par défaut** (configurable), UI trilingue via `Lang.t()` comme le reste du site.
- Sorties : panneau dashboard dans le module Bots (horloge + gaps du jour + dernier rapport),
  **Excel téléchargeable** (format familier, comme les 2 autres bots), rapport texte quotidien.
- Lancement : bouton « Lancer » admin-only (pattern Bond Scanner) + **planification quotidienne**
  via l'APScheduler déjà présent (`backend/scheduler/`).
- Le volet « apprentissage » évoqué par Massii est **hors périmètre v1** (différé explicitement).

## 3. Architecture

Pattern éprouvé de la suite : moteur autonome dans un dossier racine + router FastAPI + carte UI.

```
market-pulse/                  # moteur (comme bond-scanner/)
├── main.py                    # CLI : produit un snapshot JSON + résumé texte
├── pulse/                     # package moteur
│   ├── config.py              # watchlist (16 instruments par défaut), dataclasses
│   ├── fetcher.py             # YahooChartClient (curl_cffi, pacing, retry) — DI injectable
│   ├── quotes.py              # parse chart JSON → MarketData (pur)
│   ├── clock.py               # état ouvert/fermé + prochaine ouverture (pur, now injectable)
│   ├── gaps.py                # gap du jour + stats historiques (pur)
│   └── snapshot.py            # assemble le snapshot complet (contrat d'interface)
└── tests/                     # pytest offline, fixtures Yahoo RÉELLES capturées

backend/bots/market_router.py  # (phase suivante) /api/bots/market/* — miroir scanner_router
frontend/js/bots_module.js     # (phase suivante) carte « Market Pulse » (ticker MKT)
```

**Contrat d'interface = le snapshot JSON** produit par `snapshot.build_snapshot()`. Le router, le
rapport italien, l'Excel et l'UI ne consomment QUE ce contrat — le moteur reste testable seul et
remplaçable (source de données changeable sans toucher au reste).

Le run lourd (snapshot + rapport + Excel) tourne en **subprocess détaché**
(`start_new_session=True`, piège #30f) comme le Bond Scanner ; statut par parsing de logs +
fichiers `data/market_pulse/`.

## 4. Sources de données (décisions VALIDÉES par sonde le 2026-07-28)

| Besoin | Source | Verdict sonde |
|---|---|---|
| Cours indices/futures/FX/or/pétrole | **API chart Yahoo** `query1.finance.yahoo.com/v8/finance/chart/{sym}` | ✅ **16/16 symboles OK** via `curl_cffi impersonate="chrome"` (même mur TLS que Fitch, piège #33). En httpx nu : **429 immédiat** (empreinte TLS détectée). Pas de clé, pas de crumb nécessaire pour /chart. |
| Horaires de séance + fériés | `meta.currentTradingPeriod` de la même réponse Yahoo | ✅ start/end epoch + timezone fournis par Yahoo → **pas de table de jours fériés à maintenir**, pas de dépendance `exchange_calendars` (qui tirerait pandas). |
| Historique (stats V4) | même API, `range=1y` | Même contrat, risque faible (non re-sondé). |
| Fallback / sources dures | **Infra AI Harvester** (tiers httpx → stealth patchright+Xvfb `:100`, opérationnel sur l'Omen → unblocker) | Demande explicite de Massii : ne pas se limiter aux API publiques — réutiliser le système du Harvester pour scraper ce qui résiste (presse paywallée légère, etc.). |
| Stooq (ancien fallback envisagé) | ~~CSV `stooq.com/q/d/l/`~~ | ❌ passé derrière un **challenge JS proof-of-work** (type Anubis) — mort en HTTP pur, pas rentable en stealth vu que Yahoo couvre tout. |
| Sentiment presse | **Flux RSS** presse financière (Il Sole 24 Ore, CNBC, MarketWatch, Investing…) | Gratuit, fait pour ça, stdlib `xml.etree`. Liste exacte des feeds à valider en phase C. |
| Sentiment Reddit | **Endpoints JSON publics** (`reddit.com/r/<sub>/hot.json`) | Gratuit, low-and-slow avec pacing (doctrine Harvester). |
| Twitter/X | — | ❌ exclu (API ~100$/mois, scraping fragile/risqué). |

**Règles d'accès** : pacing ≥ 1,1 s entre requêtes Yahoo (le burst de 11 requêtes httpx a mangé un
429 instantané), retry ×3 avec backoff, session curl_cffi réutilisée. Un cycle complet de 16
symboles ≈ 20 s — largement acceptable pour un rapport matinal.

**Zéro nouvelle dépendance Python** : curl_cffi, httpx, openpyxl sont déjà dans
`requirements.txt` et installés sur l'Omen → l'auto-deploy suffit (piège #33g évité).

## 5. Intelligence / LLM

Runtime **déterministe** (doctrine Harvester) : collecte, gaps, stats, Excel = zéro LLM.
Une seule étape LLM optionnelle : la **synthèse en prose italienne** du rapport quotidien
(1 appel/jour max), via le pattern `_claude` existant (CLI Claude sur token OAuth de l'Omen,
comme Upwork Sniper / Harvester setup). **Dégradation gracieuse** : sans LLM dispo, le rapport
sort quand même en format structuré (tableaux + phrases template).

## 6. Phasage

- **Phase A (base, livrée par cette session)** : moteur `market-pulse/` — fetcher validé, horloge,
  gaps, snapshot, CLI, tests offline sur fixtures réelles.
- **Phase B (Opus 5)** : router backend + carte UI + i18n + Excel + rapport italien + planification
  matinale → le bot complet V1-V4 utilisable par le grand-père.
- **Phase C (Opus 5)** : sentiment RSS + Reddit (+ synthèse LLM du rapport), en réutilisant les
  fetchers/pacing du Harvester.

Le plan détaillé des phases B/C vit dans
`docs/superpowers/plans/2026-07-28-market-pulse-handoff-opus.md` (prompt de passation).

## 7. Tests

- Moteur : pytest **offline** — fixtures = vraies réponses Yahoo capturées
  (`market-pulse/tests/fixtures/`), horloge injectable (`now`), fetch injectable (aucun réseau).
- Phases B/C : miroir des tests des routers existants (`backend/bots/tests/`), TDD
  subagent-driven comme d'habitude.

## 8. Non-goals v1

Mode « apprentissage » pour Massii (différé à sa demande) · Twitter/X · données intraday fines
(tick/minute) · alertes push · toute forme de recommandation d'investissement.
