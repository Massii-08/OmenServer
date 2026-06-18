# AI Harvester — P1 (cœur déterministe) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the MVP that works — a deterministic, zero-LLM harvester that crawls a clean target (e.g. books.toscrape.com) low-and-slow over httpx, accumulates records through a no-PII gate into a resumable store, runs in a detached subprocess, and exposes the accumulated data via a key-protected private API, with an admin-only card + view in the Bots module.

**Architecture:** A pure backend engine package `backend/bots/harvester/` (DI everywhere — fetch/clock/sleep injected) mirroring the Bond Scanner's detached-subprocess pattern. The HTML extractor is built on the Python **stdlib `html.parser`** (a tiny DOM + tag/class selectors) because no HTML parser (bs4/lxml/selectolax) is installed and P1 must add **zero new dependencies** (`httpx` is already a dep). The router `harvester_router.py` launches `python -m backend.bots.harvester <run_dir>` detached (`start_new_session=True`), tracks the job in memory + a log-capture thread, and serves `/data/{id}` gated by a per-harvest `X-Feed-Key` header. The frontend adds an "AI Harvester" card (admin-only) and a dedicated `harvester_module.js` view (launch + live progress + feed key).

**Tech Stack:** Python 3.9 (no 3.10+ syntax — use `Optional`/`Dict`/`List` from `typing`, no `match`, no `X | Y`), FastAPI, httpx (already installed), stdlib `html.parser` + `xml.etree.ElementTree` + `urllib.parse` + `csv` + `json` + `secrets`. Frontend: vanilla JS, FR/EN/IT i18n. Tests: pytest with dependency injection (no network).

---

## Scope

This plan covers **P1 only** (spec §10). It deliberately excludes: Claude/`_claude` setup (`/setup`, P2), adaptive pacing module + stealth/unblocker tiers (P3), and the export package (P4). P1 produces a working harvester whose recipe/plan/pacing are supplied inline in the `/run` request (no LLM). Later phases plug into the same engine.

## Conventions (read before any task)

- **Python 3.9 only.** Imports: `from typing import Optional, Dict, List, Any, Callable, Tuple`. Never `str | None`, never `match`.
- **Test command** (run from project root, repo has a space in its path so quote it):
  ```bash
  cd "/Users/massimiliano/omenserver Project/Projet serveur"
  ./venv/bin/python -m pytest backend/bots/tests/ -q
  ```
- **Tests live in** `backend/bots/tests/` (existing `conftest.py`, `fixtures/`).
- **Admin gate** = strict `is_admin` (this bot is admin-only, not `money`). Use `get_current_user` from `backend.auth.utils` + a local `_require_admin(user)` raising 403 (mirrors `mc_agent_router`). The router test overrides `app.dependency_overrides[get_current_user]`.
- **No-PII gate ON by default**: every extracted record passes through `FieldPolicy.validate` before being stored.
- **Run dir layout**: `data/harvester_runs/<id>/config.json` (frozen recipe/plan/pacing/feed_key) + `data/harvester_runs/<id>/store.json` (frontier + records, written by the subprocess).

## File Structure (created in P1)

| File | Responsibility |
|---|---|
| `backend/bots/harvester/__init__.py` | package marker |
| `backend/bots/harvester/policy.py` | no-PII gate (`FieldPolicy`, `PII_FIELDS`, `PolicyViolation`) — pure |
| `backend/bots/harvester/dom.py` | stdlib `html.parser` → `Node` tree + `find_all`/`find_first` matchers — pure |
| `backend/bots/harvester/recipe.py` | `Recipe` model + deterministic `extract(html) -> records` — pure |
| `backend/bots/harvester/crawl.py` | `parse_sitemap`, `next_page_url`, `absolute_url` — pure |
| `backend/bots/harvester/store.py` | `Store` (frontier todo/done/seen + records, JSON persist/resume) — pure |
| `backend/bots/harvester/fetch.py` | `RateLimiter` + `HttpxFetcher` + `FetchError` — offline (client/clock/sleep injected) |
| `backend/bots/harvester/engine.py` | `Engine` paced loop — offline (fetch/sleep/stop injected) |
| `backend/bots/harvester/config.py` | `HarvestConfig` (load/save run dir) — pure |
| `backend/bots/harvester/__main__.py` | subprocess entrypoint: run_dir → engine → run, progress JSON lines |
| `backend/bots/harvester_router.py` | FastAPI router `/api/bots/harvester` (detached run + API) |
| `frontend/js/harvester_module.js` | dedicated view (launch + live progress + feed key) |
| Tests | `backend/bots/tests/test_harvester_*.py` (one per module) |

Modified: `backend/main.py` (mount router), `frontend/js/bots_module.js` (card + `openHarvester`), `frontend/js/lang.js` (`harvester.*` FR/EN/IT), `frontend/index.html` (script include + cache-bust), `frontend/sw.js` (CACHE_NAME + asset).

## Canonical interfaces (all tasks must match these names)

```python
# policy.py
class PolicyViolation(Exception): ...
class FieldPolicy:
    def __init__(self, allowed, pii_fields=PII_FIELDS): ...
    def validate(self, raw: Dict[str, Any]) -> Dict[str, Any]: ...

# dom.py — selector dict shape: {"tag": "article", "class": "product_pod"} (class optional, tag optional, >=1)
class Node:
    tag: str; attrs: Dict[str, str]; children: List["Node"]; parent: Optional["Node"]
    def classes(self) -> List[str]: ...
    def get_attr(self, name: str) -> str: ...
    def text(self) -> str: ...           # collapsed whitespace of subtree
def parse_html(html: str) -> Node: ...    # root Node, tag == "#root"
def node_matches(node: Node, sel: Dict[str, str]) -> bool: ...
def find_all(root: Node, sel: Dict[str, str]) -> List[Node]: ...
def find_first(root: Node, sel: Dict[str, str]) -> Optional[Node]: ...

# recipe.py — field spec: {"selector": {tag,class}|absent, "extract": "text"|"attr:NAME"|"class:N"}
class Recipe:
    item_selector: Dict[str, str]; fields: Dict[str, Dict[str, Any]]
    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Recipe": ...
    def to_dict(self) -> Dict[str, Any]: ...
    def field_names(self) -> List[str]: ...
    def extract(self, html: str) -> List[Dict[str, str]]: ...

# crawl.py
def absolute_url(base: str, href: str) -> str: ...
def parse_sitemap(xml: str) -> List[str]: ...
def next_page_url(html: str, base_url: str, next_selector: Dict[str, str]) -> Optional[str]: ...

# store.py
class Store:
    def __init__(self, path: str): ...
    def add_todo(self, url: str) -> bool: ...        # False if already seen
    def next_todo(self) -> Optional[str]: ...
    def mark_done(self, url: str) -> None: ...
    def add_record(self, rec: Dict[str, Any]) -> None: ...
    def counts(self) -> Dict[str, int]: ...          # {"todo","done","records","errors"}
    def add_error(self) -> None: ...
    def save(self) -> None: ...
    @classmethod
    def load(cls, path: str) -> "Store": ...

# fetch.py
class FetchError(Exception): ...
class RateLimiter:
    def __init__(self, min_interval_s, clock=time.monotonic, sleep=time.sleep): ...
    def wait(self) -> None: ...
class HttpxFetcher:
    def __init__(self, rate, retries=3, timeout=20.0, user_agent=DEFAULT_UA, client=None): ...
    def get(self, url: str) -> str: ...

# engine.py
class Engine:
    def __init__(self, store, recipe, fetcher, policy, plan,
                 sleep=time.sleep, jitter=None, on_progress=None,
                 should_stop=None, error_backoff_s=10.0): ...
    def step(self) -> bool: ...   # one iteration; False when frontier empty / stopped
    def run(self) -> None: ...

# config.py
class HarvestConfig:
    url: str; recipe: Recipe; plan: Dict[str, Any]; pacing: Dict[str, Any]; feed_key: str
    @classmethod
    def from_dict(cls, d) -> "HarvestConfig": ...
    def to_dict(self) -> Dict[str, Any]: ...
    @classmethod
    def load(cls, run_dir: str) -> "HarvestConfig": ...
    def save(self, run_dir: str) -> None: ...
```

---

## Task 1: policy.py — no-PII gate

**Files:**
- Create: `backend/bots/harvester/__init__.py`
- Create: `backend/bots/harvester/policy.py`
- Test: `backend/bots/tests/test_harvester_policy.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/bots/tests/test_harvester_policy.py
import pytest
from backend.bots.harvester.policy import FieldPolicy, PolicyViolation, PII_FIELDS


def test_allows_clean_record_and_drops_unlisted():
    policy = FieldPolicy(allowed=["title", "price"])
    out = policy.validate({"title": "Book", "price": "£10", "junk": "x"})
    assert out == {"title": "Book", "price": "£10"}


def test_raises_on_pii_field_even_if_allowed():
    policy = FieldPolicy(allowed=["email"])
    with pytest.raises(PolicyViolation):
        policy.validate({"email": "x@example.com"})


def test_pii_check_is_case_insensitive():
    policy = FieldPolicy(allowed=["title"])
    with pytest.raises(PolicyViolation):
        policy.validate({"title": "Book", "Email": "x@example.com"})
    with pytest.raises(PolicyViolation):
        policy.validate({"PHONE": "12345"})


def test_every_known_pii_field_is_blocked():
    for pii in PII_FIELDS:
        policy = FieldPolicy(allowed=[pii])
        with pytest.raises(PolicyViolation):
            policy.validate({pii: "value"})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_policy.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'backend.bots.harvester'`

- [ ] **Step 3: Write minimal implementation**

