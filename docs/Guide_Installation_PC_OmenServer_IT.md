# 🖥️ Guida Completa — Aggiungere un PC alla rete OmenServer

> **Version 1.0** — Mai 2026  
> Questa guida spiega come trasformare qualsiasi PC (même avec Windows) in un "braccio" connesso a OmenServer.  
> L'Omen rimane il **cervello** (server principale), gli altri PC sono i **bracci** (agents qui envoient leurs stats).

---

## 📑 Sommario

1. [Requisiti](#1--prérequis)
2. [Creare la chiavetta USB avviabile di Ubuntu](#2--créer-la-clé-usb-bootable-ubuntu)
3. [Installare Ubuntu Server](#3--installer-ubuntu-server)
4. [Primo avvio — Configurazione di base](#4--premier-démarrage--configuration-de-base)
5. [Attivare SSH (accesso remoto)](#5--activer-ssh-accès-à-distance)
6. [Installer l'agent OmenServer](#6--installer-lagent-omenserver)
7. [Avviare l'agente all'avvio automaticamente](#7--lancer-lagent-au-démarrage-automatiquement)
8. [Verificare che funzioni](#8--vérifier-que-ça-fonctionne)
9. [Comandi opzionali utili](#9--commandes-optionnelles-utiles)
10. [Risoluzione dei problemi](#10--dépannage)

---

## 1 — Requisiti

### Cosa ti serve:
- **Le PC** à transformer (Windows, vieux PC, n'importe quoi)
- **Une clé USB** de 8 Go minimum
- **Un cavo Ethernet** (ou le WiFi, mais Ethernet c'est mieux pour un serveur)
- **Uno schermo + tastiera** (juste pour l'installation, après tu fais tout à distance)
- **La chiave API OmenServer** (visible dans le dashboard → Impostazioni)

### Cosa diventerà il PC:
- Un PC con Linux (Ubuntu Server) senza interfaccia grafica
- Invierà le sue statistiche (CPU, RAM, Disque, Température) à l'Omen toutes les 10 secondes
- Potrai **riavviarlo o spegnerlo a distanza** depuis le dashboard OmenServer
- Il suo **storage sarà unito** dans le total affiché sur le dashboard
- **Resterà acceso anche col coperchio chiuso** et **si accenderà/spegnerà automaticamente** (1h-6h)

---

## 2 — Creare la chiavetta USB avviabile di Ubuntu

### 2.1 — Scaricare Ubuntu Server

Sul tuo Mac (o un altro PC), vai su:  
👉 **https://ubuntu.com/download/server**

Scarica il file **Ubuntu Server 24.04 LTS** (fichier `.iso` d'environ 2.5 Go).

### 2.2 — Creare la chiavetta USB avviabile

#### Opzione A — Su Mac (con balenaEtcher)

1. Scarica **balenaEtcher** : https://etcher.balena.io/
2. Apri balenaEtcher
3. Clicca **"Flash from file"** → seleziona il file `.iso` d'Ubuntu
4. Clicca **"Select target"** → seleziona la tua chiavetta USB
5. Clicca **"Flash!"**
6. Aspetta che finisca (~5 minutes)

#### Opzione B — Su Windows (con Rufus)

1. Scarica **Rufus** : https://rufus.ie/
2. Apri Rufus
3. **Dispositivo** : Sélectionne ta clé USB
4. **Selezione boot** : Clicca sur **"SÉLECTION"** et scegli il file `.iso` d'Ubuntu
5. Lascia le altre opzioni predefinite e clicca su **"DÉMARRER"**
6. (Si on te demande de télécharger Syslinux ou d'écrire en mode Image ISO, dis "Oui" / "Mode image ISO")

#### Opzione C — Su Mac (con il Terminale)

```bash
# Trovare il disco della tua chiavetta USB
diskutil list

# Smontare la chiavetta (remplace diskX par le bon numéro, ex: disk2)
diskutil unmountDisk /dev/diskX

# Scrivere l'ISO sulla chiavetta (remplace le chemin et diskX)
sudo dd if=~/Downloads/ubuntu-24.04-live-server-amd64.iso of=/dev/rdiskX bs=1m status=progress

# Espellere la chiavetta
diskutil eject /dev/diskX
```

> ⚠️ **ATTENTION** : Vérifie bien le numéro du disque ! Si tu te trompes, tu peux effacer ton Mac.

---

## 3 — Installare Ubuntu Server

### 3.1 — Avviare dalla chiavetta USB

1. Collega la chiavetta USB al PC
2. Accendi il PC
3. Premi il **tasto di boot** (varie selon le PC) :
   - **HP Omen** : `F9`
   - **Dell** : `F12`
   - **Lenovo** : `F12`
   - **ASUS** : `F8` ou `Esc`
   - **MSI** : `F11`
   - **Acer** : `F12`
   - **Général** : `Esc`, `F2`, `F10`, `F11`, `F12` ou `Suppr`
4. Seleziona la chiavetta USB nel menu di boot
5. Scegli **"Install Ubuntu Server"**

### 3.2 — Fasi dell'installazione

| Schermata | Cosa fare |
|-------|-----------|
| **Lingua** | Scegli ta langue (Français ou English) |
| **Tastiera** | Scegli ta disposition clavier (French - AZERTY) |
| **Tipo di installazione** | Scegli **"Ubuntu Server"** (pas minimized) |
| **Rete** | Rileva automaticamente il cavo Ethernet. Si WiFi, configure-le. |
| **Proxy** | Lascia vuoto, premi Invio |
| **Mirror** | Lascia predefinito, premi Invio |
| **Archiviazione** | ⭐ **IMPORTANTEE** — voir ci-dessous |
| **Nome / Utente** | Vedi sotto |
| **SSH** | ⭐ **Spunta "Install OpenSSH server"** |
| **Snaps** | Non spuntare nulla, premi Invio |

### 3.3 — Configurazione dell'archiviazione (IMPORTANTEE)

L'installer propone uno schema di partizioni. **Di default, Ubuntu non usa tutto lo spazio!**

**Opzione consigliata:**
- Scegli **"Use an entire disk"**
- Se il PC ha più dischi, scegli il **più grande** per il sistema
- Verifica che `lvm` sia attivato

> 💡 **Pas de panique** : même si Ubuntu ne prend pas tout l'espace au départ, on l'étendra après (Section 9).

### 3.4 — Nome e utente

| Campo | Cosa inserire | Esempio |
|-------|------------|---------|
| Your name | Il tuo nome | `Massimiliano` |
| Server name | Un nome breve per il PC | `pc-bureau`, `laptop-gaming`, `tour-salon` |
| Username | Il tuo ID utente | `massii08` (lo stesso dell'Omen, è più semplice) |
| Password | Una password sicura | `********` |

### 3.5 — Fine dell'installazione

1. L'installazione richiede ~10 minutes
2. Quando è finito, ti chiede di **rimuovere la chiavetta USB** e premere Invio
3. Il PC si riavvia in Ubuntu Server
4. Vedi uno schermo nero con `login:` → è normale, questo è Ubuntu Server !

---

## 4 — Primo avvio — Configurazione di base

### 4.1 — Accedere

```
login: massii08
Password: (la tua password)
```

### 4.2 — Aggiornare il sistema

```bash
sudo apt update && sudo apt upgrade -y
```

> Può richiedere 5-10 minuti la prima volta.

### 4.3 — Installare gli strumenti essenziali

```bash
sudo apt install -y python3 python3-pip python3-venv curl wget htop net-tools
```

**Spiegazione di ogni pacchetto :**
- `python3` : Il linguaggio di programmazione per l'agente
- `python3-pip` : L'installer dei pacchetti Python
- `python3-venv` : Per creare ambienti Python isolati
- `curl` / `wget` : Per scaricare file
- `htop` : Per vedere l'uso CPU/RAM in tempo reale
- `net-tools` : Per i comandi di rete (ifconfig, etc.)

### 4.4 — Trovare l'IP del PC (per SSH)

```bash
ip addr show | grep "inet " | grep -v 127.0.0.1
```

Prendi nota dell'indirizzo IP (ex: `192.168.68.XX`). Ti servirà per connetterti a distanza.

---

## 5 — Attivare SSH (accesso remoto)

### 5.1 — Verificare che SSH sia installato

```bash
sudo systemctl status ssh
```

Se è `active (running)`, va bene! Altrimenti:

```bash
sudo apt install -y openssh-server
sudo systemctl enable ssh
sudo systemctl start ssh
```

### 5.2 — Accedere depuis le Mac

Apri un Terminale sul tuo Mac e digita:

```bash
ssh massii08@192.168.68.XX
```

> Sostituisci `XX` con le ultime cifre dell'IP del PC.

Ora sei connesso a distanza! **Puoi scollegare schermo e tastiera dal PC.** 🎉

---

## 6 — Installare l'agente (in 1 solo comando)

Per semplificare al massimo, uno script si occupa di installare e configurare **tutto** automaticamente:
- Download dell'agente OmenServer
- Configurazione della chiave API
- Avvio automatico (servizio in background)
- **Chiusura del coperchio** : il PC resterà acceso anche se chiudi lo schermo
- **Orari automatici** : il PC entrerà in sospensione profonda all'1 di notte e si sveglierà alle 6 del mattino (fuso orario europeo configurato automaticamente)
- **Estensione del disco** : espande automaticamente lo spazio di base
- **Opzione SSD/HDD** : ti chiederà se vuoi formattare un 2° disco

### 6.1 — Avviare l'installazione

1. Va sur **https://omenserver.org**, accedi, e vai nelle **Impostazioni** per copiare la tua **Chiave API**.
2. Sul nuovo PC, digita questo comando sostituendo `TA_CLE_API` con la tua vera chiave (per esempio `sk_123456789abc`) :

```bash
curl -sL https://raw.githubusercontent.com/Massii-08/OmenServer/main/tools/setup_omen_agent.sh \
  | sudo bash -s -- TA_CLE_API
```

*(Se ti chiede una password, è quella della tua sessione ubuntu)*

3. Attendi 1 minuto. Alla fine, lo script ti chiederà:
   > `⚠️ ATTENTION: Hai un secondo disco (SSD/HDD) che vuoi cancellare... ? (y/N):`
   Digita `y` se hai un vecchio disco da formattare (ATTENZIONE: cancella TUTTO), o solo `Invio` per ignorare.
4. Quando vedi `✅ Terminé !`, hai finito.

### 6.2 — È tutto!

Ora puoi:
- **Chiudere il coperchio del computer**, resterà acceso
- Riporlo su uno scaffale col suo cavo di alimentazione
- Gestirlo interamente dalla dashboard di OmenServer

---

## 8 — Verificare che funzioni

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

## 9 — Comandi opzionali utili

### 🔧 Estendere il disco (se Ubuntu non usa tutto lo spazio)

È il problema più comune: Ubuntu Server con LVM usa solo ~100 GB di default.

```bash
# Vedere lo spazio attuale
df -h /

# Vedere i dischi fisici
lsblk

# Estendere il volume logico per usare tutto lo spazio libero
sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv

# Ridimensionare il file system
sudo resize2fs /dev/ubuntu-vg/ubuntu-lv

# Verificare che sia a posto
df -h /
```

---

### 💾 Formattare e usare un SSD/HDD aggiuntivo

Se il PC ha un secondo disco (SSD o HDD) non utilizzato:

```bash
# 1. Identificare il disco (ex: /dev/sdb ou /dev/nvme0n1)
lsblk

# 2. Vedere cosa contiene
sudo blkid /dev/sdX*

# 3. Cancellare tutte le partizioni
sudo wipefs -a /dev/sdX

# 4. Creare una partizione unica
sudo apt install -y parted
sudo parted /dev/sdX --script mklabel gpt mkpart primary ext4 0% 100%

# 5. Formattare in ext4
sudo mkfs.ext4 -L "DataDisk" /dev/sdX1

# 6. Creare il punto di mount e montare
sudo mkdir -p /mnt/data
sudo mount /dev/sdX1 /mnt/data

# 7. Aggiungere all'avvio automatico
echo "UUID=$(sudo blkid -s UUID -o value /dev/sdX1) /mnt/data ext4 defaults 0 2" | sudo tee -a /etc/fstab

# 8. Verificare
df -h /mnt/data
```

> ⚠️ Sostituisci `/dev/sdX` col vero nome del disco (ex: `/dev/sdb`, `/dev/nvme0n1`).

---

### 🗑️ Svuotare completamente un SSD (cancellare tutti i dati)

```bash
# ATTENZIONE : Questo cancella TUTTO sul disco!

# 1. Smontare il disco se è montato
sudo umount /mnt/data

# 2. Cancellare le partizioni
sudo wipefs -a /dev/sdX

# 3. Scrivere zeri (cancellazione completa — può richiedere molto tempo)
sudo dd if=/dev/zero of=/dev/sdX bs=1M status=progress

# 4. Ripartizionare se vuoi riutilizzarlo (vedi sezione precedente)
```

---

### 🌐 Configurare un IP statico (consigliato per un server)

Di default, l'IP può cambiare a ogni riavvio. Per fissarlo:

```bash
# Trovare il nome della tua interfaccia di rete
ip link show
# Prendi nota del nome (ex: enp3s0, eth0, eno1)

# Creare la configurazione Netplan
sudo nano /etc/netplan/01-static.yaml
```

Contenuto del file (adatta alla tua rete):

```yaml
network:
  version: 2
  ethernets:
    enp3s0:                    # ← Nome della tua interfaccia
      dhcp4: no
      addresses:
        - 192.168.68.XX/24     # ← IP statico che desideri
      routes:
        - to: default
          via: 192.168.68.1    # ← IP del tuo router internet
      nameservers:
        addresses: [8.8.8.8, 8.8.4.4]
```

```bash
# Applicare
sudo netplan apply

# Verificare
ip addr show
```

---

### 🔐 Configurare SSH senza password (chiave SSH)

Per non dover più digitare la password a ogni connessione SSH:

**Sur le Mac :**
```bash
# Generare una chiave SSH (se non già fatto)
ssh-keygen -t ed25519

# Copiare la chiave sul PC remoto
ssh-copy-id massii08@192.168.68.XX
```

Ora puoi connetterti senza password:
```bash
ssh massii08@192.168.68.XX
```

---

### 📊 Vedere l'uso del sistema in tempo reale

```bash
# CPU, RAM in tempo reale (come un task manager)
htop

# Uso del disco
df -h

# Temperatura CPU
cat /sys/class/thermal/thermal_zone0/temp
# Dividi per 1000 per avere i °C

# Processi più esigenti
top -o %MEM

# Connessioni di rete attive
ss -tulpn
```

---

### 🔄 Aggiornare il sistema

```bash
# Aggiornamenti classici
sudo apt update && sudo apt upgrade -y

# Aggiornamenti di sicurezza automatici
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure --priority=low unattended-upgrades
```

---

### 🔌 Éteindre ou redémarrer le PC

```bash
# Spegnere ora
sudo shutdown -h now

# Riavviare ora
sudo reboot

# Spegnere tra 30 minuti
sudo shutdown -h +30

# Annullare uno spegnimento programmato
sudo shutdown -c
```

---

### 📡 Diagnostics réseau

```bash
# Testare la connessione a OmenServer
curl -s https://omenserver.org/api/health

# Testare la connessione internet
ping -c 4 google.com

# Vedere l'IP attuale
ip addr show | grep "inet " | grep -v 127.0.0.1

# Scansionare i PC nella rete locale
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

## 10 — Risoluzione dei problemi

### L'agente non si connette al server

```bash
# Verificare que le service tourne
sudo systemctl status omen-agent

# Vedere gli errori nei log
sudo journalctl -u omen-agent --no-pager -n 50

# Testare la connessione manualmente
curl -s https://omenserver.org/api/health

# Verificare la clé API dans le fichier
grep "API_KEY" ~/omen_agent.py
```

**Cause frequenti :**
- ❌ Chiave API errata → controlla nella dashboard
- ❌ Nessuna connessione internet → controlla il cavo Ethernet
- ❌ Il firewall blocca → `sudo ufw allow out 443`

---

### Il PC non appare nella dashboard

- Attendi **30 secondi** dopo l'avvio dell'agente
- Verifica che l'agente sia in `active (running)` : `sudo systemctl status omen-agent`
- Controlla i log : `sudo journalctl -u omen-agent -f`

---

### Il disco mostra meno spazio del previsto

→ Usa il comando di estensione LVM (Section 9, première commande)

---

### Il PC è "offline" nella dashboard ma è acceso

- L'agente potrebbe essersi bloccato → `sudo systemctl restart omen-agent`
- La rete potrebbe essere interrotta → `ping omenserver.org`

---

### SSH rifiutato ("Connection refused")

```bash
# Sul PC (con schermo+tastiera), verifica che SSH sia in esecuzione
sudo systemctl status ssh

# Se non installato
sudo apt install -y openssh-server
sudo systemctl enable ssh
sudo systemctl start ssh

# Verificare le firewall
sudo ufw allow ssh
```

---

## 📋 Checklist rapida (riassunto)

Per ogni nuovo PC, fai questi passaggi in ordine:

- [ ] Créer la clé USB Ubuntu Server
- [ ] Installare Ubuntu Server (cocher SSH !)
- [ ] Accedere et mettre à jour : `sudo apt update && sudo apt upgrade -y`
- [ ] Installare python : `sudo apt install -y python3 python3-pip curl htop`
- [ ] Lanciare lo script di installazione auto : `curl -sL https://raw.githubusercontent.com/Massii-08/OmenServer/main/tools/setup_omen_agent.sh | sudo bash -s -- TA_CLE_API`
- [ ] Verificare sur le dashboard OmenServer
- [ ] (Optionnel) Estendere il disco LVM
- [ ] (Optionnel) Formattare un SSD aggiuntivo
- [ ] (Optionnel) Configurare un IP statico
- [ ] (Optionnel) Configurare SSH senza password

---

> 🖥️ **OmenServer** — L'Omen est le cerveau, les autres PC sont les bras.  
> Tutti connessi, tutto unito, tutto controllato da un'unica dashboard.
