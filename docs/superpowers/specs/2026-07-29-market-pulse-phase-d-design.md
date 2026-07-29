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

## 3bis. X sans payer — la recette exacte (dérivée et vérifiée à la main)

Une simple requête `GET https://x.com/<handle>` avec un **User-Agent de navigateur**, en `httpx`
nu, rend **200 et ~300 Ko de HTML contenant les 5 derniers posts**. Pas de clé, pas de compte, pas
de cookie, pas d'empreinte TLS (`curl_cffi` n'apporte rien ici). Mesuré le 2026-07-29 sur CNBC,
MarketWatch et Reuters : 5 posts chacun, le plus récent à **0,0 h** pour Reuters.

⚠️ **Le format n'est PAS du JSON**, et c'est là que j'ai perdu trois essais. C'est une
sérialisation Relay où **les clés ne sont pas entre guillemets** :

```
created_at_ms:1785309127000,display_text_range:$R[232]=[0,117],
self_thread_metadata:null,full_text:"Minister apologizes as Korean …"
```

Donc : `"full_text"` avec guillemets ne matche **rien**, et il n'y a pas de champ `created_at`
lisible — l'horodatage est `created_at_ms`, en **millisecondes**.

Recette qui marche :

```python
RE_TEXT = re.compile(r'full_text:"((?:[^"\\]|\\.)*)"')
RE_MS   = re.compile(r'created_at_ms:(\d{13})')
# apparier chaque texte au DERNIER created_at_ms qui le precede dans le HTML.
# Ne PAS tenter un motif unique englobant : display_text_range vaut $R[232]=[0,117],
# il CONTIENT une virgule et casse tout [^,]*.
```

Garde-fous obligatoires (les trois premiers viennent de la vérification adversariale, le
quatrième de mon propre échec) :
1. **Le post épinglé casse l'ordre** — trier par horodatage, ne jamais prendre `posts[0]`.
2. **Ce n'est pas toujours 5** posts ; ne rien coder en dur.
3. **Attribuer le compte par post**, pas par page (Reuters fait apparaître `ReutersBiz`).
4. **Alarmer si 0 post sur une page > 100 Ko** : c'est le signal que la sérialisation a changé.
   Sans cette alarme, le briefing sort silencieusement vide — piège #61 du dépôt.

**Volume et conditions.** Mesuré : 26 requêtes dans la journée, dont un burst à 1 s, **zéro 429**.
Le `robots.txt` de X met `Disallow: /` pour tout sauf Googlebot/Bingbot ; les CGU prévoient des
dommages forfaitaires **au-delà de 1 000 000 de posts par 24 h**. Notre usage cible — quelques
comptes de presse, une fois par ouverture de bourse, ~120 posts/jour — est à **quatre ordres de
grandeur** en dessous. Risque réel encouru : un blocage d'IP temporaire, rien d'autre (aucun compte
n'est utilisé, donc rien à bannir). L'API officielle, elle, coûte 0,005 $/post sans allocation
gratuite, soit ~18 $/mois pour le même volume.

**Reste hors v1** malgré tout : c'est la route la plus susceptible de changer sans préavis (la
sérialisation vient de me le prouver). Reddit + Bluesky couvrent le besoin ; X se branche en
ajoutant un collecteur, le contrat de `news.py` ne bouge pas.

## 3ter. Les dix places retenues (liste donnée par Massii) + le coffre de connaissance

Massii a fourni la liste : **NYSE · Nasdaq · JPX · Euronext · HKEX · SSE · LSE · NSE · SZSE ·
Deutsche Börse**. Ce sont des **opérateurs de marché**, pas des indices — ça change deux choses :

1. **Euronext regroupe SEPT pays** (Amsterdam, Paris, Bruxelles, Lisbonne, Dublin, **Milan**,
   Oslo). La bourse du grand-père est donc *dans* Euronext. Une entrée « Euronext » porte un
   indice large (`^N100`) **et** la liste de ses places, chacune avec son propre indice.
2. **Dix opérateurs ≠ dix déclencheurs.** Ils se regroupent en **sept ouvertures** :

| Ouverture (locale) | Opérateurs |
|---|---|
| 08:00 Europe/London | LSE |
| 09:00 CET | Euronext (7 places) + Deutsche Börse |
| 09:00 Asia/Tokyo | JPX |
| 09:15 Asia/Kolkata | NSE |
| 09:30 Asia/Shanghai | SSE + SZSE |
| 09:30 Asia/Hong_Kong | HKEX |
| 09:30 America/New_York | NYSE + Nasdaq |

Symboles **tous sondés OK le 2026-07-29** : `^NYA` `^IXIC` `^N225` `^N100` `^HSI` `000001.SS`
`^FTSE` `^NSEI` `399001.SZ` `^GDAXI` — et pour Euronext : `^AEX` `^FCHI` `^BFX` `PSI20.LS`
`^ISEQ` `FTSEMIB.MI` `OSEBX.OL`.

