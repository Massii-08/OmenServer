# Harvester — CAPTCHA interactif human-in-the-loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre à Massii de résoudre à la main les rares CAPTCHA interactifs qui bloquent le tier stealth — auto-click de la case Turnstile + (si un puzzle persiste) pause, notif Telegram, vue live noVNC dans le dashboard, reprise — sans aucun solveur automatique, payant en dernier recours.

**Architecture:** Tout vit dans le tier `stealth`. `StealthFetcher` (logique testée offline, `BrowserSession` injectable) gagne un auto-click générique + un mode « résolution manuelle » (émet des events run.log, notifie, poll jusqu'à résolution/timeout). Le router surface l'état `awaiting_solve` via `/status` (miroir du mécanisme `recommend_tier`). Un bridge WebSocket FastAPI admin-gated pompe les octets RFB vers `x11vnc` (socket Unix, zéro port TCP) ; le dashboard embarque noVNC. Secrets Telegram = modèle `unblocker_config.py`.

**Tech Stack:** Python 3.9, FastAPI/Starlette (WebSocket + `asyncio.open_unix_connection`), patchright (vrai Chrome sous Xvfb :100), httpx (notif Telegram, déjà présent — zéro nouvelle dép), x11vnc + noVNC (vendored, vanilla JS, pas de build).

**Référence spec :** `docs/superpowers/specs/2026-06-21-harvester-manual-captcha-design.md`

---

## Conventions & garde-fous (lire avant de commencer)

- **TDD strict** : test d'abord (le voir échouer), puis le minimum pour passer, puis commit. `cd "$REPO" && source venv/bin/activate && python -m pytest backend/ -q` doit rester **100% vert** (~748 → +N).
- Commandes de test ciblées : `python -m pytest backend/bots/tests/test_<x>.py -q`.
- **GARDE-FOU ANTI-SOLVEUR** : aucun OCR / modèle d'images / résolution de puzzle / service de solving. L'auto-click clique une **case** (le navigateur valide parce qu'il est vrai). Tout ce qui *résout un puzzle* = l'humain via noVNC.
- **Déterminisme** : zéro IA dans la boucle runtime. Horloge/sleep/session/httpx **injectés** dans les tests (aucun réseau, aucune horloge réelle).
- **Secrets** : les fichiers `data/*.json` (Telegram) naissent en 0o600 (atomique), vue API masquée, endpoints admin-only.
- **Pas de push sur `main` sans feu vert de Massii.** Worktree `feat/harvester-manual-captcha` (déjà créé, off `origin/main`).
- Le subprocess s'appelle `python -m backend.bots.harvester <run_dir>` ; sentinelle d'arrêt = fichier `stop.flag` dans le run_dir.

---

## File Structure

**Créés :**
- `backend/bots/harvester/telegram_config.py` — config Telegram persistante (modèle `unblocker_config.py`).
- `backend/bots/harvester/notify.py` — notif Telegram best-effort (POST httpx, injectable, ne fuite jamais le token).
- `backend/bots/tests/test_harvester_telegram.py` — tests config + notifier (offline).
- `backend/bots/tests/test_harvester_manual_solve.py` — tests auto-click + manual-solve + wiring `_build_fetcher` (offline).
- `backend/bots/tests/test_harvester_vnc_bridge.py` — tests autorisation du bridge (offline).
- `frontend/js/vendor/novnc/…` — noVNC core (ESM) vendored, servi par le mount `/js`.
- `tools/omen-harvester-vnc.service` — unit systemd x11vnc (socket Unix).
- `tools/HARVESTER_VNC_INSTALL.md` — procédure d'install one-shot (apt + systemd).

**Modifiés :**
- `backend/bots/harvester/fetch_stealth.py` — `click_turnstile` + `_click_challenge` + refactor `get()` (`_attempt`) + manual-solve (`_await_manual_solve`, events, notify, should_stop, clock).
- `backend/bots/harvester/__main__.py` — `_build_fetcher` branche `stealth` : câble `on_event`, `manual_solve`, `manual_solve_timeout`, `notify` (Telegram).
- `backend/bots/harvester_router.py` — `_capture` parse les events solve ; `_solve_from_log` + `_job_awaiting` ; champ `awaiting_solve` dans `/status` & `/active` ; endpoints `/telegram-config*` ; bridge WS `/vnc/{job_id}` + `_ws_admin_from_token` + `_vnc_authorize` + `_pump_ws_socket`.
- `frontend/js/harvester_module.js` — case `manual_solve` + wiring `start()` ; panneau Telegram (load/save/clear) ; panneau `#hrv-solve` (noVNC) dans `_renderRunning` + lifecycle dans `_poll`.
- `frontend/js/lang.js` — clés `harvester.*` FR/EN/IT (manual_solve, awaiting, solve, telegram).
- `frontend/index.html` — cache-bust `lang.js?v=237`, `harvester_module.js?v=10`.
- `frontend/sw.js` — `CACHE_NAME = 'omenserver-v122'`.

---

# FEATURE A — Auto-click de la case Turnstile

### Task A1 : `click_turnstile` + intégration dans `get()`

**Files:**
- Modify: `backend/bots/harvester/fetch_stealth.py`
- Test: `backend/bots/tests/test_harvester_manual_solve.py` (create)

- [ ] **Step 1 : Écrire les tests qui échouent**

Create `backend/bots/tests/test_harvester_manual_solve.py` :

```python
"""Tests features A (auto-click case) + B (résolution manuelle) du tier stealth.
100% offline : BrowserSession factice + clock/sleep/should_stop/notify injectés."""
import pytest

from backend.bots.harvester.fetch import PushbackError, RateLimiter
from backend.bots.harvester.fetch_stealth import StealthFetcher


def _rate():
    return RateLimiter(0.0, clock=lambda: 0.0, sleep=lambda s: None)


def _sf(session, **kw):
    kw.setdefault("warm_url", "https://site.test/p1")
    kw.setdefault("sleep", lambda s: None)
    kw.setdefault("jitter", lambda: 0.0)
    kw.setdefault("retries", 2)
    kw.setdefault("max_wait_s", 1)
    return StealthFetcher(_rate(), session=session, **kw)


class ClickSession(object):
    """Reste en challenge jusqu'au click de la case, puis sert du contenu propre."""
    def __init__(self):
        self._clicked = False
        self.click_calls = 0
        self.gotos = 0

    def goto(self, url):
        self.gotos += 1

    def title(self):
        return "Real page" if self._clicked else "Just a moment..."

    def content(self):
        return ("<html><body>clean</body></html>" if self._clicked
                else '<div class="cf-turnstile">verify</div>')

    def interact(self):
        pass

    def click_turnstile(self):
        self.click_calls += 1
        self._clicked = True
        return True


class NoClickSession(object):
    """Session sans click_turnstile : l'auto-click doit être toléré (no-op)."""
    def __init__(self, html, title="OK"):
        self._html = html
        self._title = title

    def goto(self, url):
        pass

    def title(self):
        return self._title

    def content(self):
        return self._html

    def interact(self):
        pass


def test_autoclick_resolves_checkbox_challenge():
    s = ClickSession()
    out = _sf(s).get("https://site.test/x")
    assert out == "<html><body>clean</body></html>"
    assert s.click_calls == 1


def test_no_click_method_is_tolerated_and_still_pushes_back():
    # corps challenge + pas de click_turnstile -> PushbackError (comportement legacy)
    s = NoClickSession('<div class="cf-turnstile">x</div>', title="Welcome")
    with pytest.raises(PushbackError):
        _sf(s).get("https://site.test/x")
```

- [ ] **Step 2 : Lancer les tests, voir échouer**

Run: `source venv/bin/activate && python -m pytest backend/bots/tests/test_harvester_manual_solve.py -q`
Expected: FAIL — `test_autoclick_resolves_checkbox_challenge` échoue (l'auto-click n'est pas branché → le challenge persiste → PushbackError au lieu du HTML propre).

- [ ] **Step 3 : Ajouter `_click_challenge` + `click_turnstile` au Protocol + refactor `get()`**

Dans `fetch_stealth.py`, ajouter la fonction module-level après `_interact` :

```python
def _click_challenge(session) -> bool:
    """Best-effort : demande à la session de cliquer la case Turnstile au centre.
    Tolère une session sans ``click_turnstile`` (comme ``_interact``). NE RÉSOUT
    RIEN — un vrai navigateur valide le clic. True si un widget a été cliqué."""
    fn = getattr(session, "click_turnstile", None)
    if callable(fn):
        try:
            return bool(fn())
        except Exception:  # noqa: BLE001 — best-effort
            return False
    return False
```

Ajouter au Protocol `BrowserSession` (après `screenshot`) :

```python
    def click_turnstile(self) -> bool: ...  # auto-click case (best-effort, optionnel)
```

Remplacer la méthode `get()` par une version refactorée en `_attempt` + auto-click. Remplacer :

```python
        last_error: Optional[str] = None
        for _ in range(self.retries):
            session.goto(url)
            _interact(session)  # N1: look human before reading the DOM
            if self._wait_resolved(session):
                html = session.content()
                # B: even if the title cleared, the body may still be an
                # interstitial / Turnstile -> never accept it as content.
                if not is_challenge_html(html):
                    return html
                last_error = "challenge markers in body"
            else:
                last_error = "Cloudflare challenge unresolved"
            # cookie may have gone cold -> re-warm before the next attempt.
            self._warmed = False
            self._warm(session)

        self._dump_block(session, url)  # diagnostic : screenshot + HTML au blocage
        # PushbackError (sous-classe de FetchError) -> l'engine recule (pacer)
        # et réessaie l'URL au lieu de la marteler ou de l'abandonner sèchement.
        raise PushbackError(
            "GET {0} blocked: {1}".format(url, last_error), retry_after=None)
```

par :

```python
        last_error: Optional[str] = None
        for _ in range(self.retries):
            html = self._attempt(session, url)
            if html is not None:
                return html
            last_error = self._attempt_error
            # cookie may have gone cold -> re-warm before the next attempt.
            self._warmed = False
            self._warm(session)

        self._dump_block(session, url)  # diagnostic : screenshot + HTML au blocage
        return self._raise_block(url, last_error)

    def _attempt(self, session: "BrowserSession", url: str):
        """Un essai : goto + bruit + attente ; si le challenge persiste, auto-click
        GÉNÉRIQUE de la case puis ré-attente. Retourne le HTML propre, ou None.
        Mémorise la cause dans ``self._attempt_error``."""
        session.goto(url)
        _interact(session)  # N1: look human before reading the DOM
        if self._wait_resolved(session):
            html = session.content()
            # B: même si le titre est clean, le corps peut rester un
            # interstitiel / Turnstile -> ne jamais l'accepter comme contenu.
            if not is_challenge_html(html):
                self._attempt_error = None
                return html
            self._attempt_error = "challenge markers in body"
        else:
            self._attempt_error = "Cloudflare challenge unresolved"
        # A: challenge persiste -> auto-click générique de la case + ré-attente.
        if _click_challenge(session) and self._wait_resolved(session):
            html = session.content()
            if not is_challenge_html(html):
                self._attempt_error = None
                return html
        return None

    def _raise_block(self, url: str, last_error):
        """Lève PushbackError (sous-classe de FetchError) -> l'engine recule
        (pacer) et réessaie l'URL au lieu de la marteler. Surchargé en B."""
        raise PushbackError(
            "GET {0} blocked: {1}".format(url, last_error), retry_after=None)
```

Dans `__init__`, initialiser le champ (avant `return`/fin de méthode, après `self._block_n` block) :

```python
        self._attempt_error = None  # cause du dernier essai (A/B)
```

- [ ] **Step 4 : Ajouter `click_turnstile` à la vraie session patchright**

Dans `PatchrightBrowserSession`, ajouter après `interact` :

```python
    def click_turnstile(self) -> bool:
        """Localise le widget Turnstile / l'iframe challenge et clique AU CENTRE
        (bounding box). Ne touche JAMAIS l'intérieur de l'iframe (sélecteur
        obfusqué) -> robuste & générique. NE RÉSOUT RIEN. True si trouvé+cliqué.
        Best-effort : toute erreur -> False (jamais de crash de fetch)."""
        self._ensure()
        try:
            for sel in (".cf-turnstile",
                        "iframe[src*='challenges.cloudflare.com']",
                        "iframe[title*='challenge' i]"):
                loc = self._page.locator(sel).first
                if loc.count() == 0:
                    continue
                box = loc.bounding_box()
                if not box:
                    continue
                self._page.mouse.click(box["x"] + box["width"] / 2.0,
                                       box["y"] + box["height"] / 2.0)
                return True
        except Exception:  # noqa: BLE001 — best-effort, jamais fatal
            return False
        return False
```

- [ ] **Step 5 : Lancer les tests A + la régression block-detection**

Run: `python -m pytest backend/bots/tests/test_harvester_manual_solve.py backend/bots/tests/test_harvester_block_detection.py -q`
Expected: PASS (les 2 nouveaux + les ~10 existants de block-detection inchangés).

- [ ] **Step 6 : Commit**

```bash
git add backend/bots/harvester/fetch_stealth.py backend/bots/tests/test_harvester_manual_solve.py
git commit -m "feat(harvester): auto-click générique de la case Turnstile (tier stealth)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

# FEATURE B — Résolution manuelle (détection puzzle + pause/poll/timeout)

### Task B1 : `_await_manual_solve` + events + notify + should_stop

**Files:**
- Modify: `backend/bots/harvester/fetch_stealth.py`
- Test: `backend/bots/tests/test_harvester_manual_solve.py`

- [ ] **Step 1 : Écrire les tests qui échouent**

Ajouter à `test_harvester_manual_solve.py` :

```python
class FlipSession(object):
    """Reste en challenge jusqu'au Nᵉ appel de title(), puis propre."""
    def __init__(self, flip_after):
        self.flip_after = flip_after
        self.title_calls = 0
        self.gotos = 0

    def goto(self, url):
        self.gotos += 1

    def title(self):
        self.title_calls += 1
        return "Real" if self.title_calls > self.flip_after else "Just a moment..."

    def content(self):
        return ("<html>clean</html>" if self.title_calls > self.flip_after
                else '<div class="cf-turnstile">x</div>')

    def interact(self):
        pass

    def click_turnstile(self):
        return False  # l'auto-click ne suffit pas (vrai puzzle) -> manual solve


def _counter_clock(start=0.0, step=1.0):
    state = {"t": start}

    def clock():
        v = state["t"]
        state["t"] += step
        return v
    return clock


def test_await_manual_solve_resolves_and_returns_html():
    s = FlipSession(flip_after=2)
    events = []
    f = _sf(s, on_event=events.append, manual_solve=True,
            manual_solve_timeout=100, solve_poll_s=0.0,
            clock=lambda: 0.0, should_stop=lambda: False)
    out = f._await_manual_solve(s, "https://site.test/x")
    assert out == "<html>clean</html>"
    types = [e["type"] for e in events]
    assert types == ["awaiting_manual_solve", "manual_solve_resolved"]


def test_await_manual_solve_times_out_returns_none():
    s = FlipSession(flip_after=9999)  # jamais résolu
    events = []
    f = _sf(s, on_event=events.append, manual_solve=True,
            manual_solve_timeout=3, solve_poll_s=0.0,
            clock=_counter_clock(), should_stop=lambda: False)
    out = f._await_manual_solve(s, "https://site.test/x")
    assert out is None
    assert [e["type"] for e in events] == ["awaiting_manual_solve", "manual_solve_timeout"]


def test_await_manual_solve_aborts_on_stop():
    s = FlipSession(flip_after=9999)
    events = []
    f = _sf(s, on_event=events.append, manual_solve=True,
            manual_solve_timeout=100, solve_poll_s=0.0,
            clock=lambda: 0.0, should_stop=lambda: True)
    assert f._await_manual_solve(s, "https://site.test/x") is None
    assert [e["type"] for e in events] == ["awaiting_manual_solve", "manual_solve_timeout"]


def test_await_manual_solve_notifies_once_with_url():
    s = FlipSession(flip_after=1)
    sent = []
    f = _sf(s, manual_solve=True, manual_solve_timeout=100, solve_poll_s=0.0,
            clock=lambda: 0.0, should_stop=lambda: False, notify=sent.append)
    f._await_manual_solve(s, "https://site.test/captcha")
    assert len(sent) == 1
    assert "https://site.test/captcha" in sent[0]


def test_get_manual_solve_off_raises_pushback():
    # manual_solve OFF (défaut) -> comportement legacy (PushbackError)
    s = FlipSession(flip_after=9999)
    with pytest.raises(PushbackError):
        _sf(s).get("https://site.test/x")


def test_get_falls_back_to_pushback_on_solve_timeout():
    # manual_solve ON mais jamais résolu -> awaiting puis timeout -> PushbackError
    s = FlipSession(flip_after=9999)
    events = []
    f = _sf(s, on_event=events.append, manual_solve=True, manual_solve_timeout=3,
            solve_poll_s=0.0, clock=_counter_clock(), should_stop=lambda: False)
    with pytest.raises(PushbackError):
        f.get("https://site.test/x")
    assert "awaiting_manual_solve" in [e["type"] for e in events]
    assert "manual_solve_timeout" in [e["type"] for e in events]
```

- [ ] **Step 2 : Lancer, voir échouer**

Run: `python -m pytest backend/bots/tests/test_harvester_manual_solve.py -q -k manual_solve`
Expected: FAIL — `StealthFetcher.__init__()` n'accepte pas `on_event`/`manual_solve`/`clock`/`should_stop`/`notify` ; `_await_manual_solve` n'existe pas.

- [ ] **Step 3 : Étendre `StealthFetcher.__init__` + ajouter les helpers**

Dans `fetch_stealth.py`, importer `os` est déjà fait. Étendre la signature de `__init__` (ajouter les paramètres APRÈS `rewarm_every`) :

```python
        rewarm_every: int = 0,
        on_event: Optional[Callable[[dict], None]] = None,
        notify: Optional[Callable[[str], None]] = None,
        manual_solve: bool = False,
        manual_solve_timeout: int = 1800,
        solve_poll_s: float = 3.0,
        should_stop: Optional[Callable[[], bool]] = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
```

Dans le corps de `__init__` (après `self.rewarm_every = rewarm_every`) :

```python
        self._on_event = on_event
        self._notify = notify
        self.manual_solve = manual_solve
        self.manual_solve_timeout = manual_solve_timeout
        self.solve_poll_s = solve_poll_s
        self._clock = clock
        if should_stop is not None:
            self._should_stop = should_stop
        elif run_dir:
            # arrêt propre pendant l'attente : le router pose stop.flag dans run_dir
            self._should_stop = lambda: os.path.isfile(
                os.path.join(run_dir, "stop.flag"))
        else:
            self._should_stop = lambda: False
```

Ajouter les helpers (méthodes, après `_raise_block`) :

```python
    def _emit_event(self, obj: dict) -> None:
        """Émet un event (JSON line stdout via on_event=_emit) -> run.log -> router.
        Best-effort : ne fait jamais échouer un fetch."""
        if self._on_event:
            try:
                self._on_event(obj)
            except Exception:  # noqa: BLE001
                pass

    def _do_notify(self, text: str) -> None:
        """Notif best-effort (Telegram). Ne lève jamais."""
        if self._notify:
            try:
                self._notify(text)
            except Exception:  # noqa: BLE001
                pass

    def _await_manual_solve(self, session: "BrowserSession", url: str):
        """Pause : garde la page ouverte, notifie, poll en LECTURE SEULE jusqu'à
        résolution / timeout / stop. Retourne le HTML résolu, ou None.

        Ne navigue ni n'interagit pendant l'attente (ne se bat pas avec les clics
        humains via noVNC) ; un seul re-goto si le titre est clean mais le corps
        porte encore des marqueurs."""
        start = self._clock()
        self._emit_event({"type": "awaiting_manual_solve", "url": url,
                          "since": start, "timeout_s": self.manual_solve_timeout})
        self._do_notify(
            "\U0001F512 CAPTCHA a resoudre sur {0} - ouvre le bot Harvester sur "
            "omenserver.org".format(url))
        while self._clock() - start < self.manual_solve_timeout:
            if self._should_stop():
                break
            if not is_challenge(session.title()):
                html = session.content()
                if is_challenge_html(html):
                    session.goto(url)       # un seul refresh post-résolution
                    html = session.content()
                if not is_challenge_html(html):
                    self._emit_event({"type": "manual_solve_resolved", "url": url})
                    return html
            self._sleep(self.solve_poll_s)
        self._emit_event({"type": "manual_solve_timeout", "url": url})
        return None
```

Brancher la résolution manuelle dans `get()` : remplacer la ligne finale `return self._raise_block(url, last_error)` par :

```python
        self._dump_block(session, url)  # diagnostic : screenshot + HTML au blocage
        if self.manual_solve:
            html = self._await_manual_solve(session, url)
            if html is not None:
                return html
        return self._raise_block(url, last_error)
```

(Note : le `self._dump_block` était déjà à cet endroit ; garder une seule occurrence.)

- [ ] **Step 4 : Lancer les tests**

Run: `python -m pytest backend/bots/tests/test_harvester_manual_solve.py -q`
Expected: PASS (tous, A + B).

- [ ] **Step 5 : Régression complète stealth**

Run: `python -m pytest backend/bots/tests/test_harvester_block_detection.py -q`
Expected: PASS (inchangé).

- [ ] **Step 6 : Commit**

```bash
git add backend/bots/harvester/fetch_stealth.py backend/bots/tests/test_harvester_manual_solve.py
git commit -m "feat(harvester): mode résolution manuelle (pause/poll/timeout + events)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task B2 : Câblage `_build_fetcher` (stealth → on_event/manual_solve/should_stop)

**Files:**
- Modify: `backend/bots/harvester/__main__.py`
- Test: `backend/bots/tests/test_harvester_manual_solve.py`

- [ ] **Step 1 : Écrire les tests qui échouent**

Ajouter à `test_harvester_manual_solve.py` :

```python
from backend.bots.harvester.__main__ import _build_fetcher
from backend.bots.harvester.fetch_stealth import StealthFetcher


def test_build_fetcher_stealth_wires_manual_solve():
    plan = {"fetch_tier": "stealth", "manual_solve": True, "manual_solve_timeout": 1200}
    f = _build_fetcher("stealth", _rate(), "https://t.test/p", plan, "/tmp/run")
    assert isinstance(f, StealthFetcher)
    assert f.manual_solve is True
    assert f.manual_solve_timeout == 1200
    assert f._on_event is not None        # câblé sur _emit


def test_build_fetcher_stealth_manual_solve_off_by_default():
    f = _build_fetcher("stealth", _rate(), "https://t.test/p",
                       {"fetch_tier": "stealth"}, "/tmp/run")
    assert f.manual_solve is False


def test_build_fetcher_stealth_manual_solve_strict_true():
    # "true" (string, plan édité main) ne doit PAS activer (strict is True)
    f = _build_fetcher("stealth", _rate(), "https://t.test/p",
                       {"fetch_tier": "stealth", "manual_solve": "true"}, None)
    assert f.manual_solve is False


def test_build_fetcher_stealth_timeout_clamped():
    f = _build_fetcher("stealth", _rate(), "https://t.test/p",
                       {"fetch_tier": "stealth", "manual_solve": True,
                        "manual_solve_timeout": 99999}, None)
    assert f.manual_solve_timeout == 3600
```

- [ ] **Step 2 : Lancer, voir échouer**

Run: `python -m pytest backend/bots/tests/test_harvester_manual_solve.py -q -k build_fetcher_stealth`
Expected: FAIL — `f.manual_solve` est False même quand le plan le demande (non câblé).

- [ ] **Step 3 : Câbler dans `_build_fetcher`**

Dans `__main__.py`, branche `if tier == "stealth":`, juste avant `return StealthFetcher(`, ajouter :

```python
        ms = (plan.get("manual_solve") is True)   # strict : seul un vrai bool active
        ms_timeout = _as_int(plan.get("manual_solve_timeout"), 1800, lo=30, hi=3600)
```

Et compléter l'appel `return StealthFetcher(...)` avec les nouveaux kwargs :

```python
        return StealthFetcher(
            rate, warm_url=url, jitter=jitter,
            max_wait_s=_as_int(plan.get("max_wait"), 35, lo=1, hi=120),
            retries=_as_int(plan.get("retries"), 2, lo=1, hi=10),
            run_dir=run_dir, browser_opts=browser_opts,
            rewarm_every=_as_int(plan.get("rewarm_every"), 0, lo=0, hi=10000),
            on_event=_emit,                  # events -> run.log -> router
            manual_solve=ms,
            manual_solve_timeout=ms_timeout,
            notify=None,                     # câblé sur Telegram en C4
        )
```

- [ ] **Step 4 : Lancer les tests**

Run: `python -m pytest backend/bots/tests/test_harvester_manual_solve.py -q`
Expected: PASS.

- [ ] **Step 5 : Commit**

```bash
git add backend/bots/harvester/__main__.py backend/bots/tests/test_harvester_manual_solve.py
git commit -m "feat(harvester): _build_fetcher câble on_event + manual_solve (stealth)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task B3 : Router — events solve + `awaiting_solve` dans /status & /active

**Files:**
- Modify: `backend/bots/harvester_router.py`
- Test: `backend/bots/tests/test_harvester_router.py`

- [ ] **Step 1 : Écrire les tests qui échouent**

Ajouter à `backend/bots/tests/test_harvester_router.py` :

```python
def _seed_run(c, tmp_path):
    job_id = c.post("/api/bots/harvester/run", json=GOOD_BODY).json()["job_id"]
    return job_id, tmp_path / job_id


def test_solve_from_log_awaiting(tmp_path):
    rd = tmp_path / "r"
    rd.mkdir()
    (rd / "run.log").write_text(
        json.dumps({"type": "awaiting_manual_solve", "url": "https://x",
                    "since": 1.0, "timeout_s": 1800}) + "\n", encoding="utf-8")
    msg = hr._solve_from_log(str(rd))
    assert msg and msg["url"] == "https://x"


def test_solve_from_log_cleared_after_resolved(tmp_path):
    rd = tmp_path / "r"
    rd.mkdir()
    (rd / "run.log").write_text(
        json.dumps({"type": "awaiting_manual_solve", "url": "https://x", "since": 1.0,
                    "timeout_s": 1800}) + "\n"
        + json.dumps({"type": "manual_solve_resolved", "url": "https://x"}) + "\n",
        encoding="utf-8")
    assert hr._solve_from_log(str(rd)) is None


def test_status_surfaces_awaiting_solve(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    job_id, rd = _seed_run(c, tmp_path)
    (rd / "run.log").write_text(
        json.dumps({"type": "awaiting_manual_solve", "url": "https://x", "since": 1.0,
                    "timeout_s": 1800}) + "\n", encoding="utf-8")
    s = c.get("/api/bots/harvester/status/{0}".format(job_id)).json()
    assert s["awaiting_solve"]["url"] == "https://x"
```

- [ ] **Step 2 : Lancer, voir échouer**

Run: `python -m pytest backend/bots/tests/test_harvester_router.py -q -k "solve_from_log or awaiting"`
Expected: FAIL — `hr._solve_from_log` n'existe pas ; `/status` n'a pas de champ `awaiting_solve`.

- [ ] **Step 3 : Ajouter `_solve_from_log` + `_job_awaiting`**

Dans `harvester_router.py`, après la fonction `_recommend_from_log` (et sa constante `_RECO_TAIL_BYTES`), ajouter :

```python
def _solve_from_log(run_dir, max_bytes=_RECO_TAIL_BYTES):
    """État courant de résolution manuelle, reconstruit depuis la FIN de run.log
    (miroir de _recommend_from_log). Renvoie l'event `awaiting_manual_solve`
    SEULEMENT s'il n'a pas été suivi d'un `manual_solve_resolved`/`_timeout`
    (état transitoire). None sinon. Survit au restart uvicorn. Jamais de secret."""
    p = Path(run_dir) / "run.log"
    if not p.is_file():
        return None
    try:
        size = p.stat().st_size
        with open(str(p), "rb") as f:
            if size > max_bytes:
                f.seek(size - max_bytes)
                f.readline()
            data = f.read()
        text = data.decode("utf-8", errors="replace")
    except OSError:
        return None
    last = None
    for line in text.splitlines():
        line = line.strip()
        if not line or "manual_solve" not in line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        t = msg.get("type")
        if t == "awaiting_manual_solve":
            last = msg
        elif t in ("manual_solve_resolved", "manual_solve_timeout"):
            last = None
    return last


def _job_awaiting(job):
    """État `awaiting_solve` d'un job : mémoire (posée par _capture) si le process
    est suivi vivant, sinon relecture du tail (restart-résilient). NON caché
    (l'état est transitoire : awaiting -> resolved)."""
    if job.get("process") is not None:
        return job.get("awaiting_solve")
    return _solve_from_log(str(_run_dir(job["job_id"])))
```

- [ ] **Step 4 : Parser les events dans `_capture`**

Dans `_launch_subprocess._capture`, dans le `try: msg = json.loads(stripped)`, après la branche `elif msg.get("type") == "recommend_tier":` ajouter :

```python
                    elif msg.get("type") == "awaiting_manual_solve":
                        j["awaiting_solve"] = msg
                    elif msg.get("type") in ("manual_solve_resolved",
                                             "manual_solve_timeout"):
                        j["awaiting_solve"] = None
```

- [ ] **Step 5 : Exposer `awaiting_solve` dans `/status` et `/active`**

Dans `harvester_status`, ajouter au dict retourné (après `"recommend": _job_recommend(job),`) :

```python
        "awaiting_solve": _job_awaiting(job),
```

Dans `harvester_active`, dans le `return {...}` du job actif, ajouter (après `"recommend": _job_recommend(job)}`) — insérer avant la `}` :

```python
                    "recommend": _job_recommend(job),
                    "awaiting_solve": _job_awaiting(job)}
