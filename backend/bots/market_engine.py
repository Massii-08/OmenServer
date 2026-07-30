"""Passerelle backend → moteur `market-pulse/`.

Le moteur vit dans un répertoire **frère au nom tirété** (`market-pulse/`), donc
`import pulse.prefs` ne marche pas tel quel depuis le backend. Ce module est le
SEUL endroit du backend qui connaît ce détail : le router lui parle, jamais à
`pulse` directement.

Pourquoi une passerelle plutôt qu'un import direct dans le router :

- le chemin ne s'ajoute qu'une fois, à un endroit qu'on peut tester ;
- si le moteur manque (déploiement partiel), les endpoints rendent une erreur
  claire au lieu d'un 500 avec une trace — et surtout, **le backend démarre
  quand même** ;
- `market_schedule` reste PUR : il reçoit les groupes d'ouverture, il ne les
  calcule pas.
"""
import logging
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

ENGINE_DIR = Path(__file__).resolve().parent.parent.parent / "market-pulse"


class EngineUnavailable(RuntimeError):
    """Le moteur `market-pulse/` n'est pas là où on l'attend."""


def _ensure_path() -> None:
    path = str(ENGINE_DIR)
    if path not in sys.path:
        sys.path.insert(0, path)


def _pulse(name: str):
    """Un module du moteur, importé à la demande."""
    _ensure_path()
    try:
        module = __import__("pulse.%s" % name, fromlist=[name])
    except ImportError as e:
        raise EngineUnavailable("moteur market-pulse introuvable (%s): %s"
                                % (ENGINE_DIR, e))
    return module


def available() -> bool:
    try:
        _pulse("exchanges")
        _pulse("prefs")
    except EngineUnavailable:
        return False
    return True


# --------------------------------------------------------------------------
# Catalogue des places
# --------------------------------------------------------------------------

def catalogue() -> List[Dict[str, Any]]:
    """Les dix opérateurs, sous la forme que l'UI dessine.

    On sert la liste avec les préférences : sans elle, le sélecteur ne saurait
    afficher ni le nom, ni l'heure d'ouverture, ni les sept places d'Euronext.
    """
    exchanges = _pulse("exchanges")
    return [e.as_dict() for e in exchanges.DEFAULT_EXCHANGES]


def opening_groups(exchange_ids: Optional[List[str]]) -> List[Tuple[List[str], str, str]]:
    """Groupes d'ouverture des places demandées.

    ⚠️ Une sélection vide rend une liste VIDE — jamais les dix places. Une config
    nulle doit produire zéro briefing, pas dix en silence.
    """
    exchanges = _pulse("exchanges")
    venues = [exchanges.by_id(x) for x in (exchange_ids or [])]
    return exchanges.opening_groups([v for v in venues if v])


# --------------------------------------------------------------------------
# Préférences
# --------------------------------------------------------------------------

def prefs_default_path() -> str:
    return _pulse("prefs").DEFAULT_PATH


def validate_prefs(raw: Optional[Dict[str, Any]]):
    return _pulse("prefs").validate(raw)


def load_prefs(path: Optional[str] = None):
    """`(préférences propres, avertissements)`. Ne lève jamais côté moteur."""
    return _pulse("prefs").load(path)


def save_prefs(prefs: Dict[str, Any], path: Optional[str] = None) -> Dict[str, Any]:
    """Valide PUIS écrit : une config cassée serait rechargée chaque matin."""
    return _pulse("prefs").save(prefs, path)