⚠️ **Pauses déjeuner** : JPX 11:30-12:30, HKEX 12:00-13:00, SSE/SZSE 11:30-13:00. Yahoo rend la
séance en UN bloc → afficher « aperto » pendant la pause serait faux. À traiter dans `clock.py`
(le champ existe déjà dans le catalogue).

### Le coffre Obsidian (`~/market-vault` sur l'Omen)

Demande de Massii : que je comprenne **mieux chaque jour** et que je **relie les places entre
elles**. Créé, avec un script rejouable (`tools/market_vault_init.py`) :

```
00 - Indice.md          point d'entrée, les 10 places, les thèmes
10 - Borse/             une note PERMANENTE par place — s'enrichit à chaque briefing
20 - Giornaliero/       une note par jour ET par place (le briefing)
30 - Temi/              8 pages transverses (inflazione, banche-centrali, semiconduttori…)
40 - Fonti/             santé des sources
90 - Meta/              les pièges de sources déjà mesurés
```

Le mécanisme qui rend ça utile : **chaque briefing quotidien pointe vers sa place et vers les
thèmes qu'il évoque**. Au bout de quelques semaines, ouvrir `[[semiconduttori]]` montre toutes
les fois où le sujet a touché une place — et laquelle a bougé en premier. C'est exactement le
lien entre bourses que Massii demande, et il se tisse tout seul, sans que rien ait à le calculer.

La phase D doit donc, à la fin de chaque briefing, **écrire sa note dans `20 - Giornaliero/`**
avec ses wikilinks. C'est une tâche supplémentaire du plan.

## 3quater. Suivi de TITRES individuels (demande Massii : « Nike = graphique, news, prévision »)

L'utilisateur coche des actions rattachées à une place ; à l'ouverture de cette place, chaque titre
suivi apparaît sous le nom de la bourse avec son cours, ses news et son agenda daté.

**Le graphique ne coûte RIEN à construire** : le moteur existant marche déjà tel quel sur les
actions. Sondé le 2026-07-29, cours + variation + gap + devise obtenus sur les 8 places :

| Titre | Symbole | Place | Cours | Var. |
|---|---|---|---|---|
| Nike | `NKE` | NYSE | 42,78 USD | +1,53 % |
| Ferrari | `RACE.MI` | Euronext Milan | 339,80 EUR | -0,45 % |
| ASML | `ASML.AS` | Euronext Amsterdam | 1 362,20 EUR | -1,89 % |
| SAP | `SAP.DE` | Deutsche Börse | 162,04 EUR | +1,76 % |
| Toyota | `7203.T` | JPX | 3 224 JPY | +7,18 % |
| Tencent | `0700.HK` | HKEX | 466,40 HKD | +4,29 % |
| Shell | `SHEL.L` | LSE | 3 323,50 **GBp** | +2,75 % |
| Reliance | `RELIANCE.NS` | NSE | 1 275,90 INR | +0,65 % |

⚠️ **Shell cote en GBp (pence), pas en GBP** : 3 323,50 GBp = 33,24 £. Afficher
« 3 323,50 £ » serait faux d'un facteur 100. La devise rendue par Yahoo doit être affichée telle
quelle, et le formateur doit connaître ce cas.

**Recherche par nom** — `query1.finance.yahoo.com/v1/finance/search?q=<texte>` répond 200 en
curl_cffi, sans clé, et rend symbole + nom + **code d'échange** (NYQ, NMS, MIL, AMS, FRA, WSE...),
ce qui rattache automatiquement le titre à l'un des dix opérateurs.
⚠️ **Multi-cotation** : « ferrari » rend `RACE` (NYQ) *et* `RACE.MI` (MIL) ; « asml » rend
`ASML` (NMS) *et* `ASML.AS` (AMS). Règle retenue : **on garde la cotation de la place que
l'utilisateur suit** — c'est elle qui ouvre, c'est son cours qui l'intéresse.

**News par titre — le piège, mesuré.** `feeds.finance.yahoo.com/rss/2.0/headline?s=<SYM>` répond
**200 en curl_cffi (429 en httpx nu)**, 20 items frais (2-4 h), et couvre les titres non-US. MAIS
c'est un flux **sectoriel**, pas un flux d'entreprise :

| Symbole | Titres citant vraiment la société |
|---|---|
| `NKE` | 15/20 (75 %) |
| `RACE.MI` | 11/20 (55 %) |
| `7203.T` | 10/20 (50 %) |
| `ASML.AS` | **8/20 (40 %)** |

Sous l'entrée « Nike », le flux proposait en tête « VF Shares Tumble... » ; sous ASML,
« Microsoft's Earnings... ». Publier ça tel quel ferait croire au lecteur que la news concerne
son titre. **Parade obligatoire** : ne garder que les titres qui mentionnent le nom de la société
ou son ticker — il en reste 8 à 15, largement assez. Même geste que les filtres déjà écrits
dans `sentiment.py`.

