"""
Implementazione della funzione DAYS360 di Excel.
Calcola il numero di giorni tra due date usando la convenzione 30/360.

Copiato dal Bot Calcul Yield — stessa logica esatta.
"""

from datetime import date


def days360(start_date: date, end_date: date, method_eu: bool = True) -> int:
    """
    Calcola il numero di giorni tra due date usando la convenzione 30/360.

    Replica la funzione DAYS360() di Excel.

    Args:
        start_date: Data di partenza
        end_date: Data di arrivo
        method_eu: Se True usa il metodo europeo (30E/360),
                   se False usa il metodo US/NASD (30US/360)

    Returns:
        Numero di giorni secondo la convenzione 30/360 (può essere negativo)
    """
    start_day = start_date.day
    start_month = start_date.month
    start_year = start_date.year

    end_day = end_date.day
    end_month = end_date.month
    end_year = end_date.year

    if method_eu:
        # Metodo Europeo (30E/360)
        if start_day == 31:
            start_day = 30
        if end_day == 31:
            end_day = 30
    else:
        # Metodo US/NASD (30US/360) — default di Excel
        if start_day == 31:
            start_day = 30
        if end_day == 31 and start_day >= 30:
            end_day = 30

    days = (
        (end_year - start_year) * 360
        + (end_month - start_month) * 30
        + (end_day - start_day)
    )

    return days