```

Dans `_job_from_disk`, ajouter au dict (après `"recommend": _recommend_from_log(str(run_dir)),`) :

```python
        "awaiting_solve": _solve_from_log(str(run_dir)),
```

- [ ] **Step 6 : Lancer les tests + régression router**

Run: `python -m pytest backend/bots/tests/test_harvester_router.py -q`
Expected: PASS (nouveaux + existants).

- [ ] **Step 7 : Commit**

```bash
git add backend/bots/harvester_router.py backend/bots/tests/test_harvester_router.py
git commit -m "feat(harvester): surface awaiting_solve via /status & /active (run.log tail)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task B4 : Frontend — case `manual_solve` + wiring `start()` + bandeau awaiting (texte)

**Files:**
- Modify: `frontend/js/harvester_module.js`

- [ ] **Step 1 : Ajouter la case dans `_renderForm`**

Dans `_renderForm`, juste après le bloc `<div class="form-hint">${Lang.t('harvester.stealth_hint')}</div>` (la fin du bloc stealth, avant le bloc unblocker), insérer :

```javascript
          <label style="display:flex;align-items:center;gap:8px;margin-top:10px;cursor:pointer;font-size:14px;">
            <input type="checkbox" id="hrv-manual-solve" style="width:16px;height:16px;accent-color:var(--accent);cursor:pointer;" />
            <span>${Lang.t('harvester.manual_solve')}</span>
          </label>
          <div class="form-hint">${Lang.t('harvester.manual_solve_hint')}</div>
```

