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

## 📁 Structure du projet

```
Projet serveur/
├── backend/                    # API Python FastAPI
│   ├── main.py                 # Point d'entrée — monte tous les routers
│   ├── config.py               # Settings centralisés (.env → Settings class)
│   ├── database.py             # SQLAlchemy (SQLite) — engine, session, Base
│   ├── auth/                   # Authentification JWT + invitations
│   │   ├── router.py           # /api/auth/login, /register, /logout
│   │   ├── invite_router.py    # /api/auth/invite — codes d'invitation
│   │   ├── sharing_router.py   # /api/auth/share — partage de serveurs entre users
│   │   ├── models.py           # User, Invitation (SQLAlchemy)
│   │   ├── utils.py            # get_current_user(), hash/verify (bcrypt direct)
│   │   ├── access_control.py   # Contrôle d'accès par serveur
│   │   ├── permissions.py      # Système de permissions RBAC
│   │   └── rate_limiter.py     # Rate limiting par IP/user
│   ├── monitoring/             # Monitoring système + multi-machines
│   │   ├── router.py           # /api/monitoring/stats (CPU, RAM, disque combiné)
│   │   ├── system_info.py      # Collecte multi-disques via psutil
│   │   ├── diagnostic_router.py # /api/monitoring/diagnostic (système + crash nodes)
│   │   ├── container_router.py # /api/monitoring/containers (Docker)
│   │   └── nodes_router.py     # /api/nodes — PC connectés via omen_agent.py
│   ├── game_server/            # Gestion serveurs de jeux (Docker)
│   │   ├── router.py           # CRUD serveurs + start/stop/restart
│   │   ├── websocket.py        # WebSocket logs temps réel
│   │   ├── models.py           # GameServer (SQLAlchemy)
│   │   ├── backup_router.py    # Sauvegardes auto/manuelles
│   │   ├── backup_manager.py   # Logique de backup (tar.gz + rotation)
│   │   ├── docker_manager.py   # Gestion conteneurs Docker
│   │   ├── games_config.py     # Config des images Docker par jeu
│   │   ├── settings_router.py  # server.properties, JVM args
│   │   ├── players_router.py   # Whitelist, ops, bans
│   │   ├── access_router.py    # SFTP/RCON credentials
│   │   ├── sftp_manager.py     # Gestion SFTP conteneurisé
│   │   └── files_router.py     # Navigateur de fichiers serveur
│   ├── bots/                   # Module Bots Python
│   │   ├── router.py           # CRUD bots + start/stop + logs
│   │   ├── models.py           # Bot (SQLAlchemy)
│   │   └── yield_router.py     # 🏦 Bot Yield dédié (upload, run, status, download)
│   ├── scheduler/              # Tâches planifiées (APScheduler)
│   │   ├── router.py           # CRUD tâches cron
│   │   ├── engine.py           # APScheduler engine + power job
│   │   ├── models.py           # ScheduledTask
│   │   ├── power_router.py     # API extinction/redémarrage programmé + immédiat
│   │   └── power_manager.py    # Logique rtcwake/suspend/shutdown + arrêt gracieux
│   ├── mods/                   # Gestion de mods (CurseForge, Steam Workshop)
│   │   ├── router.py           # /api/mods — installation/suppression
│   │   ├── curseforge.py       # API CurseForge (Minecraft)
│   │   ├── steam_workshop.py   # Steam Workshop (ARK, CS2, etc.)
│   │   ├── plugin_router.py    # Plugins Minecraft (Spigot/Paper)
│   │   ├── plugin_manager.py   # Gestionnaire de plugins
│   │   └── datapack_manager.py # Datapacks Minecraft
│   ├── modules/                # Hub des modules
│   │   └── router.py           # /api/modules/ — liste des modules activés
│   ├── media/                  # Module Média (Jellyfin)
│   │   └── router.py
│   ├── webserver/              # Module Serveur Web (Docker)
│   │   ├── router.py
│   │   └── models.py           # Website
│   ├── network/                # Module Réseau (Wake-on-LAN, ping)
│   │   ├── router.py
│   │   └── models.py           # WolDevice, NetworkLog
│   ├── gdrive/                 # Google Drive integration
│   │   └── router.py
│   ├── notifications/          # Notifications
│   │   └── router.py
│   ├── activity/               # Historique d'activité
│   │   └── router.py
│   └── rate_limiter.py         # Rate limiter global (IP-based middleware)
├── frontend/                   # Interface web (vanilla JS/CSS)
│   ├── index.html              # Shell SPA principal
│   ├── login.html              # Page de connexion (standalone)
│   ├── css/
│   │   └── style.css           # Design system Bento Tech v5 (voir section dédiée)
│   ├── js/
│   │   ├── app.js              # Router SPA + Dashboard + App controller
│   │   ├── auth.js             # Auth.apiCall(), login/logout, token JWT
│   │   ├── lang.js             # i18n — FR/EN/IT (clés: modules.*, bots.*, yield.*, etc.)
│   │   ├── modules.js          # Hub des modules (cartes)
│   │   ├── monitoring.js       # Dashboard monitoring (stats combinées, carte Omen cerveau)
│   │   ├── toast.js            # Notifications toast
│   │   ├── bots_module.js      # Module Bots (liste + Yield Bot UI)
│   │   ├── files_module.js     # Module Fichiers (navigateur)
│   │   ├── media_module.js     # Module Média (Jellyfin)
│   │   ├── web_module.js       # Module Serveur Web
│   │   ├── network_module.js   # Module Réseau (WoL, ping)
│   │   ├── game_server.js      # Liste des serveurs de jeux
│   │   ├── server_view.js      # Vue détaillée d'un serveur (onglets)
│   │   ├── sv_files.js         # Onglet Fichiers serveur
│   │   ├── sv_settings.js      # Onglet Paramètres serveur
│   │   ├── sv_monitoring.js    # Onglet Monitoring serveur
│   │   ├── sv_players.js       # Onglet Joueurs serveur
│   │   ├── sv_access.js        # Onglet Accès serveur (SFTP/RCON)
│   │   └── sv_history.js       # Onglet Historique serveur
│   ├── sw.js                   # Service Worker (PWA)
│   ├── manifest.json           # PWA manifest
│   └── favicon.svg
├── tools/                      # Scripts utilitaires
│   ├── omen_agent.py           # 🦾 Agent monitoring à installer sur chaque PC
│   ├── omen-resume.sh          # 🌙 Script post-suspend (reboot pour RAM fraîche)
│   ├── omen-agent.service      # Fichier service systemd pour l'agent
│   ├── setup_omen.sh           # Setup automatique de l'Omen (cerveau)
│   ├── setup_omen_agent.sh     # Setup automatique d'un bras (agent + suspend/wake)
│   └── translate.py            # Script de traduction automatique
├── docs/                       # Documentation
│   ├── Guide_Installation_PC_OmenServer.md     # Guide ajout PC (FR)
│   ├── Guide_Installation_PC_OmenServer_IT.md  # Guide ajout PC (IT)
│   ├── Guide_Installation_PC_OmenServer.html   # Version HTML (FR)
│   ├── Guide_Installation_PC_OmenServer_IT.html# Version HTML (IT)
│   └── generate_pdf.py         # Générateur PDF des guides
├── data/                       # Données persistantes
│   ├── omenserver.db           # Base SQLite
│   ├── power_schedule.json     # Config extinction/réveil programmé
│   └── servers/                # Données des serveurs de jeux
├── .env                        # Variables d'environnement (non commité)
├── .env.example                # Template des variables
├── requirements.txt            # Dépendances Python
├── watchdog.sh                 # Script de surveillance (prod)
├── CLAUDE.md                   # Contexte projet pour agents IA
├── AGENTS.md                   # Règles pour agents IA
└── README.md
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
| **Inter** (Google Fonts) | Typographie |
| **Chart.js** | (via CDN) Graphiques monitoring |

### Infrastructure de Production
| Composant | Détail |
|-----------|--------|
| **OS prod** | Ubuntu Server (HP Omen) |
| **OS dev** | macOS |
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

### Design System (style.css) — Bento Tech v5
- **Voir section dédiée** plus bas (`## 🎨 Design System v5 — Bento Tech`) pour les tokens, composants Bento, règles d'usage et catalogue complet.
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

