# 🎮 OmenServer

> **Panel de gestion de serveurs de jeux** — Déploie et gère tes serveurs Minecraft, ARK, Valheim et plus via Docker.

<div align="center">

![Python](https://img.shields.io/badge/Python-3.9+-3776AB?style=for-the-badge&logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-003B57?style=for-the-badge&logo=sqlite&logoColor=white)

</div>

---

## ✨ Fonctionnalités

### 🎮 Serveurs de Jeux
- **9 jeux supportés** : Minecraft Java, Minecraft Bedrock, ARK, Valheim, Terraria, CS2, Palworld, Garry's Mod, et jeux personnalisés
- **Déploiement Docker en un clic** — Crée, démarre, arrête et supprime tes serveurs
- **Console live WebSocket** — Envoie des commandes en temps réel (rcon-cli)
- **Monitoring** — CPU, RAM, disque, réseau en temps réel

### 🔧 Gestion Avancée
- **⚙️ Ressources** — Sliders RAM (256 Mo → 8 Go) et CPU (25% → 400%) par serveur
- **💾 Sauvegardes** — Créer, restaurer, supprimer des backups tar.gz + rotation automatique
- **⏰ Tâches planifiées** — Backups et redémarrages automatiques (APScheduler)
- **🧩 Mods CurseForge** — Recherche, installe et gère tes mods Minecraft

### 👥 Multi-Utilisateurs
- **4 rôles** : Spectateur, Joueur, Modérateur, Administrateur
- **Système d'invitations** — Génère des codes/liens d'invitation avec rôles
- **Auth JWT** — Connexion sécurisée avec tokens

---

## 🚀 Installation

### Prérequis
- Python 3.9+
- Docker (installé et lancé)
- pip

### 1. Cloner le projet
```bash
git clone https://github.com/TON_USERNAME/OmenServer.git
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
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
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

---

## 📁 Structure du Projet

```
OmenServer/
├── backend/
│   ├── main.py              # Point d'entrée FastAPI
│   ├── config.py             # Configuration
│   ├── database.py           # SQLAlchemy + SQLite
│   ├── auth/                 # Authentification JWT + Invitations
│   │   ├── router.py         # Login, register, change password
│   │   ├── invite_router.py  # Invitations + gestion utilisateurs
│   │   ├── models.py         # User, Invitation
│   │   ├── permissions.py    # Système de rôles (4 niveaux)
│   │   └── utils.py          # JWT helpers
│   ├── game_server/          # Serveurs de jeux
│   │   ├── router.py         # CRUD serveurs + ressources
│   │   ├── docker_manager.py # Interface Docker SDK
│   │   ├── games_config.py   # Config des 9 jeux supportés
│   │   ├── websocket.py      # Console live WebSocket
│   │   ├── backup_manager.py # Sauvegardes tar.gz
│   │   └── backup_router.py  # API sauvegardes
│   ├── scheduler/            # Tâches planifiées
│   │   ├── engine.py         # APScheduler engine
│   │   ├── models.py         # ScheduledTask
│   │   └── router.py         # API CRUD tâches
│   ├── mods/                 # Mods CurseForge
│   │   ├── curseforge.py     # Client API CurseForge
│   │   └── router.py         # API recherche/install/suppression
│   ├── monitoring/           # Monitoring système
│   └── modules/              # Gestion des modules
├── frontend/
│   ├── index.html            # Page principale
│   ├── login.html            # Page de connexion
│   ├── css/style.css         # Design dark theme
│   └── js/
│       ├── app.js            # Routeur frontend
│       ├── auth.js           # Auth + API calls
│       ├── game_server.js    # UI serveurs + modals
│       ├── monitoring.js     # Dashboard monitoring
│       └── modules.js        # Liste des modules
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

## 👥 Système de Rôles

| Rôle | Permissions |
|------|------------|
| 👀 Spectateur | Voir les serveurs |
| 🎮 Joueur | + Démarrer, arrêter, redémarrer |
| 🔧 Modérateur | + Console, backups, logs |
| 👑 Administrateur | + Créer, supprimer, configurer, inviter |

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

</div>
