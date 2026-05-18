# AGENTS.md — Regole per agenti IA

> **Istruzioni per qualsiasi agente IA che lavora su OmenServer.**
> **Leggere CLAUDE.md per il contesto completo del progetto.**

---

## 🎯 Regole fondamentali

### 1. Non rompere ciò che funziona
- **Testa sempre** prima di dichiarare finito
- Il server deve poter ripartire dopo ogni modifica (`uvicorn backend.main:app --reload`)
- Ogni endpoint deve essere raggiungibile (niente 404 sui nuovi route)

### 2. Rispetta l'architettura esistente
- **Backend** : un router per modulo, registrato in `main.py`
- **Frontend** : un oggetto globale JS per modulo con `render(container)` e `unload()`
- **Niente framework JS** — solo vanilla JS/CSS
- **Niente TailwindCSS** — solo CSS vanilla con variabili CSS

### 3. Internazionalizzazione obbligatoria
- Ogni testo visibile nell'interfaccia deve usare `Lang.t('chiave')`
- Aggiungere le chiavi in **3 lingue** : FR, EN, IT (in `lang.js`)
- Mai testo hardcoded nel frontend

### 4. Stile visivo premium
- Usare le variabili CSS esistenti (`var(--bg-card)`, `var(--accent-green)`, etc.)
- Tutti i nuovi componenti CSS vanno in `style.css` con un commento separatore
- Hover effects, transizioni, micro-animazioni sono attesi

### 5. Multi-macchine: architettura cervello/braccio
- L'**Omen** è il cervello (server principale) — **sempre visibile** nella griglia delle macchine
- Gli altri PC sono **bracci** (agenti che inviano stats via `omen_agent.py`)
- Le card in alto mostrano **totali combinati** (CPU media ponderata, RAM sommata, Disco sommato, Temp max)
- La sezione "Rete di macchine" mostra: 🧠 Omen (cervello) per primo + 🦾 Bracci dopo
- `system_info.py → get_disk_info()` somma tutti i mount point fisici
- Il diagnostico rileva i **crash dei nodi** (offline < 5 min = crash recente)

### 6. Cache: bumper le versioni dopo ogni modifica JS/CSS
- Ogni file JS in `index.html` ha un `?v=XX` — incrementare dopo ogni modifica
- Il Service Worker (`sw.js`) ha un `CACHE_NAME` — incrementare ad ogni versione
- Cloudflare + Service Worker cachano aggressivamente i file statici

---

## 📋 Checklist per ogni modifica

### Nuovo endpoint API
- [ ] Creare il router in `backend/<modulo>/router.py`
- [ ] Registrare in `main.py` (`from ... import router as xxx_router` + `app.include_router(xxx_router)`)
- [ ] Proteggere con `current_user: User = Depends(get_current_user)`
- [ ] Documentare con docstring
- [ ] Testare con curl o browser

### Nuovo modulo frontend
- [ ] Creare `frontend/js/<modulo>_module.js`
- [ ] Esportare un oggetto globale con `render(container)` e `unload()`
- [ ] Registrare in `app.js` nel router
- [ ] Aggiungere chiavi i18n in `lang.js` (FR + EN + IT)
- [ ] Aggiungere CSS in `style.css`
- [ ] Aggiungere nell'hub dei moduli se necessario (`modules/router.py`)

### Modifica al database
- [ ] Aggiungere modello SQLAlchemy in `<modulo>/models.py`
- [ ] Importare in `database.py` → `create_tables()`
- [ ] Se aggiunta colonna a tabella esistente → aggiungere migrazione in `main.py` startup

### Modifica al monitoring
- [ ] Se nuova stat → aggiornare `system_info.py` (backend)
- [ ] Aggiornare `monitoring.js → updateUI()` (frontend)
- [ ] Se serve nelle card → aggiornare `_renderMachinesList()` nel frontend
- [ ] Se serve nella carta Omen → aggiornare `renderNodes()` nel frontend
- [ ] Aggiungere nel `HeartbeatData` schema se anche gli agenti devono inviarlo
- [ ] **Bumper** `?v=XX` in `index.html` per i file JS/CSS modificati
- [ ] **Bumper** `CACHE_NAME` in `sw.js`

