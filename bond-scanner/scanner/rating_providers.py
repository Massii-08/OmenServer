"""
Provider di rating multi-source per le obbligazioni.

Ogni provider tenta di recuperare il rating di un bond da una fonte specifica.
I risultati vengono poi combinati per dare un rating finale con tracciabilità
della fonte (es: "AA- (DB, FR)").

Fonti supportate:
1. Deutsche Börse API JSON — dai dati già intercettati
2. Börse Frankfurt HTML — scraping DOM della pagina dettaglio
3. Börse Stuttgart HTML — navigazione alla pagina Stammdaten
4. Fitch Ratings — ricerca per nome emittente su fitchratings.com
5. Tabella Emittenti — database locale con ~80 emittenti comuni

Strategia: Cascade — si prova la fonte più rapida per prima,
e si cercano le altre solo se non si trova rating.
"""

import logging
import re
from abc import ABC, abstractmethod
from typing import Dict, Any, List, Optional

from scanner.models import RatingInfo

logger = logging.getLogger(__name__)

# ================================================================
#  Validazione dei rating
# ================================================================

# Pattern validi per rating S&P/Fitch
SP_RATING_PATTERN = re.compile(
    r'^(AAA|AA\+|AA|AA-|A\+|A|A-|BBB\+|BBB|BBB-|BB\+|BB|BB-|B\+|B|B-|'
    r'CCC\+|CCC|CCC-|CC|C|D)$',
    re.IGNORECASE
)

# Pattern validi per rating Moody's
MOODY_RATING_PATTERN = re.compile(
    r'^(Aaa|Aa[123]?|A[123]?|Baa[123]?|Ba[123]?|B[123]?|'
    r'Caa[123]?|Ca|C)$',
    re.IGNORECASE
)

# Valori da ignorare
INVALID_RATINGS = {
    'nr', 'n/a', 'na', '-', 'not rated', 'unrated', 'none',
    'n.a.', 'n.r.', '--', '—', '', 'k.a.', 'keine angabe',
    'bitte melden sie sich an',  # Börse Stuttgart login-wall
}


def is_valid_rating(value: str) -> bool:
    """Verifica se una stringa è un rating valido (S&P, Fitch o Moody's)."""
    if not value or not isinstance(value, str):
        return False
    cleaned = value.strip()
    if cleaned.lower() in INVALID_RATINGS:
        return False
    if len(cleaned) < 1 or len(cleaned) > 10:
        return False
    return bool(SP_RATING_PATTERN.match(cleaned) or MOODY_RATING_PATTERN.match(cleaned))


# ================================================================
#  Classe base
# ================================================================

class RatingProvider(ABC):
    """Interfaccia per un fornitore di rating."""

    @abstractmethod
    async def get_rating(self, isin: str, page=None, api_responses: Dict[str, Any] = None) -> Optional[RatingInfo]:
        """
        Tenta di recuperare il rating per questo ISIN.

        Args:
            isin: Codice ISIN dell'obbligazione
            page: Pagina Playwright (per scraping HTML)
            api_responses: Risposte API già intercettate (per Deutsche Börse)

        Returns:
            RatingInfo se trovato, None altrimenti
        """
        pass

    @property
    @abstractmethod
    def source_tag(self) -> str:
        """Tag corto della fonte (es: 'DB', 'BF', 'BS')."""
        pass

    @property
    @abstractmethod
    def source_name(self) -> str:
        """Nome completo della fonte."""
        pass


# ================================================================
#  Source 1: Deutsche Börse API JSON
# ================================================================

