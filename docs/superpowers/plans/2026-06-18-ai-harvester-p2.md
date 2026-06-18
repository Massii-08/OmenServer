# AI Harvester — P2 (setup intelligent) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add the one LLM step of the system — the operator types a URL + natural-language instructions, Claude (local CLI) generates the extraction recipe + crawl plan + pacing, the engine runs it on a sample page, and the UI shows an editable preview. The generated config feeds the existing P1 `/run` unchanged (runtime stays 100% deterministic).

**Architecture:** A `harvester/llm.py` helper (ported from `~/upwork-sniper/sniper/llm.py`) shells out to `claude -p --output-format json` with the prompt on stdin and parses the JSON envelope — `subprocess.run` is injectable so tests never call the real CLI. A `harvester/setup.py` orchestrates: probe difficulty from the sample response headers → build the prompt → call Claude → parse into a `Recipe` → run it on the sample HTML → return `{recipe, plan, pacing, difficulty, sample}`. A new admin-only `POST /setup` exposes it (no subprocess — a single synchronous LLM call). The frontend gains an "instructions → Générer (IA)" flow that fills the existing (editable) recipe/plan textareas and shows a sample preview; the existing "Lancer" path is untouched.

**Tech Stack:** Python 3.9 (no 3.10+ syntax — `Optional`/`Dict`/`List`/`Any`/`Tuple`/`Callable` from `typing`), FastAPI, stdlib `subprocess`/`json`, httpx (already installed) for the sample fetch. Claude CLI at `~/.local/bin/claude` (env `CLAUDE_BIN`), present on the Omen (v2.1.162). Tests: pytest with injected `run`/`fetch`/`claude` (no network, no CLI).

---

## Scope

P2 only (spec §10): `llm._claude` + `/setup` + preview UI + editable recipe. Excludes: adaptive pacing back-off + stealth/unblocker tiers (P3) and export (P4). P2 does **not** run a harvest — it produces a preview; launching still goes through the P1 `/run`.

## Conventions

- **Python 3.9.** No `X | Y`, no `match`. `# type:` comments where needed.
- **Test command** (from project root, path has a space):
  ```bash
  cd "/Users/massimiliano/omenserver Project/Projet serveur"
  ./venv/bin/python -m pytest backend/bots/tests/ -q
  ```
- **Admin gate**: reuse `_require_admin` + `Depends(get_current_user)` already in `harvester_router.py`.
- **No-PII gate**: the generated recipe's field names go through the same PII check as `/run` (reject 400 if Claude proposed a PII field name).
- **The LLM call is injectable everywhere** so CI never invokes the real CLI.

## File Structure (P2)

| File | Responsibility |
|---|---|
| `backend/bots/harvester/llm.py` | `_claude(prompt, ...)` CLI helper + `extract_json` — `run` injectable |
| `backend/bots/harvester/setup.py` | `probe_difficulty`, `PACING_BY_TIER`/`pacing_for`, `build_setup_prompt`, `build_setup` |
| `backend/bots/harvester_router.py` (modify) | add `POST /setup` + module-level `_run_setup` indirection (monkeypatchable) |
| `frontend/js/harvester_module.js` (modify) | instructions field + "Générer (IA)" → `/setup` → fill recipe/plan + sample preview |
| `frontend/js/lang.js` (modify) | `harvester.*` setup keys FR/EN/IT |
| `frontend/index.html`, `frontend/sw.js` (modify) | cache-bust bumps |
| Tests | `test_harvester_llm.py`, `test_harvester_setup.py`, extend `test_harvester_router.py` |

## Canonical interfaces

