# AI Harvester — P3a (adaptive pacing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the harvester a *polite* crawler that adapts to server pushback — when the target answers `429` / `Retry-After` / a challenge page, it **slows down (raises its interval) and cools off**, never hammering, then eases back toward the base rate once the target recovers. This is the spec's "vrai filet" anti-flag mechanism (§5.2) and is pure courteous-crawler behavior (the opposite of evasion).

**Architecture:** A pure `AdaptivePacer` (penalize on pushback → bigger interval, capped; relax on success → decay toward base) lives in `harvester/pacing.py`. `fetch.py` gains a `PushbackError(FetchError)` carrying `status`/`retry_after` and raises it on `429` / `503+Retry-After` / a detected challenge body (instead of a generic retry-then-fail). The `engine` takes an optional `pacer`: on a `PushbackError` it penalizes + waits the (now larger) interval + retries the SAME url up to a bounded count (a 429 means "later", not "broken"); on success it relaxes + paces by `pacer.interval()`. `__main__` builds the pacer from the harvest's `pacing.min_interval_s` and makes it the sole per-step spacer. **Zero new dependency. Backward-compatible** (no pacer → exact P1 behavior, all existing engine tests stay green).

**Tech Stack:** Python 3.9 (no 3.10+ syntax). Pure stdlib + httpx (already installed). Tests: pytest, fully offline (injected clock/sleep/fetch, httpx MockTransport).

---

## Scope — P3a ONLY

This plan covers **only the adaptive-pacing half of P3** (spec §5.2). It deliberately **excludes** the stealth tier (patchright) and the unblocker tier (spec §6/§9): those are anti-bot **circumvention**, which is out of bounds for this agent to build or operate. The fetcher stays a single httpx tier; its `get(url) -> str` interface is already pluggable, so those tiers can be added later by the operator without touching the engine/pacing.

## Conventions

- **Python 3.9.** `Optional`/`Callable`/`Dict`/`Any` from `typing`; `# type:` comments.
- **Test command** (project root has a space):
  ```bash
  cd "/Users/massimiliano/omenserver Project/Projet serveur"
  ./venv/bin/python -m pytest backend/bots/tests/ -q
  ```
- No new dependency. No network in tests.

## File Structure (P3a)

| File | Responsibility |
|---|---|
| `backend/bots/harvester/pacing.py` (new) | `AdaptivePacer` — penalize/relax/interval — pure |
| `backend/bots/harvester/fetch.py` (modify) | `PushbackError`, `is_challenge`, `_parse_retry_after`, raise on 429/challenge |
| `backend/bots/harvester/engine.py` (modify) | optional `pacer`: pushback → penalize + bounded retry; success → relax + pace |
| `backend/bots/harvester/__main__.py` (modify) | build `AdaptivePacer` from `pacing.min_interval_s`, pass to engine (sole spacer) |
| Tests | `test_harvester_pacing.py` (new) + extend `test_harvester_fetch.py`, `test_harvester_engine.py`, `test_harvester_main.py` |

## Canonical interfaces

```python
# pacing.py
class AdaptivePacer:
    def __init__(self, base_interval_s, max_interval_s=300.0, backoff_factor=2.0, recover_factor=0.5): ...
    def interval(self) -> float: ...
    def penalize(self, retry_after=None) -> None: ...   # jump to retry_after, else *backoff; clamp [base, max]
    def relax(self) -> None: ...                         # *recover_factor, floor at base

# fetch.py
class PushbackError(FetchError):
    def __init__(self, message, status=None, retry_after=None): ...  # .status, .retry_after
def is_challenge(text: str) -> bool: ...
# HttpxFetcher.get raises PushbackError on 429 / 503+Retry-After / challenge body

# engine.py — Engine(..., pacer=None, max_pushback_retries=5)
```

---

## Task 1: pacing.py — AdaptivePacer

