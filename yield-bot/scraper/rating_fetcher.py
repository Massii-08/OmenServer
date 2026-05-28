"""
Rating fetcher multi-sources pour le Yield Bot.

⚠️ ÉTAT : framework en place, sources gratuites toutes bloquées au moment
de l'écriture (2026-05-28). Désactivé par défaut côté yield_bot.py.
Voir investigation dans Obsidian : 90 - Concepts transverses/🌐 Scraping
Deutsche Börse.md (section "Rating sources publiques — toutes verrouillées").

Contexte : Deutsche Börse n'expose pas toujours le rating des bonds dans son
JSON (surtout pour les corporates US comme Dominion, Stryker, IBM, etc.).
Ce module est conçu pour récupérer le rating depuis d'autres sources avec
une stratégie de fallback.

Sources interrogées dans cet ordre :
1. Fitch via Scrapling/Camoufox (stealth bypass Cloudflare)
   ❌ Cloudflare détecte Camoufox, JS uncaught error crash rebrowser-playwright
   (bug coreBundle.js:49624 pageError.location.url undefined)
2. DuckDuckGo HTML search → parse titres news cbonds.com/investing.com
   ❌ html.duckduckgo.com retourne status 202 + sa homepage JS (pas les
   résultats HTML statiques attendus). Idem lite.duckduckgo.com.
3. SEC EDGAR full-text search sur les filings FWP/424B (bonds US)
   ⚠️ L'API search-index fonctionne et retourne des hits par ISIN, mais
   construire l'URL du filing document et parser son contenu pour extraire
   le rating est non-trivial — à finaliser dans une prochaine itération.

Plan prochaine itération (cf. daily 2026-05-28) :
- Intégrer FinnHub free tier (60 calls/min, ratings inclus, API key gratuite)
- OU finaliser SEC EDGAR : construire l'URL du filing primary doc via
  l'index JSON `<adsh>/index.json`, fetch le doc, parser "Expected Ratings: ..."
  qui apparaît en plein texte dans les FWP/424B.

Retour : (rating, agency) où rating est en notation Fitch/S&P (ex: "BBB+").
Les ratings Moody's sont convertis automatiquement (Baa1 → BBB+ etc.).

Cache : ~/.cache/yield-bot-ratings.json avec TTL 30 jours par ISIN.
Les ratings changent rarement → cache long évite de spammer les sources.

Usage (quand des sources marcheront) :
    from scraper.rating_fetcher import RatingFetcher
    fetcher = RatingFetcher()
    rating, agency = fetcher.fetch_rating("US25746UCY38", "Dominion Energy")
    # → ("BBB+", "Fitch")
"""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import date, timedelta
from pathlib import Path
from typing import Optional, Tuple
from urllib.parse import quote_plus

logger = logging.getLogger(__name__)


# ============================================================================
#  CONVERSIONS RATING
# ============================================================================

# Moody's long-term → Fitch/S&P notation
# Source : Wikipedia "Bond credit rating"
MOODYS_TO_SP = {
    'aaa': 'AAA',
    'aa1': 'AA+', 'aa2': 'AA', 'aa3': 'AA-',
    'a1': 'A+',  'a2': 'A',  'a3': 'A-',
    'baa1': 'BBB+', 'baa2': 'BBB', 'baa3': 'BBB-',
    'ba1': 'BB+', 'ba2': 'BB', 'ba3': 'BB-',
    'b1': 'B+',  'b2': 'B',  'b3': 'B-',
    'caa1': 'CCC+', 'caa2': 'CCC', 'caa3': 'CCC-',
    'ca': 'CC', 'c': 'C',
}

# Set of valid Fitch/S&P ratings (sans modificateur "u", "*-", etc.)
VALID_SP_RATINGS = {
    'AAA', 'AA+', 'AA', 'AA-',
    'A+', 'A', 'A-',
    'BBB+', 'BBB', 'BBB-',
    'BB+', 'BB', 'BB-',
    'B+', 'B', 'B-',
    'CCC+', 'CCC', 'CCC-',
    'CC', 'C', 'D',
}


