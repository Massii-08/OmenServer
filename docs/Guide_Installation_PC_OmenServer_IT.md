# 🖥️ Guida — Aggiungere un PC alla rete OmenServer

> **Versione 3.0** — Maggio 2026  
> 🧠 L'Omen = cervello · 🦾 Gli altri PC = bracci

---

## 📑 Sommario

1. [Requisiti](#1--requisiti)
2. [Creare la chiavetta USB](#2--creare-la-chiavetta-usb)
3. [Installare Ubuntu Server](#3--installare-ubuntu-server)
4. [Installare l'agente](#4--installare-lagente)
5. [⚙️ Opzioni](#5--opzioni)
6. [🔧 Correzione bug](#6--correzione-bug)

---

## 1 — Requisiti

| Cosa serve | Dettaglio |
|------------|-----------|
| Un PC | Qualsiasi (vecchio, Windows, ecc.) |
| Chiavetta USB | 8 GB minimo |
| Cavo Ethernet | Consigliato (WiFi possibile) |
| Schermo + Tastiera | Solo durante l'installazione |
| Chiave API | https://omenserver.org → Impostazioni |

---

## 2 — Creare la chiavetta USB

1. Scarica **Ubuntu Server 24.04 LTS** → https://ubuntu.com/download/server
2. Scrivi l'ISO con **balenaEtcher** → https://etcher.balena.io/

> 💡 Alternativa Windows : **Rufus** (https://rufus.ie/)

---

## 3 — Installare Ubuntu Server

Collega la chiavetta → Accendi il PC → Tasto di boot :

| Marca | Tasto |
|-------|-------|
| HP | `F9` |
| Dell / Lenovo / Acer | `F12` |
| ASUS | `F8` o `Esc` |
| MSI | `F11` |

Durante l'installazione, segui queste impostazioni :

| Schermata | Azione |
|-----------|--------|
| Lingua / Tastiera | Italiano / Layout desiderato |
| Tipo | **Ubuntu Server** (non minimized) |
| Rete | Lasciare predefinito (cavo auto-rilevato) |
| Storage | **"Use an entire disk"** + **LVM attivato** |
| SSH | ⭐ **Spuntare "Install OpenSSH server"** |
| Snaps | Non spuntare nulla |

> ⚠️ **Non dimenticare SSH !** Senza, dovrai tenere uno schermo collegato.

Crea il tuo utente (es: `massii08`), attendi ~10 min, rimuovi la chiavetta, riavvia.

---

## 4 — Installare l'agente

Connettiti al PC, poi lancia **un solo comando** :

```bash
curl -sL https://raw.githubusercontent.com/Massii-08/OmenServer/main/tools/setup_omen_agent.sh \
  | sudo bash -s -- LA_TUA_CHIAVE_API
```

> Sostituisci `LA_TUA_CHIAVE_API` con la chiave copiata da https://omenserver.org → Impostazioni.

Lo script fa **tutto automaticamente** :
- ✅ Installa Python, pip, dipendenze
- ✅ Scarica e configura l'agente
- ✅ Crea il servizio systemd (avvio automatico)
- ✅ Attiva il PC col coperchio chiuso (laptop)
- ✅ Programma sospensione 1h→6h con sveglia BIOS
- ✅ Espande il disco LVM al massimo
- ✅ Propone di formattare un 2° disco (opzionale)

Quando vedi `✅ Terminé !` → Verifica su https://omenserver.org che il PC appaia 🟢

> 🎉 Ora puoi scollegare schermo e tastiera !

---

## 5 — ⚙️ Opzioni

### 📀 A — Usare tutto il disco

Ubuntu LVM spesso usa solo ~100 GB di default. Lo script lo fa già, ma se serve :

```bash
sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv
sudo resize2fs /dev/ubuntu-vg/ubuntu-lv
```

---

### 💾 B — Aggiungere un 2° disco (SSD/HDD)

```bash
lsblk                                    # Identifica il disco (es: sdb)
sudo wipefs -a /dev/sdX                  # ⚠️ Cancella tutto !
sudo parted /dev/sdX --script mklabel gpt mkpart primary ext4 0% 100%
sudo mkfs.ext4 -L "DataDisk" /dev/sdX1
sudo mkdir -p /mnt/data && sudo mount /dev/sdX1 /mnt/data
echo "UUID=$(sudo blkid -s UUID -o value /dev/sdX1) /mnt/data ext4 defaults 0 2" | sudo tee -a /etc/fstab
```

> ⚠️ Sostituisci `/dev/sdX` con il vero nome del disco !

---

### 🌐 C — IP statico

Crea `/etc/netplan/01-static.yaml` :

```yaml
network:
  version: 2
  ethernets:
    enp3s0:                        # ← la tua interfaccia (ip link show)
      dhcp4: no
      addresses: [192.168.68.XX/24]
      routes:
        - to: default
          via: 192.168.68.1
      nameservers:
        addresses: [8.8.8.8, 8.8.4.4]
```

Poi : `sudo netplan apply`

---

### 🔐 D — SSH senza password

Dal tuo **Mac** :

```bash
ssh-keygen -t ed25519
ssh-copy-id massii08@192.168.68.XX
```

---

### 🌙 E — Cambiare gli orari sospensione/sveglia

Di default : sospensione alle **1h**, sveglia alle **6h**. Per modificare :

```bash
crontab -e
```

Modifica la riga `rtcwake` (ora della sospensione) e il `06:00` (ora della sveglia).

---

### 🔌 F — Disattivare la sospensione automatica

Se vuoi che il PC resti acceso 24/7 :

```bash
crontab -e
# Cancellare la riga contenente "rtcwake"
```

---

## 6 — 🔧 Correzione bug

### ❌ Il PC non appare nella dashboard

| Verifica | Comando |
|----------|---------|
| Servizio attivo ? | `sudo systemctl status omen-agent` |
| Rilanciare | `sudo systemctl restart omen-agent` |
| Chiave API corretta ? | `grep "API_KEY" ~/omen_agent.py` |
| Internet OK ? | `ping omenserver.org` |
| Firewall blocca ? | `sudo ufw allow out 443` |

---

### ❌ Il PC è "Offline" ma è acceso

```bash
sudo systemctl restart omen-agent
```

Se persiste → controlla il cavo Ethernet e che `ping omenserver.org` funzioni.

---

### ❌ Il disco mostra meno spazio del previsto

Un SSD da 500 GB mostra ~100 GB ? È il LVM di default :

```bash
sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv
sudo resize2fs /dev/ubuntu-vg/ubuntu-lv
df -h /
```

---

### ❌ SSH rifiutato ("Connection refused")

Sul PC (con schermo+tastiera) :

```bash
sudo apt install -y openssh-server
sudo systemctl enable ssh && sudo systemctl start ssh
sudo ufw allow ssh
```

---

### ❌ Il PC non si sveglia all'ora prevista

1. **BIOS** : Entrare nel BIOS (`F2` o `Canc`) → Attivare **"Wake on RTC"** o **"Power On By RTC Alarm"**
2. **Verificare il timer** : `cat /proc/driver/rtc` → `alarm_IRQ` deve essere `yes`
3. **Ri-programmare** :

```bash
sudo rtcwake -m no -l -t $(date -d "tomorrow 06:00" +%s)
sudo systemctl suspend
```

---

### ❌ I servizi non ripartono dopo la sveglia

Il PC si sveglia ma OmenServer/Cloudflare restano spenti :

```bash
sudo cp tools/omen-resume.sh /etc/systemd/system-sleep/
sudo chmod +x /etc/systemd/system-sleep/omen-resume.sh
```

---

### ❌ Reboot/Shutdown da remoto non funziona

```bash
echo "$USER ALL=(ALL) NOPASSWD: /sbin/reboot, /sbin/shutdown" | sudo tee /etc/sudoers.d/omen-agent
sudo chmod 0440 /etc/sudoers.d/omen-agent
```

---

### ❌ "pip install" fallisce (`externally-managed-environment`)

Ubuntu 24.04 blocca pip fuori da un venv :

```bash
pip3 install psutil requests --break-system-packages
```

---

### ❌ L'agente crasha all'avvio (errore Python)

```bash
sudo journalctl -u omen-agent -n 50    # Vedere i log
python3 ~/omen_agent.py                # Testare manualmente
```

**Cause frequenti** : versione Python sbagliata · `psutil` non installato · `SERVER_URL` mal configurato.

---

### ❌ Il PC si sveglia ma non si riconnette

Dopo una sveglia, l'agente impiega ~15s per riconnettersi. Se non funziona :

```bash
sudo systemctl restart omen-agent
sudo systemctl restart systemd-networkd
```

> 💡 Lo script `omen-resume.sh` fa questo automaticamente se installato (vedi bug sopra).

---

## 📋 Checklist

- [ ] Chiavetta USB Ubuntu Server creata
- [ ] Ubuntu installato (**SSH spuntato !**)
- [ ] Script agente lanciato con la chiave API
- [ ] PC visibile 🟢 su https://omenserver.org

---

> 🖥️ **OmenServer** — L'Omen è il cervello, gli altri PC sono i bracci.  
> Tutti connessi, tutto unito, tutto controllato da un'unica dashboard.
