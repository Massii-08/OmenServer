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
    Retourne les infos de connexion pour l'agent Windows/macOS/Linux :
      - username  : à utiliser comme `OMEN_AGENT_USERNAME`
      - hub_url   : à utiliser comme `OMEN_HUB_URL` (sans le segment /agent/<user>/<machine>)
      - is_admin  : si vrai, l'UI peut afficher des options admin-only
      - secret_key: SEULEMENT pour les admins. Permet à l'UI de pré-remplir les
                    commandes d'install d'agent. Pour un user non-admin, c'est
                    None — l'admin doit lui transmettre la valeur par canal sécurisé.

    Sécurité : exposer le SECRET_KEY via API même pour les admins n'est pas idéal
    mais (1) il faut être loggué + authentifié JWT, (2) HTTPS, (3) seul un admin
    déjà compromis pourrait en abuser et de toute façon il a déjà les droits.
    Trade-off : UX vs friction. Pour OmenServer (panel personnel), c'est OK.
    """
    scheme = "wss" if request.url.scheme == "https" else "ws"
    host = request.url.netloc
    response = {
        "username": current_user.username,
        "hub_url": f"{scheme}://{host}/ws/sysdoc",
        "is_admin": bool(current_user.is_admin),
    }
    if current_user.is_admin:
        from backend.config import settings
        response["secret_key"] = settings.SECRET_KEY
    return response