def normalize_rating(raw: str) -> Optional[str]:
    """
    Normalise un rating en notation Fitch/S&P standard.

    Exemples :
        "BBB+" → "BBB+"
        "Baa1" → "BBB+" (conversion Moody's)
        "A1"   → "A+"   (Moody's, pas "A1" Fitch)
        "junk" → None
    """
    if not raw:
        return None
    cleaned = raw.strip().strip("'\"`").replace(' ', '')
    if not cleaned:
        return None

    # Tentative Moody's (case insensitive)
    moodys = MOODYS_TO_SP.get(cleaned.lower())
    if moodys:
        return moodys

    # Tentative Fitch/S&P direct
    upper = cleaned.upper()
    if upper in VALID_SP_RATINGS:
        return upper

    return None


# ============================================================================
#  REGEX PARSING (pour les titres news cbonds/investing)
# ============================================================================

# Match : "Fitch Ratings affirms IBM at 'A-' (LT Int. Scale...)"
# Match : "Moody's upgrades Stryker Corporation to A3"
# Match : "S&P Global Ratings affirms Stryker at 'BBB+' (Foreign Currency LT...)"
#
# Notes :
# - Les alternatives sont ordonnées du plus long au plus court pour éviter
#   le piège classique : `A[+-]?` matche "A" sur "A-" (le `?` cause un
#   backtrack quand la contrainte trailing ne tient pas). On force "A+"/"A-"
#   AVANT "A" pour que le moteur essaye d'abord la version la plus longue.
# - Pas de `\b` en trailing : ça échoue quand le rating finit par `-` (qui
#   est non-word) et est suivi de `'` (aussi non-word) → pas de boundary.
#   On utilise un lookahead positif sur la ponctuation/whitespace usuelle.
AGENCY_RATING_RE = re.compile(
    r"(?P<agency>Fitch|S\s*&\s*P|Standard\s*&\s*Poor['’]s|Moody['’]s)"
    r".{0,150}?"  # tampon entre agency et verbe — autorise "Inc." et autres périodes
    r"\b(?:to|at|of)\s+['\"’“”]?"
    r"(?P<rating>"
    # Fitch/S&P avec modificateurs explicites en premier (longest match)
    r"AAA|AA\+|AA-|AA|A\+|A-"
    r"|BBB\+|BBB-|BBB|BB\+|BB-|BB|B\+|B-"
    r"|CCC\+|CCC-|CCC|CC|D"
    # Moody's avec chiffres (toujours 2-3 chars, pas d'ambiguïté)
    r"|Aaa|Aa[123]|A[123]|Baa[123]|Ba[123]|B[123]|Caa[123]|Ca"
    # Bare letters en dernier recours (peu utilisé pour les corporates)
    r"|A|B|C"
    r")"
    r"['\"’“”]?"
    r"(?=[\s\(\)\.,;:\]/]|$|\s*outlook|\s*stable|\s*positive|\s*negative)",
    re.IGNORECASE
)


# Regex simple pour les TITRES de pages Fitch direct (site:fitchratings.com).
# Les formats observés :
#   "Fitch Affirms IBM's IDR at 'A-'; Outlook Stable"
#   "Fitch Rates Dominion Energy's Senior Notes 'BBB+'"
#   "Fitch Upgrades Broadcom to 'BBB+'; Outlook Positive"
#   "Fitch Upgrades AstraZeneca to 'A'; Outlook Positive"
#
# Le rating apparaît TOUJOURS entre quotes (simples ou doubles, droites ou
# courbes). On se contente de chercher la 1ère occurrence quote+rating+quote
# car le titre Fitch est court et contient au plus 1 rating.
FITCH_TITLE_RATING_RE = re.compile(
    r"['\"’“”]"
    r"(?P<rating>"
    r"AAA|AA\+|AA-|AA|A\+|A-"
    r"|BBB\+|BBB-|BBB|BB\+|BB-|BB|B\+|B-"
    r"|CCC\+|CCC-|CCC|CC|D"
    r"|A|B|C"
    r")"
    r"['\"’“”]"
)


