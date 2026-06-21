# AI Harvester — CAPTCHA interactif : human-in-the-loop (tier stealth)

> Spec — 2026-06-21. Branche `feat/harvester-manual-captcha` (off `origin/main` `0d3f8e7`).

## 1. Problème & objectif

Le tier **stealth** du harvester (patchright + vrai Chrome headful sous Xvfb `:100`, profil
persistant, `cf_clearance` chaud) passe déjà le **JS Challenge** et le **Turnstile
non-interactif** (prouvé live sur `challenge-endpoint.lusostreams.com`). Restent les **rares
CAPTCHA interactifs** (case à cocher animée, voire vrai puzzle grille/slider) que stealth ne
franchit pas seul.

Objectif : les gérer **sans solveur automatique** et **sans payer** — **c'est Massii qui
résout, le bot attend**. Deux morceaux, tous deux **dans le tier stealth** :

1. **Auto-click de la case** (générique). Localiser le widget `cf-turnstile` / l'iframe
   challenge et cliquer au centre. Ça ne contourne rien : ça ne valide que parce que le
   navigateur est vrai.
2. **Résolution humaine**, déclenchée **uniquement si un puzzle persiste** : au lieu de lever
   `PushbackError`, le fetcher **met la page en pause**, émet un event `awaiting_manual_solve`,
   **notifie par Telegram**, et **poll** jusqu'à ce que Massii résolve le CAPTCHA **dans le
   dashboard** (vue live noVNC) ou jusqu'au **timeout** → fallback (`PushbackError` → reco
   unblocker, dernier recours).

### Garde-fous impératifs (non négociables)

- **AUCUN solveur automatique de CAPTCHA** : pas d'OCR, pas de modèle d'images, pas de
  résolution de puzzle, pas de service de solving. Le clic de **case** est générique et OK ;
  tout ce qui **résout un puzzle** à la place de Massii est hors-périmètre.
- **Payant (unblocker) = dernier recours**, après le human-in-the-loop (jamais avant le
  timeout).
- **Runtime déterministe, zéro IA dans la boucle.** (Le LLM ne sert qu'au `/setup`, inchangé.)
- Cible de test = `challenge-endpoint.lusostreams.com/interactive-challenge` (démo consentie).

## 2. Contexte technique (vérifié)

- Le subprocess harvester est **détaché** (`python -m backend.bots.harvester <run_dir>`,
  `start_new_session=True`) et **hérite de `DISPLAY=:100`** (le process `omenserver` a
  `DISPLAY=:100`). Il **possède l'objet page Chrome** ; uvicorn est un **autre process**.
- `StealthFetcher.get()` (`fetch_stealth.py`) : `rate.wait` → jitter → `_warm` → boucle
  `retries` { `goto` → `interact` → `_wait_resolved` → si body propre `return html` } → sinon
  `_dump_block` + `raise PushbackError`. `is_challenge(title)` / `is_challenge_html(body)`
  détectent le challenge. La `BrowserSession` est un **Protocol injectable** (`goto`/`title`/
  `content`/`interact`/`screenshot`) → tests offline ; la vraie = `PatchrightBrowserSession`
  (`channel="chrome"`, `headless=False`, `no_viewport=True`).
- L'engine (`engine.py`) émet des events via `on_event` → `_emit` (JSON line stdout) →
  thread `_capture` du router → `run.log` → `_recommend_from_log` (tail borné) → `/status` /
  `/active` → bandeau UI `#hrv-reco`. **C'est le squelette exact à réutiliser.**
- `_build_fetcher` (`__main__.py`) construit le fetcher selon `plan.fetch_tier`
  (`httpx`/`stealth`/`unblocker`), options de plan tolérantes (`_as_int`/`_as_float`).
- Secrets persistants posés depuis l'UI : modèle `unblocker_config.py` (json `data/`
  gitignoré, **création atomique 0o600** `os.open`+`os.fchmod`, `public_view` masque la clé,
  endpoints **admin-only**).

## 3. Décision d'architecture : vue live = **noVNC (Option A)**

