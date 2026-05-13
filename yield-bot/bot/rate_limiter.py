"""
Rate limiter per il Bot Calcul Yield.

Limita il numero di esecuzioni giornaliere dello scraping
per evitare di sovraccaricare Deutsche Börse.
"""

import json
import logging
import os
from datetime import date, datetime
from typing import Tuple

logger = logging.getLogger(__name__)

# File dove salviamo il conteggio giornaliero
RATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".rate_limit.json")

# Limite massimo di esecuzioni al giorno
MAX_DAILY_RUNS = 5


def check_rate_limit() -> Tuple[bool, int]:
    """
    Verifica se il bot può essere eseguito.
    
    Returns:
        (allowed, remaining): True se permesso + quante esecuzioni restano
    """
    today = date.today().isoformat()
    data = _load_rate_data()
    
    # Reset se è un nuovo giorno
    if data.get("date") != today:
        data = {"date": today, "runs": 0, "history": []}
    
    remaining = MAX_DAILY_RUNS - data["runs"]
    allowed = remaining > 0
    
    return allowed, remaining


def record_run():
    """Registra un'esecuzione del bot."""
    today = date.today().isoformat()
    data = _load_rate_data()
    
    # Reset se è un nuovo giorno
    if data.get("date") != today:
        data = {"date": today, "runs": 0, "history": []}
    
    data["runs"] += 1
    data["history"].append(datetime.now().strftime("%H:%M:%S"))
    
    _save_rate_data(data)
    
    remaining = MAX_DAILY_RUNS - data["runs"]
    logger.info(f"📊 Esecuzione {data['runs']}/{MAX_DAILY_RUNS} oggi — {remaining} restanti")


def get_usage_info() -> str:
    """Restituisce un riepilogo dell'utilizzo odierno."""
    today = date.today().isoformat()
    data = _load_rate_data()
    
    if data.get("date") != today:
        return f"📊 Oggi: 0/{MAX_DAILY_RUNS} esecuzioni (tutte disponibili)"
    
    runs = data["runs"]
    remaining = MAX_DAILY_RUNS - runs
    history = ", ".join(data.get("history", []))
    
    return (
        f"📊 Oggi: {runs}/{MAX_DAILY_RUNS} esecuzioni "
        f"({remaining} restanti)\n"
        f"   Orari: {history or 'nessuna'}"
    )


def _load_rate_data() -> dict:
    """Carica i dati del rate limiter."""
    try:
        if os.path.exists(RATE_FILE):
            with open(RATE_FILE, 'r') as f:
                return json.load(f)
    except Exception:
        pass
    return {"date": "", "runs": 0, "history": []}


def _save_rate_data(data: dict):
    """Salva i dati del rate limiter."""
    try:
        with open(RATE_FILE, 'w') as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        logger.error(f"Errore salvataggio rate limit: {e}")