class DeutscheBoerseApiProvider(RatingProvider):
    """
    Estrae il rating dalle risposte API JSON di Deutsche Börse.

    Questa è la fonte più veloce perché riutilizza i dati API
    già intercettati durante l'enrichment del bond (nessuna
    navigazione aggiuntiva necessaria).
    """

    RATING_KEYS = {
        'rating', 'sprating', 'moodyrating', 'fitchrating', 'creditrating',
        'ratingvalue', 'ratingmoodys', 'ratingfitch', 'ratingsp',
        'standardandpoorsrating', 'moodyslongtermrating', 'fitchlongtermrating',
        'splongtermrating', 'issuerrating', 'bondrating', 'currentrating',
        'ratingclass', 'ratinggrade',
    }

    @property
    def source_tag(self) -> str:
        return "DB"

    @property
    def source_name(self) -> str:
        return "Deutsche Börse"

    async def get_rating(self, isin: str, page=None, api_responses: Dict[str, Any] = None) -> Optional[RatingInfo]:
        if not api_responses:
            return None

        for url, data in api_responses.items():
            rating_value = self._search_rating_recursive(data, depth=0, max_depth=5)
            if rating_value:
                logger.info(f"    📊 Rating da {self.source_name}: {rating_value}")
                return RatingInfo(
                    value=rating_value,
                    source=self.source_tag,
                    source_full=self.source_name,
                )

        return None

    def _search_rating_recursive(self, data: Any, depth: int, max_depth: int) -> Optional[str]:
        """Cerca ricorsivamente un campo rating nei dati JSON."""
        if depth > max_depth or data is None:
            return None

        if isinstance(data, dict):
            for key, value in data.items():
                key_lower = key.lower()
                if key_lower in self.RATING_KEYS:
                    if isinstance(value, str) and is_valid_rating(value):
                        return value.strip()

                if isinstance(value, (dict, list)):
                    result = self._search_rating_recursive(value, depth + 1, max_depth)
                    if result:
                        return result

        elif isinstance(data, list):
            for item in data[:10]:
                result = self._search_rating_recursive(item, depth + 1, max_depth)
                if result:
                    return result

        return None


# ================================================================
#  Source 2: Börse Frankfurt / Deutsche Börse — DOM Scraping
# ================================================================

class BoerseFrankfurtHtmlProvider(RatingProvider):
    """
    Scraping del DOM della pagina dettaglio su Deutsche Börse / Börse Frankfurt.

    Cerca il rating nella sezione Master Data / Key Data della pagina HTML.
    Utilizza la stessa pagina già navigata durante l'enrichment
    (nessuna navigazione aggiuntiva).
    """

    @property
    def source_tag(self) -> str:
        return "BF"

    @property
    def source_name(self) -> str:
        return "Börse Frankfurt"

    async def get_rating(self, isin: str, page=None, api_responses: Dict[str, Any] = None) -> Optional[RatingInfo]:
        if page is None:
            return None

        try:
            # Cerca nel DOM della pagina già caricata (live.deutsche-boerse.com/bond/...)
            # I dati master sono spesso in tabelle <dl>, <table>, o coppie label/value

            # Strategia 1: Cercare testo che contiene "Rating" come label
            rating_selectors = [
                # Tabella master data con coppie dt/dd
                'dt:has-text("Rating") + dd',
                'dt:has-text("rating") + dd',
                # Tabella con th/td
                'th:has-text("Rating") ~ td',
                'th:has-text("rating") ~ td',
                # Span/div con label
                'label:has-text("Rating") + span',
                'label:has-text("Rating") + div',
                # Qualsiasi elemento con data-field="rating"
                '[data-field*="rating"]',
                '[data-field*="Rating"]',
                # Key-value generic
                '.key-value-pair:has-text("Rating") .value',
                '.detail-row:has-text("Rating") .detail-value',
            ]

            for selector in rating_selectors:
                try:
                    locator = page.locator(selector).first
                    if await locator.is_visible(timeout=500):
                        text = (await locator.text_content() or "").strip()
                        if is_valid_rating(text):
                            logger.info(f"    📊 Rating da {self.source_name} (HTML): {text}")
                            return RatingInfo(
                                value=text,
                                source=self.source_tag,
                                source_full=self.source_name,
                            )
                except Exception:
                    continue

            # Strategia 2: Cerca nel testo complet della pagina con regex
            try:
                page_text = await page.inner_text('body', timeout=1000)
                # Cerca pattern come "Rating  AA-" o "S&P Rating: BBB+"
                patterns = [
                    r'(?:S&P|Fitch|Moody)[\'s]*\s*(?:Rating|rating)[:\s]*([A-D][a-z0-9+\-]{0,4})',
                    r'(?:Rating|rating)[:\s]+([A-D][A-Za-z0-9+\-]{0,4})',
                    r'(?:Credit\s*Rating)[:\s]+([A-D][A-Za-z0-9+\-]{0,4})',
                ]
                for pattern in patterns:
                    match = re.search(pattern, page_text)
                    if match:
                        candidate = match.group(1).strip()
                        if is_valid_rating(candidate):
                            logger.info(f"    📊 Rating da {self.source_name} (testo): {candidate}")
                            return RatingInfo(
                                value=candidate,
                                source=self.source_tag,
                                source_full=self.source_name,
                            )
            except Exception:
                pass

        except Exception as e:
            logger.debug(f"    ⚠️ Errore scraping HTML {self.source_name}: {e}")

        return None