```python
# backend/bots/harvester/__init__.py
"""AI Harvester — moteur déterministe (P1). Aucune dépendance hors stdlib + httpx."""
```

```python
# backend/bots/harvester/policy.py
"""No-PII gate, porté de Feedsmith (FieldPolicy). Pur, zéro dépendance."""
from typing import Any, Dict, Iterable

PII_FIELDS = frozenset({
    "name", "first_name", "last_name", "fullname",
    "email", "phone", "mobile",
    "address", "street",
    "ssn", "tax_id", "dob", "birthdate",
    "photo", "avatar",
    "ip", "ip_address",
    "user_id", "username", "profile_url",
})


class PolicyViolation(Exception):
    """Levée quand un record brut contient un champ PII interdit."""
    pass


class FieldPolicy:
    """Politique no-PII stricte : rejette tout record contenant un nom de champ
    PII, et ne garde que les clés explicitement autorisées (le reste est ignoré)."""

    def __init__(self, allowed: Iterable[str], pii_fields: frozenset = PII_FIELDS) -> None:
        self.allowed = set(allowed)
        self.pii_fields = pii_fields

    def validate(self, raw: Dict[str, Any]) -> Dict[str, Any]:
        for key in raw:
            if key.lower() in self.pii_fields:
                raise PolicyViolation(
                    "PII field '{0}' is not allowed in this feed".format(key)
                )
        return {k: v for k, v in raw.items() if k in self.allowed}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_policy.py -q`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/bots/harvester/__init__.py backend/bots/harvester/policy.py backend/bots/tests/test_harvester_policy.py
git commit -m "feat(harvester): no-PII gate (FieldPolicy) — P1 task 1"
```

---

## Task 2: dom.py — stdlib HTML parser + selectors

**Files:**
- Create: `backend/bots/harvester/dom.py`
- Test: `backend/bots/tests/test_harvester_dom.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/bots/tests/test_harvester_dom.py
from backend.bots.harvester.dom import parse_html, find_all, find_first, node_matches

HTML = """
<html><body>
  <article class="product_pod">
    <h3><a href="cat/book1.html" title="Book One">Book One trunc</a></h3>
    <p class="price_color">£51.77</p>
    <p class="instock availability">  In stock  </p>
    <p class="star-rating Three"></p>
  </article>
  <article class="product_pod">
    <h3><a href="cat/book2.html" title="Book Two">Book Two trunc</a></h3>
    <p class="price_color">£10.00</p>
    <p class="instock availability">In stock</p>
    <p class="star-rating One"></p>
  </article>
</body></html>
"""


def test_find_all_by_tag_and_class():
    root = parse_html(HTML)
    pods = find_all(root, {"tag": "article", "class": "product_pod"})
    assert len(pods) == 2


def test_find_first_descendant_and_attr():
    root = parse_html(HTML)
    pod = find_all(root, {"tag": "article", "class": "product_pod"})[0]
    a = find_first(pod, {"tag": "a"})
    assert a is not None
    assert a.get_attr("title") == "Book One"
    assert a.get_attr("href") == "cat/book1.html"


def test_text_is_whitespace_collapsed():
    root = parse_html(HTML)
    pod = find_all(root, {"tag": "article", "class": "product_pod"})[0]
    avail = find_first(pod, {"tag": "p", "class": "availability"})
    assert avail.text() == "In stock"


def test_classes_and_node_matches():
    root = parse_html(HTML)
    pod = find_all(root, {"tag": "article", "class": "product_pod"})[0]
    star = find_first(pod, {"tag": "p", "class": "star-rating"})
    assert star.classes() == ["star-rating", "Three"]
    assert node_matches(star, {"tag": "p", "class": "Three"}) is True
    assert node_matches(star, {"tag": "p", "class": "Five"}) is False