def parse_rating_from_text(text: str) -> Tuple[Optional[str], Optional[str]]:
    """
    Cherche un pattern '<Agency> <verb> <Issuer> at <Rating>' dans un texte.

    Returns (rating_normalisé, agency) ou (None, None).
    """
    if not text:
        return None, None

    match = AGENCY_RATING_RE.search(text)
    if not match:
        return None, None

    agency_raw = match.group('agency').lower()
    rating_raw = match.group('rating')

    if 'fitch' in agency_raw:
        agency = 'Fitch'
    elif 'moody' in agency_raw:
        agency = "Moody's"
    else:
        agency = 'S&P'

    rating = normalize_rating(rating_raw)
    if not rating:
        return None, None

    return rating, agency


# ============================================================================
#  CACHE
# ============================================================================

CACHE_PATH = Path.home() / '.cache' / 'yield-bot-ratings.json'
CACHE_TTL = timedelta(days=30)


class _Cache:
    def __init__(self, path: Path = CACHE_PATH):
        self.path = path
        self._data: dict = {}
        self._load()

    def _load(self):
        try:
            self._data = json.loads(self.path.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            self._data = {}

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self._data, indent=2, sort_keys=True))

    def get(self, isin: str) -> Optional[dict]:
        entry = self._data.get(isin)
        if not entry:
            return None
        try:
            cached_date = date.fromisoformat(entry.get('date', ''))
        except ValueError:
            return None
        if date.today() - cached_date > CACHE_TTL:
            return None
        return entry

    def set(self, isin: str, rating: str, agency: str, source: str):
        self._data[isin] = {
            'rating': rating,
            'agency': agency,
            'source': source,
            'date': date.today().isoformat(),
        }
        self._save()


# ============================================================================
#  FETCHER PRINCIPAL
# ============================================================================