# ================================================================
#  Source 3: Börse Stuttgart — Pagina Stammdaten
# ================================================================

class BoerseStuttgartProvider(RatingProvider):
    """
    Scraping della pagina bond su Börse Stuttgart.

    Naviga a boerse-stuttgart.de e cerca il campo "S&P-RATING"
    nella sezione Stammdaten.

    ⚠️ Alcuni bond richiedono il login per vedere il rating.
    In quel caso, il campo mostra "Bitte melden Sie sich an" → ignorato.
    """

    BASE_URL = "https://www.boerse-stuttgart.de/de-de/produkte/anleihen/stuttgart"

    @property
    def source_tag(self) -> str:
        return "BS"

    @property
    def source_name(self) -> str:
        return "Börse Stuttgart"

    async def get_rating(self, isin: str, page=None, api_responses: Dict[str, Any] = None) -> Optional[RatingInfo]:
        if page is None:
            return None

        try:
            # Naviga alla pagina Börse Stuttgart
            url = f"{self.BASE_URL}/{isin.lower()}"
            logger.debug(f"    🔍 Ricerca rating su {self.source_name}: {url}")

            await page.goto(url, wait_until="domcontentloaded", timeout=10000)
            await page.wait_for_timeout(2000)

            # Cerca il campo S&P-RATING nella pagina
            rating_selectors = [
                # Stammdaten standard
                'dt:has-text("S&P") + dd',
                'dt:has-text("Rating") + dd',
                'dt:has-text("RATING") + dd',
                # Tabella Stammdaten
                'th:has-text("S&P") ~ td',
                'th:has-text("Rating") ~ td',
                # Label generiche
                'span:has-text("S&P-RATING")',
                '.stamp-data-value',
                # Cercare in tutti i data-rows
                'tr:has-text("Rating") td:last-child',
                'tr:has-text("S&P") td:last-child',
                'div:has-text("Rating") + div',
            ]

            for selector in rating_selectors:
                try:
                    locator = page.locator(selector).first
                    if await locator.is_visible(timeout=500):
                        text = (await locator.text_content() or "").strip()
                        if is_valid_rating(text):
                            logger.info(f"    📊 Rating da {self.source_name}: {text}")
                            return RatingInfo(
                                value=text,
                                source=self.source_tag,
                                source_full=self.source_name,
                            )
                except Exception:
                    continue

            # Strategia fallback: cerca nel testo della pagina
            try:
                page_text = await page.inner_text('body', timeout=1000)

                # Cerca pattern "S&P-RATING" seguito da un valore
                patterns = [
                    r'S&P[- ]*RATING[:\s]*([A-D][A-Za-z0-9+\-]{0,4})',
                    r'S&P[:\s]*([A-D][A-Za-z0-9+\-]{0,4})',
                    r"Moody['\s]*s?[:\s]*([A-C][a-z]{1,2}[123]?)",
                    r'Fitch[:\s]*([A-D][A-Za-z0-9+\-]{0,4})',
                    r'Rating[:\s]+([A-D][A-Za-z0-9+\-]{0,4})',
                ]
                for pattern in patterns:
                    match = re.search(pattern, page_text)
                    if match:
                        candidate = match.group(1).strip()
                        if is_valid_rating(candidate):
                            logger.info(f"    📊 Rating da {self.source_name} (testo): {candidate}")
                            return RatingInfo(
                                value=candidate,
                                source=self.source_tag,
                                source_full=self.source_name,
                            )
            except Exception:
                pass

            logger.debug(f"    ⚠️ Nessun rating trovato su {self.source_name}")

        except Exception as e:
            logger.debug(f"    ⚠️ Errore {self.source_name}: {e}")

        return None


# ================================================================
#  Fusione e comparazione dei rating
# ================================================================

# Scala S&P per la normalizzazione
RATING_SCALE = [
    'AAA', 'AA+', 'AA', 'AA-',
    'A+', 'A', 'A-',
    'BBB+', 'BBB', 'BBB-',
    'BB+', 'BB', 'BB-',
    'B+', 'B', 'B-',
    'CCC+', 'CCC', 'CCC-',
    'CC', 'C', 'D',
]