**Files:**
- Create: `backend/bots/harvester/pacing.py`
- Test: `backend/bots/tests/test_harvester_pacing.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/bots/tests/test_harvester_pacing.py
from backend.bots.harvester.pacing import AdaptivePacer


def test_starts_at_base():
    p = AdaptivePacer(2.0)
    assert p.interval() == 2.0


def test_penalize_multiplies_and_caps():
    p = AdaptivePacer(2.0, max_interval_s=10.0, backoff_factor=2.0)
    p.penalize()
    assert p.interval() == 4.0
    p.penalize()
    assert p.interval() == 8.0
    p.penalize()
    assert p.interval() == 10.0   # capped at max
    p.penalize()
    assert p.interval() == 10.0


def test_penalize_honours_retry_after():
    p = AdaptivePacer(2.0, max_interval_s=300.0)
    p.penalize(retry_after=30.0)
    assert p.interval() == 30.0


def test_penalize_retry_after_clamped_to_range():
    p = AdaptivePacer(2.0, max_interval_s=20.0)
    p.penalize(retry_after=999.0)
    assert p.interval() == 20.0          # clamp to max
    p2 = AdaptivePacer(5.0)
    p2.penalize(retry_after=1.0)
    assert p2.interval() == 5.0          # never below base


def test_relax_decays_toward_base_never_below():
    p = AdaptivePacer(2.0, max_interval_s=100.0, backoff_factor=2.0, recover_factor=0.5)
    p.penalize(); p.penalize(); p.penalize()  # 16
    assert p.interval() == 16.0
    p.relax(); assert p.interval() == 8.0
    p.relax(); assert p.interval() == 4.0
    p.relax(); assert p.interval() == 2.0
    p.relax(); assert p.interval() == 2.0     # floor at base
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_pacing.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'backend.bots.harvester.pacing'`

- [ ] **Step 3: Write minimal implementation**

```python
# backend/bots/harvester/pacing.py
"""Pacing adaptatif (P3a) : le 'vrai filet' anti-flag. Pur, déterministe.

Crawler POLI — quand la cible pousse (429/Retry-After/challenge), on AUGMENTE
l'intervalle (capé) puis on REVIENT doucement vers la base quand ça se calme.
Ce n'est PAS de l'évasion : c'est ralentir quand le serveur le demande."""
from typing import Optional


class AdaptivePacer(object):
    def __init__(self, base_interval_s, max_interval_s=300.0,
                 backoff_factor=2.0, recover_factor=0.5):
        self.base = float(base_interval_s)
        self.max = float(max_interval_s)
        self.backoff_factor = float(backoff_factor)
        self.recover_factor = float(recover_factor)
        self.current = self.base

    def interval(self):
        return self.current

    def _clamp(self, value):
        return min(max(value, self.base), self.max)

    def penalize(self, retry_after=None):
        # type: (Optional[float]) -> None
        if retry_after is not None:
            self.current = self._clamp(float(retry_after))
        else:
            self.current = self._clamp(self.current * self.backoff_factor)

    def relax(self):
        self.current = max(self.base, self.current * self.recover_factor)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_pacing.py -q`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/bots/harvester/pacing.py backend/bots/tests/test_harvester_pacing.py
git commit -m "feat(harvester): adaptive pacer (penalize/relax) — P3a task 1"
```

---

## Task 2: fetch.py — PushbackError + challenge/429 detection

**Files:**
- Modify: `backend/bots/harvester/fetch.py`
- Test: extend `backend/bots/tests/test_harvester_fetch.py`

- [ ] **Step 1: Append the failing tests** to `backend/bots/tests/test_harvester_fetch.py`:

```python


from backend.bots.harvester.fetch import PushbackError, is_challenge


def test_is_challenge_detects_cloudflare_interstitial():
    assert is_challenge("<html><title>Just a moment...</title></html>") is True
    assert is_challenge("<h1>Checking your browser before accessing</h1>") is True
    assert is_challenge("<html>ok normal page</html>") is False


