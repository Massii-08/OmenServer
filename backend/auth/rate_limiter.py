"""
Rate Limiter — Protection anti-bruteforce pour les endpoints sensibles.

Implémente un rate limiter en mémoire basé sur l'adresse IP.
Bloque les tentatives excessives de login (5 par minute par IP).

Sécurité :
    - Pas de dépendance externe (pas besoin de Redis/slowapi)
    - Auto-nettoyage des entrées expirées toutes les 5 minutes
    - Thread-safe via threading.Lock
"""

import time
import threading
import logging
from collections import defaultdict
from fastapi import Request, HTTPException

logger = logging.getLogger("omenserver")

# Stockage en mémoire : { ip: [timestamp1, timestamp2, ...] }
_attempts: dict = defaultdict(list)
_lock = threading.Lock()

# Configuration
MAX_ATTEMPTS = 5          # Nombre max de tentatives
WINDOW_SECONDS = 60       # Fenêtre de temps (1 minute)
CLEANUP_INTERVAL = 300    # Nettoyage toutes les 5 minutes
_last_cleanup = time.time()


def _cleanup_old_entries():
    """Supprime les entrées expirées pour éviter les fuites mémoire."""
    global _last_cleanup
    now = time.time()
    if now - _last_cleanup < CLEANUP_INTERVAL:
        return
    _last_cleanup = now
    cutoff = now - WINDOW_SECONDS
    expired_keys = []
    for ip, timestamps in _attempts.items():
        _attempts[ip] = [t for t in timestamps if t > cutoff]
        if not _attempts[ip]:
            expired_keys.append(ip)
    for ip in expired_keys:
        del _attempts[ip]


def check_rate_limit(request: Request, endpoint: str = "login"):
    """
    Vérifie si l'IP a dépassé la limite de tentatives.
    Lève une HTTPException 429 si la limite est atteinte.
    
    Usage dans un router:
        check_rate_limit(request)
    """
    # Récupérer l'IP réelle (support proxy/cloudflare)
    client_ip = (
        request.headers.get("CF-Connecting-IP")
        or request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
        or request.client.host
        if request.client else "unknown"
    )
    
    key = f"{endpoint}:{client_ip}"
    now = time.time()
    cutoff = now - WINDOW_SECONDS

    with _lock:
        _cleanup_old_entries()
        
        # Filtrer les tentatives dans la fenêtre
        _attempts[key] = [t for t in _attempts[key] if t > cutoff]
        
        if len(_attempts[key]) >= MAX_ATTEMPTS:
            remaining = int(WINDOW_SECONDS - (now - _attempts[key][0]))
            logger.warning(f"🚫 Rate limit atteint pour {client_ip} sur {endpoint} — {remaining}s restantes")
            raise HTTPException(
                status_code=429,
                detail=f"Trop de tentatives. Réessayez dans {remaining} secondes."
            )
        
        # Enregistrer cette tentative
        _attempts[key].append(now)


def reset_rate_limit(request: Request, endpoint: str = "login"):
    """Réinitialise le compteur après un login réussi."""
    client_ip = (
        request.headers.get("CF-Connecting-IP")
        or request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
        or request.client.host
        if request.client else "unknown"
    )
    key = f"{endpoint}:{client_ip}"
    with _lock:
        _attempts.pop(key, None)
