# CLAUDE.md — OmenServer Project Context

> **Ce fichier sert de mémoire persistante pour tout agent IA (Claude, Gemini, etc.)**
> **travaillant sur ce projet. Lire intégralement avant toute modification.**

---

## 🏗️ Vue d'ensemble

**OmenServer** est un panel de gestion de serveur dédié polyvalent, inspiré de Minestrator/Pterodactyl.
Il permet de gérer des serveurs de jeux (Minecraft, etc.), des bots Python, des médias, un serveur web,
et le monitoring système depuis une interface web premium.

- **Version** : 4.0.0
- **Auteur** : Massii_08 (Massimiliano)
- **License** : MIT
- **Hardware cible** : HP Omen (Ubuntu Server en prod, macOS en dev)
- **Stack** : Python FastAPI (backend) + Vanilla JS/CSS (frontend) — **pas de framework JS**

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
│   │   ├── models.py           # User, Invitation (SQLAlchemy)
│   │   └── utils.py            # get_current_user(), hash/verify password
│   ├── monitoring/             # Monitoring système
│   │   ├── router.py           # /api/monitoring/stats (CPU, RAM, disque, temp)
│   │   ├── diagnostic_router.py # /api/monitoring/diagnostic
│   │   ├── container_router.py # /api/monitoring/containers (Docker)
│   │   └── nodes_router.py     # /api/nodes — PC connectés via omen_agent.py
│   ├── game_server/            # Gestion serveurs de jeux (Docker)
│   │   ├── router.py           # CRUD serveurs + start/stop/restart
│   │   ├── websocket.py        # WebSocket logs temps réel
│   │   ├── models.py           # GameServer (SQLAlchemy)
│   │   ├── backup_router.py    # Sauvegardes auto/manuelles
│   │   ├── settings_router.py  # server.properties, JVM args
│   │   ├── players_router.py   # Whitelist, ops, bans
│   │   ├── access_router.py    # SFTP/RCON credentials
│   │   └── files_router.py     # Navigateur de fichiers serveur
│   ├── bots/                   # Module Bots Python
│   │   ├── router.py           # CRUD bots + start/stop + logs
│   │   ├── models.py           # Bot (SQLAlchemy)
│   │   └── yield_router.py     # 🏦 Bot Yield dédié (upload, run, status, download)
│   ├── scheduler/              # Tâches planifiées (APScheduler)
│   │   ├── router.py           # CRUD tâches cron
│   │   ├── engine.py           # APScheduler engine
│   │   ├── models.py           # ScheduledTask
│   │   └── power_router.py     # Extinction/redémarrage programmé
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
│   └── activity/               # Historique d'activité
│       └── router.py
├── frontend/                   # Interface web (vanilla JS/CSS)
│   ├── index.html              # Shell SPA principal
│   ├── login.html              # Page de connexion (standalone)
│   ├── css/
│   │   └── style.css           # Design system complet (variables CSS, thèmes, composants)
│   ├── js/
│   │   ├── app.js              # Router SPA + Dashboard + App controller
│   │   ├── auth.js             # Auth.apiCall(), login/logout, token JWT
│   │   ├── lang.js             # i18n — FR/EN/IT (clés: modules.*, bots.*, yield.*, etc.)
│   │   ├── modules.js          # Hub des modules (cartes)
│   │   ├── monitoring.js       # Dashboard monitoring (CPU, RAM, graphiques)
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
├── data/                       # Données persistantes
│   ├── omenserver.db           # Base SQLite
│   └── servers/                # Données des serveurs de jeux
├── tools/                      # Scripts utilitaires
├── .env                        # Variables d'environnement (non commité)
├── .env.example                # Template des variables
├── requirements.txt            # Dépendances Python
├── watchdog.sh                 # Script de surveillance (prod)
└── README.md
```

---

## ⚙️ Stack technique

### Backend
| Technologie | Usage |
|-------------|-------|
| **FastAPI** 0.115 | Framework API REST |
| **SQLAlchemy** 2.0 | ORM — SQLite en local |
| **python-jose** | JWT pour l'authentification |
| **psutil** | Monitoring système (CPU, RAM, temp) |
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

### Infrastructure
| Composant | Détail |
|-----------|--------|
| **OS prod** | Ubuntu Server (HP Omen) |
| **OS dev** | macOS |
| **Python** | 3.9+ (venv dans `./venv/`) |
| **DB** | SQLite (`data/omenserver.db`) |
| **Docker** | Conteneurs pour les serveurs de jeux |
| **Cloudflared** | Tunnel Cloudflare (accès distant) |

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
- **Responsive** : breakpoints à 768px, 480px

### Internationalisation (lang.js)
- 3 langues : **FR**, **EN**, **IT**
- Accès via `Lang.t('clé.sous_clé')`
- Changement de langue via `Lang.setLang('en')` (persisté dans localStorage)
- Structure des clés : `common.*`, `nav.*`, `modules.*`, `bots.*`, `yield.*`, `servers.*`

### Authentification (auth.js)
- Token JWT stocké dans `localStorage`
- `Auth.apiCall(url, options)` ajoute automatiquement le header `Authorization: Bearer <token>`
- Détection automatique `FormData` → pas de `Content-Type: application/json`
- Bannière auto-reconnexion si le serveur est down

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
- Pattern de détection d'une obligation : `r'\[.+?:\d+\]'` (ex: `[USD:5]`, `[Feuille 1:12]`)
- Stats live : détection de `"Yield calcolato:"`, `"⚠️ Nessun prezzo"`, `"❌ Errore:"`
- Le fichier résultat est `*_AGGIORNATO.xlsx`
- Rate limit : max 5 scraping/jour (ricalcolo illimité)
- Variable d'environnement : `YIELD_BOT_DIR` (défaut: `~/omenserver/bots/yield-bot/`)

### Frontend Yield Bot
Le Yield Bot apparaît comme **une carte dans la grille des bots** (pas un bouton séparé).
Il a 3 états :
1. **Upload** : dropzone drag&drop, sélection de mode (⚡ recalcul / 🌐 scraping+recalcul)
2. **Running** : barre de progression animée, stats live (updated/skipped/errors), terminal logs
3. **Completed** : résumé, bouton téléchargement, option relancer

---

## 🔒 Sécurité

- **JWT** avec expiration configurable (défaut 24h)
- **CORS** restreint aux origines locales
- **Headers sécurité** : X-Frame-Options DENY, X-Content-Type-Options nosniff, XSS-Protection
- **Swagger/Redoc** désactivés en production (`docs_url=None`)
- **Upload** : validation `.xlsx` uniquement pour le Yield Bot
- **Rôles** : admin, moderator, player (via `User.role`)
- **Invitations** : inscription uniquement par code d'invitation

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

# Production (Ubuntu Server)
/home/omenserver/Projet\ serveur/venv/bin/python3 -m uvicorn backend.main:app --host 0.0.0.0 --port 8000

# Accès distant via Cloudflare Tunnel
./cloudflared tunnel run omenserver
```

