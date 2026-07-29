# Market Pulse — phase D : briefing par bourse, déclenché à l'ouverture (design)

> Date : 2026-07-29 · Statut : cadrage validé par Massii (option A), sources vérifiées par sonde
> Suite des phases A (moteur), B (bot complet) et C (presse) — livrées le 2026-07-28.

## 1. Ce qui change

Les phases A-C produisent **un** rapport, à **une** heure (07:30 Rome), sur une liste
d'instruments **figée dans le code**. Massii veut autre chose :

> « je veux un système auquel je peux sélectionner quelle bourse je veux suivre dans une liste,
> et ça me donne (au moment de l'ouverture d'une de ces bourses) les comparaisons, les infos,
> les prévisions, des news passées/présentes/futures qui pourraient changer quelque chose […]
> tout converge vers une discussion avec toi […] et après tu donnes toutes ces infos en dessous
> du nom de la bourse que tu as analysée. »

Donc : **N bourses choisies par l'utilisateur**, **un briefing par bourse**, **déclenché à
l'ouverture de cette bourse**, avec presse **locale**, et une **étape d'analyse par le LLM**.

## 2. Décisions prises

| Question | Décision | Raison |
|---|---|---|
| « Prévisions » | **L'agenda des événements datés + ce qui est en jeu**, jamais une direction annoncée | Ligne rouge du projet depuis le spec d'origine, et contrainte de l'assistant. Un événement daté est un FAIT ; « la bourse va monter » n'en est pas un. |
| Destinataire | **Le grand-père surtout** | Registre simple, italien, aucun jargon. Le sélecteur sert à choisir ce qui l'intéresse. |
| Architecture | **Option A — étendre le moteur existant** | Le snapshot, l'horloge, les gaps, la presse et le rattrapage sont déjà écrits et testés (139 tests). B dupliquerait tout ; C (tout au LLM) violerait la doctrine « runtime déterministe ». |
| Nombre de bourses | **Défaut : 3 sélectionnées** (Milan, Francfort, New York), plafond 8 | Non tranché explicitement par Massii. 3 couvre son besoin réel et garde ≤ 8 appels LLM/jour. Modifiable dans l'UI. |

## 3. Sources sociales — le point où je m'étais trompé

J'avais annoncé « Reddit mort, X payant » **sur une seule requête**. Massii a contesté ; il avait
raison sur les deux. Mesures réelles du 2026-07-28/29, re-vérifiées à la main :

| Route | Résultat mesuré | Verdict |
|---|---|---|
| `reddit.com/r/<a+b+c…>/.rss?limit=100` | **200, 100 entrées, 8 subs, UNE requête** | ✅ **retenu** |
| `reddit.com/…/hot.json` (et old., api.) | 403 même en curl_cffi empreinte Chrome | ❌ fermé |
| `api.bsky.app/…/searchPosts` (Bluesky) | 200 en **httpx nu, sans compte**, rend de l'italien | ✅ **retenu** |
| `public.api.bsky.app/…/getAuthorFeed` | 200, fils des comptes de presse (Reuters…) | ✅ **retenu** |
| `x.com/<handle>` (payload SSR) | 200, 5 posts/appel, 16 requêtes d'affilée sans blocage | ⚠️ possible, non retenu en v1 |
| `syndication.twitter.com/srv/timeline-profile` | 429 dès la 1ʳᵉ requête | ❌ |
| Miroirs redlib/libreddit (8 instances) | 0 exploitable (challenge Anubis, 5xx) | ❌ |
| API OAuth Reddit | auto-inscription **fermée** depuis nov. 2025 | ❌ |
| `x.com/<handle>` — burst 8 req à 1 s | 200, **26 requêtes / 0 blocage** (httpx nu, IP résidentielle) | ⚠️ marche vraiment |
| Nitter (nitter.net) RSS | 200, 20 items datés — mais **3 autres instances mortes** (Anubis, 403, 400) | ⚠️ point unique de défaillance |
| `cdn.syndication.twimg.com/tweet-result` | 200 — et **n'importe quel token non vide suffit**, la valeur n'est pas vérifiée | ⚠️ enrichissement seulement |
| StockTwits `api.stocktwits.com` | **403 en httpx nu, 200 + 30 messages en curl_cffi** | ⚠️ exige l'empreinte Chrome |
| Hacker News Algolia | 200, 27 Ko, sans clé | ✅ appoint |
| **FinanzaOnline** `/feed` | 200, 20 Ko, 20 items — forum finance **italien** | ✅ **retenu** |
| **Investing.com IT** `/rss/news_25.rss` | 200 — presse **italienne** | ✅ **retenu** |
| Google Trends IT `/trending/rss?geo=IT` | 200, 22 Ko | ⚠️ tendances générales, peu de signal marché |
| GDELT DOC 2.0 | 429 à la re-sonde (quota partagé) | ⚠️ à espacer |

**Règles d'accès à coder** :
- Reddit : **1 requête/jour** suffit (100 posts). Plafond mesuré = 1 req/60 s par IP. Sur 429, lire
  `x-ratelimit-reset` et réessayer **une seule fois** — ne jamais boucler.
