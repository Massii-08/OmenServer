"""Store : frontier (todo/done/seen) + records, persisté JSON, resumable.

Pur (le chemin de fichier est injecté). C'est l'état qui survit au reboot
nocturne de l'Omen : load() reconstruit la frontière exacte."""
import json
import os
from typing import Any, Dict, List, Optional


class Store(object):
    def __init__(self, path: str) -> None:
        self.path = path
        self._todo = []            # type: List[str]   # queued, ordered
        self._done = []            # type: List[str]   # completed (ordered)
        self._seen = set()         # type: set         # every url ever queued/done/errored
        self._records = []         # type: List[Dict[str, Any]]
        self._errors = 0

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

    def add_record(self, rec: Dict[str, Any]) -> None:
        self._records.append(rec)

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
    def load(cls, path: str) -> "Store":
        s = cls(path)
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
        return s