---

## 📐 Conventions de code

### Backend (Python)
- **Routers** : un fichier `router.py` par module, préfixé `/api/<module>/`
- **Modèles** : SQLAlchemy dans `models.py` de chaque module
- **Auth** : `current_user: User = Depends(get_current_user)` sur chaque endpoint protégé
- **Logging** : `logger = logging.getLogger(__name__)` puis `logger.info/warning/error`
- **Docstrings** : en français ou italien, triple quotes

### Frontend (JS)
- **Modules** : objets globaux (`BotsModule`, `FilesModule`, etc.) avec `render(container)` + `unload()`
- **API calls** : toujours via `Auth.apiCall(url, options)` — jamais `fetch()` direct
- **i18n** : toujours `Lang.t('clé')` — jamais de texte hardcodé
- **DOM** : `innerHTML` pour le rendu, `document.getElementById()` pour les mises à jour
- **Pas de framework** : pas de React, Vue, jQuery — tout est vanilla JS

### CSS
- **Variables** : utiliser `var(--nom)` pour couleurs, bordures, transitions
- **Composants** : classes `.card`, `.btn`, `.btn-primary`, `.status-badge`, etc.
- **Nouveau module** : ajouter les styles dans `style.css` avec un commentaire séparateur

---

## ⚠️ Pièges connus

1. **Python 3.9** sur la machine de dev — attention aux syntaxes 3.10+ (`match`, `|` pour unions)
2. **SQLite** ne supporte pas `ALTER TABLE ... IF NOT EXISTS` — les migrations utilisent try/except
3. **Docker** doit être installé et le daemon actif pour les serveurs de jeux
4. **Playwright** + Chromium requis sur le serveur prod pour le scraping du Yield Bot
5. **FormData upload** : `Auth.apiCall` détecte automatiquement `FormData` et ne met pas `Content-Type: application/json`
6. **Auto-refresh des bots** : l'interval de 5s doit être clearé (`unload()`) avant de naviguer vers le Yield Bot

---

## 📝 Historique récent

| Date | Changement |
|------|-----------|
| 2026-05-07 | 🏦 Intégration Bot Yield (backend + frontend + CSS + i18n) |
| 2026-05-07 | 🔒 Security headers + CORS restreint + Swagger désactivé |
| 2026-05-06 | 🖥️ Déploiement Ubuntu Server sur HP Omen |
| 2026-05-05 | 🌍 Internationalisation FR/EN/IT complète |
| 2026-05-04 | 🔧 Navigation fix, logs persistants, stabilisation |
| 2026-05-01 | 🎨 V3 → V4 : Modules Média, Web, Réseau, PWA |