## 🩺 Module Diagnostic / sysdoc (V4 multi-machine)

Le **Diagnostic Bot** est intégré comme module SPA dans le hub. Permet de superviser le Mac et le PC Windows de l'utilisateur depuis n'importe quel browser logué.

### Architecture WS

- **Agent** (`tools/diagnostic_agent/`) tourne sur chaque PC de l'utilisateur. Connecte `/ws/sysdoc/agent/{username}/{machine}` (multi-machine par user, `machine` = hostname par défaut).
- **Viewer** (frontend SPA) connecte `/ws/sysdoc/viewer/{username}`. Reçoit les messages de TOUTES les machines (taggés `machine` par le backend), affiche un sélecteur de pills en haut quand >1 machine.
- **ConnectionManager** : `agents = Dict[str, Dict[str, WebSocket]]` (user→machine→ws). `viewers = Dict[str, Set[WebSocket]]` (broadcast à tous les onglets ouverts).

### Auto-start de l'agent

- **macOS** : LaunchAgent via `setup_macos.sh` (install/start/stop/restart/status/logs/uninstall + enable-dns-flush pour sudoers DNS).
- **Windows** : Tâche planifiée via PowerShell admin avec `pythonw.exe` (PAS `python.exe` — voir piège #19). Installable via le panel install du dashboard (bouton "+ Ajouter un PC").

### Pattern unique au sysdoc

- **Mode idle/active** : l'agent ne pousse pas de metrics au boot. Reste en idle, écoute juste `START_MONITORING` / `STOP_MONITORING` / `QUERY_STATE` / `LIST_ACTIONS` / `RUN_ACTION` / `SUSPEND_PROCESS` / `RESUME_PROCESS` / `BULK_SUSPEND`. Économie CPU/réseau quand l'utilisateur n'est pas sur la page.
- **Trousse 3 tiers** (safe/moderate/risky) : safe et moderate sont exécutées par l'agent, risky est REFUSÉE même si commandée (dead man's switch, le frontend affiche juste les instructions).
- **Persistance machines en localStorage** : `sysdoc.machines.<user>` → les pills offline restent visibles même après reload.
- **/api/sysdoc/me** : retourne `secret_key` UNIQUEMENT si `is_admin=true` → permet au panel install de pré-remplir le SECRET_KEY dans les commandes copy-pastables.

---

## 🏦 Bot Yield (intégration spéciale)

Le bot de calcul de rendement d'obligations est un **projet Python externe** intégré dans OmenServer.

### Architecture
```
OmenServer                          Bot Calcul Yield (externe)
  │                                    │
  ├── yield_router.py                  ├── main.py (CLI: --all, --recalculate)
  │   ├── POST /upload → save .xlsx    ├── bot/yield_bot.py (orchestrateur)
  │   ├── POST /run/{id} → subprocess  ├── calculator/yield_calculator.py
  │   ├── GET /status/{id} → parse logs├── excel/processor.py
  │   ├── GET /download/{id}           ├── scraper/boerse_scraper.py (Playwright)
  │   └── GET /usage                   └── bot/rate_limiter.py (5/jour max)
```

### Points clés
- Le bot est lancé via `subprocess.Popen` — **jamais importé directement** en prod
- Les logs sont capturés en temps réel via `stdout` pipe + thread
- La progression est parsée via regex sur les lignes de log
- Le fichier résultat est `*_AGGIORNATO.xlsx`
- Rate limit : max 5 scraping/jour (ricalcolo illimité)
- Variable d'environnement : `YIELD_BOT_DIR` (défaut: `~/omenserver/bots/yield-bot/`)

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