---

## 🛠️ Comandi di sviluppo

```bash
# Avviare il server (dev)
source venv/bin/activate
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000

# Testare un endpoint
curl -s http://localhost:8000/api/health

# Testare un endpoint autenticato
TOKEN=$(curl -s http://localhost:8000/api/auth/login \
  -d 'username=Massii_08&password=XXX' \
  -H 'Content-Type: application/x-www-form-urlencoded' | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
curl -s http://localhost:8000/api/bots -H "Authorization: Bearer $TOKEN"

# Production (Omen via SSH)
ssh massii08@192.168.68.66
sudo systemctl status omenserver
sudo systemctl restart omenserver
sudo journalctl -u omenserver -f

# Deploy automatico (ogni minuto via cron)
cat ~/deploy.log
```

---

## 🚫 Non fare mai

1. **Non installare npm / node_modules** — il frontend è puro HTML/CSS/JS
2. **Non creare nuovi file HTML** — tutto passa per `index.html` (SPA)
3. **Non usare `fetch()` direttamente** — usare sempre `Auth.apiCall()`
4. **Non hardcodare testo** — usare `Lang.t('chiave')`
5. **Non modificare il bot Yield** (`Bot Calcul yield/`) — OmenServer lo tratta come esterno
6. **Non usare `print()`** nel backend — usare `logger.info/warning/error`
7. **Non usare `alert()`** nel frontend — usare `Toast.success/error/warn`
8. **Non usare `passlib`** — usare `bcrypt` direttamente (vedi `auth/utils.py`)
9. **Non dimenticare di fare `git push`** — il deploy è automatico dopo il push
10. **Non dimenticare di bumper le versioni** — `?v=XX` in `index.html` + `CACHE_NAME` in `sw.js`

---

## 🏗️ Infrastruttura di produzione

| Componente | Dettaglio |
|-----------|-----------|
| **Server** | HP Omen (Ubuntu Server) |
| **Accesso** | `omenserver.org` (Cloudflare Tunnel) |
| **Servizio** | `omenserver.service` (systemd, avvio al boot) |
| **Wrapper** | `~/start-omen.sh` (gestisce lo spazio nel path) |
| **Auto-deploy** | `~/auto-deploy.sh` (cron ogni minuto, git pull + restart) |
| **Tunnel** | `cloudflared.service` (systemd, persistente) |
| **Storage** | HDD 914 Go `/` + SSD NVMe 469 Go `/mnt/ssd` = **1.3 To** |
| **SSH** | `ssh massii08@192.168.68.72` (IP DHCP, peut changer) |
| **Agenti** | `omen_agent.py` su ogni PC del network |

---

## 📂 File importanti da leggere prima di lavorare

| Priorità | File | Motivo |
|----------|------|--------|
| ⭐⭐⭐ | `CLAUDE.md` | Contesto completo del progetto |
| ⭐⭐⭐ | `backend/main.py` | Tutti i router registrati |
| ⭐⭐ | `frontend/js/app.js` | Router SPA + struttura dashboard |
| ⭐⭐ | `frontend/js/auth.js` | Come funzionano le chiamate API |
| ⭐⭐ | `frontend/css/style.css` | Design system + variabili CSS |
| ⭐⭐ | `backend/monitoring/system_info.py` | Monitoring multi-dischi |
| ⭐⭐ | `backend/monitoring/nodes_router.py` | API multi-macchine |
| ⭐⭐ | `backend/scheduler/power_router.py` | Gestione alimentazione (reboot/shutdown) |
| ⭐ | `frontend/js/lang.js` | Struttura delle traduzioni |
| ⭐ | `frontend/js/monitoring.js` | Stats combinate + carta Omen + nodi |
| ⭐ | `frontend/index.html` | Versioni cache JS (`?v=XX`) |
| ⭐ | `frontend/sw.js` | Service Worker (PWA, `CACHE_NAME`) |
| ⭐ | `backend/config.py` | Variabili di configurazione |
| ⭐ | `tools/omen_agent.py` | Agent per i PC "braccio" |
