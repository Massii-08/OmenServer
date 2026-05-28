"""
Mémoire des bonds "rejetés" — skip au prochain scan pendant 60j (2026-05-28).

Massii : "le prochain scan ne doit pas re-scanner ceux déjà scannés (les bons
ET les pas bons)".

Distinction des 3 cas après un scan :
- LIVRÉS (dans l'Excel)         → FoundStore (permanent, jamais re-livré)
- REJETÉS (yield/rating/no-Fitch) → SeenStore (skip 60j, puis re-évalué car
                                     le prix bouge → un rejeté peut devenir bon)
- OVERFLOW (valides mais hors top-N) → RIEN : reviennent au prochain scan pour
                                     concourir (cf. demande Massii précédente)

Pourquoi un TTL (et pas "pour toujours") : le yield d'un bond dépend de son
prix courant (coupon fixe + prix variable). Un bond rejeté à 3,6% aujourd'hui
peut passer 4% si son prix baisse. 60j = on évite le re-scan inutile à court
terme mais on rattrape les opportunités si le marché bouge.

Stockage : ~/.cache/bond-scanner-seen.json {isin: {date, reason}}.
"""
from __future__ import annotations

import json
import logging
from datetime import date, timedelta
from pathlib import Path
from typing import Iterable, Optional

logger = logging.getLogger(__name__)

SEEN_STORE_PATH = Path.home() / '.cache' / 'bond-scanner-seen.json'
SEEN_TTL = timedelta(days=60)


class SeenStore:
    """ISINs de bonds rejetés, skippés au pré-filtre pendant SEEN_TTL."""

    def __init__(self, path: Optional[Path] = None):
        self.path = path or SEEN_STORE_PATH
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
        """True si cet ISIN a été rejeté il y a MOINS de 60j (donc à skipper)."""
        if not isin:
            return False
        entry = self._data.get(isin)
        if not entry:
            return False
        try:
            seen_date = date.fromisoformat(entry.get('date', ''))
        except ValueError:
            return False
        if date.today() - seen_date > SEEN_TTL:
            return False  # expiré → re-évaluable (le prix a pu bouger)
        return True

    def add_many(self, isins: Iterable[str], reason: str = '') -> int:
        """Enregistre des ISINs rejetés (date du jour). Returns nb nouveaux/MAJ."""
        today = date.today().isoformat()
        n = 0
        for isin in isins:
            if not isin:
                continue
            self._data[isin] = {'date': today, 'reason': reason[:40]}
            n += 1
        if n:
            self._save()
        return n

    def count(self) -> int:
        return len(self._data)

    def prune(self) -> int:
        """Supprime les entrées expirées (> 60j). Returns nb supprimés."""
        today = date.today()
        before = len(self._data)
        kept = {}
        for isin, entry in self._data.items():
            try:
                if today - date.fromisoformat(entry.get('date', '')) <= SEEN_TTL:
                    kept[isin] = entry
            except ValueError:
                continue
        self._data = kept
        removed = before - len(self._data)
        if removed:
            self._save()
        return removed

    def reset(self) -> int:
        n = len(self._data)
        self._data = {}
        try:
            if self.path.exists():
                self.path.unlink()
        except OSError as e:
            logger.warning(f"Impossible de supprimer {self.path}: {e}")
        return n