1. **Python 3.9** sur la machine de dev — attention aux syntaxes 3.10+ (`match`, `|` pour unions)
2. **SQLite** ne supporte pas `ALTER TABLE ... IF NOT EXISTS` — les migrations utilisent try/except
3. **Docker** doit être installé et le daemon actif pour les serveurs de jeux
4. **Playwright** + Chromium requis sur le serveur prod pour le scraping du Yield Bot
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
20. **Windows Task Scheduler + `python.exe` = `STATUS_CONTROL_C_EXIT`** : si on crée une tâche planifiée qui exécute `python.exe -u main.py`, Windows attache une console à la session interactive. Quand l'utilisateur ferme la PowerShell où il a fait `Start-ScheduledTask`, Windows propage `CTRL_CLOSE_EVENT` → le python reçoit SIGINT → exit avec code `3221225786` (`0xC000013A`). **Solution** : utiliser `pythonw.exe` (sans le `e`, le `w` = no console). Le venv Windows en contient un d'office. Bloc complet dans le panel install Windows du dashboard.
21. **Triple-paste du SECRET_KEY au setup** : `setup_macos.sh` et `setup_windows.bat` utilisent `read -s` pour masquer l'input du SECRET_KEY. Si l'utilisateur appuie Cmd+V/Ctrl+V plusieurs fois sans s'en rendre compte (input masqué), la valeur est concaténée 2-3× dans le `.env` → JWT invalide → close code 1008 du hub → reconnect storm. Diagnostic : `python3 -c "print(len(open('.env').read().split('OMEN_JWT_SECRET=')[1].strip()))"`. Fix : remplacer la ligne via un Python script idempotent.
22. **macOS `killall mDNSResponder` sans sudo** : Catalina+ exige sudo. L'agent LaunchAgent tourne en user → ne peut pas exécuter sans password (un service ne peut pas prompt interactif). Solution : `setup_macos.sh enable-dns-flush` qui crée `/etc/sudoers.d/omen-diagnostic-agent` avec une règle ultra-restrictive (UNIQUEMENT cette commande sans password). One-shot, demande sudo une fois pour écrire le fichier sudoers.
23. **PowerShell + `.\` prefix obligatoire** : pour exécuter un script du cwd (ex: `setup_windows.bat`), faut `.\setup_windows.bat`. Sans le `.\`, erreur "n'est pas reconnu comme nom d'applet de commande". Protection anti-PATH-hijacking. En cmd.exe le `.\` n'est pas nécessaire.
24. **PowerShell s'ouvre dans `C:\Windows\system32`** : surtout en admin. `git clone` y échoue avec "Permission denied". Faut `cd ~` avant tout pour aller dans `C:\Users\<user>` (writable).
25. **Bloc de commandes "exemples utiles" copy-pasté en bloc** : PowerShell exécute en séquence si l'utilisateur colle plusieurs commandes ensemble. Si y'a un `Unregister-ScheduledTask` ou `rm` dans le lot, la dernière commande exécute et détruit ce que les précédentes ont créé. **Toujours documenter les commandes individuelles dans des blocs SÉPARÉS** avec une note "à utiliser une par une".
26. **NSSM (`nssm.cc`) souvent down 503** : mainteneur unique. Pour Windows Service alternative : `choco install nssm` / `scoop install nssm`, OU mieux **éviter NSSM totalement** via Tâche planifiée Windows (recommandé maintenant — voir piège #20 pour la version `pythonw.exe`).
27. **Multi-machine WS path** : le sysdoc utilise `/ws/sysdoc/agent/{username}/{machine}` (pas juste `{username}`). `machine` = `socket.gethostname()` sanitized par défaut, override possible via `OMEN_AGENT_MACHINE` env var. Le ConnectionManager garde un `Dict[user, Dict[machine, WS]]`. Si 2 PCs s'installent avec le MÊME machine_id, ils se kickent (strict 1:1 par machine). Solution : machine_id unique par PC (le hostname suffit usually).
28. **Backtick PowerShell `` ` `` non échappé dans template literal JS** : quand on embarque du PowerShell dans un `data-copy="..."` à l'intérieur d'un `return \`...\`` JS, **TOUT** `` ` `` dans le HTML embarqué (utilisé en PowerShell comme escape char, ex: `` `$false ``, `` `"...`" ``) ferme prématurément le template literal JS → SyntaxError au parse → module entier non défini → onglet muet (clic = ReferenceError silencieuse en console, DOM figé sur la vue précédente). Vu en commit `871c085` ligne 476 de `sysdoc_module.js` : `` -Confirm:`$false `` cassait le parse → `SysDocModule` undefined → onglet Diagnostic non fonctionnel. **Fix** : soit échapper avec `` \` `` (produit un `` ` `` littéral en sortie), soit retirer le `` ` `` si inutile en PowerShell (cas de `$false`/`$true` qui sont des littéraux natifs et n'ont PAS besoin d'échappement). **Pourquoi pas détecté** : la prod auto-deploy live sur main, et la vue par défaut au boot est `#hub`, pas `#sysdoc` — l'erreur reste silencieuse jusqu'au premier clic sur l'onglet impacté. **Réflexe** : après tout commit qui touche un panel install / code snippets PowerShell embarqués → `node -e "new Function(require('fs').readFileSync('frontend/js/<file>.js','utf8'))"` AVANT de push pour valider le parse.

29. **Rating Bond Scanner / Yield Bot — Brave Search API single source** : les deux bots partagent la même clé `BRAVE_SEARCH_API_KEY` (free tier 1000 req/mois). Stratégie `site:fitchratings.com {issuer}` parsée sur les titres indexés. Pièges spécifiques : (a) **strip prudent des suffixes** (Inc/Corp/LLC/PLC/SA/AG/NV/GmbH/SpA uniquement — JAMAIS Worldwide/Finance/Holdings/Capital sinon faux positif type Hilton Worldwide → Hilton Grand Vacations Trust BB-) ; (b) **REJECT keywords** `trust/abs/rmbs/cmbs/grand vacations/presale/covered bond/mortgage/clo/spv` (skip les hits sur structures de securitisation) ; (c) **cache négatif obligatoire 30j** (sinon on re-burn la quota pour les issuers que Fitch ne couvre pas — typiquement 30-40% des corporates US) ; (d) Brave portal a migré `api.search.brave.com` → `api-dashboard.search.brave.com` mais l'endpoint search reste `api.search.brave.com/res/v1/web/search`. (e) **Adaptation sync→async** : Yield Bot utilise `httpx.get` sync (entry point synchrone) ; Bond Scanner utilise `httpx.AsyncClient` car `fetch_ratings()` tourne dans la loop Playwright. Si on porte du code sync vers un consommateur async, surtout pas bloquer la loop avec sync I/O. (f) **2 copies à patcher** : `bot obbligation/` (standalone) + `Projet serveur/bond-scanner/` (in-server, prod). `start()` a divergé 2026-05-27 (snap-aware Chromium fallback in-server-only) → `diff -q` sur tout le market_scraper.py FAIL même après sync ; faire un diff sur la région `fetch_ratings()` uniquement.

30. **Bond Scanner — boutons Angular page-bar ne répondent qu'au DISPATCH d'événements pointer (headless)** : sur Deutsche Börse (live.deutsche-boerse.com/bonds), les boutons de pagination (`button.page-bar-type-button` : taille "100", "Show page N") NE répondent NI à Playwright `.click()` NI au native `element.click()` en HEADLESS — les deux sont des no-ops silencieux (0 nouveau `bond_search`, données inchangées → scan plafonné à 25 bonds). Le handler Angular est bindé sur la SÉQUENCE complète `pointerdown+mousedown+pointerup+mouseup+click`. Fix : `page.evaluate` qui dispatch les 5 events sur l'element_handle (cf. `MarketScraper._click_robust`). Diag confirmé en local (Mac headless chromium) : Playwright click → 50 liens ; dispatch → 200 liens + fire bond_search. **Réflexe** : pour tout site Angular/SPA en headless où un click ne déclenche rien, tester le dispatch de la séquence pointer complète. (b) **Réponse bond_search async ≈10s** : après le click, `wait_for_load_state("networkidle")+timeout` est TROP COURT → on parsait avant l'arrivée → "Nessun nuovo bond". Fix : poll explicite de `api_responses` jusqu'à voir une clé `bond_search` (`_wait_for_bond_search`, timeout 20s). (c) **Listing riche** : la réponse `bond_search` contient déjà `name.originalValue` ("ISSUER COUPON% YY/YY") + `keyData.coupon` → on extrait émetteur+coupon+maturité (année du dernier `/YY`) SANS enrich → 97% des bonds `is_complete()` depuis le listing → l'enrich page-détail (5s/bond, LE bottleneck) est skip → ratisser le marché devient faisable. (d) **3 stores dédup** : found (livrés, permanent), seen (rejetés, 60j TTL car le prix→yield bouge), rating cache (30j). L'overflow (valides hors top-N) n'est dans AUCUN → revient concourir. (e) **Garde-fou réserve Brave** : on lit `X-RateLimit-Remaining` (mensuel) ; à ≤50 on arrête + bloque le lancement (HTTP 429) — ces 50 sont RÉSERVÉES au Yield Bot (clé partagée). (f) **Scan détaché** (`start_new_session=True` dans le `subprocess.Popen` du backend) : sinon un push pendant un scan → auto-deploy → reload uvicorn → tue le subprocess enfant. NE JAMAIS pusher pendant qu'un scan tourne (badge "Bots N").