```python
# llm.py
CLAUDE_BIN  # str, env CLAUDE_BIN or ~/.local/bin/claude
def extract_json(text: str) -> Dict[str, Any]: ...           # first { .. last }
def _claude(prompt: str, model: str = "", timeout: int = 180,
            run: Callable = subprocess.run) -> Dict[str, Any]: ...

# setup.py
PACING_BY_TIER: Dict[str, Dict[str, Any]]                    # facile/moyen/dur -> {min_interval_s, jitter}
def probe_difficulty(status: int, headers: Dict[str, str]) -> str: ...   # "facile"|"moyen"|"dur"
def pacing_for(tier: str) -> Dict[str, Any]: ...
def build_setup_prompt(url: str, instructions: str, sample_html: str, tier: str) -> str: ...
def build_setup(url: str, instructions: str, *, fetch_full, claude) -> Dict[str, Any]: ...
#   fetch_full(url) -> Tuple[int, Dict[str,str], str]   (status, headers, html)
#   claude(prompt) -> Dict   (parsed {recipe, plan, pacing})
#   returns {url, difficulty, recipe, plan, pacing, sample}
```

---

## Task 1: llm.py — Claude CLI helper

**Files:**
- Create: `backend/bots/harvester/llm.py`
- Test: `backend/bots/tests/test_harvester_llm.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/bots/tests/test_harvester_llm.py
import pytest

from backend.bots.harvester.llm import _claude, extract_json


class FakeProc(object):
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def test_extract_json_finds_object_in_noise():
    assert extract_json('prefix {"a": 1, "b": [2, 3]} suffix') == {"a": 1, "b": [2, 3]}


def test_extract_json_raises_when_absent():
    with pytest.raises(ValueError):
        extract_json("no json here")


def test_claude_parses_envelope_result():
    captured = {}

    def fake_run(cmd, input=None, capture_output=None, text=None, timeout=None):
        captured["cmd"] = cmd
        captured["input"] = input
        return FakeProc(0, stdout='{"is_error": false, "result": "here: {\\"recipe\\": 1}"}')

    out = _claude("do it", run=fake_run)
    assert out == {"recipe": 1}
    assert captured["cmd"][:4][-3:] == ["-p", "--output-format", "json"]
    assert captured["input"] == "do it"


def test_claude_passes_model_flag():
    def fake_run(cmd, **kw):
        assert "--model" in cmd and "claude-haiku-4-5-20251001" in cmd
        return FakeProc(0, stdout='{"result": "{\\"x\\": 1}"}')

    assert _claude("p", model="claude-haiku-4-5-20251001", run=fake_run) == {"x": 1}


def test_claude_raises_on_nonzero_rc():
    def fake_run(cmd, **kw):
        return FakeProc(2, stdout="", stderr="boom")
    with pytest.raises(RuntimeError):
        _claude("p", run=fake_run)


def test_claude_raises_on_is_error_envelope():
    def fake_run(cmd, **kw):
        return FakeProc(0, stdout='{"is_error": true, "result": "model refused"}')
    with pytest.raises(RuntimeError):
        _claude("p", run=fake_run)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_llm.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'backend.bots.harvester.llm'`

- [ ] **Step 3: Write minimal implementation**

```python
# backend/bots/harvester/llm.py
"""Helper LLM via le CLI Claude Code (abonnement, AUCUNE clé API) — porté du
Upwork Sniper. SETUP ONLY : c'est la seule étape IA du harvester.

`claude -p` lit le prompt sur stdin ; `--output-format json` renvoie une
enveloppe {..., "result": "<texte>"}. `run` est injectable → test sans CLI.
Chemin complet du binaire car le service systemd a un PATH minimal."""
import json
import os
import subprocess
from typing import Any, Callable, Dict

CLAUDE_BIN = os.environ.get("CLAUDE_BIN") or os.path.expanduser("~/.local/bin/claude")


def extract_json(text: str) -> Dict[str, Any]:
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("no JSON in LLM response: {0}".format(text[:200]))
    return json.loads(text[start:end + 1])


def _claude(prompt: str, model: str = "", timeout: int = 180,
            run: Callable = subprocess.run) -> Dict[str, Any]:
    cmd = [CLAUDE_BIN, "-p", "--output-format", "json"]
    if model:
        cmd += ["--model", model]
    proc = run(cmd, input=prompt, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError("claude cli rc={0}: {1}".format(
            proc.returncode, (proc.stderr or "")[:200]))
    env = json.loads(proc.stdout)
    if env.get("is_error"):
        raise RuntimeError("claude error: {0}".format(str(env.get("result", ""))[:200]))
    return extract_json(env.get("result", ""))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_llm.py -q`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/bots/harvester/llm.py backend/bots/tests/test_harvester_llm.py
