# Coach OmenServer dans TradingView — extension Chrome (spec de conception)

> Date : 2026-09-09 · Auteur : Fable (brainstorming avec Massii) · État : **proposée, en attente de validation**
> Branche : `worktree-tv-coach-extension` (base `origin/main` = `f27822e`, Lot 12 déployé)
> Mémoire : `project_tv_coach_extension.md` · Vault : Daily 2026-09-09 (19:25, 19:45, 19:55) · Hub [[📈 Trading Simulator]]

---

## 1. Ce qu'on construit, en une phrase

Une **extension Chrome** qui vit sur la page TradingView, sait quel titre et quel intervalle Massii regarde, affiche dans un panneau compact tout ce que l'Omen sait de ce titre, évalue ses alertes sur le prix live, propose un ticket d'ordre simulé aussi simple que celui de TradingView, dessine sur le graphique les niveaux et les paris du coach, et — quand l'intervalle est court — devient un **garde-fou de scalping** avec journal automatique. Le LLM n'est appelé que sur clic ou en bilan de session.

## 2. Décisions de Massii (ne pas rouvrir sans lui)

| # | Décision | Date |
|---|---|---|
| D1 | Forme = **extension Chrome** (TradingView vit dans Chrome ; pas d'app native, pas de TradingView embarqué) | 09/09 |
| D2 | Les **alertes OmenServer sont évaluées dans l'extension** sur le prix live de la page | 09/09 |
| D3 | Les **news TradingView entrent dans la base** (scanner, entités, graphe Connexions) | 09/09 |
| D4 | Les 5 leviers de vitesse (§7) et toutes les idées « à ajouter » (§8) sont retenus | 09/09 |
| D5 | Ticket « simuler » **simple comme TradingView** — le formulaire d'ordre OmenServer était difficile à comprendre | 09/09 |
| D6 | Agenda enrichi par les données TradingView (calendrier économique) | 09/09 |
| D7 | **Focus Bitcoin** ; les points BTC recommandés par Fable (§9) sont pris | 09/09 |
| D8 | Horizon réel de Massii = **scalps de 3 à 4 minutes** → mode scalp (§6) | 09/09 |

Doctrines héritées du module Trading, toujours valables : LLM hors boucle de décision ; « accumule en silence, parle sur alignement » ; tout pari est scoré ; jamais de date inventée ; le coach trade avec **les mêmes frais** que l'utilisateur ; **jamais de conseil argent réel** (tout vit dans le simulateur).

## 3. Faits vérifiés le 09/09 (sur lesquels la conception s'appuie)

- La page TradingView expose `window.TradingViewApi.activeChart()` dans le **monde principal** : `onSymbolChanged`, `symbol()`, `resolution()`, `getVisibleRange()`, `createMultipointShape` / `createShape` (trend_line, path, long_position, rectangle, horizontal_line, vertical_line, arrow_up, text), `removeEntity`, `getAllShapes`, `createOrderLine` / `createPositionLine` (lignes déplaçables avec `onMove`). Les `create*` renvoient des Promises. `setVisibleRange` et `exportData` ne sont pas disponibles sur le site.
- **Le dessin par API exige d'être connecté à TradingView** (gate `ensureDrawingCreationAllowed` → `window.is_authenticated`). Connecté en plan gratuit : tout passe (9 formes testées sur le compte de Massii, puis effacées).
- Un content script classique (monde isolé) **ne voit pas** cette API → un script injecté en `world: "MAIN"` fait pont.
- Titre d'onglet = `SYMBOL PRIX ▲ +x %` mis à jour en direct ; les pastilles SELL/BUY du graphique donnent **bid et ask**. L'URL ne porte pas le symbole.
- Flux news `news-mediator.tradingview.com/news-flow/v2/news?filter=symbol:…` : **200 sans cookie, depuis le Mac ET depuis l'Omen** ; 20+ sources (Reuters, Dow Jones, CNBC, Benzinga, Zacks, Cointelegraph…) ; fraîcheur mesurée 2-3 min (flux global), 7-9 min (AAPL) ; corps via `news-headlines.tradingview.com/v2/story?id=…`. Dans la page : 1 lecture au chargement puis **push WebSocket** (0 polling en 148 s).
- Calendrier économique `economic-calendar.tradingview.com/events?from=…&to=…&countries=…` : **200 sans cookie** (Mac et Omen), JSON `result[]`.
- Sources BTC publiques, **200 sans clé depuis l'Omen** : Binance perp `premiumIndex` (mark, funding, prochain funding) et `openInterest` ; Deribit `get_volatility_index_data` (DVOL) et `get_index_price` ; `api.alternative.me/fng` ; Coinbase spot ; mempool.space. **Morts ou bloqués** : Farside (403 Cloudflare), Polymarket (DNS suisse).
- TradingView gratuit : News Flow inclus ; **webhooks réservés à Essential+** (3 alertes prix, 0 webhook).
- Latence Mac → omenserver.org : 0,11-0,23 s. CORS backend = omenserver.org seulement.
- Le simulateur tourne par pas de 15 min sur Yahoo (différé 15 min actions) ; les 6 endpoints LLM sont des jobs détachés (plafond 4), 30 s à 2 min ; Python 3.9 sur le Mac de dev, 3.14 sur l'Omen.

## 4. Architecture

```
TradingView (onglet Chrome)                                   Omen (omenserver.org)
┌──────────────────────────────────────────────┐             ┌──────────────────────────────┐
│ bridge.js  (world MAIN)                      │             │ paper_router.py              │
│  · TradingViewApi : symbole, intervalle,     │             │  · GET  /brief?symbol=       │
│    bid/ask, dessin (formes, lignes d'ordre)  │             │  · POST /precheck            │
│        ▲ postMessage (typé, origine vérifiée)│             │  · POST /scalps · /review    │
│ content.js (monde isolé)                     │  fetch/WS   │  · POST /focus               │
│  · panneau shadow-DOM « omen-coach »         │◄───────────►│  · POST /alerts/{id}/fire    │
│  · état : titre, mode swing/scalp, samples   │             │  · WS   /ws/paper (push)     │
│  · alertes live, garde-fous, ticket, ledger  │             │ paper/                       │
│        ▲ chrome.runtime messages             │             │  · tvnews.py  tvcalendar.py  │
│ sw.js  (service worker)                      │             │  · btc.py     scalps.py      │
│  · token, appels API (host_permissions),     │             │  · brief.py   precheck.py    │
│    WS Omen, WS Binance (mode scalp BTC),     │             │  · newswatch/calendar/graph  │
│    notifications, cache                      │             │    (branchements)            │
└──────────────────────────────────────────────┘             └──────────────────────────────┘
```

Principes : **le serveur calcule, l'écran affiche** (une formule d'argent n'existe qu'une fois, côté serveur, sauf ce qui doit vivre à la seconde : alertes live, garde-fous scalp, ledger — et même là le serveur **recalcule** à la réception). Chaque source externe est une **panne isolée** (repli, drapeau « source morte », jamais d'exception qui remonte). **Zéro nouvelle dépendance** Python ni Node ; l'extension est en **vanilla JS sans build**.

### 4.1 Extension `tools/tv-coach-extension/` (Manifest V3)

| Fichier | Rôle |
|---|---|
| `manifest.json` | MV3 ; `content_scripts` : `bridge.js` en `world: "MAIN"` + `content.js` (isolé) sur `*://*.tradingview.com/chart/*` ; `content-omen.js` sur `https://omenserver.org/*` (récupération du token, §10) ; `host_permissions` : `https://omenserver.org/*`, `wss://fstream.binance.com/*` ; permissions : `storage`, `notifications`, `alarms` |
| `bridge.js` | Monde MAIN. Lit `TradingViewApi` ; publie `{type:'tv:symbol', tv_symbol, resolution}` sur `onSymbolChanged` et au chargement ; lit bid/ask des pastilles SELL/BUY (DOM) et le titre (prix) ; exécute les ordres de dessin reçus (`draw:levels`, `draw:scenarios`, `draw:clear`) et renvoie les ids ; expose `onMove` des lignes d'ordre (stop/cible déplacés) |
| `content.js` | Monde isolé. Panneau `omen-coach` en shadow DOM (ancré à droite, repliable, déplaçable, mémorisé) ; machine à états `mode ∈ {swing, scalp}` (§6) ; échantillonne le prix à 1 Hz (titre) ; évalue alertes et garde-fous ; ticket et ledger ; parle à `sw.js` |
| `sw.js` | Service worker : token (`chrome.storage.local`), `fetch` vers l'Omen, WS `/ws/paper` avec reconnexion (backoff 1→30 s), WS Binance en mode scalp BTC, notifications navigateur, cache du dernier `brief` par symbole (5 min) |
| `lib/symbols.js` | **pur** : `tvToYahoo('SIX:NESN') → 'NESN.SW'`, `BATS:AAPL → AAPL`, `BITSTAMP:BTCUSD / BINANCE:BTCUSDT / KRAKEN:XBTUSD / COINBASE:BTCUSD → BTC-USD`, `FX:EURUSD → EURUSD=X`, `TVC:UKOIL → BZ=F` ; inconnu → `null` (le panneau dit « titre non suivi ») |
| `lib/guards.js` | **pur** : garde-fous scalp (§6.3) — entrée = état, sortie = liste `{code, level, text_key, values}` |
| `lib/alerts.js` | **pur** : évaluation `above/below` avec hystérésis 0,05 % et one-shot |
| `lib/bars.js` | **pur** : barres 1 min depuis les échantillons, ATR(14), VWAP de session, haut/bas du jour, spread médian |
| `lib/ledger.js` | **pur** : scalp ouvert/fermé, P&L brut/net selon profil de frais, MAE/MFE sur échantillons, durée |
| `lib/i18n.js` | FR/IT/EN, clés `coach.*`, langue = celle d'OmenServer (lue avec le token) |
| `panel.css` | Design Ion/Givre : tokens repris de `style.css` (bleu-nuit `#050810`, accent `#00FFB0` ; mode clair `#EBF0FA`, accent `#00885C`), Geist, chiffres en mono `tnum` ; suit `prefers-color-scheme` |
| `options.html/js` | Premier lancement : profil de frais (obligatoire, §6.4), risque par trade (1 % par défaut), langue, mode scalp auto (oui), **URL de l'Omen** (`https://omenserver.org` par défaut, réglable sur `http://localhost:8000` pour la vérification locale — `host_permissions` inclut les deux) |
| `tests/*.test.js` | `node --test` sur les modules purs (Node 22) |

### 4.2 Backend (package `backend/bots/paper/`, DI partout, tests hors ligne)

| Module | Rôle |
|---|---|
| `brief.py` | **assemble** `GET /brief` (§5.1) à partir des modules existants : quotes, portfolio, coach_trader (positions du coach), idea_journal (`ideas/for-symbol`), radar (hypothèses), newswatch (événements du titre, dont source `tradingview`), calendar (7 j), whales (moves_summary du titre), mood (VIX), btc (si crypto), fees (profil + A/R %), price_alerts, ta (ATR14 jour) + candles Yahoo 1 min du jour (ATR1, VWAP, H/L) |
| `precheck.py` | **pur** : applique les règles déjà écrites (`risk.preorder_warnings`, `fee_ratio`, `stop_in_noise` de `coach_trader`, concentration, biais `coach.detect_biases` sur l'historique) à un ordre hypothétique → `{qty, risk_pct, fees, r, warnings, refusals}`. Le LLM n'y touche pas |
| `tvnews.py` | volet newswatch **TradingView** : 1 requête / 60 s / symbole (positions ∪ favoris ∪ **focus** §7) en `lang:en` + `lang:fr` ; dédup par `id` et `story_key` ; `provider` conservé ; corps (`story`) chargé pour les items `urgency ≤ 2` des titres DÉTENUS seulement (facteur `held_risk` = sources curées → liste blanche : reuters, dow-jones, cnbctv, awp, afp) ; entités → graphe. Budget global 60 req/min max, backoff 429 |
| `tvcalendar.py` | volet agenda : événements `importance == 1` (haute) des pays `US, EU, CH, GB, JP, CN` à 14 j → entrées `calendar` `{kind:'macro', date, time_utc, label, country, source:'tradingview'}` ; jamais de date construite : la date vient du champ `date` de l'API |
| `btc.py` | collecteurs purs + parseurs (§9) : funding/OI Binance, DVOL/index Deribit, Fear & Greed, prime Coinbase, **gap CME** (Yahoo `BTC=F`), agenda crypto **calculé** (funding 00/08/16 UTC, expirations Deribit vendredi 08:00 UTC, mensuelle dernier vendredi, CME fermé ven 21:00 UTC → dim 22:00 UTC, ouverture US 13:30 UTC) ; facteurs de convergence `funding_extreme`, `oi_buildup` (§9.2) |
| `scalps.py` | ledger `<user>.scalps.json` (cap 500 glissant, fichier avec point dans le radical pour les états) ; recalcul serveur du P&L, frais, MAE/MFE (`tradestats.excursions` sur les échantillons), biais (`coach.detect_biases` étendu aux scalps), score de discipline ; bilan de session (prompt `llm.review_scalps`) |
| `paper_router.py` | routes §5 ; WS `/ws/paper` (§5.3) ; `focus` ; `alerts/{id}/fire` |
| `fees.py` | nouveaux profils §6.4 |
| `convergence.py` | 2 facteurs BTC (§9.2) — ids disjoints, ajoutés à l'allowlist des compteurs (piège documenté) |

### 4.3 Flux de données (nominal)

1. Massii ouvre un graphique → `bridge.js` publie `tv:symbol` → `content.js` mappe (`lib/symbols.js`) → `sw.js` appelle `GET /brief?symbol=BTC-USD&tv=BITSTAMP:BTCUSD` (cache 5 min) → panneau peint en < 0,4 s.
2. `sw.js` envoie `POST /focus {symbol}` (heartbeat toutes les 2 min tant que l'onglet est visible) → l'Omen scanne ce titre à 60 s (TV news + RSS Yahoo) au lieu de 5 min.
3. Le titre d'onglet change → prix live → `lib/alerts.js` évalue les alertes du titre → déclenchement local (toast + notification) + `POST /alerts/{id}/fire` (one-shot, le serveur marque `fired_by:'extension'`).
4. WS `/ws/paper` pousse `digest`, `threat`, `alert` (déclenchée côté serveur), `calendar_soon`, `news` (titre affiché) → badge dans le panneau, notification si menace.
5. Intervalle ≤ 5 min → **mode scalp** (§6) ; ≥ 60 min → **mode swing** ; entre les deux → swing avec garde-fous allégés.
6. Clic « Conseil » → `POST /coach/ask` (question préremplie avec le contexte du titre et du mode) → job → réponse dans le panneau, persistée dans Discussions.md comme aujourd'hui.

## 5. Contrats d'API (nouveaux ou modifiés)

### 5.1 `GET /api/paper/brief?symbol=…&tv=…` (lecture pure, rôles admin/money/trader)

```json
{
  "symbol": "BTC-USD", "tv_symbol": "BITSTAMP:BTCUSD", "kind": "crypto",
  "quote": {"price": 78760.1, "ts": "…", "delay_min": 0},
  "position": {"side":"long","qty":0.02,"avg":77900,"stop":76800,"target":81000,"pnl_chf":12.3} ,
  "coach_position": {"side":"short","qty":…,"stop":…,"target":…,"thesis":"…"} ,
  "pending_orders": [ … ],
  "alerts": [{"id":"…","op":"above","price":80000}],
  "ideas": [ … ],  "hypotheses": [ … ],
  "news": [{"ts":"…","title":"…","source":"reuters","via":"tradingview","sentiment":"neg","url":"…"}],
  "calendar": [{"date":"2026-09-10","time_utc":"12:30","kind":"macro","label":"US CPI","country":"US"}],
  "whales": [ … ],
  "mood": {"vix": 18.2, "fng": 66, "dvol": 40.3},
  "btc": {"funding_pct": 0.0062, "next_funding_utc": "…", "oi": 104504, "oi_24h_pct": 3.1, "coinbase_premium_pct": 0.02, "cme_gap": {"level": 77900, "open": true}},
  "fees": {"profile":"kraken_spot","round_trip_pct":0.52},
  "ta": {"atr14_d": 1850, "atr1_m": 41, "vwap": 78620, "day_high": 79310, "day_low": 78050},
  "defaults": {"risk_pct": 1.0, "equity_chf": 9796}
}
```
Champs absents = `null`, jamais inventés. `position`, `coach_position`, `btc` sont `null` quand sans objet.

### 5.2 `POST /api/paper/precheck` (pur, 0 LLM)

Entrée `{symbol, side, price, stop, target, risk_pct | qty, mode}` → sortie `{qty, risk_pct, risk_chf, fees_chf, r_multiple, expected_move_pct, warnings:[{code, level, text}], refusals:[{code, text}]}`. Codes réutilisés : `no_stop`, `oversized`, `fee_ratio`, `stop_in_noise`, `concentration`, `revenge_trade`, `overtrading`, `cash_floor` ; nouveaux (scalp) : `event_risk`, `funding_soon`, `flash_news`, `vol_spike`, `spread_wide`, `fee_coverage`, `cooldown`, `pace`, `daily_loss`. **Rien ne bloque** : le ticket affiche, l'humain décide ; les avertissements forcés sont journalisés avec l'ordre (`forced_warnings`, mécanisme existant).

### 5.3 `WS /ws/paper` (push serveur → extension)

Auth **par premier message** `{"token": "<jwt>"}` (jamais en query string — suivi de sécurité déjà noté), fermeture 1008 sinon. Messages : `{"type": "alert|digest|threat|calendar_soon|news|brief_changed", "symbol": …, "payload": …, "ts": …}`. Le serveur émet depuis les points existants (`maybe_fire`, guetteurs, `calendar`) via un `ConnectionManager` calqué sur celui du sysdoc (`Dict[user, Set[WebSocket]]`).

### 5.4 `POST /api/paper/scalps` et `/scalps/review`

Entrée : `{tv_symbol, symbol, side, qty, entry:{price, ts}, exit:{price, ts}, samples:[[ts, price]…] (≤ 600), fee_profile, note, emotion}`. Le serveur **recalcule** P&L brut/net, frais, MAE/MFE, durée ; refuse (400) un prix hors ±5 % de sa propre cotation ou un `ts` hors des 24 h ; renvoie `{pnl_chf, pnl_pct, fees_chf, mae_pct, mfe_pct, duration_s, biases, discipline}`. Post-mortem LLM automatique **désactivé pour les scalps** (le cap 6/j serait brûlé en une heure) ; à la place `POST /scalps/review` (job) = bilan de session, déclenché sur clic ou automatiquement après 20 min sans scalp (1 appel par session, max 3/jour). `GET /scalps?limit=` liste + stats du jour et 7 j.

### 5.5 Autres

- `POST /api/paper/focus {symbol}` → focus 10 min renouvelable ; 1 titre focus par utilisateur.
- `POST /api/paper/alerts/{id}/fire {price, ts, by:"extension"}` → marque déclenchée, dédoublonne avec l'évaluation serveur 15 min.
- `GET /api/paper/calendar` gagne les entrées `macro` (TradingView) et `crypto` (calculées) ; l'UI OmenServer existante les affiche sans changement (badge par `kind`).

## 6. Modes du panneau

### 6.1 Mode swing (intervalle ≥ 60 min)
Fiche du titre (§5.1) · pré-check · ticket · conseil sur clic · dessin des niveaux (positions à toi et du coach) et des **paris** du coach : pour chaque hypothèse/idée ouverte sur le titre, une ligne de tendance du prix d'entrée vers ±3 % à l'horizon (`MOVE_THRESHOLD_PCT`, `horizon_days`), étiquetée `A · haute` / `B · moyenne` / `C · faible` selon `confidence`, une zone cible quand `target` existe, une ligne verticale d'échéance. Tout dessin est **taggué** (texte préfixé `⌂ coach`) et retiré par `draw:clear` ; l'extension ne touche jamais aux dessins de Massii.

### 6.2 Mode scalp (intervalle ≤ 5 min)
- **Ticket** : Acheter / Vendre au prix live, quantité auto (`risk_pct × equity / distance stop`), stop et cible = lignes d'ordre déplaçables (`onMove` → recalcul), affichage permanent : frais A/R en CHF et %, mouvement à battre, R, gain/perte au stop et à la cible. Un bouton **Confirmer** ouvre le scalp dans le ledger (l'extension échantillonne à 1 Hz), un bouton **Sortir** le ferme ; envoi `POST /scalps`.
- **Garde-fous** (§6.3) affichés en bandeau, vert/ambre/rouge, jamais bloquants.
- **Dessin** : VWAP de session, haut/bas du jour, gap CME (BTC), entrée/stop/cible du scalp en cours. Pas de scénarios à jours.
- **Coach** : bouton « Bilan de session » (LLM, §5.4). Le bouton « Conseil » reste disponible mais annonce sa latence (« réponse en ~1 min »).

### 6.3 Garde-fous scalp (règles pures, seuils réglables dans les options)

| Code | Condition (défaut) | Niveau |
|---|---|---|
| `event_risk` | événement macro haute importance qui tombe dans les 15 prochaines minutes, ou qui est passé depuis moins de 5 minutes (fenêtre `[now − 5 min, now + 15 min]`) | rouge |
| `funding_soon` | règlement du funding dans < 5 min (perp BTC affiché) | ambre |
| `flash_news` | news TradingView sur le titre publiée depuis < 2 min | ambre |
| `vol_spike` | ATR(1 min, 14) > 2 × sa médiane sur 4 h | ambre |
| `spread_wide` | spread bid/ask > 2 × sa médiane de session | ambre |
| `fee_coverage` | ATR(1 min) × 3 < 3 × frais aller-retour % | rouge, texte « ce scalp doit gagner X % pour payer le courtier » |
| `cooldown` | dernier scalp perdant il y a < 10 min | ambre (`revenge_trade` du coach) |
| `pace` | > 6 scalps dans l'heure | ambre (`overtrading`) |
| `daily_loss` | P&L réalisé du jour ≤ −2 % de l'équité | rouge, texte « stop pour aujourd'hui » |

### 6.4 Frais — profils

`fees.FEE_PROFILES` gagne : `tv_paper` (0 % + commission réglable), `kraken_spot` (taker 0,26 %, maker 0,16 % ; on compte taker), `kraken_futures` (taker 0,05 %, maker 0,02 %), `custom` (% par côté saisi). Pas de timbre suisse sur ces profils. **Le profil est choisi au premier lancement de l'extension, sans défaut caché** : tant qu'il n'est pas choisi, le ticket affiche « frais non configurés » et refuse d'ouvrir un scalp. Hypothèse assumée : la plateforme réelle des scalps de Massii n'est pas encore connue ; la conception ne dépend pas de la réponse, seule la valeur du profil en dépend.

## 7. Vitesse — les 5 leviers retenus

1. **News TradingView côté Omen** (`tvnews.py`) : 60 s par titre suivi, 200 items par appel, corps pour les titres détenus ; repli RSS Yahoo inchangé.
2. **Push** WS `/ws/paper` au lieu du polling ; l'extension ne sonde `brief` qu'au changement de titre et toutes les 5 min.
3. **Focus** : le titre affiché est scanné à 60 s (TV + RSS) pendant 10 min renouvelables.
4. **Pré-check déterministe** dans le panneau ; le LLM n'est jamais sur le chemin d'un ordre.
5. **Alertes évaluées dans l'extension** sur le prix live (D2) ; le serveur garde son évaluation 15 min comme filet.

Cadences visées : changement de titre → fiche < 0,4 s ; alerte prix → < 1 s après le tick ; news TV → visible dans le panneau ≤ 60 s après ingestion Omen (≤ 2 s si l'onglet est l'onglet focus, via WS) ; menace → notification < 1 s après `maybe_fire`.

## 8. Idées retenues (toutes, D4)

Bouton simuler (§6.2) · alerte d'un clic sur un niveau (`bridge.js` écoute le clic sur l'échelle de prix avec Alt) · positions à toi et du coach dessinées · badge agenda · rappel de biais en direct (`revenge_trade`, `overtrading` depuis `coach.detect_biases`) · notification navigateur pour digest/menace du titre affiché · note rapide au journal d'idées (`POST /ideas/journal` existant) · watchlist TradingView ↔ favoris OmenServer (lecture de la watchlist DOM → `POST /watchlist`, un sens : TV → Omen, sur clic « importer ») · capture du graphique au coach = **v2** (nécessite `chrome.tabs.captureVisibleTab` + support image côté `llm.py`, hors périmètre v1).

## 9. Bitcoin — le volet recommandé (D7)

### 9.1 Ce qui entre en v1

| Point | Source (sondée 09/09) | Où | Usage |
|---|---|---|---|
| Prix live de l'échange affiché | page TradingView | extension | prix, P&L, alertes, ledger |
| Bid/ask et spread | pastilles SELL/BUY | extension | garde-fou `spread_wide`, frais implicites |
| Funding, prix de marque, prochain funding | Binance `premiumIndex` | Omen 60 s + WS Binance `markPrice@1s` en mode scalp | chip + `funding_soon` + facteur `funding_extreme` |
| Intérêt ouvert | Binance `openInterest` | Omen 60 s (série 24 h) | facteur `oi_buildup` |
| Liquidations | WS Binance `btcusdt@forceOrder` | extension seulement (v1) | chip « cascade » si ≥ 5 M$ en 5 min |
| Volatilité implicite | Deribit DVOL | Omen 60 s | chip d'ambiance, comme le VIX (`mood.py`) |
| Consensus des options | Deribit (collecteurs Oracle) | Omen 1×/h | ligne « le marché des options donne X % à BTC > N au JJ/MM » — **information, jamais un facteur ni un pari** (leçon Oracle : w* = −2,14) |
| Fear & Greed | alternative.me | Omen 1×/h | chip |
| Prime Coinbase | Coinbase spot − Binance mark | Omen 60 s | chip « demande US » |
| Gap CME | Yahoo `BTC=F` | Omen | ligne dessinée « gap ouvert à N » tant qu'il n'est pas comblé |
| Agenda crypto | calculé (§4.2 `btc.py`) + macro TradingView | Omen | badges `funding_soon`, `event_risk`, agenda |
| Flux ETF spot | titres Dow Jones / Cointelegraph via TV news | Omen | événement `watch` sur BTC-USD ; source dédiée plus tard si une réponde |
| Frais et sizing crypto | existants : niveau `crypto`, 2-3 % max, ≤ 2 cryptos | Omen | inchangé |

### 9.2 Facteurs de convergence ajoutés (déterministes, ids disjoints)
- `funding_extreme` : |funding| ≥ 0,05 % par 8 h pendant 2 règlements consécutifs.
- `oi_buildup` : intérêt ouvert +10 % en 24 h avec |Δ prix 24 h| < 1 %.
Ils comptent comme un facteur parmi les ≥ 2 exigés par `should_fire` ; ils ne tirent **jamais seuls** (seuls les `THREAT_FACTORS` le font).

### 9.3 Exclus, et pourquoi
Polymarket (bloqué en Suisse et liste noire des jeux d'argent ; lecture possible via le netfix d'Oracle mais sans valeur ajoutée prouvée) · cartes de liquidations (aucune source gratuite) · on-chain Glassnode (payant) · mempool.space (vivant mais sans lien démontré avec un scalp de 3 min ; gardé en réserve).

## 10. Sécurité et vie privée

- **Aucun mot de passe** ne transite par l'extension. Le token JWT (24 h) est obtenu d'une des deux façons : (a) sur omenserver.org connecté, `content-omen.js` propose un bouton « Connecter l'extension » qui copie `localStorage.omenserver_token` dans `chrome.storage.local` (clic explicite) ; (b) collage manuel dans les options. Expiré → bandeau « reconnecte-toi sur omenserver.org ».
- Appels réseau uniquement depuis `sw.js` (host_permissions), jamais depuis la page ; CORS backend inchangé.
- `bridge.js` ↔ `content.js` : `postMessage` avec `event.origin` vérifié et un nonce par session ; le pont n'exécute que des commandes de dessin typées, jamais de code.
- Tout texte injecté dans le panneau passe par un `esc()` ; pas d'`innerHTML` de contenu externe non échappé ; CSP d'extension par défaut (pas d'`eval`).
- Le serveur reste **autoritaire** : `precheck` et `scalps` recalculent ; un prix aberrant (±5 % de la cotation serveur) est refusé.
- WS `/ws/paper` : auth par premier message, fermeture 1008, 1 socket par onglet, 4 par utilisateur max.
- Sources externes : `User-Agent` explicite, budgets (TV news 60 req/min global, Binance 30/min, Deribit 10/min), backoff 429, `net_guard` sans objet (hôtes fixes).
- Données : `<user>.scalps.json` en 0o600 atomique comme les autres états ; rien de nouveau n'est partagé entre traders (les scalps sont privés comme les positions).

## 11. Gestion d'erreurs

- Titre non mappable → panneau « titre non suivi par l'Omen » avec bouton « ajouter aux favoris » (crée le mapping côté serveur via `quotes.canonical` + `SYMBOL_ALIASES`).
- Omen injoignable → panneau en mode dégradé : dernier `brief` en cache (horodaté), alertes live toujours évaluées sur les alertes en cache, ticket verrouillé (« serveur injoignable »).
- Source externe morte → champ `null` + chip grise « source muette depuis HH:MM » ; jamais une valeur périmée présentée comme fraîche.
- API TradingView absente (page changée) → le panneau fonctionne sans dessin ni bid/ask, avec bandeau « dessin indisponible » ; détection par test de présence à chaque changement de titre.
- Dessin refusé (non connecté ou A/B test) → bandeau « connecte-toi à TradingView pour le dessin » ; aucune répétition d'appel (1 essai par titre).
- WS coupé → reconnexion backoff ; pendant la coupure, sonde `brief` toutes les 60 s.
- Échec `POST /scalps` → le scalp est gardé en file locale (`chrome.storage`) et renvoyé au prochain succès ; jamais perdu, jamais dupliqué (id client `uuid`).

## 12. Tests

- **Backend** : pytest hors ligne, fixtures **réelles** capturées le 09/09 (réponses TradingView news/calendar, Binance, Deribit, F&G — à enregistrer dans `backend/bots/tests/fixtures/tv_*.json`, `btc_*.json`) ; chaque parseur testé sur vrai payload + payload cassé ; `precheck` par cas (chaque code) ; `scalps` : recalcul, refus ±5 %, cap 500, MAE/MFE ; WS : accept-puis-1008 vs 1011 (pattern discriminant documenté) ; convergence : facteurs BTC jamais seuls ; compteurs newswatch dans l'allowlist (test qui fige la forme complète de l'état).
- **Extension** : `node --test tools/tv-coach-extension/tests/` sur `symbols`, `guards`, `alerts`, `bars`, `ledger` (100 % pur) ; test de charge du `manifest.json` (JSON valide, world MAIN présent) ; `new Function(src)` sur chaque fichier **plus** un smoke qui charge réellement `content.js` avec un DOM stub (leçon : un parse ne résout aucun require).
- **Vérif connectée** (Fable, Chrome MCP) : extension chargée non empaquetée, page TradingView connectée, titre changé → fiche < 0,4 s, une alerte déclenchée sur prix live, un scalp ouvert/fermé et retrouvé dans `GET /scalps`, dessins posés puis effacés, 0 erreur console.
- Suite backend complète verte avant chaque push (4306 aujourd'hui, 1 flaky mc_agent connu).

## 13. Découpage en lots (ordre de livraison)

| Lot | Contenu | Dépend de |
|---|---|---|
| A | Squelette extension : manifest, pont MAIN, détection titre/intervalle, mapping symboles, token, panneau, `GET /brief` (v1 sans btc/ta) | — |
| B | `POST /precheck` + ticket simple (mode swing) + alertes live + `alerts/{id}/fire` | A |
| C | `tvnews.py` + `focus` + `tvcalendar.py` + WS `/ws/paper` + notifications | A |
| D | Mode scalp : `lib/bars`, garde-fous, ledger, `POST /scalps`, `review`, profils de frais | B |
| E | `btc.py` (chips, facteurs, gap CME, agenda crypto) + WS Binance en mode scalp | C, D |
| F | Dessin : niveaux, paris du coach, VWAP/H-L/gap, alerte au clic, watchlist import, i18n complète, mode clair | B, E |

Chaque lot = spec de mission → sous-agent (Sonnet pour A/B/C/F, Opus pour D/E) → contrôle Fable (diff lu, suites relancées, vérif connectée) → push `worktree-tv-coach-extension:main` avec `git fetch` + rebase préalables et bumps de cache si le frontend OmenServer est touché (aucun prévu en v1).

## 14. Hors périmètre v1
Capture d'écran au coach · scalps du coach lui-même (le coach reste swing, c'est un autre mandat) · exécution réelle chez un courtier · vue « Scalps » dans l'UI OmenServer (les scalps se lisent dans le journal et par `GET /scalps` ; une vue viendra si Massii la demande) · Firefox/Safari.

## 15. Risques assumés
Endpoints TradingView non documentés (peuvent changer ou se limiter : tout est isolé et replié) · usage personnel des données TradingView (pas de redistribution) · gate A/B des dessins · Python 3.9 sur le Mac (pas de `match`, pas de `X | Y`) · Yahoo différé 15 min pour les actions (le prix live vient de la page) · les probas d'options sont une copie du prix, jamais un edge.