MOODY_TO_SP = {
    'Aaa': 'AAA',
    'Aa1': 'AA+', 'Aa2': 'AA', 'Aa3': 'AA-', 'Aa': 'AA',
    'A1': 'A+', 'A2': 'A', 'A3': 'A-',
    'Baa1': 'BBB+', 'Baa2': 'BBB', 'Baa3': 'BBB-', 'Baa': 'BBB',
    'Ba1': 'BB+', 'Ba2': 'BB', 'Ba3': 'BB-', 'Ba': 'BB',
    'B1': 'B+', 'B2': 'B', 'B3': 'B-',
    'Caa1': 'CCC+', 'Caa2': 'CCC', 'Caa3': 'CCC-', 'Caa': 'CCC',
    'Ca': 'CC', 'C': 'C',
}


def normalize_to_sp(rating: str) -> Optional[str]:
    """Normalizza un rating a formato S&P."""
    if not rating:
        return None
    rating = rating.strip()

    # Già S&P?
    if rating.upper() in [r.upper() for r in RATING_SCALE]:
        return rating.upper()

    # Moody's?
    if rating in MOODY_TO_SP:
        return MOODY_TO_SP[rating]

    # Case-insensitive Moody's
    for moody, sp in MOODY_TO_SP.items():
        if rating.lower() == moody.lower():
            return sp

    return rating.upper()  # Fallback: uppercase


def merge_ratings(ratings: List[RatingInfo]) -> tuple:
    """
    Combina i rating da fonti multiple.

    Returns:
        (rating_finale, rating_display)
        - rating_finale: il rating più conservativo (peggiore) per il filtro
        - rating_display: stringa per l'Excel con le fonti

    Esempi:
        - Tutti concordano:  ("AA-", "AA- (DB, BS)")
        - Divergenza:        ("A-",  "AA- (DB) / A- (BS)")
        - Un solo:           ("AA-", "AA- (BS)")
        - Nessuno:           (None,  "?")
    """
    if not ratings:
        return None, "?"

    # Normalizza tutti i rating in S&P
    normalized = []
    for r in ratings:
        sp = normalize_to_sp(r.value)
        normalized.append((sp, r.source, r.value))

    # Raggruppa per valore normalizzato
    groups: Dict[str, List[str]] = {}
    for sp_val, source, original in normalized:
        if sp_val not in groups:
            groups[sp_val] = []
        groups[sp_val].append(source)

    if len(groups) == 1:
        # Tutti concordano
        sp_val = list(groups.keys())[0]
        sources = list(groups.values())[0]
        rating_display = f"{sp_val} ({', '.join(sources)})"
        return sp_val, rating_display
    else:
        # Divergenza: mostra tutti separatamente
        parts = []
        worst_idx = -1
        worst_val = None

        for sp_val, sources in groups.items():
            parts.append(f"{sp_val} ({', '.join(sources)})")
            try:
                idx = RATING_SCALE.index(sp_val)
            except ValueError:
                idx = 999
            if idx > worst_idx:
                worst_idx = idx
                worst_val = sp_val

        rating_display = " / ".join(parts)
        return worst_val, rating_display


# ================================================================
#  Source 4: Fitch Ratings — Ricerca per nome emittente
# ================================================================

