"""
Dédup persistante inter-scans (2026-05-28).

Massii : "du moment qu'un bon bond a été trouvé il ne sera jamais recherché
dans les scans futurs (pour éviter les doublons)".

Une fois qu'un bond est LIVRÉ dans un Excel (= il a passé tous les filtres
ET fait partie du top-N final), son ISIN est enregistré ici. Les scans
suivants l'excluent dès le pre-filtre → chaque scan ne ramène que des
NOUVELLES opportunités, et on n'épuise pas la quota Brave à re-checker
des bonds déjà connus.

Stockage : ~/.cache/bond-scanner-found-isins.json (JSON, non commité,
survit aux runs et aux redéploiements). Format :
    {
        "US25746UCY38": {"date": "2026-05-28", "name": "Dominion ...", "rating": "BBB+"},
        ...
    }

Reset : supprimer le fichier, OU via le CLI `--reset-found`, OU via
l'endpoint admin POST /api/bots/scanner/reset-found.
"""
from __future__ import annotations

import json
import logging
from datetime import date
from pathlib import Path
from typing import Iterable, Optional

logger = logging.getLogger(__name__)

FOUND_STORE_PATH = Path.home() / '.cache' / 'bond-scanner-found-isins.json'


class FoundStore:
    """Set persistant d'ISINs déjà livrés dans un Excel précédent."""

    def __init__(self, path: Optional[Path] = None):
        self.path = path or FOUND_STORE_PATH
        self._data: dict = {}
        self._load()

    def _load(self):
        try:
            self._data = json.loads(self.path.read_text())
            if not isinstance(self._data, dict):
                self._data = {}
        except (FileNotFoundError, json.JSONDecodeError):
            self._data = {}

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self._data, indent=2, sort_keys=True))

    def contains(self, isin: str) -> bool:
        """True si cet ISIN a déjà été livré dans un Excel précédent."""
        return bool(isin) and isin in self._data

    def add_many(self, bonds: Iterable) -> int:
        """
        Enregistre une liste de ScannedBond comme "déjà livrés".

        Args:
            bonds: itérable de ScannedBond (les bonds du top-N final).

        Returns:
            Nombre de NOUVEAUX ISINs ajoutés (les déjà-présents ne comptent pas).
        """
        added = 0
        today = date.today().isoformat()
        for b in bonds:
            isin = getattr(b, 'isin', None)
            if not isin or isin in self._data:
                continue
            self._data[isin] = {
                'date': today,
                'name': (getattr(b, 'name', '') or '')[:80],
                'rating': getattr(b, 'rating', None),
            }
            added += 1
        if added:
            self._save()
        return added

    def count(self) -> int:
        """Nombre total d'ISINs enregistrés."""
        return len(self._data)

    def reset(self) -> int:
        """Vide le store (supprime le fichier). Returns nombre d'ISINs effacés."""
        n = len(self._data)
        self._data = {}
        try:
            if self.path.exists():
                self.path.unlink()
        except OSError as e:
            logger.warning(f"Impossible de supprimer {self.path}: {e}")
        return n
