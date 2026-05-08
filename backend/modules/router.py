"""
Routes des modules — Liste et statut des modules.

Le frontend appelle ces routes pour savoir quels modules afficher
dans le hub et lesquels sont actifs.

Routes:
    GET /api/modules          → Liste de tous les modules
    GET /api/modules/{id}     → Détails d'un module spécifique
"""

import json

from fastapi import APIRouter, Depends, HTTPException

from backend.auth.utils import get_current_user
from backend.auth.models import User
from backend.modules.manager import module_manager

router = APIRouter(prefix="/api/modules", tags=["Modules"])


@router.get("/")
def list_modules(current_user: User = Depends(get_current_user)):
    """
    Retourne la liste de tous les modules avec leur statut.
    Filtre par les modules autorisés pour l'utilisateur.
    Les admins voient tout.
    """
    all_modules = module_manager.get_all_modules()

    # Admins voient tout
    if current_user.is_admin:
        return {
            "modules": all_modules,
            "enabled_count": len(module_manager.get_enabled_modules()),
        }

    # Filtrer par allowed_modules
    allowed = None
    if current_user.allowed_modules:
        try:
            allowed = json.loads(current_user.allowed_modules)
        except (json.JSONDecodeError, TypeError):
            allowed = None

    if allowed is not None:
        filtered = [m for m in all_modules if m["id"] in allowed]
    else:
        filtered = all_modules  # null = tous les modules

    return {
        "modules": filtered,
        "enabled_count": len([m for m in filtered if m.get("enabled")]),
    }


@router.get("/{module_id}")
def get_module(module_id: str, current_user: User = Depends(get_current_user)):
    """Retourne les détails d'un module spécifique."""
    module = module_manager.get_module(module_id)
    if not module:
        raise HTTPException(status_code=404, detail="Module non trouvé")

    # Vérifier l'accès si non-admin
    if not current_user.is_admin and current_user.allowed_modules:
        try:
            allowed = json.loads(current_user.allowed_modules)
            if module_id not in allowed:
                raise HTTPException(status_code=403, detail="Accès non autorisé à ce module")
        except (json.JSONDecodeError, TypeError):
            pass

    return module
