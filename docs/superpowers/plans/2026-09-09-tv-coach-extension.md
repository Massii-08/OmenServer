# Coach OmenServer dans TradingView — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Livrer l'extension Chrome « coach dans TradingView » (spec `docs/superpowers/specs/2026-09-09-tv-coach-extension-design.md`) : fiche du titre affiché, alertes live, ticket simple, mode scalp, volet Bitcoin, news TradingView dans la base, dessin des paris du coach.

**Architecture:** Un client fin (extension MV3, vanilla JS, 0 build) sur la page TradingView parle à un nouveau routeur FastAPI `backend/bots/paper_tv_router.py` (préfixe `/api/paper`) et à un WebSocket push `backend/bots/paper_ws.py`. Les nouveaux modules Python vivent dans `backend/bots/paper/` (DI partout, tests hors ligne sur fixtures réelles capturées le 09/09 dans `backend/bots/tests/fixtures/tvcoach/`). Le serveur calcule, l'écran affiche ; le LLM n'est jamais sur le chemin d'un ordre.

**Tech Stack:** Python 3.9 (compat obligatoire, prod 3.14) + FastAPI + httpx (déjà présents) · Chrome Manifest V3, vanilla JS/CSS, `node --test` (Node 22) · Zéro nouvelle dépendance.

---

## 0. Organisation du travail (lots parallèles)

| Lot | Agent | Fichiers possédés (personne d'autre n'y touche) |
|---|---|---|
| A/B | `be-brief` | `backend/bots/paper/brief.py`, `backend/bots/paper/precheck.py`, `backend/bots/paper/fees.py` (profils), `backend/bots/paper_tv_router.py` **section A/B**, `backend/bots/tests/test_tvcoach_brief.py`, `test_tvcoach_precheck.py` |
| C | `be-feed` | `backend/bots/paper/tvnews.py`, `backend/bots/paper/tvcalendar.py`, `backend/bots/paper/focus.py`, `backend/bots/paper_ws.py`, branchements dans `newswatch.py` et `calendar.py`, `paper_tv_router.py` **section C**, `test_tvcoach_feed.py`, `test_tvcoach_ws.py` |
| D | `be-scalps` | `backend/bots/paper/scalps.py`, `backend/bots/paper/llm.py` (+1 builder), `paper_tv_router.py` **section D**, `test_tvcoach_scalps.py` |
| E | `be-btc` | `backend/bots/paper/btc.py`, `backend/bots/paper/convergence.py` (2 facteurs), `paper_tv_router.py` **section E**, `test_tvcoach_btc.py` |
| X | `ext-core` | `tools/tv-coach-extension/**` sauf les 3 modules de `ext-scalp` |
| S | `ext-scalp` | `tools/tv-coach-extension/lib/bars.js`, `lib/guards.js`, `lib/ledger.js` + `tests/bars.test.js`, `guards.test.js`, `ledger.test.js` |

Règles communes : **aucun commit, aucun push** (Fable commit par lot après contrôle) ; aucune nouvelle dépendance ; Python 3.9 (pas de `match`, pas de `X | Y`, pas de `list[str]` en annotation runtime) ; tests hors ligne (tout I/O injecté) ; **jamais un octet NUL** dans un fichier ; les routes nouvelles vont UNIQUEMENT dans `paper_tv_router.py` sous l'ancre du lot ; les helpers de `paper_router.py` s'importent (`from backend.bots.paper_router import _job_or_sync, _load, _now_iso`), on ne modifie pas `paper_router.py`.

