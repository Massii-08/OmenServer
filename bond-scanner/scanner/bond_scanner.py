"""
Orchestratore principale del Bond Scanner.

Coordina lo scraping del mercato, il filtraggio, il calcolo yield
e la generazione del report Excel.

Flusso:
1. Scansiona Deutsche Börse per ogni valuta (EUR, USD, GBP)
2. Filtra secondo i criteri (prezzo, scadenza, yield, rating)
3. Calcola il yield per ogni bond filtrato
4. Genera il report Excel nel formato "Lista acquisti"

Rate limit: max 2 scansioni al giorno.
Tutti i log sono in italiano 🇮🇹
"""

import asyncio
import logging
import time
from datetime import date
from typing import List, Optional

from scanner.models import ScannedBond
from scanner.market_scraper import MarketScraper
from scanner.scoring import top_n_per_currency, compute_quotas
from scanner.found_store import FoundStore
from filter.criteria import ScanCriteria
from calculator.yield_calculator import (
    calculate_yield_at_current_price,
    calculate_yield_zero_coupon,
    calculate_yield_perpetual,
)
from excel.report_generator import ReportGenerator
from bot.rate_limiter import check_rate_limit, record_scan, get_usage_info

logger = logging.getLogger(__name__)


class BondScanner:
    """
    Bot principale che coordina la scansione del mercato obbligazionario.

    ⚠️ Limite: max 2 scansioni al giorno.
    """

    def __init__(
        self,
        criteria: ScanCriteria = None,
        headless: bool = True,
        delay: float = 1.0,
        price_threshold: float = 101.0,
        target_count: int = 20,
        dedup: bool = True,
    ):
        """
        Args:
            criteria: Criteri di filtro configurabili
            headless: Se True, browser invisibile
            delay: Pausa tra le richieste (secondi)
            price_threshold: Soglia di prezzo per la colorazione rosso/nero
            target_count: Numero target di bond nell'Excel finale (Task 15,
                          2026-05-28). Il pool completo viene comunque scansionato
                          per avere abbastanza candidati da scorere e ordinare;
                          alla fine si prendono i top-N per valuta secondo lo
                          split equilibrato (1 valuta=100, 2=50/50, 3=34/33/33).
                          0 = nessun cap (rende l'intero pool, sconsigliato).
        """
        self.criteria = criteria or ScanCriteria()
        self.headless = headless
        self.delay = delay
        self.price_threshold = price_threshold
        self.target_count = target_count
        # Dédup persistante inter-scans (2026-05-28) : un bond déjà livré dans
        # un Excel précédent n'est jamais re-recherché. Économise aussi la
        # quota Brave. Set dedup=False pour désactiver (ex. test).
        self.dedup = dedup
        self.found_store = FoundStore() if dedup else None
        # Task 18 (2026-05-28) : timeout hard di 45 min per evitare scansioni
        # che si bloccano indefinitamente (Brave rate-limit a cascata, Deutsche
        # Börse lento, ecc.). Allo scadere si interrompe la raccolta e si
        # genera comunque l'Excel con i bond trovati fin qui.
        self.scan_timeout_seconds = 45 * 60
        self.stats = {
            'total_scanned': 0,
            'total_filtered': 0,
            'total_with_yield': 0,
            'total_discarded': 0,
            'total_errors': 0,
            'by_currency': {},
            'timed_out': False,        # True se _scan_timed_out() ha sparato
            'quota_exhausted': False,  # True se Brave Search ha sparato 429 quota
            'elapsed_seconds': 0,      # tempo totale della fase scan
        }
        self._stopped = False
        self._scan_start: Optional[float] = None  # time.monotonic() al via di scan()
        # Budget Brave (2026-05-28, demande Massii) : nb max d'appels Brave
        # par scan. Élevé (1500) car la DÉDUP + le CACHE amortissent : un ISIN
        # déjà analysé n'est pas re-payé (cache hit), un bond déjà livré est
        # skippé (found_store). Donc chaque relance trouve du NOUVEAU sans
        # re-burn la quota. La détection 429 quota-exhausted (rating_providers)
        # reste le garde-fou si on dépasse les 1000/mois free.
        self._rating_calls = 0
        self.rating_budget = 1500
        # Brave free tier = 1 req/sec → on espace les appels pour éviter les
        # 429 transitoires (qui seraient pris à tort pour un quota épuisé).
        self._brave_min_interval = 1.1

    def _scan_timed_out(self) -> bool:
        """True se abbiamo superato self.scan_timeout_seconds dall'avvio."""
        if self._scan_start is None:
            return False
        return (time.monotonic() - self._scan_start) >= self.scan_timeout_seconds

    def stop(self):
        """Arresta la scansione in corso."""
        self._stopped = True
        logger.info("⏹ Arresto scansione richiesto...")

    async def scan(self, output_path: str = None) -> dict:
        """
        Esegue la scansione completa del mercato.

        Args:
            output_path: Percorso del file Excel di output.
                         Se None, genera un nome automatico.

        Returns:
            Dizionario con statistiche e percorso del file.
        """
        # Check rate limit
        allowed, remaining = check_rate_limit()
        logger.info(get_usage_info())

        if not allowed:
            logger.error(
                "🚫 Limite giornaliero raggiunto (2/2 scansioni).\n"
                "   Il contatore si resetta a mezzanotte."
            )
            return {'error': 'Limite giornaliero raggiunto (2/2)'}

        # Output path
        if output_path is None:
            today = date.today().strftime('%Y-%m-%d')
            output_path = f"Opportunita_Bond_{today}.xlsx"

        logger.info("=" * 60)
        logger.info("🚀 BOND SCANNER — Avvio scansione del mercato")
        logger.info("=" * 60)
        logger.info(f"📋 {self.criteria}")
        if self.target_count > 0:
            logger.info(f"🎯 Target Excel: {self.target_count} bond ({len(self.criteria.currencies)} valute)")
        logger.info(f"📂 Output: {output_path}")
        logger.info("")

        # Registra la scansione
        record_scan()

        # Task 18 — avvia il cronometro per il timeout 45 min
        self._scan_start = time.monotonic()
        logger.info(f"⏱ Timeout scan impostato a {self.scan_timeout_seconds // 60} min")

        all_filtered_bonds: List[ScannedBond] = []
        seen_isins: set = set()  # Deduplica globale tra scansioni multi-valuta

        # "Continue jusqu'au target" (2026-05-28) : quota par devise. Quand
        # une devise atteint son quota de bonds VALIDES, on arrête de la
        # scanner (early-stop) et on passe à la suivante. compute_quotas
        # répartit le target sur les devises (3 sur EUR seul = 3 ; 3 sur
        # EUR+USD+GBP = 1/1/1).
        currencies_list = list(self.criteria.currencies)
        quotas = compute_quotas(self.target_count, len(currencies_list)) if self.target_count > 0 else []
        currency_quota = dict(zip(currencies_list, quotas)) if quotas else {}

        async with MarketScraper(headless=self.headless) as scraper:
            for currency in self.criteria.currencies:
                if self._stopped:
                    logger.info("⏹ Scansione interrotta dall'utente")
                    break

                logger.info(f"\n{'─'*60}")
                logger.info(f"🔍 Scansione {currency}...")
                logger.info(f"{'─'*60}")

                try:
                    # 1. Scraping del mercato
                    # max_pages alto per garantire che ci siano abbastanza bond
                    # da filtrare per costituire un pool sufficiente al top-N
                    raw_bonds = await scraper.scan_market(
                        currency=currency,
                        max_pages=30,
                    )

                    currency_stats = {
                        'scanned': len(raw_bonds),
                        'enriched': 0,
                        'filtered': 0,
                        'discarded': 0,
                        'errors': 0,
                    }
                    self.stats['total_scanned'] += len(raw_bonds)

                    logger.info(f"\n📊 {currency}: {len(raw_bonds)} bond trovati sul mercato")

                    # 2. Pre-filtro rapido (dédup + prezzo + scadenza)
                    pre_filtered = []
                    skipped_known = 0
                    for bond in raw_bonds:
                        if self._stopped:
                            break

                        # Dédup persistante : skip les bonds déjà livrés dans
                        # un Excel précédent (le plus tôt = max d'économie,
                        # avant enrich ET avant Brave).
                        if self.found_store and self.found_store.contains(bond.isin):
                            skipped_known += 1
                            currency_stats['discarded'] += 1
                            continue

                        # Skip se mancano dati essenziali
                        if bond.current_price is None:
                            currency_stats['discarded'] += 1
                            continue

                        # Pre-filtro prezzo
                        if bond.current_price > self.criteria.max_price:
                            currency_stats['discarded'] += 1
                            continue

                        # Pre-filtro scadenza
                        if bond.maturity_date is not None:
                            years = bond.years_to_maturity()
                            if years is not None and (years <= 0 or years > self.criteria.max_maturity_years):
                                currency_stats['discarded'] += 1
                                continue

                        pre_filtered.append(bond)

                    if skipped_known:
                        logger.info(
                            f"  ♻️  Dédup : {skipped_known} bond déjà livrés "
                            f"dans un scan précédent → ignorés"
                        )

                    logger.info(f"  📋 Pre-filtro: {len(pre_filtered)} candidati "
                                f"(scartati {currency_stats['discarded']} per prezzo/scadenza/dati mancanti)")

                    # 3. Arricchimento dati + calcolo yield
                    for idx, bond in enumerate(pre_filtered):
                        if self._stopped:
                            break

                        # Task 18 — timeout 45 min : si interrompe la fase scan,
                        # si procede comunque alla generazione Excel con quello
                        # che si è raccolto fin qui (graceful degradation).
                        if self._scan_timed_out():
                            elapsed_min = (time.monotonic() - self._scan_start) / 60
                            logger.warning(
                                f"\n⏱ TIMEOUT raggiunto ({elapsed_min:.1f} min "
                                f">= {self.scan_timeout_seconds // 60} min). "
                                f"Interrompo la raccolta, genero l'Excel parziale."
                            )
                            self._stopped = True
                            self.stats['timed_out'] = True
                            break

                        # Task 15 : niente più early-stop sul count durante lo scan.
                        # Si raccoglie tutto il pool che passa i filtri, poi
                        # top_n_per_currency() applica il cap dopo lo scoring.
                        # Solo timeout + _stopped possono interrompere.

                        logger.info(f"\n  [{idx+1}/{len(pre_filtered)}] {bond.name[:50] if bond.name else bond.isin}")

                        try:
                            # Arricchisci con dati dalla pagina dettaglio
                            if not bond.is_complete():
                                await scraper.enrich_bond(bond)
                                currency_stats['enriched'] += 1
                                await asyncio.sleep(self.delay)

                            # Calcola il yield
                            if bond.is_complete():
                                self._calculate_yield(bond)
                            else:
                                logger.info(f"    ⚠️ Dati incompleti — skip yield")

                            # Pre-filter (Task 13, 2026-05-28) : verifica
                            # prezzo/yield/scadenza/valuta PRIMA di pagare la
                            # quota Brave Search. Risparmia ~80% di chiamate
                            # API per i bond che già sappiamo non passare i
                            # criteri di base. La Brave free tier vale 1000
                            # req/mese — meglio non sprecarla.
                            pre_match, pre_reason = self.criteria.matches(
                                bond, check_rating=False,
                            )
                            if not pre_match:
                                currency_stats['discarded'] += 1
                                self.stats['total_discarded'] += 1
                                logger.info(f"    ⊘ Pre-scartato: {pre_reason}")
                                continue

                            # Budget Brave (2026-05-28) : cap dur sur le nombre
                            # d'appels Brave par scan pour protéger la quota free
                            # (1000/mois). Au-delà, on arrête de rater cette devise
                            # et on classe ce qu'on a. Évite qu'un "tout le marché"
                            # avec des centaines de survivants ne vide la quota.
                            if self._rating_calls >= self.rating_budget:
                                logger.warning(
                                    f"  💸 Budget Brave atteint ({self.rating_budget} "
                                    f"appels) → arrêt rating {currency}, classement."
                                )
                                break

                            # Ora paga la chiamata Brave per ottenere il rating Fitch.
                            # Respect Brave 1 req/sec (évite les 429 transitoires).
                            self._rating_calls += 1
                            await asyncio.sleep(self._brave_min_interval)
                            await scraper.fetch_ratings(bond)

                            # Task post-15:30 (2026-05-28) — Brave quota check.
                            # Se Brave ha sparato un 429 "quota exhausted"
                            # (1000 req/mese free dépassées), interrompi tutto
                            # subito e genera l'Excel con i bond raccolti fin
                            # qui + banner d'avvertimento.
                            if scraper.quota_exhausted:
                                logger.error(
                                    "\n🚫 BRAVE QUOTA ÉPUISÉE — interrompo lo "
                                    "scan, genero l'Excel parziale."
                                )
                                self._stopped = True
                                self.stats['quota_exhausted'] = True
                                break

                            # Filtro completo (incl. rating, politica fitch_only)
                            matches, reason = self.criteria.matches(bond)
                            if matches:
                                # Deduplica globale
                                if bond.isin in seen_isins:
                                    logger.info(f"    ⚠️ Duplicato ISIN {bond.isin} — ignorato")
                                    continue
                                seen_isins.add(bond.isin)
                                all_filtered_bonds.append(bond)
                                currency_stats['filtered'] += 1
                                self.stats['total_filtered'] += 1  # ← Aggiornamento IMMEDIATO
                                yield_str = f"{bond.calculated_yield:.4%}" if bond.calculated_yield else '?'
                                logger.info(f"    ✅ ACCETTATO ({self.stats['total_filtered']} pool) "
                                            f"— Prezzo: {bond.current_price}, "
                                            f"Yield: {yield_str}, Rating: {bond.rating_display or '?'}")

                                # Best-N (2026-05-28, demande Massii) : PAS
                                # d'early-stop. On rate tous les survivants
                                # jusqu'au budget Brave (1500) / timeout / quota,
                                # puis top_n_per_currency garde les MEILLEURS par
                                # rating desc. La dédup + cache font que la
                                # prochaine relance trouve du nouveau sans re-payer.
                            else:
                                currency_stats['discarded'] += 1
                                self.stats['total_discarded'] += 1  # ← Aggiornamento IMMEDIATO
                                logger.info(f"    ❌ Scartato: {reason}")

                        except Exception as e:
                            logger.warning(f"    ❌ Errore: {e}")
                            currency_stats['errors'] += 1
                            self.stats['total_errors'] += 1

                    self.stats['by_currency'][currency] = currency_stats

                    logger.info(f"\n📊 {currency} completato: {currency_stats['filtered']} accettati, "
                                f"{currency_stats['discarded']} scartati, {currency_stats['errors']} errori")

                except Exception as e:
                    logger.error(f"❌ Errore scansione {currency}: {e}")
                    self.stats['total_errors'] += 1
                    self.stats['by_currency'][currency] = {'error': str(e)}

        # 4. Task 15 — scoring composito + top-N per valuta
        # Si calcola il punteggio Defensive (20% prezzo / 40% yield / 40% rating)
        # per ogni bond del pool. Poi si prende i top-K per valuta secondo la
        # quota equilibrata di compute_quotas(target_count, n_valute).
        if all_filtered_bonds and self.target_count > 0:
            logger.info(f"\n{'='*60}")
            logger.info(f"⚖️  Scoring composito + top-{self.target_count} per valuta...")
            logger.info(f"{'='*60}")
            top_by_currency = top_n_per_currency(
                bonds=all_filtered_bonds,
                target_count=self.target_count,
                currencies=list(self.criteria.currencies),
            )
            # Flatten preservando l'ordine delle valute (= ordine di iterazione
            # in self.criteria.currencies), e dentro ogni valuta l'ordine
            # composite-score desc viene già garantito da top_n_per_currency.
            ordered_bonds: List[ScannedBond] = []
            for currency in self.criteria.currencies:
                bonds_for_curr = top_by_currency.get(currency.upper(), [])
                ordered_bonds.extend(bonds_for_curr)
                logger.info(
                    f"  {currency}: {len(bonds_for_curr)} bond selezionati "
                    f"(pool iniziale {sum(1 for b in all_filtered_bonds if (b.currency or '').upper() == currency.upper())})"
                )
            all_filtered_bonds = ordered_bonds

        # 5. Genera il report Excel
        if all_filtered_bonds:
            logger.info(f"\n{'='*60}")
            logger.info(f"📝 Generazione report Excel ({len(all_filtered_bonds)} bond)...")
            logger.info(f"{'='*60}")

            generator = ReportGenerator(price_threshold=self.price_threshold)
            generator.generate(
                bonds=all_filtered_bonds,
                output_path=output_path,
                criteria_info=str(self.criteria),
                timed_out=self.stats.get('timed_out', False),
                quota_exhausted=self.stats.get('quota_exhausted', False),
            )

            self.stats['total_with_yield'] = sum(
                1 for b in all_filtered_bonds if b.calculated_yield is not None
            )
            self.stats['output_file'] = output_path

            # Dédup persistante : enregistre les bonds LIVRÉS (top-N final) pour
            # qu'ils ne réapparaissent jamais dans un scan futur. On enregistre
            # APRÈS génération de l'Excel pour ne marquer que ce qui a vraiment
            # été délivré à l'utilisateur.
            if self.found_store:
                added = self.found_store.add_many(all_filtered_bonds)
                self.stats['newly_recorded'] = added
                logger.info(
                    f"  ♻️  Dédup : {added} nouveaux bond enregistrés "
                    f"(total historique : {self.found_store.count()})"
                )
        else:
            logger.warning("⚠️ Nessuna obbligazione trovata con i criteri specificati!")
            self.stats['output_file'] = None

        # Task 18 — registra il tempo totale della fase scan
        if self._scan_start is not None:
            self.stats['elapsed_seconds'] = int(time.monotonic() - self._scan_start)

        # Riepilogo finale
        self._print_summary(all_filtered_bonds)

        return self.stats

    def _calculate_yield(self, bond: ScannedBond):
        """Calcola il yield di un'obbligazione usando la formula del Yield Bot."""
        try:
            if bond.coupon_rate is None or bond.current_price is None:
                return

            if bond.coupon_rate == 0 and bond.maturity_date:
                # Zero-coupon
                bond.calculated_yield = calculate_yield_zero_coupon(
                    current_price=bond.current_price,
                    maturity_date=bond.maturity_date,
                )
            elif bond.coupon_rate > 0 and bond.maturity_date is None:
                # Perpetua
                bond.calculated_yield = calculate_yield_perpetual(
                    coupon_rate=bond.coupon_rate,
                    current_price=bond.current_price,
                )
            elif bond.coupon_rate > 0 and bond.maturity_date:
                # Standard
                bond.calculated_yield = calculate_yield_at_current_price(
                    coupon_rate=bond.coupon_rate,
                    current_price=bond.current_price,
                    maturity_date=bond.maturity_date,
                )
            else:
                logger.warning(f"    ⚠️ Tipo bond non riconosciuto (cedola={bond.coupon_rate}, "
                               f"scadenza={bond.maturity_date})")

        except ValueError as e:
            logger.warning(f"    ⚠️ Errore calcolo yield: {e}")
        except Exception as e:
            logger.error(f"    ❌ Errore imprevisto nel calcolo yield: {e}")

    def _print_summary(self, filtered_bonds: List[ScannedBond]):
        """Stampa il riepilogo finale della scansione."""
        logger.info(f"\n{'='*60}")
        logger.info("📊 RIEPILOGO SCANSIONE")
        logger.info(f"{'='*60}")
        logger.info(f"  📡 Bond scansionati:  {self.stats['total_scanned']}")
        logger.info(f"  ✅ Bond accettati:    {self.stats['total_filtered']}")
        logger.info(f"  ❌ Bond scartati:     {self.stats['total_discarded']}")
        logger.info(f"  ⚠️  Errori:            {self.stats['total_errors']}")

        for currency, data in self.stats.get('by_currency', {}).items():
            if isinstance(data, dict) and 'error' not in data:
                logger.info(f"  📈 {currency}: {data.get('filtered', 0)} accettati "
                            f"(su {data.get('scanned', 0)} trovati)")

        if filtered_bonds:
            logger.info(f"\n  📂 Report: {self.stats.get('output_file', 'N/A')}")
            logger.info(f"\n  🏆 Top 5 per yield:")
            sorted_bonds = sorted(
                [b for b in filtered_bonds if b.calculated_yield],
                key=lambda b: b.calculated_yield,
                reverse=True,
            )[:5]
            for i, b in enumerate(sorted_bonds, 1):
                logger.info(f"     {i}. {b.name[:35]:<35s} "
                            f"Yield: {b.calculated_yield:.4%}  "
                            f"Prezzo: {b.current_price:.2f}  {b.currency}")

        logger.info(f"{'='*60}")
