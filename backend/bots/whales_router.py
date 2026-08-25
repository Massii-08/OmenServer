"""Router « Grands portefeuilles » — dépôts 13F de la SEC (EDGAR).

Router SÉPARÉ du reste du simulateur de paper trading (même préfixe familial
``/api/paper``, mais un fichier à lui) : la source, le cache et le rythme
d'appel n'ont rien à voir avec le portefeuille de l'utilisateur, et une panne
de la SEC ne doit pas peser sur le simulateur.

Accès ``admin`` + ``money`` partout, comme les autres bots finance du dépôt
(l'investisseur a un compte ``money``).

⚠️ Aucun job n'est armé ici : ``whales.check_new_filings`` est exposée, c'est
le planificateur (fichier d'un autre lot) qui décide quand l'appeler.

⚠️ Ordre des routes : ``/events`` est déclarée AVANT ``/{manager_id}``, sinon
FastAPI ferait correspondre « events » au paramètre de chemin et l'endpoint
serait injoignable (le catalogue n'a pas de gérant nommé « events » → 404).
"""
import logging

from fastapi import APIRouter, Depends, HTTPException

from backend.auth.models import User
from backend.auth.permissions import require_role
from backend.bots.paper import whales

logger = logging.getLogger("omenserver")

router = APIRouter(prefix="/api/paper/whales", tags=["paper"])


@router.get("")
def whales_list(current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Catalogue des gérants suivis + état du cache (aucun appel à la SEC)."""
    return {"managers": whales.list_managers()}


@router.get("/events")
def whales_events(current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Derniers dépôts EDGAR détectés par le guetteur (les plus récents en tête)."""
    return {"events": whales.recent_filing_events()}


@router.get("/{manager_id}")
def whales_snapshot(manager_id: str, force: bool = False,
                    current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Dernier trimestre agrégé d'un gérant + comparaison au précédent.

    Le premier appel « à froid » peut prendre une dizaine de secondes (4 à 6
    requêtes SEC espacées d'une seconde, par courtoisie) ; le cache 24 h rend
    les suivants instantanés. ``force=true`` re-interroge la SEC.

    Le statut voyage DANS le corps de la réponse (``ok`` / ``unverified`` /
    ``error``) : un gérant dont le CIK ne correspond pas au nom attendu n'est
    pas une erreur HTTP, c'est une information à afficher — et surtout aucune
    donnée n'est servie sous ce nom-là.
    """
    if whales.find_manager(manager_id) is None:
        raise HTTPException(status_code=404, detail="Gérant inconnu")
    return whales.get_snapshot(manager_id, force=force)
