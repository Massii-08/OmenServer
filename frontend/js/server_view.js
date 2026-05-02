const ServerView = {
    serverId: null,
    serverData: null,
    currentTab: 'dashboard',
    _ws: null,

    async open(id) {
        this.serverId = id;
        this.currentTab = 'dashboard';
        const content = document.getElementById('module-content');
        content.innerHTML = '<div style="text-align:center;padding:60px;color:var(--text-muted)">⏳ Chargement...</div>';
        await this.refreshServer();
        this.render();
    },

    async refreshServer() {
        const r = await Auth.apiCall(`/api/servers/${this.serverId}`);
        if (r && r.ok) this.serverData = await r.json();
    },

    render() {
        const s = this.serverData;
        if (!s) return;
        const content = document.getElementById('module-content');
        const isRunning = s.status === 'running';
        const statusColor = isRunning ? 'var(--accent-green)' : 'var(--text-muted)';
        const statusText = isRunning ? 'En ligne' : 'Arrêté';

        content.innerHTML = `
        <div style="display:flex;height:100%;overflow:hidden;">
            <div id="sv-sidebar" style="width:220px;min-width:220px;background:var(--bg-secondary);border-right:1px solid var(--border-color);padding:16px 0;overflow-y:auto;">
                <div style="padding:0 16px 16px;border-bottom:1px solid var(--border-color);margin-bottom:8px;">
                    <div style="font-size:18px;font-weight:700;">${s.name || 'Serveur'}</div>
                    <div style="font-size:12px;color:${statusColor};margin-top:4px;">● ${statusText}</div>
                    <div style="display:flex;gap:6px;margin-top:10px;">
                        ${isRunning ? `
                        <button class="btn btn-sm btn-secondary" onclick="ServerView.action('stop')">⏹</button>
                        <button class="btn btn-sm btn-secondary" onclick="ServerView.action('restart')">🔄</button>
                        ` : `
                        <button class="btn btn-sm btn-primary" onclick="ServerView.action('start')">▶️ Démarrer</button>
                        `}
                    </div>
                </div>
                ${this._sidebarItems()}
            </div>
            <div id="sv-content" style="flex:1;overflow-y:auto;padding:24px;">
                ${this._tabContent()}
            </div>
        </div>`;
        this._bindEvents();
    },

    _sidebarItems() {
        const tabs = [
            {id:'dashboard',icon:'📊',label:'Tableau de bord'},
            {id:'console',icon:'💻',label:'Console'},
            {id:'settings',icon:'⚙️',label:'Paramètres'},
            {id:'files',icon:'📁',label:'Fichiers'},
            {id:'access',icon:'🔌',label:'Accès'},
            {id:'backups',icon:'💾',label:'Sauvegardes'},
            {id:'scheduler',icon:'⏰',label:'Tâches planifiées'},
            {id:'monitoring',icon:'📈',label:'Monitoring temps réel'},
            {id:'history',icon:'📜',label:'Historique'},
            {id:'players',icon:'👥',label:'Joueurs'},
            {id:'mods',icon:'🧩',label:'Mods & Plugins'},
            {id:'notifications',icon:'🔔',label:'Notifications'},
        ];
        return tabs.map(t => `
            <a class="sv-tab ${this.currentTab===t.id?'active':''}" onclick="ServerView.switchTab('${t.id}')" style="display:flex;align-items:center;gap:10px;padding:10px 20px;cursor:pointer;color:${this.currentTab===t.id?'var(--accent-blue)':'var(--text-primary)'};background:${this.currentTab===t.id?'rgba(59,130,246,0.1)':'transparent'};font-size:13px;font-weight:${this.currentTab===t.id?'600':'400'};border-left:3px solid ${this.currentTab===t.id?'var(--accent-blue)':'transparent'};transition:all .15s;">
                <span>${t.icon}</span>${t.label}
            </a>
        `).join('');
    },

    switchTab(tab) {
        if (this._ws) { this._ws.close(); this._ws = null; }
        if (typeof SvMonitoring !== 'undefined') SvMonitoring.stop();
        this.currentTab = tab;
        document.getElementById('sv-sidebar').innerHTML = `
            <div style="padding:0 16px 16px;border-bottom:1px solid var(--border-color);margin-bottom:8px;">
                <div style="font-size:18px;font-weight:700;">${this.serverData?.name||'Serveur'}</div>
                <div style="font-size:12px;color:${this.serverData?.status==='running'?'var(--accent-green)':'var(--text-muted)'};margin-top:4px;">● ${this.serverData?.status==='running'?'En ligne':'Arrêté'}</div>
            </div>
            ${this._sidebarItems()}`;
        document.getElementById('sv-content').innerHTML = this._tabContent();
        this._bindEvents();
    },

    _tabContent() {
        switch(this.currentTab) {
            case 'dashboard': return this._dashboardTab();
            case 'console': return this._consoleTab();
            case 'backups': return this._backupsTab();
            case 'scheduler': return this._schedulerTab();
            case 'mods': return this._modsTab();
            case 'settings': return SvSettings.render(this.serverData, this.serverId);
            case 'files': return SvFiles.render(this.serverId);
            case 'monitoring': return SvMonitoring.render(this.serverId);
            case 'access': return SvAccess.render(this.serverData, this.serverId);
            case 'players': return SvPlayers.render(this.serverId);
            case 'history': return SvHistory.render(this.serverId);
            case 'notifications': return this._notificationsTab();
            default: return '<p>Section en cours de développement</p>';
        }
    },

    _dashboardTab() {
        const s = this.serverData;
        const isRunning = s.status === 'running';
        const addr = `${GameServer._serverIP || 'localhost'}:${s.port||25565}`;
        const game = GameServer._games?.find(g => g.id === s.game_type);
        const gameIcon = game ? game.icon : '🎮';
        const gameName = game ? game.name : (s.game_type || 'minecraft');
        
        // Calculer l'uptime approximatif
        const uptimeHtml = isRunning ? '<span style="color:var(--accent-green);font-weight:600;">● En ligne</span>' : '<span style="color:var(--text-muted);">○ Arrêté</span>';
        
        setTimeout(() => this._loadDashboardStats(), 100);
        
        return `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
            <h2 style="margin:0;">📊 Tableau de bord</h2>
            <button class="btn btn-secondary btn-sm" onclick="App.navigateTo('game_server')">← Retour à la liste</button>
        </div>

        <!-- Boutons de contrôle -->
        <div style="display:flex;gap:8px;margin-bottom:20px;">
            ${isRunning ? `
                <button class="btn btn-danger" onclick="ServerView.action('stop')" style="flex:1;">⏹️ Arrêter</button>
                <button class="btn btn-secondary" onclick="ServerView.action('restart')" style="flex:1;">🔄 Redémarrer</button>
            ` : `
                <button class="btn btn-primary" onclick="ServerView.action('start')" style="flex:1;">▶️ Démarrer</button>
            `}
        </div>

        <!-- Stats principales -->
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;margin-bottom:20px;">
            <div style="background:var(--bg-secondary);padding:16px;border-radius:10px;text-align:center;">
                <div style="font-size:24px;margin-bottom:4px;">${gameIcon}</div>
                <div style="font-size:12px;color:var(--text-muted);">Jeu</div>
                <div style="font-size:14px;font-weight:600;margin-top:2px;">${gameName}</div>
            </div>
            <div style="background:var(--bg-secondary);padding:16px;border-radius:10px;text-align:center;">
                <div style="font-size:24px;margin-bottom:4px;">📡</div>
                <div style="font-size:12px;color:var(--text-muted);">Statut</div>
                <div style="font-size:14px;margin-top:2px;">${uptimeHtml}</div>
            </div>
            <div style="background:var(--bg-secondary);padding:16px;border-radius:10px;text-align:center;">
                <div style="font-size:24px;margin-bottom:4px;">🧠</div>
                <div style="font-size:12px;color:var(--text-muted);">RAM</div>
                <div style="font-size:14px;font-weight:600;margin-top:2px;" id="sv-dash-ram">${s.memory_mb||1024} Mo</div>
            </div>
            <div style="background:var(--bg-secondary);padding:16px;border-radius:10px;text-align:center;">
                <div style="font-size:24px;margin-bottom:4px;">⚡</div>
                <div style="font-size:12px;color:var(--text-muted);">CPU</div>
                <div style="font-size:14px;font-weight:600;margin-top:2px;" id="sv-dash-cpu">${s.cpu_percent||100}%</div>
            </div>
        </div>

        <!-- Infos connexion -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px;">
            <div style="background:var(--bg-secondary);padding:16px;border-radius:10px;">
                <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">📡 Adresse de connexion</div>
                <div style="display:flex;align-items:center;gap:8px;">
                    <span style="font-family:monospace;font-size:16px;font-weight:700;color:var(--accent-green);">${addr}</span>
                    <button class="btn btn-secondary btn-sm" onclick="navigator.clipboard.writeText('${addr}');this.textContent='✅';setTimeout(()=>this.textContent='📋',1500)" style="padding:2px 8px;">📋</button>
                </div>
            </div>
            <div style="background:var(--bg-secondary);padding:16px;border-radius:10px;">
                <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">🏷️ Version</div>
                <div style="font-size:16px;font-weight:600;">${gameName} · v${s.version||'?'}</div>
            </div>
        </div>

        <!-- Raccourcis rapides -->
        <div style="margin-bottom:20px;">
            <div style="font-size:13px;font-weight:600;margin-bottom:10px;color:var(--text-muted);">⚡ Actions rapides</div>
            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;">
                <button class="btn btn-secondary" onclick="ServerView.switchTab('console')" style="padding:12px 8px;font-size:12px;">💻 Console</button>
                <button class="btn btn-secondary" onclick="ServerView.switchTab('files')" style="padding:12px 8px;font-size:12px;">📁 Fichiers</button>
                <button class="btn btn-secondary" onclick="ServerView.switchTab('backups')" style="padding:12px 8px;font-size:12px;">💾 Sauvegarder</button>
                <button class="btn btn-secondary" onclick="ServerView.switchTab('players')" style="padding:12px 8px;font-size:12px;">👥 Joueurs</button>
            </div>
        </div>

        <!-- Stats Docker live -->
        <div id="sv-dash-docker" style="background:var(--bg-secondary);padding:16px;border-radius:10px;">
            <div style="font-size:13px;font-weight:600;margin-bottom:8px;">🐳 Docker — Ressources en temps réel</div>
            <div style="color:var(--text-muted);font-size:12px;">⏳ Chargement...</div>
        </div>`;
    },

    _consoleTab() {
        setTimeout(() => this._startConsoleWS(), 100);
        return `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
            <h2 style="margin:0;">💻 Console</h2>
            <div style="display:flex;gap:8px;">
                <span id="sv-console-status" style="font-size:11px;padding:4px 8px;border-radius:4px;background:var(--bg-secondary);color:var(--text-muted);">⏳ Connexion...</span>
                <button class="btn btn-secondary btn-sm" onclick="document.getElementById('sv-console-logs').innerHTML=''">🗑 Effacer</button>
            </div>
        </div>
        <div id="sv-console-logs" style="background:#0d1117;color:#c9d1d9;font-family:'Courier New',monospace;font-size:12px;padding:12px;border-radius:8px;height:400px;overflow-y:auto;white-space:pre-wrap;line-height:1.5;"></div>
        <div style="display:flex;gap:8px;margin-top:8px;">
            <input id="sv-console-input" class="form-input" placeholder="Entrez une commande..." style="flex:1;font-family:monospace;" onkeydown="if(event.key==='Enter')ServerView.sendCommand()"/>
            <button class="btn btn-primary" onclick="ServerView.sendCommand()">📤 Envoyer</button>
        </div>
        <p style="font-size:11px;color:var(--text-muted);margin-top:8px;">💡 Les commandes sont envoyées via rcon-cli. Exemples : <code>say Bonjour</code>, <code>list</code>, <code>op Massii_08</code></p>`;
    },

    _appendLog(text, color) {
        const logs = document.getElementById('sv-console-logs');
        if (!logs) return;
        const span = document.createElement('span');
        span.style.color = color || '#c9d1d9';
        span.textContent = text + '\n';
        logs.appendChild(span);
        logs.scrollTop = logs.scrollHeight;
    },

    _startConsoleWS() {
        if (this._ws) this._ws.close();
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const token = Auth.getToken();
        // URL corrigée : /ws/servers/{id}/console
        this._ws = new WebSocket(`${proto}://${location.host}/ws/servers/${this.serverId}/console?token=${token}`);

        const statusEl = document.getElementById('sv-console-status');

        this._ws.onopen = () => {
            if (statusEl) { statusEl.textContent = '🟢 Connecté'; statusEl.style.color = 'var(--accent-green)'; }
            this._appendLog('--- Console connectée ---', '#22c55e');
        };

        this._ws.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                if (msg.type === 'log') {
                    this._appendLog(msg.data, '#c9d1d9');
                } else if (msg.type === 'info') {
                    this._appendLog(msg.data, '#3b82f6');
                } else if (msg.type === 'error') {
                    this._appendLog('❌ ' + (msg.message || msg.data), '#ef4444');
                } else {
                    this._appendLog(JSON.stringify(msg), '#c9d1d9');
                }
            } catch {
                // Message texte brut
                this._appendLog(e.data, '#c9d1d9');
            }
        };

        this._ws.onclose = () => {
            if (statusEl) { statusEl.textContent = '🔴 Déconnecté'; statusEl.style.color = '#ef4444'; }
            this._appendLog('--- Console déconnectée ---', '#ef4444');
        };

        this._ws.onerror = () => {
            this._appendLog('--- Erreur de connexion WebSocket ---', '#ef4444');
        };
    },

    sendCommand() {
        const input = document.getElementById('sv-console-input');
        if (input && input.value.trim() && this._ws && this._ws.readyState === WebSocket.OPEN) {
            const cmd = input.value.trim();
            // Afficher la commande localement
            this._appendLog('> ' + cmd, '#f59e0b');
            // Envoyer au format attendu par le backend
            this._ws.send(JSON.stringify({type: 'command', data: cmd}));
            input.value = '';
        }
    },

    _backupsTab() {
        setTimeout(() => this._loadBackups(), 50);
        return `<h2>💾 Sauvegardes</h2>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:12px;">Gérez les sauvegardes de votre serveur</p>
        
        <!-- Formulaire de création -->
        <div style="background:var(--bg-secondary);padding:14px;border-radius:10px;margin-bottom:16px;">
            <div style="font-size:13px;font-weight:600;margin-bottom:8px;">➕ Nouvelle sauvegarde</div>
            <div style="display:flex;gap:8px;align-items:center;">
                <input id="sv-backup-name" class="form-input" placeholder="Nom (optionnel, ex: avant-update-1.21)" style="flex:1;" />
                <button class="btn btn-primary btn-sm" id="sv-backup-btn" onclick="ServerView._createBackup()">💾 Créer</button>
            </div>
            <span id="sv-backup-msg" style="font-size:12px;display:block;margin-top:6px;"></span>
        </div>
        
        <div id="sv-backups-list"><div style="color:var(--text-muted)">⏳ Chargement...</div></div>`;
    },

    async _loadBackups() {
        const r = await Auth.apiCall(`/api/servers/${this.serverId}/backups`);
        const el = document.getElementById('sv-backups-list');
        if (!el) return;
        if (!r || !r.ok) { el.innerHTML='<p style="color:#e74c3c">❌ Erreur de chargement</p>'; return; }
        const data = await r.json();
        const backups = data.backups || data || [];
        if (backups.length===0) { el.innerHTML='<p style="color:var(--text-muted)">Aucune sauvegarde. Créez-en une ci-dessus.</p>'; return; }
        
        el.innerHTML = backups.map(b => {
            // Extraire le nom lisible (avant le timestamp)
            const parts = (b.id||'').split('_');
            const displayName = parts.length >= 3 ? parts.slice(0, -2).join('_') : (b.id || b.filename);
            
            return `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:12px;background:var(--bg-secondary);border-radius:8px;margin-bottom:6px;" id="sv-bk-${b.id}">
                <div style="flex:1;min-width:0;">
                    <div style="font-weight:600;font-size:14px;">📦 ${displayName}</div>
                    <div style="font-size:11px;color:var(--text-muted);">${b.size_mb||'?'} Mo · ${b.created_at||''}</div>
                </div>
                <div style="display:flex;gap:6px;flex-shrink:0;">
                    <button class="btn btn-sm btn-secondary" onclick="ServerView._renameBackup('${b.id}','${displayName.replace(/'/g,"\\'")}')" title="Renommer">✏️</button>
                    <button class="btn btn-sm btn-secondary" onclick="ServerView._restoreBackup('${b.id}')" title="Restaurer">♻️</button>
                    <button class="btn btn-sm btn-danger" onclick="ServerView._confirmDeleteBackup('${b.id}')" title="Supprimer">🗑️</button>
                </div>
            </div>`;
        }).join('');
    },

    async _createBackup() {
        const btn = document.getElementById('sv-backup-btn');
        const msg = document.getElementById('sv-backup-msg');
        const nameInput = document.getElementById('sv-backup-name');
        const backupName = nameInput ? nameInput.value.trim() : '';
        
        if (btn) btn.disabled = true;
        if (msg) { msg.style.color = 'var(--accent-blue)'; msg.textContent = '⏳ Sauvegarde en cours...'; }
        
        const body = backupName ? JSON.stringify({backup_name: backupName}) : null;
        const opts = {method: 'POST'};
        if (body) opts.body = body;
        
        const r = await Auth.apiCall(`/api/servers/${this.serverId}/backup`, opts);
        if (r && r.ok) {
            if (msg) { msg.style.color = 'var(--accent-green)'; msg.textContent = '✅ Sauvegarde créée !'; }
            if (nameInput) nameInput.value = '';
        } else {
            const err = r ? await r.json().catch(()=>({})) : {};
            if (msg) { msg.style.color = '#e74c3c'; msg.textContent = `❌ ${err.detail || 'Erreur'}`; }
        }
        if (btn) btn.disabled = false;
        this._loadBackups();
    },

    async _renameBackup(id, currentName) {
        const newName = prompt('Nouveau nom pour la sauvegarde :', currentName);
        if (!newName || newName.trim() === '' || newName.trim() === currentName) return;
        
        const msg = document.getElementById('sv-backup-msg');
        const r = await Auth.apiCall(`/api/servers/${this.serverId}/backups/${id}`, {
            method: 'PUT',
            body: JSON.stringify({new_name: newName.trim()})
        });
        
        if (r && r.ok) {
            if (msg) { msg.style.color = 'var(--accent-green)'; msg.textContent = '✅ Sauvegarde renommée !'; }
        } else {
            const err = r ? await r.json().catch(()=>({})) : {};
            if (msg) { msg.style.color = '#e74c3c'; msg.textContent = `❌ ${err.detail || 'Erreur'}`; }
        }
        this._loadBackups();
    },

    async _restoreBackup(id) {
        if (!confirm('Restaurer cette sauvegarde ? Le serveur doit être arrêté.')) return;
        const msg = document.getElementById('sv-backup-msg');
        if (msg) { msg.style.color = 'var(--accent-blue)'; msg.textContent = '⏳ Restauration...'; }
        const r = await Auth.apiCall(`/api/servers/${this.serverId}/restore/${id}`,{method:'POST'});
        if (r && r.ok) {
            if (msg) { msg.style.color = 'var(--accent-green)'; msg.textContent = '✅ Restauration effectuée !'; }
        } else {
            const err = r ? await r.json().catch(()=>({})) : {};
            if (msg) { msg.style.color = '#e74c3c'; msg.textContent = `❌ ${err.detail || 'Erreur'}`; }
        }
    },

    _confirmDeleteBackup(id) {
        // Inline confirm — remplace le contenu de la carte par une confirmation
        const row = document.getElementById(`sv-bk-${id}`);
        if (!row) return;
        row.style.background = 'rgba(231,76,60,0.15)';
        row.style.border = '1px solid rgba(231,76,60,0.3)';
        row.innerHTML = `
            <div style="flex:1;">
                <div style="font-weight:600;color:#e74c3c;">⚠️ Supprimer cette sauvegarde ?</div>
                <div style="font-size:12px;color:var(--text-muted);">Cette action est irréversible.</div>
            </div>
            <div style="display:flex;gap:6px;">
                <button class="btn btn-sm btn-danger" onclick="ServerView._deleteBackup('${id}')">🗑️ Confirmer</button>
                <button class="btn btn-sm btn-secondary" onclick="ServerView._loadBackups()">Annuler</button>
            </div>`;
    },

    async _deleteBackup(id) {
        const msg = document.getElementById('sv-backup-msg');
        if (msg) { msg.style.color = 'var(--accent-blue)'; msg.textContent = '⏳ Suppression...'; }
        const r = await Auth.apiCall(`/api/servers/${this.serverId}/backups/${id}`,{method:'DELETE'});
        if (r && r.ok) {
            if (msg) { msg.style.color = 'var(--accent-green)'; msg.textContent = '✅ Sauvegarde supprimée !'; }
        } else {
            const err = r ? await r.json().catch(()=>({})) : {};
            if (msg) { msg.style.color = '#e74c3c'; msg.textContent = `❌ ${err.detail || 'Erreur'}`; }
        }
        this._loadBackups();
    },

    _schedulerTab() {
        setTimeout(() => this._loadTasks(), 50);
        return `<h2>⏰ Tâches planifiées</h2>
        <div style="background:var(--bg-secondary);padding:14px;border-radius:8px;margin-bottom:14px;">
            <div class="flex gap-2" style="align-items:flex-end;">
                <div style="flex:1"><label style="font-size:12px;color:var(--text-muted)">Type</label><select id="sv-task-type" class="form-input" style="margin-top:4px;"><option value="backup">💾 Backup</option><option value="restart">🔄 Restart</option></select></div>
                <div style="flex:1"><label style="font-size:12px;color:var(--text-muted)">Intervalle</label><select id="sv-task-interval" class="form-input" style="margin-top:4px;"><option value="1">1h</option><option value="6" selected>6h</option><option value="12">12h</option><option value="24">24h</option></select></div>
                <button class="btn btn-primary" onclick="ServerView._createTask()">➕</button>
            </div>
        </div>
        <div id="sv-tasks-list"><div style="color:var(--text-muted)">⏳</div></div>`;
    },

    async _loadTasks() {
        const r = await Auth.apiCall(`/api/scheduler/server/${this.serverId}`);
        const el = document.getElementById('sv-tasks-list');
        if (!r||!r.ok||!el) return;
        const tasks = await r.json();
        if (tasks.length===0) { el.innerHTML='<p style="color:var(--text-muted)">Aucune tâche</p>'; return; }
        el.innerHTML = tasks.map(t => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px;background:var(--bg-secondary);border-radius:8px;margin-bottom:6px;">
                <div><span style="font-weight:600;">${t.task_type==='backup'?'💾 Backup':'🔄 Restart'}</span> · toutes les ${t.interval_hours}h <span style="color:${t.enabled?'var(--accent-green)':'var(--text-muted)'};">${t.enabled?'● Actif':'○ Inactif'}</span></div>
                <div class="flex gap-2">
                    <button class="btn btn-sm btn-secondary" onclick="ServerView._toggleTask(${t.id})">${t.enabled?'⏸':'▶️'}</button>
                    <button class="btn btn-sm btn-danger" onclick="ServerView._deleteTask(${t.id})">🗑️</button>
                </div>
            </div>`).join('');
    },

    async _createTask() {
        const type = document.getElementById('sv-task-type').value;
        const interval = parseInt(document.getElementById('sv-task-interval').value);
        await Auth.apiCall('/api/scheduler/',{method:'POST',body:JSON.stringify({server_id:this.serverId,task_type:type,interval_hours:interval})});
        this._loadTasks();
    },

    async _toggleTask(id) { await Auth.apiCall(`/api/scheduler/${id}/toggle`,{method:'POST'}); this._loadTasks(); },
    async _deleteTask(id) { await Auth.apiCall(`/api/scheduler/${id}`,{method:'DELETE'}); this._loadTasks(); },

    _modsTab() {
        this._modMode = this._modMode || 'plugins';
        return `<h2>🧩 Mods & Plugins</h2>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:12px;">Installez des plugins (Spigot/Paper) ou des mods (Forge/Fabric)</p>

        <!-- Sous-navigation -->
        <div style="display:flex;gap:4px;margin-bottom:16px;background:var(--bg-secondary);padding:4px;border-radius:8px;width:fit-content;">
            <button class="btn btn-sm ${this._modMode==='plugins'?'btn-primary':'btn-secondary'}" onclick="ServerView._modMode='plugins';ServerView.switchTab('mods')">🔌 Plugins</button>
            <button class="btn btn-sm ${this._modMode==='installed'?'btn-primary':'btn-secondary'}" onclick="ServerView._modMode='installed';ServerView.switchTab('mods')">📦 Installés</button>
            <button class="btn btn-sm ${this._modMode==='mods'?'btn-primary':'btn-secondary'}" onclick="ServerView._modMode='mods';ServerView.switchTab('mods')">🧩 Mods (CurseForge)</button>
        </div>

        <div id="sv-mods-content">${this._modModeContent()}</div>`;
    },

    _modModeContent() {
        if (this._modMode === 'plugins') return this._pluginsSearch();
        if (this._modMode === 'installed') { setTimeout(() => this._loadInstalledPlugins(), 50); return '<div id="sv-installed-list"><div style="color:var(--text-muted)">⏳ Chargement...</div></div>'; }
        if (this._modMode === 'mods') return this._modsSearch();
        return '';
    },

    // ============ PLUGINS (Modrinth) ============

    _pluginsSearch() {
        return `
        <div style="display:flex;gap:8px;margin-bottom:12px;">
            <input id="sv-plugin-q" class="form-input" placeholder="Rechercher un plugin (ex: EssentialsX, Vault, WorldEdit)..." style="flex:1;" onkeydown="if(event.key==='Enter')ServerView._searchPlugins()" />
            <button class="btn btn-primary" onclick="ServerView._searchPlugins()">🔍 Rechercher</button>
        </div>
        <div id="sv-plugin-results"><div style="color:var(--text-muted)">🔌 Recherchez un plugin pour Spigot/Paper/Bukkit</div></div>`;
    },

    async _searchPlugins() {
        const q = document.getElementById('sv-plugin-q')?.value?.trim();
        if (!q) return;
        const el = document.getElementById('sv-plugin-results');
        if (!el) return;
        el.innerHTML = '<div style="color:var(--text-muted)">⏳ Recherche sur Modrinth...</div>';

        const r = await Auth.apiCall(`/api/plugins/search?q=${encodeURIComponent(q)}`);
        if (!r || !r.ok) { el.innerHTML = '<div style="color:#e74c3c">❌ Erreur de connexion à Modrinth</div>'; return; }
        const data = await r.json();
        const plugins = data.plugins || [];

        if (plugins.length === 0) { el.innerHTML = '<div style="color:var(--text-muted)">Aucun résultat</div>'; return; }

        el.innerHTML = plugins.map(p => {
            const dl = p.downloads > 1000 ? `${Math.round(p.downloads/1000)}k` : p.downloads;
            const cats = (p.categories||[]).slice(0,3).map(c => `<span style="font-size:10px;padding:1px 5px;background:var(--bg-primary);border-radius:3px;margin-right:3px;">${c}</span>`).join('');
            return `
            <div style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--bg-secondary);border-radius:8px;margin-bottom:6px;">
                <img src="${p.icon_url||''}" style="width:40px;height:40px;border-radius:8px;object-fit:cover;" onerror="this.style.display='none'" />
                <div style="flex:1;min-width:0;">
                    <div style="font-weight:600;font-size:14px;">${p.name}</div>
                    <div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.description||''}</div>
                    <div style="margin-top:4px;">${cats} <span style="font-size:10px;color:var(--text-muted);">📥 ${dl} téléchargements</span></div>
                </div>
                <button class="btn btn-primary btn-sm" onclick="ServerView._showPluginVersions('${p.id}','${(p.name||'').replace(/'/g,"\\'")}')">📥 Installer</button>
            </div>`;
        }).join('');
    },

    async _showPluginVersions(projectId, name) {
        const el = document.getElementById('sv-plugin-results');
        if (!el) return;
        el.innerHTML = '<div style="color:var(--text-muted)">⏳ Chargement des versions...</div>';

        const r = await Auth.apiCall(`/api/plugins/${projectId}/versions`);
        if (!r || !r.ok) { el.innerHTML = '<div style="color:#e74c3c">❌ Erreur</div>'; return; }
        const data = await r.json();
        const versions = data.versions || [];

        el.innerHTML = `
            <button class="btn btn-secondary btn-sm" onclick="ServerView._searchPlugins()">← Retour</button>
            <span style="font-weight:600;margin-left:8px;font-size:15px;">📦 ${name}</span>
            <span id="sv-plugin-install-msg" style="font-size:12px;margin-left:8px;"></span>
            <div style="margin-top:12px;">
            ${versions.map(v => {
                const loaders = (v.loaders||[]).map(l => `<span style="font-size:10px;padding:1px 5px;background:var(--accent-blue);color:#fff;border-radius:3px;margin-right:3px;">${l}</span>`).join('');
                const gameVers = (v.game_versions||[]).slice(-3).join(', ');
                return `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:10px;background:var(--bg-secondary);border-radius:6px;margin-bottom:4px;">
                    <div>
                        <span style="font-weight:600;font-size:13px;">${v.name || v.version_number}</span>
                        <span style="font-size:11px;color:var(--text-muted);margin-left:6px;">(${v.size_mb} Mo)</span>
                        <div style="margin-top:3px;">${loaders} <span style="font-size:10px;color:var(--text-muted);">MC ${gameVers}</span></div>
                    </div>
                    <button class="btn btn-primary btn-sm" onclick="ServerView._installPlugin('${name.replace(/'/g,"\\'")}','${v.download_url}','${v.filename}')">📥 Installer</button>
                </div>`;
            }).join('')}
            </div>`;
    },

    async _installPlugin(name, url, filename) {
        const msg = document.getElementById('sv-plugin-install-msg');
        if (msg) { msg.style.color = 'var(--accent-blue)'; msg.textContent = '⏳ Installation...'; }

        const r = await Auth.apiCall('/api/plugins/install', {
            method: 'POST',
            body: JSON.stringify({server_id: this.serverId, plugin_name: name, download_url: url, filename: filename})
        });

        if (r && r.ok) {
            if (msg) { msg.style.color = 'var(--accent-green)'; msg.textContent = `✅ ${name} installé ! Redémarre le serveur pour l'activer.`; }
        } else {
            const err = r ? await r.json().catch(()=>({})) : {};
            if (msg) { msg.style.color = '#e74c3c'; msg.textContent = `❌ ${err.detail || 'Erreur'}`; }
        }
    },

    // ============ INSTALLÉS (liste combinée) ============

    async _loadInstalledPlugins() {
        const el = document.getElementById('sv-installed-list');
        if (!el) return;

        // Charger plugins depuis le conteneur
        const r = await Auth.apiCall(`/api/plugins/server/${this.serverId}`);
        const plugins = (r && r.ok) ? ((await r.json()).plugins || []) : [];

        if (plugins.length === 0) {
            el.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-muted);">Aucun plugin installé.<br><span style="font-size:12px;">Installez des plugins depuis l\'onglet "🔌 Plugins".</span></div>';
            return;
        }

        el.innerHTML = `<p style="color:var(--text-muted);font-size:12px;margin-bottom:8px;">${plugins.length} plugin(s) installé(s) dans /data/plugins/</p>` +
            plugins.map(p => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:var(--bg-secondary);border-radius:8px;margin-bottom:4px;">
                <div style="display:flex;align-items:center;gap:8px;">
                    <span>🔌</span>
                    <div>
                        <div style="font-weight:600;font-size:13px;">${p.filename}</div>
                        <div style="font-size:11px;color:var(--text-muted);">${p.size_mb} Mo</div>
                    </div>
                </div>
                <button class="btn btn-sm btn-danger" onclick="ServerView._removePlugin('${p.filename.replace(/'/g,"\\'")}')">🗑️ Supprimer</button>
            </div>`).join('');
    },

    async _removePlugin(filename) {
        if (!confirm(`Supprimer le plugin "${filename}" ?`)) return;
        await Auth.apiCall(`/api/plugins/server/${this.serverId}/${encodeURIComponent(filename)}`, {method: 'DELETE'});
        this._loadInstalledPlugins();
    },

    // ============ MODS (CurseForge) ============

    _modsSearch() {
        return `
        <div style="display:flex;gap:8px;margin-bottom:12px;">
            <input id="sv-mods-q" class="form-input" placeholder="Rechercher un mod (Forge/Fabric)..." style="flex:1;" onkeydown="if(event.key==='Enter')ServerView._searchMods()" />
            <select id="sv-mods-cat" class="form-input" style="width:130px;">
                <option value="mods">🧩 Mods</option>
                <option value="modpacks">📦 Modpacks</option>
            </select>
            <button class="btn btn-primary" onclick="ServerView._searchMods()">🔍</button>
        </div>
        <div id="sv-mods-results"><div style="color:var(--text-muted)">🧩 Recherchez un mod sur CurseForge</div></div>`;
    },

    async _searchMods() {
        const q = document.getElementById('sv-mods-q')?.value?.trim();
        const cat = document.getElementById('sv-mods-cat')?.value || 'mods';
        if (!q) return;
        const el = document.getElementById('sv-mods-results');
        if (!el) return;
        el.innerHTML = '<div style="color:var(--text-muted)">⏳ Recherche sur CurseForge...</div>';
        const r = await Auth.apiCall(`/api/mods/search?q=${encodeURIComponent(q)}&category=${cat}`);
        if (!r||!r.ok) { el.innerHTML='<div style="color:#e74c3c">❌ Erreur (clé CurseForge requise)</div>'; return; }
        const data = await r.json();
        const mods = data.mods||[];
        if (mods.length===0) { el.innerHTML='<div style="color:var(--text-muted)">Aucun résultat</div>'; return; }
        el.innerHTML = mods.map(m => `
            <div style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--bg-secondary);border-radius:8px;margin-bottom:6px;">
                <img src="${m.icon_url||''}" style="width:36px;height:36px;border-radius:6px;" onerror="this.style.display='none'"/>
                <div style="flex:1;min-width:0;"><div style="font-weight:600;font-size:13px;">${m.name}</div><div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${m.summary||''}</div></div>
                <button class="btn btn-primary btn-sm" onclick="ServerView._showModFiles(${m.id},'${(m.name||'').replace(/'/g,"\\'")}')">📥</button>
            </div>`).join('');
    },

    async _showModFiles(modId, name) {
        const el = document.getElementById('sv-mods-results');
        if (!el) return;
        const r = await Auth.apiCall(`/api/mods/${modId}/files`);
        if (!r||!r.ok) return;
        const files = (await r.json()).files||[];
        el.innerHTML = `<button class="btn btn-secondary btn-sm" onclick="ServerView._searchMods()">← Retour</button><span style="font-weight:600;margin-left:8px;">${name}</span><br><br>` +
            files.slice(0,8).map(f => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:8px;background:var(--bg-secondary);border-radius:6px;margin-bottom:4px;">
                <div><span style="font-size:13px;">${f.name}</span> <span style="color:var(--text-muted);font-size:11px;">(${f.size_mb}Mo)</span></div>
                ${f.download_url?`<button class="btn btn-primary btn-sm" onclick="ServerView._installMod('${name.replace(/'/g,"\\'")}','${f.download_url}','${f.name}')">📥</button>`:''}
            </div>`).join('');
    },

    async _installMod(name, url, filename) {
        await Auth.apiCall('/api/mods/install',{method:'POST',body:JSON.stringify({server_id:this.serverId,mod_name:name,download_url:url,filename:filename})});
    },

    async action(act) {
        if (act==='start') await Auth.apiCall(`/api/servers/${this.serverId}/start`,{method:'POST'});
        else if (act==='stop') await Auth.apiCall(`/api/servers/${this.serverId}/stop`,{method:'POST'});
        else if (act==='restart') await Auth.apiCall(`/api/servers/${this.serverId}/restart`,{method:'POST'});
        await this.refreshServer();
        this.render();
    },

    _bindEvents() {},

    close() {
        if (this._ws) { this._ws.close(); this._ws = null; }
        this.serverId = null;
        this.serverData = null;
    },

    // --- Dashboard live stats ---
    async _loadDashboardStats() {
        const el = document.getElementById('sv-dash-docker');
        if (!el) return;
        
        try {
            const r = await Auth.apiCall(`/api/containers/${this.serverData?.docker_id}/stats`);
            if (r && r.ok) {
                const stats = await r.json();
                el.innerHTML = `
                    <div style="font-size:13px;font-weight:600;margin-bottom:10px;">🐳 Docker — Ressources en temps réel</div>
                    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
                        <div>
                            <div style="font-size:11px;color:var(--text-muted);">CPU utilisé</div>
                            <div style="font-size:18px;font-weight:700;color:var(--accent-blue);">${(stats.cpu_percent||0).toFixed(1)}%</div>
                            <div style="background:var(--bg-primary);height:4px;border-radius:2px;margin-top:4px;">
                                <div style="background:var(--accent-blue);height:100%;border-radius:2px;width:${Math.min(stats.cpu_percent||0,100)}%;"></div>
                            </div>
                        </div>
                        <div>
                            <div style="font-size:11px;color:var(--text-muted);">RAM utilisée</div>
                            <div style="font-size:18px;font-weight:700;color:var(--accent-green);">${stats.memory_mb ? stats.memory_mb.toFixed(0) : '?'} Mo</div>
                            <div style="background:var(--bg-primary);height:4px;border-radius:2px;margin-top:4px;">
                                <div style="background:var(--accent-green);height:100%;border-radius:2px;width:${stats.memory_percent ? Math.min(stats.memory_percent,100) : 0}%;"></div>
                            </div>
                        </div>
                        <div>
                            <div style="font-size:11px;color:var(--text-muted);">Réseau</div>
                            <div style="font-size:14px;font-weight:600;">↑ ${stats.net_tx_mb ? stats.net_tx_mb.toFixed(1) : '0'} Mo</div>
                            <div style="font-size:14px;font-weight:600;">↓ ${stats.net_rx_mb ? stats.net_rx_mb.toFixed(1) : '0'} Mo</div>
                        </div>
                    </div>`;
            } else {
                el.innerHTML = `
                    <div style="font-size:13px;font-weight:600;margin-bottom:8px;">🐳 Docker</div>
                    <div style="color:var(--text-muted);font-size:12px;">Le serveur doit être en ligne pour voir les stats.</div>`;
            }
        } catch (e) {
            el.innerHTML = `
                <div style="font-size:13px;font-weight:600;margin-bottom:8px;">🐳 Docker</div>
                <div style="color:var(--text-muted);font-size:12px;">Stats non disponibles</div>`;
        }
    },

    // --- Notifications Discord ---
    _notificationsTab() {
        setTimeout(() => this._loadNotifSettings(), 50);
        return `
        <h2>🔔 Notifications Discord</h2>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px;">Recevez des alertes sur votre serveur Discord quand des événements se produisent</p>

        <div style="background:var(--bg-secondary);padding:20px;border-radius:10px;margin-bottom:16px;">
            <div style="font-weight:600;margin-bottom:12px;">🔗 Webhook Discord</div>
            <div style="display:flex;gap:8px;align-items:center;">
                <input id="sv-notif-webhook" class="form-input" placeholder="https://discord.com/api/webhooks/..." style="flex:1;font-family:monospace;font-size:12px;" />
            </div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:6px;">
                💡 Pour créer un webhook : Paramètres du salon Discord → Intégrations → Webhooks → Nouveau webhook → Copier l'URL
            </div>
        </div>

        <div style="background:var(--bg-secondary);padding:20px;border-radius:10px;margin-bottom:16px;">
            <div style="font-weight:600;margin-bottom:12px;">📋 Événements à notifier</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;">
                    <input type="checkbox" id="sv-notif-start" checked /> ▶️ Démarrage du serveur
                </label>
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;">
                    <input type="checkbox" id="sv-notif-stop" checked /> ⏹️ Arrêt du serveur
                </label>
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;">
                    <input type="checkbox" id="sv-notif-crash" checked /> 💥 Crash du serveur
                </label>
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;">
                    <input type="checkbox" id="sv-notif-backup" checked /> 💾 Sauvegarde créée
                </label>
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;">
                    <input type="checkbox" id="sv-notif-join" /> 👋 Joueur rejoint
                </label>
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;">
                    <input type="checkbox" id="sv-notif-leave" /> 👋 Joueur quitte
                </label>
            </div>
        </div>

        <div style="display:flex;gap:8px;align-items:center;">
            <button class="btn btn-primary" onclick="ServerView._saveNotifSettings()">💾 Sauvegarder</button>
            <button class="btn btn-secondary" onclick="ServerView._testNotif()">🧪 Tester</button>
            <span id="sv-notif-msg" style="font-size:12px;"></span>
        </div>`;
    },

    async _loadNotifSettings() {
        const r = await Auth.apiCall('/api/notifications/settings');
        if (!r || !r.ok) return;
        const s = await r.json();

        const el = (id) => document.getElementById(id);
        if (el('sv-notif-webhook')) el('sv-notif-webhook').value = s.discord_webhook_url || '';
        if (el('sv-notif-start')) el('sv-notif-start').checked = s.notify_server_start !== false;
        if (el('sv-notif-stop')) el('sv-notif-stop').checked = s.notify_server_stop !== false;
        if (el('sv-notif-crash')) el('sv-notif-crash').checked = s.notify_server_crash !== false;
        if (el('sv-notif-backup')) el('sv-notif-backup').checked = s.notify_backup_created !== false;
        if (el('sv-notif-join')) el('sv-notif-join').checked = s.notify_player_join === true;
        if (el('sv-notif-leave')) el('sv-notif-leave').checked = s.notify_player_leave === true;
    },

    async _saveNotifSettings() {
        const msg = document.getElementById('sv-notif-msg');
        const body = {
            discord_webhook_url: document.getElementById('sv-notif-webhook')?.value || '',
            notify_server_start: document.getElementById('sv-notif-start')?.checked ?? true,
            notify_server_stop: document.getElementById('sv-notif-stop')?.checked ?? true,
            notify_server_crash: document.getElementById('sv-notif-crash')?.checked ?? true,
            notify_backup_created: document.getElementById('sv-notif-backup')?.checked ?? true,
            notify_player_join: document.getElementById('sv-notif-join')?.checked ?? false,
            notify_player_leave: document.getElementById('sv-notif-leave')?.checked ?? false,
        };

        const r = await Auth.apiCall('/api/notifications/settings', {
            method: 'PUT', body: JSON.stringify(body)
        });

        if (r && r.ok) {
            if (msg) { msg.style.color = 'var(--accent-green)'; msg.textContent = '✅ Réglages sauvegardés !'; }
        } else {
            if (msg) { msg.style.color = '#e74c3c'; msg.textContent = '❌ Erreur'; }
        }
    },

    async _testNotif() {
        const msg = document.getElementById('sv-notif-msg');
        if (msg) { msg.style.color = 'var(--accent-blue)'; msg.textContent = '⏳ Envoi du test...'; }

        const r = await Auth.apiCall('/api/notifications/test', { method: 'POST' });
        if (r && r.ok) {
            if (msg) { msg.style.color = 'var(--accent-green)'; msg.textContent = '✅ Notification envoyée ! Vérifie ton Discord.'; }
        } else {
            const err = r ? await r.json().catch(()=>({})) : {};
            if (msg) { msg.style.color = '#e74c3c'; msg.textContent = `❌ ${err.detail || 'Erreur'}`; }
        }
    },
};