- [ ] **Step 2 : Câbler `manual_solve` dans `start()`**

Dans `start()`, dans le bloc `if (plan && typeof plan === 'object') {`, après `if (dedupeEl && dedupeEl.checked) plan.dedupe = true; else delete plan.dedupe;`, ajouter :

```javascript
            const manualEl = document.getElementById('hrv-manual-solve');
            // manual_solve n'a de sens qu'en stealth ; envoyé seulement si coché.
            if (manualEl && manualEl.checked && plan.fetch_tier === 'stealth') plan.manual_solve = true;
            else delete plan.manual_solve;
```

- [ ] **Step 3 : Ajouter le bandeau `#hrv-solve` (texte) dans `_renderRunning`**

Dans `_renderRunning`, juste après la ligne du bandeau reco
`<div id="hrv-reco" ...></div>`, insérer :

```javascript
          <div id="hrv-solve" style="display:none;margin-bottom:12px;padding:12px;border-radius:var(--r-md);background:var(--bg-elev-3);border:1px solid var(--accent);color:var(--text);font-size:13px;">
            <div style="font-weight:600;margin-bottom:4px;">${Lang.t('harvester.awaiting_title')}</div>
            <div id="hrv-solve-hint" style="color:var(--text-muted);">${Lang.t('harvester.awaiting_hint')}</div>
            <div id="hrv-solve-host" style="margin-top:10px;"></div>
          </div>
```