def test_fetcher_raises_pushback_on_429_with_retry_after():
    def handler(request):
        return httpx.Response(429, text="slow down", headers={"Retry-After": "42"})
    client = httpx.Client(transport=httpx.MockTransport(handler))
    f = HttpxFetcher(rate=_silent_rate(), retries=3, client=client, sleep=lambda s: None)
    try:
        f.get("https://x.test/")
        assert False, "should have raised"
    except PushbackError as e:
        assert e.status == 429
        assert e.retry_after == 42.0


def test_fetcher_does_not_internally_retry_a_429():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(429, text="nope")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    f = HttpxFetcher(rate=_silent_rate(), retries=3, client=client, sleep=lambda s: None)
    try:
        f.get("https://x.test/")
    except PushbackError:
        pass
    assert calls["n"] == 1  # surfaced to the engine immediately, not hammered


def test_fetcher_raises_pushback_on_challenge_body_even_with_200():
    def handler(request):
        return httpx.Response(200, text="<title>Just a moment...</title>")
    client = httpx.Client(transport=httpx.MockTransport(handler))
    f = HttpxFetcher(rate=_silent_rate(), retries=3, client=client, sleep=lambda s: None)
    try:
        f.get("https://x.test/")
        assert False, "should have raised"
    except PushbackError as e:
        assert e.status == 200


def test_pushback_is_a_fetcherror_subclass():
    assert issubclass(PushbackError, FetchError)
```

- [ ] **Step 2: Run, confirm FAIL**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_fetch.py -q`
Expected: FAIL — `ImportError: cannot import name 'PushbackError'`

- [ ] **Step 3: Modify `backend/bots/harvester/fetch.py`.** Add after the `FetchError` class:

```python
class PushbackError(FetchError):
    """Le serveur demande de ralentir (429/Retry-After) ou nous challenge.
    Porte le status + un éventuel délai Retry-After (secondes)."""

    def __init__(self, message, status=None, retry_after=None):
        FetchError.__init__(self, message)
        self.status = status
        self.retry_after = retry_after


_CHALLENGE_TOKENS = (
    "just a moment",
    "checking your browser",
    "attention required",
    "verify you are human",
    "cf-challenge",
)


def is_challenge(text):
    t = (text or "").lower()
    return any(tok in t for tok in _CHALLENGE_TOKENS)


def _parse_retry_after(value):
    if not value:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None  # HTTP-date form ignored (we just fall back to multiplicative)
```

Then replace the body of `HttpxFetcher.get` with:

```python
    def get(self, url: str) -> str:
        import httpx  # lazy
        client = self._get_client()
        last = None  # type: Optional[str]
        for attempt in range(self.retries):
            self.rate.wait()
            try:
                resp = client.get(url)
            except httpx.HTTPError as e:
                last = repr(e)
            else:
                sc = resp.status_code
                # pushback : surfacé tout de suite (l'engine adapte le pacing)
                if sc == 429 or (sc == 503 and resp.headers.get("Retry-After")):
                    raise PushbackError(
                        "HTTP {0}".format(sc), status=sc,
                        retry_after=_parse_retry_after(resp.headers.get("Retry-After")))
                if sc >= 400:
                    last = "HTTP {0}".format(sc)
                else:
                    text = resp.text
                    if is_challenge(text):
                        raise PushbackError("challenge page", status=sc, retry_after=None)
                    return text
            if attempt < self.retries - 1:
                self._sleep(1.0 * (attempt + 1))  # linear back-off (transient errors)
        raise FetchError("GET {0} failed: {1}".format(url, last))
```

- [ ] **Step 4: Run, confirm PASS** (the 4 original + 5 new):

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_fetch.py -q`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/bots/harvester/fetch.py backend/bots/tests/test_harvester_fetch.py
git commit -m "feat(harvester): PushbackError + 429/challenge detection — P3a task 2"
```

---

## Task 3: engine.py — adaptive pacing integration

**Files:**
- Modify: `backend/bots/harvester/engine.py`
- Test: extend `backend/bots/tests/test_harvester_engine.py`

