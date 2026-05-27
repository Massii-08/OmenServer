"""
HTTP router pour le module sysdoc.

Pour l'instant un seul endpoint utile :
  - GET /api/sysdoc/me  → retourne les infos de connexion que l'agent doit utiliser
                          pour se brancher au hub. Le user les copie dans son .env
                          quand il installe l'agent sur sa machine Windows.

Le reste passe par WebSocket — voir backend/sysdoc/ws_router.py.
"""

from fastapi import APIRouter, Depends, Request

from backend.auth.utils import get_current_user
from backend.auth.models import User

router = APIRouter(prefix="/api/sysdoc", tags=["sysdoc"])


@router.get("/me")
def get_my_agent_config(
    request: Request,
    current_user: User = Depends(get_current_user),
):
    """
    Retourne les infos de connexion pour l'agent Windows/macOS :
      - username : à utiliser comme `OMEN_AGENT_USERNAME`
      - hub_url  : à utiliser comme `OMEN_HUB_URL` (sans le segment /agent/<user>)

    Pour le secret JWT, l'agent doit recevoir la même `SECRET_KEY` que le hub
    (pas exposé par l'API par sécurité — passer par le .env de la machine cible
    en copiant la valeur depuis backend/config.py côté hub).
    """
    # Reconstruit l'URL WS publique en se basant sur le scheme/host de la requête
    scheme = "wss" if request.url.scheme == "https" else "ws"
    host = request.url.netloc
    return {
        "username": current_user.username,
        "hub_url": f"{scheme}://{host}/ws/sysdoc",
        "is_admin": bool(current_user.is_admin),
    }
