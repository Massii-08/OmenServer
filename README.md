# 🎮 OmenServer

> **Panel de gestion de serveur dédié polyvalent** — Serveurs de jeux, bots Python, sites web, accès distant et plus.
>
> 🌐 **[omenserver.org](https://omenserver.org)**

<div align="center">

![Python](https://img.shields.io/badge/Python-3.9+-3776AB?style=for-the-badge&logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-003B57?style=for-the-badge&logo=sqlite&logoColor=white)
![Version](https://img.shields.io/badge/Version-4.0-10b981?style=for-the-badge)

</div>

---

## ✨ Fonctionnalités

### 🎮 Serveurs de Jeux
- **9 jeux supportés** : Minecraft Java, Minecraft Bedrock, ARK, Valheim, Terraria, CS2, Palworld, Garry's Mod, et jeux personnalisés
- **Déploiement Docker en un clic** — Crée, démarre, arrête et supprime tes serveurs
- **Console live WebSocket** — Envoie des commandes en temps réel (rcon-cli)
- **Monitoring** — CPU, RAM, disque, réseau en temps réel

### 🤖 Bots & Automatisation (V3)
- **5 types de bots** : Trading, Gaming, Scraper, Analyse, Custom
- **Éditeur de code intégré** — Tab, Ctrl+S, coloration syntaxique
- **Logs en temps réel** — Console avec numéros de ligne + persistance fichier
- **Start/Stop** — Gestion des processus Python avec capture stdout

### 📁 Fichiers & Cloud (V3)
- **Google Drive intégré** — OAuth2 avec redirect localhost
- **Navigation Drive** — Parcours tes dossiers et fichiers
- **Upload & Download** — Transfère des fichiers entre serveur et Drive

### 🩺 Diagnostic Automatique (V3)
- **Analyse en temps réel** — CPU, RAM, Disque, Docker, Réseau
- **Code couleur** — OK (vert), Warning (jaune), Critique (rouge)
- **Suggestions** — Correctifs proposés pour chaque problème

### 📺 Média & Streaming (V4)
- **Jellyfin intégré** — Serveur multimédia open-source via Docker
- **Setup en un clic** — Déploiement automatique du conteneur
- **Bibliothèques** — Films, Séries, Musique avec gestion des dossiers
- **Monitoring** — CPU, RAM du conteneur en temps réel

### 🌐 Serveur Web (V4)
- **Multi-sites** — Héberger plusieurs sites/APIs en parallèle
- **4 types supportés** — Statique (Nginx), Node.js, PHP (Apache), Python
- **📦 Git Clone** — Déploie un site depuis n'importe quel repo Git
- **Docker isolé** — Chaque site = 1 conteneur indépendant
- **Logs en temps réel** — Console avec historique

### 📡 Monitoring Réseau (V4)
- **Surveillance 24/7** — Latence, IP publique, qualité de connexion
- **Speed Test** — Test de débit intégré
- **Historique** — Graphique de latence sur 24h
- **Wake-on-LAN** — Allumer d'autres PC à distance via magic packet

### 📱 PWA & Accès Distant (V4)
- **Progressive Web App** — Installable sur mobile et bureau
- **Service Worker** — Fonctionne hors-ligne (cache Network-first)
- **Cloudflare Tunnel** — Accès sécurisé depuis n'importe où (HTTPS)
- **Système d'invitations** — URL publique mais accès sur invitation uniquement

### ⚡ Monitoring Avancé (V4)
- **Mini-logs dashboard** — 15 dernières lignes de log avec coloration
- **Alertes système** — CPU, RAM, disque, température avec Toast notifications
- **Cooldown anti-spam** — 1 alerte par minute par type

### 🔧 Gestion Avancée
- **⚙️ Ressources** — Sliders RAM (256 Mo → 8 Go) et CPU (25% → 400%) par serveur
- **💾 Sauvegardes** — Créer, restaurer, supprimer des backups tar.gz + rotation automatique
- **⏰ Tâches planifiées** — Backups et redémarrages automatiques (APScheduler)
- **🧩 Mods CurseForge** — Recherche, installe et gère tes mods Minecraft
- **🎨 4 thèmes** — Défaut, Midnight, Emerald, Crimson + Light Mode

### 👥 Multi-Utilisateurs
- **4 rôles** : Spectateur, Joueur, Modérateur, Administrateur
- **Système d'invitations** — Codes/liens d'invitation avec rôles
- **Auth JWT** — Connexion sécurisée avec tokens

---

## 🚀 Installation

### Prérequis
- Python 3.9+
- Docker (installé et lancé)
- pip

### 1. Cloner le projet
```bash
git clone https://github.com/Massii-08/OmenServer.git
cd OmenServer
```

### 2. Environnement virtuel
```bash
python3 -m venv venv
source venv/bin/activate  # macOS/Linux
# venv\Scripts\activate   # Windows
```

### 3. Installer les dépendances
```bash
pip install -r requirements.txt
# Pour Google Drive (optionnel) :
pip install google-api-python-client google-auth-oauthlib google-auth-httplib2
```

### 4. Configurer
```bash
cp .env.example .env
# Édite .env avec tes réglages (clé secrète, API CurseForge, etc.)
```

### 5. Lancer
```bash
uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Ouvre **http://localhost:8000** dans ton navigateur 🎉

---

## ⚙️ Configuration (.env)

| Variable | Description | Défaut |
|----------|-------------|--------|
| `SECRET_KEY` | Clé secrète JWT | `change-moi-...` |
| `SERVER_NAME` | Nom affiché dans le panel | `OmenServer` |
| `TOKEN_EXPIRE_MINUTES` | Durée du token (min) | `1440` (24h) |
| `PORT` | Port du serveur | `8000` |
| `CURSEFORGE_API_KEY` | Clé API CurseForge (optionnel) | — |

> 🔑 Obtiens ta clé CurseForge gratuitement sur [console.curseforge.com](https://console.curseforge.com/)

### Google Drive (optionnel)

1. Va sur [console.cloud.google.com](https://console.cloud.google.com/)
2. Crée un projet → Active "Google Drive API"
3. Crée un client OAuth **"Application Web"**
4. URI de redirection : `http://localhost:8000/api/gdrive/oauth-redirect`
5. Télécharge le JSON → renomme en `credentials.json`
6. Place-le dans `~/omenserver/gdrive/credentials.json`
7. Dans le panel, va sur Fichiers & Cloud → Connecter

---

## 📁 Structure du Projet

```
OmenServer/
├── backend/
│   ├── main.py              # Point d'entrée FastAPI
│   ├── config.py             # Configuration
│   ├── database.py           # SQLAlchemy + SQLite
│   ├── auth/                 # Authentification JWT + Invitations
│   ├── game_server/          # Serveurs de jeux (Docker, WebSocket, Backups)
│   ├── bots/                 # 🤖 Module Bots (V3)
│   │   ├── router.py         # CRUD + Start/Stop + Logs + Code editor
│   │   └── models.py         # Bot model
│   ├── gdrive/               # 📁 Module Google Drive (V3)
│   │   └── router.py         # OAuth + Files + Upload/Download
│   ├── monitoring/           # Monitoring + Diagnostic (V3)
│   │   └── diagnostic_router.py
│   ├── scheduler/            # Tâches planifiées (APScheduler)
│   ├── mods/                 # Mods CurseForge
│   ├── modules/              # Gestion des modules
│   └── notifications/        # Notifications
├── frontend/
│   ├── index.html            # Page principale
│   ├── login.html            # Page de connexion
│   ├── css/style.css         # Design dark theme (4 thèmes)
│   └── js/
│       ├── app.js            # Routeur frontend + thèmes
│       ├── auth.js           # Auth + API calls
│       ├── game_server.js    # UI serveurs
│       ├── server_view.js    # Vue détaillée serveur
│       ├── bots_module.js    # 🤖 UI Bots (V3)
│       ├── files_module.js   # 📁 UI Fichiers (V3)
│       ├── media_module.js   # 📺 UI Média (V4)
│       ├── web_module.js     # 🌐 UI Serveur Web (V4)
│       ├── network_module.js # 📡 UI Réseau (V4)
│       ├── monitoring.js     # Dashboard monitoring
│       └── modules.js        # Hub des modules
├── requirements.txt
├── .env.example
└── README.md
```

---

## 🎮 Jeux Supportés

| Jeu | Image Docker | Port | RAM min |
|-----|-------------|------|---------|
| ⛏️ Minecraft Java | `itzg/minecraft-server` | 25565 | 2 Go |
| 🪨 Minecraft Bedrock | `itzg/minecraft-bedrock-server` | 19132 | 1 Go |
| 🦖 ARK: Survival Evolved | `hermsi/ark-server` | 27015 | 4 Go |
| ⚔️ Valheim | `lloesche/valheim-server` | 2456 | 2 Go |
| 🌳 Terraria | `ryshe/terraria` | 7777 | 1 Go |
| 🔫 Counter-Strike 2 | `joedwards32/cs2` | 27015 | 2 Go |
| 🐾 Palworld | `thijsvanloef/palworld-server-docker` | 8211 | 4 Go |
| 🔧 Garry's Mod | `ich777/steamcmd:gmod` | 27015 | 2 Go |
| 🎮 Personnalisé | (ton image) | — | — |

---

## 📂 Stockage

Toutes les données sont stockées dans `~/omenserver/` :

| Dossier | Contenu |
|---------|---------|
| `~/omenserver/bots/` | Scripts Python des bots |
| `~/omenserver/bots/logs/` | Logs persistants des bots |
| `~/omenserver/gdrive/` | Credentials + Token Google Drive |
| `~/omenserver/downloads/` | Fichiers téléchargés depuis Drive |
| `~/omenserver/media/` | Films, séries, musique (Jellyfin) |
| `~/omenserver/jellyfin/` | Config et cache Jellyfin |
| `~/omenserver/websites/` | Fichiers source des sites web |

---

## 🛠️ API REST

L'API complète est documentée automatiquement par FastAPI :

- **Swagger UI** : http://localhost:8000/docs
- **ReDoc** : http://localhost:8000/redoc

---

## 📜 Licence

Ce projet est sous licence MIT. Voir le fichier [LICENSE](LICENSE) pour plus de détails.

---

<div align="center">

**Fait avec ❤️ par Massimiliano**

*OmenServer V4 — L'Écosystème*

</div>