git commit -m "feat(harvester): claude CLI helper (setup-only, injectable run) — P2 task 1"
```

---

## Task 2: setup.py — probe + prompt + orchestration

**Files:**
- Create: `backend/bots/harvester/setup.py`
- Test: `backend/bots/tests/test_harvester_setup.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/bots/tests/test_harvester_setup.py
from backend.bots.harvester.setup import (
    PACING_BY_TIER, build_setup, build_setup_prompt, pacing_for, probe_difficulty,
)

SAMPLE_HTML = """
<section><ol class="row">
  <li><article class="product_pod">
    <h3><a href="b1.html" title="Book One">Book One ...</a></h3>
    <p class="price_color">£51.77</p>
  </article></li>
  <li><article class="product_pod">
    <h3><a href="b2.html" title="Book Two">Book Two ...</a></h3>
    <p class="price_color">£10.00</p>
  </article></li>
</ol></section>
"""

GENERATED = {
    "recipe": {
        "item_selector": {"tag": "article", "class": "product_pod"},
        "fields": {
            "title": {"selector": [{"tag": "h3"}, {"tag": "a"}], "extract": "attr:title"},
            "price": {"selector": {"tag": "p", "class": "price_color"}, "extract": "text"},
        },
    },
    "plan": {"mode": "pagination", "next_selector": {"tag": "li", "class": "next"}},
    "pacing": {"min_interval_s": 2.0, "jitter": [1.0, 3.0]},
}


def test_probe_difficulty_tiers():
    assert probe_difficulty(200, {}) == "facile"
    assert probe_difficulty(200, {"CF-Ray": "abc", "Server": "cloudflare"}) == "moyen"
    assert probe_difficulty(429, {}) == "dur"
    assert probe_difficulty(200, {"Retry-After": "30"}) == "dur"


def test_pacing_for_known_and_unknown_tier():
    assert pacing_for("facile") == PACING_BY_TIER["facile"]
    assert pacing_for("moyen") == PACING_BY_TIER["moyen"]
    assert pacing_for("zzz") == PACING_BY_TIER["facile"]  # safe default


def test_build_setup_prompt_includes_url_instructions_grammar_and_html():
    p = build_setup_prompt("https://x.test/p1", "get title and price",
                           "<article class='product_pod'>hi</article>", "facile")
    assert "https://x.test/p1" in p
    assert "get title and price" in p
    assert "item_selector" in p and "fields" in p           # output schema
    assert "attr:" in p and "class:" in p                   # extract grammar
    assert "product_pod" in p                               # sample html embedded


def test_build_setup_runs_recipe_on_sample_and_returns_preview():
    seen = {}

    def fake_fetch_full(url):
        seen["url"] = url
        return (200, {"Server": "nginx"}, SAMPLE_HTML)

    def fake_claude(prompt):
        seen["prompt"] = prompt
        return GENERATED

    out = build_setup("https://x.test/p1", "title + price",
                      fetch_full=fake_fetch_full, claude=fake_claude)
    assert seen["url"] == "https://x.test/p1"
    assert out["difficulty"] == "facile"
    assert out["recipe"] == GENERATED["recipe"]
    assert out["plan"] == GENERATED["plan"]
    assert out["pacing"] == GENERATED["pacing"]
    assert out["sample"] == [
        {"title": "Book One", "price": "£51.77"},
        {"title": "Book Two", "price": "£10.00"},
    ]