**L'agenda du titre** (prochains résultats, détachement de dividende) est la seule pièce non encore
sourcée : recherche en cours. La ligne rouge s'applique à l'identique — une **date** de
publication est un fait ; un **objectif de cours d'analyste** est une recommandation et reste hors
périmètre.

Côté coffre : un dossier `15 - Titoli/` avec une note permanente par titre suivi, liée à sa place
et aux thèmes. Ferrari pointera vers `[[Euronext]]` et `[[utili-societari]]`.

## 3quinquies. L'agenda d'un titre — RESOLU (la piece qui manquait)

C'etait le seul trou du dispositif. Il est comble, et par une source primaire.

**La route** : `quoteSummary` de Yahoo, module `calendarEvents`, derriere une danse
cookie + crumb :

```
1) GET https://fc.yahoo.com                                   -> pose le cookie (404, normal)
2) GET https://query1.finance.yahoo.com/v1/test/getcrumb      -> rend le crumb (11 car.)
3) GET https://query1.finance.yahoo.com/v10/finance/quoteSummary/<SYM>
       ?modules=calendarEvents&crumb=<CRUMB>
```

**curl_cffi est OBLIGATOIRE** : test discriminant a 6 s d'ecart sur la meme IP, httpx avec un UA
Chrome rend 429, curl_cffi impersonate=chrome rend 200. Ce n'est donc pas une limite d'IP ni un
429 auto-inflige : c'est bien l'empreinte TLS.

Cout : **2 requetes d'amorcage + 1 par symbole**. Le couple (cookie, crumb) est reutilisable et
persistable sur disque. Un crumb perime avec un cookie neuf rend 401 « Invalid Crumb » -> les
deux se rejouent ensemble.

**Verifie a la main le 2026-07-29, 8/8 symboles en 200** :

| Titre | Symbole | Prochains resultats | Statut | Ex-dividende |
|---|---|---|---|---|
| Ferrari | `RACE.MI` | 30/07/2026 | confirmee | 20/04/2026 |
| ASML | `ASML.AS` | 14/10/2026 | confirmee | 27/07/2026 |
| SAP | `SAP.DE` | 21/10/2026 | confirmee | 06/05/2026 |
| Toyota | `7203.T` | 04/08/2026 | confirmee | 29/09/2026 |
| Tencent | `0700.HK` | 12/08/2026 | confirmee | 15/05/2026 |
| Shell | `SHEL.L` | 30/07/2026 | confirmee | 21/05/2026 |
| Nike | `NKE` | 29/09/2026 | **estimee** | 01/06/2026 |
| Nestle | `NESN.SW` | — | aucune | 20/04/2026 |

**Couverture europeenne native** — c'est ce qui decide de l'utilite : ca marche sur `.MI`, `.AS`,
`.PA`, `.DE`, `.L`, `.SW`, `.HK`, `.T`, pas seulement sur les ADR americains.

### Deux garde-fous OBLIGATOIRES

**1. La date rendue peut etre DEJA PASSEE.** Yahoo rend la date la plus proche, sans basculer
immediatement vers la suivante. Mesure du 2026-07-29 : `VOW3.DE` rendait le 24/07 (5 jours plus
tot), `MC.PA` le 27/07. Sans filtre, le briefing annoncerait « prochains resultats le 27 juillet »
un 29 juillet. Trois etats a distinguer :

- date >= aujourd'hui et `isEarningsDateEstimate = false` -> **confirmee**
- date >= aujourd'hui et `isEarningsDateEstimate = true`  -> **estimee** (le dire)
- date < aujourd'hui -> **pas encore annoncee** : c'est la DERNIERE publication, ne jamais
  l'afficher comme prochaine.

C'est le piege « HTTP 200 ne prouve pas la fraicheur » applique a un champ de date au lieu d'un
flux — la meme famille que le FTSE et le Nikkei.

**2. Le meme bloc contient des PREVISIONS d'analystes.** Verifie : `currentQuarterEstimate`,
`earningsAverage`, `earningsLow`, `earningsHigh`, `revenueAverage`. Ce sont des consensus
d'analystes, c'est-a-dire exactement ce que le projet s'interdit. **A jeter au parsing**, jamais
au lecteur. Un test doit verrouiller que ces cles ne peuvent pas atteindre le briefing.

### Complements

- **Montant du dividende, gratuitement** : ajouter `&events=div%2Csplit` a l'appel chart qu'on
  fait DEJA rend l'historique des detachements avec le montant par action — zero requete de plus.
  En revanche aucun bloc `earnings` n'y figure, meme en le demandant.
- **Avant ou apres la seance** : `api.nasdaq.com/api/analyst/<SYM>/earnings-date` le donne
  (« BEFORE MARKET OPEN » / « AFTER MARKET CLOSE »), en httpx nu avec un UA — information qui
  n'existe nulle part ailleurs gratuitement, et tres utile pour un briefing d'OUVERTURE.
  ⚠️ US-listed uniquement, et son `reportText` contient un consensus EPS : n'extraire que la date
  et le creneau, jeter la phrase.

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
