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

---

## 📂 File importanti da leggere prima di lavorare

| Priorità | File | Motivo |
|----------|------|--------|
| ⭐⭐⭐ | `CLAUDE.md` | Contesto completo del progetto |
| ⭐⭐⭐ | `backend/main.py` | Tutti i router registrati |
| ⭐⭐ | `frontend/js/app.js` | Router SPA + struttura dashboard |
| ⭐⭐ | `frontend/js/auth.js` | Come funzionano le chiamate API |
| ⭐⭐ | `frontend/css/style.css` | Design system + variabili CSS |
| ⭐ | `frontend/js/lang.js` | Struttura delle traduzioni |
| ⭐ | `backend/config.py` | Variabili di configurazione |
