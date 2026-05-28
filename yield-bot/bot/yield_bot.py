"""
Orchestratore principale del Bot Calcul Yield.

Coordina scraper, calcolatore e processore Excel per aggiornare
automaticamente i yield delle obbligazioni.

Rate limit: max 5 esecuzioni con scraping al giorno.
Il ricalcolo yield (senza scraping) è illimitato.
"""

import asyncio
import logging
import os
from datetime import date
from typing import List, Optional

from calculator.yield_calculator import (
    calculate_yield_at_current_price,
    calculate_yield_zero_coupon,
    calculate_yield_perpetual,
    extract_coupon_from_name,
    extract_maturity_from_name,
)
from excel.processor import BondExcelProcessor
from scraper.boerse_scraper import BoerseScraper
from scraper.models import BondData
from bot.rate_limiter import check_rate_limit, record_run, get_usage_info

logger = logging.getLogger(__name__)


class YieldBot:
    """
    Bot principale che coordina il flusso:
    1. Legge gli ISIN dal file Excel
    2. Recupera i prezzi da Deutsche Börse
    3. Calcola il yield con la formula personalizzata
    4. Aggiorna il file Excel
    
    ⚠️ Limite: max 5 esecuzioni scraping/giorno (ricalcolo illimitato)
    """
    
    def __init__(
        self,
        excel_path: str,
        headless: bool = True,
        delay: float = 2.0,
        price_threshold: float = None
    ):
        """
        Args:
            excel_path: Percorso al file Excel delle obbligazioni
            headless: Se True, browser invisibile
            delay: Pausa tra richieste (secondi)
            price_threshold: Seuil de prix pour coloration rouge/noir (défaut: 101)
        """
        self.excel_path = excel_path
        self.headless = headless
        self.delay = delay
        self.processor = BondExcelProcessor(excel_path, price_threshold=price_threshold)
        self.stats = {
            'total': 0,
            'updated': 0,
            'errors': 0,
            'skipped': 0,
        }
        # Rating fetcher lazy : on instancie au premier appel pour éviter
        # de charger scrapling au boot quand on n'en a pas besoin.
        self._rating_fetcher = None

    def _fetch_rating_fallback(self, isin: str, issuer: str) -> Optional[str]:
        """
        Récupère un rating depuis les sources fallback (Fitch/DDG/SEC) quand
        Deutsche Börse n'en expose pas. Retourne None si rien trouvé.

        Lazy-loaded — n'importe scrapling qu'au premier appel.
        Cache 30j par ISIN via ~/.cache/yield-bot-ratings.json.
        """
        try:
            if self._rating_fetcher is None:
                from scraper.rating_fetcher import RatingFetcher
                # use_camoufox respecte la variable d'env pour pouvoir désactiver
                # la branche Fitch direct (utile si Camoufox cassé sur Ubuntu 26.04)
                use_cam = not os.environ.get('YIELD_BOT_DISABLE_CAMOUFOX')
                # fitch_only=True : politique décidée 2026-05-28 (cf. daily note
                # entrée 14:30). On accepte SEULEMENT des ratings Fitch — pas
                # de fallback S&P/Moody's converti pour ne pas polluer l'Excel.
                # Si pas de Fitch trouvé → market_data.rating reste None →
                # processor.update_rating ne touche pas la cellule.
                # La clé Brave Search est auto-récupérée via env BRAVE_SEARCH_API_KEY.
                self._rating_fetcher = RatingFetcher(
                    use_camoufox=use_cam,
                    fitch_only=True,
                )
            rating, agency = self._rating_fetcher.fetch_rating(isin, issuer)
            if rating:
                logger.info(f"   📊 Rating récupéré: {rating} ({agency})")
            return rating
        except ImportError:
            logger.debug("   scrapling non installé, skip rating fallback")
            return None
        except Exception as e:
            logger.warning(f"   ⚠️ Rating fetcher exception: {e!r}")
            return None

    def _check_scraping_allowed(self) -> bool:
        """Verifica se lo scraping è permesso (max 5/giorno)."""
        allowed, remaining = check_rate_limit()
        logger.info(get_usage_info())
        if not allowed:
            logger.error(
                "🚫 Limite giornaliero raggiunto (5/5 esecuzioni).\n"
                "   Usa --recalculate per ricalcolare senza scraping (illimitato).\n"
                "   Il contatore si resetta a mezzanotte."
            )
        return allowed
    
    async def run_all(self, update_price: bool = True, save: bool = True, skip_count: int = 0) -> dict:
        """
        Aggiorna il yield di TUTTE le obbligazioni.
        
        Args:
            update_price: Se True, aggiorna anche il prezzo dal mercato
            save: Se True, salva il file alla fine
            skip_count: Numero di bond da saltare (per resume)
        
        Returns:
            Statistiche dell'operazione
        """
        # Rate limit solo per scraping
        if update_price and not self._check_scraping_allowed():
            return {'error': 'Limite giornaliero raggiunto (5/5)'}
        
        logger.info("=" * 60)
        logger.info("🚀 Avvio aggiornamento yield per tutte le obbligazioni")
        logger.info("=" * 60)
        
        all_bonds = self.processor.get_all_bonds()
        
        if skip_count > 0:
            logger.info(f"⏭️  Skip dei primi {skip_count} bond (reprise)")
            all_bonds = all_bonds[skip_count:]
        
        self.stats['total'] = len(all_bonds)
        logger.info(self.processor.get_summary())
        
        if update_price:
            record_run()  # Registra l'esecuzione
            consecutive_fails = 0
            async with BoerseScraper(headless=self.headless) as scraper:
                for bond_info in all_bonds:
                    result = await self._process_bond(bond_info, scraper, update_price=True)
                    
                    # Fast-fail: si 3+ scraping échouent d'affilée, accélérer
                    if result == 'scrape_failed':
                        consecutive_fails += 1
                        if consecutive_fails >= 3:
                            await asyncio.sleep(0.5)
                            continue
                    else:
                        consecutive_fails = 0
                    
                    await asyncio.sleep(self.delay)
        else:
            # Ricalcolo senza scraping — nessun limite
            for bond_info in all_bonds:
                self._recalculate_yield(bond_info)
        
        if save:
            self.processor.save(backup=True)
        
        self._print_summary()
        return self.stats
    
    async def run_sheet(self, sheet_name: str, update_price: bool = True, save: bool = True) -> dict:
        """Aggiorna solo un foglio specifico."""
        if update_price and not self._check_scraping_allowed():
            return {'error': 'Limite giornaliero raggiunto (5/5)'}
        
        logger.info(f"🚀 Aggiornamento foglio: {sheet_name}")
        
        bonds = self.processor.get_bonds_by_sheet(sheet_name)
        self.stats['total'] = len(bonds)
        
        if update_price:
            record_run()
            async with BoerseScraper(headless=self.headless) as scraper:
                for bond_info in bonds:
                    await self._process_bond(bond_info, scraper, update_price=True)
                    await asyncio.sleep(self.delay)
        else:
            for bond_info in bonds:
                self._recalculate_yield(bond_info)
        
        if save:
            self.processor.save(backup=True)
        
        self._print_summary()
        return self.stats
    
    async def run_single(self, isin: str, update_price: bool = True, save: bool = True) -> dict:
        """Aggiorna un singolo ISIN."""
        if update_price and not self._check_scraping_allowed():
            return {'error': 'Limite giornaliero raggiunto (5/5)'}
        
        logger.info(f"🚀 Aggiornamento singolo: {isin}")
        
        all_bonds = self.processor.get_all_bonds()
        target = None
        
        for bond_info in all_bonds:
            if bond_info['isin'].strip() == isin.strip():
                target = bond_info
                break
        
        if not target:
            logger.error(f"❌ ISIN non trovato nel file: {isin}")
            return {'error': f'ISIN non trovato: {isin}'}
        
        self.stats['total'] = 1
        
        if update_price:
            record_run()
            async with BoerseScraper(headless=self.headless) as scraper:
                await self._process_bond(target, scraper, update_price=True)
        else:
            self._recalculate_yield(target)
        
        if save:
            self.processor.save(backup=True)
        
        self._print_summary()
        return self.stats
    
    async def _process_bond(
        self,
        bond_info: dict,
        scraper: BoerseScraper,
        update_price: bool = True
    ) -> str:
        """Processa un singolo bond: scraping + calcolo yield + update Excel.
        Returns: 'ok', 'scrape_failed', 'skipped', 'error'
        """
        isin = bond_info['isin']
        name = bond_info['name']
        sheet = bond_info['sheet']
        row = bond_info['row']
        
        logger.info(f"\n📌 [{sheet}:{row}] {name}")
        logger.info(f"   ISIN: {isin}")
        
        market_data = None
        
        try:
            # 1. Recupera prezzo dal mercato
            if update_price:
                market_data = await scraper.get_bond_data(isin)
                
                if market_data.error:
                    logger.warning(f"   ⚠️ Scraping fallito: {market_data.error}")
                    # Usa il prezzo esistente nel file
                    current_price = bond_info.get('price')
                    scrape_ok = False
                    # Pallino rosso = ISIN non trouvé / erreur scraping
                    self.processor.mark_red_dot(sheet, row)
                else:
                    current_price = market_data.current_price or bond_info.get('price')
                    scrape_ok = True
            else:
                current_price = bond_info.get('price')
            
            if not current_price:
                logger.warning(f"   ⚠️ Nessun prezzo disponibile")
                self.processor.mark_orange_dot(sheet, row)
                self.stats['skipped'] += 1
                return 'skipped'
            
            # Controlla se il prezzo è testo (es: "rimborsata?")
            try:
                price_float = float(current_price)
            except (ValueError, TypeError):
                logger.warning(f"   ⚠️ Prezzo non numerico: '{current_price}'")
                self.processor.mark_orange_dot(sheet, row)
                self.stats['skipped'] += 1
                return 'skipped'
            
            # 2. Estrai cedola e scadenza dal nome Excel
            coupon = extract_coupon_from_name(name)
            maturity = extract_maturity_from_name(name)
            
            # 2b. Fallback: si le nom Excel est incomplet (ex: "Dominion"),
            #     utiliser les données scrapées de Deutsche Börse
            if market_data and not market_data.error:
                if coupon is None and market_data.coupon_rate is not None:
                    coupon = market_data.coupon_rate
                    logger.info(f"   🔄 Cedola dal scraper: {coupon}%")
                if maturity is None and market_data.maturity_date is not None:
                    maturity = market_data.maturity_date
                    logger.info(f"   🔄 Scadenza dal scraper: {maturity}")
            
            # 3. Aggiorna subito nome/champs vides/couleur (AVANT il calcolo yield)
            #    Così il nome viene corretto anche se il yield fallisce
            if market_data and not market_data.error:
                self.processor.update_price(sheet, row, market_data.current_price) if market_data.current_price else None

                # Si Deutsche Börse n'a pas exposé de rating, tente le fetcher
                # multi-source (Fitch via Scrapling/Camoufox → DDG news → SEC EDGAR).
                #
                # ⚠️ Désactivé PAR DÉFAUT (2026-05-28) : les sources publiques
                # gratuites sont toutes bloquées au moment de l'investigation —
                # Fitch+Cloudflare, Cbonds ratings paywallés, DDG renvoie sa
                # homepage JS, Brave rate-limite, Google crash Camoufox,
                # SEC EDGAR parsing à finaliser. Activable via
                # YIELD_BOT_ENABLE_RATING_FETCHER=1 quand on a une source qui
                # marche (intégration FinnHub free tier prévue, cf. daily 2026-05-28).
                if (not market_data.rating or market_data.rating == '?') and market_data.name:
                    if os.environ.get('YIELD_BOT_ENABLE_RATING_FETCHER'):
                        rating_extra = self._fetch_rating_fallback(isin, market_data.name)
                        if rating_extra:
                            market_data.rating = rating_extra

                if market_data.rating and market_data.rating != '?':
                    self.processor.update_rating(sheet, row, market_data.rating)
                self.processor.fill_empty_fields(sheet, row, market_data)
                self.processor.update_name(sheet, row, market_data)
                self.processor.apply_price_color(sheet, row, price_float)
            
            # 4. Calcola il yield in base al tipo di bond
            try:
                if coupon is not None and coupon == 0 and maturity:
                    # Zero-coupon bond
                    new_yield = calculate_yield_zero_coupon(
                        current_price=price_float,
                        maturity_date=maturity,
                    )
                    logger.info(f"   📊 Zero-coupon: Prezzo: {current_price}, Scadenza: {maturity}")
                    logger.info(f"   📈 Yield zero-coupon: {new_yield:.6f} ({new_yield*100:.4f}%)")
                
                elif coupon is not None and coupon > 0 and not maturity:
                    # Obbligazione perpetua
                    new_yield = calculate_yield_perpetual(
                        coupon_rate=coupon,
                        current_price=price_float,
                    )
                    logger.info(f"   📊 Perpetua: Cedola: {coupon}%, Prezzo: {current_price}")
                    logger.info(f"   📈 Yield perpetuo: {new_yield:.6f} ({new_yield*100:.4f}%)")
                
                elif coupon is not None and coupon > 0 and maturity:
                    # Bond standard
                    new_yield = calculate_yield_at_current_price(
                        coupon_rate=coupon,
                        current_price=price_float,
                        maturity_date=maturity,
                    )
                    logger.info(f"   📊 Cedola: {coupon}%, Prezzo: {current_price}, Scadenza: {maturity}")
                    logger.info(f"   📈 Yield calcolato: {new_yield:.6f} ({new_yield*100:.4f}%)")
                
                else:
                    logger.warning(f"   ⚠️ Dati insufficienti (cedola={coupon}, scadenza={maturity})")
                    self.processor.mark_orange_dot(sheet, row)
                    self.stats['skipped'] += 1
                    return 'skipped'
                
                # 5. Aggiorna il yield nel file Excel
                self.processor.update_yield(sheet, row, new_yield)
                
                # Couleur aussi pour le mode sans scraping
                if not market_data or market_data.error:
                    self.processor.apply_price_color(sheet, row, price_float)
                
                # Si tout a réussi (scraping OK + yield calculé) → enlever le pallino
                if update_price and scrape_ok:
                    self.processor.clear_dot(sheet, row)
                
                self.stats['updated'] += 1
                return 'scrape_failed' if (update_price and not scrape_ok) else 'ok'
                
            except ValueError as e:
                logger.warning(f"   ⚠️ Errore calcolo yield: {e}")
                self.stats['errors'] += 1
                return 'error'
            
        except Exception as e:
            logger.error(f"   ❌ Errore: {e}")
            self.stats['errors'] += 1
            return 'error'
    
    def _recalculate_yield(self, bond_info: dict):
        """
        Ricalcola il yield usando i dati già presenti nel file Excel
        (senza fare scraping).
        """
        isin = bond_info['isin']
        name = bond_info['name']
        sheet = bond_info['sheet']
        row = bond_info['row']
        price = bond_info.get('price')
        
        logger.info(f"  [{sheet}:{row}] {name[:50]}")
        
        # Controlla prezzo
        if not price:
            logger.warning(f"    ⚠️ Nessun prezzo")
            self.processor.mark_orange_dot(sheet, row)
            self.stats['skipped'] += 1
            return
        
        try:
            price_float = float(price)
        except (ValueError, TypeError):
            logger.warning(f"    ⚠️ Prezzo non numerico: '{price}'")
            self.processor.mark_orange_dot(sheet, row)
            self.stats['skipped'] += 1
            return
        
        coupon = extract_coupon_from_name(name)
        maturity = extract_maturity_from_name(name)
        
        try:
            if coupon is not None and coupon == 0 and maturity:
                # Zero-coupon
                new_yield = calculate_yield_zero_coupon(
                    current_price=price_float,
                    maturity_date=maturity,
                )
                logger.info(f"    Zero-coupon: Yield={new_yield:.6f} ({new_yield*100:.4f}%)")
            
            elif coupon is not None and coupon > 0 and not maturity:
                # Perpetua
                new_yield = calculate_yield_perpetual(
                    coupon_rate=coupon,
                    current_price=price_float,
                )
                logger.info(f"    Perpetua: Yield={new_yield:.6f} ({new_yield*100:.4f}%)")
            
            elif coupon is not None and coupon > 0 and maturity:
                # Standard
                new_yield = calculate_yield_at_current_price(
                    coupon_rate=coupon,
                    current_price=price_float,
                    maturity_date=maturity,
                )
                old_yield = bond_info.get('yield')
                logger.info(f"    Yield: {old_yield} → {new_yield:.6f}")
            
            else:
                logger.warning(f"    ⚠️ Dati insufficienti (cedola={coupon}, scadenza={maturity})")
                self.processor.mark_orange_dot(sheet, row)
                self.stats['skipped'] += 1
                return
            
            self.processor.update_yield(sheet, row, new_yield)
            self.processor.apply_price_color(sheet, row, price_float)
            self.stats['updated'] += 1
            
        except ValueError as e:
            logger.warning(f"    ⚠️ Errore: {e}")
            self.stats['errors'] += 1
    
    def _print_summary(self):
        """Stampa il riepilogo delle operazioni."""
        logger.info("\n" + "=" * 60)
        logger.info("📊 RIEPILOGO")
        logger.info("=" * 60)
        logger.info(f"  Totale obbligazioni: {self.stats['total']}")
        logger.info(f"  ✅ Aggiornate:       {self.stats['updated']}")
        logger.info(f"  ⚠️  Saltate:          {self.stats['skipped']}")
        logger.info(f"  ❌ Errori:           {self.stats['errors']}")
        logger.info("=" * 60)