def test_build_setup_falls_back_to_tier_pacing_when_llm_omits_it():
    def fake_fetch_full(url):
        return (429, {}, SAMPLE_HTML)   # -> "dur"

    def fake_claude(prompt):
        g = dict(GENERATED)
        g = {"recipe": GENERATED["recipe"], "plan": GENERATED["plan"]}  # no pacing
        return g

    out = build_setup("https://x.test/p1", "x",
                      fetch_full=fake_fetch_full, claude=fake_claude)
    assert out["difficulty"] == "dur"
    assert out["pacing"] == PACING_BY_TIER["dur"]


def test_build_setup_caps_sample_to_ten():
    rows = "".join(
        '<li><article class="product_pod"><h3><a title="t{0}">t</a></h3>'
        '<p class="price_color">£1</p></article></li>'.format(i) for i in range(25)
    )
    html = "<ol>" + rows + "</ol>"

    def fake_fetch_full(url):
        return (200, {}, html)

    def fake_claude(prompt):
        return GENERATED

    out = build_setup("u", "x", fetch_full=fake_fetch_full, claude=fake_claude)
    assert len(out["sample"]) == 10
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_setup.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'backend.bots.harvester.setup'`

- [ ] **Step 3: Write minimal implementation**

```python
# backend/bots/harvester/setup.py
"""Setup intelligent (P2) : probe difficulté → prompt → Claude génère
recette/plan/pacing → run sur un échantillon → preview. Seule étape IA.

fetch_full et claude sont injectés → testable sans réseau ni CLI."""
from typing import Any, Callable, Dict, Tuple

from backend.bots.harvester.recipe import Recipe

PACING_BY_TIER = {
    "facile": {"min_interval_s": 1.5, "jitter": [0.5, 2.0]},
    "moyen": {"min_interval_s": 5.0, "jitter": [2.0, 6.0]},
    "dur": {"min_interval_s": 20.0, "jitter": [8.0, 15.0]},
}


def probe_difficulty(status: int, headers: Dict[str, str]) -> str:
    h = {}
    for k, v in (headers or {}).items():
        h[k.lower()] = v
    if status == 429 or "retry-after" in h:
        return "dur"
    server = (h.get("server") or "").lower()
    if "cf-ray" in h or "cloudflare" in server:
        return "moyen"
    return "facile"


def pacing_for(tier: str) -> Dict[str, Any]:
    return PACING_BY_TIER.get(tier, PACING_BY_TIER["facile"])


def build_setup_prompt(url: str, instructions: str, sample_html: str, tier: str) -> str:
    snippet = (sample_html or "")[:6000]
    return (
        "You generate a DETERMINISTIC web-scraping recipe for a continuous harvester. "
        "No code — output ONLY a JSON object.\n\n"
        "=== TARGET URL ===\n{url}\n\n"
        "=== WHAT THE USER WANTS (natural language) ===\n{instr}\n\n"
        "=== OBSERVED DIFFICULTY TIER ===\n{tier} (facile=fast/no protection, "
        "moyen=Cloudflare-ish, dur=rate-limited)\n\n"
        "=== HTML SAMPLE OF THE PAGE (truncated) ===\n{html}\n\n"
        "=== OUTPUT SCHEMA (return EXACTLY this shape) ===\n"
        "{{\n"
        '  "recipe": {{\n'
        '    "item_selector": {{"tag": "...", "class": "..."}},   // the repeating record container\n'
        '    "fields": {{ "<field_name>": {{"selector": <sel>, "extract": "<how>"}} , ... }}\n'
        "  }},\n"
        '  "plan": {{"mode": "pagination"|"sitemap", "next_selector": {{"tag": "...", "class": "..."}} }},\n'
        '  "pacing": {{"min_interval_s": <float>, "jitter": [<lo>, <hi>]}}\n'
        "}}\n\n"
        "=== SELECTOR RULES ===\n"
        "- A selector is {{\"tag\": t}} and/or {{\"class\": c}} (matches a descendant of the item).\n"
        "- For 'the <a> inside the <h3>' use a DESCENDANT CHAIN: [{{\"tag\":\"h3\"}},{{\"tag\":\"a\"}}].\n"
        "- A field with NO selector extracts from the item element itself.\n"
        "- extract is one of: \"text\" (collapsed text), \"attr:NAME\" (an attribute), "
        "\"class:N\" (the N-th class token, 0-based).\n"
        "- NEVER create fields for personal data (name, email, phone, address, user id, etc.).\n"
        "- Pick pacing matching the difficulty tier (slower for moyen/dur).\n"
        "Return ONLY the JSON object, nothing else."
    ).format(url=url, instr=instructions, tier=tier, html=snippet)