31. **Rating Brave/Fitch — faux positifs WRONG-ISSUER (les 2 bots, fix 2026-05-29)** : la stratégie `site:fitchratings.com {issuer}` extrayait le rating du TITRE du 1er hit Fitch SANS vérifier que la page parle bien DE l'émetteur cherché. Brave renvoie TOUJOURS des résultats (même si Fitch ne note pas l'émetteur) → on récupérait le rating d'une AUTRE entité. Cas réel reproduit : `Iccrea Banca` (petite banque coopérative IT, non notée Fitch) → Brave renvoyait `"Fitch Affirms ICBC at 'A'"` → Iccrea taggé **'A'** (ICBC = Bank of China ≠ Iccrea). Pire : le score `+2` ('Affirms'/'IDR') PRÉFÉRAIT activement ces pages-autre-émetteur à la page (sans rating) du bon émetteur. Symptôme côté Massii : ratings introuvables à la main sur Fitch, "aucun s'ouvre sur Fitch". **Fix** : garde-fou d'identité `_issuer_matches_hit(issuer, title, url)` — on n'accepte un rating QUE si le **token identitaire** de l'émetteur (1er mot ≥3 lettres non générique, ex. "dominion"/"iccrea"/"bayerische") apparaît comme **TOKEN** (pas substring — "ubs" ⊄ "subsidiary") du titre OU du slug de l'URL. Émetteur 100% générique → rejet. Mirror exact dans `bond-scanner/scanner/rating_providers.py` (`BraveFitchProvider`) ET `yield-bot/scraper/rating_fetcher.py` (`_try_brave_search`). (b) **Bond Scanner = rating obligatoire** : `criteria.matches()` rejette désormais TOUT bond sans rating vérifié (avant : seulement si `min_rating` set). (c) **Lien vérifiable Excel** : `RatingInfo.source_url` + `bond.rating_url` → la cellule G de l'Excel est un **lien hypertexte** vers la page Fitch qui prouve le rating (Massii clique → vérifie). (d) **Yield Bot** : écrit déjà `?` si `(None, None)`, donc le gate fait juste tomber les faux positifs en `?` (comportement demandé). (e) **Caches empoisonnés** : `~/.cache/{bond-scanner,yield-bot}-ratings.json` contenaient les faux positifs (TTL 30j) → vidés (backup `/tmp/*.poisoned.bak`), se régénèrent corrects au prochain scan. (f) Régression verrouillée par fixtures Brave RÉELLES (`bond-scanner/tests/fixtures/brave_results.json`) : `test_iccrea_false_positive_is_now_none` + `test_dominion_true_positive_bbbplus`. (g) **Affinage mots GÉOGRAPHIQUES (2026-05-29 bis, révélé par un scan réel)** : le match sur 1 seul token échouait quand ce token était un mot géographique/national commun → `Deutschland, Bundesrepublik` (Bund AAA) taggé **BBB** via "Telefonica **Deutschland**", et `DZ BANK ... Deutsche Zentral-...` taggé A- via "**Deutsche** Bank". Fix : ajout des pays/nationalités (`deutsche`/`deutschland`/`america`/`france`/`republik`/…) à `_GENERIC_NAME_TOKENS` → le token identitaire tombe sur la VRAIE marque (`telekom`, `zentral`, `lufthansa`). Effet de bord assumé : les émetteurs dont le SEUL token distinctif est géographique (Deutsche Bank, Bank of America, Bund allemand) → ∅ (pas de rating, sûr) plutôt qu'un faux. Recall < correctness (priorité Massii). (h) **Anti-péremption + withdrawn** : on jette les pages Fitch > 8 ans (ex. GM 'D' de 2009 → re-tombe sur GM BBB- 2020) et celles dont l'URL contient `withdraw` (notation retirée, ex. Vodafone West GmbH). 101 tests ✓.

32. **Garde-fou réserve Brave — mauvaise lecture du header sur plan SANS cap mensuel (fix 2026-05-29)** : le plan Brave actuel est métré **50 req/s, AUCUN cap mensuel** → l'API renvoie `x-ratelimit-limit: 50, 0` / `x-ratelimit-remaining: 49, 0`. `_read_remaining` lisait `parts[-1]` = `0` comme "0 restant mensuel" → `0 ≤ 50` → `quota_low=True` → (a) scan stoppé après le 1er bond, (b) la valeur `0` persistée dans `~/.cache/bond-scanner-brave-remaining.json` BLOQUAIT tous les scans suivants (HTTP 429 pré-lancement, `scanner_router._brave_remaining`). **Fix** : lire AUSSI `x-ratelimit-limit` ; n'armer la réserve QUE si la **limite mensuelle > 0** (vrai cap). Limite == 0 (plan métré) → `remaining_monthly = None` (pas `0`) → rien de bloquant persisté. La détection terminale `quota_exhausted` (429 + mots-clés) reste le vrai garde-fou. Les requêtes 200 prouvent que `0` ≠ épuisé. **Note** : la "réserve 50 pour le Yield Bot" ne s'applique que sur un plan À CAP mensuel ; sur le plan métré actuel la seule contention est le 1 req/s (déjà géré par l'espacement 1.1s).

