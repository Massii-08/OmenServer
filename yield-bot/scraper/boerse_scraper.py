"""
Scraper per Deutsche Börse (boerse-frankfurt.de).

TECNICA: Intercettazione API
Il sito è una SPA Angular che carica i dati tramite API interna JSON.
Invece di leggere il DOM HTML (fragile), intercettiamo le risposte JSON
delle API che il frontend chiama automaticamente.

Questo rende lo scraper ROBUSTO ai cambiamenti di layout:
- Se cambiano il design/CSS/HTML → funziona ancora ✅
- Se cambiano la struttura JSON dell'API → si rompe ❌ (ma è raro, 
  perché romperebbero anche il loro stesso sito)

Fallback multipli:
1. Intercettazione API JSON (primario - più robusto)
2. DOM scraping (fallback - se l'API cambia)
3. Multi-source (secondo fallback - Yahoo Finance, ecc.)
"""

import json
import logging
import re
from datetime import date, datetime
from typing import Optional, List, Dict, Any

from scraper.models import BondData

logger = logging.getLogger(__name__)


class BoerseScraper:
    """
    Scraper per recuperare dati obbligazionari da Deutsche Börse.
    
    Strategia a 3 livelli:
    1. Intercetta le risposte JSON delle API interne (robusto)
    2. Scraping DOM come fallback (fragile)
    3. Multi-source fallback (Yahoo Finance, ecc.)
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

        self._playwright = await async_playwright().start()

        launch_args = {
            "headless": self.headless,
            "args": ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
        }

        # On préfère le Chromium *bundled* par Playwright. Sur Ubuntu 22.04+,
        # /usr/bin/chromium-browser est un wrapper du snap chromium qui refuse
        # de tourner hors d'un cgroup snap (ex: depuis omenserver.service via
        # systemd) — symptômes : "is not a snap cgroup for tag snap.chromium",
        # "xdg-settings: not found", exit 1. Donc :
        #   1) on tente d'abord le Chromium bundled (cas nominal prod + dev Mac)
        #   2) si Playwright n'a pas son binaire, fallback sur le système
        #      MAIS uniquement si ce n'est PAS un wrapper snap.
        try:
            self._browser = await self._playwright.chromium.launch(**launch_args)
            logger.info("🌐 Browser Playwright (Chromium bundled) avviato")
        except Exception as bundled_err:
            logger.warning(
                f"⚠️ Chromium bundled Playwright KO ({type(bundled_err).__name__}): "
                f"{bundled_err}. Tentative fallback système (non-snap uniquement)."
            )
            system_chromium = self._find_non_snap_chromium()
            if not system_chromium:
                logger.error(
                    "❌ Aucun Chromium utilisable. Installe-le avec : "
                    "`playwright install chromium` dans le venv du yield-bot."
                )
                raise bundled_err
            launch_args["executable_path"] = system_chromium
            self._browser = await self._playwright.chromium.launch(**launch_args)
            logger.info(f"🌐 Browser système avviato (fallback): {system_chromium}")

        self._context = await self._browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/125.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1280, "height": 900},
            locale="en-US"
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

    @staticmethod
    def _find_non_snap_chromium():
        """
        Cherche un Chromium système qui n'est PAS un wrapper snap.

        Sur Ubuntu 22.04+, `/usr/bin/chromium-browser` est un script qui
        appelle `snap run chromium`, et le snap chromium ne tourne pas
        depuis un cgroup non-snap (typique d'un service systemd). On le
        détecte de deux manières (cumulatives) :
          1. realpath traverse-t-il /snap/... ?
          2. les premiers Ko du fichier contiennent-ils 'snap run' / '/snap/' ?

        Returns:
            Path d'un binaire utilisable, ou None si aucun valide.
        """
        import shutil
        import os

        candidates = [
            shutil.which("google-chrome-stable"),  # apt google-chrome, jamais snap
            shutil.which("google-chrome"),
            shutil.which("chromium"),
            shutil.which("chromium-browser"),
        ]
        for path in candidates:
            if not path:
                continue
            try:
                real = os.path.realpath(path)
                if "/snap/" in real:
                    logger.debug(f"  ⏭️  Skip snap binary: {path} → {real}")
                    continue
                # Lire les 2 premiers Ko pour détecter un wrapper script snap
                with open(path, "rb") as f:
                    head = f.read(2048)
                if b"snap run" in head or b"/snap/" in head:
                    logger.debug(f"  ⏭️  Skip snap wrapper script: {path}")
                    continue
            except (OSError, IOError) as e:
                logger.debug(f"  ⚠️ Ne peut pas inspecter {path}: {e}")
                continue
            return path
        return None

    # ================================================================
    #  METODO PRINCIPALE
    # ================================================================

    async def get_bond_data(self, isin: str) -> BondData:
        """
        Recupera i dati di un'obbligazione da Deutsche Börse.
        
        Usa 3 livelli di fallback:
        1. Intercettazione API JSON
        2. DOM scraping
        3. Fonti alternative
        
        Args:
            isin: Codice ISIN dell'obbligazione
        
        Returns:
            BondData con tutti i campi disponibili
        """
        bond = BondData(isin=isin.strip(), fetch_date=date.today())
        
        # === LIVELLO 0: API diretta (più veloce, niente browser) ===
        try:
            bond = await self._fetch_via_direct_api(bond)
            if bond.current_price is not None:
                logger.info(f"  ✅ Dati recuperati via API diretta")
                return bond
        except Exception as e:
            logger.debug(f"  API diretta fallita: {e}")
        
        # === LIVELLO 1: SKIP — Redondant avec Level 0 (navigation directe) ===
        # Level 0 navigue déjà à la page exacte du bond. Si les API ne répondent
        # pas là, une recherche depuis la homepage ne fera pas mieux.
        # Désactivé pour vitesse (~15s économisés par bond en échec).
        
        
        # === LIVELLO 2: DOM scraping ===
        try:
            bond = await self._fetch_via_dom(bond)
            if bond.current_price is not None:
                logger.info(f"  ✅ Dati recuperati via DOM scraping")
                return bond
        except Exception as e:
            logger.debug(f"  DOM scraping fallito: {e}")
        
        # === LIVELLO 3: Fonti alternative ===
        try:
            bond = await self._fetch_via_alternative(bond)
            if bond.current_price is not None:
                logger.info(f"  ✅ Dati recuperati via fonte alternativa")
                return bond
        except Exception as e:
            logger.debug(f"  Fonte alternativa fallita: {e}")
        
        bond.error = "Nessuna fonte ha restituito dati per questo ISIN"
        logger.warning(f"  ⚠️ Nessun dato trovato per {isin}")
        return bond

    # ================================================================
    #  LIVELLO 0: API DIRETTA (più veloce, niente browser)
    # ================================================================

    async def _fetch_via_direct_api(self, bond: BondData) -> BondData:
        """
        Naviga direttamente alla pagina del bond (senza usare la ricerca).
        URL: https://live.deutsche-boerse.com/bond/{isin}
        Poi intercetta le API JSON caricate dalla pagina.
        """
        api_responses: Dict[str, Any] = {}
        
        async def capture_response(response):
            url = response.url
            # Exclure les endpoints qui ne sont PAS des données bond :
            # - /unleash : feature flags Unleash (toggles avec slugs type
            #   "boersen-radio-20250805" qui polluaient bond.name)
            # - /mdstokenservice : auth tokens
            if '/unleash' in url or '/mdstokenservice' in url:
                return
            if ('api.live.deutsche-boerse.com' in url or
                'api.boerse-frankfurt.de' in url):
                try:
                    if response.status == 200:
                        content_type = response.headers.get('content-type', '')
                        if 'json' in content_type:
                            body = await response.json()
                            if body:  # Non vuoto
                                api_responses[url] = body
                                logger.debug(f"  📦 API bond: {url[:80]}")
                except Exception:
                    pass
        
        self._page.on("response", capture_response)
        
        try:
            # Naviga DIRETTAMENTE alla pagina del bond
            bond_url = f"{self.BASE_URL}/bond/{bond.isin.lower()}"
            logger.debug(f"  Navigazione diretta: {bond_url}")
            
            await self._page.goto(
                bond_url,
                wait_until="domcontentloaded",
                timeout=self.timeout
            )
            
            # Aspetta che JavaScript carichi i dati
            await self._page.wait_for_load_state("networkidle")
            await self._page.wait_for_timeout(2000)
            
            # Analizza le risposte API
            logger.debug(f"  API catturate: {len(api_responses)}")
            for url, data in api_responses.items():
                logger.debug(f"    {url[:80]}: {json.dumps(data)[:100]}")
            
            bond = self._parse_api_responses(bond, api_responses)
            
            # Se API non ha dato il prezzo, prova DOM scraping sulla pagina già caricata
            if bond.current_price is None:
                bond = await self._fetch_via_dom(bond)
            
        finally:
            self._page.remove_listener("response", capture_response)
        
        return bond

    # ================================================================
    #  LIVELLO 1: INTERCETTAZIONE API JSON (più robusto)
    # ================================================================

    async def _fetch_via_api_intercept(self, bond: BondData) -> BondData:
        """
        Intercetta le risposte JSON delle API interne del sito.
        
        Quando il sito carica una pagina bond, il frontend Angular fa
        chiamate XHR/fetch al backend. Queste risposte contengono i dati
        in formato JSON strutturato.
        
        Vantaggi:
        - Non dipende dal layout HTML (robusto ai redesign)
        - Dati già strutturati in JSON
        - Più informazioni disponibili rispetto al DOM
        """
        api_responses: Dict[str, Any] = {}
        
        async def capture_response(response):
            """Cattura tutte le risposte API JSON."""
            url = response.url
            # Intercetta qualsiasi risposta JSON dalle API del sito
            if ('api.boerse-frankfurt.de' in url or 
                'api.deutsche-boerse.com' in url or
                'live.deutsche-boerse.com' in url or
                '/api/' in url):
                try:
                    if response.status == 200:
                        content_type = response.headers.get('content-type', '')
                        if 'json' in content_type:
                            body = await response.json()
                            api_responses[url] = body
                            logger.debug(f"  📦 API intercettata: {url}")
                except Exception:
                    pass
        
        # Registra il listener PRIMA della navigazione
        self._page.on("response", capture_response)
        
        try:
            # Naviga alla homepage (reindirizza automaticamente a live.deutsche-boerse.com)
            await self._page.goto(
                f"{self.BASE_URL}/en", 
                wait_until="domcontentloaded", 
                timeout=self.timeout
            )
            await self._page.wait_for_timeout(1500)
            
            # Cerca l'ISIN nella barra di ricerca Angular Material
            # Il sito usa Angular Material: input con id="mat-input-boerse-frankfurt0"
            search_selectors = [
                'input[id*="mat-input"]',
                'input[placeholder*="Name"]',
                'input[placeholder*="ISIN"]',
                'input[placeholder*="Search"]',
                'input[placeholder*="WKN"]',
                'input[type="search"]',
                'input[type="text"]',
            ]
            
            search_input = None
            for selector in search_selectors:
                locator = self._page.locator(selector).first
                try:
                    if await locator.is_visible(timeout=2000):
                        search_input = locator
                        logger.debug(f"  Search input trovato: {selector}")
                        break
                except Exception:
                    continue
            
            if not search_input:
                logger.warning("  ⚠️ Barra di ricerca non trovata")
                return bond
            
            await search_input.click()
            await self._page.wait_for_timeout(300)
            await search_input.fill(bond.isin)
            await self._page.wait_for_timeout(1500)
            
            # Clicca sul risultato Bond nel dropdown autocomplete
            bond_result = None
            result_selectors = [
                'mat-option:has-text("Bond")',
                '[role="option"]:has-text("Bond")',
                '.search-result:has-text("Bond")',
                f'text={bond.isin}',
            ]
            
            for selector in result_selectors:
                locator = self._page.locator(selector).first
                try:
                    if await locator.is_visible(timeout=3000):
                        bond_result = locator
                        logger.debug(f"  Risultato trovato: {selector}")
                        break
                except Exception:
                    continue
            
            if bond_result:
                await bond_result.click()
                # Aspetta che le API rispondano
                await self._page.wait_for_load_state("networkidle")
                await self._page.wait_for_timeout(2000)
            else:
                logger.warning("  ⚠️ Nessun risultato nel dropdown")
            
            # Analizza le risposte API catturate
            logger.debug(f"  API catturate: {len(api_responses)}")
            bond = self._parse_api_responses(bond, api_responses)
            
        finally:
            self._page.remove_listener("response", capture_response)
        
        return bond
    
    def _parse_api_responses(self, bond: BondData, responses: Dict[str, Any]) -> BondData:
        """
        Analizza tutte le risposte API catturate per estrarre i dati del bond.
        
        Cerca pattern comuni nelle risposte JSON:
        - prezzo (price, lastPrice, last, close)
        - cedola (coupon, couponRate, interestRate)
        - scadenza (maturity, maturityDate, expirationDate)
        - ecc.
        """
        for url, data in responses.items():
            if not isinstance(data, dict):
                continue

            logger.debug(f"  Analisi risposta: {url}")
            logger.debug(f"  Chiavi: {list(data.keys()) if isinstance(data, dict) else 'non-dict'}")

            # Cerca ricorsivamente i campi nei dati JSON
            self._extract_fields_recursive(bond, data, depth=0, max_depth=5)

        return bond
    
    def _extract_fields_recursive(self, bond: BondData, data: Any, depth: int, max_depth: int):
        """
        Cerca ricorsivamente nei dati JSON i campi che ci interessano.
        
        Questo è il cuore della robustezza: non cerchiamo un campo
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
                            logger.debug(f"    💰 Prezzo trovato: {key}={value}")
                
                # --- CEDOLA ---
                if bond.coupon_rate is None and value is not None:
                    if key_lower in ('coupon', 'couponrate', 'interestrate',
                                     'nominalinterest', 'couponpercent'):
                        if isinstance(value, (int, float)) and 0 < value < 20:
                            bond.coupon_rate = float(value)
                            logger.debug(f"    📊 Cedola trovata: {key}={value}")
                
                # --- SCADENZA ---
                if bond.maturity_date is None and value is not None:
                    if key_lower in ('maturity', 'maturitydate', 'expirationdate',
                                     'redemptiondate', 'enddate'):
                        parsed = self._parse_json_date(value)
                        if parsed:
                            bond.maturity_date = parsed
                            logger.debug(f"    📅 Scadenza trovata: {key}={value}")
                
                # --- DATA EMISSIONE ---
                if bond.issue_date is None and value is not None:
                    if key_lower in ('issuedate', 'emissiondate', 'startdate',
                                     'firsttradingdate'):
                        parsed = self._parse_json_date(value)
                        if parsed:
                            bond.issue_date = parsed
                
                # --- NOME ---
                # On retire 'title' (trop générique : matche les feature flags
                # Unleash chargés en marge — ex: toggles[0].name="boersen-radio-20250805").
                # On garde 'issuer' qui est la source la plus fiable, observée
                # dans master_data_bond?isin=... — exposée explicitement par
                # Deutsche Börse pour identifier l'émetteur.
                # En plus : anti-slug — un vrai nom d'émetteur a forcément un
                # espace OU une majuscule.
                if not bond.name and value is not None:
                    if key_lower in ('name', 'instrumentname', 'shortname',
                                     'longname', 'designation', 'issuer'):
                        if isinstance(value, str) and len(value) > 5:
                            if ' ' in value or any(c.isupper() for c in value):
                                bond.name = value
                            else:
                                logger.debug(
                                    f"    🚫 Nom rejeté (slug suspect): {value!r}"
                                )
                
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
                if bond.rating is None:
                    if key_lower in ('rating', 'sprating', 'moodyrating',
                                     'fitchrating', 'creditrating'):
                        if isinstance(value, str) and 1 <= len(value) <= 10:
                            bond.rating = value
                
                # --- MIN PIECE ---
                if bond.min_piece is None:
                    if key_lower in ('minimumdenomination', 'smallestunit', 'minpiece',
                                     'minimumtradableunit', 'lotsize', 'minlot',
                                     'smallesttransferableunit', 'denomination'):
                        if value is not None:
                            bond.min_piece = str(value)
                
                # Ricorsione nei sotto-oggetti
                if isinstance(value, (dict, list)):
                    self._extract_fields_recursive(bond, value, depth + 1, max_depth)
        
        elif isinstance(data, list):
            for item in data[:10]:  # Limita la profondità nelle liste
                self._extract_fields_recursive(bond, item, depth + 1, max_depth)

    # ================================================================
    #  LIVELLO 2: DOM SCRAPING (fallback)
    # ================================================================

    async def _fetch_via_dom(self, bond: BondData) -> BondData:
        """
        Fallback: estrae i dati leggendo il testo della pagina renderizzata.
        Più fragile ma funziona come backup.
        """
        page = self._page
        
        try:
            # Leggi tutto il testo della pagina
            page_text = await page.inner_text('body')
            
            # Cerca il nome nel titolo
            try:
                h1 = await page.locator('h1').first.inner_text(timeout=3000)
                if h1 and not bond.name:
                    bond.name = h1.strip()
            except Exception:
                pass
            
            # Analizza il testo cercando pattern
            lines = page_text.split('\n')
            for i, line in enumerate(lines):
                line_clean = line.strip()
                line_lower = line_clean.lower()
                
                # Cerca il prezzo
                if bond.current_price is None:
                    if any(kw in line_lower for kw in ['last price', 'price', 'kurs', 'close']):
                        # Prova le righe vicine per il valore
                        for j in range(max(0, i-1), min(len(lines), i+3)):
                            price = self._extract_number_from_text(lines[j])
                            if price and 10 < price < 300:
                                bond.current_price = price
                                break
                
                # Cerca la cedola
                if bond.coupon_rate is None:
                    if any(kw in line_lower for kw in ['coupon', 'kupon', 'interest']):
                        pct = self._extract_percentage_from_text(line_clean)
                        if pct:
                            bond.coupon_rate = pct
                        else:
                            for j in range(i, min(len(lines), i+2)):
                                pct = self._extract_percentage_from_text(lines[j])
                                if pct:
                                    bond.coupon_rate = pct
                                    break
                
                # Cerca la scadenza
                if bond.maturity_date is None:
                    if any(kw in line_lower for kw in ['maturity', 'fälligkeit']):
                        d = self._extract_date_from_text(line_clean)
                        if not d:
                            for j in range(i, min(len(lines), i+2)):
                                d = self._extract_date_from_text(lines[j])
                                if d:
                                    break
                        if d:
                            bond.maturity_date = d
        except Exception as e:
            logger.debug(f"  DOM scraping errore: {e}")
        
        return bond

    # ================================================================
    #  LIVELLO 3: FONTI ALTERNATIVE (secondo fallback)
    # ================================================================

    async def _fetch_via_alternative(self, bond: BondData) -> BondData:
        """
        Secondo fallback: prova fonti alternative per i dati del bond.
        Usa siti che non richiedono JavaScript rendering.
        """
        # Prova con una ricerca generica
        try:
            search_url = (
                f"https://www.google.com/finance/quote/{bond.isin}:FRA"
            )
            # Per ora logga che il fallback è disponibile
            logger.debug(f"  Fonte alternativa non ancora implementata")
        except Exception:
            pass
        
        return bond

    # ================================================================
    #  UTILITY
    # ================================================================

    def _parse_json_date(self, value) -> Optional[date]:
        """Converte vari formati data JSON in oggetto date."""
        if isinstance(value, str):
            # ISO format: "2033-07-03T00:00:00"
            for fmt in ('%Y-%m-%dT%H:%M:%S', '%Y-%m-%d', '%d.%m.%Y', '%d/%m/%Y'):
                try:
                    return datetime.strptime(value[:19], fmt).date()
                except ValueError:
                    continue
            
            # Timestamp in ms
            if value.isdigit() and len(value) > 10:
                try:
                    return datetime.fromtimestamp(int(value) / 1000).date()
                except Exception:
                    pass
        
        elif isinstance(value, (int, float)):
            # Timestamp in secondi o ms
            try:
                if value > 1e12:  # ms
                    return datetime.fromtimestamp(value / 1000).date()
                elif value > 1e9:  # secondi
                    return datetime.fromtimestamp(value).date()
            except Exception:
                pass
        
        return None
    
    def _extract_number_from_text(self, text: str) -> Optional[float]:
        """Estrae un numero decimale dal testo."""
        matches = re.findall(r'(\d+[.,]\d+)', text)
        for m in matches:
            try:
                return float(m.replace(',', '.'))
            except ValueError:
                continue
        return None
    
    def _extract_percentage_from_text(self, text: str) -> Optional[float]:
        """Estrae una percentuale dal testo."""
        match = re.search(r'(\d+[.,]?\d*)\s*%', text)
        if match:
            val = float(match.group(1).replace(',', '.'))
            if 0 < val < 20:
                return val
        return None
    
    def _extract_date_from_text(self, text: str) -> Optional[date]:
        """Estrae una data dal testo."""
        # DD.MM.YYYY
        match = re.search(r'(\d{2})[./](\d{2})[./](\d{4})', text)
        if match:
            try:
                return date(int(match.group(3)), int(match.group(2)), int(match.group(1)))
            except ValueError:
                pass
        # YYYY-MM-DD
        match = re.search(r'(\d{4})-(\d{2})-(\d{2})', text)
        if match:
            try:
                return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
            except ValueError:
                pass
        return None

    # ================================================================
    #  BATCH
    # ================================================================

    async def get_multiple_bonds(self, isins: List[str], delay: float = 2.0) -> List[BondData]:
        """
        Recupera dati per più obbligazioni.
        
        Args:
            isins: Lista di codici ISIN
            delay: Pausa in secondi tra una richiesta e l'altra
        
        Returns:
            Lista di BondData
        """
        results = []
        total = len(isins)
        
        for i, isin in enumerate(isins, 1):
            logger.info(f"[{i}/{total}] {isin}")
            bond = await self.get_bond_data(isin)
            results.append(bond)
            
            if bond.error:
                logger.warning(f"  ⚠️ {bond.error}")
            elif bond.current_price:
                logger.info(
                    f"  ✅ {bond.name or isin} — "
                    f"Prezzo: {bond.current_price}, "
                    f"Cedola: {bond.coupon_rate}%"
                )
            
            if i < total:
                await self._page.wait_for_timeout(int(delay * 1000))
        
        success = sum(1 for b in results if b.current_price is not None)
        logger.info(f"\n📊 Risultato: {success}/{total} bond recuperati con successo")
        
        return results