class FitchRatingsProvider(RatingProvider):
    """
    Cerca il rating su fitchratings.com tramite il nome dell'emittente.

    Fitch fornisce i rating pubblicamente senza login.
    La ricerca avviene per nome emittente (estratto dal nome del bond).
    Prende il primo risultato "Long Term Issuer Default Rating".

    ⚠️ Richiede una pagina Playwright separata (naviga via JS/Gatsby).
    """

    BASE_URL = "https://www.fitchratings.com/search"

    @property
    def source_tag(self) -> str:
        return "FR"

    @property
    def source_name(self) -> str:
        return "Fitch Ratings"

    def _extract_issuer_from_bond_name(self, name: str) -> Optional[str]:
        """
        Estrae il nome dell'emittente dal nome del bond.

        Esempi:
            "Allianz SE 2.60% 23/28" → "Allianz"
            "Deutschland, Bundesrepublik 1,9% 25/27" → "Deutschland"
            "Sixt SE 5,125% 23/27" → "Sixt"
            "Schneider Electric SE 3% 24/30" → "Schneider Electric"
        """
        if not name:
            return None

        # Rimuovi suffissi legali
        clean = name.strip()
        # Prendi la parte prima del primo numero/percentuale
        parts = re.split(r'\d', clean, 1)
        issuer = parts[0].strip() if parts else clean

        # Rimuovi suffissi legali e virgole
        for suffix in [' SE', ' AG', ' SA', ' PLC', ' NV', ' GmbH', ' S.A.',
                       ' Inc', ' Corp', ' Ltd', ' B.V.', ' Capital',
                       ', Bundesrepublik', ', Republic of']:
            issuer = issuer.replace(suffix, '')

        issuer = issuer.strip(' ,-')

        return issuer if len(issuer) >= 2 else None

    async def get_rating(self, isin: str, page=None, api_responses=None,
                         bond_name: str = None) -> Optional[RatingInfo]:
        if page is None or not bond_name:
            return None

        issuer = self._extract_issuer_from_bond_name(bond_name)
        if not issuer:
            return None

        try:
            # Intercepta les API de Fitch pour données structurées
            fitch_api: Dict[str, Any] = {}

            async def capture_fitch(response):
                try:
                    if response.status == 200:
                        ct = response.headers.get('content-type', '')
                        if 'json' in ct:
                            body = await response.json()
                            if body:
                                fitch_api[response.url] = body
                except Exception:
                    pass

            page.on("response", capture_fitch)

            url = f"{self.BASE_URL}/?query={issuer}"
            logger.debug(f"    🔍 Ricerca Fitch per: {issuer}")

            await page.goto(url, wait_until="domcontentloaded", timeout=15000)
            await page.wait_for_timeout(3000)

            # Strategia 1: Chercher dans les API JSON interceptées
            for api_url, data in fitch_api.items():
                rating_val = self._search_fitch_api(data)
                if rating_val:
                    logger.info(f"    📊 Rating da {self.source_name} API: {rating_val}")
                    return RatingInfo(
                        value=rating_val,
                        source=self.source_tag,
                        source_full=self.source_name,
                    )

            # Strategia 2: Scraping DOM de la page de résultats
            try:
                # Cherche le premier rating dans les résultats (structure Fitch)
                # Le rating est dans un élément coloré (rouge/orange) près du nom
                rating_elements = page.locator('a[aria-label]').first
                if await rating_elements.is_visible(timeout=2000):
                    # Le parent contient nom + rating
                    parent = rating_elements.locator('..')
                    text = (await parent.text_content() or "").strip()

                    # Chercher un pattern de rating dans le texte
                    patterns = [
                        r'\b(AAA|AA\+|AA|AA-|A\+|A-|BBB\+|BBB|BBB-)\b',
                        r'\b(Aaa|Aa[123]|A[123]|Baa[123])\b',
                    ]
                    for pattern in patterns:
                        match = re.search(pattern, text)
                        if match:
                            candidate = match.group(1)
                            if is_valid_rating(candidate):
                                logger.info(f"    📊 Rating da {self.source_name} (DOM): {candidate}")
                                return RatingInfo(
                                    value=candidate,
                                    source=self.source_tag,
                                    source_full=self.source_name,
                                )
            except Exception:
                pass

            # Strategia 3: Chercher dans tout le texte de la page
            try:
                body_text = await page.inner_text('body', timeout=2000)
                # Cherche "Long Term Issuer Default Rating" suivi d'un rating
                idr_match = re.search(
                    r'(AAA|AA\+|AA-?|A\+|A-?|BBB\+|BBB-?)\s*(?:●|⬤|•)?\s*(?:Affirmed|Downgraded|Upgraded|New)',
                    body_text
                )
                if idr_match:
                    candidate = idr_match.group(1)
                    if is_valid_rating(candidate):
                        logger.info(f"    📊 Rating da {self.source_name} (testo): {candidate}")
                        return RatingInfo(
                            value=candidate,
                            source=self.source_tag,
                            source_full=self.source_name,
                        )
            except Exception:
                pass

            logger.debug(f"    ⚠️ Nessun rating Fitch per: {issuer}")

        except Exception as e:
            logger.debug(f"    ⚠️ Errore Fitch: {e}")

        return None

    def _search_fitch_api(self, data: Any, depth: int = 0) -> Optional[str]:
        """Cerca ricorsivamente un rating nelle API Fitch."""
        if depth > 6 or data is None:
            return None

        if isinstance(data, dict):
            # Fitch utilise des champs comme "ratingLongTerm", "rating", "ratingValue"
            for key, value in data.items():
                key_lower = key.lower()
                if ('rating' in key_lower and 'type' not in key_lower
                        and 'action' not in key_lower and 'date' not in key_lower):
                    if isinstance(value, str) and is_valid_rating(value):
                        return value.strip()

                if isinstance(value, (dict, list)):
                    result = self._search_fitch_api(value, depth + 1)
                    if result:
                        return result

        elif isinstance(data, list):
            for item in data[:5]:
                result = self._search_fitch_api(item, depth + 1)
                if result:
                    return result

        return None


