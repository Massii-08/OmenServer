"""
Scraper per la ricerca di obbligazioni su Deutsche Börse.

TECNICA: Intercettazione API JSON
Naviga alla pagina Bond Search di Deutsche Börse (live.deutsche-boerse.com/bonds)
e intercetta le risposte JSON delle API interne per raccogliere i dati.

A differenza del BoerseScraper del Yield Bot (che cerca un singolo ISIN),
questo scraper naviga la LISTA dei bond disponibili e raccoglie tutti i
risultati paginati.

Strategia:
1. Navigazione alla pagina Bond Search con filtri
2. Intercettazione delle API JSON di listing
3. Paginazione automatica
4. Per ogni bond trovato, navigazione alla pagina dettaglio per dati completi
"""

import json
import logging
import re
from datetime import date, datetime
from typing import List, Dict, Any, Optional

from scanner.models import ScannedBond, RatingInfo
from scanner.rating_providers import (
    ALL_PROVIDERS,
    DeutscheBoerseApiProvider,
    BoerseFrankfurtHtmlProvider,
    BoerseStuttgartProvider,
    FitchRatingsProvider,
    IssuerReferenceProvider,
    is_valid_rating,
    merge_ratings,
)

logger = logging.getLogger(__name__)


class MarketScraper:
    """
    Scraper per la ricerca di obbligazioni sul mercato.

    Naviga Deutsche Börse Bond Search e raccoglie i dati di tutte
    le obbligazioni disponibili con i filtri specificati.
    """

    BASE_URL = "https://live.deutsche-boerse.com"

    def __init__(self, headless: bool = True, timeout: int = 12000):
        """
        Args:
            headless: Se True, il browser non mostra la finestra
            timeout: Timeout in ms per il caricamento delle pagine
        """
        self.headless = headless
        self.timeout = timeout
        self._browser = None
        self._context = None
        self._page = None
        self._playwright = None

    async def __aenter__(self):
        await self.start()
        return self

    async def __aexit__(self, *args):
        await self.close()

    async def start(self):
        """Avvia il browser Playwright."""
        from playwright.async_api import async_playwright
        import shutil

        self._playwright = await async_playwright().start()

        launch_args = {
            "headless": self.headless,
            "args": ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
        }
        system_chromium = (
            shutil.which("chromium-browser")
            or shutil.which("chromium")
            or shutil.which("google-chrome")
        )
        if system_chromium:
            launch_args["executable_path"] = system_chromium
            logger.info(f"🌐 Chromium di sistema: {system_chromium}")

        try:
            self._browser = await self._playwright.chromium.launch(**launch_args)
        except Exception:
            if system_chromium and "executable_path" not in launch_args:
                launch_args["executable_path"] = system_chromium
                self._browser = await self._playwright.chromium.launch(**launch_args)
            else:
                raise

        self._context = await self._browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/125.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1280, "height": 900},
            locale="en-US",
        )
        self._page = await self._context.new_page()
        logger.info("🌐 Browser Playwright avviato")

    async def close(self):
        """Chiude il browser."""
        if self._browser:
            await self._browser.close()
        if self._playwright:
            await self._playwright.stop()
        logger.info("Browser chiuso")

    # ================================================================
    #  SCANSIONE DEL MERCATO
    # ================================================================

    async def scan_market(self, currency: str = "EUR", max_pages: int = 20) -> List[ScannedBond]:
        """
        Scansiona il mercato obbligazionario di Deutsche Börse.

        Naviga alla pagina bond search, intercetta le API JSON e
        raccoglie tutti i bond disponibili.

        Args:
            currency: Valuta da cercare (EUR, USD, GBP)
            max_pages: Numero massimo di pagine da scansionare

        Returns:
            Lista di ScannedBond con dati base (prezzo, cedola, scadenza)
        """
        logger.info(f"\n{'='*60}")
        logger.info(f"🔍 Scansione mercato: {currency}")
        logger.info(f"{'='*60}")

        all_bonds: List[ScannedBond] = []
        api_responses: Dict[str, Any] = {}

        async def capture_response(response):
            url = response.url
            if ('api.live.deutsche-boerse.com' in url or
                'api.boerse-frankfurt.de' in url):
                try:
                    if response.status == 200:
                        content_type = response.headers.get('content-type', '')
                        if 'json' in content_type:
                            body = await response.json()
                            if body:
                                api_responses[url] = body
                                logger.debug(f"  📦 API catturata: {url[:80]}")
                except Exception:
                    pass

        self._page.on("response", capture_response)

        # Deutsche Börse accetta i codici valuta standard (EUR, USD, GBP)
        # direttamente nel parametro URL — NON il nome completo

        try:
            # Naviga alla pagina Bond Search CON filtro valuta
            bonds_url = (
                f"{self.BASE_URL}/bonds/search"
                f"?CURRENCIES={currency}"
                f"&ORDER_BY=TURNOVER&ORDER_DIRECTION=DESC"
            )
            logger.info(f"📡 Navigazione: {bonds_url}")

            await self._page.goto(
                bonds_url,
                wait_until="domcontentloaded",
                timeout=self.timeout,
            )

            # Attendi caricamento API (non tutto il network)
            await self._page.wait_for_load_state("networkidle")
            await self._page.wait_for_timeout(2000)

            # Analizza le risposte API per la lista bond
            bonds_from_api = self._parse_bond_list_responses(api_responses, currency)
            if bonds_from_api:
                all_bonds.extend(bonds_from_api)
                logger.info(f"  📊 Trovati {len(bonds_from_api)} bond dalla pagina iniziale")

            # Paginazione: clicca "Next" per caricare più risultati
            page_num = 1
            while page_num < max_pages:
                api_responses.clear()

                # Cerca il bottone "Next page"
                next_btn = None
                next_selectors = [
                    'button[aria-label*="Next"]',
                    'button[aria-label*="next"]',
                    '.pagination-next',
                    'button:has-text(">")',
                    'a:has-text(">")',
                    '[class*="next"]',
                    'button[class*="paginator"] >> nth=-1',
                ]

                for selector in next_selectors:
                    try:
                        locator = self._page.locator(selector).first
                        if await locator.is_visible(timeout=2000):
                            is_disabled = await locator.is_disabled()
                            if not is_disabled:
                                next_btn = locator
                                break
                    except Exception:
                        continue

                if not next_btn:
                    logger.info(f"  📄 Fine paginazione (pagina {page_num})")
                    break

                # Clicca Next
                page_num += 1
                logger.info(f"  📄 Pagina {page_num}...")
                await next_btn.click()
                await self._page.wait_for_load_state("networkidle")
                await self._page.wait_for_timeout(1000)

                # Raccogli i nuovi bond
                new_bonds = self._parse_bond_list_responses(api_responses, currency)
                if new_bonds:
                    all_bonds.extend(new_bonds)
                    logger.info(f"  📊 +{len(new_bonds)} bond (totale: {len(all_bonds)})")
                else:
                    logger.info(f"  📄 Nessun nuovo bond, fine paginazione")
                    break

        finally:
            self._page.remove_listener("response", capture_response)

        # Deduplica per ISIN
        seen_isins = set()
        unique_bonds = []
        for bond in all_bonds:
            if bond.isin not in seen_isins:
                seen_isins.add(bond.isin)
                unique_bonds.append(bond)

        logger.info(f"\n✅ Totale bond trovati per {currency}: {len(unique_bonds)}")
        return unique_bonds

    async def enrich_bond(self, bond: ScannedBond) -> ScannedBond:
        """
        Arricchisce un bond con dati dettagliati dalla pagina singola.

        Naviga alla pagina del bond su Deutsche Börse e raccoglie
        tutti i dati disponibili (volume, min piece, ecc.).
        I rating sono gestiti separatamente da fetch_ratings().

        Args:
            bond: ScannedBond con almeno l'ISIN

        Returns:
            ScannedBond con dati completi
        """
        self._last_api_responses: Dict[str, Any] = {}

        async def capture_response(response):
            url = response.url
            if ('api.live.deutsche-boerse.com' in url or
                'api.boerse-frankfurt.de' in url):
                try:
                    if response.status == 200:
                        content_type = response.headers.get('content-type', '')
                        if 'json' in content_type:
                            body = await response.json()
                            if body:
                                self._last_api_responses[url] = body
                except Exception:
                    pass

        self._page.on("response", capture_response)

        try:
            bond_url = f"{self.BASE_URL}/bond/{bond.isin.lower()}"
            await self._page.goto(
                bond_url,
                wait_until="domcontentloaded",
                timeout=self.timeout,
            )
            # Attendi solo il tempo necessario per le API JSON
            # (come il fix di velocità del Yield Bot — niente networkidle)
            await self._page.wait_for_timeout(1500)

            # Estrai dati dalle API (prezzo, cedola, scadenza, volume, etc.)
            self._enrich_from_api(bond, self._last_api_responses)

        finally:
            self._page.remove_listener("response", capture_response)

        return bond

    async def fetch_ratings(self, bond: ScannedBond) -> ScannedBond:
        """
        Recupera i rating da fonti multiple (cascade mode).

        Strategia cascade (dal più rapido al più lento):
        1. Deutsche Börse API (dati già intercettati — istantaneo)
        2. Börse Frankfurt HTML (pagina già caricata — istantaneo)
        3. Tabella Emittenti di Riferimento (lookup locale — istantaneo)
        4. Börse Stuttgart (pagina separata — lento)
        5. Fitch Ratings (pagina separata — lento)

        I rating trovati vengono combinati in rating_display con la fonte
        tra parentesi: es. "AA- (DB, REF)" o "AA- (REF) / A+ (FR)".

        Args:
            bond: ScannedBond con l'ISIN e il nome

        Returns:
            ScannedBond con ratings, rating e rating_display aggiornati
        """
        found_ratings: list = []

        # --- Source 1: Deutsche Börse API (dati già disponibili) ---
        db_provider = DeutscheBoerseApiProvider()
        api_responses = getattr(self, '_last_api_responses', {})
        rating = await db_provider.get_rating(bond.isin, api_responses=api_responses)
        if rating:
            found_ratings.append(rating)

        # --- Source 2: Börse Frankfurt HTML (pagina già caricata) ---
        bf_provider = BoerseFrankfurtHtmlProvider()
        rating = await bf_provider.get_rating(bond.isin, page=self._page)
        if rating:
            found_ratings.append(rating)

        # --- Source 3: Tabella Emittenti (lookup locale istantaneo) ---
        ref_provider = IssuerReferenceProvider()
        rating = await ref_provider.get_rating(
            bond.isin, bond_name=bond.name
        )
        if rating:
            found_ratings.append(rating)

        # --- Source 4+5: Stuttgart + Fitch (solo se nessun rating trovato) ---
        # Usa pagine SEPARATE per non corrompere la sessione Deutsche Börse
        if not found_ratings:
            # 4. Börse Stuttgart
            stuttgart_page = None
            try:
                stuttgart_page = await self._context.new_page()

                # Intercetta le API di Stuttgart per cercare rating nei JSON
                stuttgart_api: Dict[str, Any] = {}

                async def capture_stuttgart(response):
                    try:
                        if response.status == 200:
                            ct = response.headers.get('content-type', '')
                            if 'json' in ct:
                                body = await response.json()
                                if body:
                                    stuttgart_api[response.url] = body
                    except Exception:
                        pass

                stuttgart_page.on("response", capture_stuttgart)

                bs_provider = BoerseStuttgartProvider()
                rating = await bs_provider.get_rating(bond.isin, page=stuttgart_page)
                if rating:
                    found_ratings.append(rating)

                # Fallback: cerca rating nei JSON API di Stuttgart
                if not rating and stuttgart_api:
                    db_provider2 = DeutscheBoerseApiProvider()
                    for url, data in stuttgart_api.items():
                        r = db_provider2._search_rating_recursive(data, 0, 5)
                        if r:
                            if is_valid_rating(r):
                                ri = RatingInfo(value=r, source="BS", source_full="Börse Stuttgart")
                                found_ratings.append(ri)
                                logger.info(f"    📊 Rating da Börse Stuttgart API: {r}")
                                break

            except Exception as e:
                logger.debug(f"    ⚠️ Errore Börse Stuttgart: {e}")
            finally:
                if stuttgart_page:
                    await stuttgart_page.close()

        # 5. Fitch Ratings (solo se ancora nessun rating)
        if not found_ratings and bond.name:
            fitch_page = None
            try:
                fitch_page = await self._context.new_page()
                fitch_provider = FitchRatingsProvider()
                rating = await fitch_provider.get_rating(
                    bond.isin, page=fitch_page, bond_name=bond.name
                )
                if rating:
                    found_ratings.append(rating)
            except Exception as e:
                logger.debug(f"    ⚠️ Errore Fitch Ratings: {e}")
            finally:
                if fitch_page:
                    await fitch_page.close()

        # --- Fusione ---
        bond.ratings = found_ratings
        bond.rating, bond.rating_display = merge_ratings(found_ratings)

        if found_ratings:
            logger.info(f"    📊 Rating finale: {bond.rating_display}")
        else:
            logger.info(f"    ⚠️ Nessun rating trovato (DB/BF/REF/BS/FR)")

        return bond

    # ================================================================
    #  PARSING DELLE RISPOSTE API
    # ================================================================

    def _parse_bond_list_responses(
        self, responses: Dict[str, Any], currency: str
    ) -> List[ScannedBond]:
        """
        Analizza le risposte API della pagina Bond Search per estrarre la lista bond.
        """
        bonds = []

        for url, data in responses.items():
            # Cerca liste di bond nelle risposte
            bond_list = self._find_bond_list(data)
            if bond_list:
                for item in bond_list:
                    bond = self._parse_bond_item(item, currency)
                    if bond:
                        bonds.append(bond)

        return bonds

    def _find_bond_list(self, data: Any, depth: int = 0) -> Optional[List]:
        """Cerca ricorsivamente una lista di bond nei dati JSON."""
        if depth > 5:
            return None

        if isinstance(data, dict):
            # Cerca chiavi che indicano una lista di bond
            for key in ('data', 'results', 'bonds', 'instruments', 'items',
                        'hits', 'rows', 'content', 'list'):
                if key in data and isinstance(data[key], list):
                    items = data[key]
                    # Verifica che siano bond (hanno ISIN o name)
                    if items and isinstance(items[0], dict):
                        if any(k in items[0] for k in ('isin', 'ISIN', 'name', 'instrumentName')):
                            return items
                        # Ricorsione nei sotto-elementi
                        for item in items[:3]:
                            sub = self._find_bond_list(item, depth + 1)
                            if sub:
                                return sub

            # Ricorsione nei sotto-dizionari
            for key, value in data.items():
                if isinstance(value, (dict, list)):
                    result = self._find_bond_list(value, depth + 1)
                    if result:
                        return result

        elif isinstance(data, list) and len(data) > 0:
            if isinstance(data[0], dict):
                if any(k in data[0] for k in ('isin', 'ISIN', 'name', 'instrumentName')):
                    return data

        return None

    def _parse_bond_item(self, item: dict, currency: str) -> Optional[ScannedBond]:
        """Parsea un elemento bond dalla risposta API."""
        if not isinstance(item, dict):
            return None

        # Cerca l'ISIN
        isin = None
        for key in ('isin', 'ISIN', 'isinCode'):
            if key in item and item[key]:
                isin = str(item[key]).strip()
                break

        if not isin or len(isin) < 12:
            return None

        bond = ScannedBond(isin=isin, currency=currency, fetch_date=date.today())

        # Estrai dati ricorsivamente
        self._extract_fields_recursive(bond, item, depth=0, max_depth=4)

        return bond

    def _enrich_from_api(self, bond: ScannedBond, responses: Dict[str, Any]):
        """Arricchisce un bond con dati dalle API della pagina dettaglio."""
        for url, data in responses.items():
            if isinstance(data, dict):
                self._extract_fields_recursive(bond, data, depth=0, max_depth=5)

    def _extract_fields_recursive(
        self, bond: ScannedBond, data: Any, depth: int, max_depth: int
    ):
        """
        Cerca ricorsivamente nei dati JSON i campi che ci interessano.

        Stessa logica robusta del Yield Bot: non cerchiamo un campo
        a un percorso specifico (fragile), ma cerchiamo QUALSIASI campo
        con un nome riconosciuto (robusto).
        """
        if depth > max_depth or data is None:
            return

        if isinstance(data, dict):
            for key, value in data.items():
                key_lower = key.lower()

                # --- PREZZO ---
                if bond.current_price is None and value is not None:
                    if key_lower in ('lastprice', 'last', 'close', 'price',
                                     'lastvalue', 'closeprice', 'currentprice',
                                     'lasttraded', 'settleprice'):
                        if isinstance(value, (int, float)) and 10 < value < 300:
                            bond.current_price = float(value)

                # --- CEDOLA ---
                if bond.coupon_rate is None and value is not None:
                    if key_lower in ('coupon', 'couponrate', 'interestrate',
                                     'nominalinterest', 'couponpercent'):
                        if isinstance(value, (int, float)) and 0 < value < 20:
                            bond.coupon_rate = float(value)

                # --- SCADENZA ---
                if bond.maturity_date is None and value is not None:
                    if key_lower in ('maturity', 'maturitydate', 'expirationdate',
                                     'redemptiondate', 'enddate'):
                        parsed = self._parse_json_date(value)
                        if parsed:
                            bond.maturity_date = parsed

                # --- DATA EMISSIONE ---
                if bond.issue_date is None and value is not None:
                    if key_lower in ('issuedate', 'emissiondate', 'startdate',
                                     'firsttradingdate'):
                        parsed = self._parse_json_date(value)
                        if parsed:
                            bond.issue_date = parsed

                # --- NOME ---
                if not bond.name and value is not None:
                    if key_lower in ('instrumentname', 'designation', 'longname',
                                     'shortname'):
                        if isinstance(value, str) and len(value) > 5:
                            bond.name = value
                    elif key_lower in ('name', 'title'):
                        # 'name' generico: accetta solo se sembra un nome bond
                        # (esclude nomi di file, media, ecc.)
                        if isinstance(value, str) and len(value) > 5:
                            # Ignora nomi che sembrano file/media/slug
                            if not any(x in value.lower() for x in
                                       ('boersen-radio', 'podcast', '.mp3', '.pdf',
                                        'http', '//', 'image', 'video', 'thumbnail')):
                                bond.name = value

                # --- VALUTA ---
                if key_lower in ('currency', 'tradingcurrency', 'issuecurrency',
                                 'curr', 'ccy'):
                    if isinstance(value, str) and len(value) == 3:
                        bond.currency = value

                # --- VOLUME ---
                if bond.volume is None:
                    if key_lower in ('volume', 'issuevolume', 'outstanding',
                                     'outstandingamount'):
                        if value is not None:
                            bond.volume = str(value)

                # --- RATING ---
                # I rating sono ora gestiti dai RatingProvider in rating_providers.py
                # (multi-source con tracciabilità della fonte)

                # --- MIN PIECE ---
                if bond.min_piece is None:
                    if key_lower in ('minimumdenomination', 'smallestunit', 'minpiece',
                                     'minimumtradableunit', 'lotsize', 'minlot',
                                     'smallesttransferableunit', 'denomination'):
                        if value is not None:
                            bond.min_piece = str(value)

                # Ricorsione
                if isinstance(value, (dict, list)):
                    self._extract_fields_recursive(bond, value, depth + 1, max_depth)

        elif isinstance(data, list):
            for item in data[:10]:
                self._extract_fields_recursive(bond, item, depth + 1, max_depth)

    # ================================================================
    #  UTILITY
    # ================================================================

    def _parse_json_date(self, value) -> Optional[date]:
        """Converte vari formati data JSON in oggetto date."""
        if isinstance(value, str):
            for fmt in ('%Y-%m-%dT%H:%M:%S', '%Y-%m-%d', '%d.%m.%Y', '%d/%m/%Y'):
                try:
                    return datetime.strptime(value[:19], fmt).date()
                except ValueError:
                    continue

            if value.isdigit() and len(value) > 10:
                try:
                    return datetime.fromtimestamp(int(value) / 1000).date()
                except Exception:
                    pass

        elif isinstance(value, (int, float)):
            try:
                if value > 1e12:
                    return datetime.fromtimestamp(value / 1000).date()
                elif value > 1e9:
                    return datetime.fromtimestamp(value).date()
            except Exception:
                pass

        return None

    def _collect_keys(self, data: Any, keys: set, depth: int, max_depth: int):
        """Raccoglie tutte le chiavi presenti nei dati JSON (per debug)."""
        if depth > max_depth or data is None:
            return
        if isinstance(data, dict):
            for key, value in data.items():
                keys.add(key)
                if isinstance(value, (dict, list)):
                    self._collect_keys(value, keys, depth + 1, max_depth)
        elif isinstance(data, list):
            for item in data[:5]:
                self._collect_keys(item, keys, depth + 1, max_depth)