33. **Rating FITCH PAR ISIN — source unique définitive (les 2 bots, 2026-05-29, SUPERSEDE #29/#31/#32)** : Massii a tranché « **fitch only ISIN** » — Brave (recherche par NOM) est abandonné car *fondamentalement* imprécis (un nom est ambigu : Iccrea→ICBC, Bund→Telefonica, et même quand le bon émetteur matche on ne récupère qu'une note approximative, pas celle DU bond). L'ISIN est unique → zéro ambiguïté. **Comment** : on interroge l'API GraphQL publique de Fitch `POST https://api.fitchratings.com/` avec `search(term:<ISIN>, item:IDENTIFIERS){ entity{name ratings{ratingTypeDescription ratingCode}} issue{isin ratings{...}} }`. (a) **Cloudflare bloque les clients serveur au niveau TLS** (`TLSV1_ALERT_PROTOCOL_VERSION` avec httpx/requests) → on utilise **`curl_cffi`** (`Session(impersonate="chrome")`) qui imite l'empreinte TLS de Chrome → 200 OK. C'est LA clé qui débloque tout (l'ancienne investigation pensait Fitch totalement injoignable headless). (b) **Note rendue = note du TITRE exact** (`issue` dont le tableau `isin` contient l'ISIN cherché — c'est LE rating du bond ; ex. Oncor secured → **A**), avec **fallback** sur la note émetteur `entity` Long Term IDR si le titre n'a pas de note propre (décision Massii 2026-05-29 : « la note du titre exact »). La note émetteur reste dispo (`issuer_rating`) — bascule globale via `PREFER_SECURITY_RATING`/`FITCH_PREFER_SECURITY=False`. NB : pour 95% des bonds (senior unsecured) titre == émetteur ; seuls secured/subordinated diffèrent. (c) **`WD`/`NR` (retiré/non noté) → None** : un émetteur dont Fitch a RETIRÉ la note (ex. Mercedes-Benz, noté S&P/Moody's seulement) tombe en ∅ — c'est CORRECT (≠ l'ancien Brave qui ressortait une page stale "A-"). Sovereigns OK (Bund→AAA, Spain→A, EU→AAA). (d) **Retry obligatoire** : la 1ʳᵉ requête d'une session curl_cffi reçoit parfois un challenge Cloudflare HTML (200 sans JSON) → 3 essais ; flag `unreachable` SEULEMENT après 5 échecs consécutifs (vrai blocage, pas un blip ponctuel → sinon on tuerait le scan sur un bond flaky). (e) **Lien vérifiable** : cellule G Excel = hyperlien `https://www.fitchratings.com/search/?query=<ISIN>` (= la recherche manuelle exacte de Massii). (f) **Modules** : `bond-scanner/scanner/fitch_isin.py` (`FitchIsinClient`, `select_rating`) consommé par `market_scraper.fetch_ratings` (sync curl_cffi via `asyncio.to_thread`) ; `yield-bot/scraper/rating_fetcher.py` (`select_isin_rating`, `_fetch_fitch_isin`) — `fetch_rating(isin, issuer)` ignore désormais `issuer`. (g) **⚠️ DÉPLOIEMENT** : `curl_cffi` doit être pip-installé dans le venv backend de l'Omen (les bots tournent via `sys.executable`) ; l'auto-deploy ne réinstalle PAS les deps → `pip install curl_cffi` à la main sur l'Omen, sinon `ImportError` → `unreachable` → toutes notes ∅. Ajouté à `requirements.txt` (×3). (h) Contrat GraphQL extrait par rétro-ingénierie du bundle Gatsby (introspection désactivée) + découverte error-guided (`search(term,item)` → `EntityHit.ratings{ratingCode,ratingTypeDescription}`, `IssueHit.isin/ratings`). Fixtures réelles : `tests/fixtures/fitch_isin_responses.json`, tests `test_fitch_isin.py`. (i) **Dead code** : `BraveFitchProvider` (rating_providers.py) + `_try_brave_search`/`_try_*` (rating_fetcher.py) + leurs tests restent en place mais NE SONT PLUS appelés (cleanup à faire). Les helpers partagés `is_valid_rating`/`normalize_to_sp`/`RATING_SCALE`/`_Cache` de rating_providers sont TOUJOURS utilisés (par fitch_isin + criteria). (j) **⚠️ CACHE EMPOISONNÉ à la migration de source (piège majeur, vécu)** : le cache `~/.cache/bond-scanner-ratings.json` (TTL 30j) contenait 457 entrées de l'ère Brave. Au 1er scan post-migration, chaque ISIN déjà caché était servi avec sa VIEILLE note Brave (par nom, fausse) au lieu d'appeler Fitch → Excel contaminé (Orange A+ au lieu de BBB+, etc.). **Fix** : à la lecture du cache, n'honorer QUE les entrées dont `source` commence par "Fitch" — les entrées Brave sont ignorées → re-fetch Fitch → écrasées. **Règle générale** : quand on change de source de rating, soit on versionne/vide le cache, soit on filtre les hits de cache par source (le cache survit aux déploiements, lui). Vérif gold standard : recouper les notes du bot contre l'API Fitch DEPUIS LE NAVIGATEUR (in-page fetch sur l'onglet fitchratings.com, CORS OK) — chemin indépendant du code Python. (k) **UI** : encarts clé Brave retirés des 2 bots (`bots_module.js`) ; bouton **"Oublier les rejetés"** (scanner) → `POST /api/bots/scanner/reset-seen` (vide seen only ; found préservé ; seen auto-expire 60j). `/reset-found` (les deux) reste pour le nettoyage total.

34. **Auto-restart au boot doit RESPECTER l'état désiré `srv.status` (fix 2026-05-29)** : la boucle d'auto-restart du `@app.on_event("startup")` de `backend/main.py` rallumait **TOUT** conteneur ayant un `docker_id` et non-running, **sans lire `srv.status`** → les serveurs de jeu **volontairement éteints** se rallumaient à chaque restart uvicorn. Comme l'auto-deploy (cron/min) restart uvicorn à chaque `git push`, le serveur ressuscitait dans la minute → impression de « se rallume tout seul en continu » (signalé ≥2 fois par Massii, le 1er « fix » n'avait jamais marché). **Cause exacte** : le `elif container.status in ("exited","created","paused"): container.start()` était **inconditionnel** — seule la branche « si allumé, rallume » existait, la branche « si éteint, reste éteint » n'avait jamais été codée. **Fix** : `container.start()` UNIQUEMENT si `srv.status == "running"` (état désiré) ; sinon (`stopped`/`error`) laissé éteint + DB sync `stopped`. (a) **`GameServer.status` est un champ CONFLATÉ** (état *désiré* + *observé*) : `list_servers`/`get_server` (`game_server/router.py`) l'écrasent avec le statut Docker réel + `db.commit()`. Le garde-fou d'une ligne suffit car après un *Arrêter* volontaire (`stop_server` commit `stopped`, l.357-359) le statut reste fiablement `stopped`. Refonte propre future éventuelle = 2 champs séparés (`desired_state` vs `observed`). (b) **Politique Docker = `unless-stopped`** (PAS `always`) : un conteneur arrêté via `docker stop` reste stoppé au reboot du daemon, seuls les running reviennent → elle COOPÈRE avec le garde-fou ; ne JAMAIS la passer à `always`. (c) **Effet attendu post-deploy** : un serveur actuellement *en ligne* n'est PAS coupé par le fix (il EST running → branche sync) → il faut un dernier *Arrêter* manuel APRÈS le deploy pour que l'état désiré devienne `stopped` ; ensuite il reste éteint à travers deploys + reboot nocturne.

---

## 🎨 Design System v5 — Bento Tech

> **Depuis le 26 mai 2026, le frontend est en Bento Tech v5.** Référence dans la branche
> `design/bento-tech-mockup` (mockups + MASTER.md). Sur `main`, les tokens et composants
> sont déjà déployés.

### Tokens canoniques (dans `:root` de `frontend/css/style.css`)

