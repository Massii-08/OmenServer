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
│   │   └── style.css           # Design system complet (variables CSS, 5 thèmes)
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

### Design System (style.css)
- **Variables CSS** dans `:root` pour les couleurs, espacements, transitions
- **5 thèmes** : default (violet sombre), midnight, emerald, crimson, light
- **Composants** : `.card`, `.btn`, `.stat-card`, `.status-badge`, `.console`, `.module-card`
- **Mini-listes machines** : `.stat-machines-list`, `.stat-machine-item` (dashboard multi-PC)
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

# SSH vers l'Omen (IP peut changer via DHCP — vérifier sur le routeur)
ssh massii08@192.168.68.72   # ou .66 selon le bail DHCP

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
| `.machines-grid` + `.machine-card` (+ `.brain`) | Network of machines (omen + agents) |
| `.users-table` (+ `.u-head/.u-row/.u-name`) | Tableau utilisateurs |
| `.tasks-table` | Scheduler global |
| `.mod-grid` + `.mod-card` | Plugin/Mod/Workshop browser |
| `.dropzone` | Upload zone |
| `.accent-switcher-mini` + `.accent-dot` | Switcher 4 couleurs dans sidebar footer |
| `.sv-layout` + `.sv-sidebar` + `.sv-tab` (+ `.active/.share/.danger`) | Server view sidebar |

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