Behaviour with a `pacer`:
- **success** → `pacer.relax()`, then pace by `pacer.interval()` (the pacer is the sole spacer; jitter is ignored when a pacer is present).
- **PushbackError** → `pacer.penalize(retry_after)`, increment a per-url counter; if `< max_pushback_retries` → sleep `pacer.interval()` and **retry the same url** (do NOT mark done — a 429 means "later"); if `>=` → give up (`add_error` + `mark_done`). Without a pacer, a `PushbackError` behaves like a generic `FetchError` (existing branch) so old behavior is unchanged.
- **FetchError** (non-pushback) → unchanged (add_error + mark_done + back-off).

- [ ] **Step 1: Append the failing tests** to `backend/bots/tests/test_harvester_engine.py`:

```python


from backend.bots.harvester.fetch import PushbackError
from backend.bots.harvester.pacing import AdaptivePacer


class PushbackThenOkFetcher(object):
    """429 the first `n` times for page-1, then serves normally."""
    def __init__(self, pages, fail_times):
        self.pages = pages
        self.fail_times = fail_times
        self.calls = []

    def get(self, url):
        self.calls.append(url)
        if self.fail_times > 0:
            self.fail_times -= 1
            raise PushbackError("429", status=429, retry_after=None)
        return self.pages[url]


def test_engine_pushback_retries_same_url_and_penalizes(tmp_path):
    store = _store(tmp_path)
    store.add_todo("https://x.test/page-1.html")
    pacer = AdaptivePacer(2.0, backoff_factor=2.0)
    slept = []
    fetcher = PushbackThenOkFetcher({"https://x.test/page-1.html": PAGE2}, fail_times=2)
    eng = Engine(store, Recipe.from_dict(LISTING_RECIPE), fetcher,
                 FieldPolicy(allowed=["title", "price"]), {"mode": "sitemap"},
                 sleep=lambda s: slept.append(s), pacer=pacer)
    eng.run()
    # page-1 fetched 3× (2 pushbacks + 1 success), never abandoned
    assert fetcher.calls == ["https://x.test/page-1.html"] * 3
    assert store.records() == [{"title": "B", "price": "£2"}]
    assert store.counts()["done"] == 1
    assert store.counts()["errors"] == 0
    # interval grew on the 2 pushbacks (4, then 8) then relaxed once on success (→4)
    assert 4.0 in slept and 8.0 in slept


def test_engine_pushback_gives_up_after_max_retries(tmp_path):
    store = _store(tmp_path)
    store.add_todo("https://x.test/page-1.html")

    class AlwaysPushback(object):
        def get(self, url):
            raise PushbackError("429", status=429, retry_after=None)

    pacer = AdaptivePacer(1.0, max_interval_s=100.0)
    eng = Engine(store, Recipe.from_dict(LISTING_RECIPE), AlwaysPushback(),
                 FieldPolicy(allowed=["title", "price"]), {"mode": "sitemap"},
                 sleep=lambda s: None, pacer=pacer, max_pushback_retries=3)
    eng.run()
    assert store.counts()["errors"] == 1
    assert store.counts()["done"] == 1   # abandoned after the cap so the loop ends


def test_engine_paces_by_pacer_interval_on_success(tmp_path):
    store = _store(tmp_path)
    store.add_todo("https://x.test/page-1.html")
    pacer = AdaptivePacer(3.0)
    slept = []
    fetcher = FakeFetcher({"https://x.test/page-1.html": PAGE2})
    eng = Engine(store, Recipe.from_dict(LISTING_RECIPE), fetcher,
                 FieldPolicy(allowed=["title", "price"]), {"mode": "sitemap"},
                 sleep=lambda s: slept.append(s), pacer=pacer)
    eng.run()
    assert 3.0 in slept   # paced by pacer.interval(), not jitter
```