- [ ] **Step 4 : Afficher/masquer le bandeau dans `_poll`**

Dans `_poll`, après le bloc qui gère `#hrv-reco` (`const recoEl = ...}`), ajouter :

```javascript
            const solveEl = document.getElementById('hrv-solve');
            if (solveEl) {
                if (data.awaiting_solve && data.status === 'running') {
                    solveEl.style.display = '';
                } else {
                    solveEl.style.display = 'none';
                }
            }
```

(Le canvas noVNC sera branché dans la D4 — pour l'instant ce bandeau texte signale juste l'attente.)

- [ ] **Step 5 : Vérifier le parse JS (piège #28)**

Run: `node -e "new Function(require('fs').readFileSync('frontend/js/harvester_module.js','utf8'))" && echo PARSE_OK`
Expected: `PARSE_OK`

- [ ] **Step 6 : Commit**

```bash
git add frontend/js/harvester_module.js
git commit -m "feat(harvester): case manual_solve + bandeau awaiting (frontend)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

# FEATURE C — Config Telegram persistante + notif

### Task C1 : `telegram_config.py`

**Files:**
- Create: `backend/bots/harvester/telegram_config.py`
- Test: `backend/bots/tests/test_harvester_telegram.py` (create)

- [ ] **Step 1 : Écrire les tests qui échouent**

Create `backend/bots/tests/test_harvester_telegram.py` :

```python
"""Tests config Telegram persistante + notifier. 100% offline."""
import os
import stat

from backend.bots.harvester import telegram_config as tc


def test_load_absent_returns_empty(tmp_path):
    assert tc.load(str(tmp_path / "none.json")) == {}


def test_save_then_load_roundtrip(tmp_path):
    p = str(tmp_path / "tg.json")
    tc.save({"token": "123:ABC", "chat_id": "42"}, p)
    assert tc.load(p) == {"token": "123:ABC", "chat_id": "42"}


def test_save_is_chmod_600(tmp_path):
    p = str(tmp_path / "tg.json")
    tc.save({"token": "X", "chat_id": "1"}, p)
    assert stat.S_IMODE(os.stat(p).st_mode) == 0o600


def test_save_is_600_even_if_preexisting(tmp_path):
    p = str(tmp_path / "tg.json")
    with open(p, "w") as f:
        f.write("{}")
    os.chmod(p, 0o644)
    tc.save({"token": "X", "chat_id": "1"}, p)
    assert stat.S_IMODE(os.stat(p).st_mode) == 0o600


def test_clear_is_idempotent(tmp_path):
    p = str(tmp_path / "tg.json")
    tc.clear(p)            # absent -> no error
    tc.save({"token": "X", "chat_id": "1"}, p)
    tc.clear(p)
    assert not os.path.exists(p)


def test_public_view_masks_token():
    v = tc.public_view({"token": "123456:ABCDEF", "chat_id": "42"})
    assert v["configured"] is True
    assert v["chat_id"] == "42"
    assert v["token_masked"] == "····CDEF"
    assert "123456" not in str(v)       # le token brut ne sort jamais


def test_public_view_not_configured_without_chat_id():
    v = tc.public_view({"token": "123456:ABCDEF"})
    assert v["configured"] is False
```

- [ ] **Step 2 : Lancer, voir échouer**

Run: `python -m pytest backend/bots/tests/test_harvester_telegram.py -q`
Expected: FAIL — `ModuleNotFoundError: telegram_config`.

- [ ] **Step 3 : Créer le module**

Create `backend/bots/harvester/telegram_config.py` :

```python
"""Config Telegram persistante (token + chat_id) posée depuis l'UI — pas le .env,
pas le code. Stockée côté serveur dans ``data/harvester_telegram.json`` en chmod
600 (même posture que unblocker_config / les secrets).

🔒 Le token brut ne sort JAMAIS par l'API : ``public_view`` le masque. Le path est
injectable (``DEFAULT_PATH`` surchargeable) -> tests offline."""
import json
import os
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
DEFAULT_PATH = str(_PROJECT_ROOT / "data" / "harvester_telegram.json")


def load(path=None):
    """Charge la config (dict) ; {} si absente/illisible/corrompue."""
    p = Path(path or DEFAULT_PATH)
    if not p.is_file():
        return {}
    try:
        with open(str(p), "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def save(cfg, path=None):
    """Écrit la config. Le token est un secret -> le fichier NAÎT en 0o600
    (création atomique via ``os.open``, pas de fenêtre world-readable) ;
    ``os.fchmod`` couvre un fichier pré-existant aux autres permissions."""
    p = Path(path or DEFAULT_PATH)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(p), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)
    except (AttributeError, OSError):
        pass
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def clear(path=None):
    """Supprime la config (idempotent : pas d'erreur si déjà absente)."""
    p = Path(path or DEFAULT_PATH)
    try:
        p.unlink()
    except OSError:
        pass


def public_view(cfg):
    """Vue SANS le token brut (masqué) -> sûre à renvoyer par l'API."""
    token = cfg.get("token") or ""
    if len(token) >= 4:
        masked = "····" + token[-4:]
    elif token:
        masked = "····"
    else:
        masked = ""
    return {
        "configured": bool(token and cfg.get("chat_id")),
        "chat_id": cfg.get("chat_id", ""),
        "token_masked": masked,
    }
```

- [ ] **Step 4 : Lancer, voir passer**

Run: `python -m pytest backend/bots/tests/test_harvester_telegram.py -q`
Expected: PASS.

- [ ] **Step 5 : Commit**

```bash
git add backend/bots/harvester/telegram_config.py backend/bots/tests/test_harvester_telegram.py
git commit -m "feat(harvester): config Telegram persistante (0o600, vue masquée)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task C2 : `notify.py` (POST Telegram best-effort)

**Files:**
- Create: `backend/bots/harvester/notify.py`
- Test: `backend/bots/tests/test_harvester_telegram.py`

- [ ] **Step 1 : Écrire les tests qui échouent**

Ajouter à `test_harvester_telegram.py` :

```python
import json as _json
import httpx

from backend.bots.harvester import notify


def test_send_posts_to_telegram_api():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["json"] = _json.loads(request.content)
        return httpx.Response(200, json={"ok": True})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    ok = notify.send("hello", {"token": "TKN", "chat_id": "CID"}, client=client)
    assert ok is True
    assert "/botTKN/sendMessage" in seen["url"]
    assert seen["json"] == {"chat_id": "CID", "text": "hello"}


def test_send_returns_false_without_config():
    assert notify.send("x", {}, client=httpx.Client(
        transport=httpx.MockTransport(lambda r: httpx.Response(200)))) is False


def test_send_swallows_errors_and_returns_false():
    def boom(request):
        raise httpx.ConnectError("down")
    client = httpx.Client(transport=httpx.MockTransport(boom))
    assert notify.send("x", {"token": "T", "chat_id": "C"}, client=client) is False


def test_send_returns_false_on_http_error_status():
    client = httpx.Client(transport=httpx.MockTransport(
        lambda r: httpx.Response(403, json={"ok": False})))
    assert notify.send("x", {"token": "T", "chat_id": "C"}, client=client) is False
```

- [ ] **Step 2 : Lancer, voir échouer**

Run: `python -m pytest backend/bots/tests/test_harvester_telegram.py -q -k send`
Expected: FAIL — `ModuleNotFoundError: notify`.

- [ ] **Step 3 : Créer le module**

Create `backend/bots/harvester/notify.py` :

```python
"""Notif Telegram best-effort (POST httpx). AUCUNE lib telegram (httpx déjà
présent -> zéro nouvelle dép). Ne lève JAMAIS, ne fuite JAMAIS le token (toute
exception est avalée -> False, on ne logge aucun message d'exception)."""
import httpx

_API = "https://api.telegram.org/bot{0}/sendMessage"


def send(text, cfg, client=None):
    """Envoie ``text`` au chat configuré. Retourne True si HTTP < 400, sinon False.
    cfg = {"token", "chat_id"}. ``client`` httpx injectable (test offline)."""
    token = (cfg or {}).get("token")
    chat_id = (cfg or {}).get("chat_id")
    if not token or not chat_id:
        return False
    owns = client is None
    if owns:
        client = httpx.Client(timeout=10.0)
    try:
        resp = client.post(_API.format(token),
                           json={"chat_id": chat_id, "text": text})
        return resp.status_code < 400
    except Exception:  # noqa: BLE001 — best-effort, ne fuite jamais le token
        return False
    finally:
        if owns:
            try:
                client.close()
            except Exception:  # noqa: BLE001
                pass
```

- [ ] **Step 4 : Lancer, voir passer**

Run: `python -m pytest backend/bots/tests/test_harvester_telegram.py -q`
Expected: PASS.

- [ ] **Step 5 : Commit**

```bash
git add backend/bots/harvester/notify.py backend/bots/tests/test_harvester_telegram.py
git commit -m "feat(harvester): notifier Telegram best-effort (httpx, zéro fuite token)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task C3 : Endpoints `/telegram-config*` (admin-only)

**Files:**
- Modify: `backend/bots/harvester_router.py`
- Test: `backend/bots/tests/test_harvester_router.py`

- [ ] **Step 1 : Écrire les tests qui échouent**

Ajouter à `test_harvester_router.py` :

```python
def test_telegram_config_admin_only(tmp_path, monkeypatch):
    monkeypatch.setattr(hr.telegram_config, "DEFAULT_PATH", str(tmp_path / "tg.json"))
    c, _ = make_client(tmp_path, monkeypatch, is_admin=False)
    assert c.get("/api/bots/harvester/telegram-config").status_code == 403
    assert c.post("/api/bots/harvester/telegram-config",
                  json={"token": "T", "chat_id": "C"}).status_code == 403


def test_telegram_config_save_masks_token(tmp_path, monkeypatch):
    monkeypatch.setattr(hr.telegram_config, "DEFAULT_PATH", str(tmp_path / "tg.json"))
    c, _ = make_client(tmp_path, monkeypatch)
    r = c.post("/api/bots/harvester/telegram-config",
               json={"token": "123456:ABCDEF", "chat_id": "42"})
    assert r.status_code == 200
    body = r.json()
    assert body["configured"] is True
    assert body["token_masked"] == "····CDEF"
    assert "123456" not in str(body)
    # GET renvoie la vue masquée
    g = c.get("/api/bots/harvester/telegram-config").json()
    assert g["chat_id"] == "42"
    assert "123456" not in str(g)


def test_telegram_config_empty_token_keeps_existing(tmp_path, monkeypatch):
    monkeypatch.setattr(hr.telegram_config, "DEFAULT_PATH", str(tmp_path / "tg.json"))
    c, _ = make_client(tmp_path, monkeypatch)
    c.post("/api/bots/harvester/telegram-config",
           json={"token": "SECRET:TOKEN", "chat_id": "1"})
    # token vide -> on garde l'existant, on change juste le chat_id
    c.post("/api/bots/harvester/telegram-config", json={"token": "", "chat_id": "2"})
    saved = hr.telegram_config.load(str(tmp_path / "tg.json"))
    assert saved["token"] == "SECRET:TOKEN"
    assert saved["chat_id"] == "2"


def test_telegram_config_clear(tmp_path, monkeypatch):
    monkeypatch.setattr(hr.telegram_config, "DEFAULT_PATH", str(tmp_path / "tg.json"))
    c, _ = make_client(tmp_path, monkeypatch)
    c.post("/api/bots/harvester/telegram-config",
           json={"token": "T:K", "chat_id": "1"})
    assert c.post("/api/bots/harvester/telegram-config/clear").json()["configured"] is False
    assert hr.telegram_config.load(str(tmp_path / "tg.json")) == {}
```

- [ ] **Step 2 : Lancer, voir échouer**

Run: `python -m pytest backend/bots/tests/test_harvester_router.py -q -k telegram`
Expected: FAIL — endpoints absents (404) ; `hr.telegram_config` non importé.

- [ ] **Step 3 : Ajouter import + modèle + endpoints**

Dans `harvester_router.py`, à côté de `from backend.bots.harvester import unblocker_config`, ajouter :

```python
from backend.bots.harvester import telegram_config
from backend.bots.harvester import notify as _notify
```

Après la classe `UnblockerConfigRequest`, ajouter :

```python
class TelegramConfigRequest(BaseModel):
    token: str = ""          # vide -> on garde le token déjà enregistré
    chat_id: str = ""
```

Après l'endpoint `clear_unblocker_config`, ajouter :

```python
@router.get("/telegram-config")
def get_telegram_config(current_user: User = Depends(get_current_user)):
    """Vue publique de la config Telegram (token MASQUÉ). Admin-only."""
    _require_admin(current_user)
    return telegram_config.public_view(telegram_config.load())


@router.post("/telegram-config")
def set_telegram_config(data: TelegramConfigRequest,
                        current_user: User = Depends(get_current_user)):
    """Enregistre la config Telegram (token en chmod 600). Token vide -> on garde
    l'existant (permet d'ajuster le chat_id sans recoller le token). Admin-only."""
    _require_admin(current_user)
    existing = telegram_config.load()
    cfg = {"chat_id": data.chat_id.strip()}
    new_token = data.token.strip()
    if new_token:
        cfg["token"] = new_token
    elif existing.get("token"):
        cfg["token"] = existing["token"]
    telegram_config.save(cfg)
    return telegram_config.public_view(cfg)


@router.post("/telegram-config/clear")
def clear_telegram_config(current_user: User = Depends(get_current_user)):
    """Oublie la config Telegram (supprime le fichier). Admin-only."""
    _require_admin(current_user)
    telegram_config.clear()
    return {"configured": False}
```

- [ ] **Step 4 : Lancer les tests**

Run: `python -m pytest backend/bots/tests/test_harvester_router.py -q -k telegram`
Expected: PASS.

- [ ] **Step 5 : Commit**

```bash
git add backend/bots/harvester_router.py backend/bots/tests/test_harvester_router.py
git commit -m "feat(harvester): endpoints config Telegram (admin-only, token masqué)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task C4 : Câbler le notifier Telegram dans `_build_fetcher`

**Files:**
- Modify: `backend/bots/harvester/__main__.py`
- Test: `backend/bots/tests/test_harvester_manual_solve.py`

- [ ] **Step 1 : Écrire le test qui échoue**

Ajouter à `test_harvester_manual_solve.py` :

```python
def test_build_fetcher_stealth_wires_telegram_notifier(monkeypatch):
    from backend.bots.harvester import telegram_config as tc
    monkeypatch.setattr(tc, "load", lambda path=None: {"token": "T", "chat_id": "C"})
    f = _build_fetcher("stealth", _rate(), "https://t.test/p",
                       {"fetch_tier": "stealth", "manual_solve": True}, None)
    assert callable(f._notify)


def test_build_fetcher_stealth_no_notifier_without_telegram(monkeypatch):
    from backend.bots.harvester import telegram_config as tc
    monkeypatch.setattr(tc, "load", lambda path=None: {})
    f = _build_fetcher("stealth", _rate(), "https://t.test/p",
                       {"fetch_tier": "stealth", "manual_solve": True}, None)
    assert f._notify is None
```

- [ ] **Step 2 : Lancer, voir échouer**

Run: `python -m pytest backend/bots/tests/test_harvester_manual_solve.py -q -k notifier`
Expected: FAIL — `f._notify` est None (toujours câblé `notify=None`).

- [ ] **Step 3 : Construire le notifier dans `_build_fetcher`**

Dans `__main__.py`, ajouter une fonction helper au-dessus de `_build_fetcher` :

```python
def _make_telegram_notifier():
    """Construit un callable de notif Telegram si la config persistante est
    complète, sinon None (manual-solve marche sans, Telegram = juste l'alerte)."""
    from backend.bots.harvester import telegram_config, notify
    cfg = telegram_config.load()
    if cfg.get("token") and cfg.get("chat_id"):
        return lambda text: notify.send(text, cfg)
    return None
```

Dans la branche `stealth`, remplacer `notify=None,` par :

```python
            notify=_make_telegram_notifier(),
```

- [ ] **Step 4 : Lancer les tests**

Run: `python -m pytest backend/bots/tests/test_harvester_manual_solve.py -q`
Expected: PASS.

- [ ] **Step 5 : Commit**

```bash
git add backend/bots/harvester/__main__.py backend/bots/tests/test_harvester_manual_solve.py
git commit -m "feat(harvester): câble le notifier Telegram dans le tier stealth

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task C5 : Frontend — panneau de config Telegram

**Files:**
- Modify: `frontend/js/harvester_module.js`

- [ ] **Step 1 : Ajouter le panneau `<details>` dans `_renderForm`**

Dans `_renderForm`, juste après le `<div class="form-hint">${Lang.t('harvester.manual_solve_hint')}</div>` (ajouté en B4), insérer :

```javascript
          <details id="hrv-tg-settings" style="margin-top:8px;border:1px solid var(--border);border-radius:var(--r-md);padding:0 12px;">
            <summary style="cursor:pointer;padding:10px 0;font-size:13px;color:var(--text-muted);">${Lang.t('harvester.telegram_settings')} · <span id="hrv-tg-status" style="color:var(--text-dim);">—</span></summary>
            <div style="padding-bottom:12px;">
              <label class="form-label">${Lang.t('harvester.telegram_token')}</label>
              <input id="hrv-tg-token" class="form-input" type="password" autocomplete="off" placeholder="${Lang.t('harvester.telegram_token_ph')}" />
              <label class="form-label">${Lang.t('harvester.telegram_chatid')}</label>
              <input id="hrv-tg-chatid" class="form-input" placeholder="123456789" />
              <div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                <button class="btn btn-sm btn-primary" onclick="HarvesterModule.saveTelegramConfig()">${Lang.t('harvester.telegram_save')}</button>
                <button class="btn btn-sm btn-ghost" onclick="HarvesterModule.clearTelegramConfig()">${Lang.t('harvester.telegram_clear')}</button>
                <span id="hrv-tg-msg" style="font-size:12px;color:var(--text-dim);"></span>
              </div>
            </div>
          </details>
```

- [ ] **Step 2 : Ajouter les méthodes load/save/clear**

Dans l'objet `HarvesterModule`, après `clearUnblockerConfig()`, ajouter :

```javascript
    async _loadTelegramConfig() {
        try {
            const r = await Auth.apiCall('/api/bots/harvester/telegram-config');
            if (!r || !r.ok) return;
            const d = await r.json();
            const chat = document.getElementById('hrv-tg-chatid');
            if (chat) chat.value = d.chat_id || '';
            const status = document.getElementById('hrv-tg-status');
            if (status) {
                status.textContent = d.configured
                    ? (Lang.t('harvester.telegram_configured') + (d.token_masked ? ' · ' + d.token_masked : ''))
                    : Lang.t('harvester.telegram_notconfigured');
            }
        } catch (e) { /* ignore */ }
    },

    async saveTelegramConfig() {
        const v = id => ((document.getElementById(id) || {}).value || '');
        const body = { token: v('hrv-tg-token'), chat_id: v('hrv-tg-chatid').trim() };
        const msg = document.getElementById('hrv-tg-msg');
        const r = await Auth.apiCall('/api/bots/harvester/telegram-config', {
            method: 'POST', body: JSON.stringify(body),
        });
        if (!r || !r.ok) { if (msg) msg.textContent = 'Error'; return; }
        const tok = document.getElementById('hrv-tg-token');
        if (tok) tok.value = '';                 // ne jamais garder le token en clair
        if (msg) msg.textContent = Lang.t('harvester.telegram_saved');
        this._loadTelegramConfig();
    },

    async clearTelegramConfig() {
        await Auth.apiCall('/api/bots/harvester/telegram-config/clear', { method: 'POST' });
        const tok = document.getElementById('hrv-tg-token');
        if (tok) tok.value = '';
        const msg = document.getElementById('hrv-tg-msg');
        if (msg) msg.textContent = '';
        this._loadTelegramConfig();
    },
```

- [ ] **Step 3 : Pré-remplir au rendu du formulaire**

Dans `_renderForm`, à la fin (juste après `this._loadUnblockerConfig();`), ajouter :

```javascript
        this._loadTelegramConfig();    // pré-remplit l'état (token masqué) Telegram
```

- [ ] **Step 4 : Vérifier le parse JS**

Run: `node -e "new Function(require('fs').readFileSync('frontend/js/harvester_module.js','utf8'))" && echo PARSE_OK`
Expected: `PARSE_OK`

- [ ] **Step 5 : Commit**

```bash
git add frontend/js/harvester_module.js
git commit -m "feat(harvester): panneau config Telegram (frontend)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

# FEATURE D — Vue live noVNC + résolution dans le dashboard

### Task D1 : Autorisation du bridge (`_ws_admin_from_token` + `_vnc_authorize`)

**Files:**
- Modify: `backend/bots/harvester_router.py`
- Test: `backend/bots/tests/test_harvester_vnc_bridge.py` (create)

- [ ] **Step 1 : Écrire les tests qui échouent**

Create `backend/bots/tests/test_harvester_vnc_bridge.py` :

```python
"""Tests de l'autorisation du bridge VNC (offline, sans WS ni x11vnc).
La décision d'auth est une fonction PURE (_vnc_authorize) -> testable directement."""
from backend.bots import harvester_router as hr


class FakeUser(object):
    def __init__(self, is_admin):
        self.is_admin = is_admin
        self.username = "tester"


_JOB = "0" * 32


def _admin_ok(token):
    return FakeUser(True) if token == "good" else None


def test_authorize_rejects_no_token(monkeypatch):
    monkeypatch.setattr(hr, "_job_awaiting", lambda job: {"url": "x"})
    ok, reason = hr._vnc_authorize("", _JOB, admin_fn=_admin_ok)
    assert ok is False and reason == "auth"


def test_authorize_rejects_non_admin(monkeypatch):
    monkeypatch.setattr(hr, "_job_awaiting", lambda job: {"url": "x"})
    ok, reason = hr._vnc_authorize("bad", _JOB, admin_fn=_admin_ok)
    assert ok is False and reason == "auth"


def test_authorize_rejects_bad_job_id(monkeypatch):
    monkeypatch.setattr(hr, "_job_awaiting", lambda job: {"url": "x"})
    ok, reason = hr._vnc_authorize("good", "../etc", admin_fn=_admin_ok)
    assert ok is False and reason == "job_id"


def test_authorize_rejects_when_not_awaiting(monkeypatch):
    monkeypatch.setattr(hr, "_job_awaiting", lambda job: None)
    monkeypatch.setitem(hr._harvester_jobs, _JOB, {"job_id": _JOB, "process": None})
    ok, reason = hr._vnc_authorize("good", _JOB, admin_fn=_admin_ok)
    assert ok is False and reason == "not_awaiting"


def test_authorize_ok_when_admin_and_awaiting(monkeypatch):
    monkeypatch.setattr(hr, "_job_awaiting", lambda job: {"url": "x"})
    monkeypatch.setitem(hr._harvester_jobs, _JOB, {"job_id": _JOB, "process": None})
    ok, reason = hr._vnc_authorize("good", _JOB, admin_fn=_admin_ok)
    assert ok is True and reason == "ok"
```

- [ ] **Step 2 : Lancer, voir échouer**

Run: `python -m pytest backend/bots/tests/test_harvester_vnc_bridge.py -q`
Expected: FAIL — `hr._vnc_authorize` n'existe pas.

- [ ] **Step 3 : Ajouter les helpers d'autorisation**

Dans `harvester_router.py`, ajouter l'import en tête (à côté des autres `from backend.auth...`) :

```python
from backend.auth.utils import decode_token
from backend.database import SessionLocal
```

Ajouter (après `_check_job_id`) :

```python
# --- D : bridge VNC (vue live du CAPTCHA) ---------------------------------

# Socket Unix d'x11vnc (-display :100). Aucun port TCP : accès gouverné par les
# perms du socket (user omenserver) + le JWT admin du bridge. Surchargeable env.
HARVESTER_VNC_SOCK = os.environ.get(
    "HARVESTER_VNC_SOCK", "/run/omen-harvester-vnc/vnc.sock")


def _ws_admin_from_token(token):
    """Décode le JWT (?token=) -> User admin, ou None. Réutilise le pattern WS du
    projet (game_server/websocket.py). Toute erreur -> None (refus sûr)."""
    try:
        payload = decode_token(token)
        if not payload:
            return None
        username = payload.get("sub")
        if not username:
            return None
        db = SessionLocal()
        try:
            user = db.query(User).filter(User.username == username).first()
        finally:
            db.close()
        if user and getattr(user, "is_admin", False):
            return user
        return None
    except Exception:  # noqa: BLE001 — refus sûr
        return None


def _vnc_authorize(token, job_id, admin_fn=_ws_admin_from_token):
    """Décision d'autorisation du bridge VNC (PURE -> testable sans WS).
    Retourne (ok: bool, reason). Exige : admin + job_id valide + job en attente
    de résolution manuelle (n'ouvre JAMAIS le bureau arbitrairement)."""
    if not token or not admin_fn(token):
        return False, "auth"
    if not _JOB_ID_RE.match(job_id or ""):
        return False, "job_id"
    job = _harvester_jobs.get(job_id) or _job_from_disk(str(_run_dir(job_id)), job_id)
    if not job or not _job_awaiting(job):
        return False, "not_awaiting"
    return True, "ok"
```

- [ ] **Step 4 : Lancer, voir passer**

Run: `python -m pytest backend/bots/tests/test_harvester_vnc_bridge.py -q`
Expected: PASS.

- [ ] **Step 5 : Commit**

```bash
git add backend/bots/harvester_router.py backend/bots/tests/test_harvester_vnc_bridge.py
git commit -m "feat(harvester): autorisation du bridge VNC (admin + job awaiting)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task D2 : Bridge WebSocket `/vnc/{job_id}` + pump WS↔socket

**Files:**
- Modify: `backend/bots/harvester_router.py`
- Test: `backend/bots/tests/test_harvester_vnc_bridge.py`

- [ ] **Step 1 : Écrire le test de rejet (WS-level)**

Ajouter à `test_harvester_vnc_bridge.py` :

```python
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect


def _ws_client(monkeypatch, tmp_path, admin_token=None):
    monkeypatch.setattr(hr, "HARVESTER_RUNS_DIR", tmp_path)
    app = FastAPI()
    app.include_router(hr.router)
    return TestClient(app)


def test_ws_bridge_rejects_unauthorized(monkeypatch, tmp_path):
    monkeypatch.setattr(hr, "_ws_admin_from_token", lambda t: None)
    c = _ws_client(monkeypatch, tmp_path)
    with pytest.raises(WebSocketDisconnect):
        with c.websocket_connect(
            "/api/bots/harvester/vnc/{0}?token=bad".format(_JOB)) as ws:
            ws.receive_bytes()
```

- [ ] **Step 2 : Lancer, voir échouer**

Run: `python -m pytest backend/bots/tests/test_harvester_vnc_bridge.py -q -k ws_bridge`
Expected: FAIL — route `/vnc/{job_id}` absente (la connexion réussit ou 404).

- [ ] **Step 3 : Ajouter l'import asyncio + WebSocket/Query + le bridge**

Dans `harvester_router.py`, étendre l'import fastapi :

```python
from fastapi import APIRouter, Depends, Header, HTTPException, Query, WebSocket
```

et ajouter en tête :

```python
import asyncio
```

Ajouter (après `_vnc_authorize`) :

```python
async def _pump_ws_socket(websocket, reader, writer):
    """Pompe bidirectionnelle d'octets RFB entre le WebSocket noVNC et le socket
    Unix d'x11vnc. Verbatim (zéro transformation) — c'est ce que fait websockify."""
    async def ws_to_sock():
        try:
            while True:
                data = await websocket.receive_bytes()
                writer.write(data)
                await writer.drain()
        except Exception:  # noqa: BLE001 — fin de flux / déconnexion
            pass

    async def sock_to_ws():
        try:
            while True:
                chunk = await reader.read(65536)
                if not chunk:
                    break
                await websocket.send_bytes(chunk)
        except Exception:  # noqa: BLE001
            pass

    t1 = asyncio.ensure_future(ws_to_sock())
    t2 = asyncio.ensure_future(sock_to_ws())
    try:
        await asyncio.wait({t1, t2}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for t in (t1, t2):
            t.cancel()
        try:
            writer.close()
        except Exception:  # noqa: BLE001
            pass


@router.websocket("/vnc/{job_id}")
async def harvester_vnc(websocket: WebSocket, job_id: str,
                        token: str = Query(default="")):
    """Bridge admin-gated : pompe le RFB d'x11vnc (socket Unix) vers noVNC. Refuse
    (close 1008) si non-admin / job_id invalide / job pas en `awaiting_solve`."""
    ok, _reason = _vnc_authorize(token, job_id)
    if not ok:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    try:
        reader, writer = await asyncio.open_unix_connection(HARVESTER_VNC_SOCK)
    except OSError:
        await websocket.close(code=1011)   # x11vnc indisponible
        return
    try:
        await _pump_ws_socket(websocket, reader, writer)
    finally:
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass
```

- [ ] **Step 4 : Lancer, voir passer**

Run: `python -m pytest backend/bots/tests/test_harvester_vnc_bridge.py -q`
Expected: PASS.

- [ ] **Step 5 : Commit**

```bash
git add backend/bots/harvester_router.py backend/bots/tests/test_harvester_vnc_bridge.py
git commit -m "feat(harvester): bridge WS /vnc (pump RFB vers x11vnc socket Unix)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task D3 : Vendoriser noVNC

**Files:**
- Create: `frontend/js/vendor/novnc/` (core ESM + vendor deps)

- [ ] **Step 1 : Télécharger noVNC v1.5.0 et extraire `core/` + `vendor/`**

```bash
cd /tmp
curl -L -o novnc.tar.gz https://github.com/novnc/noVNC/archive/refs/tags/v1.5.0.tar.gz
tar xzf novnc.tar.gz
REPO="$(git -C "$OLDPWD" rev-parse --show-toplevel)"
mkdir -p "$REPO/frontend/js/vendor/novnc"
cp -R noVNC-1.5.0/core "$REPO/frontend/js/vendor/novnc/core"
cp -R noVNC-1.5.0/vendor "$REPO/frontend/js/vendor/novnc/vendor"
cp noVNC-1.5.0/LICENSE.txt "$REPO/frontend/js/vendor/novnc/LICENSE.txt"
```

- [ ] **Step 2 : Vérifier que le module RFB est présent et importable (syntaxe ESM)**

Run: `ls frontend/js/vendor/novnc/core/rfb.js && node --input-type=module -e "import('./frontend/js/vendor/novnc/core/rfb.js').then(()=>console.log('IMPORT_OK')).catch(e=>{console.log('non-node-env OK:', e.code||e.message)})"`
Expected: le fichier existe ; l'import peut échouer hors-navigateur (DOM absent) mais NE doit PAS échouer pour cause de syntaxe — un `ReferenceError: document is not defined` est acceptable (le module se charge), un `SyntaxError` ne l'est pas.

> Note : noVNC `core/rfb.js` importe en relatif (`./util/`, `../vendor/pako/`) → garder l'arbo `core/` + `vendor/` intacte. Servi par le mount `/js` → URL `/js/vendor/novnc/core/rfb.js`. CSP `script-src 'self'` l'autorise.

- [ ] **Step 3 : Commit**

```bash
git add frontend/js/vendor/novnc
git commit -m "chore(harvester): vendor noVNC v1.5.0 (core RFB ESM) pour la vue live

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task D4 : Frontend — embarquer noVNC dans le bandeau `#hrv-solve`

**Files:**
- Modify: `frontend/js/harvester_module.js`

- [ ] **Step 1 : Ajouter le bouton « Reprendre » au bandeau `#hrv-solve`**

Dans `_renderRunning`, remplacer le `<div id="hrv-solve-host" ...></div>` (ajouté en B4) par :

```javascript
            <div id="hrv-solve-host" style="margin-top:10px;border:1px solid var(--border);border-radius:var(--r-sm);overflow:hidden;background:#000;min-height:200px;"></div>
            <div style="margin-top:8px;">
              <button class="btn btn-sm btn-ghost" onclick="HarvesterModule.resumeSolve()">${Lang.t('harvester.solve_resume')}</button>
            </div>
```

- [ ] **Step 2 : Ajouter l'état RFB + connect/disconnect**

Dans l'objet `HarvesterModule`, ajouter le champ d'état en haut (après `_pollInterval: null,`) :

```javascript
    _rfb: null,
    _rfbJob: null,
```

Ajouter les méthodes (après `_poll`) :

```javascript
    async _connectVnc(jobId) {
        // déjà connecté à ce job -> rien
        if (this._rfb && this._rfbJob === jobId) return;
        this._disconnectVnc();
        const host = document.getElementById('hrv-solve-host');
        if (!host) return;
        host.innerHTML = '';
        const token = Auth.getToken();
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const url = proto + '://' + location.host + '/api/bots/harvester/vnc/' +
            encodeURIComponent(jobId) + '?token=' + encodeURIComponent(token || '');
        try {
            const mod = await import('/js/vendor/novnc/core/rfb.js');
            const RFB = mod.default;
            this._rfb = new RFB(host, url);
            this._rfb.viewOnly = false;          // tu cliques/résous le CAPTCHA
            this._rfb.scaleViewport = true;
            this._rfbJob = jobId;
        } catch (e) {
            host.textContent = Lang.t('harvester.solve_connecting');
        }
    },

    _disconnectVnc() {
        if (this._rfb) {
            try { this._rfb.disconnect(); } catch (e) { /* ignore */ }
            this._rfb = null;
        }
        this._rfbJob = null;
    },

    resumeSolve() {
        // force un re-poll immédiat (UX de secours ; la résolution est auto-détectée)
        this._poll();
    },
```

- [ ] **Step 3 : Brancher connect/disconnect dans `_poll`**

Dans `_poll`, remplacer le bloc `#hrv-solve` (ajouté en B4) par :

```javascript
            const solveEl = document.getElementById('hrv-solve');
            if (solveEl) {
                if (data.awaiting_solve && data.status === 'running') {
                    solveEl.style.display = '';
                    this._connectVnc(this._jobId);     // embarque la vue live noVNC
                } else {
                    solveEl.style.display = 'none';
                    this._disconnectVnc();             // résolu/terminé -> coupe le RFB
                }
            }
```

- [ ] **Step 4 : Couper le RFB dans `unload()` et à l'arrêt**

Dans `unload()`, ajouter avant la fin :

```javascript
        this._disconnectVnc();
```

Dans `stop()`, après le `clearInterval`, ajouter :

```javascript
        this._disconnectVnc();
```

- [ ] **Step 5 : Vérifier le parse JS**

Run: `node -e "new Function(require('fs').readFileSync('frontend/js/harvester_module.js','utf8'))" && echo PARSE_OK`
Expected: `PARSE_OK`

> Note : `await import(...)` est valide dans une méthode `async`. Le `new Function(...)` valide la syntaxe globale ; l'import dynamique n'est pas exécuté ici.

- [ ] **Step 6 : Commit**

```bash
git add frontend/js/harvester_module.js
git commit -m "feat(harvester): vue live noVNC dans le bandeau de résolution (frontend)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task D5 : Unit systemd x11vnc + doc d'install

**Files:**
- Create: `tools/omen-harvester-vnc.service`
- Create: `tools/HARVESTER_VNC_INSTALL.md`

- [ ] **Step 1 : Créer l'unit systemd**

Create `tools/omen-harvester-vnc.service` :

```ini
[Unit]
Description=OmenServer Harvester VNC bridge (x11vnc on :100, Unix socket)
After=omenserver.service
Wants=omenserver.service

[Service]
# IMPORTANT : MÊME user/group que le service omenserver (sinon le bridge uvicorn
# ne peut pas ouvrir le socket). Adapter <OMEN_USER> au user réel (ex. massii08).
User=<OMEN_USER>
Group=<OMEN_USER>
Environment=DISPLAY=:100
# crée /run/omen-harvester-vnc/ au bon user (nettoyé au reboot, /run = tmpfs)
RuntimeDirectory=omen-harvester-vnc
RuntimeDirectoryMode=0700
# socket périmé après un crash -> on le retire avant de relancer
ExecStartPre=/bin/rm -f /run/omen-harvester-vnc/vnc.sock
ExecStart=/usr/bin/x11vnc -display :100 -forever -shared -nopw \
  -unixsock /run/omen-harvester-vnc/vnc.sock
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2 : Créer la doc d'install**

Create `tools/HARVESTER_VNC_INSTALL.md` :

```markdown
# Install vue live CAPTCHA (x11vnc) — one-shot sur l'Omen

Prérequis : Xvfb `:100` déjà actif (le harvester stealth tourne dessus). Le service
omenserver hérite déjà de `DISPLAY=:100`.

1. Installer x11vnc :
   ```bash
   sudo apt-get update && sudo apt-get install -y x11vnc
   ```

2. Adapter l'unit : remplacer `<OMEN_USER>` par le user du service omenserver
   (vérifier avec `systemctl show -p User omenserver.service`), puis :
   ```bash
   sudo cp ~/Projet\ serveur/tools/omen-harvester-vnc.service \
           /etc/systemd/system/omen-harvester-vnc.service
   sudo sed -i 's/<OMEN_USER>/<le_user_reel>/g' \
           /etc/systemd/system/omen-harvester-vnc.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now omen-harvester-vnc.service
   ```

3. Vérifier :
   ```bash
   systemctl status omen-harvester-vnc.service
   ls -l /run/omen-harvester-vnc/vnc.sock     # doit exister, owner = OMEN_USER
   ```

Sécurité : aucun port TCP ouvert (socket Unix only). Accès gouverné par les perms
du socket (user omenserver) + le JWT admin du bridge `/api/bots/harvester/vnc/`.
Le bridge refuse toute connexion hors d'un job en `awaiting_solve`.

Override possible du chemin via `HARVESTER_VNC_SOCK` (env du service omenserver).
```

- [ ] **Step 3 : Commit**

```bash
git add tools/omen-harvester-vnc.service tools/HARVESTER_VNC_INSTALL.md
git commit -m "chore(harvester): unit systemd x11vnc (socket Unix) + doc d'install

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

# FINITIONS

### Task E1 : i18n FR/EN/IT + cache-bust

**Files:**
- Modify: `frontend/js/lang.js`, `frontend/index.html`, `frontend/sw.js`

- [ ] **Step 1 : Ajouter les clés FR**

Dans `lang.js`, dans le bloc FR (repère `'harvester.reco_unblocker':` vers la ligne 424), ajouter après cette ligne :

```javascript
            'harvester.manual_solve': 'Attendre ma résolution manuelle si un CAPTCHA bloque',
            'harvester.manual_solve_hint': 'Furtif seulement. Si un puzzle persiste, la moisson se met en pause, t\'envoie une notif Telegram, et tu résous le CAPTCHA en direct ici. Sans réponse sous 30 min → repli sur le débloqueur. Opt-in.',
            'harvester.awaiting_title': 'CAPTCHA à résoudre',
            'harvester.awaiting_hint': 'La moisson est en pause. Résous le CAPTCHA ci-dessous — elle reprend automatiquement.',
            'harvester.solve_resume': 'Reprendre maintenant',
            'harvester.solve_connecting': 'Connexion à la vue live…',
            'harvester.telegram_settings': 'Réglages Telegram (notif CAPTCHA)',
            'harvester.telegram_token': 'Token du bot Telegram',
            'harvester.telegram_token_ph': 'ex: 123456:ABC… (vide = garder l\'actuel)',
            'harvester.telegram_chatid': 'Chat ID',
            'harvester.telegram_save': 'Enregistrer',
            'harvester.telegram_clear': 'Oublier',
            'harvester.telegram_saved': 'Enregistré',
            'harvester.telegram_configured': 'Configuré',
            'harvester.telegram_notconfigured': 'Non configuré',
```

- [ ] **Step 2 : Ajouter les clés EN**

Dans le bloc EN (repère `'harvester.reco_unblocker':` vers la ligne 1670), ajouter après :

```javascript
            'harvester.manual_solve': 'Wait for my manual solve if a CAPTCHA blocks',
            'harvester.manual_solve_hint': 'Stealth only. If a puzzle persists, the harvest pauses, sends you a Telegram alert, and you solve the CAPTCHA live here. No answer within 30 min → fall back to the unblocker. Opt-in.',
            'harvester.awaiting_title': 'CAPTCHA to solve',
            'harvester.awaiting_hint': 'The harvest is paused. Solve the CAPTCHA below — it resumes automatically.',
            'harvester.solve_resume': 'Resume now',
            'harvester.solve_connecting': 'Connecting to live view…',
            'harvester.telegram_settings': 'Telegram settings (CAPTCHA alert)',
            'harvester.telegram_token': 'Telegram bot token',
            'harvester.telegram_token_ph': 'e.g. 123456:ABC… (blank = keep current)',
            'harvester.telegram_chatid': 'Chat ID',
            'harvester.telegram_save': 'Save',
            'harvester.telegram_clear': 'Forget',
            'harvester.telegram_saved': 'Saved',
            'harvester.telegram_configured': 'Configured',
            'harvester.telegram_notconfigured': 'Not configured',
```

- [ ] **Step 3 : Ajouter les clés IT**

Repérer le bloc IT du harvester : `grep -n "harvester.reco_unblocker" frontend/js/lang.js` (3ᵉ occurrence). Ajouter après cette ligne :

```javascript
            'harvester.manual_solve': 'Attendi la mia risoluzione manuale se un CAPTCHA blocca',
            'harvester.manual_solve_hint': 'Solo furtivo. Se un puzzle persiste, la raccolta si mette in pausa, ti invia una notifica Telegram e risolvi il CAPTCHA dal vivo qui. Senza risposta entro 30 min → ripiego sullo sblocco. Opt-in.',
            'harvester.awaiting_title': 'CAPTCHA da risolvere',
            'harvester.awaiting_hint': 'La raccolta è in pausa. Risolvi il CAPTCHA qui sotto — riprende automaticamente.',
            'harvester.solve_resume': 'Riprendi ora',
            'harvester.solve_connecting': 'Connessione alla vista live…',
            'harvester.telegram_settings': 'Impostazioni Telegram (avviso CAPTCHA)',
            'harvester.telegram_token': 'Token del bot Telegram',
            'harvester.telegram_token_ph': 'es. 123456:ABC… (vuoto = mantieni attuale)',
            'harvester.telegram_chatid': 'Chat ID',
            'harvester.telegram_save': 'Salva',
            'harvester.telegram_clear': 'Dimentica',
            'harvester.telegram_saved': 'Salvato',
            'harvester.telegram_configured': 'Configurato',
            'harvester.telegram_notconfigured': 'Non configurato',
```

- [ ] **Step 4 : Cache-bust**

Dans `frontend/index.html` :
- `lang.js?v=236` → `lang.js?v=237`
- `harvester_module.js?v=9` → `harvester_module.js?v=10`

Dans `frontend/sw.js` :
- `const CACHE_NAME = 'omenserver-v121';` → `const CACHE_NAME = 'omenserver-v122';`

- [ ] **Step 5 : Vérifier que les 3 langues ont le même nombre de clés ajoutées**

Run: `grep -c "harvester.manual_solve'" frontend/js/lang.js`
Expected: `3` (FR/EN/IT).
Run: `node -e "new Function(require('fs').readFileSync('frontend/js/lang.js','utf8'))" && echo PARSE_OK`
Expected: `PARSE_OK`

- [ ] **Step 6 : Commit**

```bash
git add frontend/js/lang.js frontend/index.html frontend/sw.js
git commit -m "i18n(harvester): clés manual_solve/awaiting/telegram FR/EN/IT + cache-bust

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task F1 : Suite complète + revue adversariale + vérif live

- [ ] **Step 1 : Suite backend complète (doit rester verte)**

Run: `source venv/bin/activate && python -m pytest backend/ -q`
Expected: PASS, 0 failed (~748 + nouveaux tests).

- [ ] **Step 2 : Revue adversariale multi-agent sur le diff**

Lancer une revue (sous-agents) sur `git diff origin/main...HEAD`, axes :
- **Garde-fou anti-solveur** : confirmer qu'AUCUN code ne résout un puzzle (pas d'OCR/vision/solving) ; l'auto-click ne fait qu'un clic de bbox.
- **Fuite de secret** : token Telegram jamais en clair dans une réponse API / un event run.log / un message d'erreur.
- **Bridge VNC** : impossible d'ouvrir le bureau sans (admin + job awaiting) ; pas de path-traversal sur job_id ; socket Unix only.
- **Rétro-compat** : `manual_solve` OFF = comportement legacy strict ; les tiers httpx/unblocker inchangés.
Corriger tout finding confirmé (test d'abord), re-run la suite.

- [ ] **Step 3 : Déploiement infra (Massii, manuel)**

Rappeler à Massii d'installer x11vnc sur l'Omen via `tools/HARVESTER_VNC_INSTALL.md` (apt + systemd, one-shot) AVANT la vérif live de la D.

- [ ] **Step 4 : Vérif live (piloter Chrome moi-même — ne jamais demander à Massii de tester)**

Sur `omenserver.org`, module Bots → AI Harvester :
1. Configurer Telegram (token+chat_id) dans le panneau → vérifier le statut masqué.
2. Lancer un harvest stealth sur `https://challenge-endpoint.lusostreams.com/interactive-challenge` avec **Stealth + manual_solve** cochés.
3. Observer : auto-click tenté ; si puzzle → bandeau `#hrv-solve` apparaît (`awaiting_solve`), notif Telegram reçue, canvas noVNC affiche le vrai Chrome.
4. Résoudre le CAPTCHA dans le canvas → vérifier la reprise auto (bandeau disparaît, records augmentent).
5. Capturer une preuve (screenshot du flux). Vérifier la console (0 erreur), le réseau (WS `/vnc/` 101).

- [ ] **Step 5 : Mettre à jour CLAUDE.md + vault (historique + nouveau pièges éventuels)**

Ajouter une entrée d'historique dans `CLAUDE.md` et un nouveau piège si la vérif live en révèle un (ex. formats Turnstile, comportement noVNC sous tunnel CF).

---

## Self-Review (rempli)

**1. Spec coverage :**
- §4 Feature A (auto-click) → Task A1 ✓
- §4 Feature B (détection/pause/poll/timeout + events + status) → B1 (fetcher), B2 (build), B3 (router/status), B4 (UI checkbox+banner) ✓
- §4 Feature C (telegram config + notif + wiring) → C1, C2, C3, C4, C5 ✓
- §4 Feature D (x11vnc unit, bridge, noVNC, panel) → D1 (auth), D2 (bridge), D3 (vendor), D4 (panel), D5 (systemd) ✓
- §5 contrats (events, awaiting_solve, bridge, telegram-config, plan) → couverts par B1/B3/C3/D2 ✓
- §6 i18n/cache-bust/déploiement → E1 + F1 ✓
- §6 revue adversariale + vérif live → F1 ✓
- §7 défauts (manual_solve OFF, timeout 1800, clamp [30,3600]) → B2 (`is True`, `_as_int 30..3600`) ✓

**2. Placeholder scan :** aucun TBD/TODO/"similar to" ; tout le code est inline et complet.

**3. Type/nom consistency :** `manual_solve`/`manual_solve_timeout`/`solve_poll_s`/`_await_manual_solve`/`_emit_event`/`_do_notify`/`_should_stop`/`_clock` (B1) cohérents avec B2 (`_build_fetcher` kwargs) et le test ; `awaiting_solve`/`_solve_from_log`/`_job_awaiting` cohérents B3↔frontend (`data.awaiting_solve`) ; `_vnc_authorize`/`_ws_admin_from_token`/`HARVESTER_VNC_SOCK`/`_pump_ws_socket` cohérents D1↔D2↔frontend (`/api/bots/harvester/vnc/`) ; clés i18n `harvester.manual_solve`/`awaiting_title`/`awaiting_hint`/`solve_resume`/`solve_connecting`/`telegram_*` cohérentes E1↔B4↔C5↔D4.
