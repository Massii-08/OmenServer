# 🖥️ Guide — Ajouter un PC au réseau OmenServer

> **Version 3.0** — Mai 2026  
> 🧠 L'Omen = cerveau · 🦾 Les autres PC = bras

---

## 📑 Sommaire

1. [Prérequis](#1--prérequis)
2. [Créer la clé USB](#2--créer-la-clé-usb)
3. [Installer Ubuntu Server](#3--installer-ubuntu-server)
4. [Installer l'agent](#4--installer-lagent)
5. [⚙️ Options](#5--options)
6. [🔧 Corrections de bugs](#6--corrections-de-bugs)

---

## 1 — Prérequis

| Ce qu'il faut | Détail |
|--------------|--------|
| Un PC | N'importe lequel (ancien, Windows, etc.) |
| Clé USB | 8 Go minimum |
| Câble Ethernet | Recommandé (WiFi possible) |
| Écran + Clavier | Uniquement pendant l'installation |
| Clé API | https://omenserver.org → Paramètres |

---

## 2 — Créer la clé USB

1. Télécharge **Ubuntu Server 24.04 LTS** → https://ubuntu.com/download/server
2. Flash l'ISO avec **balenaEtcher** → https://etcher.balena.io/

> 💡 Alternative Windows : **Rufus** (https://rufus.ie/)

---

## 3 — Installer Ubuntu Server

Branche la clé USB → Allume le PC → Touche de boot :

| Marque | Touche |
|--------|--------|
| HP | `F9` |
| Dell / Lenovo / Acer | `F12` |
| ASUS | `F8` ou `Esc` |
| MSI | `F11` |

Pendant l'installation, suis ces réglages :

| Écran | Action |
|-------|--------|
| Langue / Clavier | Français / AZERTY |
| Type | **Ubuntu Server** (pas minimized) |
| Réseau | Laisser par défaut (câble auto-détecté) |
| Stockage | **"Use an entire disk"** + **LVM activé** |
| SSH | ⭐ **Cocher "Install OpenSSH server"** |
| Snaps | Ne rien cocher |

> ⚠️ **Ne pas oublier SSH !** Sans ça, tu devras garder un écran branché.

Crée ton utilisateur (ex: `massii08`), attends ~10 min, retire la clé, redémarre.

---

## 4 — Installer l'agent

Connecte-toi au PC, puis lance **une seule commande** :

```bash
curl -sL https://raw.githubusercontent.com/Massii-08/OmenServer/main/tools/setup_omen_agent.sh \
  | sudo bash -s -- TA_CLE_API
```

> Remplace `TA_CLE_API` par la clé copiée depuis https://omenserver.org → Paramètres.

Le script fait **tout automatiquement** :
- ✅ Installe Python, pip, dépendances
- ✅ Télécharge et configure l'agent
- ✅ Crée le service systemd (démarrage auto)
- ✅ Active le PC capot fermé (laptop)
- ✅ Programme veille 1h→6h avec réveil BIOS
- ✅ Étend le disque LVM au maximum
- ✅ Propose de formater un 2e disque (optionnel)

Quand tu vois `✅ Terminé !` → Vérifie sur https://omenserver.org que le PC apparaît 🟢

> 🎉 Tu peux maintenant débrancher l'écran et le clavier !

---

## 5 — ⚙️ Options

### 📀 A — Utiliser tout le disque

Ubuntu LVM n'utilise souvent que ~100 Go par défaut. Le script le fait déjà, mais si besoin :

```bash
sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv
sudo resize2fs /dev/ubuntu-vg/ubuntu-lv
```

---

### 💾 B — Ajouter un 2e disque (SSD/HDD)

```bash
lsblk                                    # Repère le disque (ex: sdb)
sudo wipefs -a /dev/sdX                  # ⚠️ Efface tout !
sudo parted /dev/sdX --script mklabel gpt mkpart primary ext4 0% 100%
sudo mkfs.ext4 -L "DataDisk" /dev/sdX1
sudo mkdir -p /mnt/data && sudo mount /dev/sdX1 /mnt/data
echo "UUID=$(sudo blkid -s UUID -o value /dev/sdX1) /mnt/data ext4 defaults 0 2" | sudo tee -a /etc/fstab
```

> ⚠️ Remplace `/dev/sdX` par le vrai nom du disque !

---

### 🌐 C — IP fixe

Crée `/etc/netplan/01-static.yaml` :

```yaml
network:
  version: 2
  ethernets:
    enp3s0:                        # ← ton interface (ip link show)
      dhcp4: no
      addresses: [192.168.68.XX/24]
      routes:
        - to: default
          via: 192.168.68.1
      nameservers:
        addresses: [8.8.8.8, 8.8.4.4]
```

Puis : `sudo netplan apply`

---

### 🔐 D — SSH sans mot de passe

Depuis ton **Mac** :

```bash
ssh-keygen -t ed25519
ssh-copy-id massii08@192.168.68.XX
```

---

### 🌙 E — Changer les horaires veille/réveil

Par défaut : veille à **1h**, réveil à **6h**. Pour modifier :

```bash
crontab -e
```

Modifie la ligne `rtcwake` (l'heure de mise en veille) et le `06:00` (l'heure de réveil).

---

### 🔌 F — Désactiver la veille automatique

Si tu veux que le PC reste allumé 24/7 :

```bash
crontab -e
# Supprimer la ligne contenant "rtcwake"
```

---

## 6 — 🔧 Corrections de bugs

### ❌ Le PC n'apparaît pas dans le dashboard

| Vérification | Commande |
|-------------|----------|
| Service tourne ? | `sudo systemctl status omen-agent` |
| Relancer | `sudo systemctl restart omen-agent` |
| Clé API correcte ? | `grep "API_KEY" ~/omen_agent.py` |
| Internet OK ? | `ping omenserver.org` |
| Firewall bloque ? | `sudo ufw allow out 443` |

---

### ❌ Le PC est "Offline" mais il est allumé

```bash
sudo systemctl restart omen-agent
```

Si ça persiste → vérifie le câble Ethernet et que `ping omenserver.org` fonctionne.

---

### ❌ Le disque affiche moins d'espace que prévu

Un SSD de 500 Go affiche ~100 Go ? C'est le LVM par défaut :

```bash
sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv
sudo resize2fs /dev/ubuntu-vg/ubuntu-lv
df -h /
```

---

### ❌ SSH refusé ("Connection refused")

Sur le PC (avec écran+clavier) :

```bash
sudo apt install -y openssh-server
sudo systemctl enable ssh && sudo systemctl start ssh
sudo ufw allow ssh
```

---

### ❌ Le PC ne se réveille pas à l'heure prévue

1. **BIOS** : Entrer dans le BIOS (`F2` ou `Suppr`) → Activer **"Wake on RTC"** ou **"Power On By RTC Alarm"**
2. **Vérifier le timer** : `cat /proc/driver/rtc` → `alarm_IRQ` doit être `yes`
3. **Re-programmer** :

```bash
sudo rtcwake -m no -l -t $(date -d "tomorrow 06:00" +%s)
sudo systemctl suspend
```

---

### ❌ Les services ne redémarrent pas après le réveil

Le PC se réveille mais OmenServer/Cloudflare restent coupés :

```bash
sudo cp tools/omen-resume.sh /etc/systemd/system-sleep/
sudo chmod +x /etc/systemd/system-sleep/omen-resume.sh
```

---

### ❌ Reboot/Shutdown à distance ne fonctionne pas

```bash
echo "$USER ALL=(ALL) NOPASSWD: /sbin/reboot, /sbin/shutdown" | sudo tee /etc/sudoers.d/omen-agent
sudo chmod 0440 /etc/sudoers.d/omen-agent
```

---

### ❌ "pip install" échoue (`externally-managed-environment`)

Ubuntu 24.04 bloque pip hors venv :

```bash
pip3 install psutil requests --break-system-packages
```

---

### ❌ L'agent crashe au démarrage (erreur Python)

```bash
sudo journalctl -u omen-agent -n 50    # Voir les logs
python3 ~/omen_agent.py                # Tester manuellement
```

**Causes fréquentes** : mauvaise version de Python · `psutil` non installé · `SERVER_URL` mal configuré.

---

### ❌ Le PC se met en veille mais ne se reconnecte pas

Après un réveil, l'agent met ~15s à se reconnecter. Si ça ne marche toujours pas :

```bash
sudo systemctl restart omen-agent
sudo systemctl restart systemd-networkd
```

> 💡 Le script `omen-resume.sh` fait ça automatiquement si installé (voir bug ci-dessus).

---

## 📋 Checklist

- [ ] Clé USB Ubuntu Server créée
- [ ] Ubuntu installé (**SSH coché !**)
- [ ] Script agent lancé avec la clé API
- [ ] PC visible 🟢 sur https://omenserver.org

---

> 🖥️ **OmenServer** — L'Omen est le cerveau, les autres PC sont les bras.  
> Tous connectés, tout fusionné, tout contrôlé depuis un seul dashboard.
