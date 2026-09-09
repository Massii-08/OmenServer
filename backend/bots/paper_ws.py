"""WebSocket push ``/ws/paper`` de l'extension TradingView « coach ».

Squelette monté par ``backend/main.py`` ; rempli par le lot C (voir
``docs/superpowers/plans/2026-09-09-tv-coach-extension.md`` Task 8).
Auth PAR PREMIER MESSAGE ``{"token": "<jwt>"}`` — jamais en query string.
"""

from typing import Any, Dict, Optional

from fastapi import APIRouter

router = APIRouter(tags=["paper-ws"])


def emit(username: Optional[str], type_: str, symbol: Optional[str],
         payload: Optional[Dict[str, Any]] = None) -> None:
    """Best-effort, jamais d'exception : sans boucle enregistrée, no-op.

    Implémentation réelle au lot C ; ce stub garde les appelants valides.
    """
    return None