Arbitrage tranché (A retenu) :

| | **A — noVNC sur Xvfb :100** | B — screenshot + relais de clics |
|---|---|---|
| Code subprocess | **minimal** (garde la page + poll, zéro mapping) | lourd (mapping image→viewport, file-queue) |
| Vrai puzzle (drag/grille) | **fidélité parfaite** (events X11 réels) | mauvais (laggé, re-trippe la détection) |
| Généricité | tout type, zéro code par-type | fragile, par-type |
| Infra | `x11vnc` + unit systemd + noVNC JS vendored | aucune |

**Raison décisive** : B sait cliquer une case — déjà couvert par l'auto-click (feature 1). La
feature 2 n'existe que pour les **vrais puzzles**, là où B s'effondre. A = fidélité parfaite +
subprocess minimal, au prix d'un install x11vnc one-shot (Massii a déjà monté Xvfb lui-même).

Le **bridge** = un **endpoint WebSocket FastAPI admin-gated** qui est lui-même le pont
**WS ↔ socket Unix** vers `x11vnc` → **pas de websockify**. x11vnc en service systemd
always-on, écoutant sur un **socket Unix** (aucun port TCP, pas même loopback), **joignable
uniquement par le bridge authentifié** (perms du socket + JWT admin).

### Flux

```
[Navigateur Massii] ──omenserver.org (tunnel CF)──► [uvicorn / FastAPI]
   dashboard (harvester_module.js)                        │ bridge WS admin-gated
   • poll /status → awaiting_solve ?                       ▼
   • si oui: panneau noVNC (canvas) ──wss /vnc/{job}?token──► [WS↔socket pump] ──► x11vnc (socket Unix)
                                                                                      │ mirroir
                                                                          [Xvfb :100] ◄── Chrome headful
                                                                                      ▲ (subprocess détaché)
[subprocess] ── run.log events ──► _capture ──► /status (awaiting_solve)
   StealthFetcher.get(): warm → goto → interact → AUTO-CLICK → wait →
     si puzzle persiste & manual_solve ON: emit awaiting → Telegram → poll → resolved|timeout
```

Le subprocess **garde la page ouverte** et **ne fait que poller en lecture seule**
(`title()`/`content()` = appels CDP read-only) pendant que Massii agit — il ne navigue ni
n'interagit, donc **ne se bat pas** avec les clics humains. Les clics de Massii passent par
X11 → Chrome `:100` → **events indiscernables d'un humain au clavier** (pas de mapping de
coordonnées côté code).

## 4. Découpage (TDD, A→B→C→D, chaque tranche verte indépendamment)

### Feature A — auto-click de la case (générique)

- Nouvelle méthode best-effort `click_turnstile()` sur le Protocol `BrowserSession` et sur
  `PatchrightBrowserSession` : localise `.cf-turnstile` (sinon l'iframe
  `src*='challenges.cloudflare.com'`), prend la **bounding box**, `page.mouse.click(centre)`.
  **Ne touche jamais** au contenu interne de l'iframe (pas de sélecteur obfusqué). Swallow
  toute exception (comme `interact()`). Retourne `True` si un widget a été trouvé+cliqué,
  `False` sinon (utile aux tests / au flux B).
- `StealthFetcher.get()` : si après `goto`+`interact` le challenge persiste, **tenter
  `click_turnstile()` puis re-`_wait_resolved`** avant de conclure l'échec d'une tentative.
  Toujours actif en stealth (inoffensif).
- **Tests offline** : fake session qui enregistre l'appel + scriptée
  (challenge→clean-après-click) → on vérifie que l'autoclick est tenté quand le titre reste un
  challenge, et **pas** quand la page est déjà propre.

### Feature B — détection puzzle + `awaiting_manual_solve` + pause/poll/timeout

