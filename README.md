# 🎮 OmenServer

> **Panel de gestion de serveur dédié polyvalent** — Serveurs de jeux, bots Python, sites web, monitoring multi-machines et plus.
>
> 🌐 **[omenserver.org](https://omenserver.org)**

<div align="center">

![Python](https://img.shields.io/badge/Python-3.9+-3776AB?style=for-the-badge&logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-003B57?style=for-the-badge&logo=sqlite&logoColor=white)
![Cloudflare](https://img.shields.io/badge/Cloudflare-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)
![Version](https://img.shields.io/badge/Version-4.3-10b981?style=for-the-badge)

</div>

---

## ✨ Fonctionnalités

### 🎮 Serveurs de Jeux
- **9 jeux supportés** : Minecraft Java, Minecraft Bedrock, ARK, Valheim, Terraria, CS2, Palworld, Garry's Mod, et jeux personnalisés
- **Déploiement Docker en un clic** — Crée, démarre, arrête et supprime tes serveurs
- **Console live WebSocket** — Envoie des commandes en temps réel (rcon-cli)
- **Monitoring** — CPU, RAM, disque, réseau en temps réel

### 🤖 Bots & Automatisation
- **5 types de bots** : Trading, Gaming, Scraper, Analyse, Custom
- **Éditeur de code intégré** — Tab, Ctrl+S, coloration syntaxique
- **Logs en temps réel** — Console avec numéros de ligne + persistance fichier
- **Start/Stop** — Gestion des processus Python avec capture stdout
- **🏦 Bot Yield** — Calcul automatique de rendement d'obligations (Excel)

### 📁 Fichiers & Cloud
- **Google Drive intégré** — OAuth2 avec redirect localhost
- **Navigation Drive** — Parcours tes dossiers et fichiers
- **Upload & Download** — Transfère des fichiers entre serveur et Drive

### 🖥️ Infrastructure Multi-Machines
- **Architecture cerveau/bras** — L'Omen est le serveur central, les autres PC sont des agents
- **Agent léger** — `omen_agent.py` à installer sur chaque PC (CPU, RAM, Disque, Temp)
- **Stockage combiné** — Le dashboard fusionne le stockage de tous les disques et tous les PC
- **Mini-listes par machine** — Chaque carte du dashboard détaille les stats par PC
- **Commandes à distance** — Redémarrer ou éteindre n'importe quel PC depuis le dashboard
- **Auto-deploy** — Les changements Git sont déployés automatiquement en < 1 minute

### 🩺 Diagnostic Automatique
- **Analyse en temps réel** — CPU, RAM, Disque, Docker, Réseau
- **Code couleur** — OK (vert), Warning (jaune), Critique (rouge)
- **Suggestions** — Correctifs proposés pour chaque problème

### 📺 Média & Streaming
- **Jellyfin intégré** — Serveur multimédia open-source via Docker
- **Setup en un clic** — Déploiement automatique du conteneur
- **Bibliothèques** — Films, Séries, Musique avec gestion des dossiers

### 🌐 Serveur Web
- **Multi-sites** — Héberger plusieurs sites/APIs en parallèle
- **4 types supportés** — Statique (Nginx), Node.js, PHP (Apache), Python
- **📦 Git Clone** — Déploie un site depuis n'importe quel repo Git
- **Docker isolé** — Chaque site = 1 conteneur indépendant

### 📡 Monitoring Réseau
- **Surveillance 24/7** — Latence, IP publique, qualité de connexion
- **Speed Test** — Test de débit intégré
- **Wake-on-LAN** — Allumer d'autres PC à distance via magic packet

### 📱 PWA & Accès Distant
- **Progressive Web App** — Installable sur mobile et bureau
- **Cloudflare Tunnel** — Accès sécurisé depuis n'importe où (HTTPS)
- **Auto-deploy** — Cron + Git pull automatique toutes les minutes
- **Système d'invitations** — URL publique mais accès sur invitation uniquement

### 🔧 Gestion Avancée
- **⚙️ Ressources** — Sliders RAM (256 Mo → 8 Go) et CPU (25% → 400%) par serveur
- **💾 Sauvegardes** — Créer, restaurer, supprimer des backups tar.gz + rotation automatique
- **⏰ Tâches planifiées** — Backups et redémarrages automatiques (APScheduler)
- **🧩 Mods CurseForge** — Recherche, installe et gère tes mods Minecraft
- **🎨 5 thèmes** — Défaut, Midnight, Emerald, Crimson + Light Mode
- **🌍 3 langues** — Français, English, Italiano

### 🌙 Gestion de l'énergie
- **Extinction automatique** — Suspend-to-RAM à 1h du matin (configurable)
- **Réveil BIOS** — RTC wake à 6h du matin (configurable)
- **Reboot post-réveil** — RAM vidée pour un démarrage frais chaque matin
- **Arrêt gracieux** — Backup serveurs + stop Docker + stop bots avant extinction

### 🔒 Sécurité
- **Rate limiter** — Protection IP-based contre les abus
- **RBAC** — Contrôle d'accès par serveur et par rôle
- **CSP + Security headers** — Protection contre injection et XSS
- **Clés API masquées** — Show/hide toggle dans le dashboard

### 🧩 Mods & Plugins
- **CurseForge** — Recherche et installe des mods Minecraft
- **Steam Workshop** — Mods pour ARK, CS2, Garry’s Mod
- **Plugins Spigot/Paper** — Plugins Minecraft avec gestion des versions
- **Datapacks** — Datapacks Minecraft

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

## 🖥️ Ajouter un PC au réseau

Voir le guide complet : **[docs/Guide_Installation_PC_OmenServer.md](docs/Guide_Installation_PC_OmenServer.md)** (FR) | **[IT](docs/Guide_Installation_PC_OmenServer_IT.md)**

En résumé, **une seule commande** :
```bash
curl -sL https://raw.githubusercontent.com/Massii-08/OmenServer/main/tools/setup_omen_agent.sh \
  | sudo bash -s -- TA_CLE_API
```

Le script fait tout automatiquement :
- ✅ Installe Python, pip, dépendances
- ✅ Télécharge et configure l'agent
- ✅ Crée le service systemd (démarrage automatique)
- ✅ Active le PC avec le couvercle fermé (laptop)
- ✅ Programme la suspension 1h→6h avec réveil BIOS
- ✅ Installe le reboot post-réveil (RAM vidée)
- ✅ Étend le disque LVM au maximum
- ✅ Propose de formater un 2è disque (optionnel)

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
│   ├── bots/                 # 🤖 Module Bots + Yield Bot
│   ├── gdrive/               # 📁 Module Google Drive
│   ├── monitoring/           # Monitoring + Diagnostic + Nodes
│   │   ├── router.py         # /api/monitoring/stats (CPU, RAM, disque combiné)
│   │   ├── system_info.py    # Collecte multi-disques psutil
│   │   ├── nodes_router.py   # /api/nodes — PC connectés via agents
│   │   └── diagnostic_router.py
│   ├── media/                # Module Média (Jellyfin)
│   ├── webserver/            # Module Serveur Web
│   ├── network/              # Module Réseau (WoL, ping)
│   ├── scheduler/            # Tâches planifiées (APScheduler)
│   ├── modules/              # Hub des modules
│   └── notifications/        # Notifications
├── frontend/
│   ├── index.html            # Shell SPA principal
│   ├── login.html            # Page de connexion
│   ├── css/style.css         # Design system (5 thèmes, variables CSS)
│   └── js/
│       ├── app.js            # Routeur SPA + Dashboard
│       ├── auth.js           # Auth JWT + API calls
│       ├── lang.js           # i18n FR/EN/IT
│       ├── monitoring.js     # Dashboard monitoring (stats combinées)
│       └── ...               # Modules: bots, files, media, web, network
├── tools/
│   └── omen_agent.py         # 🦾 Agent à installer sur chaque PC
├── docs/
│   └── Guide_Installation_PC_OmenServer.md  # Guide complet (PDF-ready)
├── data/                     # Base SQLite + données serveurs
├── requirements.txt
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

## 🏗️ Infrastructure de Production

| Composant | Détail |
|-----------|--------|
| **Serveur** | HP Omen (Ubuntu Server 26.04 LTS) |
| **Stockage** | HDD 914 Go + SSD NVMe 469 Go = **1.3 To** |
| **Accès distant** | Cloudflare Tunnel → `omenserver.org` |
| **Service systemd** | `omenserver.service` — démarre au boot |
| **Auto-deploy** | Cron → `git pull` + `restart` toutes les minutes |
| **Power Management** | Suspend 1h → Wake 6h → Reboot (RAM clear) |
| **Agents** | `omen_agent.py` sur chaque PC du réseau |

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

*OmenServer V4.3 — L'Omen est le cerveau, les autres PC sont les bras*

</div>
