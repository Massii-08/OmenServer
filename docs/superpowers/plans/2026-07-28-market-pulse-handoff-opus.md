# Market Pulse — prompt de passation (à exécuter par Opus 5)

> **Comment l'utiliser** : ouvrir une session Claude Code (Opus 5) dans le repo OmenServer et coller :
> « Lis `docs/superpowers/specs/2026-07-28-market-pulse-design.md` puis
> `docs/superpowers/plans/2026-07-28-market-pulse-handoff-opus.md` et exécute les phases B puis C. »

---

## Mission

Terminer **Market Pulse**, le 3ᵉ bot de la suite finance d'OmenServer (après Yield Bot et Bond
Scanner) : analyse des ouvertures de marché de différents pays pour le grand-père de Massii.
Le spec validé est dans `docs/superpowers/specs/2026-07-28-market-pulse-design.md` — le lire en
premier. La **phase A (moteur) est déjà livrée, testée et validée en réel** ; tu construis les
phases B (bot complet dans le dashboard) et C (sentiment presse/Reddit).

## État des lieux (ne pas refaire)

- `market-pulse/` : moteur complet — `pulse/config.py` (watchlist 16 instruments, labels italiens),
  `pulse/fetcher.py` (client Yahoo chart via **curl_cffi impersonate="chrome"**, pacing 1,1 s,
  retry backoff), `pulse/quotes.py` (parsing), `pulse/clock.py` (ouvert/fermé depuis
  `currentTradingPeriod`), `pulse/gaps.py` (gap du jour + stats par jour de semaine),
  `pulse/snapshot.py` (contrat d'interface), `main.py` (CLI).
- **26 tests pytest offline verts** (`cd market-pulse && python -m pytest tests -q`), fixtures =
  vraies réponses Yahoo capturées.
- **Run réel validé le 2026-07-28** : 16/16 instruments OK, 0 erreur, horloge et gaps cohérents
  (`python main.py` depuis `market-pulse/` avec le venv du projet).
- Faits de sonde à respecter : Yahoo en httpx nu = **429 immédiat** (mur TLS) → curl_cffi
  obligatoire ; un burst = 429 → garder le pacing ; Stooq est mort (challenge JS proof-of-work) ;
  `meta.chartPreviousClose` = clôture d'avant le RANGE, pas la veille (bug corrigé, test de
  régression pinné `test_change_pct_uses_previous_candle_not_chart_previous_close`).

## Contrat d'interface (déjà stable — tout consommer via lui)

`pulse.snapshot.build_snapshot(fetch, instruments, now_ts)` →
```json
{"generated_at": 1785240000,
 "markets": [{"symbol": "^GDAXI", "label": "DAX (Francoforte)", "region": "europe",
              "kind": "index", "name": "DAX", "currency": "EUR",
              "price": 25464.0, "prev_close": 25360.2, "change_pct": 0.41,
              "clock": {"status": "open|closed|unknown", "opens_at": null, "closes_at": 1785252600,
                        "local_time": "14:00", "tz_name": "Europe/Berlin"},
              "gap": {"date": "2026-07-28", "gap_pct": 0.53, "open": 25145.0, "prev_close": 25011.35},
              "gap_is_today": true}],
 "errors": [{"symbol": "...", "error": "..."}]}
```
`pulse.snapshot.build_history_stats(fetch, instruments, range_="1y")` → stats par symbole
(`n_sessions`, `weekday_stats` {jour italien → n/avg_gap_pct/avg_abs_gap_pct/pct_up},
`biggest_gaps`). ⚠️ `range=1y` est le même endpoint mais n'a pas été sondé — vérifie au premier
run `--stats` réel.

---

## Phase B — le bot complet dans le dashboard (V1-V4 du spec)

Suis la doctrine du repo : **TDD subagent-driven**, tests offline DI, miroir des patterns existants.
Fichiers de référence exacts à imiter :

