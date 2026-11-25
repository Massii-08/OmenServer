# CLAUDE.md — OmenServer Project Context

> **Ce fichier sert de mémoire persistante pour tout agent IA (Claude, Gemini, etc.)**
> **travaillant sur ce projet. Lire intégralement avant toute modification.**

---

## 🏗️ Vue d'ensemble

**OmenServer** est un panel de gestion de serveur dédié polyvalent, inspiré de Minestrator/Pterodactyl.
Il permet de gérer des serveurs de jeux (Minecraft, etc.), des bots Python, des médias, un serveur web,
et le monitoring système multi-machines depuis une interface web premium.

- **Version** : 4.3.0
- **Auteur** : Massii_08 (Massimiliano)
- **License** : MIT
- **Hardware** : HP Omen (Ubuntu Server 26.04 en prod, cerveau) + agents sur d'autres PC (bras)
- **Stack** : Python FastAPI (backend) + Vanilla JS/CSS (frontend) — **pas de framework JS**
- **Accès** : https://omenserver.org (Cloudflare Tunnel)

---

## 📚 Contexte par module (chargé à la demande)

Le contenu propre à un module vit dans `docs/context/*.md`. Il est chargé automatiquement via le `CLAUDE.md` relais du dossier de code (une ligne `@…`) dès qu'on lit un fichier de ce dossier ; sinon, le lire à la main avant de toucher au module. Les pièges gardent leur numéro historique ; un `#N` cité ailleurs se retrouve via ce tableau.

| Fichier | Quand le lire | Pièges |
|---|---|---|
| `docs/context/mc-agent.md` | MC Agent (`mc-agent/`, `backend/bots/mc_agent_*`), mod de capture (`mc-capture-mod/`, `mc_capture_*`), runs MC | #35-45, #42b, #47-63, #52b, #66, #72, #73 |
| `docs/context/trading-coach.md` | Extension Chrome coach TradingView, simulateur Paper Trading (`backend/bots/paper/`) | #69b, #74, #75 |
| `docs/context/stockscan.md` | Scanner d'actions (`backend/bots/stockscan/`) | #71 |
| `docs/context/market-pulse.md` | Market Pulse (`market-pulse/`, `backend/bots/market_*`) | #67, #68 |
| `docs/context/bonds-yield.md` | Bond Scanner, Yield Bot, notations Fitch | #4, #29-33, #70 |
| `docs/context/harvester.md` | AI Harvester (`backend/bots/harvester/`) | #46 |
| `docs/context/llm-gateway.md` | Passerelle LLM (`backend/llm_gateway.py`, pas de relais : à lire à la main) | #69 |
| `docs/context/sysdoc.md` | Module Diagnostic (`backend/sysdoc/`, `tools/diagnostic_agent/`) | #20-27 |
| `docs/context/design-system.md` | Toute retouche CSS/UI (`frontend/`) — Ion v6, mode Givre, composants Bento | — |
| `docs/context/historique.md` | Historique détaillé des changements (pas de relais) | — |

---

## 📁 Structure du projet

