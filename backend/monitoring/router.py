"""
Routes de monitoring — Stats système en temps réel.

Le frontend appelle ces routes toutes les 2 secondes pour
mettre à jour les jauges CPU/RAM/température sur le dashboard.

Routes:
    GET /api/monitoring/stats   → Toutes les stats en un appel
    GET /api/monitoring/system  → Infos système (hostname, uptime...)
"""

from fastapi import APIRouter, Depends

from backend.auth.utils import get_current_user
from backend.auth.models import User
from backend.monitoring.system_info import get_all_stats, get_system_info

router = APIRouter(prefix="/api/monitoring", tags=["Monitoring"])


@router.get("/stats")
def get_stats(current_user: User = Depends(get_current_user)):
    """
    Retourne toutes les statistiques système.
    Appelé toutes les 2 secondes par le frontend.

    Protégé : il faut être connecté pour voir les stats.
    """
    return get_all_stats()


@router.get("/system")
def get_system(current_user: User = Depends(get_current_user)):
    """
    Retourne les infos système générales (hostname, OS, uptime...).
    Appelé une seule fois au chargement du dashboard.
    """
    return get_system_info()