- ⚠️ **Un 429 provoqué par soi-même ne prouve rien.** J'ai conclu « mort » sur mon propre burst ;
  la sonde suivante, espacée, rendait 200. Toute sonde vers ces hôtes s'espace de ≥ 60 s.
- ⚠️ Si X est branché un jour, **trois pièges mesurés** : le post épinglé casse l'ordre
  chronologique (`posts[0]` n'est PAS le plus récent), le nombre de posts n'est pas toujours 5,
  et un autre `screen_name` peut apparaître dans la page → attribution **par post**. Et la
  recherche Nitter rend **200 avec un corps vide** : un parseur qui teste `status != 200` ne
  verrait rien et produirait un briefing silencieusement vide (piège #61 du dépôt).
- X reste **hors v1** : ça marche, mais c'est la route la plus susceptible de casser sans préavis,
  et Bluesky + Reddit couvrent déjà le besoin. Le fetcher restera pluggable.

## 4. Architecture (option A)

```
market-pulse/pulse/
├── exchanges.py     # NOUVEAU — catalogue des bourses (id, indice, tz, heure d'ouverture,
│                    #           presse LOCALE, subs Reddit, requêtes Bluesky)
├── agenda.py        # NOUVEAU — événements datés à venir (banques centrales + fichier curé)
├── briefing.py      # NOUVEAU — assemble LE briefing d'UNE bourse (pur, tout injecté)
├── analyst.py       # NOUVEAU — l'étape LLM (1 appel/bourse/jour), dégradation gracieuse
├── news.py          # ÉTENDU — collecte par jeu de flux (déjà paramétrable) + Reddit + Bluesky
├── snapshot.py clock.py gaps.py quotes.py fetcher.py report.py excel_out.py sentiment.py  # inchangés
```

**Contrat du briefing** (ce que consomment l'UI, le rapport et l'Excel) :

```json
{"exchange": "milano", "label": "Borsa di Milano", "opens_at": 1785310800,
 "index": { …une entrée de snapshot["markets"]… },
 "comparison": [ {"label": "Nikkei 225", "change_pct": -3.95, "state": "chiuso"} ],
 "agenda": [ {"when": "2026-07-30T14:15Z", "what": "BCE — decisione sui tassi",
              "at_stake": "…", "source_url": "…"} ],
 "news": { …contrat news.py… },
 "analysis": {"text": "…", "model": "claude-sonnet-5", "degraded": false},
 "generated_at": 1785310900}
```

## 5. Déclenchement

Un job APScheduler **par bourse sélectionnée**, calé sur `heure d'ouverture − 15 min` dans le
fuseau de la place. Réutilise `market_schedule` : mêmes garde-fous (`timezone=` explicite,
`misfire_grace_time`, `coalesce`) et **le même rattrapage `should_catch_up`, par bourse** — la
machine dort de 01:00 à 06:00, une ouverture asiatique tombe pendant son sommeil et doit être
rattrapée au réveil, ou explicitement marquée comme manquée.

## 6. L'étape LLM

Un appel par bourse et par jour via `_claude` (CLI sur l'abonnement, **aucune clé API**, déjà
utilisé par l'Upwork Sniper et le Harvester). Modèle : **Sonnet** — une synthèse factuelle n'a pas
besoin d'Opus et le quota est celui de Massii.

Le prompt est **contraint** : reformuler et relier les faits fournis, en italien simple ; interdit
d'ajouter un fait absent de l'entrée, d'annoncer une direction, de conseiller. Le garde-fou
existant (`FORBIDDEN` de `test_report.py`) est appliqué **à la sortie du LLM** : si un mot
prescriptif apparaît, la synthèse est **jetée** et le briefing sort en version structurée.

**Dégradation gracieuse** : sans LLM disponible, le briefing est publié tel quel. Le LLM embellit,
il ne conditionne rien.

## 7. Tests

Miroir de l'existant : tout pur et hors ligne, `fetch`/`now`/`claude` injectés, fixtures = réponses
réelles capturées (Reddit Atom, Bluesky JSON, flux locaux). Cas obligatoires : bourse sans presse
locale configurée, LLM indisponible, LLM qui produit un mot interdit, ouverture manquée pendant la
veille de la machine, source sociale en 429.

## 7bis. Correction d'environnement (vérifiée)

Le CLAUDE.md dit « Python 3.9 » — c'est vrai du **Mac de dev** (3.9.6, celui qui fait tourner les
tests) mais **faux de la prod** : le venv de l'Omen est en **Python 3.14.4** (httpx 0.28.1). On
**garde** la compatibilité 3.9 puisque la suite de tests s'exécute dessus, mais la raison à
retenir est « les tests tournent en 3.9 », pas « la prod est en 3.9 ».

## 8. Hors périmètre v1

X/Twitter · le calendrier macro complet (payant ou bloqué — on démarre aux banques centrales) ·
les dates de résultats d'entreprises · toute notion de portefeuille ou de position.