def test_void_elements_do_not_nest():
    root = parse_html("<div><img src='a.png'><p>after</p></div>")
    div = find_first(root, {"tag": "div"})
    # img is void -> p is a sibling of img, both direct children of div
    assert [c.tag for c in div.children] == ["img", "p"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_dom.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'backend.bots.harvester.dom'`

- [ ] **Step 3: Write minimal implementation**

```python
# backend/bots/harvester/dom.py
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_dom.py -q`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/bots/harvester/dom.py backend/bots/tests/test_harvester_dom.py
git commit -m "feat(harvester): stdlib mini-DOM + tag/class selectors — P1 task 2"
```

---

## Task 3: recipe.py — deterministic extractor

**Files:**
- Create: `backend/bots/harvester/recipe.py`
- Test: `backend/bots/tests/test_harvester_recipe.py`

The field-spec `extract` grammar: `"text"` (collapsed subtree text), `"attr:<name>"` (attribute value), `"class:<n>"` (the n-th class token, 0-based — used for `star-rating Three` → `class:1` → `"Three"`). If a field has no `"selector"`, the field is extracted from the item element itself.

- [ ] **Step 1: Write the failing test**

```python
# backend/bots/tests/test_harvester_recipe.py
from backend.bots.harvester.recipe import Recipe

HTML = """
<html><body>
  <article class="product_pod">
    <h3><a href="cat/book1.html" title="Book One">Book One trunc</a></h3>
    <p class="price_color">£51.77</p>
    <p class="instock availability">  In stock  </p>
    <p class="star-rating Three"></p>
  </article>
  <article class="product_pod">
    <h3><a href="cat/book2.html" title="Book Two">Book Two trunc</a></h3>
    <p class="price_color">£10.00</p>
    <p class="instock availability">In stock</p>
    <p class="star-rating One"></p>
  </article>
</body></html>
"""

RECIPE = {
    "item_selector": {"tag": "article", "class": "product_pod"},
    "fields": {
        "title": {"selector": {"tag": "a"}, "extract": "attr:title"},
        "url": {"selector": {"tag": "a"}, "extract": "attr:href"},
        "price": {"selector": {"tag": "p", "class": "price_color"}, "extract": "text"},
        "availability": {"selector": {"tag": "p", "class": "availability"}, "extract": "text"},
        "rating": {"selector": {"tag": "p", "class": "star-rating"}, "extract": "class:1"},
    },
}


def test_from_dict_roundtrip():
    r = Recipe.from_dict(RECIPE)
    assert r.to_dict() == RECIPE
    assert sorted(r.field_names()) == ["availability", "price", "rating", "title", "url"]


def test_extract_two_records():
    r = Recipe.from_dict(RECIPE)
    records = r.extract(HTML)
    assert records == [
        {"title": "Book One", "url": "cat/book1.html", "price": "£51.77",
         "availability": "In stock", "rating": "Three"},
        {"title": "Book Two", "url": "cat/book2.html", "price": "£10.00",
         "availability": "In stock", "rating": "One"},
    ]


def test_missing_node_yields_empty_string():
    r = Recipe.from_dict({
        "item_selector": {"tag": "article", "class": "product_pod"},
        "fields": {"missing": {"selector": {"tag": "span", "class": "nope"}, "extract": "text"}},
    })
    records = r.extract(HTML)
    assert records == [{"missing": ""}, {"missing": ""}]


def test_extract_from_item_itself_when_no_selector():
    r = Recipe.from_dict({
        "item_selector": {"tag": "p", "class": "price_color"},
        "fields": {"price": {"extract": "text"}},
    })
    assert r.extract(HTML) == [{"price": "£51.77"}, {"price": "£10.00"}]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_recipe.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'backend.bots.harvester.recipe'`

- [ ] **Step 3: Write minimal implementation**

```python
# backend/bots/harvester/recipe.py
"""Recette d'extraction {item_selector, fields} + extracteur déterministe.

Zéro LLM, zéro dépendance : repose sur dom.py. Une recette décrit comment
transformer un HTML en liste de records (un par élément 'item')."""
from typing import Any, Dict, List, Optional

from backend.bots.harvester.dom import Node, find_all, find_first, parse_html


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
                sel = spec.get("selector")
                node = find_first(item, sel) if sel else item
                rec[field] = apply_extract(node, spec.get("extract", "text"))
            records.append(rec)
        return records
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_recipe.py -q`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/bots/harvester/recipe.py backend/bots/tests/test_harvester_recipe.py
git commit -m "feat(harvester): deterministic recipe extractor — P1 task 3"
```

---

## Task 4: crawl.py — sitemap + pagination

**Files:**
- Create: `backend/bots/harvester/crawl.py`
- Test: `backend/bots/tests/test_harvester_crawl.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/bots/tests/test_harvester_crawl.py
from backend.bots.harvester.crawl import absolute_url, parse_sitemap, next_page_url

SITEMAP = """<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://x.test/a.html</loc></url>
  <url><loc>https://x.test/b.html</loc></url>
</urlset>"""

SITEMAP_INDEX = """<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://x.test/sitemap1.xml</loc></sitemap>
  <sitemap><loc>https://x.test/sitemap2.xml</loc></sitemap>
</sitemapindex>"""

PAGE_WITH_NEXT = """
<html><body>
  <ul class="pager">
    <li class="next"><a href="page-2.html">next</a></li>
  </ul>
</body></html>"""

PAGE_NO_NEXT = "<html><body><ul class='pager'></ul></body></html>"


def test_absolute_url_resolves_relative():
    assert absolute_url("https://x.test/catalogue/page-1.html", "page-2.html") == \
        "https://x.test/catalogue/page-2.html"
    assert absolute_url("https://x.test/catalogue/page-1.html", "/z.html") == \
        "https://x.test/z.html"


def test_parse_sitemap_urlset():
    assert parse_sitemap(SITEMAP) == ["https://x.test/a.html", "https://x.test/b.html"]


def test_parse_sitemap_index():
    assert parse_sitemap(SITEMAP_INDEX) == \
        ["https://x.test/sitemap1.xml", "https://x.test/sitemap2.xml"]


def test_next_page_url_found():
    nxt = next_page_url(PAGE_WITH_NEXT, "https://x.test/catalogue/page-1.html",
                        {"tag": "li", "class": "next"})
    assert nxt == "https://x.test/catalogue/page-2.html"


def test_next_page_url_absent_returns_none():
    assert next_page_url(PAGE_NO_NEXT, "https://x.test/catalogue/page-1.html",
                         {"tag": "li", "class": "next"}) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_crawl.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'backend.bots.harvester.crawl'`

- [ ] **Step 3: Write minimal implementation**

```python
# backend/bots/harvester/crawl.py
"""Exécuteur de plan de crawl : énumération d'URL (sitemap / pagination).

Pur, zéro dépendance (xml.etree + urllib.parse stdlib + dom.py)."""
import xml.etree.ElementTree as ET
from typing import Dict, List, Optional
from urllib.parse import urljoin

from backend.bots.harvester.dom import find_first, parse_html


def absolute_url(base: str, href: str) -> str:
    return urljoin(base, href)


def parse_sitemap(xml: str) -> List[str]:
    """Retourne les <loc> d'un <urlset> OU d'un <sitemapindex> (namespace-agnostique)."""
    locs = []  # type: List[str]
    try:
        root = ET.fromstring(xml.strip())
    except ET.ParseError:
        return locs
    for el in root.iter():
        tag = el.tag.rsplit("}", 1)[-1]  # strip namespace
        if tag == "loc" and el.text:
            locs.append(el.text.strip())
    return locs


def next_page_url(html: str, base_url: str, next_selector: Dict[str, str]) -> Optional[str]:
    """Suit le lien 'page suivante' : 1er <a href> sous l'élément next_selector."""
    root = parse_html(html)
    container = find_first(root, next_selector)
    if container is None:
        return None
    anchor = find_first(container, {"tag": "a"})
    if anchor is None:
        return None
    href = anchor.get_attr("href")
    if not href:
        return None
    return absolute_url(base_url, href)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_crawl.py -q`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/bots/harvester/crawl.py backend/bots/tests/test_harvester_crawl.py
git commit -m "feat(harvester): crawl plan (sitemap + pagination next-link) — P1 task 4"
```

---

## Task 5: store.py — resumable frontier + records

**Files:**
- Create: `backend/bots/harvester/store.py`
- Test: `backend/bots/tests/test_harvester_store.py`

Semantics: `add_todo(url)` returns `False` and is a no-op if the url has already been seen (queued, done, or errored) — this is what makes the crawl converge and the store deduplicate. `next_todo()` returns the first queued url not yet done. State persists to JSON; `load()` rebuilds the same state (resume after reboot).

- [ ] **Step 1: Write the failing test**

```python
# backend/bots/tests/test_harvester_store.py
from backend.bots.harvester.store import Store


def test_add_todo_dedups_and_next_todo_order(tmp_path):
    s = Store(str(tmp_path / "store.json"))
    assert s.add_todo("u1") is True
    assert s.add_todo("u2") is True
    assert s.add_todo("u1") is False  # already seen
    assert s.next_todo() == "u1"
    s.mark_done("u1")
    assert s.next_todo() == "u2"


def test_add_todo_after_done_is_noop(tmp_path):
    s = Store(str(tmp_path / "store.json"))
    s.add_todo("u1")
    s.mark_done("u1")
    assert s.add_todo("u1") is False  # done counts as seen
    assert s.next_todo() is None


def test_records_and_counts(tmp_path):
    s = Store(str(tmp_path / "store.json"))
    s.add_todo("u1")
    s.add_record({"title": "A"})
    s.add_record({"title": "B"})
    s.add_error()
    c = s.counts()
    assert c == {"todo": 1, "done": 0, "records": 2, "errors": 1}


def test_save_and_resume_roundtrip(tmp_path):
    path = str(tmp_path / "store.json")
    s = Store(path)
    s.add_todo("u1")
    s.add_todo("u2")
    s.mark_done("u1")
    s.add_record({"title": "A"})
    s.save()

    s2 = Store.load(path)
    assert s2.next_todo() == "u2"          # u1 already done, not re-served
    assert s2.add_todo("u1") is False      # seen survives reload
    assert s2.counts() == {"todo": 1, "done": 1, "records": 1, "errors": 0}


def test_load_missing_file_is_empty(tmp_path):
    s = Store.load(str(tmp_path / "nope.json"))
    assert s.next_todo() is None
    assert s.counts() == {"todo": 0, "done": 0, "records": 0, "errors": 0}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_store.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'backend.bots.harvester.store'`

- [ ] **Step 3: Write minimal implementation**

```python
# backend/bots/harvester/store.py
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_store.py -q`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/bots/harvester/store.py backend/bots/tests/test_harvester_store.py
git commit -m "feat(harvester): resumable frontier store — P1 task 5"
```

---

## Task 6: fetch.py — httpx fetcher + RateLimiter

**Files:**
- Create: `backend/bots/harvester/fetch.py`
- Test: `backend/bots/tests/test_harvester_fetch.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/bots/tests/test_harvester_fetch.py
import httpx
import pytest

from backend.bots.harvester.fetch import FetchError, HttpxFetcher, RateLimiter


def _silent_rate():
    return RateLimiter(0.0, clock=lambda: 0.0, sleep=lambda s: None)


def test_rate_limiter_sleeps_remaining_interval():
    t = {"now": 0.0}
    slept = []
    rate = RateLimiter(5.0, clock=lambda: t["now"], sleep=lambda s: slept.append(s))
    rate.wait()              # first call: no wait
    t["now"] = 2.0
    rate.wait()              # only 2s elapsed of 5 -> sleep 3
    assert slept == [3.0]


def test_httpx_fetcher_success_returns_body():
    def handler(request):
        return httpx.Response(200, text="<html>ok</html>")
    client = httpx.Client(transport=httpx.MockTransport(handler))
    f = HttpxFetcher(rate=_silent_rate(), retries=3, client=client)
    assert f.get("https://books.toscrape.com/") == "<html>ok</html>"


def test_httpx_fetcher_retries_then_raises_on_persistent_error():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(503, text="busy")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    f = HttpxFetcher(rate=_silent_rate(), retries=3, client=client,
                     sleep=lambda s: None)
    with pytest.raises(FetchError):
        f.get("https://books.toscrape.com/")
    assert calls["n"] == 3  # retried up to `retries` times


def test_httpx_fetcher_recovers_on_second_try():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(500, text="err")
        return httpx.Response(200, text="<html>good</html>")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    f = HttpxFetcher(rate=_silent_rate(), retries=3, client=client,
                     sleep=lambda s: None)
    assert f.get("https://x.test/") == "<html>good</html>"
    assert calls["n"] == 2
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_fetch.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'backend.bots.harvester.fetch'`

- [ ] **Step 3: Write minimal implementation**

```python
# backend/bots/harvester/fetch.py
"""Fetcher à tiers — P1 = httpx seul (déjà une dépendance du projet).

RateLimiter et HttpxFetcher prennent clock/sleep/client injectables → test
offline déterministe (httpx.MockTransport, pas de réseau, pas d'horloge réelle).
Les tiers curl_cffi / stealth / unblocker arrivent en P3."""
import time
from typing import Any, Callable, Optional

DEFAULT_UA = "OmenHarvester/0.1 (+https://omenserver.org) polite-crawler"


class FetchError(Exception):
    pass


class RateLimiter(object):
    """Garantit un intervalle minimal entre deux retours de wait()."""

    def __init__(self, min_interval_s: float,
                 clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], None] = time.sleep) -> None:
        self.min_interval_s = min_interval_s
        self._clock = clock
        self._sleep = sleep
        self._last = None  # type: Optional[float]

    def wait(self) -> None:
        now = self._clock()
        if self._last is not None:
            remaining = self.min_interval_s - (now - self._last)
            if remaining > 0:
                self._sleep(remaining)
                now = self._clock()
        self._last = now


class HttpxFetcher(object):
    """Fetcher httpx avec retries à back-off linéaire. `client` injectable."""

    def __init__(self, rate: RateLimiter, retries: int = 3, timeout: float = 20.0,
                 user_agent: str = DEFAULT_UA, client: Optional[Any] = None,
                 sleep: Callable[[float], None] = time.sleep) -> None:
        self.rate = rate
        self.retries = retries
        self.timeout = timeout
        self.user_agent = user_agent
        self._client = client
        self._sleep = sleep

    def _get_client(self):
        if self._client is not None:
            return self._client
        import httpx  # lazy
        self._client = httpx.Client(
            timeout=self.timeout,
            headers={"User-Agent": self.user_agent},
            follow_redirects=True,
        )
        return self._client

    def get(self, url: str) -> str:
        import httpx  # lazy
        client = self._get_client()
        last = None  # type: Optional[str]
        for attempt in range(self.retries):
            self.rate.wait()
            try:
                resp = client.get(url)
                if resp.status_code >= 400:
                    last = "HTTP {0}".format(resp.status_code)
                else:
                    return resp.text
            except httpx.HTTPError as e:
                last = repr(e)
            if attempt < self.retries - 1:
                self._sleep(1.0 * (attempt + 1))  # linear back-off
        raise FetchError("GET {0} failed: {1}".format(url, last))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_fetch.py -q`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/bots/harvester/fetch.py backend/bots/tests/test_harvester_fetch.py
git commit -m "feat(harvester): httpx fetcher + rate limiter (offline-testable) — P1 task 6"
```

---

## Task 7: engine.py — paced harvest loop

**Files:**
- Create: `backend/bots/harvester/engine.py`
- Test: `backend/bots/tests/test_harvester_engine.py`