| Quoi | Modèle à copier |
|---|---|
| Router backend | `backend/bots/scanner_router.py` (job mémoire + subprocess détaché `start_new_session=True` + thread pump logs + `/run /status /active /stop /download`) |
| Enregistrement | `backend/main.py` (imports l.145-151 + `include_router`) |
| Carte UI | la carte Bond Scanner dans `frontend/js/bots_module.js` (ticker `.b-ticker`, admin-only) |
| i18n | clés `scanner.*` dans `frontend/js/lang.js` — créer `market.*` en FR/EN/IT |
| Excel | `bond-scanner/excel/` (openpyxl, déjà sur l'Omen) |
| Planification | `backend/scheduler/engine.py` (APScheduler déjà en route) |

Tâches ordonnées :

1. **Rapport quotidien** (`market-pulse/pulse/report.py` + intégration `main.py --report`) :
   texte italien structuré depuis le snapshot — sections Asia (chiusura) / Futures & materie prime
   / Europa (apertura prevista : gap indicatif via futures/Stoxx) / USA (chiusura o seduta in
   corso). **Faits uniquement, aucune recommandation d'achat/vente** (ligne rouge du spec).
   Phrases template déterministes ; la synthèse LLM est en phase C.
2. **Excel** (`pulse/excel_out.py`, openpyxl) : feuille 1 = snapshot (un marché/ligne, couleurs
   gap ±), feuille 2 = stats historiques par indice. Produit dans le run dir.
3. **Router** `backend/bots/market_router.py`, prefix `/api/bots/market`, **admin-only**
   (`get_current_user` + check admin, comme scanner) : `POST /run` (lance
   `python market-pulse/main.py --out data/market_pulse/runs/<id> --stats --report` en subprocess
   **détaché**), `GET /status/{id}`, `GET /active`, `GET /snapshot` (dernier snapshot.json —
   c'est ce que l'UI poll), `GET /download/{id}` (Excel), `POST /stop`. Fichiers sous
   `data/market_pulse/` (déjà couvert par le gitignore de `data/`).
4. **Planification matinale** : job APScheduler (07:30 Europe/Rome par défaut, avant l'ouverture
   de Milan 09:00) qui déclenche le même run ; endpoint `GET/POST /schedule` pour on/off + heure,
   persisté `data/market_pulse/schedule.json`. Regarde comment `scheduler/engine.py` enregistre
   ses jobs au startup.
5. **UI** : carte « Market Pulse » (ticker `MKT`) dans `bots_module.js` — bouton Lancer, statut,
   download Excel, et un panneau : horloge des marchés (groupes Europa/USA/Asia, badge
   APERTO/chiuso, heure locale), gaps du jour, dernier rapport texte, stats V4 repliables.
   Réutiliser les composants Bento (`.row-list`, `.badge.online`, `.b-ticker`) — pas de nouveau
   CSS si évitable. i18n `market.*` ×3 langues (le CONTENU du rapport reste italien).
6. **Tests** : router (TestClient, subprocess mocké — miroir des tests scanner existants dans
   `backend/bots/tests/`), report/excel (snapshot fixture → assertions structure). Lancer AUSSI
   toute la suite backend existante.
7. **Vérification finale** : run réel local complet, puis déploiement (workflow ci-dessous) et
   **vérification en prod toi-même via Chrome MCP** (règle absolue : ne jamais demander à Massii
   de tester).

## Phase C — sentiment presse & Reddit (V5)

1. `pulse/sentiment.py` + module de collecte : **RSS presse** (candidats à VALIDER un par un
   avant de coder le parse : Il Sole 24 Ore mercati, CNBC World Markets, MarketWatch,
   Investing.com news — garder ceux qui répondent en httpx simple, stdlib `xml.etree` pour le
   parse) + **Reddit JSON public** (`https://www.reddit.com/r/investing/hot.json`,
   `r/StockMarket`, User-Agent custom obligatoire, pacing low-and-slow doctrine Harvester).
2. Sortie déterministe : top titres par source + comptage de thèmes/tickers mentionnés
   (matching par mots-clés, pas de LLM) → section « Notizie e tendenze » du rapport + panneau UI.
3. **Synthèse LLM optionnelle** (1 appel/jour max) : réutiliser le pattern `_claude`
   (`backend/bots/harvester/llm.py`, CLI Claude sur le token OAuth de l'Omen —
   `~/.config/claude-code-oauth.env`). **Dégradation gracieuse** : sans LLM le rapport sort en
   format structuré. Si une source résiste (paywall/anti-bot), utiliser les fetchers du
   **AI Harvester** (tier stealth patchright/Xvfb `:100` opérationnel sur l'Omen) — demande
   explicite de Massii de ne pas se limiter aux API publiques. **Twitter/X reste exclu.**
4. Tests offline (fixtures RSS/Reddit réelles capturées), même doctrine.

## Pièges du repo OBLIGATOIRES (numéros = CLAUDE.md)

- **Python 3.9** (#1) : pas de `match`, pas de `X | Y` — `Optional`/`Union`.
- **Aucune nouvelle dépendance Python** : curl_cffi/httpx/openpyxl sont déjà dans
  `requirements.txt` et sur l'Omen. Si tu crois en avoir besoin d'une nouvelle : STOP, trouve un
  chemin stdlib (l'auto-deploy ne pip-install pas, #33g).
- **Subprocess détaché** `start_new_session=True` (#30f) sinon l'auto-deploy tue le run.
- **Cache-bust** (#9, #35-bis) : bumper le `?v=` de CHAQUE JS modifié dans `index.html` + le
  `CACHE_NAME` de `sw.js` — au-dessus des valeurs d'`origin/main` au moment du push.
- **i18n** : jamais de texte UI hardcodé, `Lang.t()` partout ; fallback truthy trap (#12).
- **XSS** : toute donnée dynamique en innerHTML passe par `esc()` (audit 2026-06-21) ; API via
  `Auth.apiCall`, jamais `fetch()` direct.
- **Endpoints admin-only** ; fichiers de run sous `data/` (gitignored).
- **Déploiement** = push sur `origin/main` (cron auto-deploy 1 min sur l'Omen). Le main local est
  souvent stale : `git fetch` + rebase sur `origin/main` AVANT de merger/pusher la branche.
  Travail en cours sur la branche `claude/market-opening-analysis-bot-38483c` (worktree).
- Le restart uvicorn ne tue plus les bots MC (`KillMode=process`, #51) mais vérifie qu'aucun
  run/scan d'un AUTRE bot ne tourne avant de pusher (badge « Bots N » du dashboard).
- **Vérifier l'UI soi-même** via Chrome MCP après déploiement (skill `verify-ui`).

## Points ouverts identifiés (à trancher en route)

1. `currentTradingPeriod` le **week-end** : jamais observé (la base a été validée un mardi).
   Vérifier ce que Yahoo renvoie samedi (séance de vendredi ou de lundi ?) et ajuster
   `clock.py`/l'affichage `opens_at` si besoin — le contrat `ClockState` le permet déjà.
2. Yahoo depuis **l'Omen** (IP résidentielle, OK attendu) : valider au premier run prod ; en cas
   de blocage persistant, basculer le fetcher sur l'infra stealth du Harvester.
3. L'heure du rapport planifié (07:30 Rome par défaut) : confirmer avec Massii à la livraison.

## Definition of done

- Phase B : depuis le dashboard prod (omenserver.org), un admin lance Market Pulse, voit
  l'horloge/gaps se remplir, télécharge l'Excel ; le rapport du matin se génère seul à l'heure
  configurée ; tests backend TOUS verts ; vérifié en prod via Chrome MCP.
- Phase C : le rapport contient la section notizie (sources réelles), tests verts, zéro nouvelle
  dépendance, LLM optionnel avec dégradation propre.
- CLAUDE.md : ajouter une ligne à l'historique + tout nouveau piège découvert, et mettre à jour
  la table des modules si besoin.