Commandes de contrôle (Fable) :
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/tv-coach-extension"
/usr/bin/env "/Users/massimiliano/omenserver Project/Projet serveur/venv/bin/python3" -m pytest backend/ -q --no-header -p no:cacheprovider   # 4307 verts au départ
node --test tools/tv-coach-extension/tests/
for f in tools/tv-coach-extension/*.js tools/tv-coach-extension/lib/*.js; do node -e "new Function(require('fs').readFileSync('$f','utf8'))" || echo "PARSE KO $f"; done
grep -rlP '\x00' backend/bots/paper tools/tv-coach-extension && echo "NUL trouvé" || echo "0 NUL"
```

## 1. Contrats partagés (source de vérité pour tous les lots)

### 1.1 Symboles
`tv_symbol` = `EXCHANGE:TICKER` de TradingView ; `symbol` = symbole Yahoo canonique (`quotes.canonical`). Mapping côté extension (`lib/symbols.js`) ET côté serveur (`brief.tv_to_yahoo`, même table, testée à l'identique) :

| TradingView | Yahoo |
|---|---|
| `NASDAQ:AAPL`, `BATS:AAPL`, `NYSE:KO`, `AMEX:SPY` | `AAPL`, `KO`, `SPY` |
| `SIX:NESN`, `SIX:ROG`, `BX:NESR` | `NESN.SW`, `ROG.SW` (via `SYMBOL_ALIASES`), `NESN.SW` |
| `XETR:SAP`, `FWB:SAP` | `SAP.DE` |
| `EURONEXT:MC`, `EURONEXT:AIR` | `MC.PA`, `AIR.PA` |
| `LSE:SHEL` | `SHEL.L` |
| `MIL:ENI` | `ENI.MI` |
| `BITSTAMP:BTCUSD`, `BINANCE:BTCUSDT`, `BINANCE:BTCUSDT.P`, `KRAKEN:XBTUSD`, `COINBASE:BTCUSD`, `CRYPTO:BTCUSD` | `BTC-USD` |
| idem ETH/SOL/XRP (`ETHUSD…` → `ETH-USD`) | |
| `FX:EURUSD`, `OANDA:EURUSD`, `FX_IDC:EURUSD` | `EURUSD=X` |
| `TVC:UKOIL`, `TVC:USOIL`, `TVC:GOLD` | `BZ=F`, `CL=F`, `GC=F` |
| `CME:BTC1!` | `BTC=F` |
| inconnu | `null` |

`kind` ∈ `stock | crypto | forex | commodity | index` (déduit : `-USD`→crypto, `=X`→forex, `=F`→commodity, `^`→index, sinon stock).

### 1.2 `GET /api/paper/brief?symbol=&tv=` → objet §5.1 de la spec (clés : `symbol, tv_symbol, kind, quote, position, coach_position, pending_orders, alerts, ideas, hypotheses, news, calendar, whales, mood, btc, fees, ta, defaults`). Champ sans objet = `null`, liste vide = `[]`. Chaque source est appelée dans un `try/except` séparé (panne isolée) ; un échec met `null` et ajoute son nom dans `brief["degraded"]` (liste).

### 1.3 `POST /api/paper/precheck` → entrée `{symbol, side: "buy"|"sell", price, stop, target, risk_pct?, qty?, mode: "swing"|"scalp"}` ; sortie `{qty, risk_pct, risk_chf, fees_chf, fees_pct_round_trip, r_multiple, expected_move_pct, warnings: [{code, level: "amber"|"red", text}], refusals: [{code, text}]}` (`refusals` = ce que le gate du coach refuserait ; **informatif**, rien ne bloque).

### 1.4 `WS /ws/paper` → 1er message client `{"token": "<jwt>"}` ; serveur → `{"type": "alert"|"digest"|"threat"|"calendar_soon"|"news"|"brief_changed", "symbol": str|null, "payload": {...}, "ts": iso}`. Ping serveur toutes les 25 s (`{"type":"ping"}`), le client répond `{"type":"pong"}`.

### 1.5 `POST /api/paper/scalps` → entrée §5.4 ; sortie `{id, pnl_chf, pnl_pct, fees_chf, mae_pct, mfe_pct, duration_s, biases: [codes], discipline: {score, ...}}`. `GET /api/paper/scalps?limit=50` → `{items: [...], stats: {today: {n, wins, pnl_chf, fees_chf}, week: {...}}}`. `POST /api/paper/scalps/review` → `{"job": id}` (via `_job_or_sync`), résultat `{"answer": str}`.

### 1.6 `POST /api/paper/focus {symbol}` → `{ok: true, until: iso}` ; `GET /api/paper/focus` → `{symbol|null, until|null}`.
### 1.7 `POST /api/paper/alerts/{id}/fire {price, ts, by: "extension"}` → `{ok: true, alert: {...}}` ; 404 inconnu ; 409 déjà déclenchée.
### 1.8 `GET /api/paper/btc` → objet `btc` §5.1 + `{"agenda": [...]}` (entrées `{date, time_utc, kind: "crypto", label}`) ; `GET /api/paper/tvcalendar?days=14` → `{items: [{date, time_utc, kind: "macro", label, country, importance}]}`.

Tous les endpoints : `current_user: User = Depends(require_role("admin", "money", "trader"))`.

## 2. Lot A/B — `be-brief` (Opus)

### Task 1 : profils de frais
**Files:** Modify `backend/bots/paper/fees.py` ; Test `backend/bots/tests/test_tvcoach_precheck.py`
- Ajouter à `FEE_PROFILES` : `tv_paper` (taker 0.0 %, maker 0.0 %, `commission_chf: 0`), `kraken_spot` (taker 0.26 %, maker 0.16 %), `kraken_futures` (taker 0.05 %, maker 0.02 %), `custom` (taker/maker lus depuis `custom_pct` passé à `compute_fees`, défaut 0.10 %). Pas de timbre pour ces 4 profils. `compute_fees(profile, amount_chf, symbol, custom_pct=None)` reste rétro-compatible (les 3 profils existants bit-à-bit inchangés : test qui fige `compute_fees("yuh", 10000, "NESN.SW")` avant/après).
- `round_trip_pct(profile, amount_chf, symbol, custom_pct=None)` existant étendu.
- Tests : chaque profil, `custom` sans/avec `custom_pct`, profil inconnu → `ValueError` ou repli documenté (choisir : repli `yuh` + drapeau `unknown_profile: True` dans le dict).

### Task 2 : `brief.py`
**Files:** Create `backend/bots/paper/brief.py` ; Test `backend/bots/tests/test_tvcoach_brief.py`
- `tv_to_yahoo(tv_symbol: str) -> Optional[str]` (table §1.1, insensible à la casse, `.P` retiré, préfixe `CRYPTO:` accepté) et `kind_of(symbol) -> str`.
- `build(username: str, symbol: str, tv_symbol: str, *, deps: Optional[Dict[str, Callable]] = None, now=None) -> Dict[str, Any]` : `deps` injecte chaque source (`quote`, `portfolio`, `coach_positions`, `ideas_for_symbol`, `hypotheses`, `news`, `calendar`, `whales`, `mood`, `btc`, `alerts`, `candles_1m`, `candles_1d`, `fees_profile`) ; défauts = fonctions réelles des modules existants (`quotes`, `store.load_portfolio`, `coach_trader` positions_view, `idea_journal`, `radar`, `newswatch.recent_events`, `calendar`, `whales.moves_summary`, `mood.get`, `btc.snapshot` importé paresseusement dans un try, `store.load_alerts`, `quotes.get_candles(symbol, "1d", "1m")`, `quotes.get_candles(symbol, "6mo", "1d")`).
- `ta` : `atr14_d` via `ta.atr14(candles_1d)` ; `atr1_m` = ATR(14) sur les bougies 1 min (réutiliser `ta.atr14` sur la liste 1 min) ; `vwap`, `day_high`, `day_low` depuis les bougies 1 min du jour (`vwap = Σ(close×volume)/Σvolume`, `None` si volume absent).
- `news` : événements de `recent_events` filtrés sur `symbol` (et sur `tv_symbol` pour la source `tradingview`), 10 derniers, chaque item `{ts, title, source, via, sentiment, url}`.
- `degraded` : liste des sources en échec.
- Tests (fixtures : dicts en dur + `tv_news_*.json`) : mapping (≥ 15 cas), `kind_of`, brief complet avec toutes deps injectées, brief avec 3 deps qui lèvent → `null` + `degraded`, `btc` seulement si `kind == "crypto"`, `vwap` None sans volume, aucune exception ne sort de `build`.

### Task 3 : `precheck.py`
**Files:** Create `backend/bots/paper/precheck.py` ; Test `test_tvcoach_precheck.py`
- `evaluate(order: Dict, *, portfolio: Dict, trades: List[Dict], fees_profile: str, custom_pct=None, atr1_m=None, atr14_d=None, calendar=None, news=None, btc=None, scalps_today=None, now=None) -> Dict` (§1.3), **pur**.
- Quantité : `qty = floor(risk_pct/100 × equity / |price − stop|)` (crypto : 4 décimales, pas d'arrondi entier) ; `risk_chf`, `fees_chf` (= `compute_fees` × 2), `r_multiple = |target − price| / |price − stop|`, `expected_move_pct` = `atr1_m × 3 / price × 100` en scalp, `atr14_d / price × 100` en swing.
- Warnings/refusals : réutiliser `risk.preorder_warnings` (codes existants) et reproduire les deux règles de `coach_trader` `fee_ratio` (objectif < 3 × frais A/R) et `stop_in_noise` (stop < 2 × frais ou < 0,5 ATR) en appelant leurs fonctions si elles sont importables, sinon en les recopiant avec un test d'équivalence contre `coach_trader` ; nouveaux codes scalp exactement comme §6.3 de la spec (seuils par défaut dans un dict `SCALP_THRESHOLDS` surchargeable). `cooldown`/`pace`/`daily_loss` se calculent depuis `scalps_today` (liste `{closed_ts, pnl_chf}`).
- Tests : un cas par code (9 scalp + 6 existants), `mode="swing"` n'émet aucun code scalp, qty crypto fractionnaire, `stop` manquant → `no_stop` + qty `None`.

### Task 4 : routes section A/B
**Files:** Modify `backend/bots/paper_tv_router.py` (ancre `# --- LOT A/B`) ; Test `test_tvcoach_brief.py` (TestClient)
- `GET /brief`, `POST /precheck` (Pydantic `PrecheckPayload`), `POST /alerts/{alert_id}/fire` (charge `store.load_alerts`, marque `fired`/`fired_at`/`fired_by`/`fired_price` via `price_alerts.trigger` si existant, sauvegarde `store.save_alerts` ; 404/409).
- Tests TestClient avec `deps` monkeypatchés (pattern des tests existants de `paper_router`, ex. `test_paper_router*.py`) : 200 forme complète, 401 sans token, `alerts/{id}/fire` 404/409/200.

## 3. Lot C — `be-feed` (Opus)

### Task 5 : `tvnews.py`
**Files:** Create `backend/bots/paper/tvnews.py` ; Test `test_tvcoach_feed.py` (fixtures `tv_news_btc.json`, `tv_news_aapl.json`, `tv_story.json`)
- `parse_items(payload: Any, tv_symbol: str) -> List[Dict]` : items → `{id, title, published (iso UTC), provider (id), urgency, story_path, related (liste EXCHANGE:TICKER), tv_symbol, symbol (via brief.tv_to_yahoo du premier related mappable, sinon du tv_symbol), url ("https://www.tradingview.com" + story_path)}` ; items sans `title`/`published` ignorés ; dédup par `id`.
- `fetch_items(client, tv_symbol, lang) -> List[Dict]` (client injecté, `httpx.Client`-like `.get(url, headers)`), URL exacte : `https://news-mediator.tradingview.com/news-flow/v2/news?filter=lang:{lang}&filter=symbol:{tv_symbol}&client=web&streaming=false`, headers `User-Agent: Mozilla/5.0 (OmenServer coach)`, `Origin: https://www.tradingview.com` ; 429/5xx → `[]` + drapeau dans l'état.
- `fetch_story(client, item_id, lang) -> Optional[str]` : `https://news-headlines.tradingview.com/v2/story?id=…&lang=…` → `shortDescription` sinon texte concaténé de `astDescription` (children `text`), tronqué 1200 caractères.
- `to_events(items) -> List[Dict]` : forme des événements newswatch existants (`title, link, ts, symbol, sentiment, source:"tradingview", provider`), `sentiment` via `newswatch.classify(title)` (importer la fonction existante ; crypto via `newswatch.is_crypto_topic`/`crypto_symbol`), `story_key` dédup réutilisée si accessible sinon `id`.
- `yahoo_to_tv(symbol) -> Optional[str]` (inverse minimal : `AAPL`→`NASDAQ:AAPL` inconnu ⇒ chercher dans la table inverse de `brief`, sinon `None` ; BTC-USD → `BITSTAMP:BTCUSD`, NESN.SW → `SIX:NESN`).
- `run(username_symbols: Dict[str, List[str]], focus: Optional[str], client, state: Dict, now) -> List[Dict]` : 1 requête par symbole (positions ∪ favoris ∪ focus) en `en` puis `fr`, budget 60 req/cycle, `state["last_fetch"][symbol]` ≥ 60 s entre deux appels, événements nouveaux retournés (dédup `state["seen_ids"]`, cap 2000 glissant).
- Branchement `newswatch.run_once` : appeler `tvnews.run(...)` dans un `try/except` isolé chaque cycle, fusionner les événements dans le flux global (même chemin que les autres volets) ; **tout nouveau compteur d'état ajouté à l'allowlist de `_load_seen_state`** (piège documenté : sinon mort silencieuse) ; corps (`fetch_story`) seulement pour les items `urgency <= 2` d'un symbole DÉTENU et de provider ∈ `{"reuters","dow-jones","cnbctv","awp","afp"}` (liste `CURATED_PROVIDERS`) — ces événements portent `curated: True` pour `held_risk`.
- Tests : parse sur les 2 fixtures (compte, champs, symbol BTC-USD/AAPL), story parse, budget/cadence 60 s (horloge injectée), 429 → vide sans exception, `run_once` avec `tvnews.run` monkeypatché qui lève → cycle intact, allowlist figée (test qui lit l'état après un cycle et compare la forme COMPLÈTE des clés).

### Task 6 : `tvcalendar.py` + agenda
**Files:** Create `backend/bots/paper/tvcalendar.py` ; Modify `backend/bots/paper/calendar.py` (fusion) ; Test `test_tvcoach_feed.py` (fixture `tv_calendar.json`)
- `parse_events(payload, *, countries=("US","EU","CH","GB","JP","CN"), min_importance=1) -> List[Dict]` : `{date: "YYYY-MM-DD", time_utc: "HH:MM", kind: "macro", label: "{country} · {title}", country, importance, source: "tradingview", id}` ; `date` du champ `date` de l'API uniquement.
- `fetch(client, days=14, now=None)` : URL exacte `https://economic-calendar.tradingview.com/events?from={iso}&to={iso}&countries=US,EU,CH,GB,JP,CN`, mêmes headers que tvnews, cache état 1 h.
- `calendar.py` : la vue agenda (`GET /calendar` existant) inclut les entrées `macro` (nouveau `KIND_MACRO = "macro"`) et les entrées `crypto` fournies par `btc.crypto_agenda` (import paresseux dans un try ; absent ⇒ rien), triées avec les autres, dédup par `(kind, date, label)`.
- Tests : parse fixture → seulement importance 1 des pays listés, ECB 10/09 12:15 présent, tri, fusion dans l'agenda existant sans casser ses tests.

### Task 7 : `focus.py` + routes section C
**Files:** Create `backend/bots/paper/focus.py` ; Modify `paper_tv_router.py` (ancre `# --- LOT C`)
- `set_focus(username, symbol, now) -> Dict`, `get_focus(username, now)`, état `data/paper_trading/focus.state.json` (point dans le radical), TTL 10 min, 1 symbole par utilisateur ; `newswatch.run_once` lit `focus.all_active(now)` pour ajouter ces symboles au scan TV et RSS.
- Routes `POST /focus`, `GET /focus`, `GET /tvcalendar`.

### Task 8 : `paper_ws.py`
**Files:** Modify `backend/bots/paper_ws.py` (squelette existant) ; Test `test_tvcoach_ws.py`
- `ConnectionManager` (calqué sur `backend/sysdoc/ws_router.py`) : `Dict[username, Set[WebSocket]]`, max 4 sockets/utilisateur, `broadcast(username, message)`, `broadcast_all`.
- `@router.websocket("/ws/paper")` : accepte, attend le 1er message JSON `{"token"}` sous 5 s, `decode_token` (`backend.auth.utils`), sinon `close(1008)` ; ping 25 s / pong ; rôle ∈ admin/money/trader.
- `emit(username_or_None, type, symbol, payload)` fonction module appelée depuis : `convergence.maybe_fire` (digest + threat, après envoi Telegram), déclenchement serveur d'une alerte prix (là où `price_alerts.trigger` est appelé), `tvnews.run` (news d'un symbole focus), `calendar` (`calendar_soon` : événement dans ≤ 30 min, calculé à chaque cycle). `emit` est **best-effort** (jamais d'exception, thread-safe via `asyncio.run_coroutine_threadsafe` sur la loop enregistrée au startup ; sans loop ⇒ no-op).
- Tests : accept-puis-1008 sans token ; token valide → reste ouvert et reçoit un `emit` ; 5e socket refusé ; `emit` sans loop ne lève pas (pattern discriminant : le cas autorisé doit être observable, pas seulement le rejet).

## 4. Lot D — `be-scalps` (Opus)

### Task 9 : `scalps.py`
**Files:** Create `backend/bots/paper/scalps.py` ; Test `test_tvcoach_scalps.py`
- `validate(payload, *, server_price: Optional[float], now) -> Dict` : refuse (`ValueError` avec code) prix hors ±5 % de `server_price` (si connu), `ts` hors 24 h, `exit.ts < entry.ts`, `samples` > 600 ou non triés, `side` ∉ buy/sell, `qty <= 0`.
- `settle(payload, *, fees_profile, custom_pct=None) -> Dict` : `pnl_chf` brut = `(exit − entry) × qty × (1 si buy sinon −1)` (converti via `quotes.fx_to_chf` injectable pour les paires USD), `fees_chf` = `fees.compute_fees` × 2, net, `pnl_pct`, `mae_pct`/`mfe_pct` via `tradestats.excursions(candles, entry_price, side…)` sur des pseudo-bougies construites depuis `samples` (chaque échantillon = bougie o=h=l=c), `duration_s`.
- `record(username, settled) -> Dict` : ajoute à `data/paper_trading/<user>.scalps.json` (cap 500 glissant, écriture atomique `store._atomic_write_json` 0o600), id client dédupliqué (`client_id` déjà présent ⇒ renvoyer l'existant, pas de doublon).
- `stats(entries, now) -> Dict` (`today`, `week` : n, wins, pnl_chf, fees_chf, avg_duration_s), `biases(entries, now) -> List[str]` : `revenge_trade` (scalp ouvert < 10 min après un perdant), `overtrading` (> 6/h), `fee_bleed` (frais > 50 % du brut gagné sur la journée), `let_losers_run` (durée moyenne des perdants > 1,5 × gagnants) ; `discipline(entries) -> Dict` en réutilisant `tradestats.discipline_score` si sa forme d'entrée convient, sinon score propre 0-100 documenté (−10 par biais du jour, −20 si `daily_loss` atteint).
- `session_context(entries, now) -> Dict` pour le prompt de bilan.
- Tests : validate (6 refus + 1 ok), settle buy/sell, MAE/MFE cohérents avec des échantillons choisis à la main, cap 500, dédup `client_id`, stats/biais sur un jeu de 12 scalps synthétiques, aucune I/O réseau.

### Task 10 : bilan de session + routes section D
**Files:** Modify `backend/bots/paper/llm.py` (ajouter `build_scalp_review_prompt(context, lang="fr")`, style des builders existants, mandat : « coach de discipline, factuel, chiffres du contexte seulement, 120 mots max, langue de l'UI ») ; Modify `paper_tv_router.py` (ancre `# --- LOT D`)
- `POST /scalps` (Pydantic `ScalpPayload`), `GET /scalps`, `POST /scalps/review` via `_job_or_sync` (plafond 3 bilans/jour/utilisateur, état dans le fichier scalps), réponse `{"answer"}` ; le texte est ajouté au carnet via `_append_journal(username, "bilan scalps", answer, now)` (import depuis `paper_router`).
- Tests TestClient : 200 forme, 400 prix aberrant, dédup, review plafonné (4e → 429), prompt construit sans réseau (`llm._claude_text` monkeypatché).

## 5. Lot E — `be-btc` (Opus)

### Task 11 : `btc.py`
**Files:** Create `backend/bots/paper/btc.py` ; Test `test_tvcoach_btc.py` (fixtures `binance_*.json`, `deribit_*.json`, `fng.json`, `coinbase_spot.json`)
- Parseurs purs : `parse_premium(payload) -> {mark, index, funding_pct (lastFundingRate×100), next_funding_utc (iso)}`, `parse_oi(payload) -> {oi, ts}`, `parse_dvol(payload) -> {dvol (dernier close), ts}`, `parse_deribit_index(payload) -> float`, `parse_fng(payload) -> {value, label, ts}`, `parse_coinbase(payload) -> float`.
- `snapshot(client, state, now) -> Dict` (§5.1 clé `btc`) : appelle chaque source dans un try isolé (URLs exactes de la spec §3), `coinbase_premium_pct = (coinbase − binance_mark) / binance_mark × 100`, `oi_24h_pct` depuis `state["oi_history"]` (liste `[ts, oi]` 48 h glissante), `funding_history` (règlements observés), cache 60 s (F&G et DVOL 1 h). `cme_gap(candles_btc_f, spot, now) -> {level, open: bool}` : dernier close du vendredi (Yahoo `BTC=F`, bougies 1 j) vs spot ; `open` tant que le spot n'a pas retraversé le niveau depuis la clôture.
- `crypto_agenda(now, days=7) -> List[Dict]` : funding 00:00/08:00/16:00 UTC, expirations Deribit vendredi 08:00 UTC (hebdo) + dernier vendredi du mois (mensuelle), CME fermé vendredi 21:00 UTC → dimanche 22:00 UTC (deux entrées), ouverture US 13:30 UTC jours ouvrés ; `{date, time_utc, kind: "crypto", label}`.
- Facteurs : `factors(state, now) -> Dict[str, List[Dict]]` : `funding_extreme` (|funding| ≥ 0,05 % sur 2 règlements consécutifs), `oi_buildup` (OI +10 % en 24 h et |Δ prix 24 h| < 1 %) ; items `{id, kind, text}` avec ids DISJOINTS (`btc:funding:<ts>`, `btc:oi:<day>`).
- Branchement `convergence.py` : ajouter les deux codes à `FACTOR_CODES` + libellés FR/IT dans la table existante ; `collect_factors` accepte un paramètre optionnel `btc_factors=None` fusionné ; **jamais dans `THREAT_FACTORS`**.
- Tests : chaque parseur sur fixture + payload cassé, premium/oi_24h, cme_gap ouvert/comblé, agenda 7 j (dates réelles calculées, aucune inventée : test sur une date fixe connue, ex. 2026-09-09 → vendredi 11/09 08:00 expiration, dernier vendredi 25/09 mensuelle), facteurs seuls ne déclenchent pas `should_fire`, `FACTOR_CODES` étendu sans casser les tests existants.

### Task 12 : route section E
**Files:** Modify `paper_tv_router.py` (ancre `# --- LOT E`) — `GET /btc` (snapshot + agenda, client httpx réel en prod, injectable en test).

## 6. Lot X — `ext-core` (Opus)

### Task 13 : squelette de l'extension
**Files:** Create `tools/tv-coach-extension/manifest.json`, `bridge.js`, `content.js`, `content-omen.js`, `sw.js`, `panel.css`, `options.html`, `options.js`, `lib/symbols.js`, `lib/alerts.js`, `lib/i18n.js`, `lib/api.js`, `lib/draw.js`, `README.md`, `tests/symbols.test.js`, `tests/alerts.test.js`, `tests/i18n.test.js`, `tests/manifest.test.js`
- `manifest.json` : `manifest_version 3`, `name "OmenServer Coach"`, `version "0.1.0"`, `content_scripts` : `[{matches: ["*://*.tradingview.com/chart/*"], js: ["bridge.js"], world: "MAIN", run_at: "document_idle"}, {matches: ["*://*.tradingview.com/chart/*"], js: ["lib/i18n.js","lib/symbols.js","lib/alerts.js","lib/bars.js","lib/guards.js","lib/ledger.js","lib/draw.js","content.js"], css: ["panel.css"], run_at: "document_idle"}, {matches: ["https://omenserver.org/*","http://localhost:8000/*"], js: ["content-omen.js"]}]`, `background.service_worker: "sw.js"`, `host_permissions: ["https://omenserver.org/*","http://localhost:8000/*","wss://fstream.binance.com/*"]`, `permissions: ["storage","notifications","alarms"]`, `options_page`.
- Les modules `lib/*.js` s'écrivent en **double usage** : `globalThis.OmenLib = globalThis.OmenLib || {}` + `if (typeof module !== "undefined") module.exports = …` (testables par `node --test`, utilisables en content script sans bundler). `sw.js` utilise `importScripts("lib/symbols.js", …)`.
- `bridge.js` (monde MAIN) : détecte `window.TradingViewApi` (réessai 500 ms × 40) ; publie `window.postMessage({omen: true, nonce, type: "tv:symbol", tv_symbol: chart.symbol(), resolution: chart.resolution()}, location.origin)` au démarrage et sur `chart.onSymbolChanged().subscribe(...)` ; toutes les 1 s publie `tv:tick {price (titre), bid, ask}` (bid/ask lus sur les pastilles `[data-name="..."]` ou par texte « SELL »/« BUY » adjacents — sélecteurs dans une constante commentée) ; écoute les commandes `draw:*` (voir `lib/draw.js` côté content pour le format) et répond `draw:result {ids}` ; expose `onMove` des lignes d'ordre via `tv:line_moved {id, price}`. Le `nonce` est tiré par `content.js` et transmis via un attribut `data-omen-nonce` sur `<html>` avant l'injection ; tout message sans le bon nonce est ignoré.
- `content.js` : panneau shadow-DOM `omen-coach` (bouton flottant repliable, position mémorisée), état `{tv_symbol, symbol, kind, resolution, mode, brief, price, bid, ask, alerts}`, rendu par `render()` avec `esc()` sur tout texte ; sections : en-tête (symbole, prix live, mode), position/stop/cible, coach (position du coach, idées), news (5), agenda (3), alertes, chips (mood/btc), bouton « Conseil » (`POST /coach/ask` job + polling 3 s via `sw.js`), ticket (mode swing : Acheter/Vendre, quantité auto par `precheck`, stop/cible par lignes déplaçables, Confirmer → `POST /orders` existant `{symbol, side, qty, price, stop_loss, take_profit}` (vérifier la forme dans `paper_router.py` avant d'écrire), avertissements en une ligne). Mode `scalp` si `resolution` ∈ `{"1","2","3","5"}` (minutes) : le ticket devient le ledger (`lib/ledger.js`), les garde-fous (`lib/guards.js`) s'affichent en bandeau, `lib/bars.js` alimenté par les ticks.
- `lib/alerts.js` : `evaluate(alerts, price, prevPrice) -> [alertIds déclenchées]` avec hystérésis 0,05 % et `fired` ignorées ; `content.js` déclenche localement (toast + `chrome.runtime.sendMessage({type:"notify"})`) puis `POST /alerts/{id}/fire`.
- `sw.js` : `chrome.storage.local` `{token, api_base, fee_profile, custom_pct, risk_pct, lang, scalp_auto}` ; `fetchApi(path, options)` avec `Authorization: Bearer` ; messages `api`, `notify`, `ws:subscribe` ; client WS `/ws/paper` (1er message token, pong, reconnexion 1→30 s), diffusion des messages aux onglets ; en mode scalp BTC, WS `wss://fstream.binance.com/ws/btcusdt@markPrice@1s/btcusdt@forceOrder` relayé aux onglets (`btc:mark`, `btc:liq`) — connecté seulement tant qu'un onglet BTC en mode scalp est ouvert.
- `content-omen.js` : sur omenserver.org connecté, injecte un bouton « Connecter l'extension coach » (bas droite, classe Ion) ; clic → lit `localStorage.getItem("omenserver_token")` + `localStorage.getItem("omen-lang")` (vérifier la clé de langue dans `frontend/js/lang.js`) → `chrome.runtime.sendMessage({type:"token", token, lang, api_base: location.origin})`.
- `lib/i18n.js` : `t(key, lang, values)` FR/IT/EN pour toutes les chaînes du panneau (≈ 60 clés), test de parité des clés ×3.
- `options.html/js` : profil de frais (select : tv_paper / kraken_spot / kraken_futures / yuh / swissquote / ibkr / custom + % custom), risque %, langue, mode scalp auto, URL Omen ; premier lancement : bandeau « choisis ton profil de frais » tant que vide.
- `panel.css` : tokens Ion/Givre repris (dark `#050810/#0A101E/#EDF2FA/#00FFB0`, light `#EBF0FA/#FFFFFF/#0B1220/#00885C`), `prefers-color-scheme`, police système + `font-variant-numeric: tabular-nums`, largeur 320 px, hauteur max 70 vh, scroll interne.
- `lib/draw.js` : construit les commandes pour `bridge.js` : `levels({entry, stop, target, side, label})` → lignes d'ordre ; `bets(hypotheses, price, now)` → pour chaque hypothèse ouverte : `trend_line` de `(now, price)` à `(now + horizon_days, price × (1 ± 0.03))`, texte `⌂ coach · A · haute` selon `confidence` (haute→A, moyenne→B, faible→C), `vertical_line` d'échéance, `rectangle` zone cible si `target` ; `scalp({vwap, day_high, day_low, cme_gap})` → 3-4 `horizontal_line` ; `clear()` → `removeEntity` sur tous les ids créés par l'extension (jamais les autres). Mode swing : `bets` + `levels` ; mode scalp : `scalp` + `levels` du scalp en cours.
- Tests `node --test` : `symbols` (table §1.1 complète, casse, `.P`), `alerts` (above/below, hystérésis, fired), `i18n` parité, `manifest` (JSON valide, `world: "MAIN"` présent, host_permissions attendues), `draw` (commandes générées pour 2 hypothèses).
- `README.md` : installation (chrome://extensions → mode développeur → « Charger l'extension non empaquetée » → ce dossier), connexion du token depuis omenserver.org, options, vérification locale (`api_base` = `http://localhost:8000`).

## 7. Lot S — `ext-scalp` (Sonnet)

### Task 14 : modules purs du mode scalp
**Files:** Create `tools/tv-coach-extension/lib/bars.js`, `lib/guards.js`, `lib/ledger.js`, `tests/bars.test.js`, `tests/guards.test.js`, `tests/ledger.test.js` (même convention double usage `OmenLib` + `module.exports`)
- `bars.js` : `createBars()` → objet `{push(ts_ms, price), bars() -> [{t, o, h, l, c}]` (1 min, fermées), `atr(n=14) -> number|null`, `medianAtr(hours=4) -> number|null`, `vwap(samplesWithVolume?)` (sans volume : moyenne pondérée par le temps = `null` documenté ; VWAP réel vient du `brief.ta.vwap`), `dayHigh()`, `dayLow()`, `spread(bid, ask)` + `medianSpread()` sur les 200 derniers}`.
- `guards.js` : `evaluate(state, thresholds = DEFAULTS) -> [{code, level, values}]` avec `state = {now_ms, calendar: [{ts_ms, importance}], next_funding_ms, last_news_ms, atr1, atr1_median, spread, spread_median, fee_round_trip_pct, price, scalps_today: [{closed_ms, pnl_chf}], equity_chf, is_perp}` ; codes/seuils EXACTEMENT ceux de la spec §6.3 ; pur, déterministe.
- `ledger.js` : `open({side, qty, price, ts_ms, fee_profile, fee_pct_per_side})`, `sample(ts_ms, price)`, `close(price, ts_ms) -> {pnl_gross, fees, pnl_net, pnl_pct, mae_pct, mfe_pct, duration_s, samples}` ; `serialize()` pour `POST /scalps` (échantillons réduits à ≤ 600 par décimation régulière).
- Tests : bars sur une séquence synthétique de 30 min (ATR attendu calculé à la main), guards : un cas par code + cas « tout vert », ledger buy/sell avec MAE/MFE choisis, décimation 900 → 600.

## 8. Intégration, contrôle, livraison (Fable)

### Task 15 : wiring et contrôle
- [ ] `backend/main.py` monte `paper_tv_router` et `paper_ws` (déjà fait par Fable avant dispatch).
- [ ] Après chaque lot : lire le diff, relancer `pytest` complet + `node --test` + parse + NUL, vérifier chaque critère du lot, commit par lot (`feat(tv-coach): LOT X — …`).
- [ ] Vérification locale de bout en bout : `uvicorn backend.main:app --port 8000` en arrière-plan sur le worktree avec `data/` local, utilisateur de test créé en base, token minté via `create_access_token`, extension chargée avec `api_base=http://localhost:8000` ; scénario : changement de titre → fiche ; alerte live ; scalp ouvert/fermé → `GET /scalps` ; dessins posés/effacés ; 0 erreur console.
- [ ] `git fetch` + rebase sur `origin/main`, suites vertes, push `worktree-tv-coach-extension:main` (auto-deploy Omen, `curl` de `/api/paper/btc` en prod avec le token de l'onglet de Massii).
- [ ] Vault Daily + mémoire projet + CLAUDE.md (section extension + pièges nouveaux).

## 9. Auto-revue du plan (faite le 09/09)
- Couverture spec : §4.1 → Task 13/14 ; §4.2 → Tasks 2-12 ; §5 contrats → §1 du plan ; §6 modes → Tasks 3, 9, 13, 14 ; §7 leviers → Tasks 5, 7, 8, 3, 13 ; §8 idées → Task 13 (alerte au clic, watchlist import, note journal : à inclure dans Task 13 si le temps le permet, sinon Lot F suivant — **non bloquant pour la v1**) ; §9 BTC → Tasks 11-12 + sw.js ; §10 sécurité → Tasks 8, 9, 13 ; §11 erreurs → `degraded`, files locales, reconnexion ; §12 tests → chaque task.
- Placeholders : aucun « TBD » ; les seuils sont ceux de la spec.
- Cohérence des noms : `brief.tv_to_yahoo` ↔ `lib/symbols.js` (même table, tests miroirs) ; `precheck.evaluate` ↔ `POST /precheck` ; `scalps.validate/settle/record` ↔ `POST /scalps` ; `paper_ws.emit` ↔ appels dans convergence/tvnews/calendar/alerts.