- [ ] **Step 2: Run, confirm FAIL**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_engine.py -q`
Expected: FAIL — `TypeError: __init__() got an unexpected keyword argument 'pacer'`

- [ ] **Step 3: Modify `backend/bots/harvester/engine.py`.**

Update the imports line:
```python
from backend.bots.harvester.fetch import FetchError, PushbackError
```

Add `pacer` + `max_pushback_retries` params and a per-url counter in `__init__` (add to the signature after `error_backoff_s`):
```python
    def __init__(self, store, recipe, fetcher, policy, plan,
                 sleep: Callable[[float], None] = time.sleep,
                 jitter: Optional[Callable[[], float]] = None,
                 on_progress: Optional[Callable[[Dict[str, Any]], None]] = None,
                 should_stop: Optional[Callable[[], bool]] = None,
                 error_backoff_s: float = 10.0,
                 pacer=None, max_pushback_retries: int = 5) -> None:
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
        self._pacer = pacer
        self.max_pushback_retries = max_pushback_retries
        self._pushbacks = {}  # type: Dict[str, int]
```

Add a pacing helper + rewrite `step()`:
```python
    def _pace(self) -> None:
        if self._pacer is not None:
            self._sleep(self._pacer.interval())
        elif self._jitter is not None:
            self._sleep(self._jitter())

    def step(self) -> bool:
        if self._should_stop():
            return False
        url = self.store.next_todo()
        if url is None:
            return False

        try:
            html = self.fetcher.get(url)
        except PushbackError as e:
            if self._pacer is not None:
                self._pacer.penalize(e.retry_after)
                n = self._pushbacks.get(url, 0) + 1
                self._pushbacks[url] = n
                self.store.save()
                self._progress()
                self._pace()  # wait the (now larger) interval
                if n >= self.max_pushback_retries:
                    # give up on this url so the loop can converge
                    self.store.add_error()
                    self.store.mark_done(url)
                    self.store.save()
                return True
            # no pacer → treat like a generic error (P1 behaviour)
            self.store.add_error()
            self.store.mark_done(url)
            self.store.save()
            self._progress()
            self._sleep(self.error_backoff_s)
            return True
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
        if self._pacer is not None:
            self._pacer.relax()
        self._pace()
        return True
```

Note the success branch now calls `_pace()` (which uses the pacer when present, else the jitter) — this preserves the existing jitter behaviour when no pacer is given, so all P1/P2 engine tests stay green.

- [ ] **Step 4: Run, confirm PASS** (the 7 original + 3 new):

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_engine.py -q`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/bots/harvester/engine.py backend/bots/tests/test_harvester_engine.py
git commit -m "feat(harvester): engine adaptive pacing (pushback retry + relax) — P3a task 3"
```

---

## Task 4: __main__.py — wire the AdaptivePacer

**Files:**
- Modify: `backend/bots/harvester/__main__.py`
- Test: extend `backend/bots/tests/test_harvester_main.py`

The deployed harvester builds an `AdaptivePacer(base=pacing.min_interval_s)` and passes it to the engine as the sole spacer; the fetcher's `RateLimiter` is set to `0.0` to avoid double-pacing (the pacer governs spacing). When a `fetcher` is injected (tests), no pacer is built unless one is passed — keep the smoke test simple by leaving the default-path wiring covered by a focused assertion.

- [ ] **Step 1: Append the failing test** to `backend/bots/tests/test_harvester_main.py`:

```python


def test_build_engine_uses_adaptive_pacer_from_config(tmp_path, monkeypatch):
    from backend.bots.harvester import __main__ as entry
    from backend.bots.harvester.pacing import AdaptivePacer

    cfg = dict(CFG)
    cfg["pacing"] = {"min_interval_s": 7.0, "jitter": [0.0, 0.0]}
    HarvestConfig.from_dict(cfg).save(str(tmp_path))
    store = Store(str(tmp_path / "store.json"))
    store.add_todo(cfg["url"])
    store.save()

    captured = {}
    real_engine = entry.Engine

    def spy_engine(*args, **kwargs):
        captured["pacer"] = kwargs.get("pacer")
        return real_engine(*args, **kwargs)

    monkeypatch.setattr(entry, "Engine", spy_engine)
    rc = entry.run_harvest(str(tmp_path), fetcher=FakeFetcher())
    assert rc == 0
    assert isinstance(captured["pacer"], AdaptivePacer)
    assert captured["pacer"].base == 7.0