- **Opt-in** : `plan.manual_solve: true` (case UI « Attendre ma résolution manuelle si un
  CAPTCHA bloque », visible quand Stealth coché). **Défaut OFF** (sinon un run nocturne non
  surveillé se bloquerait `timeout` sur chaque puzzle). `plan.manual_solve_timeout` (défaut
  **1800 s**, borné `_as_int` `[30, 3600]`). Poll interne ~3 s (borné).
- `StealthFetcher` gagne (tous injectables, défauts rétro-compatibles) :
  `on_event: Callable|None`, `notify: Callable[[str], None]|None`, `manual_solve: bool=False`,
  `manual_solve_timeout: int=1800`, `solve_poll_s: float=3.0`, `should_stop: Callable[[],bool]`
  (défaut : lit `run_dir/stop.flag` si `run_dir`, sinon `lambda: False`).
- Quand **retries + autoclick échouent** ET `manual_solve` ON, au lieu de `PushbackError` :
  1. `_emit_event({"type":"awaiting_manual_solve","url":url,"since":<clock>,"timeout_s":N})` ;
  2. `notify(message)` (best-effort) ;
  3. **boucle de poll** (lecture seule `is_challenge`/`is_challenge_html`) jusqu'à :
     - **résolu** (titre **et** body propres) → `_emit_event(manual_solve_resolved)` ; si le
       body porte encore des marqueurs, **re-`goto(url)` une fois** puis re-check ; retourne
       le HTML → **la moisson reprend** ;
     - **timeout** (`clock` injecté) → `_emit_event(manual_solve_timeout)` → `PushbackError`
       (→ engine `consec_pushbacks` → reco unblocker, inchangé) ;
     - **`should_stop()`** (Massii a cliqué Stop) → `PushbackError` immédiat (arrêt propre).
- **La moisson se met en pause sur cette URL** pendant l'attente (modèle single-thread
  déterministe conservé : un host qui te challenge une URL te les challenge toutes →
  paralléliser n'aiderait pas).
- **Câblage events** : `_build_fetcher` passe `on_event=_emit` et `should_stop`/`notify` au
  `StealthFetcher`. Le fetcher écrit donc des JSON lines sur stdout exactement comme l'engine
  → captées par le thread `_capture`.
- **Router** :
  - `_capture` parse les 3 events → pose/efface `job["awaiting_solve"]` (l'event awaiting
    posé ; effacé sur resolved/timeout).
  - `_solve_from_log(run_dir, max_bytes)` (**miroir exact** de `_recommend_from_log`, lecture
    tail bornée) : reconstruit l'état courant — renvoie l'event awaiting **seulement si** le
    dernier event solve du tail est `awaiting_manual_solve` (sinon `None`). Restart-résilient.
  - `_job_awaiting(job)` (miroir `_job_recommend`) : mémoire sinon relecture tail, caché sur
    le job tant qu'awaiting (recalcul quand le statut change).
  - `/status/{job_id}` et `/active` renvoient `awaiting_solve` (objet `{url, since,
    timeout_s}` ou `None`). **L'event ne porte jamais de secret.**
- **Tests offline** : fake session scriptée pour rester en challenge ; `clock`/`sleep`/
  `should_stop`/`notify`/`on_event` injectés. On asserte : ordre des events (awaiting →
  resolved | timeout), retour HTML à la résolution, `PushbackError` au timeout, abort sur
  `should_stop`, `notify` appelé une fois. + `_solve_from_log` sur tails forgés (awaiting seul
  ; awaiting→resolved → `None` ; awaiting→timeout → `None`).

### Feature C — config Telegram persistante + notif

- `backend/bots/harvester/telegram_config.py` — **copie conforme** d'`unblocker_config.py` :
  `data/harvester_telegram.json` (**gitignoré** via `data/`), création **atomique 0o600**
  (`os.open`+`os.fchmod`), `clear()` idempotent. `public_view(cfg)` : `token_masked`
  (`····last4`), `chat_id` en clair, `configured = bool(token and chat_id)`. **Le token brut
  ne sort jamais de l'API.**
