# Module Diagnostic / sysdoc

Extrait du CLAUDE.md racine le 2026-11-25. Pièges : #20, #21, #22, #23, #24, #25, #26, #27.

## 🩺 Module Diagnostic / sysdoc (V4 multi-machine)

Le **Diagnostic Bot** est intégré comme module SPA dans le hub. Permet de superviser le Mac et le PC Windows de l'utilisateur depuis n'importe quel browser logué.

### Architecture WS

- **Agent** (`tools/diagnostic_agent/`) tourne sur chaque PC de l'utilisateur. Connecte `/ws/sysdoc/agent/{username}/{machine}` (multi-machine par user, `machine` = hostname par défaut).
- **Viewer** (frontend SPA) connecte `/ws/sysdoc/viewer/{username}`. Reçoit les messages de TOUTES les machines (taggés `machine` par le backend), affiche un sélecteur de pills en haut quand >1 machine.
- **ConnectionManager** : `agents = Dict[str, Dict[str, WebSocket]]` (user→machine→ws). `viewers = Dict[str, Set[WebSocket]]` (broadcast à tous les onglets ouverts).

### Auto-start de l'agent

- **macOS** : LaunchAgent via `setup_macos.sh` (install/start/stop/restart/status/logs/uninstall + enable-dns-flush pour sudoers DNS).
- **Windows** : Tâche planifiée via PowerShell admin avec `pythonw.exe` (PAS `python.exe` — voir piège #19). Installable via le panel install du dashboard (bouton "+ Ajouter un PC").

### Pattern unique au sysdoc

- **Mode idle/active** : l'agent ne pousse pas de metrics au boot. Reste en idle, écoute juste `START_MONITORING` / `STOP_MONITORING` / `QUERY_STATE` / `LIST_ACTIONS` / `RUN_ACTION` / `SUSPEND_PROCESS` / `RESUME_PROCESS` / `BULK_SUSPEND`. Économie CPU/réseau quand l'utilisateur n'est pas sur la page.
- **Trousse 3 tiers** (safe/moderate/risky) : safe et moderate sont exécutées par l'agent, risky est REFUSÉE même si commandée (dead man's switch, le frontend affiche juste les instructions).
- **Persistance machines en localStorage** : `sysdoc.machines.<user>` → les pills offline restent visibles même après reload.
- **/api/sysdoc/me** : retourne `secret_key` UNIQUEMENT si `is_admin=true` → permet au panel install de pré-remplir le SECRET_KEY dans les commandes copy-pastables.

## ⚠️ Pièges (numéro historique conservé)

20. **Windows Task Scheduler + `python.exe` = `STATUS_CONTROL_C_EXIT`** : si on crée une tâche planifiée qui exécute `python.exe -u main.py`, Windows attache une console à la session interactive. Quand l'utilisateur ferme la PowerShell où il a fait `Start-ScheduledTask`, Windows propage `CTRL_CLOSE_EVENT` → le python reçoit SIGINT → exit avec code `3221225786` (`0xC000013A`). **Solution** : utiliser `pythonw.exe` (sans le `e`, le `w` = no console). Le venv Windows en contient un d'office. Bloc complet dans le panel install Windows du dashboard.

21. **Triple-paste du SECRET_KEY au setup** : `setup_macos.sh` et `setup_windows.bat` utilisent `read -s` pour masquer l'input du SECRET_KEY. Si l'utilisateur appuie Cmd+V/Ctrl+V plusieurs fois sans s'en rendre compte (input masqué), la valeur est concaténée 2-3× dans le `.env` → JWT invalide → close code 1008 du hub → reconnect storm. Diagnostic : `python3 -c "print(len(open('.env').read().split('OMEN_JWT_SECRET=')[1].strip()))"`. Fix : remplacer la ligne via un Python script idempotent.

22. **macOS `killall mDNSResponder` sans sudo** : Catalina+ exige sudo. L'agent LaunchAgent tourne en user → ne peut pas exécuter sans password (un service ne peut pas prompt interactif). Solution : `setup_macos.sh enable-dns-flush` qui crée `/etc/sudoers.d/omen-diagnostic-agent` avec une règle ultra-restrictive (UNIQUEMENT cette commande sans password). One-shot, demande sudo une fois pour écrire le fichier sudoers.

23. **PowerShell + `.\` prefix obligatoire** : pour exécuter un script du cwd (ex: `setup_windows.bat`), faut `.\setup_windows.bat`. Sans le `.\`, erreur "n'est pas reconnu comme nom d'applet de commande". Protection anti-PATH-hijacking. En cmd.exe le `.\` n'est pas nécessaire.

24. **PowerShell s'ouvre dans `C:\Windows\system32`** : surtout en admin. `git clone` y échoue avec "Permission denied". Faut `cd ~` avant tout pour aller dans `C:\Users\<user>` (writable).

25. **Bloc de commandes "exemples utiles" copy-pasté en bloc** : PowerShell exécute en séquence si l'utilisateur colle plusieurs commandes ensemble. Si y'a un `Unregister-ScheduledTask` ou `rm` dans le lot, la dernière commande exécute et détruit ce que les précédentes ont créé. **Toujours documenter les commandes individuelles dans des blocs SÉPARÉS** avec une note "à utiliser une par une".

26. **NSSM (`nssm.cc`) souvent down 503** : mainteneur unique. Pour Windows Service alternative : `choco install nssm` / `scoop install nssm`, OU mieux **éviter NSSM totalement** via Tâche planifiée Windows (recommandé maintenant — voir piège #20 pour la version `pythonw.exe`).

27. **Multi-machine WS path** : le sysdoc utilise `/ws/sysdoc/agent/{username}/{machine}` (pas juste `{username}`). `machine` = `socket.gethostname()` sanitized par défaut, override possible via `OMEN_AGENT_MACHINE` env var. Le ConnectionManager garde un `Dict[user, Dict[machine, WS]]`. Si 2 PCs s'installent avec le MÊME machine_id, ils se kickent (strict 1:1 par machine). Solution : machine_id unique par PC (le hostname suffit usually).