def build_setup(url: str, instructions: str, *,
                fetch_full: Callable[[str], Tuple[int, Dict[str, str], str]],
                claude: Callable[[str], Dict[str, Any]]) -> Dict[str, Any]:
    status, headers, html = fetch_full(url)
    tier = probe_difficulty(status, headers)
    prompt = build_setup_prompt(url, instructions, html, tier)
    spec = claude(prompt)
    recipe_dict = spec["recipe"]
    recipe = Recipe.from_dict(recipe_dict)
    sample = recipe.extract(html)[:10]
    pacing = spec.get("pacing") or pacing_for(tier)
    return {
        "url": url,
        "difficulty": tier,
        "recipe": recipe_dict,
        "plan": spec.get("plan", {}),
        "pacing": pacing,
        "sample": sample,
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_setup.py -q`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/bots/harvester/setup.py backend/bots/tests/test_harvester_setup.py
git commit -m "feat(harvester): setup orchestration (probe + prompt + sample preview) — P2 task 2"
```

---

## Task 3: router — POST /setup

**Files:**
- Modify: `backend/bots/harvester_router.py`
- Test: extend `backend/bots/tests/test_harvester_router.py`

- [ ] **Step 1: Write the failing test (append to the existing router test file)**

```python
# append to backend/bots/tests/test_harvester_router.py

def test_setup_refuses_non_admin(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch, is_admin=False)
    r = c.post("/api/bots/harvester/setup",
               json={"url": "https://books.toscrape.com/", "instructions": "titles"})
    assert r.status_code == 403


def test_setup_returns_preview(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    preview = {
        "url": "https://books.toscrape.com/",
        "difficulty": "facile",
        "recipe": {"item_selector": {"tag": "article", "class": "product_pod"},
                   "fields": {"title": {"selector": [{"tag": "h3"}, {"tag": "a"}],
                                        "extract": "attr:title"}}},
        "plan": {"mode": "pagination", "next_selector": {"tag": "li", "class": "next"}},
        "pacing": {"min_interval_s": 1.5, "jitter": [0.5, 2.0]},
        "sample": [{"title": "Book One"}],
    }
    monkeypatch.setattr(hr, "_run_setup", lambda url, instructions: preview)
    r = c.post("/api/bots/harvester/setup",
               json={"url": "https://books.toscrape.com/", "instructions": "titles"})
    assert r.status_code == 200
    body = r.json()
    assert body["difficulty"] == "facile"
    assert body["sample"] == [{"title": "Book One"}]
    assert body["recipe"]["item_selector"]["class"] == "product_pod"


def test_setup_rejects_generated_pii_field(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    preview = {
        "url": "u", "difficulty": "facile",
        "recipe": {"item_selector": {"tag": "article"},
                   "fields": {"email": {"extract": "text"}}},
        "plan": {}, "pacing": {}, "sample": [],
    }
    monkeypatch.setattr(hr, "_run_setup", lambda url, instructions: preview)
    r = c.post("/api/bots/harvester/setup", json={"url": "u", "instructions": "x"})
    assert r.status_code == 400


def test_setup_surfaces_llm_failure_as_502(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)

    def boom(url, instructions):
        raise RuntimeError("claude cli rc=2")

    monkeypatch.setattr(hr, "_run_setup", boom)
    r = c.post("/api/bots/harvester/setup", json={"url": "u", "instructions": "x"})
    assert r.status_code == 502
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_router.py -q`
Expected: FAIL — the four new tests error (`AttributeError: ... has no attribute '_run_setup'` / 404 on `/setup`)

- [ ] **Step 3: Write minimal implementation**

In `backend/bots/harvester_router.py`, add the imports near the top (after the existing harvester imports):

```python
import httpx

from backend.bots.harvester.llm import _claude
from backend.bots.harvester.setup import build_setup
```

Add a request model near `RunRequest`:

```python
class SetupRequest(BaseModel):
    url: str
    instructions: str = ""
```

Add the module-level helpers (near `_launch_subprocess`, so tests can monkeypatch `_run_setup`):

```python
def _fetch_full(url):
    """Un GET httpx unique pour l'échantillon de setup → (status, headers, text)."""
    with httpx.Client(timeout=20.0, follow_redirects=True,
                      headers={"User-Agent": "OmenHarvester/0.1 (+https://omenserver.org)"}) as client:
        resp = client.get(url)
        return resp.status_code, dict(resp.headers), resp.text


def _run_setup(url, instructions):
    """Orchestre le setup avec les vraies dépendances (Claude CLI + httpx)."""
    return build_setup(url, instructions, fetch_full=_fetch_full, claude=_claude)
```

Add the endpoint (after `/run`):

```python
@router.post("/setup")
def setup_harvester(data: SetupRequest, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    if urlparse(data.url).scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="URL doit être http(s)")
    try:
        preview = _run_setup(data.url, data.instructions)
    except Exception as e:  # LLM/fetch failure → surfaced to the operator
        logger.warning("[Harvester] setup failed: %r", e)
        raise HTTPException(status_code=502, detail="Setup IA échoué: {0}".format(str(e)[:200]))
    # no-PII gate sur la recette générée par Claude
    try:
        recipe = Recipe.from_dict(preview["recipe"])
    except (KeyError, TypeError):
        raise HTTPException(status_code=502, detail="Recette générée invalide")
    for name in recipe.field_names():
        if name.lower() in PII_FIELDS:
            raise HTTPException(
                status_code=400,
                detail="La recette générée contient un champ PII: '{0}'".format(name),
            )
    return preview
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_router.py -q`
Expected: PASS (all — the original 8 + 4 new)

- [ ] **Step 5: Verify the app still imports + full bots suite**

Run: `./venv/bin/python -c "import backend.main; print('ok')"`
Run: `./venv/bin/python -m pytest backend/bots/tests/ -q`
Expected: `ok` + all green.

- [ ] **Step 6: Commit**

```bash
git add backend/bots/harvester_router.py backend/bots/tests/test_harvester_router.py
git commit -m "feat(harvester): POST /setup (LLM recipe generation + PII gate) — P2 task 3"
```

---

## Task 4: frontend — "Générer (IA)" setup flow

**Files:**
- Modify: `frontend/js/harvester_module.js`
- Modify: `frontend/js/lang.js` (FR/EN/IT)
- Modify: `frontend/index.html` (cache-bust), `frontend/sw.js` (CACHE_NAME)

No pytest. Gate = `node -e "new Function(...)"` parse + Chrome verify.

- [ ] **Step 1: i18n keys (FR/EN/IT)**

In `frontend/js/lang.js`, add inside each language object right after its existing `harvester.*` block:

FR:
```javascript
    'harvester.instructions': 'Ce que tu veux extraire (langage naturel)',
    'harvester.generate': 'Générer la recette (IA)',
    'harvester.generating': 'Génération en cours…',
    'harvester.difficulty': 'Difficulté',
    'harvester.preview': 'Aperçu (échantillon)',
    'harvester.setup_error': 'Échec de la génération IA',
    'harvester.generated_ok': 'Recette générée — vérifie/édite puis lance',
```
EN:
```javascript
    'harvester.instructions': 'What you want to extract (natural language)',
    'harvester.generate': 'Generate recipe (AI)',
    'harvester.generating': 'Generating…',
    'harvester.difficulty': 'Difficulty',
    'harvester.preview': 'Preview (sample)',
    'harvester.setup_error': 'AI generation failed',
    'harvester.generated_ok': 'Recipe generated — review/edit then launch',
```
IT:
```javascript
    'harvester.instructions': 'Cosa vuoi estrarre (linguaggio naturale)',
    'harvester.generate': 'Genera ricetta (IA)',
    'harvester.generating': 'Generazione in corso…',
    'harvester.difficulty': 'Difficoltà',
    'harvester.preview': 'Anteprima (campione)',
    'harvester.setup_error': 'Generazione IA fallita',
    'harvester.generated_ok': 'Ricetta generata — controlla/modifica poi avvia',
```

- [ ] **Step 2: Add the instructions field + Generate button to the form in harvester_module.js**

In `_renderForm()`, insert — right after the URL input (the `<input id="hrv-url" ...>` line) and BEFORE the recipe label — this block:

```javascript
          <label class="form-label">${Lang.t('harvester.instructions')}</label>
          <textarea id="hrv-instructions" class="form-input" rows="2" placeholder="ex: titre, prix, disponibilité de chaque livre"></textarea>
          <div style="margin:8px 0;display:flex;gap:8px;align-items:center;">
            <button class="btn btn-secondary" id="hrv-gen-btn" onclick="HarvesterModule.generate()">${Lang.t('harvester.generate')}</button>
            <span id="hrv-gen-status" style="font-size:12px;color:var(--text-dim);"></span>
          </div>
          <div id="hrv-preview"></div>
```

- [ ] **Step 3: Add the `generate()` method to the HarvesterModule object**

Insert this method right before `start()`:

```javascript
    async generate() {
        const url = document.getElementById('hrv-url').value.trim();
        const instructions = document.getElementById('hrv-instructions').value.trim();
        const btn = document.getElementById('hrv-gen-btn');
        const status = document.getElementById('hrv-gen-status');
        if (btn) btn.disabled = true;
        if (status) status.textContent = Lang.t('harvester.generating');
        try {
            const r = await Auth.apiCall('/api/bots/harvester/setup', {
                method: 'POST',
                body: JSON.stringify({ url, instructions }),
            });
            if (!r || !r.ok) {
                const detail = r ? (await r.json().catch(() => ({}))).detail : '';
                if (status) status.textContent = Lang.t('harvester.setup_error') + (detail ? ': ' + detail : '');
                return;
            }
            const data = await r.json();
            document.getElementById('hrv-recipe').value = JSON.stringify(data.recipe, null, 2);
            document.getElementById('hrv-plan').value = JSON.stringify(data.plan || {}, null, 2);
            if (status) status.textContent = Lang.t('harvester.generated_ok') + ' · ' + Lang.t('harvester.difficulty') + ': ' + data.difficulty;
            this._renderPreview(data.sample || []);
        } catch (e) {
            if (status) status.textContent = Lang.t('harvester.setup_error');
        } finally {
            if (btn) btn.disabled = false;
        }
    },

    _renderPreview(sample) {
        const host = document.getElementById('hrv-preview');
        if (!host) return;
        if (!sample.length) { host.innerHTML = ''; return; }
        const cols = Object.keys(sample[0]);
        const head = cols.map(function (c) { return '<th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--border);">' + c + '</th>'; }).join('');
        const rows = sample.slice(0, 5).map(function (rec) {
            return '<tr>' + cols.map(function (c) { return '<td style="padding:4px 8px;border-bottom:1px solid var(--border);">' + (rec[c] || '') + '</td>'; }).join('') + '</tr>';
        }).join('');
        host.innerHTML = '<div class="form-label" style="margin-top:12px;">' + Lang.t('harvester.preview') + '</div>' +
            '<div style="overflow:auto;"><table style="border-collapse:collapse;font-family:var(--font-mono);font-size:12px;width:100%;"><thead><tr>' + head + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
    },
```

- [ ] **Step 4: Validate the JS parses (pitfall #28)**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur"
node -e "new Function(require('fs').readFileSync('frontend/js/harvester_module.js','utf8')); console.log('harvester_module ok')"
node -e "new Function(require('fs').readFileSync('frontend/js/lang.js','utf8')); console.log('lang ok')"
```
Expected: both `... ok`.

- [ ] **Step 5: Cache-bust**

In `frontend/index.html`: bump `harvester_module.js?v=2` → `?v=3` and `lang.js?v=229` → `?v=230` (read current values first; increment by 1). In `frontend/sw.js`: bump `CACHE_NAME` `omenserver-v113` → `omenserver-v114` (one above current).

- [ ] **Step 6: Re-validate parse + commit**

Re-run the two `node -e` checks. Then:
```bash
git add frontend/js/harvester_module.js frontend/js/lang.js frontend/index.html frontend/sw.js
git commit -m "feat(harvester): AI setup flow (instructions -> generate -> editable recipe + preview) — P2 task 4"
```

- [ ] **Step 7: Chrome verify (controller, after deploy)**

After P2 is green and deployed: in the live OmenServer tab, open AI Harvester, type instructions ("titre et prix de chaque livre"), click "Générer la recette (IA)", confirm the recipe + plan textareas fill, the difficulty shows, and a sample preview table renders — then "Lancer" runs as before. Read console for errors. (This step needs the real Claude CLI on the Omen; verify post-deploy.)

---

## Self-Review

**Spec coverage (P2, spec §10/§4/§5):** `llm._claude` → Task 1 ✓. `/setup` (probe difficulté + claude génère recette+plan+pacing + run échantillon → preview) → Tasks 2+3 ✓. Preview UI + editable recipe → Task 4 ✓ (fills the existing editable textareas; manual edit + Lancer untouched). Difficulty tiers + pacing calibration (the SETUP half of §5) → Task 2 ✓. **Adaptive back-off, stealth, unblocker = P3 (out of scope).**

**Test coverage (spec §11):** `llm._claude` mock subprocess → Task 1 ✓. setup probe/prompt/orchestration with injected fetch+claude → Task 2 ✓. router `/setup` admin-403, happy path, PII-reject, LLM-failure-502 → Task 3 ✓. All offline.

**Type consistency:** `_claude(prompt, model, timeout, run)`, `extract_json`, `probe_difficulty(status, headers)->str`, `pacing_for(tier)`, `build_setup_prompt(url, instructions, sample_html, tier)`, `build_setup(url, instructions, *, fetch_full, claude)`, router `_run_setup(url, instructions)` / `_fetch_full(url)`. The router monkeypatch target `_run_setup` matches Task 3's module-level function. The generated recipe uses the SAME `Recipe.from_dict` schema (incl. descendant chains) shipped in P1.

**No placeholders / no overbuild:** No adaptive pacing, no stealth import, no new runtime dependency (httpx already installed; the LLM is setup-only and injected).

---

## Execution Handoff

Execute via **superpowers:subagent-driven-development** — fresh subagent per task, controller verifies tests between tasks. Tasks 1-3 backend TDD (pytest green gate). Task 4 frontend (JS parse + post-deploy Chrome verify). Deploy follows the deploy-workflow memory (fetch + rebase onto origin/main, bump cache-bust above origin). ⚠️ `/setup` needs the real `claude` CLI on the Omen — CI/tests never call it (injected), but the live Chrome verify does.
