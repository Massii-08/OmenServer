# Diagnostic Agent (intégré OmenServer)

Agent Python qui pousse les métriques (RAM, processus, indice de souffrance) au hub
OmenServer via WebSocket, et reçoit des commandes (suspend process, bulk suspend,
run action). C'est le pendant du `omen_agent.py` classique mais beaucoup plus riche
(le omen_agent classique fait juste un heartbeat 10s).

---

## 🪟 Installation Windows (recommandée)

**1. Cloner le repo OmenServer** (ou copier juste ce dossier) :
```cmd
git clone https://github.com/Massii-08/omenserver.git
cd omenserver\tools\diagnostic_agent
```

**2. Lancer le setup interactif** (double-clic ou cmd) :
```cmd
setup_windows.bat
```
Le script :
- Vérifie Python (3.9+ requis)
- Crée un venv local
- Installe les deps
- Demande les 3 valeurs de config et les écrit dans `.env`

**3. Lancer l'agent** :
```cmd
run.bat
```
La fenêtre reste ouverte avec les logs. Ctrl+C pour arrêter.

**4. Installer en service Windows** (optionnel, auto-start au boot) :
- Télécharger NSSM depuis https://nssm.cc/download
- Placer `nssm.exe` dans ce dossier (ou dans le PATH système)
- Clic droit sur `install_service.bat` → **Exécuter en tant qu'administrateur**

Le service `OmenDiagnosticAgent` apparaîtra dans `services.msc`, auto-start au boot,
restart auto en cas de crash. Logs dans `logs/agent.log` + `logs/agent.err.log`.

Pour arrêter / désinstaller :
```cmd
nssm stop OmenDiagnosticAgent
nssm remove OmenDiagnosticAgent confirm
```

---

## 🍎 Installation manuelle (macOS / Linux dev)

```bash
cd "Projet serveur/tools/diagnostic_agent"
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Option A — .env local (recommandé)
cat > .env <<EOF
OMEN_AGENT_USERNAME=Massii_08
OMEN_HUB_URL=ws://localhost:8000/ws/sysdoc
# Sur le dev local macOS, l'agent auto-charge SECRET_KEY depuis ../../.env
# du hub — pas besoin de le mettre ici
EOF

# Option B — variables d'environnement directes
export OMEN_AGENT_USERNAME=Massii_08
export OMEN_HUB_URL=ws://localhost:8000/ws/sysdoc

python main.py
```

---

## 🔧 Configuration

Trois variables sont lues par l'agent (par ordre de priorité) :

| Var | Description |
|---|---|
| `OMEN_AGENT_USERNAME` | Username OmenServer (ex: `Massii_08`). DOIT exister dans la DB du hub. |
| `OMEN_HUB_URL` | URL WS de base du hub. `wss://omenserver.org/ws/sysdoc` (prod) ou `ws://localhost:8000/ws/sysdoc` (dev) |
| `OMEN_JWT_SECRET` | Le `SECRET_KEY` de `backend/config.py` du hub. **DOIT matcher** sinon JWT invalide |

**Priorité de lecture** :
1. Variable d'environnement système (`export OMEN_JWT_SECRET=...`)
2. Fichier `.env` à côté de `main.py`
3. (Dev macOS seulement) Auto-load depuis `../../.env` du hub

⚠️ Le `.env` LOCAL de l'agent (`tools/diagnostic_agent/.env`) est dans `.gitignore`
au niveau du repo OmenServer. **NE LE COMMIT JAMAIS** — il contient le secret JWT.

---

## 🔑 Où trouver le SECRET_KEY du hub prod

Sur la machine Omen (Ubuntu Server) :
```bash
ssh massii08@<ip-omen>
grep ^SECRET_KEY= ~/omenserver/.env
```

Copier la valeur **après le `=`** (sans guillemets) dans `OMEN_JWT_SECRET`.

Si tu changes le `SECRET_KEY` sur le hub, tu dois aussi le mettre à jour sur **toutes**
les machines qui ont un Diagnostic Agent installé, sinon leurs JWT seront refusés.

---

## 🔌 URL WS

L'agent se connecte à `{OMEN_HUB_URL}/agent/{username}?token={jwt}` où le JWT contient
`sub = username`, `exp = now + 24h`, signé HS256 avec `OMEN_JWT_SECRET`.

Le hub route les messages strict 1:1 par username :
- Agent → Viewer du même username : `{type: "metrics"|"command_result"|...}`
- Viewer → Agent du même username : commandes `SUSPEND_PROCESS`, `BULK_SUSPEND`, `RUN_ACTION`, etc.

---

## 🛡️ Sécurité

- **1 user OmenServer ↔ 1 diagnostic agent** strict via username dans l'URL
- **L'agent n'exécute JAMAIS les actions tier `risky`** — il renvoie une erreur même
  si la commande est valide. Les instructions risky sont uniquement affichées dans
  le dashboard pour application manuelle par l'utilisateur.
- **Safe List** côté `modules/process_manager.py` protège les binaires Windows
  système (`System32`, `SysWOW64`, 10 noms exacts). Sur macOS, les procs sous
  `/System/` `/usr/` `/Library/Frameworks/` sont groupés visuellement sous
  "Système" mais ne sont PAS protégés actuellement (à étendre).
- **JWT expiration** 24h — l'agent re-génère un token à chaque reconnexion. Si le
  hub est down longtemps, l'agent reste en boucle reconnect avec `MIN_BACKOFF=1s`.