# ================================================================
#  Source 5: Tabella Emittenti di Riferimento
# ================================================================

# Rating S&P/Fitch ufficiali dei principali emittenti europei e internazionali
# Fonte: S&P Global, Fitch Ratings (dati pubblici, aggiornati maggio 2025)
# Chiave: nome dell'emittente (minuscolo, senza suffissi legali)
# Valore: (rating S&P, rating Fitch se diverso o None)
ISSUER_RATINGS = {
    # --- GOVERNI EUROPEI ---
    'deutschland': 'AAA', 'germany': 'AAA', 'bundesrepublik': 'AAA',
    'france': 'AA-', 'republique francaise': 'AA-',
    'italy': 'BBB', 'italia': 'BBB', 'repubblica italiana': 'BBB',
    'spain': 'A', 'espagne': 'A', 'reino de espana': 'A',
    'netherlands': 'AAA', 'pays-bas': 'AAA', 'koninkrijk der nederlanden': 'AAA',
    'austria': 'AA+', 'republik oesterreich': 'AA+',
    'belgium': 'AA-', 'belgique': 'AA-',
    'portugal': 'A-',
    'ireland': 'AA-', 'irland': 'AA-',
    'finland': 'AA+', 'finnland': 'AA+',
    'greece': 'BBB-', 'griechenland': 'BBB-',
    'poland': 'A-', 'polen': 'A-',
    'united kingdom': 'AA', 'uk': 'AA',

    # --- GOVERNI NON-EUROPÉENS ---
    'united states': 'AA+', 'usa': 'AA+',
    'japan': 'A+', 'canada': 'AAA',
    'australia': 'AAA', 'china': 'A+',

    # --- BANQUES EUROPÉENNES ---
    'deutsche bank': 'A-', 'commerzbank': 'A-',
    'bnp paribas': 'A+', 'societe generale': 'A',
    'credit agricole': 'A+', 'natixis': 'A+',
    'hsbc': 'A+', 'barclays': 'A',
    'standard chartered': 'A+', 'lloyds': 'A+',
    'unicredit': 'BBB', 'intesa sanpaolo': 'BBB+',
    'ing': 'A+', 'rabobank': 'A+', 'abn amro': 'A',
    'nordea': 'AA-', 'danske bank': 'A+',
    'credit suisse': 'A-', 'ubs': 'A+',
    'santander': 'A+', 'bbva': 'A+', 'caixabank': 'A-',
    'erste bank': 'A', 'raiffeisen': 'A-',

    # --- BANQUES DE DÉVELOPPEMENT ---
    'kfw': 'AAA', 'bei': 'AAA', 'eib': 'AAA',
    'european investment bank': 'AAA',
    'world bank': 'AAA', 'ibrd': 'AAA',
    'landesbank': 'A', 'lbbw': 'A+',
    'nrw.bank': 'AAA', 'l-bank': 'AAA',
    'rentenbank': 'AAA',

    # --- ASSURANCES ---
    'allianz': 'AA', 'munich re': 'AA-', 'muenchener rueck': 'AA-',
    'axa': 'AA-', 'zurich': 'AA', 'swiss re': 'AA-',
    'generali': 'A-', 'talanx': 'A+', 'hannover rueck': 'AA-',

    # --- AUTOMOBILE ---
    'volkswagen': 'BBB+', 'vw': 'BBB+',
    'bmw': 'A+', 'mercedes-benz': 'A', 'daimler': 'A',
    'porsche': 'A-', 'audi': 'BBB+',
    'renault': 'BBB-', 'stellantis': 'BBB+',
    'toyota': 'A+', 'ford': 'BBB-',

    # --- ÉNERGIE & UTILITIES ---
    'edf': 'BBB+', 'engie': 'BBB+', 'total': 'AA-', 'totalenergies': 'AA-',
    'shell': 'AA-', 'bp': 'A-', 'eni': 'A-',
    'enel': 'BBB+', 'iberdrola': 'BBB+', 'rwe': 'BBB+',
    'e.on': 'BBB+', 'vattenfall': 'BBB+', 'fortum': 'BBB+',
    'orsted': 'BBB+',

    # --- TELECOM ---
    'deutsche telekom': 'BBB+', 'orange': 'BBB+',
    'telefonica': 'BBB', 'vodafone': 'BBB',
    'bt': 'BBB', 'swisscom': 'A',

    # --- INDUSTRIE / CONGLOMÉRATS ---
    'siemens': 'A+', 'basf': 'A', 'bayer': 'BBB',
    'henkel': 'A', 'linde': 'A',
    'schneider electric': 'A-', 'saint-gobain': 'BBB+',
    'thyssenkrupp': 'BB+',
    'airbus': 'A', 'safran': 'A-',

    # --- TECH & LUXE ---
    'sap': 'A', 'lvmh': 'A+', 'hermes': 'A+',

    # --- IMMOBILIER ---
    'vonovia': 'BBB+', 'unibail': 'A-',

    # --- RETAIL / CONSUMER ---
    'nestle': 'AA-', 'danone': 'BBB+', 'unilever': 'A+',
    'diageo': 'A-', 'anheuser-busch': 'BBB+', 'ab inbev': 'BBB+',
    'sixt': 'BBB-',
}