```css
--bg          #0E0E10    /* page background */
--bg-elev-1   #161618    /* default surface (cards) */
--bg-elev-2   #18181B    /* hover state, big cards */
--bg-elev-3   #1F1F23    /* inputs, avatars, code blocks */
--border      #27272A    /* hairline */
--border-strong #3F3F46  /* emphasized */
--text        #F4F4F5    /* primary */
--text-muted  #A1A1AA    /* secondary */
--text-dim    #71717A    /* tertiary, timestamps */
--accent      #4ADE80    /* CHANGEABLE via data-accent */
--accent-dim  rgba(74,222,128,.14)
--danger      #F87171    /* FIXED — semantic only */
--warning     #FBBF24
--info        #60A5FA
--violet      #C084FC    /* developer role */
--orange      #FB923C    /* money role */
--font-ui     'Inter'
--font-mono   'Geist Mono'  /* ALL numbers via font-feature-settings:"tnum" */
--r-sm/md/lg  8 / 10 / 14 px
--s-1 .. --s-12  4 .. 48 px (scale 4px base)
```

### Accent variants (changent uniquement `--accent`)

```css
[data-accent="blue"]   { --accent: #60A5FA; ... }
[data-accent="red"]    { --accent: #FB7185; ... }
[data-accent="yellow"] { --accent: #FACC15; ... }
/* default green stays in :root */
```

L'accent est persisté en localStorage (`omen-accent`). Migration auto depuis les anciens
thèmes (midnight→blue, crimson→red, emerald/default→green) au boot via `App._loadAccent()`.

### Composants Bento (à utiliser en priorité)

| Class | Usage |
|---|---|
| `.bento-overview` + `.stat-card` | Grille de stats Dashboard / Network / Tasks |
| `.bento-overview .stat-card.big` | Card 2× plus grosse (span 2 rows) |
| `.bot-card-bento` (+ `.b-head/.b-name/.b-actions/.b-desc`) | Bot cards module |
| `.diag-strip` + `.diag-grid` + `.diag-item` (`.warn`/`.err`) | System health checks |
| `.badge` (+ `.online`/`.warn`/`.danger`) | Status pills universel |
| `.role-pill` (`.admin`/`.developer`/`.moderator`/`.money`/`.player`/`.spectator`) | Rôles RBAC |
| `.access-pill` (`.owner`/`.manage`/`.start`/`.view`) | Per-resource sharing level |
| `.mod-chip` | `User.allowed_modules` indicator |
| `.row` + `.row-list` | Compact list items (servers, bots, etc.) |
| `.events-feed` + `.ev` (+ `.typ.ok/.warn/.err`) | Activity log mono |
| `.sparkline` | Aréa chart subtil sous big stat |
| `.machines-grid` + `.machine-card` (+ `.brain`/`.arm`/`.offline`) | Network of machines (omen + agents) |
| `.users-table` (+ `.u-head/.u-row/.u-name`) | Tableau utilisateurs |
| `.tasks-table` | Scheduler global |
| `.mod-grid` + `.mod-card` | Plugin/Mod/Workshop browser |
| `.dropzone` | Upload zone |
| `.accent-switcher-mini` + `.accent-dot` | Switcher 4 couleurs (topbar right) |
| `.sv-layout` + `.sv-sidebar` + `.sv-tab` (+ `.active/.share/.danger`) | Server view sidebar |
| `.topbar` + `.brand .logo` + `.nav-tabs` + `.nav-tab` | Top bar navigation (PR26) |
| `.lang-switcher` + `.lang` (`.active`) | Pill segmenté FR/EN/IT (PR26) |
| `.user-pill` + `.user-avatar` + `.user-meta` + `.user-caret` | Avatar + nom + rôle (topbar right) — cliquable depuis PR37, ouvre `.user-menu` |
| `.user-menu-wrap` + `.user-menu` + `.user-menu-item` (+ `.danger`) + `.user-menu-sep` | Dropdown sous le profil avec actions account-scope (Utilisateurs admin-only, Paramètres, Logout) — PR37/PR38 |
| `.tab-badge` | Badge count sur nav-tab (PR32 — background jobs) |
| `.b-ticker` | Mono text ticker chip (replace emoji avatars, PR27) |
| `.game-ico` | Idem pour game server cards (`MC`/`ARK`/`CS2`, PR24) |
| `.login-brand` + `.login-logo` + `.login-brand-text` | Login page brand (matches topbar, PR33) |

### Règles d'usage

- **Tous les chiffres** : `font-family: var(--font-mono); font-feature-settings: "tnum"`
- **Couleurs sémantiques** (`--danger`/`--warning`/`--info`) : **FIXES**, ne suivent JAMAIS l'accent
- **`--accent`** uniquement pour : status "online", deltas positifs, primary CTA active,
  nav item actif, role-pill `.admin` (signature owner)
- **Surfaces** : 3 niveaux (`--bg-elev-1/2/3`), JAMAIS d'ombre, hairline border 1px
- **Border-radius** : échelle `--r-sm` (8) / `--r-md` (10) / `--r-lg` (14) / `--r-pill` (999) uniquement
- **Anti-patterns** : pas de gradients (sauf sparkline), pas de glassmorphism, pas d'emoji UI,
  pas de `box-shadow` flou, pas de hex hardcodé dans les composants

### Coexistence avec le legacy

PR 1-6 ont ajouté les nouveaux tokens **sans supprimer** les anciens (`--bg-primary`, `--accent-green`, etc.).
PR 7 a appliqué des **overrides `!important`** sur les classes legacy (`.sidebar`, `.module-card`,
`.btn-primary`, `.status-badge`, etc.) pour les rendre Bento Tech sans toucher au HTML.

**Évolution session 26 mai PM** :
- PR12 : purge complète du système de thèmes legacy (`_themes`, `cycleTheme`, `toggleLightMode`, `_loadTheme`)
- PR17/18 : sweep JS automatique de TOUS les `var(--legacy)` et hex hardcodés (~490 substitutions)
- PR24 : `modules-grid` (6 module-cards emoji) **supprimé du Hub** — la nav passe par la topbar
- PR26 : sidebar verticale **remplacée** par topbar horizontale
- PR27-29-34 : sweep nucléaire emojis (lang.js + tous JS modules) — UI 100% text/iconography mono
- PR31 (backend) : CSP `img-src` étendu pour autoriser `forgecdn.net` + `cdn.modrinth.com` + Steam Workshop + Spigot CDN (modpack thumbnails)
- PR33 : login.html aligné sur topbar Bento (brand `O OMENSERVER` + pill FR/EN/IT)

**Évolution session 27 mai (aftermath sweep nucléaire)** :
- PR35 : 4 boutons devenus vides après PR34 (boutons emoji-only → emoji strippé → contenu vide). Fix : labels texte i18n via `Lang.t()` partout, créer les clés manquantes (`sharing.share_btn`, `sv.files.rename`). Aussi : supprimé `.sharing-search-wrap::before { content: '🔍' }` + migré vars CSS legacy (`--bg-primary`, `--accent-blue`) vers tokens Bento.
- PR35-bis : oubli cache-bust JS individuels — bumper seulement `style.css?v=` + `sw CACHE_NAME` ne propage pas les fixes JS car le disk cache browser sert encore `lang.js?v=N` (URL inchangée). Toujours bumper le `?v=` de chaque JS modifié dans `index.html`.
- PR36 : 2 nouveaux symptômes post-PR35 (Massii spotted) — boutons serveur "Arrêter/Redémarrer/Partager" superposés (`.btn-icon` force 38×38px, texte déborde) + boutons Clé API Agents vides (👁/📋 strippés + code `cond ? '' : ''` smell). Fix : retirer `.btn-icon` quand on met du texte + labels i18n sur toggle/copy + placeholder masqué = 40 bullets `•`.

