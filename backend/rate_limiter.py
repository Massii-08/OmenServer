"""
Rate Limiter — Protection contre le bombardement de requêtes.

Middleware léger, sans dépendance externe, basé sur un token bucket par IP.

Règles :
    - 127.0.0.1 / localhost → EXEMPTÉ (bots de scraping locaux)
    - /api/nodes/heartbeat → EXEMPTÉ (agents envoient toutes les 10s)
    - /api/auth/login → 10 req/min (protection brute-force)
    - Autres routes /api/* → 120 req/min par IP
    - Fichiers statiques (CSS, JS, HTML) → pas limités

La mémoire est nettoyée toutes les 5 minutes pour éviter les fuites.
"""

import time
import logging
from collections import defaultdict
from starlette.requests import Request
from starlette.responses import JSONResponse

logger = logging.getLogger("omenserver")

# --- Configuration ---
# Limites : (nombre max de requêtes, fenêtre en secondes)
RATE_LIMITS = {
    "login": (10, 60),       # 10 req/min pour le login (anti brute-force)
    "api": (120, 60),        # 120 req/min pour les autres API
}

# Routes et IPs exemptées
EXEMPT_PATHS = {
    "/api/nodes/heartbeat",  # Agents envoient toutes les 10s
    "/api/health",           # Health check
}

EXEMPT_PATH_PREFIXES = (
    "/css/", "/js/", "/sw.js", "/manifest.json",
    "/favicon", "/icon-", "/login",
)

LOCAL_IPS = {"127.0.0.1", "::1", "localhost"}


class RateLimitStore:
    """
    Stockage en mémoire des compteurs de requêtes par IP.
    Utilise un système de fenêtre glissante simple.
    """

    def __init__(self):
        # { "bucket_key": [timestamp, timestamp, ...] }
        self._requests = defaultdict(list)
        self._last_cleanup = time.time()

    def is_allowed(self, key: str, max_requests: int, window_seconds: int) -> bool:
        """Vérifie si la requête est autorisée et l'enregistre."""
        now = time.time()
        cutoff = now - window_seconds

        # Nettoyer les anciennes entrées pour cette clé
        self._requests[key] = [t for t in self._requests[key] if t > cutoff]

        if len(self._requests[key]) >= max_requests:
            return False

        self._requests[key].append(now)
        return True

    def cleanup(self):
        """Nettoie les entrées expirées (appelé périodiquement)."""
        now = time.time()
        if now - self._last_cleanup < 300:  # Toutes les 5 min
            return

        self._last_cleanup = now
        expired_keys = []
        for key, timestamps in self._requests.items():
            # Garder seulement les timestamps de la dernière minute
            self._requests[key] = [t for t in timestamps if t > now - 120]
            if not self._requests[key]:
                expired_keys.append(key)

        for key in expired_keys:
            del self._requests[key]

        if expired_keys:
            logger.debug(f"🧹 Rate limiter: {len(expired_keys)} entrées nettoyées")


# Instance globale
_store = RateLimitStore()


def _get_client_ip(request: Request) -> str:
    """
    IP de confiance pour la clé de rate-limit.

    Sécurité : on ne fait PLUS confiance à `X-Forwarded-For` — en accès direct à
    l'origine (hors Cloudflare), il est forgeable à chaque requête → un attaquant
    contournait le rate-limit (chaque requête = une clé différente). On utilise
    `CF-Connecting-IP` (posé par Cloudflare en prod) sinon l'IP TCP réelle.

    ⚠️ Déploiement : firewaller l'origine (port 8000) aux ranges IP Cloudflare pour
    que `CF-Connecting-IP` soit fiable ; sinon un client direct peut le falsifier.
    """
    # Cloudflare envoie l'IP réelle dans CF-Connecting-IP
    cf_ip = request.headers.get("CF-Connecting-IP")
    if cf_ip:
        return cf_ip

    # IP directe (non falsifiable). On n'utilise volontairement pas X-Forwarded-For.
    return request.client.host if request.client else "unknown"


async def rate_limit_middleware(request: Request, call_next):
    """
    Middleware de rate limiting.
    Vérifie les limites de requêtes par IP avant de traiter la requête.
    """
    path = request.url.path

    # --- Exemptions ---

    # Fichiers statiques → pas de limite
    if path == "/" or path.startswith(EXEMPT_PATH_PREFIXES):
        return await call_next(request)

    # Routes spécifiquement exemptées
    if path in EXEMPT_PATHS:
        return await call_next(request)

    # Pas une route API → pas de limite
    if not path.startswith("/api/"):
        return await call_next(request)

    # IP locale → pas de limite (bots de scraping)
    client_ip = _get_client_ip(request)
    if client_ip in LOCAL_IPS:
        return await call_next(request)

    # --- Appliquer les limites ---

    # Login → limite stricte
    if path == "/api/auth/login":
        max_req, window = RATE_LIMITS["login"]
        bucket_key = f"login:{client_ip}"
    else:
        max_req, window = RATE_LIMITS["api"]
        bucket_key = f"api:{client_ip}"

    if not _store.is_allowed(bucket_key, max_req, window):
        logger.warning(f"🚫 Rate limit dépassé: {client_ip} → {path}")
        return JSONResponse(
            status_code=429,
            content={"detail": "Trop de requêtes. Réessayez dans quelques secondes."},
            headers={
                "Retry-After": str(window),
                "X-RateLimit-Limit": str(max_req),
            },
        )

    # Nettoyage périodique
    _store.cleanup()

    response = await call_next(request)

    # Ajouter des headers informatifs
    response.headers["X-RateLimit-Limit"] = str(max_req)

    return response
