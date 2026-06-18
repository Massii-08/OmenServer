"""Recette d'extraction {item_selector, fields} + extracteur déterministe.

Zéro LLM, zéro dépendance : repose sur dom.py. Une recette décrit comment
transformer un HTML en liste de records (un par élément 'item')."""
from typing import Any, Dict, List, Optional, Union

from backend.bots.harvester.dom import Node, find_all, find_first, parse_html


def resolve_selector(item: Node, sel: Union[Dict[str, str], List[Dict[str, str]], None]) -> Optional[Node]:
    """Résout un sélecteur de champ relatif à `item`.

    - None    → l'item lui-même.
    - dict    → 1er descendant matchant {tag/class}.
    - list    → chaîne descendante (ex: [{tag:'h3'},{tag:'a'}] = le <a> DANS le
      <h3>) : indispensable quand plusieurs <a> existent dans l'item et qu'on
      veut le bon (ex: books.toscrape a l'ancre image AVANT l'ancre titre)."""
    if sel is None:
        return item
    if isinstance(sel, list):
        node = item  # type: Optional[Node]
        for step in sel:
            if node is None:
                return None
            node = find_first(node, step)
        return node
    return find_first(item, sel)


def apply_extract(node: Optional[Node], extract_spec: str) -> str:
    if node is None:
        return ""
    spec = extract_spec or "text"
    if spec == "text":
        return node.text()
    if spec.startswith("attr:"):
        return node.get_attr(spec[len("attr:"):])
    if spec.startswith("class:"):
        try:
            idx = int(spec[len("class:"):])
        except ValueError:
            return ""
        classes = node.classes()
        return classes[idx] if 0 <= idx < len(classes) else ""
    return ""


class Recipe(object):
    def __init__(self, item_selector: Dict[str, str], fields: Dict[str, Dict[str, Any]]) -> None:
        self.item_selector = item_selector
        self.fields = fields

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Recipe":
        return cls(item_selector=d["item_selector"], fields=d["fields"])

    def to_dict(self) -> Dict[str, Any]:
        return {"item_selector": self.item_selector, "fields": self.fields}

    def field_names(self) -> List[str]:
        return list(self.fields.keys())

    def extract(self, html: str) -> List[Dict[str, str]]:
        root = parse_html(html)
        records = []  # type: List[Dict[str, str]]
        for item in find_all(root, self.item_selector):
            rec = {}  # type: Dict[str, str]
            for field, spec in self.fields.items():
                node = resolve_selector(item, spec.get("selector"))
                rec[field] = apply_extract(node, spec.get("extract", "text"))
            records.append(rec)
        return records
