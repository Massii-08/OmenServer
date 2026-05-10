# 🖥️ Guide Complet — Ajouter un PC au réseau OmenServer

> **Version 1.0** — Mai 2026  
> Ce guide explique comment transformer n'importe quel PC (même avec Windows) en un "bras" connecté à OmenServer.  
> L'Omen reste le **cerveau** (serveur principal), les autres PC sont les **bras** (agents qui envoient leurs stats).

---

## 📑 Table des matières

1. [Prérequis](#1--prérequis)
2. [Créer la clé USB bootable Ubuntu](#2--créer-la-clé-usb-bootable-ubuntu)
3. [Installer Ubuntu Server](#3--installer-ubuntu-server)
4. [Premier démarrage — Configuration de base](#4--premier-démarrage--configuration-de-base)
5. [Activer SSH (accès à distance)](#5--activer-ssh-accès-à-distance)
6. [Installer l'agent OmenServer](#6--installer-lagent-omenserver)
7. [Lancer l'agent au démarrage automatiquement](#7--lancer-lagent-au-démarrage-automatiquement)
8. [Vérifier que ça fonctionne](#8--vérifier-que-ça-fonctionne)
9. [Commandes optionnelles utiles](#9--commandes-optionnelles-utiles)
10. [Dépannage](#10--dépannage)

---

## 1 — Prérequis

### Ce qu'il te faut :
- **Le PC** à transformer (Windows, vieux PC, n'importe quoi)
- **Une clé USB** de 8 Go minimum
- **Un câble Ethernet** (ou le WiFi, mais Ethernet c'est mieux pour un serveur)
- **Un écran + clavier** (juste pour l'installation, après tu fais tout à distance)
- **La clé API OmenServer** (visible dans le dashboard → Paramètres)

### Ce que le PC va devenir :
- Un PC sous Linux (Ubuntu Server) sans interface graphique
- Il enverra ses stats (CPU, RAM, Disque, Température) à l'Omen toutes les 10 secondes
- Tu pourras le **redémarrer ou l'éteindre à distance** depuis le dashboard OmenServer
- Son **stockage sera fusionné** dans le total affiché sur le dashboard

---

## 2 — Créer la clé USB bootable Ubuntu

### 2.1 — Télécharger Ubuntu Server

Sur ton Mac (ou un autre PC), va sur :  
👉 **https://ubuntu.com/download/server**

Télécharge le fichier **Ubuntu Server 24.04 LTS** (fichier `.iso` d'environ 2.5 Go).

### 2.2 — Créer la clé USB bootable

#### Option A — Sur Mac (avec balenaEtcher)

1. Télécharge **balenaEtcher** : https://etcher.balena.io/
2. Ouvre balenaEtcher
3. Clique **"Flash from file"** → sélectionne le fichier `.iso` d'Ubuntu
4. Clique **"Select target"** → sélectionne ta clé USB
5. Clique **"Flash!"**
6. Attends que ça finisse (~5 minutes)

#### Option B — Sur Mac (avec le Terminal)

```bash
# Trouver le disque de ta clé USB
diskutil list

# Démonter la clé (remplace diskX par le bon numéro, ex: disk2)
diskutil unmountDisk /dev/diskX

# Écrire l'ISO sur la clé (remplace le chemin et diskX)
sudo dd if=~/Downloads/ubuntu-24.04-live-server-amd64.iso of=/dev/rdiskX bs=1m status=progress

# Éjecter la clé
diskutil eject /dev/diskX
```

> ⚠️ **ATTENTION** : Vérifie bien le numéro du disque ! Si tu te trompes, tu peux effacer ton Mac.

---

## 3 — Installer Ubuntu Server

### 3.1 — Booter sur la clé USB

1. Branche la clé USB sur le PC
2. Allume le PC
3. Appuie sur la **touche de boot** (varie selon le PC) :
   - **HP Omen** : `F9`
   - **Dell** : `F12`
   - **Lenovo** : `F12`
   - **ASUS** : `F8` ou `Esc`
   - **MSI** : `F11`
   - **Acer** : `F12`
   - **Général** : `Esc`, `F2`, `F10`, `F11`, `F12` ou `Suppr`
4. Sélectionne la clé USB dans le menu de boot
5. Choisis **"Install Ubuntu Server"**

### 3.2 — Étapes de l'installation

| Écran | Quoi faire |
|-------|-----------|
| **Langue** | Choisis ta langue (Français ou English) |
| **Clavier** | Choisis ta disposition clavier (French - AZERTY) |
| **Type d'installation** | Choisis **"Ubuntu Server"** (pas minimized) |
| **Réseau** | Il détecte automatiquement ton câble Ethernet. Si WiFi, configure-le. |
| **Proxy** | Laisse vide, appuie Entrée |
| **Mirror** | Laisse par défaut, appuie Entrée |
| **Stockage** | ⭐ **IMPORTANT** — voir ci-dessous |
| **Nom / Utilisateur** | Voir ci-dessous |
| **SSH** | ⭐ **Coche "Install OpenSSH server"** |
| **Snaps** | Ne coche rien, appuie Entrée |

### 3.3 — Configuration du stockage (IMPORTANT)

L'installateur propose un schéma de partition. **Par défaut, Ubuntu n'utilise pas tout l'espace !**

**Option recommandée :**
- Choisis **"Use an entire disk"**
- Si le PC a plusieurs disques, choisis le **plus gros** pour le système
- Vérifie que le `lvm` est activé

> 💡 **Pas de panique** : même si Ubuntu ne prend pas tout l'espace au départ, on l'étendra après (Section 9).

### 3.4 — Nom et utilisateur

| Champ | Quoi mettre | Exemple |
|-------|------------|---------|
| Your name | Ton prénom | `Massimiliano` |
| Server name | Un nom court pour le PC | `pc-bureau`, `laptop-gaming`, `tour-salon` |
| Username | Ton identifiant | `massii08` (le même que l'Omen, c'est plus simple) |
| Password | Un mot de passe solide | `********` |

### 3.5 — Fin de l'installation

1. L'installation prend ~10 minutes
2. Quand c'est fini, il te demande de **retirer la clé USB** et appuyer Entrée
3. Le PC redémarre sous Ubuntu Server
4. Tu vois un écran noir avec `login:` → c'est normal, c'est ça Ubuntu Server !

---

## 4 — Premier démarrage — Configuration de base

### 4.1 — Se connecter

```
login: massii08
Password: (ton mot de passe)
```

### 4.2 — Mettre à jour le système

```bash
sudo apt update && sudo apt upgrade -y
```

> Ça peut prendre 5-10 minutes la première fois.

### 4.3 — Installer les outils essentiels

```bash
sudo apt install -y python3 python3-pip python3-venv curl wget htop net-tools
```

**Explication de chaque paquet :**
- `python3` : Le langage de programmation pour l'agent
- `python3-pip` : L'installateur de paquets Python
- `python3-venv` : Pour créer des environnements Python isolés
- `curl` / `wget` : Pour télécharger des fichiers
- `htop` : Pour voir l'utilisation CPU/RAM en temps réel
- `net-tools` : Pour les commandes réseau (ifconfig, etc.)

### 4.4 — Trouver l'IP du PC (pour SSH)

```bash
ip addr show | grep "inet " | grep -v 127.0.0.1
```

Note l'adresse IP (ex: `192.168.68.XX`). Tu en auras besoin pour te connecter à distance.

---

## 5 — Activer SSH (accès à distance)

### 5.1 — Vérifier que SSH est installé

```bash
sudo systemctl status ssh
```

Si c'est `active (running)`, c'est bon ! Sinon :

```bash
sudo apt install -y openssh-server
sudo systemctl enable ssh
sudo systemctl start ssh
```

### 5.2 — Se connecter depuis le Mac

Ouvre un Terminal sur ton Mac et tape :

```bash
ssh massii08@192.168.68.XX
```

> Remplace `XX` par le dernier chiffre de l'IP du PC.

Tu es maintenant connecté à distance ! **Tu peux débrancher l'écran et le clavier du PC.** 🎉

---

## 6 — Installer l'agent OmenServer

### 6.1 — Télécharger l'agent

```bash
curl -o ~/omen_agent.py https://raw.githubusercontent.com/Massii-08/OmenServer/main/tools/omen_agent.py
```

### 6.2 — Installer les dépendances Python

```bash
pip3 install psutil requests
```

> Si `pip3` ne marche pas directement, utilise :
> ```bash
> python3 -m pip install psutil requests
> ```

### 6.3 — Récupérer la clé API

1. Va sur **https://omenserver.org**
2. Connecte-toi avec ton compte
3. Va dans **Settings** (Paramètres)
4. Section **"Ordinateurs connectés"**
5. Copie la **clé API**

### 6.4 — Configurer l'agent

```bash
nano ~/omen_agent.py
```

Modifie les **2 lignes** en haut du fichier :

```python
SERVER_URL = "https://omenserver.org"      # ← Adresse du serveur
API_KEY = "COLLE_TA_CLE_ICI"              # ← La clé API copiée
```

Enregistre avec `Ctrl+O` puis `Entrée`, puis quitte avec `Ctrl+X`.

### 6.5 — Tester l'agent manuellement

```bash
python3 ~/omen_agent.py
```

Tu devrais voir :
```
🖥️  OmenServer Agent — pc-bureau
📡 Serveur: https://omenserver.org
⏱️  Intervalle: 10s
========================================
📡 [16:30:45] CPU 12% | RAM 1.2/8.0Go (15%) | Disk 23%
📡 [16:30:55] CPU 8% | RAM 1.1/8.0Go (14%) | Disk 23%
```

Si tu vois ça, **ça marche !** Appuie `Ctrl+C` pour arrêter.

---

## 7 — Lancer l'agent au démarrage automatiquement

### 7.1 — Créer le service systemd

```bash
sudo tee /etc/systemd/system/omen-agent.service << EOF
[Unit]
Description=OmenServer Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
ExecStart=/usr/bin/python3 /home/$USER/omen_agent.py
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
```

### 7.2 — Activer et démarrer

```bash
sudo systemctl daemon-reload
sudo systemctl enable omen-agent
sudo systemctl start omen-agent
```

### 7.3 — Vérifier que ça tourne

```bash
sudo systemctl status omen-agent
```

Tu devrais voir `active (running)` en vert.

### 7.4 — Voir les logs en temps réel

```bash
sudo journalctl -u omen-agent -f
```

> Appuie `Ctrl+C` pour quitter les logs.

---

## 8 — Vérifier que ça fonctionne

### 8.1 — Sur le Dashboard OmenServer

1. Va sur **https://omenserver.org**
2. Le nouveau PC apparaît dans **"Ordinateurs connectés"** avec un point 🟢
3. Tu vois ses stats : CPU, RAM, Disque, Température
4. Le **total de stockage** dans la carte DISK inclut maintenant ce PC

### 8.2 — Tester les commandes à distance

Depuis le dashboard, tu peux :
- 🔄 **Redémarrer** le PC à distance
- ⏻ **Éteindre** le PC à distance

---

## 9 — Commandes optionnelles utiles

### 🔧 Étendre le disque (si Ubuntu n'utilise pas tout l'espace)

C'est le problème le plus courant : Ubuntu Server avec LVM n'utilise que ~100 Go par défaut.

```bash
# Voir l'espace actuel
df -h /

# Voir les disques physiques
lsblk

# Étendre le volume logique pour utiliser tout l'espace libre
sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv

# Redimensionner le système de fichiers
sudo resize2fs /dev/ubuntu-vg/ubuntu-lv

# Vérifier que c'est bon
df -h /
```

---

### 💾 Formater et utiliser un SSD/HDD supplémentaire

Si le PC a un deuxième disque (SSD ou HDD) pas utilisé :

```bash
# 1. Identifier le disque (ex: /dev/sdb ou /dev/nvme0n1)
lsblk

# 2. Voir ce qu'il contient
sudo blkid /dev/sdX*

# 3. Effacer toutes les partitions
sudo wipefs -a /dev/sdX

# 4. Créer une partition unique
sudo apt install -y parted
sudo parted /dev/sdX --script mklabel gpt mkpart primary ext4 0% 100%

# 5. Formater en ext4
sudo mkfs.ext4 -L "DataDisk" /dev/sdX1

# 6. Créer le point de montage et monter
sudo mkdir -p /mnt/data
sudo mount /dev/sdX1 /mnt/data

# 7. Ajouter au démarrage automatique
echo "UUID=$(sudo blkid -s UUID -o value /dev/sdX1) /mnt/data ext4 defaults 0 2" | sudo tee -a /etc/fstab

# 8. Vérifier
df -h /mnt/data
```

> ⚠️ Remplace `/dev/sdX` par le vrai nom du disque (ex: `/dev/sdb`, `/dev/nvme0n1`).

---

### 🗑️ Vider complètement un SSD (effacer toutes les données)

```bash
# ATTENTION : Ceci efface TOUT sur le disque !

# 1. Démonter le disque s'il est monté
sudo umount /mnt/data

# 2. Effacer les partitions
sudo wipefs -a /dev/sdX

# 3. Écrire des zéros (effacement complet — peut prendre longtemps)
sudo dd if=/dev/zero of=/dev/sdX bs=1M status=progress

# 4. Re-partitionner si tu veux le réutiliser (voir section précédente)
```

---

### 🌐 Configurer une IP fixe (recommandé pour un serveur)

Par défaut, l'IP peut changer à chaque redémarrage. Pour la fixer :

```bash
# Trouver le nom de ton interface réseau
ip link show
# Note le nom (ex: enp3s0, eth0, eno1)

# Créer la configuration Netplan
sudo nano /etc/netplan/01-static.yaml
```

Contenu du fichier (adapte selon ton réseau) :

```yaml
network:
  version: 2
  ethernets:
    enp3s0:                    # ← Nom de ton interface
      dhcp4: no
      addresses:
        - 192.168.68.XX/24     # ← IP fixe que tu veux
      routes:
        - to: default
          via: 192.168.68.1    # ← IP de ta box internet
      nameservers:
        addresses: [8.8.8.8, 8.8.4.4]
```

```bash
# Appliquer
sudo netplan apply

# Vérifier
ip addr show
```

---

### 🔐 Configurer SSH sans mot de passe (clé SSH)

Pour ne plus taper le mot de passe à chaque connexion SSH :

**Sur le Mac :**
```bash
# Générer une clé SSH (si pas déjà fait)
ssh-keygen -t ed25519

# Copier la clé sur le PC distant
ssh-copy-id massii08@192.168.68.XX
```

Maintenant tu peux te connecter sans mot de passe :
```bash
ssh massii08@192.168.68.XX
```

---

### 📊 Voir l'utilisation du système en temps réel

```bash
# CPU, RAM en temps réel (comme un gestionnaire de tâches)
htop

# Utilisation disque
df -h

# Température CPU
cat /sys/class/thermal/thermal_zone0/temp
# Divise par 1000 pour avoir les °C

# Processus les plus gourmands
top -o %MEM

# Connexions réseau actives
ss -tulpn
```

---

### 🔄 Mettre à jour le système

```bash
# Mises à jour classiques
sudo apt update && sudo apt upgrade -y

# Mises à jour de sécurité automatiques
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure --priority=low unattended-upgrades
```

---

### 🔌 Éteindre ou redémarrer le PC

```bash
# Éteindre maintenant
sudo shutdown -h now

# Redémarrer maintenant
sudo reboot

# Éteindre dans 30 minutes
sudo shutdown -h +30

# Annuler un shutdown programmé
sudo shutdown -c
```

---

### 📡 Diagnostics réseau

```bash
# Tester la connexion à OmenServer
curl -s https://omenserver.org/api/health

# Tester la connexion internet
ping -c 4 google.com

# Voir l'IP actuelle
ip addr show | grep "inet " | grep -v 127.0.0.1

# Scanner les PC du réseau local
sudo apt install -y nmap
nmap -sn 192.168.68.0/24
```

---

### 🛡️ Permettre le reboot/shutdown à distance (sans mot de passe sudo)

L'agent a besoin de `sudo` pour redémarrer/éteindre le PC quand tu le demandes depuis le dashboard :

```bash
echo "$USER ALL=(ALL) NOPASSWD: /sbin/reboot, /sbin/shutdown" | sudo tee /etc/sudoers.d/omen-agent
```

---

### 📝 Mettre à jour l'agent OmenServer

Si une nouvelle version de l'agent est disponible :

```bash
# Arrêter l'agent
sudo systemctl stop omen-agent

# Sauvegarder l'ancien
cp ~/omen_agent.py ~/omen_agent.py.bak

# Télécharger la nouvelle version
curl -o ~/omen_agent.py https://raw.githubusercontent.com/Massii-08/OmenServer/main/tools/omen_agent.py

# Remettre ta configuration (SERVER_URL et API_KEY)
nano ~/omen_agent.py

# Relancer l'agent
sudo systemctl start omen-agent
```

---

## 10 — Dépannage

### L'agent ne se connecte pas au serveur

```bash
# Vérifier que le service tourne
sudo systemctl status omen-agent

# Voir les erreurs dans les logs
sudo journalctl -u omen-agent --no-pager -n 50

# Tester la connexion manuellement
curl -s https://omenserver.org/api/health

# Vérifier la clé API dans le fichier
grep "API_KEY" ~/omen_agent.py
```

**Causes fréquentes :**
- ❌ Mauvaise clé API → vérifie dans le dashboard
- ❌ Pas de connexion internet → vérifie le câble Ethernet
- ❌ Firewall bloque → `sudo ufw allow out 443`

---

### Le PC n'apparaît pas dans le dashboard

- Attends **30 secondes** après le démarrage de l'agent
- Vérifie que l'agent est en `active (running)` : `sudo systemctl status omen-agent`
- Vérifie les logs : `sudo journalctl -u omen-agent -f`

---

### Le disque affiche moins d'espace que prévu

→ Utilise la commande d'extension LVM (Section 9, première commande)

---

### Le PC est "offline" dans le dashboard mais il tourne

- L'agent s'est peut-être crashé → `sudo systemctl restart omen-agent`
- Le réseau est peut-être coupé → `ping omenserver.org`

---

### SSH refusé ("Connection refused")

```bash
# Sur le PC (avec écran+clavier), vérifie que SSH tourne
sudo systemctl status ssh

# Si non installé
sudo apt install -y openssh-server
sudo systemctl enable ssh
sudo systemctl start ssh

# Vérifier le firewall
sudo ufw allow ssh
```

---

## 📋 Checklist rapide (résumé)

Pour chaque nouveau PC, fais ces étapes dans l'ordre :

- [ ] Créer la clé USB Ubuntu Server
- [ ] Installer Ubuntu Server (cocher SSH !)
- [ ] Se connecter et mettre à jour : `sudo apt update && sudo apt upgrade -y`
- [ ] Installer les outils : `sudo apt install -y python3 python3-pip curl htop`
- [ ] Télécharger l'agent : `curl -o ~/omen_agent.py https://raw.githubusercontent.com/Massii-08/OmenServer/main/tools/omen_agent.py`
- [ ] Installer psutil + requests : `pip3 install psutil requests`
- [ ] Configurer SERVER_URL et API_KEY : `nano ~/omen_agent.py`
- [ ] Créer le service systemd (Section 7)
- [ ] Vérifier sur le dashboard OmenServer
- [ ] (Optionnel) Étendre le disque LVM
- [ ] (Optionnel) Formater un SSD supplémentaire
- [ ] (Optionnel) Configurer une IP fixe
- [ ] (Optionnel) Configurer SSH sans mot de passe

---

> 🖥️ **OmenServer** — L'Omen est le cerveau, les autres PC sont les bras.  
> Tous connectés, tout fusionné, tout contrôlé depuis un seul dashboard.
