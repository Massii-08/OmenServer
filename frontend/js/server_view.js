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
            {id:'backups',icon:'💾',label:'Sauvegardes'},
            {id:'scheduler',icon:'⏰',label:'Tâches planifiées'},
            {id:'monitoring',icon:'📈',label:'Monitoring'},
            {id:'mods',icon:'🧩',label:'Mods & Plugins'},
            {id:'access',icon:'👥',label:'Accès SFTP'},
        ];
        return tabs.map(t => `
            <a class="sv-tab ${this.currentTab===t.id?'active':''}" onclick="ServerView.switchTab('${t.id}')" style="display:flex;align-items:center;gap:10px;padding:10px 20px;cursor:pointer;color:${this.currentTab===t.id?'var(--accent-blue)':'var(--text-primary)'};background:${this.currentTab===t.id?'rgba(59,130,246,0.1)':'transparent'};font-size:13px;font-weight:${this.currentTab===t.id?'600':'400'};border-left:3px solid ${this.currentTab===t.id?'var(--accent-blue)':'transparent'};transition:all .15s;">
                <span>${t.icon}</span>${t.label}
            </a>
        `).join('');
    },

    switchTab(tab) {
        if (this._ws) { this._ws.close(); this._ws = null; }
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
            case 'settings': return this._settingsTab();
            case 'files': return this._filesTab();
            case 'monitoring': return this._monitoringTab();
            case 'access': return this._accessTab();
            default: return '<p>Section en cours de développement</p>';
        }
    },

    _dashboardTab() {
        const s = this.serverData;
        const addr = `${GameServer._serverIP || 'localhost'}:${s.port||25565}`;
        return `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
            <h2 style="margin:0;">📊 Tableau de bord</h2>
            <button class="btn btn-secondary btn-sm" onclick="App.navigateTo('game_server')">← Retour à la liste</button>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
            <div style="background:var(--bg-secondary);padding:16px;border-radius:10px;">
                <div style="font-size:12px;color:var(--text-muted);">Adresse</div>
                <div style="font-family:monospace;font-size:15px;margin-top:4px;cursor:pointer;" onclick="navigator.clipboard.writeText('${addr}')">📡 ${addr} <span style="font-size:11px;color:var(--text-muted);">📋</span></div>
            </div>
            <div style="background:var(--bg-secondary);padding:16px;border-radius:10px;">
                <div style="font-size:12px;color:var(--text-muted);">Version</div>
                <div style="font-size:15px;margin-top:4px;">${s.game_type||'minecraft'} · v${s.version||'?'}</div>
            </div>
            <div style="background:var(--bg-secondary);padding:16px;border-radius:10px;">
                <div style="font-size:12px;color:var(--text-muted);">RAM allouée</div>
                <div style="font-size:15px;margin-top:4px;">${s.memory_mb||1024} Mo</div>
            </div>
            <div style="background:var(--bg-secondary);padding:16px;border-radius:10px;">
                <div style="font-size:12px;color:var(--text-muted);">CPU alloué</div>
                <div style="font-size:15px;margin-top:4px;">${s.cpu_percent||100}%</div>
            </div>
        </div>`;
    },

    _consoleTab() {
        setTimeout(() => this._startConsoleWS(), 100);
        return `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
            <h2 style="margin:0;">💻 Console</h2>
            <button class="btn btn-secondary btn-sm" onclick="document.getElementById('sv-console-logs').innerHTML=''">🗑 Effacer</button>
        </div>
        <div id="sv-console-logs" style="background:#0d1117;color:#c9d1d9;font-family:'Courier New',monospace;font-size:12px;padding:12px;border-radius:8px;height:400px;overflow-y:auto;white-space:pre-wrap;"></div>
        <div style="display:flex;gap:8px;margin-top:8px;">
            <input id="sv-console-input" class="form-input" placeholder="Entrez une commande..." style="flex:1;font-family:monospace;" onkeydown="if(event.key==='Enter')ServerView.sendCommand()"/>
            <button class="btn btn-primary" onclick="ServerView.sendCommand()">📤</button>
        </div>`;
    },

    _startConsoleWS() {
        if (this._ws) this._ws.close();
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const token = Auth.getToken();
        this._ws = new WebSocket(`${proto}://${location.host}/api/servers/${this.serverId}/ws?token=${token}`);
        const logs = document.getElementById('sv-console-logs');
        this._ws.onmessage = (e) => {
            if (logs) { logs.textContent += e.data + '\n'; logs.scrollTop = logs.scrollHeight; }
        };
    },

    sendCommand() {
        const input = document.getElementById('sv-console-input');
        if (input && input.value.trim() && this._ws) {
            this._ws.send(JSON.stringify({command: input.value.trim()}));
            input.value = '';
        }
    },

    _backupsTab() {
        setTimeout(() => this._loadBackups(), 50);
        return `<h2>💾 Sauvegardes</h2>
        <button class="btn btn-primary btn-sm" onclick="ServerView._createBackup()" style="margin-bottom:12px;">➕ Créer une sauvegarde</button>
        <div id="sv-backups-list"><div style="color:var(--text-muted)">⏳ Chargement...</div></div>`;
    },

    async _loadBackups() {
        const r = await Auth.apiCall(`/api/servers/${this.serverId}/backups`);
        const el = document.getElementById('sv-backups-list');
        if (!r||!r.ok||!el) return;
        const backups = await r.json();
        if (backups.length===0) { el.innerHTML='<p style="color:var(--text-muted)">Aucune sauvegarde</p>'; return; }
        el.innerHTML = backups.map(b => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px;background:var(--bg-secondary);border-radius:8px;margin-bottom:6px;">
                <div><div style="font-weight:600;">📦 ${b.filename||b.id}</div><div style="font-size:11px;color:var(--text-muted);">${b.size_mb||'?'} Mo · ${b.created_at||''}</div></div>
                <div class="flex gap-2">
                    <button class="btn btn-sm btn-secondary" onclick="ServerView._restoreBackup('${b.id}')">♻️</button>
                    <button class="btn btn-sm btn-danger" onclick="ServerView._deleteBackup('${b.id}')">🗑️</button>
                </div>
            </div>`).join('');
    },

    async _createBackup() {
        await Auth.apiCall(`/api/servers/${this.serverId}/backup`,{method:'POST'});
        this._loadBackups();
    },

    async _restoreBackup(id) {
        await Auth.apiCall(`/api/servers/${this.serverId}/restore/${id}`,{method:'POST'});
    },

    async _deleteBackup(id) {
        await Auth.apiCall(`/api/servers/${this.serverId}/backups/${id}`,{method:'DELETE'});
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
        return `<h2>🧩 Mods & Plugins</h2>
        <div class="flex gap-2" style="margin-bottom:12px;">
            <button class="btn btn-primary btn-sm" id="sv-mods-tab-search" onclick="ServerView._modsSwitch('search')">🔍 Rechercher</button>
            <button class="btn btn-secondary btn-sm" id="sv-mods-tab-installed" onclick="ServerView._modsSwitch('installed')">📦 Installés</button>
        </div>
        <div id="sv-mods-search" style="margin-bottom:12px;">
            <div class="flex gap-2" style="margin-bottom:10px;">
                <input id="sv-mods-q" class="form-input" placeholder="Rechercher..." style="flex:1;" onkeydown="if(event.key==='Enter')ServerView._searchMods()"/>
                <select id="sv-mods-cat" class="form-input" style="width:120px;"><option value="mods">🧩 Mods</option><option value="modpacks">📦 Modpacks</option></select>
                <button class="btn btn-primary" onclick="ServerView._searchMods()">🔍</button>
            </div>
        </div>
        <div id="sv-mods-results"><div style="color:var(--text-muted)">🔍 Cherche un mod</div></div>`;
    },

    _modsSwitch(tab) {
        if (tab==='installed') { this._loadInstalledMods(); }
        else { document.getElementById('sv-mods-search').style.display='block'; }
    },

    async _searchMods() {
        const q = document.getElementById('sv-mods-q').value.trim();
        const cat = document.getElementById('sv-mods-cat').value;
        if (!q) return;
        const el = document.getElementById('sv-mods-results');
        el.innerHTML = '<div style="color:var(--text-muted)">⏳ Recherche...</div>';
        const r = await Auth.apiCall(`/api/mods/search?q=${encodeURIComponent(q)}&category=${cat}`);
        if (!r||!r.ok) { el.innerHTML='<div style="color:#e74c3c">❌ Erreur</div>'; return; }
        const data = await r.json();
        const mods = data.mods||[];
        if (mods.length===0) { el.innerHTML='<div style="color:var(--text-muted)">Aucun résultat</div>'; return; }
        el.innerHTML = mods.map(m => `
            <div style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--bg-secondary);border-radius:8px;margin-bottom:6px;">
                <img src="${m.icon_url||''}" style="width:36px;height:36px;border-radius:6px;" onerror="this.style.display='none'"/>
                <div style="flex:1;min-width:0;"><div style="font-weight:600;font-size:13px;">${m.name}</div><div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${m.summary||''}</div></div>
                <button class="btn btn-primary btn-sm" onclick="ServerView._showModFiles(${m.id},'${m.name.replace(/'/g,"\\'")}')">📥</button>
            </div>`).join('');
    },

    async _showModFiles(modId, name) {
        const el = document.getElementById('sv-mods-results');
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

    async _loadInstalledMods() {
        const el = document.getElementById('sv-mods-results');
        const r = await Auth.apiCall(`/api/mods/server/${this.serverId}`);
        if (!r||!r.ok) return;
        const mods = (await r.json()).mods||[];
        if (mods.length===0) { el.innerHTML='<div style="color:var(--text-muted)">Aucun mod installé</div>'; return; }
        el.innerHTML = mods.map(m => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:8px;background:var(--bg-secondary);border-radius:6px;margin-bottom:4px;">
                <div>🧩 ${m.filename} <span style="color:var(--text-muted);font-size:11px;">${m.size_mb}Mo</span></div>
                <button class="btn btn-sm btn-danger" onclick="ServerView._removeMod('${m.filename}')">🗑️</button>
            </div>`).join('');
    },

    async _removeMod(f) {
        await Auth.apiCall(`/api/mods/server/${this.serverId}/${encodeURIComponent(f)}`,{method:'DELETE'});
        this._loadInstalledMods();
    },

    _settingsTab() {
        return `<h2>⚙️ Paramètres</h2>
        <div class="flex gap-2" style="margin-bottom:16px;">
            <button class="btn btn-primary btn-sm" onclick="ServerView._settingsSubTab('server')">🖥 Serveur</button>
            <button class="btn btn-secondary btn-sm" onclick="ServerView._settingsSubTab('resources')">📊 Ressources</button>
        </div>
        <div id="sv-settings-content">${this._settingsServerSub()}</div>`;
    },

    _settingsSubTab(sub) {
        const el = document.getElementById('sv-settings-content');
        if (sub==='resources') { el.innerHTML = this._settingsResourcesSub(); this._initSliders(); }
        else { el.innerHTML = this._settingsServerSub(); }
    },

    _settingsServerSub() {
        return `<p style="color:var(--text-muted);font-size:13px;">Les paramètres du serveur (server.properties) seront éditables ici quand le backend sera connecté.</p>`;
    },

    _settingsResourcesSub() {
        const s = this.serverData;
        return `
        <div style="margin-bottom:20px;">
            <label class="form-label">RAM : <span id="sv-ram-val">${s.memory_mb||1024}</span> Mo</label>
            <input type="range" id="sv-ram-slider" min="256" max="8192" step="256" value="${s.memory_mb||1024}" oninput="document.getElementById('sv-ram-val').textContent=this.value" style="width:100%;"/>
        </div>
        <div style="margin-bottom:20px;">
            <label class="form-label">CPU : <span id="sv-cpu-val">${s.cpu_percent||100}</span>%</label>
            <input type="range" id="sv-cpu-slider" min="25" max="400" step="25" value="${s.cpu_percent||100}" oninput="document.getElementById('sv-cpu-val').textContent=this.value" style="width:100%;"/>
        </div>
        <button class="btn btn-primary" onclick="ServerView._saveResources()">💾 Appliquer</button>
        <span id="sv-res-msg" style="margin-left:10px;font-size:13px;"></span>`;
    },

    _initSliders() {},

    async _saveResources() {
        const ram = parseInt(document.getElementById('sv-ram-slider').value);
        const cpu = parseInt(document.getElementById('sv-cpu-slider').value);
        const r = await Auth.apiCall(`/api/servers/${this.serverId}/resources`,{method:'PUT',body:JSON.stringify({memory_mb:ram,cpu_percent:cpu})});
        const msg = document.getElementById('sv-res-msg');
        if (r&&r.ok) { msg.style.color='var(--accent-green)'; msg.textContent='✅ Appliqué'; }
        else { msg.style.color='#e74c3c'; msg.textContent='❌ Erreur'; }
    },

    _filesTab() {
        return `<h2>📁 Fichiers</h2><p style="color:var(--text-muted);">Explorateur de fichiers — disponible prochainement.</p>`;
    },

    _monitoringTab() {
        return `<h2>📈 Monitoring</h2><p style="color:var(--text-muted);">Graphiques temps réel — disponible prochainement.</p>`;
    },

    _accessTab() {
        const s = this.serverData;
        return `<h2>👥 Accès SFTP</h2>
        <div style="background:var(--bg-secondary);padding:16px;border-radius:10px;">
            <p style="margin-bottom:12px;">Connecte-toi avec WinSCP ou FileZilla pour gérer tes fichiers :</p>
            <div style="font-family:monospace;font-size:13px;line-height:2;">
                <div>📡 <strong>Hôte :</strong> ${GameServer._serverIP||'ton-ip'}</div>
                <div>🔌 <strong>Port :</strong> 2222</div>
                <div>👤 <strong>Utilisateur :</strong> server_${this.serverId}</div>
                <div>🔑 <strong>Mot de passe :</strong> <em>Celui de ton compte OmenServer</em></div>
                <div>📂 <strong>Dossier :</strong> /data/servers/${this.serverId}/</div>
            </div>
            <p style="color:var(--text-muted);font-size:12px;margin-top:12px;">⚠️ Le service SFTP doit être activé sur le serveur hôte.</p>
        </div>`;
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
    }
};