class IssuerReferenceProvider(RatingProvider):
    """
    Lookup rapide dans la table de référence des émetteurs.

    Aucun scraping — utilise une base de données locale des ratings
    des principaux émetteurs européens et internationaux.
    Affiché comme "AA- (REF)" dans l'Excel.

    ⚠️ Les ratings peuvent être obsolètes si non mis à jour régulièrement.
    """

    @property
    def source_tag(self) -> str:
        return "REF"

    @property
    def source_name(self) -> str:
        return "Tabella Emittenti"

    def _extract_issuer_keywords(self, name: str) -> List[str]:
        """
        Extrait les mots-clés de l'émetteur depuis le nom du bond.

        Retourne une liste de candidats à chercher dans ISSUER_RATINGS.
        """
        if not name:
            return []

        clean = name.strip()
        # Prendi tutto prima del primo numero
        parts = re.split(r'\d', clean, 1)
        issuer_part = parts[0].strip(' ,-') if parts else clean

        # Rimuovi suffissi legali
        for suffix in [' SE', ' AG', ' SA', ' PLC', ' NV', ' GmbH', ' S.A.',
                       ' Inc', ' Corp', ' Ltd', ' B.V.', ' Capital',
                       ', Bundesrepublik', ', Republic of']:
            issuer_part = issuer_part.replace(suffix, '')

        issuer_part = issuer_part.strip(' ,-')

        # Genera candidati:
        # "Schneider Electric" → ["schneider electric", "schneider"]
        # "Landesbank Hessen-Thüringen Girozentrale" → ["landesbank hessen-thüringen girozentrale", "landesbank"]
        candidates = [issuer_part.lower()]
        words = issuer_part.split()
        if len(words) > 1:
            candidates.append(words[0].lower())  # primo parola
            candidates.append(' '.join(words[:2]).lower())  # prime 2 parole

        return candidates

    async def get_rating(self, isin: str, page=None, api_responses=None,
                         bond_name: str = None) -> Optional[RatingInfo]:
        if not bond_name:
            return None

        candidates = self._extract_issuer_keywords(bond_name)

        for candidate in candidates:
            if candidate in ISSUER_RATINGS:
                rating = ISSUER_RATINGS[candidate]
                logger.info(f"    📊 Rating da {self.source_name}: {rating} (emittente: {candidate})")
                return RatingInfo(
                    value=rating,
                    source=self.source_tag,
                    source_full=self.source_name,
                )

        return None


# ================================================================
#  Lista dei provider disponibili
# ================================================================

ALL_PROVIDERS: List[RatingProvider] = [
    DeutscheBoerseApiProvider(),     # Source 1: API JSON (istantaneo)
    BoerseFrankfurtHtmlProvider(),   # Source 2: DOM pagina (istantaneo)
    IssuerReferenceProvider(),       # Source 5: Tabella emittenti (istantaneo)
    BoerseStuttgartProvider(),       # Source 3: Börse Stuttgart (navigazione)
    FitchRatingsProvider(),          # Source 4: Fitch Ratings (navigazione)
]
