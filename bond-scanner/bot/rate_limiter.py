"""
Rate limiter per il Bond Scanner.

Limita il numero di scansioni giornaliere
per evitare di sovraccaricare Deutsche Börse.

Limite: max 2 scansioni al giorno.
"""

import json
import logging
import os
from datetime import date, datetime
from typing import Tuple

logger = logging.getLogger(__name__)

# File dove salviamo il conteggio giornaliero
RATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".rate_limit.json")

# Limite massimo di scansioni al giorno
MAX_DAILY_SCANS = 2


def check_rate_limit() -> Tuple[bool, int]:
    """
    Verifica se il bot può essere eseguito.

    Returns:
        (allowed, remaining): True se permesso + quante scansioni restano
    """
    today = date.today().isoformat()
    data = _load_rate_data()

    # Reset se è un nuovo giorno
    if data.get("date") != today:
        data = {"date": today, "scans": 0, "history": []}

    remaining = MAX_DAILY_SCANS - data["scans"]
    allowed = remaining > 0

    return allowed, remaining


def record_scan():
    """Registra una scansione del bot."""
    today = date.today().isoformat()
    data = _load_rate_data()

    # Reset se è un nuovo giorno
    if data.get("date") != today:
        data = {"date": today, "scans": 0, "history": []}

    data["scans"] += 1
    data["history"].append(datetime.now().strftime("%H:%M:%S"))

    _save_rate_data(data)

    remaining = MAX_DAILY_SCANS - data["scans"]
    logger.info(f"📊 Scansione {data['scans']}/{MAX_DAILY_SCANS} oggi — {remaining} restanti")


def get_usage_info() -> str:
    """Restituisce un riepilogo dell'utilizzo odierno."""
    today = date.today().isoformat()
    data = _load_rate_data()

    if data.get("date") != today:
        return f"📊 Oggi: 0/{MAX_DAILY_SCANS} scansioni (tutte disponibili)"

    scans = data["scans"]
    remaining = MAX_DAILY_SCANS - scans
    history = ", ".join(data.get("history", []))

    return (
        f"📊 Oggi: {scans}/{MAX_DAILY_SCANS} scansioni "
        f"({remaining} restanti)\n"
        f"   Orari: {history or 'nessuna'}"
    )


def get_usage_data() -> dict:
    """Restituisce i dati di utilizzo per l'API."""
    today = date.today().isoformat()
    data = _load_rate_data()

    if data.get("date") != today:
        return {
            "today_scans": 0,
            "max_scans": MAX_DAILY_SCANS,
            "remaining": MAX_DAILY_SCANS,
            "history": [],
        }

    scans = data.get("scans", 0)
    return {
        "today_scans": scans,
        "max_scans": MAX_DAILY_SCANS,
        "remaining": max(0, MAX_DAILY_SCANS - scans),
        "history": data.get("history", []),
    }


def _load_rate_data() -> dict:
    """Carica i dati del rate limiter."""
    try:
        if os.path.exists(RATE_FILE):
            with open(RATE_FILE, 'r') as f:
                return json.load(f)
    except Exception:
        pass
    return {"date": "", "scans": 0, "history": []}


def _save_rate_data(data: dict):
    """Salva i dati del rate limiter."""
    try:
        with open(RATE_FILE, 'w') as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        logger.error(f"Errore salvataggio rate limit: {e}")
