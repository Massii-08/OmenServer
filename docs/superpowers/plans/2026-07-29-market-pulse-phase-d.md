# Market Pulse phase D — plan d'implémentation

> Spec : `docs/superpowers/specs/2026-07-29-market-pulse-phase-d-design.md` (à lire en premier).
> Option A validée par Massii. Les phases A-C sont livrées, déployées et testées (139 tests moteur,
> 939 backend) — **ne rien refaire**.

## Ordre des tâches

Chaque tâche est TDD, hors ligne, `fetch`/`now`/`claude` injectés. La suite complète doit rester
verte à chaque étape : `cd market-pulse && <venv>/bin/python -m pytest tests -q` **et**
`<venv>/bin/python -m pytest backend -q`.

### 1. `pulse/exchanges.py` — le catalogue (aucune dépendance, pur)

```python
@dataclass(frozen=True)
class Exchange:
    id: str            # "milano"
    label: str         # "Borsa di Milano"   (italien)
    symbol: str        # "FTSEMIB.MI"        (doit exister dans DEFAULT_WATCHLIST)
    tz: str            # "Europe/Rome"
    opens_at: str      # "09:00"  heure LOCALE de la place
    feeds: List[dict]  # presse LOCALE, même forme que news.FEEDS
    reddit_subs: List[str]
    bluesky_queries: List[str]
```

Catalogue de départ : `milano`, `francoforte`, `parigi`, `londra`, `madrid`, `zurigo`,
`new_york`, `tokyo`, `hong_kong`. Presse locale par place ; pour Milan, réutiliser les flux déjà
vérifiés (Il Sole, ANSA, Google News IT) **plus** FinanzaOnline et Investing.com IT (sondés 200).

Tests : chaque `symbol` existe dans la watchlist · chaque `tz` est un ZoneInfo valide · chaque
`opens_at` passe `market_schedule.parse_time` · au moins un flux par bourse.

### 2. `pulse/news.py` — étendre aux sources sociales

Ajouter deux collecteurs, **même contrat de sortie** que `collect_news` :

- `fetch_reddit(subs, fetch, limit=100)` → `https://www.reddit.com/r/<a+b+c>/.rss?limit=<n>`.
  Parse Atom (le parseur existant gère déjà Atom). Le `<category term="...">` donne le sub.
  **Sur 429 : lire `x-ratelimit-reset`, réessayer UNE fois, puis abandonner** — jamais de boucle.
- `fetch_bluesky(queries, fetch)` → `https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=…`
  et `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=…`. httpx nu, sans compte.

⚠️ Les deux passent par `is_advice` **et** `is_offtopic` : la recherche Bluesky sur « borsa » a
ramené un fait divers sordide pendant la sonde. Les filtres existent déjà, il faut juste les câbler.

Fixtures : capturer une vraie réponse Reddit Atom et une vraie réponse Bluesky JSON.

### 3. `pulse/agenda.py` — les « prévisions » honnêtes

`upcoming_events(now_ts, horizon_h=48) -> List[dict]`. Sources v1 : le flux BCE déjà dans `FEEDS`
+ un fichier curé `data/market_pulse/agenda.json` (dates FOMC/BCE/ISTAT) facile à rafraîchir.
Chaque événement : `when`, `what` (italien), `at_stake` (ce qui bouge selon l'issue — **jamais
quelle issue**), `source_url`.

### 4. `pulse/briefing.py` — l'assembleur (pur)

`build_briefing(exchange, snapshot, news, agenda, now_ts) -> dict` (contrat en §4 de la spec).
La `comparison` liste les places **déjà ouvertes ou fermées ce jour-là** avant celle-ci : Asie
quand Milan ouvre, Europe quand New York ouvre. Purement dérivé de `clock.status` du snapshot.

### 5. `pulse/analyst.py` — l'étape LLM

`analyse(briefing, claude=_claude, model="claude-sonnet-5") -> dict`. Prompt contraint (§6 spec).
**Le garde-fou de sortie est obligatoire** : réutiliser la liste `FORBIDDEN` de
`tests/test_report.py` (l'extraire dans `sentiment.py` pour la partager) et **jeter** la synthèse
si un mot prescriptif apparaît → `{"text": None, "degraded": true, "reason": "..."}`.
Tests : LLM absent · LLM qui renvoie du JSON invalide · LLM qui dit « conviene comprare » → rejeté.

### 6. Backend — sélection + N jobs

- `data/market_pulse/watch.json` : `{"exchanges": ["milano","francoforte","new_york"]}`.
- `GET/POST /api/bots/market/exchanges` (lecture `admin`+`money`, écriture `admin`).
- `market_schedule.register_exchange_jobs(scheduler, run_fn, selection)` : un job par bourse à
  `opens_at − 15 min` dans le fuseau de la place, `timezone=` explicite, `misfire_grace_time`,
  `coalesce`. **Rattrapage par bourse** : `should_catch_up` prend déjà tout ce qu'il faut, il faut
  juste une date de dernier run **par bourse** (`meta.json` → `{"exchange": ..., "date": ...}`).
- `GET /api/bots/market/briefings` : les derniers briefings, un par bourse.

### 7. UI

Un bloc par bourse dans `market_module.js`, **tout sous le nom de la bourse** (demande explicite) :
état → indice → comparaison → agenda → notizie → synthèse. Plus un sélecteur (cases à cocher).
Clés i18n `market.*` à créer en FR/EN/IT. **Cache-bust** : bumper `market_module.js`, `lang.js`,
`index.html` et `CACHE_NAME` de `sw.js` — au-dessus des valeurs d'`origin/main` au moment du push.

## Pièges à ne pas re-découvrir

- **Ne JAMAIS sonder une URL versionnée avant que le déploiement soit arrivé** : ça met le 404 en
  cache Cloudflare contre cette URL exacte, et le déploiement réussi reste invisible (vécu le
  2026-07-28, cf. commit `5c8102f`).
- **Un 429 provoqué par soi-même ne prouve rien** — espacer ≥ 60 s avant de conclure.
- **Avant de publier une métrique dérivée d'un champ, mesurer que le champ VARIE** (cf. `^FTSE`,
  piège #67g).
- Les tests tournent en **Python 3.9** (Mac) même si la prod est en 3.14 → garder la compat 3.9.
- Zéro nouvelle dépendance : stdlib + httpx + curl_cffi + openpyxl.

## Definition of done

Depuis le dashboard, Massii coche 3 bourses ; chacune produit son briefing à son heure
d'ouverture, avec presse locale, agenda et synthèse italienne ; la synthèse tombe proprement en
version structurée si le LLM est indisponible ; aucun mot prescriptif ne peut sortir ; tests
verts ; vérifié en prod.