- `backend/bots/harvester/notify.py` — `send(text, cfg, client=None) -> bool` : POST
  `https://api.telegram.org/bot<token>/sendMessage` (`chat_id`, `text`), `client` httpx
  injectable (test offline via `MockTransport`), **best-effort** : ne lève jamais, réduit
  toute exception à `type(e).__name__` (zéro fuite de token/URL), retourne `True/False`.
  **Aucune nouvelle dépendance** (httpx déjà présent, pas de lib telegram).
- Message : `🔒 CAPTCHA à résoudre sur <url> — ouvre le bot Harvester sur omenserver.org`.
  Zéro secret.
- Endpoints **admin-only** : `GET /telegram-config` (vue masquée), `POST /telegram-config`
  (token vide ⇒ garde l'existant ; chat_id requis si token posé), `POST /telegram-config/clear`.
- **Câblage** : `_build_fetcher` construit le `notify` à partir de la config Telegram
  persistante → passé au `StealthFetcher` (feature B). Si Telegram non configuré → `notify`
  no-op (l'awaiting + la vue live marchent quand même ; Telegram n'est que la notif).
- **Tests** : load/save/clear/public_view (miroir tests unblocker) + notifier
  (`MockTransport` : forme du POST, swallow sur erreur, pas de fuite token).

### Feature D — vue live + résolution dans le dashboard (le gros)

- **Infra (Massii, one-shot sur l'Omen, comme Xvfb)** — fournis dans `tools/` + doc :
  - `apt install x11vnc` ;
  - unit systemd `tools/omen-harvester-vnc.service`, tournant sous le **même user que
    `omenserver`** (`User=`/`Group=`), avec `RuntimeDirectory=omen-harvester-vnc` (crée
    `/run/omen-harvester-vnc/` au bon user, nettoyé au reboot) :
    - `ExecStartPre=/bin/rm -f /run/omen-harvester-vnc/vnc.sock` (socket périmé après crash)
    - `ExecStart=/usr/bin/x11vnc -display :100 -forever -shared -unixsock /run/omen-harvester-vnc/vnc.sock`
    → **aucun port TCP** (pas même loopback), `-forever` survit aux déconnexions, `-shared`
    multi-viewer. Accès gouverné par les **perms du socket** (user omenserver) + le JWT admin du
    bridge → **pas de mot de passe RFB à gérer**.
- **Bridge** : `@router.websocket("/api/bots/harvester/vnc/{job_id}")` :
  - auth **admin** via `?token=` (réutilise le pattern WS existant du projet : décode le JWT,
    charge l'user, exige `is_admin`) ; `_check_job_id` ;
  - **refuse (close 1008) si le job n'est pas `awaiting_solve`** → n'ouvre jamais le bureau
    arbitrairement ;
  - `reader, writer = await asyncio.open_unix_connection("/run/omen-harvester-vnc/vnc.sock")`
    (chemin configurable via env `HARVESTER_VNC_SOCK`) + 2 coroutines de pump
    (`ws.receive_bytes()` → `writer.write`; `reader.read(n)` → `ws.send_bytes`) ; ferme
    proprement des 2 côtés. C'est ce que fait websockify, en ~40 lignes authentifiées.
  - **Prérequis** : x11vnc et uvicorn tournent sous le **même user** (sinon socket
    inaccessible) → si users distincts, socket en groupe partagé `0o660`.
- **noVNC vendored** : `frontend/vendor/novnc/` (core RFB ESM + deps), chargé en `import()`
  dynamique quand `awaiting_solve` (CSP `script-src 'self'` OK). `new RFB(canvasEl, wsUrl)`
  avec `wsUrl = wss://<host>/api/bots/harvester/vnc/{job_id}?token=<jwt>`.
- **Panneau `#hrv-solve`** (calqué sur `#hrv-reco`) : visible quand `data.awaiting_solve`,
  affiche le canvas noVNC + l'URL + une ligne d'instruction. Massii clique/résout **dans** le
  dashboard ; résolution **auto-détectée** côté subprocess → event `resolved` → panneau
  disparaît → reprise. Bouton **« Reprendre maintenant »** (force un re-check ; UX de secours,
  pas requis). Déconnexion propre du RFB quand le panneau se cache.
- **Tests** : gate d'auth du bridge (admin requis ; job non-awaiting rejeté) ; `_solve_from_log`
  (déjà en B). Le **pump d'octets** et le **rendu noVNC** = **vérif live** (Chrome piloté
  moi-même), pas unit-testables proprement (I/O glue).

## 5. Contrats d'interface (résumé)

- **Events run.log** (jamais de secret) :
  - `{"type":"awaiting_manual_solve","url":str,"since":float,"timeout_s":int}`
  - `{"type":"manual_solve_resolved","url":str}`
  - `{"type":"manual_solve_timeout","url":str}`
- **`/status/{job_id}` & `/active`** : champ additionnel `"awaiting_solve": {url,since,timeout_s}|null`.
- **Bridge** : `GET (WS) /api/bots/harvester/vnc/{job_id}?token=<jwt>` — admin + job awaiting.
- **Telegram config** : `GET/POST /api/bots/harvester/telegram-config`,
  `POST /api/bots/harvester/telegram-config/clear` — admin-only, token masqué.
- **Plan (par-run)** : `manual_solve: bool`, `manual_solve_timeout: int` (`[30,3600]`).

## 6. i18n / cache-bust / déploiement

- **i18n FR/EN/IT** sous `harvester.*` : `manual_solve` (label+hint), `awaiting` (bandeau),
  `solve_panel` (instruction + bouton reprendre), `telegram_*` (panneau config : token,
  chat_id, save/clear/configured/masked), `notif`.
- **Cache-bust** : bump `?v=` de `lang.js` + `harvester_module.js` dans `index.html` et
  `CACHE_NAME` dans `sw.js`, **au-dessus des valeurs actuelles d'origin/main** (relire à
  l'implémentation). Le dossier `frontend/vendor/novnc/` est statique (référencé par le module,
  pas besoin de `?v=` propre).
- **Worktree** `feat/harvester-manual-captcha` (off `origin/main`). **Aucun push sur main sans
  feu vert de Massii.** L'install x11vnc/systemd = étape **infra manuelle** (unit + commande
  fournis) ; Python/JS arrivent par **auto-deploy**. Note : `frontend/vendor/novnc/` doit être
  **committé** (pas de build step ; arrive par auto-deploy).