```

- [ ] **Step 2: Run, confirm FAIL**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_main.py -q`
Expected: FAIL — `KeyError: 'pacer'` / `AssertionError` (Engine built without a pacer)

- [ ] **Step 3: Modify `backend/bots/harvester/__main__.py`.**

Add the import:
```python
from backend.bots.harvester.pacing import AdaptivePacer
```

In `run_harvest`, after computing `pacing = cfg.pacing or {}` and BEFORE building the engine, build the pacer and adjust the fetcher default so the pacer is the sole spacer. Replace the existing fetcher-default + jitter + Engine construction block with:

```python
    pacing = cfg.pacing or {}
    base_interval = float(pacing.get("min_interval_s", 1.5))
    pacer = AdaptivePacer(base_interval)

    if fetcher is None:
        # le pacer gouverne l'espacement → le RateLimiter du fetcher est un
        # simple plancher à 0 (pas de double-pacing).
        rate = RateLimiter(0.0)
        fetcher = HttpxFetcher(rate)

    def should_stop():
        return os.path.isfile(os.path.join(run_dir, STOP_FILE))

    def on_progress(counts):
        _emit({"type": "progress", "counts": counts})

    eng = Engine(store, cfg.recipe, fetcher, FieldPolicy(allowed=cfg.recipe.field_names()),
                 cfg.plan, on_progress=on_progress, should_stop=should_stop, pacer=pacer)
```

(Remove the old `jit`/`jitter` closure and the old `Engine(...)` call — the pacer replaces the jitter as the spacer. Keep everything else, including the `try/except eng.run()` block and `_emit` calls.)

- [ ] **Step 4: Run, confirm PASS**

Run: `./venv/bin/python -m pytest backend/bots/tests/test_harvester_main.py -q`
Expected: PASS (the original main test + the new one)

- [ ] **Step 5: Verify the whole suite + app import**

Run: `./venv/bin/python -m pytest backend/bots/tests/ -q`
Run: `./venv/bin/python -c "import backend.main; print('ok')"`
Expected: all green + `ok`.

- [ ] **Step 6: Commit**

```bash
git add backend/bots/harvester/__main__.py backend/bots/tests/test_harvester_main.py
git commit -m "feat(harvester): wire AdaptivePacer into the detached run — P3a task 4"
```

---

## Self-Review

**Spec coverage (§5.2):** adaptive back-off (429/challenge → bigger interval + cooldown, never hammer) → Tasks 1-3 ✓; wired into the live run → Task 4 ✓. **Stealth/unblocker tiers (§6/§9) intentionally NOT built** (anti-bot circumvention — out of bounds; fetcher interface left pluggable for the operator).

**Test coverage:** pacer penalize/relax/clamp → Task 1 ✓; PushbackError + 429/Retry-After/challenge detection + no-internal-retry → Task 2 ✓; engine pushback-retry/give-up/relax-pace → Task 3 ✓; pacer wired from config → Task 4 ✓. All offline.

**Backward compatibility:** `pacer=None` path = exact P1/P2 behaviour (jitter spacing, generic FetchError handling). `PushbackError` subclasses `FetchError`, and `except PushbackError` precedes `except FetchError`, so no-pacer pushbacks fall through to the unchanged generic branch. Existing engine/fetch/main tests stay green.

**Type consistency:** `AdaptivePacer(base, max, backoff_factor, recover_factor)` / `.interval()/.penalize(retry_after)/.relax()`; `PushbackError(message, status, retry_after)`; `Engine(..., pacer=None, max_pushback_retries=5)`. `__main__` builds `AdaptivePacer(base=min_interval_s)`.

---

## Execution Handoff

Execute via **superpowers:subagent-driven-development** — fresh subagent per task, controller verifies tests between tasks. All backend TDD (pytest green gate each). Deploy follows the deploy-workflow memory (fetch + rebase onto origin/main, bump nothing on the frontend — P3a is backend-only, no cache-bust needed). After deploy, no special live verification is required beyond "a harvest still runs"; the adaptive behaviour only manifests against a pushing target.
