"""Store : frontier (todo/done/seen) + records, persisté JSON, resumable.

Pur (le chemin de fichier est injecté). C'est l'état qui survit au reboot
nocturne de l'Omen : load() reconstruit la frontière exacte."""
import json
import os
from typing import Any, Dict, List, Optional


class Store(object):
    def __init__(self, path: str, dedupe: bool = False) -> None:
        self.path = path
        self._dedupe = dedupe
        self._todo = []            # type: List[str]   # queued, ordered
        self._done = []            # type: List[str]   # completed (ordered)
        self._seen = set()         # type: set         # every url ever queued/done/errored
        self._records = []         # type: List[Dict[str, Any]]
        self._record_keys = set()  # type: set         # hashes de records (si dedupe)
        self._errors = 0

    @staticmethod
    def _rec_key(rec: Dict[str, Any]) -> str:
        # clé stable insensible à l'ordre des champs
        return json.dumps(rec, sort_keys=True, ensure_ascii=False)

    def add_todo(self, url: str) -> bool:
        if url in self._seen:
            return False
        self._seen.add(url)
        self._todo.append(url)
        return True

    def next_todo(self) -> Optional[str]:
        return self._todo[0] if self._todo else None

    def mark_done(self, url: str) -> None:
        if url in self._todo:
            self._todo.remove(url)
        self._seen.add(url)
        if url not in self._done:
            self._done.append(url)

    def add_record(self, rec: Dict[str, Any]) -> bool:
        """Ajoute un record. En mode dedupe, un record dont TOUS les champs sont
        identiques à un record DÉJÀ collecté (sur l'ensemble du run, pas juste la
        page) est ignoré -> retourne False ; sinon True. Dédup globale."""
        if self._dedupe:
            key = self._rec_key(rec)
            if key in self._record_keys:
                return False
            self._record_keys.add(key)
        self._records.append(rec)
        return True

    def add_error(self) -> None:
        self._errors += 1

    def records(self) -> List[Dict[str, Any]]:
        return list(self._records)

    def counts(self) -> Dict[str, int]:
        return {
            "todo": len(self._todo),
            "done": len(self._done),
            "records": len(self._records),
            "errors": self._errors,
        }

    def to_dict(self) -> Dict[str, Any]:
        return {
            "todo": self._todo,
            "done": self._done,
            "seen": sorted(self._seen),
            "records": self._records,
            "errors": self._errors,
        }

    def save(self) -> None:
        d = os.path.dirname(self.path)
        if d:
            os.makedirs(d, exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.to_dict(), f, ensure_ascii=False)
        os.replace(tmp, self.path)

    @classmethod
    def load(cls, path: str, dedupe: bool = False) -> "Store":
        s = cls(path, dedupe=dedupe)
        if not os.path.isfile(path):
            return s
        try:
            with open(path, "r", encoding="utf-8") as f:
                d = json.load(f)
        except (ValueError, OSError):
            return s
        s._todo = list(d.get("todo", []))
        s._done = list(d.get("done", []))
        s._seen = set(d.get("seen", [])) | set(s._todo) | set(s._done)
        s._records = list(d.get("records", []))
        s._errors = int(d.get("errors", 0))
        if dedupe:
            # reprise : reconstruit l'index des records déjà stockés -> une page
            # re-fetchée après interruption ne re-duplique pas ses records.
            s._record_keys = set(s._rec_key(r) for r in s._records)
        return s
