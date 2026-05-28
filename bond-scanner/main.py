"""
Bond Scanner — Entry point CLI.

Scansiona automaticamente il mercato obbligazionario per trovare
le migliori opportunità di investimento secondo criteri configurabili.

Utilizzo:
    python main.py --scan
    python main.py --scan --currency EUR
    python main.py --scan --max-price 99 --min-yield 0.04
    python main.py --scan --currencies EUR,USD,GBP

Tutti i log sono in italiano 🇮🇹
"""

import argparse
import asyncio
import logging
import os
import sys
from datetime import date

from scanner.bond_scanner import BondScanner
from filter.criteria import ScanCriteria
from bot.rate_limiter import get_usage_info

# Logging config
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    datefmt="%H:%M:%S",
    handlers=[
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger(__name__)


def parse_args():
    """Parse degli argomenti CLI."""
    parser = argparse.ArgumentParser(
        description="Bond Scanner — Ricerca automatica di obbligazioni sicure",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Esempi:
  python main.py --scan                          # Scansione standard
  python main.py --scan --max-price 98           # Solo bond sotto 98
  python main.py --scan --min-yield 0.05         # Solo yield > 5%
  python main.py --scan --currencies EUR,USD     # Solo EUR e USD
  python main.py --scan --output risultati.xlsx  # File output custom
  python main.py --usage                         # Controlla rate limit
        """,
    )

    parser.add_argument('--scan', action='store_true', help='Avvia la scansione del mercato')
    parser.add_argument('--usage', action='store_true', help='Mostra utilizzo odierno (rate limit)')

    # Criteri di filtro
    parser.add_argument('--max-price', type=float, default=100.0,
                        help='Prezzo massimo (default: 100 = sotto la pari)')
    parser.add_argument('--min-yield', type=float, default=0.03,
                        help='Yield minimo come decimale (default: 0.03 = 3%%)')
    parser.add_argument('--max-maturity', type=int, default=9,
                        help='Scadenza massima in anni (default: 9)')
    parser.add_argument('--min-rating', type=str, default='BBB',
                        help='Rating Fitch minimo (default: BBB). Slider UI: BBB- → AAA')
    parser.add_argument('--currencies', type=str, default='EUR,USD,GBP',
                        help='Valute da cercare (default: EUR,USD,GBP)')
    parser.add_argument('--target-count', type=int, default=20,
                        help='Target di bond nell\'Excel finale (default: 20, range 1-20). '
                             'Split equilibrato sulle valute selezionate '
                             '(1 valuta=20, 2=10/10, 3=7/7/6). '
                             'Scoring Defensive 20%% prezzo / 40%% yield / 40%% rating.')

    # Opzioni di output
    parser.add_argument('--output', '-o', type=str, default=None,
                        help='Percorso del file Excel di output')
    parser.add_argument('--price-threshold', type=float, default=101.0,
                        help='Soglia di prezzo per la colorazione rosso/nero (default: 101)')

    # Opzioni tecniche
    parser.add_argument('--show', action='store_true',
                        help='Mostra il browser durante la scansione (debug)')
    parser.add_argument('--delay', type=float, default=1.0,
                        help='Pausa tra richieste in secondi (default: 1)')

    # Dédup persistante inter-scans
    parser.add_argument('--no-dedup', action='store_true',
                        help='Désactive la dédup : re-cherche aussi les bonds déjà livrés')
    parser.add_argument('--reset-found', action='store_true',
                        help='Vide l\'historique des bonds déjà livrés avant de scanner')
    parser.add_argument('--reset-cache', action='store_true',
                        help='Vide le cache de ratings (force re-fetch Brave) avant de scanner')

    return parser.parse_args()


async def main():
    """Entry point principale."""
    args = parse_args()

    if args.usage:
        print(get_usage_info())
        return

    if not args.scan:
        print("Specifica --scan per avviare la scansione o --usage per lo stato.")
        print("Usa --help per tutti i parametri disponibili.")
        return

    # Costruisci i criteri
    currencies = [c.strip().upper() for c in args.currencies.split(',')]
    criteria = ScanCriteria(
        max_price=args.max_price,
        min_yield=args.min_yield,
        max_maturity_years=args.max_maturity,
        min_rating=args.min_rating,
        currencies=currencies,
    )

    # Output path
    output_path = args.output
    if output_path is None:
        today = date.today().strftime('%Y-%m-%d')
        output_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            f"Opportunita_Bond_{today}.xlsx",
        )

    # Reset dédup si demandé (avant le scan) — vide found (livrés) + seen (rejetés)
    if args.reset_found:
        from scanner.found_store import FoundStore
        from scanner.seen_store import SeenStore
        nf = FoundStore().reset()
        ns = SeenStore().reset()
        print(f"♻️  Mémoire dédup vidée : {nf} livrés + {ns} rejetés effacés.")

    # Reset cache ratings si demandé (avant le scan)
    if args.reset_cache:
        from scanner.rating_providers import CACHE_PATH
        try:
            if CACHE_PATH.exists():
                CACHE_PATH.unlink()
                print("🗑️  Cache ratings vidé (re-fetch Brave au scan).")
        except OSError as e:
            print(f"⚠️  Impossible de vider le cache ratings : {e}")

    # Lancia la scansione
    scanner = BondScanner(
        criteria=criteria,
        headless=not args.show,
        delay=args.delay,
        price_threshold=args.price_threshold,
        target_count=args.target_count,
        dedup=not args.no_dedup,
    )

    try:
        result = scanner.scan(output_path=output_path)
        # Run the coroutine
        result = await result if asyncio.iscoroutine(result) else result

        if 'error' in result:
            logger.error(f"❌ {result['error']}")
            sys.exit(1)

        # Résumé final
        logger.info(f"\n🏁 Scansione completata!")
        if result.get('output_file'):
            logger.info(f"📂 File: {result['output_file']}")
        logger.info(f"📊 Trovati: {result.get('total_filtered', 0)} obbligazioni")

    except KeyboardInterrupt:
        logger.info("\n⏹ Scansione interrotta dall'utente")
        scanner.stop()
    except Exception as e:
        logger.error(f"❌ Errore fatale: {e}")
        raise


if __name__ == "__main__":
    asyncio.run(main())