**Évolution session 28 mai (topbar → dropdown profil)** :
- PR37 : tab "Paramètres" inaccessible (caché derrière `.topbar-right` par overflow-x: auto). Solution > déplacer Paramètres + Déconnexion dans un dropdown sous le `.user-pill` (avatar+nom+rôle+caret ▾). Nouveau composant `.user-menu` : position absolute top:100%+8px right:0, animation `user-menu-in` 140ms (fade+translate), shadow `rgba(0,0,0,0.35)`. JS : `App._toggleUserMenu()` + click-outside (capture phase, armé/désarmé à l'ouverture) + Esc handler + restore focus. `Lang.set()` appelle maintenant `App.updateUserInfo()` pour rafraîchir les labels du dropdown au switch FR/EN/IT (les éléments statiques de la topbar n'étaient pas re-traduits avant). Aussi : `min-width: 0` sur `.nav-tabs` (flex children scrollables nécessitent ça pour shrink correctement).
- PR38 : extension de PR37 — "Utilisateurs" (auparavant tab admin-only `display:none`) rejoint le même dropdown au-dessus de Paramètres. Visibility via `item.hidden = !user.is_admin` (toggle propre, pas `style.display` inline). Ordre menu : **admin > self > danger** (séparateur hairline avant le danger). Pattern à généraliser : *toute action account-scope future* (changer mdp, switch user, sessions actives, etc.) doit atterrir dans ce même dropdown.

**Pour migrer un composant non-encore-refactoré** :
1. Identifie son HTML render dans `frontend/js/*_module.js` ou `app.js`
2. Remplace ses classes legacy par les classes Bento ci-dessus
3. Supprime les inline `style="..."` (les classes font le boulot)
4. Supprime les overrides `!important` correspondants en bas de `style.css`
5. Bump `style.css?v=X` dans `index.html` + `CACHE_NAME` dans `sw.js`

### Référence design

- **Mockups interactifs** : `frontend/design-explorations/proposals.html` (5 directions comparison)
  et `frontend/design-explorations/proposals-v2.html` (Bento Tech 10-page mockup complet)
- **MASTER.md** : design system formel avec tokens, composants, plan migration
  (dans la branche `design/bento-tech-mockup`, pas sur `main`)
- **Backend RBAC** (source de vérité pour rôles, quotas, permissions) :
  [backend/auth/permissions.py:29](backend/auth/permissions.py:29)
- **Server view tabs logic** (conditionnels Plugins/Mods/Workshop par type) :
  [frontend/js/server_view.js:71](frontend/js/server_view.js:71)

---

## 📝 Historique récent

