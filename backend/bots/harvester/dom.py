"""Mini-DOM stdlib (html.parser) + sélecteurs tag/class. Pur, zéro dépendance.

Raison d'être : aucun parseur HTML (bs4/lxml/selectolax) n'est installé sur
l'Omen et P1 doit rester zéro-nouvelle-dépendance. On construit donc un arbre
léger suffisant pour l'extraction par tag + classe (le cas books.toscrape).
"""
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional, Union

VOID_TAGS = frozenset({
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
})


class Node(object):
    def __init__(self, tag: str, attrs: Optional[Dict[str, str]] = None) -> None:
        self.tag = tag
        self.attrs = attrs or {}
        self.children = []          # type: List[Node]
        self.parent = None          # type: Optional[Node]
        self._content = []          # type: List[Union[str, Node]]  # mixed, doc order

    def classes(self) -> List[str]:
        return (self.attrs.get("class") or "").split()

    def get_attr(self, name: str) -> str:
        return self.attrs.get(name, "") or ""

    def text(self) -> str:
        parts = []  # type: List[str]
        for item in self._content:
            if isinstance(item, Node):
                parts.append(item.text())
            else:
                parts.append(item)
        return " ".join(" ".join(parts).split())


class _TreeBuilder(HTMLParser):
    def __init__(self) -> None:
        HTMLParser.__init__(self, convert_charrefs=True)
        self.root = Node("#root")
        self._stack = [self.root]  # type: List[Node]

    def _append_child(self, node: Node) -> None:
        top = self._stack[-1]
        node.parent = top
        top.children.append(node)
        top._content.append(node)

    def handle_starttag(self, tag, attrs):
        node = Node(tag, {k: (v if v is not None else "") for k, v in attrs})
        self._append_child(node)
        if tag.lower() not in VOID_TAGS:
            self._stack.append(node)

    def handle_startendtag(self, tag, attrs):  # <br/> style
        node = Node(tag, {k: (v if v is not None else "") for k, v in attrs})
        self._append_child(node)

    def handle_endtag(self, tag):
        tag = tag.lower()
        # tolerant close: pop down to the nearest matching open tag
        for i in range(len(self._stack) - 1, 0, -1):
            if self._stack[i].tag.lower() == tag:
                del self._stack[i:]
                return

    def handle_data(self, data):
        if data:
            self._stack[-1]._content.append(data)


def parse_html(html: str) -> Node:
    b = _TreeBuilder()
    b.feed(html or "")
    b.close()
    return b.root


def node_matches(node: Node, sel: Dict[str, str]) -> bool:
    tag = sel.get("tag")
    cls = sel.get("class")
    if not tag and not cls:
        return False
    if tag and node.tag.lower() != tag.lower():
        return False
    if cls and cls not in node.classes():
        return False
    return True


def find_all(root: Node, sel: Dict[str, str]) -> List[Node]:
    out = []  # type: List[Node]

    def walk(n: Node) -> None:
        for c in n.children:
            if node_matches(c, sel):
                out.append(c)
            walk(c)

    walk(root)
    return out


def find_first(root: Node, sel: Dict[str, str]) -> Optional[Node]:
    for c in root.children:
        if node_matches(c, sel):
            return c
        found = find_first(c, sel)
        if found is not None:
            return found
    return None
