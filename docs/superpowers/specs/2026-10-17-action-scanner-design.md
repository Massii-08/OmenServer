# Scanner d'actions — design (2026-10-17)

4ᵉ bot de la suite finance, frère du Bond Scanner : on règle des critères, il
balaie des marchés ENTIERS et rend une liste classée (écran + Excel). Ce qu'il
cherche : des **catalyseurs** — des actions liquides qui ont une actualité
récente ou annoncée, confirmée par le prix et le volume — en s'appuyant sur les
news que le coach du simulateur récupère déjà.

Public : Massii (simulateur Paper). Accès `admin` + `money`, comme les trois
autres bots finance.

---

## 1. Décisions arrêtées (cadrage avec Massii, 17/10)

| Sujet | Décision | Pourquoi |
|---|---|---|
| Objectif | **Catalyseurs** (trading) | Seul profil où « se baser sur les news du coach » sert à quelque chose ; dividendes/valeur n'utiliseraient les news qu'en alerte |
| Univers | **Marché entier** via le screener public TradingView, **repli automatique** sur les grandes valeurs (Yahoo) s'il casse | Vrai miroir du Bond Scanner (qui balaie tout Deutsche Börse) |
| Rôle des news | **Signal + alerte** : un catalyseur fait monter le titre ; une news négative le marque en rouge (option : l'exclure) ; un titre qui a déjà beaucoup bougé est marqué « en retard » | Choix utilisateur |
| LLM | **Aucun** au runtime | Doctrine du dépôt (runtime déterministe) ; zéro coût de jetons |
| Dépendances | **Aucune nouvelle** (httpx, curl_cffi, openpyxl déjà installés sur l'Omen) | Auto-deploy propre (piège #33g) |
| Lancement | Manuel (v1) | La planification est une v2 (cf. §11) |

## 2. Ce que le scanner n'est PAS (ligne rouge)

- **Pas une recommandation.** Même position que le coach (spec Paper §2) : il
  présente des faits filtrés et ses RAISONS, jamais « à acheter ». Titre de
  l'Excel : « Candidats à étudier ». Les titres de presse qui sont eux-mêmes des
  conseils (« 3 stocks to buy », « da comprare ») sont écartés et COMPTÉS.
- **Pas un doublon du coach.** Le coach trie ~20 candidats pour SON propre
  portefeuille, avec un LLM (`paper_router._coach_candidates`). Le scanner,
  lui, balaie des milliers de titres de façon déterministe et rend une liste
  lisible par un humain, avec la raison de chaque ligne.

## 3. Angles morts connus (et la parade)

1. **Les news du coach ne couvrent pas le marché.** Mesuré dans le code : le
   flux TradingView du coach ne tourne que pour positions ∪ watchlist ∪ titre
   affiché (cache de 60 titres) ; les flux par symbole Yahoo idem ; la table
   d'entités ne connaît que 39 grandes entreprises. Scanner « les titres dont
   parle le coach » reviendrait à rescanner l'attention de Massii.
   → **Parade** : l'univers vient du screener ; les news du coach servent de
   signal GRATUIT (zéro réseau) ; pour la présélection (40 titres par défaut),
   le scanner va chercher lui-même les news TradingView en réutilisant le
   collecteur du coach (`tvnews.fetch_items`, source sondée 200 sans cookie).
2. **Une news publique est souvent déjà dans le prix.** → drapeau « en retard »
   (variation du jour ≥ 8 % ou semaine ≥ 20 %) avec pénalité, et bonus pour
   les catalyseurs À VENIR (résultats dans les 7 jours, mots-clés `watch`).
3. **Le flux Yahoo par symbole du coach est un flux SECTORIEL** (40-75 % des
   titres parlent vraiment de la société, mesuré en phase D de Market Pulse).
   → un événement sans `src` (= flux Yahoo par symbole) ne compte pour un titre
   que si son libellé NOMME la société (`entities.detect_companies` avec les
   noms du screener comme ancres) ou son ticker (≥ 3 lettres).
4. **La veille du coach peut être muette.** `newswatch.run_once` ne fait RIEN
   sans config Telegram (`data/paper_telegram.json`). → si le carnet est vide,
   le résultat porte l'avertissement `coach_empty` (jamais un silence).
5. **Rafale de requêtes TradingView.** Le coach consomme déjà ≤ 60 requêtes
   par cycle de 5 min sur le même hôte. → pacing 1,2 s, plafond = taille de la
   présélection × langues, **disjoncteur** au premier 429 ou à 3 échecs de
   suite : les titres restants sont marqués `news_unverified`, le scan va au
   bout quand même.
6. **Screener jamais sondé dans le projet, et pas sondable depuis le conteneur
   cloud** (Yahoo et TradingView y rendent 403). Le format vient du code source
   du paquet open source `tradingview-screener` 3.2.2 (PyPI, 2026). →
   commande `--probe` qui enregistre les vraies réponses ; la fixture du
   screener est marquée SYNTHÉTIQUE tant qu'elle n'est pas remplacée par une
   capture réelle (§10).
7. **Colonnes renommées par TradingView.** Une colonne inconnue fait échouer
   la requête : on rejoue UNE fois avec `ignore_unknown_fields: true`, et toute
   colonne revenue vide sur toutes les lignes est listée dans
   `warnings` (`degraded_columns`) — un champ mort doit se VOIR (piège #61).
8. **Fuseau des `ts` du coach hétérogène** (vu par la veille pour RSS/X/Reddit,
   publication pour TradingView, heure locale naïve pour SEC). Un `ts` naïf est
   lu en UTC ; l'erreur (≤ 2 h) est négligeable sur une fenêtre de 24-72 h.

## 4. Architecture

```
backend/bots/stockscan/            # moteur (PUR + I/O injectables)
  __init__.py
  __main__.py      # python -m backend.bots.stockscan --out <run> --config <json> --user <u>
                   #                                 | --probe <dir> [--market italy]
  markets.py       # catalogue des marchés + TradingView -> Yahoo selon le marché (PUR)
  config.py        # validation de la config (PUR) + défauts persistés
  screener.py      # requête (PUR), parseur (PUR), client HTTP (I/O injectable)
  coach.py         # LECTURE SEULE des mémoires du coach -> signaux par symbole
  news.py          # admission/classement (PUR) + news fraîches TradingView (I/O)
  scoring.py       # score, raisons, drapeaux (PUR)
  excel_out.py     # classeur openpyxl
  engine.py        # orchestration, progression, results.json
backend/bots/stockscan_router.py   # /api/bots/stocks
frontend/js/stockscan_module.js    # StockScanModule (render/unload)
```

Le moteur vit DANS le backend (comme le Harvester) parce qu'il lit les modules
du coach (`backend.bots.paper.*`). Subprocess détaché lancé depuis la racine du
projet : `python -m backend.bots.stockscan …`.

**Il n'écrit JAMAIS dans `data/paper_trading/`** (ni cache du coach, ni état) :
son dossier est `data/stock_scanner/`.

## 5. Le pipeline (une exécution)

| Phase | Réseau | Ce qui se passe |
|---|---|---|
| `universe` | 1 POST / marché | screener TradingView, filtres côté serveur (action ordinaire, cotation principale, capitalisation ≥ seuil), tri par volume échangé, ≤ 400 lignes (US) / 200 (autres) ; filtre local d'échanges moyens. Tous les marchés en échec → **repli** grandes valeurs (bougies Yahoo) |
| `coach` | 0 | lecture seule : carnets news de tous les comptes (dédup par lien), cache TradingView, tendances Reddit, dépôts SEC, hypothèses ouvertes du radar, positions + watchlist du demandeur |
| `shortlist` | 0 | pré-score (volume relatif, variation, résultats proches, signaux du coach) → les `shortlist` meilleurs |
| `news` | ≤ shortlist × langues | news TradingView fraîches de la présélection (cache du coach réutilisé s'il a < 15 min), disjoncteur |
| `scoring` | 0 | score 0-100, raisons, drapeaux ; exclusions `no_catalyst` (et `red` si demandé) |
| `output` | 0 | `results.json` puis l'Excel |

Arrêt : le moteur lit `stop.flag` entre deux étapes et sort en code 3.

## 6. Le score (PUR, `scoring.py`)

Chaque composante produit une raison lisible. Poids v1 (verrouillés par test) :

| Composante | Points |
|---|---|
| News admises non négatives dans la fenêtre : Σ récence (≤24 h : 1 ; ≤48 h : 0,6 ; au-delà : 0,3) × nature (pos/watch : 1 ; neutre : 0,5) | `min(30, 10 × Σ)` |
| Familles de sources distinctes (tradingview, presse, social, sec, coach) | 2 → +8 ; ≥3 → +15 |
| Au moins une bonne nouvelle (`pos`) | +10 |
| Au moins un catalyseur annoncé (`watch`) | +8 |
| Résultats dans les 7 jours (screener) | +10 (+ drapeau `earnings_soon`) |
| Volume relatif ≥ 1,5 / 2,5 / 4 | +8 / +15 / +20 |
| Le cours confirme (variation > 0 avec une news pos/watch) | +5 |
| Hypothèse « hausse » ouverte du radar du coach | +10 |
| Buzz Reddit (≥ 5 mentions et ≥ 2× la veille) | +5 (+ drapeau `crowd`) |
| Dépôt SEC du titre dans la fenêtre | +5 |
| News négative dans la fenêtre | **−25** + drapeau `red` (exclu si `exclude_red`) |
| Hypothèse « baisse » ouverte du coach | −10 + drapeau `coach_down` |
| Déjà parti (variation ≥ 8 % en valeur absolue ou semaine ≥ 20 %) | −10 + drapeau `late` |

Score borné 0-100. **Catalyseur obligatoire** : au moins une news admise, des
résultats dans les 7 jours, une hypothèse du coach ou un dépôt SEC — sinon la
ligne est exclue (`no_catalyst`, comptée). Un volume anormal sans aucune raison
connue n'est pas un catalyseur.

Admission d'un titre de presse : refusé si `newswatch.is_advice` (règle du
coach) ou si un motif de conseil adressé au lecteur matche (« stocks to buy »,
« should you buy », « top picks », « da comprare », « à acheter »…). Les
changements de recommandation d'analystes (« upgrade/downgrade ») restent
ADMIS, comme dans la veille du coach (`classify` les range en pos/neg) :
ce sont des événements qui font bouger les cours. Le filtre plus strict de
Market Pulse (fait pour le grand-père) n'est volontairement pas repris : il
jetterait « X to sell its unit to Y » (une cession = un fait).

## 7. Contrats de données

### 7.1 Config (`config.json` du run ; défauts dans `data/stock_scanner/defaults.json`)

```json
{
  "markets": ["switzerland", "italy", "germany", "france", "america"],
  "min_cap_meur": 1000,
  "min_value_meur": 5,
  "window_h": 48,
  "top_n": 25,
  "shortlist": 40,
  "exclude_red": false,
  "lang": "fr"
}
```

Bornes : `min_cap_meur` 50-500000, `min_value_meur` 0-10000, `window_h` ∈ {24,
48, 72}, `top_n` 5-100, `shortlist` 10-80, `lang` ∈ {fr, en, it}.
`config.validate(raw) -> (clean, warnings)` ne lève jamais ; marché inconnu →
avertissement ; liste vide ou que des inconnus → marchés par défaut.

### 7.2 Catalogue des marchés (`markets.py`)

| id | marché TradingView | devise | ≈ EUR/unité (seuils seulement) | langues des news |
|---|---|---|---|---|
| `switzerland` | switzerland | CHF | 1,05 | en, fr |
| `italy` | italy | EUR | 1 | en |
| `germany` | germany | EUR | 1 | en |
| `france` | france | EUR | 1 | en, fr |
| `netherlands` | netherlands | EUR | 1 | en |
| `spain` | spain | EUR | 1 | en |
| `uk` | uk | GBP (cours en GBX) | 1,17 | en |
| `america` | america | USD | 0,92 | en |

Les taux ne servent QU'À convertir les seuils de liquidité : une erreur de
10 % n'y change rien. Langues : seuls `en` et `fr` ont été sondés par le coach
(09/09) ; les autres ne sont pas ajoutées tant qu'une sonde ne les a pas vues.

TradingView → Yahoo : `brief.tv_to_yahoo` (table de référence du coach), sauf
`EURONEXT` (suffixe selon le marché balayé : `.PA`, `.AS`) et `BME` (`.MC`),
puis `quotes.canonical` (`ROG.SW` → `RO.SW`).

### 7.3 `results.json` (contrat unique de l'UI et de l'Excel)

```json
{
  "version": 1,
  "generated_at": "2026-10-17T07:45:12+00:00",
  "config": {"…": "config propre"},
  "source": "screener | fallback",
  "markets": [{"id": "italy", "ok": true, "rows": 200, "error": null}],
  "counts": {"universe": 1180, "shortlist": 40, "news_requests": 52,
             "news_failed": 0, "kept": 18, "excluded_no_catalyst": 19,
             "excluded_red": 3, "filtered_advice": 4, "dropped_irrelevant": 7,
             "coach_events": 214},
  "warnings": [{"code": "coach_empty"}, {"code": "degraded_columns", "columns": ["gap"]}],
  "rows": [{
    "rank": 1,
    "tv_symbol": "MIL:ENI", "symbol": "ENI.MI", "ticker": "ENI",
    "name": "Eni S.p.A.", "market": "italy", "exchange": "MIL",
    "currency": "EUR", "price": 15.48, "change_pct": 2.31, "gap_pct": 1.1,
    "rel_volume": 2.4, "avg_value_meur": 120.5, "market_cap_meur": 50210,
    "sector": "Energy Minerals", "perf_w": 4.1,
    "earnings_next": "2026-10-24",
    "score": 72,
    "components": {"news": 20, "sources": 8, "volume": 8},
    "reasons": [{"code": "volume", "value": 2.4}, {"code": "news", "value": 3, "hours": 48}],
    "flags": ["earnings_soon", "followed", "new"],
    "news": [{"title": "…", "url": "https://…", "published": "2026-10-17T06:02:00+00:00",
              "source": "tradingview", "provider": "reuters", "sentiment": "pos"}],
    "coach": {"hypotheses": [{"direction": "up", "thesis": "…", "confidence": "moyenne"}],
              "reddit": {"count": 6, "prev": 2}, "filings": []},
    "links": {"chart": "https://www.tradingview.com/chart/?symbol=MIL%3AENI"}
  }]
}
```

Raisons et drapeaux sont des CODES (langue neutre) : l'UI les traduit
(`stocks.reason.*`, `stocks.flag.*`), l'Excel aussi (table fr/en/it du moteur).

Codes de raison : `news`, `sources`, `positive`, `upcoming`, `earnings`,
`volume`, `aligned`, `coach_up`, `crowd`, `filing`.
Codes de drapeau : `red`, `late`, `earnings_soon`, `coach_down`, `crowd`,
`followed` (dans les positions ou la watchlist du DEMANDEUR — jamais celles
d'un autre compte), `new` (absent du run précédent), `news_unverified`.
Codes d'avertissement : `coach_empty`, `degraded_columns`, `market_failed`,
`fallback_universe`, `news_breaker`, `stopped_early`.

### 7.4 Dossier d'un run (le disque fait foi)

`data/stock_scanner/runs/<32 hexa>/` : `pid`, `meta.json`
`{job_id, user, created_at, date}`, `config.json`, `run.log` (stdout du
moteur, écrit DIRECTEMENT dans le fichier : pas de pipe, donc pas de
`BrokenPipeError` quand l'auto-deploy redémarre uvicorn), `progress.json`
`{phase, done, total, counts, at}` (écrit atomiquement), `results.json`,
`<nom>.xlsx`, `stop.flag`.

Statut lu sur le disque : `stop.flag` → `stopped` ; pid vivant → `running` ;
`results.json` → `completed` ; sinon `error`.

## 8. Router `backend/bots/stockscan_router.py` (préfixe `/api/bots/stocks`)

Tout en `require_role("admin", "money")`.

| Méthode | Chemin | Rôle |
|---|---|---|
| GET | `/config` | `{defaults, markets, limits}` |
| POST | `/run` | config partielle → validée, enregistrée comme défauts, run lancé (refuse d'en empiler deux) → `{job_id, already_running, warnings}` |
| GET | `/status/{job_id}` | `{job_id, status, progress, logs (60 dernières lignes), meta, files}` |
| GET | `/active` | run le plus récent `{found, job_id, status, progress, meta}` — le badge de l'onglet ne compte QUE `running` |
| POST | `/stop/{job_id}` | `stop.flag` + `os.killpg` du pid (la session détachée a pgid = pid) |
| GET | `/results/{job_id}` | `results.json` |
| GET | `/latest` | dernier run qui a un `results.json` |
| GET | `/download/{job_id}` | le classeur |

`job_id` = 32 hexa, sinon 404 avant de composer un chemin (patron Market
Pulse). Rétention 30 jours, jamais le run le plus récent ni un run vivant.

Défauts du Bond Scanner NON recopiés : un arrêt qui finit affiché « erreur »,
un téléchargement sans contrôle de rôle, un `/active` qui fait compter les
runs terminés dans le badge, un `unload()` qui laisse tourner le sondage.

## 9. Interface

Carte « ACT » dans le hub Bots (admin/money) → `StockScanModule`. Trois états :
réglages (marchés, seuils, fenêtre, nombre de lignes, exclusion des titres en
rouge), exécution (phase, barre, compteurs, journal, Arrêter), résultats
(tableau classé : drapeaux, raisons, news dépliables avec lien, résultats à
venir, lien graphique TradingView, bouton « Suivre dans le simulateur » →
`POST /api/paper/watchlist`, ce qui fait entrer le titre dans la veille du
coach). Téléchargement Excel. i18n `stocks.*` FR/EN/IT. Le badge de l'onglet
Bots suit `/api/bots/stocks/active`.

## 10. Tests

- Moteur : `backend/bots/tests/test_stockscan_*.py`, tout hors ligne, tout
  injecté (client du screener, chargeurs du coach, client des news, horloge).
- Fixtures `backend/bots/tests/fixtures/stockscan/` : réponse du screener
  **synthétique** (forme tirée de `tradingview-screener` 3.2.2 — à remplacer
  par la capture `--probe`) ; news TradingView RÉELLES réutilisées
  (`fixtures/tvcoach/tv_news_aapl.json`, capture du 09/09).
- Router : `TestClient`, `FakeUser`, lancement remplacé (patron
  `test_market_router.py`).

## 11. Hors v1 (suites possibles)

- Planification avant l'ouverture (Europe 08:45, US 15:15) + digest Oracle.
- Profils « dividendes » et « qualité » sur le même moteur (autres poids).
- Prochaines dates de résultats hors US via `quoteSummary` (danse cookie +
  crumb documentée en phase D de Market Pulse, jamais codée).