class RatingFetcher:
    """
    Récupère le rating d'un bond en essayant plusieurs sources avec fallback.
    """

    def __init__(
        self,
        prefer_fitch: bool = True,
        use_camoufox: bool = True,
        fitch_only: bool = False,
        brave_api_key: Optional[str] = None,
    ):
        """
        Args:
            prefer_fitch: Si True, essaie Fitch en premier. Sinon part direct
                          sur les sources fallback (news/SEC).
            use_camoufox: Si True, utilise Scrapling/Camoufox pour Fitch.
                          Mettre False pour skip si Camoufox est cassé.
            fitch_only: Si True, n'accepte QUE les ratings parsés comme Fitch.
                        Les S&P/Moody's matchés dans les snippets sont ignorés.
                        Utilisé par yield_bot pour ne pas polluer l'Excel avec
                        des ratings autres que Fitch sans validation manuelle.
            brave_api_key: Clé Brave Search API. Si None, lookup auto via env
                           var BRAVE_SEARCH_API_KEY. Si absente partout, Brave
                           Search est skip (pas d'erreur).
        """
        self.prefer_fitch = prefer_fitch
        self.use_camoufox = use_camoufox
        self.fitch_only = fitch_only
        self.brave_api_key = brave_api_key or os.environ.get('BRAVE_SEARCH_API_KEY')
        self.cache = _Cache()

    def fetch_rating(
        self,
        isin: str,
        issuer: str,
    ) -> Tuple[Optional[str], Optional[str]]:
        """
        Récupère un rating pour un bond.

        Args:
            isin: Code ISIN
            issuer: Nom de l'émetteur (ex: "Dominion Energy Inc.")

        Returns:
            (rating, agency) en notation Fitch/S&P, ou (None, None) si rien
            n'a été trouvé.
        """
        if not isin or not issuer:
            return None, None

        # Cache hit ?
        cached = self.cache.get(isin)
        if cached:
            logger.info(
                f"  📦 Rating cached: {isin} → {cached['rating']} "
                f"({cached['agency']} via {cached['source']})"
            )
            return cached['rating'], cached['agency']

        # Ordre des sources : Brave en premier si clé dispo (le plus fiable),
        # puis Fitch direct (Camoufox), puis DDG news, puis SEC EDGAR.
        sources = []
        if self.brave_api_key:
            sources.append(('Brave Search', self._try_brave_search))
        if self.prefer_fitch and self.use_camoufox:
            sources.append(('Fitch+Camoufox', self._try_fitch_camoufox))
        sources.append(('DuckDuckGo+news', self._try_ddg_news))
        sources.append(('SEC EDGAR', self._try_sec_edgar))

        for source_name, source_fn in sources:
            try:
                result = source_fn(isin, issuer)
                if result and result[0]:
                    rating, agency = result

                    # Mode fitch_only : on n'accepte QUE les ratings dont l'agency
                    # parsée est "Fitch". Les S&P/Moody's matchés sont rejetés
                    # silencieusement → on tente la source suivante.
                    if self.fitch_only and agency != 'Fitch':
                        logger.debug(
                            f"  ⊘ {source_name} a trouvé {rating} ({agency}) "
                            f"mais fitch_only=True → skip"
                        )
                        continue

                    logger.info(
                        f"  ✏️  Rating {isin} ({issuer}): {rating} "
                        f"({agency}) via {source_name}"
                    )
                    self.cache.set(isin, rating, agency, source_name)
                    return rating, agency
            except Exception as e:
                logger.debug(f"  ⚠️  Source {source_name} échec: {e!r}")
                continue

        logger.warning(f"  ❓ Aucun rating trouvé pour {isin} ({issuer})")
        return None, None

    # ------------------------------------------------------------------
    #  Source 0 : Brave Search API ciblée site:fitchratings.com
    # ------------------------------------------------------------------
    #
    #  Stratégie décidée 2026-05-28 (cf. daily note) :
    #  - Source UNIQUE = fitchratings.com (autoritative, pas de news
    #    intermédiaire qui peut être désactualisée)
    #  - On ne SCRAPE pas le site (bloqué par Cloudflare + crash Camoufox).
    #    On lit l'index Brave qui a déjà aspiré les pages Fitch publiques.
    #  - Le rating est dans le TITLE des pages Fitch, entre quotes :
    #      "Fitch Affirms IBM's IDR at 'A-'; Outlook Stable"
    #      "Fitch Upgrades Broadcom to 'BBB+'; Outlook Positive"
    #      "Fitch Rates Dominion Energy's Senior Notes 'BBB+'"
    #  - Si Fitch ne rate pas l'issuer → 0 hits dans la SERP → on retourne
    #    (None, None) → la cellule Excel reste intacte (politique fitch_only).
    #
    def _try_brave_search(
        self, isin: str, issuer: str
    ) -> Tuple[Optional[str], Optional[str]]:
        """
        Cherche le rating Fitch d'un issuer en restreignant Brave Search au
        domaine fitchratings.com.
        Retourne (rating, "Fitch") ou (None, None).
        """
        if not self.brave_api_key:
            return None, None
        try:
            import httpx
        except ImportError:
            logger.debug("  ⚠️  httpx non dispo, skip Brave Search")
            return None, None

        # Strip UNIQUEMENT les suffixes corporate purement légaux.
        # On NE strip PAS "Worldwide", "Finance", "Holdings", "Capital" car
        # ils peuvent distinguer 2 entités différentes :
        #   - "Hilton Worldwide" (corporate hôtelier) vs "Hilton Grand
        #     Vacations" (timeshare spin-off, rating différent)
        #   - "AstraZeneca Finance LLC" vs "AstraZeneca PLC" (parent)
        # Mieux vaut un ∅ qu'un faux rating.
        issuer_short = issuer
        for suffix in (
            ' Inc.', ' Inc', ' Corporation', ' Corp.', ' Corp',
            ' LLC', ' PLC', ' Plc', ' Ltd.', ' Ltd',
            ' SA', ' AG', ' NV', ' GmbH', ' SpA',
        ):
            if issuer_short.endswith(suffix):
                issuer_short = issuer_short[: -len(suffix)].strip()
                break  # un seul strip suffit

        query = f'site:fitchratings.com {issuer_short}'
        headers = {
            'X-Subscription-Token': self.brave_api_key,
            'Accept': 'application/json',
        }
        params = {
            'q': query,
            'count': 10,
            'result_filter': 'web',
        }

        try:
            r = httpx.get(
                'https://api.search.brave.com/res/v1/web/search',
                headers=headers, params=params, timeout=15,
            )
        except Exception as e:
            logger.debug(f"  ⚠️  Brave Search fetch error: {e!r}")
            return None, None

        if r.status_code == 429:
            logger.warning(
                "  ⚠️  Brave Search rate-limited (429). "
                "Plan free = 1 req/sec — ralentir si batch."
            )
            return None, None
        if r.status_code != 200:
            logger.debug(
                f"  ⚠️  Brave Search status={r.status_code} "
                f"body={r.text[:200]}"
            )
            return None, None

        try:
            data = r.json()
        except Exception:
            return None, None

        results = data.get('web', {}).get('results', []) or []
        if not results:
            logger.debug(f"  Brave: 0 hit pour {query!r}")
            return None, None

        # Scoring des hits Fitch :
        #  +2 : title contient un verbe de rating principal Issuer
        #       (Upgrades/Downgrades/Affirms) OU "IDR" (Issuer Default Rating)
        #   0 : title contient "Senior Notes" / "Junior" / "Sub Notes"
        #       (rating d'émission spécifique, accepté en fallback)
        HIGH_PREF = ('upgrades', 'downgrades', 'affirms', 'idr',
                     'credit ratings')
        ISSUE_SPECIFIC = ('senior notes', 'junior', 'sub notes',
                          'convertible', 'subordinated')
        # REJECT : structures de securitisation et autres véhicules qui
        # n'ont rien à voir avec le bond corporate sous-jacent. Vu sur
        # "Hilton Grand Vacations Trust 2026-1" (ABS timeshare).
        REJECT = ('trust', 'grand vacations', 'abs', 'rmbs', 'cmbs',
                  'presale', 'covered bond', 'mortgage', 'clo', 'spv')

        best: Optional[Tuple[int, str, str]] = None  # (score, rating, url)

        for res in results:
            url = res.get('url', '') or ''
            if 'fitchratings.com' not in url.lower():
                continue  # garde-fou — Brave devrait ne renvoyer que ce site
            title = res.get('title', '') or ''
            title_lower = title.lower()

            # Le mot "Fitch" doit apparaître dans le titre — sinon c'est
            # probablement une page entity sans action de rating récente.
            if 'fitch' not in title_lower:
                continue

            # Rejet : structures de securitisation (Trust/ABS/...) — leur
            # rating n'a aucun rapport avec un bond corporate.
            if any(kw in title_lower for kw in REJECT):
                logger.debug(
                    f"  ⊘ Reject (securitisation): {title[:80]!r}"
                )
                continue

            m = FITCH_TITLE_RATING_RE.search(title)
            if not m:
                continue

            rating = normalize_rating(m.group('rating'))
            if not rating:
                continue

            score = 0
            if any(kw in title_lower for kw in HIGH_PREF):
                score += 2
            if any(kw in title_lower for kw in ISSUE_SPECIFIC):
                # On accepte mais on préfère un hit Issuer
                score -= 0  # neutre — meilleur que rien
            else:
                # Pas de mot-clé d'émission → c'est probablement le rating
                # Issuer si HIGH_PREF présent
                pass

            logger.debug(
                f"  · score={score:+d} rating={rating} title={title[:80]!r}"
            )

            if best is None or score > best[0]:
                best = (score, rating, url)

        if best:
            _score, rating, hit_url = best
            logger.debug(f"  ✓ Brave Fitch hit: {rating} via {hit_url}")
            return rating, 'Fitch'

        return None, None

    # ------------------------------------------------------------------
    #  Source 1 : Fitch direct via Scrapling/Camoufox
    # ------------------------------------------------------------------
    def _try_fitch_camoufox(
        self, isin: str, issuer: str
    ) -> Tuple[Optional[str], Optional[str]]:
        """
        Scrape fitchratings.com via StealthyFetcher (Camoufox).
        Fitch indexe par émetteur, pas par ISIN → on cherche par nom.
        """
        try:
            from scrapling import StealthyFetcher
        except ImportError:
            logger.debug("  ⚠️  Scrapling non installé, skip Fitch direct")
            return None, None

        fetcher = StealthyFetcher(auto_match=False)
        search_url = (
            f"https://www.fitchratings.com/search"
            f"?expanded=research&query={quote_plus(issuer)}"
        )

        try:
            page = fetcher.fetch(
                search_url, headless=True, network_idle=True,
            )
        except Exception as e:
            logger.debug(f"  ⚠️  Camoufox fetch error: {e!r}")
            return None, None

        if page.status != 200:
            logger.debug(f"  ⚠️  Fitch search status={page.status}")
            return None, None

        body = page.body or ''
        if 'Just a moment' in body or 'cf-chl-bypass' in body:
            logger.debug("  ⚠️  Cloudflare challenge non bypassé sur Fitch")
            return None, None

        # Parse les résultats : chercher un lien vers /entity/<slug>
        # et essayer d'extraire le rating depuis la fiche.
        # NOTE : la vraie structure HTML peut varier — TODO valider après
        # premier run réussi.
        entity_links = page.css('a[href*="/entity/"]::attr(href)')
        if not entity_links:
            logger.debug("  ⚠️  Aucun lien entity dans la SERP Fitch")
            return None, None

        # On prend le premier lien — il faudrait idéalement vérifier que
        # le nom match l'issuer, mais pour un MVP on accepte le top result.
        entity_path = entity_links[0]
        if not entity_path.startswith('http'):
            entity_url = f"https://www.fitchratings.com{entity_path}"
        else:
            entity_url = entity_path

        try:
            entity_page = fetcher.fetch(
                entity_url, headless=True, network_idle=True,
            )
        except Exception as e:
            logger.debug(f"  ⚠️  Fitch entity page error: {e!r}")
            return None, None

        if entity_page.status != 200:
            return None, None

        # Parse le rating depuis le texte de la page entity.
        # Le format typique sur Fitch : "Long-Term Issuer Default Rating: BBB+"
        # ou table avec colonne "Rating" et valeur "BBB+ Stable".
        text = entity_page.body or ''
        rating, _agency = parse_rating_from_text(text)
        if rating:
            return rating, 'Fitch'
        return None, None

    # ------------------------------------------------------------------
    #  Source 2 : DuckDuckGo HTML search
    # ------------------------------------------------------------------
    def _try_ddg_news(
        self, isin: str, issuer: str
    ) -> Tuple[Optional[str], Optional[str]]:
        """
        Cherche sur DuckDuckGo HTML les actualités récentes de rating.
        DDG ne nécessite pas de stealth — Scrapling.Fetcher (HTTP simple) suffit.
        """
        try:
            from scrapling import Fetcher
        except ImportError:
            logger.debug("  ⚠️  Scrapling non installé, skip DDG")
            return None, None

        # Query optimisée pour faire matcher les titres cbonds.com/investing.com
        query = f'"{issuer}" Fitch OR "S&P" OR "Moody" rating'
        url = f"https://html.duckduckgo.com/html/?q={quote_plus(query)}"

        try:
            page = Fetcher.get(url, timeout=15)
        except Exception as e:
            logger.debug(f"  ⚠️  DDG fetch error: {e!r}")
            return None, None

        if page.status != 200:
            return None, None

        # DDG HTML retourne des <a class="result__a">title</a> + <a class="result__snippet">
        # On collecte tous les titres + snippets et on parse.
        titles = page.css('a.result__a::text') or []
        snippets = page.css('a.result__snippet::text') or []
        urls = page.css('a.result__a::attr(href)') or []

        # Préfère les résultats provenant de sources de confiance
        TRUSTED = ('cbonds.com', 'investing.com', 'reuters.com',
                   'spglobal.com', 'fitchratings.com', 'streetinsider.com')

        # Ordre : trusted d'abord, puis les autres
        candidates = []
        for i in range(min(len(titles), 20)):
            combined = f"{titles[i]} {snippets[i] if i < len(snippets) else ''}"
            href = urls[i] if i < len(urls) else ''
            score = 1 if any(t in href.lower() for t in TRUSTED) else 0
            candidates.append((score, combined, href))
        candidates.sort(key=lambda x: -x[0])

        # Préférence d'agence : Fitch > S&P > Moody's
        AGENCY_PREF = {'Fitch': 3, 'S&P': 2, "Moody's": 1}
        best = None  # (preference, rating, agency)

        for _score, text, _href in candidates:
            rating, agency = parse_rating_from_text(text)
            if not rating:
                continue
            pref = AGENCY_PREF.get(agency, 0)
            if best is None or pref > best[0]:
                best = (pref, rating, agency)

        if best:
            _pref, rating, agency = best
            return rating, agency
        return None, None

    # ------------------------------------------------------------------
    #  Source 3 : SEC EDGAR full-text search
    # ------------------------------------------------------------------
    def _try_sec_edgar(
        self, isin: str, issuer: str
    ) -> Tuple[Optional[str], Optional[str]]:
        """
        SEC EDGAR full-text search API.
        Cherche dans les filings FWP (Free Writing Prospectus) qui contiennent
        souvent les ratings attendus en plein texte.
        """
        try:
            import httpx
        except ImportError:
            logger.debug("  ⚠️  httpx non dispo, skip SEC EDGAR")
            return None, None

        # SEC requiert un User-Agent identifiable
        headers = {
            'User-Agent': 'OmenServer YieldBot (massimiliano@example.com)'
        }

        # Recherche full-text par ISIN dans les FWP et 424B
        search_api = (
            f"https://efts.sec.gov/LATEST/search-index"
            f"?q=%22{isin}%22&forms=FWP,424B2,424B5"
        )
        try:
            r = httpx.get(search_api, headers=headers, timeout=15)
            if r.status_code != 200:
                return None, None
            data = r.json()
        except Exception as e:
            logger.debug(f"  ⚠️  SEC EDGAR error: {e!r}")
            return None, None

        hits = data.get('hits', {}).get('hits', [])
        if not hits:
            return None, None

        # Prend le filing le plus récent et parse son contenu
        first = hits[0]
        adsh = first.get('_id', '').replace(':', '/')
        cik = first.get('_source', {}).get('ciks', [''])[0]
        if not adsh or not cik:
            return None, None

        # Construit l'URL du fichier indexé
        # Format: https://www.sec.gov/Archives/edgar/data/<cik>/<adsh-clean>/
        cik_clean = cik.lstrip('0')
        adsh_clean = adsh.split('/')[0].replace('-', '')
        index_url = (
            f"https://www.sec.gov/cgi-bin/browse-edgar"
            f"?action=getcompany&CIK={cik}&type=FWP&dateb=&owner=include"
            f"&count=40"
        )

        try:
            r2 = httpx.get(index_url, headers=headers, timeout=15)
            text = r2.text
        except Exception:
            return None, None

        # Parse simple — cherche un rating dans le texte du filing
        rating, agency = parse_rating_from_text(text)
        if rating:
            return rating, agency
        return None, None


# ============================================================================
#  CLI de test
# ============================================================================

if __name__ == '__main__':
    import argparse
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s | %(message)s', datefmt='%H:%M:%S',
    )

    parser = argparse.ArgumentParser(
        description='Test du rating fetcher sur un ISIN + issuer.'
    )
    parser.add_argument('isin', help='Code ISIN (ex: US25746UCY38)')
    parser.add_argument('issuer', help='Nom émetteur (ex: "Dominion Energy")')
    parser.add_argument('--no-fitch', action='store_true',
                        help='Skip Fitch direct (Camoufox), utilise seulement DDG+SEC')
    args = parser.parse_args()

    fetcher = RatingFetcher(use_camoufox=not args.no_fitch)
    rating, agency = fetcher.fetch_rating(args.isin, args.issuer)
    print(f"\nResult: {rating} ({agency})" if rating else "\nResult: NOT FOUND")
