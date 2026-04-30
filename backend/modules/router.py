"""
Routes des modules — Liste et statut des modules.

Le frontend appelle ces routes pour savoir quels modules afficher
dans le hub et lesquels sont actifs.

Routes:
    GET /api/modules          → Liste de tous les modules
    GET /api/modules/{id}     → Détails d'un module spécifique
"""

from fastapi import APIRouter, Depends, HTTPException

from backend.auth.utils import get_current_user
from backend.auth.models import User
from backend.modules.manager import module_manager

router = APIRouter(prefix="/api/modules", tags=["Modules"])


@router.get("/")
def list_modules(current_user: User = Depends(get_current_user)):
    """
    Retourne la liste de tous les modules avec leur statut.
    Le frontend utilise ça pour afficher les cartes du hub.
    """
    return {
        "modules": module_manager.get_all_modules(),
        "enabled_count": len(module_manager.get_enabled_modules()),
    }


@router.get("/{module_id}")
def get_module(module_id: str, current_user: User = Depends(get_current_user)):
    """Retourne les détails d'un module spécifique."""
    module = module_manager.get_module(module_id)
    if not module:
        raise HTTPException(status_code=404, detail="Module non trouvé")
    return module