- **`python -m pytest backend/ -q` reste 100% vert** (~748 → +N).
- **Revue adversariale multi-agent** sur le diff avant deploy, dont un axe explicite
  « respect du garde-fou anti-auto-solveur ».
- **Vérif live** : piloter Chrome moi-même sur
  `challenge-endpoint.lusostreams.com/interactive-challenge`, déclencher tout le flux
  (awaiting → noVNC → résolution → reprise) ; ne jamais demander à Massii de tester.

## 7. Décisions de défaut (validées)

- `manual_solve` **OFF par défaut** (anti-stall nocturne non surveillé).
- `manual_solve_timeout` = **1800 s** (borné `[30, 3600]`).
- **Concurrence** : on assume **≈1 awaiting à la fois** (rare). Xvfb `:100` est partagé → la
  vue montre le bureau `:100` entier (en pratique le seul Chrome harvester). Si 2 runs stealth
  awaitent en même temps, la vue les montre tous les deux ; acceptable v1 (documenté).
- x11vnc **always-on** sur **socket Unix** (aucun port réseau ; cohérent avec la philosophie
  systemd OmenServer : cloudflared/omenserver/agent), pas on-demand.

## 8. Hors-périmètre (explicite)

- Solveur automatique de CAPTCHA (OCR / vision / puzzle / service de solving) — **interdit**.
- Solver Turnstile / résidentiel proxy — non.
- Tier unblocker (payant) : **inchangé**, reste le dernier recours après timeout.
- Migration de l'auth WS `?token=` → auth-par-1er-message : hors-périmètre (le bridge réutilise
  le pattern existant ; noté comme follow-up global, cf. `[[project_security_audit]]`).
