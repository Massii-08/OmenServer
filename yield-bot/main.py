#!/usr/bin/env python3
"""
Bot Calcul Yield — Entry Point CLI

Aggiorna automaticamente il yield delle obbligazioni nel file Excel,
recuperando i prezzi da Deutsche Börse e applicando la formula personalizzata.

Uso:
    python main.py --recalculate              # Ricalcola yield con prezzi esistenti
    python main.py --all                      # Aggiorna prezzi + ricalcola yield
    python main.py --sheet Euro               # Aggiorna solo il foglio Euro
    python main.py --isin XS2644423035        # Aggiorna un singolo bond
    python main.py --summary                  # Mostra riepilogo file
"""

import argparse
import asyncio
import logging
import os
import sys

# Configura il path per gli import
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from bot.yield_bot import YieldBot
from bot.rate_limiter import get_usage_info
from excel.processor import BondExcelProcessor


# Configurazione logging
def setup_logging(verbose: bool = False):
    """Configura il logging."""
    level = logging.DEBUG if verbose else logging.INFO
    
    # Formato colorato per terminale
    formatter = logging.Formatter(
        '%(asctime)s | %(message)s',
        datefmt='%H:%M:%S'
    )
    
    handler = logging.StreamHandler()
    handler.setFormatter(formatter)
    
    root_logger = logging.getLogger()
    root_logger.setLevel(level)
    root_logger.addHandler(handler)
    
    # Riduci verbosità di librerie esterne
    logging.getLogger('urllib3').setLevel(logging.WARNING)
    logging.getLogger('playwright').setLevel(logging.WARNING)


def find_excel_file(path: str = None) -> str:
    """Trova il file Excel nel progetto."""
    if path and os.path.exists(path):
        return path
    
    # Cerca nella directory corrente
    current_dir = os.path.dirname(os.path.abspath(__file__))
    for f in os.listdir(current_dir):
        if f.endswith('.xlsx') and 'lista' in f.lower() and 'backup' not in f.lower():
            return os.path.join(current_dir, f)
    
    raise FileNotFoundError(
        "File Excel non trovato. Usa --file per specificare il percorso."
    )


async def main():
    parser = argparse.ArgumentParser(
        description='🏦 Bot Calcul Yield — Aggiornamento automatico yield obbligazioni',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Esempi:
  python main.py --recalculate              Ricalcola yield (senza scraping)
  python main.py --all                      Aggiorna tutto (scraping + yield)
  python main.py --sheet Euro               Aggiorna foglio Euro
  python main.py --isin XS2644423035        Aggiorna un singolo bond
  python main.py --summary                  Mostra riepilogo
        """
    )
    
    # Modalità di esecuzione (mutualmente esclusive)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--all', action='store_true',
                      help='Aggiorna prezzi da Deutsche Börse + ricalcola yield')
    mode.add_argument('--recalculate', action='store_true',
                      help='Ricalcola yield usando i prezzi esistenti nel file')
    mode.add_argument('--sheet', type=str,
                      help='Aggiorna un foglio specifico (Euro, USD, GBP, Vale)')
    mode.add_argument('--isin', type=str,
                      help='Aggiorna un singolo ISIN')
    mode.add_argument('--summary', action='store_true',
                      help='Mostra riepilogo del file')
    mode.add_argument('--usage', action='store_true',
                      help='Mostra utilizzo giornaliero (limite scraping)')
    
    # Opzioni aggiuntive
    parser.add_argument('--file', type=str, default=None,
                        help='Percorso al file Excel')
    parser.add_argument('--no-backup', action='store_true',
                        help='Non creare backup prima di salvare')
    parser.add_argument('--no-save', action='store_true',
                        help='Non salvare le modifiche (dry run)')
    parser.add_argument('--visible', action='store_true',
                        help='Mostra il browser (non headless)')
    parser.add_argument('--delay', type=float, default=1.0,
                        help='Pausa tra richieste in secondi (default: 1)')
    parser.add_argument('--skip', type=int, default=0,
                        help='Salta i primi N bond (per reprendre après arrêt)')
    parser.add_argument('-v', '--verbose', action='store_true',
                        help='Output dettagliato')
    
    args = parser.parse_args()
    setup_logging(args.verbose)
    
    logger = logging.getLogger(__name__)
    
    try:
        excel_path = find_excel_file(args.file)
        logger.info(f"📂 File: {excel_path}")
    except FileNotFoundError as e:
        logger.error(str(e))
        sys.exit(1)
    
    # Modalità utilizzo
    if args.usage:
        print("\n" + get_usage_info())
        return
    
    # Modalità riepilogo
    if args.summary:
        processor = BondExcelProcessor(excel_path)
        print("\n" + processor.get_summary())
        return
    
    # Se nessuna modalità specificata, mostra help
    if not any([args.all, args.recalculate, args.sheet, args.isin]):
        parser.print_help()
        return
    
    # Crea il bot
    bot = YieldBot(
        excel_path=excel_path,
        headless=not args.visible,
        delay=args.delay,
    )
    
    save = not args.no_save
    
    # Esegui la modalità selezionata
    if args.recalculate:
        logger.info("📝 Modalità: Ricalcolo yield (senza scraping)")
        await bot.run_all(update_price=False, save=save, skip_count=args.skip)
    
    elif args.all:
        logger.info("🌐 Modalità: Aggiornamento completo (scraping + yield)")
        await bot.run_all(update_price=True, save=save, skip_count=args.skip)
    
    elif args.sheet:
        logger.info(f"📑 Modalità: Foglio {args.sheet}")
        await bot.run_sheet(args.sheet, update_price=True, save=save)
    
    elif args.isin:
        logger.info(f"🎯 Modalità: ISIN {args.isin}")
        await bot.run_single(args.isin, update_price=True, save=save)


if __name__ == '__main__':
    asyncio.run(main())