The loop (one `step()`): pop `next_todo`; if none → return `False`. Fetch it. On `FetchError`: `store.add_error()`, `store.mark_done(url)` (so it isn't retried forever), sleep `error_backoff_s`, `save`, return `True`. On success: `recipe.extract` → for each record, `policy.validate` then `store.add_record`; if `plan["mode"] == "pagination"`, compute `next_page_url` and `store.add_todo` it; `store.mark_done(url)`; `save`; emit progress; `rate`-pacing happens inside the fetcher's `RateLimiter.wait`, plus the engine sleeps a per-step `jitter()` if provided. `run()` calls `step()` until it returns `False` or `should_stop()` is true.

PolicyViolation is **fatal** (a recipe asking for a PII field is misconfiguration) — `run()` lets it propagate so the subprocess exits non-zero and the router marks the job `error`.

- [ ] **Step 1: Write the failing test**

```python
# backend/bots/tests/test_harvester_engine.py
import pytest

from backend.bots.harvester.engine import Engine
from backend.bots.harvester.policy import FieldPolicy, PolicyViolation
from backend.bots.harvester.recipe import Recipe
from backend.bots.harvester.store import Store

LISTING_RECIPE = {
    "item_selector": {"tag": "article", "class": "product_pod"},
    "fields": {
        "title": {"selector": {"tag": "a"}, "extract": "attr:title"},
        "price": {"selector": {"tag": "p", "class": "price_color"}, "extract": "text"},
    },
}

PAGE1 = """<html><body>
  <article class="product_pod"><h3><a title="A">a</a></h3><p class="price_color">£1</p></article>
  <ul class="pager"><li class="next"><a href="page-2.html">next</a></li></ul>
</body></html>"""

PAGE2 = """<html><body>
  <article class="product_pod"><h3><a title="B">b</a></h3><p class="price_color">£2</p></article>
</body></html>"""

PLAN = {"mode": "pagination", "next_selector": {"tag": "li", "class": "next"}}


class FakeFetcher(object):
    def __init__(self, pages):
        self.pages = pages
        self.calls = []

    def get(self, url):
        self.calls.append(url)
        return self.pages[url]


def _store(tmp_path):
    return Store(str(tmp_path / "store.json"))


def test_engine_follows_pagination_and_collects_all(tmp_path):
    pages = {
        "https://x.test/page-1.html": PAGE1,
        "https://x.test/page-2.html": PAGE2,
    }
    store = _store(tmp_path)
    store.add_todo("https://x.test/page-1.html")
    slept = []
    eng = Engine(store, Recipe.from_dict(LISTING_RECIPE), FakeFetcher(pages),
                 FieldPolicy(allowed=["title", "price"]), PLAN,
                 sleep=lambda s: slept.append(s), jitter=lambda: 2.5)
    eng.run()
    assert store.records() == [
        {"title": "A", "price": "£1"},
        {"title": "B", "price": "£2"},
    ]
    assert store.counts()["done"] == 2
    assert store.counts()["todo"] == 0
    assert 2.5 in slept  # per-step jitter applied


def test_engine_ordering_fetch_then_extract_then_store(tmp_path):
    pages = {"https://x.test/page-1.html": PAGE1, "https://x.test/page-2.html": PAGE2}
    fetcher = FakeFetcher(pages)
    store = _store(tmp_path)
    store.add_todo("https://x.test/page-1.html")
    eng = Engine(store, Recipe.from_dict(LISTING_RECIPE), fetcher,
                 FieldPolicy(allowed=["title", "price"]), PLAN, sleep=lambda s: None)
    eng.run()
    assert fetcher.calls == ["https://x.test/page-1.html", "https://x.test/page-2.html"]


def test_engine_resume_skips_done_urls(tmp_path):
    pages = {"https://x.test/page-1.html": PAGE1, "https://x.test/page-2.html": PAGE2}
    store = _store(tmp_path)
    store.add_todo("https://x.test/page-1.html")
    store.mark_done("https://x.test/page-1.html")   # already fetched in a prior run
    store.add_todo("https://x.test/page-2.html")
    fetcher = FakeFetcher(pages)
    eng = Engine(store, Recipe.from_dict(LISTING_RECIPE), fetcher,
                 FieldPolicy(allowed=["title", "price"]), PLAN, sleep=lambda s: None)
    eng.run()
    assert fetcher.calls == ["https://x.test/page-2.html"]  # page-1 not re-fetched


def test_engine_should_stop_halts_loop(tmp_path):
    pages = {"https://x.test/page-1.html": PAGE1, "https://x.test/page-2.html": PAGE2}
    store = _store(tmp_path)
    store.add_todo("https://x.test/page-1.html")
    eng = Engine(store, Recipe.from_dict(LISTING_RECIPE), FakeFetcher(pages),
                 FieldPolicy(allowed=["title", "price"]), PLAN,
                 sleep=lambda s: None, should_stop=lambda: True)
    eng.run()
    assert store.records() == []          # stopped before first fetch
    assert store.counts()["done"] == 0


def test_engine_fetch_error_backs_off_and_marks_done(tmp_path):
    from backend.bots.harvester.fetch import FetchError

    class BoomFetcher(object):
        def get(self, url):
            raise FetchError("boom")

    store = _store(tmp_path)
    store.add_todo("https://x.test/page-1.html")
    slept = []
    eng = Engine(store, Recipe.from_dict(LISTING_RECIPE), BoomFetcher(),
                 FieldPolicy(allowed=["title", "price"]), PLAN,
                 sleep=lambda s: slept.append(s), error_backoff_s=10.0)
    eng.run()
    assert store.counts()["errors"] == 1
    assert store.counts()["done"] == 1   # marked done so it isn't retried forever
    assert 10.0 in slept                 # back-off applied


def test_engine_policy_violation_is_fatal(tmp_path):
    pages = {"https://x.test/page-1.html": PAGE1, "https://x.test/page-2.html": PAGE2}
    store = _store(tmp_path)
    store.add_todo("https://x.test/page-1.html")
    bad_recipe = {
        "item_selector": {"tag": "article", "class": "product_pod"},
        "fields": {"email": {"selector": {"tag": "a"}, "extract": "attr:title"}},
    }
    eng = Engine(store, Recipe.from_dict(bad_recipe), FakeFetcher(pages),
                 FieldPolicy(allowed=["email"]), PLAN, sleep=lambda s: None)
    with pytest.raises(PolicyViolation):
        eng.run()


def test_engine_sitemap_mode_no_pagination(tmp_path):
    store = _store(tmp_path)
    store.add_todo("https://x.test/page-1.html")
    fetcher = FakeFetcher({"https://x.test/page-1.html": PAGE1})
    eng = Engine(store, Recipe.from_dict(LISTING_RECIPE), fetcher,
                 FieldPolicy(allowed=["title", "price"]),
                 {"mode": "sitemap"}, sleep=lambda s: None)
    eng.run()
    assert fetcher.calls == ["https://x.test/page-1.html"]  # no next-link followed
    assert store.records() == [{"title": "A", "price": "£1"}]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_engine.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'backend.bots.harvester.engine'`

- [ ] **Step 3: Write minimal implementation**

```python
# backend/bots/harvester/engine.py
"""Boucle de moisson : frontier -> fetch -> extract -> no-PII gate -> store ->
pacing -> reprise. Déterministe, zéro IA. fetch/sleep/stop/horloge injectés →
test offline, zéro réseau.

Pacing = deux niveaux : l'intervalle minimal est tenu par le RateLimiter DANS
le fetcher (anti speed-flag), et l'engine ajoute un jitter par étape si fourni.
Le back-off adaptatif riche (429/cooldown) arrive en P3 ; P1 a un back-off
linéaire simple sur erreur de fetch."""
import time
from typing import Any, Callable, Dict, Optional

from backend.bots.harvester.crawl import next_page_url
from backend.bots.harvester.fetch import FetchError


class Engine(object):
    def __init__(self, store, recipe, fetcher, policy, plan,
                 sleep: Callable[[float], None] = time.sleep,
                 jitter: Optional[Callable[[], float]] = None,
                 on_progress: Optional[Callable[[Dict[str, Any]], None]] = None,
                 should_stop: Optional[Callable[[], bool]] = None,
                 error_backoff_s: float = 10.0) -> None:
        self.store = store
        self.recipe = recipe
        self.fetcher = fetcher
        self.policy = policy
        self.plan = plan or {}
        self._sleep = sleep
        self._jitter = jitter
        self._on_progress = on_progress
        self._should_stop = should_stop or (lambda: False)
        self.error_backoff_s = error_backoff_s

    def _progress(self) -> None:
        if self._on_progress:
            self._on_progress(self.store.counts())

    def step(self) -> bool:
        if self._should_stop():
            return False
        url = self.store.next_todo()
        if url is None:
            return False

        try:
            html = self.fetcher.get(url)
        except FetchError:
            self.store.add_error()
            self.store.mark_done(url)
            self.store.save()
            self._progress()
            self._sleep(self.error_backoff_s)
            return True

        for raw in self.recipe.extract(html):
            clean = self.policy.validate(raw)   # PolicyViolation -> propagates (fatal)
            self.store.add_record(clean)

        if self.plan.get("mode") == "pagination":
            nxt = next_page_url(html, url, self.plan.get("next_selector") or {})
            if nxt:
                self.store.add_todo(nxt)

        self.store.mark_done(url)
        self.store.save()
        self._progress()
        if self._jitter is not None:
            self._sleep(self._jitter())
        return True

    def run(self) -> None:
        while True:
            if self._should_stop():
                return
            if not self.step():
                return
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_engine.py -q`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/bots/harvester/engine.py backend/bots/tests/test_harvester_engine.py
git commit -m "feat(harvester): paced harvest engine (DI, offline-testable) — P1 task 7"
```

---

## Task 8: config.py + __main__.py — subprocess entrypoint

**Files:**
- Create: `backend/bots/harvester/config.py`
- Create: `backend/bots/harvester/__main__.py`
- Test: `backend/bots/tests/test_harvester_config.py`
- Test: `backend/bots/tests/test_harvester_main.py`

- [ ] **Step 1: Write the failing test (config)**

```python
# backend/bots/tests/test_harvester_config.py
from backend.bots.harvester.config import HarvestConfig
from backend.bots.harvester.recipe import Recipe

CFG = {
    "url": "https://books.toscrape.com/catalogue/page-1.html",
    "recipe": {
        "item_selector": {"tag": "article", "class": "product_pod"},
        "fields": {"title": {"selector": {"tag": "a"}, "extract": "attr:title"}},
    },
    "plan": {"mode": "pagination", "next_selector": {"tag": "li", "class": "next"}},
    "pacing": {"min_interval_s": 1.5, "jitter": [0.5, 2.0]},
    "feed_key": "abc123",
}


def test_from_dict_to_dict_roundtrip():
    cfg = HarvestConfig.from_dict(CFG)
    assert isinstance(cfg.recipe, Recipe)
    assert cfg.feed_key == "abc123"
    assert cfg.to_dict() == CFG


def test_save_and_load_run_dir(tmp_path):
    cfg = HarvestConfig.from_dict(CFG)
    cfg.save(str(tmp_path))
    assert (tmp_path / "config.json").is_file()
    loaded = HarvestConfig.load(str(tmp_path))
    assert loaded.to_dict() == CFG
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_config.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'backend.bots.harvester.config'`

- [ ] **Step 3: Write minimal implementation (config)**

```python
# backend/bots/harvester/config.py
"""Config figée d'un harvest (url + recette + plan + pacing + clé de feed),
persistée dans run_dir/config.json. Pure."""
import json
import os
from typing import Any, Dict

from backend.bots.harvester.recipe import Recipe


class HarvestConfig(object):
    def __init__(self, url: str, recipe: Recipe, plan: Dict[str, Any],
                 pacing: Dict[str, Any], feed_key: str) -> None:
        self.url = url
        self.recipe = recipe
        self.plan = plan
        self.pacing = pacing
        self.feed_key = feed_key

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "HarvestConfig":
        return cls(
            url=d["url"],
            recipe=Recipe.from_dict(d["recipe"]),
            plan=d.get("plan", {}),
            pacing=d.get("pacing", {}),
            feed_key=d["feed_key"],
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "url": self.url,
            "recipe": self.recipe.to_dict(),
            "plan": self.plan,
            "pacing": self.pacing,
            "feed_key": self.feed_key,
        }

    @classmethod
    def load(cls, run_dir: str) -> "HarvestConfig":
        with open(os.path.join(run_dir, "config.json"), "r", encoding="utf-8") as f:
            return cls.from_dict(json.load(f))

    def save(self, run_dir: str) -> None:
        os.makedirs(run_dir, exist_ok=True)
        with open(os.path.join(run_dir, "config.json"), "w", encoding="utf-8") as f:
            json.dump(self.to_dict(), f, ensure_ascii=False, indent=2)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_config.py -q`
Expected: PASS (2 tests)

- [ ] **Step 5: Write the failing test (__main__)**

```python
# backend/bots/tests/test_harvester_main.py
import json

from backend.bots.harvester import __main__ as entry
from backend.bots.harvester.config import HarvestConfig
from backend.bots.harvester.store import Store

CFG = {
    "url": "https://x.test/page-1.html",
    "recipe": {
        "item_selector": {"tag": "article", "class": "product_pod"},
        "fields": {"title": {"selector": {"tag": "a"}, "extract": "attr:title"}},
    },
    "plan": {"mode": "sitemap"},
    "pacing": {"min_interval_s": 0.0, "jitter": [0.0, 0.0]},
    "feed_key": "k",
}

PAGE = ('<html><body><article class="product_pod"><h3>'
        '<a title="A">a</a></h3></article></body></html>')


class FakeFetcher(object):
    def get(self, url):
        return PAGE


def test_run_harvest_writes_store(tmp_path, monkeypatch):
    HarvestConfig.from_dict(CFG).save(str(tmp_path))
    # seed the frontier with the start url
    store = Store(str(tmp_path / "store.json"))
    store.add_todo(CFG["url"])
    store.save()

    rc = entry.run_harvest(str(tmp_path), fetcher=FakeFetcher())
    assert rc == 0

    written = Store.load(str(tmp_path / "store.json"))
    assert written.records() == [{"title": "A"}]
    assert written.counts()["done"] == 1
```

- [ ] **Step 6: Run test to verify it fails**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_main.py -q`
Expected: FAIL — `AttributeError: module ... has no attribute 'run_harvest'`

- [ ] **Step 7: Write minimal implementation (__main__)**

```python
# backend/bots/harvester/__main__.py
"""Entrypoint du subprocess détaché : `python -m backend.bots.harvester <run_dir>`.

Charge config.json + store.json depuis run_dir, construit l'engine httpx, et
boucle. Émet la progression en lignes JSON sur stdout (capturées par le router).
fetcher injectable → test offline (run_harvest)."""
import json
import os
import random
import sys
import time
from typing import Any, Dict, Optional

from backend.bots.harvester.config import HarvestConfig
from backend.bots.harvester.engine import Engine
from backend.bots.harvester.fetch import HttpxFetcher, RateLimiter
from backend.bots.harvester.policy import FieldPolicy
from backend.bots.harvester.store import Store

# fichier sentinelle posé par le router pour demander l'arrêt propre
STOP_FILE = "stop.flag"


def _emit(obj: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def run_harvest(run_dir: str, fetcher: Optional[Any] = None) -> int:
    cfg = HarvestConfig.load(run_dir)
    store = Store.load(os.path.join(run_dir, "store.json"))
    if store.next_todo() is None and not store.counts()["done"]:
        store.add_todo(cfg.url)

    pacing = cfg.pacing or {}
    if fetcher is None:
        rate = RateLimiter(float(pacing.get("min_interval_s", 1.5)))
        fetcher = HttpxFetcher(rate)

    jit = pacing.get("jitter") or [0.0, 0.0]

    def jitter():
        return random.uniform(float(jit[0]), float(jit[1]))

    def should_stop():
        return os.path.isfile(os.path.join(run_dir, STOP_FILE))

    def on_progress(counts):
        _emit({"type": "progress", "counts": counts})

    eng = Engine(store, cfg.recipe, fetcher, FieldPolicy(allowed=cfg.recipe.field_names()),
                 cfg.plan, jitter=jitter, on_progress=on_progress, should_stop=should_stop)
    try:
        eng.run()
    except Exception as e:  # noqa: BLE001 — surfaced as a final log line
        _emit({"type": "error", "message": repr(e)})
        return 1
    _emit({"type": "done", "counts": store.counts()})
    return 0


def main(argv=None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    if not argv:
        sys.stderr.write("usage: python -m backend.bots.harvester <run_dir>\n")
        return 2
    return run_harvest(argv[0])


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 8: Run test to verify it passes**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_main.py -q`
Expected: PASS (1 test)

- [ ] **Step 9: Commit**

```bash
git add backend/bots/harvester/config.py backend/bots/harvester/__main__.py backend/bots/tests/test_harvester_config.py backend/bots/tests/test_harvester_main.py
git commit -m "feat(harvester): config + detached subprocess entrypoint — P1 task 8"
```

---

## Task 9: harvester_router.py — detached run + private API

**Files:**
- Create: `backend/bots/harvester_router.py`
- Modify: `backend/main.py` (import + include — mirror the existing scanner/yield mount lines)
- Test: `backend/bots/tests/test_harvester_router.py`

Endpoints (all admin-only via `_require_admin`, except `/data/{id}` which is gated by `X-Feed-Key`):
- `POST /api/bots/harvester/run` — body `{url, recipe, plan, pacing}`; validates recipe field names against the no-PII policy up front (reject 400 if a field name is PII); generates `feed_key` (`secrets.token_urlsafe`); writes run dir; launches `python -m backend.bots.harvester <run_dir>` detached; returns `{job_id, feed_key}`.
- `GET /api/bots/harvester/status/{id}` — `{status, counts, logs, feed_key}`.
- `GET /api/bots/harvester/active` — the most recent running job or `null`.
- `POST /api/bots/harvester/stop/{id}` — writes `stop.flag` + `proc.terminate()`.
- `GET /api/bots/harvester/data/{id}` — header `X-Feed-Key` must equal the harvest feed key; `?format=json|csv` returns accumulated records.

- [ ] **Step 1: Write the failing test**

```python
# backend/bots/tests/test_harvester_router.py
import json

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.bots import harvester_router as hr
from backend.auth.utils import get_current_user


class FakeUser(object):
    def __init__(self, is_admin):
        self.is_admin = is_admin
        self.role = "admin" if is_admin else "player"
        self.username = "tester"


def make_client(tmp_path, monkeypatch, is_admin=True):
    # isolate the runs dir + neutralise the real subprocess launch
    monkeypatch.setattr(hr, "HARVESTER_RUNS_DIR", tmp_path)

    launched = {}

    def fake_launch(run_dir, job):
        launched["run_dir"] = run_dir
        job["status"] = "running"
        job["process"] = None
        return None

    monkeypatch.setattr(hr, "_launch_subprocess", fake_launch)

    app = FastAPI()
    app.include_router(hr.router)
    app.dependency_overrides[get_current_user] = lambda: FakeUser(is_admin)
    return TestClient(app), launched


GOOD_BODY = {
    "url": "https://books.toscrape.com/catalogue/page-1.html",
    "recipe": {
        "item_selector": {"tag": "article", "class": "product_pod"},
        "fields": {"title": {"selector": {"tag": "a"}, "extract": "attr:title"}},
    },
    "plan": {"mode": "pagination", "next_selector": {"tag": "li", "class": "next"}},
    "pacing": {"min_interval_s": 1.5, "jitter": [0.5, 2.0]},
}


def test_run_refuses_non_admin(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch, is_admin=False)
    r = c.post("/api/bots/harvester/run", json=GOOD_BODY)
    assert r.status_code == 403


def test_run_rejects_pii_field_name(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    body = json.loads(json.dumps(GOOD_BODY))
    body["recipe"]["fields"] = {"email": {"selector": {"tag": "a"}, "extract": "attr:title"}}
    r = c.post("/api/bots/harvester/run", json=body)
    assert r.status_code == 400


def test_run_launches_and_returns_feed_key(tmp_path, monkeypatch):
    c, launched = make_client(tmp_path, monkeypatch)
    r = c.post("/api/bots/harvester/run", json=GOOD_BODY)
    assert r.status_code == 200
    data = r.json()
    assert data["job_id"]
    assert data["feed_key"]
    assert "run_dir" in launched  # subprocess launch was invoked
    # config.json frozen on disk
    cfg_path = tmp_path / data["job_id"] / "config.json"
    assert cfg_path.is_file()


def test_status_and_active(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    job_id = c.post("/api/bots/harvester/run", json=GOOD_BODY).json()["job_id"]
    s = c.get("/api/bots/harvester/status/{0}".format(job_id))
    assert s.status_code == 200
    assert s.json()["status"] == "running"
    a = c.get("/api/bots/harvester/active")
    assert a.status_code == 200
    assert a.json()["job_id"] == job_id


def test_data_requires_feed_key(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    resp = c.post("/api/bots/harvester/run", json=GOOD_BODY).json()
    job_id, feed_key = resp["job_id"], resp["feed_key"]
    # seed the store on disk (the subprocess would normally do this)
    from backend.bots.harvester.store import Store
    store = Store(str(tmp_path / job_id / "store.json"))
    store.add_record({"title": "A"})
    store.save()

    # wrong / missing key -> 401
    assert c.get("/api/bots/harvester/data/{0}".format(job_id)).status_code == 401
    assert c.get("/api/bots/harvester/data/{0}".format(job_id),
                 headers={"X-Feed-Key": "wrong"}).status_code == 401

    # right key -> records
    ok = c.get("/api/bots/harvester/data/{0}".format(job_id),
               headers={"X-Feed-Key": feed_key})
    assert ok.status_code == 200
    assert ok.json()["records"] == [{"title": "A"}]

    # csv format
    csv_resp = c.get("/api/bots/harvester/data/{0}?format=csv".format(job_id),
                     headers={"X-Feed-Key": feed_key})
    assert csv_resp.status_code == 200
    assert "title" in csv_resp.text


def test_data_unknown_job_404(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert c.get("/api/bots/harvester/data/nope",
                 headers={"X-Feed-Key": "x"}).status_code == 404
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_router.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'backend.bots.harvester_router'`

- [ ] **Step 3: Write minimal implementation**

```python
# backend/bots/harvester_router.py
"""Router AI Harvester (P1) — lance le moteur déterministe en subprocess détaché
(mirroir du Bond Scanner) + API privée gated par X-Feed-Key.

Admin-only (gate backend strict is_admin) sauf /data qui est gated par la clé
de feed par-harvest (header X-Feed-Key) — c'est l'API privée consommable par un
client externe."""
import csv
import io
import json
import logging
import os
import secrets
import subprocess
import sys
import threading
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from backend.auth.models import User
from backend.auth.utils import get_current_user
from backend.bots.harvester.config import HarvestConfig
from backend.bots.harvester.policy import PII_FIELDS
from backend.bots.harvester.recipe import Recipe
from backend.bots.harvester.store import Store

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/bots/harvester", tags=["AI Harvester"])

_project_root = Path(__file__).resolve().parent.parent.parent
HARVESTER_RUNS_DIR = _project_root / "data" / "harvester_runs"

# job en mémoire (comme le scanner) — perdu au reload, mais le store.json sur
# disque reste la source de vérité (le subprocess détaché continue).
_harvester_jobs = {}  # type: Dict[str, Dict[str, Any]]


def _require_admin(user) -> None:
    if not getattr(user, "is_admin", False):
        raise HTTPException(status_code=403, detail="Admin uniquement")


class RunRequest(BaseModel):
    url: str
    recipe: Dict[str, Any]
    plan: Dict[str, Any] = {}
    pacing: Dict[str, Any] = {}


def _run_dir(job_id: str) -> Path:
    return Path(HARVESTER_RUNS_DIR) / job_id


def _launch_subprocess(run_dir: str, job: Dict[str, Any]) -> None:
    """Lance `python -m backend.bots.harvester <run_dir>` détaché + thread logs."""
    subprocess_env = {**os.environ, "PYTHONUNBUFFERED": "1"}
    cmd = [sys.executable, "-m", "backend.bots.harvester", run_dir]
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        cwd=str(_project_root),
        env=subprocess_env,
        # détache dans sa propre session pour survivre à un reload uvicorn
        # (auto-deploy git pull) — comme le Bond Scanner.
        start_new_session=True,
    )
    job["process"] = proc
    job["status"] = "running"

    def _capture(p, j):
        try:
            for line in p.stdout:
                stripped = line.rstrip()
                if not stripped:
                    continue
                j["logs"].append(stripped)
                if len(j["logs"]) > 500:
                    j["logs"] = j["logs"][-500:]
                try:
                    msg = json.loads(stripped)
                    if msg.get("type") in ("progress", "done") and "counts" in msg:
                        j["counts"] = msg["counts"]
                except ValueError:
                    pass
        except Exception:
            pass
        p.wait()
        if j["status"] == "running":
            j["status"] = "completed" if p.returncode == 0 else "error"
        j["process"] = None
        logger.info("[Harvester] Job terminé: %s", j["status"])

    t = threading.Thread(target=_capture, args=(proc, job), daemon=True)
    t.start()


@router.post("/run")
def run_harvester(data: RunRequest, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)

    # no-PII gate sur les NOMS de champ de la recette (fail fast au lancement)
    try:
        recipe = Recipe.from_dict(data.recipe)
    except (KeyError, TypeError):
        raise HTTPException(status_code=400, detail="Recette invalide")
    for name in recipe.field_names():
        if name.lower() in PII_FIELDS:
            raise HTTPException(
                status_code=400,
                detail="Champ PII interdit dans la recette: '{0}'".format(name),
            )

    job_id = uuid.uuid4().hex
    feed_key = secrets.token_urlsafe(24)
    run_dir = _run_dir(job_id)
    run_dir.mkdir(parents=True, exist_ok=True)

    cfg = HarvestConfig(
        url=data.url, recipe=recipe, plan=data.plan,
        pacing=data.pacing or {"min_interval_s": 1.5, "jitter": [0.5, 2.0]},
        feed_key=feed_key,
    )
    cfg.save(str(run_dir))
    # seed la frontière avec l'URL de départ
    store = Store(str(run_dir / "store.json"))
    store.add_todo(data.url)
    store.save()

    job = {
        "job_id": job_id,
        "status": "starting",
        "logs": [],
        "process": None,
        "counts": {"todo": 1, "done": 0, "records": 0, "errors": 0},
        "feed_key": feed_key,
        "url": data.url,
        "user": getattr(current_user, "username", "?"),
    }
    _harvester_jobs[job_id] = job
    _launch_subprocess(str(run_dir), job)

    return {"job_id": job_id, "feed_key": feed_key}


def _disk_counts(job_id: str) -> Optional[Dict[str, int]]:
    store_path = _run_dir(job_id) / "store.json"
    if not store_path.is_file():
        return None
    return Store.load(str(store_path)).counts()


@router.get("/status/{job_id}")
def harvester_status(job_id: str, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    job = _harvester_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job introuvable")
    counts = _disk_counts(job_id) or job["counts"]
    return {
        "job_id": job_id,
        "status": job["status"],
        "counts": counts,
        "logs": job["logs"][-50:],
        "feed_key": job["feed_key"],
        "url": job["url"],
    }


@router.get("/active")
def harvester_active(current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    for job in reversed(list(_harvester_jobs.values())):
        if job["status"] in ("starting", "running"):
            return {"job_id": job["job_id"], "status": job["status"],
                    "counts": _disk_counts(job["job_id"]) or job["counts"],
                    "url": job["url"]}
    return None


@router.post("/stop/{job_id}")
def harvester_stop(job_id: str, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    job = _harvester_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job introuvable")
    # arrêt propre : pose le flag (le subprocess le lit entre deux URL)
    try:
        (_run_dir(job_id) / "stop.flag").write_text("1", encoding="utf-8")
    except OSError:
        pass
    proc = job.get("process")
    if proc and proc.poll() is None:
        proc.terminate()
    job["status"] = "stopped"
    job["process"] = None
    return {"status": "stopped", "job_id": job_id}


@router.get("/data/{job_id}")
def harvester_data(job_id: str, request: Request, format: str = "json",
                   x_feed_key: Optional[str] = Header(default=None)):
    """API privée : renvoie les records accumulés. Gated par X-Feed-Key
    (pas par login → consommable par un client externe)."""
    run_dir = _run_dir(job_id)
    cfg_path = run_dir / "config.json"
    if not cfg_path.is_file():
        raise HTTPException(status_code=404, detail="Harvest introuvable")
    cfg = HarvestConfig.load(str(run_dir))
    if not x_feed_key or not secrets.compare_digest(x_feed_key, cfg.feed_key):
        raise HTTPException(status_code=401, detail="Clé de feed invalide")

    store_path = run_dir / "store.json"
    records = Store.load(str(store_path)).records() if store_path.is_file() else []

    if format == "csv":
        cols = cfg.recipe.field_names()
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
        writer.writeheader()
        for rec in records:
            writer.writerow(rec)
        return PlainTextResponse(buf.getvalue(), media_type="text/csv")

    return {"job_id": job_id, "count": len(records), "records": records}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_router.py -q`
Expected: PASS (6 tests)

- [ ] **Step 5: Mount the router in main.py**

In `backend/main.py`, find the bot router imports (near `from backend.bots.mc_capture_router import router as mc_capture_router`) and add after it:

```python
from backend.bots.harvester_router import router as harvester_router
```

Find the includes (near `app.include_router(mc_capture_router)`) and add after it:

```python
app.include_router(harvester_router)
```

- [ ] **Step 6: Verify the app imports cleanly**

Run: `./venv/bin/python -c "import backend.main; print('ok')"`
Expected: prints `ok` (no ImportError). Then run the full bots suite:
Run: `./venv/bin/python -m pytest backend/bots/tests/ -q`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add backend/bots/harvester_router.py backend/main.py backend/bots/tests/test_harvester_router.py
git commit -m "feat(harvester): router (detached run + X-Feed-Key private API) + mount — P1 task 9"
```

---

## Task 10: Frontend — card + view + i18n + cache-bust

**Files:**
- Modify: `frontend/js/bots_module.js` (card in the grid + `openHarvester()`)
- Create: `frontend/js/harvester_module.js`
- Modify: `frontend/js/lang.js` (`harvester.*` in FR, EN, IT)
- Modify: `frontend/index.html` (script include + cache-bust bumps)
- Modify: `frontend/sw.js` (CACHE_NAME bump + asset)

This task is UI; "tests" are (a) JS parse-validation via `node -e "new Function(...)"` (per known pitfall #28) and (b) a Chrome verification with the dev server. No pytest.

- [ ] **Step 1: Add i18n keys (FR/EN/IT)**

In `frontend/js/lang.js`, add these keys inside each language object, right after that language's `scanner.*` block (FR section, then EN section, then IT section — match the file's existing per-language layout).

FR:
```javascript
    'harvester.title': 'AI Harvester',
    'harvester.subtitle': 'Moissonneur de données continu (cible propre)',
    'harvester.launch': 'Ouvrir',
    'harvester.desc': 'Récolte une cible web en continu, low-and-slow, et expose la donnée via une API privée.',
    'harvester.form_url': 'URL de départ',
    'harvester.form_recipe': 'Recette d\'extraction (JSON)',
    'harvester.form_plan': 'Plan de crawl (JSON)',
    'harvester.start': 'Lancer la moisson',
    'harvester.stop': 'Arrêter',
    'harvester.running': 'Moisson en cours',
    'harvester.records': 'Records',
    'harvester.pages_done': 'Pages faites',
    'harvester.errors': 'Erreurs',
    'harvester.feed_key': 'Clé API privée (X-Feed-Key)',
    'harvester.feed_key_hint': 'À envoyer dans le header X-Feed-Key pour lire /data.',
    'harvester.view_data': 'Voir les données',
    'harvester.back': 'Retour',
    'harvester.demo': 'Pré-remplir l\'exemple (books.toscrape)',
    'harvester.invalid_json': 'JSON invalide',
```

EN:
```javascript
    'harvester.title': 'AI Harvester',
    'harvester.subtitle': 'Continuous data harvester (clean target)',
    'harvester.launch': 'Open',
    'harvester.desc': 'Harvests a web target continuously, low-and-slow, and exposes the data via a private API.',
    'harvester.form_url': 'Start URL',
    'harvester.form_recipe': 'Extraction recipe (JSON)',
    'harvester.form_plan': 'Crawl plan (JSON)',
    'harvester.start': 'Start harvest',
    'harvester.stop': 'Stop',
    'harvester.running': 'Harvest running',
    'harvester.records': 'Records',
    'harvester.pages_done': 'Pages done',
    'harvester.errors': 'Errors',
    'harvester.feed_key': 'Private API key (X-Feed-Key)',
    'harvester.feed_key_hint': 'Send it in the X-Feed-Key header to read /data.',
    'harvester.view_data': 'View data',
    'harvester.back': 'Back',
    'harvester.demo': 'Prefill the example (books.toscrape)',
    'harvester.invalid_json': 'Invalid JSON',
```

IT:
```javascript
    'harvester.title': 'AI Harvester',
    'harvester.subtitle': 'Raccoglitore dati continuo (target pulito)',
    'harvester.launch': 'Apri',
    'harvester.desc': 'Raccoglie un target web in continuo, low-and-slow, ed espone i dati via API privata.',
    'harvester.form_url': 'URL di partenza',
    'harvester.form_recipe': 'Ricetta di estrazione (JSON)',
    'harvester.form_plan': 'Piano di crawl (JSON)',
    'harvester.start': 'Avvia raccolta',
    'harvester.stop': 'Ferma',
    'harvester.running': 'Raccolta in corso',
    'harvester.records': 'Record',
    'harvester.pages_done': 'Pagine fatte',
    'harvester.errors': 'Errori',
    'harvester.feed_key': 'Chiave API privata (X-Feed-Key)',
    'harvester.feed_key_hint': 'Inviala nell\'header X-Feed-Key per leggere /data.',
    'harvester.view_data': 'Vedi i dati',
    'harvester.back': 'Indietro',
    'harvester.demo': 'Precompila l\'esempio (books.toscrape)',
    'harvester.invalid_json': 'JSON non valido',
```

- [ ] **Step 2: Add the card in bots_module.js**

In `frontend/js/bots_module.js`, near the existing MC Agent card block, add an admin-only AI Harvester card. Mirror the MC Agent gating + `buildBotCard` usage:

```javascript
// AI Harvester virtual card (admin-only — R&D scraping + API privée)
const canSeeHarvester = u && u.is_admin;
const harvesterCard = canSeeHarvester ? buildBotCard({
    icon: 'HRV',
    name: 'AI Harvester',
    type: 'data',
    desc: Lang.t('harvester.desc'),
    status: 'online',
    statusLabel: Lang.t('modules.active'),
    onClick: 'BotsModule.openHarvester()',
    actions: `<button class="btn btn-ghost btn-sm">${Lang.t('harvester.launch')}</button>`,
    selected: false,
    sharedWithYou: false,
}) : '';
```

Then add `harvesterCard` to the grid HTML where `mcAgentCard` (and the other virtual cards) are concatenated into the cards markup. Find the line that injects the virtual cards (e.g. `${yieldBotCard}${scannerBotCard}${mcAgentCard}`) and append `${harvesterCard}`.

Add the `openHarvester` method to the `BotsModule` object (near `openMCAgent`):

```javascript
openHarvester() {
    const u = (typeof Auth !== 'undefined' && Auth.getUser) ? Auth.getUser() : null;
    if (!u || !u.is_admin) return;
    if (this._refreshInterval) { clearInterval(this._refreshInterval); this._refreshInterval = null; }
    if (typeof HarvesterModule !== 'undefined') {
        HarvesterModule.render(this._container);
    }
},
```

- [ ] **Step 3: Create harvester_module.js**

```javascript
// frontend/js/harvester_module.js
// Vue dédiée AI Harvester (P1) : formulaire de lancement + progression live +
// clé API privée. Admin-only (le backend garde aussi la porte).
const HarvesterModule = {
    _container: null,
    _jobId: null,
    _feedKey: null,
    _pollInterval: null,

    _demoRecipe() {
        return JSON.stringify({
            item_selector: { tag: 'article', class: 'product_pod' },
            fields: {
                title: { selector: { tag: 'a' }, extract: 'attr:title' },
                price: { selector: { tag: 'p', class: 'price_color' }, extract: 'text' },
                availability: { selector: { tag: 'p', class: 'availability' }, extract: 'text' },
                rating: { selector: { tag: 'p', class: 'star-rating' }, extract: 'class:1' },
            },
        }, null, 2);
    },

    _demoPlan() {
        return JSON.stringify({ mode: 'pagination', next_selector: { tag: 'li', class: 'next' } }, null, 2);
    },

    async render(container) {
        this._container = container;
        // reconnect to an active job if any
        let active = null;
        try {
            const r = await Auth.apiCall('/api/bots/harvester/active');
            if (r && r.ok) active = await r.json();
        } catch (e) { /* ignore */ }
        if (active && active.job_id) {
            this._jobId = active.job_id;
            this._renderRunning(active);
            this._startPolling();
        } else {
            this._renderForm();
        }
    },

    unload() {
        if (this._pollInterval) { clearInterval(this._pollInterval); this._pollInterval = null; }
    },

    _renderForm() {
        const c = this._container;
        c.innerHTML = `
        <div class="card">
          <div class="b-head" style="margin-bottom:12px;">
            <span class="b-icon b-ticker">HRV</span>
            <div class="b-name-wrap"><div class="b-name">${Lang.t('harvester.title')}</div>
            <div class="b-type">${Lang.t('harvester.subtitle')}</div></div>
          </div>
          <label class="form-label">${Lang.t('harvester.form_url')}</label>
          <input id="hrv-url" class="form-input" value="https://books.toscrape.com/catalogue/page-1.html" />
          <label class="form-label">${Lang.t('harvester.form_recipe')}</label>
          <textarea id="hrv-recipe" class="form-input" rows="10" style="font-family:var(--font-mono);">${this._demoRecipe()}</textarea>
          <label class="form-label">${Lang.t('harvester.form_plan')}</label>
          <textarea id="hrv-plan" class="form-input" rows="4" style="font-family:var(--font-mono);">${this._demoPlan()}</textarea>
          <div style="margin-top:14px;display:flex;gap:8px;">
            <button class="btn btn-primary" onclick="HarvesterModule.start()">${Lang.t('harvester.start')}</button>
            <button class="btn btn-ghost" onclick="BotsModule.render(BotsModule._container)">${Lang.t('harvester.back')}</button>
          </div>
        </div>`;
    },

    async start() {
        let recipe, plan;
        try {
            recipe = JSON.parse(document.getElementById('hrv-recipe').value);
            plan = JSON.parse(document.getElementById('hrv-plan').value);
        } catch (e) {
            if (typeof Toast !== 'undefined') Toast.error(Lang.t('harvester.invalid_json'));
            return;
        }
        const url = document.getElementById('hrv-url').value.trim();
        const r = await Auth.apiCall('/api/bots/harvester/run', {
            method: 'POST',
            body: JSON.stringify({ url, recipe, plan }),
        });
        if (!r || !r.ok) {
            const detail = r ? (await r.json().catch(() => ({}))).detail : '';
            if (typeof Toast !== 'undefined') Toast.error(detail || 'Error');
            return;
        }
        const data = await r.json();
        this._jobId = data.job_id;
        this._feedKey = data.feed_key;
        this._renderRunning({ job_id: data.job_id, counts: { records: 0, done: 0, errors: 0 } });
        this._startPolling();
    },

    _renderRunning(state) {
        const c = this._container;
        const counts = state.counts || { records: 0, done: 0, errors: 0 };
        const keyBlock = this._feedKey ? `
          <div style="margin-top:14px;">
            <label class="form-label">${Lang.t('harvester.feed_key')}</label>
            <code style="display:block;padding:8px;background:var(--bg-elev-3);border-radius:var(--r-sm);word-break:break-all;">${this._feedKey}</code>
            <div class="form-hint">${Lang.t('harvester.feed_key_hint')}</div>
          </div>` : '';
        c.innerHTML = `
        <div class="card">
          <div class="b-head" style="margin-bottom:12px;">
            <span class="b-icon b-ticker">HRV</span>
            <div class="b-name-wrap"><div class="b-name">${Lang.t('harvester.title')}</div>
            <div class="b-type">${Lang.t('harvester.running')}</div></div>
            <span class="badge online" id="hrv-status">running</span>
          </div>
          <div class="bento-overview" style="margin-bottom:12px;">
            <div class="stat-card"><div class="stat-label">${Lang.t('harvester.records')}</div><div class="stat-value" id="hrv-records">${counts.records || 0}</div></div>
            <div class="stat-card"><div class="stat-label">${Lang.t('harvester.pages_done')}</div><div class="stat-value" id="hrv-done">${counts.done || 0}</div></div>
            <div class="stat-card"><div class="stat-label">${Lang.t('harvester.errors')}</div><div class="stat-value" id="hrv-errors">${counts.errors || 0}</div></div>
          </div>
          ${keyBlock}
          <div style="margin-top:14px;display:flex;gap:8px;">
            <button class="btn btn-danger" onclick="HarvesterModule.stop()">${Lang.t('harvester.stop')}</button>
            <button class="btn btn-ghost" onclick="HarvesterModule.viewData()">${Lang.t('harvester.view_data')}</button>
            <button class="btn btn-ghost" onclick="BotsModule.render(BotsModule._container)">${Lang.t('harvester.back')}</button>
          </div>
          <pre id="hrv-data" style="margin-top:12px;max-height:240px;overflow:auto;font-family:var(--font-mono);font-size:12px;"></pre>
        </div>`;
    },

    _startPolling() {
        if (this._pollInterval) clearInterval(this._pollInterval);
        this._poll();
        this._pollInterval = setInterval(() => this._poll(), 3000);
    },

    async _poll() {
        if (!this._jobId) return;
        try {
            const r = await Auth.apiCall(`/api/bots/harvester/status/${this._jobId}`);
            if (!r || !r.ok) return;
            const data = await r.json();
            const counts = data.counts || {};
            const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
            set('hrv-records', counts.records || 0);
            set('hrv-done', counts.done || 0);
            set('hrv-errors', counts.errors || 0);
            const st = document.getElementById('hrv-status');
            if (st) st.textContent = data.status;
            if (['completed', 'error', 'stopped'].includes(data.status)) {
                clearInterval(this._pollInterval); this._pollInterval = null;
            }
        } catch (e) { /* ignore */ }
    },

    async stop() {
        if (!this._jobId) return;
        await Auth.apiCall(`/api/bots/harvester/stop/${this._jobId}`, { method: 'POST' });
        if (this._pollInterval) { clearInterval(this._pollInterval); this._pollInterval = null; }
    },

    async viewData() {
        if (!this._jobId || !this._feedKey) return;
        const r = await Auth.apiCall(`/api/bots/harvester/data/${this._jobId}`, {
            headers: { 'X-Feed-Key': this._feedKey },
        });
        if (!r || !r.ok) return;
        const data = await r.json();
        const el = document.getElementById('hrv-data');
        if (el) el.textContent = JSON.stringify(data.records.slice(0, 20), null, 2);
    },
};
```

- [ ] **Step 4: Validate the JS parses (pitfall #28 reflex)**

Run:
```bash
node -e "new Function(require('fs').readFileSync('frontend/js/harvester_module.js','utf8')); console.log('harvester_module ok')"
node -e "new Function(require('fs').readFileSync('frontend/js/bots_module.js','utf8')); console.log('bots_module ok')"
node -e "new Function(require('fs').readFileSync('frontend/js/lang.js','utf8')); console.log('lang ok')"
```
Expected: three `... ok` lines, no SyntaxError.

- [ ] **Step 5: Wire the script include + cache-bust in index.html**

In `frontend/index.html`, add after the `bots_module.js` script tag:
```html
<script src="/js/harvester_module.js?v=1"></script>
```
Bump the cache-bust on the files you changed: `bots_module.js?v=227` → `?v=228`, `lang.js?v=228` → `?v=229`. (Use values strictly above whatever is currently in the file — read the current numbers first and increment.)

- [ ] **Step 6: Update sw.js**

In `frontend/sw.js`: bump `const CACHE_NAME = 'omenserver-v111';` → `'omenserver-v112'` (one above current), and add `'/js/harvester_module.js',` to `STATIC_ASSETS` after the `'/js/bots_module.js',` line.

- [ ] **Step 7: Verify in Chrome (verify-ui skill / Control_Chrome MCP)**

Start the dev server (ask Massii to run it — uvicorn `--reload` is his terminal per CLAUDE.md), then with Control_Chrome: log in as admin, navigate to the Bots module, confirm the "AI Harvester" card appears, click it, confirm the form renders with the prefilled demo recipe, and (optionally, against a live books.toscrape) click Start and confirm the records counter climbs + the feed key shows. Read the console for errors. Capture a screenshot. Do NOT ask the user to verify — verify yourself and report.

- [ ] **Step 8: Commit**

```bash
git add frontend/js/harvester_module.js frontend/js/bots_module.js frontend/js/lang.js frontend/index.html frontend/sw.js
git commit -m "feat(harvester): admin-only card + dedicated view + i18n + cache-bust — P1 task 10"
```

---

## Self-Review (run after implementing — checklist, not a dispatch)

**Spec coverage (§10 P1):**
- store (frontier resumable) → Task 5 ✓
- crawl (sitemap/pagination) → Task 4 ✓
- recipe (deterministic extractor) → Task 3 (+ dom Task 2) ✓
- engine (paced httpx loop) → Task 7 ✓
- harvester_router (/run /status /active /stop /data) → Task 9 ✓
- carte UI → Task 10 ✓
- run détaché → Task 9 (`_launch_subprocess`, `start_new_session=True`) ✓
- no-PII gate → Task 1 + enforced in engine (Task 7) + router fail-fast (Task 9) ✓
- httpx only, zero new dep → confirmed (httpx already installed; HTML via stdlib `html.parser`) ✓
- NO Claude, NO stealth in P1 → confirmed (none imported) ✓

**Test coverage (§11):** recipe (fixture→records) ✓, crawl (sitemap/pagination fixtures) ✓, policy (no-PII) ✓, store (resume) ✓, engine (DI, order+resume+back-off+stop, zero network) ✓, router (TestClient, 403 admin, 401 feed-key, 404) ✓. Pacing adaptive + `llm._claude` mock are P2/P3, intentionally out of P1.

**Type consistency:** `Recipe.field_names()`, `Store.add_todo/next_todo/mark_done/add_record/add_error/counts/records/save/load`, `Engine(store, recipe, fetcher, policy, plan, ...)`, `HarvestConfig.from_dict/to_dict/load/save`, selector dict `{"tag","class"}`, field spec `{"selector","extract"}` — all consistent across tasks 1–10 and the router. `_launch_subprocess(run_dir, job)` signature matches the router test's monkeypatch.

**Deferred to later phases (not gaps):** `/setup` + `_claude` (P2), `pacing.py` adaptive back-off + stealth/unblocker tiers + `/config` unblocker key (P3), `exporter.py` + `/export` (P4).

---

## Execution Handoff

After the plan is saved, execute via **superpowers:subagent-driven-development** — fresh subagent per task, controller (me) reviews + runs the test command between tasks, commits per task. Tasks 1–9 are pure backend TDD (pytest green gate each). Task 10 is frontend (JS parse-check + Chrome verify-ui). Do not push to origin/main mid-run; integrate per the deploy-workflow memory (fetch + rebase onto origin/main, bump cache-bust above origin's values) once P1 is green end-to-end.