| Date | Changement |
|------|-----------|
| 2026-05-29 PM | 🛑 **Fix serveur de jeu « se rallume tout seul »** — la boucle auto-restart du `@app.on_event("startup")` de `main.py` rallumait TOUT conteneur arrêté sans lire `srv.status` → les serveurs éteints **volontairement** revenaient à chaque restart uvicorn (et chaque `git push` = auto-deploy/min = un restart) → impression de relance continue. Fix : `container.start()` seulement si état désiré `srv.status == "running"`, sinon laissé éteint. `GameServer.status` est conflaté (désiré+observé) ; `unless-stopped` coopère. Post-deploy : 1 dernier *Arrêter* manuel pour « coller ». Piège #34. |
| 2026-05-29 PM | 🎯 **Rating FITCH PAR ISIN — refonte, Brave abandonné** (demande Massii « fitch only ISIN »). API GraphQL `api.fitchratings.com` `search(term:ISIN,item:IDENTIFIERS)` via **curl_cffi** (empreinte TLS Chrome → passe le mur Cloudflare qui refusait httpx au handshake). ISIN unique → ZÉRO ambiguïté de nom. Note émetteur Long Term IDR (+ note du titre exact dispo). `WD`/non-noté → ∅. Bunds→AAA (étaient BBB faux !), sovereigns OK. Retry anti-challenge Cloudflare (unreachable après 5 échecs). Cellule G Excel = lien `fitchratings.com/search/?query=<ISIN>`. Modules `scanner/fitch_isin.py` + `yield-bot/scraper/rating_fetcher.py` (`select_isin_rating`). ⚠️ `pip install curl_cffi` requis sur l'Omen (auto-deploy ne réinstalle pas). 112 tests ✓ (fixtures Fitch réelles). Validé live : Oncor BBB+, Bund AAA, Mercedes ∅(WD), bidon ∅. Piège #33 (supersede #29/#31/#32). |
| 2026-05-29 | 🩹 Fix rating WRONG-ISSUER (2 bots) — `site:fitchratings.com {issuer}` extrayait le rating d'une AUTRE entité quand Fitch ne notait pas l'émetteur (`Iccrea Banca` → `Fitch Affirms ICBC 'A'` → faux 'A'). Garde-fou d'identité `_issuer_matches_hit` (token identitaire dans titre/URL, match par token). Bond Scanner : rating obligatoire (bond sans rating vérifié exclu) + cellule G = **lien hypertexte Fitch** (vérifiable à la main). Yield Bot : faux positifs → `?`. Fix annexe : réserve Brave lisait `remaining 0` du plan métré (50 req/s, cap mensuel 0) comme épuisée → bloquait les scans ; on ne déclenche la réserve que si limite mensuelle > 0. Caches empoisonnés vidés. 91 tests ✓ (régression fixtures Brave réelles). Validé live : Iccrea→∅, Dominion→BBB+, Bayerische→A-. Pièges #31 + #32. |
| 2026-05-28 PM | 🔍 Bond Scanner V2 — refonte complète validée end-to-end en prod. (1) Pagination headless réparée via dispatch d'événements pointer (piège #30) : 25→1500 bonds. (2) Extraction listing (name.originalValue + coupon + maturité) → 97% sans enrich → ratissage rapide. (3) Best-N trié RATING DESC (slider 1-100). (4) 3 stores dédup : found (permanent) + seen (rejetés 60j) + rating cache (30j) ; overflow revient. (5) Garde-fou réserve Brave ≤50 (réservées au Yield Bot, clé partagée) → arrêt + blocage lancement. (6) Scan détaché (survit aux reloads), timeout 45min, banner Excel partiel. 79 tests ✓. 1er Excel prod : 30 bonds EUR yield≥4% triés AA-→BBB. |
| 2026-05-28 | 🔍 Bond Scanner — port stratégie rating Brave/Fitch-only (mirror Yield Bot). Strip cascade 5-providers (`DeutscheBoerseApiProvider`/`BoerseFrankfurtHtmlProvider`/`IssuerReferenceProvider`/`BoerseStuttgartProvider`/`FitchRatingsProvider`) → single `BraveFitchProvider` async. Cache 30j + negative caching (issuers Fitch-uncovered cachés aussi). Cellule Excel vide si pas de Fitch. Tests 18/18 ✓. Smoke OK : Dominion BBB+, Stryker ∅. |
| 2026-05-28 | ✨ PR 38 — Utilisateurs (admin-only) rejoint le dropdown profil au-dessus de Paramètres ; tab nav supprimé |
| 2026-05-28 | ✨ PR 37 — Topbar dropdown profil : Paramètres + Déconnexion sortent de la nav-tabs et vivent sous le `.user-pill` (caret ▾, aria-haspopup, click-outside, Esc, animation 140ms) |
| 2026-05-28 | 🏦 Activation rating fetcher Yield Bot — Brave Search API ciblée `site:fitchratings.com` (Fitch-only strict). 5/7 ratings "Da papà" extraits (Dominion ×2, Broadcom, IBM, AstraZeneca) ; Hilton/Stryker → cellule intacte (Fitch ne couvre pas). Coût $0/mois (free credits 1000 req). Clé stockée Keychain + `.env` gitignored. |
| 2026-05-27 | 🩹 PR 36 — Fix btn-icon trap (boutons serveur superposés) + Clé API Agents (👁/📋 strippés, labels i18n + 40 bullets placeholder) |
| 2026-05-27 | 🧹 PR 35-bis — Bump `?v=` JS individuels (lang/game_server/sv_files/server_view/app) oublié dans PR35 |
| 2026-05-27 | 🩹 PR 35 — Fix 4 boutons vides post-PR34 : `sharing.share_btn` raw, boutons search Mods/Modpack, loupe modale Partage, actions fichiers (renommer/supprimer) |
| 2026-05-26 PM | 🔇 PR 34 — Nuclear emoji sweep lang.js + tous JS + login.html (~720 bytes strippés) |
| 2026-05-26 PM | 🚪 PR 33 — Login page full Bento (brand `O OMENSERVER` + pill FR/EN/IT, plus de gradient text) |
| 2026-05-26 PM | 🔄 PR 32 — Background bots poller cross-page (`App._activeJobs` + `.tab-badge` + toast notif) |
| 2026-05-26 PM | 🖼️ PR 31 (backend) — CSP `img-src` étendu (forgecdn/modrinth/Steam Workshop/Spigot CDNs) |
| 2026-05-26 PM | 🔇 PR 27-30 — Strip emojis bots / modules / server pages (`YLD`/`SCN`/`CST` tickers, text-only buttons) |
| 2026-05-26 PM | 🏗️ PR 26 — Sidebar → topbar nav horizontale (10 tabs, brand+pill+user-pill à droite) |
| 2026-05-26 PM | 🏠 PR 24 — Real Bento Hub : kill big emoji module-cards, add `.machines-grid` + `.row-list` |
| 2026-05-26 PM | 🧹 PR 17-23 — Sweeps JS automatiques (legacy vars, hex, gradients, glassmorphism, ✅ backend Toast msgs) |
| 2026-05-26 PM | 🩺 PR 12-19 — Bento Tech polish autonome (themes legacy purge, RBAC emojis, login PR15, app.js sweep PR16) |
| 2026-05-26 | 🎨 Refonte frontend Bento Tech v5 — 11 PRs (tokens, composants, Dashboard, Server view, modules) |
| 2026-05-26 | 🎨 PR 11 — Polish autofill / form-input / avatars / danger icons |
| 2026-05-26 | 🎨 PR 10 — Game server list `.server-item` overrides Bento |
| 2026-05-26 | 🎨 PR 9 — Network module `.bento-overview` stats + speedtest |
| 2026-05-26 | 🎨 PR 8 — Bots module HTML refactor en `.bot-card-bento` |
| 2026-05-26 | 🎨 PR 7 — Override massif legacy classes (217 !important) |
| 2026-05-26 | 🎨 PR 6 — 15 composants restants + fix `.diag-item.err` bg |
| 2026-05-26 | 🎨 PR 5 — Server view sidebar 240px (strip inline styles) |
| 2026-05-26 | 🎨 PR 4 — Dashboard refactor + Diagnostic strip API |
| 2026-05-26 | 🎨 PR 3 — Accent switcher 4 dots + legacy theme migration |
| 2026-05-26 | 🎨 PR 2 — 11 composants atomiques + composés (`.badge`, `.role-pill`, etc.) |
| 2026-05-26 | 🎨 PR 1 — Tokens Bento Tech + Geist Mono import (additif) |
| 2026-05-18 | 🌙 Reboot post-suspend pour RAM fraîche (omen-resume.sh v2) |
| 2026-05-18 | 🏦 Fix Bond Scanner : ségrégation devise EUR/USD dans les rapports Excel |
| 2026-05-17 | 🔒 Audit sécurité complet : JWT secret, Docker shell injection, path traversal, RBAC |
| 2026-05-17 | 🛡️ Rate limiter IP-based + clés API masquées dans le dashboard |
| 2026-05-16 | 🏦 Optimisation Bond Scanner : pagination, retry logic, provider errors |
| 2026-05-15 | 🌙 Fix réveil automatique 6h + omen-resume.sh (restart cloudflared/omenserver) |
| 2026-05-15 | 🏦 Bond Scanner : download Excel fiable + slider config UI |
| 2026-05-14 | 🔌 Module Accès : SFTP conteneurisé par serveur + fix JS template literals |
| 2026-05-14 | 🔧 Fix Reboot/Shutdown : body JSON vide + Toast persistent + sudo validation |
| 2026-05-13 | 🖥️ Module Réseau admin-only + nodes grid déplacée + fix ping diagnostic |
| 2026-05-12 | 🖥️ Omen cerveau visible dans la grille machines + stats combinées (CPU/RAM/Temp) |
| 2026-05-12 | 🔌 Boutons reboot/shutdown sur carte Omen + diagnostic crash nodes |
| 2026-05-10 | 🖥️ Multi-machines : stockage combiné + mini-listes + auto-deploy |
| 2026-05-10 | 💾 Extension disque LVM (98→914 Go) + formatage SSD NVMe (469 Go) |
| 2026-05-10 | 🌐 Cloudflare Tunnel → omenserver.org + service systemd |
| 2026-05-08 | 🔧 Fix bcrypt (passlib → bcrypt direct) |
| 2026-05-07 | 🏦 Intégration Bot Yield (backend + frontend + CSS + i18n) |
| 2026-05-07 | 🔒 Security headers + CORS restreint + Swagger désactivé |
| 2026-05-06 | 🖥️ Déploiement Ubuntu Server sur HP Omen |
| 2026-05-05 | 🌍 Internationalisation FR/EN/IT complète |
| 2026-05-04 | 🔧 Navigation fix, logs persistants, stabilisation |
| 2026-05-01 | 🎨 V3 → V4 : Modules Média, Web, Réseau, PWA |