Arbre condensé (dossiers + points d'entrée ; vérifié le 2026-11-25).

```
Projet serveur/
├── backend/                  # API FastAPI
│   ├── main.py               # point d'entrée — monte tous les routers + /css /js /fonts
│   ├── config.py · database.py · rate_limiter.py · net_guard.py (anti-SSRF)
│   ├── llm_gateway.py        # passerelle LLM (API d'abord, CLI en repli)
│   ├── auth/                 # JWT, invitations, partage, RBAC (permissions.py, access_control.py)
│   ├── game_server/          # serveurs de jeux Docker (fichiers, joueurs, backups, SFTP…)
│   ├── mods/ · modules/ · monitoring/ · scheduler/ (power) · network/ · webserver/
│   ├── activity/ · notifications/ · agentchat/ · muscu/
│   ├── sysdoc/               # module Diagnostic (WS agent ↔ viewer)
│   ├── bots/                 # routers *_router.py de tous les bots
│   │   ├── paper/            # simulateur de trading + coach (paper_tv_router.py, paper_ws.py)
│   │   ├── stockscan/        # scanner d'actions (stockscan_router.py)
│   │   ├── harvester/        # AI Harvester (harvester_router.py)
│   │   ├── mc_agent_*.py · mc_capture_*.py   # pilotage MC Agent + captures
│   │   ├── market_*.py       # intégration Market Pulse
│   │   └── tests/
│   └── tests/
├── frontend/                 # SPA vanilla JS/CSS
│   ├── index.html · login.html · sw.js · manifest.json
│   ├── css/style.css         # design system Ion v6
│   ├── js/                   # app.js (router), auth.js, lang.js, anim.js, *_module.js, sv_*.js
│   └── fonts/
├── mc-agent/                 # bot Minecraft Node (index.js, skills/, bin/, tests *.test.js)
├── mc-capture-mod/           # mod Fabric de capture (Gradle, dist/ = jars committés)
├── market-pulse/             # Market Pulse (main.py, pulse/, tests/)
├── bond-scanner/             # Bond Scanner (main.py, scanner/, excel/…) — a son propre CLAUDE.md
├── yield-bot/                # Yield Bot (main.py, scraper/, calculator/…)
├── tools/
│   ├── tv-coach-extension/   # extension Chrome « coach TradingView » (MV3)
│   ├── diagnostic_agent/     # agent sysdoc à installer sur les PC
│   ├── omen_agent.py · setup_omen*.sh · omen-resume.sh · *.service
├── docs/                     # guides d'installation, superpowers/ (specs, plans), context/ (mémoire par module)
├── data/                     # données persistantes (non commité) — omenserver.db, power_schedule.json…
├── requirements.txt · watchdog.sh · CLAUDE.md · AGENTS.md · README.md
```

---

## ⚙️ Stack technique

### Backend
| Technologie | Usage |
|-------------|-------|
| **FastAPI** 0.115 | Framework API REST |
| **SQLAlchemy** 2.0 | ORM — SQLite en local |
| **bcrypt** | Hachage de mots de passe (direct, sans passlib) |
| **python-jose** | JWT pour l'authentification |
| **psutil** | Monitoring système (CPU, RAM, temp, multi-disques) |
| **docker** (Python SDK) | Gestion conteneurs Docker |
| **APScheduler** | Tâches planifiées (cron-like) |
| **uvicorn** | Serveur ASGI |

### Frontend
| Technologie | Usage |
|-------------|-------|
| **Vanilla JS** | Pas de React/Vue — tout est en JS natif |
| **Vanilla CSS** | Design system complet avec variables CSS |
| **Geist** + **Geist Mono** | Typographie (depuis Ion v6, Inter retiré) |
| **Chart.js** | (via CDN) Graphiques monitoring |

### Infrastructure de Production
| Composant | Détail |
|-----------|--------|
| **OS prod** | Ubuntu Server (HP Omen) |
| **OS dev** | macOS |
| **RAM** | **15 Go** (relevé live 2026-06-01 : ~3.4 Go utilisés au repos, ~11 Go dispo) |
| **CPU** | **12 threads** (idle downclock 800 MHz, ~2-3 % au repos) |
| **Stockage** | HDD 914 Go (`/`) + SSD NVMe 469 Go (`/mnt/ssd`) = **1.3 To** |
| **Python** | 3.9+ (venv dans `./venv/`) |
| **DB** | SQLite (`data/omenserver.db`) |
| **Docker** | Conteneurs pour les serveurs de jeux |
| **Cloudflared** | Tunnel Cloudflare → `omenserver.org` (service systemd) |
| **Service** | `omenserver.service` (systemd, démarre au boot via `start-omen.sh`) |
| **Auto-deploy** | Cron toutes les minutes → `auto-deploy.sh` (git pull + restart) |
| **Agents** | `omen_agent.py` sur chaque PC du réseau |

---

## 🎨 Architecture frontend

### Pattern SPA
Le frontend est une **Single Page Application** sans framework :
- `app.js` gère le routing (`App.navigateTo('bots')`)
- Chaque module a son fichier JS (`bots_module.js`, `files_module.js`, etc.)
- Chaque module expose un objet global avec une méthode `render(container)` et optionnellement `unload()`
- Le contenu est injecté via `container.innerHTML`

### Chrome (depuis PR26)
- **Top bar horizontale** (pas de sidebar verticale) — composant `.topbar` sticky en haut
- `.brand` à gauche (logo carré accent vert "O" + texte mono "OMENSERVER")
- `.nav-tabs` au centre (8 tabs depuis PR37/PR38 : Dashboard / Serveurs / Bots / Fichiers / Média / Web / Réseau / Diagnostic) — `flex:1; min-width:0; overflow-x:auto` avec scrollbar custom 4px
- `.topbar-right` à droite : `.lang-switcher` (pill segmenté FR/EN/IT) + `.accent-switcher-mini` (4 dots couleurs) + `.user-menu-wrap` contenant `.user-pill` (avatar+nom+rôle+caret ▾, button cliquable `aria-haspopup="menu"`) qui ouvre le dropdown `.user-menu` (Utilisateurs admin-only / Paramètres / *sep* / Se déconnecter)
- Tab active visible via `::before` dot accent vert
- Badge `.tab-badge` sur nav-tab quand jobs background tournent (PR32 — `App._pollBgJobs`)

### Background jobs poller (PR32)
- `App._activeJobs = {}` + `App._bgJobsInterval` poll `/api/bots/yield|scanner/active` toutes les 5s
- Cross-page awareness : tu lances un job Yield → tu navigues sur Dashboard → le badge `[1]` reste visible sur le tab Bot
- Toast notif quand un job transition `running → completed`
- Backend continue toujours via `subprocess.Popen` détaché — c'était purement perceptuel avant PR32

### Design System (style.css) — v6 Ion (tokens v5 renommés) — voir docs/context/design-system.md
- **Voir `docs/context/design-system.md`** (chargé via `frontend/CLAUDE.md`) pour les tokens, composants Bento, règles d'usage et catalogue complet.
- **Variables CSS** dans `:root` (`--bg`, `--bg-elev-1/2/3`, `--text`, `--accent`, `--danger`, etc.)
- **Theming** : 1 mode dark + 4 accent variants via `data-accent="green|blue|red|yellow"` (default green dans `:root`)
- **Composants principaux** : `.bento-overview` + `.stat-card`, `.machine-card` (+ `.brain`/`.arm`), `.bot-card-bento`, `.role-pill`, `.badge`, `.diag-strip`, `.row-list`, `.machines-grid` (responsive)
- **Legacy survivants** : `.card`, `.btn`, `.btn-primary`, `.console`, `.module-card`, `.stat-machines-list` (dashboard multi-PC) — partiellement migrés via overrides PR7
- **Responsive** : breakpoints à 768px, 480px

### Internationalisation (lang.js)
- 3 langues : **FR**, **EN**, **IT**
- Accès via `Lang.t('clé.sous_clé')`
- Changement de langue via `Lang.setLang('en')` (persisté dans localStorage)
- Structure des clés : `common.*`, `nav.*`, `modules.*`, `bots.*`, `yield.*`, `servers.*`, `dashboard.*`

### Authentification (auth.js)
- Token JWT stocké dans `localStorage`
- `Auth.apiCall(url, options)` ajoute automatiquement le header `Authorization: Bearer <token>`
- Détection automatique `FormData` → pas de `Content-Type: application/json`
- Bannière auto-reconnexion si le serveur est down

---

## 🖥️ Architecture Multi-Machines

### Concept : Cerveau / Bras
- **L'Omen** = cerveau (serveur central, dashboard, API) — **toujours visible** dans la liste des machines
- **Les autres PC** = bras (agents légers qui envoient leurs stats)

### Dashboard unifié
- **Cartes du haut** : stats **combinées** (CPU moy. pondérée par cœurs, RAM sommée, Disque sommé, Temp max)
- **Section "Réseau de machines"** : grille de cartes avec :
  - 🧠 **Omen (cerveau)** toujours en premier, avec badge violet et bordure verte
  - 🦾 **Agents (bras)** ensuite, avec badge bleu et boutons reboot/shutdown/retirer
- Boutons **reboot/shutdown** sur la carte Omen (admin, double confirmation)

### Monitoring combiné
- `system_info.py → get_disk_info()` somme **tous les disques physiques** (HDD + SSD + partitions)
- `monitoring.js → updateUI()` fusionne les stats serveur + nodes connectés (CPU pondéré, RAM sommée, Temp max)
- Les cartes CPU/RAM/Temp affichent une **mini-liste par machine** quand des nodes sont connectés

### Gestion de l'alimentation (Power Management)
- `power_manager.py` : logique d'extinction/réveil programmé
- `power_router.py` : API REST pour la configuration
- **Cycle quotidien** :
  1. **01:00** → APScheduler déclenche `execute_scheduled_shutdown()`
  2. Arrêt gracieux : backup serveurs → stop Docker → stop bots
  3. `rtcwake -m no -l -t <timestamp>` → programme le timer BIOS
  4. `systemctl suspend` → suspend-to-RAM (S3)
  5. **06:00** → BIOS réveille le PC via RTC alarm
  6. `omen-resume.sh` → détecte le flag → **reboot complet** (RAM vidée)
  7. Après reboot : cloudflared + omenserver redémarrés
- Config stockée dans `data/power_schedule.json`
- Endpoints : `POST /api/power/reboot`, `POST /api/power/shutdown`
- Double confirmation pour l'extinction du cerveau
- **Anti-boucle** : fichier flag `/tmp/omen-post-suspend-reboot` empêche les reboots infinis

### Diagnostic multi-machines
- `diagnostic_router.py` vérifie CPU, RAM, Disque, Docker, Serveurs de jeux, Réseau **et Nodes**
- **Crash détecté** : si un PC agent passe offline depuis < 5 min → CRITICAL avec dernières stats
- **Offline longue durée** : > 5 min → WARNING avec suggestion Wake-on-LAN

### Agent (`tools/omen_agent.py`)
- Script Python léger à installer sur chaque PC
- Envoie un heartbeat toutes les 10s : CPU, RAM, Disque, Temp, Uptime
- Authentification via `X-Agent-Key` (clé API auto-générée)
- Peut recevoir des commandes : `reboot`, `shutdown`
- **Installation auto** : `setup_omen_agent.sh` installe tout (agent + suspend/wake + reboot post-wake)
- Guide d'installation : `docs/Guide_Installation_PC_OmenServer.md` (FR + IT)

---

## 🔌 Modules actifs

| Module | Backend Router | Frontend JS | Description |
|--------|---------------|-------------|-------------|
| **Serveurs de jeux** | `game_server/router.py` | `game_server.js` + `server_view.js` | Gestion Docker (Minecraft, etc.) |
| **Bots** | `bots/router.py` + `yield_router.py` | `bots_module.js` | Bots Python + Yield Bot |
| **Fichiers** | `gdrive/router.py` | `files_module.js` | Google Drive |
| **Média** | `media/router.py` | `media_module.js` | Jellyfin |
| **Web** | `webserver/router.py` | `web_module.js` | Sites web Docker |
| **Réseau** | `network/router.py` | `network_module.js` | WoL, ping, scan |
| **Diagnostic** ([[🩺 Diagnostic Bot]]) | `sysdoc/router.py` + `sysdoc/ws_router.py` | `sysdoc_module.js` | Agent sur PC distant via WS (RAM, processus groupés, trousse 3 tiers) |

---

## 🔒 Sécurité

- **JWT** avec expiration configurable (défaut 24h)
- **bcrypt** direct (sans passlib, avec troncature 72 bytes manuelle)
- **CORS** restreint aux origines locales
- **Headers sécurité** : X-Frame-Options DENY, X-Content-Type-Options nosniff, XSS-Protection, CSP
- **Swagger/Redoc** désactivés en production (`docs_url=None`)
- **Upload** : validation `.xlsx` uniquement pour le Yield Bot
- **Rôles** : admin, moderator, player, spectator (via `User.role`)
- **Invitations** : inscription uniquement par code d'invitation
- **Agents** : authentification via clé API (`X-Agent-Key`)
- **Rate limiter** : middleware IP-based (exemption agents + localhost)
- **RBAC** : `access_control.py` + `permissions.py` pour contrôle d'accès par serveur
- **Clés API masquées** : les clés sont masquées dans le dashboard (toggle show/hide)
- **Partage serveurs** : `sharing_router.py` pour partager l'accès à un serveur entre users

---

## 🗄️ Base de données

**SQLite** via SQLAlchemy ORM. Tables :

| Table | Modèle | Fichier |
|-------|--------|---------|
| `users` | `User` | `auth/models.py` |
| `invitations` | `Invitation` | `auth/models.py` |
| `game_servers` | `GameServer` | `game_server/models.py` |
| `scheduled_tasks` | `ScheduledTask` | `scheduler/models.py` |
| `bots` | `Bot` | `bots/models.py` |
| `websites` | `Website` | `webserver/models.py` |
| `wol_devices` | `WolDevice` | `network/models.py` |
| `network_logs` | `NetworkLog` | `network/models.py` |

Les migrations sont faites manuellement dans `main.py` startup (ALTER TABLE avec try/except).

---

## 🚀 Commandes utiles

```bash
# Développement (macOS)
cd "Projet serveur"
source venv/bin/activate
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000

# Production (Ubuntu Server — géré par systemd)
sudo systemctl status omenserver
sudo systemctl restart omenserver

# Logs du serveur
sudo journalctl -u omenserver -f

# Auto-deploy (cron, toutes les minutes)
cat ~/deploy.log

# SSH vers l'Omen
# ⚠️ L'IP locale CHANGE via DHCP. Ne JAMAIS copier une IP d'un ancien
#    transcript / exemple — elle sera stale. Procédure obligatoire avant
#    chaque SSH :
#       1. Ouvrir https://omenserver.org (tunnel Cloudflare toujours up)
#       2. Module Réseau → carte "IP locale"
#       3. SSH avec CETTE IP
ssh massii08@<IP_LOCALE_DU_MOMENT>

# Accès distant via Cloudflare Tunnel
# Automatique via systemd : cloudflared.service
sudo systemctl status cloudflared
```

---

## 📐 Conventions de code

### Backend (Python)
- **Routers** : un fichier `router.py` par module, préfixé `/api/<module>/`
- **Modèles** : SQLAlchemy dans `models.py` de chaque module
- **Auth** : `current_user: User = Depends(get_current_user)` sur chaque endpoint protégé
- **Logging** : `logger = logging.getLogger("omenserver")` puis `logger.info/warning/error`
- **Docstrings** : en français ou italien, triple quotes

### Frontend (JS)
- **Modules** : objets globaux (`BotsModule`, `FilesModule`, etc.) avec `render(container)` + `unload()`
- **API calls** : toujours via `Auth.apiCall(url, options)` — jamais `fetch()` direct
- **i18n** : toujours `Lang.t('clé')` — jamais de texte hardcodé
- **DOM** : `innerHTML` pour le rendu, `document.getElementById()` pour les mises à jour
- **Pas de framework** : pas de React, Vue, jQuery — tout est vanilla JS

### CSS
- **Variables** : utiliser `var(--nom)` pour couleurs, bordures, transitions
- **Composants** : classes `.card`, `.btn`, `.btn-primary`, `.status-badge`, `.console`, `.module-card`
- **Nouveau module** : ajouter les styles dans `style.css` avec un commentaire séparateur

---

## ⚠️ Pièges connus

> Ici seulement les pièges transverses. Les pièges propres à un module vivent dans `docs/context/*.md` (voir l'index « 📚 Contexte par module » plus haut) et gardent leur numéro historique.

1. **Python 3.9** sur la machine de dev — attention aux syntaxes 3.10+ (`match`, `|` pour unions)

2. **SQLite** ne supporte pas `ALTER TABLE ... IF NOT EXISTS` — les migrations utilisent try/except

3. **Docker** doit être installé et le daemon actif pour les serveurs de jeux

5. **FormData upload** : `Auth.apiCall` détecte automatiquement `FormData` et ne met pas `Content-Type: application/json`

6. **Auto-refresh des bots** : l'interval de 5s doit être clearé (`unload()`) avant de naviguer vers le Yield Bot

7. **Espace dans le chemin** : "Projet serveur" a un espace — utiliser un wrapper script pour systemd

8. **bcrypt direct** : `auth/utils.py` utilise `bcrypt` directement (pas passlib) avec troncature manuelle à 72 bytes

9. **Cache Cloudflare/SW** : bumper `?v=XX` dans `index.html` + `CACHE_NAME` dans `sw.js` après chaque modif JS/CSS

10. **Service Worker PWA** : `sw.js` met en cache les fichiers statiques — bumper `CACHE_NAME` à chaque version

11. **Cache browser stubborn** : même avec `caches.delete + sw.unregister + Ctrl+Shift+R`, le disk cache peut servir une ancienne version `?v=N` du CSS si N a été utilisé avant. Workaround : bumper à un N franc (`?v=99` au lieu de `?v=83`) pour avoir une URL jamais cachée.

12. **i18n fallback truthy trap** : `Lang.t('clé.x') || 'fallback'` ne marche PAS car `Lang.t()` retourne la clé elle-même (truthy) si non trouvée. Pattern correct : `(Lang.t('clé.x')||'').startsWith('clé.') ? 'fallback' : Lang.t('clé.x')`.

13. **Backend emoji propagation** : les Toast notifications viennent souvent de messages backend (`return {"message": "...✅"}`). Stripper les emojis i18n côté frontend ne suffit pas — auditer aussi les `message`/`detail` strings dans `backend/**/*.py` (cf. PR22 — 63 ✅ retirés dans 24 fichiers backend).

14. **Pattern reconstruction trap** : quand on strip un pattern (emoji, hex, etc.), grep aussi les contextes JS où il peut être RECONSTRUIT côté code (dicts, template literals, concatenations). PR16 a découvert `renderSettings()` avait un dict `{admin:'👑', ...}` qui reconstruisait l'emoji après PR14 RBAC strip — la sidebar montrait "Admin" mais Settings montrait "👑 Admin".

15. **Regex emoji sweep + `\s*` pitfall** : `EMOJI_RE + \s*` mange les `\n` aussi (regex `\s` inclut newline). Si un commentaire `// ─── Section ───` (où `─` est U+2500 = dans le emoji range Unicode), le strip englobe le `\n` suivant et le commentaire mange la déclaration suivante. Toujours utiliser `[ \t]*` (horizontal whitespace seulement) si on veut préserver les newlines.

16. **CSP `img-src` restrictif** : par défaut `backend/main.py` n'autorise que `'self' data: blob:` pour les images. Les vignettes CurseForge/Modrinth/Steam Workshop sont CDN externes — il faut les ajouter explicitement à la directive `img-src`. Symptôme : `<img>` avec `naturalSize: 0x0` + `display: none` via `onerror` (silent fail).

17. **Emoji-only button trap (PR35)** : les sweeps emojis (PR27-29-34) laissent des `<button>...</button>` complètement vides quand l'emoji était le SEUL contenu visible. Détection : `grep -E "class=\"btn[^\"]*\"[^>]*>\\s*</button>"` sur `frontend/js/`. Fix : toujours remplacer par un label texte i18n via `Lang.t()`. Idem pour les `::before { content: 'emoji' }` CSS qui peuvent laisser un glyph orphelin avec padding incohérent (cf. `.sharing-search-wrap::before` supprimé en PR35).

18. **`.btn-icon` trap (PR36)** : la classe `.btn-icon` force `width:38px; height:38px; padding:0` (conçue pour emojis carrés). Si on convertit un bouton emoji-only en label texte SANS retirer la classe, le texte déborde et les boutons adjacents se superposent visuellement (vu sur cartes serveur PR36 : "Arrêter Redémarrer Partager" collés). Pattern de détection : `grep -E 'class="[^"]*btn-icon[^"]*"[^>]*>\\${Lang\\.t'`. Fix : retirer `.btn-icon`, garder `.btn-sm` qui a un padding texte normal.

19. **`cond ? '' : ''` smell (PR36)** : un ternaire dont les 2 branches sont des chaînes vides (`btn.textContent = visible ? '' : ''`) est presque toujours un sweep automatique qui a mangé les 2 branches d'un toggle emoji (`'👁' : '🙈'`, `'▶' : '⏸'`). Détection post-sweep : `grep -E "\\? '' : ''"` sur les JS.

28. **Backtick PowerShell `` ` `` non échappé dans template literal JS** : quand on embarque du PowerShell dans un `data-copy="..."` à l'intérieur d'un `return \`...\`` JS, **TOUT** `` ` `` dans le HTML embarqué (utilisé en PowerShell comme escape char, ex: `` `$false ``, `` `"...`" ``) ferme prématurément le template literal JS → SyntaxError au parse → module entier non défini → onglet muet (clic = ReferenceError silencieuse en console, DOM figé sur la vue précédente). Vu en commit `871c085` ligne 476 de `sysdoc_module.js` : `` -Confirm:`$false `` cassait le parse → `SysDocModule` undefined → onglet Diagnostic non fonctionnel. **Fix** : soit échapper avec `` \` `` (produit un `` ` `` littéral en sortie), soit retirer le `` ` `` si inutile en PowerShell (cas de `$false`/`$true` qui sont des littéraux natifs et n'ont PAS besoin d'échappement). **Pourquoi pas détecté** : la prod auto-deploy live sur main, et la vue par défaut au boot est `#hub`, pas `#sysdoc` — l'erreur reste silencieuse jusqu'au premier clic sur l'onglet impacté. **Réflexe** : après tout commit qui touche un panel install / code snippets PowerShell embarqués → `node -e "new Function(require('fs').readFileSync('frontend/js/<file>.js','utf8'))"` AVANT de push pour valider le parse.

34. **Auto-restart au boot doit RESPECTER l'état désiré `srv.status` (fix 2026-05-29)** : la boucle d'auto-restart du `@app.on_event("startup")` de `backend/main.py` rallumait **TOUT** conteneur ayant un `docker_id` et non-running, **sans lire `srv.status`** → les serveurs de jeu **volontairement éteints** se rallumaient à chaque restart uvicorn. Comme l'auto-deploy (cron/min) restart uvicorn à chaque `git push`, le serveur ressuscitait dans la minute → impression de « se rallume tout seul en continu » (signalé ≥2 fois par Massii, le 1er « fix » n'avait jamais marché). **Cause exacte** : le `elif container.status in ("exited","created","paused"): container.start()` était **inconditionnel** — seule la branche « si allumé, rallume » existait, la branche « si éteint, reste éteint » n'avait jamais été codée. **Fix** : `container.start()` UNIQUEMENT si `srv.status == "running"` (état désiré) ; sinon (`stopped`/`error`) laissé éteint + DB sync `stopped`. (a) **`GameServer.status` est un champ CONFLATÉ** (état *désiré* + *observé*) : `list_servers`/`get_server` (`game_server/router.py`) l'écrasent avec le statut Docker réel + `db.commit()`. Le garde-fou d'une ligne suffit car après un *Arrêter* volontaire (`stop_server` commit `stopped`, l.357-359) le statut reste fiablement `stopped`. Refonte propre future éventuelle = 2 champs séparés (`desired_state` vs `observed`). (b) **Politique Docker = `unless-stopped`** (PAS `always`) : un conteneur arrêté via `docker stop` reste stoppé au reboot du daemon, seuls les running reviennent → elle COOPÈRE avec le garde-fou ; ne JAMAIS la passer à `always`. (c) **Effet attendu post-deploy** : un serveur actuellement *en ligne* n'est PAS coupé par le fix (il EST running → branche sync) → il faut un dernier *Arrêter* manuel APRÈS le deploy pour que l'état désiré devienne `stopped` ; ensuite il reste éteint à travers deploys + reboot nocturne.

61. **Un champ lu au mauvais niveau ne plante jamais — il rend la fonctionnalité morte** : leçon générale, texte complet (vécu sur MC Agent) dans `docs/context/mc-agent.md` #61.

64. **⚠️ `new Function(src)` NE VALIDE QU'UN PARSE — il ne charge rien (garde-fou ajoute le 27/07)**. Le reflexe « `node -e "new Function(readFileSync('index.js'))"` avant de pusher » (#28) a laisse passer les DEUX bugs qui ont tue la prod : (1) `index.js` requerait `./wsiteDrown`, jamais `git add` → **MODULE_NOT_FOUND avant `onSpawn`**, chaque spawn frais crashait, la flotte ne pouvait plus se self-heal — et le registre marquait juste `stopped`, `last_error: None` ; (2) piege #56, `panicInFlight` declare dans `onSpawn` mais lu au niveau module → ReferenceError au 1er tick, 3 workers morts, **1153 tests verts**. Un parse ne resout aucun `require` et n'evalue aucune reference. Fix : **`index.smoke.test.js`** charge REELLEMENT `index.js` dans un process enfant, avec `mineflayer` stubbe pour que `createBot` leve tout de suite — si le module s'evalue jusque-la, tous les `require` existent et toutes les references de niveau module resolvent. Verifie dans LES DEUX SENS (il echoue bien sur un require casse, il passe une fois repare). **Regle : pour tout gros point d'entree a effets de bord, le test qui compte est celui qui CHARGE le module, pas celui qui le parse.**

65. **La veille nocturne de l'Omen COMMITTE mais ne peut pas POUSSER — moissonner AVANT toute autre chose (27/07)**. L'Omen n'a aucun identifiant git : `git push` rend « could not read Username ». La veille corrige donc en local et son travail n'existe que dans son arbre — il a fallu le moissonner a la main **4 fois en 24 h** (`3bfd982`, `de1b3d9`, `e23216e`, `f5b0e04`). ⚠️ **`git status --porcelain` PROPRE NE VEUT PAS DIRE « rien a moissonner »** : ce jour-la l'arbre etait propre mais HEAD portait un commit local en avance sur `origin/main` — et ce commit contenait le correctif du MODULE_NOT_FOUND, donc `origin/main` etait **casse** pendant ce temps. **Toujours verifier `git log origin/main..HEAD`, pas seulement le porcelain.** Moisson : `git format-patch -1 <sha> --stdout` cote Omen → `git am` cote Mac (preserve auteur et message) → suites → push → puis **realigner l'Omen** (`git reset --hard origin/main` : meme arbre, hash different, sinon le `git pull` de l'auto-deploy diverge). Voie de sortie durable = **cle de deploiement SSH** (jamais un PAT : un jeton personnel ouvre tout le compte, une deploy key n'ouvre qu'un depot et se revoque d'un clic). La cle privee ne quitte JAMAIS l'Omen ; seule la publique se colle dans Settings → Deploy keys avec **Allow write access**.
